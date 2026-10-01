import type { CallDirection, CallSessionStatus } from './model.js';

/**
 * The translation boundary between a provider's vocabulary and the domain's.
 * Twilio AND Telnyx terms stop here; the domain layer only ever sees `CallSessionStatus`.
 */

/** Twilio's documented `CallStatus` values (queued, initiated, ringing, in-progress, completed, busy, failed, no-answer, canceled). */
const TWILIO_STATUS: Record<string, CallSessionStatus> = {
  queued: 'initiating',
  initiated: 'initiating',
  ringing: 'ringing',
  'in-progress': 'answered',
  // The status-callback *event* name for pick-up; the existing integration also sent this spelling.
  answered: 'answered',
  completed: 'completed',
  busy: 'busy',
  failed: 'failed',
  'no-answer': 'no_answer',
  canceled: 'canceled',
};

/** `null` means "not a status this domain models": record it, do not act on it, do not reject it. */
export function mapTwilioCallStatus(raw: string): CallSessionStatus | null {
  return TWILIO_STATUS[raw.trim().toLowerCase()] ?? null;
}

/** Twilio's `Direction` parameter is `inbound`, `outbound-api` or `outbound-dial`. */
export function mapTwilioDirection(raw: unknown): CallDirection {
  return typeof raw === 'string' && raw.toLowerCase().startsWith('outbound') ? 'outbound' : 'inbound';
}

/**
 * Identity of one provider callback, so a redelivery is recognisable.
 *
 * Built only from fields Twilio sends: the call, the status, and `SequenceNumber` when the
 * callback carries one. Nothing is invented: without a sequence number, one callback per
 * (call, status) is the most Twilio sends, so (call, status) identifies it.
 */
export function twilioProviderEventId(record: Record<string, unknown>): string {
  const sid = String(record.CallSid ?? '');
  const status = String(record.CallStatus ?? '').toLowerCase();
  const sequence = record.SequenceNumber;
  return typeof sequence === 'string' && sequence.trim() !== '' || typeof sequence === 'number'
    ? `${sid}:${status}:${String(sequence).trim()}`
    : `${sid}:${status}`;
}

// ---------------------------------------------------------------------------
// Telnyx Voice API (V2 webhooks). Verified against Telnyx docs 2026-10:
// envelope `{ data: { id, event_type, occurred_at, payload } }` with payload
// identifiers `call_control_id`, `call_leg_id`, `call_session_id`,
// `connection_id`. Event names below are the documented Voice API names.
// ---------------------------------------------------------------------------

/**
 * Telnyx call-lifecycle events mapped into the domain. Everything else
 * (recording, streaming, AMD, transcription, gather, playback, fork, DTMF,
 * deepfake) is an observation, not a lifecycle move: `null`.
 *
 * Deliberately conservative: `call.hangup` always becomes `completed`.
 * Telnyx hangup payloads carry provider-specific cause detail
 * (`hangup_source`, `sip_hangup_cause`); no verified mapping of those causes
 * onto `no_answer`/`busy`/`failed` exists in this PR, so no such mapping is
 * invented. The raw cause stays in the webhook payload for diagnosis.
 */
const TELNYX_LIFECYCLE: Record<string, CallSessionStatus> = {
  'call.initiated': 'ringing',
  'call.ringing': 'ringing',
  'call.answered': 'answered',
  // Both legs bridged: media is flowing. The domain has no "bridged" state;
  // the closest modelled fact is that the call was picked up.
  'call.bridged': 'answered',
  'call.hangup': 'completed',
};

/** `null`: an event the domain does not model as a status move. */
export function mapTelnyxEventToStatus(eventType: string): CallSessionStatus | null {
  return TELNYX_LIFECYCLE[eventType.trim().toLowerCase()] ?? null;
}

/** Telnyx `direction` is `incoming` or `outgoing`. Unknown/absent: inbound (same rule as Twilio: cannot say ⇒ treated as inbound). */
export function mapTelnyxDirection(raw: unknown): CallDirection {
  return typeof raw === 'string' && raw.toLowerCase().startsWith('outgoing') ? 'outbound' : 'inbound';
}

/**
 * Identity of one Telnyx delivery: the webhook event's own `data.id`.
 * Telnyx documents duplicates, retries, concurrency and out-of-order delivery;
 * `data.id` is the documented dedupe key, so it is used verbatim. A payload
 * without one is malformed (rejected upstream, never defaulted here).
 */
export function telnyxProviderEventId(eventId: string): string {
  return eventId;
}

