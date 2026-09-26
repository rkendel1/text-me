import webpush from 'web-push';

import type { ConversationRepository } from '../repositories/conversation-repository.js';
import type { MessagingProvider } from '../messaging/provider.js';
import type { OwnerChannel } from '../owner/channel.js';
import { attentionUrl, type NotificationDelivery, type OwnerAttention, type OwnerSurfaceKind } from './model.js';
import type { NotificationPreferences } from './router.js';
import type { AppSecretStore, OwnerSurfaceDeviceStore } from './stores.js';
import { ApnsError, apnsMessage, type ApnsSender } from './apns.js';

export type SurfaceResult = Pick<NotificationDelivery, 'status' | 'deviceId' | 'error' | 'providerId'> & {
  /** Set when one surface reaches devices through different services (Web Push and APNs). */
  surface?: OwnerSurfaceKind;
};

/**
 * A place the owner can be reached and act from. Conversations never know
 * which surfaces exist; the router hands each one an OwnerAttention.
 */
export interface OwnerSurface {
  readonly kind: OwnerSurfaceKind;
  /** Set up and usable for this owner right now (a registered phone, a paired Mac…). */
  available(ownerId: string): Promise<boolean>;
  deliver(attention: OwnerAttention, preferences?: Pick<NotificationPreferences, 'includeSummary' | 'includeSuggestedResponse'>): Promise<SurfaceResult[]>;
}

/**
 * The text the owner reads in Messages or SMS, shaped by their settings:
 * include the caller summary and a suggested reply only if they want them.
 */
export function ownerTextMessage(
  attention: OwnerAttention,
  preferences: Pick<NotificationPreferences, 'includeSummary' | 'includeSuggestedResponse'> = { includeSummary: true, includeSuggestedResponse: true },
): string {
  const meta = attention.metadata;
  const caller = String(meta.callerName ?? attention.title.replace(/ (needs you|is now texting|is calling)$/, ''));
  const reason = preferences.includeSummary && typeof meta.callerReason === 'string' ? ` (${meta.callerReason})` : '';
  if (attention.type === 'assistant_needs_owner') {
    const suggestion = preferences.includeSuggestedResponse && Array.isArray(meta.suggestedReplies) && meta.suggestedReplies[0]
      ? ` Suggested reply: "${meta.suggestedReplies[0]}".` : '';
    return `${caller}${reason} is waiting: ${String(meta.question ?? attention.body)}${suggestion} Reply here.`;
  }
  if (attention.type === 'conversation_transferred') {
    const summary = preferences.includeSummary && typeof meta.summary === 'string' ? ` They called about ${meta.summary}` : '';
    return `${caller} is now texting.${summary} Reply here and I'll take care of the conversation with them.`;
  }
  return `${attention.title}: ${attention.body} — reply here.`;
}

// ---------------------------------------------------------------- Web Push

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSender {
  publicKey(): Promise<string>;
  send(subscription: PushSubscriptionJSON, payload: string, options: { ttlSeconds: number; urgency: 'high' | 'normal'; topic?: string }): Promise<{ statusCode: number }>;
}

/** Web Push with VAPID keys generated once and kept in Neon; env keys take precedence. */
export class VapidPushSender implements PushSender {
  private keys?: Promise<{ publicKey: string; privateKey: string }>;

  constructor(
    private readonly secrets: AppSecretStore,
    private readonly options: { subject?: string; publicKey?: string; privateKey?: string } = {},
  ) {}

  private loadKeys() {
    this.keys ??= (async () => {
      if (this.options.publicKey && this.options.privateKey) {
        return { publicKey: this.options.publicKey, privateKey: this.options.privateKey };
      }
      const stored = await this.secrets.getOrCreate('web_push_vapid', () => JSON.stringify(webpush.generateVAPIDKeys()));
      return JSON.parse(stored) as { publicKey: string; privateKey: string };
    })();
    return this.keys;
  }

  async publicKey(): Promise<string> {
    return (await this.loadKeys()).publicKey;
  }

  async send(subscription: PushSubscriptionJSON, payload: string, options: Parameters<PushSender['send']>[2]) {
    const keys = await this.loadKeys();
    const result = await webpush.sendNotification(subscription, payload, {
      TTL: options.ttlSeconds,
      urgency: options.urgency,
      ...(options.topic ? { topic: options.topic } : {}),
      vapidDetails: { subject: this.options.subject ?? 'mailto:owner@text-me.app', publicKey: keys.publicKey, privateKey: keys.privateKey },
    });
    return { statusCode: result.statusCode };
  }
}

/** What a phone notification shows: short, human, and only opaque ids in the link. */
export function pushPayload(attention: OwnerAttention): string {
  const interactive = attention.actions.filter((action) => action !== 'open');
  return JSON.stringify({
    title: attention.title,
    body: attention.body.length > 180 ? `${attention.body.slice(0, 177)}…` : attention.body,
    tag: attention.id,
    url: attentionUrl(attention),
    actions: interactive.map((action) => ({ action, title: action === 'take_over' ? 'Take Over' : 'Reply' })),
    renotify: attention.priority === 'interrupt',
  });
}

/**
 * Phone notifications: Web Push for the browser and Home Screen app, APNs for
 * the native iOS app. Both get the same attention, text and deep link.
 */
export class WebPushSurface implements OwnerSurface {
  readonly kind = 'web_push' as const;

  constructor(
    private readonly devices: OwnerSurfaceDeviceStore,
    private readonly sender: PushSender,
    private readonly apns?: ApnsSender,
  ) {}

  private async targets(ownerId: string) {
    return (await this.devices.list(ownerId)).filter((device) =>
      device.status === 'active' && device.capabilities.includes('push') &&
      (device.platform === 'web' || (device.platform === 'ios' && Boolean(this.apns))));
  }

  async available(ownerId: string): Promise<boolean> {
    return (await this.targets(ownerId)).length > 0;
  }

  async deliver(attention: OwnerAttention): Promise<SurfaceResult[]> {
    const payload = pushPayload(attention);
    return Promise.all((await this.targets(attention.ownerId)).map(async (device): Promise<SurfaceResult> => {
      if (device.platform === 'ios') return this.deliverNative(attention, device.id, device.deviceToken);
      try {
        const result = await this.sender.send(JSON.parse(device.deviceToken) as PushSubscriptionJSON, payload, {
          ttlSeconds: attention.priority === 'interrupt' ? 600 : 3600,
          urgency: attention.priority === 'interrupt' ? 'high' : 'normal',
          topic: attention.id.slice(-32),
        });
        return { status: 'sent', deviceId: device.id, providerId: String(result.statusCode) };
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        // The browser unsubscribed or the subscription expired: stop sending to it.
        if (statusCode === 404 || statusCode === 410) await this.devices.setStatus(device.id, 'expired');
        return { status: 'failed', deviceId: device.id, error: statusCode ? `push service ${statusCode}` : (error as Error).message };
      }
    }));
  }

  private async deliverNative(attention: OwnerAttention, deviceId: string, token: string): Promise<SurfaceResult> {
    try {
      const result = await this.apns!.send(token, apnsMessage(attention));
      return { status: 'sent', deviceId, providerId: result.apnsId ?? '200', surface: 'apns' };
    } catch (error) {
      if (error instanceof ApnsError && error.deviceGone) await this.devices.setStatus(deviceId, 'expired');
      return { status: 'failed', deviceId, error: (error as Error).message, surface: 'apns' };
    }
  }
}

// ---------------------------------------------------------------- Mac Messages (optional)

/** The Mac bridge as one more owner surface; replies come back through the same owner-reply path. */
export class MacMessagesSurface implements OwnerSurface {
  readonly kind = 'mac_messages' as const;

  constructor(
    private readonly channel: OwnerChannel & { isAvailable?(ownerId: string): Promise<boolean> },
    private readonly repository: ConversationRepository,
  ) {}

  async available(ownerId: string): Promise<boolean> {
    return this.channel.isAvailable ? this.channel.isAvailable(ownerId) : true;
  }

  async deliver(attention: OwnerAttention, preferences?: Parameters<OwnerSurface['deliver']>[1]): Promise<SurfaceResult[]> {
    const messageId = String(attention.metadata.messageKey ?? attention.dedupeKey);
    const body = ownerTextMessage(attention, preferences);
    await this.repository.appendEvent(attention.conversationId, 'owner.message.created', {
      messageId, body, source: 'macos_messages', attentionId: attention.id,
    }, new Date());
    try {
      const delivery = await this.channel.sendMessage({ ownerId: attention.ownerId, conversationId: attention.conversationId, messageId, body });
      await this.repository.appendEvent(attention.conversationId, 'owner.delivery.requested', {
        messageId, deliveryId: delivery.deliveryId, source: 'macos_messages', attentionId: attention.id,
      }, new Date());
      return [{ status: 'sent', providerId: delivery.deliveryId }];
    } catch (error) {
      await this.repository.appendEvent(attention.conversationId, 'owner.delivery.failed', {
        messageId, source: 'macos_messages', error: error instanceof Error ? error.message : 'unknown', attentionId: attention.id,
      }, new Date());
      return [{ status: 'failed', error: error instanceof Error ? error.message : 'unknown' }];
    }
  }
}

// ---------------------------------------------------------------- Owner SMS (fallback)

/** Texts the owner's phone number: the fallback when no other surface can reach them. */
export class OwnerSmsSurface implements OwnerSurface {
  readonly kind = 'owner_sms' as const;

  constructor(private readonly messaging: MessagingProvider | undefined, private readonly ownerPhone: string | undefined) {}

  async available(): Promise<boolean> {
    return Boolean(this.messaging && this.ownerPhone);
  }

  async deliver(attention: OwnerAttention, preferences?: Parameters<OwnerSurface['deliver']>[1]): Promise<SurfaceResult[]> {
    try {
      const body = ownerTextMessage(attention, preferences);
      const result = await this.messaging!.sendMessage({ to: this.ownerPhone!, body, idempotencyKey: `attention:${attention.id}:sms` });
      return [{ status: 'sent', providerId: result.providerMessageId }];
    } catch (error) {
      return [{ status: 'failed', error: error instanceof Error ? error.message : 'unknown' }];
    }
  }
}
