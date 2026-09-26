import { randomUUID } from 'node:crypto';

/**
 * Owner attention: the durable record that a conversation wants (or might
 * want) the owner. Conversations never depend on a device; attention is what
 * gets delivered to whichever owner surfaces are registered.
 */
export type OwnerAttentionType =
  | 'conversation_started'
  | 'assistant_needs_owner'
  | 'conversation_transferred'
  | 'conversation_completed'
  | 'owner_message'
  | 'error';

/** interrupt: notify now. passive: in-app only unless the owner opted in. */
export type OwnerAttentionPriority = 'interrupt' | 'passive';

export type OwnerAttentionStatus = 'pending' | 'delivered' | 'opened' | 'acted' | 'dismissed' | 'resolved';

export type OwnerAttentionActionKind = 'open' | 'reply' | 'take_over';

export interface OwnerAttention {
  id: string;
  ownerId: string;
  conversationId: string;
  type: OwnerAttentionType;
  priority: OwnerAttentionPriority;
  title: string;
  body: string;
  /** What the owner can do from the notification; always resolved server-side. */
  actions: OwnerAttentionActionKind[];
  status: OwnerAttentionStatus;
  /** Makes raising idempotent (e.g. one attention per owner request). */
  dedupeKey: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt?: Date;
}

export type OwnerSurfaceKind = 'web_push' | 'mac_messages' | 'owner_sms';

export interface NotificationDelivery {
  id: string;
  attentionId: string;
  ownerId: string;
  surface: OwnerSurfaceKind;
  deviceId?: string;
  status: 'sent' | 'failed';
  error?: string;
  providerId?: string;
  createdAt: Date;
}

export type OwnerDevicePlatform = 'web' | 'ios' | 'macos';
export type OwnerDeviceCapability = 'push' | 'live_activity' | 'interactive_notification' | 'deep_link';

/** A device the owner uses as a notification/control surface (not the Mac bridge). */
export interface OwnerSurfaceDevice {
  id: string;
  ownerId: string;
  platform: OwnerDevicePlatform;
  /** For web: the PushSubscription JSON. For ios later: the APNs token. */
  deviceToken: string;
  capabilities: OwnerDeviceCapability[];
  label?: string;
  status: 'active' | 'expired' | 'revoked';
  createdAt: Date;
  lastSeenAt: Date;
}

export const createAttentionId = () => `att_${randomUUID().replace(/-/g, '')}`;
export const createDeliveryId = () => `ntf_${randomUUID().replace(/-/g, '')}`;
export const createSurfaceDeviceId = () => `dev_${randomUUID().replace(/-/g, '')}`;

/** Deep link that opens the exact live conversation, carrying only opaque ids. */
export function attentionUrl(attention: Pick<OwnerAttention, 'id' | 'conversationId'>, intent?: OwnerAttentionActionKind): string {
  const params = new URLSearchParams({ attention: attention.id });
  if (intent && intent !== 'open') params.set('intent', intent);
  return `/conversations/${encodeURIComponent(attention.conversationId)}/live?${params.toString()}`;
}
