import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import request from 'supertest';
import WebSocket from 'ws';

import { createApp } from '../src/app.js';
import {
  InMemoryNotificationDeliveryStore,
  InMemoryOwnerAttentionStore,
  InMemoryOwnerSurfaceDeviceStore,
} from '../src/attention/stores.js';
import type { PushSender, PushSubscriptionJSON } from '../src/attention/surfaces.js';
import { FakeMessagingProvider } from '../src/messaging/fake-provider.js';
import { OwnerConfigurationService } from '../src/owner/configuration.js';
import { InMemoryRuntimeCommandStore } from '../src/runtime/commands.js';
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

/** Records pushes the way a browser push service would receive them. */
class RecordingPushSender implements PushSender {
  sent: Array<{ endpoint: string; payload: Record<string, unknown>; urgency: string }> = [];
  failWith?: number;
  async publicKey() { return 'BPublicKeyForTests'; }
  async send(subscription: PushSubscriptionJSON, payload: string, options: { urgency: string }) {
    if (this.failWith) throw Object.assign(new Error('gone'), { statusCode: this.failWith });
    this.sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), urgency: options.urgency });
    return { statusCode: 201 };
  }
}

class ScriptedConnector implements RealtimeConnector {
  readonly modelId = 'openai/gpt-realtime-2';
  sent: RealtimeClientEvent[] = [];
  private handlers?: RealtimeConnectionHandlers;
  async connect(_config: RealtimeSessionConfig, handlers: RealtimeConnectionHandlers): Promise<RealtimeConnection> {
    this.handlers = handlers;
    return { send: async (event) => { this.sent.push(event); }, close: () => undefined };
  }
  emit(event: Record<string, unknown>) { this.handlers!.onEvent({ raw: {}, ...event } as RealtimeServerEvent); }
  get connected() { return Boolean(this.handlers); }
}

async function eventually(check: () => boolean | Promise<boolean>, what: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

const subscription = (id: string) => ({
  endpoint: `https://web.push.apple.com/${id}`, keys: { p256dh: 'BKey', auth: 'auth' },
});

/** An owner with an iPhone and no Mac: no ownerChannel, no Mac devices, no Photon. */
async function iphoneOwner(options: { configuration?: OwnerConfigurationService } = {}) {
  const repository = new InMemoryConversationRepository();
  const connector = new ScriptedConnector();
  const messaging = new FakeMessagingProvider();
  const push = new RecordingPushSender();
  const attentionStore = new InMemoryOwnerAttentionStore();
  const deliveries = new InMemoryNotificationDeliveryStore(attentionStore);
  const commands = new InMemoryRuntimeCommandStore();
  const voice = new RealtimeVoiceService(connector);
  const app = createApp({
    repository,
    messagingProvider: messaging,
    ownerPhone: '+15550009999',
    ownerConfigurationService: options.configuration,
    realtimeVoice: voice,
    pushSender: push,
    attentionStore,
    notificationDeliveryStore: deliveries,
    surfaceDeviceStore: new InMemoryOwnerSurfaceDeviceStore(),
    runtimeCommandStore: commands,
    providers: [new TwilioProvider({ mediaStreamUrl: `wss://example.test${MEDIA_STREAM_PATH}` }), new FakeTelephonyProvider()],
  });
  const server: Server = createServer(app);
  voice.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { app, repository, connector, messaging, push, attentionStore, deliveries, commands, voice, port, close: () => server.close() };
}

async function placeCall(owner: Awaited<ReturnType<typeof iphoneOwner>>, callId = 'call-1') {
  await request(owner.app).post('/webhooks/fake/voice').send({ callId, callerPhone: '+15553334444' });
  const conversation = (await owner.repository.list()).find((candidate) => candidate.providerCallId === callId)!;
  const socket = new WebSocket(`ws://127.0.0.1:${owner.port}${MEDIA_STREAM_PATH}`);
  await new Promise((resolve) => socket.once('open', resolve));
  socket.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', customParameters: { conversationId: conversation.id } } }));
  await eventually(() => owner.connector.connected, 'realtime session');
  return { conversationId: conversation.id, socket };
}

const askOwner = (owner: Awaited<ReturnType<typeof iphoneOwner>>, callId = 'ask-1') => owner.connector.emit({
  type: 'function-call-arguments-done', responseId: 'r', itemId: 'i', callId,
  name: 'ask_owner', arguments: JSON.stringify({ question: 'Can you do Friday at 2?', suggestedReplies: ['Friday at 2 works'] }),
});

test('iPhone, no Mac: the assistant needs the owner -> attention -> push that deep-links to the live conversation', async (t) => {
  const owner = await iphoneOwner();
  t.after(owner.close);
  const registered = await request(owner.app).post('/owner/push/devices')
    .send({ subscription: subscription('iphone'), label: 'iPhone', supportsActions: false });
  assert.equal(registered.status, 201);
  assert.deepEqual(registered.body.capabilities, ['push', 'deep_link'], 'no pretend capabilities on iOS web push');
  assert.equal((await request(owner.app).get('/owner/push/config')).body.publicKey, 'BPublicKeyForTests');

  const { conversationId, socket } = await placeCall(owner);
  t.after(() => socket.close());
  // Call start is recorded but, by default, does not interrupt the owner.
  const started = (await owner.attentionStore.list('owner')).find((item) => item.type === 'conversation_started')!;
  assert.equal(started.title, '+15553334444 is calling');
  assert.equal(started.priority, 'passive');
  assert.equal(owner.push.sent.length, 0);

  askOwner(owner);
  await eventually(() => owner.push.sent.length === 1, 'owner push');
  const pushed = owner.push.sent[0];
  assert.equal(pushed.endpoint, 'https://web.push.apple.com/iphone');
  assert.equal(pushed.urgency, 'high');
  assert.equal(pushed.payload.title, '+15553334444 needs you');
  assert.equal(pushed.payload.body, '“Can you do Friday at 2?”');
  const needs = (await owner.attentionStore.list('owner')).find((item) => item.type === 'assistant_needs_owner')!;
  assert.equal(pushed.payload.url, `/conversations/${conversationId}/live?attention=${needs.id}`);
  assert.deepEqual(pushed.payload.actions, [{ action: 'reply', title: 'Reply' }, { action: 'take_over', title: 'Take Over' }]);
  assert.ok(!JSON.stringify(pushed.payload).match(/gpt|twilio|runtime|turn/i), 'no implementation details in the notification');
  assert.equal(needs.status, 'delivered');
  assert.deepEqual((await owner.deliveries.list(needs.id)).map((delivery) => delivery.surface), ['web_push']);
  // Push got through, so the owner is not also texted; and nothing touched a Mac.
  assert.ok(!owner.messaging.sentMessages.some((message) => message.to === '+15550009999'));
  const detail = (await request(owner.app).get(`/conversations/${conversationId}`)).body;
  assert.ok(!detail.events.some((type: string) => type.startsWith('owner.delivery')));

  // The deep link serves the app itself (it opens that conversation with no inbox step).
  const live = await request(owner.app).get(`/conversations/${conversationId}/live?attention=${needs.id}`);
  assert.equal(live.status, 200);
  assert.match(live.text, /<title>Text Me<\/title>/);
  assert.equal((await request(owner.app).get('/sw.js')).status, 200);
});

test('notification actions run as owner-scoped durable commands on the conversation the server resolves', async (t) => {
  const owner = await iphoneOwner();
  t.after(owner.close);
  await request(owner.app).post('/owner/push/devices').send({ subscription: subscription('iphone') });
  const { conversationId, socket } = await placeCall(owner);
  t.after(() => socket.close());
  askOwner(owner);
  await eventually(() => owner.push.sent.length === 1, 'push');
  const needs = (await owner.attentionStore.list('owner')).find((item) => item.type === 'assistant_needs_owner')!;

  const opened = await request(owner.app).post(`/owner/attention/${needs.id}/opened`);
  assert.equal(opened.body.status, 'opened');

  // "Take Over" from the notification: no conversation id from the client, only the attention id.
  const takeOver = await request(owner.app).post(`/owner/attention/${needs.id}/actions`).send({ action: 'take_over', conversationId: 'conv_forged' });
  assert.equal(takeOver.status, 200);
  assert.equal(takeOver.body.conversationId, conversationId);
  assert.equal(takeOver.body.runtime.status, 'takeover');
  await eventually(async () => (await owner.commands.list(conversationId)).some((command) =>
    command.type === 'take_over' && command.status === 'applied_live'), 'take over applied to the live call');
  const command = (await owner.commands.list(conversationId)).find((candidate) => candidate.type === 'take_over')!;
  assert.equal(command.runtimeId, `rt_${conversationId.replace(/^conv_/, '')}`);
  assert.equal((await owner.attentionStore.get(needs.id))!.status, 'acted');

  // Tapping again is replay-safe.
  const again = await request(owner.app).post(`/owner/attention/${needs.id}/actions`).send({ action: 'take_over' });
  assert.equal(again.status, 200);
  assert.equal((await owner.commands.list(conversationId)).filter((candidate) => candidate.type === 'take_over').length, 1);

  // A second question, answered with "Reply" straight from the notification.
  askOwner(owner, 'ask-2');
  await eventually(() => owner.push.sent.length === 2, 'second push');
  const second = (await owner.attentionStore.list('owner')).find((item) => item.metadata.requestId === 'req_ask-2')!;
  const reply = await request(owner.app).post(`/owner/attention/${second.id}/actions`).send({ action: 'reply', body: 'Friday at 2 works' });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.conversation.ownerRequest, null);
  await eventually(() => owner.connector.sent.some((event) => event.type === 'response-create' &&
    /just replied: "Friday at 2 works"/.test(event.options?.instructions ?? '')), 'reply relayed on the call');

  // Someone else's attention id is invisible.
  const foreign = await owner.attentionStore.create({ ...second, id: 'att_foreign', ownerId: 'someone-else', dedupeKey: 'x' });
  assert.equal((await request(owner.app).post(`/owner/attention/${foreign.id}/actions`).send({ action: 'take_over' })).status, 404);
});

test('an expired phone subscription is retired and the owner is texted instead', async (t) => {
  const owner = await iphoneOwner();
  t.after(owner.close);
  await request(owner.app).post('/owner/push/devices').send({ subscription: subscription('old-iphone') });
  owner.push.failWith = 410;
  const { socket } = await placeCall(owner);
  t.after(() => socket.close());
  askOwner(owner);
  await eventually(() => owner.messaging.sentMessages.some((message) => message.to === '+15550009999'), 'SMS fallback');
  const needs = (await owner.attentionStore.list('owner')).find((item) => item.type === 'assistant_needs_owner')!;
  assert.deepEqual((await owner.deliveries.list(needs.id)).map((delivery) => [delivery.surface, delivery.status]),
    [['web_push', 'failed'], ['owner_sms', 'sent']]);
  const devices = (await request(owner.app).get('/owner/push/devices')).body;
  assert.equal(devices[0].status, 'expired');
});

test('owners who opt in hear about every call; everyone else is only interrupted when needed', async (t) => {
  const configuration = new OwnerConfigurationService();
  await configuration.update('owner', { messages: { notifyOnActivity: true } });
  const owner = await iphoneOwner({ configuration });
  t.after(owner.close);
  await request(owner.app).post('/owner/push/devices').send({ subscription: subscription('iphone') });
  const { socket } = await placeCall(owner);
  t.after(() => socket.close());
  await eventually(() => owner.push.sent.length === 1, 'call start push');
  assert.equal(owner.push.sent[0].payload.title, '+15553334444 is calling');
  assert.equal(owner.push.sent[0].payload.body, 'Your assistant is answering');
  assert.equal(owner.push.sent[0].urgency, 'normal');
});

test('Adjust is one durable command scoped to the conversation; reset returns to defaults; takeover survives reset', async (t) => {
  const owner = await iphoneOwner();
  t.after(owner.close);
  const { conversationId, socket } = await placeCall(owner);
  t.after(() => socket.close());
  const before = (await request(owner.app).get(`/conversations/${conversationId}/runtime`)).body;
  assert.equal(before.temporarySettings, false);

  const adjusted = await request(owner.app).patch(`/conversations/${conversationId}/runtime`)
    .send({ commandId: 'cmd_adjust', verbosity: 'detailed', voiceEnabled: false, expectedRevision: before.revision });
  assert.equal(adjusted.status, 200, JSON.stringify(adjusted.body));
  assert.equal(adjusted.body.revision, before.revision + 1, 'one revision for the whole adjustment');
  assert.equal(adjusted.body.temporarySettings, true);
  assert.deepEqual([...adjusted.body.overriddenFields].sort(), ['verbosity', 'voiceEnabled']);
  const commands = await owner.commands.list(conversationId);
  assert.deepEqual(commands.map((command) => command.type), ['adjust_interaction']);
  assert.deepEqual(commands[0].payload.changes, { verbosity: 'detailed', voiceEnabled: false });
  assert.equal((await request(owner.app).get('/owner/configuration')).body.assistant.responseStyle, 'concise', 'defaults untouched');

  // Invalid adjustments are rejected atomically, and replaying the id returns the same error.
  const invalid = await request(owner.app).patch(`/conversations/${conversationId}/runtime`).send({ commandId: 'cmd_bad', verbosity: 'huge', voiceEnabled: true });
  assert.equal(invalid.status, 400);
  assert.equal((await request(owner.app).get(`/conversations/${conversationId}/runtime`)).body.voiceEnabled, false);
  const replay = await request(owner.app).patch(`/conversations/${conversationId}/runtime`).send({ commandId: 'cmd_bad', verbosity: 'huge' });
  assert.equal(replay.status, 409);

  await request(owner.app).post(`/conversations/${conversationId}/runtime/takeover`).send({});
  const reset = await request(owner.app).delete(`/conversations/${conversationId}/runtime/overrides`).send({ commandId: 'cmd_reset' });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.temporarySettings, false);
  assert.equal(reset.body.verbosity, 'short');
  assert.equal(reset.body.voiceEnabled, true);
  assert.equal(reset.body.status, 'takeover', 'reset changes settings, not who is in control');
});

test('the owner-wide live stream carries attention for the owner’s conversations', async (t) => {
  const owner = await iphoneOwner();
  t.after(owner.close);
  const server = createServer(owner.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const received: string[] = [];
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/owner/events`, { signal: controller.signal });
  const reader = stream.body!.getReader();
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        received.push(decoder.decode(value));
      }
    } catch { /* aborted */ }
  })();
  await eventually(() => received.join('').includes('event: ready'), 'stream ready');
  const { socket } = await placeCall(owner);
  t.after(() => socket.close());
  askOwner(owner);
  await eventually(() => /event: runtime\.attention[\s\S]*"attentionType":"assistant_needs_owner"/.test(received.join('')), 'attention on the owner stream');
});

test('connecting the number points it at this deployment without any provider console', async () => {
  const { PhoneNumberService } = await import('../src/telephony/phone-number.js');
  const numbers = new Map([['+15550000000', { sid: 'PN1', phoneNumber: '+15550000000', voiceUrl: 'https://old.example/voice', smsUrl: null as string | null, statusCallback: null as string | null }]]);
  const client = {
    find: async (phoneNumber: string) => numbers.get(phoneNumber) ?? null,
    update: async (_sid: string, urls: { voiceUrl: string; smsUrl: string; statusCallback: string }) => {
      const updated = { ...numbers.get('+15550000000')!, ...urls };
      numbers.set('+15550000000', updated);
      return updated;
    },
  };
  const app = createApp({
    repository: new InMemoryConversationRepository(),
    phoneNumbers: new PhoneNumberService(client, '+15550000000', 'https://text-me.vercel.app'),
  });
  assert.deepEqual((await request(app).get('/owner/phone')).body, { available: true, phoneNumber: '+15550000000', found: true, connected: false });
  const connected = await request(app).post('/owner/phone/connect');
  assert.equal(connected.status, 200);
  assert.equal(numbers.get('+15550000000')!.voiceUrl, 'https://text-me.vercel.app/webhooks/twilio/voice');
  assert.equal(numbers.get('+15550000000')!.smsUrl, 'https://text-me.vercel.app/webhooks/twilio/sms');
  assert.equal(numbers.get('+15550000000')!.statusCallback, 'https://text-me.vercel.app/webhooks/twilio/status');
  assert.equal((await request(app).get('/owner/phone')).body.connected, true);
});
