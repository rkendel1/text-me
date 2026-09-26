import type { Conversation, ConversationStatus } from '../domain/conversation.js';
import { HttpError } from '../errors.js';
import type { ConversationRepository } from '../repositories/conversation-repository.js';
import type { IncomingCall, IncomingSms, StatusUpdate } from '../telephony/provider.js';
import type { MessagingProvider } from '../messaging/provider.js';
import type { OwnerChannel } from '../owner/channel.js';
import { normalizePhoneNumber } from '../lib/phone.js';

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
  constructor(
    private readonly repository: ConversationRepository,
    private readonly messaging?: MessagingProvider,
    private readonly ownerPhone = process.env.OWNER_PHONE_NUMBER,
    private readonly ownerId = process.env.OWNER_ID ?? 'owner',
    private readonly ownerChannel?: OwnerChannel,
  ) {}

  async incomingCall(input: IncomingCall): Promise<Conversation> {
    const occurredAt = new Date();
    const created = await this.repository.createIfAbsent({
      provider: input.provider,
      providerCallId: input.providerCallId,
      callerPhone: input.callerPhone,
      status: 'received',
      startedAt: occurredAt,
      ownerId: this.ownerId,
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

  async grantSmsConsent(
    conversationId: string,
    smsPhone: string,
    displayName?: string,
  ): Promise<Conversation> {
    const conversation = await this.requireConversation(conversationId);
    const phone = normalizePhoneNumber(smsPhone);
    await this.repository.appendEvent(
      conversationId,
      'sms.consent.granted',
      { phoneNumber: phone, displayName },
      new Date(),
    );
    await this.repository.updateStatus(conversationId, conversation.status, {
      state: 'awaiting_sms_consent',
    });
    return this.requireConversation(conversationId);
  }

  async convertToTextConversation(conversationId: string): Promise<Conversation> {
    if (!this.messaging) throw new Error('Messaging provider is required');
    const conversation = await this.requireConversation(conversationId);
    if (conversation.state === 'text_active' || conversation.events.some(
      (event) => event.type === 'conversation.channel_transitioned',
    )) return conversation;
    const consent = [...conversation.events]
      .reverse()
      .find((event) => event.type === 'sms.consent.granted');
    if (!consent || typeof consent.payload.phoneNumber !== 'string') {
      throw new HttpError(409, 'SMS consent is required');
    }

    const summary = this.voiceSummary(conversation);
    if (!conversation.events.some((event) => event.type === 'conversation.summary.created')) {
      await this.repository.appendEvent(conversationId, 'conversation.summary.created', {
        summary,
        source: 'voice',
      }, new Date());
    }

    const callerKey = `conversation:${conversationId}:sms:introduction`;
    const ownerKey = `conversation:${conversationId}:sms:owner-summary`;
    await this.sendOnce(conversationId, callerKey, String(consent.payload.phoneNumber),
      `Hi${consent.payload.displayName ? ` ${consent.payload.displayName}` : ''} — this is Randy's assistant. We're continuing our conversation here because Randy prefers text. You can reply here and I'll take care of the conversation.`);
    const ownerMessage = `${consent.payload.displayName ?? 'Someone'} called about ${summary} Reply here and I'll take care of the conversation with them.`;
    await this.notifyOwner(conversationId, ownerKey, ownerMessage);

    await this.repository.appendEvent(conversationId, 'conversation.channel_transitioned', {
      from: 'voice',
      to: 'sms',
      reason: 'owner_prefers_text',
    }, new Date());
    await this.repository.updateStatus(conversationId, conversation.status, { state: 'text_active' });
    return this.requireConversation(conversationId);
  }

  async receiveSms(input: IncomingSms): Promise<Conversation> {
    const conversations = await this.repository.list();
    const conversation = conversations.find((candidate) => {
      if (candidate.state !== 'text_active' && !candidate.events.some(
        (event) => event.type === 'conversation.channel_transitioned',
      )) return false;
      const consent = [...candidate.events].reverse().find(
        (event) => event.type === 'sms.consent.granted',
      );
      return consent?.payload.phoneNumber === input.from ||
        (this.ownerPhone === input.from && candidate.callerPhone !== input.from);
    });
    if (!conversation) throw new HttpError(404, 'Conversation not found');
    if (conversation.events.some(
      (event) => event.type === 'sms.received' &&
        event.payload.providerMessageId === input.providerMessageId,
    )) return conversation;

    const owner = this.ownerPhone === input.from;
    await this.repository.appendEvent(conversation.id, 'sms.received', {
      providerMessageId: input.providerMessageId, from: input.from, body: input.body,
    }, new Date());
    await this.repository.appendEvent(conversation.id, owner ? 'owner.message' : 'caller.message', {
      providerMessageId: input.providerMessageId, speaker: owner ? 'owner' : 'caller',
      text: input.body, channel: 'sms',
    }, new Date());
    return this.requireConversation(conversation.id);
  }

  /**
   * Tell the owner the caller moved to text: Mac Messages first, then SMS. The
   * caller has already been texted by now, so a missing owner channel must not
   * block the transition; the failure is recorded and the conversation still
   * appears in the owner's control app.
   */
  private async notifyOwner(conversationId: string, key: string, body: string): Promise<void> {
    if (this.ownerChannel) {
      try {
        await this.sendOwnerMessage(conversationId, key, body);
        return;
      } catch {
        // Recorded as owner.delivery.failed; fall back to SMS below.
      }
    }
    if (!this.ownerPhone) {
      if (!this.ownerChannel) throw new HttpError(409, 'Owner phone number is not configured');
      return;
    }
    try {
      await this.sendOnce(conversationId, key, this.ownerPhone, body);
    } catch (error) {
      if (!this.ownerChannel) throw error;
    }
  }

  private voiceSummary(conversation: Conversation): string {
    const transcript = conversation.events.find((event) => event.type === 'speech.transcript');
    return transcript ? String(transcript.payload.text) : 'their request';
  }

  private async sendOnce(
    conversationId: string,
    key: string,
    to: string,
    body: string,
  ): Promise<void> {
    const conversation = await this.requireConversation(conversationId);
    const sent = conversation.events.find(
      (event) => event.type === 'sms.sent' && event.payload.idempotencyKey === key,
    );
    if (sent) return;
    try {
      const result = await this.messaging!.sendMessage({ to, body, idempotencyKey: key });
      await this.repository.appendEvent(conversationId, 'sms.sent', {
        to, body, idempotencyKey: key, providerMessageId: result.providerMessageId,
      }, new Date());
      await this.repository.appendEvent(conversationId, 'sms.invitation.sent', {
        to, idempotencyKey: key, providerMessageId: result.providerMessageId,
      }, new Date());
    } catch (error) {
      await this.repository.appendEvent(conversationId, 'sms.invitation.failed', {
        to, idempotencyKey: key, error: error instanceof Error ? error.message : 'unknown',
      }, new Date());
      throw error;
    }

  }

  private async sendOwnerMessage(
    conversationId: string,
    messageId: string,
    body: string,
  ): Promise<void> {
    const conversation = await this.requireConversation(conversationId);
    const channel = this.ownerChannel;
    if (!channel) throw new Error('Owner channel is not configured');
    if (conversation.events.some((event) =>
      event.type === 'owner.delivery.requested' && event.payload.messageId === messageId)) return;
    await this.repository.appendEvent(conversationId, 'owner.message.created', {
      messageId, body, source: channel.type,
    }, new Date());
    try {
      const delivery = await channel.sendMessage({
        ownerId: this.ownerId,
        conversationId,
        messageId,
        body,
      });
      await this.repository.appendEvent(conversationId, 'owner.delivery.requested', {
        messageId, deliveryId: delivery.deliveryId, source: channel.type,
      }, new Date());
    } catch (error) {
      await this.repository.appendEvent(conversationId, 'owner.delivery.failed', {
        messageId, source: channel.type,
        error: error instanceof Error ? error.message : 'unknown',
      }, new Date());
      throw error;
    }
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

  async markOwnerRead(conversationId: string, ownerId: string): Promise<Conversation> {
    const conversation = await this.requireOwnedConversation(conversationId, ownerId);
    const readAt = new Date();
    if (this.repository.markOwnerRead) {
      await this.repository.markOwnerRead(conversationId, ownerId, readAt);
    }
    return this.requireConversation(conversation.id);
  }

  async requireOwnedConversation(conversationId: string, ownerId: string): Promise<Conversation> {
    const conversation = await this.requireConversation(conversationId);
    if (conversation.ownerId !== ownerId) {
      throw new HttpError(404, 'Conversation not found');
    }
    return conversation;
  }

  private async requireConversation(id: string): Promise<Conversation> {
    const conversation = await this.repository.getById(id);

    if (!conversation) {
      throw new HttpError(404, 'Conversation not found');
    }

    return conversation;
  }
}
