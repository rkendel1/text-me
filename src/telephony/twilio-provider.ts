import twilio from 'twilio';

import type { Conversation } from '../domain/conversation.js';
import { HttpError } from '../errors.js';
import { normalizePhoneNumber } from '../lib/phone.js';
import type {
  IncomingCall,
  IncomingSms,
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

export interface TwilioVoiceOptions {
  /** wss:// URL of the realtime media stream; when set, calls are answered by the realtime voice agent. */
  mediaStreamUrl?: string;
  /** Webhook Twilio continues to once the media stream ends (goodbye or failure fallback). */
  continueUrl?: string;
  /** HTTPS turn endpoint used where persistent Media Stream WebSockets are unavailable. */
  turnUrl?: string;
}

export class TwilioProvider implements TelephonyProvider {
  readonly name = 'twilio';
  readonly endCall?: (providerCallId: string) => Promise<void>;

  constructor(
    private readonly voice: TwilioVoiceOptions = {},
    credentials?: { accountSid: string; authToken: string },
  ) {
    if (credentials) {
      const client = twilio(credentials.accountSid, credentials.authToken);
      this.endCall = async (providerCallId) => {
        await client.calls(providerCallId).update({ status: 'completed' });
      };
    }
  }

  parseIncomingCall(payload: unknown): IncomingCall {
    const record = asRecord(payload);
    const providerCallId = requiredString(record, 'CallSid');
    const callerPhone = normalizePhoneNumber(requiredString(record, 'From'));
    const calledNumber = typeof record.To === 'string' && record.To.trim() ? normalizePhoneNumber(record.To) : undefined;

    return {
      provider: this.name,
      providerCallId,
      callerPhone,
      ...(calledNumber ? { calledNumber } : {}),
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

  parseIncomingSms(payload: unknown): IncomingSms {
    const record = asRecord(payload);
    return {
      provider: this.name,
      providerMessageId: requiredString(record, 'MessageSid'),
      from: normalizePhoneNumber(requiredString(record, 'From')),
      ...(typeof record.To === 'string' && record.To.trim() ? { to: normalizePhoneNumber(record.To) } : {}),
      body: requiredString(record, 'Body'),
      payload: record,
    };
  }

  answerCall(conversation?: Conversation, options: { greeting?: string } = {}): ProviderResponse {
    const response = new twilio.twiml.VoiceResponse();
    if (this.voice.mediaStreamUrl && conversation) {
      const stream = response.connect().stream({ url: this.voice.mediaStreamUrl });
      stream.parameter({ name: 'conversationId', value: conversation.id });
      if (this.voice.continueUrl) {
        response.redirect({ method: 'POST' }, `${this.voice.continueUrl}?conversationId=${encodeURIComponent(conversation.id)}`);
      } else {
        response.hangup();
      }
      return { body: response.toString(), contentType: 'text/xml; charset=utf-8' };
    }
    if (this.voice.turnUrl && conversation) {
      return this.turn(conversation.id, options.greeting || 'Hi. What can I help you with?', 1);
    }
    // Without realtime voice (local development): the account's own greeting, then a recording.
    response.say(options.greeting || 'Hi. What can I help you with?');
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

  /** One turn of an HTTPS speech conversation: speak, listen, then post the transcript back. */
  turn(conversationId: string, prompt: string, turn: number): ProviderResponse {
    const response = new twilio.twiml.VoiceResponse();
    if (!this.voice.turnUrl) {
      response.say(prompt);
      response.hangup();
      return { body: response.toString(), contentType: 'text/xml; charset=utf-8', spokenGreeting: prompt };
    }
    const action = new URL(this.voice.turnUrl);
    action.searchParams.set('conversationId', conversationId);
    action.searchParams.set('turn', String(turn));
    const gather = response.gather({
      input: ['speech'], action: action.toString(), method: 'POST',
      speechTimeout: 'auto', timeout: 5, actionOnEmptyResult: true,
    });
    gather.say(prompt);
    return { body: response.toString(), contentType: 'text/xml; charset=utf-8', spokenGreeting: prompt };
  }
}
