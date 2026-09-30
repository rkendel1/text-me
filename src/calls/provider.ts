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
    await this.duringCreate?.(providerCallId, input);
    if (this.loseResponse) throw new CallProviderUnconfirmedError('connection reset before the response arrived');
    return { providerCallId };
  }

  async endCall(providerCallId: string, options: { mode: 'cancel' | 'complete' }): Promise<void> {
    if (this.failEnd) throw this.failEnd;
    this.ended.push({ providerCallId, mode: options.mode });
  }
}
