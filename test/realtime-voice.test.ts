import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import type { AppPortApplication } from '@appport/core';
import request from 'supertest';
import WebSocket from 'ws';

import { appPortSessionFor } from '../src/appport/session.js';
import { CallCapabilityClient } from '../src/appport/call-client.js';
import { FakeCallProvider } from '../src/calls/provider.js';
import { createApp } from '../src/http-app.js';
import { InMemoryCallSessionStore } from '../src/calls/store.js';
import { FakeMessagingProvider } from '../src/messaging/fake-provider.js';
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
import { onboardTenant } from './support/tenant.js';

/** A scripted stand-in for the AI Gateway realtime session. */
class ScriptedRealtimeConnector implements RealtimeConnector {
  readonly modelId = 'openai/gpt-realtime-2';
  config?: RealtimeSessionConfig;
  sent: RealtimeClientEvent[] = [];
  closed = false;
  failWith?: Error;
  private handlers?: RealtimeConnectionHandlers;

  async connect(config: RealtimeSessionConfig, handlers: RealtimeConnectionHandlers): Promise<RealtimeConnection> {
    if (this.failWith) throw this.failWith;
    this.config = config;
    this.handlers = handlers;
    return {
      send: async (event) => {
        this.sent.push(event);
      },
      close: () => {
        this.closed = true;
      },
    };
  }

  emit(event: Record<string, unknown>): void {
    this.handlers!.onEvent({ raw: {}, ...event } as RealtimeServerEvent);
  }

  sentOfType<T extends RealtimeClientEvent['type']>(type: T) {
    return this.sent.filter((event) => event.type === type) as Extract<RealtimeClientEvent, { type: T }>[];
  }
}

/** Plays Twilio's side of a bidirectional media stream. */
class TwilioStream {
  readonly received: Array<Record<string, unknown>> = [];
  closed = false;
  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => this.received.push(JSON.parse(data.toString())));
    socket.on('close', () => {
      this.closed = true;
    });
  }

  static async open(port: number, conversationId: string, callSessionId?: string): Promise<TwilioStream> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${MEDIA_STREAM_PATH}`);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const stream = new TwilioStream(socket);
    socket.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
    socket.send(JSON.stringify({
      event: 'start',
      streamSid: 'MZ123',
      start: { streamSid: 'MZ123', callSid: 'CA123', customParameters: { conversationId, ...(callSessionId ? { callSessionId } : {}) } },
    }));
    return stream;
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  ofType(event: string) {
    return this.received.filter((message) => message.event === event);
  }
}

async function eventually(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

async function startCallService() {
  const repository = new InMemoryConversationRepository();
  const connector = new ScriptedRealtimeConnector();
  const messaging = new FakeMessagingProvider();
  const voice = new RealtimeVoiceService(connector, { voice: 'marin' });
  const callSessionStore = new InMemoryCallSessionStore();
  const app = createApp({
    repository,
    messagingProvider: messaging,
    callSessionStore,
    realtimeVoice: voice,
    providers: [
      new TwilioProvider({
        mediaStreamUrl: `wss://example.test${MEDIA_STREAM_PATH}`,
        continueUrl: 'https://example.test/webhooks/twilio/voice/continue',
      }),
      new FakeTelephonyProvider(),
    ],
  });
  const tenant = await onboardTenant(app, messaging, { personal: '+15550009999' });
  messaging.sentMessages.length = 0;
  const server: Server = createServer(app);
  voice.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const call = await request(app).post('/webhooks/fake/voice').send({ callId: 'call-1', callerPhone: '+15553334444', to: tenant.line });
  assert.equal(call.status, 200);
  const [conversation] = await repository.list(tenant.accountId);
  const callSession = async () => (await callSessionStore.findByProviderCallId('fake', 'call-1'))!;
  return { app, server, port, repository, connector, messaging, voice, conversationId: conversation.id, headers: tenant.headers, callSessionStore, callSession, tenant };
}

test('Twilio answers realtime calls with a bidirectional media stream', async () => {
  const repository = new InMemoryConversationRepository();
  const messaging = new FakeMessagingProvider();
  const app = createApp({
    repository,
    messagingProvider: messaging,
    realtimeVoice: new RealtimeVoiceService(new ScriptedRealtimeConnector()),
    providers: [new TwilioProvider({
      mediaStreamUrl: 'wss://text-me.vercel.app/media-stream',
      continueUrl: 'https://text-me.vercel.app/webhooks/twilio/voice/continue',
    }), new FakeTelephonyProvider()],
  });
  const tenant = await onboardTenant(app, messaging);
  const response = await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ CallSid: 'CA1', From: '+15553334444', To: tenant.line });
  assert.equal(response.status, 200);
  const [conversation] = await repository.list(tenant.accountId);
  assert.match(response.text, /<Connect><Stream url="wss:\/\/text-me\.vercel\.app\/media-stream">/);
  assert.match(response.text, new RegExp(`<Parameter name="conversationId" value="${conversation.id}"/>`));
  assert.match(response.text, /<Redirect method="POST">https:\/\/text-me\.vercel\.app\/webhooks\/twilio\/voice\/continue\?conversationId=/);
});

test('a live call streams audio both ways, records the transcript, and obeys owner controls', async (t) => {
  const service = await startCallService();
  t.after(() => service.server.close());
  const { connector, conversationId, port, app, headers } = service;
  const twilio = await TwilioStream.open(port, conversationId);
  t.after(() => twilio.socket.close());

  // Session is configured for telephony audio with the call tools and owner greeting.
  await eventually(() => connector.config !== undefined, 'realtime session');
  assert.deepEqual(connector.config!.inputAudioFormat, { type: 'audio/pcmu', rate: 8000 });
  assert.deepEqual(connector.config!.outputAudioFormat, { type: 'audio/pcmu', rate: 8000 });
  assert.equal(connector.config!.voice, 'marin');
  assert.deepEqual(connector.config!.tools!.map((tool) => tool.name), ['note_caller', 'get_owner_context', 'lookup_conversation', 'ask_owner', 'transition_to_text', 'end_call']);
  await eventually(() => connector.sentOfType('response-create').length === 1, 'greeting');
  assert.match(connector.sentOfType('response-create')[0].options!.instructions!, /Greet the caller/);

  // Caller audio goes to the model untouched.
  twilio.send({ event: 'media', streamSid: 'MZ123', media: { track: 'inbound', payload: 'AAEC' } });
  await eventually(() => connector.sentOfType('input-audio-append').some((event) => event.audio === 'AAEC'), 'caller audio');

  // Model audio goes to the caller; a playback mark follows the response.
  connector.emit({ type: 'response-created', responseId: 'resp-1' });
  connector.emit({ type: 'audio-delta', responseId: 'resp-1', itemId: 'item-1', delta: '//79' });
  connector.emit({ type: 'audio-transcript-done', responseId: 'resp-1', itemId: 'item-1', transcript: "Hi, this is Randy's assistant. How can I help?" });
  connector.emit({ type: 'response-done', responseId: 'resp-1', status: 'completed' });
  await eventually(() => twilio.ofType('mark').length === 1, 'playback mark');
  assert.deepEqual(twilio.ofType('media')[0], { event: 'media', streamSid: 'MZ123', media: { payload: '//79' } });
  twilio.send({ event: 'mark', streamSid: 'MZ123', mark: { name: 'response:resp-1' } });

  // Caller speech is transcribed into the conversation the owner is watching.
  connector.emit({ type: 'speech-started', itemId: 'caller-1' });
  connector.emit({ type: 'input-transcription-completed', itemId: 'caller-1', transcript: 'I need to move my Thursday appointment.' });
  await service.voice.bridge(conversationId)!.settled();
  let detail = await request(app).get(`/conversations/${conversationId}`).set(headers);
  assert.equal(detail.body.voice.live, true);
  assert.equal(detail.body.voice.model, 'openai/gpt-realtime-2');
  assert.deepEqual(detail.body.messages.map((message: { role: string; channel: string }) => [message.role, message.channel]), [
    ['assistant', 'voice'],
    ['caller', 'voice'],
  ]);
  assert.equal(detail.body.messages[1].body, 'I need to move my Thursday appointment.');

  // Barge-in: caller talks over the assistant, playback is cleared and the response cancelled.
  connector.emit({ type: 'response-created', responseId: 'resp-2' });
  connector.emit({ type: 'audio-delta', responseId: 'resp-2', itemId: 'item-2', delta: 'AAAA' });
  const cancelsBefore = connector.sentOfType('response-cancel').length;
  connector.emit({ type: 'speech-started', itemId: 'caller-2' });
  await eventually(() => twilio.ofType('clear').length === 1, 'barge-in clear');
  assert.ok(connector.sentOfType('response-cancel').length > cancelsBefore);

  // Pause: caller audio stops flowing and automatic replies are cancelled unheard.
  const revision = (await request(app).get(`/conversations/${conversationId}/runtime`).set(headers)).body.revision;
  const paused = await request(app).post(`/conversations/${conversationId}/runtime/pause`).set(headers).send({ expectedRevision: revision });
  assert.equal(paused.body.state, 'paused');
  await eventually(async () => {
    twilio.send({ event: 'media', streamSid: 'MZ123', media: { track: 'inbound', payload: 'PAUSED' } });
    connector.emit({ type: 'response-created', responseId: 'resp-paused' });
    connector.emit({ type: 'audio-delta', responseId: 'resp-paused', itemId: 'x', delta: 'LEAK' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return !connector.sentOfType('input-audio-append').some((event) => event.audio === 'PAUSED');
  }, 'paused audio gate');
  assert.ok(!twilio.ofType('media').some((message) => (message.media as { payload: string }).payload === 'LEAK'));

  // Resume, then take over: the owner's typed words are spoken into the call.
  await request(app).post(`/conversations/${conversationId}/runtime/resume`).set(headers).send({});
  const takeover = await request(app).post(`/conversations/${conversationId}/runtime/takeover`).set(headers).send({});
  assert.equal(takeover.body.aiMode, 'owner_only');
  await eventually(() => connector.sentOfType('session-update').length > 0, 'settings pushed to live session');
  const reply = await request(app).post(`/conversations/${conversationId}/messages`).set(headers).send({ body: 'Thursday at 3 works for Randy.' });
  assert.equal(reply.status, 200);
  assert.ok(reply.body.messages.some((message: { role: string; body: string }) =>
    message.role === 'owner' && message.body === 'Thursday at 3 works for Randy.'));
  await eventually(() => connector.sentOfType('response-create').some((event) =>
    event.options?.instructions?.includes('Thursday at 3 works for Randy.') ?? false), 'owner speech request');
  connector.emit({ type: 'response-created', responseId: 'resp-owner' });
  connector.emit({ type: 'audio-delta', responseId: 'resp-owner', itemId: 'item-owner', delta: 'T1dORVI=' });
  await eventually(() => twilio.ofType('media').some((message) =>
    (message.media as { payload: string }).payload === 'T1dORVI='), 'owner speech audio');
  connector.emit({ type: 'response-done', responseId: 'resp-owner', status: 'completed' });
  await eventually(() => twilio.ofType('mark').length === 2, 'owner speech mark');
  twilio.send({ event: 'mark', streamSid: 'MZ123', mark: { name: 'response:resp-owner' } });
  // ...while the model's own replies stay silent during takeover.
  connector.emit({ type: 'response-created', responseId: 'resp-auto' });
  connector.emit({ type: 'audio-delta', responseId: 'resp-auto', itemId: 'item-auto', delta: 'QVVUTw==' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!twilio.ofType('media').some((message) => (message.media as { payload: string }).payload === 'QVVUTw=='));

  // Tools: the caller agrees to text, then the assistant hangs up.
  connector.emit({
    type: 'function-call-arguments-done', responseId: 'r', itemId: 'i', callId: 'call-sms',
    name: 'transition_to_text', arguments: JSON.stringify({ callerName: 'Jordan' }),
  });
  await eventually(() => connector.sentOfType('conversation-item-create').length === 1, 'tool output');
  assert.equal(service.messaging.sentMessages.length, 2);
  assert.equal(service.messaging.sentMessages[0].to, '+15553334444');
  // The assistant says goodbye on the call after the move to text...
  connector.emit({ type: 'response-created', responseId: 'resp-bye' });
  connector.emit({ type: 'audio-delta', responseId: 'resp-bye', itemId: 'item-bye', delta: 'QllF' });
  connector.emit({ type: 'audio-transcript-done', responseId: 'resp-bye', itemId: 'item-bye', transcript: "You'll get a text in a moment." });
  connector.emit({ type: 'response-done', responseId: 'resp-bye', status: 'completed' });
  await eventually(() => twilio.ofType('mark').length === 3, 'goodbye mark');
  twilio.send({ event: 'mark', streamSid: 'MZ123', mark: { name: 'response:resp-bye' } });
  connector.emit({
    type: 'function-call-arguments-done', responseId: 'r', itemId: 'i2', callId: 'call-end',
    name: 'end_call', arguments: JSON.stringify({ reason: 'done' }),
  });
  await eventually(() => twilio.closed, 'call hang-up');
  assert.equal(connector.closed, true);

  await eventually(async () => {
    const after = await request(app).get(`/conversations/${conversationId}`).set(headers);
    return after.body.voice.live === false && after.body.voice.outcome === 'ended';
  }, 'call marked ended');
  // ...and the caller hangs up; the conversation stays in text.
  await request(app).post('/webhooks/fake/status').send({ callId: 'call-1', status: 'completed', durationSeconds: 41 });
  detail = await request(app).get(`/conversations/${conversationId}`).set(headers);
  assert.equal(detail.body.state, 'text_active');
  assert.equal(detail.body.runtime.state, 'text_active');
  const next = await request(app).post(`/webhooks/twilio/voice/continue?conversationId=${conversationId}`);
  assert.doesNotMatch(next.text, /Sorry/);
  assert.match(next.text, /<Hangup\/>/);
});

test('owner stop says goodbye and hangs up the live call', async (t) => {
  const service = await startCallService();
  t.after(() => service.server.close());
  const twilio = await TwilioStream.open(service.port, service.conversationId);
  await eventually(() => service.connector.config !== undefined, 'realtime session');
  const stop = await request(service.app).post(`/conversations/${service.conversationId}/runtime/stop`).set(service.headers).send({});
  assert.equal(stop.body.state, 'stopped');
  await eventually(() => service.connector.sentOfType('response-create').some((event) =>
    event.options?.instructions?.includes('owner has ended this call') ?? false), 'farewell request');
  service.connector.emit({ type: 'response-created', responseId: 'bye' });
  service.connector.emit({ type: 'audio-delta', responseId: 'bye', itemId: 'bye-item', delta: 'QllF' });
  service.connector.emit({ type: 'response-done', responseId: 'bye', status: 'completed' });
  await eventually(() => twilio.ofType('mark').length === 1, 'farewell playback');
  twilio.send({ event: 'mark', streamSid: 'MZ123', mark: { name: 'response:bye' } });
  await eventually(() => twilio.closed, 'hang-up after farewell');
});

test('if the realtime model is unreachable the caller hears an apology', async (t) => {
  const service = await startCallService();
  t.after(() => service.server.close());
  service.connector.failWith = new Error('Gateway unavailable');
  const twilio = await TwilioStream.open(service.port, service.conversationId);
  await eventually(() => twilio.closed, 'stream closed');
  await eventually(async () => (await service.repository.getById(service.conversationId))!.events
    .some((event) => event.type === 'voice.completed' && event.payload.outcome === 'failed'), 'failure recorded');
  const next = await request(service.app).post(`/webhooks/twilio/voice/continue?conversationId=${service.conversationId}`);
  assert.match(next.text, /<Say>Sorry, the assistant can't take your call right now/);
});

test('ask_owner keeps the conversation flagged until the owner replies', async (t) => {
  const service = await startCallService();
  t.after(() => service.server.close());
  const twilio = await TwilioStream.open(service.port, service.conversationId);
  t.after(() => twilio.socket.close());
  await eventually(() => service.connector.config !== undefined, 'realtime session');
  service.connector.emit({
    type: 'function-call-arguments-done', responseId: 'r', itemId: 'n', callId: 'note-1',
    name: 'note_caller', arguments: JSON.stringify({ name: 'Jordan', reason: 'Reschedule Thursday appointment' }),
  });
  await eventually(() => service.connector.sentOfType('conversation-item-create').length === 1, 'note output');
  const [listed] = (await request(service.app).get('/conversations').set(service.headers)).body;
  assert.deepEqual(listed.participant, { name: 'Jordan', phoneNumber: '+15553334444', reason: 'Reschedule Thursday appointment' });
  service.connector.emit({
    type: 'function-call-arguments-done', responseId: 'r', itemId: 'i', callId: 'ask-1',
    name: 'ask_owner', arguments: JSON.stringify({ question: 'Can Jordan move to Friday?' }),
  });
  await eventually(() => service.connector.sentOfType('conversation-item-create').length === 2, 'tool output');
  // The assistant carries on talking, but the request for the owner stays visible.
  service.connector.emit({ type: 'response-created', responseId: 'after' });
  service.connector.emit({ type: 'response-done', responseId: 'after', status: 'completed' });
  await service.voice.bridge(service.conversationId)!.settled();
  const flagged = await request(service.app).get('/conversations?needsOwner=true').set(service.headers);
  assert.deepEqual(flagged.body.map((conversation: { id: string }) => conversation.id), [service.conversationId]);
  await request(service.app).post(`/conversations/${service.conversationId}/messages`).set(service.headers).send({ body: 'Friday at 10 is fine.' });
  const after = await request(service.app).get('/conversations?needsOwner=true').set(service.headers);
  assert.equal(after.body.length, 0);
});

// ----- The media stream reports into the CallSession; it never decides the call's lifecycle -----

test('the stream moves its CallSession to in progress, reports the hang-up, and the provider completes it', async (t) => {
  const service = await startCallService();
  t.after(() => service.server.close());
  const session = await service.callSession();
  assert.equal(session.status, 'answered', 'the webhook answered the call before any media flowed');

  const twilio = await TwilioStream.open(service.port, service.conversationId, session.id);
  t.after(() => twilio.socket.close());
  await eventually(async () => (await service.callSession()).status === 'in_progress', 'call in progress');

  twilio.send({ event: 'stop', streamSid: 'MZ123' });
  await eventually(async () => (await service.callSession()).status === 'ending', 'call ending after the stream stopped');
  assert.equal((await service.callSession()).endReason, 'media_stream_ended');

  // Only the provider's callback completes it, and the stream is not the source of truth for that.
  const done = await request(service.app).post('/webhooks/fake/status').send({ callId: 'call-1', status: 'completed', durationSeconds: 41 });
  assert.equal(done.status, 200);
  assert.equal((await service.callSession()).status, 'completed');
});

test('a media stream cannot claim a CallSession that is not its own call', async (t) => {
  const service = await startCallService();
  t.after(() => service.server.close());
  // A second call in the same account.
  await request(service.app).post('/webhooks/fake/voice').send({ callId: 'call-2', callerPhone: '+15557778888', to: service.tenant.line });
  const other = (await service.callSessionStore.findByProviderCallId('fake', 'call-2'))!;
  const mine = await service.callSession();

  const twilio = await TwilioStream.open(service.port, service.conversationId, other.id);
  t.after(() => twilio.socket.close());
  await eventually(() => service.connector.config !== undefined, 'realtime session');
  await service.voice.bridge(service.conversationId)!.settled();
  assert.equal((await service.callSession()).status, 'answered', 'the claim was not honoured');
  assert.equal((await service.callSessionStore.get(service.tenant.accountId, other.id))!.status, 'answered');
  assert.equal(mine.id === other.id, false);
});

test('if the realtime model cannot start, the CallSession records the failure and the provider\'s late completion is stale', async (t) => {
  const service = await startCallService();
  t.after(() => service.server.close());
  const session = await service.callSession();
  service.connector.failWith = new Error('Gateway unavailable');
  const twilio = await TwilioStream.open(service.port, service.conversationId, session.id);
  await eventually(() => twilio.closed, 'stream closed');
  await eventually(async () => (await service.callSession()).status === 'failed', 'call failed');
  assert.equal((await service.callSession()).endReason, 'voice_start_failed');

  const late = await request(service.app).post('/webhooks/fake/status').send({ callId: 'call-1', status: 'completed' });
  assert.equal(late.status, 200);
  const after = await service.callSession();
  assert.equal(after.status, 'failed', 'a terminal call stays as it ended');
});

test('owner Stop on a live stream ends the call once through call.end', async (t) => {
  const service = await startCallService();
  t.after(() => service.server.close());
  const session = await service.callSession();
  const twilio = await TwilioStream.open(service.port, service.conversationId, session.id);
  t.after(() => twilio.socket.close());
  await eventually(async () => (await service.callSession()).status === 'in_progress', 'call in progress');
  const stop = await request(service.app).post(`/conversations/${service.conversationId}/runtime/stop`).set(service.headers).send({});
  assert.equal(stop.status, 200);
  const ending = await service.callSession();
  assert.equal(ending.status, 'ending');
  assert.equal(ending.endReason, 'owner_stopped');
});

test('an answered outbound call runs in the realtime runtime, told it is outbound and why, with the objective as data', async (t) => {
  const repository = new InMemoryConversationRepository();
  const connector = new ScriptedRealtimeConnector();
  const messaging = new FakeMessagingProvider();
  const voice = new RealtimeVoiceService(connector, { voice: 'marin' });
  const callSessionStore = new InMemoryCallSessionStore();
  const callProvider = new FakeCallProvider();
  const app = createApp({
    repository, messagingProvider: messaging, callSessionStore, callProvider, realtimeVoice: voice,
    publicBaseUrl: 'https://example.test', outboundAgentCalls: true,
    providers: [new TwilioProvider({ mediaStreamUrl: `wss://example.test${MEDIA_STREAM_PATH}`, continueUrl: 'https://example.test/webhooks/twilio/voice/continue' }), new FakeTelephonyProvider()],
  });
  const tenant = await onboardTenant(app, messaging, { personal: '+15550009999' });
  const server: Server = createServer(app);
  voice.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const capabilities = (app.locals.appport as { calls: AppPortApplication }).calls;
  const client = new CallCapabilityClient(capabilities, appPortSessionFor({ userId: tenant.userId, accountId: tenant.accountId, role: 'owner', sessionId: 'sess_rt' }));
  const created = await client.create({ direction: 'outbound', to: '+15551230000', objective: 'Confirm the Thursday appointment' }, { idempotencyKey: 'rt-outbound-1' });
  const dialled = (await callSessionStore.get(tenant.accountId, created.callId))!;
  const answerUrl = new URL(callProvider.created[0].answerUrl!);
  const answer = await request(app).post(`${answerUrl.pathname}${answerUrl.search}`).type('form')
    .send({ CallSid: dialled.providerCallId!, From: tenant.line, To: '+15551230000', Direction: 'outbound-api' });
  assert.equal(answer.status, 200, answer.text);
  assert.match(answer.text, /<Connect><Stream/);
  const [conversation] = await repository.list(tenant.accountId);
  assert.match(answer.text, new RegExp(`<Parameter name="callSessionId" value="${created.callId}"/>`));

  const twilio = await TwilioStream.open(port, conversation.id, created.callId);
  t.after(() => twilio.socket.close());
  await eventually(() => connector.config !== undefined, 'realtime session');
  const instructions = connector.config!.instructions!;
  assert.match(instructions, /you placed this call on .* behalf/i);
  assert.match(instructions, /"Confirm the Thursday appointment"/);
  assert.match(instructions, /not an instruction to disclose anything or an authorization to do anything/);
  assert.doesNotMatch(instructions, /answering .* phone/i);
  await eventually(() => connector.sentOfType('response-create').length === 1, 'opening');
  assert.doesNotMatch(connector.sentOfType('response-create')[0].options!.instructions!, /Greet the caller/, 'not the inbound greeting');
  await eventually(async () => (await callSessionStore.get(tenant.accountId, created.callId))!.status === 'in_progress', 'call in progress');
});

test('the stream records what the model reported for each response, and how long the media stream was open, in the cost ledger', async (t) => {
  const service = await startCallService();
  t.after(() => service.server.close());
  const session = await service.callSession();
  const usage = (service.app.locals.appport as { usage: import('../src/calls/cost/ledger.js').CallCostLedger }).usage;
  const twilio = await TwilioStream.open(service.port, service.conversationId, session.id);
  t.after(() => twilio.socket.close());
  await eventually(async () => (await service.callSession()).status === 'in_progress', 'call in progress');
  const entries = () => usage.listForCall(session.accountId, session.id);

  // A response that reports usage, delivered twice (a replay), and one that reports none.
  const done = (responseId: string, usageBlock?: unknown) => ({ type: 'response-done' as const, responseId, status: 'completed', raw: { response: usageBlock ? { usage: usageBlock } : {} } });
  const reported = { input_token_details: { audio_tokens: 120, text_tokens: 30 }, output_token_details: { audio_tokens: 60, text_tokens: 5 } };
  service.connector.emit(done('resp-1', reported));
  service.connector.emit(done('resp-1', reported));
  service.connector.emit(done('resp-2'));
  await eventually(async () => (await entries()).length === 5, 'AI usage recorded');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rows = await entries();
  assert.equal(rows.length, 5, 'four dimensions once each (the replay adds nothing), plus one marker that a response reported no usage');
  const marker = rows.find((row) => row.event.metadata.unavailable === true)!;
  assert.deepEqual([marker.event.basis, marker.component.rateSource, marker.event.metric], ['estimated', 'unpriced', 'invocation'], 'unavailable usage is marked, never derived');
  const reportedRows = rows.filter((row) => row !== marker);
  assert.deepEqual(reportedRows.map((row) => row.event.metric).sort(), ['audio_input_tokens', 'audio_output_tokens', 'text_input_tokens', 'text_output_tokens']);
  assert.ok(reportedRows.every((row) => row.event.category === 'ai_voice' && row.event.provider === 'openai' && row.event.model === 'gpt-realtime-2' && row.event.basis === 'final'));
  assert.ok(rows.every((row) => row.component.rateSource === 'unpriced'), 'no AI rate is configured by default: recorded, not guessed');

  twilio.send({ event: 'stop', streamSid: 'MZ123' });
  await eventually(async () => (await entries()).some((row) => row.event.category === 'media'), 'media stream recorded');
  const media = (await entries()).find((row) => row.event.category === 'media')!;
  assert.deepEqual([media.event.product, media.event.metric, media.event.basis, media.event.source], ['media_stream', 'duration', 'estimated', 'media_stream']);
  const summary = await usage.summarize(session);
  assert.ok(summary.nonFinalizable.includes('ai_voice') && summary.nonFinalizable.includes('media'), 'unavailable AI usage and media both keep the call from being final');
});
