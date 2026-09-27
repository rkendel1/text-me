import { randomBytes, randomUUID } from 'node:crypto';
import type { MacMessagesAdapter, MessagesCapabilities, MessagesChat, MessagesService } from './mac-messages-adapter.js';

export type OwnerDeviceStatus = 'pending' | 'active' | 'revoked';
export type OwnerDeviceSetupStatus =
  | 'awaiting_pairing'
  | 'paired'
  | 'awaiting_messages'
  | 'awaiting_chat_authorization'
  | 'ready'
  | 'error';

export interface OwnerMessagesIdentity {
  accountId: string;
  deviceId: string;
  service: MessagesService;
  address: string;
  displayName?: string;
}

export interface AssistantMessagesChat {
  deviceId: string;
  chatId: string;
  service: MessagesService;
  address?: string;
  displayName?: string;
}

export interface OwnerDeviceHealth extends MessagesCapabilities {
  authorizedChat: boolean;
}

/** "Test connection": the bridge checks everything end to end without sending a visible message. */
export interface OwnerDeviceProbe {
  id: string;
  requestedAt: string;
  completedAt?: string;
  result?: {
    bridgeReachable: boolean;
    messagesAccess: boolean;
    sendCapability: boolean;
    watcher: boolean;
    assistantChatFound: boolean;
  };
}

export interface OwnerDevice {
  id: string;
  /** The owning account: the Mac only ever sees and acts on this account's configuration and deliveries. */
  accountId: string;
  /** The user who paired it. */
  userId?: string;
  type: 'macos_messages';
  name: string;
  status: OwnerDeviceStatus;
  setupStatus: OwnerDeviceSetupStatus;
  health: OwnerDeviceHealth;
  messagesIdentity: OwnerMessagesIdentity | null;
  assistantChat: AssistantMessagesChat | null;
  discoveredChats: MessagesChat[];
  isPrimary: boolean;
  bridgeVersion?: string;
  probe?: OwnerDeviceProbe | null;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

export interface OwnerDeviceStore {
  save(device: OwnerDevice): Promise<void>;
  get(id: string): Promise<OwnerDevice | null>;
  list(accountId: string): Promise<OwnerDevice[]>;
}

export interface OwnerPairingCredentialRecord {
  deviceId: string;
  accountId: string;
  code: string;
  expiresAt: number;
}

export interface OwnerPairingCredentialStore {
  save(record: OwnerPairingCredentialRecord): Promise<void>;
  /** Atomically take a live credential so it can be used exactly once, even by two simultaneous scans. */
  consume(code: string, now: number): Promise<OwnerPairingCredentialRecord | null>;
  getByDeviceId(deviceId: string): Promise<OwnerPairingCredentialRecord | null>;
  getByCode(code: string): Promise<OwnerPairingCredentialRecord | null>;
  delete(deviceId: string): Promise<void>;
}

export interface OwnerDeviceSessionRecord {
  token: string;
  deviceId: string;
  accountId: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface OwnerDeviceSessionStore {
  save(record: OwnerDeviceSessionRecord): Promise<void>;
  get(token: string): Promise<OwnerDeviceSessionRecord | null>;
  delete(token: string): Promise<void>;
  deleteByDeviceId(deviceId: string): Promise<void>;
  touch(token: string, lastSeenAt: number): Promise<void>;
}

export const PAIRING_TTL_MS = 5 * 60 * 1000;

/**
 * The QR payload: attn://pair/<one-time token>?s=<server origin>. Only an opaque
 * single-use token and where to redeem it — no owner or device credentials.
 */
export function pairingQrPayload(pairingCode: string, serverOrigin: string): string {
  return `attn://pair/${pairingCode}?s=${encodeURIComponent(serverOrigin)}`;
}

export function parsePairingCredential(credential: string): { code: string; server?: string } {
  const trimmed = credential.trim();
  const match = trimmed.match(/^attn:\/\/pair\/([A-Za-z0-9_-]+)(?:\?(.*))?$/);
  if (!match) return { code: trimmed };
  const server = new URLSearchParams(match[2] ?? '').get('s') ?? undefined;
  return { code: match[1], ...(server ? { server } : {}) };
}

export class InMemoryOwnerDeviceStore implements OwnerDeviceStore {
  private readonly devices = new Map<string, OwnerDevice>();

  async save(device: OwnerDevice): Promise<void> {
    this.devices.set(device.id, structuredClone(device));
  }

  async get(id: string): Promise<OwnerDevice | null> {
    return structuredClone(this.devices.get(id) ?? null);
  }

  async list(accountId: string): Promise<OwnerDevice[]> {
    return [...this.devices.values()]
      .filter((device) => device.accountId === accountId)
      .map((device) => structuredClone(device));
  }
}

export class InMemoryOwnerPairingCredentialStore implements OwnerPairingCredentialStore {
  private readonly credentials = new Map<string, OwnerPairingCredentialRecord>();

  async save(record: OwnerPairingCredentialRecord): Promise<void> {
    this.credentials.set(record.deviceId, structuredClone(record));
  }

  async getByDeviceId(deviceId: string): Promise<OwnerPairingCredentialRecord | null> {
    return structuredClone(this.credentials.get(deviceId) ?? null);
  }

  async consume(code: string, now: number): Promise<OwnerPairingCredentialRecord | null> {
    const record = [...this.credentials.values()].find((candidate) => candidate.code === code);
    if (!record) return null;
    this.credentials.delete(record.deviceId);
    return record.expiresAt > now ? structuredClone(record) : null;
  }

  async getByCode(code: string): Promise<OwnerPairingCredentialRecord | null> {
    return structuredClone([...this.credentials.values()].find((record) => record.code === code) ?? null);
  }

  async delete(deviceId: string): Promise<void> {
    this.credentials.delete(deviceId);
  }
}

export class InMemoryOwnerDeviceSessionStore implements OwnerDeviceSessionStore {
  private readonly sessions = new Map<string, OwnerDeviceSessionRecord>();

  async save(record: OwnerDeviceSessionRecord): Promise<void> {
    this.sessions.set(record.token, structuredClone(record));
  }

  async get(token: string): Promise<OwnerDeviceSessionRecord | null> {
    return structuredClone(this.sessions.get(token) ?? null);
  }

  async delete(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  async deleteByDeviceId(deviceId: string): Promise<void> {
    for (const [token, session] of this.sessions) {
      if (session.deviceId === deviceId) this.sessions.delete(token);
    }
  }

  async touch(token: string, lastSeenAt: number): Promise<void> {
    const session = this.sessions.get(token);
    if (!session) return;
    session.lastSeenAt = lastSeenAt;
  }
}

export class OwnerDeviceService {
  constructor(
    private readonly store: OwnerDeviceStore = new InMemoryOwnerDeviceStore(),
    private readonly now: () => number = Date.now,
    private readonly pairings: OwnerPairingCredentialStore = new InMemoryOwnerPairingCredentialStore(),
    private readonly sessions: OwnerDeviceSessionStore = new InMemoryOwnerDeviceSessionStore(),
  ) {}

  async pair(accountId: string, name: string, userId?: string): Promise<{
    device: OwnerDevice;
    pairingCode: string;
    pairingUri: string;
    expiresAt: Date;
  }> {
    const createdAt = new Date(this.now());
    if (!accountId) throw new Error('An account is required');
    const device: OwnerDevice = {
      id: randomUUID(),
      accountId,
      ...(userId ? { userId } : {}),
      type: 'macos_messages',
      name: name.trim() || 'Mac Messages',
      status: 'pending',
      setupStatus: 'awaiting_pairing',
      health: {
        messagesAccess: false, sendCapability: false, watcher: false, authorizedChat: false,
      },
      messagesIdentity: null,
      assistantChat: null,
      discoveredChats: [],
      isPrimary: false,
      createdAt,
      updatedAt: createdAt,
      lastSeenAt: null,
      revokedAt: null,
    };
    // Short-lived: long enough to scan from across the room, not long enough to linger.
    const expiresAt = this.now() + PAIRING_TTL_MS;
    const pairingCode = randomBytes(18).toString('base64url');
    // The device row must exist before its pairing credential (FK in Postgres).
    await this.store.save(device);
    await this.pairings.save({
      deviceId: device.id,
      accountId,
      code: pairingCode,
      expiresAt,
    });
    return { device, pairingCode, pairingUri: `attn://pair/${pairingCode}`, expiresAt: new Date(expiresAt) };
  }

  async activate(deviceId: string, pairingCode: string): Promise<{ device: OwnerDevice; sessionToken: string }> {
    const code = parsePairingCredential(pairingCode).code;
    const pairing = await this.pairings.consume(code, this.now());
    const device = await this.store.get(deviceId);
    if (!pairing || pairing.deviceId !== deviceId || !device || device.status !== 'pending' || device.accountId !== pairing.accountId) {
      throw new Error('Invalid or expired pairing code');
    }

    device.status = 'active';
    device.setupStatus = 'paired';
    device.lastSeenAt = new Date(this.now());
    device.updatedAt = new Date(this.now());
    await this.store.save(device);
    const sessionToken = randomBytes(32).toString('base64url');
    await this.sessions.save({
      token: sessionToken,
      deviceId: device.id,
      accountId: device.accountId,
      createdAt: this.now(),
      lastSeenAt: this.now(),
    });
    return { device, sessionToken };
  }

  async activatePairing(pairingCredential: string): Promise<{ device: OwnerDevice; sessionToken: string }> {
    const { code } = parsePairingCredential(pairingCredential);
    const pairing = await this.pairings.getByCode(code);
    if (!pairing) throw new Error('Invalid or expired pairing code');
    return this.activate(pairing.deviceId, code);
  }

  /** Capabilities as measured by the bridge on the Mac itself. */
  async reportHealth(sessionToken: string, capabilities: MessagesCapabilities, bridgeVersion?: string): Promise<OwnerDevice> {
    const device = await this.heartbeat(sessionToken, capabilities);
    if (bridgeVersion && device.bridgeVersion !== bridgeVersion) {
      device.bridgeVersion = bridgeVersion;
      await this.store.save(device);
    }
    return device;
  }

  /** The bridge reports candidate assistant chats it discovered locally (the owner's own threads only). */
  async reportChats(sessionToken: string, chats: MessagesChat[]): Promise<OwnerDevice> {
    const device = await this.requireSession(sessionToken);
    device.discoveredChats = chats
      .filter((chat) => !chat.isGroup)
      .slice(0, 20)
      .map((chat) => ({ id: chat.id, service: chat.service, displayName: chat.displayName, address: chat.address, isGroup: false }));
    if (device.assistantChat && !device.discoveredChats.some((chat) => chat.id === device.assistantChat!.chatId)) {
      device.discoveredChats.push({
        id: device.assistantChat.chatId, service: device.assistantChat.service,
        displayName: device.assistantChat.displayName, address: device.assistantChat.address, isGroup: false,
      });
    }
    device.updatedAt = new Date(this.now());
    this.updateSetupStatus(device);
    await this.store.save(device);
    return device;
  }

  async requestProbe(accountId: string, deviceId: string): Promise<OwnerDevice> {
    const device = await this.store.get(deviceId);
    if (!device || device.accountId !== accountId || device.status !== 'active') throw new Error('Device not found');
    device.probe = { id: `probe_${randomBytes(8).toString('hex')}`, requestedAt: new Date(this.now()).toISOString() };
    device.updatedAt = new Date(this.now());
    await this.store.save(device);
    return device;
  }

  async completeProbe(sessionToken: string, probeId: string, result: Omit<NonNullable<OwnerDeviceProbe['result']>, 'bridgeReachable'>): Promise<OwnerDevice> {
    const device = await this.requireSession(sessionToken);
    if (!device.probe || device.probe.id !== probeId) throw new Error('No such connection test');
    device.probe = { ...device.probe, completedAt: new Date(this.now()).toISOString(), result: { bridgeReachable: true, ...result } };
    device.lastSeenAt = new Date(this.now());
    device.updatedAt = new Date(this.now());
    await this.store.save(device);
    return device;
  }

  async list(accountId: string): Promise<OwnerDevice[]> {
    return this.store.list(accountId);
  }

  async get(deviceId: string): Promise<OwnerDevice | null> {
    return this.store.get(deviceId);
  }

  async revoke(accountId: string, deviceId: string): Promise<void> {
    const device = await this.store.get(deviceId);
    if (!device || device.accountId !== accountId) throw new Error('Device not found');
    device.status = 'revoked';
    device.setupStatus = 'error';
    device.isPrimary = false;
    device.revokedAt = new Date(this.now());
    device.updatedAt = new Date(this.now());
    await this.store.save(device);
    await this.sessions.deleteByDeviceId(deviceId);
    await this.pairings.delete(deviceId);
  }

  async authenticate(sessionToken: string): Promise<OwnerDevice | null> {
    const session = await this.sessions.get(sessionToken);
    if (!session) return null;
    const device = await this.store.get(session.deviceId);
    return device?.status === 'active' ? device : null;
  }

  async heartbeat(sessionToken: string, capabilities: MessagesCapabilities): Promise<OwnerDevice> {
    const device = await this.requireSession(sessionToken);
    device.health = { ...capabilities, authorizedChat: device.assistantChat !== null };
    device.messagesIdentity = capabilities.authorizedIdentity
      ? { accountId: device.accountId, deviceId: device.id, ...capabilities.authorizedIdentity }
      : device.messagesIdentity;
    device.lastSeenAt = new Date(this.now());
    device.updatedAt = new Date(this.now());
    this.updateSetupStatus(device);
    await this.store.save(device);
    await this.sessions.touch(sessionToken, this.now());
    return device;
  }

  async discoverChats(sessionToken: string, adapter: MacMessagesAdapter): Promise<MessagesChat[]> {
    const device = await this.requireSession(sessionToken);
    if (!adapter.discoverChats) throw new Error('Messages chat discovery is unavailable');
    const chats = (await adapter.discoverChats()).map((chat) => ({
      id: chat.id, service: chat.service, displayName: chat.displayName, address: chat.address, isGroup: chat.isGroup,
    }));
    device.discoveredChats = chats;
    device.updatedAt = new Date(this.now());
    device.setupStatus = device.health.messagesAccess
      ? 'awaiting_chat_authorization' : 'awaiting_messages';
    await this.store.save(device);
    return chats;
  }

  async authorizeChat(accountId: string, deviceId: string, chatId: string, service: MessagesService): Promise<OwnerDevice> {
    const device = await this.store.get(deviceId);
    if (!device || device.accountId !== accountId || device.status !== 'active') throw new Error('Device not found');
    const chat = device.discoveredChats.find((candidate) => candidate.id === chatId && candidate.service === service);
    if (!chat || chat.isGroup) throw new Error('Chat was not discovered or is not compatible');
    device.assistantChat = {
      deviceId,
      chatId: chat.id,
      service: chat.service,
      address: chat.address,
      displayName: chat.displayName,
    };
    device.health.authorizedChat = true;
    device.updatedAt = new Date(this.now());
    this.updateSetupStatus(device);
    await this.store.save(device);
    return device;
  }

  async setPrimary(accountId: string, deviceId: string): Promise<OwnerDevice> {
    const device = await this.store.get(deviceId);
    if (!device || device.accountId !== accountId || device.status !== 'active') throw new Error('Device not found');
    if (!this.isReady(device)) throw new Error('Device is not ready');
    for (const candidate of await this.store.list(accountId)) {
      if (candidate.isPrimary && candidate.id !== deviceId) {
        candidate.isPrimary = false;
        candidate.updatedAt = new Date(this.now());
        await this.store.save(candidate);
      }
    }
    device.isPrimary = true;
    device.updatedAt = new Date(this.now());
    await this.store.save(device);
    return device;
  }

  async primary(accountId: string): Promise<OwnerDevice | null> {
    return (await this.store.list(accountId)).find((device) => device.isPrimary && this.isReady(device)) ?? null;
  }

  isReady(device: OwnerDevice): boolean {
    return device.status === 'active' && device.health.messagesAccess &&
      device.health.sendCapability && device.health.watcher &&
      device.messagesIdentity !== null && device.assistantChat !== null;
  }

  private updateSetupStatus(device: OwnerDevice): void {
    device.setupStatus = this.isReady(device) ? 'ready'
      : device.status === 'revoked' ? 'error'
      : device.assistantChat ? 'paired'
      : device.health.messagesAccess ? 'awaiting_chat_authorization' : 'awaiting_messages';
  }

  private async requireSession(sessionToken: string): Promise<OwnerDevice> {
    const device = await this.authenticate(sessionToken);
    if (!device) throw new Error('Device authentication required');
    return device;
  }
}
