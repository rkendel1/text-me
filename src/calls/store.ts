import type { CallDirection, CallSessionRecord, CallSessionStatus, DialOutcome } from './model.js';

/** The fields a mutation may change. `status` is written only by `transitionCallSession`. */
export interface CallSessionPatch {
  status?: CallSessionStatus;
  providerCallId?: string | null;
  conversationId?: string | null;
  from?: string | null;
  to?: string | null;
  startedAt?: Date | null;
  answeredAt?: Date | null;
  endedAt?: Date | null;
  endReason?: string | null;
  endClaimedAt?: Date | null;
  lastProviderStatus?: string | null;
  dialClaimedAt?: Date | null;
  dialOutcome?: DialOutcome | null;
  reconciliationAttempts?: number;
  lastReconciliationAt?: Date | null;
}

/** One provider callback, identified by the provider and its event id. */
export interface ProviderEventInput {
  provider: string;
  eventId: string;
  rawStatus: string;
  sequence?: string | null;
  providerTimestamp?: string | null;
}

export interface MutationOutcome {
  /** The patch to persist, or null to change nothing. */
  patch: CallSessionPatch | null;
  /** How the provider event (if one is being recorded) turned out, for diagnosis. */
  eventOutcome?: string;
}

export interface MutationResult {
  session: CallSessionRecord;
  /** True when something was persisted. */
  changed: boolean;
  /** True when this provider event had been recorded before: nothing was run or changed. */
  duplicateEvent: boolean;
}

export interface CallSessionFilter {
  status?: readonly CallSessionStatus[];
  direction?: CallDirection;
  createdAfter?: Date;
  createdBefore?: Date;
  limit: number;
  /** Return only sessions strictly older than this (createdAt, id). */
  after?: { createdAt: Date; id: string };
}

export interface ReconcilableDialCriteria {
  claimedBefore: Date;
  attemptedBefore: Date;
  maxAttempts: number;
  limit: number;
}

export interface CallSessionStore {
  /**
   * Inserts a new session. If one already exists for the same account + idempotency key, or the
   * same provider call, returns that one with `created: false`; the caller decides whether it is a
   * legitimate replay (same account, same request) or a conflict.
   */
  insert(record: CallSessionRecord): Promise<{ session: CallSessionRecord; created: boolean }>;
  /** Tenant-scoped read: a session of another account is simply absent. */
  get(accountId: string, id: string): Promise<CallSessionRecord | null>;
  /** Webhook-side lookup by the provider's own id. Callers must check `accountId` themselves. */
  findByProviderCallId(provider: string, providerCallId: string): Promise<CallSessionRecord | null>;
  /** The session a tenant's request with this idempotency key created, if any. */
  findByIdempotencyKey(accountId: string, idempotencyKey: string): Promise<CallSessionRecord | null>;
  /** Webhook-side lookup by our own id (a URL we gave the provider). Callers must check `accountId` themselves. */
  findById(id: string): Promise<CallSessionRecord | null>;
  /**
   * Outbound dials whose outcome is still unknown: claimed before `claimedBefore`, never tied to a provider call,
   * not yet proven accepted or rejected, reconciled fewer than `maxAttempts` times and not looked at since
   * `attemptedBefore`. Whatever the session's local status is (it may have been ended meanwhile). Oldest first.
   */
  listReconcilableDials(criteria: ReconcilableDialCriteria): Promise<CallSessionRecord[]>;
  /** Dials still unknown, and how many of them reconciliation has given up on (attempts used up). */
  countUnresolvedDials(maxAttempts: number): Promise<{ unresolved: number; exhausted: number }>;
  findByConversation(accountId: string, conversationId: string): Promise<CallSessionRecord | null>;
  list(accountId: string, filter: CallSessionFilter): Promise<CallSessionRecord[]>;
  /**
   * Atomically: load the session (locking it), optionally record the provider event (a repeat is
   * reported, not re-run), let `decide` compute a patch from the current state, persist it, and
   * bump `version`/`updatedAt`. This is the only way a session changes after insert.
   */
  mutate(
    id: string,
    decide: (current: CallSessionRecord) => MutationOutcome,
    options?: { providerEvent?: ProviderEventInput; now?: Date },
  ): Promise<MutationResult | null>;
}

/** A dial that was claimed, is tied to no provider call, and is neither proven accepted nor proven rejected. */
export const isUnresolvedDial = (record: CallSessionRecord): boolean =>
  record.direction === 'outbound' && !record.providerCallId && !!record.dialClaimedAt &&
  (record.dialOutcome === 'pending' || record.dialOutcome === 'unconfirmed');

const matches = (record: CallSessionRecord, filter: CallSessionFilter): boolean =>
  (!filter.status?.length || filter.status.includes(record.status)) &&
  (!filter.direction || record.direction === filter.direction) &&
  (!filter.createdAfter || record.createdAt > filter.createdAfter) &&
  (!filter.createdBefore || record.createdAt < filter.createdBefore);

const newestFirst = (left: CallSessionRecord, right: CallSessionRecord): number =>
  right.createdAt.getTime() - left.createdAt.getTime() || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);

export function applyPatch(current: CallSessionRecord, patch: CallSessionPatch, now: Date): CallSessionRecord {
  return { ...current, ...patch, updatedAt: now, version: current.version + 1 };
}

/** In-memory store for tests and local development. Single-threaded, so each `mutate` is atomic. */
export class InMemoryCallSessionStore implements CallSessionStore {
  private readonly sessions = new Map<string, CallSessionRecord>();
  private readonly events = new Map<string, { outcome?: string }>();

  /** Every session held (for the in-memory cost ledger's joins). */
  all(): CallSessionRecord[] {
    return [...this.sessions.values()].map((record) => structuredClone(record));
  }

  async insert(record: CallSessionRecord): Promise<{ session: CallSessionRecord; created: boolean }> {
    const existing = [...this.sessions.values()].find((candidate) =>
      (record.providerCallId !== null && candidate.provider === record.provider && candidate.providerCallId === record.providerCallId) ||
      (record.idempotencyKey !== null && candidate.accountId === record.accountId && candidate.idempotencyKey === record.idempotencyKey));
    if (existing) return { session: structuredClone(existing), created: false };
    this.sessions.set(record.id, structuredClone(record));
    return { session: structuredClone(record), created: true };
  }

  async get(accountId: string, id: string): Promise<CallSessionRecord | null> {
    const found = this.sessions.get(id);
    return found && found.accountId === accountId ? structuredClone(found) : null;
  }

  async findByProviderCallId(provider: string, providerCallId: string): Promise<CallSessionRecord | null> {
    const found = [...this.sessions.values()].find((candidate) => candidate.provider === provider && candidate.providerCallId === providerCallId);
    return found ? structuredClone(found) : null;
  }

  async findByIdempotencyKey(accountId: string, idempotencyKey: string): Promise<CallSessionRecord | null> {
    const found = [...this.sessions.values()].find((candidate) => candidate.accountId === accountId && candidate.idempotencyKey === idempotencyKey);
    return found ? structuredClone(found) : null;
  }

  async findById(id: string): Promise<CallSessionRecord | null> {
    const found = this.sessions.get(id);
    return found ? structuredClone(found) : null;
  }

  async listReconcilableDials(criteria: ReconcilableDialCriteria): Promise<CallSessionRecord[]> {
    return [...this.sessions.values()]
      .filter((record) => isUnresolvedDial(record) && record.dialClaimedAt! < criteria.claimedBefore &&
        record.reconciliationAttempts < criteria.maxAttempts &&
        (!record.lastReconciliationAt || record.lastReconciliationAt < criteria.attemptedBefore))
      .sort((left, right) => left.dialClaimedAt!.getTime() - right.dialClaimedAt!.getTime())
      .slice(0, criteria.limit)
      .map((record) => structuredClone(record));
  }

  async countUnresolvedDials(maxAttempts: number): Promise<{ unresolved: number; exhausted: number }> {
    const unresolved = [...this.sessions.values()].filter(isUnresolvedDial);
    return { unresolved: unresolved.length, exhausted: unresolved.filter((record) => record.reconciliationAttempts >= maxAttempts).length };
  }

  async findByConversation(accountId: string, conversationId: string): Promise<CallSessionRecord | null> {
    const found = [...this.sessions.values()].find((candidate) => candidate.accountId === accountId && candidate.conversationId === conversationId);
    return found ? structuredClone(found) : null;
  }

  async list(accountId: string, filter: CallSessionFilter): Promise<CallSessionRecord[]> {
    return [...this.sessions.values()]
      .filter((record) => record.accountId === accountId && matches(record, filter))
      .sort(newestFirst)
      .filter((record) => !filter.after || record.createdAt < filter.after.createdAt ||
        (record.createdAt.getTime() === filter.after.createdAt.getTime() && record.id < filter.after.id))
      .slice(0, filter.limit)
      .map((record) => structuredClone(record));
  }

  async mutate(
    id: string,
    decide: (current: CallSessionRecord) => MutationOutcome,
    options: { providerEvent?: ProviderEventInput; now?: Date } = {},
  ): Promise<MutationResult | null> {
    const current = this.sessions.get(id);
    if (!current) return null;
    const now = options.now ?? new Date();
    const eventKey = options.providerEvent ? `${options.providerEvent.provider}|${options.providerEvent.eventId}` : undefined;
    if (eventKey && this.events.has(eventKey)) return { session: structuredClone(current), changed: false, duplicateEvent: true };
    const outcome = decide(structuredClone(current));
    if (eventKey) this.events.set(eventKey, { outcome: outcome.eventOutcome });
    if (!outcome.patch || Object.keys(outcome.patch).length === 0) {
      return { session: structuredClone(current), changed: false, duplicateEvent: false };
    }
    const next = applyPatch(current, outcome.patch, now);
    this.sessions.set(id, next);
    return { session: structuredClone(next), changed: true, duplicateEvent: false };
  }
}
