import type { Conversation, ConversationStatus } from '../domain/conversation.js';
import { HttpError } from '../errors.js';
import type { ConversationRepository } from '../repositories/conversation-repository.js';
import type { IncomingCall, IncomingSms, StatusUpdate } from '../telephony/provider.js';
import type { MessagingProvider } from '../messaging/provider.js';
import type { OwnerAttentionService, RaiseAttentionInput } from '../attention/service.js';
import { normalizePhoneNumber } from '../lib/phone.js';
import { randomUUID } from 'node:crypto';
import { openOwnerRequest, type OwnerRequest } from '../domain/owner-requests.js';

function firstName(name: string): string {
  return /^\+?\d/.test(name) ? name : name.split(' ')[0];
}

function callerDisplayName(conversation: Conversation): string {
  const named = [...conversation.events].reverse().find((event) =>
    (event.type === 'caller.identified' && typeof event.payload.name === 'string') ||
    (event.type === 'sms.consent.granted' && typeof event.payload.displayName === 'string'));
  return named ? String(named.payload.name ?? named.payload.displayName) : conversation.callerPhone;
}

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
    /** Where "the owner should know" goes; surfaces (phone, Mac, SMS) are the router's business. */
    private readonly attention?: OwnerAttentionService,
  ) {}

  async resolveAttention(conversationId: string, types: Parameters<OwnerAttentionService['resolve']>[2], reason: string): Promise<void> {
    if (!this.attention) return;
    const conversation = await this.repository.getById(conversationId);
    await this.attention.resolve(conversation?.ownerId ?? this.ownerId, conversationId, types, reason).catch(() => undefined);
  }

  /** Raise owner attention for a conversation; never fails the conversation itself. */
  async raiseAttention(conversationId: string, input: Omit<RaiseAttentionInput, 'ownerId' | 'conversationId' | 'title'> & {
    title: (callerName: string) => string;
  }): Promise<string | null> {
    if (!this.attention) return null;
    try {
      const conversation = await this.requireConversation(conversationId);
      const attention = await this.attention.raise({
        ...input,
        title: input.title(callerDisplayName(conversation)),
        ownerId: conversation.ownerId ?? this.ownerId,
        conversationId,
      });
      return attention.id;
    } catch (error) {
      console.error(`[attention ${conversationId}]`, error instanceof Error ? error.message : error);
      return null;
    }
  }

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
    await this.raiseAttention(conversationId, {
      type: 'conversation_transferred',
      title: (name) => `${firstName(name)} is now texting`,
      body: `About ${summary}`.replace(/\.$/, ''),
      dedupeKey: ownerKey,
      metadata: { messageKey: ownerKey, messageBody: ownerMessage },
    });

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
   * The assistant needs the owner: record the request (it stays open until the
   * owner replies) and notify them. Only attention-worthy moments notify.
   */
  async requestOwner(conversationId: string, input: {
    question: string;
    suggestedReplies?: string[];
    source: string;
    callId?: string;
  }): Promise<string> {
    const conversation = await this.requireConversation(conversationId);
    const requestId = `req_${input.callId ?? randomUUID()}`;
    if (conversation.events.some((event) =>
      event.type === 'owner.attention.requested' && event.payload.requestId === requestId)) return requestId;
    const suggestedReplies = (input.suggestedReplies ?? []).map((reply) => reply.trim()).filter(Boolean).slice(0, 3);
    await this.repository.appendEvent(conversationId, 'owner.attention.requested', {
      requestId, question: input.question, suggestedReplies, source: input.source,
    }, new Date());
    const caller = callerDisplayName(conversation);
    await this.raiseAttention(conversationId, {
      type: 'assistant_needs_owner',
      title: (name) => `${firstName(name)} needs you`,
      body: `“${input.question}”`,
      dedupeKey: `owner-request:${requestId}`,
      metadata: {
        requestId, suggestedReplies, source: input.source,
        messageKey: `owner-request:${requestId}`,
        messageBody: `${caller} is waiting: ${input.question}${suggestedReplies.length ? ` (e.g. "${suggestedReplies[0]}")` : ''} — reply here.`,
      },
    });
    return requestId;
  }

  /** The request the owner has not answered yet, if any. */
  openOwnerRequest(conversation: Conversation): OwnerRequest | null {
    return openOwnerRequest(conversation);
  }

  /** Where an owner reply without an explicit conversation (SMS, Messages) should go. */
  async findConversationForOwnerReply(): Promise<Conversation | null> {
    const conversations = await this.repository.list();
    const waiting = conversations
      .map((conversation) => ({ conversation, request: this.openOwnerRequest(conversation) }))
      .filter((candidate) => candidate.request)
      .sort((left, right) => right.request!.askedAt.getTime() - left.request!.askedAt.getTime())[0];
    if (waiting) return waiting.conversation;
    return conversations.find((candidate) => candidate.state === 'text_active' ||
      candidate.events.some((event) => event.type === 'conversation.channel_transitioned')) ?? null;
  }

  /** Earlier conversations with the same caller, newest first. */
  async priorConversations(conversationId: string, limit = 3): Promise<Conversation[]> {
    const conversation = await this.requireConversation(conversationId);
    return (await this.repository.list())
      .filter((candidate) => candidate.id !== conversationId && candidate.callerPhone === conversation.callerPhone)
      .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
      .slice(0, limit);
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
