import type {
  Conversation,
  ConversationEvent,
  ConversationStatus,
} from '../../src/domain/conversation.js';
import { createConversationId, createEventId } from '../../src/lib/ids.js';
import type {
  ConversationRepository,
  CreateConversationInput,
} from '../../src/repositories/conversation-repository.js';

export class InMemoryConversationRepository implements ConversationRepository {
  private readonly conversations = new Map<string, Conversation>();
  private readonly byProviderCallId = new Map<string, string>();

  async createIfAbsent(
    input: CreateConversationInput,
  ): Promise<{ conversation: Conversation; created: boolean }> {
    const key = `${input.provider}:${input.providerCallId}`;
    const existingId = this.byProviderCallId.get(key);

    if (existingId) {
      return {
        conversation: structuredClone(this.conversations.get(existingId)!),
        created: false,
      };
    }

    const conversation: Conversation = {
      id: createConversationId(),
      provider: input.provider,
      providerCallId: input.providerCallId,
      callerPhone: input.callerPhone,
      status: input.status,
      startedAt: input.startedAt,
      endedAt: null,
      durationSeconds: null,
      events: [],
      ownerId: input.ownerId,
    };

    this.byProviderCallId.set(key, conversation.id);
    this.conversations.set(conversation.id, structuredClone(conversation));

    return {
      conversation: structuredClone(conversation),
      created: true,
    };
  }

  async getById(id: string): Promise<Conversation | null> {
    return structuredClone(this.conversations.get(id) ?? null);
  }

  async getByProviderCallId(
    provider: string,
    providerCallId: string,
  ): Promise<Conversation | null> {
    const id = this.byProviderCallId.get(`${provider}:${providerCallId}`);
    return id ? this.getById(id) : null;
  }

  async list(): Promise<Conversation[]> {
    return [...this.conversations.values()]
      .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
      .map((conversation) => structuredClone(conversation));
  }

  async appendEvent(
    conversationId: string,
    type: ConversationEvent['type'],
    payload: Record<string, unknown>,
    occurredAt: Date,
  ): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return;
    }

    conversation.events.push({
      id: createEventId(),
      conversationId,
      type,
      payload,
      occurredAt,
    });
  }

  async updateStatus(
    conversationId: string,
    status: ConversationStatus,
    patch: { endedAt?: Date | null; durationSeconds?: number | null; state?: Conversation['state'] },
  ): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return;
    }

    conversation.status = status;
    if (patch.endedAt !== undefined) {
      conversation.endedAt = patch.endedAt;
    }
    if (patch.durationSeconds !== undefined) {
      conversation.durationSeconds = patch.durationSeconds;
    }
    if (patch.state !== undefined) {
      conversation.state = patch.state;
    }
  }

  async markOwnerRead(conversationId: string, _ownerId: string, readAt: Date): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (conversation) conversation.lastOwnerReadAt = readAt;
  }
}
