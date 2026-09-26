import { randomUUID } from 'node:crypto';

import type { Conversation, ConversationState } from '../domain/conversation.js';
import type {
  ConversationRuntime,
  ConversationRuntimeEvent,
  ConversationRuntimeEventType,
  InteractionState,
  RuntimeOverride,
} from '../domain/runtime.js';
import type { OwnerConfiguration } from '../owner/configuration.js';

export interface ConversationRuntimeStore {
  get(conversationId: string): Promise<ConversationRuntime | null>;
  save(runtime: ConversationRuntime): Promise<void>;
  list(conversationIds?: string[]): Promise<ConversationRuntime[]>;
}

export interface ConversationRuntimeEventStore {
  append(event: ConversationRuntimeEvent): Promise<void>;
  list(conversationId: string): Promise<ConversationRuntimeEvent[]>;
  findByCommandId(conversationId: string, commandId: string): Promise<ConversationRuntimeEvent | null>;
}

export interface RuntimeOverrideStore {
  list(conversationId: string): Promise<RuntimeOverride[]>;
  save(override: RuntimeOverride): Promise<void>;
  delete(conversationId: string, field: RuntimeOverride['field']): Promise<void>;
  clearConversation(conversationId: string): Promise<void>;
}

export class InMemoryConversationRuntimeStore implements ConversationRuntimeStore {
  private readonly runtimes = new Map<string, ConversationRuntime>();

  async get(conversationId: string): Promise<ConversationRuntime | null> {
    return structuredClone(this.runtimes.get(conversationId) ?? null);
  }

  async save(runtime: ConversationRuntime): Promise<void> {
    this.runtimes.set(runtime.conversationId, structuredClone(runtime));
  }

  async list(conversationIds?: string[]): Promise<ConversationRuntime[]> {
    const allowed = conversationIds ? new Set(conversationIds) : null;
    return [...this.runtimes.values()]
      .filter((runtime) => !allowed || allowed.has(runtime.conversationId))
      .map((runtime) => structuredClone(runtime));
  }
}

export class InMemoryConversationRuntimeEventStore implements ConversationRuntimeEventStore {
  private readonly events = new Map<string, ConversationRuntimeEvent[]>();

  async append(event: ConversationRuntimeEvent): Promise<void> {
    const events = this.events.get(event.conversationId) ?? [];
    events.push(structuredClone(event));
    this.events.set(event.conversationId, events);
  }

  async list(conversationId: string): Promise<ConversationRuntimeEvent[]> {
    return structuredClone(this.events.get(conversationId) ?? []);
  }

  async findByCommandId(conversationId: string, commandId: string): Promise<ConversationRuntimeEvent | null> {
    const event = (this.events.get(conversationId) ?? []).find((candidate) =>
      candidate.payload.commandId === commandId,
    );
    return structuredClone(event ?? null);
  }
}

export class InMemoryRuntimeOverrideStore implements RuntimeOverrideStore {
  private readonly overrides = new Map<string, RuntimeOverride[]>();

  async list(conversationId: string): Promise<RuntimeOverride[]> {
    return structuredClone(this.overrides.get(conversationId) ?? []);
  }

  async save(override: RuntimeOverride): Promise<void> {
    const current = (this.overrides.get(override.conversationId) ?? [])
      .filter((candidate) => candidate.field !== override.field);
    current.push(structuredClone(override));
    this.overrides.set(override.conversationId, current);
  }

  async delete(conversationId: string, field: RuntimeOverride['field']): Promise<void> {
    const current = (this.overrides.get(conversationId) ?? [])
      .filter((candidate) => candidate.field !== field);
    this.overrides.set(conversationId, current);
  }

  async clearConversation(conversationId: string): Promise<void> {
    this.overrides.delete(conversationId);
  }
}

export function deriveRuntimeState(conversation: Conversation): InteractionState {
  if (conversation.state === 'awaiting_sms_consent') return 'listening';
  if (conversation.state === 'text_active' || conversation.events.some((event) =>
    event.type === 'conversation.channel_transitioned')) return 'text_active';
  if (conversation.status === 'completed') return 'stopped';
  if (conversation.status === 'received') return 'starting';
  return 'listening';
}

export function createDefaultRuntime(
  conversation: Conversation,
  configuration: OwnerConfiguration,
): ConversationRuntime {
  const now = new Date();
  const state = deriveRuntimeState(conversation);
  return {
    conversationId: conversation.id,
    state,
    assistantEnabled: configuration.calls.answerCalls,
    voiceEnabled: state !== 'text_active',
    transcriptionEnabled: true,
    aiMode: 'automatic',
    responseStyle: configuration.assistant.tone === 'professional' ? 'professional'
      : configuration.assistant.tone === 'warm' ? 'friendly' : 'concise',
    verbosity: configuration.assistant.responseStyle === 'detailed' ? 'detailed' : 'short',
    askOwnerWhen: configuration.messages.interruptOnlyWhenNeeded ? 'important' : 'always',
    allowCommitments: true,
    allowScheduling: true,
    allowCallerFollowups: true,
    smsTransitionEnabled: configuration.calls.offerSmsTransition,
    startedAt: conversation.startedAt,
    stoppedAt: state === 'stopped' ? conversation.endedAt ?? now : undefined,
    currentActivity: state === 'text_active' ? 'Text conversation active' : 'Awaiting caller input',
    configurationRevision: 1,
    appliedRevision: 1,
    updatedAt: now,
  };
}

export function createRuntimeEvent(
  conversationId: string,
  type: ConversationRuntimeEventType,
  payload: Record<string, unknown>,
  durable = false,
): ConversationRuntimeEvent {
  return {
    id: randomUUID(),
    conversationId,
    type,
    payload,
    occurredAt: new Date(),
    durable,
  };
}
