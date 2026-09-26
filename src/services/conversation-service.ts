import type { Conversation, ConversationStatus } from '../domain/conversation.js';
import { HttpError } from '../errors.js';
import type { ConversationRepository } from '../repositories/conversation-repository.js';
import type { IncomingCall, StatusUpdate } from '../telephony/provider.js';

const allowedTransitions: Record<ConversationStatus, ConversationStatus[]> = {
  received: ['answered'],
  answered: ['completed'],
  completed: [],
};

function canTransition(
  current: ConversationStatus,
  next: ConversationStatus,
): boolean {
  return allowedTransitions[current].includes(next);
}

export class ConversationService {
  constructor(private readonly repository: ConversationRepository) {}

  async incomingCall(input: IncomingCall): Promise<Conversation> {
    const occurredAt = new Date();
    const created = await this.repository.createIfAbsent({
      provider: input.provider,
      providerCallId: input.providerCallId,
      callerPhone: input.callerPhone,
      status: 'received',
      startedAt: occurredAt,
    });

    if (created.created) {
      await this.repository.appendEvent(
        created.conversation.id,
        'call.received',
        input.payload,
        occurredAt,
      );
    }

    return this.requireConversation(created.conversation.id);
  }

  async answerCall(
    conversationId: string,
    payload: Record<string, unknown>,
  ): Promise<Conversation> {
    const conversation = await this.requireConversation(conversationId);

    if (conversation.status === 'answered' || conversation.status === 'completed') {
      return conversation;
    }

    if (!canTransition(conversation.status, 'answered')) {
      throw new HttpError(409, `Invalid transition from ${conversation.status} to answered`);
    }

    const occurredAt = new Date();
    await this.repository.updateStatus(conversation.id, 'answered', {});
    await this.repository.appendEvent(
      conversation.id,
      'call.answered',
      payload,
      occurredAt,
    );

    return this.requireConversation(conversation.id);
  }

  async updateCallStatus(input: StatusUpdate): Promise<Conversation> {
    const conversation = await this.repository.getByProviderCallId(
      input.provider,
      input.providerCallId,
    );

    if (!conversation) {
      throw new HttpError(404, 'Conversation not found for provider call');
    }

    if (input.status === 'answered') {
      return this.answerCall(conversation.id, input.payload);
    }

    if (conversation.status === 'completed') {
      return conversation;
    }

    if (!canTransition(conversation.status, 'completed')) {
      throw new HttpError(409, `Invalid transition from ${conversation.status} to completed`);
    }

    const occurredAt = new Date();
    await this.repository.updateStatus(conversation.id, 'completed', {
      endedAt: occurredAt,
      durationSeconds: input.durationSeconds,
    });
    await this.repository.appendEvent(
      conversation.id,
      'call.ended',
      input.payload,
      occurredAt,
    );

    return this.requireConversation(conversation.id);
  }

  getConversation(id: string): Promise<Conversation | null> {
    return this.repository.getById(id);
  }

  listConversations(): Promise<Conversation[]> {
    return this.repository.list();
  }

  private async requireConversation(id: string): Promise<Conversation> {
    const conversation = await this.repository.getById(id);

    if (!conversation) {
      throw new HttpError(404, 'Conversation not found');
    }

    return conversation;
  }
}
