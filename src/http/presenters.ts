import type { Conversation } from '../domain/conversation.js';

export function presentConversation(conversation: Conversation): Record<string, unknown> {
  return {
    id: conversation.id,
    provider: conversation.provider,
    providerCallId: conversation.providerCallId,
    caller: conversation.callerPhone,
    status: conversation.status,
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
    startedAt: conversation.startedAt.toISOString(),
    endedAt: conversation.endedAt?.toISOString() ?? null,
    durationSeconds: conversation.durationSeconds,
  };
}
