import twilio from 'twilio';

import type { CallProvider, CallProviderCreateInput } from '../calls/provider.js';

/**
 * The only place the application places or ends Twilio calls (`client.calls.create` / `.update`).
 * The CallSession domain depends on `CallProvider`, never on the Twilio SDK.
 */
export class TwilioCallProvider implements CallProvider {
  readonly name = 'twilio';
  private readonly client: ReturnType<typeof twilio>;

  constructor(accountSid: string, authToken: string) {
    this.client = twilio(accountSid, authToken);
  }

  async createCall(input: CallProviderCreateInput): Promise<{ providerCallId: string }> {
    if (!input.answerUrl && !input.inlineInstructions) throw new Error('A call needs an answer URL or inline instructions.');
    const call = await this.client.calls.create({
      from: input.from,
      to: input.to,
      ...(input.answerUrl ? { url: input.answerUrl, method: 'POST' } : { twiml: input.inlineInstructions }),
      ...(input.statusUrl ? {
        statusCallback: input.statusUrl,
        statusCallbackMethod: 'POST',
        // Every lifecycle event, so a ringing, answered or unanswered call is visible as it happens.
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      } : {}),
    });
    return { providerCallId: call.sid };
  }

  async endCall(providerCallId: string, options: { mode: 'cancel' | 'complete' }): Promise<void> {
    await this.client.calls(providerCallId).update({ status: options.mode === 'cancel' ? 'canceled' : 'completed' });
  }
}
