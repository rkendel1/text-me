import { randomUUID } from 'node:crypto';

import type { Conversation, ConversationState } from '../domain/conversation.js';
import type {
  ConversationRuntime,
  RuntimeCommandInput,
  RuntimeOverride,
  RuntimeOverrideField,
} from '../domain/runtime.js';
import { HttpError } from '../errors.js';
import { assertJobOwnership, CrossTenantJobError } from '../tenancy/authorization.js';
import type { OwnerConfigurationService } from '../owner/configuration.js';
import type { ConversationRepository } from '../repositories/conversation-repository.js';
import type { ConversationRuntimeController } from './controller.js';
import { InMemoryRuntimeEventBus, type RuntimeEventBus } from './event-bus.js';
import { InMemoryRuntimeCommandStore, runtimeIdFor, type RuntimeCommand, type RuntimeCommandStore, type RuntimeCommandType } from './commands.js';
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

const COMMAND_TYPES: Partial<Record<Parameters<typeof createRuntimeEvent>[1], RuntimeCommandType>> = {
  'runtime.started': 'start',
  'runtime.stopped': 'stop',
  'runtime.paused': 'pause',
  'runtime.resumed': 'resume',
  'runtime.takeover': 'take_over',
  'runtime.returned_to_assistant': 'return_to_assistant',
  'runtime.interrupted': 'interrupt',
  'runtime.sms_transition_requested': 'transition_to_text',
};

type RuntimeEventListener = (event: ReturnType<typeof createRuntimeEvent>) => void;

export class RuntimeControlService {
  constructor(
    private readonly repository: ConversationRepository,
    private readonly configuration: OwnerConfigurationService,
    private readonly store: ConversationRuntimeStore,
    private readonly eventStore: ConversationRuntimeEventStore,
    private readonly overrides: RuntimeOverrideStore,
    private readonly controller: ConversationRuntimeController,
    private readonly bus: RuntimeEventBus = new InMemoryRuntimeEventBus(),
    private readonly commands: RuntimeCommandStore = new InMemoryRuntimeCommandStore(),
  ) {}

  async listCommands(conversationId: string, accountId: string): Promise<RuntimeCommand[]> {
    await this.requireOwnedConversation(conversationId, accountId);
    return this.commands.list(conversationId);
  }

  /** Let every owner surface (live screens, other instances) see new attention immediately. */
  async publishAttention(conversationId: string, payload: Record<string, unknown>): Promise<void> {
    await this.persistEvent(conversationId, 'runtime.attention', payload, true);
  }

  /**
   * The live call acted on this command (called by the instance holding the
   * call). The command is a job: it must belong to the same account as the
   * conversation the call is for, or nothing is recorded.
   */
  async markCommandAppliedLive(commandId: string, conversationId: string): Promise<void> {
    const command = await this.commands.get(commandId);
    if (!command) return;
    const conversation = await this.repository.getById(conversationId);
    assertJobOwnership({ id: command.id, accountId: command.accountId, resourceId: conversationId }, conversation);
    if (command.conversationId !== conversationId) {
      throw new CrossTenantJobError({ id: command.id, accountId: command.accountId, resourceId: conversationId }, conversation?.accountId);
    }
    await this.commands.update(commandId, { status: 'applied_live', appliedLiveAt: new Date() });
  }

  /**
   * Records the command; returns false if this command id was already recorded
   * (a retry, or the same command sent to two instances at once). Only the call
   * that recorded it executes it.
   */
  private async recordCommand(
    conversationId: string,
    accountId: string,
    type: RuntimeCommandType,
    commandId: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    return this.commands.record({
      id: commandId, conversationId, runtimeId: runtimeIdFor(conversationId), accountId, type, payload, status: 'accepted', createdAt: new Date(),
    });
  }

  /** A duplicate of a command another request is executing: wait for its outcome and report it, never run it twice. */
  private async settledReplay(conversation: Conversation, commandId: string): Promise<ConversationRuntime> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const command = await this.commands.get(commandId);
      if (command && command.conversationId !== conversation.id) throw new HttpError(409, 'Command id already used');
      if (command?.status === 'rejected') throw new HttpError(409, command.error ?? 'Command was rejected');
      if (command && command.status !== 'accepted') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.ensureRuntime(await this.requireConversation(conversation.id));
  }

  /**
   * Replay safety: a command id is executed once. Replaying an applied command
   * returns the current runtime; replaying a rejected one returns its original error.
   */
  private async replayed(conversation: Conversation, commandId: string): Promise<ConversationRuntime | null> {
    const command = await this.commands.get(commandId);
    if (command && command.conversationId !== conversation.id) throw new HttpError(409, 'Command id already used');
    if (command?.status === 'rejected') throw new HttpError(409, command.error ?? 'Command was rejected');
    if (command || await this.eventStore.findByCommandId(conversation.id, commandId)) return this.ensureRuntime(conversation);
    return null;
  }

  /**
   * adjust_interaction: change how the assistant handles this one conversation.
   * All fields are validated first and applied together as one revision; account
   * defaults are never touched.
   */
  async adjust(
    conversationId: string,
    accountId: string,
    changes: Partial<Record<RuntimeOverrideField, unknown>>,
    input: RuntimeCommandInput = {},
    expiresAt?: Date,
  ): Promise<ConversationRuntime> {
    const commandId = input.commandId ?? randomUUID();
    const conversation = await this.requireOwnedConversation(conversationId, accountId);
    const replay = await this.replayed(conversation, commandId);
    if (replay) return replay;
    const fields = Object.keys(changes) as RuntimeOverrideField[];
    const runtime = await this.ensureRuntime(conversation);
    if (!await this.recordCommand(conversationId, accountId, 'adjust_interaction', commandId, {
      changes, expectedRevision: input.expectedRevision, ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
    })) return this.settledReplay(conversation, commandId);
    try {
      if (!fields.length) throw new HttpError(400, 'At least one runtime field is required');
      this.assertRevision(runtime, input.expectedRevision);
      for (const field of fields) this.validateOverride(field, changes[field]);
      if (expiresAt && !Number.isFinite(expiresAt.getTime())) throw new HttpError(400, 'expiresAt must be a valid date');
    } catch (error) {
      await this.commands.update(commandId, { status: 'rejected', error: error instanceof Error ? error.message : 'Rejected', processedAt: new Date() });
      throw error;
    }
    const added = fields.map((field): RuntimeOverride => ({ conversationId, field, value: changes[field], createdAt: new Date(), expiresAt }));
    const projected = [...(await this.overrides.list(conversationId)).filter((override) => !fields.includes(override.field)), ...added];
    const updated = this.bump(this.applyOverrides(runtime, projected), {}, true);
    // Commit first (compare-and-set on the revision we read); only the winner writes its overrides.
    await this.commit(commandId, runtime, updated);
    for (const override of added) await this.overrides.save(override);
    await this.syncConversationState(conversation, updated.state);
    await this.controller.update(conversationId, updated);
    await this.commands.update(commandId, { status: 'applied', processedAt: new Date() });
    await this.persistEvent(conversationId, 'runtime.configuration_changed', {
      commandId, accountId, fields, changes, revision: updated.configurationRevision,
    }, true);
    return updated;
  }

  /** Drop every conversation-scoped override and return to the owner's defaults. */
  async resetOverrides(conversationId: string, accountId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    const commandId = input.commandId ?? randomUUID();
    const conversation = await this.requireOwnedConversation(conversationId, accountId);
    const replay = await this.replayed(conversation, commandId);
    if (replay) return replay;
    const runtime = await this.ensureRuntime(conversation);
    if (!await this.recordCommand(conversationId, accountId, 'adjust_interaction', commandId, { reset: true, expectedRevision: input.expectedRevision })) {
      return this.settledReplay(conversation, commandId);
    }
    try {
      this.assertRevision(runtime, input.expectedRevision);
    } catch (error) {
      await this.commands.update(commandId, { status: 'rejected', error: error instanceof Error ? error.message : 'Rejected', processedAt: new Date() });
      throw error;
    }
    const cleared = (await this.overrides.list(conversationId)).map((override) => override.field);
    // Keep live call state (listening, speaking…) but take every setting from the defaults again.
    const { next: defaults } = await this.projectRuntime(conversation, true, []);
    const updated = this.bump({
      ...defaults, state: runtime.state, currentActivity: runtime.currentActivity,
      aiMode: runtime.aiMode === 'owner_only' && !cleared.includes('aiMode') ? runtime.aiMode : defaults.aiMode,
      configurationRevision: runtime.configurationRevision,
    }, {}, true);
    await this.commit(commandId, runtime, updated);
    await this.overrides.clearConversation(conversationId);
    await this.controller.update(conversationId, updated);
    await this.commands.update(commandId, { status: 'applied', processedAt: new Date() });
    await this.persistEvent(conversationId, 'runtime.configuration_changed', {
      commandId, accountId, reset: true, fields: cleared, revision: updated.configurationRevision,
    }, true);
    return updated;
  }

  async getRuntime(conversationId: string, accountId: string): Promise<ConversationRuntime> {
    const conversation = await this.requireOwnedConversation(conversationId, accountId);
    return this.ensureRuntime(conversation);
  }

  async getRuntimeForConversation(conversation: Conversation): Promise<ConversationRuntime> {
    return this.ensureRuntime(conversation);
  }

  async listRuntimes(accountId: string): Promise<ConversationRuntime[]> {
    const conversations = (await this.repository.list(accountId)).filter((conversation) => conversation.accountId === accountId);
    return Promise.all(conversations.map((conversation) => this.ensureRuntime(conversation)));
  }

  subscribe(conversationId: string, listener: RuntimeEventListener): () => void {
    return this.bus.subscribe(conversationId, listener as Parameters<RuntimeEventBus['subscribe']>[1]);
  }

  /**
   * Live events for every conversation in this account. The bus carries every
   * account's events (one channel for the whole platform), so each event is
   * checked against the durable owner of its conversation before it is passed
   * on; anything that can't be resolved is dropped.
   */
  subscribeOwner(accountId: string, listener: RuntimeEventListener): () => void {
    const owners = new Map<string, Promise<boolean>>();
    const visible = (conversationId: string) => {
      if (!owners.has(conversationId)) {
        owners.set(conversationId, this.repository.getById(conversationId)
          .then((conversation) => Boolean(accountId && conversation?.accountId === accountId), () => false));
      }
      return owners.get(conversationId)!;
    };
    return this.bus.subscribeAll((event) => {
      void visible(event.conversationId).then((allowed) => { if (allowed) listener(event as Parameters<RuntimeEventListener>[0]); });
    });
  }

  /** Ask the live call (on whichever instance holds it) to speak the owner's words to the caller. */
  async requestOwnerSpeech(
    conversationId: string,
    accountId: string,
    text: string,
    meta: { messageId?: string; requestId?: string; commandId?: string } = {},
  ): Promise<void> {
    await this.requireOwnedConversation(conversationId, accountId);
    const commandId = meta.commandId ?? randomUUID();
    if (!await this.recordCommand(conversationId, accountId, meta.requestId ? 'answer_owner_request' : 'owner_message', commandId, {
      text, ...meta,
    })) return;
    await this.commands.update(commandId, { status: 'applied', processedAt: new Date() });
    await this.persistEvent(conversationId, 'runtime.owner_speech', { text, ...meta, commandId, accountId }, true);
  }

  async listEvents(conversationId: string, accountId: string) {
    await this.requireOwnedConversation(conversationId, accountId);
    return this.eventStore.list(conversationId);
  }

  async start(conversationId: string, accountId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    return this.applyCommand(conversationId, accountId, 'runtime.started', input, async (runtime) => {
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

  async stop(conversationId: string, accountId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    return this.applyCommand(conversationId, accountId, 'runtime.stopped', input, async (runtime) => {
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

  async pause(conversationId: string, accountId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    return this.applyCommand(conversationId, accountId, 'runtime.paused', input, async (runtime) => {
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

  async resume(conversationId: string, accountId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    return this.applyCommand(conversationId, accountId, 'runtime.resumed', input, async (runtime) => {
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

  async takeOver(conversationId: string, accountId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    return this.applyCommand(conversationId, accountId, 'runtime.takeover', input, async (runtime) => {
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

  async returnToAssistant(conversationId: string, accountId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    return this.applyCommand(conversationId, accountId, 'runtime.returned_to_assistant', input, async (runtime) => {
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

  async interrupt(conversationId: string, accountId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    return this.applyCommand(conversationId, accountId, 'runtime.interrupted', input, async (runtime) => {
      if (runtime.state !== 'speaking') return { runtime, changed: false };
      const next = this.bump(runtime, {
        state: runtime.voiceEnabled ? 'listening' : 'text_active',
        currentActivity: 'Listening after interruption',
      });
      await this.controller.interrupt(conversationId);
      return { runtime: next, changed: true };
    });
  }

  async transitionToSms(conversationId: string, accountId: string, input: RuntimeCommandInput = {}): Promise<ConversationRuntime> {
    return this.applyCommand(conversationId, accountId, 'runtime.sms_transition_requested', input, async (runtime, conversation) => {
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
    accountId: string,
    field: RuntimeOverrideField,
    value: unknown,
    input: RuntimeCommandInput = {},
    expiresAt?: Date,
  ): Promise<ConversationRuntime> {
    return this.adjust(conversationId, accountId, { [field]: value }, input, expiresAt);
  }

  async clearTemporaryOverride(
    conversationId: string,
    accountId: string,
    field: RuntimeOverrideField,
    input: RuntimeCommandInput = {},
  ): Promise<ConversationRuntime> {
    const commandId = input.commandId ?? randomUUID();
    const conversation = await this.requireOwnedConversation(conversationId, accountId);
    const existing = await this.eventStore.findByCommandId(conversation.id, commandId);
    if (existing) return this.ensureRuntime(conversation);
    const runtime = await this.ensureRuntime(conversation);
    if (!await this.recordCommand(conversationId, accountId, 'adjust_interaction', commandId, { clear: [field], expectedRevision: input.expectedRevision })) {
      return this.settledReplay(conversation, commandId);
    }
    try {
      this.assertRevision(runtime, input.expectedRevision);
      this.validateOverrideField(field);
    } catch (error) {
      await this.commands.update(commandId, { status: 'rejected', error: error instanceof Error ? error.message : 'Rejected', processedAt: new Date() });
      throw error;
    }
    const remaining = (await this.overrides.list(conversationId)).filter((override) => override.field !== field);
    const { next } = await this.projectRuntime(conversation, true, remaining);
    const refreshed = this.bump({ ...next, configurationRevision: runtime.configurationRevision }, {}, true);
    await this.commit(commandId, runtime, refreshed);
    await this.overrides.delete(conversationId, field);
    await this.controller.update(conversationId, refreshed);
    await this.commands.update(commandId, { status: 'applied', processedAt: new Date() });
    await this.persistEvent(conversationId, 'runtime.configuration_changed', {
      commandId,
      accountId,
      field,
      cleared: true,
      revision: refreshed.configurationRevision,
    }, true);
    return refreshed;
  }

  async finalizeSmsTransition(conversationId: string): Promise<ConversationRuntime> {
    const conversation = await this.requireConversation(conversationId);
    let runtime = await this.ensureRuntime(conversation);
    let next: ConversationRuntime;
    for (let attempt = 0; ; attempt += 1) {
      if (runtime.state !== 'transferring') return runtime;
      next = this.bump(runtime, { state: 'text_active', voiceEnabled: false, currentActivity: 'Text conversation active' }, false);
      if (await this.store.save(next, runtime.configurationRevision) || attempt >= 3) break;
      runtime = await this.ensureRuntime(await this.requireConversation(conversationId));
    }
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
    // "Ask me" mode still lets the assistant talk; it escalates instead of deciding. Only takeover silences it.
    return runtime.aiMode !== 'owner_only';
  }

  private async applyCommand(
    conversationId: string,
    accountId: string,
    eventType: Parameters<typeof createRuntimeEvent>[1],
    input: RuntimeCommandInput,
    apply: (runtime: ConversationRuntime, conversation: Conversation) => Promise<{ runtime: ConversationRuntime; changed: boolean }>,
  ): Promise<ConversationRuntime> {
    const commandId = input.commandId ?? randomUUID();
    const conversation = await this.requireOwnedConversation(conversationId, accountId);
    const replay = await this.replayed(conversation, commandId);
    if (replay) return replay;
    const runtime = await this.ensureRuntime(conversation);
    const commandType = COMMAND_TYPES[eventType];
    if (commandType && !await this.recordCommand(conversationId, accountId, commandType, commandId, { expectedRevision: input.expectedRevision })) {
      return this.settledReplay(conversation, commandId);
    }
    try {
      this.assertRevision(runtime, input.expectedRevision);
    } catch (error) {
      if (commandType) await this.commands.update(commandId, { status: 'rejected', error: error instanceof Error ? error.message : 'Rejected', processedAt: new Date() });
      throw error;
    }
    try {
      const result = await apply(runtime, conversation);
      if (!result.changed) {
        if (commandType) await this.commands.update(commandId, { status: 'noop', processedAt: new Date() });
        return result.runtime;
      }
      await this.commit(commandId, runtime, result.runtime);
      await this.supersedeOverrides(conversationId, runtime, result.runtime);
      await this.syncConversationState(conversation, result.runtime.state);
      if (commandType) await this.commands.update(commandId, { status: 'applied', processedAt: new Date() });
      await this.persistEvent(conversationId, eventType, {
        commandId,
        accountId,
        revision: result.runtime.configurationRevision,
        state: result.runtime.state,
      }, true);
      return result.runtime;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Runtime command failed';
      if (commandType) await this.commands.update(commandId, { status: 'rejected', error: reason, processedAt: new Date() });
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

  /**
   * A command (take over, stop, move to text…) is the owner's latest word on the
   * fields it changes, so any earlier per-conversation override of those fields
   * must not re-apply on the next read.
   */
  private async supersedeOverrides(conversationId: string, before: ConversationRuntime, after: ConversationRuntime): Promise<void> {
    const overrides = await this.overrides.list(conversationId);
    for (const override of overrides) {
      if (before[override.field] !== after[override.field]) await this.overrides.delete(conversationId, override.field);
    }
  }

  /**
   * What the runtime should be, from the stored row (or the account's defaults
   * when reset or new), the conversation's state and its overrides. Pure: writes nothing.
   */
  private async projectRuntime(conversation: Conversation, reset = false, overrides?: RuntimeOverride[]) {
    const baseConfiguration = await this.configuration.get(conversation.accountId);
    const stored = await this.store.get(conversation.id);
    const defaults = createDefaultRuntime(conversation, baseConfiguration);
    // A reset takes settings from the defaults but keeps counting revisions forward.
    const current = reset ? { ...defaults, ...(stored ? { configurationRevision: stored.configurationRevision, appliedRevision: stored.appliedRevision } : {}) }
      : stored ?? defaults;
    const normalizedState = deriveRuntimeState(conversation);
    const nextState: ConversationRuntime['state'] = conversation.state === 'awaiting_sms_consent'
      ? current.state === 'transferring' ? 'transferring' : 'listening'
      : conversation.state === 'text_active'
        ? 'text_active'
        : conversation.status === 'completed'
          ? 'stopped'
          : current.state === 'idle' || current.state === 'starting' ? normalizedState : current.state;
    const next = this.applyOverrides({ ...current, state: nextState }, overrides ?? await this.overrides.list(conversation.id));
    const dirty = !stored || reset || next.state !== conversation.state || next.configurationRevision !== current.configurationRevision;
    return { stored, next, dirty };
  }

  private async ensureRuntime(conversation: Conversation, reset = false): Promise<ConversationRuntime> {
    const { stored, next, dirty } = await this.projectRuntime(conversation, reset);
    if (!dirty) return next;
    const updated = this.bump(next, {}, !stored || reset);
    if (!(await this.store.save(updated, stored ? stored.configurationRevision : null))) {
      // Another instance wrote first; theirs is the newer state.
      const fresh = await this.store.get(conversation.id);
      if (fresh) return this.applyOverrides(fresh, await this.overrides.list(conversation.id));
    }
    await this.syncConversationState(conversation, updated.state);
    return updated;
  }

  /** Commit a command's result only if the runtime is still the one it was computed from. */
  private async commit(commandId: string, before: ConversationRuntime, after: ConversationRuntime): Promise<void> {
    if (await this.store.save(after, before.configurationRevision)) return;
    const error = new HttpError(409, 'The conversation changed at the same moment (stale revision). Refresh and try again.', 'stale_revision');
    await this.commands.update(commandId, { status: 'rejected', error: error.message, processedAt: new Date() });
    throw error;
  }


  private applyOverrides(runtime: ConversationRuntime, overrides: RuntimeOverride[]): ConversationRuntime {
    const now = Date.now();
    const active = overrides.filter((override) => !override.expiresAt || override.expiresAt.getTime() > now);
    return active.reduce((current, override) => ({
      ...current,
      [override.field]: override.value,
    }), { ...runtime, overriddenFields: active.map((override) => override.field) });
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
    let conversation = await this.requireConversation(conversationId);
    let next: ConversationRuntime;
    // Activity never overwrites a command committed meanwhile by another instance: re-read and re-apply.
    for (let attempt = 0; ; attempt += 1) {
      const runtime = await this.ensureRuntime(conversation);
      // Once a conversation has moved to text, trailing call activity (the goodbye) must not pull it back to voice.
      const movedToText = conversation.events.some((event) => event.type === 'conversation.channel_transitioned');
      const keepText = movedToText && patch.state !== 'waiting_for_owner';
      next = this.bump(runtime, keepText ? { ...patch, state: 'text_active' } : patch, false);
      if (await this.store.save(next, runtime.configurationRevision) || attempt >= 3) break;
      conversation = await this.requireConversation(conversationId);
    }
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
    await this.bus.publish(event);
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

  private async requireOwnedConversation(conversationId: string, accountId: string): Promise<Conversation> {
    const conversation = await this.requireConversation(conversationId);
    // Fail closed: no account on either side, or a different one, is "not found".
    if (!accountId || !conversation.accountId || conversation.accountId !== accountId) {
      throw new HttpError(404, 'Conversation not found');
    }
    return conversation;
  }
}
