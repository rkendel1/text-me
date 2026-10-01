import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import pg from 'pg';
import request from 'supertest';

import { appPortSessionFor } from '../src/appport/session.js';
import { REFERENCE_RATES } from '../src/billing/call-reference-rates.js';
import { CallCostLedger, type LedgerCall } from '../src/calls/cost/ledger.js';
import { StaticPriceBook, type PriceRate } from '../src/calls/cost/pricing.js';
import { InMemoryCallUsageStore, type CallUsageStore } from '../src/calls/cost/store.js';
import { FakeCallProvider, type CallProvider, type ProviderUsageObservation } from '../src/calls/provider.js';
import { createApp } from '../src/http-app.js';
import { FakeMessagingProvider } from '../src/messaging/fake-provider.js';
import { PostgresCallSessionStore } from '../src/repositories/postgres-call-session-repository.js';
import { PostgresCallUsageStore } from '../src/repositories/postgres-call-usage-repository.js';
import { TwilioProvider } from '../src/telephony/twilio-provider.js';
import { CallCapabilityClient } from '../src/appport/call-client.js';
import { onboardTenant } from './support/tenant.js';
import { TwilioCallProvider, type TwilioCallsClient } from '../src/telephony/twilio-call-provider.js';
import { extractRealtimeUsage } from '../src/voice/realtime/usage.js';
import { InMemoryConversationRepository } from './support/in-memory-repository.js';
import { createCallStack, tenant, mcpClientFor } from './support/calls.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresOnly = { skip: databaseUrl ? undefined : 'set TEST_DATABASE_URL to run against Postgres' };
let counter = 0;
const uniq = (label: string) => `${label}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const freshNumber = () => `+1555${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
const T0 = new Date('2026-10-02T12:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const rate = (over: Partial<PriceRate> & Pick<PriceRate, 'provider' | 'product' | 'metric' | 'rate'>): PriceRate => ({
  id: `${over.provider}.${over.product}.${over.metric}@${(over.effectiveFrom ?? new Date('2026-01-01')).toISOString().slice(0, 10)}`,
  unit: 'minute', currency: 'USD', effectiveFrom: new Date('2026-01-01T00:00:00Z'), ...over,
});
/** A price book with an AI rate, which the reference book deliberately does not have. */
const aiRates = [
  rate({ provider: 'openai', product: 'realtime', metric: 'audio_input_tokens', unit: 'token', per: 1_000_000, rate: 32, model: 'gpt-realtime-2' }),
  rate({ provider: 'openai', product: 'realtime', metric: 'audio_output_tokens', unit: 'token', per: 1_000_000, rate: 64, model: 'gpt-realtime-2' }),
];
const book = (...extra: PriceRate[]) => new StaticPriceBook([...REFERENCE_RATES, ...extra]);

const call = (over: Partial<LedgerCall> = {}): LedgerCall => ({
  id: uniq('call'), accountId: uniq('acct'), direction: 'outbound', status: 'completed', provider: 'twilio', answeredAt: T0, endedAt: at(10), ...over,
});
const twilioReport = (seconds: number, extra: Partial<ProviderUsageObservation> = {}) => ({
  providerCallId: 'CA123', observations: [{ key: 'duration', category: 'telephony' as const, product: 'voice_outbound', metric: 'duration' as const, quantity: seconds, unit: 'second' as const, basis: 'estimated' as const, ...extra }],
});
const ledgerOver = (store: CallUsageStore = new InMemoryCallUsageStore(), priceBook = book()) => new CallCostLedger(store, { priceBook, now: () => at(30), logger: { log: () => undefined } });

// ---------- Pricing: usage is priced separately, with the rate kept ----------

test('usage is priced by the price book and the rate used is kept on the cost component', async () => {
  const ledger = ledgerOver();
  const c = call();
  const { record } = await ledger.record(c, {
    subject: 's1', idempotencyKey: 'k1', category: 'telephony', provider: 'twilio', product: 'voice_outbound', metric: 'duration', quantity: 600, unit: 'second',
    basis: 'estimated', source: 'provider_callback', occurredAt: T0,
  });
  assert.equal(record.component.amount, 0.14, '10 minutes at 0.014 per minute');
  assert.equal(record.component.rateSource, 'rate_card');
  assert.equal(record.component.rate, 0.014);
  assert.equal(record.component.rateId, 'twilio.voice_outbound.duration@2026-10-01');
  assert.equal(record.component.pricedQuantity, 10, 'converted to the rate\'s unit');
  assert.equal(record.component.currency, 'USD');
});

test('a provider-stated charge is used as it is, and no rate is invented for it', async () => {
  const { record } = await ledgerOver().record(call(), {
    subject: 's', idempotencyKey: 'k', category: 'telephony', provider: 'twilio', product: 'voice_outbound', metric: 'duration', quantity: 61, unit: 'second',
    basis: 'final', source: 'provider_usage_report', occurredAt: T0, reportedAmount: 0.028, reportedCurrency: 'USD',
  });
  assert.deepEqual([record.component.amount, record.component.rateSource, record.component.rateId], [0.028, 'provider_reported', null]);
});

test('usage with no rate is recorded and left unpriced, never guessed', async () => {
  const ledger = ledgerOver();
  const c = call();
  const { record } = await ledger.record(c, {
    subject: 's', idempotencyKey: 'k', category: 'ai_voice', provider: 'someone', product: 'realtime', model: 'm', metric: 'audio_input_tokens', quantity: 1000, unit: 'token',
    basis: 'final', source: 'ai_runtime', occurredAt: T0,
  });
  assert.deepEqual([record.component.amount, record.component.rateSource], [null, 'unpriced']);
  const summary = await ledger.summarize(c);
  assert.equal(summary.unpricedUsage, 1);
  assert.equal(summary.status, 'estimated', 'not final while something is unpriced');
});

test('rates are versioned by date and a model-specific rate wins', () => {
  const rates = new StaticPriceBook([
    rate({ provider: 'p', product: 'x', metric: 'duration', rate: 1, effectiveTo: new Date('2026-06-01T00:00:00Z') }),
    rate({ provider: 'p', product: 'x', metric: 'duration', rate: 2, effectiveFrom: new Date('2026-06-01T00:00:00Z') }),
    rate({ provider: 'p', product: 'x', metric: 'duration', rate: 9, model: 'special', effectiveFrom: new Date('2026-06-01T00:00:00Z') }),
  ]);
  const q = { provider: 'p', product: 'x', metric: 'duration', model: null as string | null };
  assert.equal(rates.resolve({ ...q, at: new Date('2026-05-31T23:59:59Z') })!.rate, 1);
  assert.equal(rates.resolve({ ...q, at: new Date('2026-06-01T00:00:00Z') })!.rate, 2);
  assert.equal(rates.resolve({ ...q, model: 'special', at: new Date('2026-07-01') })!.rate, 9);
  assert.equal(rates.resolve({ ...q, at: new Date('2025-01-01') }), null);
  assert.throws(() => new StaticPriceBook([rate({ provider: 'p', product: 'x', metric: 'd', rate: -1 })]));
});

test('historical cost does not change when prices change', async () => {
  const store = new InMemoryCallUsageStore();
  const before = ledgerOver(store, new StaticPriceBook([rate({ provider: 'twilio', product: 'voice_outbound', metric: 'duration', rate: 0.014 })]));
  const c = call();
  await before.record(c, { subject: 'a', idempotencyKey: 'a', category: 'telephony', provider: 'twilio', product: 'voice_outbound', metric: 'duration', quantity: 600, unit: 'second', basis: 'final', source: 'provider_usage_report', occurredAt: T0 });
  const was = await before.summarize(c);
  // Prices double tomorrow. The ledger over the same store, with the new book, reads the same history.
  const after = ledgerOver(store, new StaticPriceBook([
    rate({ provider: 'twilio', product: 'voice_outbound', metric: 'duration', rate: 0.014, effectiveTo: at(60 * 24) }),
    rate({ provider: 'twilio', product: 'voice_outbound', metric: 'duration', rate: 0.028, effectiveFrom: at(60 * 24), id: 'new' }),
  ]));
  assert.deepEqual(await after.summarize(c), was);
  assert.equal(was.finalCost, 0.14);
  // New usage after the change is priced at the new rate; the old usage still is not.
  const later = call();
  await after.record(later, { subject: 'b', idempotencyKey: 'b', category: 'telephony', provider: 'twilio', product: 'voice_outbound', metric: 'duration', quantity: 600, unit: 'second', basis: 'final', source: 'provider_usage_report', occurredAt: at(60 * 25) });
  assert.equal((await after.summarize(later)).finalCost, 0.28);
  assert.equal((await after.summarize(c)).finalCost, 0.14);
});

// ---------- Append-only, idempotent, estimated vs final ----------

test('the same observation recorded twice adds nothing (replayed webhook, retried job)', async () => {
  const store = new InMemoryCallUsageStore();
  const ledger = ledgerOver(store);
  const c = call();
  const event = { provider: 'twilio', providerCallId: 'CA1', eventId: 'CA1:completed', durationSeconds: 600 };
  await ledger.recordProviderDuration(c, event);
  await ledger.recordProviderDuration(c, event);
  await ledger.recordProviderDuration(c, event);
  assert.equal((await store.listForCall(c.accountId, c.id)).length, 1);
  assert.equal((await ledger.summarize(c)).estimatedCost, 0.14);
});

test('an estimate is superseded by the authoritative figure without losing the original observation', async () => {
  const store = new InMemoryCallUsageStore();
  const ledger = ledgerOver(store);
  const c = call();
  await ledger.recordProviderDuration(c, { provider: 'twilio', providerCallId: 'CA123', eventId: 'CA123:completed', durationSeconds: 600 });
  const interim = await ledger.summarize(c);
  assert.deepEqual([interim.status, interim.estimatedCost, interim.finalCost], ['estimated', 0.14, null], 'a finished call is not final merely because it ended');

  await ledger.recordProviderReport(c, twilioReport(600, { basis: 'final', reportedAmount: 0.0131, currency: 'USD' }));
  const settled = await ledger.summarize(c);
  assert.deepEqual([settled.status, settled.estimatedCost, settled.finalCost], ['final', 0.0131, 0.0131]);
  const all = await store.listForCall(c.accountId, c.id);
  assert.equal(all.length, 2, 'both observations are still in the ledger');
  assert.deepEqual(all.map((record) => record.event.basis).sort(), ['estimated', 'final']);
  assert.deepEqual(all.find((record) => record.event.basis === 'estimated')!.component.amount, 0.14, 'the estimate was not rewritten');
  // And a later estimate for the same subject cannot displace the authoritative one.
  await ledger.recordProviderDuration(c, { provider: 'twilio', providerCallId: 'CA123', eventId: 'CA123:completed:late', durationSeconds: 700 });
  assert.equal((await ledger.summarize(c)).finalCost, 0.0131);
});

test('an interim provider figure is an estimate; a rated one is final', async () => {
  const ledger = ledgerOver();
  const c = call();
  await ledger.recordProviderReport(c, twilioReport(120));
  assert.equal((await ledger.summarize(c)).status, 'estimated');
  await ledger.recordProviderReport(c, twilioReport(120, { basis: 'final', reportedAmount: 0.028, currency: 'USD' }));
  assert.equal((await ledger.summarize(c)).status, 'final');
});

test('the ledger offers no way to change or remove a recorded observation', () => {
  const sources = ['src/calls/cost/store.ts', 'src/calls/cost/ledger.ts', 'src/repositories/postgres-call-usage-repository.ts'].map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(sources, /\b(UPDATE|DELETE)\b\s+(FROM\s+)?call_(usage_events|cost_components)/i);
  assert.doesNotMatch(sources, /\b(update|delete|remove)\w*\(/);
  // And nothing else in the application writes to these tables.
  const others = readdirSync('src', { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts') && !file.includes('postgres-call-usage-repository'));
  for (const file of others) assert.doesNotMatch(readFileSync(join('src', file), 'utf8'), /(UPDATE|DELETE FROM|INSERT INTO)\s+call_(usage_events|cost_components)/i, file);
});

// ---------- Estimates while active, and calls that never connect ----------

test('an active call has a derived estimate that is never stored', async () => {
  const store = new InMemoryCallUsageStore();
  const ledger = new CallCostLedger(store, { priceBook: book(), now: () => at(5), logger: { log: () => undefined } });
  const active = call({ status: 'in_progress', endedAt: null });
  const summary = await ledger.summarize(active);
  assert.deepEqual([summary.status, summary.derived, summary.estimatedCost, summary.finalCost], ['estimated', true, 0.07, null], '5 minutes so far at 0.014');
  assert.equal((await store.listForCall(active.accountId, active.id)).length, 0, 'reading never writes');
});

test('a call that never connected costs nothing and nothing is invented', async () => {
  const ledger = ledgerOver();
  const never = call({ status: 'no_answer', answeredAt: null, endedAt: at(1) });
  const summary = await ledger.summarize(never);
  assert.deepEqual([summary.status, summary.estimatedCost, summary.finalCost, summary.breakdown], ['unknown', null, null, []]);
  // The carrier reports zero connected seconds: that is a figure, an estimate until the carrier rates it.
  await ledger.recordProviderDuration(never, { provider: 'twilio', providerCallId: 'CA9', eventId: 'CA9:no-answer', durationSeconds: 0 });
  const zero = await ledger.summarize(never);
  assert.deepEqual([zero.status, zero.estimatedCost], ['estimated', 0]);
});

test('a call that connected and then failed keeps its partial usage, once', async () => {
  const ledger = ledgerOver();
  const failed = call({ status: 'failed', endedAt: at(2) });
  await ledger.recordProviderDuration(failed, { provider: 'twilio', providerCallId: 'CAf', eventId: 'CAf:failed', durationSeconds: 95 });
  await ledger.recordProviderDuration(failed, { provider: 'twilio', providerCallId: 'CAf', eventId: 'CAf:failed', durationSeconds: 95 });
  const summary = await ledger.summarize(failed);
  assert.equal(summary.estimatedCost, 0.022167, '95 seconds at 0.014 per minute, not a full minute and not ten');
  assert.equal(summary.status, 'estimated');
});

// ---------- AI usage ----------

test('realtime usage is extracted only from what the model reported', () => {
  assert.deepEqual(extractRealtimeUsage({ response: { usage: { input_tokens: 100, output_tokens: 50, input_token_details: { audio_tokens: 80, text_tokens: 20, cached_tokens: 10 }, output_token_details: { audio_tokens: 40, text_tokens: 10 } } } }),
    { audio_input_tokens: 80, text_input_tokens: 20, cached_input_tokens: 10, audio_output_tokens: 40, text_output_tokens: 10 });
  assert.deepEqual(extractRealtimeUsage({ response: { usage: { input_tokens: 7, output_tokens: 3 } } }), { input_tokens: 7, output_tokens: 3 });
  assert.deepEqual(extractRealtimeUsage({ response: { status: 'completed' } }), {}, 'no usage: nothing is made up');
  assert.deepEqual(extractRealtimeUsage(null), {});
  assert.deepEqual(extractRealtimeUsage({ response: { usage: { input_tokens: -5, output_tokens: 'x' } } }), {});
});

test('AI usage is recorded against the model and vendor, priced from configuration, and independent of the carrier', async () => {
  const ledger = ledgerOver(new InMemoryCallUsageStore(), book(...aiRates));
  const onTwilio = call({ provider: 'twilio' });
  const onTelnyx = call({ provider: 'telnyx' });
  for (const c of [onTwilio, onTelnyx]) {
    await ledger.recordAiUsage(c, { modelId: 'openai/gpt-realtime-2', responseId: 'resp_1', metrics: { audio_input_tokens: 1_000_000, audio_output_tokens: 500_000, cached_input_tokens: 10 } });
    await ledger.recordAiUsage(c, { modelId: 'openai/gpt-realtime-2', responseId: 'resp_1', metrics: { audio_input_tokens: 1_000_000, audio_output_tokens: 500_000, cached_input_tokens: 10 } });
  }
  const a = await ledger.summarize(onTwilio);
  const b = await ledger.summarize(onTelnyx);
  assert.equal(a.breakdown.find((entry) => entry.category === 'ai_voice')!.amount, 64, '32 + 0.5 * 64');
  const ai = (summary: typeof a) => summary.breakdown.find((entry) => entry.category === 'ai_voice');
  assert.deepEqual(ai(a), ai(b), 'the same AI usage costs the same whichever carrier handled the call');
  assert.equal(a.unpricedUsage, 1, 'cached tokens have no rate configured: recorded, unpriced');
  const rows = await ledger.listForCall(onTwilio.accountId, onTwilio.id);
  assert.equal(rows.length, 3, 'a repeated response adds nothing');
  assert.deepEqual([rows[0].event.provider, rows[0].event.model, rows[0].event.product, rows[0].event.basis], ['openai', 'gpt-realtime-2', 'realtime', 'final']);
});

test('a runtime that reported nothing leaves the call\'s accounting intact', async () => {
  const ledger = ledgerOver();
  const c = call();
  await ledger.recordProviderDuration(c, { provider: 'twilio', providerCallId: 'CAx', eventId: 'CAx:completed', durationSeconds: 60 });
  await ledger.recordAiUsage(c, { modelId: 'openai/gpt-realtime-2', responseId: 'r', metrics: {} });
  const summary = await ledger.summarize(c);
  assert.deepEqual(summary.breakdown.map((entry) => entry.category), ['telephony']);
});

test('media stream and recording usage are recorded as observed, as estimates', async () => {
  const ledger = ledgerOver();
  const c = call();
  await ledger.recordMediaStream(c, { streamSid: 'MZ1', seconds: 570, startedAt: T0 });
  await ledger.recordMediaStream(c, { streamSid: 'MZ1', seconds: 570, startedAt: T0 });
  await ledger.recordRecording(c, { recordingSid: 'RE1', seconds: 60, providerCallId: 'CAr' });
  const summary = await ledger.summarize(c);
  const by = Object.fromEntries(summary.breakdown.map((entry) => [entry.category, entry]));
  assert.equal(by.media.amount, 0.04180, '9.5 minutes at 0.0044');
  assert.equal(by.recording.amount, 0.0025);
  assert.ok(summary.breakdown.every((entry) => entry.basis === 'estimated'));
  assert.equal(summary.status, 'estimated');
});

// ---------- Breakdown and aggregation ----------

test('a call\'s cost breaks down by category', async () => {
  const ledger = ledgerOver(new InMemoryCallUsageStore(), book(...aiRates));
  const c = call();
  await ledger.recordProviderReport(c, twilioReport(600, { basis: 'final', reportedAmount: 0.14, currency: 'USD' }));
  await ledger.recordMediaStream(c, { streamSid: 'MZ', seconds: 600, startedAt: T0 });
  await ledger.recordAiUsage(c, { modelId: 'openai/gpt-realtime-2', responseId: 'r', metrics: { audio_input_tokens: 1_000_000 } });
  const summary = await ledger.summarize(c);
  assert.deepEqual(summary.breakdown.map((entry) => [entry.category, entry.amount, entry.basis]), [['telephony', 0.14, 'final'], ['media', 0.044, 'estimated'], ['ai_voice', 32, 'final']]);
  assert.equal(summary.estimatedCost, 32.184);
  assert.equal(summary.finalCost, null, 'media is still an estimate');
});

test('aggregation answers cost per call, direction, carrier, model, outcome, day and month from the ledger', async () => {
  const stack = createCallStack({ priceBook: book(...aiRates) });
  const make = async (direction: 'inbound' | 'outbound', provider: string, to: string, day: number) => {
    const session = direction === 'outbound'
      ? await stack.calls.create({ accountId: 'acct_a' }, { direction, to, from: '+15550001000' })
      : await stack.calls.create({ accountId: 'acct_a', canIngest: true }, { direction, providerCallId: uniq('CAin'), from: to, to: '+15550001000' });
    return { ...session, provider, answeredAt: at(day * 24 * 60), endedAt: at(day * 24 * 60 + 10) };
  };
  const ledger = stack.usage;
  const one = await make('outbound', 'twilio', '+15551230001', 0);
  const two = await make('inbound', 'twilio', '+15551230002', 40);
  const store = stack.store as import('../src/calls/store.js').InMemoryCallSessionStore;
  await store.mutate(one.id, () => ({ patch: { status: 'completed' as const } }));
  await store.mutate(two.id, () => ({ patch: { status: 'failed' as const } }));
  await ledger.record({ ...one, provider: 'twilio' }, { subject: 'o', idempotencyKey: 'o', category: 'telephony', provider: 'twilio', product: 'voice_outbound', metric: 'duration', quantity: 600, unit: 'second', basis: 'final', source: 'provider_usage_report', occurredAt: at(0), reportedAmount: 0.14, reportedCurrency: 'USD' });
  await ledger.record({ ...one }, { subject: 'o', idempotencyKey: 'o-est', category: 'telephony', provider: 'twilio', product: 'voice_outbound', metric: 'duration', quantity: 600, unit: 'second', basis: 'estimated', source: 'provider_callback', occurredAt: at(0) });
  await ledger.record({ ...one }, { subject: 'ai1', idempotencyKey: 'ai1', category: 'ai_voice', provider: 'openai', product: 'realtime', model: 'gpt-realtime-2', metric: 'audio_input_tokens', quantity: 1_000_000, unit: 'token', basis: 'final', source: 'ai_runtime', occurredAt: at(0) });
  await ledger.record({ ...two }, { subject: 't2', idempotencyKey: 't2', category: 'telephony', provider: 'twilio', product: 'voice_inbound', metric: 'duration', quantity: 60, unit: 'second', basis: 'estimated', source: 'provider_callback', occurredAt: at(40 * 24 * 60) });

  const by = async (dimension: Parameters<CallCostLedger['aggregate']>[0]['dimension']) =>
    Object.fromEntries((await ledger.aggregate({ accountId: 'acct_a', dimension })).groups.map((group) => [group.key, group]));
  const category = await by('category');
  assert.equal(category.telephony.amount, 0.1485, '0.14 (the estimate it supersedes is not added) + 0.0085');
  assert.equal(category.telephony.finalAmount, 0.14);
  assert.equal(category.ai_voice.amount, 32);
  assert.equal((await by('direction')).inbound.amount, 0.0085);
  assert.equal((await by('provider')).openai.amount, 32);
  assert.equal((await by('model'))['gpt-realtime-2'].calls, 1);
  const outcome = await by('outcome');
  assert.equal(outcome.completed.costPerCall, 32.14, 'cost per completed call');
  assert.equal(outcome.failed.calls, 1);
  assert.deepEqual(Object.keys(await by('day')).length, 2);
  assert.deepEqual(Object.keys(await by('month')).sort(), ['2026-10', '2026-11']);
  const window = await ledger.aggregate({ accountId: 'acct_a', dimension: 'category', from: at(30 * 24 * 60) });
  assert.deepEqual(window.groups.map((group) => group.key), ['telephony'], 'a window');
  assert.equal((await ledger.aggregate({ accountId: 'acct_b', dimension: 'category' })).groups.length, 0, 'another account sees none of it');
});

// ---------- Provider boundary ----------

const assertNormalized = (observation: ProviderUsageObservation) => {
  assert.deepEqual(Object.keys(observation).filter((key) => !['key', 'category', 'product', 'metric', 'quantity', 'unit', 'basis', 'reportedAmount', 'currency', 'metadata'].includes(key)), [], 'only normalized fields');
  assert.ok(['telephony', 'media', 'ai_voice', 'recording', 'amd', 'other'].includes(observation.category));
  assert.ok(Number.isFinite(observation.quantity) && observation.quantity >= 0);
  assert.ok(['estimated', 'final'].includes(observation.basis));
  if (observation.reportedAmount !== undefined) assert.ok(observation.reportedAmount >= 0 && observation.currency, 'a reported charge is absolute and has a currency');
};

const twilioStub = (call: Record<string, unknown> | null, recordings: Array<Record<string, unknown>> = []) => new TwilioCallProvider('AC', 'token', {
  client: { calls: Object.assign(() => ({ fetch: async () => call, update: async () => undefined, recordings: { list: async () => recordings } }), { create: async () => { throw new Error('no'); }, list: async () => [] }) } as unknown as TwilioCallsClient,
});

/** What every CallProvider must satisfy for the cost ledger. A future carrier's adapter is run through this same function. */
async function usageContract(name: string, makeProvider: (scenario: 'rated' | 'interim' | 'nothing') => Promise<{ provider: CallProvider; providerCallId: string }>) {
  const rated = await makeProvider('rated');
  const report = await rated.provider.getCallUsage(rated.providerCallId);
  assert.ok(report, `${name}: reports usage for a rated call`);
  assert.equal(report!.providerCallId, rated.providerCallId);
  report!.observations.forEach(assertNormalized);
  assert.ok(report!.observations.some((observation) => observation.basis === 'final' && observation.reportedAmount !== undefined), `${name}: a rated call is final with its charge`);
  const interim = (await (await makeProvider('interim')).provider.getCallUsage(rated.providerCallId))!;
  interim.observations.forEach(assertNormalized);
  assert.ok(interim.observations.every((observation) => observation.basis === 'estimated' && observation.reportedAmount === undefined), `${name}: an unrated call is an estimate`);
  assert.equal(await (await makeProvider('nothing')).provider.getCallUsage(rated.providerCallId), null, `${name}: nothing to report is null`);
  // Whatever the carrier, the ledger records it the same way.
  const ledger = ledgerOver();
  const c = call({ provider: rated.provider.name });
  assert.deepEqual(await ledger.recordProviderReport(c, report!), { recorded: report!.observations.length, duplicates: 0 });
  assert.deepEqual(await ledger.recordProviderReport(c, report!), { recorded: 0, duplicates: report!.observations.length });
}

test('provider contract: the Twilio adapter reports normalized usage', async () => {
  await usageContract('twilio', async (scenario) => ({
    providerCallId: 'CA123',
    provider: twilioStub(scenario === 'nothing' ? { duration: null } : { duration: '125', direction: 'outbound-api', status: 'completed', price: scenario === 'rated' ? '-0.0350' : null, priceUnit: scenario === 'rated' ? 'USD' : null }),
  }));
  const inbound = await twilioStub({ duration: '60', direction: 'inbound', price: '-0.0085', priceUnit: 'usd' }).getCallUsage('CA1');
  assert.deepEqual([inbound!.observations[0].product, inbound!.observations[0].reportedAmount, inbound!.observations[0].currency], ['voice_inbound', 0.0085, 'USD']);
});

test('provider contract: the fake provider satisfies the same contract', async () => {
  await usageContract('fake', async (scenario) => {
    const provider = new FakeCallProvider();
    if (scenario !== 'nothing') provider.usageReports.set('CAfake1', { providerCallId: 'CAfake1', observations: [{ key: 'duration', category: 'telephony', product: 'voice_outbound', metric: 'duration', quantity: 125, unit: 'second', basis: scenario === 'rated' ? 'final' : 'estimated', ...(scenario === 'rated' ? { reportedAmount: 0.035, currency: 'USD' } : {}) }] });
    return { provider, providerCallId: 'CAfake1' };
  });
});

test('the carrier is configuration: the same usage prices under either carrier\'s rates, and the domain never branches on it', async () => {
  const ledger = ledgerOver();
  const usage = { subject: 's', idempotencyKey: 'k', category: 'telephony' as const, product: 'voice_outbound', metric: 'duration' as const, quantity: 600, unit: 'second' as const, basis: 'estimated' as const, source: 'provider_callback' as const, occurredAt: T0 };
  const twilio = await ledger.record(call({ provider: 'twilio' }), { ...usage, provider: 'twilio' });
  const telnyx = await ledger.record(call({ provider: 'telnyx' }), { ...usage, provider: 'telnyx' });
  assert.deepEqual([twilio.record.component.amount, telnyx.record.component.amount], [0.14, 0.05], 'same usage, same code, each carrier\'s own rate');
  // The cost code never names a carrier or an AI vendor.
  for (const file of readdirSync('src/calls/cost')) {
    const source = readFileSync(join('src/calls/cost', file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(source, /twilio|telnyx|openai|provider\s*[!=]==?\s*['"]/i, file);
  }
});

test('no AI vendor or carrier price lives in call or cost logic', () => {
  for (const dir of ['src/calls', 'src/voice']) {
    for (const file of readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      assert.doesNotMatch(source, /0\.014|0\.0085|0\.0044|0\.0025|0\.0032/, `${dir}/${file} hard-codes a rate`);
    }
  }
});

// ---------- Through the application: webhooks, call.get, tenancy, MCP ----------

async function costApp() {
  const stack = createCallStack({ priceBook: book() });
  const provider = stack.provider;
  const created = await stack.adminA.create({ direction: 'outbound', to: freshNumber() }, { idempotencyKey: uniq('app') });
  const session = (await stack.store.findById(created.callId))!;
  return { stack, provider, created, session };
}

test('call.get carries the cost, only for the owning account, over AppPort and MCP alike', async () => {
  const { stack, created, session } = await costApp();
  await stack.calls.transition(created.callId, 'answered');
  await stack.calls.transition(created.callId, 'completed');
  await stack.usage.recordProviderDuration(session, { provider: 'twilio', providerCallId: 'CAa', eventId: 'CAa:completed', durationSeconds: 300 });

  const own = await stack.adminA.get({ callId: created.callId });
  assert.deepEqual([own.cost!.status, own.cost!.estimatedCost, own.cost!.finalCost, own.cost!.currency], ['estimated', 0.07, null, 'USD']);
  assert.equal(own.cost!.breakdown[0].category, 'telephony');
  assert.equal(Object.hasOwn(own, 'providerCallId'), false, 'still no provider ids');

  await assert.rejects(stack.adminB.get({ callId: created.callId }), (error: { code?: string }) => error.code === 'NOT_FOUND');
  const foreign = await mcpClientFor(stack.application, appPortSessionFor(tenant('acct_b', 'admin')));
  assert.match((await foreign.callTool('call_get', { callId: created.callId })).content[0].text, /^NOT_FOUND/);
  assert.ok(!(await foreign.callTool('call_get', { callId: created.callId })).content[0].text.includes('estimatedCost'));

  const mcp = await mcpClientFor(stack.application, appPortSessionFor(tenant('acct_a', 'member')));
  assert.deepEqual(JSON.parse((await mcp.callTool('call_get', { callId: created.callId })).content[0].text).cost, own.cost, 'MCP projects the same representation');
  assert.equal((await stack.adminB.list()).items.length, 0);
  assert.equal(Object.hasOwn((await stack.adminA.list()).items[0], 'cost'), false, 'list is unchanged');
});

test('a call.get with no ledger configured is exactly as before', async () => {
  const { createCallApplication } = await import('../src/appport/call-application.js');
  const { CallCapabilityClient } = await import('../src/appport/call-client.js');
  const stack = createCallStack();
  const bare = new CallCapabilityClient(createCallApplication({ calls: stack.calls }), appPortSessionFor(tenant('acct_a', 'admin')));
  const made = await stack.adminA.create({ direction: 'outbound', to: freshNumber() }, { idempotencyKey: uniq('bare') });
  assert.equal(Object.hasOwn(await bare.get({ callId: made.callId }), 'cost'), false);
});

test('a status callback, replayed, adds no cost; its duration is recorded under the call that was placed', async () => {
  const provider = new FakeCallProvider();
  const messaging = new FakeMessagingProvider();
  const app = createApp({
    repository: new InMemoryConversationRepository(), messagingProvider: messaging, callProvider: provider, publicBaseUrl: 'https://cost.example.test',
    outboundAgentCalls: true, providers: [new TwilioProvider({ turnUrl: 'https://cost.example.test/webhooks/twilio/voice/turn' })],
  });
  const owner = await onboardTenant(app, messaging);
  const { calls, usage } = app.locals.appport as { calls: import('@appport/core').AppPortApplication; usage: CallCostLedger };
  const client = new CallCapabilityClient(calls, appPortSessionFor({ userId: owner.userId, accountId: owner.accountId, role: 'owner', sessionId: 'sess_cost' }));
  // The response from the carrier is lost: only the callback, carrying our callId, tells us the carrier's id.
  provider.loseResponse = true;
  const created = await client.create({ direction: 'outbound', to: freshNumber() }, { idempotencyKey: uniq('http') });
  const sid = provider.held.at(-1)!.providerCallId;
  const post = () => request(app).post(`/webhooks/twilio/status?callId=${created.callId}`).type('form').send({ CallSid: sid, CallStatus: 'completed', CallDuration: '120', SequenceNumber: '3' });
  for (let index = 0; index < 3; index += 1) assert.equal((await post()).status, 200);
  const ledger = await usage.listForCall(owner.accountId, created.callId);
  assert.equal(ledger.length, 1, 'three deliveries, one entry');
  assert.deepEqual([ledger[0].event.quantity, ledger[0].event.unit, ledger[0].event.basis, ledger[0].component.amount], [120, 'second', 'estimated', 0.028]);
  const viewed = await client.get({ callId: created.callId });
  assert.deepEqual([viewed.status, viewed.cost!.status, viewed.cost!.estimatedCost], ['completed', 'estimated', 0.028]);
  assert.equal(provider.attempts, 1);
});

// ---------- Finalization ----------

test('finalization asks the carrier for settled usage on ended calls, once each, and bounds who it asks', async () => {
  let clock = at(0).getTime();
  const provider = new FakeCallProvider();
  const stack = createCallStack({ provider, now: () => new Date(clock) });
  const sessions = [];
  for (let index = 0; index < 3; index += 1) {
    const created = await stack.calls.create({ accountId: 'acct_a' }, { direction: 'outbound', to: freshNumber(), from: '+15550001000' });
    await stack.calls.attachProviderCall(created.id, `CAfin${index}`);
    await stack.calls.transition(created.id, 'initiating', { mode: 'lenient' });
    await stack.calls.transition(created.id, 'ringing', { mode: 'lenient' });
    await stack.calls.transition(created.id, 'answered', { mode: 'lenient' });
    await stack.calls.transition(created.id, 'completed', { mode: 'lenient' });
    sessions.push(created.id);
  }
  provider.usageReports.set('CAfin0', { providerCallId: 'CAfin0', observations: [{ key: 'duration', category: 'telephony', product: 'voice_outbound', metric: 'duration', quantity: 600, unit: 'second', basis: 'final', reportedAmount: 0.14, currency: 'USD' }] });
  provider.usageReports.set('CAfin1', { providerCallId: 'CAfin1', observations: [{ key: 'duration', category: 'telephony', product: 'voice_outbound', metric: 'duration', quantity: 60, unit: 'second', basis: 'estimated' }] });

  assert.equal((await stack.usage.finalizeCompletedCalls(provider)).examined, 0, 'given time to settle first');
  clock += 15 * 60_000;
  const first = await stack.usage.finalizeCompletedCalls(provider);
  assert.deepEqual([first.examined, first.recorded, first.notReady, first.failed], [3, 2, 2, 0]);
  const done = await stack.usage.summarize((await stack.store.findById(sessions[0]))!);
  assert.deepEqual([done.status, done.finalCost], ['final', 0.14]);
  const immediately = await stack.usage.finalizeCompletedCalls(provider);
  assert.equal(immediately.examined, 0, 'a call is asked at most once per retry interval');
  clock += 61 * 60_000;
  const second = await stack.usage.finalizeCompletedCalls(provider);
  assert.equal(second.examined, 2, 'the settled call is not asked about again');
  assert.equal(second.recorded, 0, 'a repeat records nothing');
  assert.equal(second.duplicates, 1);
  clock += 3 * 24 * 3_600_000;
  assert.equal((await stack.usage.finalizeCompletedCalls(provider)).examined, 0, 'too old to ask');
  assert.equal(provider.attempts, 0, 'finalization never creates a call');
  assert.equal(provider.ended.length, 0);
});

test('finalization survives a provider that errors, and records nothing for it', async () => {
  let clock = at(0).getTime();
  const provider = new FakeCallProvider();
  const stack = createCallStack({ provider, now: () => new Date(clock) });
  const created = await stack.calls.create({ accountId: 'acct_a' }, { direction: 'outbound', to: freshNumber(), from: '+15550001000' });
  await stack.calls.attachProviderCall(created.id, 'CAerr');
  await stack.calls.transition(created.id, 'initiating', { mode: 'lenient' });
  await stack.calls.transition(created.id, 'ringing', { mode: 'lenient' });
  await stack.calls.transition(created.id, 'completed', { mode: 'lenient' });
  clock += 30 * 60_000;
  provider.failUsage = new Error('twilio unavailable');
  const report = await stack.usage.finalizeCompletedCalls(provider);
  assert.deepEqual([report.examined, report.failed, report.recorded], [1, 1, 0]);
  provider.failUsage = undefined;
  clock += 61 * 60_000;
  provider.usageReports.set('CAerr', { providerCallId: 'CAerr', observations: [{ key: 'duration', category: 'telephony', product: 'voice_outbound', metric: 'duration', quantity: 30, unit: 'second', basis: 'final', reportedAmount: 0.007, currency: 'USD' }] });
  assert.equal((await stack.usage.finalizeCompletedCalls(provider)).recorded, 1, 'the next run catches up');
});

// ---------- Reconciled calls keep one ledger ----------

test('a reconciled call has one ledger under its own call id, not a second one', async () => {
  const clock = { ms: Date.parse('2026-10-05T12:00:00Z') };
  const provider = new FakeCallProvider();
  const stack = createCallStack({ provider, now: () => new Date(clock.ms) });
  provider.loseResponse = true;
  const created = await stack.adminA.create({ direction: 'outbound', to: freshNumber() }, { idempotencyKey: uniq('rec') });
  provider.loseResponse = false;
  const held = provider.held.at(-1)!;
  held.status = 'completed';
  clock.ms += 3 * 60_000;
  await stack.calls.reconcileUnconfirmedDials();
  const session = (await stack.store.findById(created.callId))!;
  assert.equal(session.providerCallId, held.providerCallId);
  const event = { provider: 'twilio', providerCallId: held.providerCallId, eventId: `${held.providerCallId}:completed`, rawStatus: 'completed', status: 'completed' as const, durationSeconds: 120 };
  await stack.calls.applyProviderEvent(event);
  await stack.calls.applyProviderEvent(event);
  const ledger = await stack.usage.listForCall('acct_a', created.callId);
  assert.equal(ledger.length, 1);
  assert.equal(provider.attempts, 1, 'reconciliation made no second call, and so no second cost');
  assert.equal((await stack.usage.summarize(session)).estimatedCost, 0.028);
});

// ---------- Real Postgres ----------

async function pgLedger(t: { after: (fn: () => unknown) => void }) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 20 });
  t.after(() => pool.end());
  const sessions = new PostgresCallSessionStore(pool);
  await sessions.initialize();
  const usage = new PostgresCallUsageStore(pool);
  await usage.initialize();
  await usage.initialize();
  const stack = createCallStack({ store: sessions, usageStore: usage, priceBook: book(...aiRates) });
  return { pool, sessions, usage, stack };
}

test('Postgres: the ledger migration is additive and repeatable, and the tables are what the code expects', postgresOnly, async (t) => {
  const { pool } = await pgLedger(t);
  const columns = (await pool.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('call_usage_events', 'call_cost_components')`)).rows;
  for (const column of ['idempotency_key', 'subject', 'basis', 'quantity', 'reported_amount', 'metadata']) assert.ok(columns.some((row) => row.table_name === 'call_usage_events' && row.column_name === column), column);
  for (const column of ['rate_id', 'rate', 'rate_source', 'amount', 'priced_at']) assert.ok(columns.some((row) => row.table_name === 'call_cost_components' && row.column_name === column), column);
  await assert.rejects(pool.query(`INSERT INTO call_usage_events (id, call_session_id, account_id, subject, idempotency_key, category, provider, product, metric, quantity, unit, basis, source, occurred_at, recorded_at)
    VALUES ('x', 'call_missing', 'a', 's', 'k', 'telephony', 'p', 'p', 'duration', 1, 'second', 'final', 's', now(), now())`), /foreign key/);
});

test('Postgres: concurrent duplicates record once, estimates and finals coexist, history is stable', postgresOnly, async (t) => {
  const { stack, usage, pool } = await pgLedger(t);
  const created = await stack.calls.create({ accountId: uniq('acct') }, { direction: 'outbound', to: freshNumber(), from: '+15550001000' });
  const c = (await stack.store.findById(created.id))!;
  const event = { provider: 'twilio', providerCallId: uniq('CA'), eventId: uniq('evt'), durationSeconds: 600 };
  await Promise.all(Array.from({ length: 20 }, () => stack.usage.recordProviderDuration(c, event)));
  assert.equal((await usage.listForCall(c.accountId, c.id)).length, 1, 'twenty simultaneous deliveries, one entry');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM call_cost_components WHERE call_session_id = $1', [c.id])).rows[0].n, 1, 'one priced component too');

  await stack.usage.recordProviderReport(c, { providerCallId: event.providerCallId, observations: [{ key: 'duration', category: 'telephony', product: 'voice_outbound', metric: 'duration', quantity: 600, unit: 'second', basis: 'final', reportedAmount: 0.0131, currency: 'USD' }] });
  const rows = await usage.listForCall(c.accountId, c.id);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.event.basis), ['estimated', 'final']);
  assert.equal(rows[0].component.rateId, 'twilio.voice_outbound.duration@2026-10-01', 'the rate the estimate used is kept');
  assert.equal(rows[0].component.amount, 0.14);
  const summary = await stack.usage.summarize({ ...c, status: 'completed', endedAt: new Date() });
  assert.deepEqual([summary.status, summary.finalCost], ['final', 0.0131]);
});

test('Postgres: tenant scoping, aggregation and finalization run on the durable ledger', postgresOnly, async (t) => {
  const { stack, usage } = await pgLedger(t);
  const accountA = uniq('acct');
  const accountB = uniq('acct');
  const a = await stack.calls.create({ accountId: accountA }, { direction: 'outbound', to: freshNumber(), from: '+15550001000' });
  const b = await stack.calls.create({ accountId: accountB }, { direction: 'outbound', to: freshNumber(), from: '+15550002000' });
  const callA = (await stack.store.findById(a.id))!;
  const callB = (await stack.store.findById(b.id))!;
  await stack.usage.recordAiUsage(callA, { modelId: 'openai/gpt-realtime-2', responseId: 'r1', metrics: { audio_input_tokens: 1_000_000 } });
  await stack.usage.recordAiUsage(callB, { modelId: 'openai/gpt-realtime-2', responseId: 'r1', metrics: { audio_input_tokens: 2_000_000 } });
  assert.deepEqual(await usage.listForCall(accountA, b.id), [], 'another account\'s call has no ledger here');
  const mine = await stack.usage.aggregate({ accountId: accountA, dimension: 'model' });
  assert.deepEqual(mine.groups.map((group) => [group.key, group.amount]), [['gpt-realtime-2', 32]]);
  assert.deepEqual((await stack.usage.aggregate({ accountId: accountB, dimension: 'category' })).groups.map((group) => group.amount), [64]);
});

test('Postgres: two instances finalizing the same ended call at once record one authoritative entry (repeated)', postgresOnly, async (t) => {
  const { sessions, usage, pool } = await pgLedger(t);
  for (let round = 0; round < 5; round += 1) {
    const provider = new FakeCallProvider();
    const one = createCallStack({ store: sessions, usageStore: usage, provider });
    const two = createCallStack({ store: sessions, usageStore: usage, provider });
    const accountId = uniq('acct');
    const created = await one.calls.create({ accountId }, { direction: 'outbound', to: freshNumber(), from: '+15550001000' });
    const sid = uniq('CAfinal');
    await one.calls.attachProviderCall(created.id, sid);
    for (const next of ['initiating', 'ringing', 'completed'] as const) await one.calls.transition(created.id, next, { mode: 'lenient' });
    await pool.query(`UPDATE call_sessions SET ended_at = now() - interval '11 minutes' WHERE id = $1`, [created.id]);
    provider.usageReports.set(sid, { providerCallId: sid, observations: [{ key: 'duration', category: 'telephony', product: 'voice_outbound', metric: 'duration', quantity: 90, unit: 'second', basis: 'final', reportedAmount: 0.021, currency: 'USD' }] });
    const reports = await Promise.all([one.usage.finalizeCompletedCalls(provider, { limit: 100, accountId }), two.usage.finalizeCompletedCalls(provider, { limit: 100, accountId })]);
    assert.ok(reports.every((report) => report.failed === 0));
    const ledger = await usage.listForCall((await sessions.findById(created.id))!.accountId, created.id);
    assert.equal(ledger.length, 1, 'one authoritative entry however many finalizers ran');
    assert.equal(ledger[0].component.amount, 0.021);
    assert.equal(provider.attempts, 0);
  }
});

// ---------- Cron ----------

test('cron: finalization is authenticated like reconciliation, and refuses everyone without the secret', async () => {
  const provider = new FakeCallProvider();
  const app = createApp({ repository: new InMemoryConversationRepository(), messagingProvider: new FakeMessagingProvider(), callProvider: provider, cronSecret: 'secret-for-cron-tests-0123456789' });
  assert.equal((await request(app).get('/api/internal/cron/finalize-call-usage')).status, 401);
  assert.equal((await request(app).get('/api/internal/cron/finalize-call-usage').set('Authorization', 'Bearer nope')).status, 401);
  const ok = await request(app).get('/api/internal/cron/finalize-call-usage').set('Authorization', 'Bearer secret-for-cron-tests-0123456789');
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.status, ok.body.examined], ['ok', 0]);
  const open = createApp({ repository: new InMemoryConversationRepository(), messagingProvider: new FakeMessagingProvider(), callProvider: provider });
  assert.equal((await request(open).get('/api/internal/cron/finalize-call-usage').set('Authorization', 'Bearer x')).status, 503);
});

test('autonomous outbound calling stays off by default', async () => {
  const { getConfig } = await import('../src/config.js');
  const minimal = { DATABASE_URL: 'postgres://x', TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' } as NodeJS.ProcessEnv;
  assert.equal(getConfig(minimal).outboundAgentCalls, false);
  assert.equal(getConfig({ ...minimal, OUTBOUND_AGENT_CALLS: 'on' }).outboundAgentCalls, true);
});
