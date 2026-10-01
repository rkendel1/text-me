/**
 * The cost ledger's vocabulary. Everything here is provider-neutral: a carrier or an AI vendor is a `provider`
 * string and a `product`, never a type or a branch. The ledger records what happened (usage); what it costs is
 * decided separately (pricing), and the answer is kept next to the usage that produced it.
 */

export const USAGE_CATEGORIES = ['telephony', 'media', 'ai_voice', 'ai_reasoning', 'transcription', 'tts', 'recording', 'amd', 'other'] as const;
export type UsageCategory = (typeof USAGE_CATEGORIES)[number];

/**
 * What was measured. `duration` and `invocation` are what carriers report; the token metrics are what an AI runtime
 * reports, and only when it reports them (nothing here is derived from elapsed time).
 */
export const USAGE_METRICS = [
  'duration', 'invocation',
  'input_tokens', 'output_tokens', 'cached_input_tokens',
  'audio_input_tokens', 'audio_output_tokens', 'text_input_tokens', 'text_output_tokens',
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export const USAGE_UNITS = ['second', 'minute', 'call', 'token'] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];

/**
 * `final`: the measurement is authoritative (the provider's own record of it).
 * `estimated`: our own observation or a provider's interim figure. Never presented as an authoritative charge.
 */
export const USAGE_BASES = ['estimated', 'final'] as const;
export type UsageBasis = (typeof USAGE_BASES)[number];

/** Where a usage observation came from. Recorded for explanation, never branched on. */
export const USAGE_SOURCES = ['provider_callback', 'provider_usage_report', 'media_stream', 'ai_runtime', 'recording_callback'] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

/** One observation of usage. Append-only: a better observation of the same `subject` is a new event, not an edit. */
export interface UsageEvent {
  id: string;
  callSessionId: string;
  /** Denormalised from the call so cost is tenant-scoped without a join. */
  accountId: string;
  /**
   * What is being measured (one call's duration at one provider; one AI response's output tokens). Observations
   * sharing a subject are successive readings of the same quantity: the best one counts, they are not added.
   * Different subjects add.
   */
  subject: string;
  /** Deterministic identity of this very observation. A redelivered callback or a retry has the same key and records nothing. */
  idempotencyKey: string;
  category: UsageCategory;
  /** The vendor that performed or measured it: a carrier, an AI vendor. */
  provider: string;
  /** What was used, in the vendor-neutral names adapters map to (`voice_outbound`, `media_stream`, `realtime`). */
  product: string;
  model: string | null;
  metric: UsageMetric;
  quantity: number;
  unit: UsageUnit;
  basis: UsageBasis;
  source: UsageSource;
  /** A charge the provider itself stated for this usage. When present it is the amount; no rate is applied. */
  reportedAmount: number | null;
  reportedCurrency: string | null;
  occurredAt: Date;
  recordedAt: Date;
  /** Provider-specific detail kept for explanation. Never read by cost logic. */
  metadata: Record<string, unknown>;
}

export type UsageEventInput = Omit<UsageEvent, 'id' | 'recordedAt' | 'reportedAmount' | 'reportedCurrency' | 'metadata' | 'model'> &
  Partial<Pick<UsageEvent, 'reportedAmount' | 'reportedCurrency' | 'metadata' | 'model'>>;

export type RateSource = 'rate_card' | 'provider_reported' | 'unpriced';

/**
 * The price of one usage event, written once at the moment it was recorded, with the rate used. A later price
 * change adds a rate to the price book; it cannot change this row.
 */
export interface CostComponent {
  id: string;
  usageEventId: string;
  callSessionId: string;
  accountId: string;
  /** `null` when no rate was known and the provider stated no charge: the usage is real, its cost is not. */
  amount: number | null;
  currency: string | null;
  rateSource: RateSource;
  /** The rate applied (`rate_card` only), kept so the amount can be explained and re-derived. */
  rateId: string | null;
  rate: number | null;
  ratePer: number | null;
  rateUnit: UsageUnit | null;
  /** The quantity after conversion to the rate's unit. */
  pricedQuantity: number | null;
  pricedAt: Date;
}

export interface UsageRecord {
  event: UsageEvent;
  component: CostComponent;
}

/** What a call has cost so far, derived from its usage and cost components (never authoritative on its own). */
export type CostStatus =
  /** No usage has been observed and none can be estimated. */
  | 'unknown'
  /** Some usage is estimated, derived, or unpriced. */
  | 'estimated'
  /** The call is over and every observed dimension has an authoritative measurement and a price. */
  | 'final';

export interface CostBreakdownEntry {
  category: UsageCategory;
  /** `null` when everything in this category is unpriced. */
  amount: number | null;
  basis: UsageBasis;
  /** Usage counted in the category that has no price. */
  unpriced: number;
}

export interface CallCostSummary {
  callId: string;
  currency: string;
  status: CostStatus;
  /** The best current figure: authoritative where there is one, estimated elsewhere. `null` if nothing can be priced. */
  estimatedCost: number | null;
  /** The authoritative figure. Only present when `status` is `final`. */
  finalCost: number | null;
  breakdown: CostBreakdownEntry[];
  /** The part of the figure that is authoritative (settled and priced), whether or not the rest is. `null` when none of it is. */
  authoritativeCost: number | null;
  /** Categories still estimated that the provider or runtime can yet settle: waiting, not wrong. */
  pending: UsageCategory[];
  /** Categories that can only ever be estimates (nothing authoritative exists per call, or the figure was unavailable). They keep the call from ever being `final`. */
  nonFinalizable: UsageCategory[];
  /** Usage observed but not priced (no rate configured), so the totals above exclude it. */
  unpricedUsage: number;
  /** True when part of the figure was derived from the call's lifecycle times because no usage had been recorded. */
  derived: boolean;
}
