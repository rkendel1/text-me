import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp, type AppOptions } from '../src/http-app.js';
import { CallProviderRejectedError, FakeCallProvider } from '../src/calls/provider.js';
import { InMemoryCallSessionStore } from '../src/calls/store.js';
import { FakeMessagingProvider } from '../src/messaging/fake-provider.js';
import { TwilioProvider } from '../src/telephony/twilio-provider.js';
import { FakePhoneNumberClient } from '../src/telephony/phone-number.js';
import { InMemoryConversationRepository } from './support/in-memory-repository.js';
import { onboardTenant } from './support/tenant.js';

async function callApp(options: Partial<AppOptions> = {}) {
  const repository = new InMemoryConversationRepository();
  const messaging = new FakeMessagingProvider();
  const store = new InMemoryCallSessionStore();
  const callProvider = new FakeCallProvider();
  const phoneNumberClient = new FakePhoneNumberClient();
  const app = createApp({ repository, messagingProvider: messaging, callSessionStore: store, callProvider, phoneNumberClient, ...options });
  const owner = await onboardTenant(app, messaging);
  const sessions = async () => store.list(owner.accountId, { limit: 100 });
  const sessionFor = async (providerCallId: string) => (await store.findByProviderCallId('twilio', providerCallId))!;
  const inbound = (CallSid: string, extra: Record<string, string> = {}) =>
    request(app).post('/webhooks/twilio/voice').type('form').send({ CallSid, From: '+15555550123', To: owner.line, Direction: 'inbound', ...extra });
  const status = (CallSid: string, CallStatus: string, extra: Record<string, string> = {}) =>
    request(app).post('/webhooks/twilio/status').type('form').send({ CallSid, CallStatus, ...extra });
  return { app, repository, messaging, store, callProvider, phoneNumberClient, owner, sessions, sessionFor, inbound, status };
}

test('an inbound call creates a CallSession that is answered and linked to its conversation', async () => {
  const { inbound, sessions, sessionFor, repository, owner } = await callApp();
  const response = await inbound('CA-INB-1');
  assert.equal(response.status, 200);
  assert.match(response.text, /<Response>/, 'the existing voice handling still answers');

  const [conversation] = await repository.list(owner.accountId);
  const session = await sessionFor('CA-INB-1');
  assert.equal(session.direction, 'inbound');
  assert.equal(session.status, 'answered');
  assert.equal(session.provider, 'twilio');
  assert.notEqual(session.id, 'CA-INB-1', 'the provider id is not the domain id');
  assert.equal(session.providerCallId, 'CA-INB-1');
  assert.equal(session.accountId, owner.accountId);
  assert.equal(session.conversationId, conversation.id);
  assert.equal(session.from, '+15555550123');
  assert.equal(session.to, owner.line);
  assert.ok(session.startedAt && session.answeredAt && !session.endedAt);

  // Twilio retries the webhook: still one call, one conversation.
  assert.equal((await inbound('CA-INB-1')).status, 200);
  assert.equal((await sessions()).length, 1);
  assert.equal((await repository.list(owner.accountId)).length, 1);
  assert.equal((await sessionFor('CA-INB-1')).id, session.id);
});

test('a call that ends reaches a terminal state once, however often Twilio says so', async () => {
  const { inbound, status, sessionFor, owner, app } = await callApp();
  await inbound('CA-END-1');
  const before = await sessionFor('CA-END-1');

  const first = await status('CA-END-1', 'completed', { CallDuration: '42', SequenceNumber: '3' });
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'completed');
  assert.equal(first.body.durationSeconds, 42);
  const ended = await sessionFor('CA-END-1');
  assert.equal(ended.status, 'completed');
  assert.ok(ended.endedAt);
  assert.equal(ended.endReason, 'completed');
  assert.ok(ended.version > before.version);

  // The same callback redelivered, several times, some at once: same durable result as once.
  const replays = await Promise.all([1, 2, 3].map(() => status('CA-END-1', 'completed', { CallDuration: '42', SequenceNumber: '3' })));
  for (const replay of replays) {
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.events, first.body.events, 'no extra conversation events');
  }
  assert.equal((await sessionFor('CA-END-1')).version, ended.version, 'nothing changed');
  const attention = (await request(app).get('/owner/attention').set(owner.headers)).body as Array<{ type: string }>;
  assert.equal(attention.filter((item) => item.type === 'conversation_completed').length, 1, 'side effects happen once');
});

test('callbacks that arrive out of order or after the end are acknowledged and change nothing', async () => {
  const { inbound, status, sessionFor } = await callApp();
  await inbound('CA-OOO-1');
  const done = await status('CA-OOO-1', 'completed', { CallDuration: '9' });
  assert.equal(done.status, 200);
  const version = (await sessionFor('CA-OOO-1')).version;

  // These belong earlier in the call's life but were delayed: the call stays completed.
  for (const late of ['ringing', 'in-progress', 'initiated']) {
    const response = await status('CA-OOO-1', late);
    assert.equal(response.status, 200, late);
    assert.equal(response.body.status, 'completed');
  }
  const session = await sessionFor('CA-OOO-1');
  assert.equal(session.status, 'completed');
  assert.equal(session.version, version);
});

test('every terminal provider status closes the call; only a normal completion announces it', async () => {
  const { inbound, status, sessionFor, app, owner } = await callApp();
  for (const [sid, raw, expected] of [['CA-T-F', 'failed', 'failed'], ['CA-T-B', 'busy', 'busy'], ['CA-T-N', 'no-answer', 'no_answer'], ['CA-T-C', 'canceled', 'canceled']] as const) {
    await inbound(sid);
    const before = await sessionFor(sid);
    const response = await status(sid, raw);
    assert.equal(response.status, 200, raw);
    const session = await sessionFor(sid);
    // busy / no-answer cannot follow an answered call: stale and harmless. failed / canceled can.
    if (raw === 'busy' || raw === 'no-answer') {
      assert.equal(session.status, 'answered', `${raw} after answer is stale`);
      assert.equal(session.version, before.version);
    } else {
      assert.equal(session.status, expected);
      assert.ok(session.endedAt);
      assert.equal(response.body.status, 'completed', 'the owner-facing conversation is closed');
    }
  }
  const attention = (await request(app).get('/owner/attention').set(owner.headers)).body as Array<{ type: string }>;
  assert.equal(attention.filter((item) => item.type === 'conversation_completed').length, 0, 'a failed or cancelled call is not announced as handled');
});

test('a status the domain does not model is acknowledged, not rejected', async () => {
  const { inbound, status, sessionFor } = await callApp();
  await inbound('CA-UNK-1');
  const version = (await sessionFor('CA-UNK-1')).version;
  const response = await status('CA-UNK-1', 'some-future-status');
  assert.equal(response.status, 200, 'this used to be a 400 and so a retry storm');
  assert.equal((await sessionFor('CA-UNK-1')).version, version);
  assert.equal((await status('CA-UNK-1', 'some-future-status')).status, 200);
});

test('callbacks for calls we never saw: early lifecycle events are ignored, anything else is unknown', async () => {
  const { status } = await callApp();
  assert.equal((await status('CA-NEVER', 'ringing')).status, 200, 'a call still being registered');
  assert.equal((await status('CA-NEVER', 'completed')).status, 404);
});

test('a call from before CallSessions is adopted when its first callback arrives', async () => {
  const { repository, status, sessionFor, owner } = await callApp();
  const { conversation } = await repository.createIfAbsent({ provider: 'twilio', providerCallId: 'CA-LEGACY', callerPhone: '+15550001111', status: 'received', startedAt: new Date(), accountId: owner.accountId });
  await repository.appendEvent(conversation.id, 'call.received', {}, new Date());
  await repository.updateStatus(conversation.id, 'answered', {});
  const response = await status('CA-LEGACY', 'completed', { CallDuration: '5' });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'completed');
  const session = await sessionFor('CA-LEGACY');
  assert.equal(session.status, 'completed');
  assert.equal(session.conversationId, conversation.id);
  assert.equal(session.direction, 'inbound');
});

test('the owner test call runs through the same lifecycle as any other call', async () => {
  const { app, owner, sessions, sessionFor, store, callProvider, status, repository } = await callApp();
  const placed = await request(app).post('/account/phone/test-call').set(owner.headers).send({});
  assert.equal(placed.status, 202, JSON.stringify(placed.body));
  assert.equal(callProvider.created.length, 1);
  const sid = placed.body.id as string;

  // Established before anything rang, and its provider id recorded once dialed.
  let [session] = await sessions();
  assert.equal(session.direction, 'outbound');
  assert.equal(session.status, 'initiating');
  assert.equal(session.providerCallId, sid);
  assert.equal(session.from, owner.line);
  assert.equal(session.to, owner.personal);
  assert.notEqual(session.id, sid);

  // Twilio reports progress before there is any conversation: tracked, acknowledged.
  assert.equal((await status(sid, 'ringing')).status, 200);
  assert.equal((await sessionFor(sid)).status, 'ringing');
  assert.equal((await status(sid, 'in-progress')).status, 200);
  assert.equal((await sessionFor(sid)).status, 'answered');
  assert.equal((await repository.list(owner.accountId)).length, 0, 'no conversation until the owner confirms');

  // The owner presses 1: Twilio asks for instructions on the same call, which becomes the conversation.
  const confirmed = await request(app)
    .post(`/webhooks/twilio/voice/test?assistantLine=${encodeURIComponent(owner.line)}&confirmed=1`)
    .type('form')
    .send({ CallSid: sid, From: owner.line, To: owner.personal, Direction: 'outbound-api', Digits: '1' });
  assert.equal(confirmed.status, 200);
  assert.equal((await sessions()).length, 1, 'still one call');
  [session] = await sessions();
  assert.equal(session.direction, 'outbound');
  assert.equal(session.status, 'answered');
  const [conversation] = await repository.list(owner.accountId);
  assert.equal(session.conversationId, conversation.id);

  assert.equal((await status(sid, 'completed', { CallDuration: '30' })).status, 200);
  const done = (await store.get(owner.accountId, session.id))!;
  assert.equal(done.status, 'completed');
  assert.equal((await repository.getById(conversation.id))!.status, 'completed');
});

test('a test call that cannot be placed is recorded as failed', async () => {
  const { app, owner, sessions, callProvider } = await callApp();
  callProvider.failCreate = new CallProviderRejectedError('carrier rejected', 21211);
  const placed = await request(app).post('/account/phone/test-call').set(owner.headers).send({});
  assert.equal(placed.status, 502);
  const [session] = await sessions();
  assert.equal(session.status, 'failed');
  assert.equal(session.endReason, 'provider_rejected');
  assert.equal(session.providerCallId, null, 'no provider id was invented');
});

test('Stop ends the call through call.end once, however often it is pressed, and never after the call ended', async () => {
  const { inbound, callProvider, repository, owner, app, sessionFor, status } = await callApp();
  await inbound('CA-STOP-1');
  const [conversation] = await repository.list(owner.accountId);

  const first = await request(app).post(`/conversations/${conversation.id}/runtime/stop`).set(owner.headers).send({ commandId: 'stop-a' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = await request(app).post(`/conversations/${conversation.id}/runtime/stop`).set(owner.headers).send({ commandId: 'stop-b' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(callProvider.ended, [{ providerCallId: 'CA-STOP-1', mode: 'complete' }], 'one provider operation');
  const ending = await sessionFor('CA-STOP-1');
  assert.equal(ending.status, 'ending');
  assert.equal(ending.endReason, 'owner_stopped');

  // The provider confirms; later presses do nothing at the provider.
  await status('CA-STOP-1', 'completed', { CallDuration: '12' });
  assert.equal((await sessionFor('CA-STOP-1')).status, 'completed');
  await request(app).post(`/conversations/${conversation.id}/runtime/stop`).set(owner.headers).send({ commandId: 'stop-c' });
  assert.equal(callProvider.ended.length, 1);
});

test('one account cannot end another account\'s call by Stop', async () => {
  const { app, inbound, callProvider, repository, owner, messaging } = await callApp();
  await inbound('CA-ISO-1');
  const [conversation] = await repository.list(owner.accountId);
  const other = await onboardTenant(app, messaging);
  const attempt = await request(app).post(`/conversations/${conversation.id}/runtime/stop`).set(other.headers).send({});
  assert.equal(attempt.status, 404);
  assert.deepEqual(callProvider.ended, []);
});

test('without a stream host, the first spoken turn moves the call to in progress', async () => {
  const { app, owner, repository, sessionFor, status } = await callApp({
    providers: [new TwilioProvider({ turnUrl: 'https://text-me.example.test/webhooks/twilio/voice/turn' })],
  });
  const answered = await request(app).post('/webhooks/twilio/voice').type('form').send({ CallSid: 'CA-TURN-S', From: '+15555550123', To: owner.line });
  assert.match(answered.text, /<Gather/);
  assert.equal((await sessionFor('CA-TURN-S')).status, 'answered');
  const [conversation] = await repository.list(owner.accountId);

  const turn = await request(app)
    .post(`/webhooks/twilio/voice/turn?conversationId=${encodeURIComponent(conversation.id)}&turn=1`)
    .type('form').send({ CallSid: 'CA-TURN-S', SpeechResult: 'Can you help me?' });
  assert.equal(turn.status, 200, turn.text);
  const session = await sessionFor('CA-TURN-S');
  assert.equal(session.status, 'in_progress');
  const version = session.version;

  // Later turns leave it alone; the provider's callback still completes it.
  await request(app).post(`/webhooks/twilio/voice/turn?conversationId=${encodeURIComponent(conversation.id)}&turn=2`).type('form').send({ CallSid: 'CA-TURN-S', SpeechResult: 'Thanks' });
  assert.equal((await sessionFor('CA-TURN-S')).version, version);
  await status('CA-TURN-S', 'completed', { CallDuration: '20' });
  assert.equal((await sessionFor('CA-TURN-S')).status, 'completed');
});

test('the media stream is told which CallSession it belongs to', async () => {
  const repository = new InMemoryConversationRepository();
  const messaging = new FakeMessagingProvider();
  const sessionStore = new InMemoryCallSessionStore();
  const app = createApp({
    repository, messagingProvider: messaging, callSessionStore: sessionStore,
    providers: [new TwilioProvider({ mediaStreamUrl: 'wss://example.test/media-stream', continueUrl: 'https://example.test/webhooks/twilio/voice/continue' })],
  });
  const tenant = await onboardTenant(app, messaging);
  const response = await request(app).post('/webhooks/twilio/voice').type('form').send({ CallSid: 'CA-MEDIA-1', From: '+15553334444', To: tenant.line });
  const session = (await sessionStore.findByProviderCallId('twilio', 'CA-MEDIA-1'))!;
  assert.match(response.text, new RegExp(`<Parameter name="callSessionId" value="${session.id}"/>`));
  assert.ok(!response.text.includes('CA-MEDIA-1'), 'the stream is given our id, never the provider\'s');
});

test('production composition: CallSessions persist in Postgres and every instance sees and dedupes the same call', {
  skip: process.env.TEST_DATABASE_URL ? false : 'set TEST_DATABASE_URL to run against Postgres',
}, async (t) => {
  const { buildServer } = await import('../src/bootstrap.js');
  const { getConfig } = await import('../src/config.js');
  const pg = (await import('pg')).default;
  const databaseUrl = process.env.TEST_DATABASE_URL!;
  const env = {
    DATABASE_URL: databaseUrl, TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'twilio-test',
    PUBLIC_BASE_URL: 'http://localhost', REALTIME_VOICE: 'off', TELEPHONY_NUMBER_PURCHASE: 'on', TELEPHONY_SMS_VERIFICATION: 'on',
  };
  const platform = { phoneNumberClient: new FakePhoneNumberClient(), messagingProvider: new FakeMessagingProvider() };
  const first = buildServer(getConfig(env), {}, platform);
  const second = buildServer(getConfig(env), {}, platform);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  t.after(async () => { first.server.close(); second.server.close(); await pool.end(); });
  await Promise.all([first.ready, second.ready]);
  const owner = await onboardTenant(first.app, platform.messagingProvider);

  const callId = `pgcall-${Date.now()}`;
  const voice = await request(first.app).post('/webhooks/fake/voice').send({ callId, callerPhone: '+15553334444', to: owner.line });
  assert.equal(voice.status, 200);
  const rows = await pool.query('SELECT id, status, direction, provider, provider_call_id, account_id, conversation_id FROM call_sessions WHERE provider_call_id = $1', [callId]);
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].status, 'answered');
  assert.equal(rows.rows[0].direction, 'inbound');
  assert.equal(rows.rows[0].account_id, owner.accountId);
  assert.notEqual(rows.rows[0].id, callId);
  assert.ok(rows.rows[0].conversation_id);

  // The provider's callback arrives at one instance, then again at the other, then at both at once.
  const completed = { callId, status: 'completed', durationSeconds: 7 };
  assert.equal((await request(first.app).post('/webhooks/fake/status').send(completed)).status, 200);
  const replays = await Promise.all([first, second, first, second].map((instance) => request(instance.app).post('/webhooks/fake/status').send(completed)));
  assert.ok(replays.every((replay) => replay.status === 200));
  const done = await pool.query('SELECT status, end_reason, version FROM call_sessions WHERE provider_call_id = $1', [callId]);
  assert.equal(done.rows[0].status, 'completed');
  assert.equal(done.rows[0].version, 4, 'created → ringing → answered → completed, each exactly once');
  const events = await pool.query('SELECT outcome FROM call_provider_events WHERE call_session_id = $1', [rows.rows[0].id]);
  assert.deepEqual(events.rows, [{ outcome: 'applied' }], 'one recorded callback, however many were delivered');
  const attention = (await request(second.app).get('/owner/attention').set(owner.headers)).body as Array<{ type: string }>;
  assert.equal(attention.filter((item) => item.type === 'conversation_completed').length, 1);
});
