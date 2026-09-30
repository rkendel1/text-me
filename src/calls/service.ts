import { createHash } from 'node:crypto';

import type { Conversation } from '../domain/conversation.js';
import { E164 } from '../tenancy/model.js';
import {
  CALL_SESSION_STATUSES,
  createCallSessionId,
  isTerminal,
  type CallDirection,
  type CallSessionRecord,
  type CallSessionStatus,
} from './model.js';
import { consoleCallLogger, maskPhone, type CallLogger } from './log.js';
import type { CallProvider } from './provider.js';
import type { CallSessionStore } from './store.js';
import { claimCallEnd, releaseEndClaim, transitionCallSession, type TransitionOutcome, type TransitionResult } from './transition.js';

export class CallNotFoundError extends Error {
  constructor() {
    super('Call not found');
  }
}

/** The caller asked for something the contract does not allow (bad input, missing line…). */
export class CallRequestError extends Error {
  constructor(readonly code: 'invalid_input' | 'no_assistant_line' | 'not_permitted', message: string) {
    super(message);
  }
}

export class CallConflictError extends Error {
  constructor(readonly reason: 'idempotency_key_reused' | 'provider_call_taken') {
    super(reason === 'idempotency_key_reused'
      ? 'This idempotency key was already used for a different call request.'
      : 'That call is already recorded.');
  }
}

export class CallProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Who is acting. The account always comes from authenticated context, never from input. */
export interface CallActor {
  accountId: string;
  principalId?: string;
  traceId?: string;
  idempotencyKey?: string;
  /** May record a call that already exists at the provider (inbound webhooks). Never a user. */
  canIngest?: boolean;
}

export interface CreateCallInput {
  direction: CallDirection;
  /** The telephony provider that reported the call. Honoured only for trusted ingest; otherwise the configured provider. */
  provider?: string;
  from?: string | null;
  to?: string | null;
  /** Provider reference of a call that already exists there. Requires `canIngest`. */
  providerCallId?: string | null;
  /** The owner-facing conversation this call belongs to. Requires `canIngest`. */
  conversationId?: string | null;
}

export interface ListCallsInput {
  status?: readonly CallSessionStatus[];
  direction?: CallDirection;
  createdAfter?: Date;
  createdBefore?: Date;
  limit?: number;
  cursor?: string;
}

export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 100;

/** One provider callback, already translated into domain terms by the provider adapter. */
export interface ProviderCallEvent {
  provider: string;
  providerCallId: string;
  eventId: string;
  rawStatus: string;
  /** `null` when the provider status is not one the domain models. */
  status: CallSessionStatus | null;
  traceId?: string;
  sequence?: string | null;
  providerTimestamp?: string | null;
}

export type ProviderEventOutcome = TransitionOutcome | 'unmapped' | 'unknown_call';

export interface CallSessionServiceOptions {
  provider?: CallProvider;
  /** The account's own assistant line, used as `from` for an outbound call that names none. */
  assistantLine?: (accountId: string) => Promise<string | null>;
  logger?: CallLogger;
  now?: () => Date;
  newId?: () => string;
}

const encodeCursor = (record: CallSessionRecord): string =>
  Buffer.from(JSON.stringify({ t: record.createdAt.toISOString(), i: record.id })).toString('base64url');

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; i?: unknown };
    const createdAt = new Date(String(parsed.t));
    if (typeof parsed.i !== 'string' || Number.isNaN(createdAt.getTime())) throw new Error('bad cursor');
    return { createdAt, id: parsed.i };
  } catch {
    throw new CallRequestError('invalid_input', 'The cursor is not valid.');
  }
}

const fingerprint = (direction: CallDirection, from: string | null, to: string | null, providerCallId: string | null): string =>
  createHash('sha256').update([direction, from ?? '', to ?? '', providerCallId ?? ''].join('|')).digest('hex');

/**
 * The application's CallSession operations. Every read and write is scoped to an account, and the
 * status only ever changes through `transitionCallSession`.
 */
export class CallSessionService {
  private readonly logger: CallLogger;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(readonly store: CallSessionStore, private readonly options: CallSessionServiceOptions = {}) {
    this.logger = options.logger ?? consoleCallLogger;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? createCallSessionId;
  }

  get providerName(): string {
    return this.options.provider?.name ?? 'twilio';
  }

  private log(level: 'info' | 'warn' | 'error', event: string, session: Pick<CallSessionRecord, 'id' | 'providerCallId' | 'traceId'> | null, fields: Record<string, unknown> = {}): void {
    this.logger.log(level, event, {
      callId: session?.id ?? null,
      providerCallId: session?.providerCallId ?? null,
      traceId: fields.traceId ?? session?.traceId ?? null,
      ...fields,
    });
  }

  // ----- Creation -----

  /**
   * Establishes the domain object for a call. Outbound: a `created` session that nothing has dialed.
   * Inbound: a call that already exists at the provider, so it is immediately `ringing`.
   */
  async create(actor: CallActor, input: CreateCallInput): Promise<CallSessionRecord> {
    const direction = input.direction;
    const providerCallId = input.providerCallId?.trim() || null;
    const conversationId = input.conversationId ?? null;
    if ((providerCallId || conversationId) && !actor.canIngest) {
      throw new CallRequestError('not_permitted', 'Only the telephony webhook may attach a provider call or a conversation.');
    }
    // The telephony webhook reports what the carrier sent, which is not always E.164 (anonymous callers, SIP
    // identifiers): it is recorded when valid and left null otherwise, never a reason to drop a real call.
    let from = this.phone(input.from, 'from', actor.canIngest);
    const to = this.phone(input.to, 'to', actor.canIngest);
    if (direction === 'inbound') {
      if (!providerCallId) throw new CallRequestError('invalid_input', 'An inbound call needs its provider call.');
    } else {
      if (!to) throw new CallRequestError('invalid_input', 'An outbound call needs a destination number.');
      if (providerCallId) throw new CallRequestError('invalid_input', 'An outbound call gets its provider call when it is dialed.');
      if (!from) {
        from = (await this.options.assistantLine?.(actor.accountId)) ?? null;
        if (!from) throw new CallRequestError('no_assistant_line', 'This account has no assistant line to call from yet.');
      }
    }

    const now = this.now();
    const record: CallSessionRecord = {
      id: this.newId(),
      accountId: actor.accountId,
      direction,
      status: 'created',
      provider: actor.canIngest && input.provider ? input.provider : this.providerName,
      providerCallId,
      from,
      to,
      conversationId,
      startedAt: null,
      answeredAt: null,
      endedAt: null,
      endReason: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
      requestedBy: actor.principalId ?? (actor.canIngest ? 'system' : null),
      traceId: actor.traceId ?? null,
      idempotencyKey: actor.idempotencyKey ?? null,
      requestFingerprint: fingerprint(direction, from, to, providerCallId),
      endClaimedAt: null,
      lastProviderStatus: null,
    };

    const inserted = await this.store.insert(record);
    let session = inserted.session;
    if (!inserted.created) {
      // A replay. It must be ours, and it must be the same request.
      if (session.accountId !== actor.accountId) throw new CallConflictError('provider_call_taken');
      if (actor.idempotencyKey && session.idempotencyKey === actor.idempotencyKey && session.requestFingerprint !== record.requestFingerprint) {
        throw new CallConflictError('idempotency_key_reused');
      }
      this.log('info', 'call.create.replayed', session, { traceId: actor.traceId });
    } else {
      this.log('info', 'call.created', session, {
        traceId: actor.traceId, direction, from: maskPhone(from), to: maskPhone(to), idempotent: Boolean(actor.idempotencyKey),
      });
    }

    // An inbound call is already at the provider. Resuming this step on a replay heals a crash between insert and transition.
    if (direction === 'inbound' && session.status === 'created') {
      session = (await this.transition(session.id, 'ringing', { mode: 'lenient' })).session ?? session;
    }
    return session;
  }

  private phone(value: string | null | undefined, field: string, lenient = false): string | null {
    if (value === undefined || value === null || value.trim() === '') return null;
    const trimmed = value.trim();
    if (!E164.test(trimmed)) {
      if (lenient) return null;
      throw new CallRequestError('invalid_input', `${field} must be an E.164 phone number such as +15551234567.`);
    }
    return trimmed;
  }

  /**
   * The call a webhook is about. A call the application already knows (an owner test call it placed)
   * is resolved; any other is recorded as a new call that exists at the provider.
   */
  async openProviderCall(input: {
    accountId: string;
    provider?: string;
    providerCallId: string;
    direction: CallDirection;
    from?: string | null;
    to?: string | null;
    conversationId?: string;
    traceId?: string;
  }): Promise<CallSessionRecord> {
    const provider = input.provider ?? this.providerName;
    const existing = await this.store.findByProviderCallId(provider, input.providerCallId);
    if (existing) {
      if (existing.accountId !== input.accountId) throw new CallConflictError('provider_call_taken');
      return this.linkConversation(existing, input.conversationId);
    }
    const created = await this.create(
      { accountId: input.accountId, traceId: input.traceId, canIngest: true },
      { direction: input.direction, provider, from: input.from, to: input.to, providerCallId: input.providerCallId, conversationId: input.conversationId },
    );
    return created;
  }

  /** A conversation that predates CallSessions (or whose call the provider reported before we saw it). */
  async adoptConversation(conversation: Conversation): Promise<CallSessionRecord | null> {
    if (!conversation.accountId) return null;
    const existing = await this.store.findByProviderCallId(conversation.provider, conversation.providerCallId);
    if (existing) return existing;
    const now = this.now();
    // Its own provider, even when it differs from the configured one (the fake provider used in tests).
    const record: CallSessionRecord = {
      id: this.newId(), accountId: conversation.accountId, direction: 'inbound', status: 'created',
      provider: conversation.provider, providerCallId: conversation.providerCallId,
      from: E164.test(conversation.callerPhone) ? conversation.callerPhone : null, to: null,
      conversationId: conversation.id, startedAt: null, answeredAt: null, endedAt: null, endReason: null,
      createdAt: conversation.startedAt, updatedAt: now, version: 1, requestedBy: 'system', traceId: null,
      idempotencyKey: null, requestFingerprint: null, endClaimedAt: null, lastProviderStatus: null,
    };
    const { session } = await this.store.insert(record);
    // Mirror where the conversation already is, through the same transition mechanism.
    let result = session;
    if (session.status === 'created' && conversation.status !== 'received') {
      // A conversation still `received` never got going; leave its session `created` so a completion is rejected as before.
      result = (await this.transition(session.id, 'ringing', { mode: 'lenient' })).session ?? session;
      result = (await this.transition(session.id, 'answered', { mode: 'lenient' })).session ?? result;
      if (conversation.status === 'completed') {
        result = (await this.transition(session.id, 'completed', { mode: 'lenient', reason: 'completed' })).session ?? result;
      }
    }
    this.log('info', 'call.adopted', result, { conversationId: conversation.id });
    return result;
  }

  private async linkConversation(session: CallSessionRecord, conversationId?: string): Promise<CallSessionRecord> {
    if (!conversationId || session.conversationId === conversationId) return session;
    const result = await this.store.mutate(session.id, (current) =>
      current.conversationId ? { patch: null } : { patch: { conversationId } });
    return result?.session ?? session;
  }

  // ----- Reads (tenant-scoped) -----

  async get(accountId: string, id: string): Promise<CallSessionRecord> {
    const session = await this.store.get(accountId, id);
    if (!session) throw new CallNotFoundError();
    return session;
  }

  async findByConversation(accountId: string, conversationId: string): Promise<CallSessionRecord | null> {
    return this.store.findByConversation(accountId, conversationId);
  }

  async findByProviderCall(providerCallId: string, provider = this.providerName): Promise<CallSessionRecord | null> {
    return this.store.findByProviderCallId(provider, providerCallId);
  }

  async list(accountId: string, input: ListCallsInput = {}): Promise<{ items: CallSessionRecord[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);
    for (const status of input.status ?? []) {
      if (!CALL_SESSION_STATUSES.includes(status)) throw new CallRequestError('invalid_input', `Unknown status: ${String(status)}`);
    }
    const rows = await this.store.list(accountId, {
      ...(input.status?.length ? { status: input.status } : {}),
      ...(input.direction ? { direction: input.direction } : {}),
      ...(input.createdAfter ? { createdAfter: input.createdAfter } : {}),
      ...(input.createdBefore ? { createdBefore: input.createdBefore } : {}),
      limit: limit + 1,
      ...(input.cursor ? { after: decodeCursor(input.cursor) } : {}),
    });
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]) : null };
  }

  // ----- Lifecycle -----

  /** Application and runtime observations. Strict unless told otherwise. */
  async transition(id: string, to: CallSessionStatus, options: { mode?: 'strict' | 'lenient'; reason?: string } = {}): Promise<TransitionResult> {
    const result = await transitionCallSession(this.store, id, to, { mode: options.mode ?? 'strict', reason: options.reason, now: this.now() });
    if (result.outcome === 'applied') this.log('info', 'call.transition', result.session, { to, reason: options.reason });
    return result;
  }

  /** The voice runtime took the call: media is flowing and the assistant is conversing. */
  async markInProgress(id: string | null | undefined): Promise<void> {
    if (!id) return;
    await this.transition(id, 'in_progress', { mode: 'lenient' }).catch((error) => this.logFailure('call.in_progress.failed', id, error));
  }

  /** The runtime could not keep the call going. Terminal: the provider's later `completed` is then stale. */
  async markFailed(id: string | null | undefined, reason: string): Promise<void> {
    if (!id) return;
    await this.transition(id, 'failed', { mode: 'lenient', reason }).catch((error) => this.logFailure('call.fail.failed', id, error));
  }

  /** The runtime hung up (or saw the stream end); the provider will confirm with its final callback. */
  async markEnding(id: string | null | undefined, reason: string): Promise<void> {
    if (!id) return;
    await this.transition(id, 'ending', { mode: 'lenient', reason }).catch((error) => this.logFailure('call.ending.failed', id, error));
  }

  private logFailure(event: string, id: string, error: unknown): void {
    this.log('error', event, { id, providerCallId: null, traceId: null }, { error: error instanceof Error ? error.message : 'unknown' });
  }

  /** Records the provider's id for a call the application dialed. */
  async attachProviderCall(id: string, providerCallId: string): Promise<CallSessionRecord | null> {
    const result = await this.store.mutate(id, (current) =>
      current.providerCallId ? { patch: null } : { patch: { providerCallId } });
    return result?.session ?? null;
  }

  /**
   * The owner-initiated test call is the only call the application dials today (`call.create` never
   * dials). Its lifecycle goes through the same transitions: dialing, then the provider's id, or failure.
   */
  async beginDial(id: string): Promise<void> {
    await this.transition(id, 'initiating', { mode: 'strict' });
  }

  async recordDialed(id: string, providerCallId: string, traceId?: string): Promise<void> {
    const attached = await this.attachProviderCall(id, providerCallId);
    this.log('info', 'call.dialed', attached, { traceId });
  }

  async recordDialFailed(id: string, traceId?: string, error?: unknown): Promise<void> {
    const result = await this.transition(id, 'failed', { mode: 'lenient', reason: 'dial_failed' });
    this.log('error', 'call.dial.failed', result.session, { traceId, error: error instanceof Error ? error.message : 'unknown' });
  }

  /**
   * Ends a call. Idempotent: an already-ended call is returned as it is, and the provider is asked
   * to hang up at most once, by whichever request claims the end first.
   */
  async end(actor: CallActor, id: string, options: { reason?: string } = {}): Promise<CallSessionRecord> {
    const session = await this.get(actor.accountId, id);
    if (isTerminal(session.status)) return session;
    const reason = options.reason?.trim().slice(0, 200) || 'ended_by_request';

    // Nothing exists at the provider yet: there is nothing to hang up.
    if (!session.providerCallId) {
      const result = await this.transition(id, 'canceled', { mode: 'lenient', reason });
      this.log('info', 'call.end.canceled', result.session ?? session, { traceId: actor.traceId });
      return result.session ?? session;
    }

    // A provider call exists but the session never reached `ringing` (a crash between insert and transition): catch it up first.
    if (session.status === 'created') await this.transition(id, 'ringing', { mode: 'lenient' });
    const cancelMode = session.status === 'created' || session.status === 'initiating' || session.status === 'ringing';
    const claim = await claimCallEnd(this.store, id, { reason, now: this.now() });
    if (claim.outcome === 'not_found' || !claim.session) throw new CallNotFoundError();
    if (!claim.claimed) {
      this.log('info', `call.end.${claim.outcome}`, claim.session, { traceId: actor.traceId });
      return claim.session;
    }

    try {
      await this.options.provider?.endCall(session.providerCallId, { mode: cancelMode ? 'cancel' : 'complete' });
    } catch (error) {
      // Release the claim so a retry can ask again; the call is `ending` and stays observable.
      await releaseEndClaim(this.store, id);
      this.log('error', 'call.end.provider_failed', claim.session, { traceId: actor.traceId, error: error instanceof Error ? error.message : 'unknown' });
      throw new CallProviderError('The call could not be ended at the provider.', { cause: error });
    }
    this.log('info', 'call.end.requested', claim.session, { traceId: actor.traceId, reason });
    return (await this.store.get(actor.accountId, id)) ?? claim.session;
  }

  // ----- Provider events -----

  /**
   * Applies one provider callback. Redeliveries, late arrivals and unknown statuses are all safe:
   * the event is recorded by identity, transitions only move forward, and only a first, applicable
   * event changes anything.
   */
  async applyProviderEvent(event: ProviderCallEvent): Promise<{ outcome: ProviderEventOutcome; session: CallSessionRecord | null }> {
    const session = await this.store.findByProviderCallId(event.provider, event.providerCallId);
    if (!session) {
      this.log('warn', 'call.event.unknown_call', { id: '', providerCallId: event.providerCallId, traceId: null }, { rawStatus: event.rawStatus, traceId: event.traceId });
      return { outcome: 'unknown_call', session: null };
    }
    const providerEvent = {
      provider: event.provider, eventId: event.eventId, rawStatus: event.rawStatus,
      sequence: event.sequence ?? null, providerTimestamp: event.providerTimestamp ?? null,
    };

    let outcome: ProviderEventOutcome;
    let latest: CallSessionRecord | null;
    if (event.status === null) {
      // A status the domain does not model. Keep a diagnosable record; change nothing.
      const recorded = await this.store.mutate(session.id, () => ({ patch: null, eventOutcome: 'unmapped' }), { providerEvent });
      outcome = recorded?.duplicateEvent ? 'duplicate' : 'unmapped';
      latest = recorded?.session ?? session;
    } else {
      const result = await transitionCallSession(this.store, session.id, event.status, {
        mode: 'lenient', reason: event.status === 'completed' ? 'completed' : undefined, now: this.now(),
        also: { lastProviderStatus: event.rawStatus }, providerEvent,
      });
      outcome = result.outcome;
      latest = result.session;
    }
    this.log(outcome === 'rejected' || outcome === 'unmapped' ? 'warn' : 'info', `call.event.${outcome}`, latest ?? session, { rawStatus: event.rawStatus, eventId: event.eventId, traceId: event.traceId });
    return { outcome, session: latest };
  }
}
