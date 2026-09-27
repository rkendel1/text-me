import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createHttp2Server, type Http2Server, type IncomingHttpHeaders } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import request from 'supertest';
import twilio from 'twilio';
import WebSocket from 'ws';

import { apnsJwt, HttpApnsSender } from '../src/attention/apns.js';
import {
  InMemoryNotificationDeliveryStore,
  InMemoryOwnerAttentionStore,
  InMemoryOwnerSurfaceDeviceStore,
} from '../src/attention/stores.js';
import type { PushSender } from '../src/attention/surfaces.js';
import { AuthService, InMemoryAuthSessionStore, SESSION_TTL_MS } from '../src/auth/sessions.js';
import { InMemoryTenancyStore } from '../src/tenancy/store.js';
import { getConfig } from '../src/config.js';
import { assertProductionComposition, createApp } from '../src/http-app.js';
import { FakeMessagingProvider } from '../src/messaging/fake-provider.js';
import { OwnerConfigurationService } from '../src/owner/configuration.js';
import { InMemoryRuntimeCommandStore } from '../src/runtime/commands.js';
import { FakeTelephonyProvider } from '../src/telephony/fake-provider.js';
import { TwilioProvider } from '../src/telephony/twilio-provider.js';
import type {
  RealtimeConnection,
  RealtimeConnectionHandlers,
  RealtimeConnector,
  RealtimeServerEvent,
} from '../src/voice/realtime/connector.js';
import { MEDIA_STREAM_PATH, RealtimeVoiceService } from '../src/voice/realtime/realtime-voice.js';
import { InMemoryConversationRepository } from './support/in-memory-repository.js';
import { onboardTenant, PASSWORD, signIn, signUp } from './support/tenant.js';

class Connector implements RealtimeConnector {
  readonly modelId = 'openai/gpt-realtime-2';
  private handlers?: RealtimeConnectionHandlers;
  async connect(_config: unknown, handlers: RealtimeConnectionHandlers): Promise<RealtimeConnection> {
    this.handlers = handlers;
    return { send: async () => undefined, close: () => undefined };
  }
  emit(event: Record<string, unknown>) { this.handlers!.onEvent({ raw: {}, ...event } as RealtimeServerEvent); }
  get connected() { return Boolean(this.handlers); }
}

class NoWebPush implements PushSender {
  async publicKey() { return 'BKey'; }
  async send() { return { statusCode: 201 }; }
}

/** Stands in for Apple: a real HTTP/2 server that checks what APNs checks. */
async function fakeApns(publicKeyPem: string) {
  const received: Array<{ headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  let reply: { status: number; reason?: string } = { status: 200 };
  const server: Http2Server = createHttp2Server();
  server.on('stream', (stream, headers) => {
    let raw = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { raw += chunk; });
    stream.on('end', () => {
      const [header, claims, signature] = String(headers.authorization ?? '').replace(/^bearer /, '').split('.');
      const validJwt = Boolean(signature) && verify('sha256', Buffer.from(`${header}.${claims}`),
        { key: createPublicKey(publicKeyPem), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
      received.push({ headers, body: JSON.parse(raw) });
      if (!validJwt) {
        stream.respond({ ':status': 403 });
        stream.end(JSON.stringify({ reason: 'InvalidProviderToken' }));
        return;
      }
      stream.respond({ ':status': reply.status, 'apns-id': 'apns-1' });
      stream.end(reply.reason ? JSON.stringify({ reason: reply.reason }) : '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    respondWith(next: { status: number; reason?: string }) { reply = next; },
    close: () => server.close(),
  };
}

async function plane(options: { apns?: HttpApnsSender; twilioAuthToken?: string; publicBaseUrl?: string } = {}) {
  const repository = new InMemoryConversationRepository();
  const connector = new Connector();
  const voice = new RealtimeVoiceService(connector);
  const attentionStore = new InMemoryOwnerAttentionStore();
  const surfaceDevices = new InMemoryOwnerSurfaceDeviceStore();
  const commands = new InMemoryRuntimeCommandStore();
  const configuration = new OwnerConfigurationService();
  const messaging = new FakeMessagingProvider();
  const app = createApp({
    repository,
    tenancyStore: new InMemoryTenancyStore(),
    messagingProvider: messaging,
    ownerConfigurationService: configuration,
    realtimeVoice: voice,
    pushSender: new NoWebPush(),
    apnsSender: options.apns,
    appleTeamId: 'TEAM123456',
    attentionStore,
    notificationDeliveryStore: new InMemoryNotificationDeliveryStore(attentionStore),
    surfaceDeviceStore: surfaceDevices,
    runtimeCommandStore: commands,
    authSessionStore: new InMemoryAuthSessionStore(),
    twilioAuthToken: options.twilioAuthToken,
    publicBaseUrl: options.publicBaseUrl,
    providers: [new TwilioProvider({ mediaStreamUrl: `wss://example.test${MEDIA_STREAM_PATH}` }), new FakeTelephonyProvider()],
  });
  const owner = await onboardTenant(app, messaging, { personal: '+15550009999' });
  const server: Server = createServer(app);
  voice.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const sockets: WebSocket[] = [];
  return {
    app, repository, connector, attentionStore, surfaceDevices, commands, configuration, port, owner, messaging,
    close: () => { sockets.forEach((socket) => socket.close()); server.closeAllConnections(); server.close(); },
    async signIn(platform: 'web' | 'ios' = 'web') {
      const response = await request(app).post('/auth/sessions').send({ email: owner.email, password: PASSWORD, platform });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      return { token: response.body.token as string, headers: { Authorization: `Bearer ${response.body.token}` }, session: response.body.session };
    },
    async call(callId = 'call-1') {
      await request(app).post('/webhooks/fake/voice').send({ callId, callerPhone: '+15553334444', to: owner.line });
      const conversation = (await repository.list(owner.accountId)).find((candidate) => candidate.providerCallId === callId)!;
      const socket = new WebSocket(`ws://127.0.0.1:${port}${MEDIA_STREAM_PATH}`);
      sockets.push(socket);
      await new Promise((resolve) => socket.once('open', resolve));
      socket.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', customParameters: { conversationId: conversation.id } } }));
      await eventually(() => connector.connected, 'realtime session');
      return conversation.id;
    },
    askOwner(callId = 'ask-1') {
      connector.emit({
        type: 'function-call-arguments-done', responseId: 'r', itemId: 'i', callId, name: 'ask_owner',
        arguments: JSON.stringify({ question: 'Can you do Friday at 2?', suggestedReplies: ['Friday at 2 works'] }),
      });
    },
  };
}

async function eventually(check: () => boolean | Promise<boolean>, what: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

test('one sign-in model for every surface: a user signs in to their account and gets a session; there is no shared access key', async (t) => {
  const p = await plane();
  t.after(p.close);
  const wrong = await request(p.app).post('/auth/sessions').send({ email: p.owner.email, password: 'not the password', platform: 'web' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'invalid_credentials');
  const nobody = await request(p.app).post('/auth/sessions').send({ email: 'nobody@example.test', password: PASSWORD, platform: 'web' });
  assert.equal(nobody.status, 401, 'an unknown email looks exactly like a wrong password');
  assert.equal(nobody.body.code, 'invalid_credentials');
  assert.equal((await request(p.app).post('/auth/sessions').send({ accessKey: 'owner-access-key' })).status, 401, 'access keys are gone');
  assert.equal((await request(p.app).get('/owner/control-plane')).status, 401, 'no anonymous access');
  assert.equal((await request(p.app).get('/owner/control-plane').set({ Authorization: 'Bearer owner-access-key' })).status, 401);

  const web = await p.signIn('web');
  const ios = await p.signIn('ios');
  assert.match(web.token, /^ses_[A-Za-z0-9_-]{40,}$/);
  assert.equal(web.session.platform, 'web');
  assert.equal(ios.session.platform, 'ios');
  assert.equal(web.session.accountId, p.owner.accountId, 'the session names the account it operates on');
  assert.equal((await request(p.app).get('/conversations').set({ authorization: `bearer ${web.token}` })).status, 200);
  const me = await request(p.app).get('/owner/me').set(ios.headers);
  assert.deepEqual({ accountId: me.body.accountId, userId: me.body.userId, name: me.body.name, platform: me.body.session.platform },
    { accountId: p.owner.accountId, userId: p.owner.userId, name: 'Randy', platform: 'ios' });
  const current = await request(p.app).get('/auth/session').set(web.headers);
  assert.equal(current.body.credential, 'session');
  const listed = (await request(p.app).get('/auth/sessions').set(web.headers)).body as Array<{ platform: string; current: boolean }>;
  assert.deepEqual(listed.map((session) => [session.platform, session.current]).sort(), [['ios', false], ['web', false], ['web', true]],
    'the sign-up session, this browser and the iPhone');

  // Tokens in URLs are accepted only by the live streams (EventSource can't set headers).
  assert.equal((await request(p.app).get(`/owner/control-plane?token=${web.token}`)).status, 401);
  const stream = await fetch(`http://127.0.0.1:${p.port}/owner/events?token=${web.token}`);
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  await stream.body?.cancel();
});

test('sessions expire, slide while used, and a revoked device is out immediately and stops getting notifications', async (t) => {
  let clock = Date.parse('2026-09-26T12:00:00Z');
  const auth = new AuthService(new InMemoryAuthSessionStore(), () => clock);
  const { token } = await auth.createSession('usr_1', 'acct_1', { platform: 'ios' });
  clock += SESSION_TTL_MS - 60_000;
  assert.equal((await auth.authenticate(token)).ok, true, 'used just before expiry: extended');
  clock += SESSION_TTL_MS - 60_000;
  assert.equal((await auth.authenticate(token)).ok, true, 'still valid because it was used');
  clock += SESSION_TTL_MS + 1;
  assert.deepEqual(await auth.authenticate(token), { ok: false, reason: 'expired' });
  assert.deepEqual(await auth.authenticate('ses_forged'), { ok: false, reason: 'invalid' });
  assert.deepEqual(await auth.authenticate(undefined), { ok: false, reason: 'missing' });

  const p = await plane();
  t.after(p.close);
  const phone = await p.signIn('ios');
  const laptop = await p.signIn('web');
  await request(p.app).post('/owner/push/devices').set(laptop.headers)
    .send({ subscription: { endpoint: 'https://web.push.apple.com/laptop', keys: { p256dh: 'k', auth: 'a' } } });
  assert.equal((await request(p.app).delete(`/auth/sessions/${laptop.session.id}`).set(phone.headers)).status, 204);
  const revoked = await request(p.app).get('/owner/control-plane').set(laptop.headers);
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.code, 'session_revoked');
  assert.deepEqual((await p.surfaceDevices.list(p.owner.accountId)).map((device) => device.status), ['revoked'],
    'signing a device out stops its notifications');
  // Signing yourself out.
  assert.equal((await request(p.app).delete('/auth/session').set(phone.headers)).status, 204);
  assert.equal((await request(p.app).get('/owner/me').set(phone.headers)).status, 401);
});

test('the control-plane snapshot: identity, plane status through its lifecycle, live work and pending attention', async (t) => {
  const p = await plane();
  t.after(p.close);
  const { headers } = await p.signIn();
  const snapshot = async () => (await request(p.app).get('/owner/control-plane').set(headers)).body;

  const idle = await snapshot();
  assert.equal(idle.owner.id, p.owner.accountId);
  assert.deepEqual(idle.account, { id: p.owner.accountId, name: 'Randy', role: 'owner' });
  assert.equal(idle.user.email, p.owner.email);
  assert.equal(idle.onboarding.state, 'ready');
  assert.match(idle.plane.id, /^plane_/);
  assert.equal(idle.plane.assistantLine, p.owner.line);
  assert.equal(idle.plane.status, 'online');
  assert.deepEqual(idle.plane.voice, { realtime: true, model: 'openai/gpt-realtime-2' });
  assert.deepEqual([idle.live.length, idle.attention.length], [0, 0]);

  const conversationId = await p.call();
  const working = await snapshot();
  assert.equal(working.plane.status, 'working');
  assert.equal(working.live[0].id, conversationId);

  p.askOwner();
  await eventually(async () => (await snapshot()).plane.status === 'awaiting_attention', 'attention');
  const needs = await snapshot();
  const item = needs.attention.find((entry: { type: string }) => entry.type === 'assistant_needs_owner');
  assert.equal(item.url, `/conversations/${conversationId}/live?attention=${item.id}`);

  // Command → acknowledgement → resulting state, all on the same contract.
  const takeOver = await request(p.app).post(`/conversations/${conversationId}/runtime/takeover`).set(headers).send({ commandId: 'cmd-1' });
  assert.equal(takeOver.status, 200);
  assert.equal(takeOver.body.status, 'takeover');
  const replay = await request(p.app).post(`/conversations/${conversationId}/runtime/takeover`).set(headers).send({ commandId: 'cmd-1' });
  assert.equal(replay.status, 200, 'retrying after a lost response is safe');
  assert.equal((await p.commands.list(conversationId)).filter((command) => command.id === 'cmd-1').length, 1);
  const commands = (await request(p.app).get(`/conversations/${conversationId}/runtime/commands`).set(headers)).body;
  assert.ok(commands.some((command: { id: string; status: string }) => command.id === 'cmd-1' &&
    ['applied', 'applied_live'].includes(command.status)));

  await p.configuration.update(p.owner.accountId, { calls: { answerCalls: false } });
  assert.equal((await snapshot()).plane.status, 'offline');
});

test('stale notifications never act: already handled elsewhere, dismissed, or replayed', async (t) => {
  const p = await plane();
  t.after(p.close);
  const web = await p.signIn('web');
  const ios = await p.signIn('ios');
  const conversationId = await p.call();
  p.askOwner();
  await eventually(async () => (await p.attentionStore.list(p.owner.accountId)).some((item) => item.type === 'assistant_needs_owner'), 'attention');
  const item = (await p.attentionStore.list(p.owner.accountId)).find((entry) => entry.type === 'assistant_needs_owner')!;

  // Answered from the iPhone's lock screen...
  const answered = await request(p.app).post(`/owner/attention/${item.id}/actions`).set(ios.headers)
    .send({ action: 'reply', body: 'Friday at 2 works', commandId: `ios:${item.id}:reply` });
  assert.equal(answered.status, 200);
  // ...then iOS retries the same action (lost response): the same result, sent once.
  const retried = await request(p.app).post(`/owner/attention/${item.id}/actions`).set(ios.headers)
    .send({ action: 'reply', body: 'Friday at 2 works', commandId: `ios:${item.id}:reply` });
  assert.equal(retried.status, 200);
  const detail = (await request(p.app).get(`/conversations/${conversationId}`).set(ios.headers)).body;
  const ownerReplies = detail.messages.filter((message: { role: string; body: string }) => message.role === 'owner' && message.body === 'Friday at 2 works');
  assert.equal(ownerReplies.length, 1);
  // ...and the browser's stale notification tap does nothing but show where it stands.
  const stale = await request(p.app).post(`/owner/attention/${item.id}/actions`).set(web.headers).send({ action: 'take_over' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'attention_resolved');
  assert.equal((await request(p.app).get(`/owner/attention/${item.id}`).set(web.headers)).body.status, 'acted');
  assert.notEqual((await request(p.app).get(`/conversations/${conversationId}`).set(web.headers)).body.runtime.status, 'takeover');
  // The same state, whichever surface asks.
  const fromWeb = (await request(p.app).get('/owner/control-plane').set(web.headers)).body;
  const fromIos = (await request(p.app).get('/owner/control-plane').set(ios.headers)).body;
  assert.deepEqual({ ...fromWeb, session: null, serverTime: null }, { ...fromIos, session: null, serverTime: null });
});

test('native iOS notifications go to APNs with the same attention and deep link; dead tokens are retired', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const apns = await fakeApns(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  t.after(apns.close);
  const sender = new HttpApnsSender({
    keyId: 'KEY1234567', teamId: 'TEAM123456', bundleId: 'app.textme.owner', environment: 'production', origin: apns.origin,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });
  t.after(() => sender.close());
  const p = await plane({ apns: sender });
  t.after(p.close);
  const ios = await p.signIn('ios');
  assert.equal((await request(p.app).get('/owner/push/config').set(ios.headers)).body.nativePush, true);
  assert.equal((await request(p.app).post('/owner/push/devices').set(ios.headers).send({ platform: 'ios', apnsToken: 'not-hex' })).status, 400);
  const token = 'a1'.repeat(32);
  const registered = await request(p.app).post('/owner/push/devices').set(ios.headers).send({ platform: 'ios', apnsToken: token, label: 'Randy’s iPhone' });
  assert.equal(registered.status, 201);
  assert.deepEqual(registered.body.capabilities, ['push', 'deep_link', 'interactive_notification']);

  const conversationId = await p.call();
  p.askOwner();
  await eventually(() => apns.received.length === 1, 'APNs delivery');
  const [sent] = apns.received;
  const item = (await p.attentionStore.list(p.owner.accountId)).find((entry) => entry.type === 'assistant_needs_owner')!;
  assert.equal(sent.headers[':path'], `/3/device/${token}`);
  assert.equal(sent.headers['apns-topic'], 'app.textme.owner');
  assert.equal(sent.headers['apns-push-type'], 'alert');
  assert.equal(sent.headers['apns-priority'], '10');
  assert.equal(sent.headers['apns-collapse-id'], item.id, 'a repeat of the same attention replaces, never duplicates');
  const aps = sent.body.aps as Record<string, unknown>;
  assert.deepEqual(aps.alert, { title: '+15553334444 needs you', body: '“Can you do Friday at 2?”' });
  assert.equal(aps.category, 'OWNER_ATTENTION');
  assert.equal(aps['interruption-level'], 'time-sensitive');
  assert.equal(sent.body.url, `/conversations/${conversationId}/live?attention=${item.id}`);
  assert.equal(sent.body.attentionId, item.id);
  const audit = (await request(p.app).get(`/conversations/${conversationId}/audit`).set(ios.headers)).body;
  assert.ok(audit.timeline.some((entry: { type: string; ids: { surface?: string } }) => entry.type === 'notification.sent' && entry.ids.surface === 'apns'));

  // The app was deleted: Apple says 410, and the device stops being a target.
  apns.respondWith({ status: 410, reason: 'Unregistered' });
  p.askOwner('ask-2');
  await eventually(async () => (await p.surfaceDevices.list(p.owner.accountId))[0].status === 'expired', 'token retired');

  // Universal links for the app's domain.
  const association = await request(p.app).get('/.well-known/apple-app-site-association');
  assert.deepEqual(association.body.applinks.details[0].appIDs, ['TEAM123456.app.textme.owner']);
  assert.ok(association.body.applinks.details[0].components.some((component: Record<string, string>) => component['/'] === '/conversations/*/live'));
  assert.match(apnsJwt({ keyId: 'K', teamId: 'T', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }, 0), /^[\w-]+\.[\w-]+\.[\w-]+$/);
});

test('without APNs configured, iOS registration is refused clearly instead of silently dropping notifications', async (t) => {
  const p = await plane();
  t.after(p.close);
  const ios = await p.signIn('ios');
  const refused = await request(p.app).post('/owner/push/devices').set(ios.headers).send({ platform: 'ios', apnsToken: 'b2'.repeat(32) });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'apns_not_configured');
  assert.equal((await request(p.app).get('/.well-known/apple-app-site-association')).status, 404);
});

test('production never falls back to in-memory state, fake providers or a fake model', () => {
  assert.throws(() => assertProductionComposition({ repository: new InMemoryConversationRepository(), includeFakeProviderRoutes: false }),
    /Refusing to start in production without: runtime state store, .*account store, phone number service, .*AI text model/);
  assert.throws(() => createApp({ repository: new InMemoryConversationRepository(), production: true }), /Refusing to start in production/);
  const env = { DATABASE_URL: 'postgres://x', TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' };
  assert.throws(() => getConfig({ ...env, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://x.test' }), /AI Gateway credential is required in production/);
  assert.throws(() => getConfig({ ...env, NODE_ENV: 'production', AI_GATEWAY_API_KEY: 'k', PUBLIC_BASE_URL: 'http://x.test' }), /must be an https URL/);
  assert.throws(() => getConfig({ ...env, NODE_ENV: 'production', AI_GATEWAY_API_KEY: 'k', PUBLIC_BASE_URL: 'https://x.test', REALTIME_VOICE: 'off' }),
    /REALTIME_VOICE=off isn’t supported in production/);
  const vercel = getConfig({ ...env, VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'text-me.vercel.app', VERCEL_GIT_COMMIT_SHA: 'abc123' });
  assert.equal(vercel.production, true);
  assert.equal(vercel.enableFakeProviderRoutes, false);
  assert.deepEqual(vercel.release, { environment: 'production', commit: 'abc123' });
  assert.equal(getConfig({ ...env, REALTIME_VOICE: 'off', AI_GATEWAY_API_KEY: 'k' }).aiGateway?.textModelId, 'anthropic/claude-haiku-4.5',
    'turning realtime voice off keeps the real text model');
});

test('environment variables are platform configuration only: customer identity there refuses to start', () => {
  const env = { DATABASE_URL: 'postgres://x', TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' };
  const config = getConfig(env);
  for (const key of ['ownerPhone', 'ownerId', 'accountId', 'ownerAuthToken', 'twilioPhoneNumber']) {
    assert.ok(!(key in config), `no ${key} in the configuration`);
  }
  for (const key of ['OWNER_PHONE_NUMBER', 'OWNER_ID', 'OWNER_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'USER_NAME', 'USER_PHONE', 'USER_EMAIL', 'ACCOUNT_ID', 'DEVICE_ID']) {
    assert.throws(() => getConfig({ ...env, [key]: 'x' }), new RegExp(`${key} is set, but customer identity no longer comes from the environment`));
  }
});

test('Twilio webhooks verify behind Vercel’s proxy (signed for the public https URL)', async (t) => {
  const p = await plane({ twilioAuthToken: 'twilio-secret', publicBaseUrl: 'https://text-me.vercel.app' });
  t.after(p.close);
  const params = { CallSid: 'CA1', From: '+15553334444', To: '+15550000000' };
  const signature = twilio.getExpectedTwilioSignature('twilio-secret', 'https://text-me.vercel.app/webhooks/twilio/voice', params);
  const accepted = await request(p.app).post('/webhooks/twilio/voice').set('X-Twilio-Signature', signature).type('form').send(params);
  assert.equal(accepted.status, 200, 'the request arrives as http://127.0.0.1 but was signed for the public URL');
  const forged = await request(p.app).post('/webhooks/twilio/voice').set('X-Twilio-Signature', 'forged').type('form').send(params);
  assert.equal(forged.status, 403);
});

test('health: liveness always answers; readiness says exactly what a deployment is missing', async (t) => {
  const p = await plane();
  t.after(p.close);
  const live = await request(p.app).get('/health');
  assert.equal(live.status, 200);
  assert.equal(live.body.status, 'ok');
  const ready = await request(p.app).get('/health/ready');
  assert.equal(ready.status, 503, 'a development composition is not production-ready');
  assert.equal(ready.body.checks.authentication.ok, true);
  assert.equal(ready.body.checks.productionComposition.ok, false);
  assert.equal(ready.body.checks.webhookSignatures.ok, false);
  assert.ok(!JSON.stringify(ready.body).includes(p.owner.token), 'no secrets');
  assert.ok(!JSON.stringify(ready.body).includes(p.owner.email), 'no customer data');
});

test('the deployed app shell and static assets return through Express', async (t) => {
  const p = await plane();
  t.after(p.close);
  assert.equal((await request(p.app).get('/')).status, 200);
  assert.equal((await request(p.app).get('/health/ready')).status, 503);
  assert.equal((await request(p.app).get('/sw.js')).status, 200);
  assert.equal((await request(p.app).get('/manifest.webmanifest')).status, 200);
});

test('auth forms return to the app root after signing in from a deep link', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /location\.replace\('\\/'\);/);
  assert.doesNotMatch(html, /location\.replace\(location\.pathname/);
});

test('keep your real number: the account’s line comes from the platform pool, and forwarding is proven by a forwarded call', async () => {
  const { FakePhoneNumberClient, forwardingCodes } = await import('../src/telephony/phone-number.js');
  assert.deepEqual(forwardingCodes('+15550000000').map((code) => [code.enable, code.disable]), [['**004*+15550000000#', '##004#'], ['*715550000000', '*73']]);
  assert.deepEqual(forwardingCodes('+447700900123').map((code) => code.carrier), ['AT&T, T-Mobile and most carriers'], 'no Verizon code outside the US');

  const repository = new InMemoryConversationRepository();
  const messaging = new FakeMessagingProvider();
  const app = createApp({
    repository, messagingProvider: messaging, publicBaseUrl: 'https://text-me.vercel.app',
    phoneNumberClient: new FakePhoneNumberClient(['+15550000000'], false),
    providers: [new TwilioProvider(), new FakeTelephonyProvider()],
  });
  const owner = await onboardTenant(app, messaging, { personal: '+15551112222' });
  assert.equal(owner.line, '+15550000000');
  const before = (await request(app).get('/owner/phone').set(owner.headers)).body;
  assert.deepEqual([before.ownerNumber, before.assistantLine, before.connected, before.forwardingSeen], ['+15551112222', '+15550000000', true, false]);
  assert.deepEqual(before.forwarding.map((code: { enable: string }) => code.enable), ['**004*+15550000000#', '*715550000000']);

  // A call someone placed to the owner's real number, forwarded by the carrier to the account's line.
  const forwarded = await request(app).post('/webhooks/twilio/voice').type('form')
    .send({ CallSid: 'CA9', From: '+15553334444', To: '+15550000000', ForwardedFrom: '+15551112222' });
  assert.equal(forwarded.status, 200);
  const phone = (await request(app).get('/owner/phone').set(owner.headers)).body;
  assert.equal(phone.forwardingSeen, true);
  assert.ok(phone.lastForwardedAt);
  const [conversation] = await repository.list(owner.accountId);
  assert.ok(conversation.events.some((event) => event.type === 'call.forwarded' && event.payload.from === '+15551112222'));
});

test('a misconfigured deployment explains itself instead of crashing', async () => {
  const { ConfigurationError } = await import('../src/config.js');
  const { startupFailureServer } = await import('../src/startup-failure.js');
  let caught: unknown;
  try {
    getConfig({ VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'text-me-five.vercel.app', TWILIO_AUTH_TOKEN: 'secret-value', OWNER_PHONE_NUMBER: '555 111 2222', APNS_KEY_ID: 'K' });
  } catch (error) { caught = error; }
  assert.ok(caught instanceof ConfigurationError);
  const problems = (caught as InstanceType<typeof ConfigurationError>).problems.join('\n');
  // Every problem at once, each with what to do.
  for (const expected of [/DATABASE_URL is missing/, /TWILIO_ACCOUNT_SID is missing/,
    /OWNER_PHONE_NUMBER is set, but customer identity no longer comes from the environment/, /iOS push is partly configured: also set APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_BUNDLE_ID/]) {
    assert.match(problems, expected);
  }
  assert.ok(!problems.includes('secret-value') && !problems.includes('555 111 2222'), 'values are never echoed');

  const server = startupFailureServer(caught);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${base}/`, { headers: { Accept: 'text/html' } });
    assert.equal(page.status, 503);
    const html = await page.text();
    assert.match(html, /Almost there/);
    assert.match(html, /TWILIO_ACCOUNT_SID is missing/);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const ready = await fetch(`${base}/health/ready`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).status, 'not_configured');
    const apiCall = await fetch(`${base}/owner/control-plane`);
    assert.equal((await apiCall.json()).code, 'not_configured');
    // Anything that isn't a configuration problem stays in the logs.
    const other = startupFailureServer(new Error('password=hunter2'));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const otherReady = await (await fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}/health/ready`)).json();
    assert.ok(!JSON.stringify(otherReady).includes('hunter2'));
    other.close();
  } finally {
    server.close();
  }
});

test('database setup is retried after a failure, and the app shell loads meanwhile', async () => {
  let attempts = 0;
  const app = createApp({
    repository: new InMemoryConversationRepository(),
    beforeRequest: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('connection refused');
    },
  });
  assert.equal((await request(app).get('/')).status, 200, 'the app itself still loads');
  const down = await request(app).post('/auth/signup').send({ email: 'retry@example.test', password: PASSWORD });
  assert.equal(down.status, 503);
  assert.equal(down.body.code, 'database_unavailable');
  const { headers } = await signUp(app, { email: 'retry@example.test' });
  assert.equal((await request(app).get('/owner/control-plane').set(headers)).status, 200, 'the next request retries and succeeds');
  assert.equal((await signIn(app, 'retry@example.test')).body.account.id, (await request(app).get('/me').set(headers)).body.account.id);
});

test('a failed live-updates connection never crashes the process', async () => {
  const pg = (await import('pg')).default;
  const { PostgresRuntimeEventBus } = await import('../src/runtime/event-bus.js');
  const pool = new pg.Pool({ connectionString: 'postgres://nobody:none@127.0.0.1:1/none' });
  pool.on('error', () => undefined);
  const bus = new PostgresRuntimeEventBus(pool, 'postgres://nobody:none@127.0.0.1:1/none');
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const unsubscribe = bus.subscribeAll(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    unsubscribe();
    assert.deepEqual(unhandled, [], 'the connection error is handled, not left to kill the instance');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await bus.close();
    await pool.end();
  }
});
