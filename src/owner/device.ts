import { randomBytes, randomUUID } from 'node:crypto';

export type OwnerDeviceStatus = 'pending' | 'active' | 'revoked';

export interface OwnerDevice {
  id: string;
  ownerId: string;
  type: 'macos_messages';
  name: string;
  status: OwnerDeviceStatus;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

export interface OwnerDeviceStore {
  save(device: OwnerDevice): Promise<void>;
  get(id: string): Promise<OwnerDevice | null>;
  list(ownerId: string): Promise<OwnerDevice[]>;
}

export class InMemoryOwnerDeviceStore implements OwnerDeviceStore {
  private readonly devices = new Map<string, OwnerDevice>();

  async save(device: OwnerDevice): Promise<void> {
    this.devices.set(device.id, structuredClone(device));
  }

  async get(id: string): Promise<OwnerDevice | null> {
    return structuredClone(this.devices.get(id) ?? null);
  }

  async list(ownerId: string): Promise<OwnerDevice[]> {
    return [...this.devices.values()]
      .filter((device) => device.ownerId === ownerId)
      .map((device) => structuredClone(device));
  }
}

export class OwnerDeviceService {
  private readonly pairingCodes = new Map<string, { code: string; expiresAt: number }>();
  private readonly sessions = new Map<string, string>();

  constructor(
    private readonly store: OwnerDeviceStore = new InMemoryOwnerDeviceStore(),
    private readonly now: () => number = Date.now,
  ) {}

  async pair(ownerId: string, name: string): Promise<{
    device: OwnerDevice;
    pairingCode: string;
    expiresAt: Date;
  }> {
    const createdAt = new Date(this.now());
    const device: OwnerDevice = {
      id: randomUUID(),
      ownerId,
      type: 'macos_messages',
      name: name.trim() || 'Mac Messages',
      status: 'pending',
      createdAt,
      lastSeenAt: null,
      revokedAt: null,
    };
    const expiresAt = this.now() + 10 * 60 * 1000;
    this.pairingCodes.set(device.id, {
      code: randomBytes(18).toString('base64url'),
      expiresAt,
    });
    await this.store.save(device);
    return { device, pairingCode: this.pairingCodes.get(device.id)!.code, expiresAt: new Date(expiresAt) };
  }

  async activate(deviceId: string, pairingCode: string): Promise<{ device: OwnerDevice; sessionToken: string }> {
    const device = await this.store.get(deviceId);
    const pairing = this.pairingCodes.get(deviceId);
    if (!device || device.status !== 'pending' || !pairing ||
      pairing.expiresAt <= this.now() || pairing.code !== pairingCode) {
      throw new Error('Invalid or expired pairing code');
    }
    device.status = 'active';
    device.lastSeenAt = new Date(this.now());
    await this.store.save(device);
    this.pairingCodes.delete(deviceId);
    const sessionToken = randomBytes(32).toString('base64url');
    this.sessions.set(sessionToken, deviceId);
    return { device, sessionToken };
  }

  async list(ownerId: string): Promise<OwnerDevice[]> {
    return this.store.list(ownerId);
  }

  async revoke(ownerId: string, deviceId: string): Promise<void> {
    const device = await this.store.get(deviceId);
    if (!device || device.ownerId !== ownerId) throw new Error('Device not found');
    device.status = 'revoked';
    device.revokedAt = new Date(this.now());
    await this.store.save(device);
    for (const [token, id] of this.sessions) if (id === deviceId) this.sessions.delete(token);
  }

  async authenticate(sessionToken: string): Promise<OwnerDevice | null> {
    const deviceId = this.sessions.get(sessionToken);
    if (!deviceId) return null;
    const device = await this.store.get(deviceId);
    return device?.status === 'active' ? device : null;
  }
}
