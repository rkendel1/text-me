import type { CallSessionRecord } from '../model.js';
import { isTerminal } from '../model.js';
import type { CallCostSummary, CostBreakdownEntry, CostComponent, UsageCategory, UsageEvent, UsageRecord } from './model.js';
import { priceUsage, type PriceBook } from './pricing.js';
import type { CostRow } from './store.js';

/**
 * Observations of one subject are successive readings of one quantity: the authoritative one wins, else the latest.
 * (Different subjects are different quantities and add.) Nothing is deleted: the superseded readings stay in the ledger.
 */
export function effectiveRecords(records: readonly UsageRecord[]): UsageRecord[] {
  const best = new Map<string, UsageRecord>();
  for (const record of records) {
    const current = best.get(record.event.subject);
    if (!current || beats(record, current)) best.set(record.event.subject, record);
  }
  return [...best.values()];
}

const beats = (candidate: UsageRecord, current: UsageRecord): boolean => {
  if (candidate.event.basis !== current.event.basis) return candidate.event.basis === 'final';
  const byTime = candidate.event.recordedAt.getTime() - current.event.recordedAt.getTime();
  return byTime !== 0 ? byTime > 0 : candidate.event.id > current.event.id;
};

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

type Call = Pick<CallSessionRecord, 'id' | 'direction' | 'status' | 'provider' | 'answeredAt' | 'endedAt'>;

/**
 * A telephony charge derived from the call's own lifecycle times, for a call whose carrier usage has not been
 * recorded yet (still active, or ended and not yet reported). Estimated by definition, computed on read, never stored.
 */
function deriveTelephony(call: Call, book: PriceBook, now: Date): UsageRecord | null {
  if (!call.answeredAt) return null;
  const end = call.endedAt ?? now;
  const seconds = Math.max(0, (end.getTime() - call.answeredAt.getTime()) / 1000);
  const event: UsageEvent = {
    id: `derived:${call.id}`, callSessionId: call.id, accountId: '', subject: `derived:${call.id}:telephony`, idempotencyKey: `derived:${call.id}`,
    category: 'telephony', provider: call.provider, product: call.direction === 'outbound' ? 'voice_outbound' : 'voice_inbound', model: null,
    metric: 'duration', quantity: seconds, unit: 'second', basis: 'estimated', source: 'provider_callback',
    reportedAmount: null, reportedCurrency: null, occurredAt: call.answeredAt, recordedAt: now, metadata: { derived: true },
  };
  const component = priceUsage(event, book, now, `derived:${call.id}`);
  return component.amount === null ? null : { event, component };
}

/** What a call has cost, from its recorded usage (and, failing any carrier usage, from its lifecycle times). */
export function summarizeCost(call: Call, records: readonly UsageRecord[], book: PriceBook, now: Date): CallCostSummary {
  const effective = effectiveRecords(records);
  let derived = false;
  if (!effective.some((record) => record.event.category === 'telephony')) {
    const estimate = deriveTelephony(call, book, now);
    if (estimate) { effective.push(estimate); derived = true; }
  }
  const currency = effective.find((record) => record.component.currency)?.component.currency ?? 'USD';
  const byCategory = new Map<UsageCategory, { amount: number | null; final: boolean; unpriced: number }>();
  let total: number | null = null;
  let unpricedUsage = 0;
  for (const { event, component } of effective) {
    const entry = byCategory.get(event.category) ?? { amount: null, final: true, unpriced: 0 };
    const priced = component.amount !== null && component.currency === currency;
    if (priced) {
      entry.amount = (entry.amount ?? 0) + component.amount!;
      total = (total ?? 0) + component.amount!;
    } else {
      entry.unpriced += 1;
      unpricedUsage += 1;
    }
    if (event.basis !== 'final') entry.final = false;
    byCategory.set(event.category, entry);
  }
  const breakdown: CostBreakdownEntry[] = [...byCategory].map(([category, entry]) => ({
    category, amount: entry.amount === null ? null : round6(entry.amount), basis: entry.final && entry.unpriced === 0 ? 'final' : 'estimated', unpriced: entry.unpriced,
  }));
  const status = effective.length === 0 ? 'unknown'
    : isTerminal(call.status) && !derived && unpricedUsage === 0 && effective.every((record) => record.event.basis === 'final') ? 'final' : 'estimated';
  return {
    callId: call.id, currency, status, breakdown, unpricedUsage, derived,
    estimatedCost: total === null ? null : round6(total),
    finalCost: status === 'final' && total !== null ? round6(total) : null,
  };
}

export const COST_DIMENSIONS = ['category', 'provider', 'model', 'direction', 'outcome', 'day', 'month'] as const;
export type CostDimension = (typeof COST_DIMENSIONS)[number];

export interface CostGroup {
  key: string;
  /** Priced cost in this group (authoritative and estimated together). */
  amount: number;
  /** ... of which authoritative. */
  finalAmount: number;
  calls: number;
  usageEvents: number;
  /** Usage in the group that has no price (excluded from the amounts). */
  unpriced: number;
  /** Cost divided by the calls in the group: the cost per call (per completed call when grouped by `outcome`, the call's final status). */
  costPerCall: number | null;
}

const keyOf = (row: CostRow, dimension: CostDimension): string => {
  const { event } = row.record;
  switch (dimension) {
    case 'category': return event.category;
    case 'provider': return event.provider;
    case 'model': return event.model ?? '(none)';
    case 'direction': return row.direction;
    case 'outcome': return row.outcome;
    case 'day': return event.occurredAt.toISOString().slice(0, 10);
    case 'month': return event.occurredAt.toISOString().slice(0, 7);
  }
};

/**
 * Groups priced usage by one dimension. Superseded readings are left out (one reading per subject), so a
 * correction never double counts. Only priced amounts add; unpriced usage is counted and reported separately.
 */
export function aggregateCosts(rows: readonly CostRow[], dimension: CostDimension, currency = 'USD'): CostGroup[] {
  const bySubject = new Map<string, CostRow[]>();
  for (const row of rows) bySubject.set(row.record.event.subject, [...(bySubject.get(row.record.event.subject) ?? []), row]);
  const chosen = [...bySubject.values()].map((group) => {
    const winner = effectiveRecords(group.map((row) => row.record))[0];
    return group.find((row) => row.record === winner)!;
  });
  const groups = new Map<string, { amount: number; finalAmount: number; calls: Set<string>; events: number; unpriced: number }>();
  for (const row of chosen) {
    const key = keyOf(row, dimension);
    const group = groups.get(key) ?? { amount: 0, finalAmount: 0, calls: new Set<string>(), events: 0, unpriced: 0 };
    const { event, component } = row.record;
    group.calls.add(event.callSessionId);
    group.events += 1;
    if (component.amount !== null && component.currency === currency) {
      group.amount += component.amount;
      if (event.basis === 'final') group.finalAmount += component.amount;
    } else group.unpriced += 1;
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => ({
    key, amount: round6(group.amount), finalAmount: round6(group.finalAmount), calls: group.calls.size, usageEvents: group.events, unpriced: group.unpriced,
    costPerCall: group.calls.size ? round6(group.amount / group.calls.size) : null,
  })).sort((left, right) => left.key.localeCompare(right.key));
}

export type { CostComponent };
