import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { appPortSessionFor } from '../src/appport/session.js';
import { CallCapabilityClient } from '../src/appport/call-client.js';
import { CallProviderRejectedError, CallProviderUnconfirmedError, FakeCallProvider } from '../src/calls/provider.js';
import { normalizeDialableNumber } from '../src/calls/phone.js';
import { InMemoryCallSessionStore, type CallSessionStore } from '../src/calls/store.js';
import { claimOutboundDial } from '../src/calls/transition.js';
import { TwilioCallProvider, type TwilioCallsClient } from '../src/telephony/twilio-call-provider.js';
import { PostgresCallSessionStore } from '../src/repositories/postgres-call-session-repository.js';
import { createCallStack, LINE_A, LINE_B, providerEvent, tenant, type CallStack } from './support/calls.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
let counter = 0;
/** A destination nobody else in a shared test database is calling. */
const freshNumber = () => `+1555${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
const uniq = (label: string) => `${label}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const rejectsWith = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
const denied = (reason: string) => (error: unknown) => (error as { code?: string; details?: { reason?: string } }).code === 'FORBIDDEN' && (error as { details?: { reason?: string } }).details?.reason === reason;
const callIdOf = (url: string) => new URL(url).searchParams.get('callId')!;
async function eventually(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

// ---------- Destination validation ----------

test('destinations are validated and normalised, never reinterpreted', () => {
  assert.equal(normalizeDialableNumber('+15551234567'), '+15551234567');
  assert.equal(normalizeDialableNumber('  +1 (555) 123-4567 '), '+15551234567', 'presentation is stripped');
  assert.equal(normalizeDialableNumber('+44 20 7183 8750'), '+442071838750', 'international');
  assert.equal(normalizeDialableNumber('+33.1.42.68.53.00'), '+33142685300');
  // Nothing is guessed into a different destination.
  for (const bad of ['15551234567', '5551234567', '555-123-4567', 'abc', '+abc', '+0123456789', '+1555', '+1555123456789012', '', '   ', '+1 555 123 4567 ext 9', '+1555123456x', '911', '+', null, undefined, 15551234567, {}]) {
    assert.equal(normalizeDialableNumber(bad), null, `${String(bad)} must be refused`);
  }
});

// ---------- Domain: outbound creation and execution ----------

test('call.create places the call: one provider request, built from our configuration, returning before anyone answers', async () => {
  const stack = createCallStack();
  const started = Date.now();
  const created = await stack.adminA.create({ direction: 'outbound', to: '+1 (555) 123-0000', objective: '  Confirm   Thursday\n appointment  ' }, { idempotencyKey: uniq('k'), traceId: 'trace-place-1' });
  assert.ok(Date.now() - started < 1000, 'asynchronous: it does not wait for the phone to ring, let alone be answered');
  assert.equal(created.status, 'initiating');
  assert.equal(stack.provider.attempts, 1);

  const request = stack.provider.created[0];
  assert.deepEqual({ from: request.from, to: request.to }, { from: LINE_A, to: '+15551230000' }, 'an owned caller id; the destination in E.164');
  const callId = created.callId;
  assert.equal(request.answerUrl, `https://calls.example.test/webhooks/twilio/voice/outbound?callId=${callId}`);
  assert.equal(request.statusUrl, `https://calls.example.test/webhooks/twilio/status?callId=${callId}`);
  assert.equal(Object.keys(request).sort().join(), 'answerUrl,from,statusUrl,to', 'nothing else reaches the provider');

  const view = await stack.adminA.get({ callId });
  assert.equal(view.direction, 'outbound');
  assert.equal(view.execution, 'accepted');
  assert.equal(view.objective, 'Confirm Thursday appointment', 'one line of plain text');
  const record = (await stack.store.get('acct_a', callId))!;
  assert.ok(record.providerCallId && record.providerCallId !== callId, 'the provider id is recorded, and is not the domain id');
  assert.ok(record.dialClaimedAt && record.startedAt);
  assert.equal(record.traceId, 'trace-place-1');
});

test('the execution claim is durable and exclusive', async () => {
  const store = new InMemoryCallSessionStore();
  const stack = createCallStack({ store, outboundEnabled: true });
  const planned = await stack.calls.create({ accountId: 'acct_a' }, { direction: 'outbound', to: '+15551230000' });
  assert.equal(planned.status, 'created');
  assert.equal(stack.provider.attempts, 0, 'creating the record dials nothing');

  const claims = await Promise.all(Array.from({ length: 8 }, () => claimOutboundDial(store, planned.id)));
  assert.equal(claims.filter((claim) => claim.claimed).length, 1, 'exactly one claimant');
  assert.equal(claims.filter((claim) => claim.outcome === 'already_claimed').length, 7);
  const claimed = (await store.get('acct_a', planned.id))!;
  assert.equal(claimed.status, 'initiating');
  assert.equal(claimed.dialOutcome, 'pending');
  assert.ok(claimed.dialClaimedAt);
  // Nothing claims it again, whatever state it is in.
  assert.equal((await claimOutboundDial(store, planned.id)).claimed, false);
  // Inbound calls, calls that already have a provider call, and unknown calls are not claimable.
  const inbound = await stack.calls.create({ accountId: 'acct_a', canIngest: true }, { direction: 'inbound', providerCallId: uniq('CA') });
  assert.equal((await claimOutboundDial(store, inbound.id)).outcome, 'not_claimable');
  assert.equal((await claimOutboundDial(store, 'call_missing')).outcome, 'not_found');
});

test('one logical request produces at most one provider call: retries and concurrent requests on one instance', async () => {
  const stack = createCallStack();
  stack.provider.createDelayMs = 30;
  const key = uniq('once');
  const input = { direction: 'outbound' as const, to: '+15551230000' };
  const results = await Promise.all(Array.from({ length: 10 }, () => stack.adminA.create(input, { idempotencyKey: key })));
  assert.equal(new Set(results.map((result) => result.callId)).size, 1, 'one call');
  assert.equal(stack.provider.attempts, 1, 'one provider request');
  assert.equal((await stack.adminA.list()).items.length, 1);

  // Later retries: the call is initiating (or further along), so nobody dials.
  for (let attempt = 0; attempt < 3; attempt += 1) await stack.adminA.create(input, { idempotencyKey: key });
  assert.equal(stack.provider.attempts, 1);
  // Even after it ended, the same request is the same call, not a new one.
  await stack.calls.transition(results[0].callId, 'answered');
  await stack.adminA.end({ callId: results[0].callId });
  await stack.calls.applyProviderEvent(providerEvent((await stack.calls.get('acct_a', results[0].callId)).providerCallId!, 'completed', 'completed'));
  const again = await stack.adminA.create(input, { idempotencyKey: key });
  assert.equal(again.callId, results[0].callId);
  assert.equal(again.status, 'completed');
  assert.equal(stack.provider.attempts, 1);
  // A second call needs a second, different request identity.
  const second = await stack.adminA.create({ direction: 'outbound', to: '+15551239999' }, { idempotencyKey: uniq('other') });
  assert.notEqual(second.callId, results[0].callId);
  assert.equal(stack.provider.attempts, 2);
});

test('a retry that finds the call created but never claimed (a crash after insert) completes it, once', async () => {
  // The first attempt dies after the durable insert and before the claim.
  class CrashesOnFirstClaim extends InMemoryCallSessionStore {
    crashed = false;
    override async mutate(...args: Parameters<InMemoryCallSessionStore['mutate']>) {
      if (!this.crashed) {
        this.crashed = true;
        throw new Error('process died');
      }
      return super.mutate(...args);
    }
  }
  const store = new CrashesOnFirstClaim();
  const stack = createCallStack({ store });
  const key = uniq('crash');
  const input = { direction: 'outbound' as const, to: '+15551230000' };
  await assert.rejects(stack.adminA.create(input, { idempotencyKey: key }));
  assert.equal(stack.provider.attempts, 0);
  const orphan = (await store.list('acct_a', { limit: 10 }))[0];
  assert.equal(orphan.status, 'created', 'the record survived, unclaimed');

  const first = await stack.adminA.create(input, { idempotencyKey: key });
  const second = await stack.adminA.create(input, { idempotencyKey: key });
  assert.equal(first.callId, orphan.id);
  assert.equal(second.callId, orphan.id);
  assert.equal(first.status, 'initiating');
  assert.equal(stack.provider.attempts, 1);
});

// ---------- Policy and security: Twilio is never contacted ----------

test('the outbound policy runs first and Twilio is never contacted when it says no', async () => {
  const stack = createCallStack();
  const place = (input: Record<string, unknown>, meta: { idempotencyKey?: string } = { idempotencyKey: uniq('p') }) =>
    stack.adminA.create({ direction: 'outbound', to: '+15551230000', ...input } as Parameters<typeof stack.adminA.create>[0], meta);

  await assert.rejects(place({ from: LINE_B }), denied('caller_id_not_owned'), 'another tenant\'s number as caller id');
  await assert.rejects(place({ from: '+19995550000' }), denied('caller_id_not_owned'), 'an arbitrary number as caller id');
  await assert.rejects(place({ from: '+1 (999) 555-0000' }), denied('caller_id_not_owned'), 'the same, however it is written');
  await assert.rejects(place({ from: 'not a number' }), rejectsWith('INVALID_INPUT'), 'a malformed caller id');
  await assert.rejects(place({ to: 'not a number' }), rejectsWith('INVALID_INPUT'));
  await assert.rejects(place({ to: '5551230000' }), rejectsWith('INVALID_INPUT'), 'no country: not guessed');
  await assert.rejects(place({ to: undefined }), rejectsWith('INVALID_INPUT'));
  await assert.rejects(place({ to: LINE_A }), denied('destination_is_own_line'));
  await assert.rejects(place({ objective: 'x'.repeat(501) }), rejectsWith('INVALID_INPUT'));
  await assert.rejects(place({}, {} as { idempotencyKey?: string }), rejectsWith('INVALID_INPUT'), 'no idempotency key');
  await assert.rejects(place({ providerCallId: 'CAforged' }), (error) => (error as { code?: string }).code === 'FORBIDDEN' || (error as { code?: string }).code === 'INVALID_INPUT', 'a provider call cannot be supplied');
  await assert.rejects(place({ conversationId: 'conv_x' }), (error) => ['FORBIDDEN', 'INVALID_INPUT'].includes((error as { code?: string }).code!));
  assert.equal(stack.provider.attempts, 0, 'Twilio was never called');
  assert.equal((await stack.adminA.list()).items.length, 0, 'and nothing was recorded for a refused call');

  // Naming the account's own line is fine, and so is leaving it out.
  assert.equal((await place({ from: LINE_A })).status, 'initiating');
  assert.equal(stack.provider.created[0].from, LINE_A);
});

test('with outbound agent calling off (the default) call.create refuses before anything is created or dialed', async () => {
  const stack = createCallStack({ outboundEnabled: false });
  const error = await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: uniq('off') }).catch((caught) => caught);
  assert.equal(error.code, 'FORBIDDEN');
  assert.equal(error.details?.reason, 'outbound_disabled');
  assert.equal(stack.provider.attempts, 0);
  assert.equal((await stack.adminA.list()).items.length, 0);
  const logged = stack.logs.filter((entry) => entry.event.startsWith('call.outbound.'));
  assert.deepEqual(logged.map((entry) => entry.event), ['call.outbound.requested', 'call.outbound.denied']);
  assert.equal(logged[1].fields.reason, 'outbound_disabled', 'deterministic and observable');

  // Inbound is unaffected by the switch.
  assert.equal((await stack.telephonyA.create({ direction: 'inbound', providerCallId: uniq('CA'), to: LINE_A })).status, 'ringing');
  // And a deployment that never configures a policy allows nothing at all.
  const { CallSessionService } = await import('../src/calls/service.js');
  const bare = new CallSessionService(new InMemoryCallSessionStore(), { provider: stack.provider });
  await assert.rejects(bare.placeOutbound({ accountId: 'acct_a', idempotencyKey: 'k' }, { direction: 'outbound', to: '+15551230000' }, { origin: 'agent' }), (caught) => (caught as { reason?: string }).reason === 'outbound_disabled');
  assert.equal(stack.provider.attempts, 0);
});

test('an account with no assistant line cannot place a call; a call to a destination already being called is refused', async () => {
  const stack = createCallStack();
  const nobody = new CallCapabilityClient(stack.application, appPortSessionFor(tenant('acct_none', 'admin')));
  await assert.rejects(nobody.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: uniq('n') }), denied('no_caller_id'));
  assert.equal(stack.provider.attempts, 0);

  const first = await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: uniq('d1') });
  await assert.rejects(stack.adminA.create({ direction: 'outbound', to: '+1 555 123 0000' }, { idempotencyKey: uniq('d2') }), denied('duplicate_destination'));
  assert.equal(stack.provider.attempts, 1);
  // Another account may call the same number; and once the first call ended this account may again.
  assert.equal((await stack.adminB.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: uniq('d3') })).status, 'initiating');
  await stack.adminA.end({ callId: first.callId });
  await stack.calls.applyProviderEvent(providerEvent((await stack.calls.get('acct_a', first.callId)).providerCallId!, 'completed', 'completed'));
  assert.equal((await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: uniq('d4') })).status, 'initiating');
});

test('the objective describes the goal: it is validated plain text, stored as a domain field, and part of the request identity', async () => {
  const stack = createCallStack();
  const key = uniq('obj');
  const a = await stack.adminA.create({ direction: 'outbound', to: '+15551230000', objective: 'Reschedule the appointment' }, { idempotencyKey: key });
  assert.equal((await stack.store.get('acct_a', a.callId))!.objective, 'Reschedule the appointment');
  await assert.rejects(stack.adminA.create({ direction: 'outbound', to: '+15551230000', objective: 'Something else entirely' }, { idempotencyKey: key }), rejectsWith('CONFLICT'));
  assert.equal(stack.provider.attempts, 1);
  // The provider is given no objective, prompt or instruction of any kind.
  assert.ok(!JSON.stringify(stack.provider.created).includes('Reschedule'));
});

test('a concurrent twin of the same request is a replay, never refused as a duplicate destination', async () => {
  // The twin is recorded (and dialed) in the gap between this request's replay check and its policy decision.
  let interleaved = false;
  const stack = createCallStack({
    wrapPolicy: (inner, service) => ({
      async evaluate(request) {
        if (!interleaved) {
          interleaved = true;
          await service().placeOutbound({ accountId: 'acct_a', principalId: 'twin', idempotencyKey: 'twin-key' }, { direction: 'outbound', to: request.to }, { origin: 'agent' });
        }
        return inner.evaluate(request);
      },
    }),
  });
  const result = await stack.calls.placeOutbound({ accountId: 'acct_a', principalId: 'u', idempotencyKey: 'twin-key' }, { direction: 'outbound', to: '+15551230000' }, { origin: 'agent' });
  assert.equal(result.status, 'initiating');
  assert.equal(stack.provider.attempts, 1, 'one request, one call');
  assert.equal((await stack.store.list('acct_a', { limit: 10 })).length, 1);
  // A genuinely different request to the same number is still refused.
  await assert.rejects(stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: 'a-different-request' }), denied('duplicate_destination'));
});

// ---------- Provider failure model ----------

test('the provider refuses: the call fails, no provider id is invented, and nothing retries it', async () => {
  const stack = createCallStack();
  stack.provider.failCreate = new CallProviderRejectedError('The \'To\' number +15551230000 is not a valid phone number.', 21211);
  const key = uniq('rej');
  const created = await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key });
  assert.equal(created.status, 'failed', 'the caller sees the failure; call.get explains it');
  const view = await stack.adminA.get({ callId: created.callId });
  assert.equal(view.status, 'failed');
  assert.equal(view.execution, 'rejected');
  assert.equal(view.endReason, 'provider_rejected');
  const record = (await stack.store.get('acct_a', created.callId))!;
  assert.equal(record.providerCallId, null);
  assert.ok(record.endedAt);

  // The same request again is the same failed call: no automatic or accidental second attempt.
  stack.provider.failCreate = undefined;
  const retry = await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key });
  assert.equal(retry.callId, created.callId);
  assert.equal(retry.status, 'failed');
  assert.equal(stack.provider.attempts, 1);
  assert.equal(stack.provider.created.length, 0);
  // Only a new request identity is a new call.
  assert.equal((await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: uniq('new') })).status, 'initiating');
  // The provider's message repeats the number it was given; the log must not.
  const failed = stack.logs.find((entry) => entry.event === 'call.outbound.failed')!;
  assert.equal(failed.fields.unconfirmed, false);
  assert.ok(!JSON.stringify(stack.logs).includes('+15551230000'));
});

test('the outcome is unknown: the call stays observable as initiating, is never failed or redialed, and converges when the provider speaks', async () => {
  const stack = createCallStack();
  stack.provider.loseResponse = true; // Twilio created the call; its response never arrived.
  const key = uniq('lost');
  const created = await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key });
  assert.equal(created.status, 'initiating', 'not failed: the call may exist');
  const before = await stack.adminA.get({ callId: created.callId });
  assert.equal(before.execution, 'unconfirmed');
  assert.equal((await stack.store.get('acct_a', created.callId))!.providerCallId, null);

  // A retry must not dial again, however many times it comes.
  for (let attempt = 0; attempt < 3; attempt += 1) await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key });
  assert.equal(stack.provider.attempts, 1);

  // The call did exist. Its first callback carries our callId: the provider id is attached and the call converges.
  const sid = 'CAlost0000000000000000000000000001';
  assert.ok(await stack.calls.adoptDialedCall(created.callId, sid));
  assert.equal((await stack.calls.applyProviderEvent(providerEvent(sid, 'ringing', 'ringing'))).outcome, 'applied');
  assert.equal((await stack.calls.applyProviderEvent(providerEvent(sid, 'in-progress', 'answered'))).outcome, 'applied');
  const after = await stack.adminA.get({ callId: created.callId });
  assert.equal(after.status, 'answered');
  assert.equal(after.execution, 'accepted');
  assert.equal(stack.provider.attempts, 1);
  const failed = stack.logs.filter((entry) => entry.event === 'call.outbound.failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].fields.unconfirmed, true);
});

test('any other provider failure is also unconfirmed, never assumed to mean "no call"', async () => {
  const stack = createCallStack();
  stack.provider.failCreate = new CallProviderUnconfirmedError('socket hang up');
  const one = await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: uniq('u1') });
  assert.equal(one.status, 'initiating');
  stack.provider.failCreate = new Error('something unexpected');
  const two = await stack.adminA.create({ direction: 'outbound', to: '+15551230001' }, { idempotencyKey: uniq('u2') });
  assert.equal(two.status, 'initiating');
  assert.equal((await stack.adminA.get({ callId: two.callId })).execution, 'unconfirmed');
});

test('a provider that is too slow is treated as unknown, and if its answer lands later it is still recorded', async () => {
  const stack = createCallStack({ dialTimeoutMs: 30 });
  stack.provider.createDelayMs = 150;
  const created = await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: uniq('slow') });
  assert.equal(created.status, 'initiating');
  assert.equal((await stack.adminA.get({ callId: created.callId })).execution, 'unconfirmed');
  await eventually(async () => (await stack.store.get('acct_a', created.callId))!.providerCallId !== null, 'the late response to be recorded');
  assert.equal((await stack.adminA.get({ callId: created.callId })).execution, 'accepted');
  assert.equal(stack.provider.attempts, 1);
});

test('unconfirmed dials that never resolve are closed by reconciliation, and a stray answer meets a dead session', async () => {
  let clock = Date.parse('2026-06-01T12:00:00Z');
  const stack = createCallStack({ now: () => new Date(clock) });
  stack.provider.loseResponse = true;
  const lost = await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: uniq('rec1') });
  stack.provider.loseResponse = false;
  const fine = await stack.adminA.create({ direction: 'outbound', to: '+15551230001' }, { idempotencyKey: uniq('rec2') });

  clock += 60_000;
  assert.equal(await stack.calls.reconcileUnconfirmedDials({ olderThanMs: 10 * 60_000 }), 0, 'not yet stale');
  clock += 15 * 60_000;
  assert.equal(await stack.calls.reconcileUnconfirmedDials({ olderThanMs: 10 * 60_000 }), 1, 'only the call that never got a provider id');
  assert.equal(await stack.calls.reconcileUnconfirmedDials({ olderThanMs: 10 * 60_000 }), 0, 'repeatable');
  const closed = await stack.adminA.get({ callId: lost.callId });
  assert.equal(closed.status, 'failed');
  assert.equal(closed.endReason, 'dial_unconfirmed');
  assert.equal((await stack.adminA.get({ callId: fine.callId })).status, 'initiating');
  // If the call did exist after all, its late id is recorded but it is cancelled rather than allowed to ring.
  await stack.calls.adoptDialedCall(lost.callId, 'CAstray0000000000000000000000000001');
  assert.equal((await stack.calls.get('acct_a', lost.callId)).status, 'failed');
});

// ---------- Callback races, in every ordering ----------

test('callbacks that arrive before our own request returns still converge (and never regress the call)', async () => {
  const stack = createCallStack();
  // While Twilio's response is in flight, Twilio has already called back twice, carrying our callId.
  stack.provider.duringCreate = async (sid, input) => {
    const callId = callIdOf(input.statusUrl!);
    assert.ok(await stack.calls.adoptDialedCall(callId, sid));
    assert.equal((await stack.calls.applyProviderEvent(providerEvent(sid, 'ringing', 'ringing'))).outcome, 'applied');
    assert.equal((await stack.calls.applyProviderEvent(providerEvent(sid, 'in-progress', 'answered'))).outcome, 'applied');
  };
  const created = await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: uniq('race1') });
  assert.equal(created.status, 'answered', 'the response arriving late does not drag the call back to initiating');
  const record = (await stack.store.get('acct_a', created.callId))!;
  assert.equal(record.status, 'answered');
  assert.equal(record.dialOutcome, 'accepted');
  assert.ok(record.providerCallId);
  assert.equal(stack.provider.attempts, 1);
});

test('callbacks that arrive after our request returns apply normally; a duplicate is harmless', async () => {
  const stack = createCallStack();
  const created = await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: uniq('race2') });
  const sid = (await stack.store.get('acct_a', created.callId))!.providerCallId!;
  for (const [raw, status] of [['ringing', 'ringing'], ['in-progress', 'answered']] as const) {
    assert.equal((await stack.calls.applyProviderEvent(providerEvent(sid, raw, status))).outcome, 'applied');
    assert.equal((await stack.calls.applyProviderEvent(providerEvent(sid, raw, status))).outcome, 'duplicate');
  }
  // In the wrong order: ringing is stale once answered.
  assert.equal((await stack.calls.applyProviderEvent(providerEvent(sid, 'ringing', 'ringing', { sequence: '9' }))).outcome, 'stale');
  assert.equal((await stack.adminA.get({ callId: created.callId })).status, 'answered');
});

test('the call is ended (or failed) while the provider request is in flight: the call that gets created anyway is cancelled', async () => {
  const stack = createCallStack();
  stack.provider.duringCreate = async (_sid, input) => {
    await stack.calls.end({ accountId: 'acct_a' }, callIdOf(input.answerUrl!), { reason: 'changed my mind' });
  };
  const created = await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: uniq('race3') });
  assert.equal(created.status, 'canceled');
  const sid = (await stack.store.get('acct_a', created.callId))!.providerCallId;
  assert.ok(sid, 'the id is still recorded');
  assert.deepEqual(stack.provider.ended, [{ providerCallId: sid!, mode: 'cancel' }], 'and the phone is not left to ring');
});

// ---------- call.end across the outbound lifecycle ----------

test('call.end works in every live state of an outbound call, once, and never after it is over', async () => {
  for (const state of ['initiating', 'ringing', 'answered', 'in_progress'] as const) {
    const stack = createCallStack();
    const { callId } = await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: uniq(`end-${state}`) });
    if (state !== 'initiating') await stack.calls.transition(callId, 'ringing');
    if (state === 'answered' || state === 'in_progress') await stack.calls.transition(callId, 'answered');
    if (state === 'in_progress') await stack.calls.transition(callId, 'in_progress');
    const sid = (await stack.store.get('acct_a', callId))!.providerCallId!;

    const ended = await Promise.all([stack.adminA.end({ callId }), stack.adminA.end({ callId }), stack.adminA.end({ callId })]);
    assert.ok(ended.every((view) => view.status === 'ending'), state);
    const mode = state === 'answered' || state === 'in_progress' ? 'complete' : 'cancel';
    assert.deepEqual(stack.provider.ended, [{ providerCallId: sid, mode }], `${state}: one provider operation for three concurrent ends`);

    await stack.calls.applyProviderEvent(providerEvent(sid, mode === 'cancel' ? 'canceled' : 'completed', mode === 'cancel' ? 'canceled' : 'completed'));
    const final = await stack.adminA.end({ callId });
    assert.ok(['completed', 'canceled'].includes(final.status));
    assert.equal(stack.provider.ended.length, 1, `${state}: a terminal call produces no second hang-up`);
  }
  // A call that already completed on its own.
  const stack = createCallStack();
  const { callId } = await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: uniq('end-done') });
  const sid = (await stack.store.get('acct_a', callId))!.providerCallId!;
  await stack.calls.applyProviderEvent(providerEvent(sid, 'completed', 'completed'));
  assert.equal((await stack.adminA.end({ callId })).status, 'completed');
  assert.deepEqual(stack.provider.ended, []);
});

test('unanswered outcomes close an outbound call: no answer, busy, failed', async () => {
  for (const [raw, status] of [['no-answer', 'no_answer'], ['busy', 'busy'], ['failed', 'failed']] as const) {
    const stack = createCallStack();
    const { callId } = await stack.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: uniq(raw) });
    const sid = (await stack.store.get('acct_a', callId))!.providerCallId!;
    await stack.calls.applyProviderEvent(providerEvent(sid, 'ringing', 'ringing'));
    assert.equal((await stack.calls.applyProviderEvent(providerEvent(sid, raw, status))).outcome, 'applied');
    assert.equal((await stack.adminA.get({ callId })).status, status);
    assert.equal((await stack.calls.applyProviderEvent(providerEvent(sid, raw, status))).outcome, 'duplicate');
    // Nothing is retried, and the phone is not asked to ring again.
    assert.equal(stack.provider.attempts, 1);
  }
});

// ---------- Observability ----------

test('each step emits a structured event correlated by callId, providerCallId and traceId, with numbers masked', async () => {
  const stack = createCallStack();
  const created = await stack.adminA.create({ direction: 'outbound', to: '+15551234567', objective: 'Confirm the appointment' }, { idempotencyKey: uniq('obs'), traceId: 'trace-obs-1' });
  const events = stack.logs.filter((entry) => entry.event.startsWith('call.outbound.'));
  assert.deepEqual(events.map((entry) => entry.event), ['call.outbound.requested', 'call.outbound.allowed', 'call.outbound.initiating', 'call.outbound.provider_created']);
  for (const entry of events) assert.equal(entry.fields.traceId, 'trace-obs-1');
  const sid = (await stack.store.get('acct_a', created.callId))!.providerCallId;
  for (const entry of events.slice(2)) assert.equal(entry.fields.callId, created.callId);
  assert.equal(events[3].fields.providerCallId, sid);

  const serialized = JSON.stringify(stack.logs);
  assert.ok(!serialized.includes('+15551234567') && !serialized.includes(LINE_A), 'no full phone numbers');
  assert.ok(!serialized.includes('Confirm the appointment'), 'no call content or customer detail');
  assert.ok(!/token|secret|password|authorization/i.test(serialized.replace(/"event":"[^"]*"/g, '')), 'no credentials');

  stack.provider.failCreate = new CallProviderRejectedError('rejected for +15557654321 with token abc123', 21215);
  await stack.adminA.create({ direction: 'outbound', to: '+15557654321' }, { idempotencyKey: uniq('obs2'), traceId: 'trace-obs-2' });
  const failed = stack.logs.find((entry) => entry.event === 'call.outbound.failed')!;
  assert.equal(failed.fields.traceId, 'trace-obs-2');
  assert.ok(failed.fields.callId);
  assert.ok(!JSON.stringify(failed).includes('+15557654321'), 'a provider message that repeats the number is masked');
});

// ---------- The Twilio adapter itself ----------

function stubTwilio(behavior: { create?: (params: Record<string, unknown>) => Promise<{ sid: string }>; update?: (sid: string, params: Record<string, unknown>) => Promise<unknown> }) {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<{ sid: string; params: Record<string, unknown> }> = [];
  const calls = Object.assign(
    (sid: string) => ({ update: async (params: Record<string, unknown>) => { updated.push({ sid, params }); return behavior.update?.(sid, params); } }),
    { create: async (params: Record<string, unknown>) => { created.push(params); return behavior.create ? behavior.create(params) : { sid: 'CAstub000000000000000000000000001' }; } },
  );
  return { client: { calls } as unknown as TwilioCallsClient, created, updated };
}

test('TwilioCallProvider: what it sends, what it returns, and how it classifies failure', async () => {
  const ok = stubTwilio({});
  const provider = new TwilioCallProvider('ACtest', 'secret-token', { client: ok.client });
  assert.deepEqual(await provider.createCall({ from: LINE_A, to: '+15551230000', answerUrl: 'https://x.test/a?callId=c', statusUrl: 'https://x.test/s?callId=c' }), { providerCallId: 'CAstub000000000000000000000000001' });
  assert.deepEqual(ok.created, [{
    from: LINE_A, to: '+15551230000', url: 'https://x.test/a?callId=c', method: 'POST',
    statusCallback: 'https://x.test/s?callId=c', statusCallbackMethod: 'POST', statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
  }], 'no other Twilio parameter is ever sent (no machine detection, recording, caller name…)');
  await provider.createCall({ from: LINE_A, to: '+15551230000', inlineInstructions: '<Response/>' });
  assert.equal(ok.created[1].twiml, '<Response/>');
  assert.ok(!('url' in ok.created[1]));

  // A 4xx from Twilio is a refusal: no call exists.
  const refusing = new TwilioCallProvider('ACtest', 'secret-token', { client: stubTwilio({ create: async () => { throw Object.assign(new Error('Invalid \'To\' number'), { status: 400, code: 21211 }); } }).client });
  await assert.rejects(refusing.createCall({ from: LINE_A, to: '+15551230000', answerUrl: 'https://x.test/a' }), (error) => error instanceof CallProviderRejectedError && error.code === 21211);
  const limited = new TwilioCallProvider('ACtest', 'secret-token', { client: stubTwilio({ create: async () => { throw Object.assign(new Error('Too many requests'), { status: 429, code: 20429 }); } }).client });
  await assert.rejects(limited.createCall({ from: LINE_A, to: '+15551230000', answerUrl: 'https://x.test/a' }), CallProviderRejectedError);
  // Everything else says nothing about whether a call exists.
  for (const failure of [Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' }), Object.assign(new Error('Service unavailable'), { status: 503 }), Object.assign(new Error('Request Timeout'), { status: 408 }), new Error('socket hang up'), 'weird']) {
    const flaky = new TwilioCallProvider('ACtest', 'secret-token', { client: stubTwilio({ create: async () => { throw failure; } }).client });
    await assert.rejects(flaky.createCall({ from: LINE_A, to: '+15551230000', answerUrl: 'https://x.test/a' }), (error) => error instanceof CallProviderUnconfirmedError && !(error instanceof CallProviderRejectedError));
  }
  await assert.rejects(provider.createCall({ from: LINE_A, to: '+15551230000' }), CallProviderRejectedError, 'instructions are required');

  await provider.endCall('CA1', { mode: 'cancel' });
  await provider.endCall('CA2', { mode: 'complete' });
  assert.deepEqual(ok.updated, [{ sid: 'CA1', params: { status: 'canceled' } }, { sid: 'CA2', params: { status: 'completed' } }]);
});

// ---------- Two application instances, one database, one Twilio ----------

function twoInstances(store: CallSessionStore) {
  const provider = new FakeCallProvider();
  provider.createDelayMs = 25; // widen the window in which the instances race
  const instances = [createCallStack({ store, provider }), createCallStack({ store, provider })];
  return { provider, instances };
}

async function raceOneRequest(store: CallSessionStore) {
  const { provider, instances } = twoInstances(store);
  const idempotencyKey = uniq('race');
  const input = { direction: 'outbound' as const, to: freshNumber() };
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => instances[index % 2].adminA.create(input, { idempotencyKey })));
  assert.equal(new Set(results.map((result) => result.callId)).size, 1, 'one CallSession');
  assert.equal(provider.attempts, 1, 'one Twilio request');
  assert.equal(provider.created.length, 1);
  const rows = (await store.list('acct_a', { limit: 100 })).filter((session) => session.idempotencyKey === idempotencyKey);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'initiating');
  assert.equal(rows[0].dialOutcome, 'accepted');
  assert.ok(rows[0].providerCallId);
  // Each instance sees and reports the same call; callbacks processed by either converge it once.
  const sid = rows[0].providerCallId!;
  const applied = await Promise.all([instances[0], instances[1], instances[0], instances[1]].map((instance) => instance.calls.applyProviderEvent(providerEvent(sid, 'completed', 'completed'))));
  assert.equal(applied.filter((entry) => entry.outcome === 'applied').length, 1);
  assert.equal((await instances[1].adminA.get({ callId: results[0].callId })).status, 'completed');
}

test('two application instances, one request: one session and one provider call (in-memory store)', async () => {
  await raceOneRequest(new InMemoryCallSessionStore());
});

test('two application instances, one request: one session and one provider call (real Postgres, repeated)', { skip: databaseUrl ? undefined : 'set TEST_DATABASE_URL to run against Postgres' }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 20 });
  t.after(() => pool.end());
  const store = new PostgresCallSessionStore(pool);
  await store.initialize();
  // Many independent races, so a scheduling quirk cannot hide a duplicate dial.
  for (let round = 0; round < 12; round += 1) await raceOneRequest(store);
  // And unrelated requests in flight at the same time each get exactly their own call.
  const { provider, instances } = twoInstances(store);
  const keys = Array.from({ length: 6 }, () => uniq('multi'));
  const destinations = keys.map(() => freshNumber());
  await Promise.all(keys.flatMap((idempotencyKey, index) => [0, 1, 2].map((copy) =>
    instances[copy % 2].adminA.create({ direction: 'outbound', to: destinations[index] }, { idempotencyKey }))));
  assert.equal(provider.attempts, 6, 'six requests, six calls, however many duplicates');
});

test('Postgres: the claim, the outcome and the migration behave as the in-memory store does', { skip: databaseUrl ? undefined : 'set TEST_DATABASE_URL to run against Postgres' }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
  t.after(() => pool.end());
  const store = new PostgresCallSessionStore(pool);
  await store.initialize();
  await store.initialize();
  const stack = createCallStack({ store });
  const planned = await stack.calls.create({ accountId: uniq('acct') }, { direction: 'outbound', to: '+15551230000', from: '+15550009999' });
  const claims = await Promise.all(Array.from({ length: 10 }, () => claimOutboundDial(store, planned.id)));
  assert.equal(claims.filter((claim) => claim.claimed).length, 1);
  const row = (await pool.query('SELECT status, dial_outcome, dial_claimed_at FROM call_sessions WHERE id = $1', [planned.id])).rows[0];
  assert.equal(row.status, 'initiating');
  assert.equal(row.dial_outcome, 'pending');
  assert.ok(row.dial_claimed_at);
  const columns = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'call_sessions'`)).rows.map((r) => r.column_name);
  for (const column of ['objective', 'dial_claimed_at', 'dial_outcome']) assert.ok(columns.includes(column), column);
  await assert.rejects(pool.query(`UPDATE call_sessions SET dial_outcome = 'nonsense' WHERE id = $1`, [planned.id]), /violates check constraint/);
  const indexes = (await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'call_sessions'`)).rows.map((r) => r.indexname);
  assert.ok(indexes.includes('idx_call_sessions_unconfirmed_dial'));
  // Unconfirmed-dial lookup uses it: only claimed, unresolved, old enough.
  const old = await store.listUnconfirmedDials(new Date(Date.now() + 60_000), 100);
  assert.ok(old.some((session) => session.id === planned.id));
  await stack.calls.attachProviderCall(planned.id, uniq('CA'));
  assert.ok(!(await store.listUnconfirmedDials(new Date(Date.now() + 60_000), 100)).some((session) => session.id === planned.id));
});
