import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { FakeMessagingProvider } from '../src/messaging/fake-provider.js';
import { acceptableServer, InMemoryBridgeStateStore, MacBridgeAgent, ownSelfChats } from '../src/owner/bridge-agent.js';
import type { OwnerBridgeCheckpointStore } from '../src/owner/bridge.js';
import { startConnectServer } from '../src/owner/bridge-connect-server.js';
import { OwnerConfigurationService } from '../src/owner/configuration.js';
import { InMemoryOwnerMessageDeliveryStore, QueuedMacMessagesOwnerChannel } from '../src/owner/delivery.js';
import { OwnerDeviceService } from '../src/owner/device.js';
import type { MacMessagesAdapter, MessagesCapabilities, MessagesChat, ObservedMessagesMessage } from '../src/owner/mac-messages-adapter.js';
import { PhotonKitClient, type PhotonSdk } from '../src/owner/photon-kit-client.js';
import { FakeTelephonyProvider } from '../src/telephony/fake-provider.js';
import { TwilioProvider } from '../src/telephony/twilio-provider.js';
import { InMemoryConversationRepository } from './support/in-memory-repository.js';

const OWNER_TOKEN = 'owner-token';
const auth = { Authorization: `Bearer ${OWNER_TOKEN}` };
const PUBLIC_URL = 'https://text-me.vercel.app';

/** A Mac's Messages, as the bridge sees it through the adapter. */
class FakeMessages implements MacMessagesAdapter {
  chats: MessagesChat[] = [
    { id: 'iMessage;-;randy@icloud.example', service: 'imessage', displayName: 'Randy', address: 'randy@icloud.example' },
    { id: 'iMessage;-;+15551230000', service: 'imessage', displayName: 'Jordan', address: '+15551230000' },
    { id: 'any;+;chat99', service: 'imessage', displayName: 'Family', isGroup: true },
  ];
  sent: Array<{ recipient: string; body: string }> = [];
  watching = 0;
  starts = 0;
  handler?: (message: ObservedMessagesMessage) => Promise<void>;
  async send(input: { recipient: string; body: string }) {
    this.sent.push(input);
    return { providerRequestId: `req-${this.sent.length}` };
  }
  async watch(handler: (message: ObservedMessagesMessage) => Promise<void>) {
    this.watching += 1;
    this.starts += 1;
    this.handler = handler;
    return async () => { this.watching -= 1; this.handler = undefined; };
  }
  async discoverChats() { return this.chats; }
  async checkCapabilities(): Promise<MessagesCapabilities> {
    return { messagesAccess: true, sendCapability: true, watcher: false, authorizedIdentity: { service: 'imessage', address: 'randy@icloud.example' } };
  }
}

class MemoryCheckpoint implements OwnerBridgeCheckpointStore {
  cursor?: string;
  async load() { return this.cursor; }
  async save(cursor: string) { this.cursor = cursor; }
}

async function backend() {
  const repository = new InMemoryConversationRepository();
  const configuration = new OwnerConfigurationService();
  const devices = new OwnerDeviceService();
  const macDeliveries = new InMemoryOwnerMessageDeliveryStore();
  const app = createApp({
    repository,
    ownerAuthToken: OWNER_TOKEN,
    messagingProvider: new FakeMessagingProvider(),
    ownerConfigurationService: configuration,
    ownerDeviceService: devices,
    ownerDeliveryStore: macDeliveries,
    ownerChannel: new QueuedMacMessagesOwnerChannel(macDeliveries, devices, configuration),
    publicBaseUrl: PUBLIC_URL,
    providers: [new TwilioProvider({ mediaStreamUrl: 'wss://example.test/media-stream' }), new FakeTelephonyProvider()],
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const calls: string[] = [];
  // The QR names the production origin; route it to this test server.
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    return fetch(`${local}${url.pathname}${url.search}`, init);
  };
  return { app, server, configuration, devices, macDeliveries, fetcher, calls };
}

function agentFor(fetcher: typeof fetch, messages = new FakeMessages(), store = new InMemoryBridgeStateStore()) {
  const agent = new MacBridgeAgent({
    adapter: messages, store, checkpoint: new MemoryCheckpoint(), bridgeVersion: '1.0.0', fetch: fetcher,
    heartbeatIntervalMs: 0, chatDiscoveryIntervalMs: 0,
  });
  return { agent, messages, store };
}

test('scanning the QR connects the Mac with nothing typed, and only the owner’s own thread leaves the Mac', async (t) => {
  const plane = await backend();
  t.after(() => plane.server.close());
  const { agent, store } = agentFor(plane.fetcher);
  await agent.start();
  assert.equal(agent.status().phase, 'waiting_for_qr');

  const qr = await request(plane.app).post('/owner/devices/pair/qr').set(auth).send({ name: 'MacBook Pro' });
  // The iPhone polls while it shows the code.
  assert.equal((await request(plane.app).get(`/owner/devices/pair/${qr.body.deviceId}`).set(auth)).body.status, 'pending');

  const status = await agent.connect(qr.body.pairingUri);
  assert.equal(status.phase, 'connected');
  assert.equal(status.server, 'text-me.vercel.app', 'the backend came from the QR');
  const saved = await store.load();
  assert.deepEqual(Object.keys(saved!).sort(), ['deviceId', 'serverUrl', 'sessionToken'], 'the Mac stores only its own credential and endpoint');
  assert.equal(saved!.serverUrl, `${PUBLIC_URL}/`);

  // The iPhone sees the Mac connected, healthy, and its own thread offered as the assistant chat.
  const polled = await request(plane.app).get(`/owner/devices/pair/${qr.body.deviceId}`).set(auth);
  assert.equal(polled.body.status, 'active');
  const [device] = (await request(plane.app).get('/owner/devices').set(auth)).body;
  assert.equal(device.online, true);
  assert.equal(device.bridgeVersion, '1.0.0');
  assert.equal(device.health.messagesAccess, true);
  assert.deepEqual(device.discoveredChats.map((chat: MessagesChat) => chat.id), ['iMessage;-;randy@icloud.example'],
    'contacts and group chats never reach the backend');

  // The code is spent: a second Mac can't reuse it.
  const other = agentFor(plane.fetcher);
  await other.agent.start();
  const reused = await other.agent.connect(qr.body.pairingUri);
  assert.equal(reused.phase, 'waiting_for_qr');
  assert.match(reused.error!, /expired or was already used/);
});

test('the Mac follows the owner’s settings by revision: chat choice, channel toggle and test connection', async (t) => {
  const plane = await backend();
  t.after(() => plane.server.close());
  const { agent, messages } = agentFor(plane.fetcher);
  await agent.start();
  const qr = await request(plane.app).post('/owner/devices/pair/qr').set(auth).send({});
  await agent.connect(qr.body.pairingUri);
  const deviceId = qr.body.deviceId as string;
  assert.equal(messages.watching, 0, 'nothing is watched before the owner picks a chat');

  // The owner picks the chat on the iPhone; the Mac starts watching on its next sync.
  await request(plane.app).post(`/owner/devices/${deviceId}/messages/chat`).set(auth)
    .send({ chatId: 'iMessage;-;randy@icloud.example', service: 'imessage' });
  await agent.tick();
  assert.equal(messages.watching, 1);
  assert.equal(agent.status().watcher, true);
  const revision = agent.status().revision!;
  const [healthy] = (await request(plane.app).get('/owner/devices').set(auth)).body;
  assert.equal(healthy.health.watcher, true, 'the iPhone sees the watcher running');

  // Turning Apple Messages off stops the watcher, without restarting the bridge.
  const off = await request(plane.app).patch('/owner/configuration').set(auth).send({ messages: { macosMessagesEnabled: false } });
  assert.equal(off.status, 200);
  await agent.tick();
  assert.equal(messages.watching, 0);
  assert.ok(agent.status().revision! > revision);
  const [stopped] = (await request(plane.app).get('/owner/devices').set(auth)).body;
  assert.equal(stopped.health.watcher, false);
  // Deliveries wait while the channel is off.
  const queued = await plane.macDeliveries.create({ ownerId: 'owner', deviceId, conversationId: 'conv-1', messageId: 'msg-1', body: 'Jordan is waiting' });
  await agent.tick();
  assert.equal(messages.sent.length, 0);

  // Back on: same process, watcher resumes and the waiting message goes out.
  await request(plane.app).patch('/owner/configuration').set(auth).send({ messages: { macosMessagesEnabled: true } });
  await agent.tick();
  assert.equal(messages.watching, 1);
  assert.equal(messages.starts, 2);
  assert.deepEqual(messages.sent, [{ recipient: 'randy@icloud.example', body: 'Jordan is waiting' }]);
  await messages.handler!({
    externalId: 'req-1', chatId: 'iMessage;-;randy@icloud.example', sender: 'randy@icloud.example',
    body: 'Jordan is waiting', direction: 'outgoing', observedAt: new Date(),
  });
  assert.ok(plane.calls.includes(`POST /owner/devices/${deviceId}/deliveries/${queued.id}/requested`));
  assert.ok(plane.calls.includes(`POST /owner/devices/${deviceId}/deliveries/${queued.id}/observed`), 'delivery confirmed once it lands in Messages');
  assert.deepEqual(await plane.macDeliveries.listPending(deviceId), []);

  // Test connection: answered by the Mac, and nothing visible is sent.
  const sentBefore = messages.sent.length;
  const probe = await request(plane.app).post(`/owner/devices/${deviceId}/test`).set(auth);
  assert.equal(probe.status, 202);
  await agent.tick();
  const [tested] = (await request(plane.app).get('/owner/devices').set(auth)).body;
  assert.deepEqual(tested.probe.result, { bridgeReachable: true, messagesAccess: true, sendCapability: true, watcher: true, assistantChatFound: true });
  assert.equal(messages.sent.length, sentBefore);
  assert.ok(!plane.calls.some((call) => call.startsWith('PATCH') || call.includes('/configuration') && call.startsWith('POST')),
    'the Mac never writes owner configuration');
});

test('revoking the Mac sends it back to the scanner, and a new QR reconnects it', async (t) => {
  const plane = await backend();
  t.after(() => plane.server.close());
  const { agent, messages, store } = agentFor(plane.fetcher);
  await agent.start();
  const qr = await request(plane.app).post('/owner/devices/pair/qr').set(auth).send({});
  await agent.connect(qr.body.pairingUri);
  await request(plane.app).post(`/owner/devices/${qr.body.deviceId}/messages/chat`).set(auth)
    .send({ chatId: 'iMessage;-;randy@icloud.example', service: 'imessage' });
  await agent.tick();
  assert.equal(messages.watching, 1);

  assert.equal((await request(plane.app).post(`/owner/devices/${qr.body.deviceId}/revoke`).set(auth)).status, 204);
  await agent.tick();
  assert.equal(agent.status().phase, 'waiting_for_qr');
  assert.match(agent.status().error!, /disconnected/);
  assert.equal(messages.watching, 0, 'a revoked Mac stops watching Messages');
  assert.equal(await store.load(), null, 'the old credential is forgotten');

  const fresh = await request(plane.app).post('/owner/devices/pair/qr').set(auth).send({});
  assert.equal((await agent.connect(fresh.body.pairingUri)).phase, 'connected');
  const devices = (await request(plane.app).get('/owner/devices').set(auth)).body as Array<{ id: string; status: string }>;
  assert.equal(devices.find((device) => device.id === fresh.body.deviceId)!.status, 'active');
});

test('the QR is only trusted to name an https backend', () => {
  assert.equal(acceptableServer('https://text-me.vercel.app/x')!.toString(), 'https://text-me.vercel.app/');
  assert.equal(acceptableServer('http://evil.example'), null);
  assert.equal(acceptableServer('https://user:pw@text-me.vercel.app'), null);
  assert.equal(acceptableServer('javascript:alert(1)'), null);
  assert.ok(acceptableServer('http://localhost:3000'));
  assert.deepEqual(ownSelfChats([
    { id: 'a', service: 'sms', address: '+1 (555) 000-1111' },
    { id: 'b', service: 'sms', address: '+15550002222' },
  ], ['+15550001111']).map((chat) => chat.id), ['a']);
});

test('the local Connect page only answers loopback requests that carry its launch key', async (t) => {
  const connects: string[] = [];
  const page = await startConnectServer({
    status: () => ({ phase: 'waiting_for_qr', messagesEnabled: false, assistantChat: false, watcher: false }),
    connect: async (payload) => {
      connects.push(payload);
      return { phase: 'connected', messagesEnabled: true, assistantChat: false, watcher: false };
    },
  });
  t.after(() => page.close());
  const url = new URL(page.url);
  const key = url.searchParams.get('key')!;
  assert.equal(url.hostname, '127.0.0.1');

  const html = await fetch(page.url);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Connect this Mac/);
  assert.equal((await fetch(`${url.origin}/`)).status, 403, 'no key, no page');
  assert.equal((await fetch(`${url.origin}/api/connect`, { method: 'POST', body: '{"payload":"attn://pair/x"}' })).status, 403,
    'a website cannot pair this Mac');
  assert.equal((await fetch(`${url.origin}/jsQR.js`)).status, 200);

  const connected = await fetch(`${url.origin}/api/connect`, {
    method: 'POST', headers: { 'X-Bridge-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: 'attn://pair/abc?s=https%3A%2F%2Ftext-me.vercel.app' }),
  });
  assert.equal((await connected.json()).phase, 'connected');
  assert.deepEqual(connects, ['attn://pair/abc?s=https%3A%2F%2Ftext-me.vercel.app']);

  // DNS rebinding: a foreign Host header is refused even with the key.
  const rebound = await new Promise<number>((resolve) => {
    import('node:http').then(({ request: send }) => {
      const outgoing = send({ host: '127.0.0.1', port: url.port, path: '/api/status', headers: { Host: 'evil.example', 'X-Bridge-Key': key } },
        (response) => { response.resume(); resolve(response.statusCode!); });
      outgoing.end();
    });
  });
  assert.equal(rebound, 403);
});

test('Photon binding: own sends are correlated, echoes are dropped, and owner notes-to-self are replies', async () => {
  const rows: Array<(message: Parameters<NonNullable<Parameters<PhotonSdk['startWatching']>[0]['onIncomingMessage']>>[0]) => void | Promise<void>> = [];
  const sdk: PhotonSdk = {
    send: async () => undefined,
    listChats: async () => [{ chatId: 'iMessage;-;randy@icloud.example', name: null, service: 'iMessage', kind: 'dm', account: 'e:randy@icloud.example' }],
    startWatching: async (events) => { rows.push(events.onIncomingMessage!, events.onFromMeMessage!); },
    stopWatching: async () => undefined,
  };
  const client = new PhotonKitClient(sdk, 'darwin');
  const capabilities = await client.checkCapabilities();
  assert.deepEqual(capabilities.authorizedIdentity, { address: 'randy@icloud.example', service: 'imessage' });
  const seen: ObservedMessagesMessage[] = [];
  await client.watch(async (message) => { seen.push(message); });
  const [incoming, fromMe] = rows;
  const row = (id: string, text: string, isFromMe: boolean, rowId: number) => ({
    rowId, id, chatId: 'iMessage;-;randy@icloud.example', participant: 'randy@icloud.example', service: 'iMessage' as const,
    text, isFromMe, createdAt: new Date(),
  });

  const { requestId } = await client.sendMessage({ recipient: 'randy@icloud.example', body: 'Jordan is waiting' });
  await fromMe(row('g1', 'Jordan is waiting', true, 1));
  await incoming(row('g2', 'Jordan is waiting', false, 2));
  await fromMe(row('g3', 'Friday at 2 works', true, 3));
  await incoming(row('g4', 'Friday at 2 works', false, 4));
  assert.deepEqual(seen.map(({ externalId, direction, body, sender }) => ({ externalId, direction, body, sender })), [
    { externalId: requestId, direction: 'outgoing', body: 'Jordan is waiting', sender: 'randy@icloud.example' },
    { externalId: 'g3', direction: 'incoming', body: 'Friday at 2 works', sender: 'randy@icloud.example' },
  ]);
  assert.deepEqual(await new PhotonKitClient(sdk, 'linux').checkCapabilities().then((value) => value.messagesAccess), false);
});
