import type { OwnerSurfaceDeviceStore } from '../attention/stores.js';
import type { OwnerConfigurationService } from '../owner/configuration.js';
import type { NotificationChannel } from './model.js';

/**
 * An account's notification channels, resolved from records the account owns:
 * its registered push devices, its paired Mac, its verified personal number,
 * and its own settings. Nothing here comes from the deployment, so there is no
 * deployment-wide notification destination to leak another account's events to.
 */
export class NotificationChannelResolver {
  constructor(private readonly deps: {
    surfaceDevices: OwnerSurfaceDeviceStore;
    macDevices?: { primary(accountId: string): Promise<{ id: string; name: string } | null> };
    configuration: OwnerConfigurationService;
    personalNumber: (accountId: string) => Promise<string | null>;
    nativePush: boolean;
    messaging: boolean;
  }) {}

  async list(accountId: string): Promise<NotificationChannel[]> {
    const [configuration, devices, mac, personal] = await Promise.all([
      this.deps.configuration.get(accountId),
      this.deps.surfaceDevices.list(accountId),
      this.deps.macDevices?.primary(accountId) ?? Promise.resolve(null),
      this.deps.personalNumber(accountId),
    ]);
    const push = devices.filter((device) => device.accountId === accountId && device.status === 'active' &&
      device.capabilities.includes('push') && (device.platform === 'web' || (device.platform === 'ios' && this.deps.nativePush)));
    return [
      {
        id: 'ch_push', accountId, kind: 'push', enabled: configuration.messages.webEnabled, available: push.length > 0,
        destination: push.length ? `${push.length} ${push.length === 1 ? 'device' : 'devices'}` : null,
      },
      {
        id: 'ch_mac_messages', accountId, kind: 'mac_messages', enabled: configuration.messages.macosMessagesEnabled,
        available: Boolean(mac), destination: mac?.name ?? null,
      },
      {
        id: 'ch_sms', accountId, kind: 'sms', enabled: configuration.messages.smsEnabled,
        available: Boolean(personal && this.deps.messaging), destination: personal,
      },
    ];
  }
}
