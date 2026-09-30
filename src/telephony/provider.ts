import type { CallDirection, CallSessionStatus } from '../calls/model.js';
import type { Conversation } from '../domain/conversation.js';

export interface IncomingCall {
  provider: string;
  providerCallId: string;
  callerPhone: string;
  /** The number that was called: an account's assistant line. It decides which account the call belongs to. */
  calledNumber?: string;
  /** Who started the call. A provider that cannot say is treated as inbound. */
  direction?: CallDirection;
  payload: Record<string, unknown>;
}

/**
 * One provider lifecycle callback, already translated into domain terms by the provider adapter.
 * `rawStatus` is the provider's own word, kept only for diagnosis.
 */
export interface StatusUpdate {
  provider: string;
  providerCallId: string;
  /** Identifies this callback, so a redelivery is recognisable. */
  eventId: string;
  rawStatus: string;
  /** `null` when the provider sent a status the domain does not model. */
  status: CallSessionStatus | null;
  sequence?: string | null;
  providerTimestamp?: string | null;
  durationSeconds: number | null;
  payload: Record<string, unknown>;
}

export interface IncomingSms {
  provider: string;
  providerMessageId: string;
  from: string;
  /** The account's assistant line the text was sent to. */
  to?: string;
  body: string;
  payload: Record<string, unknown>;
}

export interface ProviderResponse {
  body: string;
  contentType: string;
  /** Text the provider itself speaks before the conversational model takes over. */
  spokenGreeting?: string;
}

export interface TelephonyProvider {
  readonly name: string;
  parseIncomingCall(payload: unknown): IncomingCall;
  parseStatusUpdate(payload: unknown): StatusUpdate;
  answerCall(conversation: Conversation, options?: { greeting?: string; callSessionId?: string }): ProviderResponse;
  parseIncomingSms?(payload: unknown): IncomingSms;
}
