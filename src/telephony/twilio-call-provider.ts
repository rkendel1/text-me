import twilio from 'twilio';

import {
  CallProviderRejectedError, CallProviderUnconfirmedError,
  type CallProvider, type CallProviderCreateInput, type ProviderCallLookup, type ProviderCallLookupInput, type ProviderUsageReport,
} from '../calls/provider.js';
import { mapTwilioCallStatus } from '../calls/provider-status.js';

/**
 * The only place the application places or ends Twilio calls (`client.calls.create` / `.update`).
 * The CallSession domain depends on `CallProvider`, never on the Twilio SDK.
 */
/** The slice of the Twilio SDK this adapter uses. Injectable so the adapter's own behavior can be tested without the network. */
export type TwilioCallsClient = Pick<ReturnType<typeof twilio>, 'calls'>;

/** Enough for the calls between one assistant line and one callee around one dial; a larger result is itself ambiguous. */
const LOOKUP_LIMIT = 20;

export class TwilioCallProvider implements CallProvider {
  readonly name = 'twilio';
  private readonly client: TwilioCallsClient;

  constructor(accountSid: string, authToken: string, options: { timeoutMs?: number; client?: TwilioCallsClient } = {}) {
    // A bounded request: an outbound call must not hang a serverless invocation waiting on the network.
    this.client = options.client ?? twilio(accountSid, authToken, { timeout: options.timeoutMs ?? 15_000 });
  }

  async createCall(input: CallProviderCreateInput): Promise<{ providerCallId: string }> {
    if (!input.answerUrl && !input.inlineInstructions) throw new CallProviderRejectedError('A call needs an answer URL or inline instructions.');
    try {
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
    } catch (error) {
      throw classifyCreateFailure(error);
    }
  }

  /**
   * Read-only (`client.calls.list`). Twilio has no lookup by our own reference, and its date filters are day-granular,
   * so this lists the most recent calls between the two numbers and keeps those created inside the window. Twilio's
   * list ordering, and how soon a just-created call appears in it, are not verified here, so absence is never
   * conclusive and a match is only a candidate for the caller to judge.
   */
  async findDialedCalls(input: ProviderCallLookupInput): Promise<ProviderCallLookup> {
    const listed = await this.client.calls.list({ from: input.from, to: input.to, pageSize: LOOKUP_LIMIT, limit: LOOKUP_LIMIT });
    const calls = listed
      .filter((call) => call.dateCreated >= input.createdAfter && call.dateCreated <= input.createdBefore)
      .map((call) => ({ providerCallId: call.sid, status: mapTwilioCallStatus(String(call.status)), createdAt: call.dateCreated }));
    return calls.length ? { outcome: 'found', calls } : { outcome: 'not_found', conclusive: false };
  }

  /**
   * Read-only (`client.calls(sid).fetch()`). Twilio's call resource carries the connected `duration` (seconds) and,
   * once it has been rated, `price` with `priceUnit` (Twilio reports a charge as a negative number). A call that has
   * not been rated yet reports a duration only, which is an interim figure: it is returned as `estimated`. How long
   * Twilio takes to rate a call is not verified here.
   */
  async getCallUsage(providerCallId: string): Promise<ProviderUsageReport | null> {
    const call = await this.client.calls(providerCallId).fetch();
    const seconds = call.duration === null || call.duration === undefined || call.duration === '' ? NaN : Number(call.duration);
    if (!Number.isFinite(seconds)) return null;
    const price = call.price === null || call.price === undefined || call.price === '' ? NaN : Number(call.price);
    const rated = Number.isFinite(price) && typeof call.priceUnit === 'string' && call.priceUnit !== '';
    return {
      providerCallId,
      observations: [{
        key: 'duration', category: 'telephony', product: String(call.direction ?? '').toLowerCase().startsWith('outbound') ? 'voice_outbound' : 'voice_inbound',
        metric: 'duration', quantity: seconds, unit: 'second', basis: rated ? 'final' : 'estimated',
        ...(rated ? { reportedAmount: Math.abs(price), currency: String(call.priceUnit).toUpperCase() } : {}),
        metadata: { twilioStatus: call.status ?? null },
      }],
    };
  }

  async endCall(providerCallId: string, options: { mode: 'cancel' | 'complete' }): Promise<void> {
    await this.client.calls(providerCallId).update({ status: options.mode === 'cancel' ? 'canceled' : 'completed' });
  }
}

/**
 * Twilio answered with an HTTP 4xx: it looked at the request and refused it, so no call exists (an invalid
 * number, a permissions or authentication problem, a rate limit). Anything else (a timeout, a dropped
 * connection, a 5xx) says nothing about whether the call was created, so it is reported as unconfirmed and the
 * application must not assume either way. (408 is a timeout, not a verdict.)
 */
function classifyCreateFailure(error: unknown): Error {
  const { status, code, message } = (error ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
  const text = typeof message === 'string' ? message : 'The call could not be created.';
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) {
    return new CallProviderRejectedError(text, typeof code === 'string' || typeof code === 'number' ? code : status);
  }
  return new CallProviderUnconfirmedError(text, { cause: error });
}
