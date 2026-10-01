import { mapTelnyxDirection, mapTelnyxEventToStatus } from '../calls/provider-status.js';
import { normalizePhoneNumber } from '../lib/phone.js';
import { HttpError } from '../errors.js';
import type { IncomingCall, ProviderResponse, StatusUpdate, TelephonyProvider } from './provider.js';

/**
 * Webhook parsing and answer documents for Telnyx. Placing and ending calls
 * lives in `TelnyxCallProvider` (`telnyx-call-provider.ts`). Verification
 * lives in `telnyx-verification.ts` and runs in the route before this is
 * called. Nothing here touches tenant state, authorization, lifecycle or the
 * ledger; the service owns those.
 */
export interface TelnyxVoiceProviderOptions {
  /** Reserved for the follow-up media seam (unused in this PR). */
  mediaStreamUrl?: string;
  /** HTTPS turn endpoint used where persistent media-stream WebSockets are unavailable. */
  turnUrl?: string;
}

/** The verified webhook envelope from `verifyTelnyxWebhook`. */
export interface TelnyxWebhookEvent {
  eventId: string;
  eventType: string;
  occurredAt: string | null;
  payload: Record<string, unknown>;
}

function asWebhookEvent(event: unknown): TelnyxWebhookEvent {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new HttpError(400, 'Malformed webhook payload');
  const record = event as Record<string, unknown>;
  if (typeof record.eventId !== 'string' || !record.eventId) throw new HttpError(400, 'Malformed webhook payload');
  if (typeof record.eventType !== 'string' || !record.eventType) throw new HttpError(400, 'Malformed webhook payload');
  const payload = record.payload;
  if (payload !== undefined && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) {
    throw new HttpError(400, 'Malformed webhook payload');
  }
  return {
    eventId: record.eventId,
    eventType: record.eventType,
    occurredAt: typeof record.occurredAt === 'string' ? record.occurredAt : null,
    payload: (payload ?? {}) as Record<string, unknown>,
  };
}

function asRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'Malformed webhook payload');
  }
  return payload as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `Missing required field: ${key}`);
  }
  return value.trim();
}

export class TelnyxProvider implements TelephonyProvider {
  readonly name = 'telnyx';

  constructor(private readonly voice: TelnyxVoiceProviderOptions = {}) {}

  parseIncomingCall(event: unknown): IncomingCall {
    const { payload, eventType } = asWebhookEvent(event);
    // Telnyx has no separate "inbound ring" document: `call.initiated`
    // (direction `incoming`) IS the inbound-call signal.
    if (eventType !== 'call.initiated') throw new HttpError(400, `Missing required field: call.initiated (got ${eventType})`);
    const record = asRecord(payload);
    const providerCallId = requiredString(record, 'call_control_id');
    const rawFrom = record.from;
    const rawTo = record.to;
    if (typeof rawFrom !== 'string' || !rawFrom.trim()) throw new HttpError(400, 'Missing required field: from');
    const callerPhone = normalizePhoneNumber(rawFrom);
    const calledNumber = typeof rawTo === 'string' && rawTo.trim() ? normalizePhoneNumber(rawTo) : undefined;
    void this.voice;
    return {
      provider: this.name,
      providerCallId,
      callerPhone,
      ...(calledNumber ? { calledNumber } : {}),
      direction: mapTelnyxDirection(record.direction),
      payload: { ...record, eventType },
    };
  }

  parseStatusUpdate(event: unknown): StatusUpdate {
    const { payload, eventType, eventId, occurredAt } = asWebhookEvent(event);
    const record = asRecord(payload);
    const providerCallId = requiredString(record, 'call_control_id');
    return {
      provider: this.name,
      providerCallId,
      eventId,
      rawStatus: eventType,
      // A status the domain does not model is data, not an error: never 400 over it.
      status: mapTelnyxEventToStatus(eventType),
      sequence: null,
      providerTimestamp: occurredAt,
      durationSeconds: null,
      payload: { ...record, eventType, eventId },
    };
  }

  /**
   * Telnyx Voice API calls do not fetch instruction documents: a
   * `call.initiated` webhook is answered with call-control commands
   * (`answer`), which the application issues after recording the CallSession
   * — not from inside the HTTP response. So the webhook response carries no
   * instructions: 200 with an empty body. The realtime-bridge media seam is
   * follow-up work (see docs/telnyx-provider.md); until it lands, a Telnyx
   * call is answered at the signaling level.
   */
  answerCall(): ProviderResponse {
    return { body: '', contentType: 'application/json; charset=utf-8' };
  }
}
