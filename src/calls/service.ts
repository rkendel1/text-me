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
import { consoleCallLogger, maskPhone, safeError, type CallLogger } from './log.js';
import { denyAllOutboundPolicy, type OutboundOrigin, type OutboundPolicy } from './outbound-policy.js';
import { normalizeDialableNumber } from './phone.js';
import type { CallCostLedger } from './cost/ledger.js';
import { CallProviderRejectedError, type CallProvider } from './provider.js';
import type { CallSessionStore } from './store.js';
import { claimCallEnd, claimOutboundDial, claimReconciliation, releaseEndClaim, transitionCallSession, type TransitionOutcome, type TransitionResult } from './transition.js';

export class CallNotFoundError extends Error {
  constructor() {
    super('Call not found');
  }
}

/** The caller asked for something the contract does not allow (bad input, missing line…). */
export class CallRequestError extends Error {
  constructor(readonly code: 'invalid_input' | 'no_assistant_line' | 'not_permitted' | 'idempotency_key_required', message: string) {
    super(message);
  }
}

/** The outbound policy refused the call. Nothing was created and the provider was never contacted. */
export class CallPolicyDeniedError extends Error {
  constructor(readonly reason: string, message: string) {
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
  /** Outbound: what the call is for. A description of the goal, never authority to act. */
  objective?: string | null;
}

export const MAX_OBJECTIVE_LENGTH = 500;

/** Where the provider should send the callee's instructions request and the call's lifecycle events. Built by the application, never from input. */
export interface DialUrls {
  answerUrl: string;
  statusUrl: string;
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
  /** The call's connected duration, when the provider's callback states one. */
  durationSeconds?: number | null;
}

export type ProviderEventOutcome = TransitionOutcome | 'unmapped' | 'unknown_call';

export interface CallSessionServiceOptions {
  /** The cost ledger: usage the provider's callbacks report is recorded in it. Accounting never fails a callback. */
  usage?: CallCostLedger;
  provider?: CallProvider;
  /** Decides whether an outbound call may be placed, and from which number. With none, nothing is allowed. */
  policy?: OutboundPolicy;
  /** The URLs the provider is given for an outbound call. */
  dialUrls?: (session: CallSessionRecord, origin: OutboundOrigin) => DialUrls;
  /** How long to wait for the provider to answer a create-call request before treating its outcome as unconfirmed. */
  dialTimeoutMs?: number;
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

const fingerprint = (direction: CallDirection, from: string | null, to: string | null, providerCallId: string | null, objective: string | null = null): string =>
  // An absent objective leaves the hash exactly as it was before objectives existed, so older rows still match.
  createHash('sha256').update([direction, from ?? '', to ?? '', providerCallId ?? ''].join('|') + (objective ? `|objective:${objective}` : '')).digest('hex');

const DEFAULT_DIAL_TIMEOUT_MS = 20_000;

/**
 * Reconciliation bounds. The grace period is how long a claimed dial is left alone before anyone looks for it at the
 * provider: the request itself can take up to the dial timeout (20 s; the Twilio adapter's own HTTP timeout is 15 s),
 * so the default is six times that and the floor is twice it.
 */
export const DEFAULT_RECONCILIATION_GRACE_MS = 120_000;
export const DEFAULT_RECONCILIATION_BATCH = 25;
export const MAX_RECONCILIATION_BATCH = 100;
export const DEFAULT_RECONCILIATION_MAX_ATTEMPTS = 5;
export const DEFAULT_RECONCILIATION_RETRY_MS = 60_000;
const DEFAULT_RECONCILIATION_BUDGET_MS = 240_000;
const RECONCILIATION_CLOCK_SKEW_MS = 30_000;
const RECONCILIATION_LOOKUP_WINDOW_MS = 5 * 60_000;

export interface ReconciliationOptions {
  graceMs?: number;
  limit?: number;
  maxAttempts?: number;
  retryIntervalMs?: number;
  /** Stop taking new attempts once a run has lasted this long (each lookup is itself a bounded network call). */
  budgetMs?: number;
}

export interface ReconciliationReport {
  /** Eligible sessions looked at this run. */
  examined: number;
  /** Eligible but taken by another reconciler, or no longer eligible. */
  skipped: number;
  /** Tied to a provider call. */
  confirmed: number;
  /** ... of which the call was already ended locally, and was hung up at the provider. */
  cancelledAtProvider: number;
  /** The provider guaranteed no such call exists: failed. */
  rejected: number;
  stillUnconfirmed: number;
  failed: number;
  /** Across the whole table after the run: dials still unknown, and those that have used up their attempts. */
  unresolved: number;
  exhausted: number;
}

class DialTimeout extends Error {
  constructor() {
    super('The provider did not answer the create-call request in time.');
  }
}

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
    const objective = this.objective(input.objective);
    if (objective && direction !== 'outbound') throw new CallRequestError('invalid_input', 'Only an outbound call has an objective.');
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
    const { session } = await this.persist(actor, {
      direction, from, to, providerCallId, conversationId, objective,
      provider: actor.canIngest && input.provider ? input.provider : this.providerName,
      fingerprint: fingerprint(direction, from, to, providerCallId, objective),
    });
    // An inbound call is already at the provider. Resuming this step on a replay heals a crash between insert and transition.
    if (direction === 'inbound' && session.status === 'created') {
      return (await this.transition(session.id, 'ringing', { mode: 'lenient' })).session ?? session;
    }
    return session;
  }

  /** Inserts the session, or finds the one this same request already made. The one place a session is created. */
  private async persist(actor: CallActor, fields: {
    direction: CallDirection;
    provider: string;
    from: string | null;
    to: string | null;
    providerCallId: string | null;
    conversationId: string | null;
    objective: string | null;
    fingerprint: string;
  }): Promise<{ session: CallSessionRecord; replayed: boolean }> {
    const now = this.now();
    const record: CallSessionRecord = {
      id: this.newId(),
      accountId: actor.accountId,
      direction: fields.direction,
      status: 'created',
      provider: fields.provider,
      providerCallId: fields.providerCallId,
      from: fields.from,
      to: fields.to,
      conversationId: fields.conversationId,
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
      requestFingerprint: fields.fingerprint,
      endClaimedAt: null,
      lastProviderStatus: null,
      objective: fields.objective,
      dialClaimedAt: null,
      dialOutcome: null,
      reconciliationAttempts: 0,
      lastReconciliationAt: null,
    };
    const inserted = await this.store.insert(record);
    if (inserted.created) {
      this.log('info', 'call.created', inserted.session, {
        traceId: actor.traceId, direction: fields.direction, from: maskPhone(fields.from), to: maskPhone(fields.to), idempotent: Boolean(actor.idempotencyKey),
      });
      return { session: inserted.session, replayed: false };
    }
    // A replay. It must be ours, and it must be the same request.
    this.assertSameRequest(inserted.session, actor, fields.fingerprint);
    this.log('info', 'call.create.replayed', inserted.session, { traceId: actor.traceId });
    return { session: inserted.session, replayed: true };
  }

  private assertSameRequest(existing: CallSessionRecord, actor: CallActor, fingerprintOfRequest: string): void {
    if (existing.accountId !== actor.accountId) throw new CallConflictError('provider_call_taken');
    if (actor.idempotencyKey && existing.idempotencyKey === actor.idempotencyKey && existing.requestFingerprint !== fingerprintOfRequest) {
      throw new CallConflictError('idempotency_key_reused');
    }
  }

  private objective(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    // One line of plain text: whitespace collapsed, no control characters. It is context for the conversation, never a command channel.
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    if (text.length > MAX_OBJECTIVE_LENGTH) throw new CallRequestError('invalid_input', `objective must be at most ${MAX_OBJECTIVE_LENGTH} characters.`);
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new CallRequestError('invalid_input', 'objective must be plain text.');
    return text;
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
      objective: null, dialClaimedAt: null, dialOutcome: null, reconciliationAttempts: 0, lastReconciliationAt: null,
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

  /** A session by our own id, for a webhook whose URL we built. Not tenant-scoped: the caller must check `accountId`. */
  async findSession(id: string): Promise<CallSessionRecord | null> {
    return this.store.findById(id);
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

  // ----- Outbound execution -----

  /**
   * Places an outbound call: validate, recognise a retry, ask the policy, create the durable session, then
   * execute it. It returns as soon as the provider has accepted (or refused) the request: the caller
   * observes the call afterwards with `get`. It never waits for anyone to pick up.
   *
   * The invariant: one logical request (one idempotency key) produces at most one provider call. The
   * session is unique per (account, key); the right to call the provider is a durable claim
   * (`claimOutboundDial`); and a provider outcome we cannot confirm is recorded, never retried.
   */
  async placeOutbound(actor: CallActor, input: CreateCallInput, options: { origin: OutboundOrigin }): Promise<CallSessionRecord> {
    const { origin } = options;
    this.log('info', 'call.outbound.requested', null, {
      traceId: actor.traceId, origin, principal: actor.principalId ?? null, to: maskPhone(typeof input.to === 'string' ? input.to : null),
    });
    const refuse = (reason: string, error: Error): never => {
      this.log('warn', 'call.outbound.denied', null, { traceId: actor.traceId, origin, reason, to: maskPhone(typeof input.to === 'string' ? input.to : null) });
      throw error;
    };

    if (input.direction !== 'outbound') return refuse('not_outbound', new CallRequestError('invalid_input', 'Only an outbound call can be placed.'));
    if (input.providerCallId || input.conversationId) return refuse('ingest_fields', new CallRequestError('not_permitted', 'An outbound call gets its provider call when it is dialed.'));
    const to = normalizeDialableNumber(input.to);
    if (!to) return refuse('invalid_destination', new CallRequestError('invalid_input', 'to must be a dialable phone number in international format, such as +15551234567.'));
    const from = input.from ? normalizeDialableNumber(input.from) : undefined;
    if (input.from && !from) return refuse('invalid_caller_id', new CallRequestError('invalid_input', 'from must be a phone number in international format.'));
    let objective: string | null;
    try {
      objective = this.objective(input.objective);
    } catch (error) {
      return refuse('invalid_objective', error as Error);
    }
    // An externally observable side effect: the request must be identifiable, or a retry would dial again.
    if (origin === 'agent' && !actor.idempotencyKey) {
      return refuse('idempotency_key_required', new CallRequestError('idempotency_key_required', 'Placing a call requires an idempotency key, so a retry cannot dial twice.'));
    }
    const requestFingerprint = fingerprint('outbound', from ?? null, to, null, objective);

    // A retry of a request already accepted: the decision was made once. Same call, no second dial.
    if (actor.idempotencyKey) {
      const existing = await this.store.findByIdempotencyKey(actor.accountId, actor.idempotencyKey);
      if (existing) {
        this.assertSameRequest(existing, actor, requestFingerprint);
        this.log('info', 'call.create.replayed', existing, { traceId: actor.traceId });
        return this.executeOutbound(actor, existing);
      }
    }

    const decision = await (this.options.policy ?? denyAllOutboundPolicy).evaluate({
      accountId: actor.accountId, ...(actor.principalId ? { principalId: actor.principalId } : {}), origin, to, ...(from ? { from } : {}),
    });
    if (!decision.allowed) {
      // A concurrent twin of this very request may have been recorded between the replay check and the policy (whose
      // duplicate-destination rule then sees that twin). That is a retry, not a second call: never refuse it as one.
      if (actor.idempotencyKey) {
        const twin = await this.store.findByIdempotencyKey(actor.accountId, actor.idempotencyKey);
        if (twin) {
          this.assertSameRequest(twin, actor, requestFingerprint);
          this.log('info', 'call.create.replayed', twin, { traceId: actor.traceId });
          return this.executeOutbound(actor, twin, origin);
        }
      }
      return refuse(decision.reason, new CallPolicyDeniedError(decision.reason, decision.message));
    }
    this.log('info', 'call.outbound.allowed', null, { traceId: actor.traceId, origin, to: maskPhone(to), from: maskPhone(decision.callerId) });

    const { session } = await this.persist(actor, {
      direction: 'outbound', provider: this.providerName, from: decision.callerId, to,
      providerCallId: null, conversationId: null, objective, fingerprint: requestFingerprint,
    });
    return this.executeOutbound(actor, session, origin);
  }

  /**
   * Asks the provider to place a `created` outbound call, at most once.
   *
   * Failure model, made explicit:
   * - The database write and the provider request are two steps, never one transaction. Between them a
   *   process can die; the durable claim (`initiating`, `dialClaimedAt`) is what says "someone is on it".
   * - The provider refused (a 4xx): definitively no call. The session is `failed` (`provider_rejected`).
   * - The provider timed out, dropped the connection or errored (5xx): a call may exist. The session stays
   *   `initiating`, marked `unconfirmed`. It is not failed and it is never dialed again. A callback or the
   *   answer request, which carry our `callId`, attach the provider id and the session converges; if none
   *   ever arrives, `reconcileUnconfirmedDials` closes it, and the callee's answer is met with a hang-up.
   * - The provider accepted: its id is recorded. Callbacks may arrive before, during or after this, in any
   *   order; they attach the id themselves, so the order never matters.
   */
  private async executeOutbound(actor: CallActor, session: CallSessionRecord, origin: OutboundOrigin = 'agent'): Promise<CallSessionRecord> {
    if (session.direction !== 'outbound' || session.status !== 'created') return session;
    const claim = await claimOutboundDial(this.store, session.id, { now: this.now() });
    if (!claim.claimed || !claim.session) {
      // Another request, instance or process owns the dial, or it is already over. Observe, do not dial.
      this.log('info', 'call.outbound.not_dialed', claim.session ?? session, { traceId: actor.traceId, outcome: claim.outcome });
      return claim.session ?? session;
    }
    const claimed = claim.session;
    this.log('info', 'call.outbound.initiating', claimed, { traceId: actor.traceId, to: maskPhone(claimed.to), from: maskPhone(claimed.from) });

    const provider = this.options.provider;
    const urls = this.options.dialUrls?.(claimed, origin);
    if (!provider || !urls || !claimed.from || !claimed.to) {
      return this.failDial(claimed, actor, 'provider_unavailable', 'rejected', 'No telephony provider is configured for outbound calls.');
    }

    const attempt = provider.createCall({ from: claimed.from, to: claimed.to, answerUrl: urls.answerUrl, statusUrl: urls.statusUrl });
    try {
      const { providerCallId } = await this.withDialTimeout(attempt);
      return await this.recordAccepted(actor, claimed.id, providerCallId);
    } catch (error) {
      if (error instanceof CallProviderRejectedError) {
        return this.failDial(claimed, actor, 'provider_rejected', 'rejected', error.message, error.code);
      }
      // Unknown outcome: a call may exist. Record that, do not fail it, never redial.
      const marked = await this.store.mutate(claimed.id, (current) => (current.providerCallId ? { patch: null } : { patch: { dialOutcome: 'unconfirmed' as const } }));
      this.log('error', 'call.outbound.failed', marked?.session ?? claimed, { traceId: actor.traceId, unconfirmed: true, error: safeError(error) });
      if (error instanceof DialTimeout) {
        // The request is still in flight. If it lands after all, its id is recorded and the call converges.
        void attempt.then(({ providerCallId }) => this.recordAccepted(actor, claimed.id, providerCallId)).catch(() => undefined);
      }
      return marked?.session ?? claimed;
    }
  }

  private async failDial(
    session: CallSessionRecord, actor: CallActor, reason: string, outcome: 'rejected', message: string, code?: string | number,
  ): Promise<CallSessionRecord> {
    const result = await transitionCallSession(this.store, session.id, 'failed', { mode: 'lenient', reason, also: { dialOutcome: outcome }, now: this.now() });
    this.log('error', 'call.outbound.failed', result.session ?? session, { traceId: actor.traceId, unconfirmed: false, reason, code: code ?? null, error: safeError(message) });
    return result.session ?? session;
  }

  private withDialTimeout<T>(attempt: Promise<T>): Promise<T> {
    const limit = this.options.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new DialTimeout()), limit); });
    return Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Records the provider's id for a dialed call. Safe in any order with callbacks that already attached it.
   * If the call was ended or failed while the request was in flight, the call that nevertheless got created is cancelled.
   */
  private async recordAccepted(actor: CallActor, id: string, providerCallId: string): Promise<CallSessionRecord> {
    let conflicting = false;
    const result = await this.store.mutate(id, (current) => {
      if (current.providerCallId && current.providerCallId !== providerCallId) {
        conflicting = true;
        return { patch: null };
      }
      return { patch: { ...(current.providerCallId ? {} : { providerCallId }), ...(current.dialOutcome === 'accepted' ? {} : { dialOutcome: 'accepted' as const }) } };
    });
    if (!result) throw new CallNotFoundError();
    if (conflicting) {
      this.log('error', 'call.outbound.provider_id_conflict', result.session, { traceId: actor.traceId });
      return result.session;
    }
    this.log('info', 'call.outbound.provider_created', result.session, { traceId: actor.traceId });
    if (isTerminal(result.session.status)) {
      // Ended (or failed) while the request was in flight, yet the provider created the call: do not let it ring.
      await this.options.provider?.endCall(providerCallId, { mode: 'cancel' }).catch((error) =>
        this.log('error', 'call.outbound.cancel_after_dial_failed', result.session, { traceId: actor.traceId, error: safeError(error) }));
      this.log('info', 'call.outbound.cancelled_after_dial', result.session, { traceId: actor.traceId });
    }
    return result.session;
  }

  /**
   * A webhook carrying the `callId` we put in its URL proves which session a provider call belongs to, even
   * if our own request to create the call has not come back (or never will). It attaches the provider id.
   */
  async adoptDialedCall(callId: string, providerCallId: string): Promise<CallSessionRecord | null> {
    const session = await this.store.findById(callId);
    if (!session || session.direction !== 'outbound') return null;
    if (session.providerCallId && session.providerCallId !== providerCallId) {
      this.log('error', 'call.outbound.provider_id_conflict', session, { providerCallId });
      return null;
    }
    if (session.providerCallId) return session;
    const result = await this.store.mutate(callId, (current) =>
      current.providerCallId ? { patch: null } : { patch: { providerCallId, dialOutcome: 'accepted' as const } });
    if (result?.changed) {
      this.log('info', 'call.outbound.provider_created', result.session, { via: 'callback' });
      if (isTerminal(result.session.status)) {
        // Ended locally while its dial was unknown, and now the provider call turns up: do not let it ring. Whoever attaches the id does this, once.
        await this.options.provider?.endCall(providerCallId, { mode: 'cancel' }).catch((error) =>
          this.log('warn', 'call.outbound.cancel_after_dial_failed', result.session, { via: 'callback', error: safeError(error) }));
      }
    }
    return result?.session ?? null;
  }

  /**
   * Converges dials whose outcome was never learned (the provider's response was lost, or the process died
   * mid-request). It only ever *asks the provider what exists*: it never creates a call, never redials, and never
   * turns "I do not know" into "failed". For each eligible session, at most one reconciler (the row lock) takes
   * the attempt; then:
   * - exactly one provider call can be ours: its id is attached and the session follows the provider's state;
   * - a call turns up but the session was already ended locally: the id is attached and the call is hung up once;
   *   the session is never moved out of its terminal state;
   * - nothing is found and the provider cannot vouch for that: it stays `unconfirmed` (until attempts run out);
   * - nothing is found and the provider guarantees it would have been listed: `failed`, `rejected`;
   * - several candidates: ambiguous, never guessed.
   * Bounded by batch size, a grace period (> the dial timeout, so an in-flight request is never raced) and a maximum number of attempts.
   */
  async reconcileUnconfirmedDials(options: ReconciliationOptions = {}): Promise<ReconciliationReport> {
    const provider = this.options.provider;
    const dialTimeout = this.options.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS;
    const graceMs = Math.max(options.graceMs ?? DEFAULT_RECONCILIATION_GRACE_MS, dialTimeout * 2);
    const maxAttempts = options.maxAttempts ?? DEFAULT_RECONCILIATION_MAX_ATTEMPTS;
    const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RECONCILIATION_RETRY_MS;
    const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_RECONCILIATION_BATCH, MAX_RECONCILIATION_BATCH));
    const report: ReconciliationReport = { examined: 0, skipped: 0, confirmed: 0, rejected: 0, stillUnconfirmed: 0, failed: 0, cancelledAtProvider: 0, unresolved: 0, exhausted: 0 };
    const now = this.now();
    const claimedBefore = new Date(now.getTime() - graceMs);
    const attemptedBefore = new Date(now.getTime() - retryIntervalMs);
    const candidates = provider ? await this.store.listReconcilableDials({ claimedBefore, attemptedBefore, maxAttempts, limit }) : [];

    const deadline = now.getTime() + (options.budgetMs ?? DEFAULT_RECONCILIATION_BUDGET_MS);
    for (const candidate of candidates) {
      if (this.now().getTime() > deadline) break;
      report.examined += 1;
      const claim = await claimReconciliation(this.store, candidate.id, { now: this.now(), claimedBefore, attemptedBefore, maxAttempts });
      if (!claim.claimed || !claim.session) { report.skipped += 1; continue; }
      try {
        const verdict = await this.reconcileOne(provider!, claim.session, claim.attempt, maxAttempts);
        report[verdict] += 1;
        if (verdict === 'cancelledAtProvider') report.confirmed += 1;
      } catch (error) {
        report.failed += 1;
        this.log('error', 'call.reconciliation.failed', claim.session, { attempt: claim.attempt, maxAttempts, error: safeError(error) });
      }
    }
    const counts = await this.store.countUnresolvedDials(maxAttempts);
    report.unresolved = counts.unresolved;
    report.exhausted = counts.exhausted;
    this.log('info', 'call.reconciliation.summary', null, { ...report });
    return report;
  }

  private async reconcileOne(
    provider: CallProvider, session: CallSessionRecord, attempt: number, maxAttempts: number,
  ): Promise<'confirmed' | 'rejected' | 'stillUnconfirmed' | 'cancelledAtProvider'> {
    this.log('info', 'call.reconciliation.started', session, { attempt, maxAttempts, to: maskPhone(session.to), from: maskPhone(session.from) });
    const claimedAt = session.dialClaimedAt!;
    // The provider created any call of ours after we claimed the dial (allowing for clock skew) and within a bounded time.
    const lookup = await provider.findDialedCalls({
      from: session.from!, to: session.to!,
      createdAfter: new Date(claimedAt.getTime() - RECONCILIATION_CLOCK_SKEW_MS),
      createdBefore: new Date(claimedAt.getTime() + RECONCILIATION_LOOKUP_WINDOW_MS),
    });

    let candidates = lookup.outcome === 'found' ? lookup.calls : [];
    // A provider call another session already owns is not ours.
    const unclaimed = [];
    for (const call of candidates) {
      const owner = await this.store.findByProviderCallId(provider.name, call.providerCallId);
      if (!owner || owner.id === session.id) unclaimed.push(call);
    }
    candidates = unclaimed;

    if (candidates.length === 0 && lookup.outcome === 'not_found' && lookup.conclusive) {
      await this.store.mutate(session.id, (current) => (current.providerCallId || current.dialOutcome === 'rejected' ? { patch: null } : { patch: { dialOutcome: 'rejected' as const } }));
      await this.transition(session.id, 'failed', { mode: 'lenient', reason: 'provider_has_no_such_call' });
      this.log('warn', 'call.reconciliation.rejected', session, { attempt, maxAttempts });
      return 'rejected';
    }
    if (candidates.length !== 1) {
      this.log('warn', 'call.reconciliation.still_unconfirmed', session, {
        attempt, maxAttempts, exhausted: attempt >= maxAttempts, reason: candidates.length === 0 ? 'not_found' : 'ambiguous', candidates: candidates.length,
      });
      return 'stillUnconfirmed';
    }

    const [found] = candidates;
    let attached = false;
    let conflicting = false;
    const result = await this.store.mutate(session.id, (current) => {
      if (current.providerCallId) {
        conflicting = current.providerCallId !== found.providerCallId;
        return { patch: null };
      }
      attached = true;
      return { patch: { providerCallId: found.providerCallId, dialOutcome: 'accepted' as const } };
    });
    if (!result) throw new CallNotFoundError();
    if (conflicting) {
      this.log('error', 'call.outbound.provider_id_conflict', result.session, { attempt });
      return 'stillUnconfirmed';
    }
    // Attached by the callback, the answer webhook or a late response in the meantime: already converged; only catch up.
    let cancelled = false;
    if (isTerminal(result.session.status)) {
      // The call was ended locally while its dial was unknown. Never resurrect it: hang the provider call up, once (by whoever attached it).
      const live = found.status === null ? false : !isTerminal(found.status);
      if (attached && live) {
        const mode = found.status === 'initiating' || found.status === 'ringing' ? 'cancel' : 'complete';
        await provider.endCall(found.providerCallId, { mode }).then(() => { cancelled = true; }, (error) =>
          this.log('error', 'call.reconciliation.failed', result.session, { attempt, maxAttempts, step: 'end_discovered_call', error: safeError(error) }));
      }
    } else if (found.status) {
      await this.transition(session.id, found.status, { mode: 'lenient', reason: 'reconciled' });
    }
    this.log('info', 'call.reconciliation.confirmed', result.session, { attempt, maxAttempts, providerStatus: found.status, endedAtProvider: cancelled });
    return cancelled ? 'cancelledAtProvider' : 'confirmed';
  }

  /** Where an account's outbound calls still in progress are going (for the duplicate-destination rule). */
  async activeOutboundDestinations(accountId: string): Promise<string[]> {
    const active = await this.store.list(accountId, {
      direction: 'outbound', status: ['created', 'initiating', 'ringing', 'answered', 'in_progress', 'ending'], limit: MAX_LIST_LIMIT,
    });
    return active.flatMap((session) => (session.to ? [session.to] : []));
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
      this.log('error', 'call.end.provider_failed', claim.session, { traceId: actor.traceId, error: safeError(error) });
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
    // Cost: whatever usage the callback reports is recorded under the call's own id. A redelivery repeats the same key and records nothing.
    if (this.options.usage && latest && event.status !== null && isTerminal(event.status) && event.durationSeconds !== null && event.durationSeconds !== undefined) {
      await this.options.usage.recordProviderDuration(latest, { provider: event.provider, providerCallId: event.providerCallId, eventId: event.eventId, durationSeconds: event.durationSeconds })
        .catch((error) => this.log('error', 'call.usage.record_failed', latest, { error: safeError(error) }));
    }
    this.log(outcome === 'rejected' || outcome === 'unmapped' ? 'warn' : 'info', `call.event.${outcome}`, latest ?? session, { rawStatus: event.rawStatus, eventId: event.eventId, traceId: event.traceId });
    return { outcome, session: latest };
  }
}
