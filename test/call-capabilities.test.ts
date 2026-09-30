import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequest, newRequestId, type Session } from '@appport/protocol';

import { appPortSessionFor, telephonySessionFor } from '../src/appport/session.js';
import { CallCapabilityClient } from '../src/appport/call-client.js';
import { createCallApplication, MAX_WAIT_SECONDS } from '../src/appport/call-application.js';
import { createCallMcpBridge } from '../src/appport/mcp.js';
import { FakeCallProvider } from '../src/calls/provider.js';
import { CallSessionService } from '../src/calls/service.js';
import { InMemoryCallSessionStore } from '../src/calls/store.js';
import type { TenantContext } from '../src/tenancy/authorization.js';

const tenant = (accountId: string, role: TenantContext['role']): TenantContext => ({ userId: `user_${accountId}_${role}`, accountId, role, sessionId: `sess_${accountId}_${role}` });

function setup(options: { pollIntervalMs?: number; store?: InMemoryCallSessionStore } = {}) {
  const store = options.store ?? new InMemoryCallSessionStore();
  const provider = new FakeCallProvider();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const calls = new CallSessionService(store, {
    provider,
    assistantLine: async () => '+15550001000',
    logger: { log: (_level, event, fields) => logs.push({ event, fields }) },
  });
  const application = createCallApplication({ calls, pollIntervalMs: options.pollIntervalMs ?? 5 });
  const as = (session: Session) => new CallCapabilityClient(application, session);
  return {
    store, provider, calls, application, logs, as,
    adminA: as(appPortSessionFor(tenant('acct_a', 'admin'))),
    memberA: as(appPortSessionFor(tenant('acct_a', 'member'))),
    adminB: as(appPortSessionFor(tenant('acct_b', 'admin'))),
    telephonyA: as(telephonySessionFor('acct_a')),
  };
}

const rejectsWith = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

test('the four call capabilities are declared, versioned and provider-blind', () => {
  const { application } = setup();
  const manifest = application.manifest();
  const call = manifest.capabilities.filter((entry) => entry.name.startsWith('call.'));
  assert.deepEqual(call.map((entry) => `${entry.name}@${entry.latestVersion}`).sort(), ['call.create@1', 'call.end@1', 'call.get@1', 'call.list@1']);
  assert.deepEqual(Object.fromEntries(call.map((entry) => [entry.name, entry.authorization])), {
    'call.create': ['call.create'], 'call.get': ['call.read'], 'call.list': ['call.read'], 'call.end': ['call.control'],
  });
  // No consumer needs to understand the telephony provider: nothing in any schema names it.
  const schemas = JSON.stringify(call.map((entry) => [entry.inputSchema, entry.outputSchema]));
  assert.ok(!/twilio|callsid|sid\b/i.test(schemas.replace(/providerCallId[^}]*ingest[^"]*"/g, '')), 'no Twilio vocabulary in the contract');
  const output = JSON.stringify(call.find((entry) => entry.name === 'call.get')!.outputSchema);
  assert.ok(!output.includes('providerCallId'));
});

test('call.create establishes a call of either direction and returns only its id and status', async () => {
  const { adminA, telephonyA, provider, store } = setup();
  const outbound = await adminA.create({ direction: 'outbound', to: '+15551230000' });
  assert.deepEqual(Object.keys(outbound).sort(), ['callId', 'status']);
  assert.equal(outbound.status, 'created');
  assert.deepEqual(provider.created, [], 'no autonomous dialing: create only establishes the domain object');

  const inbound = await telephonyA.create({ direction: 'inbound', providerCallId: 'CAcap1', from: '+15555550123', to: '+15550001000', conversationId: 'conv_1' });
  assert.equal(inbound.status, 'ringing');
  assert.notEqual(inbound.callId, 'CAcap1');
  assert.equal((await store.findByProviderCallId('twilio', 'CAcap1'))!.id, inbound.callId);

  const view = await adminA.get({ callId: inbound.callId });
  assert.equal(view.direction, 'inbound');
  assert.equal(view.conversationId, 'conv_1');
  assert.ok(!('providerCallId' in view));
  assert.equal(view.provider, 'twilio');
  assert.deepEqual(provider.created, []);
});

test('authorization: what a caller may do is decided by the session, server-side', async () => {
  const { memberA, adminA, telephonyA, application } = setup();
  // Members read and end; only admins create; only the telephony webhook ingests.
  await assert.rejects(memberA.create({ direction: 'outbound', to: '+15551230000' }), rejectsWith('FORBIDDEN'));
  const created = await adminA.create({ direction: 'outbound', to: '+15551230000' });
  assert.equal((await memberA.get({ callId: created.callId })).status, 'created');
  assert.equal((await memberA.end({ callId: created.callId })).status, 'canceled');
  await assert.rejects(adminA.create({ direction: 'inbound', providerCallId: 'CAnope', to: '+15550001000' }), rejectsWith('FORBIDDEN'));
  assert.equal((await telephonyA.create({ direction: 'inbound', providerCallId: 'CAyes', to: '+15550001000' })).status, 'ringing');

  // No session at all: unauthenticated. A session without an account cannot act on any call.
  const anonymous = await application.handleRequest(createRequest({ requestId: newRequestId(), capability: { name: 'call.list', version: 1 }, input: {} }));
  assert.equal(anonymous.ok, false);
  assert.equal(!anonymous.ok && anonymous.error.code, 'UNAUTHORIZED');
  const accountless = new CallCapabilityClient(application, { ...appPortSessionFor(tenant('acct_a', 'admin')), attributes: {} });
  await assert.rejects(accountless.list(), rejectsWith('UNAUTHORIZED'));
  // Input that is not in the contract is refused before anything runs.
  const bad = await application.handleRequest(createRequest({ requestId: newRequestId(), capability: { name: 'call.get', version: 1 }, input: { callId: 'x', accountId: 'acct_b' } }), { session: appPortSessionFor(tenant('acct_a', 'admin')) });
  assert.equal(!bad.ok && bad.error.code, 'INVALID_INPUT');
});

test('ownership: a caller can neither read, list nor end another account\'s call, and learns nothing by guessing', async () => {
  const { adminA, adminB, memberA, provider, calls } = setup();
  const mine = await adminA.create({ direction: 'outbound', to: '+15551230000' });
  await calls.transition(mine.callId, 'initiating');
  await calls.recordDialed(mine.callId, 'CAown1');
  await calls.transition(mine.callId, 'answered');

  // Another account: exactly the answer it would get for a call that does not exist.
  const guessed = await adminB.get({ callId: 'call_ffffffffffffffffffffffffffffffff' }).catch((error) => error);
  const foreign = await adminB.get({ callId: mine.callId }).catch((error) => error);
  assert.equal(foreign.code, 'NOT_FOUND');
  assert.equal(foreign.message, guessed.message);
  await assert.rejects(adminB.end({ callId: mine.callId }), rejectsWith('NOT_FOUND'));
  assert.deepEqual(provider.ended, [], 'nothing was ended at the provider');
  assert.deepEqual((await adminB.list()).items, []);
  assert.equal((await adminA.list()).items.length, 1);
  assert.equal((await memberA.get({ callId: mine.callId })).status, 'answered');
  // The owner can.
  assert.equal((await adminA.end({ callId: mine.callId })).status, 'ending');
  assert.deepEqual(provider.ended, [{ providerCallId: 'CAown1', mode: 'complete' }]);
});

test('call.get waits, boundedly, for the next change: create → get → wait → get', async () => {
  const { adminA, calls } = setup();
  const { callId } = await adminA.create({ direction: 'outbound', to: '+15551230000' });
  const first = await adminA.get({ callId });
  assert.equal(first.status, 'created');

  // A change arrives while the client is waiting: the wait ends promptly with the new state.
  setTimeout(() => void calls.beginDial(callId), 40);
  const started = Date.now();
  const next = await adminA.get({ callId, waitSeconds: 5, sinceVersion: first.version });
  assert.equal(next.status, 'initiating');
  assert.ok(next.version > first.version);
  assert.ok(Date.now() - started < 2000, 'returned when the call changed, not after the full wait');

  // Already past the version the client has seen: no waiting at all.
  const immediate = Date.now();
  assert.equal((await adminA.get({ callId, waitSeconds: 10, sinceVersion: first.version })).status, 'initiating');
  assert.ok(Date.now() - immediate < 500);

  // A finished call never makes the client wait.
  await calls.end({ accountId: 'acct_a' }, callId);
  const ended = Date.now();
  assert.equal((await adminA.get({ callId, waitSeconds: 10 })).status, 'canceled');
  assert.ok(Date.now() - ended < 500);
});

test('call.get never outlives its request: waits are clamped and respect the deadline', async () => {
  assert.equal(MAX_WAIT_SECONDS, 20);
  const { adminA } = setup({ pollIntervalMs: 10 });
  const { callId } = await adminA.create({ direction: 'outbound', to: '+15551230000' });
  // An absurd wait under a short request timeout ends at the timeout, with the current state and no error.
  const started = Date.now();
  const view = await adminA.get({ callId, waitSeconds: 100000 }, { timeoutMs: 400 });
  const elapsed = Date.now() - started;
  assert.equal(view.status, 'created');
  assert.ok(elapsed < 1200, `took ${elapsed}ms`);
  // Negative and fractional waits are harmless.
  assert.equal((await adminA.get({ callId, waitSeconds: 0 })).status, 'created');
});

test('call.list filters, pages, and is scoped to the caller\'s account', async () => {
  const { adminA, adminB, telephonyA } = setup();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 4)); // distinct creation times: order is (createdAt, id)
  for (let index = 0; index < 3; index += 1) { await telephonyA.create({ direction: 'inbound', providerCallId: `CAlist${index}`, to: '+15550001000' }); await tick(); }
  const outbound = await adminA.create({ direction: 'outbound', to: '+15551230000' });
  await tick();
  await adminB.create({ direction: 'outbound', to: '+15551230000' });

  const all = await adminA.list();
  assert.equal(all.items.length, 4);
  assert.equal(all.items[0].callId, outbound.callId, 'newest first');
  assert.deepEqual((await adminA.list({ direction: 'outbound' })).items.map((item) => item.callId), [outbound.callId]);
  assert.equal((await adminA.list({ direction: 'inbound', status: ['ringing'] })).items.length, 3);
  assert.equal((await adminA.list({ status: ['completed'] })).items.length, 0);
  const page = await adminA.list({ limit: 3 });
  assert.equal(page.items.length, 3);
  const rest = await adminA.list({ limit: 3, cursor: page.nextCursor! });
  assert.deepEqual([...page.items, ...rest.items].map((item) => item.callId), all.items.map((item) => item.callId));
  assert.equal(rest.nextCursor, null);
  await assert.rejects(adminA.list({ createdAfter: 'yesterday' }), rejectsWith('INVALID_INPUT'));
  await assert.rejects(adminA.list({ limit: 1000 }), rejectsWith('INVALID_INPUT'));
});

test('call.end is idempotent and goes through the provider boundary exactly once', async () => {
  const { adminA, provider, calls, store } = setup();
  const created = await adminA.create({ direction: 'outbound', to: '+15551230000' });
  await calls.beginDial(created.callId);
  await calls.recordDialed(created.callId, 'CAend1');
  await calls.transition(created.callId, 'ringing');
  await calls.transition(created.callId, 'answered');

  const key = 'end-once';
  const results = await Promise.all([adminA.end({ callId: created.callId, reason: 'test' }, { idempotencyKey: key }), adminA.end({ callId: created.callId, reason: 'test' }, { idempotencyKey: key })]);
  assert.ok(results.every((view) => view.status === 'ending'));
  await adminA.end({ callId: created.callId });
  assert.deepEqual(provider.ended, [{ providerCallId: 'CAend1', mode: 'complete' }]);

  await calls.applyProviderEvent({ provider: 'twilio', providerCallId: 'CAend1', eventId: 'CAend1:completed', rawStatus: 'completed', status: 'completed' });
  const final = await adminA.end({ callId: created.callId });
  assert.equal(final.status, 'completed');
  assert.equal(provider.ended.length, 1, 'an ended call is never ended again');
  assert.equal((await store.findByProviderCallId('twilio', 'CAend1'))!.endReason, 'test');
});

test('request metadata is preserved: idempotency key, trace id and timeout reach the call', async () => {
  const store = new InMemoryCallSessionStore();
  const first = setup({ store });
  const key = 'create-once-please';
  const a = await first.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key, traceId: 'trace-meta-1', timeoutMs: 5000 });
  const b = await first.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key, traceId: 'trace-meta-2' });
  assert.equal(b.callId, a.callId, 'a retry is the same call');
  assert.equal((await first.adminA.list()).items.length, 1);

  // A different application instance (a cold start, another server) sharing the durable store dedupes the same way:
  // the guarantee lives in the stored CallSession, not in any one process's replay cache.
  const second = setup({ store });
  const c = await second.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key });
  assert.equal(c.callId, a.callId);
  assert.equal((await second.adminA.list()).items.length, 1);
  // The same key for a different request is refused, not silently reused.
  await assert.rejects(second.adminA.create({ direction: 'outbound', to: '+15559990000' }, { idempotencyKey: key }), rejectsWith('CONFLICT'));

  const stored = (await store.get('acct_a', a.callId))!;
  assert.equal(stored.idempotencyKey, key);
  assert.equal(stored.traceId, 'trace-meta-1', 'the creating request\'s trace id is on the record');
  assert.equal(stored.requestedBy, 'user_acct_a_admin');
  const logged = first.logs.find((entry) => entry.event === 'call.created')!;
  assert.equal(logged.fields.callId, a.callId);
  assert.equal(logged.fields.traceId, 'trace-meta-1');

  // End carries its trace id into the log as well.
  await first.adminA.end({ callId: a.callId }, { traceId: 'trace-end-9' });
  assert.ok(first.logs.some((entry) => entry.event === 'call.end.canceled' && entry.fields.traceId === 'trace-end-9' && entry.fields.callId === a.callId));
});

test('provider failures surface as errors without leaking provider detail, and leave the call observable', async () => {
  const { adminA, provider, calls } = setup();
  const created = await adminA.create({ direction: 'outbound', to: '+15551230000' });
  await calls.beginDial(created.callId);
  await calls.recordDialed(created.callId, 'CAfail1');
  await calls.transition(created.callId, 'answered');
  provider.failEnd = new Error('Twilio says: auth token abc123 is invalid');
  const error = await adminA.end({ callId: created.callId }).catch((caught) => caught);
  assert.equal(error.code, 'INTERNAL_ERROR');
  assert.ok(!String(error.message).includes('abc123'));
  assert.equal((await adminA.get({ callId: created.callId })).status, 'ending');
});

test('MCP projects exactly the call capabilities, through the same dispatch', async () => {
  const { application, provider } = setup();
  const admin = createCallMcpBridge(application, appPortSessionFor(tenant('acct_a', 'admin')));
  const member = createCallMcpBridge(application, appPortSessionFor(tenant('acct_a', 'member')));
  const other = createCallMcpBridge(application, appPortSessionFor(tenant('acct_b', 'admin')));

  assert.deepEqual(admin.listTools().map((tool) => tool.name).sort(), ['call_create', 'call_end', 'call_get', 'call_list']);
  const create = admin.listTools().find((tool) => tool.name === 'call_create')!;
  assert.deepEqual(create._appport.authorization, ['call.create'], 'the capability\'s own authorization travels with the tool');
  assert.equal(create.inputSchema.type, 'object');

  const created = await admin.callTool('call_create', { direction: 'outbound', to: '+15551230000' });
  assert.equal(created.isError, undefined);
  const { callId, status } = JSON.parse(created.content[0].text);
  assert.equal(status, 'created');
  const got = JSON.parse((await admin.callTool('call_get', { callId })).content[0].text);
  assert.equal(got.callId, callId);
  assert.equal(JSON.parse((await admin.callTool('call_list', {})).content[0].text).items.length, 1);

  // Same authorization as any other caller: the member cannot create; another account cannot see it.
  const denied = await member.callTool('call_create', { direction: 'outbound', to: '+15551230000' });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /^FORBIDDEN/);
  const foreign = await other.callTool('call_get', { callId });
  assert.equal(foreign.isError, true);
  assert.match(foreign.content[0].text, /^NOT_FOUND/);
  const invalid = await admin.callTool('call_get', { callId: 12 });
  assert.match(invalid.content[0].text, /^INVALID_INPUT/);

  // The projected operation is the capability: ending it through MCP is the same idempotent end.
  const ended = JSON.parse((await admin.callTool('call_end', { callId, reason: 'via mcp' })).content[0].text);
  assert.equal(ended.status, 'canceled');
  assert.equal(ended.endReason, 'via mcp');
  assert.deepEqual(provider.created, [], 'MCP cannot cause dialing either');
  assert.equal((await admin.callTool('no_such_tool', {})).isError, true);
});
