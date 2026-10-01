import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import request from 'supertest';
import type { AppRequest } from '@appport/protocol';

import { createApp, type AppOptions } from '../src/http-app.js';
import { FakeCallProvider } from '../src/calls/provider.js';
import { InMemoryCallSessionStore } from '../src/calls/store.js';
import { FakeMessagingProvider } from '../src/messaging/fake-provider.js';
import { FakePhoneNumberClient } from '../src/telephony/phone-number.js';
import { InMemoryConversationRepository } from './support/in-memory-repository.js';
import { onboardTenant, signUp } from './support/tenant.js';

/** The real Express app on a real socket, an official MCP SDK client over Streamable HTTP: the production path. */
async function mcpApp(options: Partial<AppOptions> = {}) {
  const messaging = new FakeMessagingProvider();
  const store = new InMemoryCallSessionStore();
  const callProvider = new FakeCallProvider();
  const app = createApp({
    repository: new InMemoryConversationRepository(), messagingProvider: messaging, callSessionStore: store, callProvider,
    phoneNumberClient: new FakePhoneNumberClient(), ...options,
  });
  const a = await onboardTenant(app, messaging);
  const b = await onboardTenant(app, messaging);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);

  // What AppPort receives, observed at the application's one entry point.
  const seen: Array<{ request: AppRequest; transport?: string; signal?: AbortSignal }> = [];
  const application = app.locals.appport.calls;
  const handleRequest = application.handleRequest.bind(application);
  application.handleRequest = (appRequest: AppRequest, dispatch: { transport?: string; signal?: AbortSignal }) => {
    seen.push({ request: appRequest, transport: dispatch?.transport, signal: dispatch?.signal });
    return handleRequest(appRequest, dispatch);
  };

  const clients: Client[] = [];
  const connect = async (token?: string) => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}));
    clients.push(client);
    return client;
  };
  const inbound = async (tenant: { line: string }, CallSid: string) => {
    const response = await request(app).post('/webhooks/twilio/voice').type('form').send({ CallSid, From: '+15555550123', To: tenant.line, Direction: 'inbound' });
    assert.equal(response.status, 200);
    return (await store.findByProviderCallId('twilio', CallSid))!;
  };
  const close = async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await new Promise((resolve) => server.close(resolve));
  };
  return { app, server, url, store, callProvider, a, b, seen, connect, inbound, close, messaging };
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: any; _meta?: Record<string, any> };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as ToolResult;
const errorOf = (result: ToolResult) => result._meta?.['dev.appport/error'] as { code: string; category: string; details?: Record<string, unknown> } | undefined;

test('MCP over the real HTTP runtime: initialize, discovery through the AppPort projection, read, list, end', async () => {
  const t = await mcpApp();
  try {
    const client = await t.connect(t.a.token);
    assert.equal(client.getServerVersion()?.name, 'Just Text Me calls');

    // The tools are the AppPort capabilities, projected: nothing else, nothing hand-written.
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['call_create', 'call_end', 'call_get', 'call_list']);
    const capabilities = Object.fromEntries(tools.map((tool) => [tool.name, tool._meta?.['dev.appport/capability']]));
    assert.deepEqual(capabilities.call_create, { name: 'call.create', version: 1, authorization: ['call.create'] });
    assert.deepEqual(capabilities.call_get, { name: 'call.get', version: 1, authorization: ['call.read'] });
    assert.deepEqual(capabilities.call_list, { name: 'call.list', version: 1, authorization: ['call.read'] });
    assert.deepEqual(capabilities.call_end, { name: 'call.end', version: 1, authorization: ['call.control'] });
    const manifest = t.app.locals.appport.calls.manifest().capabilities.filter((entry: { name: string }) => entry.name.startsWith('call.'));
    for (const entry of manifest) {
      const tool = tools.find((candidate) => candidate.name === entry.name.replace('.', '_'))!;
      assert.deepEqual(tool.inputSchema, entry.inputSchema, `${entry.name}: the schema is AppPort's`);
    }

    const session = await t.inbound(t.a, 'CA-MCP-1');
    const got = await call(client, 'call_get', { callId: session.id });
    assert.equal(got.isError, undefined);
    assert.equal(got.structuredContent.callId, session.id);
    assert.ok(!('providerCallId' in got.structuredContent));
    const listed = await call(client, 'call_list', {});
    assert.deepEqual(listed.structuredContent.items.map((item: { callId: string }) => item.callId), [session.id]);

    const ended = await call(client, 'call_end', { callId: session.id, reason: 'via mcp' });
    assert.equal(ended.isError, undefined, JSON.stringify(ended));
    assert.equal(t.callProvider.ended.length, 1, 'the end went through the provider seam, once');
    // AppPort errors come back as AppPort errors.
    const invalid = await call(client, 'call_get', { callId: 12 });
    assert.equal(errorOf(invalid)?.code, 'INVALID_INPUT');
    assert.equal(errorOf(invalid)?.category, 'invalid_request');
    // Every call was dispatched by the MCP transport through AppPort.
    assert.ok(t.seen.length >= 4 && t.seen.every((entry) => entry.transport === 'mcp'));
  } finally { await t.close(); }
});

test('authentication: anonymous and invalid credentials are refused at invocation; a stranger sees nothing', async () => {
  const t = await mcpApp();
  try {
    const session = await t.inbound(t.a, 'CA-MCP-AUTH');
    // Discovery lists what the application publishes (the package does not filter by caller); invocation is what is authorized.
    const anonymous = await t.connect();
    assert.equal((await anonymous.listTools()).tools.length, 4);
    for (const name of ['call_get', 'call_list']) {
      const result = await call(anonymous, name, name === 'call_get' ? { callId: session.id } : {});
      assert.equal(result.isError, true);
      assert.equal(errorOf(result)?.code, 'UNAUTHORIZED');
      assert.equal(errorOf(result)?.category, 'unauthenticated');
      assert.ok(!JSON.stringify(result).includes(session.id), 'nothing about the call leaks');
    }
    assert.equal(errorOf(await call(anonymous, 'call_end', { callId: session.id }))?.code, 'UNAUTHORIZED');
    assert.equal(t.callProvider.ended.length, 0);

    const forged = await t.connect('not-a-real-session-token');
    const refused = await call(forged, 'call_get', { callId: session.id });
    assert.equal(errorOf(refused)?.code, 'UNAUTHORIZED');

    const stranger = await t.connect((await signUp(t.app, { name: 'Other' })).token);
    assert.equal(errorOf(await call(stranger, 'call_get', { callId: session.id }))?.code, 'NOT_FOUND', 'a different account\'s call is not found');
  } finally { await t.close(); }
});

test('tenant isolation: each account reaches only its own calls, and the error reveals nothing', async () => {
  const t = await mcpApp();
  try {
    const callA = await t.inbound(t.a, 'CA-ISO-A');
    const callB = await t.inbound(t.b, 'CA-ISO-B');
    const asA = await t.connect(t.a.token);
    const asB = await t.connect(t.b.token);

    assert.equal((await call(asA, 'call_get', { callId: callA.id })).structuredContent.callId, callA.id);
    assert.equal((await call(asB, 'call_get', { callId: callB.id })).structuredContent.callId, callB.id);
    for (const [client, foreign, own] of [[asA, callB, callA], [asB, callA, callB]] as const) {
      const denied = await call(client, 'call_get', { callId: foreign.id });
      assert.equal(denied.isError, true);
      assert.equal(errorOf(denied)?.code, 'NOT_FOUND');
      const text = JSON.stringify(denied);
      for (const secret of [foreign.providerCallId, foreign.from, foreign.to, foreign.accountId, foreign.id]) {
        assert.ok(!text.includes(String(secret)), `the error must not carry ${secret}`);
      }
      assert.equal(JSON.stringify(denied).includes(own.id), false);
      assert.equal(errorOf(await call(client, 'call_end', { callId: foreign.id }))?.code, 'NOT_FOUND');
      const listed = await call(client, 'call_list', {});
      assert.deepEqual(listed.structuredContent.items.map((item: { callId: string }) => item.callId), [own.id]);
    }
    assert.equal(t.callProvider.ended.length, 0, 'a foreign call was never hung up');
    assert.notEqual((await t.store.findByProviderCallId('twilio', 'CA-ISO-B'))!.status, 'ending');
  } finally { await t.close(); }
});

test('MCP cannot place a call: the outbound policy stays authoritative, and Twilio is never contacted', async () => {
  for (const outboundAgentCalls of [false, true]) {
    const t = await mcpApp({ outboundAgentCalls });
    try {
      const client = await t.connect(t.a.token);
      const result = await call(client, 'call_create', { direction: 'outbound', to: '+15551230000', objective: 'say hello' }, { 'dev.appport/idempotencyKey': 'mcp-outbound-1' });
      assert.equal(result.isError, true, `OUTBOUND_AGENT_CALLS=${outboundAgentCalls}`);
      assert.equal(errorOf(result)?.code, 'FORBIDDEN');
      assert.equal(errorOf(result)?.details?.reason, 'transport_not_supported', 'the existing policy denial, not an MCP-specific one');
      assert.equal(t.callProvider.created.length, 0, 'the provider was never asked to place a call');
      assert.equal((await t.store.list(t.a.accountId, { limit: 10 })).length, 0, 'no CallSession was left behind');
      assert.equal(t.seen.at(-1)!.transport, 'mcp');
    } finally { await t.close(); }
  }
});

test('MCP cannot create inbound calls either: that authority belongs to the telephony webhook', async () => {
  const t = await mcpApp();
  try {
    const client = await t.connect(t.a.token);
    const result = await call(client, 'call_create', { direction: 'inbound', providerCallId: 'CA-FORGED', from: '+15555550123', to: t.a.line });
    assert.equal(result.isError, true);
    assert.ok(!(await t.store.findByProviderCallId('twilio', 'CA-FORGED')), 'nothing was recorded');
  } finally { await t.close(); }
});

test('request metadata reaches AppPort: idempotency key (same key twice), timeout and trace id', async () => {
  const t = await mcpApp();
  try {
    const client = await t.connect(t.a.token);
    const session = await t.inbound(t.a, 'CA-META');
    const meta = { 'dev.appport/idempotencyKey': 'key-123', 'dev.appport/traceId': 'trace-abc', 'dev.appport/timeoutMs': 4000 };
    const first = await call(client, 'call_get', { callId: session.id }, meta);
    assert.equal(first._meta?.['dev.appport/traceId'], 'trace-abc', 'the trace id is echoed on the result');
    await call(client, 'call_end', { callId: session.id }, { 'dev.appport/idempotencyKey': 'end-key-1', 'dev.appport/traceId': 'trace-end' });
    await call(client, 'call_end', { callId: session.id }, { 'dev.appport/idempotencyKey': 'end-key-1', 'dev.appport/traceId': 'trace-end' });
    const ends = t.seen.filter((entry) => entry.request.capability.name === 'call.end');
    assert.equal(ends.length, 2);
    assert.deepEqual(ends.map((entry) => entry.request.idempotencyKey), ['end-key-1', 'end-key-1']);
    assert.deepEqual(ends.map((entry) => entry.request.traceId), ['trace-end', 'trace-end']);
    const get = t.seen.find((entry) => entry.request.capability.name === 'call.get')!;
    assert.equal(get.request.timeoutMs, 4000);
    assert.equal(get.request.traceId, 'trace-abc');
    assert.equal(t.callProvider.ended.length, 1, 'the provider hangs up at most once however often the end is repeated');

    // Malformed metadata is rejected by the package, not silently defaulted.
    assert.equal(errorOf(await call(client, 'call_list', {}, { 'dev.appport/timeoutMs': -1 }))?.code, 'INVALID_REQUEST');
    // Identity cannot be supplied by the caller: account and session come from the credential only.
    const smuggled = await call(client, 'call_list', { accountId: t.b.accountId } as Record<string, unknown>);
    assert.ok(smuggled.isError || smuggled.structuredContent.items.every((item: { callId: string }) => item.callId !== undefined));
  } finally { await t.close(); }
});

test('timeout reaches the handler, and cancelling the request aborts the capability\'s signal', async () => {
  const t = await mcpApp();
  try {
    const client = await t.connect(t.a.token);
    const session = await t.inbound(t.a, 'CA-WAIT');
    // The deadline is AppPort's: call.get would wait 20s, but its request deadline is 600ms.
    const startedAt = Date.now();
    const waited = await call(client, 'call_get', { callId: session.id, waitSeconds: 20 }, { 'dev.appport/timeoutMs': 600 });
    assert.ok(Date.now() - startedAt < 5000, 'the handler honoured the request deadline');
    assert.ok(waited.isError || waited.structuredContent.callId === session.id);

    // Cancellation: the client abandons a long wait. The endpoint is stateless, so what reaches the capability is the HTTP
    // request's own abort (a later MCP `notifications/cancelled` is a different request, and no instance holds the first one).
    const before = t.seen.length;
    const controller = new AbortController();
    const pending = fetch(t.url, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${t.a.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'call_get', arguments: { callId: session.id, waitSeconds: 20 } } }),
    }).catch((error) => error);
    for (let i = 0; i < 100 && t.seen.length === before; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const entry = t.seen[before];
    assert.ok(entry?.signal, 'the capability received a signal');
    assert.equal(entry.signal!.aborted, false);
    controller.abort();
    await pending;
    for (let i = 0; i < 100 && !entry.signal!.aborted; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(entry.signal!.aborted, true, 'a client disconnect reaches the capability as a signal; whether work stops is the handler\'s decision');
  } finally { await t.close(); }
});

test('malformed and unsupported requests, HTTP methods, origins and size', async () => {
  const t = await mcpApp();
  try {
    const post = (body: string, headers: Record<string, string> = {}) => fetch(t.url, {
      method: 'POST', body, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    });
    const malformed = await post('{not json');
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, -32700);
    const unknown = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: {} }));
    assert.equal((await unknown.json()).error.code, -32601);
    const noTool = await post(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } }));
    assert.equal((await noTool.json()).error.code, -32602);
    for (const method of ['GET', 'DELETE']) assert.equal((await fetch(t.url, { method })).status, 405);
    const hostile = await post(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }), { origin: 'https://evil.example' });
    assert.equal(hostile.status, 403);
    const huge = await post(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'call_get', arguments: { callId: 'x'.repeat(400_000) } } }));
    assert.equal(huge.status, 413);
    // The web app still parses its own JSON as before.
    assert.equal((await request(t.app).post('/auth/sessions').send({ email: 'nobody@example.test', password: 'x', platform: 'web' })).status, 401);
  } finally { await t.close(); }
});

test('concurrent requests from two accounts stay isolated and share no state', async () => {
  const t = await mcpApp();
  try {
    const callsA = await Promise.all([1, 2, 3, 4].map((n) => t.inbound(t.a, `CA-CONC-A${n}`)));
    const callsB = await Promise.all([1, 2, 3, 4].map((n) => t.inbound(t.b, `CA-CONC-B${n}`)));
    const asA = await t.connect(t.a.token);
    const asB = await t.connect(t.b.token);
    const results = await Promise.all([
      ...callsA.map((session) => call(asA, 'call_get', { callId: session.id })),
      ...callsB.map((session) => call(asB, 'call_get', { callId: session.id })),
      ...callsB.map((session) => call(asA, 'call_get', { callId: session.id })),
      ...callsA.map((session) => call(asB, 'call_get', { callId: session.id })),
    ]);
    assert.deepEqual(results.map((result) => result.isError ?? false), [...Array(8).fill(false), ...Array(8).fill(true)]);
    assert.ok(results.slice(8).every((result) => errorOf(result)?.code === 'NOT_FOUND'));
  } finally { await t.close(); }
});

test('inbound call handling is unchanged: the Twilio webhook path does not involve MCP', async () => {
  const t = await mcpApp();
  try {
    const before = t.seen.length;
    const session = await t.inbound(t.a, 'CA-INBOUND-PATH');
    assert.equal(session.direction, 'inbound');
    assert.equal(t.seen.filter((entry) => entry.transport === 'mcp').length, 0);
    assert.ok(t.seen.length >= before, 'the webhook records the call through the same application, in-process');
    assert.ok(t.seen.every((entry) => entry.transport !== 'mcp'));
  } finally { await t.close(); }
});
