import twilio from 'twilio';

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

function requiredString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];

  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `Missing required field: ${key}`);
  }

  return value.trim();
}

export class TwilioProvider implements TelephonyProvider {
  readonly name = 'twilio';

  parseIncomingCall(payload: unknown): IncomingCall {
    const record = asRecord(payload);
    const providerCallId = requiredString(record, 'CallSid');
    const callerPhone = normalizePhoneNumber(requiredString(record, 'From'));

    return {
      provider: this.name,
      providerCallId,
      callerPhone,
      payload: record,
    };
  }

  parseStatusUpdate(payload: unknown): StatusUpdate {
    const record = asRecord(payload);
    const providerCallId = requiredString(record, 'CallSid');
    const callStatus = requiredString(record, 'CallStatus').toLowerCase();
    const rawDuration = record.CallDuration;
    const durationSeconds =
      typeof rawDuration === 'string' && rawDuration !== ''
        ? Number(rawDuration)
        : null;

    if (callStatus === 'in-progress' || callStatus === 'answered') {
      return {
        provider: this.name,
        providerCallId,
        status: 'answered',
        durationSeconds,
        payload: record,
      };
    }

    if (callStatus === 'completed') {
      return {
        provider: this.name,
        providerCallId,
        status: 'completed',
        durationSeconds,
        payload: record,
      };
    }

    throw new HttpError(400, `Unsupported Twilio call status: ${callStatus}`);
  }

  answerCall(): ProviderResponse {
    const response = new twilio.twiml.VoiceResponse();
    response.say(
      'Hi. This number is currently unavailable. Please tell me why you are calling after the tone.',
    );
    response.record({
      maxLength: 120,
      playBeep: true,
      trim: 'trim-silence',
    });
    response.hangup();

    return {
      body: response.toString(),
      contentType: 'text/xml; charset=utf-8',
    };
  }
}
