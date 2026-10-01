import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Session } from '@appport/protocol';
import type { AppPortApplication } from '@appport/core';
import { createCallMcpServer } from '../../src/appport/mcp.js';

import { appPortSessionFor, telephonySessionFor } from '../../src/appport/session.js';
import { CallCapabilityClient } from '../../src/appport/call-client.js';
import { createCallApplication } from '../../src/appport/call-application.js';
import { DefaultOutboundPolicy, type OutboundPolicy } from '../../src/calls/outbound-policy.js';
import { FakeCallProvider } from '../../src/calls/provider.js';
import { CallSessionService } from '../../src/calls/service.js';
import { InMemoryCallSessionStore, type CallSessionStore } from '../../src/calls/store.js';
import { CallCostLedger } from '../../src/calls/cost/ledger.js';
import type { PriceBook } from '../../src/calls/cost/pricing.js';
import { InMemoryCallUsageStore, type CallUsageStore } from '../../src/calls/cost/store.js';
import type { TenantContext } from '../../src/tenancy/authorization.js';

export const LINE_A = '+15550001000';
export const LINE_B = '+15550002000';
export const PUBLIC_ORIGIN = 'https://calls.example.test';

export const tenant = (accountId: string, role: TenantContext['role']): TenantContext =>
  ({ userId: `user_${accountId}_${role}`, accountId, role, sessionId: `sess_${accountId}_${role}` });

export interface CallStackOptions {
  store?: CallSessionStore;
  /** The provider. Share one between stacks to stand for "Twilio" seen by several application instances. */
  provider?: FakeCallProvider;
  /** OUTBOUND_AGENT_CALLS. On unless a test is about it being off. */
  outboundEnabled?: boolean;
  pollIntervalMs?: number;
  dialTimeoutMs?: number;
  now?: () => Date;
  /** The cost ledger's store and price book (an in-memory ledger over the call store by default). */
  usageStore?: CallUsageStore;
  priceBook?: PriceBook;
  /** Wraps the default policy (to observe or interleave with it). */
  wrapPolicy?: (inner: OutboundPolicy, calls: () => CallSessionService) => OutboundPolicy;
}

/**
 * One application instance: the call service, its AppPort application, and callers of each kind. Two stacks over one
 * store and one provider are two servers behind one database talking to one Twilio account.
 */
export function createCallStack(options: CallStackOptions = {}) {
  const store = options.store ?? new InMemoryCallSessionStore();
  const provider = options.provider ?? new FakeCallProvider();
  if (options.now) provider.clock = options.now;
  const usage = new CallCostLedger(
    options.usageStore ?? new InMemoryCallUsageStore(() => (store instanceof InMemoryCallSessionStore ? store.all() : [])),
    { priceBook: options.priceBook, now: options.now },
  );
  const logs: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  const lines: Record<string, string> = { acct_a: LINE_A, acct_b: LINE_B };
  const calls: CallSessionService = new CallSessionService(store, {
    provider,
    usage,
    assistantLine: async (accountId) => lines[accountId] ?? null,
    policy: (options.wrapPolicy ?? ((inner) => inner))(new DefaultOutboundPolicy({
      agentCallsEnabled: options.outboundEnabled ?? true,
      ownedCallerIds: async (accountId) => (lines[accountId] ? [lines[accountId]] : []),
      activeOutboundDestinations: (accountId) => calls.activeOutboundDestinations(accountId),
    }), () => calls),
    dialUrls: (session, origin) => ({
      answerUrl: origin === 'owner_test'
        ? `${PUBLIC_ORIGIN}/webhooks/twilio/voice/test?assistantLine=${encodeURIComponent(session.from ?? '')}&callId=${session.id}`
        : `${PUBLIC_ORIGIN}/webhooks/twilio/voice/outbound?callId=${session.id}`,
      statusUrl: `${PUBLIC_ORIGIN}/webhooks/twilio/status?callId=${session.id}`,
    }),
    logger: { log: (level, event, fields) => logs.push({ level, event, fields }) },
    ...(options.dialTimeoutMs ? { dialTimeoutMs: options.dialTimeoutMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const application = createCallApplication({ calls, usage, pollIntervalMs: options.pollIntervalMs ?? 5 });
  const as = (session: Session) => new CallCapabilityClient(application, session);
  return {
    store, provider, calls, application, logs, as, lines, usage,
    adminA: as(appPortSessionFor(tenant('acct_a', 'admin'))),
    memberA: as(appPortSessionFor(tenant('acct_a', 'member'))),
    adminB: as(appPortSessionFor(tenant('acct_b', 'admin'))),
    telephonyA: as(telephonySessionFor('acct_a')),
  };
}

export type CallStack = ReturnType<typeof createCallStack>;

/** A provider callback, the way Twilio's adapter would hand it to the service. */
export function providerEvent(providerCallId: string, rawStatus: string, status: Parameters<CallSessionService['applyProviderEvent']>[0]['status'], extra: { sequence?: string } = {}) {
  return {
    provider: 'twilio', providerCallId, rawStatus, status,
    eventId: `${providerCallId}:${rawStatus}${extra.sequence ? `:${extra.sequence}` : ''}`,
    ...(extra.sequence ? { sequence: extra.sequence } : {}),
  };
}

/**
 * An MCP client connected, in memory, to `@appport/mcp`'s server over the application, running as `session`.
 * (The network endpoint is covered by test/mcp-endpoint.test.ts; this is the same server without HTTP.)
 */
export async function mcpClientFor(application: AppPortApplication, session: Session | undefined) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createCallMcpServer(application, async () => session).connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return {
    client,
    listTools: async () => (await client.listTools()).tools,
    callTool: async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as {
      isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, any>;
    },
  };
}
