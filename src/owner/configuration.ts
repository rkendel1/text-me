export type AssistantTone = 'friendly' | 'professional' | 'warm';
export type AssistantResponseStyle = 'concise' | 'normal' | 'detailed';
/** How calls are normally handled; each conversation can override it live. */
export type AssistantBehavior = 'automatic' | 'ask_when_unsure' | 'ask_before_commitments';

export interface OwnerAssistantSettings {
  /** Who the assistant works for, as callers should hear it ("Randy"). */
  ownerName: string;
  assistantName: string;
  behavior: AssistantBehavior;
  greeting: string;
  ownerIntroduction: string;
  tone: AssistantTone;
  responseStyle: AssistantResponseStyle;
}

export interface OwnerCallSettings {
  answerCalls: boolean;
  collectCallerName: boolean;
  collectReason: boolean;
  offerSmsTransition: boolean;
  requireSmsConsent: boolean;
  voicemailFallback: boolean;
  /** Default for new calls: the assistant speaks its replies. */
  voiceEnabled: boolean;
  /** Default for new calls: the owner sees a live transcript. */
  transcriptionEnabled: boolean;
}

export interface OwnerMessageSettings {
  webEnabled: boolean;
  macosMessagesEnabled: boolean;
  notifyOwner: boolean;
  interruptOnlyWhenNeeded: boolean;
  includeSummary: boolean;
  includeSuggestedResponse: boolean;
}

export interface OwnerConfiguration {
  ownerId: string;
  revision: number;
  assistant: OwnerAssistantSettings;
  calls: OwnerCallSettings;
  messages: OwnerMessageSettings;
  onboarding: { completed: boolean };
}

export interface OwnerConfigurationAuditEvent {
  type: string;
  ownerId: string;
  revision: number;
  source: string;
  occurredAt: Date;
}

export type OwnerConfigurationPatch = {
  assistant?: Partial<OwnerAssistantSettings>;
  calls?: Partial<OwnerCallSettings>;
  messages?: Partial<OwnerMessageSettings>;
  onboarding?: Partial<OwnerConfiguration['onboarding']>;
};

export interface OwnerConfigurationStore {
  get(ownerId: string): Promise<OwnerConfiguration | null>;
  create(configuration: OwnerConfiguration, event: OwnerConfigurationAuditEvent): Promise<void>;
  update(configuration: OwnerConfiguration, previousRevision: number, event: OwnerConfigurationAuditEvent): Promise<void>;
  events(ownerId: string): Promise<OwnerConfigurationAuditEvent[]>;
}

export class InMemoryOwnerConfigurationStore implements OwnerConfigurationStore {
  private readonly configurations = new Map<string, OwnerConfiguration>();
  private readonly audit = new Map<string, OwnerConfigurationAuditEvent[]>();

  async get(ownerId: string): Promise<OwnerConfiguration | null> {
    return structuredClone(this.configurations.get(ownerId) ?? null);
  }

  async create(configuration: OwnerConfiguration, event: OwnerConfigurationAuditEvent): Promise<void> {
    if (!this.configurations.has(configuration.ownerId)) {
      this.configurations.set(configuration.ownerId, structuredClone(configuration));
      this.record(event);
    }
  }

  async update(configuration: OwnerConfiguration, previousRevision: number, event: OwnerConfigurationAuditEvent): Promise<void> {
    if (this.configurations.get(configuration.ownerId)?.revision !== previousRevision) {
      throw new ConfigurationConflictError();
    }
    this.configurations.set(configuration.ownerId, structuredClone(configuration));
    this.record(event);
  }

  async events(ownerId: string): Promise<OwnerConfigurationAuditEvent[]> {
    return structuredClone(this.audit.get(ownerId) ?? []);
  }

  private record(event: OwnerConfigurationAuditEvent): void {
    const events = this.audit.get(event.ownerId) ?? [];
    events.push(structuredClone(event));
    this.audit.set(event.ownerId, events);
  }
}

function defaultConfiguration(ownerId: string): OwnerConfiguration {
  return {
    ownerId,
    revision: 1,
    assistant: {
      ownerName: 'Randy',
      assistantName: 'Assistant',
      behavior: 'automatic',
      greeting: "Hi, this is Randy's assistant. How can I help?",
      ownerIntroduction: "Randy prefers text. I'll make sure he gets your message.",
      tone: 'friendly',
      responseStyle: 'concise',
    },
    calls: {
      answerCalls: true,
      collectCallerName: true,
      collectReason: true,
      offerSmsTransition: true,
      requireSmsConsent: true,
      voicemailFallback: false,
      voiceEnabled: true,
      transcriptionEnabled: true,
    },
    messages: {
      webEnabled: true,
      macosMessagesEnabled: true,
      notifyOwner: true,
      interruptOnlyWhenNeeded: true,
      includeSummary: true,
      includeSuggestedResponse: true,
    },
    onboarding: { completed: false },
  };
}

/** Fill in fields added after a configuration was first stored. */
function withDefaults(stored: OwnerConfiguration): OwnerConfiguration {
  const defaults = defaultConfiguration(stored.ownerId);
  return {
    ...defaults,
    ...stored,
    assistant: { ...defaults.assistant, ...stored.assistant },
    calls: { ...defaults.calls, ...stored.calls },
    messages: { ...defaults.messages, ...stored.messages },
    onboarding: { ...defaults.onboarding, ...stored.onboarding },
  };
}

const allowed: Record<string, readonly string[]> = {
  behavior: ['automatic', 'ask_when_unsure', 'ask_before_commitments'],
  tone: ['friendly', 'professional', 'warm'],
  responseStyle: ['concise', 'normal', 'detailed'],
};

function validatePatch(patch: OwnerConfigurationPatch): void {
  for (const [key, values] of Object.entries(allowed)) {
    const value = (patch.assistant as Record<string, unknown> | undefined)?.[key];
    if (value !== undefined && !values.includes(value as string)) throw new Error(`Invalid value for ${key}`);
  }
  for (const key of ['ownerName', 'assistantName', 'greeting', 'ownerIntroduction'] as const) {
    const value = patch.assistant?.[key];
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 300)) {
      throw new Error(`Invalid value for ${key}`);
    }
  }
}

export class ConfigurationConflictError extends Error {
  constructor() {
    super('Settings changed somewhere else. Refresh and try again.');
  }
}

function channelEventType(patch: OwnerConfigurationPatch): string | undefined {
  const toggles = [patch.messages?.macosMessagesEnabled, patch.messages?.webEnabled].filter((value) => value !== undefined);
  if (!toggles.length) return undefined;
  return toggles[0] ? 'owner.channel.enabled' : 'owner.channel.disabled';
}

export class OwnerConfigurationService {
  constructor(private readonly store: OwnerConfigurationStore = new InMemoryOwnerConfigurationStore()) {}

  async get(ownerId: string): Promise<OwnerConfiguration> {
    const existing = await this.store.get(ownerId);
    if (existing) return withDefaults(structuredClone(existing));
    const configuration = defaultConfiguration(ownerId);
    await this.store.create(configuration, {
      type: 'configuration.created',
      ownerId,
      revision: configuration.revision,
      source: 'system',
      occurredAt: new Date(),
    });
    return structuredClone(configuration);
  }

  async update(ownerId: string, patch: OwnerConfigurationPatch, source = 'web', expectedRevision?: number): Promise<OwnerConfiguration> {
    validatePatch(patch);
    const current = await this.get(ownerId);
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new ConfigurationConflictError();
    }
    const next: OwnerConfiguration = {
      ...current,
      revision: current.revision + 1,
      assistant: { ...current.assistant, ...patch.assistant },
      calls: { ...current.calls, ...patch.calls },
      messages: { ...current.messages, ...patch.messages },
      onboarding: { ...current.onboarding, ...patch.onboarding },
    };
    await this.store.update(next, current.revision, {
      type: channelEventType(patch) ?? (patch.assistant ? 'assistant.settings.updated'
        : patch.calls ? 'call.settings.updated'
          : patch.messages ? 'message.settings.updated' : 'onboarding.updated'),
      ownerId,
      revision: next.revision,
      source,
      occurredAt: new Date(),
    });
    return structuredClone(next);
  }

  async events(ownerId: string): Promise<OwnerConfigurationAuditEvent[]> {
    return this.store.events(ownerId);
  }

  /**
   * Record a control-plane change that lives outside the typed settings
   * (device connected/revoked, assistant chat chosen) and bump the revision,
   * so bridges following the revision pick it up.
   */
  async recordChange(ownerId: string, type: string, source = 'web'): Promise<OwnerConfiguration> {
    const current = await this.get(ownerId);
    const next = { ...current, revision: current.revision + 1 };
    await this.store.update(next, current.revision, { type, ownerId, revision: next.revision, source, occurredAt: new Date() });
    return structuredClone(next);
  }

  async isChannelEnabled(ownerId: string, channel: 'web' | 'macos_messages'): Promise<boolean> {
    const configuration = await this.get(ownerId);
    return channel === 'web' ? configuration.messages.webEnabled : configuration.messages.macosMessagesEnabled;
  }
}
