export type AssistantTone = 'friendly' | 'professional' | 'warm';
export type AssistantResponseStyle = 'concise' | 'detailed';

export interface OwnerAssistantSettings {
  assistantName: string;
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

  async update(configuration: OwnerConfiguration, _previousRevision: number, event: OwnerConfigurationAuditEvent): Promise<void> {
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
      assistantName: 'Assistant',
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
    },
    messages: {
      webEnabled: true,
      macosMessagesEnabled: true,
      notifyOwner: true,
      interruptOnlyWhenNeeded: true,
      includeSummary: true,
      includeSuggestedResponse: true,
    },
  };
}

export class OwnerConfigurationService {
  constructor(private readonly store: OwnerConfigurationStore = new InMemoryOwnerConfigurationStore()) {}

  async get(ownerId: string): Promise<OwnerConfiguration> {
    const existing = await this.store.get(ownerId);
    if (existing) return structuredClone(existing);
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

  async update(ownerId: string, patch: OwnerConfigurationPatch, source = 'web'): Promise<OwnerConfiguration> {
    const current = await this.get(ownerId);
    const next: OwnerConfiguration = {
      ...current,
      revision: current.revision + 1,
      assistant: { ...current.assistant, ...patch.assistant },
      calls: { ...current.calls, ...patch.calls },
      messages: { ...current.messages, ...patch.messages },
    };
    await this.store.update(next, current.revision, {
      type: patch.messages?.macosMessagesEnabled === true ? 'owner.channel.enabled'
        : patch.messages?.macosMessagesEnabled === false ? 'owner.channel.disabled'
        : patch.assistant ? 'assistant.settings.updated'
          : patch.calls ? 'call.settings.updated' : 'message.settings.updated',
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

  async isChannelEnabled(ownerId: string, channel: 'web' | 'macos_messages'): Promise<boolean> {
    const configuration = await this.get(ownerId);
    return channel === 'web' ? configuration.messages.webEnabled : configuration.messages.macosMessagesEnabled;
  }
}
