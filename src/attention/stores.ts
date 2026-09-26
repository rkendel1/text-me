import type {
  NotificationDelivery,
  OwnerAttention,
  OwnerAttentionStatus,
  OwnerSurfaceDevice,
} from './model.js';

export interface OwnerAttentionStore {
  /** Inserts unless an attention with the same dedupe key exists; returns the stored record. */
  create(attention: OwnerAttention): Promise<OwnerAttention>;
  get(id: string): Promise<OwnerAttention | null>;
  update(id: string, patch: { status: OwnerAttentionStatus; resolvedAt?: Date; metadata?: Record<string, unknown> }): Promise<void>;
  list(ownerId: string, options?: { conversationId?: string; open?: boolean; limit?: number }): Promise<OwnerAttention[]>;
}

export interface NotificationDeliveryStore {
  record(delivery: NotificationDelivery): Promise<void>;
  list(attentionId: string): Promise<NotificationDelivery[]>;
  listForConversation(conversationId: string): Promise<NotificationDelivery[]>;
}

export interface OwnerSurfaceDeviceStore {
  /** Registers or refreshes a device (same owner + token = same device). */
  upsert(device: OwnerSurfaceDevice): Promise<OwnerSurfaceDevice>;
  list(ownerId: string): Promise<OwnerSurfaceDevice[]>;
  setStatus(id: string, status: OwnerSurfaceDevice['status']): Promise<void>;
}

/** Small key/value store for server-generated secrets (e.g. Web Push VAPID keys). */
export interface AppSecretStore {
  /** Stores the value only if the key is unset, and returns whichever value won. */
  getOrCreate(key: string, create: () => string): Promise<string>;
}

const OPEN: OwnerAttentionStatus[] = ['pending', 'delivered', 'opened'];

export class InMemoryOwnerAttentionStore implements OwnerAttentionStore {
  private readonly items = new Map<string, OwnerAttention>();

  async create(attention: OwnerAttention): Promise<OwnerAttention> {
    const existing = [...this.items.values()].find((item) => item.ownerId === attention.ownerId && item.dedupeKey === attention.dedupeKey);
    if (existing) return structuredClone(existing);
    this.items.set(attention.id, structuredClone(attention));
    return structuredClone(attention);
  }

  async get(id: string): Promise<OwnerAttention | null> {
    return structuredClone(this.items.get(id) ?? null);
  }

  async update(id: string, patch: Parameters<OwnerAttentionStore['update']>[1]): Promise<void> {
    const item = this.items.get(id);
    if (!item) return;
    this.items.set(id, {
      ...item,
      status: patch.status,
      resolvedAt: patch.resolvedAt ?? item.resolvedAt,
      metadata: patch.metadata ? { ...item.metadata, ...patch.metadata } : item.metadata,
      updatedAt: new Date(),
    });
  }

  async list(ownerId: string, options: Parameters<OwnerAttentionStore['list']>[1] = {}): Promise<OwnerAttention[]> {
    return [...this.items.values()]
      .filter((item) => item.ownerId === ownerId)
      .filter((item) => !options.conversationId || item.conversationId === options.conversationId)
      .filter((item) => !options.open || OPEN.includes(item.status))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, options.limit ?? 100)
      .map((item) => structuredClone(item));
  }
}

export class InMemoryNotificationDeliveryStore implements NotificationDeliveryStore {
  private readonly items: NotificationDelivery[] = [];
  private readonly conversations = new Map<string, string>();

  constructor(private readonly attentions?: OwnerAttentionStore) {}

  async record(delivery: NotificationDelivery): Promise<void> {
    this.items.push(structuredClone(delivery));
    const attention = await this.attentions?.get(delivery.attentionId);
    if (attention) this.conversations.set(delivery.id, attention.conversationId);
  }

  async list(attentionId: string): Promise<NotificationDelivery[]> {
    return this.items.filter((item) => item.attentionId === attentionId).map((item) => structuredClone(item));
  }

  async listForConversation(conversationId: string): Promise<NotificationDelivery[]> {
    return this.items.filter((item) => this.conversations.get(item.id) === conversationId).map((item) => structuredClone(item));
  }
}

export class InMemoryOwnerSurfaceDeviceStore implements OwnerSurfaceDeviceStore {
  private readonly items = new Map<string, OwnerSurfaceDevice>();

  async upsert(device: OwnerSurfaceDevice): Promise<OwnerSurfaceDevice> {
    const existing = [...this.items.values()].find((item) => item.ownerId === device.ownerId && item.deviceToken === device.deviceToken);
    const next = existing
      ? { ...existing, capabilities: device.capabilities, label: device.label ?? existing.label, status: 'active' as const, lastSeenAt: new Date() }
      : device;
    this.items.set(next.id, structuredClone(next));
    return structuredClone(next);
  }

  async list(ownerId: string): Promise<OwnerSurfaceDevice[]> {
    return [...this.items.values()].filter((item) => item.ownerId === ownerId).map((item) => structuredClone(item));
  }

  async setStatus(id: string, status: OwnerSurfaceDevice['status']): Promise<void> {
    const item = this.items.get(id);
    if (item) this.items.set(id, { ...item, status });
  }
}

export class InMemoryAppSecretStore implements AppSecretStore {
  private readonly items = new Map<string, string>();

  async getOrCreate(key: string, create: () => string): Promise<string> {
    if (!this.items.has(key)) this.items.set(key, create());
    return this.items.get(key)!;
  }
}
