import assert from 'node:assert/strict';
import test from 'node:test';

import { MacOSMessagesBridge } from '../src/owner/bridge.js';
import { FakeMacMessagesAdapter } from '../src/owner/fake-mac-messages-adapter.js';
import { MacOSMessagesOwnerChannel } from '../src/owner/macos-messages-channel.js';
import type { OwnerBridgeCheckpointStore } from '../src/owner/bridge.js';
import { OwnerDeviceService } from '../src/owner/device.js';
import { OwnerConfigurationService } from '../src/owner/configuration.js';

test('macOS owner channel sends only the requested owner delivery', async () => {
  const adapter = new FakeMacMessagesAdapter();
  const channel = new MacOSMessagesOwnerChannel(adapter, (accountId) => `address:${accountId}`);

  const result = await channel.sendMessage({
    accountId: 'randy',
    conversationId: 'conversation-1',
    messageId: 'message-1',
    body: 'John called about Friday.',
  });

  assert.equal(channel.type, 'macos_messages');
  assert.equal(result.deliveryId, 'owner-delivery:message-1');
  assert.deepEqual(adapter.sent, [{
    recipient: 'address:randy',
    body: 'John called about Friday.',
  }]);
});

test('macOS bridge filters chats and deduplicates observed owner replies', async () => {
  const adapter = new FakeMacMessagesAdapter();
  let cursor: string | undefined;
  const checkpoint: OwnerBridgeCheckpointStore = {
    async load() { return cursor; },
    async save(value) { cursor = value; },
  };
  const received: string[] = [];
  const confirmed: string[] = [];
  const bridge = new MacOSMessagesBridge(adapter, {
    async submitOwnerMessage(input) {
      received.push(`${input.chatId}:${input.externalId}:${input.body}`);
    },
    async confirmOwnerDelivery(input) {
      confirmed.push(`${input.deliveryId}:${input.externalId}`);
    },
  }, {
    accountId: 'randy',
    deviceId: 'device-1',
    assistantChatId: 'assistant-chat',
    ownerSender: 'randy',
    checkpoint,
  });

  await bridge.start();
  const sendResult = await adapter.send({ recipient: 'assistant-chat', body: 'John called about Friday.' });
  bridge.trackDelivery('delivery-1', sendResult.providerRequestId);
  await adapter.observe({
    chatId: 'assistant-chat',
    sender: 'assistant',
    body: 'John called about Friday.',
    direction: 'outgoing',
    externalId: sendResult.providerRequestId,
    cursor: '0',
  });
  await adapter.observe({
    chatId: 'personal-chat',
    sender: 'randy',
    body: 'ignore',
    direction: 'incoming',
  });
  await adapter.observe({
    chatId: 'assistant-chat',
    sender: 'someone-else',
    body: 'ignore',
    direction: 'incoming',
  });
  await adapter.observe({
    chatId: 'assistant-chat',
    sender: 'randy',
    body: 'Friday at 2 works.',
    direction: 'incoming',
    externalId: 'message-1',
    replyToExternalId: sendResult.providerRequestId,
    cursor: '3',
  });
  await adapter.observe({
    chatId: 'assistant-chat',
    sender: 'randy',
    body: 'Friday at 2 works.',
    direction: 'incoming',
    externalId: 'message-1',
    cursor: '4',
  });

  assert.deepEqual(received, ['assistant-chat:message-1:Friday at 2 works.']);
  assert.deepEqual(confirmed, [`delivery-1:${sendResult.providerRequestId}`]);
  assert.equal(cursor, '3');
  await bridge.stop();
});

test('owner device pairing creates a short-lived session and revocation removes it', async () => {
  let now = 1_000;
  const service = new OwnerDeviceService(undefined, () => now);
  const pairing = await service.pair('randy', 'Randy Mac');
  const activated = await service.activate(pairing.device.id, pairing.pairingCode);

  assert.equal(activated.device.status, 'active');
  assert.equal((await service.authenticate(activated.sessionToken))?.accountId, 'randy');
  await service.revoke('randy', pairing.device.id);
  assert.equal(await service.authenticate(activated.sessionToken), null);

  const expired = await service.pair('randy', 'Another Mac');
  now += 10 * 60 * 1000 + 1;
  await assert.rejects(
    service.activate(expired.device.id, expired.pairingCode),
    /Invalid or expired pairing code/,
  );
});

test('QR pairing is opaque, single-use, and device readiness requires explicit chat authorization', async () => {
  const adapter = new FakeMacMessagesAdapter();
  adapter.chats = [{ id: 'assistant-chat', service: 'imessage', displayName: 'Assistant', address: 'assistant@example.test' }];
  const service = new OwnerDeviceService();
  const pairing = await service.pair('randy', 'MacBook');
  assert.match(pairing.pairingUri, /^attn:\/\/pair\/[^/]+$/);
  assert.equal(pairing.pairingUri.includes('randy'), false);
  const activated = await service.activate(pairing.device.id, pairing.pairingUri);
  assert.equal(activated.device.setupStatus, 'paired');
  await assert.rejects(service.activate(pairing.device.id, pairing.pairingUri));

  await service.heartbeat(activated.sessionToken, await adapter.checkCapabilities());
  assert.equal((await service.get(pairing.device.id))?.setupStatus, 'awaiting_chat_authorization');
  await service.discoverChats(activated.sessionToken, adapter);
  await service.authorizeChat('randy', pairing.device.id, 'assistant-chat', 'imessage');
  const ready = await service.heartbeat(activated.sessionToken, await adapter.checkCapabilities());
  assert.equal(ready.setupStatus, 'ready');
});


test('owner configuration update surfaces optimistic concurrency conflicts', async () => {
  class ConflictStore {
    private configuration = {
      accountId: 'randy',
      revision: 1,
      assistant: {
        assistantName: 'Assistant',
        greeting: "Hi, this is Randy's assistant. How can I help?",
        ownerIntroduction: "Randy prefers text. I'll make sure he gets your message.",
        tone: 'friendly' as const,
        responseStyle: 'concise' as const,
      },
      calls: {
        answerCalls: true,
        collectCallerName: true,
        collectReason: true,
        offerSmsTransition: true,
        requireSmsConsent: true,
        voicemailFallback: false,
      },
      messages: {
        webEnabled: true,
        macosMessagesEnabled: true,
        notifyOwner: true,
        interruptOnlyWhenNeeded: true,
        includeSummary: true,
        includeSuggestedResponse: true,
      },
    };
    async get() { return structuredClone(this.configuration); }
    async create() {}
    async update(_configuration: any, previousRevision: number) {
      this.configuration.revision = 2;
      if (previousRevision !== this.configuration.revision) throw new Error('Owner configuration update conflict');
    }
    async events() { return []; }
  }

  const service = new OwnerConfigurationService(new ConflictStore() as never);
  await assert.rejects(
    service.update('randy', { messages: { macosMessagesEnabled: false } }),
    /Owner configuration update conflict/,
  );
});

test('owner configuration is typed, revisioned, and channel toggles are durable', async () => {
  const service = new OwnerConfigurationService();
  const initial = await service.get('randy');
  assert.equal(initial.messages.macosMessagesEnabled, true);
  const updated = await service.update('randy', { messages: { macosMessagesEnabled: false } });
  assert.equal(updated.revision, initial.revision + 1);
  assert.equal(await service.isChannelEnabled('randy', 'macos_messages'), false);
  assert.equal((await service.get('other')).messages.macosMessagesEnabled, true);
  assert.equal((await service.events('randy')).at(-1)?.type, 'owner.channel.disabled');
});
