import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CalendarCapability,
  CalendarSelectionService,
  InMemoryCalendarSelectionStore,
  type CalendarProvider,
} from '../src/integrations/calendar.js';
import { IdentityService, InMemoryIdentityStore } from '../src/integrations/identity.js';
import { EntitlementService, type TransactionVerifier } from '../src/integrations/payments.js';

test('provider identities link to one canonical user and can be revoked', async () => {
  const service = new IdentityService(new InMemoryIdentityStore());
  const identity = await service.link('usr_1', { provider: 'apple', subject: 'apple-subject', email: 'relay@privaterelay.appleid.com' });

  assert.equal((await service.resolve({ provider: 'apple', subject: 'apple-subject' }))?.userId, 'usr_1');
  assert.equal(await service.revoke('usr_1', 'apple'), true);
  assert.equal(await service.resolve({ provider: 'apple', subject: 'apple-subject' }), null);
  assert.equal(identity.email, 'relay@privaterelay.appleid.com');
});

test('calendar writes fail closed when provider authorization is not writable', async () => {
  let writes = 0;
  const provider: CalendarProvider = {
    name: 'google',
    authorization: async () => 'read_only',
    listCalendars: async () => [],
    getAvailability: async () => [],
    listEvents: async () => [],
    createEvent: async (event) => { writes += 1; return { ...event, id: 'event_1' }; },
    updateEvent: async (event) => event,
    deleteEvent: async () => undefined,
  };

  await assert.rejects(
    new CalendarCapability(provider).createEvent({
      calendarId: 'calendar_1', startsAt: new Date(1), endsAt: new Date(2), title: 'Meeting',
    }),
    /read_only/,
  );
  assert.equal(writes, 0);
});

test('calendar selection is durable, explicit, and chooses an unambiguous write target', async () => {
  const selections = new CalendarSelectionService(new InMemoryCalendarSelectionStore(), () => 123);
  const saved = await selections.save('usr_1', 'google', [
    { id: 'personal', name: 'Personal', readOnly: false },
    { id: 'birthdays', name: 'Birthdays', readOnly: true },
  ], ['personal', 'birthdays']);
  assert.deepEqual(saved.calendarIds, ['personal', 'birthdays']);
  assert.equal(saved.writeCalendarId, 'personal');
  assert.equal((await selections.get('usr_1', 'google'))?.updatedAt.getTime(), 123);
  assert.equal(await selections.ready('usr_1', 'google'), true);
});

test('calendar authorization exposes a native recovery action', async () => {
  const provider: CalendarProvider = {
    name: 'apple',
    authorization: async () => 'unauthorized',
    listCalendars: async () => [],
    getAvailability: async () => [],
    listEvents: async () => [],
    createEvent: async (event) => ({ ...event, id: 'event_1' }),
    updateEvent: async (event) => event,
    deleteEvent: async () => undefined,
  };
  assert.deepEqual(await new CalendarCapability(provider).authorizationStatus(), {
    state: 'unauthorized',
    action: 'open_settings',
  });
});

test('entitlements are granted only from verified transactions', async () => {
  const verifier: TransactionVerifier = {
    async verify(transaction) {
      assert.deepEqual(transaction, { signedTransaction: 'valid' });
      return {
        transactionId: 'tx_1',
        userId: 'usr_1',
        productId: 'pro',
        state: 'active',
        verifiedAt: new Date(1),
        expiresAt: new Date(10_000),
      };
    },
  };
  const service = new EntitlementService(verifier);
  await service.applyTransaction({ signedTransaction: 'valid' });
  assert.equal(service.hasActiveEntitlement('usr_1', 'pro', 2), true);
  assert.equal(service.hasActiveEntitlement('usr_1', 'pro', 10_000), false);
});

test('verified billing retry and grace states retain access until authority changes them', async () => {
  const verifier: TransactionVerifier = {
    async verify(transaction) {
      return {
        transactionId: String(transaction),
        userId: 'usr_1',
        productId: 'pro',
        state: transaction === 'grace' ? 'grace_period' : 'billing_retry',
        verifiedAt: new Date(1),
        expiresAt: new Date(2),
      };
    },
  };
  const service = new EntitlementService(verifier);
  await service.applyTransaction('grace');
  assert.equal(service.hasActiveEntitlement('usr_1', 'pro', 10_000), true);
  await service.applyTransaction('retry');
  assert.equal(service.hasActiveEntitlement('usr_1', 'pro', 10_000), true);
});
