import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import { appPortSessionFor } from '../src/appport/session.js';
import { REFERENCE_RATES } from '../src/billing/call-reference-rates.js';
import { CallCostLedger, FINALIZATION_MAX_ATTEMPTS, type LedgerCall } from '../src/calls/cost/ledger.js';
import { StaticPriceBook, type PriceRate } from '../src/calls/cost/pricing.js';
import { InMemoryCallUsageStore, type CallUsageStore } from '../src/calls/cost/store.js';
import type { UsageEventInput } from '../src/calls/cost/model.js';
import { FakeCallProvider, type CallProvider, type ProviderUsageObservation } from '../src/calls/provider.js';
import { InMemoryCallSessionStore, type CallSessionStore } from '../src/calls/store.js';
import { PostgresCallSessionStore } from '../src/repositories/postgres-call-session-repository.js';
import { PostgresCallUsageStore } from '../src/repositories/postgres-call-usage-repository.js';
import { TwilioCallProvider, type TwilioCallsClient } from '../src/telephony/twilio-call-provider.js';
import { extractRealtimeUsage } from '../src/voice/realtime/usage.js';
import type { RealtimeServerEvent } from '../src/voice/realtime/connector.js';
import { createCallStack, tenant, mcpClientFor } from './support/calls.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresOnly = { skip: databaseUrl ? undefined : 'set TEST_DATABASE_URL to run against Postgres' };
let counter = 0;
const uniq = (label: string) => `${label}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const freshNumber = () => `+1555${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
const T0 = new Date('2026-10-02T12:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const MINUTE = 60_000;

const rate = (over: Partial<PriceRate> & Pick<PriceRate, 'provider' | 'product' | 'metric' | 'rate'>): PriceRate => ({
  id: `${over.provider}.${over.product}.${over.metric}@${(over.effectiveFrom ?? new Date('2026-01-01')).toISOString().slice(0, 10)}`,
  unit: 'minute', currency: 'USD', effectiveFrom: new Date('2026-01-01T00:00:00Z'), ...over,
});
const aiRates = [
  rate({ provider: 'openai', product: 'realtime', metric: 'audio_input_tokens', unit: 'token', per: 1_000_000, rate: 32, model: 'gpt-realtime-2' }),
  rate({ provider: 'openai', product: 'realtime', metric: 'audio_output_tokens', unit: 'token', per: 1_000_000, rate: 64, model: 'gpt-realtime-2' }),
];
const book = (...extra: PriceRate[]) => new StaticPriceBook([...REFERENCE_RATES, ...extra]);
const CARRIER_SETTLES = ['telephony', 'recording'] as const;
const quiet = { log: () => undefined };
const ledgerOver = (store: CallUsageStore = new InMemoryCallUsageStore(), over: { priceBook?: StaticPriceBook; now?: () => Date } = {}) =>
  new CallCostLedger(store, { priceBook: over.priceBook ?? book(...aiRates), now: over.now ?? (() => at(30)), logger: quiet, carrierSettles: CARRIER_SETTLES });
const call = (over: Partial<LedgerCall> = {}): LedgerCall => ({ id: uniq('call'), accountId: uniq('acct'), direction: 'outbound', status: 'completed', provider: 'twilio', answeredAt: T0, endedAt: at(10), ...over });

const obs = (over: Partial<UsageEventInput> & Pick<UsageEventInput, 'subject' | 'category' | 'basis'>): Omit<UsageEventInput, 'callSessionId' | 'accountId'> => ({
  idempotencyKey: `${over.subject}:${over.basis}`, provider: 'twilio', product: 'voice_outbound', metric: 'duration', quantity: 600, unit: 'second',
  source: 'provider_usage_report', occurredAt: T0, ...over,
});
const telephonyFinal = obs({ subject: 'tel', category: 'telephony', basis: 'final', reportedAmount: 0.14, reportedCurrency: 'USD' });
const aiFinal = obs({ subject: 'ai', category: 'ai_voice', basis: 'final', provider: 'openai', product: 'realtime', model: 'gpt-realtime-2', metric: 'audio_input_tokens', quantity: 1_000_000, unit: 'token', source: 'ai_runtime' });
const mediaEstimated = obs({ subject: 'media', category: 'media', basis: 'estimated', product: 'media_stream', source: 'media_stream' });

// ---------- What "final" means ----------

test('finality, case A: every observed usage authoritative and priced, call over → final', async () => {
  const ledger = ledgerOver();
  const c = call();
  await ledger.record(c, telephonyFinal);
  await ledger.record(c, aiFinal);
  await ledger.record(c, { ...mediaEstimated, basis: 'final', reportedAmount: 0.044, reportedCurrency: 'USD' });
  await ledger.record(c, obs({ subject: 'rec', category: 'recording', basis: 'final', product: 'recording', reportedAmount: 0.0025, reportedCurrency: 'USD' }));
  const summary = await ledger.summarize(c);
  assert.deepEqual([summary.status, summary.finalCost, summary.authoritativeCost, summary.pending, summary.nonFinalizable], ['final', 32.1865, 32.1865, [], []]);
});

test('finality, case B: telephony and AI authoritative, media only estimated → not final, and media can never settle', async () => {
  const ledger = ledgerOver();
  const c = call();
  await ledger.record(c, telephonyFinal);
  await ledger.record(c, aiFinal);
  await ledger.record(c, mediaEstimated);
  const summary = await ledger.summarize(c);
  assert.equal(summary.status, 'estimated');
  assert.equal(summary.finalCost, null);
  assert.equal(summary.authoritativeCost, 32.14, 'the authoritative part is still reported');
  assert.equal(summary.estimatedCost, 32.184);
  assert.deepEqual([summary.pending, summary.nonFinalizable], [[], ['media']]);
});

test('finality, case C: AI usage unavailable → not final, explicitly unpriced, never derived', async () => {
  const ledger = ledgerOver();
  const c = call();
  await ledger.record(c, telephonyFinal);
  await ledger.recordAiUsageUnavailable(c, { modelId: 'openai/gpt-realtime-2', responseId: 'r1' });
  await ledger.recordAiUsageUnavailable(c, { modelId: 'openai/gpt-realtime-2', responseId: 'r2' });
  const summary = await ledger.summarize(c);
  assert.deepEqual([summary.status, summary.unpricedUsage, summary.nonFinalizable], ['estimated', 1, ['ai_voice']]);
  assert.equal((await ledger.listForCall(c.accountId, c.id)).length, 2, 'the marker is recorded once per call');
  assert.equal(summary.breakdown.find((entry) => entry.category === 'ai_voice')!.amount, null, 'no cost is made up for it');
});

test('finality, case D: an active call is never final, whatever has been recorded for it', async () => {
  const ledger = ledgerOver();
  const active = call({ status: 'in_progress', endedAt: null });
  await ledger.record(active, telephonyFinal);
  const summary = await ledger.summarize(active);
  assert.deepEqual([summary.status, summary.finalCost], ['estimated', null]);
});

test('finality, case E: ended but not yet rated by the provider → estimated and pending', async () => {
  const ledger = ledgerOver();
  const c = call();
  await ledger.record(c, obs({ subject: 'tel', category: 'telephony', basis: 'estimated', source: 'provider_callback' }));
  const summary = await ledger.summarize(c);
  assert.deepEqual([summary.status, summary.pending, summary.nonFinalizable, summary.finalCost], ['estimated', ['telephony'], [], null]);
});

test('finality, case F: no rate and no reported charge → never final', async () => {
  const ledger = ledgerOver(new InMemoryCallUsageStore(), { priceBook: new StaticPriceBook([]) });
  const c = call();
  await ledger.record(c, { ...telephonyFinal, reportedAmount: null, reportedCurrency: null });
  const summary = await ledger.summarize(c);
  assert.deepEqual([summary.status, summary.unpricedUsage, summary.estimatedCost, summary.finalCost], ['estimated', 1, null, null]);
});

test('giving up asking is not settling: an exhausted call stays estimated and is counted as exhausted', async () => {
  let clock = at(0).getTime();
  const provider = new FakeCallProvider();
  const stack = createCallStack({ provider, now: () => new Date(clock), priceBook: book() });
  const created = await stack.calls.create({ accountId: 'acct_a' }, { direction: 'outbound', to: freshNumber(), from: '+15550001000' });
  await stack.calls.attachProviderCall(created.id, 'CAexh');
  for (const next of ['initiating', 'ringing', 'answered', 'completed'] as const) await stack.calls.transition(created.id, next, { mode: 'lenient' });
  provider.usageReports.set('CAexh', { providerCallId: 'CAexh', observations: [{ key: 'duration', category: 'telephony', product: 'voice_outbound', metric: 'duration', quantity: 60, unit: 'second', basis: 'estimated' }] });
  clock += 15 * MINUTE;
  let last = await stack.usage.finalizeCompletedCalls(provider, { maxAttempts: 3 });
  for (let hour = 0; hour < 5; hour += 1) { clock += 61 * MINUTE; last = await stack.usage.finalizeCompletedCalls(provider, { maxAttempts: 3 }); }
  assert.equal(provider.usageFetches.length, 3, 'asked exactly the attempts allowed, then left alone');
  assert.deepEqual([last.examined, last.exhausted], [0, 1]);
  const row = (await stack.store.findById(created.id))!;
  const summary = await stack.usage.summarize(row);
  assert.deepEqual([summary.status, summary.finalCost, summary.pending], ['estimated', null, ['telephony']]);
  assert.equal((await stack.usage.getFinalizationState(created.id))!.attempts, 3);
});

// ---------- Recording ----------

const twilioWith = (call: Record<string, unknown>, recordings: Array<Record<string, unknown>> = [], media: string[] = []) => new TwilioCallProvider('AC', 'token', {
  client: { calls: Object.assign(() => ({ fetch: async () => call, update: async () => undefined, recordings: { list: async () => recordings } }), { create: async () => { throw new Error('no'); }, list: async () => [] }) } as unknown as TwilioCallsClient,
});

test('recording: a completed, rated Twilio recording is authoritative; a processing one is an estimate', async () => {
  const report = await twilioWith(
    { duration: '120', direction: 'outbound-api', price: '-0.0140', priceUnit: 'USD', status: 'completed' },
    [
      { sid: 'RE1', status: 'completed', duration: '110', price: '-0.0030', priceUnit: 'USD' },
      { sid: 'RE2', status: 'processing', duration: '10', price: null, priceUnit: null },
      { sid: 'RE3', status: 'absent', duration: null, price: null, priceUnit: null },
    ],
  ).getCallUsage('CA1');
  assert.deepEqual(report!.observations.map((o) => [o.key, o.category, o.basis, o.reportedAmount ?? null]), [
    ['duration', 'telephony', 'final', 0.014], ['recording:RE1', 'recording', 'final', 0.003], ['recording:RE2', 'recording', 'estimated', null],
  ], 'an absent recording has nothing to report');
});

test('recording: the carrier\'s settled figure supersedes the callback estimate, which stays in the ledger', async () => {
  const store = new InMemoryCallUsageStore();
  const ledger = ledgerOver(store);
  const c = call();
  await ledger.recordRecording(c, { recordingSid: 'RE1', seconds: 110, providerCallId: 'CA1' });
  const estimated = await ledger.summarize(c);
  assert.equal(estimated.breakdown.find((e) => e.category === 'recording')!.basis, 'estimated');
  await ledger.recordProviderReport(c, { providerCallId: 'CA1', observations: [{ key: 'recording:RE1', category: 'recording', product: 'recording', metric: 'duration', quantity: 110, unit: 'second', basis: 'final', reportedAmount: 0.003, currency: 'USD' }] });
  const settled = await ledger.summarize(c);
  const entry = settled.breakdown.find((e) => e.category === 'recording')!;
  assert.deepEqual([entry.basis, entry.amount], ['final', 0.003]);
  assert.equal((await store.listForCall(c.accountId, c.id)).length, 2, 'one subject, two observations, nothing overwritten');
});

// ---------- Media ----------

test('media: Twilio has no per-call authoritative figure, so the adapter reports none and the estimate is non-finalizable', async () => {
  const provider = twilioWith({ duration: '600', direction: 'outbound-api', price: '-0.14', priceUnit: 'USD' });
  assert.deepEqual([...provider.authoritativeUsage], ['telephony', 'recording']);
  const report = await provider.getCallUsage('CA1');
  assert.ok(report!.observations.every((o) => o.category !== 'media'), 'never reports media');
  const ledger = ledgerOver();
  const c = call();
  await ledger.recordMediaStream(c, { streamSid: 'MZ', seconds: 600, startedAt: T0 });
  assert.deepEqual((await ledger.summarize(c)).nonFinalizable, ['media']);
});

// ---------- AI usage shape ----------

test('AI usage: the normalized realtime event carries usage only in `raw`, and that is the shape the ledger reads', () => {
  // A response-done event exactly as the AI SDK types it: `{ type, responseId, status, raw }`, with no usage field of its own.
  const event: RealtimeServerEvent = { type: 'response-done', responseId: 'resp_1', status: 'completed', raw: { type: 'response.done', response: { id: 'resp_1', usage: { total_tokens: 400, input_tokens: 300, output_tokens: 100, input_token_details: { text_tokens: 20, audio_tokens: 280, cached_tokens: 64 }, output_token_details: { text_tokens: 10, audio_tokens: 90 } } } } };
  assert.equal(event.type, 'response-done');
  assert.deepEqual(extractRealtimeUsage((event as { raw: unknown }).raw), { text_input_tokens: 20, audio_input_tokens: 280, cached_input_tokens: 64, text_output_tokens: 10, audio_output_tokens: 90 });
  // Not reported: nothing is made up, whatever else the event carries.
  assert.deepEqual(extractRealtimeUsage({ type: 'response.done', response: { id: 'r', status: 'completed', output: [{ type: 'message', content: [{ transcript: 'a long transcript of what was said' }] }] } }), {});
});

// ---------- Active-call estimates ----------

test('an active call\'s estimate is derived on read, flagged, never stored, and never overrides recorded usage', async () => {
  const store = new InMemoryCallUsageStore();
  const ledger = new CallCostLedger(store, { priceBook: book(), now: () => at(5), logger: quiet, carrierSettles: CARRIER_SETTLES });
  const active = call({ status: 'in_progress', endedAt: null });
  const before = await ledger.summarize(active);
  assert.deepEqual([before.derived, before.status, before.estimatedCost, before.authoritativeCost, before.pending], [true, 'estimated', 0.07, null, ['telephony']]);
  assert.equal((await store.listForCall(active.accountId, active.id)).length, 0);
  await ledger.record(active, obs({ subject: 'tel', category: 'telephony', basis: 'estimated', quantity: 60, source: 'provider_callback' }));
  const after = await ledger.summarize(active);
  assert.deepEqual([after.derived, after.estimatedCost], [false, 0.014], 'a recorded observation replaces the lifecycle estimate');
  assert.equal((await store.listForCall(active.accountId, active.id)).length, 1, 'and reading wrote nothing');
});

test('a terminal call with an authoritative observation does not use the lifecycle estimate', async () => {
  const ledger = ledgerOver();
  const c = call();
  await ledger.record(c, { ...telephonyFinal, reportedAmount: 0.01 });
  const summary = await ledger.summarize(c);
  assert.deepEqual([summary.derived, summary.estimatedCost, summary.finalCost], [false, 0.01, 0.01], 'not the 10 minutes the lifecycle times imply');
});

// ---------- Pricing semantics ----------

test('pricing distinguishes metrics and units without any vendor-shaped schema', async () => {
  const ledger = ledgerOver();
  const c = call();
  await ledger.recordAiUsage(c, { modelId: 'openai/gpt-realtime-2', responseId: 'r', metrics: { audio_input_tokens: 1_000_000, audio_output_tokens: 1_000_000 } });
  const rows = await ledger.listForCall(c.accountId, c.id);
  const by = Object.fromEntries(rows.map((row) => [row.event.metric, row.component.amount]));
  assert.deepEqual(by, { audio_input_tokens: 32, audio_output_tokens: 64 }, 'input and output are priced separately');
  assert.ok(rows.every((row) => row.component.rateUnit === 'token' && row.component.ratePer === 1_000_000));
});

test('changing an AI rate later does not change a recorded cost component', async () => {
  const store = new InMemoryCallUsageStore();
  const first = ledgerOver(store);
  const c = call();
  await first.recordAiUsage(c, { modelId: 'openai/gpt-realtime-2', responseId: 'r', metrics: { audio_input_tokens: 1_000_000 }, occurredAt: at(0) });
  const cheaper = ledgerOver(store, { priceBook: book(
    rate({ provider: 'openai', product: 'realtime', metric: 'audio_input_tokens', unit: 'token', per: 1_000_000, rate: 32, model: 'gpt-realtime-2', effectiveTo: at(60) }),
    rate({ provider: 'openai', product: 'realtime', metric: 'audio_input_tokens', unit: 'token', per: 1_000_000, rate: 8, model: 'gpt-realtime-2', effectiveFrom: at(60), id: 'ai.cut' }),
  ) });
  await cheaper.recordAiUsage(c, { modelId: 'openai/gpt-realtime-2', responseId: 'later', metrics: { audio_input_tokens: 1_000_000 }, occurredAt: at(120) });
  const rows = await cheaper.listForCall(c.accountId, c.id);
  assert.deepEqual(rows.map((row) => [row.component.amount, row.component.rateId]), [[32, 'openai.realtime.audio_input_tokens@2026-01-01'], [8, 'ai.cut']]);
});

test('the ledger schema has no provider- or vendor-specific columns', postgresOnly, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  t.after(() => pool.end());
  await new PostgresCallSessionStore(pool).initialize();
  await new PostgresCallUsageStore(pool).initialize();
  const columns = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('call_usage_events', 'call_cost_components', 'call_usage_finalization')`)).rows.map((row) => row.column_name as string);
  assert.deepEqual(columns.filter((column) => /twilio|telnyx|openai|(^|_)sid($|_)|minute/i.test(column)), [], 'no vendor-shaped columns');
});

// ---------- Contract (multiple observations, metadata, duplicates, pricing availability) ----------

async function contract(name: string, make: (scenario: 'multi' | 'none') => CallProvider & { seed?: () => void }) {
  assert.ok(Array.isArray(make('none').authoritativeUsage), `${name}: declares what it can settle`);
  assert.equal(await make('none').getCallUsage('CA1'), null, `${name}: no usage → null`);
  const provider = make('multi');
  const report = (await provider.getCallUsage('CA1'))!;
  assert.equal(report.providerCallId, 'CA1', `${name}: provider reference`);
  assert.ok(report.observations.length >= 2, `${name}: multiple observations`);
  assert.equal(new Set(report.observations.map((o) => o.key)).size, report.observations.length, `${name}: each observation has its own key`);
  for (const o of report.observations) {
    assert.ok(['estimated', 'final'].includes(o.basis));
    assert.ok(o.basis === 'final' || o.reportedAmount === undefined, `${name}: only a settled observation states a charge`);
    assert.ok(provider.authoritativeUsage.includes(o.category) || o.basis === 'estimated', `${name}: authoritative only for categories it declares`);
  }
  assert.ok(report.observations.some((o) => o.basis === 'final'), `${name}: authoritative usage`);
  assert.ok(report.observations.some((o) => o.basis === 'estimated'), `${name}: estimated usage`);
  assert.ok(report.observations.some((o) => o.metadata && Object.keys(o.metadata).length > 0), `${name}: provider metadata is carried`);
  // Priceable by the one pricing path, whoever the provider is: rate card, provider-reported, or explicitly unpriced.
  const ledger = ledgerOver();
  const c = call({ provider: provider.name });
  assert.deepEqual(await ledger.recordProviderReport(c, report), { recorded: report.observations.length, duplicates: 0 });
  assert.deepEqual(await ledger.recordProviderReport(c, report), { recorded: 0, duplicates: report.observations.length }, `${name}: duplicate observations record nothing`);
  const rows = await ledger.listForCall(c.accountId, c.id);
  assert.ok(rows.every((row) => ['rate_card', 'provider_reported', 'unpriced'].includes(row.component.rateSource)));
  assert.ok(rows.filter((row) => row.event.basis === 'final').every((row) => row.component.rateSource === 'provider_reported'));
}

test('provider contract (strengthened): Twilio', async () => {
  await contract('twilio', (scenario) => twilioWith(
    scenario === 'none' ? { duration: null } : { duration: '125', direction: 'outbound-api', status: 'completed', price: '-0.0350', priceUnit: 'USD' },
    scenario === 'none' ? [] : [{ sid: 'RE9', status: 'processing', duration: '30', price: null, priceUnit: null }],
  ));
});

test('provider contract (strengthened): fake provider', async () => {
  await contract('fake', (scenario) => {
    const provider = new FakeCallProvider();
    if (scenario === 'multi') {
      const observations: ProviderUsageObservation[] = [
        { key: 'duration', category: 'telephony', product: 'voice_outbound', metric: 'duration', quantity: 125, unit: 'second', basis: 'final', reportedAmount: 0.035, currency: 'USD', metadata: { status: 'completed' } },
        { key: 'recording:RE9', category: 'recording', product: 'recording', metric: 'duration', quantity: 30, unit: 'second', basis: 'estimated', metadata: { status: 'processing' } },
      ];
      provider.usageReports.set('CA1', { providerCallId: 'CA1', observations });
    }
    return provider;
  });
});

// ---------- Architecture guards ----------

test('guard: carrier SDK, carrier pricing fields and vendor billing logic stay out of the call domain', () => {
  const walk = (dir: string) => readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts')).map((file) => ({ file: join(dir, file), source: readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '') }));
  for (const { file, source } of walk('src/calls')) assert.doesNotMatch(source, /from 'twilio'|require\('twilio'\)/, `${file} imports the carrier SDK`);
  for (const { file, source } of [...walk('src/calls'), ...walk('src/voice')]) {
    assert.doesNotMatch(source, /priceUnit|price_unit|\.price\b/, `${file} reads a carrier price field`);
    assert.doesNotMatch(source, /0\.014|0\.0085|0\.0044|0\.0025|0\.0032|0\.005\b|0\.002\b|0\.0035/, `${file} hard-codes a rate`);
  }
  // Only a provider adapter (src/telephony) reads a provider's price fields.
  const readers = walk('src').filter(({ source }) => /priceUnit|price_unit/.test(source)).map(({ file }) => file);
  assert.deepEqual(readers, [join('src', 'telephony', 'twilio-call-provider.ts')]);
  // Rates are data: they are only declared under src/billing.
  const declarers = walk('src').filter(({ source }) => /currency:\s*'[A-Z]{3}'/.test(source)).map(({ file }) => file).sort();
  assert.deepEqual(declarers, [join('src', 'billing', 'call-reference-rates.ts')]);
});

// ---------- Fair, bounded finalization ----------

async function endedCalls(stack: ReturnType<typeof createCallStack>, count: number, provider: FakeCallProvider, prefix: string) {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const created = await stack.calls.create({ accountId: 'acct_a' }, { direction: 'outbound', to: freshNumber(), from: '+15550001000' });
    const sid = `${prefix}${index}`;
    await stack.calls.attachProviderCall(created.id, sid);
    for (const next of ['initiating', 'ringing', 'answered', 'completed'] as const) await stack.calls.transition(created.id, next, { mode: 'lenient' });
    provider.usageReports.set(sid, { providerCallId: sid, observations: [{ key: 'duration', category: 'telephony', product: 'voice_outbound', metric: 'duration', quantity: 60, unit: 'second', basis: 'final', reportedAmount: 0.014, currency: 'USD' }] });
    ids.push(created.id);
  }
  return ids;
}

test('finalization is fair: with more calls than one batch, every call is asked, old ones are not starved by new ones', async () => {
  let clock = at(0).getTime();
  const provider = new FakeCallProvider();
  const stack = createCallStack({ provider, now: () => new Date(clock) });
  const old = await endedCalls(stack, 12, provider, 'CAold');
  clock += 6 * 3_600_000;
  const fresh = await endedCalls(stack, 12, provider, 'CAnew');
  clock += 15 * MINUTE;
  for (let run = 0; run < 6; run += 1) { await stack.usage.finalizeCompletedCalls(provider, { limit: 5 }); clock += 20 * MINUTE; }
  const asked = new Set(provider.usageFetches);
  assert.equal(asked.size, 24, 'every call was asked within a few runs');
  const settled = await Promise.all([...old, ...fresh].map(async (id) => (await stack.usage.summarize((await stack.store.findById(id))!)).status));
  assert.ok(settled.every((status) => status === 'final'));
  assert.equal(provider.usageFetches.length, 24, 'each asked once: a settled call is not asked again');
});

test('finalization respects the horizon, and reports pending and exhausted calls', async () => {
  let clock = at(0).getTime();
  const provider = new FakeCallProvider();
  const stack = createCallStack({ provider, now: () => new Date(clock) });
  const [tooOld, unrated] = await endedCalls(stack, 2, provider, 'CAh');
  provider.usageReports.delete('CAh0');
  provider.usageReports.delete('CAh1');
  clock += 49 * 3_600_000;
  const report = await stack.usage.finalizeCompletedCalls(provider);
  assert.equal(report.examined, 0, 'beyond the 48 hour horizon');
  assert.equal(report.exhausted, 0);
  void tooOld; void unrated;
  // Inside the horizon: asked while attempts remain, reported as pending.
  const [recent] = await endedCalls(stack, 1, provider, 'CAr');
  provider.usageReports.delete('CAr0');
  clock += 15 * MINUTE;
  const first = await stack.usage.finalizeCompletedCalls(provider);
  assert.deepEqual([first.examined, first.notReady, first.pending], [1, 1, 1]);
  assert.equal(FINALIZATION_MAX_ATTEMPTS, 24);
  void recent;
});

test('ledger health counts authoritative, estimated, unpriced, pending and exhausted calls', async () => {
  let clock = at(0).getTime();
  const provider = new FakeCallProvider();
  const stack = createCallStack({ provider, now: () => new Date(clock), priceBook: book() });
  const [settled, waiting, unpriced] = await endedCalls(stack, 3, provider, 'CAhl');
  provider.usageReports.delete('CAhl1');
  provider.usageReports.set('CAhl2', { providerCallId: 'CAhl2', observations: [{ key: 'duration', category: 'telephony', product: 'product_nobody_priced', metric: 'duration', quantity: 60, unit: 'second', basis: 'final' }] });
  clock += 15 * MINUTE;
  await stack.usage.finalizeCompletedCalls(provider);
  await stack.usage.recordProviderDuration((await stack.store.findById(waiting))!, { provider: 'twilio', providerCallId: 'CAhl1', eventId: 'e', durationSeconds: 60 });
  const health = await stack.usage.health();
  assert.equal(health.calls, 3);
  assert.equal(health.authoritative, 1, 'one call settled with a provider-stated charge');
  assert.equal(health.estimated, 2);
  assert.equal(health.withUnpricedUsage, 1, 'the call whose settled usage has no charge and no rate');
  assert.equal(health.pendingRating, 1, 'the call the carrier has not settled; the unpriced one was settled but has no price');
  assert.equal(health.exhausted, 0);
  void settled; void unpriced;
});

// ---------- Read path: call.get over AppPort and MCP ----------

test('call.get cost: unknown, active, final and unpriced states, identical over MCP, tenant-scoped, nothing internal leaked', async () => {
  // A fixed clock: the reference rates take effect on a date, and a test must not depend on what day it runs.
  let clock = at(0).getTime();
  const stack = createCallStack({ priceBook: book(), now: () => new Date(clock) });
  const make = async () => stack.adminA.create({ direction: 'outbound', to: freshNumber() }, { idempotencyKey: uniq('rp') });
  const mcp = await mcpClientFor(stack.application, appPortSessionFor(tenant('acct_a', 'member')));

  const fresh = await make();
  const unknown = await stack.adminA.get({ callId: fresh.callId });
  assert.deepEqual([unknown.cost!.status, unknown.cost!.estimatedCost, unknown.cost!.breakdown], ['unknown', null, []], 'a call with no ledger records is safe');

  await stack.calls.transition(fresh.callId, 'answered', { mode: 'lenient' });
  clock += 5 * MINUTE;
  const running = await stack.adminA.get({ callId: fresh.callId });
  assert.deepEqual([running.cost!.status, running.cost!.derived], ['estimated', true]);

  await stack.calls.transition(fresh.callId, 'completed', { mode: 'lenient' });
  const session = (await stack.store.findById(fresh.callId))!;
  await stack.usage.record(session, telephonyFinal);
  const done = await stack.adminA.get({ callId: fresh.callId });
  assert.deepEqual([done.cost!.status, done.cost!.finalCost, done.cost!.authoritativeCost], ['final', 0.14, 0.14]);

  await stack.usage.recordAiUsage(session, { modelId: 'someone/other-model', responseId: 'r', metrics: { audio_input_tokens: 5 } });
  const withUnpriced = await stack.adminA.get({ callId: fresh.callId });
  assert.deepEqual([withUnpriced.cost!.status, withUnpriced.cost!.unpricedUsage, withUnpriced.cost!.finalCost], ['estimated', 1, null], 'unpriced usage is exposed, and blocks final');

  const viaMcp = JSON.parse((await mcp.callTool('call_get', { callId: fresh.callId })).content[0].text);
  assert.deepEqual(viaMcp.cost, withUnpriced.cost, 'MCP output is the AppPort output');
  const text = JSON.stringify(withUnpriced);
  assert.doesNotMatch(text, /rate_card|rateId|provider_reported|reportedAmount|idempotency|providerCallId|CA[0-9a-f]{6}/i, 'no pricing internals, provider ids or keys');

  await assert.rejects(stack.adminB.get({ callId: fresh.callId }), (error: { code?: string }) => error.code === 'NOT_FOUND');
  const foreign = await mcpClientFor(stack.application, appPortSessionFor(tenant('acct_b', 'admin')));
  const refused = (await foreign.callTool('call_get', { callId: fresh.callId })).content[0].text;
  assert.match(refused, /^NOT_FOUND/);
  assert.doesNotMatch(refused, /cost|0\.14/);
});

// ---------- Real Postgres: races, crashes, and fairness ----------

async function pgStack(t: { after: (fn: () => unknown) => void }, over: { now?: () => Date; provider?: FakeCallProvider } = {}) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 24 });
  t.after(() => pool.end());
  const sessions = new PostgresCallSessionStore(pool);
  await sessions.initialize();
  const usage = new PostgresCallUsageStore(pool);
  await usage.initialize();
  const provider = over.provider ?? new FakeCallProvider();
  const make = () => createCallStack({ store: sessions, usageStore: usage, provider, priceBook: book(...aiRates), now: over.now });
  return { pool, sessions, usage, provider, make, stack: make() };
}
async function endedPgCall(stack: ReturnType<typeof createCallStack>, pool: pg.Pool, provider: FakeCallProvider, accountId = uniq('acct')) {
  const created = await stack.calls.create({ accountId }, { direction: 'outbound', to: freshNumber(), from: '+15550001000' });
  const sid = uniq('CApg');
  await stack.calls.attachProviderCall(created.id, sid);
  for (const next of ['initiating', 'ringing', 'answered', 'completed'] as const) await stack.calls.transition(created.id, next, { mode: 'lenient' });
  await pool.query(`UPDATE call_sessions SET ended_at = now() - interval '11 minutes' WHERE id = $1`, [created.id]);
  provider.usageReports.set(sid, { providerCallId: sid, observations: [
    { key: 'duration', category: 'telephony', product: 'voice_outbound', metric: 'duration', quantity: 90, unit: 'second', basis: 'final', reportedAmount: 0.021, currency: 'USD' },
    { key: 'recording:RE1', category: 'recording', product: 'recording', metric: 'duration', quantity: 80, unit: 'second', basis: 'final', reportedAmount: 0.003, currency: 'USD' },
  ] });
  return { session: (await stack.store.findById(created.id))!, sid };
}

async function assertConsistent(usage: PostgresCallUsageStore, session: { id: string; accountId: string }, pool: pg.Pool) {
  const rows = await usage.listForCall(session.accountId, session.id);
  assert.equal(new Set(rows.map((row) => row.event.idempotencyKey)).size, rows.length, 'no duplicate observation');
  const components = (await pool.query('SELECT count(*)::int AS n, count(DISTINCT usage_event_id)::int AS d FROM call_cost_components WHERE call_session_id = $1', [session.id])).rows[0];
  assert.deepEqual([components.n, components.d], [rows.length, rows.length], 'every observation priced exactly once');
  const bySubject = new Map<string, number>();
  for (const row of rows.filter((candidate) => candidate.event.basis === 'final')) bySubject.set(row.event.subject, (bySubject.get(row.event.subject) ?? 0) + 1);
  assert.ok([...bySubject.values()].every((count) => count === 1), 'no conflicting authoritative observations of one subject');
}

test('Postgres race: terminal webhook, recording callback, AI usage and finalization at once, repeated', postgresOnly, async (t) => {
  const { pool, usage, provider, make } = await pgStack(t);
  for (let round = 0; round < 8; round += 1) {
    const instances = [make(), make(), make()];
    const accountId = uniq('acct');
    const { session, sid } = await endedPgCall(instances[0], pool, provider, accountId);
    const event = { provider: 'twilio', providerCallId: sid, eventId: `${sid}:completed`, durationSeconds: 90 };
    await Promise.all([
      instances[0].usage.recordProviderDuration(session, event),
      instances[1].usage.recordProviderDuration(session, event),
      instances[1].usage.finalizeCompletedCalls(provider, { limit: 100, accountId }),
      instances[2].usage.finalizeCompletedCalls(provider, { limit: 100, accountId }),
      instances[0].usage.recordRecording(session, { recordingSid: 'RE1', seconds: 80, providerCallId: sid }),
      instances[2].usage.recordAiUsage(session, { modelId: 'openai/gpt-realtime-2', responseId: 'r1', metrics: { audio_input_tokens: 1000, audio_output_tokens: 500 } }),
      instances[2].usage.recordAiUsage(session, { modelId: 'openai/gpt-realtime-2', responseId: 'r1', metrics: { audio_input_tokens: 1000, audio_output_tokens: 500 } }),
    ]);
    await instances[0].usage.finalizeCompletedCalls(provider, { limit: 100, retryIntervalMs: 0, accountId });
    await assertConsistent(usage, session, pool);
    const summary = await instances[0].usage.summarize({ ...session, status: 'completed', endedAt: new Date() });
    const telephony = summary.breakdown.find((entry) => entry.category === 'telephony')!;
    const recording = summary.breakdown.find((entry) => entry.category === 'recording')!;
    assert.deepEqual([telephony.amount, telephony.basis, recording.amount, recording.basis], [0.021, 'final', 0.003, 'final'], 'the authoritative observations win whichever landed first');
    assert.equal(provider.attempts, 0);
  }
});

test('Postgres: a failure while recording leaves nothing half-written, and a redelivery completes it', postgresOnly, async (t) => {
  const { pool, usage, provider, stack } = await pgStack(t);
  const { session } = await endedPgCall(stack, pool, provider);
  const ledger = stack.usage;
  // Before the write: nothing exists, so nothing is lost; a retry records it.
  const real = usage.append.bind(usage);
  let failures = 1;
  (usage as { append: typeof usage.append }).append = async (event, component) => { if (failures-- > 0) throw new Error('process died before writing'); return real(event, component); };
  const input = obs({ subject: 'x', category: 'telephony', basis: 'estimated', source: 'provider_callback' });
  await assert.rejects(ledger.record(session, input), /died/);
  assert.equal((await usage.listForCall(session.accountId, session.id)).length, 0);
  (usage as { append: typeof usage.append }).append = real;
  assert.equal((await ledger.record(session, input)).duplicate, false);
  // After the write: a new process (a new ledger) delivering the same observation again finds it recorded.
  const restarted = new CallCostLedger(usage, { priceBook: book(), logger: quiet });
  assert.equal((await restarted.record(session, input)).duplicate, true);
  // Between event and price: impossible by construction. A component the database refuses rolls the event back too.
  const bad = { id: 'cost_bad', usageEventId: 'x', callSessionId: session.id, accountId: session.accountId, amount: 1, currency: 'USD', rateSource: 'nonsense' as never, rateId: null, rate: null, ratePer: null, rateUnit: null, pricedQuantity: null, pricedAt: new Date() };
  const event = { ...(await usage.listForCall(session.accountId, session.id))[0].event, id: 'use_bad', idempotencyKey: 'bad-key' };
  await assert.rejects(usage.append(event, bad));
  assert.equal((await usage.listForCall(session.accountId, session.id)).length, 1, 'the event was rolled back with its price');
});

test('Postgres: finalization survives death mid-run and a retried webhook; the attempt state is durable', postgresOnly, async (t) => {
  const { pool, usage, provider, make, stack } = await pgStack(t);
  const { session, sid } = await endedPgCall(stack, pool, provider);
  const { accountId } = session;
  provider.failUsage = new Error('process died while asking the carrier');
  const first = await stack.usage.finalizeCompletedCalls(provider, { limit: 100, accountId });
  assert.deepEqual([first.examined, first.failed], [1, 1]);
  const state = await usage.getFinalizationState(session.id);
  assert.deepEqual([state!.attempts, state!.lastOutcome], [1, 'failed'], 'the attempt is remembered in the database, not in a process');
  provider.failUsage = undefined;
  assert.equal((await make().usage.finalizeCompletedCalls(provider, { limit: 100, accountId })).examined, 0, 'a new process respects the spacing');
  const later = await make().usage.finalizeCompletedCalls(provider, { limit: 100, retryIntervalMs: 0, accountId });
  assert.equal(later.recorded, 2);
  // The webhook that was being retried arrives now: it adds its estimate beside the settled figure, which still wins.
  await make().usage.recordProviderDuration(session, { provider: 'twilio', providerCallId: sid, eventId: `${sid}:completed`, durationSeconds: 95 });
  await assertConsistent(usage, session, pool);
  assert.equal((await stack.usage.summarize({ ...session, status: 'completed', endedAt: new Date() })).authoritativeCost, 0.024);
});

test('Postgres: fair, bounded finalization across instances (repeated)', postgresOnly, async (t) => {
  let clock = Date.now();
  const { pool, usage, provider, make } = await pgStack(t, { now: () => new Date(clock) });
  for (let round = 0; round < 3; round += 1) {
    const stack = make();
    const accountId = uniq('acct');
    const ids: string[] = [];
    for (let index = 0; index < 9; index += 1) ids.push((await endedPgCall(stack, pool, provider, accountId)).session.id);
    const instances = [make(), make()];
    for (let run = 0; run < 5; run += 1) {
      clock += 61 * MINUTE;
      await Promise.all(instances.map((instance) => instance.usage.finalizeCompletedCalls(provider, { limit: 3, accountId })));
    }
    for (const id of ids) {
      const state = await usage.getFinalizationState(id);
      assert.equal(state?.attempts, 1, 'every call asked exactly once: no starvation, no double asking');
    }
    const health = await make().usage.health({ from: new Date(clock - 3 * 86_400_000), accountId });
    assert.equal(health.exhausted, 0);
    clock = Date.now();
  }
});

test('Postgres: ledger health and exhausted calls are inspectable', postgresOnly, async (t) => {
  let clock = Date.now();
  const { pool, provider, make, usage } = await pgStack(t, { now: () => new Date(clock) });
  const stack = make();
  const { session, sid } = await endedPgCall(stack, pool, provider);
  const { accountId } = session;
  provider.usageReports.delete(sid);
  await stack.usage.recordProviderDuration(session, { provider: 'twilio', providerCallId: sid, eventId: uniq('e'), durationSeconds: 90 });
  for (let run = 0; run < 4; run += 1) { clock += 61 * MINUTE; await stack.usage.finalizeCompletedCalls(provider, { limit: 100, maxAttempts: 3, accountId }); }
  const state = await usage.getFinalizationState(session.id);
  assert.deepEqual([state!.attempts, state!.lastOutcome], [3, 'not_ready']);
  const backlog = await usage.finalizationBacklog({ endedAfter: new Date(clock - 48 * 3_600_000), maxAttempts: 3, accountId });
  assert.deepEqual([backlog.exhausted, backlog.pending], [1, 0]);
});

void InMemoryCallSessionStore; void ({} as CallSessionStore);
