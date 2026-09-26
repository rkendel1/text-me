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

export class OwnerConfigurationService {
  private readonly configurations = new Map<string, OwnerConfiguration>();
  private readonly audit = new Map<string, OwnerConfigurationAuditEvent[]>();

  get(ownerId: string): OwnerConfiguration {
    const existing = this.configurations.get(ownerId);
    if (existing) return structuredClone(existing);
    const configuration: OwnerConfiguration = {
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
        answerCalls: true, collectCallerName: true, collectReason: true,
        offerSmsTransition: true, requireSmsConsent: true, voicemailFallback: false,
      },
      messages: {
        webEnabled: true, macosMessagesEnabled: true, notifyOwner: true,
        interruptOnlyWhenNeeded: true, includeSummary: true, includeSuggestedResponse: true,
      },
    };
    this.configurations.set(ownerId, configuration);
    return structuredClone(configuration);
  }

  update(ownerId: string, patch: OwnerConfigurationPatch, source = 'web'): OwnerConfiguration {
    const current = this.get(ownerId);
    const next: OwnerConfiguration = {
      ...current,
      revision: current.revision + 1,
      assistant: { ...current.assistant, ...patch.assistant },
      calls: { ...current.calls, ...patch.calls },
      messages: { ...current.messages, ...patch.messages },
    };
    this.configurations.set(ownerId, next);
    const changed = patch.messages?.macosMessagesEnabled;
    this.record({
      type: changed === true ? 'owner.channel.enabled'
        : changed === false ? 'owner.channel.disabled'
        : patch.assistant ? 'assistant.settings.updated'
          : patch.calls ? 'call.settings.updated' : 'message.settings.updated',
      ownerId, revision: next.revision, source, occurredAt: new Date(),
    });
    return structuredClone(next);
  }

  events(ownerId: string): OwnerConfigurationAuditEvent[] {
    return structuredClone(this.audit.get(ownerId) ?? []);
  }

  isChannelEnabled(ownerId: string, channel: 'web' | 'macos_messages'): boolean {
    const configuration = this.get(ownerId);
    return channel === 'web' ? configuration.messages.webEnabled : configuration.messages.macosMessagesEnabled;
  }

  private record(event: OwnerConfigurationAuditEvent): void {
    const events = this.audit.get(event.ownerId) ?? [];
    events.push(event);
    this.audit.set(event.ownerId, events);
  }
}
