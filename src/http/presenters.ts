import type { Conversation } from '../domain/conversation.js';
import { openOwnerRequest } from '../domain/owner-requests.js';

function presentOwnerRequest(conversation: Conversation) {
  const request = openOwnerRequest(conversation);
  return request ? { ...request, askedAt: request.askedAt.toISOString() } : null;
}

function lastText(conversation: Conversation, types: string[]): string | null {
  const event = [...conversation.events].reverse().find((candidate) => types.includes(candidate.type));
  return event ? String(event.payload.text ?? event.payload.body ?? '') : null;
}

/** Best known caller name: explicit participant, then what they told the assistant, then SMS consent. */
export function callerName(conversation: Conversation): string | undefined {
  const participant = conversation.participants?.find((candidate) => candidate.role === 'caller')?.displayName;
  if (participant) return participant;
  const named = [...conversation.events].reverse().find((event) =>
    (event.type === 'caller.identified' && typeof event.payload.name === 'string') ||
    (event.type === 'sms.consent.granted' && typeof event.payload.displayName === 'string'));
  return named ? String(named.payload.name ?? named.payload.displayName) : undefined;
}

/** The owner is needed when the assistant asked for them and they haven't replied since. */
export function needsOwner(conversation: Conversation): boolean {
  const lastTime = (type: string) => [...conversation.events].reverse()
    .find((event) => event.type === type)?.occurredAt.getTime();
  if (openOwnerRequest(conversation)) return true;
  return conversation.events.some((event) => event.type === 'assistant.message') && lastTime('owner.message') === undefined;
}

export function presentConversation(conversation: Conversation): Record<string, unknown> {
  const lastRead = conversation.lastOwnerReadAt?.getTime() ??
    [...conversation.events].reverse().find((event) => event.type === 'owner.read')?.occurredAt.getTime() ?? 0;
  const messages = conversation.events
    .filter((event) => ['caller.message', 'owner.message', 'assistant.message', 'speech.transcript', 'ai.response']
      .includes(event.type))
    .map((event) => ({
      id: event.id,
      role: event.type === 'caller.message' || event.type === 'speech.transcript'
        ? 'caller'
        : event.type === 'owner.message' ? 'owner' : 'assistant',
      body: String(event.payload.text ?? event.payload.body ?? ''),
      channel: event.type === 'speech.transcript' || event.type === 'ai.response'
        ? 'voice'
        : String(event.payload.channel ?? 'sms'),
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
    accountId: conversation.accountId,
    callerName: callerName(conversation) ?? null,
    ownerRequest: presentOwnerRequest(conversation),
    summary: summary ? String(summary) : undefined,
    needsOwner: needsOwner(conversation),
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
      name: callerName(conversation),
      reason: [...conversation.events].reverse().find((event) => event.type === 'caller.identified' &&
        typeof event.payload.reason === 'string')?.payload.reason,
      phoneNumber: conversation.callerPhone,
    },
    preview: [...conversation.events].reverse()
      .find((event) => ['caller.message', 'owner.message', 'assistant.message', 'speech.transcript', 'ai.response', 'conversation.summary.created'].includes(event.type))
      ?.payload.text ??
      [...conversation.events].find((event) => event.type === 'conversation.summary.created')?.payload.summary ??
      '',
    needsOwner: needsOwner(conversation),
    ownerRequest: presentOwnerRequest(conversation),
    lastCallerMessage: lastText(conversation, ['caller.message', 'speech.transcript']),
    lastAssistantMessage: lastText(conversation, ['assistant.message', 'ai.response']),
    unread: conversation.events.some((event) => event.occurredAt.getTime() >
      (conversation.lastOwnerReadAt?.getTime() ?? 0) && event.type !== 'owner.read'),
    updatedAt: [...conversation.events].reduce(
      (latest, event) => Math.max(latest, event.occurredAt.getTime()),
      conversation.startedAt.getTime(),
    ) ? new Date(Math.max(conversation.startedAt.getTime(), ...conversation.events.map((event) => event.occurredAt.getTime()))).toISOString() : conversation.startedAt.toISOString(),
  };
}
