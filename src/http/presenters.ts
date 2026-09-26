import type { Conversation } from '../domain/conversation.js';

export function presentConversation(conversation: Conversation): Record<string, unknown> {
  const lastRead = conversation.lastOwnerReadAt?.getTime() ??
    [...conversation.events].reverse().find((event) => event.type === 'owner.read')?.occurredAt.getTime() ?? 0;
  const messages = conversation.events
    .filter((event) => ['caller.message', 'owner.message', 'assistant.message'].includes(event.type))
    .map((event) => ({
      id: event.id,
      role: event.type === 'caller.message' ? 'caller' : event.type === 'owner.message' ? 'owner' : 'assistant',
      body: String(event.payload.text ?? event.payload.body ?? ''),
      source: event.payload.source,
      occurredAt: event.occurredAt.toISOString(),
      deliveryFailed: event.type === 'assistant.message' &&
        conversation.events.some((failed) => failed.type === 'assistant.failed' &&
          failed.payload.idempotencyKey === event.payload.idempotencyKey),
    }));
  const summary = [...conversation.events].reverse()
    .find((event) => event.type === 'conversation.summary.created')?.payload.summary;
  return {
    id: conversation.id,
    provider: conversation.provider,
    providerCallId: conversation.providerCallId,
    caller: conversation.callerPhone,
    status: conversation.status,
    state: conversation.state ?? (conversation.events.some((event) => event.type === 'conversation.channel_transitioned')
      ? 'text_active' : conversation.status === 'completed' ? 'completed' : 'voice_active'),
    channels: conversation.channels ?? (conversation.events.some((event) => event.type === 'conversation.channel_transitioned') ? ['voice', 'sms'] : ['voice']),
    primaryChannel: conversation.primaryChannel ?? (conversation.events.some((event) => event.type === 'conversation.channel_transitioned') ? 'sms' : 'voice'),
    participants: conversation.participants ?? [
      { role: 'caller', phoneNumber: conversation.callerPhone },
      { role: 'assistant' },
      { role: 'owner' },
    ],
    ownerId: conversation.ownerId,
    summary: summary ? String(summary) : undefined,
    needsOwner: conversation.events.some((event) => event.type === 'assistant.message') &&
      !conversation.events.some((event) => event.type === 'owner.message'),
    unread: conversation.events.some((event) => event.occurredAt.getTime() > lastRead &&
      event.type !== 'owner.read'),
    lastOwnerReadAt: conversation.lastOwnerReadAt?.toISOString() ?? null,
    messages,
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
    state: conversation.state ?? (conversation.events.some((event) => event.type === 'conversation.channel_transitioned') ? 'text_active' : 'voice_active'),
    channels: conversation.channels ?? ['voice'],
    primaryChannel: conversation.primaryChannel ?? 'voice',
    startedAt: conversation.startedAt.toISOString(),
    endedAt: conversation.endedAt?.toISOString() ?? null,
    durationSeconds: conversation.durationSeconds,
    participant: {
      name: conversation.participants?.find((participant) => participant.role === 'caller')?.displayName,
      phoneNumber: conversation.callerPhone,
    },
    preview: [...conversation.events].reverse()
      .find((event) => ['caller.message', 'owner.message', 'assistant.message', 'speech.transcript', 'conversation.summary.created'].includes(event.type))
      ?.payload.text ??
      [...conversation.events].find((event) => event.type === 'conversation.summary.created')?.payload.summary ??
      '',
    needsOwner: conversation.events.some((event) => event.type === 'assistant.message') &&
      !conversation.events.some((event) => event.type === 'owner.message'),
    unread: conversation.events.some((event) => event.occurredAt.getTime() >
      (conversation.lastOwnerReadAt?.getTime() ?? 0) && event.type !== 'owner.read'),
    updatedAt: [...conversation.events].reduce(
      (latest, event) => Math.max(latest, event.occurredAt.getTime()),
      conversation.startedAt.getTime(),
    ) ? new Date(Math.max(conversation.startedAt.getTime(), ...conversation.events.map((event) => event.occurredAt.getTime()))).toISOString() : conversation.startedAt.toISOString(),
  };
}
