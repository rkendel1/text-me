import type { CallDirection, CallSessionRecord, CallSessionStatus } from '../model.js';
import type { CostComponent, UsageEvent, UsageRecord } from './model.js';

/** A usage record with the facts about its call that aggregation groups by. */
export interface CostRow {
  record: UsageRecord;
  /** The call's facts, enough to judge its cost status. */
  call: Pick<CallSessionRecord, 'id' | 'accountId' | 'direction' | 'status' | 'provider' | 'answeredAt' | 'endedAt'>;
  direction: CallDirection;
  outcome: CallSessionStatus;
  callProvider: string;
  callCreatedAt: Date;
}

export interface CostRowQuery {
  /** Absent: every account (internal health inspection only; never reachable from a request). */
  accountId?: string;
  /** By the usage's `occurredAt`: inclusive start, exclusive end. */
  from?: Date;
  to?: Date;
  limit: number;
}

export interface FinalizationQuery {
  /** Restrict to one account (operational use and tests). The cron passes none: it serves every account. */
  accountId?: string;
  /** Terminal calls that ended in this window, tied to a provider call, with no authoritative telephony usage yet. */
  endedAfter: Date;
  endedBefore: Date;
  /** Not asked since this time (spacing between attempts on one call). */
  retryBefore: Date;
  /** Calls asked this many times are exhausted: no longer selected, still counted. */
  maxAttempts: number;
  limit: number;
}

/** Operational record of asking the carrier about a call (not accounting: it is updated in place). */
export interface FinalizationState {
  callSessionId: string;
  attempts: number;
  lastAttemptAt: Date;
  lastOutcome: string | null;
}

/**
 * The ledger's persistence. Insert-only by design: there is no update or delete, so a recorded observation or
 * price cannot be changed, only superseded by a later observation.
 */
export interface CallUsageStore {
  /** Records the event and its price together, once. A repeat of the same idempotency key records nothing and returns the original. */
  append(event: UsageEvent, component: CostComponent): Promise<{ record: UsageRecord; duplicate: boolean }>;
  listForCall(accountId: string, callSessionId: string): Promise<UsageRecord[]>;
  listCostRows(query: CostRowQuery): Promise<CostRow[]>;
  /**
   * Fair selection: calls never asked first (oldest first), then those asked least recently. Bounded by attempts, so
   * an old call the carrier never settles is asked a fixed number of times and then left alone, not asked forever
   * and not ahead of newer calls.
   */
  findFinalizationCandidates(query: FinalizationQuery): Promise<CallSessionRecord[]>;
  /** Takes one attempt on a call, once across instances: `null` when it is exhausted or was asked too recently. */
  claimFinalizationAttempt(callSessionId: string, claim: { now: Date; retryBefore: Date; maxAttempts: number }): Promise<number | null>;
  recordFinalizationOutcome(callSessionId: string, outcome: string): Promise<void>;
  getFinalizationState(callSessionId: string): Promise<FinalizationState | null>;
  /** Ended calls tied to a provider call with no authoritative telephony usage: still being asked about, and given up on. */
  finalizationBacklog(query: { endedAfter: Date; maxAttempts: number; accountId?: string }): Promise<{ pending: number; exhausted: number }>;
}

export class InMemoryCallUsageStore implements CallUsageStore {
  private readonly records: UsageRecord[] = [];

  /** `sessions` is where call facts come from (the CallSession store). */
  constructor(private readonly sessions: () => readonly CallSessionRecord[] = () => []) {}

  async append(event: UsageEvent, component: CostComponent): Promise<{ record: UsageRecord; duplicate: boolean }> {
    const existing = this.records.find((candidate) => candidate.event.idempotencyKey === event.idempotencyKey);
    if (existing) return { record: structuredClone(existing), duplicate: true };
    const record = { event: structuredClone(event), component: structuredClone(component) };
    this.records.push(record);
    return { record: structuredClone(record), duplicate: false };
  }

  async listForCall(accountId: string, callSessionId: string): Promise<UsageRecord[]> {
    return this.records.filter((record) => record.event.accountId === accountId && record.event.callSessionId === callSessionId).map((record) => structuredClone(record));
  }

  async listCostRows(query: CostRowQuery): Promise<CostRow[]> {
    const calls = new Map(this.sessions().map((session) => [session.id, session]));
    return this.records
      .filter((record) => (!query.accountId || record.event.accountId === query.accountId) &&
        (!query.from || record.event.occurredAt >= query.from) && (!query.to || record.event.occurredAt < query.to))
      .slice(0, query.limit)
      .flatMap((record) => {
        const call = calls.get(record.event.callSessionId);
        return call ? [{ record: structuredClone(record), call: structuredClone(call), direction: call.direction, outcome: call.status, callProvider: call.provider, callCreatedAt: call.createdAt }] : [];
      });
  }

  private readonly finalization = new Map<string, FinalizationState>();

  private awaiting(accountId?: string): CallSessionRecord[] {
    const hasFinal = new Set(this.records.filter((record) => record.event.basis === 'final' && record.event.category === 'telephony').map((record) => record.event.callSessionId));
    return this.sessions().filter((session) => (!accountId || session.accountId === accountId) && ['completed', 'failed', 'no_answer', 'busy', 'canceled'].includes(session.status) && !!session.providerCallId && !!session.endedAt && !hasFinal.has(session.id));
  }

  async findFinalizationCandidates(query: FinalizationQuery): Promise<CallSessionRecord[]> {
    return this.awaiting(query.accountId)
      .filter((session) => {
        const state = this.finalization.get(session.id);
        return session.endedAt! >= query.endedAfter && session.endedAt! < query.endedBefore &&
          (!state || (state.attempts < query.maxAttempts && state.lastAttemptAt < query.retryBefore));
      })
      .sort((left, right) => {
        const a = this.finalization.get(left.id)?.lastAttemptAt.getTime() ?? -Infinity;
        const b = this.finalization.get(right.id)?.lastAttemptAt.getTime() ?? -Infinity;
        return a - b || left.endedAt!.getTime() - right.endedAt!.getTime();
      })
      .slice(0, query.limit)
      .map((session) => structuredClone(session));
  }

  async claimFinalizationAttempt(callSessionId: string, claim: { now: Date; retryBefore: Date; maxAttempts: number }): Promise<number | null> {
    const state = this.finalization.get(callSessionId);
    if (state && (state.attempts >= claim.maxAttempts || state.lastAttemptAt >= claim.retryBefore)) return null;
    const attempts = (state?.attempts ?? 0) + 1;
    this.finalization.set(callSessionId, { callSessionId, attempts, lastAttemptAt: claim.now, lastOutcome: state?.lastOutcome ?? null });
    return attempts;
  }

  async recordFinalizationOutcome(callSessionId: string, outcome: string): Promise<void> {
    const state = this.finalization.get(callSessionId);
    if (state) state.lastOutcome = outcome;
  }

  async getFinalizationState(callSessionId: string): Promise<FinalizationState | null> {
    const state = this.finalization.get(callSessionId);
    return state ? { ...state } : null;
  }

  async finalizationBacklog(query: { endedAfter: Date; maxAttempts: number; accountId?: string }): Promise<{ pending: number; exhausted: number }> {
    const awaiting = this.awaiting(query.accountId);
    const exhausted = awaiting.filter((session) => (this.finalization.get(session.id)?.attempts ?? 0) >= query.maxAttempts).length;
    const pending = awaiting.filter((session) => session.endedAt! >= query.endedAfter && (this.finalization.get(session.id)?.attempts ?? 0) < query.maxAttempts).length;
    return { pending, exhausted };
  }
}
