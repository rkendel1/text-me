/**
 * The boundary between the CallSession domain and a telephony provider.
 * The domain calls this; only an adapter (today `TwilioCallProvider`) knows the provider's SDK.
 */
export interface CallProviderCreateInput {
  from: string;
  to: string;
  /** Webhook the provider asks for call instructions once the callee answers. */
  answerUrl?: string;
  /** Inline instructions in the provider's own document format, for calls that need no webhook. */
  inlineInstructions?: string;
  /** Webhook that receives the call's lifecycle events. */
  statusUrl?: string;
}

/**
 * The provider refused the request, definitively: no call exists. Safe to record as failed.
 * (For Twilio this is an HTTP 4xx: an invalid number, a permissions or authentication problem.)
 */
export class CallProviderRejectedError extends Error {
  constructor(message: string, readonly code?: string | number) {
    super(message);
  }
}

/**
 * The request failed in a way that does not say whether a call was created: a timeout, a dropped
 * connection, a server error. The call may exist. The application must neither assume it does not nor
 * dial again.
 */
export class CallProviderUnconfirmedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** What a provider reports about one call it holds, in the domain's vocabulary. */
export interface ProviderCallObservation {
  providerCallId: string;
  /** The call's state, already translated to the domain (`null`: a state the domain does not model). */
  status: import('./model.js').CallSessionStatus | null;
  /** When the provider created the call. */
  createdAt: Date;
}

/**
 * What a provider can say about a call we asked for but never heard back about.
 * - `found`: calls the provider holds that match the request. The caller decides whether they identify ours.
 * - `not_found`: none match. `conclusive` is true only when the provider guarantees a call that was accepted
 *   would be listed by now; otherwise absence proves nothing (propagation delay, filter granularity).
 */
export type ProviderCallLookup =
  | { outcome: 'found'; calls: ProviderCallObservation[] }
  | { outcome: 'not_found'; conclusive: boolean };

export interface ProviderCallLookupInput {
  from: string;
  to: string;
  /** Only calls the provider created within this window can be ours. */
  createdAfter: Date;
  createdBefore: Date;
}

/**
 * One usage the provider reports for a call, in the ledger's vocabulary. The adapter translates its vendor's
 * records into this; nothing downstream knows what the vendor called them.
 */
export interface ProviderUsageObservation {
  /** Names what is measured within this provider call (`duration`, `recording:RE123`); the ledger scopes it to the call. */
  key: string;
  category: import('./cost/model.js').UsageCategory;
  product: string;
  metric: import('./cost/model.js').UsageMetric;
  quantity: number;
  unit: import('./cost/model.js').UsageUnit;
  /** `final` only when the provider states this measurement as its settled record. */
  basis: import('./cost/model.js').UsageBasis;
  /** The charge the provider itself states, when it does (absolute, in `currency`). */
  reportedAmount?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderUsageReport {
  providerCallId: string;
  observations: ProviderUsageObservation[];
}

export interface CallProvider {
  readonly name: string;
  /**
   * Places an outbound call. Resolves with the provider's id for it. Rejects with
   * `CallProviderRejectedError` when the provider definitively refused, and with anything else
   * (typically `CallProviderUnconfirmedError`) when the outcome is unknown.
   */
  createCall(input: CallProviderCreateInput): Promise<{ providerCallId: string }>;
  /**
   * Ask the provider to end a call. `cancel` is for a call that has not been answered yet,
   * `complete` hangs up one that has.
   */
  endCall(providerCallId: string, options: { mode: 'cancel' | 'complete' }): Promise<void>;
  /**
   * Read-only. Looks for calls matching a dial whose response was lost. Never creates, changes or ends a call.
   * Rejects when the provider cannot be asked (the outcome then stays unknown).
   */
  findDialedCalls(input: ProviderCallLookupInput): Promise<ProviderCallLookup>;
  /**
   * Read-only. What the provider reports having used for this call, as normalized observations. `null` when the
   * provider has nothing to report (yet). An observation is `final` only if the provider itself settled it.
   */
  getCallUsage(providerCallId: string): Promise<ProviderUsageReport | null>;
}

/** A provider stand-in for local development and tests: records what it was asked to do. */
export class FakeCallProvider implements CallProvider {
  readonly name: string;
  readonly created: CallProviderCreateInput[] = [];
  readonly ended: Array<{ providerCallId: string; mode: 'cancel' | 'complete' }> = [];
  failEnd?: Error;
  /** Throw this from createCall: a `CallProviderRejectedError` for a definitive refusal, anything else for an unknown outcome. */
  failCreate?: Error;
  /** Delay createCall by this long (ms) before it settles. */
  createDelayMs = 0;
  /** Runs while createCall is "in flight", after the call exists at the provider but before the caller hears back. Simulates callbacks that beat the response. */
  duringCreate?: (providerCallId: string, input: CallProviderCreateInput) => Promise<void>;
  /** The call is created at the provider, but the response is lost: createCall rejects with an unconfirmed error. */
  loseResponse = false;
  /** How many times createCall was invoked, successful or not. Zero means the provider was never contacted. */
  attempts = 0;
  private counter = 0;

  constructor(name = 'twilio') {
    this.name = name;
  }

  async createCall(input: CallProviderCreateInput): Promise<{ providerCallId: string }> {
    this.attempts += 1;
    if (this.createDelayMs) await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
    if (this.failCreate) throw this.failCreate;
    this.created.push(structuredClone(input));
    this.counter += 1;
    const providerCallId = `CAfake${String(this.counter).padStart(14, '0')}${Math.random().toString(16).slice(2, 16).padEnd(14, '0')}`;
    this.held.push({ providerCallId, from: input.from, to: input.to, status: 'initiating', createdAt: this.clock() });
    await this.duringCreate?.(providerCallId, input);
    if (this.loseResponse) throw new CallProviderUnconfirmedError('connection reset before the response arrived');
    return { providerCallId };
  }

  /** Calls the fake provider "holds": everything created, plus anything a test registers (its `createdAt` is when it was created). */
  readonly held: Array<ProviderCallObservation & { from: string; to: string }> = [];
  lookups: ProviderCallLookupInput[] = [];
  failLookup?: Error;
  /** What absence means for this fake (a real provider decides for itself). */
  absenceIsConclusive = false;
  /** The fake provider's clock, for `createdAt`; a test with a fake clock replaces it. */
  clock: () => Date = () => new Date();

  /** What `getCallUsage` reports, per provider call id (a test sets it; absent means "nothing to report yet"). */
  readonly usageReports = new Map<string, ProviderUsageReport>();
  usageFetches: string[] = [];
  failUsage?: Error;

  async getCallUsage(providerCallId: string): Promise<ProviderUsageReport | null> {
    this.usageFetches.push(providerCallId);
    if (this.failUsage) throw this.failUsage;
    return this.usageReports.get(providerCallId) ?? null;
  }

  async findDialedCalls(input: ProviderCallLookupInput): Promise<ProviderCallLookup> {
    this.lookups.push(input);
    if (this.failLookup) throw this.failLookup;
    const calls = this.held
      .filter((call) => call.from === input.from && call.to === input.to && call.createdAt >= input.createdAfter && call.createdAt <= input.createdBefore)
      .map(({ providerCallId, status, createdAt }) => ({ providerCallId, status, createdAt }));
    return calls.length ? { outcome: 'found', calls } : { outcome: 'not_found', conclusive: this.absenceIsConclusive };
  }

  async endCall(providerCallId: string, options: { mode: 'cancel' | 'complete' }): Promise<void> {
    if (this.failEnd) throw this.failEnd;
    this.ended.push({ providerCallId, mode: options.mode });
  }
}
