import type { Conversation, ConversationState, ConversationStatus } from '../domain/conversation.js';

export interface CreateConversationInput {
  provider: string;
  providerCallId: string;
  callerPhone: string;
  status: ConversationStatus;
  startedAt: Date;
}

export interface ConversationRepository {
  initialize?(): Promise<void>;
  createIfAbsent(
    input: CreateConversationInput,
  ): Promise<{ conversation: Conversation; created: boolean }>;
  getById(id: string): Promise<Conversation | null>;
  getByProviderCallId(
    provider: string,
    providerCallId: string,
  ): Promise<Conversation | null>;
  list(): Promise<Conversation[]>;
  appendEvent(
    conversationId: string,
    type: Conversation['events'][number]['type'],
    payload: Record<string, unknown>,
    occurredAt: Date,
  ): Promise<void>;
  updateStatus(
    conversationId: string,
    status: ConversationStatus,
    patch: {
      endedAt?: Date | null;
      durationSeconds?: number | null;
      state?: ConversationState;
    },
  ): Promise<void>;
}
