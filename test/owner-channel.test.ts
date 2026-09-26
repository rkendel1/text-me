import assert from 'node:assert/strict';
import test from 'node:test';

import { MacOSMessagesBridge } from '../src/owner/bridge.js';
import { FakeMacMessagesAdapter } from '../src/owner/fake-mac-messages-adapter.js';
import { MacOSMessagesOwnerChannel } from '../src/owner/macos-messages-channel.js';
import type { OwnerBridgeCheckpointStore } from '../src/owner/bridge.js';
import { OwnerDeviceService } from '../src/owner/device.js';

test('macOS owner channel sends only the requested owner delivery', async () => {
  const adapter = new FakeMacMessagesAdapter();
  const channel = new MacOSMessagesOwnerChannel(adapter, (ownerId) => `address:${ownerId}`);

  const result = await channel.sendMessage({
    ownerId: 'randy',
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
    ownerId: 'randy',
    deviceId: 'device-1',
    assistantChatId: 'assistant-chat',
    ownerSender: 'randy',
    checkpoint,
  });

  await bridge.start();
  bridge.trackDelivery('delivery-1', 'John called about Friday.');
  await adapter.observe({
    chatId: 'assistant-chat',
    sender: 'assistant',
    body: 'John called about Friday.',
    direction: 'outgoing',
    externalId: 'message-out',
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
  assert.deepEqual(confirmed, ['delivery-1:message-out']);
  assert.equal(cursor, '3');
  await bridge.stop();
});

test('owner device pairing creates a short-lived session and revocation removes it', async () => {
  let now = 1_000;
  const service = new OwnerDeviceService(undefined, () => now);
  const pairing = await service.pair('randy', 'Randy Mac');
  const activated = await service.activate(pairing.device.id, pairing.pairingCode);

  assert.equal(activated.device.status, 'active');
  assert.equal((await service.authenticate(activated.sessionToken))?.ownerId, 'randy');
  await service.revoke('randy', pairing.device.id);
  assert.equal(await service.authenticate(activated.sessionToken), null);

  const expired = await service.pair('randy', 'Another Mac');
  now += 10 * 60 * 1000 + 1;
  await assert.rejects(
    service.activate(expired.device.id, expired.pairingCode),
    /Invalid or expired pairing code/,
  );
});
