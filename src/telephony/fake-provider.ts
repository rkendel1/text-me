import { HttpError } from '../errors.js';
import { mapTwilioCallStatus } from '../calls/provider-status.js';
import { normalizePhoneNumber } from '../lib/phone.js';
import type {
  IncomingCall,
  ProviderResponse,
  StatusUpdate,
  TelephonyProvider,
} from './provider.js';

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

export class FakeTelephonyProvider implements TelephonyProvider {
  readonly name = 'fake';

  parseIncomingCall(payload: unknown): IncomingCall {
    const record = asRecord(payload);

    const called = typeof record.to === 'string' && record.to.trim() ? normalizePhoneNumber(record.to) : undefined;
    return {
      provider: this.name,
      providerCallId: requiredString(record, 'callId'),
      callerPhone: normalizePhoneNumber(requiredString(record, 'callerPhone')),
      ...(called ? { calledNumber: called } : {}),
      payload: record,
    };
  }

  parseStatusUpdate(payload: unknown): StatusUpdate {
    const record = asRecord(payload);
    const rawStatus = requiredString(record, 'status').toLowerCase();
    const providerCallId = requiredString(record, 'callId');

    return {
      provider: this.name,
      providerCallId,
      eventId: `${providerCallId}:${rawStatus}${typeof record.sequence === 'number' ? `:${record.sequence}` : ''}`,
      rawStatus,
      // The fake speaks the same status words as the real provider.
      status: mapTwilioCallStatus(rawStatus),
      durationSeconds:
        typeof record.durationSeconds === 'number' ? record.durationSeconds : null,
      payload: record,
    };
  }

  answerCall(_conversation?: unknown, options: { greeting?: string; callSessionId?: string } = {}): ProviderResponse {
    const greeting = (options.greeting || 'Hi. What can I help you with?').replace(/[&<>"']/g, (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!));
    return {
      body: `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${greeting}</Say><Record maxLength="120" playBeep="true" trim="trim-silence" /><Hangup /></Response>`,
      contentType: 'text/xml; charset=utf-8',
    };
  }
}
