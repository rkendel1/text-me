import type { CallDirection, CallSessionRecord, CallSessionStatus } from '../model.js';
import type { CostComponent, UsageEvent, UsageRecord } from './model.js';

/** A usage record with the facts about its call that aggregation groups by. */
export interface CostRow {
  record: UsageRecord;
  direction: CallDirection;
  outcome: CallSessionStatus;
  callProvider: string;
  callCreatedAt: Date;
}

export interface CostRowQuery {
  accountId: string;
  /** By the usage's `occurredAt`: inclusive start, exclusive end. */
  from?: Date;
  to?: Date;
  limit: number;
}

export interface AwaitingFinalUsageQuery {
  /** Newest first, so calls the carrier will never report on cannot starve fresh ones. Terminal calls that ended in this window, tied to a provider call, with no authoritative telephony usage yet. */
  endedAfter: Date;
  endedBefore: Date;
  limit: number;
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
  findCallsAwaitingFinalUsage(query: AwaitingFinalUsageQuery): Promise<CallSessionRecord[]>;
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
      .filter((record) => record.event.accountId === query.accountId &&
        (!query.from || record.event.occurredAt >= query.from) && (!query.to || record.event.occurredAt < query.to))
      .slice(0, query.limit)
      .flatMap((record) => {
        const call = calls.get(record.event.callSessionId);
        return call ? [{ record: structuredClone(record), direction: call.direction, outcome: call.status, callProvider: call.provider, callCreatedAt: call.createdAt }] : [];
      });
  }

  async findCallsAwaitingFinalUsage(query: AwaitingFinalUsageQuery): Promise<CallSessionRecord[]> {
    const hasFinal = new Set(this.records.filter((record) => record.event.basis === 'final' && record.event.category === 'telephony').map((record) => record.event.callSessionId));
    return this.sessions()
      .filter((session) => ['completed', 'failed', 'no_answer', 'busy', 'canceled'].includes(session.status) && !!session.providerCallId && !!session.endedAt &&
        session.endedAt >= query.endedAfter && session.endedAt < query.endedBefore && !hasFinal.has(session.id))
      .sort((left, right) => right.endedAt!.getTime() - left.endedAt!.getTime())
      .slice(0, query.limit)
      .map((session) => structuredClone(session));
  }
}
