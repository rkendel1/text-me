import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import type { Conversation, ConversationState } from '../domain/conversation.js';
import type {
  ConversationRuntime,
  RuntimeCommandInput,
  RuntimeOverride,
  RuntimeOverrideField,
} from '../domain/runtime.js';
import { HttpError } from '../errors.js';
import type { OwnerConfigurationService } from '../owner/configuration.js';
import type { ConversationRepository } from '../repositories/conversation-repository.js';
import type { ConversationRuntimeController } from './controller.js';
import {
  ConversationRuntimeEventStore,
  ConversationRuntimeStore,
  RuntimeOverrideStore,
  createDefaultRuntime,
  createRuntimeEvent,
  deriveRuntimeState,
} from './store.js';

export interface RuntimeConfigurationPatch {
  assistantEnabled?: boolean;
  voiceEnabled?: boolean;
  transcriptionEnabled?: boolean;
  aiMode?: ConversationRuntime['aiMode'];
  responseStyle?: ConversationRuntime['responseStyle'];
  verbosity?: ConversationRuntime['verbosity'];
  askOwnerWhen?: ConversationRuntime['askOwnerWhen'];
  allowCommitments?: boolean;
  allowScheduling?: boolean;
  allowCallerFollowups?: boolean;
  customInstructions?: string;
  smsTransitionEnabled?: boolean;
}

type RuntimeEventListener = (event: ReturnType<typeof createRuntimeEvent>) => void;

export class RuntimeControlService {
  private readonly events = new EventEmitter();

  constructor(
    private readonly repository: ConversationRepository,
    private readonly configuration: OwnerConfigurationService,
    private readonly store: ConversationRuntimeStore,
    private readonly eventStore: ConversationRuntimeEventStore,
    private readonly overrides: RuntimeOverrideStore,
    private readonly controller: ConversationRuntimeController,
  ) {}

  async getRuntime(conversationId: string, ownerId: string): Promise<ConversationRuntime> {
    const conversation = await this.requireOwnedConversation(conversationId, ownerId);
    return this.ensureRuntime(conversation);
  }

  async getRuntimeForConversation(conversation: Conversation): Promise<ConversationRuntime> {
    return this.ensureRuntime(conversation);
  }

  async listRuntimes(ownerId: string): Promise<ConversationRuntime[]> {
    const conversations = (await this.repository.list()).filter((conversation) =>
      !conversation.ownerId || conversation.ownerId === ownerId,
    );
    return Promise.all(conversations.map((conversation) => this.ensureRuntime(conversation)));
  }

  subscribe(conversationId: string, listener: RuntimeEventListener): () => void {
    const eventName = `runtime:${conversationId}`;
    this.events.on(eventName, listener);
    return () => this.events.off(eventName, listener);
  }

  async listEvents(conversationId: string, ownerId: string) {
    await this.requireOwnedConversation(conversationId, ownerId);
    return this.eventStore.list(conversationId);
  }

  async start(conversationId: string, ownerId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    return this.applyCommand(conversationId, ownerId, 'runtime.started', input, async (runtime) => {
      if (runtime.state === 'listening' && runtime.assistantEnabled) return { runtime, changed: false };
      if (runtime.state === 'paused') throw new HttpError(409, 'Use resume to continue a paused conversation');
      const next = this.bump(runtime, {
        state: runtime.state === 'text_active' ? 'text_active' : 'listening',
        assistantEnabled: true,
        stoppedAt: undefined,
        pausedAt: undefined,
        currentActivity: 'Listening for the caller',
      });
      await this.controller.start(conversationId);
      return { runtime: next, changed: true };
    });
  }

  async stop(conversationId: string, ownerId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    return this.applyCommand(conversationId, ownerId, 'runtime.stopped', input, async (runtime) => {
      if (runtime.state === 'stopped' && !runtime.assistantEnabled) return { runtime, changed: false };
      const next = this.bump(runtime, {
        state: 'stopped',
        assistantEnabled: false,
        stoppedAt: new Date(),
        currentTurnId: undefined,
        currentActivity: 'Stopped by owner',
      });
      await this.controller.stop(conversationId);
      return { runtime: next, changed: true };
    });
  }

  async pause(conversationId: string, ownerId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    return this.applyCommand(conversationId, ownerId, 'runtime.paused', input, async (runtime) => {
      if (runtime.state === 'paused') return { runtime, changed: false };
      if (runtime.state === 'stopped') throw new HttpError(409, 'Stopped conversations cannot be paused');
      const next = this.bump(runtime, {
        state: 'paused',
        pausedAt: new Date(),
        currentActivity: 'Paused by owner',
      });
      await this.controller.pause(conversationId);
      return { runtime: next, changed: true };
    });
  }

  async resume(conversationId: string, ownerId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    return this.applyCommand(conversationId, ownerId, 'runtime.resumed', input, async (runtime) => {
      if (runtime.state !== 'paused') {
        if (runtime.state === 'listening' || runtime.state === 'text_active') return { runtime, changed: false };
        throw new HttpError(409, 'Only paused conversations can resume');
      }
      const next = this.bump(runtime, {
        state: runtime.voiceEnabled ? 'listening' : 'text_active',
        pausedAt: undefined,
        assistantEnabled: true,
        currentActivity: runtime.voiceEnabled ? 'Listening for the caller' : 'Text conversation active',
      });
      await this.controller.resume(conversationId);
      return { runtime: next, changed: true };
    });
  }

  async takeOver(conversationId: string, ownerId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    return this.applyCommand(conversationId, ownerId, 'runtime.takeover', input, async (runtime) => {
      if (runtime.aiMode === 'owner_only') return { runtime, changed: false };
      const next = this.bump(runtime, {
        aiMode: 'owner_only',
        state: runtime.state === 'stopped' ? 'stopped' : 'waiting_for_owner',
        currentActivity: 'Waiting for owner input',
      });
      await this.controller.update(conversationId, next);
      return { runtime: next, changed: true };
    });
  }

  async returnToAssistant(conversationId: string, ownerId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    return this.applyCommand(conversationId, ownerId, 'runtime.returned_to_assistant', input, async (runtime) => {
      if (runtime.aiMode === 'automatic') return { runtime, changed: false };
      const next = this.bump(runtime, {
        aiMode: 'automatic',
        state: runtime.state === 'waiting_for_owner'
          ? (runtime.voiceEnabled ? 'listening' : 'text_active')
          : runtime.state,
        currentActivity: runtime.voiceEnabled ? 'Listening for the caller' : 'Text conversation active',
      });
      await this.controller.update(conversationId, next);
      return { runtime: next, changed: true };
    });
  }

  async interrupt(conversationId: string, ownerId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    return this.applyCommand(conversationId, ownerId, 'runtime.interrupted', input, async (runtime) => {
      if (runtime.state !== 'speaking') return { runtime, changed: false };
      const next = this.bump(runtime, {
        state: runtime.voiceEnabled ? 'listening' : 'text_active',
        currentActivity: 'Listening after interruption',
      });
      await this.controller.interrupt(conversationId);
      return { runtime: next, changed: true };
    });
  }

  async transitionToSms(conversationId: string, ownerId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    return this.applyCommand(conversationId, ownerId, 'runtime.sms_transition_requested', input, async (runtime, conversation) => {
      if (!runtime.smsTransitionEnabled) throw new HttpError(409, 'SMS transition is disabled');
      if (runtime.state === 'text_active') return { runtime, changed: false };
      const next = this.bump(runtime, {
        state: 'transferring',
        currentActivity: 'Waiting for caller SMS consent',
      });
      await this.controller.update(conversationId, next);
      if (conversation.events.some((event) => event.type === 'sms.consent.granted')) {
        return { runtime: this.bump(next, {
          state: 'text_active',
          voiceEnabled: false,
          currentActivity: 'Text conversation active',
        }, false), changed: true };
      }
      return { runtime: next, changed: true };
    });
  }

  async setTemporaryOverride(
    conversationId: string,
    ownerId: string,
    field: RuntimeOverrideField,
    value: unknown,
    input: RuntimeCommandInput = {},
    expiresAt?: Date,
  ): Promise<ConversationRuntime> {
    const commandId = input.commandId ?? randomUUID();
    const conversation = await this.requireOwnedConversation(conversationId, ownerId);
    const existing = await this.eventStore.findByCommandId(conversation.id, commandId);
    if (existing) return this.ensureRuntime(conversation);
    const runtime = await this.ensureRuntime(conversation);
    this.assertRevision(runtime, input.expectedRevision);
    this.validateOverride(field, value);
    if (expiresAt && !Number.isFinite(expiresAt.getTime())) {
      throw new HttpError(400, 'expiresAt must be a valid date');
    }
    const override: RuntimeOverride = {
      conversationId,
      field,
      value,
      createdAt: new Date(),
      expiresAt,
    };
    await this.overrides.save(override);
    const next = this.applyOverrides(runtime, await this.overrides.list(conversationId));
    const updated = this.bump(next, {}, true);
    await this.store.save(updated);
    await this.syncConversationState(conversation, updated.state);
    await this.controller.update(conversationId, updated);
    await this.persistEvent(conversationId, 'runtime.configuration_changed', {
      commandId,
      field,
      value,
      revision: updated.configurationRevision,
    }, true);
    return updated;
  }

  async clearTemporaryOverride(
    conversationId: string,
    ownerId: string,
    field: RuntimeOverrideField,
    input: RuntimeCommandInput = {},
  ): Promise<ConversationRuntime> {
    const commandId = input.commandId ?? randomUUID();
    const conversation = await this.requireOwnedConversation(conversationId, ownerId);
    const existing = await this.eventStore.findByCommandId(conversation.id, commandId);
    if (existing) return this.ensureRuntime(conversation);
    const runtime = await this.ensureRuntime(conversation);
    this.assertRevision(runtime, input.expectedRevision);
    this.validateOverrideField(field);
    await this.overrides.delete(conversationId, field);
    const refreshed = await this.ensureRuntime(conversation, true);
    await this.controller.update(conversationId, refreshed);
    await this.persistEvent(conversationId, 'runtime.configuration_changed', {
      commandId,
      field,
      cleared: true,
      revision: refreshed.configurationRevision,
    }, true);
    return refreshed;
  }

  async finalizeSmsTransition(conversationId: string): Promise<ConversationRuntime> {
    const conversation = await this.requireConversation(conversationId);
    const runtime = await this.ensureRuntime(conversation);
    if (runtime.state !== 'transferring') return runtime;
    const next = this.bump(runtime, {
      state: 'text_active',
      voiceEnabled: false,
      currentActivity: 'Text conversation active',
    }, false);
    await this.store.save(next);
    await this.syncConversationState(conversation, 'text_active');
    await this.controller.update(conversationId, next);
    await this.emitEvent(conversationId, 'runtime.state_changed', {
      state: next.state,
      revision: next.configurationRevision,
    });
    return next;
  }

  async noteTranscript(conversationId: string, callbackId: string, text: string): Promise<void> {
    await this.noteActivity(conversationId, {
      state: 'thinking',
      currentTurnId: callbackId,
      currentActivity: 'Transcript finalized',
    }, 'runtime.transcript_final', {
      callbackId,
      speaker: 'caller',
      status: 'final',
      text,
    });
  }

  async noteSpeechStarted(conversationId: string, callbackId: string): Promise<void> {
    await this.noteActivity(conversationId, {
      state: 'transcribing',
      currentTurnId: callbackId,
      currentActivity: 'Transcribing caller speech',
    }, 'runtime.state_changed', {
      callbackId,
      state: 'transcribing',
    });
  }

  async noteAiStarted(conversationId: string, callbackId: string): Promise<void> {
    await this.noteActivity(conversationId, {
      state: 'thinking',
      currentTurnId: callbackId,
      currentActivity: 'Assistant thinking',
    }, 'runtime.ai_started', {
      callbackId,
    });
  }

  async noteAiCompleted(conversationId: string, callbackId: string, text: string): Promise<void> {
    await this.noteActivity(conversationId, {
      state: 'speaking',
      currentTurnId: callbackId,
      currentActivity: 'Assistant response generated',
    }, 'runtime.ai_completed', {
      callbackId,
      text,
    });
  }

  async noteVoiceStarted(conversationId: string, callbackId: string, text: string): Promise<void> {
    await this.noteActivity(conversationId, {
      state: 'speaking',
      currentTurnId: callbackId,
      currentActivity: 'Assistant speaking',
    }, 'runtime.voice_started', {
      callbackId,
      text,
    });
  }

  async noteVoiceStopped(conversationId: string, callbackId: string): Promise<void> {
    const conversation = await this.requireConversation(conversationId);
    const runtime = await this.ensureRuntime(conversation);
    const nextState = runtime.voiceEnabled ? 'listening' : 'text_active';
    await this.noteActivity(conversationId, {
      state: nextState,
      currentTurnId: callbackId,
      currentActivity: nextState === 'listening' ? 'Listening for the caller' : 'Text conversation active',
    }, 'runtime.voice_stopped', {
      callbackId,
      state: nextState,
    });
  }

  async noteOwnerNeeded(conversationId: string, callbackId: string, text: string): Promise<void> {
    await this.noteActivity(conversationId, {
      state: 'waiting_for_owner',
      currentTurnId: callbackId,
      currentActivity: 'Waiting for owner input',
    }, 'runtime.owner_needed', {
      callbackId,
      text,
    });
  }

  async noteOwnerResponse(conversationId: string): Promise<void> {
    const conversation = await this.requireConversation(conversationId);
    const runtime = await this.ensureRuntime(conversation);
    if (runtime.state !== 'waiting_for_owner') return;
    const nextState = runtime.voiceEnabled ? 'listening' : 'text_active';
    await this.noteActivity(conversationId, {
      state: nextState,
      currentActivity: nextState === 'listening' ? 'Listening for the caller' : 'Text conversation active',
    }, 'runtime.state_changed', {
      state: nextState,
    });
  }

  async canAssistantRespond(conversationId: string): Promise<boolean> {
    const conversation = await this.requireConversation(conversationId);
    const runtime = await this.ensureRuntime(conversation);
    return runtime.assistantEnabled && runtime.state !== 'paused' && runtime.state !== 'stopped';
  }

  async shouldUseAssistantAutonomy(conversationId: string): Promise<boolean> {
    const conversation = await this.requireConversation(conversationId);
    const runtime = await this.ensureRuntime(conversation);
    return runtime.aiMode === 'automatic';
  }

  private async applyCommand(
    conversationId: string,
    ownerId: string,
    eventType: Parameters<typeof createRuntimeEvent>[1],
    input: RuntimeCommandInput,
    apply: (runtime: ConversationRuntime, conversation: Conversation) => Promise<{ runtime: ConversationRuntime; changed: boolean }>,
  ): Promise<ConversationRuntime> {
    const commandId = input.commandId ?? randomUUID();
    const conversation = await this.requireOwnedConversation(conversationId, ownerId);
    const existing = await this.eventStore.findByCommandId(conversation.id, commandId);
    if (existing) return this.ensureRuntime(conversation);
    const runtime = await this.ensureRuntime(conversation);
    this.assertRevision(runtime, input.expectedRevision);
    try {
      const result = await apply(runtime, conversation);
      if (!result.changed) return result.runtime;
      await this.store.save(result.runtime);
      await this.syncConversationState(conversation, result.runtime.state);
      await this.persistEvent(conversationId, eventType, {
        commandId,
        revision: result.runtime.configurationRevision,
        state: result.runtime.state,
      }, true);
      return result.runtime;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Runtime command failed';
      await this.persistEvent(conversationId, 'runtime.command_failed', {
        commandId,
        failedCommand: eventType,
        reason,
      }, true);
      await this.persistEvent(conversationId, 'runtime.error', {
        commandId,
        failedCommand: eventType,
        reason,
      });
      if (error instanceof HttpError) throw error;
      throw new HttpError(409, reason);
    }
  }

  private async ensureRuntime(conversation: Conversation, reset = false): Promise<ConversationRuntime> {
    const baseConfiguration = await this.configuration.get(conversation.ownerId ?? 'owner');
    const stored = reset ? null : await this.store.get(conversation.id);
    const current = stored ?? createDefaultRuntime(conversation, baseConfiguration);
    const normalizedState = deriveRuntimeState(conversation);
    const nextState: ConversationRuntime['state'] = conversation.state === 'awaiting_sms_consent'
      ? current.state === 'transferring' ? 'transferring' : 'listening'
      : conversation.state === 'text_active'
        ? 'text_active'
        : conversation.status === 'completed'
          ? 'stopped'
          : current.state === 'idle' || current.state === 'starting' ? normalizedState : current.state;
    const next = this.applyOverrides({
      ...current,
      state: nextState,
    }, await this.overrides.list(conversation.id));
    if (!stored || reset || next.state !== conversation.state || next.configurationRevision !== current.configurationRevision) {
      const updated = this.bump(next, {}, !stored || reset);
      await this.store.save(updated);
      await this.syncConversationState(conversation, updated.state);
      return updated;
    }
    return next;
  }

  private applyOverrides(runtime: ConversationRuntime, overrides: RuntimeOverride[]): ConversationRuntime {
    const now = Date.now();
    return overrides
      .filter((override) => !override.expiresAt || override.expiresAt.getTime() > now)
      .reduce((current, override) => ({
        ...current,
        [override.field]: override.value,
      }), runtime);
  }

  private validateOverrideField(field: RuntimeOverrideField): void {
    const fields: RuntimeOverrideField[] = [
      'assistantEnabled',
      'aiMode',
      'responseStyle',
      'verbosity',
      'askOwnerWhen',
      'allowCommitments',
      'allowScheduling',
      'allowCallerFollowups',
      'customInstructions',
      'voiceEnabled',
      'transcriptionEnabled',
      'smsTransitionEnabled',
    ];
    if (!fields.includes(field)) throw new HttpError(400, 'Invalid runtime field');
  }

  private validateOverride(field: RuntimeOverrideField, value: unknown): void {
    this.validateOverrideField(field);
    const validValues: Record<RuntimeOverrideField, readonly unknown[]> = {
      assistantEnabled: [true, false],
      aiMode: ['automatic', 'owner_assist', 'owner_only'],
      responseStyle: ['concise', 'friendly', 'professional', 'custom'],
      verbosity: ['short', 'normal', 'detailed'],
      askOwnerWhen: ['never', 'uncertain', 'important', 'always'],
      allowCommitments: [true, false],
      allowScheduling: [true, false],
      allowCallerFollowups: [true, false],
      customInstructions: [],
      voiceEnabled: [true, false],
      transcriptionEnabled: [true, false],
      smsTransitionEnabled: [true, false],
    };
    if (field === 'customInstructions' && typeof value === 'string') return;
    if (!validValues[field].includes(value)) throw new HttpError(400, `Invalid value for ${field}`);
  }

  private bump(runtime: ConversationRuntime, patch: Partial<ConversationRuntime>, incrementRevision = true): ConversationRuntime {
    const revision = incrementRevision ? runtime.configurationRevision + 1 : runtime.configurationRevision;
    return {
      ...runtime,
      ...patch,
      configurationRevision: revision,
      appliedRevision: revision,
      updatedAt: new Date(),
    };
  }

  private assertRevision(runtime: ConversationRuntime, expectedRevision?: number): void {
    if (expectedRevision !== undefined && expectedRevision !== runtime.configurationRevision) {
      throw new HttpError(409, 'Runtime revision is stale');
    }
  }

  private async noteActivity(
    conversationId: string,
    patch: Partial<ConversationRuntime>,
    eventType: Parameters<typeof createRuntimeEvent>[1],
    payload: Record<string, unknown>,
  ): Promise<void> {
    const conversation = await this.requireConversation(conversationId);
    const runtime = await this.ensureRuntime(conversation);
    const next = this.bump(runtime, patch, false);
    await this.store.save(next);
    await this.syncConversationState(conversation, next.state);
    await this.persistEvent(conversationId, eventType, {
      ...payload,
      state: next.state,
      revision: next.configurationRevision,
    });
  }

  private async persistEvent(
    conversationId: string,
    type: Parameters<typeof createRuntimeEvent>[1],
    payload: Record<string, unknown>,
    durable = false,
  ): Promise<void> {
    const event = createRuntimeEvent(conversationId, type, payload, durable);
    await this.eventStore.append(event);
    this.events.emit(`runtime:${conversationId}`, event);
  }

  private async emitEvent(
    conversationId: string,
    type: Parameters<typeof createRuntimeEvent>[1],
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.persistEvent(conversationId, type, payload, false);
  }

  private async syncConversationState(conversation: Conversation, state: ConversationRuntime['state']): Promise<void> {
    const mapped = state as ConversationState;
    if (conversation.state === mapped) return;
    await this.repository.updateStatus(conversation.id, conversation.status, { state: mapped });
  }

  private async requireConversation(conversationId: string): Promise<Conversation> {
    const conversation = await this.repository.getById(conversationId);
    if (!conversation) throw new HttpError(404, 'Conversation not found');
    return conversation;
  }

  private async requireOwnedConversation(conversationId: string, ownerId: string): Promise<Conversation> {
    const conversation = await this.requireConversation(conversationId);
    if (conversation.ownerId && conversation.ownerId !== ownerId) {
      throw new HttpError(404, 'Conversation not found');
    }
    return conversation;
  }
}
