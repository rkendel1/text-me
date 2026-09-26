import type {
  MacMessagesAdapter,
  ObservedMessagesMessage,
} from './mac-messages-adapter.js';

export class FakeMacMessagesAdapter implements MacMessagesAdapter {
  readonly sent: Array<{ recipient: string; body: string }> = [];
  private handler?: (message: ObservedMessagesMessage) => Promise<void>;
  private sequence = 0;

  async send(input: { recipient: string; body: string }): Promise<{ providerRequestId: string }> {
    this.sent.push(input);
    return { providerRequestId: `request-${this.sent.length}` };
  }

  async watch(
    handler: (message: ObservedMessagesMessage) => Promise<void>,
  ): Promise<() => Promise<void>> {
    this.handler = handler;
    return async () => {
      this.handler = undefined;
    };
  }

  async observe(message: Omit<ObservedMessagesMessage, 'externalId' | 'observedAt' | 'cursor'> & {
    externalId?: string;
    cursor?: string;
  }): Promise<void> {
    this.sequence += 1;
    await this.handler?.({
      ...message,
      externalId: message.externalId ?? `message-${this.sequence}`,
      observedAt: new Date(),
      cursor: message.cursor ?? String(this.sequence),
    });
  }
}
