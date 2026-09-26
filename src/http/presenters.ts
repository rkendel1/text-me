import type { Conversation } from '../domain/conversation.js';

export function presentConversation(conversation: Conversation): Record<string, unknown> {
  return {
    id: conversation.id,
    provider: conversation.provider,
    providerCallId: conversation.providerCallId,
    caller: conversation.callerPhone,
    status: conversation.status,
    state: conversation.state ?? (conversation.status === 'completed' ? 'completed' : 'voice_active'),
    channels: conversation.channels ?? (conversation.events.some((event) => event.type === 'conversation.channel_transitioned') ? ['voice', 'sms'] : ['voice']),
    primaryChannel: conversation.primaryChannel ?? (conversation.events.some((event) => event.type === 'conversation.channel_transitioned') ? 'sms' : 'voice'),
    participants: conversation.participants ?? [
      { role: 'caller', phoneNumber: conversation.callerPhone },
      { role: 'assistant' },
      { role: 'owner' },
    ],
    startedAt: conversation.startedAt.toISOString(),
    endedAt: conversation.endedAt?.toISOString() ?? null,
    durationSeconds: conversation.durationSeconds,
    events: conversation.events.map((event) => event.type),
    eventLog: conversation.events.map((event) => ({
      type: event.type,
      payload: event.payload,
      occurredAt: event.occurredAt.toISOString(),
    })),
  };
}

export function presentConversationSummary(
  conversation: Conversation,
): Record<string, unknown> {
  return {
    id: conversation.id,
    provider: conversation.provider,
    providerCallId: conversation.providerCallId,
    caller: conversation.callerPhone,
    status: conversation.status,
    state: conversation.state ?? 'voice_active',
    channels: conversation.channels ?? ['voice'],
    primaryChannel: conversation.primaryChannel ?? 'voice',
    startedAt: conversation.startedAt.toISOString(),
    endedAt: conversation.endedAt?.toISOString() ?? null,
    durationSeconds: conversation.durationSeconds,
  };
}
