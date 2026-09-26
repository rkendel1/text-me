import type { OwnerAttention } from './model.js';
import type { OwnerSurface, SurfaceResult } from './surfaces.js';

/** The owner's message settings that decide delivery (typed OwnerMessageSettings, not device presence). */
export interface NotificationPreferences {
  /** Master switch: send owner notifications at all. */
  notifyOwner: boolean;
  /** Only interrupt when the assistant needs the owner (off: also routine calls). */
  interruptOnlyWhenNeeded: boolean;
  /** Owner channels: enabled is separate from whether a device is connected. */
  webEnabled: boolean;
  macosMessagesEnabled: boolean;
  includeSummary: boolean;
  includeSuggestedResponse: boolean;
}

export interface DeliveryPlan {
  push: boolean;
  mac: boolean;
  /** When to text the owner's phone: never, only if nothing else got through, or only if no other surface is set up. */
  sms: 'never' | 'if_undelivered' | 'if_no_surface';
}

/**
 * The single notification policy. Autonomous calls stay quiet; the owner is
 * interrupted only when the assistant needs them or something is wrong.
 */
export function planDelivery(attention: Pick<OwnerAttention, 'type'>, preferences: NotificationPreferences): DeliveryPlan {
  if (!preferences.notifyOwner) return { push: false, mac: false, sms: 'never' };
  const plan = basePlan(attention, !preferences.interruptOnlyWhenNeeded);
  return { ...plan, push: plan.push && preferences.webEnabled, mac: plan.mac && preferences.macosMessagesEnabled };
}

function basePlan(attention: Pick<OwnerAttention, 'type'>, notifyOnActivity: boolean): DeliveryPlan {
  switch (attention.type) {
    case 'assistant_needs_owner':
    case 'error':
      return { push: true, mac: true, sms: 'if_undelivered' };
    case 'voicemail':
      return { push: true, mac: true, sms: 'if_no_surface' };
    case 'conversation_transferred':
      // Messages is a text surface: the owner converses there, so it hears about the move.
      return { push: notifyOnActivity, mac: true, sms: 'if_no_surface' };
    case 'conversation_started':
    case 'conversation_completed':
      return { push: notifyOnActivity, mac: false, sms: 'never' };
    case 'owner_message':
    default:
      return { push: false, mac: false, sms: 'never' };
  }
}

export interface RoutedDelivery extends SurfaceResult {
  surface: OwnerSurface['kind'];
}

export class NotificationRouter {
  constructor(private readonly surfaces: { push?: OwnerSurface; mac?: OwnerSurface; sms?: OwnerSurface }) {}

  async route(attention: OwnerAttention, preferences: NotificationPreferences): Promise<RoutedDelivery[]> {
    const plan = planDelivery(attention, preferences);
    const deliveries: RoutedDelivery[] = [];
    const primary = [
      plan.push ? this.surfaces.push : undefined,
      plan.mac ? this.surfaces.mac : undefined,
    ].filter((surface): surface is OwnerSurface => Boolean(surface));
    for (const surface of primary) {
      if (!(await surface.available(attention.ownerId))) continue;
      for (const result of await surface.deliver(attention, preferences)) deliveries.push({ ...result, surface: surface.kind });
    }
    const sms = this.surfaces.sms;
    if (sms && plan.sms !== 'never' && await sms.available(attention.ownerId)) {
      const delivered = deliveries.some((delivery) => delivery.status === 'sent');
      const anySurface = await this.anyEnabledSurface(attention.ownerId, preferences);
      if ((plan.sms === 'if_undelivered' && !delivered) || (plan.sms === 'if_no_surface' && !anySurface)) {
        for (const result of await sms.deliver(attention, preferences)) deliveries.push({ ...result, surface: sms.kind });
      }
    }
    return deliveries;
  }

  /** A connected device only counts if its owner channel is enabled. */
  private async anyEnabledSurface(ownerId: string, preferences: NotificationPreferences): Promise<boolean> {
    const enabled = [
      preferences.webEnabled ? this.surfaces.push : undefined,
      preferences.macosMessagesEnabled ? this.surfaces.mac : undefined,
    ];
    for (const surface of enabled) {
      if (surface && await surface.available(ownerId)) return true;
    }
    return false;
  }
}
