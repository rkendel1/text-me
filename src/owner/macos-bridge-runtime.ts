import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { FileOwnerBridgeCheckpointStore, MacOSMessagesBridge } from './bridge.js';
import { PhotonIMessageKitAdapter, type PhotonIMessageKitClient } from './photon-imessage-adapter.js';

interface RuntimeState {
  deviceId?: string;
  sessionToken?: string;
}

class BackendOwnerBridgeClient {
  constructor(private readonly backendUrl: string, private readonly getSession: () => RuntimeState) {}

  async activate(pairingCredential: string): Promise<{ deviceId: string; sessionToken: string }> {
    const response = await fetch(this.url('/owner/devices/activate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCredential }),
    });
    if (!response.ok) throw new Error(`Activation failed: ${response.status}`);
    const body = await response.json() as { device: { id: string }; sessionToken: string };
    return { deviceId: body.device.id, sessionToken: body.sessionToken };
  }

  async deviceStatus(deviceId: string): Promise<any> {
    const response = await fetch(this.url(`/owner/devices/${deviceId}/status`), { headers: this.headers() });
    if (!response.ok) throw new Error(`Device status failed: ${response.status}`);
    return response.json();
  }

  async heartbeat(deviceId: string): Promise<any> {
    const response = await fetch(this.url(`/owner/devices/${deviceId}/heartbeat`), {
      method: 'POST',
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`Heartbeat failed: ${response.status}`);
    return response.json();
  }

  async discoverChats(deviceId: string): Promise<void> {
    const response = await fetch(this.url(`/owner/devices/${deviceId}/messages/chats`), { headers: this.headers() });
    if (!response.ok && response.status !== 501) throw new Error(`Chat discovery failed: ${response.status}`);
  }

  async deliveries(deviceId: string): Promise<Array<{ id: string; body: string }>> {
    const response = await fetch(this.url(`/owner/devices/${deviceId}/deliveries`), { headers: this.headers() });
    if (!response.ok) throw new Error(`Delivery fetch failed: ${response.status}`);
    return response.json();
  }

  async markRequested(deviceId: string, deliveryId: string, providerRequestId: string): Promise<void> {
    const response = await fetch(this.url(`/owner/devices/${deviceId}/deliveries/${deliveryId}/requested`), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerRequestId }),
    });
    if (!response.ok) throw new Error(`Delivery request update failed: ${response.status}`);
  }

  async markObserved(deviceId: string, deliveryId: string, externalId: string): Promise<void> {
    const response = await fetch(this.url(`/owner/devices/${deviceId}/deliveries/${deliveryId}/observed`), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ externalId }),
    });
    if (!response.ok) throw new Error(`Delivery observe update failed: ${response.status}`);
  }

  async markFailed(deviceId: string, deliveryId: string, error: string): Promise<void> {
    const response = await fetch(this.url(`/owner/devices/${deviceId}/deliveries/${deliveryId}/failed`), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error }),
    });
    if (!response.ok) throw new Error(`Delivery failure update failed: ${response.status}`);
  }

  async submitReply(deviceId: string, externalId: string, body: string, deliveryId?: string, replyToExternalId?: string): Promise<void> {
    const response = await fetch(this.url(`/owner/devices/${deviceId}/messages/replies`), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ externalId, body, deliveryId, replyToExternalId }),
    });
    if (!response.ok) throw new Error(`Owner reply submit failed: ${response.status}`);
  }

  private headers(): HeadersInit {
    const session = this.getSession();
    return session.sessionToken ? { Authorization: 'Bearer ' + session.sessionToken } : {};
  }

  private url(path: string): string {
    return new URL(path, this.backendUrl).toString();
  }
}

async function loadState(path: string): Promise<RuntimeState> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RuntimeState;
  } catch {
    return {};
  }
}

async function saveState(path: string, state: RuntimeState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state), 'utf8');
}

async function loadPhotonClient(modulePath: string): Promise<PhotonIMessageKitClient> {
  const loaded = await import(resolve(modulePath));
  if (typeof loaded.createPhotonClient === 'function') return loaded.createPhotonClient();
  if (typeof loaded.default === 'function') return new loaded.default();
  if (loaded.default && typeof loaded.default === 'object') return loaded.default as PhotonIMessageKitClient;
  throw new Error('Photon client module must export createPhotonClient(), a default class, or a default client object');
}

async function main(): Promise<void> {
  const backendUrl = process.env.BACKEND_URL;
  const photonModule = process.env.PHOTON_CLIENT_MODULE;
  const statePath = process.env.MAC_BRIDGE_STATE_PATH ?? '/tmp/text-me-mac-bridge/state.json';
  const checkpointPath = process.env.MAC_BRIDGE_CHECKPOINT_PATH ?? '/tmp/text-me-mac-bridge/checkpoint.json';
  const pairingCredential = process.env.PAIRING_CREDENTIAL ?? process.env.PAIRING_URI;
  const pollMs = Number(process.env.MAC_BRIDGE_POLL_MS ?? '5000');
  if (!backendUrl) throw new Error('BACKEND_URL is required');
  if (!photonModule) throw new Error('PHOTON_CLIENT_MODULE is required');

  const state = await loadState(statePath);
  const backend = new BackendOwnerBridgeClient(backendUrl, () => state);
  if (!state.deviceId || !state.sessionToken) {
    if (!pairingCredential) throw new Error('PAIRING_CREDENTIAL is required on first boot');
    Object.assign(state, await backend.activate(pairingCredential));
    await saveState(statePath, state);
  }

  const adapter = new PhotonIMessageKitAdapter(await loadPhotonClient(photonModule));
  const checkpoint = new FileOwnerBridgeCheckpointStore(checkpointPath);
  let bridge: MacOSMessagesBridge | undefined;
  let currentChatId: string | undefined;

  while (true) {
    const device = await backend.heartbeat(state.deviceId!);
    if (!device.assistantChat) {
      await backend.discoverChats(state.deviceId!);
      await sleep(pollMs);
      continue;
    }

    if (!bridge || currentChatId !== device.assistantChat.chatId) {
      await bridge?.stop();
      currentChatId = device.assistantChat.chatId;
      bridge = new MacOSMessagesBridge(adapter, {
        async submitOwnerMessage(input) {
          await backend.submitReply(state.deviceId!, input.externalId, input.body, input.deliveryId, input.replyToExternalId);
        },
        async confirmOwnerDelivery(input) {
          await backend.markObserved(state.deviceId!, input.deliveryId, input.externalId);
        },
      }, {
        ownerId: device.ownerId,
        deviceId: device.id,
        assistantChatId: device.assistantChat.chatId,
        ownerSender: device.messagesIdentity?.address ?? process.env.OWNER_SENDER ?? '',
        checkpoint,
      });
      await bridge.start();
    }

    const deliveries = await backend.deliveries(state.deviceId!);
    for (const delivery of deliveries) {
      try {
        const result = await adapter.send({
          recipient: device.assistantChat.address ?? device.assistantChat.chatId,
          body: delivery.body,
        });
        if (!result.providerRequestId) throw new Error('Messages adapter did not return a providerRequestId');
        await backend.markRequested(state.deviceId!, delivery.id, result.providerRequestId);
        bridge.trackDelivery(delivery.id, result.providerRequestId);
      } catch (error) {
        await backend.markFailed(state.deviceId!, delivery.id, error instanceof Error ? error.message : 'Delivery failed');
      }
    }
    await sleep(pollMs);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
