import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { MacOSMessagesBridge, type OwnerBridgeCheckpointStore } from './bridge.js';
import { parsePairingCredential } from './device.js';
import type { MacMessagesAdapter, MessagesCapabilities, MessagesChat } from './mac-messages-adapter.js';

/**
 * Everything the Mac keeps locally: its own device credential, the backend it
 * belongs to, and nothing else. Owner configuration always comes from the server.
 */
export interface BridgeState {
  serverUrl: string;
  deviceId: string;
  sessionToken: string;
}

export interface BridgeStateStore {
  load(): Promise<BridgeState | null>;
  save(state: BridgeState): Promise<void>;
  clear(): Promise<void>;
}

export class FileBridgeStateStore implements BridgeStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<BridgeState | null> {
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8')) as Partial<BridgeState>;
      return state.serverUrl && state.deviceId && state.sessionToken ? state as BridgeState : null;
    } catch {
      return null;
    }
  }

  async save(state: BridgeState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

export class InMemoryBridgeStateStore implements BridgeStateStore {
  private state: BridgeState | null = null;
  async load() { return this.state ? { ...this.state } : null; }
  async save(state: BridgeState) { this.state = { ...state }; }
  async clear() { this.state = null; }
}

/** What the local Connect page shows. */
export type BridgePhase = 'waiting_for_qr' | 'connecting' | 'connected';

export interface BridgeStatus {
  phase: BridgePhase;
  /** Plain-language problem, for the Connect page. */
  error?: string;
  server?: string;
  messagesEnabled: boolean;
  assistantChat: boolean;
  watcher: boolean;
  revision?: number;
  lastSyncAt?: string;
}

/** The device credential no longer works: revoked, or the owner re-paired elsewhere. */
export class DeviceDisconnectedError extends Error {}

interface DeviceConfiguration {
  deviceId: string;
  ownerId: string;
  revision: number;
  bridge: {
    messagesChannelEnabled: boolean;
    assistantChat: { chatId: string; service: string; address?: string; displayName?: string } | null;
    ownerIdentity: string | null;
    needsChatDiscovery: boolean;
    pendingProbe: { id: string } | null;
  };
}

/** Only https backends, except a backend on this machine (development). */
export function acceptableServer(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  if (url.username || url.password) return null;
  return new URL(url.origin);
}

const normalizeAddress = (address: string): string => {
  const trimmed = address.trim().toLowerCase().replace(/^(e|p|tel|mailto):/, '');
  return trimmed.includes('@') ? trimmed : trimmed.replace(/[^\d+]/g, '');
};

/**
 * The assistant chat is the owner's own thread (a note to themselves). Nothing
 * else about the owner's Messages ever leaves the Mac.
 */
export function ownSelfChats(chats: MessagesChat[], identities: string[]): MessagesChat[] {
  const own = new Set(identities.filter(Boolean).map(normalizeAddress));
  return chats
    .filter((chat) => !chat.isGroup && chat.address && own.has(normalizeAddress(chat.address)))
    .map(({ id, service, displayName, address }) => ({ id, service, displayName, address, isGroup: false }));
}

class DeviceClient {
  constructor(private readonly state: BridgeState, private readonly fetcher: typeof fetch) {}

  heartbeat(capabilities: MessagesCapabilities, bridgeVersion: string) {
    return this.request('POST', 'heartbeat', { capabilities, bridgeVersion });
  }

  configuration(): Promise<DeviceConfiguration> {
    return this.request('GET', 'configuration') as Promise<DeviceConfiguration>;
  }

  reportChats(chats: MessagesChat[]) {
    return this.request('POST', 'messages/chats', { chats });
  }

  completeProbe(probeId: string, result: Record<string, boolean>) {
    return this.request('POST', `probe/${encodeURIComponent(probeId)}`, result);
  }

  deliveries(): Promise<Array<{ id: string; body: string }>> {
    return this.request('GET', 'deliveries') as Promise<Array<{ id: string; body: string }>>;
  }

  markRequested(deliveryId: string, providerRequestId: string) {
    return this.request('POST', `deliveries/${deliveryId}/requested`, { providerRequestId });
  }

  markObserved(deliveryId: string, externalId: string) {
    return this.request('POST', `deliveries/${deliveryId}/observed`, { externalId });
  }

  markFailed(deliveryId: string, error: string) {
    return this.request('POST', `deliveries/${deliveryId}/failed`, { error });
  }

  submitReply(input: { externalId: string; body: string; deliveryId?: string; replyToExternalId?: string }) {
    return this.request('POST', 'messages/replies', input);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const url = new URL(`/owner/devices/${encodeURIComponent(this.state.deviceId)}/${path}`, this.state.serverUrl);
    const response = await this.fetcher(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.state.sessionToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) throw new DeviceDisconnectedError('This Mac is no longer connected');
    if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status}`);
    return response.json();
  }
}

export interface MacBridgeAgentOptions {
  adapter: MacMessagesAdapter;
  store: BridgeStateStore;
  checkpoint: OwnerBridgeCheckpointStore;
  bridgeVersion: string;
  fetch?: typeof fetch;
  now?: () => number;
  heartbeatIntervalMs?: number;
  chatDiscoveryIntervalMs?: number;
  log?: (message: string, error?: unknown) => void;
}

/**
 * The Mac is an executor. It pairs by scanning a QR code, then follows the
 * owner's configuration by revision: it never edits configuration, and the
 * owner never edits anything on the Mac.
 */
export class MacBridgeAgent {
  private state: BridgeState | null = null;
  private client?: DeviceClient;
  private phase: BridgePhase = 'waiting_for_qr';
  private error?: string;
  private config?: DeviceConfiguration;
  private bridge?: MacOSMessagesBridge;
  private watchedChatId?: string;
  private lastHeartbeat = 0;
  private lastChatReport = 0;
  private lastSyncAt?: number;
  private busy?: Promise<void>;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: MacBridgeAgentOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): BridgeStatus {
    return {
      phase: this.phase,
      ...(this.error ? { error: this.error } : {}),
      ...(this.state ? { server: new URL(this.state.serverUrl).host } : {}),
      messagesEnabled: this.config?.bridge.messagesChannelEnabled ?? false,
      assistantChat: Boolean(this.config?.bridge.assistantChat),
      watcher: Boolean(this.bridge),
      ...(this.config ? { revision: this.config.revision } : {}),
      ...(this.lastSyncAt ? { lastSyncAt: new Date(this.lastSyncAt).toISOString() } : {}),
    };
  }

  async start(): Promise<void> {
    this.state = await this.options.store.load();
    if (this.state) {
      this.client = new DeviceClient(this.state, this.fetcher);
      this.setPhase('connected');
    } else {
      this.setPhase('waiting_for_qr');
    }
  }

  /** Called with the scanned QR payload: attn://pair/<code>?s=<server>. */
  async connect(payload: string): Promise<BridgeStatus> {
    if (this.phase === 'connected') return this.status();
    const { code, server } = parsePairingCredential(payload);
    const origin = server ? acceptableServer(server) : null;
    if (!/^attn:\/\/pair\//.test(payload.trim()) || !origin) {
      this.setPhase('waiting_for_qr', 'That isn’t a pairing code. Scan the code shown on your iPhone.');
      return this.status();
    }
    this.setPhase('connecting');
    try {
      const response = await this.fetcher(new URL('/owner/devices/activate', origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingCredential: `attn://pair/${code}` }),
      });
      if (!response.ok) {
        this.setPhase('waiting_for_qr', response.status === 401
          ? 'That code has expired or was already used. Show a new code on your iPhone.'
          : 'Couldn’t reach your account. Check your connection and try again.');
        return this.status();
      }
      const body = await response.json() as { device: { id: string }; sessionToken: string };
      this.state = { serverUrl: origin.toString(), deviceId: body.device.id, sessionToken: body.sessionToken };
      await this.options.store.save(this.state);
      this.client = new DeviceClient(this.state, this.fetcher);
      this.lastHeartbeat = 0;
      this.lastChatReport = 0;
      this.setPhase('connected');
      await this.tick();
    } catch (error) {
      this.options.log?.('Pairing failed', error);
      if (this.phase === 'connecting') {
        this.setPhase('waiting_for_qr', 'Couldn’t reach your account. Check your connection and try again.');
      }
    }
    return this.status();
  }

  /** One sync pass. Serialized: a slow pass is never overlapped by the next. */
  tick(): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.sync().finally(() => { this.busy = undefined; });
    return this.busy;
  }

  async stop(): Promise<void> {
    await this.bridge?.stop();
    this.bridge = undefined;
    this.watchedChatId = undefined;
  }

  private async sync(): Promise<void> {
    const client = this.client;
    if (this.phase !== 'connected' || !client) return;
    try {
      const capabilities = await this.capabilities();
      const heartbeatInterval = this.options.heartbeatIntervalMs ?? 30_000;
      if (this.now() - this.lastHeartbeat >= heartbeatInterval) {
        await client.heartbeat(capabilities, this.options.bridgeVersion);
        this.lastHeartbeat = this.now();
      }
      const config = await client.configuration();
      const changed = !this.config || this.config.revision !== config.revision ||
        this.config.bridge.assistantChat?.chatId !== config.bridge.assistantChat?.chatId;
      this.config = config;
      if (config.bridge.needsChatDiscovery &&
        this.now() - this.lastChatReport >= (this.options.chatDiscoveryIntervalMs ?? 60_000)) {
        await client.reportChats(await this.selfChats(capabilities, config));
        this.lastChatReport = this.now();
      }
      if (changed) {
        await this.apply(config, capabilities);
        // Report the watcher's new state right away, so the iPhone shows it.
        if (Boolean(this.bridge) !== capabilities.watcher) {
          await client.heartbeat({ ...capabilities, watcher: Boolean(this.bridge) }, this.options.bridgeVersion);
          this.lastHeartbeat = this.now();
        }
      }
      if (config.bridge.pendingProbe) await this.answerProbe(client, config, capabilities);
      if (this.bridge) await this.deliver(client, config);
      this.lastSyncAt = this.now();
      this.error = undefined;
      this.emit();
    } catch (error) {
      if (error instanceof DeviceDisconnectedError) {
        await this.disconnect();
        return;
      }
      this.options.log?.('Sync failed', error);
      this.error = 'Can’t reach your account right now. Retrying…';
      this.emit();
    }
  }

  /** Follow the configuration: the Messages watcher runs only while the channel is enabled. */
  private async apply(config: DeviceConfiguration, capabilities: MessagesCapabilities): Promise<void> {
    const chat = config.bridge.assistantChat;
    const ownerSender = config.bridge.ownerIdentity ?? capabilities.authorizedIdentity?.address;
    const shouldWatch = config.bridge.messagesChannelEnabled && Boolean(chat) && Boolean(ownerSender);
    if (!shouldWatch) {
      await this.stop();
      return;
    }
    if (this.bridge && this.watchedChatId === chat!.chatId) return;
    await this.stop();
    const client = this.client!;
    const bridge = new MacOSMessagesBridge(this.options.adapter, {
      submitOwnerMessage: (input) => client.submitReply(input).then(() => undefined),
      confirmOwnerDelivery: (input) => client.markObserved(input.deliveryId, input.externalId).then(() => undefined),
    }, {
      ownerId: config.ownerId,
      deviceId: config.deviceId,
      assistantChatId: chat!.chatId,
      ownerSender: ownerSender!,
      checkpoint: this.options.checkpoint,
    });
    await bridge.start();
    this.bridge = bridge;
    this.watchedChatId = chat!.chatId;
  }

  private async deliver(client: DeviceClient, config: DeviceConfiguration): Promise<void> {
    const chat = config.bridge.assistantChat;
    if (!chat || !config.bridge.messagesChannelEnabled) return;
    for (const delivery of await client.deliveries()) {
      try {
        const result = await this.options.adapter.send({ recipient: chat.address ?? chat.chatId, body: delivery.body });
        if (!result.providerRequestId) throw new Error('Messages did not confirm the send');
        await client.markRequested(delivery.id, result.providerRequestId);
        this.bridge?.trackDelivery(delivery.id, result.providerRequestId);
      } catch (error) {
        if (error instanceof DeviceDisconnectedError) throw error;
        await client.markFailed(delivery.id, error instanceof Error ? error.message : 'Delivery failed');
      }
    }
  }

  /** Test connection: checked locally, reported back, and nothing visible is sent. */
  private async answerProbe(client: DeviceClient, config: DeviceConfiguration, capabilities: MessagesCapabilities): Promise<void> {
    const chatId = config.bridge.assistantChat?.chatId;
    let assistantChatFound = false;
    if (chatId && capabilities.messagesAccess && this.options.adapter.discoverChats) {
      assistantChatFound = (await this.options.adapter.discoverChats().catch(() => [])).some((chat) => chat.id === chatId);
    }
    await client.completeProbe(config.bridge.pendingProbe!.id, {
      messagesAccess: capabilities.messagesAccess,
      sendCapability: capabilities.sendCapability,
      watcher: Boolean(this.bridge),
      assistantChatFound,
    });
  }

  private async selfChats(capabilities: MessagesCapabilities, config: DeviceConfiguration): Promise<MessagesChat[]> {
    if (!capabilities.messagesAccess || !this.options.adapter.discoverChats) return [];
    const identities = [capabilities.authorizedIdentity?.address, config.bridge.ownerIdentity].filter((value): value is string => Boolean(value));
    return ownSelfChats(await this.options.adapter.discoverChats(), identities);
  }

  private async capabilities(): Promise<MessagesCapabilities> {
    try {
      const measured = this.options.adapter.checkCapabilities
        ? await this.options.adapter.checkCapabilities()
        : { messagesAccess: false, sendCapability: false, watcher: false, error: 'Messages is unavailable' };
      return { ...measured, watcher: Boolean(this.bridge) };
    } catch (error) {
      return {
        messagesAccess: false, sendCapability: false, watcher: Boolean(this.bridge),
        error: error instanceof Error ? error.message : 'Messages is unavailable',
      };
    }
  }

  /** Revoked (or replaced): forget the credential and go back to showing the QR scanner. */
  private async disconnect(): Promise<void> {
    await this.stop();
    await this.options.store.clear();
    this.state = null;
    this.client = undefined;
    this.config = undefined;
    this.setPhase('waiting_for_qr', 'This Mac was disconnected from your account. Scan a new code to reconnect.');
  }

  private setPhase(phase: BridgePhase, error?: string): void {
    this.phase = phase;
    this.error = error;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
