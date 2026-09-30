import type { CallDirection, CallSessionStatus } from './model.js';

/**
 * The translation boundary between a provider's vocabulary and the domain's.
 * Twilio terms stop here; the domain layer only ever sees `CallSessionStatus`.
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
