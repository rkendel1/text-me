import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import pg from 'pg';
import { WebSocketServer } from 'ws';

import { getConfig, resolvePublicBaseUrl } from '../src/config.js';
import { createRuntimeEvent } from '../src/runtime/store.js';
import { PostgresRuntimeEventBus } from '../src/runtime/event-bus.js';
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
