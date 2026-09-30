import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequest, newRequestId } from '@appport/protocol';

import { appPortSessionFor } from '../src/appport/session.js';
import { CallCapabilityClient } from '../src/appport/call-client.js';
import { MAX_WAIT_SECONDS } from '../src/appport/call-application.js';
import { createCallMcpBridge } from '../src/appport/mcp.js';
import { InMemoryCallSessionStore } from '../src/calls/store.js';
import { FakeCallProvider } from '../src/calls/provider.js';
import { createCallStack, LINE_A, tenant } from './support/calls.js';

const rejectsWith = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
const key = (() => { let n = 0; return (label = 'k') => `${label}-${Date.now().toString(36)}-${n++}`; })();

test('the four call capabilities are declared, versioned and provider-blind', () => {
  const { application } = createCallStack();
  const manifest = application.manifest();
  const call = manifest.capabilities.filter((entry) => entry.name.startsWith('call.'));
  assert.deepEqual(call.map((entry) => `${entry.name}@${entry.latestVersion}`).sort(), ['call.create@1', 'call.end@1', 'call.get@1', 'call.list@1']);
  assert.deepEqual(Object.fromEntries(call.map((entry) => [entry.name, entry.authorization])), {
    'call.create': ['call.create'], 'call.get': ['call.read'], 'call.list': ['call.read'], 'call.end': ['call.control'],
  });
  // The contract is a domain API, not a Twilio wrapper: no URLs, credentials or provider parameters can be supplied.
  const input = JSON.stringify(call.find((entry) => entry.name === 'call.create')!.inputSchema);
  for (const forbidden of ['url', 'callback', 'twiml', 'token', 'credential', 'statusCallback', 'machineDetection', 'record']) {
    assert.ok(!new RegExp(`"${forbidden}`, 'i').test(input), `call.create must not accept ${forbidden}`);
  }
  const output = JSON.stringify(call.find((entry) => entry.name === 'call.get')!.outputSchema);
  assert.ok(!output.includes('providerCallId'));
});

test('call.create places an outbound call and returns at once; an inbound call is recorded by the telephony webhook', async () => {
  const { adminA, telephonyA, provider, store } = createCallStack();
  const outbound = await adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key() });
  assert.deepEqual(Object.keys(outbound).sort(), ['callId', 'status']);
  assert.equal(outbound.status, 'initiating', 'handed to the provider, not yet answered by anyone');
  assert.equal(provider.created.length, 1);
  assert.equal(provider.created[0].from, LINE_A, 'the account\'s own line');
  assert.equal(provider.created[0].to, '+15551230000');

  const inbound = await telephonyA.create({ direction: 'inbound', providerCallId: 'CAcap1', from: '+15555550123', to: LINE_A, conversationId: 'conv_1' });
  assert.equal(inbound.status, 'ringing');
  assert.notEqual(inbound.callId, 'CAcap1');
  assert.equal((await store.findByProviderCallId('twilio', 'CAcap1'))!.id, inbound.callId);
  const view = await adminA.get({ callId: inbound.callId });
  assert.equal(view.direction, 'inbound');
  assert.equal(view.execution, null, 'nothing was placed for an inbound call');
  assert.ok(!('providerCallId' in view));
  assert.equal(provider.created.length, 1, 'recording an inbound call never dials');
});

test('authorization: what a caller may do is decided by the session, server-side', async () => {
  const { memberA, adminA, telephonyA, application, provider } = createCallStack();
  // Members read and end; only admins create and place; only the telephony webhook ingests, and it can never place a call.
  await assert.rejects(memberA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key() }), rejectsWith('FORBIDDEN'));
  await assert.rejects(telephonyA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key() }), rejectsWith('FORBIDDEN'));
  assert.equal(provider.created.length, 0);
  const created = await adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key() });
  assert.equal((await memberA.get({ callId: created.callId })).status, 'initiating');
  await assert.rejects(adminA.create({ direction: 'inbound', providerCallId: 'CAnope', to: LINE_A }), rejectsWith('FORBIDDEN'));
  assert.equal((await telephonyA.create({ direction: 'inbound', providerCallId: 'CAyes', to: LINE_A })).status, 'ringing');

  // A session that may create but not place cannot cause a call.
  const createOnly = new CallCapabilityClient(application, { ...appPortSessionFor(tenant('acct_a', 'admin')), permissions: ['call.create', 'call.read'] });
  await assert.rejects(createOnly.create({ direction: 'outbound', to: '+15559990000' }, { idempotencyKey: key() }), rejectsWith('FORBIDDEN'));
  assert.equal(provider.created.length, 1);

  // No session: unauthenticated. A session without an account cannot act on any call.
  const anonymous = await application.handleRequest(createRequest({ requestId: newRequestId(), capability: { name: 'call.list', version: 1 }, input: {} }));
  assert.equal(!anonymous.ok && anonymous.error.code, 'UNAUTHORIZED');
  const accountless = new CallCapabilityClient(application, { ...appPortSessionFor(tenant('acct_a', 'admin')), attributes: {} });
  await assert.rejects(accountless.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key() }), rejectsWith('UNAUTHORIZED'));
  assert.equal(provider.created.length, 1);
  const bad = await application.handleRequest(createRequest({ requestId: newRequestId(), capability: { name: 'call.get', version: 1 }, input: { callId: 'x', accountId: 'acct_b' } }), { session: appPortSessionFor(tenant('acct_a', 'admin')) });
  assert.equal(!bad.ok && bad.error.code, 'INVALID_INPUT');
});

test('ownership: a caller can neither read, list nor end another account\'s call, and learns nothing by guessing', async () => {
  const { adminA, adminB, memberA, provider, calls, store } = createCallStack();
  const mine = await adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key() });
  await calls.transition(mine.callId, 'answered');
  const sid = (await store.get('acct_a', mine.callId))!.providerCallId!;

  const guessed = await adminB.get({ callId: 'call_ffffffffffffffffffffffffffffffff' }).catch((error) => error);
  const foreign = await adminB.get({ callId: mine.callId }).catch((error) => error);
  assert.equal(foreign.code, 'NOT_FOUND');
  assert.equal(foreign.message, guessed.message);
  await assert.rejects(adminB.end({ callId: mine.callId }), rejectsWith('NOT_FOUND'));
  assert.deepEqual(provider.ended, [], 'nothing was ended at the provider');
  assert.deepEqual((await adminB.list()).items, []);
  assert.equal((await memberA.get({ callId: mine.callId })).status, 'answered');
  assert.equal((await adminA.end({ callId: mine.callId })).status, 'ending');
  assert.deepEqual(provider.ended, [{ providerCallId: sid, mode: 'complete' }]);
});

test('call.get observes the call as it progresses, and waits boundedly for the next change', async () => {
  const { adminA, calls } = createCallStack();
  const { callId } = await adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key() });
  const first = await adminA.get({ callId });
  assert.equal(first.status, 'initiating');
  assert.equal(first.execution, 'accepted');

  // The phone starts ringing while the client is waiting: the wait ends promptly with the new state.
  setTimeout(() => void calls.transition(callId, 'ringing'), 40);
  const started = Date.now();
  const ringing = await adminA.get({ callId, waitSeconds: 5, sinceVersion: first.version });
  assert.equal(ringing.status, 'ringing');
  assert.ok(ringing.version > first.version);
  assert.ok(Date.now() - started < 2000, 'returned when the call changed, not after the full wait');

  // Already past the version the client has seen: no waiting at all.
  const immediate = Date.now();
  assert.equal((await adminA.get({ callId, waitSeconds: 10, sinceVersion: first.version })).status, 'ringing');
  assert.ok(Date.now() - immediate < 500);

  await calls.transition(callId, 'answered');
  await calls.transition(callId, 'in_progress');
  await adminA.end({ callId });
  await calls.applyProviderEvent({ provider: 'twilio', providerCallId: (await calls.get('acct_a', callId)).providerCallId!, eventId: 'done', rawStatus: 'completed', status: 'completed' });
  const ended = Date.now();
  assert.equal((await adminA.get({ callId, waitSeconds: 10 })).status, 'completed');
  assert.ok(Date.now() - ended < 500, 'a finished call never makes the client wait');
});

test('call.get never outlives its request: waits are clamped and respect the deadline', async () => {
  assert.equal(MAX_WAIT_SECONDS, 20);
  const { adminA } = createCallStack({ pollIntervalMs: 10 });
  const { callId } = await adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key() });
  const started = Date.now();
  const view = await adminA.get({ callId, waitSeconds: 100000 }, { timeoutMs: 400 });
  assert.equal(view.status, 'initiating');
  assert.ok(Date.now() - started < 1200, `took ${Date.now() - started}ms`);
  assert.equal((await adminA.get({ callId, waitSeconds: 0 })).status, 'initiating');
});

test('call.list filters, pages, and is scoped to the caller\'s account', async () => {
  const { adminA, adminB, telephonyA } = createCallStack();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 4)); // distinct creation times: order is (createdAt, id)
  for (let index = 0; index < 3; index += 1) { await telephonyA.create({ direction: 'inbound', providerCallId: `CAlist${index}`, to: LINE_A }); await tick(); }
  const outbound = await adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key() });
  await tick();
  await adminB.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key() });

  const all = await adminA.list();
  assert.equal(all.items.length, 4);
  assert.equal(all.items[0].callId, outbound.callId, 'newest first');
  assert.deepEqual((await adminA.list({ direction: 'outbound' })).items.map((item) => item.callId), [outbound.callId]);
  assert.equal((await adminA.list({ direction: 'inbound', status: ['ringing'] })).items.length, 3);
  assert.equal((await adminA.list({ status: ['completed'] })).items.length, 0);
  const page = await adminA.list({ limit: 3 });
  const rest = await adminA.list({ limit: 3, cursor: page.nextCursor! });
  assert.deepEqual([...page.items, ...rest.items].map((item) => item.callId), all.items.map((item) => item.callId));
  assert.equal(rest.nextCursor, null);
  await assert.rejects(adminA.list({ createdAfter: 'yesterday' }), rejectsWith('INVALID_INPUT'));
  await assert.rejects(adminA.list({ limit: 1000 }), rejectsWith('INVALID_INPUT'));
});

test('request metadata is preserved: idempotency key and trace id reach the durable call, on every instance', async () => {
  const store = new InMemoryCallSessionStore();
  const provider = new FakeCallProvider();
  const first = createCallStack({ store, provider });
  const second = createCallStack({ store, provider });
  const idempotencyKey = key('create-once');
  const a = await first.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey, traceId: 'trace-meta-1', timeoutMs: 5000 });
  const b = await first.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey, traceId: 'trace-meta-2' });
  assert.equal(b.callId, a.callId, 'a retry is the same call');
  // Another application instance over the same database dedupes the same way: the guarantee is in the stored call.
  const c = await second.adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey });
  assert.equal(c.callId, a.callId);
  assert.equal((await first.adminA.list()).items.length, 1);
  assert.equal(provider.created.length, 1, 'one request, one provider call');
  // The same key for a different request is refused, never silently reused.
  await assert.rejects(second.adminA.create({ direction: 'outbound', to: '+15559990000' }, { idempotencyKey }), rejectsWith('CONFLICT'));
  assert.equal(provider.created.length, 1);

  const stored = (await store.get('acct_a', a.callId))!;
  assert.equal(stored.idempotencyKey, idempotencyKey);
  assert.equal(stored.traceId, 'trace-meta-1', 'the creating request\'s trace id is on the record');
  assert.equal(stored.requestedBy, 'user_acct_a_admin');
  const logged = first.logs.find((entry) => entry.event === 'call.created')!;
  assert.equal(logged.fields.callId, a.callId);
  assert.equal(logged.fields.traceId, 'trace-meta-1');
});

test('call.end is idempotent and goes through the provider boundary exactly once', async () => {
  const { adminA, provider, calls, store } = createCallStack();
  const created = await adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key() });
  await calls.transition(created.callId, 'ringing');
  await calls.transition(created.callId, 'answered');
  const sid = (await store.get('acct_a', created.callId))!.providerCallId!;

  const endKey = 'end-once';
  const results = await Promise.all([adminA.end({ callId: created.callId, reason: 'test' }, { idempotencyKey: endKey }), adminA.end({ callId: created.callId, reason: 'test' }, { idempotencyKey: endKey })]);
  assert.ok(results.every((view) => view.status === 'ending'));
  await adminA.end({ callId: created.callId });
  assert.deepEqual(provider.ended, [{ providerCallId: sid, mode: 'complete' }]);
  await calls.applyProviderEvent({ provider: 'twilio', providerCallId: sid, eventId: `${sid}:completed`, rawStatus: 'completed', status: 'completed' });
  assert.equal((await adminA.end({ callId: created.callId })).status, 'completed');
  assert.equal(provider.ended.length, 1, 'an ended call is never ended again');
  assert.equal((await store.findByProviderCallId('twilio', sid))!.endReason, 'test');
});

test('provider failures on end surface as errors without leaking provider detail, and leave the call observable', async () => {
  const { adminA, provider, calls } = createCallStack();
  const created = await adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key() });
  await calls.transition(created.callId, 'answered');
  provider.failEnd = new Error('Twilio says: auth token abc123 is invalid');
  const error = await adminA.end({ callId: created.callId }).catch((caught) => caught);
  assert.equal(error.code, 'INTERNAL_ERROR');
  assert.ok(!String(error.message).includes('abc123'));
  assert.equal((await adminA.get({ callId: created.callId })).status, 'ending');
});

test('MCP projects the call capabilities, but cannot place a call: it cannot carry the request\'s metadata', async () => {
  const { application, provider, calls, adminA } = createCallStack();
  const admin = createCallMcpBridge(application, appPortSessionFor(tenant('acct_a', 'admin')));
  const member = createCallMcpBridge(application, appPortSessionFor(tenant('acct_a', 'member')));
  const other = createCallMcpBridge(application, appPortSessionFor(tenant('acct_b', 'admin')));

  assert.deepEqual(admin.listTools().map((tool) => tool.name).sort(), ['call_create', 'call_end', 'call_get', 'call_list']);
  const create = admin.listTools().find((tool) => tool.name === 'call_create')!;
  assert.deepEqual(create._appport.authorization, ['call.create']);

  // Placing a call over MCP is refused before anything is created or dialed, whatever the session may do.
  const refused = await admin.callTool('call_create', { direction: 'outbound', to: '+15551230000' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /^FORBIDDEN/);
  assert.match(refused.content[0].text, /idempotency key, timeout and trace id|transport/i);
  assert.equal(provider.created.length, 0);
  assert.equal((await adminA.list()).items.length, 0, 'not even a durable session was left behind');

  // Reading and ending go through the same dispatch, with the same authorization.
  const made = await adminA.create({ direction: 'outbound', to: '+15551230000' }, { idempotencyKey: key() });
  assert.equal(JSON.parse((await admin.callTool('call_get', { callId: made.callId })).content[0].text).callId, made.callId);
  assert.equal(JSON.parse((await admin.callTool('call_list', {})).content[0].text).items.length, 1);
  const foreign = await other.callTool('call_get', { callId: made.callId });
  assert.match(foreign.content[0].text, /^NOT_FOUND/);
  assert.match((await admin.callTool('call_get', { callId: 12 })).content[0].text, /^INVALID_INPUT/);
  assert.equal((await member.callTool('call_create', { direction: 'outbound', to: '+15551230000' })).isError, true);
  await calls.transition(made.callId, 'answered');
  assert.equal(JSON.parse((await admin.callTool('call_end', { callId: made.callId, reason: 'via mcp' })).content[0].text).status, 'ending');
  assert.equal(provider.ended.length, 1);
  assert.equal((await admin.callTool('no_such_tool', {})).isError, true);
});
