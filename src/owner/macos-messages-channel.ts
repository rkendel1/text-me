import type { OwnerChannel } from './channel.js';
import type { MacMessagesAdapter } from './mac-messages-adapter.js';

export class MacOSMessagesOwnerChannel implements OwnerChannel {
  readonly type = 'macos_messages' as const;

  constructor(
    private readonly adapter: MacMessagesAdapter,
    private readonly recipient: string | ((ownerId: string) => string),
  ) {}

  async sendMessage(input: Parameters<OwnerChannel['sendMessage']>[0]): Promise<{ deliveryId: string }> {
    if (!input.ownerId || !input.conversationId || !input.messageId || !input.body.trim()) {
      throw new Error('Owner message delivery is incomplete');
    }

    const deliveryId = `owner-delivery:${input.messageId}`;
    await this.adapter.send({
      recipient: typeof this.recipient === 'function'
        ? this.recipient(input.ownerId)
        : this.recipient,
      body: input.body,
    });
    return { deliveryId };
  }
}
