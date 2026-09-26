import { randomUUID } from 'node:crypto';

import type { OwnerChannel } from './channel.js';

export type OwnerMessageDeliveryStatus = 'pending' | 'sent' | 'observed' | 'replied' | 'failed';

export interface OwnerMessageDeliveryRecord {
  id: string;
  ownerId: string;
  deviceId: string;
  conversationId: string;
  messageId: string;
  body: string;
  correlationKey: string;
  status: OwnerMessageDeliveryStatus;
  providerRequestId?: string;
  observedExternalId?: string;
  repliedExternalId?: string;
  createdAt: Date;
  updatedAt: Date;
  observedAt?: Date;
  repliedAt?: Date;
  failedAt?: Date;
  error?: string;
}

export interface OwnerMessageDeliveryStore {
  create(input: Omit<OwnerMessageDeliveryRecord, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'correlationKey'> & {
    correlationKey?: string;
  }): Promise<OwnerMessageDeliveryRecord>;
  listPending(deviceId: string): Promise<OwnerMessageDeliveryRecord[]>;
  markSent(deviceId: string, deliveryId: string, providerRequestId: string): Promise<OwnerMessageDeliveryRecord | null>;
  markObserved(deviceId: string, deliveryId: string, observedExternalId: string): Promise<OwnerMessageDeliveryRecord | null>;
  markFailed(deviceId: string, deliveryId: string, error: string): Promise<OwnerMessageDeliveryRecord | null>;
  claimReplyTarget(deviceId: string, externalId: string, deliveryId?: string, replyToExternalId?: string): Promise<OwnerMessageDeliveryRecord | null>;
}

export class InMemoryOwnerMessageDeliveryStore implements OwnerMessageDeliveryStore {
  private readonly deliveries = new Map<string, OwnerMessageDeliveryRecord>();

  async create(input: Omit<OwnerMessageDeliveryRecord, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'correlationKey'> & {
    correlationKey?: string;
  }): Promise<OwnerMessageDeliveryRecord> {
    const now = new Date();
    const record: OwnerMessageDeliveryRecord = {
      id: randomUUID(),
      ownerId: input.ownerId,
      deviceId: input.deviceId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      body: input.body,
      correlationKey: input.correlationKey ?? randomUUID(),
      status: 'pending',
      providerRequestId: input.providerRequestId,
      observedExternalId: input.observedExternalId,
      repliedExternalId: input.repliedExternalId,
      createdAt: now,
      updatedAt: now,
      observedAt: input.observedAt,
      repliedAt: input.repliedAt,
      failedAt: input.failedAt,
      error: input.error,
    };
    this.deliveries.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async listPending(deviceId: string): Promise<OwnerMessageDeliveryRecord[]> {
    return [...this.deliveries.values()]
      .filter((delivery) => delivery.deviceId === deviceId && delivery.status === 'pending')
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((delivery) => structuredClone(delivery));
  }

  async markSent(deviceId: string, deliveryId: string, providerRequestId: string): Promise<OwnerMessageDeliveryRecord | null> {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery || delivery.deviceId !== deviceId) return null;
    delivery.status = 'sent';
    delivery.providerRequestId = providerRequestId;
    delivery.updatedAt = new Date();
    return structuredClone(delivery);
  }

  async markObserved(deviceId: string, deliveryId: string, observedExternalId: string): Promise<OwnerMessageDeliveryRecord | null> {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery || delivery.deviceId !== deviceId) return null;
    delivery.status = 'observed';
    delivery.observedExternalId = observedExternalId;
    delivery.observedAt = new Date();
    delivery.updatedAt = new Date();
    return structuredClone(delivery);
  }

  async markFailed(deviceId: string, deliveryId: string, error: string): Promise<OwnerMessageDeliveryRecord | null> {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery || delivery.deviceId !== deviceId) return null;
    delivery.status = 'failed';
    delivery.error = error;
    delivery.failedAt = new Date();
    delivery.updatedAt = new Date();
    return structuredClone(delivery);
  }

  async claimReplyTarget(deviceId: string, externalId: string, deliveryId?: string, replyToExternalId?: string): Promise<OwnerMessageDeliveryRecord | null> {
    const delivery = deliveryId
      ? this.deliveries.get(deliveryId)
      : replyToExternalId
        ? [...this.deliveries.values()].find((candidate) =>
          candidate.deviceId === deviceId &&
          (candidate.status === 'observed' || candidate.status === 'sent') &&
          (candidate.observedExternalId === replyToExternalId || candidate.providerRequestId === replyToExternalId))
        : undefined;
    if (!delivery || delivery.deviceId !== deviceId || (delivery.status !== 'observed' && delivery.status !== 'sent')) return null;
    delivery.status = 'replied';
    delivery.repliedExternalId = externalId;
    delivery.repliedAt = new Date();
    delivery.updatedAt = new Date();
    return structuredClone(delivery);
  }
}

export class QueuedMacMessagesOwnerChannel implements OwnerChannel {
  readonly type = 'macos_messages' as const;

  constructor(
    private readonly deliveries: OwnerMessageDeliveryStore,
    private readonly devices: { primary(ownerId: string): Promise<{ id: string } | null> },
    private readonly settings?: { isChannelEnabled(ownerId: string, channel: OwnerChannel['type']): boolean | Promise<boolean> },
  ) {}

  async sendMessage(input: Parameters<OwnerChannel['sendMessage']>[0]): Promise<{ deliveryId: string }> {
    if (!input.ownerId || !input.conversationId || !input.messageId || !input.body.trim()) {
      throw new Error('Owner message delivery is incomplete');
    }
    if (this.settings && !(await this.settings.isChannelEnabled(input.ownerId, this.type))) {
      throw new Error('Apple Messages owner channel is disabled');
    }
    const device = await this.devices.primary(input.ownerId);
    if (!device) throw new Error('A ready primary Mac Messages device is required');
    const delivery = await this.deliveries.create({
      ownerId: input.ownerId,
      deviceId: device.id,
      conversationId: input.conversationId,
      messageId: input.messageId,
      body: input.body,
    });
    return { deliveryId: delivery.id };
  }
}
