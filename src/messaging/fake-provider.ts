import type { MessagingInput, MessagingProvider, MessagingResult } from './provider.js';

export interface SentMessage extends MessagingInput {
  providerMessageId: string;
}

export class FakeMessagingProvider implements MessagingProvider {
  readonly name = 'fake';
  readonly sentMessages: SentMessage[] = [];
  failNext = false;

  async sendMessage(input: MessagingInput): Promise<MessagingResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('messaging provider unavailable');
    }
    const existing = this.sentMessages.find(
      (message) => message.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return { providerMessageId: existing.providerMessageId };
    const result = { providerMessageId: `SM${this.sentMessages.length + 1}` };
    this.sentMessages.push({ ...input, ...result });
    return result;
  }
}
