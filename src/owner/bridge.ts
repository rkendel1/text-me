import { readFile, writeFile } from 'node:fs/promises';
import type { MacMessagesAdapter, ObservedMessagesMessage } from './mac-messages-adapter.js';

export interface OwnerBridgeCheckpointStore {
  load(): Promise<string | undefined>;
  save(cursor: string): Promise<void>;
}

export class FileOwnerBridgeCheckpointStore implements OwnerBridgeCheckpointStore {
  constructor(private readonly path: string) {}

  async load(): Promise<string | undefined> {
    try {
      return (await readFile(this.path, 'utf8')).trim() || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async save(cursor: string): Promise<void> {
    await writeFile(this.path, cursor, 'utf8');
  }
}

export interface OwnerBridgeBackend {
  submitOwnerMessage(input: {
    ownerId: string;
    deviceId: string;
    chatId: string;
    externalId: string;
    body: string;
    occurredAt: Date;
  }): Promise<void>;
  confirmOwnerDelivery?(input: {
    ownerId: string;
    deviceId: string;
    deliveryId: string;
    externalId: string;
  }): Promise<void>;
}

export interface MacOSMessagesBridgeOptions {
  ownerId: string;
  deviceId: string;
  assistantChatId: string;
  ownerSender: string;
  checkpoint: OwnerBridgeCheckpointStore;
}

export class MacOSMessagesBridge {
  private stopWatching?: () => Promise<void>;
  private cursor?: string;
  private readonly consumed = new Set<string>();

  constructor(
    private readonly adapter: MacMessagesAdapter,
    private readonly backend: OwnerBridgeBackend,
    private readonly options: MacOSMessagesBridgeOptions,
  ) {}

  async start(): Promise<void> {
    this.cursor = await this.options.checkpoint.load();
    this.stopWatching = await this.adapter.watch((message) => this.handle(message));
  }

  async stop(): Promise<void> {
    await this.stopWatching?.();
    this.stopWatching = undefined;
  }

  private async handle(message: ObservedMessagesMessage): Promise<void> {
    if (
      message.chatId !== this.options.assistantChatId ||
      message.sender !== this.options.ownerSender ||
      message.direction !== 'incoming' ||
      this.consumed.has(message.externalId) ||
      (this.cursor !== undefined && message.cursor !== undefined &&
        message.cursor <= this.cursor)
    ) return;

    this.consumed.add(message.externalId);
    await this.backend.submitOwnerMessage({
      ownerId: this.options.ownerId,
      deviceId: this.options.deviceId,
      chatId: message.chatId,
      externalId: message.externalId,
      body: message.body,
      occurredAt: message.observedAt,
    });
    if (message.cursor !== undefined) {
      this.cursor = message.cursor;
      await this.options.checkpoint.save(message.cursor);
    }
  }
}
