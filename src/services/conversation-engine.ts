import { HttpError } from '../errors.js';
import type { Conversation } from '../domain/conversation.js';
import type { ConversationRepository } from '../repositories/conversation-repository.js';
import type { ConversationModel, ConversationTurn } from '../conversation/model.js';
import type { AudioInput, SpeechProvider } from '../speech/provider.js';
import type { VoiceProvider } from '../voice/provider.js';
import type { MessagingProvider } from '../messaging/provider.js';
import type { RuntimeControlService } from '../runtime/service.js';

const turnEvents = new Set(['speech.transcript', 'ai.response']);

export class ConversationEngine {
  constructor(
    private readonly repository: ConversationRepository,
    private readonly speech: SpeechProvider,
    private readonly model: ConversationModel,
    private readonly voice: VoiceProvider,
    private readonly messaging?: MessagingProvider,
    private readonly runtime?: RuntimeControlService,
  ) {}

  async respond(conversationId: string, input: AudioInput): Promise<Conversation> {
    const conversation = await this.requireConversation(conversationId);
    if (this.runtime && !await this.runtime.canAssistantRespond(conversationId)) {
      return conversation;
    }
    const existingTranscript = conversation.events.find(
      (event) =>
        event.type === 'speech.transcript' &&
        event.payload.callbackId === input.callbackId,
    );
    if (existingTranscript) return conversation;

    const sequence = this.nextSequence(conversation);
    await this.repository.appendEvent(
      conversationId,
      'speech.started',
      { callbackId: input.callbackId, sequence },
      new Date(),
    );
    await this.runtime?.noteSpeechStarted(conversationId, input.callbackId);

    const transcript = await this.speech.transcribe(input);
    if (!transcript.text.trim()) {
      // Nothing was said; return the runtime to listening instead of leaving it transcribing.
      await this.runtime?.noteVoiceStopped(conversationId, input.callbackId);
      return this.requireConversation(conversationId);
    }

    await this.repository.appendEvent(
      conversationId,
      'speech.transcript',
      {
        callbackId: input.callbackId,
        speaker: 'caller',
        text: transcript.text,
        sequence,
      },
      new Date(),
    );
    await this.runtime?.noteTranscript(conversationId, input.callbackId, transcript.text);

    if (this.runtime && !await this.runtime.shouldUseAssistantAutonomy(conversationId)) {
      await this.runtime.noteOwnerNeeded(conversationId, input.callbackId, transcript.text);
      return this.requireConversation(conversationId);
    }

    const history = this.history(await this.requireConversation(conversationId));
    await this.repository.appendEvent(
      conversationId,
      'ai.thinking',
      { callbackId: input.callbackId, sequence: sequence + 1 },
      new Date(),
    );
    await this.runtime?.noteAiStarted(conversationId, input.callbackId);
    const text = await this.model.respond(history);
    const currentConversation = await this.requireConversation(conversationId);
    if (currentConversation.state === 'text_active' || currentConversation.events.some(
      (event) => event.type === 'conversation.channel_transitioned',
    )) {
      const consent = [...currentConversation.events].reverse().find(
        (event) => event.type === 'sms.consent.granted',
      );
      if (!this.messaging || typeof consent?.payload.phoneNumber !== 'string') {
        throw new Error('SMS destination is unavailable');
      }

      const idempotencyKey = `conversation:${conversationId}:sms:turn:${input.callbackId}`;
      const result = await this.messaging.sendMessage({
        to: consent.payload.phoneNumber,
        body: text,
        idempotencyKey,
      });
      await this.repository.appendEvent(conversationId, 'assistant.message', {
        text, channel: 'sms', idempotencyKey, providerMessageId: result.providerMessageId,
      }, new Date());
      await this.repository.appendEvent(conversationId, 'sms.sent', {
        to: consent.payload.phoneNumber, body: text, idempotencyKey,
        providerMessageId: result.providerMessageId,
      }, new Date());
      await this.runtime?.noteAiCompleted(conversationId, input.callbackId, text);
      await this.runtime?.noteVoiceStopped(conversationId, input.callbackId);
      return this.requireConversation(conversationId);
    }

    await this.repository.appendEvent(
      conversationId,
      'ai.response',
      {
        callbackId: input.callbackId,
        speaker: 'assistant',
        text,
        sequence: sequence + 1,
      },
      new Date(),
    );
    await this.runtime?.noteAiCompleted(conversationId, input.callbackId, text);

    const runtime = this.runtime
      ? await this.runtime.getRuntimeForConversation(await this.requireConversation(conversationId))
      : null;
    if (runtime && !runtime.voiceEnabled) {
      await this.runtime?.noteVoiceStopped(conversationId, input.callbackId);
      return this.requireConversation(conversationId);
    }

    await this.repository.appendEvent(
      conversationId,
      'voice.started',
      { callbackId: input.callbackId, sequence: sequence + 1 },
      new Date(),
    );
    await this.runtime?.noteVoiceStarted(conversationId, input.callbackId, text);
    await this.voice.speak(text);
    await this.repository.appendEvent(
      conversationId,
      'voice.completed',
      { callbackId: input.callbackId, text, sequence: sequence + 1 },
      new Date(),
    );
    await this.runtime?.noteVoiceStopped(conversationId, input.callbackId);

    return this.requireConversation(conversationId);
  }

  async respondToOwner(
    conversationId: string,
    body: string,
    idempotencyKey: string,
    source: 'web' | 'macos_messages' = 'web',
  ): Promise<Conversation> {
    const conversation = await this.requireConversation(conversationId);
    const existing = conversation.events.find(
      (event) => event.type === 'owner.message' && event.payload.idempotencyKey === idempotencyKey,
    );
    if (!this.messaging || !conversation.events.some((event) => event.type === 'sms.consent.granted')) {
      throw new HttpError(409, 'The caller has not agreed to continue over text yet');
    }
    if (!existing) {
      await this.repository.appendEvent(conversationId, 'owner.message', {
        text: body, speaker: 'owner', channel: 'web', source, idempotencyKey,
      }, new Date());
    } else if (conversation.events.some(
      (event) => event.type === 'assistant.message' && event.payload.idempotencyKey === idempotencyKey,
    )) {
      return conversation;
    }
    const current = await this.requireConversation(conversationId);
    const consent = [...current.events].reverse().find(
      (event) => event.type === 'sms.consent.granted',
    );
    if (!this.messaging || typeof consent?.payload.phoneNumber !== 'string') {
      throw new HttpError(409, 'The caller has not agreed to continue over text yet');
    }
    const history = this.history(current);
    history.push({ speaker: 'owner', text: body, sequence: history.length + 1 });
    const text = await this.model.respond(history);
    try {
      const result = await this.messaging.sendMessage({
        to: consent.payload.phoneNumber, body: text, idempotencyKey: `${idempotencyKey}:sms`,
      });
      await this.repository.appendEvent(conversationId, 'assistant.message', {
        text, speaker: 'assistant', channel: 'sms', source, idempotencyKey,
        providerMessageId: result.providerMessageId,
      }, new Date());
      await this.repository.appendEvent(conversationId, 'sms.sent', {
        to: consent.payload.phoneNumber, body: text,
        idempotencyKey: `${idempotencyKey}:sms`, providerMessageId: result.providerMessageId,
      }, new Date());
    } catch (error) {
      await this.repository.appendEvent(conversationId, 'assistant.failed', {
        idempotencyKey, error: error instanceof Error ? error.message : 'unknown',
      }, new Date());
      throw error;
    }
    await this.runtime?.noteOwnerResponse(conversationId);
    return this.requireConversation(conversationId);
  }

  private history(conversation: Conversation): ConversationTurn[] {
    return conversation.events
      .filter((event) => turnEvents.has(event.type) || event.type === 'owner.message' ||
        event.type === 'caller.message' || event.type === 'assistant.message')
      .map((event) => ({
        speaker: event.payload.speaker as ConversationTurn['speaker'],
        text: String(event.payload.text),
        sequence: Number(event.payload.sequence),
      }))
      .sort((left, right) => left.sequence - right.sequence);
  }

  private nextSequence(conversation: Conversation): number {
    const lastSequence = conversation.events
      .filter((event) => turnEvents.has(event.type))
      .reduce((max, event) => Math.max(max, Number(event.payload.sequence) || 0), 2);
    return lastSequence + 1;
  }

  private async requireConversation(id: string): Promise<Conversation> {
    const conversation = await this.repository.getById(id);
    if (!conversation) throw new Error(`Conversation not found: ${id}`);
    return conversation;
  }
}
