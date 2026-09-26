import type { OwnerAttention } from './model.js';
import type { OwnerSurface, SurfaceResult } from './surfaces.js';

export interface NotificationPreferences {
  /** Also notify about calls that don't need the owner (started, moved to text, completed). */
  notifyOnActivity: boolean;
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
  switch (attention.type) {
    case 'assistant_needs_owner':
    case 'error':
      return { push: true, mac: true, sms: 'if_undelivered' };
    case 'conversation_transferred':
      // Messages is a text surface: the owner converses there, so it hears about the move.
      return { push: preferences.notifyOnActivity, mac: true, sms: 'if_no_surface' };
    case 'conversation_started':
    case 'conversation_completed':
      return { push: preferences.notifyOnActivity, mac: false, sms: 'never' };
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
      for (const result of await surface.deliver(attention)) deliveries.push({ ...result, surface: surface.kind });
    }
    const sms = this.surfaces.sms;
    if (sms && plan.sms !== 'never' && await sms.available(attention.ownerId)) {
      const delivered = deliveries.some((delivery) => delivery.status === 'sent');
      const anySurface = await this.anyPrimarySurface(attention.ownerId);
      if ((plan.sms === 'if_undelivered' && !delivered) || (plan.sms === 'if_no_surface' && !anySurface)) {
        for (const result of await sms.deliver(attention)) deliveries.push({ ...result, surface: sms.kind });
      }
    }
    return deliveries;
  }

  private async anyPrimarySurface(ownerId: string): Promise<boolean> {
    for (const surface of [this.surfaces.push, this.surfaces.mac]) {
      if (surface && await surface.available(ownerId)) return true;
    }
    return false;
  }
}
