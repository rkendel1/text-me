import type { Conversation } from './conversation.js';

export interface OwnerRequest {
  requestId: string;
  question: string;
  suggestedReplies: string[];
  askedAt: Date;
}

/** The assistant's latest request for the owner, if the owner hasn't answered it yet. */
export function openOwnerRequest(conversation: Conversation): OwnerRequest | null {
  const request = [...conversation.events].reverse().find((event) => event.type === 'owner.attention.requested');
  if (!request) return null;
  const answered = conversation.events.some((event) => event.type === 'owner.message' &&
    event.occurredAt.getTime() >= request.occurredAt.getTime());
  if (answered) return null;
  return {
    requestId: String(request.payload.requestId ?? request.id),
    question: String(request.payload.question ?? ''),
    suggestedReplies: Array.isArray(request.payload.suggestedReplies) ? request.payload.suggestedReplies.map(String) : [],
    askedAt: request.occurredAt,
  };
}
