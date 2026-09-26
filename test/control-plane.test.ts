import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import request from 'supertest';
import WebSocket from 'ws';

import { createApp } from '../src/http-app.js';
import { InMemoryNotificationDeliveryStore, InMemoryOwnerAttentionStore } from '../src/attention/stores.js';
import type { PushSender } from '../src/attention/surfaces.js';
import { FakeMessagingProvider } from '../src/messaging/fake-provider.js';
import { OwnerConfigurationService } from '../src/owner/configuration.js';
import { InMemoryOwnerMessageDeliveryStore, QueuedMacMessagesOwnerChannel } from '../src/owner/delivery.js';
import { OwnerDeviceService, PAIRING_TTL_MS, parsePairingCredential } from '../src/owner/device.js';
import { FakeTelephonyProvider } from '../src/telephony/fake-provider.js';
import { TwilioProvider } from '../src/telephony/twilio-provider.js';
import type {
  RealtimeClientEvent,
  RealtimeConnection,
  RealtimeConnectionHandlers,
  RealtimeConnector,
  RealtimeServerEvent,
  RealtimeSessionConfig,
} from '../src/voice/realtime/connector.js';
import { MEDIA_STREAM_PATH, RealtimeVoiceService } from '../src/voice/realtime/realtime-voice.js';
import { InMemoryConversationRepository } from './support/in-memory-repository.js';

const OWNER_TOKEN = 'owner-token';
const auth = { Authorization: `Bearer ${OWNER_TOKEN}` };
const MAC_CAPABILITIES = {
  messagesAccess: true, sendCapability: true, watcher: true,
  authorizedIdentity: { service: 'imessage', address: 'randy@icloud.example' },
};

class Connector implements RealtimeConnector {
  readonly modelId = 'openai/gpt-realtime-2';
  configs: RealtimeSessionConfig[] = [];
  sent: RealtimeClientEvent[] = [];
  private handlers?: RealtimeConnectionHandlers;
  async connect(config: RealtimeSessionConfig, handlers: RealtimeConnectionHandlers): Promise<RealtimeConnection> {
    this.configs.push(config);
    this.handlers = handlers;
    return { send: async (event) => { this.sent.push(event); }, close: () => undefined };
  }
  emit(event: Record<string, unknown>) { this.handlers!.onEvent({ raw: {}, ...event } as RealtimeServerEvent); }
}

async function eventually(check: () => boolean | Promise<boolean>, what: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

function controlPlane(options: { now?: () => number } = {}) {
  const repository = new InMemoryConversationRepository();
  const configuration = new OwnerConfigurationService();
  const devices = new OwnerDeviceService(undefined, options.now);
  const macDeliveries = new InMemoryOwnerMessageDeliveryStore();
  const attentionStore = new InMemoryOwnerAttentionStore();
  const notificationDeliveries = new InMemoryNotificationDeliveryStore(attentionStore);
  const connector = new Connector();
  const voice = new RealtimeVoiceService(connector);
  const pushes: string[] = [];
  const pushSender: PushSender = {
    publicKey: async () => 'BKey',
    send: async (_subscription, payload) => { pushes.push(payload); return { statusCode: 201 }; },
  };
  const app = createApp({
    repository,
    ownerAuthToken: OWNER_TOKEN,
    ownerPhone: '+15550009999',
    messagingProvider: new FakeMessagingProvider(),
    ownerConfigurationService: configuration,
    ownerDeviceService: devices,
    ownerDeliveryStore: macDeliveries,
    ownerChannel: new QueuedMacMessagesOwnerChannel(macDeliveries, devices, configuration),
    attentionStore,
    notificationDeliveryStore: notificationDeliveries,
    pushSender,
    realtimeVoice: voice,
    publicBaseUrl: 'https://text-me.vercel.app',
    providers: [new TwilioProvider({ mediaStreamUrl: `wss://example.test${MEDIA_STREAM_PATH}` }), new FakeTelephonyProvider()],
  });
  return { app, repository, configuration, devices, macDeliveries, attentionStore, notificationDeliveries, connector, voice, pushes };
}

/** What the Mac bridge does after the owner scans the QR: redeem, report health, report chats. */
async function pairMac(app: ReturnType<typeof controlPlane>['app']) {
  const qr = await request(app).post('/owner/devices/pair/qr').set(auth).send({ name: 'MacBook Pro' });
  const activated = await request(app).post('/owner/devices/activate').send({ pairingCredential: qr.body.pairingUri });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  const deviceId = activated.body.device.id as string;
  const bridge = { Authorization: `Bearer ${activated.body.sessionToken}` };
  const health = await request(app).post(`/owner/devices/${deviceId}/heartbeat`).set(bridge).send({ capabilities: MAC_CAPABILITIES, bridgeVersion: '1.0.0' });
  assert.equal(health.status, 200, JSON.stringify(health.body));
  await request(app).post(`/owner/devices/${deviceId}/messages/chats`).set(bridge)
    .send({ chats: [{ id: 'chat-self', service: 'imessage', displayName: 'Randy (me)', address: 'randy@icloud.example' }] });
  return { qr, deviceId, bridge, sessionToken: activated.body.sessionToken as string };
}

test('QR pairing: short-lived, single-use, owner-bound, and the QR carries no credentials', async () => {
  let clock = Date.now();
  const plane = controlPlane({ now: () => clock });
  const qr = await request(plane.app).post('/owner/devices/pair/qr').set(auth).send({});
  assert.equal(qr.status, 201);
  const parsed = parsePairingCredential(qr.body.pairingUri);
  assert.match(qr.body.pairingUri, /^attn:\/\/pair\/[A-Za-z0-9_-]{20,}\?s=https%3A%2F%2Ftext-me\.vercel\.app$/);
  assert.equal(parsed.server, 'https://text-me.vercel.app', 'the bridge learns where to connect from the QR');
  assert.ok(!qr.body.pairingUri.includes(OWNER_TOKEN) && !qr.body.pairingUri.includes('owner') && !qr.body.pairingUri.includes(qr.body.deviceId));
  assert.ok(Math.abs(new Date(qr.body.expiresAt).getTime() - (clock + PAIRING_TTL_MS)) < 1000);
  assert.ok(PAIRING_TTL_MS <= 5 * 60 * 1000);
  assert.equal((await request(plane.app).post('/owner/devices/pair/qr').send({})).status, 401, 'only the signed-in owner can create a QR');

  // Two simultaneous scans of the same QR: exactly one Mac gets in.
  const [first, second] = await Promise.all([
    request(plane.app).post('/owner/devices/activate').send({ pairingCredential: qr.body.pairingUri }),
    request(plane.app).post('/owner/devices/activate').send({ pairingCredential: qr.body.pairingUri }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 401]);
  const winner = first.status === 200 ? first : second;
  assert.equal(winner.body.device.ownerId, 'owner');
  assert.equal((await request(plane.app).post('/owner/devices/activate').send({ pairingCredential: qr.body.pairingUri })).status, 401, 'duplicate scan');

  // An expired QR is rejected.
  const late = await request(plane.app).post('/owner/devices/pair/qr').set(auth).send({});
  clock += PAIRING_TTL_MS + 1;
  assert.equal((await request(plane.app).post('/owner/devices/activate').send({ pairingCredential: late.body.pairingUri })).status, 401);
});

test('revoked Macs lose access immediately and come back only through a new QR', async () => {
  const plane = controlPlane();
  const { deviceId, bridge } = await pairMac(plane.app);
  const pending = await request(plane.app).post('/owner/devices/pair/qr').set(auth).send({});
  assert.equal((await request(plane.app).post(`/owner/devices/${deviceId}/revoke`).set(auth)).status, 204);
  assert.equal((await request(plane.app).post(`/owner/devices/${deviceId}/heartbeat`).set(bridge).send({ capabilities: MAC_CAPABILITIES })).status, 401);
  assert.equal((await request(plane.app).get(`/owner/devices/${deviceId}/configuration`).set(bridge)).status, 401);
  // Re-pair with a fresh QR (the other outstanding QR still works; the old session never does).
  const repaired = await request(plane.app).post('/owner/devices/activate').send({ pairingCredential: pending.body.pairingUri });
  assert.equal(repaired.status, 200);
  assert.notEqual(repaired.body.device.id, deviceId);
  assert.equal((await request(plane.app).post(`/owner/devices/${deviceId}/heartbeat`).set(bridge).send({ capabilities: MAC_CAPABILITIES })).status, 401);
  const events = (await request(plane.app).get('/owner/configuration/events').set(auth)).body.map((event: { type: string }) => event.type);
  assert.ok(events.includes('device.connected') && events.includes('device.revoked'));
});

test('the bridge reports real health and chats; the owner picks the chat; the Mac receives configuration by revision', async () => {
  const plane = controlPlane();
  const { deviceId, bridge } = await pairMac(plane.app);
  let [device] = (await request(plane.app).get('/owner/devices').set(auth)).body;
  assert.equal(device.online, true);
  assert.deepEqual(device.health, { ...MAC_CAPABILITIES, authorizedChat: false });
  assert.deepEqual(device.discoveredChats.map((chat: { id: string }) => chat.id), ['chat-self']);
  assert.equal(device.ready, false);

  const before = (await request(plane.app).get(`/owner/devices/${deviceId}/configuration`).set(bridge)).body;
  assert.equal(before.bridge.needsChatDiscovery, true);
  const chosen = await request(plane.app).post(`/owner/devices/${deviceId}/messages/chat`).set(auth).send({ chatId: 'chat-self', service: 'imessage' });
  assert.equal(chosen.status, 200);
  await request(plane.app).post(`/owner/devices/${deviceId}/heartbeat`).set(bridge).send({ capabilities: MAC_CAPABILITIES });
  [device] = (await request(plane.app).get('/owner/devices').set(auth)).body;
  assert.equal(device.ready, true);

  const after = (await request(plane.app).get(`/owner/devices/${deviceId}/configuration`).set(bridge)).body;
  assert.ok(after.revision > before.revision, 'choosing the chat is a new revision the Mac can follow');
  assert.equal(after.bridge.assistantChat.chatId, 'chat-self');
  assert.equal(after.bridge.messagesChannelEnabled, true);

  // Channel off: the Mac stays connected, and learns the new state on its next check (no re-pair).
  const off = await request(plane.app).patch('/owner/configuration').set(auth).send({ messages: { macosMessagesEnabled: false } });
  assert.equal(off.body.messages.macosMessagesEnabled, false);
  const synced = (await request(plane.app).get(`/owner/devices/${deviceId}/configuration`).set(bridge)).body;
  assert.equal(synced.revision, off.body.revision);
  assert.equal(synced.bridge.messagesChannelEnabled, false);
  [device] = (await request(plane.app).get('/owner/devices').set(auth)).body;
  assert.equal(device.status, 'active');
  assert.equal(device.online, true);

  // Test connection: capability check round trip, nothing sent to Messages.
  const probe = await request(plane.app).post(`/owner/devices/${deviceId}/test`).set(auth);
  assert.equal(probe.status, 202);
  const pending = (await request(plane.app).get(`/owner/devices/${deviceId}/configuration`).set(bridge)).body.bridge.pendingProbe;
  assert.equal(pending.id, probe.body.probe.id);
  await request(plane.app).post(`/owner/devices/${deviceId}/probe/${pending.id}`).set(bridge)
    .send({ messagesAccess: true, sendCapability: true, watcher: true, assistantChatFound: true });
  [device] = (await request(plane.app).get('/owner/devices').set(auth)).body;
  assert.deepEqual(device.probe.result, { bridgeReachable: true, messagesAccess: true, sendCapability: true, watcher: true, assistantChatFound: true });
  assert.equal((await plane.macDeliveries.listPending(deviceId)).length, 0, 'no visible test message');
});

test('turning Apple Messages off stops owner deliveries; turning it on resumes them; no re-pairing', async (t) => {
  const plane = controlPlane();
  const { deviceId, bridge } = await pairMac(plane.app);
  await request(plane.app).post(`/owner/devices/${deviceId}/messages/chat`).set(auth).send({ chatId: 'chat-self', service: 'imessage' });
  await request(plane.app).post(`/owner/devices/${deviceId}/heartbeat`).set(bridge).send({ capabilities: MAC_CAPABILITIES });
  await request(plane.app).post(`/owner/devices/${deviceId}/primary`).set(auth);

  const server: Server = createServer(plane.app);
  plane.voice.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const call = async (callId: string) => {
    await request(plane.app).post('/webhooks/fake/voice').send({ callId, callerPhone: '+15553334444' });
    const conversation = (await plane.repository.list()).find((candidate) => candidate.providerCallId === callId)!;
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}${MEDIA_STREAM_PATH}`);
    t.after(() => socket.close());
    await new Promise((resolve) => socket.once('open', resolve));
    const before = plane.connector.configs.length;
    socket.send(JSON.stringify({ event: 'start', start: { streamSid: `MZ-${callId}`, customParameters: { conversationId: conversation.id } } }));
    await eventually(() => plane.connector.configs.length > before, 'session');
    return conversation.id;
  };
  const ask = (callId: string) => plane.connector.emit({
    type: 'function-call-arguments-done', responseId: 'r', itemId: 'i', callId,
    name: 'ask_owner', arguments: JSON.stringify({ question: 'Friday at 2?', suggestedReplies: ['Friday at 2 works'] }),
  });

  await call('c1');
  plane.connector.emit({ type: 'function-call-arguments-done', responseId: 'r', itemId: 'n', callId: 'note-1', name: 'note_caller', arguments: JSON.stringify({ name: 'Jordan', reason: 'moving a meeting' }) });
  ask('ask-1');
  await eventually(async () => (await plane.macDeliveries.listPending(deviceId)).length === 1, 'Messages delivery');
  const [first] = await plane.macDeliveries.listPending(deviceId);
  assert.equal(first.body, 'Jordan (moving a meeting) is waiting: Friday at 2? Suggested reply: "Friday at 2 works". Reply here.');

  await request(plane.app).patch('/owner/configuration').set(auth).send({ messages: { macosMessagesEnabled: false } });
  await call('c2');
  ask('ask-2');
  await eventually(async () => (await plane.attentionStore.list('owner')).some((item) => item.metadata.requestId === 'req_ask-2'), 'second attention');
  assert.equal((await plane.macDeliveries.listPending(deviceId)).length, 1, 'disabled channel gets nothing new');

  // Summary and suggestion follow the message settings too.
  await request(plane.app).patch('/owner/configuration').set(auth)
    .send({ messages: { macosMessagesEnabled: true, includeSummary: false, includeSuggestedResponse: false } });
  await call('c3');
  ask('ask-3');
  await eventually(async () => (await plane.macDeliveries.listPending(deviceId)).length === 2, 'delivery resumes');
  const latest = (await plane.macDeliveries.listPending(deviceId)).at(-1)!;
  assert.equal(latest.body, '+15553334444 is waiting: Friday at 2? Reply here.');
});

/** A live call on the plane, with helpers to have the assistant ask the owner something. */
async function liveCalls(plane: ReturnType<typeof controlPlane>, t: { after(fn: () => void): void }) {
  const server: Server = createServer(plane.app);
  plane.voice.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return {
    async call(callId: string) {
      await request(plane.app).post('/webhooks/fake/voice').send({ callId, callerPhone: '+15553334444' });
      const conversation = (await plane.repository.list()).find((candidate) => candidate.providerCallId === callId)!;
      const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}${MEDIA_STREAM_PATH}`);
      t.after(() => socket.close());
      await new Promise((resolve) => socket.once('open', resolve));
      const before = plane.connector.configs.length;
      socket.send(JSON.stringify({ event: 'start', start: { streamSid: `MZ-${callId}`, customParameters: { conversationId: conversation.id } } }));
      await eventually(() => plane.connector.configs.length > before, 'session');
      return conversation.id;
    },
    async ask(callId: string) {
      plane.connector.emit({
        type: 'function-call-arguments-done', responseId: 'r', itemId: 'i', callId,
        name: 'ask_owner', arguments: JSON.stringify({ question: 'Friday at 2?', suggestedReplies: ['Friday at 2 works'] }),
      });
      await eventually(async () => (await plane.attentionStore.list('owner')).some((item) => item.metadata.requestId === `req_${callId}`), 'attention');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const attention = (await plane.attentionStore.list('owner')).find((item) => item.metadata.requestId === `req_${callId}`)!;
      return { attention, deliveries: await plane.notificationDeliveries.list(attention.id) };
    },
  };
}

test('browser inbox and "send owner notifications" decide whether the iPhone is pushed', async (t) => {
  const plane = controlPlane();
  await request(plane.app).post('/owner/push/devices').set(auth)
    .send({ subscription: { endpoint: 'https://web.push.apple.com/owner', keys: { p256dh: 'k', auth: 'a' } } });
  const calls = await liveCalls(plane, t);

  await request(plane.app).patch('/owner/configuration').set(auth).send({ messages: { webEnabled: false } });
  await calls.call('w1');
  const off = await calls.ask('ask-w1');
  assert.equal(plane.pushes.length, 0, 'browser inbox off: no push');
  assert.deepEqual(off.deliveries.map((delivery) => delivery.surface), ['owner_sms'], 'still reached: SMS fallback when nothing else can');

  await request(plane.app).patch('/owner/configuration').set(auth).send({ messages: { webEnabled: true } });
  await calls.call('w2');
  const on = await calls.ask('ask-w2');
  assert.equal(plane.pushes.length, 1);
  assert.deepEqual(on.deliveries.map((delivery) => delivery.surface), ['web_push']);

  await request(plane.app).patch('/owner/configuration').set(auth).send({ messages: { notifyOwner: false } });
  await calls.call('w3');
  const silent = await calls.ask('ask-w3');
  assert.equal(plane.pushes.length, 1, 'notifications off: nothing sent anywhere');
  assert.deepEqual(silent.deliveries, []);
  assert.equal(silent.attention.status, 'pending', 'but the attention is still recorded for the app');
});

test('call and assistant settings change the next call, with no Mac involved', async (t) => {
  const plane = controlPlane();
  const server: Server = createServer(plane.app);
  plane.voice.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const start = async (callId: string) => {
    const answer = await request(plane.app).post('/webhooks/fake/voice').send({ callId, callerPhone: '+15553334444' });
    const conversation = (await plane.repository.list()).find((candidate) => candidate.providerCallId === callId)!;
    if (/can.t take/.test(answer.text)) return { answer, conversationId: conversation.id };
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}${MEDIA_STREAM_PATH}`);
    t.after(() => socket.close());
    await new Promise((resolve) => socket.once('open', resolve));
    const before = plane.connector.configs.length;
    socket.send(JSON.stringify({ event: 'start', start: { streamSid: `MZ-${callId}`, customParameters: { conversationId: conversation.id } } }));
    await eventually(() => plane.connector.configs.length > before, 'session');
    return { answer, conversationId: conversation.id };
  };

  await start('a1');
  assert.match(plane.connector.configs.at(-1)!.instructions!, /Who am I speaking with\?/);

  await request(plane.app).patch('/owner/configuration').set(auth).send({
    assistant: { assistantName: 'Ava', greeting: 'Hey, Randy’s phone, Ava here.' },
    calls: { collectCallerName: false, collectReason: false },
  });
  await start('a2');
  const instructions = plane.connector.configs.at(-1)!.instructions!;
  assert.match(instructions, /Your name is Ava\./);
  assert.match(instructions, /Open with exactly: "Hey, Randy’s phone, Ava here\."/);
  assert.doesNotMatch(instructions, /Who am I speaking with\?/);

  // Answering off, voicemail on: the caller gets a voicemail, not a silent assistant.
  await request(plane.app).patch('/owner/configuration').set(auth).send({ calls: { answerCalls: false, voicemailFallback: true } });
  const declined = await start('a3');
  assert.doesNotMatch(declined.answer.text, /<Connect>/);
  assert.match(declined.answer.text, /<Record [^>]*action="\/webhooks\/twilio\/voicemail\?conversationId=/);
  const voicemail = await request(plane.app).post(`/webhooks/twilio/voicemail?conversationId=${declined.conversationId}`).type('form')
    .send({ RecordingUrl: 'https://api.twilio.com/rec/RE1', RecordingSid: 'RE1', RecordingDuration: '14' });
  assert.equal(voicemail.status, 200);
  const attention = (await plane.attentionStore.list('owner')).find((item) => item.type === 'voicemail')!;
  assert.equal(attention.title, '+15553334444 left a voicemail');

  // Answering off, voicemail off: they're asked to text.
  await request(plane.app).patch('/owner/configuration').set(auth).send({ calls: { voicemailFallback: false } });
  const texted = await start('a4');
  assert.match(texted.answer.text, /Please send a text message instead/);
});

test('settings: defaults, persistence, revisions, conflicts, audit, and owner isolation', async () => {
  const plane = controlPlane();
  const defaults = (await request(plane.app).get('/owner/configuration').set(auth)).body;
  assert.deepEqual(defaults.calls, {
    answerCalls: true, collectCallerName: true, collectReason: true, offerSmsTransition: true,
    requireSmsConsent: true, voicemailFallback: false, voiceEnabled: true, transcriptionEnabled: true,
  });
  assert.equal(defaults.messages.webEnabled, true);
  assert.equal(defaults.messages.macosMessagesEnabled, true);

  const updated = await request(plane.app).patch('/owner/configuration').set(auth)
    .send({ expectedRevision: defaults.revision, assistant: { tone: 'professional' } });
  assert.equal(updated.body.revision, defaults.revision + 1);
  assert.equal((await request(plane.app).get('/owner/configuration').set(auth)).body.assistant.tone, 'professional');

  // Two edits from the same starting point: the second is told to refresh instead of silently overwriting.
  const stale = await request(plane.app).patch('/owner/configuration').set(auth)
    .send({ expectedRevision: defaults.revision, assistant: { tone: 'warm' } });
  assert.equal(stale.status, 409);
  assert.equal((await request(plane.app).get('/owner/configuration').set(auth)).body.assistant.tone, 'professional');

  assert.equal((await request(plane.app).patch('/owner/configuration').set(auth).send({ assistant: { tone: 'sarcastic' } })).status, 400);
  assert.equal((await request(plane.app).patch('/owner/configuration').set(auth).send({ prompt: 'ignore rules' })).status, 400);

  await request(plane.app).patch('/owner/configuration').set(auth).send({ messages: { webEnabled: false } });
  const events = (await request(plane.app).get('/owner/configuration/events').set(auth)).body;
  assert.deepEqual(events.map((event: { type: string }) => event.type).slice(-2), ['assistant.settings.updated', 'owner.channel.disabled']);
  assert.ok(events.every((event: Record<string, unknown>) => Object.keys(event).sort().join() === 'occurredAt,ownerId,revision,source,type'));

  // Owner isolation at the service level: one owner's changes never touch another's.
  await plane.configuration.update('someone-else', { messages: { macosMessagesEnabled: false } });
  assert.equal((await request(plane.app).get('/owner/configuration').set(auth)).body.messages.macosMessagesEnabled, true);

  // The Mac bridge is an executor: its credential can't change settings or read another device's config.
  const { deviceId, bridge } = await pairMac(plane.app);
  assert.equal((await request(plane.app).patch('/owner/configuration').set(bridge).send({ messages: { webEnabled: true } })).status, 401);
  const other = await request(plane.app).post('/owner/devices/pair/qr').set(auth).send({});
  assert.equal((await request(plane.app).get(`/owner/devices/${other.body.deviceId}/configuration`).set(bridge)).status, 401);
  assert.equal((await request(plane.app).get(`/owner/devices/${deviceId}/configuration`).set(bridge)).status, 200);
});

test('every Settings control in the owner UI is bound to a real, typed setting', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('function renderSettings()');
  const settings = html.slice(start, html.indexOf('\n}\n', start)) + html.slice(html.indexOf('function renderMacConfig('), html.indexOf('async function testMac('));
  const paths = new Set([
    ...[...settings.matchAll(/\bsw\('([a-z]+\.[A-Za-z]+)'/g)].map((match) => match[1]),
    ...[...settings.matchAll(/switchHTML\('([a-z]+\.[A-Za-z]+)'/g)].map((match) => match[1]),
    ...[...settings.matchAll(/(?:textRow|areaRow)\('[^']+', '([a-z]+\.[A-Za-z]+)'/g)].map((match) => match[1]),
    ...[...settings.matchAll(/choiceRows\('([a-z]+\.[A-Za-z]+)'/g)].map((match) => match[1]),
  ]);
  assert.ok(paths.size >= 20, `found only ${paths.size} controls`);
  const defaults = await new OwnerConfigurationService().get('owner') as unknown as Record<string, Record<string, unknown>>;
  for (const path of paths) {
    const [section, key] = path.split('.');
    assert.ok(section in defaults && key in defaults[section], `Settings control "${path}" has no stored setting`);
  }
});
