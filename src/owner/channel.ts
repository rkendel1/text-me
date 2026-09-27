import type { OwnerChannelType } from '../domain/conversation.js';

export interface OwnerMessageDeliveryInput {
  accountId: string;
  conversationId: string;
  messageId: string;
  body: string;
}

export interface OwnerMessageDelivery {
  deliveryId: string;
}

export interface OwnerChannel {
  readonly type: OwnerChannelType;
  sendMessage(input: OwnerMessageDeliveryInput): Promise<OwnerMessageDelivery>;
}

export interface OwnerChannelSettings {
  isChannelEnabled(accountId: string, channel: OwnerChannelType): boolean | Promise<boolean>;
}
