export type ObservedMessagesDirection = 'incoming' | 'outgoing';

export interface ObservedMessagesMessage {
  externalId: string;
  chatId: string;
  sender: string;
  body: string;
  direction: ObservedMessagesDirection;
  observedAt: Date;
  cursor?: string;
}

export interface MacMessagesAdapter {
  send(input: { recipient: string; body: string }): Promise<{ providerRequestId?: string }>;
  watch(
    handler: (message: ObservedMessagesMessage) => Promise<void>,
  ): Promise<() => Promise<void>>;
}
