import { randomUUID } from 'node:crypto';

export function createConversationId(): string {
  return `conv_${randomUUID().replaceAll('-', '')}`;
}

export function createEventId(): string {
  return `evt_${randomUUID().replaceAll('-', '')}`;
}
