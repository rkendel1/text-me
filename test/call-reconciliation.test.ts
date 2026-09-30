import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import pg from 'pg';
import request from 'supertest';

import { FakeCallProvider } from '../src/calls/provider.js';
import type { CallSessionRecord } from '../src/calls/model.js';
import { InMemoryCallSessionStore, type CallSessionStore } from '../src/calls/store.js';
import { createApp } from '../src/http-app.js';
import { PostgresCallSessionStore } from '../src/repositories/postgres-call-session-repository.js';
import { FakeMessagingProvider } from '../src/messaging/fake-provider.js';
import { InMemoryConversationRepository } from './support/in-memory-repository.js';
import { createCallStack, providerEvent } from './support/calls.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresOnly = { skip: databaseUrl ? undefined : 'set TEST_DATABASE_URL to run against Postgres' };
let counter = 0;
const uniq = (label: string) => `${label}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const freshNumber = () => `+1555${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
const MINUTE = 60_000;

/** A stack on a clock the test moves, with "Twilio" losing the first response: the call exists at the provider, the application never heard. */
async function lostResponse(options: { store?: CallSessionStore; to?: string } = {}) {
  const clock = { ms: Date.parse('2026-06-01T12:00:00Z') };
  const now = () => new Date(clock.ms);
  const provider = new FakeCallProvider();
  const stack = createCallStack({ store: options.store, provider, now });
  provider.loseResponse = true;
  const created = await stack.adminA.create({ direction: 'outbound', to: options.to ?? freshNumber() }, { idempotencyKey: uniq('lost') });
  provider.loseResponse = false;
  const held = provider.held.at(-1)!;
  const session = async () => (await stack.store.findById(created.callId))!;
  const advance = (ms: number) => { clock.ms += ms; };
  return { stack, provider, created, held, session, advance, clock, now };
}

// ---------- What the session looks like before reconciliation ----------

test('a lost response leaves the call initiating and unconfirmed, with no provider id invented', async () => {
  const { session, provider, created } = await lostResponse();
  const row = await session();
  assert.equal(created.status, 'initiating');
  assert.equal(row.providerCallId, null);
  assert.equal(row.dialOutcome, 'unconfirmed');
  assert.equal(provider.attempts, 1);
});

// ---------- Convergence ----------

test('reconciliation ties an unconfirmed call to the provider call and follows its state (ringing)', async () => {
  const { stack, provider, held, session, advance } = await lostResponse();
  held.status = 'ringing';
  advance(3 * MINUTE);
  const report = await stack.calls.reconcileUnconfirmedDials();
  assert.equal(report.confirmed, 1);
  const row = await session();
  assert.equal(row.providerCallId, held.providerCallId);
  assert.equal(row.status, 'ringing');
  assert.equal(row.dialOutcome, 'accepted');
  assert.equal(row.reconciliationAttempts, 1);
  assert.equal(provider.attempts, 1, 'reconciliation never dials');
  assert.equal(provider.ended.length, 0);
  // Its own callbacks carry on from there.
  await stack.calls.applyProviderEvent(providerEvent(held.providerCallId, 'in-progress', 'answered'));
  assert.equal((await session()).status, 'answered');
});

test('a provider call that already finished completes the session', async () => {
  const { stack, held, session, advance } = await lostResponse();
  held.status = 'completed';
  advance(3 * MINUTE);
  await stack.calls.reconcileUnconfirmedDials();
  const row = await session();
  assert.equal(row.status, 'completed');
  assert.equal(row.providerCallId, held.providerCallId);
  assert.equal(row.dialOutcome, 'accepted', 'the call existed: it is not a rejection');
});

test('a provider call that was canceled is a canceled call that existed, not a rejected request', async () => {
  const { stack, held, session, advance } = await lostResponse();
  held.status = 'canceled';
  advance(3 * MINUTE);
  await stack.calls.reconcileUnconfirmedDials();
  const row = await session();
  assert.equal(row.status, 'canceled');
  assert.equal(row.dialOutcome, 'accepted');
});

test('a queued provider call keeps the session initiating and records the id', async () => {
  const { stack, held, session, advance } = await lostResponse();
  held.status = 'initiating';
  advance(3 * MINUTE);
  await stack.calls.reconcileUnconfirmedDials();
  assert.equal((await session()).status, 'initiating');
  assert.equal((await session()).providerCallId, held.providerCallId);
});

test('a provider call that never matches our numbers and window is not ours', async () => {
  const { stack, provider, session, advance, now } = await lostResponse();
  provider.held.length = 0;
  provider.held.push({ providerCallId: 'CAother', from: '+15559990000', to: '+15559990001', status: 'ringing', createdAt: now() });
  advance(3 * MINUTE);
  const report = await stack.calls.reconcileUnconfirmedDials();
  assert.equal(report.stillUnconfirmed, 1);
  assert.equal((await session()).providerCallId, null);
});

// ---------- Uncertainty stays uncertainty ----------

test('nothing found and the provider cannot vouch for that: still unconfirmed, never failed', async () => {
  const { stack, provider, session, advance } = await lostResponse();
  provider.held.length = 0;
  advance(3 * MINUTE);
  const report = await stack.calls.reconcileUnconfirmedDials();
  assert.equal(report.stillUnconfirmed, 1);
  const row = await session();
  assert.equal(row.status, 'initiating');
  assert.equal(row.dialOutcome, 'unconfirmed');
  assert.equal(row.providerCallId, null);
});

test('a provider that guarantees absence proves the request never took: failed and rejected', async () => {
  const { stack, provider, session, advance } = await lostResponse();
  provider.held.length = 0;
  provider.absenceIsConclusive = true;
  advance(3 * MINUTE);
  const report = await stack.calls.reconcileUnconfirmedDials();
  assert.equal(report.rejected, 1);
  const row = await session();
  assert.equal(row.status, 'failed');
  assert.equal(row.dialOutcome, 'rejected');
  assert.equal(provider.attempts, 1);
});

test('two candidates are ambiguous: nothing is attached, nothing guessed', async () => {
  const { stack, provider, held, session, advance, now } = await lostResponse();
  provider.held.push({ ...held, providerCallId: 'CAtwin', createdAt: now() });
  advance(3 * MINUTE);
  const report = await stack.calls.reconcileUnconfirmedDials();
  assert.equal(report.stillUnconfirmed, 1);
  assert.equal((await session()).providerCallId, null);
});

test('a provider call that belongs to another session is not ours', async () => {
  const { stack, held, session, advance } = await lostResponse();
  const other = await stack.calls.create({ accountId: 'acct_b' }, { direction: 'outbound', to: held.to, from: '+15550002000' });
  await stack.calls.adoptDialedCall(other.id, held.providerCallId);
  advance(3 * MINUTE);
  const report = await stack.calls.reconcileUnconfirmedDials();
  assert.equal(report.stillUnconfirmed, 1);
  assert.equal((await session()).providerCallId, null);
});

test('a lookup that cannot be made leaves the call unconfirmed and is reported', async () => {
  const { stack, provider, session, advance } = await lostResponse();
  provider.failLookup = new Error('provider unavailable');
  advance(3 * MINUTE);
  const report = await stack.calls.reconcileUnconfirmedDials();
  assert.equal(report.failed, 1);
  const row = await session();
  assert.equal(row.status, 'initiating');
  assert.equal(row.dialOutcome, 'unconfirmed');
  assert.equal(row.reconciliationAttempts, 1);
  assert.ok(stack.logs.some((entry) => entry.event === 'call.reconciliation.failed'));
});

// ---------- Bounds ----------

test('a fresh dial is left alone until the grace period has passed', async () => {
  const { stack, held, session, advance } = await lostResponse();
  held.status = 'ringing';
  advance(30_000);
  assert.equal((await stack.calls.reconcileUnconfirmedDials()).examined, 0);
  advance(60_000);
  assert.equal((await stack.calls.reconcileUnconfirmedDials()).examined, 0, 'still inside the default grace');
  assert.equal((await session()).reconciliationAttempts, 0);
  advance(60_000);
  assert.equal((await stack.calls.reconcileUnconfirmedDials()).confirmed, 1);
});

test('the grace period cannot be configured below twice the dial timeout', async () => {
  const { stack, held, advance } = await lostResponse();
  held.status = 'ringing';
  advance(25_000);
  assert.equal((await stack.calls.reconcileUnconfirmedDials({ graceMs: 1 })).examined, 0, 'the 20s dial timeout could still be in flight');
  advance(20_000);
  assert.equal((await stack.calls.reconcileUnconfirmedDials({ graceMs: 1 })).confirmed, 1);
});

test('attempts are bounded, spaced, and then given up on (never failed, never redialed)', async () => {
  const { stack, provider, session, advance } = await lostResponse();
  provider.held.length = 0;
  advance(3 * MINUTE);
  assert.equal((await stack.calls.reconcileUnconfirmedDials()).examined, 1);
  assert.equal((await stack.calls.reconcileUnconfirmedDials()).examined, 0, 'a run straight after does nothing: attempts are spaced');
  for (let run = 0; run < 8; run += 1) { advance(2 * MINUTE); await stack.calls.reconcileUnconfirmedDials(); }
  const row = await session();
  assert.equal(row.reconciliationAttempts, 5, 'the default maximum');
  assert.equal(row.status, 'initiating');
  assert.equal(row.dialOutcome, 'unconfirmed');
  const last = await stack.calls.reconcileUnconfirmedDials();
  assert.equal(last.examined, 0);
  assert.deepEqual([last.unresolved, last.exhausted], [1, 1], 'visible as given up on');
  assert.equal(provider.attempts, 1);
  assert.equal(provider.lookups.length, 5);
});

test('a batch is bounded', async () => {
  const clock = { ms: Date.parse('2026-06-01T12:00:00Z') };
  const provider = new FakeCallProvider();
  const stack = createCallStack({ provider, now: () => new Date(clock.ms) });
  provider.loseResponse = true;
  for (let index = 0; index < 5; index += 1) {
    await stack.adminA.create({ direction: 'outbound', to: freshNumber() }, { idempotencyKey: uniq('batch') });
    // One line per account: each earlier call is still "active", so end it locally to place the next.
    await Promise.all((await stack.adminA.list({ status: ['initiating'] })).items.map((item) => stack.adminA.end({ callId: item.callId })));
  }
  clock.ms += 3 * MINUTE;
  const report = await stack.calls.reconcileUnconfirmedDials({ limit: 2 });
  assert.equal(report.examined, 2);
  assert.equal(provider.attempts, 5);
});

// ---------- Local intent is never reversed ----------

test('a call ended while its dial was unknown is found, hung up once, and stays ended', async () => {
  const { stack, provider, created, held, session, advance } = await lostResponse();
  const ended = await stack.adminA.end({ callId: created.callId });
  assert.equal(ended.status, 'canceled');
  held.status = 'ringing';
  advance(3 * MINUTE);
  const report = await stack.calls.reconcileUnconfirmedDials();
  assert.equal(report.cancelledAtProvider, 1);
  const row = await session();
  assert.equal(row.status, 'canceled', 'not resurrected');
  assert.equal(row.providerCallId, held.providerCallId);
  assert.equal(row.dialOutcome, 'accepted');
  assert.deepEqual(provider.ended, [{ providerCallId: held.providerCallId, mode: 'cancel' }]);
  await stack.calls.reconcileUnconfirmedDials();
  assert.equal(provider.ended.length, 1, 'once');
  assert.equal(provider.attempts, 1);
});

test('an answered call that was ended locally is completed at the provider, not cancelled', async () => {
  const { stack, provider, created, held, advance } = await lostResponse();
  await stack.adminA.end({ callId: created.callId });
  held.status = 'answered';
  advance(3 * MINUTE);
  await stack.calls.reconcileUnconfirmedDials();
  assert.deepEqual(provider.ended, [{ providerCallId: held.providerCallId, mode: 'complete' }]);
});

test('a provider call that already finished is not hung up again', async () => {
  const { stack, provider, created, held, session, advance } = await lostResponse();
  await stack.adminA.end({ callId: created.callId });
  held.status = 'completed';
  advance(3 * MINUTE);
  await stack.calls.reconcileUnconfirmedDials();
  assert.equal(provider.ended.length, 0);
  assert.equal((await session()).status, 'canceled');
});

test('a failed provider hang-up is reported and does not undo anything', async () => {
  const { stack, provider, created, held, session, advance } = await lostResponse();
  await stack.adminA.end({ callId: created.callId });
  held.status = 'ringing';
  provider.failEnd = new Error('provider down');
  advance(3 * MINUTE);
  await stack.calls.reconcileUnconfirmedDials();
  assert.equal((await session()).status, 'canceled');
  assert.ok(stack.logs.some((entry) => entry.event === 'call.reconciliation.failed' && entry.fields.step === 'end_discovered_call'));
});

test('if a callback attaches the id mid-lookup, exactly one of callback and reconciler hangs the call up', async () => {
  const { stack, provider, created, held, session, advance } = await lostResponse();
  await stack.adminA.end({ callId: created.callId });
  held.status = 'ringing';
  const lookup = provider.findDialedCalls.bind(provider);
  provider.findDialedCalls = async (input) => {
    const result = await lookup(input);
    await stack.calls.adoptDialedCall(created.callId, held.providerCallId);
    return result;
  };
  advance(3 * MINUTE);
  await stack.calls.reconcileUnconfirmedDials();
  assert.equal(provider.ended.length, 1);
  assert.equal((await session()).status, 'canceled');
});

// ---------- Races ----------

test('a callback that got there first means there is nothing left to reconcile', async () => {
  const { stack, held, created, session, advance } = await lostResponse();
  await stack.calls.adoptDialedCall(created.callId, held.providerCallId);
  await stack.calls.applyProviderEvent(providerEvent(held.providerCallId, 'ringing', 'ringing'));
  advance(3 * MINUTE);
  const report = await stack.calls.reconcileUnconfirmedDials();
  assert.equal(report.examined, 0);
  assert.equal((await session()).status, 'ringing');
});

test('callback and reconciliation at once converge on one session and one provider call', async () => {
  for (let round = 0; round < 25; round += 1) {
    const { stack, provider, held, created, session, advance } = await lostResponse();
    held.status = 'ringing';
    advance(3 * MINUTE);
    await Promise.all([
      stack.calls.reconcileUnconfirmedDials(),
      stack.calls.adoptDialedCall(created.callId, held.providerCallId).then(() =>
        stack.calls.applyProviderEvent(providerEvent(held.providerCallId, 'in-progress', 'answered'))),
      stack.calls.reconcileUnconfirmedDials(),
    ]);
    const row = await session();
    assert.equal(row.providerCallId, held.providerCallId);
    assert.equal(row.dialOutcome, 'accepted');
    assert.ok(['ringing', 'answered'].includes(row.status), row.status);
    assert.equal((await stack.adminA.list({})).items.length, 1, 'one session');
    assert.equal(provider.attempts, 1);
    // And it never regresses afterwards.
    await stack.calls.reconcileUnconfirmedDials();
    assert.ok(['ringing', 'answered'].includes((await session()).status));
  }
});

test('two instances reconciling the same call: one attempt, one provider operation', async () => {
  const { stack, provider, created, held, session, advance, now } = await lostResponse();
  const second = createCallStack({ store: stack.store, provider, now });
  await stack.adminA.end({ callId: created.callId });
  held.status = 'ringing';
  advance(3 * MINUTE);
  const reports = await Promise.all([stack.calls.reconcileUnconfirmedDials(), second.calls.reconcileUnconfirmedDials()]);
  assert.equal(reports.reduce((sum, report) => sum + report.confirmed, 0), 1);
  assert.equal(provider.ended.length, 1, 'one hang-up, however many reconcilers');
  assert.equal((await session()).reconciliationAttempts, 1);
  assert.equal(provider.attempts, 1);
});

// ---------- The no-redial invariant ----------

test('reconciliation cannot place a call: the provider is only ever asked to look up or end', async () => {
  const { stack, provider, advance } = await lostResponse();
  const creations = provider.attempts;
  provider.createCall = async () => { throw new Error('reconciliation must never dial'); };
  provider.held.length = 0;
  for (const conclusive of [false, true]) {
    provider.absenceIsConclusive = conclusive;
    advance(3 * MINUTE);
    await stack.calls.reconcileUnconfirmedDials();
  }
  provider.failLookup = new Error('down');
  advance(3 * MINUTE);
  await stack.calls.reconcileUnconfirmedDials();
  assert.equal(provider.attempts, creations);
  assert.equal(provider.created.length, 1);
});

test('source: nothing on the reconciliation path calls createCall', () => {
  const source = readFileSync(new URL('../src/calls/service.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async reconcileUnconfirmedDials');
  const end = source.indexOf('/** Where an account\'s outbound calls still in progress');
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /createCall|executeOutbound|placeOutbound|claimOutboundDial|\.create\(/);
  const transition = readFileSync(new URL('../src/calls/transition.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(transition.slice(transition.indexOf('export async function claimReconciliation')), /createCall/);
});

// ---------- Observability ----------

test('reconciliation logs its steps with correlation ids and masked numbers', async () => {
  const { stack, held, created, advance } = await lostResponse();
  held.status = 'ringing';
  advance(3 * MINUTE);
  await stack.calls.reconcileUnconfirmedDials();
  const events = stack.logs.map((entry) => entry.event);
  assert.ok(events.includes('call.reconciliation.started') && events.includes('call.reconciliation.confirmed') && events.includes('call.reconciliation.summary'));
  const started = stack.logs.find((entry) => entry.event === 'call.reconciliation.started')!;
  assert.equal(started.fields.callId, created.callId);
  assert.equal(started.fields.attempt, 1);
  const confirmed = stack.logs.find((entry) => entry.event === 'call.reconciliation.confirmed')!;
  assert.equal(confirmed.fields.providerCallId, held.providerCallId);
  assert.doesNotMatch(JSON.stringify(stack.logs), /\+1555\d{7}/, 'no full numbers');
});

// ---------- Cron ----------

const SECRET = 'cron-secret-for-tests-0123456789';
function cronApp(store: CallSessionStore, provider: FakeCallProvider, extra: Record<string, unknown> = {}) {
  return createApp({
    repository: new InMemoryConversationRepository(), messagingProvider: new FakeMessagingProvider(),
    callSessionStore: store, callProvider: provider, cronSecret: SECRET, ...extra,
  });
}
const unconfirmed = (id: string, claimedAt: Date, to = freshNumber()): CallSessionRecord => ({
  id, accountId: 'acct_cron', direction: 'outbound', status: 'initiating', provider: 'twilio', providerCallId: null,
  from: '+15550007000', to, conversationId: null, startedAt: null, answeredAt: null, endedAt: null, endReason: null,
  createdAt: claimedAt, updatedAt: claimedAt, version: 1, requestedBy: 'usr_cron', traceId: null, idempotencyKey: uniq('cron'),
  requestFingerprint: null, endClaimedAt: null, lastProviderStatus: null, objective: null,
  dialClaimedAt: claimedAt, dialOutcome: 'unconfirmed', reconciliationAttempts: 0, lastReconciliationAt: null,
});
const ago = (ms: number) => new Date(Date.now() - ms);
const holdFor = (provider: FakeCallProvider, record: CallSessionRecord, status: 'ringing' | 'completed' = 'ringing') => {
  const providerCallId = `CAcron${Math.random().toString(16).slice(2, 12)}${provider.held.length}`;
  provider.held.push({ providerCallId, from: record.from!, to: record.to!, status, createdAt: record.dialClaimedAt! });
  return providerCallId;
};

test('cron: unauthenticated and wrongly authenticated requests cannot trigger reconciliation', async () => {
  const store = new InMemoryCallSessionStore();
  const provider = new FakeCallProvider();
  const record = unconfirmed(uniq('call'), ago(10 * MINUTE));
  await store.insert(record);
  holdFor(provider, record);
  const app = cronApp(store, provider);
  for (const header of [undefined, 'Bearer wrong', `Bearer ${SECRET}x`, SECRET, 'Basic abc', 'Bearer']) {
    const response = await request(app).get('/api/internal/cron/reconcile-calls').set(...(header ? ['Authorization', header] as const : ['X-None', '1'] as const));
    assert.equal(response.status, 401, String(header));
    assert.doesNotMatch(response.text, new RegExp(SECRET));
  }
  assert.equal(provider.lookups.length, 0, 'nothing ran');
  assert.equal((await store.findById(record.id))!.reconciliationAttempts, 0);
});

test('cron: with no secret configured every request is refused', async () => {
  const provider = new FakeCallProvider();
  const app = cronApp(new InMemoryCallSessionStore(), provider, { cronSecret: undefined });
  for (const header of ['Bearer ', 'Bearer undefined', 'Bearer anything']) {
    assert.equal((await request(app).get('/api/internal/cron/reconcile-calls').set('Authorization', header)).status, 503);
  }
  assert.equal(provider.lookups.length, 0);
});

test('cron: an authorized run reconciles and reports, an empty queue is fine, and repeating is safe', async () => {
  const store = new InMemoryCallSessionStore();
  const provider = new FakeCallProvider();
  const app = cronApp(store, provider);
  const empty = await request(app).get('/api/internal/cron/reconcile-calls').set('Authorization', `Bearer ${SECRET}`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.examined, 0);

  const record = unconfirmed(uniq('call'), ago(10 * MINUTE));
  await store.insert(record);
  const sid = holdFor(provider, record);
  const first = await request(app).get('/api/internal/cron/reconcile-calls').set('Authorization', `Bearer ${SECRET}`);
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.status, first.body.examined, first.body.confirmed], ['ok', 1, 1]);
  const second = await request(app).get('/api/internal/cron/reconcile-calls').set('Authorization', `Bearer ${SECRET}`);
  assert.equal(second.body.examined, 0);
  const row = (await store.findById(record.id))!;
  assert.equal(row.providerCallId, sid);
  assert.equal(row.status, 'ringing');
  assert.equal(provider.attempts, 0, 'the cron route never dials');
});

test('cron: a run is bounded by the configured batch size, and a fresh dial is left alone', async () => {
  const store = new InMemoryCallSessionStore();
  const provider = new FakeCallProvider();
  const old = [0, 1, 2, 3, 4].map((index) => unconfirmed(uniq('call'), ago((20 - index) * MINUTE)));
  for (const record of old) { await store.insert(record); holdFor(provider, record); }
  const fresh = unconfirmed(uniq('call'), ago(5_000));
  await store.insert(fresh);
  holdFor(provider, fresh);
  const app = cronApp(store, provider, { callReconciliation: { batchSize: 2 } });
  const run = () => request(app).get('/api/internal/cron/reconcile-calls').set('Authorization', `Bearer ${SECRET}`);
  assert.equal((await run()).body.examined, 2);
  assert.equal((await run()).body.examined, 2);
  assert.equal((await run()).body.examined, 1);
  assert.equal((await run()).body.examined, 0);
  assert.equal((await store.findById(fresh.id))!.providerCallId, null, 'too recent to look for');
});

test('cron: reconciliation can be switched off, and nothing else can be switched on', async () => {
  const store = new InMemoryCallSessionStore();
  const provider = new FakeCallProvider();
  const record = unconfirmed(uniq('call'), ago(10 * MINUTE));
  await store.insert(record);
  holdFor(provider, record);
  const app = cronApp(store, provider, { callReconciliation: { enabled: false } });
  const response = await request(app).get('/api/internal/cron/reconcile-calls').set('Authorization', `Bearer ${SECRET}`);
  assert.equal(response.body.status, 'disabled');
  assert.equal((await store.findById(record.id))!.reconciliationAttempts, 0);
});

test('cron: a provider that cannot be reached does not fail the run or the call', async () => {
  const store = new InMemoryCallSessionStore();
  const provider = new FakeCallProvider();
  provider.failLookup = new Error('twilio down');
  const record = unconfirmed(uniq('call'), ago(10 * MINUTE));
  await store.insert(record);
  const response = await request(cronApp(store, provider)).get('/api/internal/cron/reconcile-calls').set('Authorization', `Bearer ${SECRET}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.failed, 1);
  assert.equal((await store.findById(record.id))!.status, 'initiating');
});

// ---------- Real Postgres, two application instances ----------

test('Postgres, two instances, cron on both at once: one attempt, one hang-up, no dial (repeated)', postgresOnly, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 20 });
  t.after(() => pool.end());
  const store = new PostgresCallSessionStore(pool);
  await store.initialize();
  for (let round = 0; round < 6; round += 1) {
    const provider = new FakeCallProvider();
    const origin = createCallStack({ store, provider });
    provider.loseResponse = true;
    const created = await origin.adminA.create({ direction: 'outbound', to: freshNumber() }, { idempotencyKey: uniq('pg') });
    provider.loseResponse = false;
    // The owner ended it meanwhile, so the provider call that turns up has to be hung up.
    await origin.adminA.end({ callId: created.callId });
    const backdated = ago(15 * MINUTE);
    await pool.query('UPDATE call_sessions SET dial_claimed_at = $2 WHERE id = $1', [created.callId, backdated]);
    const held = provider.held.at(-1)!;
    held.createdAt = backdated;
    held.status = 'ringing';

    const a = cronApp(store, provider);
    const b = cronApp(store, provider);
    const responses = await Promise.all([a, b, a, b].map((app) => request(app).get('/api/internal/cron/reconcile-calls').set('Authorization', `Bearer ${SECRET}`)));
    assert.ok(responses.every((response) => response.status === 200));
    assert.equal(responses.reduce((sum, response) => sum + response.body.confirmed, 0), 1, 'one reconciler wins');
    assert.equal(provider.ended.length, 1, 'one provider operation');
    assert.equal(provider.attempts, 1, 'no second call');
    const row = (await pool.query('SELECT status, provider_call_id, dial_outcome, reconciliation_attempts FROM call_sessions WHERE id = $1', [created.callId])).rows[0];
    assert.deepEqual([row.status, row.provider_call_id, row.dial_outcome, row.reconciliation_attempts], ['canceled', held.providerCallId, 'accepted', 1]);
  }
});

test('Postgres: callback and reconciliation race converge (repeated)', postgresOnly, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 20 });
  t.after(() => pool.end());
  const store = new PostgresCallSessionStore(pool);
  await store.initialize();
  for (let round = 0; round < 10; round += 1) {
    const provider = new FakeCallProvider();
    const one = createCallStack({ store, provider });
    const two = createCallStack({ store, provider });
    provider.loseResponse = true;
    const created = await one.adminA.create({ direction: 'outbound', to: freshNumber() }, { idempotencyKey: uniq('pgrace') });
    provider.loseResponse = false;
    const backdated = ago(15 * MINUTE);
    await pool.query('UPDATE call_sessions SET dial_claimed_at = $2 WHERE id = $1', [created.callId, backdated]);
    const held = provider.held.at(-1)!;
    held.createdAt = backdated;
    held.status = 'ringing';
    await Promise.all([
      one.calls.reconcileUnconfirmedDials(),
      two.calls.adoptDialedCall(created.callId, held.providerCallId).then(() => two.calls.applyProviderEvent(providerEvent(held.providerCallId, 'in-progress', 'answered'))),
    ]);
    const row = (await pool.query('SELECT status, provider_call_id, dial_outcome FROM call_sessions WHERE id = $1', [created.callId])).rows[0];
    assert.equal(row.provider_call_id, held.providerCallId);
    assert.equal(row.dial_outcome, 'accepted');
    assert.ok(['ringing', 'answered'].includes(row.status), row.status);
    assert.equal(provider.attempts, 1);
  }
});

// ---------- The Twilio adapter's lookup (against a stub of the SDK, not Twilio) ----------

test('the Twilio adapter lists by number pair, keeps calls inside the window, and translates status to the domain', async () => {
  const listed: unknown[] = [];
  const at = (iso: string) => new Date(iso);
  const client = {
    calls: Object.assign(() => ({ update: async () => undefined }), {
      create: async () => { throw new Error('lookup must not create'); },
      list: async (options: unknown) => {
        listed.push(options);
        return [
          { sid: 'CA1', status: 'ringing', dateCreated: at('2026-06-01T12:00:05Z') },
          { sid: 'CA2', status: 'no-answer', dateCreated: at('2026-06-01T12:01:00Z') },
          { sid: 'CA3', status: 'in-progress', dateCreated: at('2026-05-31T12:00:00Z') },
          { sid: 'CA4', status: 'something-new', dateCreated: at('2026-06-01T12:00:10Z') },
        ];
      },
    }),
  } as unknown as import('../src/telephony/twilio-call-provider.js').TwilioCallsClient;
  const { TwilioCallProvider } = await import('../src/telephony/twilio-call-provider.js');
  const provider = new TwilioCallProvider('AC', 'token', { client });
  const found = await provider.findDialedCalls({ from: '+15550001000', to: '+15551230000', createdAfter: at('2026-06-01T11:59:30Z'), createdBefore: at('2026-06-01T12:05:00Z') });
  assert.deepEqual(listed, [{ from: '+15550001000', to: '+15551230000', pageSize: 20, limit: 20 }]);
  assert.equal(found.outcome, 'found');
  if (found.outcome === 'found') {
    assert.deepEqual(found.calls.map((call) => [call.providerCallId, call.status]), [['CA1', 'ringing'], ['CA2', 'no_answer'], ['CA4', null]]);
  }
  const none = await provider.findDialedCalls({ from: '+15550001000', to: '+15551230000', createdAfter: at('2027-01-01T00:00:00Z'), createdBefore: at('2027-01-02T00:00:00Z') });
  assert.deepEqual(none, { outcome: 'not_found', conclusive: false }, 'absence is never conclusive for Twilio');
});
