/**
 * The multi-tenant matrix: two customers on one deployment.
 *
 *   Account A · User A · Phone A · Device A
 *   Account B · User B · Phone B · Device B
 *
 * Every assertion is made through the public API (or the provider webhooks),
 * as a customer or an attacker would reach it.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import request from 'supertest';
import WebSocket from 'ws';

import { InMemoryNotificationDeliveryStore, InMemoryOwnerAttentionStore, InMemoryOwnerSurfaceDeviceStore } from '../src/attention/stores.js';
import type { ApnsMessage, ApnsSender } from '../src/attention/apns.js';
import type { PushSender, PushSubscriptionJSON } from '../src/attention/surfaces.js';
import { createApp } from '../src/http-app.js';
import { FakeMessagingProvider } from '../src/messaging/fake-provider.js';
import { OwnerConfigurationService } from '../src/owner/configuration.js';
import { InMemoryOwnerMessageDeliveryStore, QueuedMacMessagesOwnerChannel } from '../src/owner/delivery.js';
import { OwnerDeviceService } from '../src/owner/device.js';
import { InMemoryRuntimeCommandStore } from '../src/runtime/commands.js';
import { InMemoryRuntimeEventBus } from '../src/runtime/event-bus.js';
import { createRuntimeEvent } from '../src/runtime/store.js';
import { RuntimeControlService } from '../src/runtime/service.js';
import { FakeTelephonyProvider } from '../src/telephony/fake-provider.js';
import { TwilioProvider } from '../src/telephony/twilio-provider.js';
import { assertJobOwnership, CrossTenantJobError } from '../src/tenancy/authorization.js';
import type {
  RealtimeClientEvent,
  RealtimeConnection,
  RealtimeConnectionHandlers,
  RealtimeConnector,
  RealtimeServerEvent,
} from '../src/voice/realtime/connector.js';
import { MEDIA_STREAM_PATH, RealtimeVoiceService } from '../src/voice/realtime/realtime-voice.js';
import { InMemoryConversationRepository } from './support/in-memory-repository.js';
import { onboardTenant, signIn, type Tenant } from './support/tenant.js';

/** One realtime connection per call, so each tenant's live call is observable on its own. */
class Connector implements RealtimeConnector {
  readonly modelId = 'openai/gpt-realtime-2';
  readonly calls: Array<{ sent: RealtimeClientEvent[]; handlers: RealtimeConnectionHandlers; instructions: string }> = [];
  async connect(config: { instructions?: string }, handlers: RealtimeConnectionHandlers): Promise<RealtimeConnection> {
    const call = { sent: [] as RealtimeClientEvent[], handlers, instructions: config.instructions ?? '' };
    this.calls.push(call);
    return { send: async (event) => { call.sent.push(event); }, close: () => undefined };
  }
}

class RecordingPush implements PushSender {
  sent: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
  async publicKey() { return 'BKey'; }
  async send(subscription: PushSubscriptionJSON, payload: string) {
    this.sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
    return { statusCode: 201 };
  }
}

class RecordingApns implements ApnsSender {
  readonly bundleId = 'app.textme.owner';
  sent: Array<{ token: string; message: ApnsMessage }> = [];
  async send(token: string, message: ApnsMessage) {
    this.sent.push({ token, message });
    return { apnsId: `apns-${this.sent.length}` };
  }
}

async function eventually(check: () => boolean | Promise<boolean>, what: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

const subscription = (id: string) => ({ endpoint: `https://web.push.apple.com/${id}`, keys: { p256dh: 'k', auth: 'a' } });

/** One deployment, two customers, each with a phone line, a verified number, a browser push device and a Mac. */
async function deployment() {
  const repository = new InMemoryConversationRepository();
  const messaging = new FakeMessagingProvider();
  const push = new RecordingPush();
  const apns = new RecordingApns();
  const connector = new Connector();
  const voice = new RealtimeVoiceService(connector);
  const bus = new InMemoryRuntimeEventBus();
  const configuration = new OwnerConfigurationService();
  const devices = new OwnerDeviceService();
  const macDeliveries = new InMemoryOwnerMessageDeliveryStore();
  const attentionStore = new InMemoryOwnerAttentionStore();
  const notificationDeliveries = new InMemoryNotificationDeliveryStore(attentionStore);
  const surfaceDevices = new InMemoryOwnerSurfaceDeviceStore();
  const commands = new InMemoryRuntimeCommandStore();
  const app = createApp({
    repository, messagingProvider: messaging, pushSender: push, apnsSender: apns, realtimeVoice: voice,
    runtimeEventBus: bus, runtimeCommandStore: commands, ownerConfigurationService: configuration,
    ownerDeviceService: devices, ownerDeliveryStore: macDeliveries,
    ownerChannel: new QueuedMacMessagesOwnerChannel(macDeliveries, devices, configuration),
    attentionStore, notificationDeliveryStore: notificationDeliveries, surfaceDeviceStore: surfaceDevices,
    publicBaseUrl: 'https://text-me.vercel.app',
    providers: [new TwilioProvider({ mediaStreamUrl: `wss://example.test${MEDIA_STREAM_PATH}` }), new FakeTelephonyProvider()],
  });
  const server: Server = createServer(app);
  voice.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const sockets: WebSocket[] = [];

  const a = await onboardTenant(app, messaging, { name: 'Avery', personal: '+15551110001' });
  const b = await onboardTenant(app, messaging, { name: 'Blake', personal: '+15552220002' });
  await request(app).post('/owner/push/devices').set(a.headers).send({ subscription: subscription('device-a'), label: 'A phone' });
  await request(app).post('/owner/push/devices').set(b.headers).send({ subscription: subscription('device-b'), label: 'B phone' });
  const macA = await pairMac(app, a);
  const macB = await pairMac(app, b);
  messaging.sentMessages.length = 0;

  /** A caller dials a tenant's line; the call goes live on the realtime bridge. */
  const call = async (tenant: Tenant, callId: string) => {
    const answered = await request(app).post('/webhooks/fake/voice').send({ callId, callerPhone: '+15559990000', to: tenant.line });
    assert.equal(answered.status, 200);
    const conversation = (await repository.list(tenant.accountId)).find((item) => item.providerCallId === callId)!;
    const socket = new WebSocket(`ws://127.0.0.1:${port}${MEDIA_STREAM_PATH}`);
    sockets.push(socket);
    await new Promise((resolve) => socket.once('open', resolve));
    const before = connector.calls.length;
    socket.send(JSON.stringify({ event: 'start', start: { streamSid: `MZ-${callId}`, customParameters: { conversationId: conversation.id } } }));
    await eventually(() => connector.calls.length > before, 'live call');
    return { conversationId: conversation.id, live: connector.calls[connector.calls.length - 1] };
  };
  const askOwner = (live: Connector['calls'][number], callId: string) => live.handlers.onEvent({
    raw: {}, type: 'function-call-arguments-done', responseId: 'r', itemId: 'i', callId, name: 'ask_owner',
    arguments: JSON.stringify({ question: `Question ${callId}?`, suggestedReplies: ['Yes'] }),
  } as RealtimeServerEvent);

  return {
    app, repository, messaging, push, apns, connector, bus, commands, attentionStore, notificationDeliveries, macDeliveries, devices,
    surfaceDevices, port, a, b, macA, macB, call, askOwner,
    close: () => { sockets.forEach((socket) => socket.close()); server.closeAllConnections(); server.close(); },
  };
}

async function pairMac(app: Parameters<typeof request>[0], tenant: Tenant) {
  const qr = await request(app).post('/owner/devices/pair/qr').set(tenant.headers).send({ name: 'Mac' });
  const activated = await request(app).post('/owner/devices/activate').send({ pairingCredential: qr.body.pairingUri });
  const deviceId = activated.body.device.id as string;
  const auth = { Authorization: `Bearer ${activated.body.sessionToken}` };
  await request(app).post(`/owner/devices/${deviceId}/heartbeat`).set(auth).send({
    capabilities: { messagesAccess: true, sendCapability: true, watcher: true, authorizedIdentity: { service: 'imessage', address: `${tenant.accountId}@icloud.test` } },
  });
  await request(app).post(`/owner/devices/${deviceId}/messages/chats`).set(auth).send({ chats: [{ id: `chat-${tenant.accountId}`, service: 'imessage' }] });
  await request(app).post(`/owner/devices/${deviceId}/messages/chat`).set(tenant.headers).send({ chatId: `chat-${tenant.accountId}`, service: 'imessage' });
  await request(app).post(`/owner/devices/${deviceId}/primary`).set(tenant.headers);
  return { deviceId, auth };
}

test('reads: A cannot read anything of B’s, and B cannot read anything of A’s', async (t) => {
  const d = await deployment();
  t.after(d.close);
  const callA = await d.call(d.a, 'read-a');
  const callB = await d.call(d.b, 'read-b');
  d.askOwner(callB.live, 'ask-read-b');
  d.askOwner(callA.live, 'ask-read-a');
  await eventually(async () => (await d.attentionStore.list(d.b.accountId)).some((item) => item.type === 'assistant_needs_owner') &&
    (await d.attentionStore.list(d.a.accountId)).some((item) => item.type === 'assistant_needs_owner'), 'attention for both');
  const attentionB = (await d.attentionStore.list(d.b.accountId)).find((item) => item.type === 'assistant_needs_owner')!;
  const attentionA = (await d.attentionStore.list(d.a.accountId)).find((item) => item.type === 'assistant_needs_owner')!;

  for (const [reader, own, foreign, foreignAttention] of [
    [d.a, callA, callB, attentionB], [d.b, callB, callA, attentionA],
  ] as const) {
    const listed = (await request(d.app).get('/conversations').set(reader.headers)).body as Array<{ id: string }>;
    assert.deepEqual(listed.map((item) => item.id), [own.conversationId], 'the inbox holds only the reader’s own conversations');
    for (const path of [
      `/conversations/${foreign.conversationId}`, `/conversations/${foreign.conversationId}/runtime`,
      `/conversations/${foreign.conversationId}/runtime/commands`, `/conversations/${foreign.conversationId}/audit`,
      `/owner/attention/${foreignAttention.id}`,
    ]) {
      const response = await request(d.app).get(path).set(reader.headers);
      assert.equal(response.status, 404, `${path} must not exist for another account`);
      assert.ok(!JSON.stringify(response.body).includes(foreign.conversationId), 'and says nothing about it');
    }
    const plane = (await request(d.app).get('/owner/control-plane').set(reader.headers)).body;
    assert.deepEqual(plane.live.map((item: { id: string }) => item.id), [own.conversationId]);
    assert.ok(plane.attention.every((item: { conversationId: string }) => item.conversationId === own.conversationId));
    const attention = (await request(d.app).get('/owner/attention').set(reader.headers)).body as Array<{ conversationId: string }>;
    assert.ok(attention.length > 0 && attention.every((item) => item.conversationId === own.conversationId));
    const filtered = (await request(d.app).get(`/owner/attention?conversationId=${foreign.conversationId}`).set(reader.headers)).body;
    assert.deepEqual(filtered, [], 'filtering by another account’s conversation yields nothing');
    const devices = (await request(d.app).get('/owner/devices').set(reader.headers)).body as Array<{ accountId: string }>;
    assert.ok(devices.length === 1 && devices.every((device) => device.accountId === reader.accountId));
    const pushDevices = (await request(d.app).get('/owner/push/devices').set(reader.headers)).body as Array<{ label: string }>;
    assert.equal(pushDevices.length, 1);
    const phone = (await request(d.app).get('/owner/phone').set(reader.headers)).body;
    assert.deepEqual([phone.assistantLine, phone.ownerNumber], [reader.line, reader.personal]);
    const me = (await request(d.app).get('/me').set(reader.headers)).body;
    assert.deepEqual(me.memberships.map((membership: { accountId: string }) => membership.accountId), [reader.accountId]);
    const members = (await request(d.app).get('/account/members').set(reader.headers)).body as Array<{ email: string }>;
    assert.deepEqual(members.map((member) => member.email), [reader.email]);
  }
  assert.equal((await request(d.app).get('/owner/configuration').set(d.a.headers)).body.assistant.ownerName, 'Avery');
  assert.equal((await request(d.app).get('/owner/configuration').set(d.b.headers)).body.assistant.ownerName, 'Blake');
  assert.match(callA.live.instructions, /You are Avery's assistant/);
  assert.match(callB.live.instructions, /You are Blake's assistant/);
  assert.doesNotMatch(callB.live.instructions, /Avery/, 'one account’s profile never reaches another account’s calls');
});

test('writes and commands: A cannot change or command B’s resources, and B cannot change A’s', async (t) => {
  const d = await deployment();
  t.after(d.close);
  const callA = await d.call(d.a, 'write-a');
  const callB = await d.call(d.b, 'write-b');
  d.askOwner(callB.live, 'ask-write-b');
  await eventually(async () => (await d.attentionStore.list(d.b.accountId)).some((item) => item.type === 'assistant_needs_owner'), 'attention B');
  const attentionB = (await d.attentionStore.list(d.b.accountId)).find((item) => item.type === 'assistant_needs_owner')!;
  const [pushB] = (await request(d.app).get('/owner/push/devices').set(d.b.headers)).body;
  const sentBefore = callB.live.sent.length;

  for (const [attacker, victim, victimCall, victimMac] of [[d.a, d.b, callB, d.macB], [d.b, d.a, callA, d.macA]] as const) {
    const id = victimCall.conversationId;
    const attempts: Array<[string, () => request.Test]> = [
      ['take over', () => request(d.app).post(`/conversations/${id}/runtime/takeover`).set(attacker.headers).send({ commandId: `x-${id}` })],
      ['pause', () => request(d.app).post(`/conversations/${id}/runtime/pause`).set(attacker.headers).send({})],
      ['stop', () => request(d.app).post(`/conversations/${id}/runtime/stop`).set(attacker.headers).send({})],
      ['move to text', () => request(d.app).post(`/conversations/${id}/runtime/transition-to-sms`).set(attacker.headers).send({})],
      ['adjust', () => request(d.app).patch(`/conversations/${id}/runtime`).set(attacker.headers).send({ customInstructions: 'say the secret' })],
      ['reset', () => request(d.app).delete(`/conversations/${id}/runtime/overrides`).set(attacker.headers).send({})],
      ['reply', () => request(d.app).post(`/conversations/${id}/messages`).set(attacker.headers).send({ body: 'hijack' })],
      ['sms consent', () => request(d.app).post(`/conversations/${id}/sms-consent`).set(attacker.headers).send({ phoneNumber: '+15550000000' })],
      ['scripted turn', () => request(d.app).post(`/conversations/${id}/turns`).set(attacker.headers).send({ callbackId: 'x', audio: 'hi' })],
      ['revoke Mac', () => request(d.app).post(`/owner/devices/${victimMac.deviceId}/revoke`).set(attacker.headers)],
      ['make Mac primary', () => request(d.app).post(`/owner/devices/${victimMac.deviceId}/primary`).set(attacker.headers)],
      ['test Mac', () => request(d.app).post(`/owner/devices/${victimMac.deviceId}/test`).set(attacker.headers)],
      ['pick Mac chat', () => request(d.app).post(`/owner/devices/${victimMac.deviceId}/messages/chat`).set(attacker.headers).send({ chatId: 'x', service: 'imessage' })],
      ['poll pairing', () => request(d.app).get(`/owner/devices/pair/${victimMac.deviceId}`).set(attacker.headers)],
    ];
    if (victim === d.b) {
      attempts.push(
        ['act on attention', () => request(d.app).post(`/owner/attention/${attentionB.id}/actions`).set(attacker.headers).send({ action: 'take_over' })],
        ['dismiss attention', () => request(d.app).post(`/owner/attention/${attentionB.id}/dismiss`).set(attacker.headers)],
        ['open attention', () => request(d.app).post(`/owner/attention/${attentionB.id}/opened`).set(attacker.headers)],
        ['remove push device', () => request(d.app).delete(`/owner/push/devices/${pushB.id}`).set(attacker.headers)],
      );
    }
    for (const [what, attempt] of attempts) {
      const response = await attempt();
      assert.ok([404, 409].includes(response.status), `${what}: expected refusal, got ${response.status} ${JSON.stringify(response.body)}`);
    }
    // Nothing happened to the victim: no commands, same runtime, same devices, still the owner in control.
    assert.deepEqual((await d.commands.list(id)).map((command) => command.accountId).filter((account) => account !== victim.accountId), []);
    const runtime = (await request(d.app).get(`/conversations/${id}/runtime`).set(victim.headers)).body;
    assert.equal(runtime.status, victim === d.b ? 'owner_needed' : 'active');
    assert.equal(runtime.temporarySettings, false);
    assert.equal((await request(d.app).get('/owner/devices').set(victim.headers)).body[0].status, 'active');
  }
  assert.equal((await request(d.app).get(`/owner/attention/${attentionB.id}`).set(d.b.headers)).body.status, 'delivered');
  assert.equal((await request(d.app).get('/owner/push/devices').set(d.b.headers)).body[0].status, 'active');
  assert.ok(!callB.live.sent.slice(sentBefore).some((event) => event.type === 'session-update' || event.type === 'response-cancel'),
    'B’s live call never received anything from A');

  // A command id is a job id: reusing B's command id from A's account can't touch B's conversation.
  await request(d.app).post(`/conversations/${callB.conversationId}/runtime/pause`).set(d.b.headers).send({ commandId: 'cmd-shared' });
  const reused = await request(d.app).post(`/conversations/${callA.conversationId}/runtime/stop`).set(d.a.headers).send({ commandId: 'cmd-shared' });
  assert.equal(reused.status, 409);
  assert.equal((await d.commands.get('cmd-shared'))!.accountId, d.b.accountId);
  assert.notEqual((await request(d.app).get(`/conversations/${callA.conversationId}/runtime`).set(d.a.headers)).body.status, 'ended');

  // Settings are per account.
  await request(d.app).patch('/owner/configuration').set(d.a.headers).send({ calls: { answerCalls: false } });
  assert.equal((await request(d.app).get('/owner/configuration').set(d.b.headers)).body.calls.answerCalls, true);
});

test('commands on the bus: a live call only ever applies commands of its own account', async (t) => {
  const d = await deployment();
  t.after(d.close);
  const callB = await d.call(d.b, 'bus-b');
  const before = callB.live.sent.length;
  // A forged event for B's conversation carrying another account's id (what a confused worker could emit).
  await d.bus.publish(createRuntimeEvent(callB.conversationId, 'runtime.stopped', { commandId: 'forged', accountId: d.a.accountId }, true));
  await d.bus.publish(createRuntimeEvent(callB.conversationId, 'runtime.owner_speech', { text: 'from A', commandId: 'forged-2', accountId: d.a.accountId }, true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(callB.live.sent.slice(before), [], 'ignored: no goodbye, no relayed speech');

  // The worker's bookkeeping refuses a command whose account differs from the call's conversation.
  const runtime = new RuntimeControlService(d.repository, new OwnerConfigurationService(), undefined as never, undefined as never,
    undefined as never, undefined as never, undefined, d.commands);
  await d.commands.record({ id: 'cmd-a', conversationId: callB.conversationId, runtimeId: 'rt', accountId: d.a.accountId, type: 'stop', payload: {}, status: 'applied', createdAt: new Date() });
  await assert.rejects(runtime.markCommandAppliedLive('cmd-a', callB.conversationId), CrossTenantJobError);
  assert.equal((await d.commands.get('cmd-a'))!.status, 'applied');
  assert.throws(() => assertJobOwnership({ id: 'j', accountId: d.a.accountId, resourceId: 'r' }, { accountId: d.b.accountId }), CrossTenantJobError);
  assert.throws(() => assertJobOwnership({ id: 'j', accountId: d.a.accountId, resourceId: 'r' }, null), CrossTenantJobError);
  assert.throws(() => assertJobOwnership({ id: 'j', accountId: d.a.accountId, resourceId: 'r' }, { accountId: '' }), CrossTenantJobError);
});

test('notifications: A receives A’s events, B receives B’s, and neither ever receives the other’s', async (t) => {
  const d = await deployment();
  t.after(d.close);
  // Mac channels off so each account's push device and SMS number are the only surfaces.
  for (const tenant of [d.a, d.b]) await request(d.app).patch('/owner/configuration').set(tenant.headers).send({ messages: { macosMessagesEnabled: false } });
  const callA = await d.call(d.a, 'notify-a');
  const callB = await d.call(d.b, 'notify-b');
  d.askOwner(callA.live, 'ask-notify-a');
  await eventually(() => d.push.sent.length === 1, 'A’s push');
  assert.equal(d.push.sent[0].endpoint, 'https://web.push.apple.com/device-a');
  assert.match(String(d.push.sent[0].payload.url), new RegExp(callA.conversationId));
  d.askOwner(callB.live, 'ask-notify-b');
  await eventually(() => d.push.sent.length === 2, 'B’s push');
  assert.equal(d.push.sent[1].endpoint, 'https://web.push.apple.com/device-b');
  assert.match(String(d.push.sent[1].payload.url), new RegExp(callB.conversationId));
  for (const tenant of [d.a, d.b]) {
    const own = await d.attentionStore.list(tenant.accountId);
    for (const item of own) {
      for (const delivery of await d.notificationDeliveries.list(item.id)) assert.equal(delivery.accountId, tenant.accountId);
    }
  }

  // With push gone, the SMS fallback goes to each account's own verified number, from its own line.
  d.push.sent.length = 0;
  for (const tenant of [d.a, d.b]) {
    const [device] = (await request(d.app).get('/owner/push/devices').set(tenant.headers)).body;
    await request(d.app).delete(`/owner/push/devices/${device.id}`).set(tenant.headers);
  }
  d.askOwner(callA.live, 'ask-notify-a2');
  d.askOwner(callB.live, 'ask-notify-b2');
  await eventually(() => d.messaging.sentMessages.filter((message) => /Question ask-notify-/.test(message.body)).length === 2, 'SMS fallbacks');
  const texts = d.messaging.sentMessages.filter((message) => /Question ask-notify-/.test(message.body));
  assert.deepEqual(texts.map((text) => [text.to, text.from, /a2/.test(text.body) ? 'A' : 'B']).sort(),
    [['+15551110001', d.a.line, 'A'], ['+15552220002', d.b.line, 'B']]);
  assert.equal(d.push.sent.length, 0);
});

test('owner texts route by the line they were sent to: A’s number can’t answer B’s callers', async (t) => {
  const d = await deployment();
  t.after(d.close);
  const callA = await d.call(d.a, 'sms-a');
  const callB = await d.call(d.b, 'sms-b');
  d.askOwner(callB.live, 'ask-sms-b');
  await eventually(async () => (await request(d.app).get(`/conversations/${callB.conversationId}`).set(d.b.headers)).body.ownerRequest !== null, 'B waits');

  // A's owner texts B's line: that's just a stranger texting B (no text conversation) — never an owner reply.
  const stray = await request(d.app).post('/webhooks/twilio/sms').type('form').send({ MessageSid: 'SM-stray', From: d.a.personal, To: d.b.line, Body: 'yes' });
  assert.equal(stray.status, 404);
  assert.notEqual((await request(d.app).get(`/conversations/${callB.conversationId}`).set(d.b.headers)).body.ownerRequest, null);
  // A's owner texting A's own line with nothing waiting: nothing of B's is touched.
  const own = await request(d.app).post('/webhooks/twilio/sms').type('form').send({ MessageSid: 'SM-own', From: d.a.personal, To: d.a.line, Body: 'yes' });
  assert.equal(own.status, 404);
  // B's owner texting B's line answers B's waiting caller.
  const answer = await request(d.app).post('/webhooks/twilio/sms').type('form').send({ MessageSid: 'SM-b', From: d.b.personal, To: d.b.line, Body: 'Yes' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.id, callB.conversationId);
  assert.equal((await request(d.app).get(`/conversations/${callA.conversationId}`).set(d.a.headers)).body.eventLog
    .filter((event: { type: string }) => event.type === 'owner.message').length, 0);
  // Unknown lines are refused outright.
  assert.equal((await request(d.app).post('/webhooks/twilio/sms').type('form').send({ MessageSid: 'SM-x', From: d.b.personal, To: '+15550000001', Body: 'x' })).status, 404);
});

test('jobs: each Mac works only its own account’s queue, and replies land only in its own account', async (t) => {
  const d = await deployment();
  t.after(d.close);
  const callB = await d.call(d.b, 'job-b');
  d.askOwner(callB.live, 'ask-job-b');
  await eventually(async () => (await d.macDeliveries.listPending(d.macB.deviceId)).length === 1, 'B’s Mac delivery queued');
  const [deliveryB] = await d.macDeliveries.listPending(d.macB.deviceId);
  assert.equal(deliveryB.accountId, d.b.accountId);
  assert.deepEqual(await d.macDeliveries.listPending(d.macA.deviceId), [], 'A’s Mac has nothing of B’s');

  // A's Mac tries B's queue, B's device routes, and B's delivery.
  assert.equal((await request(d.app).get(`/owner/devices/${d.macB.deviceId}/deliveries`).set(d.macA.auth)).status, 401);
  assert.equal((await request(d.app).get(`/owner/devices/${d.macB.deviceId}/configuration`).set(d.macA.auth)).status, 401);
  assert.deepEqual((await request(d.app).get(`/owner/devices/${d.macA.deviceId}/deliveries`).set(d.macA.auth)).body, []);
  assert.equal((await request(d.app).post(`/owner/devices/${d.macA.deviceId}/deliveries/${deliveryB.id}/requested`).set(d.macA.auth)
    .send({ providerRequestId: 'p' })).status, 404);
  assert.equal((await request(d.app).post(`/owner/devices/${d.macA.deviceId}/messages/replies`).set(d.macA.auth)
    .send({ externalId: 'e1', body: 'from A', deliveryId: deliveryB.id })).status, 409);
  const configA = (await request(d.app).get(`/owner/devices/${d.macA.deviceId}/configuration`).set(d.macA.auth)).body;
  assert.equal(configA.accountId, d.a.accountId);
  assert.equal(configA.configuration.assistant.ownerName, 'Avery');

  // B's Mac completes its own job; the reply reaches B's call only.
  await request(d.app).post(`/owner/devices/${d.macB.deviceId}/deliveries/${deliveryB.id}/requested`).set(d.macB.auth).send({ providerRequestId: 'p-b' });
  const reply = await request(d.app).post(`/owner/devices/${d.macB.deviceId}/messages/replies`).set(d.macB.auth)
    .send({ externalId: 'e-b', body: 'Yes', deliveryId: deliveryB.id });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.id, callB.conversationId);
  assert.equal((await d.commands.list(callB.conversationId)).every((command) => command.accountId === d.b.accountId), true);

  // A delivery job whose record names a different account than its Mac is refused, not executed.
  const forged = await d.macDeliveries.create({ accountId: d.a.accountId, deviceId: d.macB.deviceId, conversationId: callB.conversationId, messageId: 'm', body: 'x' });
  await d.macDeliveries.markSent(d.macB.deviceId, forged.id, 'p-forged');
  const refused = await request(d.app).post(`/owner/devices/${d.macB.deviceId}/messages/replies`).set(d.macB.auth)
    .send({ externalId: 'e-forged', body: 'hijack', deliveryId: forged.id });
  assert.equal(refused.status, 409);
  assert.ok(!(await request(d.app).get(`/conversations/${callB.conversationId}`).set(d.b.headers)).body.messages
    .some((message: { body: string }) => message.body === 'hijack'));
});

test('sessions and browsers: two simultaneous browsers stay isolated, and signing out and in never leaves stale account state', async (t) => {
  const d = await deployment();
  t.after(d.close);
  const received = { a: '', b: '' };
  const controllers: AbortController[] = [];
  t.after(() => controllers.forEach((controller) => controller.abort()));
  for (const [key, tenant] of [['a', d.a], ['b', d.b]] as const) {
    const controller = new AbortController();
    controllers.push(controller);
    const stream = await fetch(`http://127.0.0.1:${d.port}/owner/events?token=${tenant.token}`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      try { for (;;) { const { value, done } = await reader.read(); if (done) return; received[key] += decoder.decode(value); } } catch { /* aborted */ }
    })();
  }
  await eventually(() => received.a.includes('event: ready') && received.b.includes('event: ready'), 'both streams');
  const callA = await d.call(d.a, 'stream-a');
  const callB = await d.call(d.b, 'stream-b');
  d.askOwner(callA.live, 'ask-stream-a');
  d.askOwner(callB.live, 'ask-stream-b');
  await eventually(() => received.a.includes(callA.conversationId) && received.b.includes(callB.conversationId), 'events');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!received.a.includes(callB.conversationId), 'browser A never sees B’s events');
  assert.ok(!received.b.includes(callA.conversationId), 'browser B never sees A’s events');

  // One browser: A signs out, B signs in. The old token is dead; the control plane is B's, with nothing of A's.
  const browser = await signIn(d.app, d.a.email);
  const asA = (await request(d.app).get('/owner/control-plane').set(browser.headers)).body;
  assert.equal(asA.account.id, d.a.accountId);
  assert.equal((await request(d.app).delete('/auth/session').set(browser.headers)).status, 204);
  assert.equal((await request(d.app).get('/owner/control-plane').set(browser.headers)).status, 401);
  const next = await signIn(d.app, d.b.email);
  const asB = (await request(d.app).get('/owner/control-plane').set(next.headers)).body;
  assert.equal(asB.account.id, d.b.accountId);
  assert.equal(asB.user.email, d.b.email);
  assert.ok(!JSON.stringify(asB).includes(d.a.accountId) && !JSON.stringify(asB).includes(callA.conversationId) && !JSON.stringify(asB).includes('Avery'));
});

test('iOS: one app, one phone: signing into a different account switches the control plane and the phone’s notifications', async (t) => {
  const d = await deployment();
  t.after(d.close);
  for (const tenant of [d.a, d.b]) await request(d.app).patch('/owner/configuration').set(tenant.headers).send({ messages: { macosMessagesEnabled: false } });
  const token = 'ab'.repeat(32);
  // User A signs in on the phone and turns on notifications.
  const phoneA = await signIn(d.app, d.a.email, 'ios');
  assert.equal((await request(d.app).post('/owner/push/devices').set(phoneA.headers).send({ platform: 'ios', apnsToken: token })).status, 201);
  assert.equal((await request(d.app).get('/owner/control-plane').set(phoneA.headers)).body.account.id, d.a.accountId);
  // Same phone, same build: A signs out, B signs in and turns on notifications with the same APNs token.
  await request(d.app).delete('/auth/session').set(phoneA.headers);
  const phoneB = await signIn(d.app, d.b.email, 'ios');
  assert.equal((await request(d.app).post('/owner/push/devices').set(phoneB.headers).send({ platform: 'ios', apnsToken: token })).status, 201);
  const plane = (await request(d.app).get('/owner/control-plane').set(phoneB.headers)).body;
  assert.deepEqual([plane.account.id, plane.plane.assistantLine, plane.owner.name], [d.b.accountId, d.b.line, 'Blake']);

  // A's attention no longer reaches the phone; B's does.
  const callA = await d.call(d.a, 'ios-a');
  d.askOwner(callA.live, 'ask-ios-a');
  await eventually(async () => (await d.attentionStore.list(d.a.accountId)).some((item) => item.type === 'assistant_needs_owner'), 'A attention');
  const callB = await d.call(d.b, 'ios-b');
  d.askOwner(callB.live, 'ask-ios-b');
  await eventually(() => d.apns.sent.length === 1, 'B’s notification on the phone');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(d.apns.sent.length, 1);
  assert.equal(d.apns.sent[0].token, token);
  assert.match(String(d.apns.sent[0].message.payload.url), new RegExp(callB.conversationId));

  // Even without signing out (a session that just expired), registering the token for B retires A's registration.
  const phoneA2 = await signIn(d.app, d.a.email, 'ios');
  await request(d.app).post('/owner/push/devices').set(phoneA2.headers).send({ platform: 'ios', apnsToken: token });
  const devicesB = (await request(d.app).get('/owner/push/devices').set(d.b.headers)).body as Array<{ platform: string; status: string }>;
  assert.deepEqual(devicesB.filter((device) => device.platform === 'ios').map((device) => device.status), ['revoked']);
});
