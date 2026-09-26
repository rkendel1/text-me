import { randomUUID } from 'node:crypto';

import type { MessagesCapabilities, MessagesChat, MessagesService, ObservedMessagesMessage } from './mac-messages-adapter.js';
import type { PhotonIMessageKitClient } from './photon-imessage-adapter.js';

/** The slice of @photon-ai/imessage-kit's IMessageSDK the bridge uses. */
interface PhotonMessage {
  rowId: number;
  id: string;
  chatId: string | null;
  participant: string | null;
  service: 'iMessage' | 'SMS' | 'RCS' | null;
  text: string | null;
  isFromMe: boolean;
  createdAt: Date;
}

interface PhotonChat {
  chatId: string;
  name: string | null;
  service: 'iMessage' | 'SMS' | 'RCS' | null;
  kind: 'dm' | 'group' | 'unknown';
  account: string | null;
}

export interface PhotonSdk {
  send(request: { to: string; text: string }): Promise<void>;
  listChats(query?: { kind?: 'dm' | 'group'; limit?: number; sortBy?: 'recent' | 'name' }): Promise<readonly PhotonChat[]>;
  startWatching(events: {
    onIncomingMessage?: (message: PhotonMessage) => void | Promise<void>;
    onFromMeMessage?: (message: PhotonMessage) => void | Promise<void>;
    onError?: (error: Error) => void;
  }): Promise<void>;
  stopWatching(): Promise<void>;
}

const serviceOf = (service: PhotonChat['service']): MessagesService => service === 'iMessage' ? 'imessage' : 'sms';
const stripScheme = (address: string) => address.replace(/^(e|p|tel|mailto):/i, '');
const normalize = (address: string) => {
  const bare = stripScheme(address.trim().toLowerCase());
  return bare.includes('@') ? bare : bare.replace(/[^\d+]/g, '');
};
/** DM chat ids look like "iMessage;-;+15551234567". */
const dmAddress = (chatId: string) => chatId.includes(';-;') ? chatId.split(';-;')[1] : chatId;

/**
 * Binds Photon iMessage Kit to the bridge. Messages is read from chat.db
 * (Full Disk Access) and sent through Messages.app (Automation). Photon's send
 * returns nothing, so sends are correlated to the row that lands in chat.db.
 */
export class PhotonKitClient implements PhotonIMessageKitClient {
  private identity?: { address: string; service: MessagesService };
  private readonly pendingSends: Array<{ requestId: string; chat: string; text: string; at: number }> = [];
  private readonly recent = new Map<string, number>();

  constructor(private readonly sdk: PhotonSdk, private readonly platform = process.platform, private readonly now = Date.now) {}

  async sendMessage(input: { recipient: string; body: string }): Promise<{ requestId?: string }> {
    const requestId = `req_${randomUUID()}`;
    this.pendingSends.push({ requestId, chat: normalize(dmAddress(input.recipient)), text: input.body.trim(), at: this.now() });
    await this.sdk.send({ to: input.recipient, text: input.body });
    return { requestId };
  }

  async watch(handler: (message: ObservedMessagesMessage) => Promise<void>): Promise<() => Promise<void>> {
    await this.sdk.startWatching({
      onIncomingMessage: (message) => this.observe(message, handler),
      onFromMeMessage: (message) => this.observe(message, handler),
      onError: () => undefined,
    });
    return () => this.sdk.stopWatching();
  }

  async discoverChats(): Promise<MessagesChat[]> {
    const chats = await this.sdk.listChats({ kind: 'dm', limit: 200, sortBy: 'recent' });
    return chats.map((chat) => ({
      id: chat.chatId,
      service: serviceOf(chat.service),
      displayName: chat.name ?? undefined,
      address: stripScheme(dmAddress(chat.chatId)),
      isGroup: chat.kind === 'group',
    }));
  }

  async checkCapabilities(): Promise<MessagesCapabilities> {
    if (this.platform !== 'darwin') {
      return { messagesAccess: false, sendCapability: false, watcher: false, error: 'Messages is only available on macOS' };
    }
    try {
      const chats = await this.sdk.listChats({ limit: 100, sortBy: 'recent' });
      // The signed-in Messages account is the owner's own identity.
      const counts = new Map<string, { count: number; service: MessagesService }>();
      for (const chat of chats) {
        if (!chat.account) continue;
        const address = stripScheme(chat.account);
        const entry = counts.get(address) ?? { count: 0, service: serviceOf(chat.service) };
        entry.count += 1;
        counts.set(address, entry);
      }
      const [top] = [...counts.entries()].sort((left, right) => right[1].count - left[1].count);
      this.identity = top ? { address: top[0], service: top[1].service } : this.identity;
      return {
        messagesAccess: true,
        // Automation permission is only provable by sending; the first delivery reports it.
        sendCapability: true,
        watcher: false,
        ...(this.identity ? { authorizedIdentity: { ...this.identity } } : {}),
      };
    } catch (error) {
      return {
        messagesAccess: false, sendCapability: false, watcher: false,
        error: 'Allow Full Disk Access for the bridge in System Settings → Privacy & Security.',
      };
    }
  }

  private async observe(message: PhotonMessage, handler: (message: ObservedMessagesMessage) => Promise<void>): Promise<void> {
    const text = message.text?.trim();
    if (!message.chatId || !text) return;
    const chat = normalize(dmAddress(message.chatId));
    this.expire();
    // Our own delivery landing in chat.db: report it under the id the bridge was given.
    const sentIndex = this.pendingSends.findIndex((send) => send.chat === chat && send.text === text);
    const key = `${chat}|${text}`;
    if (sentIndex >= 0) {
      this.recent.set(key, this.now());
      // In a note-to-self thread the delivery can also echo back as an incoming row: never a reply.
      if (!message.isFromMe) return;
      const [sent] = this.pendingSends.splice(sentIndex, 1);
      await handler(this.toObserved(message, text, 'outgoing', sent.requestId));
      return;
    }
    // A note-to-self can land as both a from-me row and an incoming row; count it once.
    const seen = this.recent.get(key);
    if (seen !== undefined && this.now() - seen < 90_000) return;
    this.recent.set(key, this.now());
    const isSelfChat = Boolean(this.identity && normalize(this.identity.address) === chat);
    if (message.isFromMe && !isSelfChat) return;
    await handler(this.toObserved(message, text, 'incoming', message.id));
  }

  private toObserved(message: PhotonMessage, text: string, direction: 'incoming' | 'outgoing', externalId: string): ObservedMessagesMessage {
    const participant = message.participant ?? dmAddress(message.chatId!);
    const ownAddress = this.identity?.address;
    const sender = message.isFromMe || (ownAddress && normalize(participant) === normalize(ownAddress))
      ? ownAddress ?? participant
      : participant;
    return {
      externalId,
      chatId: message.chatId!,
      sender,
      body: text,
      direction,
      observedAt: message.createdAt,
      cursor: String(message.rowId).padStart(16, '0'),
    };
  }

  private expire(): void {
    const cutoff = this.now() - 10 * 60_000;
    for (const [key, at] of this.recent) if (at < cutoff) this.recent.delete(key);
    while (this.pendingSends.length && this.pendingSends[0].at < cutoff) this.pendingSends.shift();
  }
}

/** Loads Photon iMessage Kit on the Mac. It is an optional dependency, never loaded by the server. */
export async function createPhotonKitClient(): Promise<PhotonKitClient> {
  const moduleName = '@photon-ai/imessage-kit';
  const kit = await import(moduleName) as { IMessageSDK: new () => PhotonSdk };
  return new PhotonKitClient(new kit.IMessageSDK());
}
