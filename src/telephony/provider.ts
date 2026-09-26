import type { Conversation } from '../domain/conversation.js';

export interface IncomingCall {
  provider: string;
  providerCallId: string;
  callerPhone: string;
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
  answerCall(conversation: Conversation): ProviderResponse;
  parseIncomingSms?(payload: unknown): IncomingSms;
}
