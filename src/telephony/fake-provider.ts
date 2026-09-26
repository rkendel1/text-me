import { HttpError } from '../errors.js';
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

    return {
      provider: this.name,
      providerCallId: requiredString(record, 'callId'),
      callerPhone: normalizePhoneNumber(requiredString(record, 'callerPhone')),
      payload: record,
    };
  }

  parseStatusUpdate(payload: unknown): StatusUpdate {
    const record = asRecord(payload);
    const status = requiredString(record, 'status').toLowerCase();

    if (status !== 'answered' && status !== 'completed') {
      throw new HttpError(400, `Unsupported fake call status: ${status}`);
    }

    return {
      provider: this.name,
      providerCallId: requiredString(record, 'callId'),
      status,
      durationSeconds:
        typeof record.durationSeconds === 'number' ? record.durationSeconds : null,
      payload: record,
    };
  }

  answerCall(): ProviderResponse {
    return {
      body: '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Hi. This number is currently unavailable. Please tell me why you are calling after the tone.</Say><Record maxLength="120" playBeep="true" trim="trim-silence" /><Hangup /></Response>',
      contentType: 'text/xml; charset=utf-8',
    };
  }
}
