import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp, type AppOptions } from '../src/http-app.js';
import { onboardTenant } from './support/tenant.js';
import { InMemoryConversationRepository } from './support/in-memory-repository.js';
import { InMemoryNotificationDeliveryStore, InMemoryOwnerAttentionStore } from '../src/attention/stores.js';
import { TwilioProvider } from '../src/telephony/twilio-provider.js';
import { FakeConversationModel } from '../src/conversation/fake-model.js';
import { FakeSpeechProvider } from '../src/speech/fake-provider.js';
import { FakeVoiceProvider } from '../src/voice/fake-provider.js';
import { FakeMessagingProvider } from '../src/messaging/fake-provider.js';
import { FakeMacMessagesAdapter } from '../src/owner/fake-mac-messages-adapter.js';
import { OwnerDeviceService } from '../src/owner/device.js';
import { OwnerConfigurationService } from '../src/owner/configuration.js';
import { InMemoryOwnerMessageDeliveryStore, QueuedMacMessagesOwnerChannel } from '../src/owner/delivery.js';
import type { ConversationRuntime } from '../src/domain/runtime.js';
import type { ConversationRuntimeController } from '../src/runtime/controller.js';

class ThrowingTwilioProvider extends TwilioProvider {
  override answerCall(): never {
    throw new Error('provider unavailable');
  }
}

class TrackingRuntimeController implements ConversationRuntimeController {
  readonly calls: string[] = [];
  failure?: { method: string; message: string };

  private maybeFail(method: string): void {
    this.calls.push(method);
    if (this.failure?.method === method) throw new Error(this.failure.message);
  }

  async start(): Promise<void> { this.maybeFail('start'); }
  async stop(): Promise<void> { this.maybeFail('stop'); }
  async pause(): Promise<void> { this.maybeFail('pause'); }
  async resume(): Promise<void> { this.maybeFail('resume'); }
  async interrupt(): Promise<void> { this.maybeFail('interrupt'); }
  async update(_conversationId: string, _config: ConversationRuntime): Promise<void> {
    this.maybeFail('update');
  }
}

/** An app with one fully onboarded customer; the setup texts (verification code) are cleared. */
async function ownedApp(options: Partial<AppOptions> = {}, tenant: Parameters<typeof onboardTenant>[2] = {}) {
  const repository = (options.repository as InMemoryConversationRepository | undefined) ?? new InMemoryConversationRepository();
  const messaging = (options.messagingProvider as FakeMessagingProvider | undefined) ?? new FakeMessagingProvider();
  const app = createApp({ ...options, repository, messagingProvider: messaging });
  const owner = await onboardTenant(app, messaging, tenant);
  messaging.sentMessages.length = 0;
  return { app, repository, messaging, owner, auth: owner.headers };
}

test('inbound webhook creates conversation, persists identifiers, and returns TwiML', async () => {
  const { app, auth, owner } = await ownedApp();

  const response = await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ CallSid: 'CA123', From: '+15555550123', To: owner.line });

  assert.equal(response.status, 200);
  assert.match(response.text, /<Response>/);
  assert.match(response.text, /<Say>/);
  assert.match(response.text, /<Record/);

  const listResponse = await request(app).get('/conversations').set(auth);
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.length, 1);
  assert.equal(listResponse.body[0].caller, '+15555550123');
  assert.equal(listResponse.body[0].providerCallId, 'CA123');
  assert.equal(listResponse.body[0].status, 'answered');
});

test('HTTPS voice turns keep a spoken assistant call working without a WebSocket host', async () => {
  const { app, auth, owner } = await ownedApp({
    providers: [new TwilioProvider({ turnUrl: 'https://text-me.example.test/webhooks/twilio/voice/turn' })],
    conversationModel: new FakeConversationModel(['I can help with that.']),
  });
  const answered = await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ CallSid: 'CA-TURN', From: '+15555550123', To: owner.line });
  assert.equal(answered.status, 200);
  assert.match(answered.text, /<Gather/);
  assert.match(answered.text, /voice\/turn\?conversationId=/);

  const [conversation] = (await request(app).get('/conversations').set(auth)).body;
  assert.deepEqual(conversation.lastAssistantMessage, "Hi, this is Randy's assistant. How can I help?");
  const turn = await request(app)
    .post(`/webhooks/twilio/voice/turn?conversationId=${encodeURIComponent(conversation.id)}&turn=1`)
    .type('form')
    .send({ CallSid: 'CA-TURN', SpeechResult: 'Can you help me?' });
  assert.equal(turn.status, 200, turn.text);
  assert.match(turn.text, /I can help with that/);
  assert.match(turn.text, /turn=2/);

  const details = await request(app).get(`/conversations/${conversation.id}`).set(auth);
  assert.deepEqual(details.body.messages.map((message: { role: string; body: string }) => [message.role, message.body]), [
    ['assistant', "Hi, this is Randy's assistant. How can I help?"],
    ['caller', 'Can you help me?'],
    ['assistant', 'I can help with that.'],
  ]);
});

test('a text-model outage keeps appointment intake going instead of ending the call', async () => {
  const { app, auth, owner } = await ownedApp({
    providers: [new TwilioProvider({ turnUrl: 'https://text-me.example.test/webhooks/twilio/voice/turn' })],
    conversationModel: {
      name: 'unavailable',
      respond: async () => { throw new Error('gateway credits unavailable'); },
    },
  });
  await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ CallSid: 'CA-MODEL-DOWN', From: '+15555550123', To: owner.line });
  const [conversation] = (await request(app).get('/conversations').set(auth)).body;

  const turn = await request(app)
    .post(`/webhooks/twilio/voice/turn?conversationId=${encodeURIComponent(conversation.id)}&turn=1`)
    .type('form')
    .send({ CallSid: 'CA-MODEL-DOWN', SpeechResult: 'I need to make an appointment.' });

  assert.equal(turn.status, 200, turn.text);
  assert.match(turn.headers['content-type'], /text\/xml/);
  assert.match(turn.text, /what is the appointment for/i);
  assert.match(turn.text, /what day and time/i);
  assert.match(turn.text, /turn=2/);
  assert.doesNotMatch(turn.text, /<Hangup/);

  const details = await request(app).get(`/conversations/${conversation.id}`).set(auth);
  assert.equal(details.body.messages.at(-1).body, 'Absolutely. What is the appointment for, and what day and time work best for you?');
  const audit = await request(app).get(`/conversations/${conversation.id}/audit`).set(auth);
  assert.ok(audit.body.timeline.some((event: { type: string }) => event.type === 'assistant.degraded'));
});

test('an outbound test call requires keypad confirmation before starting the assistant', async () => {
  const { app, auth, owner } = await ownedApp({
    providers: [new TwilioProvider({ turnUrl: 'https://text-me.example.test/webhooks/twilio/voice/turn' })],
  });
  const prompt = await request(app)
    .post(`/webhooks/twilio/voice/test?assistantLine=${encodeURIComponent(owner.line)}`)
    .type('form')
    .send({ CallSid: 'CA-TEST', From: owner.line, To: '+15555550199' });

  assert.equal(prompt.status, 200);
  assert.match(prompt.text, /<Gather/);
  assert.match(prompt.text, /Press 1 to talk to your assistant/);
  assert.match(prompt.text, /confirmed=1/);
  assert.deepEqual((await request(app).get('/conversations').set(auth)).body, []);

  const confirmed = await request(app)
    .post(`/webhooks/twilio/voice/test?assistantLine=${encodeURIComponent(owner.line)}&confirmed=1`)
    .type('form')
    .send({ CallSid: 'CA-TEST', From: owner.line, To: '+15555550199', Digits: '1' });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.match(confirmed.text, /<Gather/);
  assert.equal((await request(app).get('/conversations').set(auth)).body.length, 1);
});

test('a call to a number no account owns is not answered and creates nothing', async () => {
  const { app, auth, repository, owner } = await ownedApp();

  const response = await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ CallSid: 'CA-UNKNOWN', From: '+15555550123', To: '+15550000001' });
  const missingTo = await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ CallSid: 'CA-NO-TO', From: '+15555550123' });

  assert.equal(response.status, 200);
  assert.match(response.text, /not in service/);
  assert.match(missingTo.text, /not in service/);
  assert.equal((await repository.list(owner.accountId)).length, 0);
  assert.equal((await request(app).get('/conversations').set(auth)).body.length, 0);
});

test('duplicate inbound webhook does not create a duplicate conversation', async () => {
  const { app, auth, owner } = await ownedApp();

  await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ CallSid: 'CA123', From: '+15555550123', To: owner.line });

  await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ CallSid: 'CA123', From: '+15555550123', To: owner.line });

  const listResponse = await request(app).get('/conversations').set(auth);
  assert.equal(listResponse.body.length, 1);

  const detailsResponse = await request(app).get(
    `/conversations/${listResponse.body[0].id}`,
  ).set(auth);
  assert.deepEqual(detailsResponse.body.events, ['call.received', 'call.answered']);
});

test('completed status records end time and duration', async () => {
  const { app, owner } = await ownedApp();

  await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ CallSid: 'CA999', From: '+15555550999', To: owner.line });

  const response = await request(app)
    .post('/webhooks/twilio/status')
    .type('form')
    .send({ CallSid: 'CA999', CallStatus: 'completed', CallDuration: '42' });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'completed');
  assert.equal(response.body.durationSeconds, 42);
  assert.ok(response.body.endedAt);
  assert.deepEqual(response.body.events, [
    'call.received',
    'call.answered',
    'call.ended',
  ]);
});

test('call status transitions reject invalid completion before answer', async () => {
  const { app, repository, owner } = await ownedApp();
  const conversation = await repository.createIfAbsent({
    provider: 'twilio',
    providerCallId: 'CAEARLY',
    callerPhone: '+15550000000',
    status: 'received',
    startedAt: new Date(),
    accountId: owner.accountId,
  });
  await repository.appendEvent(
    conversation.conversation.id,
    'call.received',
    { CallSid: 'CAEARLY', From: '+15550000000' },
    new Date(),
  );

  const response = await request(app)
    .post('/webhooks/twilio/status')
    .type('form')
    .send({ CallSid: 'CAEARLY', CallStatus: 'completed', CallDuration: '4' });

  assert.equal(response.status, 409);
});

test('malformed webhook payloads are rejected', async () => {
  const { app, owner } = await ownedApp();

  const response = await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ From: '+15555550123', To: owner.line });

  assert.equal(response.status, 400);
});

test('provider failure does not corrupt conversation state', async () => {
  const { app, auth, owner } = await ownedApp({
    providers: [new ThrowingTwilioProvider()],
    includeFakeProviderRoutes: false,
  });

  const response = await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ CallSid: 'CAFAIL', From: '+15555550123', To: owner.line });

  assert.equal(response.status, 500);

  const listResponse = await request(app).get('/conversations').set(auth);
  assert.equal(listResponse.body.length, 1);
  assert.equal(listResponse.body[0].status, 'received');

  const detailsResponse = await request(app).get(
    `/conversations/${listResponse.body[0].id}`,
  ).set(auth);
  assert.deepEqual(detailsResponse.body.events, ['call.received']);
});

test('fake provider exercises the same lifecycle', async () => {
  const { app, owner } = await ownedApp();

  const voiceResponse = await request(app)
    .post('/webhooks/fake/voice')
    .send({ callId: 'fake-1', callerPhone: '+15555550123', to: owner.line });
  assert.equal(voiceResponse.status, 200);
  assert.match(voiceResponse.text, /<Response>/);
  // The account's own greeting, with its owner's name; nothing is hard-coded.
  assert.match(voiceResponse.text, /Hi, this is Randy&apos;s assistant/);

  const statusResponse = await request(app)
    .post('/webhooks/fake/status')
    .send({ callId: 'fake-1', status: 'completed', durationSeconds: 12 });
  assert.equal(statusResponse.status, 200);
  assert.equal(statusResponse.body.status, 'completed');
  assert.deepEqual(statusResponse.body.events, [
    'call.received',
    'call.answered',
    'call.ended',
  ]);
});

test('fake providers run ordered, idempotent conversational turns', async () => {
  const voice = new FakeVoiceProvider();
  const { app, auth, owner } = await ownedApp({
    voiceProvider: voice,
    speechProvider: new FakeSpeechProvider(),
    conversationModel: new FakeConversationModel(['I can help with that.']),
  });

  await request(app)
    .post('/webhooks/fake/voice')
    .send({ callId: 'conversation-1', callerPhone: '+15555550123', to: owner.line });
  const conversationId = (await request(app).get('/conversations').set(auth)).body[0].id;

  assert.equal((await request(app).post(`/conversations/${conversationId}/turns`)
    .send({ callbackId: 'media-0', audio: 'Hello?' })).status, 401, 'the scripted pipeline is not open to anyone');

  const turn = await request(app)
    .post(`/conversations/${conversationId}/turns`).set(auth)
    .send({ callbackId: 'media-1', audio: 'I need to reschedule tomorrow.' });
  assert.equal(turn.status, 200);
  assert.deepEqual(turn.body.events, [
    'call.received',
    'call.answered',
    'speech.started',
    'speech.transcript',
    'ai.thinking',
    'ai.response',
    'voice.started',
    'voice.completed',
  ]);
  assert.equal(turn.body.eventLog[3].payload.text, 'I need to reschedule tomorrow.');
  assert.equal(turn.body.eventLog[3].payload.sequence, 3);
  assert.equal(turn.body.eventLog[5].payload.text, 'I can help with that.');
  assert.equal(turn.body.eventLog[5].payload.sequence, 4);
  assert.equal(voice.outputs.length, 1);

  const duplicate = await request(app)
    .post(`/conversations/${conversationId}/turns`).set(auth)
    .send({ callbackId: 'media-1', audio: 'I need to reschedule tomorrow.' });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.events.length, turn.body.events.length);
  assert.equal(voice.outputs.length, 1);
});

test('voice conversations bridge to one idempotent SMS conversation', async () => {
  const { app, auth, owner, messaging } = await ownedApp({
    speechProvider: new FakeSpeechProvider(),
    conversationModel: new FakeConversationModel(['I can help with that.']),
  });
  await request(app).post('/webhooks/fake/voice')
    .send({ callId: 'bridge-1', callerPhone: '+15555550123', to: owner.line });
  const id = (await request(app).get('/conversations').set(auth)).body[0].id;
  await request(app).post(`/conversations/${id}/turns`).set(auth)
    .send({ callbackId: 'bridge-turn', audio: 'Move tomorrow meeting to Friday.' });
  await request(app).post(`/conversations/${id}/sms-consent`).set(auth)
    .send({ phoneNumber: '+15555550123', displayName: 'John' });

  const first = await request(app).post(`/conversations/${id}/convert-to-text`).set(auth);
  const second = await request(app).post(`/conversations/${id}/convert-to-text`).set(auth);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(messaging.sentMessages.length, 2);
  // Both texts come from this account's own line: the caller's introduction and the owner's heads-up.
  assert.deepEqual(messaging.sentMessages.map((message) => message.from), [owner.line, owner.line]);
  assert.match(messaging.sentMessages[0].body, /this is Randy's assistant/);
  assert.equal(first.body.id, second.body.id);
  assert.equal(first.body.primaryChannel, 'sms');
  assert.deepEqual(first.body.channels, ['voice', 'sms']);
  assert.equal(first.body.state, 'text_active');
});

test('sms consent and text conversion routes are available before any turn callbacks run', async () => {
  const { app, auth, owner, messaging } = await ownedApp();

  await request(app).post('/webhooks/fake/voice')
    .send({ callId: 'bridge-routes', callerPhone: '+15555550123', to: owner.line });
  const id = (await request(app).get('/conversations').set(auth)).body[0].id;

  const consent = await request(app)
    .post(`/conversations/${id}/sms-consent`).set(auth)
    .send({ phoneNumber: '+15555550123', displayName: 'John' });
  const bridge = await request(app).post(`/conversations/${id}/convert-to-text`).set(auth);

  assert.equal(consent.status, 200, JSON.stringify(consent.body));
  assert.equal(bridge.status, 200, JSON.stringify(bridge.body));
  assert.equal(bridge.body.id, id);
  assert.equal(bridge.body.primaryChannel, 'sms');
  assert.equal(messaging.sentMessages.length, 2);
});

test('text-active turns use messaging instead of voice', async () => {
  const voice = new FakeVoiceProvider();
  const { app, auth, owner, messaging } = await ownedApp({
    voiceProvider: voice,
    speechProvider: new FakeSpeechProvider(),
    conversationModel: new FakeConversationModel(['SMS reply']),
  });
  await request(app).post('/webhooks/fake/voice')
    .send({ callId: 'bridge-2', callerPhone: '+15555550123', to: owner.line });
  const id = (await request(app).get('/conversations').set(auth)).body[0].id;
  await request(app).post(`/conversations/${id}/turns`).set(auth)
    .send({ callbackId: 'pre-bridge', audio: 'I need help.' });
  await request(app).post(`/conversations/${id}/sms-consent`).set(auth)
    .send({ phoneNumber: '+15555550123' });
  const bridge = await request(app).post(`/conversations/${id}/convert-to-text`).set(auth);
  assert.equal(bridge.status, 200, JSON.stringify(bridge.body));
  assert.equal((await request(app).get(`/conversations/${id}`).set(auth)).body.state, 'text_active');
  voice.outputs.length = 0;
  await request(app).post(`/conversations/${id}/turns`).set(auth)
    .send({ callbackId: 'sms-turn', audio: 'Friday works.' });

  assert.equal(voice.outputs.length, 0);
  assert.equal(messaging.sentMessages.length, 3);
});


test('QR pairing route returns a scannable QR image payload', async () => {
  const { app, auth } = await ownedApp();

  assert.equal((await request(app).post('/owner/devices/pair/qr').send({ name: 'Audit Mac' })).status, 401);
  const pair = await request(app)
    .post('/owner/devices/pair/qr').set(auth)
    .send({ name: 'Audit Mac' });

  assert.equal(pair.status, 201, JSON.stringify(pair.body));
  assert.match(pair.body.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(typeof pair.body.pairingUri, 'string');
});


test('QR pairing route surfaces QR generation failures as an error response', async () => {
  const { app, auth } = await ownedApp({
    qrCodeDataUrl: async () => { throw new Error('QR unavailable'); },
  });

  const pair = await request(app)
    .post('/owner/devices/pair/qr').set(auth)
    .send({ name: 'Audit Mac' });

  assert.equal(pair.status, 500, JSON.stringify(pair.body));
  assert.deepEqual(pair.body, { error: 'Internal server error' });
});

test('global device activation route works without priming the per-device activation route', async () => {
  const { app, auth, owner } = await ownedApp();

  const pair = await request(app)
    .post('/owner/devices/pair/qr').set(auth)
    .send({ name: 'Audit Mac' });
  const activate = await request(app)
    .post('/owner/devices/activate')
    .send({ pairingCredential: pair.body.pairingUri });

  assert.equal(pair.status, 201, JSON.stringify(pair.body));
  assert.equal(activate.status, 200, JSON.stringify(activate.body));
  assert.equal(activate.body.device.id, pair.body.deviceId);
  // The Mac belongs to the account that paired it, and to the user who did.
  assert.equal(activate.body.device.accountId, owner.accountId);
  assert.equal(activate.body.device.userId, owner.userId);
  assert.equal(typeof activate.body.sessionToken, 'string');
});

/** A ready Mac for the account, paired through the device service the app uses. */
async function readyMac(ownerDevices: OwnerDeviceService, accountId: string) {
  const adapter = new FakeMacMessagesAdapter();
  adapter.chats = [{ id: 'assistant-chat', service: 'imessage', displayName: 'Assistant', address: 'assistant@example.test' }];
  const pair = await ownerDevices.pair(accountId, 'Randy Mac');
  const activation = await ownerDevices.activate(pair.device.id, pair.pairingCode);
  await ownerDevices.heartbeat(activation.sessionToken, await adapter.checkCapabilities());
  await ownerDevices.discoverChats(activation.sessionToken, adapter);
  await ownerDevices.authorizeChat(accountId, pair.device.id, 'assistant-chat', 'imessage');
  await ownerDevices.heartbeat(activation.sessionToken, await adapter.checkCapabilities());
  await ownerDevices.setPrimary(accountId, pair.device.id);
  return { adapter, pair, activation, auth: { Authorization: 'Bearer ' + activation.sessionToken } };
}

async function textConversation(repository: InMemoryConversationRepository, accountId: string, callId: string, state: 'awaiting_sms_consent' | 'text_active' = 'awaiting_sms_consent') {
  const created = await repository.createIfAbsent({
    provider: 'fake', providerCallId: callId, callerPhone: '+15555550123', status: 'answered', startedAt: new Date(), accountId,
  });
  await repository.appendEvent(created.conversation.id, 'speech.transcript', {
    callbackId: 'voice-summary', speaker: 'caller', text: 'Friday lunch', sequence: 1,
  }, new Date());
  await repository.appendEvent(created.conversation.id, 'sms.consent.granted', { phoneNumber: '+15555550123', displayName: 'John' }, new Date());
  await repository.updateStatus(created.conversation.id, 'answered', { state });
  return created.conversation;
}

test('device delivery queue and Mac replies bridge owner messages back to the caller', async () => {
  const ownerDevices = new OwnerDeviceService();
  const ownerConfiguration = new OwnerConfigurationService();
  const ownerDeliveries = new InMemoryOwnerMessageDeliveryStore();
  const adapter = new FakeMacMessagesAdapter();
  const { app, auth: ownerAuth, owner, repository, messaging } = await ownedApp({
    ownerChannel: new QueuedMacMessagesOwnerChannel(ownerDeliveries, ownerDevices, ownerConfiguration),
    ownerDeviceService: ownerDevices,
    ownerConfigurationService: ownerConfiguration,
    ownerDeliveryStore: ownerDeliveries,
    ownerMessagesAdapter: adapter,
    conversationModel: new FakeConversationModel(['Randy says Friday at 2 works.']),
  });
  const { pair, auth } = await readyMac(ownerDevices, owner.accountId);
  const conversation = await textConversation(repository, owner.accountId, 'mac-1');

  const converted = await request(app).post(`/conversations/${conversation.id}/convert-to-text`).set(ownerAuth);
  assert.equal(converted.status, 200, JSON.stringify(converted.body));
  assert.equal(messaging.sentMessages.length, 1);
  assert.equal(messaging.sentMessages[0]?.to, '+15555550123');

  const pending = await request(app)
    .get(`/owner/devices/${pair.device.id}/deliveries`)
    .set(auth);
  assert.equal(pending.status, 200, JSON.stringify(pending.body));
  assert.equal(pending.body.length, 1);
  assert.equal(pending.body[0].accountId, owner.accountId);

  const requested = await request(app)
    .post(`/owner/devices/${pair.device.id}/deliveries/${pending.body[0].id}/requested`)
    .set(auth)
    .send({ providerRequestId: 'request-1' });
  assert.equal(requested.status, 200, JSON.stringify(requested.body));

  const observed = await request(app)
    .post(`/owner/devices/${pair.device.id}/deliveries/${pending.body[0].id}/observed`)
    .set(auth)
    .send({ externalId: 'request-1' });
  assert.equal(observed.status, 200, JSON.stringify(observed.body));
  const sentEvent = (await repository.getById(conversation.id))!.events.find((event) => event.type === 'owner.delivery.sent');
  assert.deepEqual(sentEvent?.payload, {
    messageId: pending.body[0].messageId,
    deliveryId: pending.body[0].id,
    externalId: 'request-1',
    providerRequestId: 'request-1',
    source: 'macos_messages',
  });

  const reply = await request(app)
    .post(`/owner/devices/${pair.device.id}/messages/replies`)
    .set(auth)
    .send({ externalId: 'reply-1', body: 'Friday at 2 works.', deliveryId: pending.body[0].id, replyToExternalId: 'request-1' });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(messaging.sentMessages.length, 2);
  assert.equal(messaging.sentMessages[1]?.body, 'Randy says Friday at 2 works.');
  assert.equal(reply.body.messages.some((message: { role: string; body: string }) =>
    message.role === 'owner' && message.body === 'Friday at 2 works.'), true);
  assert.equal(reply.body.messages.some((message: { role: string; body: string }) =>
    message.role === 'assistant' && message.body === 'Randy says Friday at 2 works.'), true);
});


test('delivery failure route records a durable owner delivery failure event', async () => {
  const ownerDevices = new OwnerDeviceService();
  const ownerConfiguration = new OwnerConfigurationService();
  const ownerDeliveries = new InMemoryOwnerMessageDeliveryStore();
  const { app, auth: ownerAuth, owner, repository } = await ownedApp({
    ownerChannel: new QueuedMacMessagesOwnerChannel(ownerDeliveries, ownerDevices, ownerConfiguration),
    ownerDeviceService: ownerDevices,
    ownerConfigurationService: ownerConfiguration,
    ownerDeliveryStore: ownerDeliveries,
    ownerMessagesAdapter: new FakeMacMessagesAdapter(),
  });
  const { pair, auth } = await readyMac(ownerDevices, owner.accountId);
  const conversation = await textConversation(repository, owner.accountId, 'mac-failure');

  await request(app).post(`/conversations/${conversation.id}/convert-to-text`).set(ownerAuth);
  const pending = await request(app)
    .get(`/owner/devices/${pair.device.id}/deliveries`)
    .set(auth);
  const failed = await request(app)
    .post(`/owner/devices/${pair.device.id}/deliveries/${pending.body[0].id}/failed`)
    .set(auth)
    .send({ error: 'Messages.app unavailable' });

  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  const failureEvent = (await repository.getById(conversation.id))!.events.find((event) => event.type === 'owner.delivery.failed');
  assert.deepEqual(failureEvent?.payload, {
    messageId: pending.body[0].messageId,
    deliveryId: pending.body[0].id,
    error: 'Messages.app unavailable',
    source: 'macos_messages',
  });
});

test('authenticated owner inbox authorizes and mediates web messages', async () => {
  const { app, auth, owner, repository, messaging } = await ownedApp({
    conversationModel: new FakeConversationModel(['Randy says Friday at 2 works.']),
  });
  const conversation = await textConversation(repository, owner.accountId, 'web-1', 'text_active');

  assert.equal((await request(app).get('/conversations')).status, 401);
  assert.equal((await request(app).get('/conversations').set('Authorization', 'Bearer ses_forged')).status, 401);
  assert.equal((await request(app).get('/conversations').set(auth)).body.length, 1);
  const response = await request(app)
    .post(`/conversations/${conversation.id}/messages`)
    .set(auth)
    .send({ body: 'Friday at 2 works.', idempotencyKey: 'web-message-1' });
  assert.equal(response.status, 200);
  assert.equal(messaging.sentMessages.length, 1);
  assert.equal(messaging.sentMessages[0].from, owner.line);
  assert.equal(response.body.messages.some((message: { role: string; body: string }) =>
    message.role === 'owner' && message.body === 'Friday at 2 works.'), true);
});

test('an owner can resolve a voice-call request after hangup without caller SMS consent', async () => {
  const { app, auth, owner, repository, messaging } = await ownedApp();
  await request(app).post('/webhooks/fake/voice')
    .send({ callId: 'voice-owner-reply', callerPhone: '+15555550123', to: owner.line });
  const [conversation] = await repository.list(owner.accountId);
  await repository.appendEvent(conversation.id, 'owner.attention.requested', {
    requestId: 'req_after_call', question: 'A caller wants an appointment. What should I do?',
    suggestedReplies: ["I'll call them back"], source: 'voice',
  }, new Date());
  await request(app).post('/webhooks/fake/status')
    .send({ callId: 'voice-owner-reply', status: 'completed', durationSeconds: 20 });

  const reply = await request(app).post(`/conversations/${conversation.id}/messages`).set(auth)
    .send({ body: "I'll call them back", idempotencyKey: 'web-after-call' });

  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.ownerReply.delivery, 'recorded_after_call');
  assert.equal(reply.body.ownerRequest, null);
  assert.equal(messaging.sentMessages.length, 0, 'an owner decision must not text a caller without consent');
  assert.ok(reply.body.messages.some((message: { role: string; body: string; channel: string }) =>
    message.role === 'owner' && message.body === "I'll call them back" && message.channel === 'internal'));
});

test('a queued owner decision is spoken on the next turn of an active voice call', async () => {
  const { app, auth, owner, repository } = await ownedApp({
    providers: [new TwilioProvider({ turnUrl: 'https://text-me.example.test/webhooks/twilio/voice/turn' })],
  });
  await request(app).post('/webhooks/twilio/voice').type('form')
    .send({ CallSid: 'CA-OWNER-RELAY', From: '+15555550123', To: owner.line });
  const [conversation] = await repository.list(owner.accountId);
  await repository.appendEvent(conversation.id, 'owner.attention.requested', {
    requestId: 'req_another_time', question: 'What should I tell the caller?',
    suggestedReplies: ["I'll call them back", 'Ask for another time'], source: 'voice',
  }, new Date());

  const reply = await request(app).post(`/conversations/${conversation.id}/messages`).set(auth)
    .send({ body: 'Ask for another time', idempotencyKey: 'web-another-time' });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.ownerReply.delivery, 'queued_for_voice');

  const turn = await request(app)
    .post(`/webhooks/twilio/voice/turn?conversationId=${encodeURIComponent(conversation.id)}&turn=3`)
    .type('form').send({ CallSid: 'CA-OWNER-RELAY', SpeechResult: '' });
  assert.equal(turn.status, 200, turn.text);
  assert.match(turn.text, /Randy asked me to find another time/i);
  assert.match(turn.text, /What other day and time would work for you/i);

  const replay = await request(app)
    .post(`/webhooks/twilio/voice/turn?conversationId=${encodeURIComponent(conversation.id)}&turn=4`)
    .type('form').send({ CallSid: 'CA-OWNER-RELAY', SpeechResult: '' });
  assert.doesNotMatch(replay.text, /Randy asked me to find another time/i);
  const updated = await repository.getById(conversation.id);
  assert.equal(updated?.events.filter((event) => event.type === 'owner.message.relayed').length, 1);
});

async function answeredConversation(repository: InMemoryConversationRepository, accountId: string, callId: string) {
  return (await repository.createIfAbsent({
    provider: 'fake', providerCallId: callId, callerPhone: '+15555550123', status: 'answered', startedAt: new Date(), accountId,
  })).conversation;
}

test('runtime lifecycle commands are durable, idempotent, and enforce stale revisions', async () => {
  const { app, auth, owner, repository } = await ownedApp();
  const conversation = await answeredConversation(repository, owner.accountId, 'runtime-1');

  const snapshot = await request(app)
    .get(`/conversations/${conversation.id}/runtime`)
    .set(auth);
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
  assert.equal(snapshot.body.state, 'listening');

  const pause = await request(app)
    .post(`/conversations/${conversation.id}/runtime/pause`)
    .set(auth)
    .send({ commandId: 'pause-1', expectedRevision: snapshot.body.revision });
  assert.equal(pause.status, 200, JSON.stringify(pause.body));
  assert.equal(pause.body.state, 'paused');

  const duplicate = await request(app)
    .post(`/conversations/${conversation.id}/runtime/pause`)
    .set(auth)
    .send({ commandId: 'pause-1', expectedRevision: snapshot.body.revision });
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.revision, pause.body.revision);

  const stale = await request(app)
    .post(`/conversations/${conversation.id}/runtime/resume`)
    .set(auth)
    .send({ expectedRevision: snapshot.body.revision });
  assert.equal(stale.status, 409);

  const resume = await request(app)
    .post(`/conversations/${conversation.id}/runtime/resume`)
    .set(auth)
    .send({ expectedRevision: pause.body.revision });
  assert.equal(resume.status, 200, JSON.stringify(resume.body));
  assert.equal(resume.body.state, 'listening');

  const stop = await request(app)
    .post(`/conversations/${conversation.id}/runtime/stop`)
    .set(auth)
    .send({ expectedRevision: resume.body.revision });
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  assert.equal(stop.body.state, 'stopped');

  const invalidResume = await request(app)
    .post(`/conversations/${conversation.id}/runtime/resume`)
    .set(auth)
    .send({ expectedRevision: stop.body.revision });
  assert.equal(invalidResume.status, 409);
});

test('takeover stops autonomous replies and temporary runtime overrides do not mutate owner defaults', async () => {
  const voice = new FakeVoiceProvider();
  const { app, auth, owner, repository } = await ownedApp({
    voiceProvider: voice,
    speechProvider: new FakeSpeechProvider(),
    conversationModel: new FakeConversationModel(['I can help with that.']),
  });
  const conversation = await answeredConversation(repository, owner.accountId, 'runtime-2');

  const takeover = await request(app)
    .post(`/conversations/${conversation.id}/runtime/takeover`)
    .set(auth)
    .send({});
  assert.equal(takeover.status, 200, JSON.stringify(takeover.body));
  assert.equal(takeover.body.aiMode, 'owner_only');
  assert.equal(takeover.body.state, 'waiting_for_owner');

  const turn = await request(app)
    .post(`/conversations/${conversation.id}/turns`).set(auth)
    .send({ callbackId: 'turn-owner-only', audio: 'Can you move Friday?' });
  assert.equal(turn.status, 200, JSON.stringify(turn.body));
  assert.equal(turn.body.events.includes('ai.response'), false);
  assert.equal(voice.outputs.length, 0);
  assert.equal(turn.body.runtime.state, 'waiting_for_owner');

  const config = await request(app)
    .patch(`/conversations/${conversation.id}/runtime`)
    .set(auth)
    .send({ responseStyle: 'concise', verbosity: 'short', askOwnerWhen: 'important' });
  assert.equal(config.status, 200, JSON.stringify(config.body));
  assert.equal(config.body.responseStyle, 'concise');
  assert.equal(config.body.verbosity, 'short');
  assert.equal(config.body.askOwnerWhen, 'important');

  const defaults = await request(app)
    .get('/owner/configuration')
    .set(auth);
  assert.equal(defaults.status, 200, JSON.stringify(defaults.body));
  assert.equal(defaults.body.assistant.responseStyle, 'concise');
  assert.equal(defaults.body.messages.interruptOnlyWhenNeeded, true);

  const returned = await request(app)
    .post(`/conversations/${conversation.id}/runtime/return-to-assistant`)
    .set(auth)
    .send({ expectedRevision: config.body.revision });
  assert.equal(returned.status, 200, JSON.stringify(returned.body));
  assert.equal(returned.body.aiMode, 'automatic');
});

test('voice can be disabled independently and runtime controller failures surface explicit command errors', async () => {
  const controller = new TrackingRuntimeController();
  const voice = new FakeVoiceProvider();
  const { app, auth, owner, repository } = await ownedApp({
    runtimeController: controller,
    voiceProvider: voice,
    speechProvider: new FakeSpeechProvider(),
    conversationModel: new FakeConversationModel(['Voice disabled reply', 'Voice restored reply']),
  });
  const conversation = await answeredConversation(repository, owner.accountId, 'runtime-3');

  const disabled = await request(app)
    .patch(`/conversations/${conversation.id}/runtime`)
    .set(auth)
    .send({ voiceEnabled: false });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  assert.equal(disabled.body.voiceEnabled, false);

  const silentTurn = await request(app)
    .post(`/conversations/${conversation.id}/turns`).set(auth)
    .send({ callbackId: 'silent-turn', audio: 'Please help.' });
  assert.equal(silentTurn.status, 200, JSON.stringify(silentTurn.body));
  assert.equal(voice.outputs.length, 0);

  const reenabled = await request(app)
    .patch(`/conversations/${conversation.id}/runtime`)
    .set(auth)
    .send({ voiceEnabled: true, expectedRevision: disabled.body.revision });
  assert.equal(reenabled.status, 200, JSON.stringify(reenabled.body));
  assert.equal(reenabled.body.voiceEnabled, true);

  await request(app)
    .post(`/conversations/${conversation.id}/turns`).set(auth)
    .send({ callbackId: 'voice-turn', audio: 'Try again.' });
  assert.equal(voice.outputs.length, 1);

  controller.failure = { method: 'pause', message: 'active call runtime unavailable' };
  const failedPause = await request(app)
    .post(`/conversations/${conversation.id}/runtime/pause`)
    .set(auth)
    .send({ expectedRevision: reenabled.body.revision });
  assert.equal(failedPause.status, 409);
  assert.match(failedPause.body.error, /active call runtime unavailable/);

  const snapshot = await request(app)
    .get(`/conversations/${conversation.id}/runtime`)
    .set(auth);
  assert.equal(snapshot.body.state, 'listening');
});

test('SMS transition runtime request preserves caller consent and can stream SSE updates', async () => {
  const { app, auth, owner, repository, messaging } = await ownedApp();
  const conversation = await answeredConversation(repository, owner.accountId, 'runtime-4');

  const server = app.listen(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const streamResponse = await fetch(`http://127.0.0.1:${address.port}/conversations/${conversation.id}/runtime/events`, {
      headers: auth,
    });
    assert.equal(streamResponse.status, 200);
    assert.equal(streamResponse.headers.get('content-type'), 'text/event-stream');
    const reader = streamResponse.body!.getReader();
    const firstChunk = await reader.read();
    assert.equal(firstChunk.done, false);
    const payload = new TextDecoder().decode(firstChunk.value);
    assert.match(payload, /runtime.state_changed/);
    reader.cancel().catch(() => undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  const requested = await request(app)
    .post(`/conversations/${conversation.id}/runtime/transition-to-sms`)
    .set(auth)
    .send({});
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  assert.equal(requested.body.state, 'transferring');

  const withoutConsent = await request(app)
    .post(`/conversations/${conversation.id}/convert-to-text`).set(auth);
  assert.equal(withoutConsent.status, 409);

  await request(app)
    .post(`/conversations/${conversation.id}/sms-consent`).set(auth)
    .send({ phoneNumber: '+15555550123', displayName: 'John' });
  const converted = await request(app)
    .post(`/conversations/${conversation.id}/convert-to-text`).set(auth);
  assert.equal(converted.status, 200, JSON.stringify(converted.body));
  assert.equal(converted.body.runtime.state, 'text_active');
  assert.equal(messaging.sentMessages.length, 2);
});

test('with no Mac anywhere, moving to text works and the owner is reached by SMS, with no Mac traces', async () => {
  const attentionStore = new InMemoryOwnerAttentionStore();
  const deliveries = new InMemoryNotificationDeliveryStore(attentionStore);
  const { app, auth, owner, repository, messaging } = await ownedApp({
    attentionStore,
    notificationDeliveryStore: deliveries,
  }, { personal: '+15550009999' });
  await request(app).post('/webhooks/fake/voice').send({ callId: 'no-mac', callerPhone: '+15553334444', to: owner.line });
  const [conversation] = await repository.list(owner.accountId);
  await request(app).post(`/conversations/${conversation.id}/sms-consent`).set(auth).send({ phoneNumber: '+15553334444', displayName: 'Jordan' });

  const converted = await request(app).post(`/conversations/${conversation.id}/convert-to-text`).set(auth);

  assert.equal(converted.status, 200, JSON.stringify(converted.body));
  assert.equal(converted.body.state, 'text_active');
  // The caller, then the owner's own verified number: both from the owner's own line.
  assert.deepEqual(messaging.sentMessages.map((message) => [message.to, message.from]), [['+15553334444', owner.line], ['+15550009999', owner.line]]);
  assert.ok(!converted.body.events.some((type: string) => type.startsWith('owner.delivery')), 'no Mac delivery attempted');
  const transferred = (await attentionStore.list(owner.accountId)).find((item) => item.type === 'conversation_transferred')!;
  assert.equal(transferred.title, 'Jordan is now texting');
  assert.equal(transferred.status, 'delivered');
  assert.deepEqual((await deliveries.list(transferred.id)).map((delivery) => [delivery.surface, delivery.status]), [['owner_sms', 'sent']]);
});
