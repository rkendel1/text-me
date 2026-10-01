import { randomUUID } from 'node:crypto';

import { consoleCallLogger, type CallLogger } from '../log.js';
import type { CallSessionRecord } from '../model.js';
import type { CallProvider, ProviderUsageReport } from '../provider.js';
import { aggregateCosts, summarizeCost, type CostDimension, type CostGroup, type SummaryOptions } from './analysis.js';
import type { CallCostSummary, UsageCategory, UsageEvent, UsageEventInput, UsageMetric, UsageRecord } from './model.js';
import { priceUsage, StaticPriceBook, type PriceBook } from './pricing.js';
import { REFERENCE_RATES } from '../../billing/call-reference-rates.js';
import type { CallUsageStore, CostRow } from './store.js';

/** The facts about a call the ledger needs. The caller has already established the call belongs to the account. */
export type LedgerCall = Pick<CallSessionRecord, 'id' | 'accountId' | 'direction' | 'status' | 'provider' | 'answeredAt' | 'endedAt'>;

export interface CallCostLedgerOptions {
  priceBook?: PriceBook;
  now?: () => Date;
  logger?: CallLogger;
  /** The categories the carrier in use can settle per call (`CallProvider.authoritativeUsage`). */
  carrierSettles?: readonly UsageCategory[];
}

export const MAX_AGGREGATION_ROWS = 20_000;
/** How long after a call ends the carrier is given to settle its figures before they are asked for. */
export const DEFAULT_FINALIZATION_SETTLE_MS = 10 * 60_000;
/** The horizon: calls that ended longer ago than this are no longer selected. */
export const FINALIZATION_HORIZON_MS = 48 * 3_600_000;
/** At most one attempt on a call per interval, and at most this many in all (24 hourly attempts fit inside the horizon). */
export const FINALIZATION_RETRY_MS = 60 * 60_000;
export const FINALIZATION_MAX_ATTEMPTS = 24;

export interface LedgerHealth {
  /** Calls with usage in the window. */
  calls: number;
  authoritative: number;
  estimated: number;
  withUnpricedUsage: number;
  /** Calls holding estimates that can never settle (no per-call authoritative figure, or the figure was unavailable). */
  nonFinalizable: number;
  /** Ended calls (inside the horizon) still waiting for the carrier's settled figure. */
  pendingRating: number;
  /** Ended calls the carrier never settled within the attempts allowed. Still estimated. */
  exhausted: number;
  truncated: boolean;
}

export interface FinalizationReport {
  examined: number;
  /** Selected but taken by another instance, or asked too recently. */
  skipped: number;
  /** Observations newly recorded. */
  recorded: number;
  /** Observations already in the ledger (a repeat). */
  duplicates: number;
  /** The provider had nothing, or only an interim figure, for the call yet. */
  notReady: number;
  failed: number;
  /** Across all calls after the run: still being asked about, and given up on. */
  pending: number;
  exhausted: number;
}

/**
 * The cost ledger: records usage observations, prices them once, and answers what a call (or a set of calls) cost.
 * It knows nothing about any carrier or AI vendor. Adapters and the runtime hand it normalized usage.
 */
export class CallCostLedger {
  private readonly priceBook: PriceBook;
  private readonly now: () => Date;
  private readonly logger: CallLogger;
  private readonly summaryOptions: SummaryOptions;

  constructor(private readonly store: CallUsageStore, options: CallCostLedgerOptions = {}) {
    this.summaryOptions = options.carrierSettles ? { carrierSettles: new Set(options.carrierSettles) } : {};
    this.priceBook = options.priceBook ?? new StaticPriceBook(REFERENCE_RATES);
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? consoleCallLogger;
  }

  /**
   * Records one observation and its price. The same idempotency key records nothing the second time, so a replayed
   * webhook or a retried job cannot add cost.
   */
  async record(call: LedgerCall, input: Omit<UsageEventInput, 'callSessionId' | 'accountId'>): Promise<{ record: UsageRecord; duplicate: boolean }> {
    const now = this.now();
    const event: UsageEvent = {
      reportedAmount: null, reportedCurrency: null, metadata: {}, model: null, ...input,
      // Scoped to the call: an identity that could collide across calls would silently drop a real observation.
      subject: `${call.id}|${input.subject}`, idempotencyKey: `${call.id}|${input.idempotencyKey}`,
      id: `use_${randomUUID().replaceAll('-', '')}`, callSessionId: call.id, accountId: call.accountId, recordedAt: now,
    };
    if (!(event.quantity >= 0) || !Number.isFinite(event.quantity)) throw new Error('Usage quantity must be a non-negative number.');
    const component = priceUsage(event, this.priceBook, now, `cost_${randomUUID().replaceAll('-', '')}`);
    const result = await this.store.append(event, component);
    this.logger.log('info', result.duplicate ? 'call.usage.duplicate' : 'call.usage.recorded', {
      callId: call.id, providerCallId: null, traceId: null, category: event.category, provider: event.provider, product: event.product,
      metric: event.metric, basis: event.basis, quantity: event.quantity, unit: event.unit, priced: result.record.component.rateSource,
    });
    return result;
  }

  /** The carrier's own callback reported how long the call was connected. An interim figure: the carrier's settled record supersedes it. */
  async recordProviderDuration(call: LedgerCall, event: { provider: string; providerCallId: string; eventId: string; durationSeconds: number | null | undefined }): Promise<void> {
    if (event.durationSeconds === null || event.durationSeconds === undefined || !Number.isFinite(event.durationSeconds) || event.durationSeconds < 0) return;
    await this.record(call, {
      subject: `${event.provider}:${event.providerCallId}:duration`, idempotencyKey: `callback:${event.provider}:${event.eventId}:duration`,
      category: 'telephony', provider: event.provider, product: call.direction === 'outbound' ? 'voice_outbound' : 'voice_inbound',
      metric: 'duration', quantity: event.durationSeconds, unit: 'second', basis: 'estimated', source: 'provider_callback', occurredAt: call.answeredAt ?? this.now(),
      metadata: { providerCallId: event.providerCallId },
    });
  }

  /** What a provider adapter reports for a call, normalized. Idempotent per observation. */
  async recordProviderReport(call: LedgerCall, report: ProviderUsageReport): Promise<{ recorded: number; duplicates: number }> {
    let recorded = 0;
    let duplicates = 0;
    for (const observation of report.observations) {
      const subject = `${call.provider}:${report.providerCallId}:${observation.key}`;
      const { duplicate } = await this.record(call, {
        subject, idempotencyKey: `report:${subject}:${observation.basis}:${observation.quantity}:${observation.reportedAmount ?? ''}`,
        category: observation.category, provider: call.provider, product: observation.product, metric: observation.metric, quantity: observation.quantity,
        unit: observation.unit, basis: observation.basis, source: 'provider_usage_report', occurredAt: call.answeredAt ?? call.endedAt ?? this.now(),
        reportedAmount: observation.reportedAmount ?? null, reportedCurrency: observation.currency ?? null, metadata: observation.metadata ?? {},
      });
      if (duplicate) duplicates += 1; else recorded += 1;
    }
    return { recorded, duplicates };
  }

  /**
   * Usage the AI runtime reported for one response: whatever dimensions it reported, nothing it did not. Nothing is
   * derived from elapsed time. `modelId` may be vendor-qualified (`vendor/model`); the vendor is the AI provider.
   */
  async recordAiUsage(call: LedgerCall, usage: { modelId: string; responseId: string; metrics: Partial<Record<UsageMetric, number>>; occurredAt?: Date; metadata?: Record<string, unknown> }): Promise<void> {
    const slash = usage.modelId.indexOf('/');
    const provider = slash > 0 ? usage.modelId.slice(0, slash) : 'unknown';
    const model = slash > 0 ? usage.modelId.slice(slash + 1) : usage.modelId;
    for (const [metric, quantity] of Object.entries(usage.metrics) as Array<[UsageMetric, number]>) {
      if (!Number.isFinite(quantity) || quantity < 0) continue;
      const subject = `ai:${call.id}:${usage.responseId}:${metric}`;
      await this.record(call, {
        subject, idempotencyKey: subject, category: 'ai_voice', provider, product: 'realtime', model, metric, quantity, unit: 'token',
        basis: 'final', source: 'ai_runtime', occurredAt: usage.occurredAt ?? this.now(), metadata: { modelId: usage.modelId, responseId: usage.responseId, ...usage.metadata },
      });
    }
  }

  /**
   * The runtime finished a response and reported no usage for it (recorded once per call). Recorded as an unavailable observation (an
   * estimate that can never settle, with nothing priced) so the call is not mistaken for fully accounted. No token
   * count is derived from time or transcript.
   */
  async recordAiUsageUnavailable(call: LedgerCall, usage: { modelId: string; responseId: string }): Promise<void> {
    const slash = usage.modelId.indexOf('/');
    const subject = `ai:${call.id}:usage_unavailable`;
    await this.record(call, {
      subject, idempotencyKey: subject, category: 'ai_voice', provider: slash > 0 ? usage.modelId.slice(0, slash) : 'unknown', product: 'realtime',
      model: slash > 0 ? usage.modelId.slice(slash + 1) : usage.modelId, metric: 'invocation', quantity: 1, unit: 'call', basis: 'estimated', source: 'ai_runtime',
      occurredAt: this.now(), metadata: { unavailable: true, firstResponseId: usage.responseId },
    });
  }

  /** How long one media stream was open, as this application observed it. Estimated: the carrier's own figure, if it ever reports one, supersedes it. */
  async recordMediaStream(call: LedgerCall, stream: { streamSid: string; seconds: number; startedAt: Date }): Promise<void> {
    if (!(stream.seconds >= 0)) return;
    const subject = `${call.provider}:${call.id}:media_stream:${stream.streamSid}`;
    await this.record(call, {
      subject, idempotencyKey: subject, category: 'media', provider: call.provider, product: 'media_stream', metric: 'duration',
      quantity: stream.seconds, unit: 'second', basis: 'estimated', source: 'media_stream', occurredAt: stream.startedAt, metadata: { streamSid: stream.streamSid },
    });
  }

  /** A recording the carrier made, with the duration it reported. */
  async recordRecording(call: LedgerCall, recording: { recordingSid: string; seconds: number; providerCallId: string }): Promise<void> {
    if (!(recording.seconds >= 0)) return;
    // The same subject the carrier's own report uses for this recording, so its settled figure supersedes this estimate.
    const subject = `${call.provider}:${recording.providerCallId}:recording:${recording.recordingSid}`;
    await this.record(call, {
      subject, idempotencyKey: subject, category: 'recording', provider: call.provider, product: 'recording', metric: 'duration',
      quantity: recording.seconds, unit: 'second', basis: 'estimated', source: 'recording_callback', occurredAt: this.now(), metadata: { recordingSid: recording.recordingSid },
    });
  }

  /** The durable ledger for one call, as recorded (every observation, including superseded ones). */
  listForCall(accountId: string, callSessionId: string): Promise<UsageRecord[]> {
    return this.store.listForCall(accountId, callSessionId);
  }

  /** What the call has cost. Read-only: never writes, so it can never alter settled accounting. */
  async summarize(call: LedgerCall): Promise<CallCostSummary> {
    return summarizeCost(call, await this.store.listForCall(call.accountId, call.id), this.priceBook, this.now(), this.summaryOptions);
  }

  /** Cost grouped by one dimension over a window (usage occurring in `[from, to)`), from the durable ledger. */
  async aggregate(query: { accountId: string; dimension: CostDimension; from?: Date; to?: Date; currency?: string }): Promise<{ groups: CostGroup[]; truncated: boolean }> {
    const rows = await this.store.listCostRows({ accountId: query.accountId, from: query.from, to: query.to, limit: MAX_AGGREGATION_ROWS + 1 });
    return { groups: aggregateCosts(rows.slice(0, MAX_AGGREGATION_ROWS), query.dimension, query.currency), truncated: rows.length > MAX_AGGREGATION_ROWS };
  }

  /**
   * Asks the carrier for its settled usage on calls that have ended and have none recorded. Read-only at the
   * provider, bounded, and safe to run from several instances: each call is asked at most once per retry interval
   * (a durable attempt claim), a bounded number of times, and the idempotency keys make a repeat record nothing.
   * Selection is fair: never-asked calls first, then the least recently asked, so no call is starved by newer ones
   * and none is asked forever. A call the carrier has not rated yet is left for a later attempt; one that uses up
   * its attempts is exhausted: still counted, still estimated, never treated as authoritative.
   */
  async finalizeCompletedCalls(provider: CallProvider, options: { limit?: number; settleMs?: number; maxAgeMs?: number; retryIntervalMs?: number; maxAttempts?: number; accountId?: string } = {}): Promise<FinalizationReport> {
    const now = this.now();
    const maxAttempts = options.maxAttempts ?? FINALIZATION_MAX_ATTEMPTS;
    const retryBefore = new Date(now.getTime() - (options.retryIntervalMs ?? FINALIZATION_RETRY_MS));
    const endedAfter = new Date(now.getTime() - (options.maxAgeMs ?? FINALIZATION_HORIZON_MS));
    const calls = await this.store.findFinalizationCandidates({
      endedAfter, endedBefore: new Date(now.getTime() - (options.settleMs ?? DEFAULT_FINALIZATION_SETTLE_MS)), retryBefore, maxAttempts, accountId: options.accountId,
      limit: Math.max(1, Math.min(options.limit ?? 25, 100)),
    });
    const report: FinalizationReport = { examined: 0, skipped: 0, recorded: 0, duplicates: 0, notReady: 0, failed: 0, pending: 0, exhausted: 0 };
    for (const call of calls.filter((candidate) => candidate.provider === provider.name)) {
      const attempt = await this.store.claimFinalizationAttempt(call.id, { now: this.now(), retryBefore, maxAttempts });
      if (attempt === null) { report.skipped += 1; continue; }
      report.examined += 1;
      try {
        const usage = await provider.getCallUsage(call.providerCallId!);
        if (!usage || usage.observations.length === 0) { report.notReady += 1; await this.store.recordFinalizationOutcome(call.id, 'not_ready'); continue; }
        const result = await this.recordProviderReport(call, usage);
        report.recorded += result.recorded;
        report.duplicates += result.duplicates;
        const settled = usage.observations.some((observation) => observation.category === 'telephony' && observation.basis === 'final');
        if (!settled) report.notReady += 1;
        await this.store.recordFinalizationOutcome(call.id, settled ? 'settled' : 'interim');
      } catch (error) {
        report.failed += 1;
        await this.store.recordFinalizationOutcome(call.id, 'failed').catch(() => undefined);
        this.logger.log('error', 'call.usage.finalization_failed', { callId: call.id, providerCallId: call.providerCallId, traceId: null, attempt, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
      }
    }
    const backlog = await this.store.finalizationBacklog({ endedAfter, maxAttempts, accountId: options.accountId });
    report.pending = backlog.pending;
    report.exhausted = backlog.exhausted;
    this.logger.log('info', 'call.usage.finalization_summary', { callId: null, providerCallId: null, traceId: null, ...report });
    return report;
  }

  /** Operational record of asking the carrier about a call (attempts, last outcome). */
  getFinalizationState(callSessionId: string) {
    return this.store.getFinalizationState(callSessionId);
  }

  /**
   * Internal operational view of the ledger, not an analytics API: how many calls (with usage in the window) have an
   * authoritative cost, an estimated one, or unpriced usage, and how many ended calls are still waiting for the carrier's
   * rating or have been given up on. Never reachable from a request.
   */
  async health(options: { from?: Date; to?: Date; accountId?: string } = {}): Promise<LedgerHealth> {
    const now = this.now();
    const from = options.from ?? new Date(now.getTime() - 30 * 24 * 3_600_000);
    const rows = await this.store.listCostRows({ accountId: options.accountId, from, to: options.to, limit: MAX_AGGREGATION_ROWS + 1 });
    const byCall = new Map<string, { call: CostRow['call']; records: UsageRecord[] }>();
    for (const row of rows.slice(0, MAX_AGGREGATION_ROWS)) {
      const entry = byCall.get(row.call.id) ?? { call: row.call, records: [] };
      entry.records.push(row.record);
      byCall.set(row.call.id, entry);
    }
    const health: LedgerHealth = { calls: byCall.size, authoritative: 0, estimated: 0, withUnpricedUsage: 0, nonFinalizable: 0, pendingRating: 0, exhausted: 0, truncated: rows.length > MAX_AGGREGATION_ROWS };
    for (const { call, records } of byCall.values()) {
      const summary = summarizeCost(call, records, this.priceBook, now, this.summaryOptions);
      if (summary.status === 'final') health.authoritative += 1;
      else if (summary.status === 'estimated') health.estimated += 1;
      if (summary.unpricedUsage > 0) health.withUnpricedUsage += 1;
      if (summary.nonFinalizable.length > 0) health.nonFinalizable += 1;
    }
    const backlog = await this.store.finalizationBacklog({ endedAfter: new Date(now.getTime() - FINALIZATION_HORIZON_MS), maxAttempts: FINALIZATION_MAX_ATTEMPTS, accountId: options.accountId });
    health.pendingRating = backlog.pending;
    health.exhausted = backlog.exhausted;
    return health;
  }
}
