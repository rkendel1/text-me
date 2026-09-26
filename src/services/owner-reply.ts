import { randomUUID } from 'node:crypto';

import type { Conversation } from '../domain/conversation.js';
import { HttpError } from '../errors.js';
import type { ConversationRepository } from '../repositories/conversation-repository.js';
import type { RuntimeControlService } from '../runtime/service.js';
import { realtimeVoiceStatus } from '../voice/realtime/realtime-voice.js';
import type { ConversationEngine } from './conversation-engine.js';
import type { ConversationService } from './conversation-service.js';

export type OwnerReplySource = 'web' | 'macos_messages' | 'sms';

/**
 * The one path for an owner's reply, whatever it came from (web, Messages,
 * SMS). The assistant always mediates: on a live call it relays the answer by
 * voice; otherwise it texts the caller on the owner's behalf.
 */
export class OwnerReplyService {
  constructor(
    private readonly repository: ConversationRepository,
    private readonly conversations: ConversationService,
    private readonly engine: ConversationEngine,
    private readonly runtime: RuntimeControlService,
    private readonly realtimeVoice: boolean,
  ) {}

  async reply(input: {
    conversationId: string;
    ownerId: string;
    body: string;
    idempotencyKey: string;
    source: OwnerReplySource;
  }): Promise<Conversation> {
    const conversation = await this.conversations.getConversation(input.conversationId);
    if (!conversation) throw new HttpError(404, 'Conversation not found');
    const requestId = this.conversations.openOwnerRequest(conversation)?.requestId;
    const messageId = `msg_${randomUUID()}`;

    if (this.realtimeVoice && realtimeVoiceStatus(conversation).live) {
      const duplicate = conversation.events.some((event) =>
        event.type === 'owner.message' && event.payload.idempotencyKey === input.idempotencyKey);
      if (!duplicate) {
        await this.repository.appendEvent(input.conversationId, 'owner.message', {
          text: input.body, speaker: 'owner', channel: 'voice', source: input.source,
          idempotencyKey: input.idempotencyKey, messageId, ...(requestId ? { requestId } : {}),
        }, new Date());
        await this.runtime.requestOwnerSpeech(input.conversationId, input.ownerId, input.body, { messageId, requestId });
        await this.runtime.noteOwnerResponse(input.conversationId);
      }
      return (await this.conversations.getConversation(input.conversationId))!;
    }

    return this.engine.respondToOwner(input.conversationId, input.body, input.idempotencyKey, input.source, {
      messageId, ...(requestId ? { requestId } : {}),
    });
  }
}
