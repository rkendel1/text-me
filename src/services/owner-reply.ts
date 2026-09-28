import { randomUUID } from 'node:crypto';

import type { Conversation } from '../domain/conversation.js';
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
    accountId: string;
    body: string;
    idempotencyKey: string;
    source: OwnerReplySource;
  }): Promise<Conversation> {
    // The reply acts as the given account; a conversation of any other account doesn't exist for it.
    const conversation = await this.conversations.requireOwnedConversation(input.conversationId, input.accountId);
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
        await this.runtime.requestOwnerSpeech(input.conversationId, input.accountId, input.body, { messageId, requestId });
        await this.runtime.noteOwnerResponse(input.conversationId);
      }
      await this.conversations.resolveAttention(input.conversationId, ['assistant_needs_owner'], `owner replied via ${input.source}`);
      return (await this.conversations.getConversation(input.conversationId))!;
    }

    const canTextCaller = conversation.events.some((event) => event.type === 'sms.consent.granted');
    if (canTextCaller) {
      const replied = await this.engine.respondToOwner(input.conversationId, input.body, input.idempotencyKey, input.source, {
        messageId, ...(requestId ? { requestId } : {}),
      });
      await this.conversations.resolveAttention(input.conversationId, ['assistant_needs_owner'], `owner replied via ${input.source}`);
      return replied;
    }

    // A decision requested during a voice call is still valid after the caller
    // hangs up. Record it and clear the owner's task; SMS consent controls only
    // sending a text to the caller, not the owner's ability to answer their own
    // assistant. During a turn-based live call this also puts the answer into
    // conversation history for the assistant's next spoken turn.
    const duplicate = conversation.events.some((event) =>
      event.type === 'owner.message' && event.payload.idempotencyKey === input.idempotencyKey);
    if (!duplicate) {
      await this.repository.appendEvent(input.conversationId, 'owner.message', {
        text: input.body, speaker: 'owner',
        channel: conversation.status === 'completed' ? 'internal' : 'voice',
        source: input.source, idempotencyKey: input.idempotencyKey, messageId,
        delivery: conversation.status === 'completed' ? 'recorded_after_call' : 'queued_for_voice',
        ...(requestId ? { requestId } : {}),
      }, new Date());
      if (conversation.status !== 'completed') await this.runtime.noteOwnerResponse(input.conversationId);
    }
    await this.conversations.resolveAttention(input.conversationId, ['assistant_needs_owner'], `owner replied via ${input.source}`);
    return (await this.conversations.getConversation(input.conversationId))!;
  }
}
