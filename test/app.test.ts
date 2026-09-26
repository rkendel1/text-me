import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import type {
  Conversation,
  ConversationEvent,
  ConversationStatus,
} from '../src/domain/conversation.js';
import { createConversationId, createEventId } from '../src/lib/ids.js';
import type {
  ConversationRepository,
  CreateConversationInput,
} from '../src/repositories/conversation-repository.js';
import { TwilioProvider } from '../src/telephony/twilio-provider.js';

class InMemoryConversationRepository implements ConversationRepository {
  private readonly conversations = new Map<string, Conversation>();
  private readonly byProviderCallId = new Map<string, string>();

  async createIfAbsent(
    input: CreateConversationInput,
  ): Promise<{ conversation: Conversation; created: boolean }> {
    const key = `${input.provider}:${input.providerCallId}`;
    const existingId = this.byProviderCallId.get(key);

    if (existingId) {
      return {
        conversation: structuredClone(this.conversations.get(existingId)!),
        created: false,
      };
    }

    const conversation: Conversation = {
      id: createConversationId(),
      provider: input.provider,
      providerCallId: input.providerCallId,
      callerPhone: input.callerPhone,
      status: input.status,
      startedAt: input.startedAt,
      endedAt: null,
      durationSeconds: null,
      events: [],
    };

    this.byProviderCallId.set(key, conversation.id);
    this.conversations.set(conversation.id, structuredClone(conversation));

    return {
      conversation: structuredClone(conversation),
      created: true,
    };
  }

  async getById(id: string): Promise<Conversation | null> {
    return structuredClone(this.conversations.get(id) ?? null);
  }

  async getByProviderCallId(
    provider: string,
    providerCallId: string,
  ): Promise<Conversation | null> {
    const id = this.byProviderCallId.get(`${provider}:${providerCallId}`);
    return id ? this.getById(id) : null;
  }

  async list(): Promise<Conversation[]> {
    return [...this.conversations.values()]
      .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
      .map((conversation) => structuredClone(conversation));
  }

  async appendEvent(
    conversationId: string,
    type: ConversationEvent['type'],
    payload: Record<string, unknown>,
    occurredAt: Date,
  ): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return;
    }

    conversation.events.push({
      id: createEventId(),
      conversationId,
      type,
      payload,
      occurredAt,
    });
  }

  async updateStatus(
    conversationId: string,
    status: ConversationStatus,
    patch: { endedAt?: Date | null; durationSeconds?: number | null },
  ): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return;
    }

    conversation.status = status;
    if (patch.endedAt !== undefined) {
      conversation.endedAt = patch.endedAt;
    }
    if (patch.durationSeconds !== undefined) {
      conversation.durationSeconds = patch.durationSeconds;
    }
  }
}

class ThrowingTwilioProvider extends TwilioProvider {
  override answerCall() {
    throw new Error('provider unavailable');
  }
}

test('inbound webhook creates conversation, persists identifiers, and returns TwiML', async () => {
  const repository = new InMemoryConversationRepository();
  const app = createApp({ repository });

  const response = await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ CallSid: 'CA123', From: '+15555550123' });

  assert.equal(response.status, 200);
  assert.match(response.text, /<Response>/);
  assert.match(response.text, /<Say>/);
  assert.match(response.text, /<Record/);

  const listResponse = await request(app).get('/conversations');
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.length, 1);
  assert.equal(listResponse.body[0].caller, '+15555550123');
  assert.equal(listResponse.body[0].providerCallId, 'CA123');
  assert.equal(listResponse.body[0].status, 'answered');
});

test('duplicate inbound webhook does not create a duplicate conversation', async () => {
  const repository = new InMemoryConversationRepository();
  const app = createApp({ repository });

  await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ CallSid: 'CA123', From: '+15555550123' });

  await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ CallSid: 'CA123', From: '+15555550123' });

  const listResponse = await request(app).get('/conversations');
  assert.equal(listResponse.body.length, 1);

  const detailsResponse = await request(app).get(
    `/conversations/${listResponse.body[0].id}`,
  );
  assert.deepEqual(detailsResponse.body.events, ['call.received', 'call.answered']);
});

test('completed status records end time and duration', async () => {
  const repository = new InMemoryConversationRepository();
  const app = createApp({ repository });

  await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ CallSid: 'CA999', From: '+15555550999' });

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
  const repository = new InMemoryConversationRepository();
  const conversation = await repository.createIfAbsent({
    provider: 'twilio',
    providerCallId: 'CAEARLY',
    callerPhone: '+15550000000',
    status: 'received',
    startedAt: new Date(),
  });
  await repository.appendEvent(
    conversation.conversation.id,
    'call.received',
    { CallSid: 'CAEARLY', From: '+15550000000' },
    new Date(),
  );

  const app = createApp({ repository });
  const response = await request(app)
    .post('/webhooks/twilio/status')
    .type('form')
    .send({ CallSid: 'CAEARLY', CallStatus: 'completed', CallDuration: '4' });

  assert.equal(response.status, 409);
});

test('malformed webhook payloads are rejected', async () => {
  const repository = new InMemoryConversationRepository();
  const app = createApp({ repository });

  const response = await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ From: '+15555550123' });

  assert.equal(response.status, 400);
});

test('provider failure does not corrupt conversation state', async () => {
  const repository = new InMemoryConversationRepository();
  const app = createApp({
    repository,
    providers: [new ThrowingTwilioProvider()],
    includeFakeProviderRoutes: false,
  });

  const response = await request(app)
    .post('/webhooks/twilio/voice')
    .type('form')
    .send({ CallSid: 'CAFAIL', From: '+15555550123' });

  assert.equal(response.status, 500);

  const listResponse = await request(app).get('/conversations');
  assert.equal(listResponse.body.length, 1);
  assert.equal(listResponse.body[0].status, 'received');

  const detailsResponse = await request(app).get(
    `/conversations/${listResponse.body[0].id}`,
  );
  assert.deepEqual(detailsResponse.body.events, ['call.received']);
});

test('fake provider exercises the same lifecycle', async () => {
  const repository = new InMemoryConversationRepository();
  const app = createApp({ repository });

  const voiceResponse = await request(app)
    .post('/webhooks/fake/voice')
    .send({ callId: 'fake-1', callerPhone: '+15555550123' });
  assert.equal(voiceResponse.status, 200);
  assert.match(voiceResponse.text, /<Response>/);

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
