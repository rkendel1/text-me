export type AssistantTone = 'friendly' | 'professional' | 'warm';
export type AssistantResponseStyle = 'concise' | 'normal' | 'detailed';
/** How calls are normally handled; each conversation can override it live. */
export type AssistantBehavior = 'automatic' | 'ask_when_unsure' | 'ask_before_commitments';
export type PhoneSetupChoice = 'existing' | 'new' | 'later';

export interface OwnerAssistantSettings {
  /** Who the assistant works for, as callers should hear it. Set by the account during onboarding. */
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
  /** Text the account's verified personal number when no other surface reaches the owner. */
  smsEnabled: boolean;
}

export interface OwnerConfiguration {
  accountId: string;
  revision: number;
  assistant: OwnerAssistantSettings;
  calls: OwnerCallSettings;
  messages: OwnerMessageSettings;
  onboarding: { completed: boolean; phoneChoice?: PhoneSetupChoice };
}

export interface OwnerConfigurationAuditEvent {
  type: string;
  accountId: string;
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
  get(accountId: string): Promise<OwnerConfiguration | null>;
  create(configuration: OwnerConfiguration, event: OwnerConfigurationAuditEvent): Promise<void>;
  update(configuration: OwnerConfiguration, previousRevision: number, event: OwnerConfigurationAuditEvent): Promise<void>;
  events(accountId: string): Promise<OwnerConfigurationAuditEvent[]>;
}

export class InMemoryOwnerConfigurationStore implements OwnerConfigurationStore {
  private readonly configurations = new Map<string, OwnerConfiguration>();
  private readonly audit = new Map<string, OwnerConfigurationAuditEvent[]>();

  async get(accountId: string): Promise<OwnerConfiguration | null> {
    return structuredClone(this.configurations.get(accountId) ?? null);
  }

  async create(configuration: OwnerConfiguration, event: OwnerConfigurationAuditEvent): Promise<void> {
    if (!this.configurations.has(configuration.accountId)) {
      this.configurations.set(configuration.accountId, structuredClone(configuration));
      this.record(event);
    }
  }

  async update(configuration: OwnerConfiguration, previousRevision: number, event: OwnerConfigurationAuditEvent): Promise<void> {
    if (this.configurations.get(configuration.accountId)?.revision !== previousRevision) {
      throw new ConfigurationConflictError();
    }
    this.configurations.set(configuration.accountId, structuredClone(configuration));
    this.record(event);
  }

  async events(accountId: string): Promise<OwnerConfigurationAuditEvent[]> {
    return structuredClone(this.audit.get(accountId) ?? []);
  }

  private record(event: OwnerConfigurationAuditEvent): void {
    const events = this.audit.get(event.accountId) ?? [];
    events.push(structuredClone(event));
    this.audit.set(event.accountId, events);
  }
}

/**
 * No customer identity is baked in: a new account starts with no name, and the
 * greeting and introduction follow whatever name the account gives until the
 * owner writes their own (an empty stored value means "use the default").
 */
function defaultConfiguration(accountId: string): OwnerConfiguration {
  return {
    accountId,
    revision: 1,
    assistant: {
      ownerName: '',
      assistantName: 'Assistant',
      behavior: 'automatic',
      greeting: '',
      ownerIntroduction: '',
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
      smsEnabled: false,
    },
    onboarding: { completed: false },
  };
}

export function defaultGreeting(ownerName: string): string {
  const name = ownerName.trim();
  return name ? `Hi, this is ${name}'s assistant. How can I help?` : 'Hi, this is an assistant. How can I help?';
}

export function defaultIntroduction(ownerName: string): string {
  const name = ownerName.trim() || 'They';
  return `${name} prefers text. I'll make sure they get your message.`;
}

/** What the assistant actually uses: stored values, with empty greeting/introduction following the owner's name. */
function effective(configuration: OwnerConfiguration): OwnerConfiguration {
  const assistant = configuration.assistant;
  return {
    ...configuration,
    assistant: {
      ...assistant,
      greeting: assistant.greeting.trim() || defaultGreeting(assistant.ownerName),
      ownerIntroduction: assistant.ownerIntroduction.trim() || defaultIntroduction(assistant.ownerName),
    },
  };
}

/** Fill in fields added after a configuration was first stored. */
function withDefaults(stored: OwnerConfiguration): OwnerConfiguration {
  const defaults = defaultConfiguration(stored.accountId);
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
  if (patch.onboarding?.phoneChoice !== undefined && !['existing', 'new', 'later'].includes(patch.onboarding.phoneChoice)) {
    throw new Error('Invalid phone setup choice');
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

  async get(accountId: string): Promise<OwnerConfiguration> {
    return effective(await this.stored(accountId));
  }

  /** As stored (empty greeting = follow the name); updates merge into this, not into the effective view. */
  private async stored(accountId: string): Promise<OwnerConfiguration> {
    if (!accountId) throw new Error('An account is required');
    const existing = await this.store.get(accountId);
    if (existing) return withDefaults(structuredClone(existing));
    const configuration = defaultConfiguration(accountId);
    await this.store.create(configuration, {
      type: 'configuration.created',
      accountId,
      revision: configuration.revision,
      source: 'system',
      occurredAt: new Date(),
    });
    return structuredClone(configuration);
  }

  async update(accountId: string, patch: OwnerConfigurationPatch, source = 'web', expectedRevision?: number): Promise<OwnerConfiguration> {
    validatePatch(patch);
    const current = await this.stored(accountId);
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
      accountId,
      revision: next.revision,
      source,
      occurredAt: new Date(),
    });
    return effective(structuredClone(next));
  }

  async events(accountId: string): Promise<OwnerConfigurationAuditEvent[]> {
    return this.store.events(accountId);
  }

  /**
   * Record a control-plane change that lives outside the typed settings
   * (device connected/revoked, assistant chat chosen) and bump the revision,
   * so bridges following the revision pick it up.
   */
  async recordChange(accountId: string, type: string, source = 'web'): Promise<OwnerConfiguration> {
    const current = await this.stored(accountId);
    const next = { ...current, revision: current.revision + 1 };
    await this.store.update(next, current.revision, { type, accountId, revision: next.revision, source, occurredAt: new Date() });
    return effective(structuredClone(next));
  }

  async isChannelEnabled(accountId: string, channel: 'web' | 'macos_messages'): Promise<boolean> {
    const configuration = await this.get(accountId);
    return channel === 'web' ? configuration.messages.webEnabled : configuration.messages.macosMessagesEnabled;
  }
}
