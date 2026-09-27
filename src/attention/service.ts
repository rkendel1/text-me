import {
  createAttentionId,
  createDeliveryId,
  type OwnerAttention,
  type OwnerAttentionActionKind,
  type OwnerAttentionPriority,
  type OwnerAttentionStatus,
  type OwnerAttentionType,
} from './model.js';
import type { NotificationPreferences, NotificationRouter } from './router.js';
import type { NotificationDeliveryStore, OwnerAttentionStore } from './stores.js';

export interface RaiseAttentionInput {
  accountId: string;
  conversationId: string;
  type: OwnerAttentionType;
  title: string;
  body: string;
  dedupeKey: string;
  priority?: OwnerAttentionPriority;
  actions?: OwnerAttentionActionKind[];
  metadata?: Record<string, unknown>;
}

const INTERRUPTING: OwnerAttentionType[] = ['assistant_needs_owner', 'error'];
const OPEN: OwnerAttentionStatus[] = ['pending', 'delivered', 'opened'];

/**
 * Owner attention: raised from conversation/runtime state, stored in Neon,
 * then routed to whatever surfaces the owner has. Delivery never blocks the
 * conversation — a caller is never held up by a missing phone or Mac.
 */
export class OwnerAttentionService {
  constructor(
    private readonly store: OwnerAttentionStore,
    private readonly deliveries: NotificationDeliveryStore,
    private readonly router: NotificationRouter,
    private readonly preferences: (accountId: string) => Promise<NotificationPreferences>,
    private readonly publish: (attention: OwnerAttention) => Promise<void> = async () => undefined,
  ) {}

  async raise(input: RaiseAttentionInput): Promise<OwnerAttention> {
    if (!input.accountId) throw new Error('Attention needs the owning account');
    const now = new Date();
    const candidate: OwnerAttention = {
      id: createAttentionId(),
      accountId: input.accountId,
      conversationId: input.conversationId,
      type: input.type,
      priority: input.priority ?? (INTERRUPTING.includes(input.type) ? 'interrupt' : 'passive'),
      title: input.title,
      body: input.body,
      actions: input.actions ?? (input.type === 'assistant_needs_owner' ? ['reply', 'take_over'] : ['open']),
      status: 'pending',
      dedupeKey: input.dedupeKey,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    const attention = await this.store.create(candidate);
    if (attention.id !== candidate.id) return attention; // Already raised; don't notify twice.

    try {
      const routed = await this.router.route(attention, await this.preferences(attention.accountId));
      for (const delivery of routed) {
        await this.deliveries.record({
          id: createDeliveryId(), attentionId: attention.id, accountId: attention.accountId, createdAt: new Date(), ...delivery,
        });
      }
      if (routed.some((delivery) => delivery.status === 'sent')) {
        await this.store.update(attention.id, { status: 'delivered' });
        attention.status = 'delivered';
      }
    } catch (error) {
      console.error(`[attention ${attention.id}] routing failed`, error);
    }
    await this.publish(attention).catch(() => undefined);
    return attention;
  }

  async get(id: string, accountId: string): Promise<OwnerAttention | null> {
    const attention = await this.store.get(id);
    return attention && attention.accountId === accountId ? attention : null;
  }

  list(accountId: string, options?: { conversationId?: string; open?: boolean; limit?: number }) {
    return this.store.list(accountId, options);
  }

  deliveriesFor(attentionId: string) {
    return this.deliveries.list(attentionId);
  }

  deliveriesForConversation(conversationId: string) {
    return this.deliveries.listForConversation(conversationId);
  }

  /** The owner opened it (e.g. tapped the notification). */
  async markOpened(attention: OwnerAttention): Promise<void> {
    if (attention.status === 'pending' || attention.status === 'delivered') {
      await this.store.update(attention.id, { status: 'opened', metadata: { openedAt: new Date().toISOString() } });
    }
  }

  async markActed(attention: OwnerAttention, action: string, commandId?: string): Promise<void> {
    await this.store.update(attention.id, {
      status: 'acted',
      resolvedAt: new Date(),
      metadata: { action, ...(commandId ? { commandId } : {}), actedAt: new Date().toISOString() },
    });
  }

  async dismiss(attention: OwnerAttention): Promise<void> {
    await this.store.update(attention.id, { status: 'dismissed', resolvedAt: new Date() });
  }

  /** The condition that raised it no longer holds (call ended, owner answered…). */
  async resolve(accountId: string, conversationId: string, types: OwnerAttentionType[], reason: string): Promise<void> {
    for (const attention of await this.store.list(accountId, { conversationId, open: true })) {
      if (types.includes(attention.type) && OPEN.includes(attention.status)) {
        await this.store.update(attention.id, { status: 'resolved', resolvedAt: new Date(), metadata: { resolvedBecause: reason } });
      }
    }
  }
}
