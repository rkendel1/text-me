export type ObservedMessagesDirection = 'incoming' | 'outgoing';

export interface ObservedMessagesMessage {
  externalId: string;
  chatId: string;
  sender: string;
  body: string;
  direction: ObservedMessagesDirection;
  observedAt: Date;
  cursor?: string;
  replyToExternalId?: string;
}

export type MessagesService = 'imessage' | 'sms';

export interface MessagesChat {
  id: string;
  service: MessagesService;
  displayName?: string;
  address?: string;
  isGroup?: boolean;
}

export interface MessagesCapabilities {
  messagesAccess: boolean;
  sendCapability: boolean;
  authorizedIdentity?: {
    service: MessagesService;
    address: string;
    displayName?: string;
  };
  watcher: boolean;
  error?: string;
}

export interface MacMessagesAdapter {
  send(input: { recipient: string; body: string }): Promise<{ providerRequestId?: string }>;
  watch(
    handler: (message: ObservedMessagesMessage) => Promise<void>,
  ): Promise<() => Promise<void>>;
  discoverChats?(): Promise<MessagesChat[]>;
  checkCapabilities?(): Promise<MessagesCapabilities>;
}
