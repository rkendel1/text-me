export type ConversationStatus = 'received' | 'answered' | 'completed';

export type ConversationEventType =
  | 'call.received'
  | 'call.answered'
  | 'call.ended'
  | 'speech.started'
  | 'speech.transcript'
  | 'ai.thinking'
  | 'ai.response'
  | 'voice.started'
  | 'voice.completed';

export interface ConversationEvent {
  id: string;
  conversationId: string;
  type: ConversationEventType;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface Conversation {
  id: string;
  provider: string;
  providerCallId: string;
  callerPhone: string;
  status: ConversationStatus;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number | null;
  events: ConversationEvent[];
}
