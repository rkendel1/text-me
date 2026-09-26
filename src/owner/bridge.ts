import { readFile, writeFile } from 'node:fs/promises';
import type { MacMessagesAdapter, ObservedMessagesMessage } from './mac-messages-adapter.js';

export interface OwnerBridgeCheckpointStore {
  load(): Promise<string | undefined>;
  save(cursor: string): Promise<void>;
  loadConsumed?(): Promise<string[]>;
  saveConsumed?(externalId: string): Promise<void>;
}

export class FileOwnerBridgeCheckpointStore implements OwnerBridgeCheckpointStore {
  constructor(private readonly path: string) {}

  async load(): Promise<string | undefined> {
    try {
      const value = (await readFile(this.path, 'utf8')).trim();
      if (!value) return undefined;
      try {
        return (JSON.parse(value) as { cursor?: string }).cursor;
      } catch {
        return value;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async save(cursor: string): Promise<void> {
    const consumed = await this.loadConsumed();
    await writeFile(this.path, JSON.stringify({ cursor, consumed }), 'utf8');
  }

  async loadConsumed(): Promise<string[]> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as { consumed?: string[] };
      return value.consumed ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    }
  }

  async saveConsumed(externalId: string): Promise<void> {
    const cursor = await this.load();
    const consumed = await this.loadConsumed();
    if (!consumed.includes(externalId)) consumed.push(externalId);
    await writeFile(this.path, JSON.stringify({ cursor, consumed }), 'utf8');
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
    deliveryId?: string;
    replyToExternalId?: string;
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
  private readonly pendingDeliveries = new Map<string, string>();
  private readonly replyTargets = new Map<string, string>();

  constructor(
    private readonly adapter: MacMessagesAdapter,
    private readonly backend: OwnerBridgeBackend,
    private readonly options: MacOSMessagesBridgeOptions,
  ) {}

  async start(): Promise<void> {
    this.cursor = await this.options.checkpoint.load();
    for (const externalId of await (this.options.checkpoint.loadConsumed?.() ?? Promise.resolve([]))) {
      this.consumed.add(externalId);
    }
    this.stopWatching = await this.adapter.watch((message) => this.handle(message));
  }

  async stop(): Promise<void> {
    await this.stopWatching?.();
    this.stopWatching = undefined;
  }

  trackDelivery(deliveryId: string, providerRequestId: string): void {
    this.pendingDeliveries.set(providerRequestId, deliveryId);
  }

  private async handle(message: ObservedMessagesMessage): Promise<void> {
    if (message.chatId === this.options.assistantChatId && message.direction === 'outgoing') {
      const deliveryId = this.pendingDeliveries.get(message.externalId);
      if (deliveryId && this.backend.confirmOwnerDelivery) {
        await this.backend.confirmOwnerDelivery({
          ownerId: this.options.ownerId,
          deviceId: this.options.deviceId,
          deliveryId,
          externalId: message.externalId,
        });
        this.pendingDeliveries.delete(message.externalId);
        this.replyTargets.set(message.externalId, deliveryId);
      }
      return;
    }
    if (
      message.chatId !== this.options.assistantChatId ||
      message.sender !== this.options.ownerSender ||
      message.direction !== 'incoming' ||
      this.consumed.has(message.externalId) ||
      (this.cursor !== undefined && message.cursor !== undefined &&
        message.cursor <= this.cursor)
    ) return;

    const replyToExternalId = message.replyToExternalId;
    const deliveryId = replyToExternalId ? this.replyTargets.get(replyToExternalId) : undefined;
    if (replyToExternalId && deliveryId) this.replyTargets.delete(replyToExternalId);
    await this.backend.submitOwnerMessage({
      ownerId: this.options.ownerId,
      deviceId: this.options.deviceId,
      chatId: message.chatId,
      externalId: message.externalId,
      body: message.body,
      occurredAt: message.observedAt,
      deliveryId,
      replyToExternalId,
    });
    this.consumed.add(message.externalId);
    await this.options.checkpoint.saveConsumed?.(message.externalId);
    if (message.cursor !== undefined) {
      this.cursor = message.cursor;
      await this.options.checkpoint.save(message.cursor);
    }
  }
}
