import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import request from 'supertest';
import WebSocket from 'ws';

import { createApp } from '../src/http-app.js';
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

  static async open(port: number, conversationId: string): Promise<TwilioStream> {
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
      start: { streamSid: 'MZ123', callSid: 'CA123', customParameters: { conversationId } },
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
  const app = createApp({
    repository,
    messagingProvider: messaging,
    ownerPhone: '+15550009999',
    realtimeVoice: voice,
    providers: [
      new TwilioProvider({
        mediaStreamUrl: `wss://example.test${MEDIA_STREAM_PATH}`,
        continueUrl: 'https://example.test/webhooks/twilio/voice/continue',
      }),
      new FakeTelephonyProvider(),
    ],
  });
  const server: Server = createServer(app);
  voice.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const call = await request(app).post('/webhooks/fake/voice').send({ callId: 'call-1', callerPhone: '+15553334444' });
  assert.equal(call.status, 200);
  const [conversation] = await repository.list();
  return { app, server, port, repository, connector, messaging, voice, conversationId: conversation.id };
}

test('Twilio answers realtime calls with a bidirectional media stream', async () => {
  const repository = new InMemoryConversationRepository();
  const app = createApp({
    repository,
    realtimeVoice: new RealtimeVoiceService(new ScriptedRealtimeConnector()),
    providers: [new TwilioProvider({
      mediaStreamUrl: 'wss://text-me.vercel.app/media-stream',
      continueUrl: 'https://text-me.vercel.app/webhooks/twilio/voice/continue',
    }), new FakeTelephonyProvider()],
  });
  const response = await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ CallSid: 'CA1', From: '+15553334444' });
  assert.equal(response.status, 200);
  const [conversation] = await repository.list();
  assert.match(response.text, /<Connect><Stream url="wss:\/\/text-me\.vercel\.app\/media-stream">/);
  assert.match(response.text, new RegExp(`<Parameter name="conversationId" value="${conversation.id}"/>`));
  assert.match(response.text, /<Redirect method="POST">https:\/\/text-me\.vercel\.app\/webhooks\/twilio\/voice\/continue\?conversationId=/);
});

test('a live call streams audio both ways, records the transcript, and obeys owner controls', async (t) => {
  const service = await startCallService();
  t.after(() => service.server.close());
  const { connector, conversationId, port, app } = service;
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
  let detail = await request(app).get(`/conversations/${conversationId}`);
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
  const revision = (await request(app).get(`/conversations/${conversationId}/runtime`)).body.revision;
  const paused = await request(app).post(`/conversations/${conversationId}/runtime/pause`).send({ expectedRevision: revision });
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
  await request(app).post(`/conversations/${conversationId}/runtime/resume`).send({});
  const takeover = await request(app).post(`/conversations/${conversationId}/runtime/takeover`).send({});
  assert.equal(takeover.body.aiMode, 'owner_only');
  await eventually(() => connector.sentOfType('session-update').length > 0, 'settings pushed to live session');
  const reply = await request(app).post(`/conversations/${conversationId}/messages`).send({ body: 'Thursday at 3 works for Randy.' });
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
    const after = await request(app).get(`/conversations/${conversationId}`);
    return after.body.voice.live === false && after.body.voice.outcome === 'ended';
  }, 'call marked ended');
  // ...and the caller hangs up; the conversation stays in text.
  await request(app).post('/webhooks/fake/status').send({ callId: 'call-1', status: 'completed', durationSeconds: 41 });
  detail = await request(app).get(`/conversations/${conversationId}`);
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
  const stop = await request(service.app).post(`/conversations/${service.conversationId}/runtime/stop`).send({});
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
  const [listed] = (await request(service.app).get('/conversations')).body;
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
  const flagged = await request(service.app).get('/conversations?needsOwner=true');
  assert.deepEqual(flagged.body.map((conversation: { id: string }) => conversation.id), [service.conversationId]);
  await request(service.app).post(`/conversations/${service.conversationId}/messages`).send({ body: 'Friday at 10 is fine.' });
  const after = await request(service.app).get('/conversations?needsOwner=true');
  assert.equal(after.body.length, 0);
});
