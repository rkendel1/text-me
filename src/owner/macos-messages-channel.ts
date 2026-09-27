import type { OwnerChannel, OwnerChannelSettings } from './channel.js';
import type { MacMessagesAdapter } from './mac-messages-adapter.js';
import type { OwnerDeviceService } from './device.js';

export class MacOSMessagesOwnerChannel implements OwnerChannel {
  readonly type = 'macos_messages' as const;

  constructor(
    private readonly adapter: MacMessagesAdapter,
    private readonly recipient: string | ((accountId: string) => string) | OwnerDeviceService,
    private readonly settings?: OwnerChannelSettings,
  ) {}

  async sendMessage(input: Parameters<OwnerChannel['sendMessage']>[0]): Promise<{ deliveryId: string }> {
    if (!input.accountId || !input.conversationId || !input.messageId || !input.body.trim()) {
      throw new Error('Owner message delivery is incomplete');
    }
    if (this.settings && !(await this.settings.isChannelEnabled(input.accountId, this.type))) {
      throw new Error('Apple Messages owner channel is disabled');
    }

    const deliveryId = `owner-delivery:${input.messageId}`;
    const recipient = typeof this.recipient === 'string'
      ? this.recipient
      : typeof this.recipient === 'function'
        ? this.recipient(input.accountId)
        : (await this.recipient.primary(input.accountId))?.messagesIdentity?.address;
    if (!recipient) throw new Error('A ready primary Mac Messages device is required');
    await this.adapter.send({
      recipient,
      body: input.body,
    });
    return { deliveryId };
  }
}
