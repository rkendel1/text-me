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

export interface CallProvider {
  readonly name: string;
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
  failCreate?: Error;
  private counter = 0;

  constructor(name = 'twilio') {
    this.name = name;
  }

  async createCall(input: CallProviderCreateInput): Promise<{ providerCallId: string }> {
    if (this.failCreate) throw this.failCreate;
    this.created.push(structuredClone(input));
    this.counter += 1;
    return { providerCallId: `CAfake${String(this.counter).padStart(28, '0')}` };
  }

  async endCall(providerCallId: string, options: { mode: 'cancel' | 'complete' }): Promise<void> {
    if (this.failEnd) throw this.failEnd;
    this.ended.push({ providerCallId, mode: options.mode });
  }
}
