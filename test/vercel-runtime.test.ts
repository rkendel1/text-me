import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import pg from 'pg';
import { WebSocketServer } from 'ws';

import { getConfig, resolvePublicBaseUrl } from '../src/config.js';
import { createRuntimeEvent } from '../src/runtime/store.js';
import { PostgresRuntimeEventBus } from '../src/runtime/event-bus.js';
import { PostgresConversationRepository } from '../src/repositories/postgres-conversation-repository.js';
import { PostgresRuntimeCommandStore } from '../src/repositories/postgres-conversation-runtime-repository.js';
import { GatewayRealtimeConnector, type RealtimeServerEvent } from '../src/voice/realtime/connector.js';

const baseEnv = {
  DATABASE_URL: 'postgres://pooled.neon.test/db',
  TWILIO_ACCOUNT_SID: 'AC1',
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_PHONE_NUMBER: '+15550000000',
  OWNER_PHONE_NUMBER: '+15551112222',
  OWNER_AUTH_TOKEN: 'owner',
};

test('on Vercel the default domain, Neon URLs and Gateway OIDC are picked up automatically', () => {
  const config = getConfig({
    ...baseEnv,
    VERCEL: '1',
    VERCEL_PROJECT_PRODUCTION_URL: 'text-me.vercel.app',
    DATABASE_URL_UNPOOLED: 'postgres://direct.neon.test/db',
  });
  assert.equal(config.publicBaseUrl, 'https://text-me.vercel.app');
  assert.equal(config.databaseListenUrl, 'postgres://direct.neon.test/db');
  assert.equal(config.enableFakeProviderRoutes, false);
  assert.equal(config.realtimeVoice?.modelId, 'openai/gpt-realtime-2');
  assert.equal(config.realtimeVoice?.apiKey, undefined);

  assert.equal(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://calls.example.com/' }), 'https://calls.example.com');
  assert.equal(getConfig(baseEnv).realtimeVoice, undefined);
  assert.equal(getConfig({ ...baseEnv, AI_GATEWAY_API_KEY: 'k', REALTIME_VOICE: 'off' }).realtimeVoice, undefined);
});

/**
 * A local stand-in for AI Gateway that enforces its realtime wire contract:
 * client-secret minting with the long-lived key, then a WebSocket authenticated
 * by subprotocol that speaks normalized AI SDK realtime events.
 */
async function startGatewayStandIn() {
  const seen = { mintAuth: '', mintModel: '', wsModel: '', protocols: [] as string[], clientEvents: [] as Array<Record<string, unknown>> };
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/realtime/client-secrets') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        seen.mintAuth = request.headers.authorization ?? '';
        seen.mintModel = JSON.parse(body).model;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ token: 'vcst_local', expiresAt: Math.floor(Date.now() / 1000) + 60 }));
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const wss = new WebSocketServer({
    server,
    handleProtocols: (protocols) => (protocols.has('ai-gateway-realtime.v1') ? 'ai-gateway-realtime.v1' : false),
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      seen.wsModel = url.searchParams.get('ai-model-id') ?? '';
      seen.protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((value) => value.trim());
      return url.pathname === '/v4/ai/realtime-model' && seen.protocols.includes('ai-gateway-auth.vcst_local');
    },
  });
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      const event = JSON.parse(data.toString());
      seen.clientEvents.push(event);
      if (event.type === 'session-update') socket.send(JSON.stringify({ type: 'session-updated', raw: {} }));
      if (event.type === 'response-create') {
        for (const reply of [
          { type: 'response-created', responseId: 'r1' },
          { type: 'audio-delta', responseId: 'r1', itemId: 'i1', delta: '//79' },
          { type: 'audio-transcript-done', responseId: 'r1', itemId: 'i1', transcript: 'Hello!' },
          { type: 'response-done', responseId: 'r1', status: 'completed' },
        ]) socket.send(JSON.stringify({ ...reply, raw: {} }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { seen, port, close: () => { wss.close(); server.close(); } };
}

test('GatewayRealtimeConnector drives a session through the AI SDK Gateway realtime model', async (t) => {
  const gateway = await startGatewayStandIn();
  t.after(gateway.close);
  const connector = new GatewayRealtimeConnector({
    modelId: 'openai/gpt-realtime-2',
    apiKey: 'test-gateway-key',
    baseURL: `http://127.0.0.1:${gateway.port}/v4/ai`,
  });
  const events: RealtimeServerEvent[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const connection = await connector.connect({
    instructions: 'Be brief.',
    inputAudioFormat: { type: 'audio/pcmu', rate: 8000 },
    outputAudioFormat: { type: 'audio/pcmu', rate: 8000 },
  }, {
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'response-done') resolveDone();
    },
    onClose: () => undefined,
  });
  await connection.send({ type: 'response-create', options: { instructions: 'Say hello' } });
  await done;
  connection.close();

  // The long-lived key only ever goes to the mint endpoint; the socket uses the short-lived secret.
  assert.equal(gateway.seen.mintAuth, 'Bearer test-gateway-key');
  assert.equal(gateway.seen.mintModel, 'openai/gpt-realtime-2');
  assert.equal(gateway.seen.wsModel, 'openai/gpt-realtime-2');
  assert.ok(gateway.seen.protocols.includes('ai-gateway-realtime.v1'));
  assert.ok(!gateway.seen.protocols.some((protocol) => protocol.includes('test-gateway-key')));
  assert.equal(gateway.seen.clientEvents[0].type, 'session-update');
  assert.deepEqual((gateway.seen.clientEvents[0].config as { inputAudioFormat: unknown }).inputAudioFormat, { type: 'audio/pcmu', rate: 8000 });
  assert.deepEqual(events.map((event) => event.type), ['session-updated', 'response-created', 'audio-delta', 'audio-transcript-done', 'response-done']);
});

const databaseUrl = process.env.TEST_DATABASE_URL;

test('runtime events published on one instance reach subscribers on another (Postgres LISTEN/NOTIFY)', {
  skip: databaseUrl ? false : 'set TEST_DATABASE_URL to run against Postgres',
}, async (t) => {
  const poolA = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const poolB = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const instanceA = new PostgresRuntimeEventBus(poolA, databaseUrl!);
  const instanceB = new PostgresRuntimeEventBus(poolB, databaseUrl!);
  t.after(async () => {
    await instanceA.close();
    await instanceB.close();
    await poolA.end();
    await poolB.end();
  });
  const received: string[] = [];
  const unsubscribe = instanceB.subscribe('conv_bus', (event) => received.push(`${event.type}:${event.payload.text}`));
  instanceB.subscribe('conv_other', () => received.push('wrong conversation'));
  await instanceB.ready();

  await instanceA.publish(createRuntimeEvent('conv_bus', 'runtime.paused', { text: 'pause' }, true));
  await instanceA.publish(createRuntimeEvent('conv_bus', 'runtime.owner_speech', { text: 'x'.repeat(9000) }, true));
  for (let attempt = 0; attempt < 100 && received.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(received[0], 'runtime.paused:pause');
  assert.match(received[1], /^runtime\.owner_speech:x{2000}…$/);
  assert.equal(received.length, 2);
  unsubscribe();
});

test('runtime commands persist in Postgres and never regress from applied_live', {
  skip: databaseUrl ? false : 'set TEST_DATABASE_URL to run against Postgres',
}, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  t.after(() => pool.end());
  const conversations = new PostgresConversationRepository(pool);
  await conversations.initialize();
  const store = new PostgresRuntimeCommandStore(pool);
  await store.initialize();
  const { conversation } = await conversations.createIfAbsent({
    provider: 'fake', providerCallId: `cmd-${Date.now()}`, callerPhone: '+15550001111', status: 'answered', startedAt: new Date(), ownerId: 'owner',
  });
  const id = `cmd_${Date.now()}`;
  await store.record({ id, conversationId: conversation.id, runtimeId: 'rt_test', ownerId: 'owner', type: 'stop', payload: {}, status: 'accepted', createdAt: new Date() });
  await store.update(id, { status: 'applied_live', appliedLiveAt: new Date() });
  await store.update(id, { status: 'applied', processedAt: new Date() });
  const [stored] = await store.list(conversation.id);
  assert.equal(stored.status, 'applied_live');
  assert.ok(stored.processedAt && stored.appliedLiveAt);
});

test('owner attention, deliveries, surface devices and push keys persist in Neon', {
  skip: databaseUrl ? false : 'set TEST_DATABASE_URL to run against Postgres',
}, async (t) => {
  const { PostgresOwnerAttentionStore, PostgresNotificationDeliveryStore, PostgresOwnerSurfaceDeviceStore, PostgresAppSecretStore } =
    await import('../src/attention/postgres.js');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  t.after(() => pool.end());
  const conversations = new PostgresConversationRepository(pool);
  await conversations.initialize();
  const attention = new PostgresOwnerAttentionStore(pool);
  const deliveries = new PostgresNotificationDeliveryStore(pool);
  const devices = new PostgresOwnerSurfaceDeviceStore(pool);
  const secrets = new PostgresAppSecretStore(pool);
  for (const store of [attention, deliveries, devices, secrets]) await store.initialize();
  const owner = `owner-${Date.now()}`;
  const { conversation } = await conversations.createIfAbsent({
    provider: 'fake', providerCallId: `att-${Date.now()}`, callerPhone: '+15550001111', status: 'answered', startedAt: new Date(), ownerId: owner,
  });
  const now = new Date();
  const base = {
    ownerId: owner, conversationId: conversation.id, type: 'assistant_needs_owner' as const, priority: 'interrupt' as const,
    title: 'Sam needs you', body: '“Friday?”', actions: ['reply' as const, 'take_over' as const], status: 'pending' as const,
    dedupeKey: 'owner-request:req_1', metadata: { requestId: 'req_1' }, createdAt: now, updatedAt: now,
  };
  const first = await attention.create({ ...base, id: `att_${Date.now()}a` });
  const duplicate = await attention.create({ ...base, id: `att_${Date.now()}b` });
  assert.equal(duplicate.id, first.id, 'dedupe key makes raising idempotent');
  await deliveries.record({ id: `ntf_${Date.now()}`, attentionId: first.id, ownerId: owner, surface: 'web_push', deviceId: 'dev_1', status: 'sent', providerId: '201', createdAt: now });
  await attention.update(first.id, { status: 'acted', resolvedAt: new Date(), metadata: { action: 'take_over' } });
  const stored = (await attention.get(first.id))!;
  assert.equal(stored.status, 'acted');
  assert.deepEqual(stored.metadata, { requestId: 'req_1', action: 'take_over' });
  assert.deepEqual(stored.actions, ['reply', 'take_over']);
  assert.equal((await attention.list(owner, { open: true })).length, 0);
  assert.equal((await deliveries.listForConversation(conversation.id))[0].surface, 'web_push');

  const token = JSON.stringify({ endpoint: `https://push.example/${owner}`, keys: { p256dh: 'k', auth: 'a' } });
  const device = await devices.upsert({ id: `dev_${Date.now()}`, ownerId: owner, platform: 'web', deviceToken: token, capabilities: ['push'], status: 'active', createdAt: now, lastSeenAt: now });
  const again = await devices.upsert({ id: 'dev_other', ownerId: owner, platform: 'web', deviceToken: token, capabilities: ['push', 'deep_link'], status: 'active', createdAt: now, lastSeenAt: new Date() });
  assert.equal(again.id, device.id, 'same subscription = same device');
  assert.deepEqual(again.capabilities, ['push', 'deep_link']);

  const key = `vapid-${Date.now()}`;
  const [a, b] = await Promise.all([secrets.getOrCreate(key, () => 'first'), secrets.getOrCreate(key, () => 'second')]);
  assert.equal(a, b, 'concurrent cold starts agree on one key');
});

test('production composition starts with no Mac at all, and a fresh instance recovers live state from Neon', {
  skip: databaseUrl ? false : 'set TEST_DATABASE_URL to run against Postgres',
}, async (t) => {
  const { buildServer } = await import('../src/bootstrap.js');
  const request = (await import('supertest')).default;
  // No Mac, no Photon, no Messages authorization, no AI Gateway key: just Neon + Twilio + owner token.
  const env = {
    DATABASE_URL: databaseUrl, TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'twilio-test', TWILIO_PHONE_NUMBER: '+15550000000',
    OWNER_PHONE_NUMBER: '+15551112222', OWNER_AUTH_TOKEN: 'owner-test', PUBLIC_BASE_URL: 'http://localhost', REALTIME_VOICE: 'off',
  };
  assert.ok(!Object.keys(env).some((key) => /MAC|PHOTON|PAIRING/i.test(key)));
  const first = buildServer(getConfig(env));
  const second = buildServer(getConfig(env));
  t.after(() => { first.server.close(); second.server.close(); });
  await Promise.all([first.ready, second.ready]);
  const auth = { Authorization: 'Bearer owner-test' };

  assert.equal((await request(first.server).get('/')).status, 200);
  assert.equal((await request(first.server).get('/conversations')).status, 401);
  const conversation = await request(first.server).post('/webhooks/fake/voice').send({ callId: `nomac-${Date.now()}`, callerPhone: '+15553334444' });
  assert.equal(conversation.status, 200);
  const listed = (await request(first.server).get('/conversations').set(auth)).body;
  const id = listed.find((item: { caller: string; status: string }) => item.caller === '+15553334444' && item.status === 'answered').id;
  const takeover = await request(first.server).post(`/conversations/${id}/runtime/takeover`).set(auth).send({});
  assert.equal(takeover.status, 200);
  const adjusted = await request(first.server).patch(`/conversations/${id}/runtime`).set(auth).send({ verbosity: 'detailed' });
  assert.equal(adjusted.status, 200);

  // A different instance (or the same app after a reload/restart) sees exactly the same state.
  const recovered = (await request(second.server).get(`/conversations/${id}`).set(auth)).body;
  assert.equal(recovered.runtime.status, 'takeover');
  assert.equal(recovered.runtime.verbosity, 'detailed');
  assert.equal(recovered.runtime.temporarySettings, true);
  const commands = (await request(second.server).get(`/conversations/${id}/runtime/commands`).set(auth)).body;
  assert.deepEqual(commands.map((command: { type: string }) => command.type), ['take_over', 'adjust_interaction']);
  const attention = (await request(second.server).get(`/owner/attention?conversationId=${id}`).set(auth)).body;
  assert.equal(attention[0].type, 'conversation_started');
  assert.equal((await request(second.server).get(`/conversations/${id}/live`)).status, 200);
});

test('Neon: a pairing credential can be redeemed exactly once, even by two simultaneous scans', {
  skip: databaseUrl ? false : 'set TEST_DATABASE_URL to run against Postgres',
}, async (t) => {
  const { PostgresOwnerDeviceStore, PostgresOwnerPairingCredentialStore, PostgresOwnerDeviceSessionStore, PostgresOwnerConfigurationStore } =
    await import('../src/repositories/postgres-owner-runtime-repository.js');
  const { OwnerDeviceService } = await import('../src/owner/device.js');
  const { OwnerConfigurationService } = await import('../src/owner/configuration.js');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  t.after(() => pool.end());
  const devices = new PostgresOwnerDeviceStore(pool);
  const pairings = new PostgresOwnerPairingCredentialStore(pool);
  const sessions = new PostgresOwnerDeviceSessionStore(pool);
  const configurations = new PostgresOwnerConfigurationStore(pool);
  for (const store of [devices, pairings, sessions, configurations]) await store.initialize();
  const service = new OwnerDeviceService(devices, Date.now, pairings, sessions);
  const owner = `owner-${Date.now()}`;
  const paired = await service.pair(owner, 'MacBook Pro');
  const results = await Promise.allSettled([service.activatePairing(paired.pairingUri), service.activatePairing(paired.pairingUri)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  const probed = await service.requestProbe(owner, paired.device.id);
  assert.equal((await devices.get(paired.device.id))!.probe!.id, probed.probe!.id, 'probe persists');

  // Concurrent settings edits: the second writer on a stale revision gets a conflict, not a silent overwrite.
  const settings = new OwnerConfigurationService(configurations);
  const start = await settings.get(owner);
  const outcomes = await Promise.allSettled([
    settings.update(owner, { assistant: { tone: 'warm' } }, 'web', start.revision),
    settings.update(owner, { assistant: { tone: 'professional' } }, 'web', start.revision),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal((await settings.get(owner)).revision, start.revision + 1);
});
