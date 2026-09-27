/**
 * No correctness property may depend on which instance serves a request.
 *
 *            load balancer
 *      ┌──────────┼──────────┐
 *   API #1     API #2     API #N      (separate apps, separate process-local state)
 *      └──────────┼──────────┘
 *        durable shared state          (shared stores; Postgres + LISTEN/NOTIFY when available)
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import pg from 'pg';
import request from 'supertest';
import WebSocket from 'ws';

import { InMemoryNotificationDeliveryStore, InMemoryOwnerAttentionStore, InMemoryOwnerSurfaceDeviceStore } from '../src/attention/stores.js';
import type { PushSender } from '../src/attention/surfaces.js';
import { AuthService, InMemoryAuthSessionStore, PostgresAuthSessionStore, SESSION_TTL_MS } from '../src/auth/sessions.js';
import { buildServerWithPool } from '../src/bootstrap.js';
import { getConfig } from '../src/config.js';
import { createApp, type AppOptions } from '../src/http-app.js';
import { FakeMessagingProvider } from '../src/messaging/fake-provider.js';
import { InMemoryOwnerConfigurationStore, OwnerConfigurationService } from '../src/owner/configuration.js';
import { InMemoryOwnerDeviceSessionStore, InMemoryOwnerDeviceStore, InMemoryOwnerPairingCredentialStore, OwnerDeviceService } from '../src/owner/device.js';
import { InMemoryOwnerMessageDeliveryStore } from '../src/owner/delivery.js';
import { InMemoryRuntimeCommandStore } from '../src/runtime/commands.js';
import { InMemoryRuntimeEventBus } from '../src/runtime/event-bus.js';
import { InMemoryConversationRuntimeEventStore, InMemoryConversationRuntimeStore, InMemoryRuntimeOverrideStore } from '../src/runtime/store.js';
import { FakeTelephonyProvider } from '../src/telephony/fake-provider.js';
import { FakePhoneNumberClient } from '../src/telephony/phone-number.js';
import { TwilioProvider } from '../src/telephony/twilio-provider.js';
import { InMemoryTenancyStore } from '../src/tenancy/store.js';
import type { RealtimeClientEvent, RealtimeConnection, RealtimeConnectionHandlers, RealtimeConnector, RealtimeServerEvent } from '../src/voice/realtime/connector.js';
import { MEDIA_STREAM_PATH, RealtimeVoiceService } from '../src/voice/realtime/realtime-voice.js';
import { InMemoryConversationRepository } from './support/in-memory-repository.js';
import { onboardTenant, signIn, type Tenant } from './support/tenant.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

class Connector implements RealtimeConnector {
  readonly modelId = 'openai/gpt-realtime-2';
  sent: RealtimeClientEvent[] = [];
  handlers?: RealtimeConnectionHandlers;
  async connect(_config: unknown, handlers: RealtimeConnectionHandlers): Promise<RealtimeConnection> {
    this.handlers = handlers;
    return { send: async (event) => { this.sent.push(event); }, close: () => undefined };
  }
  emit(event: Record<string, unknown>) { this.handlers!.onEvent({ raw: {}, ...event } as RealtimeServerEvent); }
}

class CountingPush implements PushSender {
  sent: string[] = [];
  async publicKey() { return 'BKey'; }
  async send(subscription: { endpoint: string }) { this.sent.push(subscription.endpoint); return { statusCode: 201 }; }
}

const sockets: WebSocket[] = [];
test.after(() => sockets.forEach((socket) => socket.terminate()));

async function eventually(check: () => boolean | Promise<boolean>, what: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

interface Instance { name: string; app: Parameters<typeof request>[0]; server: Server; port: number; voice: RealtimeVoiceService; connector: Connector; close(): Promise<void> }

async function listen(name: string, app: Instance['app'], voice: RealtimeVoiceService, connector: Connector): Promise<Instance> {
  const server = createServer(app as Parameters<typeof createServer>[1]);
  voice.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    name, app, server, voice, connector, port: (server.address() as AddressInfo).port,
    close: async () => { server.closeAllConnections(); server.close(); },
  };
}

/** The durable layer every in-memory instance shares (standing in for the database). */
function sharedState() {
  const attentionStore = new InMemoryOwnerAttentionStore();
  return {
    repository: new InMemoryConversationRepository(),
    tenancyStore: new InMemoryTenancyStore(),
    authSessionStore: new InMemoryAuthSessionStore(),
    configurationStore: new InMemoryOwnerConfigurationStore(),
    deviceStores: [new InMemoryOwnerDeviceStore(), new InMemoryOwnerPairingCredentialStore(), new InMemoryOwnerDeviceSessionStore()] as const,
    runtimeStore: new InMemoryConversationRuntimeStore(),
    runtimeEventStore: new InMemoryConversationRuntimeEventStore(),
    runtimeOverrideStore: new InMemoryRuntimeOverrideStore(),
    runtimeCommandStore: new InMemoryRuntimeCommandStore(),
    runtimeEventBus: new InMemoryRuntimeEventBus(),
    attentionStore,
    notificationDeliveryStore: new InMemoryNotificationDeliveryStore(attentionStore),
    surfaceDeviceStore: new InMemoryOwnerSurfaceDeviceStore(),
    ownerDeliveryStore: new InMemoryOwnerMessageDeliveryStore(),
    phoneNumberClient: new FakePhoneNumberClient(),
    messaging: new FakeMessagingProvider(),
    push: new CountingPush(),
  };
}

/** A fresh process: its own services and caches, over the shared durable state. */
async function inMemoryInstance(name: string, state: ReturnType<typeof sharedState>): Promise<Instance> {
  const connector = new Connector();
  const voice = new RealtimeVoiceService(connector);
  const configuration = new OwnerConfigurationService(state.configurationStore);
  const options: AppOptions = {
    repository: state.repository, tenancyStore: state.tenancyStore, authSessionStore: state.authSessionStore,
    ownerConfigurationService: configuration, ownerDeviceService: new OwnerDeviceService(state.deviceStores[0], Date.now, state.deviceStores[1], state.deviceStores[2]),
    runtimeStore: state.runtimeStore, runtimeEventStore: state.runtimeEventStore, runtimeOverrideStore: state.runtimeOverrideStore,
    runtimeCommandStore: state.runtimeCommandStore, runtimeEventBus: state.runtimeEventBus,
    attentionStore: state.attentionStore, notificationDeliveryStore: state.notificationDeliveryStore, surfaceDeviceStore: state.surfaceDeviceStore,
    ownerDeliveryStore: state.ownerDeliveryStore, phoneNumberClient: state.phoneNumberClient, messagingProvider: state.messaging,
    pushSender: state.push, realtimeVoice: voice, publicBaseUrl: 'https://text-me.vercel.app',
    providers: [new TwilioProvider({ mediaStreamUrl: `wss://example.test${MEDIA_STREAM_PATH}` }), new FakeTelephonyProvider()],
  };
  return listen(name, createApp(options), voice, connector);
}

/**
 * The scenario, run the same way against in-memory instances and Postgres instances:
 * requests hop A → B → A → C, instances restart, a live call on one instance obeys
 * commands sent to others, concurrent commands run once, notifications go out once.
 */
async function exercise(instances: Instance[], restart: (name: string) => Promise<Instance>, messaging: FakeMessagingProvider, push: CountingPush,
  listConversations: (accountId: string) => Promise<Array<{ id: string; providerCallId: string }>>) {
  const [a, b, c] = instances;
  // Sign up on A, onboard on B, sign in on C: one account, whichever instance answers.
  const tenant: Tenant = await onboardTenant(a.app, messaging);
  const other: Tenant = await onboardTenant(b.app, messaging);
  const browser = await signIn(c.app, tenant.email);
  const route = [a, b, a, c];
  const views = [];
  for (const instance of route) views.push((await request(instance.app).get('/owner/control-plane').set(browser.headers)).body);
  for (const view of views) {
    assert.deepEqual([view.account.id, view.onboarding.state, view.plane.assistantLine, view.owner.name], [tenant.accountId, 'ready', tenant.line, 'Randy']);
  }
  // Settings written on one instance are read back on every other (revision checks included).
  const current = (await request(b.app).get('/owner/configuration').set(browser.headers)).body;
  assert.equal((await request(a.app).patch('/owner/configuration').set(browser.headers).send({ expectedRevision: current.revision, assistant: { tone: 'warm' } })).status, 200);
  assert.equal((await request(c.app).patch('/owner/configuration').set(browser.headers).send({ expectedRevision: current.revision, assistant: { tone: 'professional' } })).status, 409);
  assert.equal((await request(b.app).get('/owner/configuration').set(browser.headers)).body.assistant.tone, 'warm');

  // A push device registered through C; the call arrives at B; its media stream lands on A.
  await request(c.app).post('/owner/push/devices').set(browser.headers)
    .send({ subscription: { endpoint: `https://web.push.apple.com/${tenant.accountId}`, keys: { p256dh: 'k', auth: 'a' } } });
  const callId = `scale-${Date.now()}`;
  assert.equal((await request(b.app).post('/webhooks/fake/voice').send({ callId, callerPhone: '+15553334444', to: tenant.line })).status, 200);
  const conversation = (await listConversations(tenant.accountId)).find((item) => item.providerCallId === callId)!;
  const socket = new WebSocket(`ws://127.0.0.1:${a.port}${MEDIA_STREAM_PATH}`);
  sockets.push(socket);
  await new Promise((resolve) => socket.once('open', resolve));
  socket.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZ-scale', customParameters: { conversationId: conversation.id } } }));
  await eventually(() => Boolean(a.connector.handlers), 'live call on A');

  // Concurrent submissions of the same command, to different instances: applied once, reaches the call on A.
  const revision = (await request(c.app).get(`/conversations/${conversation.id}/runtime`).set(browser.headers)).body.revision;
  const commandId = `cmd-once-${callId}`;
  const [first, second] = await Promise.all([
    request(b.app).post(`/conversations/${conversation.id}/runtime/takeover`).set(browser.headers).send({ commandId, expectedRevision: revision }),
    request(c.app).post(`/conversations/${conversation.id}/runtime/takeover`).set(browser.headers).send({ commandId, expectedRevision: revision }),
  ]);
  assert.deepEqual([first.status, second.status], [200, 200], JSON.stringify([first.body, second.body]));
  await eventually(async () => {
    const commands = (await request(a.app).get(`/conversations/${conversation.id}/runtime/commands`).set(browser.headers)).body as Array<{ id: string; status: string }>;
    return commands.filter((command) => command.id === commandId).length === 1 && commands[0].status === 'applied_live';
  }, 'the call on A applied the command sent to B and C, once');
  // Different commands racing on one revision: exactly one wins, the other is told it's stale.
  const now = (await request(a.app).get(`/conversations/${conversation.id}/runtime`).set(browser.headers)).body.revision;
  const racing = await Promise.all([
    request(b.app).post(`/conversations/${conversation.id}/runtime/pause`).set(browser.headers).send({ expectedRevision: now }),
    request(c.app).post(`/conversations/${conversation.id}/runtime/return-to-assistant`).set(browser.headers).send({ expectedRevision: now }),
  ]);
  assert.deepEqual(racing.map((response) => response.status).sort(), [200, 409]);

  // The assistant needs the owner: one attention, one push, visible from every instance.
  a.connector.emit({ type: 'function-call-arguments-done', responseId: 'r', itemId: 'i', callId: 'ask-scale', name: 'ask_owner',
    arguments: JSON.stringify({ question: 'Friday?', suggestedReplies: [] }) });
  await eventually(() => push.sent.filter((endpoint) => endpoint.endsWith(tenant.accountId)).length === 1, 'one push');
  for (const instance of [a, b, c]) {
    const open = (await request(instance.app).get('/owner/attention?open=true').set(browser.headers)).body as Array<{ type: string }>;
    assert.equal(open.filter((item) => item.type === 'assistant_needs_owner').length, 1, `attention on ${instance.name}`);
  }

  // Instance C restarts (a new process); the browser's session and all state carry over.
  const restarted = await restart(c.name);
  const afterRestart = (await request(restarted.app).get(`/conversations/${conversation.id}`).set(browser.headers)).body;
  assert.equal(afterRestart.id, conversation.id);
  assert.equal(afterRestart.ownerRequest.question, 'Friday?');
  // The owner answers through the restarted instance; the live call on A relays it.
  const replied = await request(restarted.app).post(`/conversations/${conversation.id}/messages`).set(browser.headers).send({ body: 'Friday works', idempotencyKey: 'scale-reply' });
  assert.equal(replied.status, 200, JSON.stringify(replied.body));
  await eventually(() => a.connector.sent.some((event) => event.type === 'response-create' && /Friday works/.test(event.options?.instructions ?? '')), 'relayed on A');

  // Sign-out on one instance is sign-out everywhere; the other account never saw any of this.
  assert.equal((await request(b.app).get('/conversations').set(other.headers)).body.length, 0);
  assert.equal((await request(a.app).delete('/auth/session').set(browser.headers)).status, 204);
  for (const instance of [b, restarted]) assert.equal((await request(instance.app).get('/owner/me').set(browser.headers)).status, 401);
  socket.close();
  return { tenant, conversationId: conversation.id };
}

test('in-memory: any instance serves any account; restarts and concurrency change nothing', async (t) => {
  const state = sharedState();
  const instances = await Promise.all(['A', 'B', 'C'].map((name) => inMemoryInstance(name, state)));
  const all = [...instances];
  t.after(() => Promise.all(all.map((instance) => instance.close())));
  await exercise(instances, async (name) => {
    const index = instances.findIndex((instance) => instance.name === name);
    await instances[index].close();
    const next = await inMemoryInstance(`${name}'`, state);
    all.push(next);
    return next;
  }, state.messaging, state.push, (accountId) => state.repository.list(accountId));
});

test('session renewal is shared state: one instance renews, every instance honours the new expiry', async () => {
  let clock = Date.parse('2026-09-26T12:00:00Z');
  const store = new InMemoryAuthSessionStore();
  const one = new AuthService(store, () => clock);
  const two = new AuthService(store, () => clock);
  const { token } = await one.createSession('usr_1', 'acct_1', { platform: 'web' });
  clock += SESSION_TTL_MS - 60_000;
  assert.equal((await one.authenticate(token)).ok, true, 'renewed on instance one');
  clock += SESSION_TTL_MS - 60_000;
  assert.equal((await two.authenticate(token)).ok, true, 'instance two sees the renewal');
});

test('Postgres: separate instances, separate pools, one database — the same guarantees', {
  skip: databaseUrl ? false : 'set TEST_DATABASE_URL to run against Postgres',
}, async (t) => {
  const env = { DATABASE_URL: databaseUrl, TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'twilio-test', PUBLIC_BASE_URL: 'https://text-me.vercel.app', REALTIME_VOICE: 'off', TELEPHONY_NUMBER_PURCHASE: 'on' };
  const config = getConfig(env);
  const messaging = new FakeMessagingProvider();
  const push = new CountingPush();
  const phoneNumberClient = new FakePhoneNumberClient();
  const pools: pg.Pool[] = [];
  const all: Instance[] = [];
  const start = async (name: string) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    pools.push(pool);
    const connector = new Connector();
    const voice = new RealtimeVoiceService(connector);
    const built = buildServerWithPool(config, pool, { realtimeVoice: voice, pushSender: push }, { phoneNumberClient, messagingProvider: messaging });
    await built.ready;
    await built.stores.runtimeEventBus.ready();
    // Subscribing before any call makes each instance's LISTEN connection live.
    built.stores.runtimeEventBus.subscribeAll(() => undefined);
    const instance = await listen(name, built.app, voice, connector);
    const close = instance.close;
    instance.close = async () => { await close(); await built.stores.runtimeEventBus.close(); };
    all.push(instance);
    return instance;
  };
  t.after(async () => {
    await Promise.all(all.map((instance) => instance.close().catch(() => undefined)));
    await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
  });
  const instances = [await start('A'), await start('B'), await start('C')];
  const listPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  pools.push(listPool);
  const { PostgresConversationRepository } = await import('../src/repositories/postgres-conversation-repository.js');
  const conversations = new PostgresConversationRepository(listPool);
  await exercise(instances, async (name) => {
    await instances.find((instance) => instance.name === name)!.close();
    return start(`${name}'`);
  }, messaging, push, (accountId) => conversations.list(accountId));

  // Session renewal against the shared table, from two "instances".
  const sessionPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  pools.push(sessionPool);
  const store = new PostgresAuthSessionStore(sessionPool);
  const tenant = await onboardTenant(instances[1].app, messaging);
  let clock = Date.now();
  const one = new AuthService(store, () => clock);
  const two = new AuthService(store, () => clock);
  const { token } = await one.createSession(tenant.userId, tenant.accountId, { platform: 'ios' });
  clock += SESSION_TTL_MS - 60_000;
  assert.equal((await one.authenticate(token)).ok, true);
  clock += SESSION_TTL_MS - 60_000;
  assert.equal((await two.authenticate(token)).ok, true, 'the renewal written by one instance is what the other reads');
});
