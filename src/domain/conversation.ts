export type ConversationStatus = 'received' | 'answered' | 'completed';
export type ConversationState =
  | 'voice_active'
  | 'awaiting_sms_consent'
  | 'text_active'
  | 'completed';
export type ConversationChannel = 'voice' | 'sms' | 'web';
export type ParticipantRole = 'caller' | 'assistant' | 'owner';

export interface ConversationParticipant {
  role: ParticipantRole;
  phoneNumber?: string;
  displayName?: string;
}

export type ConversationEventType =
  | 'call.received'
  | 'call.answered'
  | 'call.ended'
  | 'speech.started'
  | 'speech.transcript'
  | 'ai.thinking'
  | 'ai.response'
  | 'voice.started'
  | 'voice.completed'
  | 'conversation.summary.created'
  | 'conversation.channel_transitioned'
  | 'sms.consent.granted'
  | 'sms.consent.denied'
  | 'sms.invitation.sent'
  | 'sms.invitation.failed'
  | 'sms.received'
  | 'sms.sent'
  | 'caller.message'
  | 'owner.message'
  | 'assistant.message'
  | 'assistant.failed'
  | 'owner.read';

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
  state?: ConversationState;
  channels?: ConversationChannel[];
  primaryChannel?: ConversationChannel;
  participants?: ConversationParticipant[];
  ownerId?: string;
  lastOwnerReadAt?: Date | null;
}
