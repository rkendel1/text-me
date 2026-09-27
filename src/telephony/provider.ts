import type { Conversation } from '../domain/conversation.js';

export interface IncomingCall {
  provider: string;
  providerCallId: string;
  callerPhone: string;
  /** The number that was called: an account's assistant line. It decides which account the call belongs to. */
  calledNumber?: string;
  payload: Record<string, unknown>;
}

export type ProviderCallStatus = 'answered' | 'completed';

export interface StatusUpdate {
  provider: string;
  providerCallId: string;
  status: ProviderCallStatus;
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
}

export interface TelephonyProvider {
  readonly name: string;
  parseIncomingCall(payload: unknown): IncomingCall;
  parseStatusUpdate(payload: unknown): StatusUpdate;
  answerCall(conversation: Conversation, options?: { greeting?: string }): ProviderResponse;
  parseIncomingSms?(payload: unknown): IncomingSms;
}
