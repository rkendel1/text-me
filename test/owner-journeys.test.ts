import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import request from 'supertest';
import WebSocket from 'ws';

import { createApp } from '../src/app.js';
import { AiSdkTextAgent } from '../src/conversation/ai-sdk-text-agent.js';
import { FakeMessagingProvider } from '../src/messaging/fake-provider.js';
import { OwnerConfigurationService } from '../src/owner/configuration.js';
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

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const say = (text: string): LanguageModelV4GenerateResult => ({
  content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
});
const callTool = (toolName: string, input: unknown): LanguageModelV4GenerateResult => ({
  content: [{ type: 'tool-call', toolCallId: `tc-${toolName}`, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [],
});

class ScriptedConnector implements RealtimeConnector {
  readonly modelId = 'openai/gpt-realtime-2';
  configs: RealtimeSessionConfig[] = [];
  sent: RealtimeClientEvent[] = [];
  private handlers?: RealtimeConnectionHandlers;
  async connect(config: RealtimeSessionConfig, handlers: RealtimeConnectionHandlers): Promise<RealtimeConnection> {
    this.configs.push(config);
    this.handlers = handlers;
    return { send: async (event) => { this.sent.push(event); }, close: () => undefined };
  }
  emit(event: Record<string, unknown>): void {
    this.handlers!.onEvent({ raw: {}, ...event } as RealtimeServerEvent);
  }
  of<T extends RealtimeClientEvent['type']>(type: T) {
    return this.sent.filter((event) => event.type === type) as Extract<RealtimeClientEvent, { type: T }>[];
  }
}

async function eventually(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

async function liveCall(options: { configuration?: OwnerConfigurationService; model?: MockLanguageModelV4 } = {}) {
  const repository = new InMemoryConversationRepository();
  const connector = new ScriptedConnector();
  const messaging = new FakeMessagingProvider();
  const voice = new RealtimeVoiceService(connector);
  const app = createApp({
    repository,
    messagingProvider: messaging,
    ownerPhone: '+15550009999',
    ownerConfigurationService: options.configuration,
    realtimeVoice: voice,
    conversationModel: options.model ? new AiSdkTextAgent(options.model) : undefined,
    autoReplyToCallerTexts: Boolean(options.model),
    providers: [new TwilioProvider({ mediaStreamUrl: `wss://example.test${MEDIA_STREAM_PATH}` }), new FakeTelephonyProvider()],
  });
  const server: Server = createServer(app);
  voice.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await request(app).post('/webhooks/fake/voice').send({ callId: 'journey', callerPhone: '+15553334444' });
  const [conversation] = await repository.list();
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}${MEDIA_STREAM_PATH}`);
  await new Promise((resolve) => socket.once('open', resolve));
  socket.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', customParameters: { conversationId: conversation.id } } }));
  await eventually(() => connector.configs.length === 1, 'realtime session');
  const close = () => { socket.close(); server.close(); };
  return { app, repository, connector, messaging, voice, conversationId: conversation.id, close };
}

test('Journey B: the assistant asks the owner, the owner answers by SMS, and the caller hears it relayed', async (t) => {
  const call = await liveCall();
  t.after(call.close);
  call.connector.emit({
    type: 'function-call-arguments-done', responseId: 'r', itemId: 'i', callId: 'ask',
    name: 'ask_owner', arguments: JSON.stringify({ question: 'Can Jordan move to Friday at 2?', suggestedReplies: ['Friday at 2 works', 'Suggest Monday'] }),
  });
  await eventually(() => call.messaging.sentMessages.some((message) => message.to === '+15550009999'), 'owner notified');
  assert.match(call.messaging.sentMessages.find((message) => message.to === '+15550009999')!.body, /Can Jordan move to Friday at 2\?/);

  const flagged = await request(call.app).get(`/conversations/${call.conversationId}`);
  assert.equal(flagged.body.ownerRequest.question, 'Can Jordan move to Friday at 2?');
  assert.deepEqual(flagged.body.ownerRequest.suggestedReplies, ['Friday at 2 works', 'Suggest Monday']);
  assert.ok(flagged.body.eventLog.some((event: { type: string; payload: { summary?: string } }) =>
    event.type === 'assistant.activity' && event.payload.summary === 'Asked Randy: "Can Jordan move to Friday at 2?"'));

  // The owner replies from their phone by SMS; it lands on the waiting live call.
  const sms = await request(call.app).post('/webhooks/twilio/sms').type('form')
    .send({ MessageSid: 'SM-owner-1', From: '+15550009999', Body: 'Friday at 2 works' });
  assert.equal(sms.status, 200, JSON.stringify(sms.body));
  await eventually(() => call.connector.of('response-create').some((event) =>
    /Randy just replied: "Friday at 2 works"\. Relay this to the caller/.test(event.options?.instructions ?? '')), 'relay request');
  const answered = await request(call.app).get(`/conversations/${call.conversationId}`);
  assert.equal(answered.body.ownerRequest, null);
  const reply = answered.body.eventLog.find((event: { type: string }) => event.type === 'owner.message');
  assert.equal(reply.payload.source, 'sms');
  assert.equal(reply.payload.requestId, 'req_ask');
  assert.match(reply.payload.messageId, /^msg_/);
});

test('Ask-me mode keeps the assistant talking; only takeover silences it', async (t) => {
  const call = await liveCall();
  t.after(call.close);
  await request(call.app).patch(`/conversations/${call.conversationId}/runtime`).send({ aiMode: 'owner_assist', askOwnerWhen: 'important' });
  await eventually(() => call.connector.of('session-update').some((event) => /Ask-me mode is on/.test(event.config.instructions ?? '')), 'ask-me instructions');
  const cancelsBefore = call.connector.of('response-cancel').length;
  call.connector.emit({ type: 'response-created', responseId: 'auto-1' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(call.connector.of('response-cancel').length, cancelsBefore, 'ask-me mode must not cancel replies');

  await request(call.app).post(`/conversations/${call.conversationId}/runtime/takeover`).send({});
  await eventually(() => call.connector.of('session-update').some((event) => /has taken over/.test(event.config.instructions ?? '')), 'takeover instructions');
  call.connector.emit({ type: 'response-created', responseId: 'auto-2' });
  await eventually(() => call.connector.of('response-cancel').length > cancelsBefore, 'takeover cancels autonomous reply');
});

test('Journey E: turning transcription off stops the transcript; turning it back on resumes it', async (t) => {
  const call = await liveCall();
  t.after(call.close);
  const transcript = async () => (await request(call.app).get(`/conversations/${call.conversationId}`)).body.messages
    .filter((message: { role: string }) => message.role === 'caller').map((message: { body: string }) => message.body);

  await request(call.app).patch(`/conversations/${call.conversationId}/runtime`).send({ transcriptionEnabled: false });
  await eventually(() => call.connector.of('session-update').some((event) => !event.config.inputAudioTranscription), 'transcription off');
  call.connector.emit({ type: 'input-transcription-completed', itemId: 'c1', transcript: 'Not recorded' });
  await call.voice.bridge(call.conversationId)!.settled();
  assert.deepEqual(await transcript(), []);

  const runtime = (await request(call.app).get(`/conversations/${call.conversationId}/runtime`)).body;
  await request(call.app).patch(`/conversations/${call.conversationId}/runtime`).send({ transcriptionEnabled: true, expectedRevision: runtime.revision });
  await eventually(() => call.connector.of('session-update').at(-1)?.config.inputAudioTranscription !== undefined, 'transcription on');
  await call.voice.bridge(call.conversationId)!.settled();
  call.connector.emit({ type: 'input-transcription-completed', itemId: 'c2', transcript: 'Recorded again' });
  await call.voice.bridge(call.conversationId)!.settled();
  assert.deepEqual(await transcript(), ['Recorded again']);

  // Voice off: the live session stops producing audio; on again restores it.
  const current = (await request(call.app).get(`/conversations/${call.conversationId}/runtime`)).body;
  await request(call.app).patch(`/conversations/${call.conversationId}/runtime`).send({ voiceEnabled: false, expectedRevision: current.revision });
  await eventually(() => call.connector.of('session-update').at(-1)?.config.outputModalities?.join() === 'text', 'voice off');
  await request(call.app).patch(`/conversations/${call.conversationId}/runtime`).send({ voiceEnabled: true });
  await eventually(() => call.connector.of('session-update').at(-1)?.config.outputModalities?.join() === 'audio', 'voice on');
});

test('defaults come from settings; live adjustments apply only to that conversation', async (t) => {
  const configuration = new OwnerConfigurationService();
  await configuration.update('owner', { assistant: { behavior: 'ask_when_unsure', responseStyle: 'normal' }, calls: { transcriptionEnabled: true } });
  const call = await liveCall({ configuration });
  t.after(call.close);
  const runtime = (await request(call.app).get(`/conversations/${call.conversationId}/runtime`)).body;
  assert.equal(runtime.aiMode, 'owner_assist');
  assert.equal(runtime.askOwnerWhen, 'uncertain');
  assert.equal(runtime.verbosity, 'normal');

  await request(call.app).patch(`/conversations/${call.conversationId}/runtime`).send({ aiMode: 'automatic', askOwnerWhen: 'never' });
  const settings = (await request(call.app).get('/owner/configuration')).body;
  assert.equal(settings.assistant.behavior, 'ask_when_unsure', 'global defaults must not change during a call');
});

test('Journey F: after moving to text, caller texts are answered by the AI SDK text agent, which can escalate', async (t) => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      callTool('ask_owner', { question: 'Morgan asks if the proposal can wait until Monday.', suggestedReplies: ['Monday is fine'] }),
      say("Let me check with Randy and I'll text you right back."),
      say('Randy says Monday is fine.'),
    ],
  });
  const call = await liveCall({ model });
  t.after(call.close);
  call.connector.emit({
    type: 'function-call-arguments-done', responseId: 'r', itemId: 'i', callId: 'txt',
    name: 'transition_to_text', arguments: JSON.stringify({ callerName: 'Morgan' }),
  });
  await eventually(async () => (await request(call.app).get(`/conversations/${call.conversationId}`)).body.state === 'text_active', 'moved to text');
  call.connector.emit({ type: 'session-closed', reason: 'call ended' });

  const inbound = await request(call.app).post('/webhooks/twilio/sms').type('form')
    .send({ MessageSid: 'SM-caller-1', From: '+15553334444', Body: 'Can the proposal wait until Monday?' });
  assert.equal(inbound.status, 200, JSON.stringify(inbound.body));
  assert.equal(inbound.body.ownerRequest.question, 'Morgan asks if the proposal can wait until Monday.');
  assert.equal(call.messaging.sentMessages.at(-1)!.body, "Let me check with Randy and I'll text you right back.");
  assert.match(model.doGenerateCalls[0].prompt.map((message) => JSON.stringify(message.content)).join(' '), /Can the proposal wait until Monday\?/);

  const answer = await request(call.app).post(`/conversations/${call.conversationId}/messages`).send({ body: 'Monday is fine' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(call.messaging.sentMessages.at(-1)!.body, 'Randy says Monday is fine.');
  assert.equal(call.messaging.sentMessages.at(-1)!.to, '+15553334444');
  assert.equal(answer.body.ownerRequest, null);
});

test('Journeys C/D + audit: owner commands reach the live call and the timeline links every id', async (t) => {
  const call = await liveCall();
  t.after(call.close);
  // A caller turn and an assistant response on the call.
  call.connector.emit({ type: 'input-transcription-completed', itemId: 'turn_1', transcript: 'Can we move Friday?' });
  call.connector.emit({ type: 'response-created', responseId: 'resp_1' });
  call.connector.emit({ type: 'audio-transcript-done', responseId: 'resp_1', itemId: 'item_1', transcript: 'Let me check with Randy.' });
  await call.voice.bridge(call.conversationId)!.settled();

  const takeover = await request(call.app).post(`/conversations/${call.conversationId}/runtime/takeover`).send({ commandId: 'cmd_takeover' });
  assert.equal(takeover.body.status, 'takeover');
  assert.equal(takeover.body.mode, 'owner_only');
  await request(call.app).patch(`/conversations/${call.conversationId}/runtime`).send({ commandId: 'cmd_style', verbosity: 'detailed' });
  await request(call.app).post(`/conversations/${call.conversationId}/messages`).send({ body: 'Friday at 2 works.', idempotencyKey: 'owner-1' });
  const stale = await request(call.app).post(`/conversations/${call.conversationId}/runtime/pause`).send({ commandId: 'cmd_stale', expectedRevision: 1 });
  assert.equal(stale.status, 409);

  await eventually(async () => {
    const commands = (await request(call.app).get(`/conversations/${call.conversationId}/runtime/commands`)).body;
    return commands.filter((command: { status: string }) => command.status === 'applied_live').length === 3;
  }, 'commands applied to the live call');
  const commands = (await request(call.app).get(`/conversations/${call.conversationId}/runtime/commands`)).body as Array<Record<string, unknown>>;
  const byId = Object.fromEntries(commands.map((command) => [command.id, command]));
  assert.equal(byId.cmd_takeover.type, 'takeover');
  assert.equal(byId.cmd_takeover.status, 'applied_live');
  assert.ok(byId.cmd_takeover.processedAt && byId.cmd_takeover.appliedLiveAt);
  assert.equal(byId.cmd_style.type, 'set_override');
  assert.equal(byId.cmd_style.status, 'applied_live');
  assert.equal(byId.cmd_stale.status, 'rejected');
  assert.match(String(byId.cmd_stale.error), /stale/);
  const ownerMessage = commands.find((command) => command.type === 'owner_message')!;
  assert.equal(ownerMessage.status, 'applied_live');

  const audit = (await request(call.app).get(`/conversations/${call.conversationId}/audit`)).body;
  const find = (type: string) => audit.timeline.find((entry: { type: string }) => entry.type === type);
  assert.equal(find('speech.transcript').ids.turnId, 'turn_1');
  assert.equal(find('ai.response').ids.responseId, 'resp_1');
  assert.equal(find('voice.started').ids.streamSid, 'MZ1');
  assert.equal(find('runtime.takeover').ids.commandId, 'cmd_takeover');
  assert.match(find('owner.message').ids.messageId, /^msg_/);
  assert.equal(find('runtime.owner_speech').ids.commandId, ownerMessage.id);
  assert.equal(audit.providerCallId, 'journey');
});
