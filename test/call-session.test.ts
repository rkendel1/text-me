import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import {
  CALL_SESSION_STATUSES,
  CallTransitionError,
  decideTransition,
  isTerminal,
  presentCallSession,
  type CallDirection,
  type CallSessionRecord,
  type CallSessionStatus,
} from '../src/calls/model.js';
import { FakeCallProvider } from '../src/calls/provider.js';
import { mapTwilioCallStatus, mapTwilioDirection, twilioProviderEventId } from '../src/calls/provider-status.js';
import {
  CallConflictError,
  CallNotFoundError,
  CallProviderError,
  CallRequestError,
  CallSessionService,
} from '../src/calls/service.js';
import { InMemoryCallSessionStore, type CallSessionStore } from '../src/calls/store.js';
import { maskPhone } from '../src/calls/log.js';
import { TwilioProvider } from '../src/telephony/twilio-provider.js';
import { PostgresCallSessionStore } from '../src/repositories/postgres-call-session-repository.js';
import { transitionCallSession } from '../src/calls/transition.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
let counter = 0;
const uniq = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Puts an outbound session where a dial leaves it: `initiating`, with the provider's id. */
async function dialled(h: { calls: CallSessionService }, id: string, providerCallId: string): Promise<void> {
  await h.calls.transition(id, 'initiating');
  await h.calls.attachProviderCall(id, providerCallId);
}

interface Harness {
  calls: CallSessionService;
  store: CallSessionStore;
  provider: FakeCallProvider;
  logs: Array<{ level: string; event: string; fields: Record<string, unknown> }>;
  accountA: string;
  accountB: string;
}

function harness(store: CallSessionStore = new InMemoryCallSessionStore(), clock?: () => Date): Harness {
  const provider = new FakeCallProvider();
  const logs: Harness['logs'] = [];
  const accountA = uniq('acct_a');
  const accountB = uniq('acct_b');
  const calls = new CallSessionService(store, {
    provider,
    assistantLine: async (accountId) => (accountId === accountA ? '+15550001000' : null),
    logger: { log: (level, event, fields) => logs.push({ level, event, fields }) },
    ...(clock ? { now: clock } : {}),
  });
  return { calls, store, provider, logs, accountA, accountB };
}

const inboundInput = (providerCallId = uniq('CA')) => ({
  direction: 'inbound' as CallDirection, providerCallId, from: '+15555550123', to: '+15550001000',
});

// ---------- Lifecycle rules (pure) ----------

test('the lifecycle moves forward only, and terminal states are final', () => {
  const at = (status: CallSessionStatus, direction: CallDirection = 'outbound', providerCallId: string | null = 'CA1') => ({ status, direction, providerCallId });

  // The happy path, step by step.
  for (const [from, to] of [
    ['created', 'initiating'], ['initiating', 'ringing'], ['ringing', 'answered'], ['answered', 'in_progress'],
    ['in_progress', 'ending'], ['ending', 'completed'],
  ] as const) {
    assert.equal(decideTransition(at(from), to).kind, 'apply', `${from} → ${to}`);
  }
  // Failure paths from the spec.
  assert.equal(decideTransition(at('initiating'), 'failed').kind, 'apply');
  assert.equal(decideTransition(at('ringing'), 'no_answer').kind, 'apply');
  assert.equal(decideTransition(at('ringing'), 'busy').kind, 'apply');
  assert.equal(decideTransition(at('ringing'), 'failed').kind, 'apply');
  assert.equal(decideTransition(at('in_progress'), 'failed').kind, 'apply');
  for (const active of ['created', 'initiating', 'ringing', 'answered', 'in_progress', 'ending'] as const) {
    assert.equal(decideTransition(at(active), 'canceled').kind, 'apply', `${active} → canceled`);
  }
  // A provider may skip events it never delivered: completion without seeing `answered` is fine once dialing began.
  assert.equal(decideTransition(at('ringing'), 'completed').kind, 'apply');
  assert.equal(decideTransition(at('initiating'), 'completed').kind, 'apply');
  // But a call that never started cannot complete, and a call with nothing at the provider cannot be ending.
  assert.equal(decideTransition(at('created'), 'completed').kind, 'invalid');
  assert.equal(decideTransition(at('created', 'outbound', null), 'answered').kind, 'invalid');
  assert.equal(decideTransition(at('answered', 'outbound', null), 'ending').kind, 'invalid');
  // created → ringing is for a call that already exists at the provider (inbound).
  assert.equal(decideTransition(at('created', 'inbound', null), 'ringing').kind, 'apply');
  assert.equal(decideTransition(at('created', 'outbound', null), 'ringing').kind, 'invalid');

  // Same state is a harmless repeat; going backwards is stale, not an error.
  assert.equal(decideTransition(at('answered'), 'answered').kind, 'noop');
  assert.equal(decideTransition(at('in_progress'), 'ringing').kind, 'stale');
  assert.equal(decideTransition(at('ending'), 'in_progress').kind, 'stale');
  // A call that was picked up cannot be reported unanswered later.
  assert.equal(decideTransition(at('answered'), 'no_answer').kind, 'stale');
  assert.equal(decideTransition(at('created'), 'busy').kind, 'invalid');

  // Terminal states cannot transition to anything else, in particular not to an active state.
  for (const terminal of CALL_SESSION_STATUSES.filter(isTerminal)) {
    for (const target of CALL_SESSION_STATUSES) {
      const decision = decideTransition(at(terminal), target);
      assert.equal(decision.kind, target === terminal ? 'noop' : 'stale', `${terminal} → ${target}`);
    }
  }
});

// ---------- Provider translation boundary ----------

test('Twilio statuses map to domain statuses, and unknown ones are data, not errors', () => {
  assert.deepEqual(
    ['queued', 'initiated', 'ringing', 'in-progress', 'answered', 'completed', 'busy', 'failed', 'no-answer', 'canceled'].map((raw) => mapTwilioCallStatus(raw)),
    ['initiating', 'initiating', 'ringing', 'answered', 'answered', 'completed', 'busy', 'failed', 'no_answer', 'canceled'],
  );
  assert.equal(mapTwilioCallStatus('COMPLETED'), 'completed');
  assert.equal(mapTwilioCallStatus('something-new'), null);
  assert.equal(mapTwilioDirection('inbound'), 'inbound');
  assert.equal(mapTwilioDirection('outbound-api'), 'outbound');
  assert.equal(mapTwilioDirection('outbound-dial'), 'outbound');
  assert.equal(mapTwilioDirection(undefined), 'inbound');

  // Event identity uses only what Twilio sends.
  assert.equal(twilioProviderEventId({ CallSid: 'CA1', CallStatus: 'Completed' }), 'CA1:completed');
  assert.equal(twilioProviderEventId({ CallSid: 'CA1', CallStatus: 'completed', SequenceNumber: '4' }), 'CA1:completed:4');
  assert.notEqual(twilioProviderEventId({ CallSid: 'CA1', CallStatus: 'ringing' }), twilioProviderEventId({ CallSid: 'CA2', CallStatus: 'ringing' }));

  const parsed = new TwilioProvider().parseStatusUpdate({ CallSid: 'CA9', CallStatus: 'mystery', CallDuration: '7', SequenceNumber: '2' });
  assert.equal(parsed.status, null, 'an unmodelled status no longer throws (it used to be a 400)');
  assert.equal(parsed.rawStatus, 'mystery');
  assert.equal(parsed.eventId, 'CA9:mystery:2');
  assert.equal(parsed.durationSeconds, 7);
  assert.equal(new TwilioProvider().parseStatusUpdate({ CallSid: 'CA9', CallStatus: 'no-answer' }).status, 'no_answer');
});

// ---------- Store contract: the same guarantees from memory and from Postgres ----------

function storeContract(name: string, make: () => Promise<CallSessionStore> | CallSessionStore, options: { skip?: string } = {}) {
  const t = (title: string, fn: () => Promise<void>) => test(`${name}: ${title}`, { skip: options.skip }, fn);

  t('creation: the domain id is ours and differs from the provider id', async () => {
    const h = harness(await make());
    const sid = uniq('CAabc');
    const inbound = await h.calls.create({ accountId: h.accountA, canIngest: true }, inboundInput(sid));
    assert.notEqual(inbound.id, sid);
    assert.match(inbound.id, /^call_[0-9a-f]{32}$/);
    assert.equal(inbound.providerCallId, sid);
    assert.equal(inbound.direction, 'inbound');
    assert.equal(inbound.status, 'ringing', 'an inbound call already exists at the provider');

    const outbound = await h.calls.create({ accountId: h.accountA, principalId: 'user_1' }, { direction: 'outbound', to: '+15551230000' });
    assert.equal(outbound.direction, 'outbound');
    assert.equal(outbound.status, 'created');
    assert.equal(outbound.providerCallId, null);
    assert.equal(outbound.from, '+15550001000', 'defaults to the account\'s assistant line');
    assert.equal(outbound.requestedBy, 'user_1');
    assert.deepEqual(h.provider.created, [], 'creating an outbound call never dials it');
    assert.ok(!('providerCallId' in presentCallSession(outbound)), 'the view never exposes the provider id');
  });

  t('the same provider call is one session, however often it is reported', async () => {
    const h = harness(await make());
    const input = inboundInput();
    const first = await h.calls.create({ accountId: h.accountA, canIngest: true }, input);
    const again = await h.calls.create({ accountId: h.accountA, canIngest: true }, input);
    assert.equal(again.id, first.id);
    // Another account can neither claim nor learn about it.
    await assert.rejects(h.calls.create({ accountId: h.accountB, canIngest: true }, input), (error) => error instanceof CallConflictError && error.reason === 'provider_call_taken');
  });

  t('idempotent create: a retry with the same key is the same call; a different request under the key is refused', async () => {
    const h = harness(await make());
    const key = uniq('idem');
    const first = await h.calls.create({ accountId: h.accountA, idempotencyKey: key }, { direction: 'outbound', to: '+15551230000' });
    const retry = await h.calls.create({ accountId: h.accountA, idempotencyKey: key }, { direction: 'outbound', to: '+15551230000' });
    assert.equal(retry.id, first.id);
    assert.equal((await h.calls.list(h.accountA)).items.length, 1);
    await assert.rejects(
      h.calls.create({ accountId: h.accountA, idempotencyKey: key }, { direction: 'outbound', to: '+15559990000' }),
      (error) => error instanceof CallConflictError && error.reason === 'idempotency_key_reused',
    );
    // The key is scoped to the account.
    const other = await h.calls.create({ accountId: h.accountB, idempotencyKey: key, canIngest: false }, { direction: 'outbound', to: '+15551230000', from: '+15550002000' });
    assert.notEqual(other.id, first.id);
  });

  t('concurrent creates with one key produce exactly one call', async () => {
    const h = harness(await make());
    const key = uniq('race');
    const made = await Promise.all(Array.from({ length: 8 }, () =>
      h.calls.create({ accountId: h.accountA, idempotencyKey: key }, { direction: 'outbound', to: '+15551230000' })));
    assert.equal(new Set(made.map((session) => session.id)).size, 1);
    assert.equal((await h.calls.list(h.accountA)).items.length, 1);
  });

  t('transitions: validated, timestamped, versioned, and retry-safe', async () => {
    const h = harness(await make());
    const call = await h.calls.create({ accountId: h.accountA }, { direction: 'outbound', to: '+15551230000' });
    assert.equal(call.version, 1);
    assert.equal(call.startedAt, null);

    const dialed = uniq('CAdial');
    await dialled(h, call.id, dialed);
    let session = await h.calls.get(h.accountA, call.id);
    assert.equal(session.status, 'initiating');
    assert.equal(session.providerCallId, dialed);
    assert.ok(session.startedAt, 'startedAt is set when dialing begins');

    // Strict (application) mode refuses what the lifecycle forbids, and never half-applies it.
    await assert.rejects(h.calls.transition(call.id, 'in_progress').then(() => h.calls.transition(call.id, 'created')), CallTransitionError);
    session = await h.calls.get(h.accountA, call.id);
    assert.equal(session.status, 'in_progress');
    assert.ok(session.answeredAt, 'in progress implies answered');

    const version = session.version;
    const repeat = await h.calls.transition(call.id, 'in_progress');
    assert.equal(repeat.outcome, 'noop');
    assert.equal((await h.calls.get(h.accountA, call.id)).version, version, 'repeating a transition changes nothing');

    await h.calls.transition(call.id, 'completed', { reason: 'all done' });
    session = await h.calls.get(h.accountA, call.id);
    assert.equal(session.status, 'completed');
    assert.ok(session.endedAt);
    assert.equal(session.endReason, 'all done');
    // Terminal states cannot go back to active ones.
    await assert.rejects(h.calls.transition(call.id, 'in_progress'), CallTransitionError);
    await assert.rejects(h.calls.transition(call.id, 'ringing'), CallTransitionError);
    assert.equal((await h.calls.get(h.accountA, call.id)).status, 'completed');
    // The runtime's lenient observations never throw.
    assert.equal((await h.calls.transition(call.id, 'in_progress', { mode: 'lenient' })).outcome, 'stale');
  });

  t('provider events: duplicates are harmless, late ones are stale, unknown statuses change nothing', async () => {
    const h = harness(await make());
    const sid = uniq('CA');
    const call = await h.calls.create({ accountId: h.accountA, canIngest: true }, inboundInput(sid));
    const event = (rawStatus: string, status: CallSessionStatus | null, extra: { eventId?: string } = {}) => ({
      provider: 'twilio', providerCallId: sid, eventId: extra.eventId ?? `${sid}:${rawStatus}`, rawStatus, status,
    });

    const answered = await h.calls.applyProviderEvent(event('in-progress', 'answered'));
    assert.equal(answered.outcome, 'applied');
    const version = answered.session!.version;

    // The same callback again: same durable result as once.
    const duplicate = await h.calls.applyProviderEvent(event('in-progress', 'answered'));
    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal(duplicate.session!.version, version);

    // A different callback that says the same thing is a noop, also harmless.
    assert.equal((await h.calls.applyProviderEvent(event('answered', 'answered', { eventId: `${sid}:answered` }))).outcome, 'noop');
    // An earlier state arriving late.
    assert.equal((await h.calls.applyProviderEvent(event('ringing', 'ringing'))).outcome, 'stale');
    // A status the domain doesn't model: recorded, nothing changes.
    const unknown = await h.calls.applyProviderEvent(event('mystery', null));
    assert.equal(unknown.outcome, 'unmapped');
    assert.equal((await h.calls.get(h.accountA, call.id)).version, version);
    assert.equal((await h.calls.applyProviderEvent(event('mystery', null))).outcome, 'duplicate');

    const completed = await h.calls.applyProviderEvent(event('completed', 'completed'));
    assert.equal(completed.outcome, 'applied');
    assert.equal(completed.session!.status, 'completed');
    assert.equal(completed.session!.endReason, 'completed');
    assert.equal(completed.session!.lastProviderStatus, 'completed');
    // Out of order after the end: the call stays completed.
    assert.equal((await h.calls.applyProviderEvent(event('in-progress', 'answered', { eventId: `${sid}:in-progress:9` }))).outcome, 'stale');
    assert.equal((await h.calls.get(h.accountA, call.id)).status, 'completed');
    // A call nobody knows.
    assert.equal((await h.calls.applyProviderEvent({ ...event('completed', 'completed'), providerCallId: 'CAunknown', eventId: 'CAunknown:completed' })).outcome, 'unknown_call');
  });

  t('the same event delivered concurrently is applied exactly once', async () => {
    const h = harness(await make());
    const sid = uniq('CA');
    const call = await h.calls.create({ accountId: h.accountA, canIngest: true }, inboundInput(sid));
    const results = await Promise.all(Array.from({ length: 10 }, () => h.calls.applyProviderEvent({
      provider: 'twilio', providerCallId: sid, eventId: `${sid}:completed`, rawStatus: 'completed', status: 'completed',
    })));
    assert.equal(results.filter((result) => result.outcome === 'applied').length, 1);
    assert.equal(results.filter((result) => result.outcome === 'duplicate').length, 9);
    const session = await h.calls.get(h.accountA, call.id);
    assert.equal(session.status, 'completed');
    assert.equal(session.version, 3, 'created → ringing → completed: one version per real change');
  });

  t('unanswered outcomes: no answer, busy and failed are terminal', async () => {
    const h = harness(await make());
    for (const [raw, expected] of [['no-answer', 'no_answer'], ['busy', 'busy'], ['failed', 'failed']] as const) {
      const call = await h.calls.create({ accountId: h.accountA }, { direction: 'outbound', to: '+15551230000' });
      const sid = uniq('CA');
      await dialled(h, call.id, sid);
      await h.calls.applyProviderEvent({ provider: 'twilio', providerCallId: sid, eventId: `${sid}:ringing`, rawStatus: 'ringing', status: 'ringing' });
      const result = await h.calls.applyProviderEvent({ provider: 'twilio', providerCallId: sid, eventId: `${sid}:${raw}`, rawStatus: raw, status: expected });
      assert.equal(result.outcome, 'applied');
      assert.equal(result.session!.status, expected);
      assert.equal(result.session!.endReason, expected);
      assert.ok(result.session!.endedAt);
    }
  });

  t('end is idempotent: the provider is asked to hang up once', async () => {
    const h = harness(await make());
    const sid = uniq('CA');
    const call = await h.calls.create({ accountId: h.accountA, canIngest: true }, inboundInput(sid));
    await h.calls.applyProviderEvent({ provider: 'twilio', providerCallId: sid, eventId: `${sid}:in-progress`, rawStatus: 'in-progress', status: 'answered' });

    const actor = { accountId: h.accountA, principalId: 'user_1', traceId: 'trace-end' };
    const [a, b, c] = await Promise.all([h.calls.end(actor, call.id, { reason: 'owner_stopped' }), h.calls.end(actor, call.id), h.calls.end(actor, call.id)]);
    assert.deepEqual(h.provider.ended, [{ providerCallId: sid, mode: 'complete' }], 'one provider operation for three concurrent requests');
    for (const session of [a, b, c]) assert.ok(['ending', 'completed'].includes(session.status));
    const ending = await h.calls.get(h.accountA, call.id);
    assert.equal(ending.status, 'ending');
    // Whichever request claimed first decided the reason.
    assert.ok(['owner_stopped', 'ended_by_request'].includes(ending.endReason!));

    await h.calls.end(actor, call.id);
    assert.equal(h.provider.ended.length, 1, 'a later repeat is also harmless');

    // The provider's confirmation completes it; the end reason given is kept.
    const done = await h.calls.applyProviderEvent({ provider: 'twilio', providerCallId: sid, eventId: `${sid}:completed`, rawStatus: 'completed', status: 'completed' });
    assert.equal(done.session!.status, 'completed');
    assert.equal(done.session!.endReason, ending.endReason);
    // Ending an ended call does nothing at the provider.
    const final = await h.calls.end(actor, call.id);
    assert.equal(final.status, 'completed');
    assert.equal(h.provider.ended.length, 1);
  });

  t('end: an unanswered call is cancelled, and one with nothing at the provider just becomes canceled', async () => {
    const h = harness(await make());
    const pending = await h.calls.create({ accountId: h.accountA }, { direction: 'outbound', to: '+15551230000' });
    const canceled = await h.calls.end({ accountId: h.accountA }, pending.id);
    assert.equal(canceled.status, 'canceled');
    assert.equal(canceled.endReason, 'ended_by_request');
    assert.deepEqual(h.provider.ended, [], 'there was no provider call to end');

    const ringing = await h.calls.create({ accountId: h.accountA }, { direction: 'outbound', to: '+15551230000' });
    const ringSid = uniq('CAring');
    await dialled(h, ringing.id, ringSid);
    await h.calls.transition(ringing.id, 'ringing');
    await h.calls.end({ accountId: h.accountA }, ringing.id);
    assert.deepEqual(h.provider.ended, [{ providerCallId: ringSid, mode: 'cancel' }]);
  });

  t('end: if the provider fails the call stays ending and a retry asks again', async () => {
    const h = harness(await make());
    const sid = uniq('CA');
    const call = await h.calls.create({ accountId: h.accountA, canIngest: true }, inboundInput(sid));
    await h.calls.transition(call.id, 'answered');
    h.provider.failEnd = new Error('twilio 503');
    await assert.rejects(h.calls.end({ accountId: h.accountA }, call.id), CallProviderError);
    assert.equal((await h.calls.get(h.accountA, call.id)).status, 'ending');
    assert.equal((await h.calls.get(h.accountA, call.id)).endClaimedAt, null, 'the claim was released');
    h.provider.failEnd = undefined;
    await h.calls.end({ accountId: h.accountA }, call.id);
    assert.deepEqual(h.provider.ended, [{ providerCallId: sid, mode: 'complete' }]);
  });

  t('ownership: one account can neither see nor end another account\'s call', async () => {
    const h = harness(await make());
    const mine = await h.calls.create({ accountId: h.accountA, canIngest: true }, inboundInput());
    await assert.rejects(h.calls.get(h.accountB, mine.id), CallNotFoundError);
    await assert.rejects(h.calls.end({ accountId: h.accountB }, mine.id), CallNotFoundError);
    assert.deepEqual(h.provider.ended, []);
    assert.equal((await h.calls.list(h.accountB)).items.length, 0);
    assert.equal((await h.calls.get(h.accountA, mine.id)).status, 'ringing');
    // A guessed id is indistinguishable from no id.
    await assert.rejects(h.calls.get(h.accountA, 'call_00000000000000000000000000000000'), CallNotFoundError);
  });

  t('list: filters, newest first, keyset paging', async () => {
    let tick = Date.parse('2026-01-01T00:00:00Z');
    const h = harness(await make(), () => new Date((tick += 1000)));
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const call = index % 2 === 0
        ? await h.calls.create({ accountId: h.accountA, canIngest: true }, inboundInput())
        : await h.calls.create({ accountId: h.accountA }, { direction: 'outbound', to: '+15551230000' });
      ids.push(call.id);
    }
    await h.calls.end({ accountId: h.accountA }, ids[1]); // canceled
    await h.calls.create({ accountId: h.accountB, canIngest: true }, inboundInput());

    const all = await h.calls.list(h.accountA, { limit: 100 });
    assert.deepEqual(all.items.map((item) => item.id), [...ids].reverse(), 'newest first, only this account');
    assert.equal(all.nextCursor, null);

    assert.deepEqual((await h.calls.list(h.accountA, { direction: 'outbound' })).items.map((item) => item.id), [ids[3], ids[1]]);
    assert.deepEqual((await h.calls.list(h.accountA, { status: ['canceled'] })).items.map((item) => item.id), [ids[1]]);
    assert.equal((await h.calls.list(h.accountA, { status: ['ringing', 'created'] })).items.length, 4);
    // Boundaries come from the stored timestamps (the clock ticks on every internal read, not once per call).
    const middle = (await h.calls.get(h.accountA, ids[2])).createdAt;
    assert.deepEqual((await h.calls.list(h.accountA, { createdAfter: middle })).items.map((item) => item.id), [ids[4], ids[3]]);
    assert.deepEqual((await h.calls.list(h.accountA, { createdBefore: middle })).items.map((item) => item.id), [ids[1], ids[0]]);

    const first = await h.calls.list(h.accountA, { limit: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const second = await h.calls.list(h.accountA, { limit: 2, cursor: first.nextCursor! });
    const third = await h.calls.list(h.accountA, { limit: 2, cursor: second.nextCursor! });
    assert.deepEqual([...first.items, ...second.items, ...third.items].map((item) => item.id), [...ids].reverse());
    assert.equal(third.nextCursor, null);
    await assert.rejects(h.calls.list(h.accountA, { cursor: 'not-a-cursor' }), CallRequestError);
  });

  t('the carrier\'s caller id is recorded when valid, never a reason to drop the call', async () => {
    const h = harness(await make());
    const anonymous = await h.calls.create({ accountId: h.accountA, canIngest: true }, { direction: 'inbound', providerCallId: uniq('CA'), from: 'anonymous', to: '+15550001000' });
    assert.equal(anonymous.from, null);
    assert.equal(anonymous.to, '+15550001000');
    // A user, by contrast, is held to valid numbers and cannot attach provider calls.
    await assert.rejects(h.calls.create({ accountId: h.accountA }, { direction: 'outbound', to: 'not a number' }), CallRequestError);
    await assert.rejects(h.calls.create({ accountId: h.accountA }, inboundInput()), (error) => error instanceof CallRequestError && error.code === 'not_permitted');
    await assert.rejects(h.calls.create({ accountId: h.accountB }, { direction: 'outbound', to: '+15551230000' }), (error) => error instanceof CallRequestError && error.code === 'no_assistant_line');
  });
}

storeContract('in-memory store', () => new InMemoryCallSessionStore());

let pool: pg.Pool | undefined;
storeContract('Postgres store', async () => {
  pool ??= new pg.Pool({ connectionString: databaseUrl, max: 12 });
  const store = new PostgresCallSessionStore(pool);
  await store.initialize();
  return store;
}, { skip: databaseUrl ? undefined : 'set TEST_DATABASE_URL to run against Postgres' });

test('Postgres store: duplicate callbacks leave a diagnosable record; migration is repeatable', { skip: databaseUrl ? undefined : 'set TEST_DATABASE_URL to run against Postgres' }, async (t) => {
  pool ??= new pg.Pool({ connectionString: databaseUrl, max: 12 });
  t.after(async () => { await pool?.end(); pool = undefined; });
  const store = new PostgresCallSessionStore(pool);
  await store.initialize();
  await store.initialize(); // idempotent: instances migrate on every cold start
  const h = harness(store);
  const sid = uniq('CA');
  await h.calls.create({ accountId: h.accountA, canIngest: true }, inboundInput(sid));
  await h.calls.applyProviderEvent({ provider: 'twilio', providerCallId: sid, eventId: `${sid}:mystery:1`, rawStatus: 'mystery', status: null, sequence: '1' });
  await h.calls.applyProviderEvent({ provider: 'twilio', providerCallId: sid, eventId: `${sid}:mystery:1`, rawStatus: 'mystery', status: null, sequence: '1' });
  const rows = await pool.query('SELECT raw_status, sequence, outcome FROM call_provider_events WHERE provider = $1 AND event_id = $2', ['twilio', `${sid}:mystery:1`]);
  assert.deepEqual(rows.rows, [{ raw_status: 'mystery', sequence: '1', outcome: 'unmapped' }], 'one row per callback, with how it turned out');
  // The constraints that carry the guarantees exist, and so do the indexes the queries use.
  const indexes = (await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'call_sessions'`)).rows.map((row) => row.indexname);
  for (const name of ['call_sessions_provider_call', 'call_sessions_idempotency', 'idx_call_sessions_account_created', 'idx_call_sessions_account_status', 'idx_call_sessions_conversation']) {
    assert.ok(indexes.includes(name), name);
  }
  await assert.rejects(pool.query(`UPDATE call_sessions SET status = 'bogus' WHERE id = 'x'`).then(() => pool!.query(`INSERT INTO call_sessions (id, account_id, direction, status, provider, created_at, updated_at) VALUES ('bad', 'a', 'inbound', 'bogus', 'twilio', now(), now())`)), /violates check constraint/);
});

// ---------- Observability ----------

test('every call operation logs the ids needed to correlate it, with phone numbers masked', async () => {
  const h = harness();
  const sid = 'CAtrace0000000000000000000000000001';
  const call = await h.calls.create({ accountId: h.accountA, canIngest: true, traceId: 'trace-xyz' }, inboundInput(sid));
  await h.calls.applyProviderEvent({ provider: 'twilio', providerCallId: sid, eventId: `${sid}:completed`, rawStatus: 'completed', status: 'completed', traceId: 'trace-evt' });
  const created = h.logs.find((entry) => entry.event === 'call.created')!;
  assert.equal(created.fields.callId, call.id);
  assert.equal(created.fields.providerCallId, sid);
  assert.equal(created.fields.traceId, 'trace-xyz');
  const event = h.logs.find((entry) => entry.event === 'call.event.applied')!;
  assert.equal(event.fields.callId, call.id);
  assert.equal(event.fields.providerCallId, sid);
  assert.equal(event.fields.traceId, 'trace-evt');
  const serialized = JSON.stringify(h.logs);
  assert.ok(!serialized.includes('+15555550123') && !serialized.includes('+15550001000'), 'no full phone numbers in logs');
  assert.equal(maskPhone('+15555550123'), '+1••••••0123');
  assert.equal(maskPhone(null), null);
});

// ---------- Architecture guards ----------

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

test('architecture: status changes only through the transition function, calls only through the provider', () => {
  const files = sources('src');
  const read = (file: string) => readFileSync(file, 'utf8');

  // Only transition.ts writes a status into a patch.
  const writers = files.filter((file) => read(file).includes('CallSession') && /patch:\s*\{[^}]*\bstatus\b/.test(read(file)));
  assert.deepEqual(writers, [join('src', 'calls', 'transition.ts')]);
  // Only the calls layer (and its stores) mutate sessions.
  const mutators = files.filter((file) => /\.mutate\(/.test(read(file))).sort();
  assert.deepEqual(mutators, [join('src', 'calls', 'service.ts'), join('src', 'calls', 'transition.ts')].sort());
  // Only the Twilio adapter touches the Twilio calls API.
  const direct = files.filter((file) => /\.calls\.create\(|\.calls\(\s*[a-zA-Z'"`]/.test(read(file)) && /twilio/i.test(read(file)));
  assert.deepEqual(direct, [join('src', 'telephony', 'twilio-call-provider.ts')]);
  // The domain layer never names the provider's vocabulary.
  for (const file of files.filter((candidate) => candidate.startsWith(join('src', 'calls')) && !candidate.endsWith('provider-status.ts'))) {
    assert.ok(!/CallSid|CallStatus|'in-progress'|'no-answer'|twilio\b/i.test(read(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/provider: 'twilio'|'twilio'/g, '')), `${file} names Twilio terms`);
  }
});

test('a transition on a session nobody has reports not_found, it does not throw', async () => {
  const result = await transitionCallSession(new InMemoryCallSessionStore(), 'call_missing', 'ringing', { mode: 'lenient' });
  assert.equal(result.outcome, 'not_found');
});
