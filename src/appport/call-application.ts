import { permissionAuthorizer } from '@appport/authorization';
import { createApplication, defineCapability, type AppPortApplication, type CapabilityContext, type IdempotencyStore } from '@appport/core';
import { errors, type AppPortError } from '@appport/protocol';
import { s } from '@appport/schema';

import {
  CALL_DIRECTIONS,
  CALL_SESSION_STATUSES,
  DIAL_OUTCOMES,
  CallTransitionError,
  isTerminal,
  presentCallSession,
  type CallSessionRecord,
  type CallSessionView,
} from '../calls/model.js';
import {
  CallConflictError,
  CallNotFoundError,
  CallPolicyDeniedError,
  CallProviderError,
  CallRequestError,
  MAX_OBJECTIVE_LENGTH,
  type CallActor,
  type CallSessionService,
} from '../calls/service.js';
import type { CallCostLedger } from '../calls/cost/ledger.js';
import { USAGE_BASES, USAGE_CATEGORIES } from '../calls/cost/model.js';
import { CALL_APPLICATION_ID, CALL_PERMISSIONS } from './session.js';

/** The transport the in-process client declares. Anything else, MCP included, cannot place calls. */
const IN_PROCESS = 'in-process';

/** The longest a single `call.get` will hold a request open. Longer waits are clamped, not refused. */
export const MAX_WAIT_SECONDS = 20;
const DEFAULT_POLL_INTERVAL_MS = 500;

const status = s.enum(CALL_SESSION_STATUSES);
const direction = s.enum(CALL_DIRECTIONS as readonly ['inbound', 'outbound']);

/**
 * What a call has cost so far, derived from its durable usage ledger (never authoritative on its own: the ledger is).
 * `estimatedCost` is the best current figure; `finalCost` exists only once every observed usage is authoritative and priced.
 */
const costView = s.object({
  currency: s.string(),
  status: s.enum(['unknown', 'estimated', 'final'] as const),
  estimatedCost: s.nullable(s.number()),
  finalCost: s.nullable(s.number()),
  breakdown: s.array(s.object({
    category: s.enum(USAGE_CATEGORIES),
    amount: s.nullable(s.number()),
    basis: s.enum(USAGE_BASES),
    unpriced: s.integer({ minimum: 0 }),
  })),
  /** The part of the figure that is authoritative. */
  authoritativeCost: s.nullable(s.number()),
  /** Estimated categories that may still be settled by the provider. */
  pending: s.array(s.enum(USAGE_CATEGORIES)),
  /** Estimated categories that can never be settled (no per-call authoritative figure exists, or it was unavailable). */
  nonFinalizable: s.array(s.enum(USAGE_CATEGORIES)),
  unpricedUsage: s.integer({ minimum: 0 }),
  derived: s.boolean('True when part of the figure is derived from the call\'s lifecycle times because no usage had been recorded.'),
}, { title: 'CallCost' });

/** What every call capability returns for a call: no provider id, no internals. */
const callView = s.object({
  callId: s.string(),
  direction,
  status,
  provider: s.string(),
  from: s.nullable(s.string()),
  to: s.nullable(s.string()),
  conversationId: s.nullable(s.string()),
  startedAt: s.nullable(s.timestamp()),
  answeredAt: s.nullable(s.timestamp()),
  endedAt: s.nullable(s.timestamp()),
  endReason: s.nullable(s.string()),
  createdAt: s.timestamp(),
  updatedAt: s.timestamp(),
  /** Increases on every change. Pass it back as `sinceVersion` to wait for the next one. */
  version: s.integer({ minimum: 1 }),
  /** What an outbound call is for. A description of the goal, never authority to act. */
  objective: s.nullable(s.string()),
  /**
   * Outbound only. `pending`: the request to place the call is in flight. `accepted`: it was placed. `rejected`: it was
   * refused, so no call exists (the call is `failed`). `unconfirmed`: the outcome is unknown, a call may exist, and it
   * will not be placed again. `null`: nothing was placed for this call.
   */
  execution: s.nullable(s.enum(DIAL_OUTCOMES)),
  /** Only `call.get` fills this, and only when a cost ledger is configured. Absent elsewhere. */
  cost: s.optional(costView),
}, { title: 'Call' });

/**
 * AppPort's built-in replay cache lives in one process's memory and replays a stored response for a key
 * whatever the new input is, so on a serverless deployment (new instance per cold start) key reuse would
 * behave differently depending on which instance answered. Call idempotency is instead decided by the
 * durable CallSession (unique per account + key, with the request fingerprint), identically everywhere.
 * The application still declares `idempotency: 'supported'`, so the key reaches the handler.
 */
const durableIdempotencyOnly: IdempotencyStore = {
  get: async () => undefined,
  set: async () => undefined,
};

export interface CallApplicationOptions {
  calls: CallSessionService;
  /** The cost ledger `call.get` reads from. Without one, calls carry no cost. */
  usage?: CallCostLedger;
  /** How often `call.get` re-reads while waiting. Tests shorten it. */
  pollIntervalMs?: number;
}

/** The account always comes from the authorized session, never from input. */
function accountOf(context: CapabilityContext): string {
  const accountId = context.session?.attributes?.accountId;
  if (typeof accountId !== 'string' || !accountId) throw errors.unauthorized();
  return accountId;
}

/**
 * The acting caller. Request metadata is carried through, not dropped: the AppPort idempotency key
 * and trace id become part of the durable record so a retry lands on the same call.
 */
function actorOf(context: CapabilityContext): CallActor {
  return {
    accountId: accountOf(context),
    ...(context.principal ? { principalId: context.principal.id } : {}),
    traceId: context.traceId,
    ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
    canIngest: context.authorization.has(CALL_PERMISSIONS.ingest),
  };
}

/** Domain errors become AppPort errors. Another account's call is reported exactly like a missing one. */
function toAppPortError(error: unknown): unknown {
  if (error instanceof CallNotFoundError) return errors.notFound('Call not found');
  if (error instanceof CallRequestError) {
    return error.code === 'invalid_input' || error.code === 'idempotency_key_required' ? errors.invalidInput(error.message, { reason: error.code })
      : error.code === 'not_permitted' ? errors.forbidden(error.message)
        : errors.conflict(error.message);
  }
  if (error instanceof CallPolicyDeniedError) return errors.forbidden(error.message, { reason: error.reason });
  if (error instanceof CallConflictError || error instanceof CallTransitionError) return errors.conflict(error.message);
  if (error instanceof CallProviderError) return errors.internal(error.message, { internal: error.cause });
  return error;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toAppPortError(error) as AppPortError;
  }
}

const date = (value: string | undefined, field: string): Date | undefined => {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw errors.invalidInput(`${field} must be an ISO-8601 timestamp.`);
  return parsed;
};

/** A call's cost for the view. A ledger that cannot be read leaves the call readable, without a cost. */
async function summarizeCall(usage: CallCostLedger, session: CallSessionRecord): Promise<CallSessionView['cost']> {
  try {
    const { callId: _callId, ...cost } = await usage.summarize(session);
    return cost;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/**
 * The call capabilities, as an AppPort application. These four operations are the one capability
 * surface for calls: the in-process caller (voice runtime, control plane) and the MCP projection
 * both reach exactly this. Nothing here knows the telephony provider.
 */
export function createCallApplication(options: CallApplicationOptions): AppPortApplication {
  const { calls } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const create = defineCapability({
    name: 'call.create',
    version: 1,
    description: 'Creates a call. An outbound call is placed through the telephony provider and returns as soon as it has been accepted (observe it with call.get); it needs an idempotency key. An inbound call is recorded as it arrives (telephony webhook only).',
    authorization: [CALL_PERMISSIONS.create],
    effect: 'consequential',
    idempotency: 'supported',
    input: s.object({
      direction,
      from: s.optional(s.string({ description: 'E.164. For an outbound call, defaults to the account\'s assistant line.' })),
      to: s.optional(s.string({ description: 'E.164. Required for an outbound call.' })),
      providerCallId: s.optional(s.string({ description: 'Inbound only, and only for the telephony webhook (call.ingest).' })),
      conversationId: s.optional(s.string({ description: 'The owner-facing conversation, for the telephony webhook (call.ingest).' })),
      objective: s.optional(s.string({ maxLength: MAX_OBJECTIVE_LENGTH, description: 'Outbound: what the call is for. Describes the goal; it grants no authority to act.' })),
    }),
    output: s.object({ callId: s.string(), status }),
    async handler(input, context) {
      return guarded(async () => {
        if (input.direction === 'outbound') {
          // Having a call placed is a separate authority from creating one.
          context.authorization.require(CALL_PERMISSIONS.dial);
          const placed = await calls.placeOutbound(
            actorOf(context),
            { direction: 'outbound', from: input.from, to: input.to, objective: input.objective, providerCallId: input.providerCallId, conversationId: input.conversationId },
            // Only the in-process transport may place a call; any other (MCP included) is refused by the outbound policy.
            { origin: context.metadata.transport === IN_PROCESS ? 'agent' : 'untrusted_transport' },
          );
          return { callId: placed.id, status: placed.status };
        }
        const session = await calls.create(actorOf(context), {
          direction: input.direction, from: input.from, to: input.to,
          providerCallId: input.providerCallId, conversationId: input.conversationId,
        });
        return { callId: session.id, status: session.status };
      });
    },
  });

  const get = defineCapability({
    name: 'call.get',
    version: 1,
    description: 'Reads a call. With waitSeconds it waits (bounded) for the call to change, so create → get → wait → get needs no push channel.',
    authorization: [CALL_PERMISSIONS.read],
    effect: 'observation',
    input: s.object({
      callId: s.string(),
      waitSeconds: s.optional(s.number({ minimum: 0, description: `Clamped to ${MAX_WAIT_SECONDS}.` })),
      sinceVersion: s.optional(s.integer({ minimum: 0, description: 'Wait until the call is past this version. Defaults to the version now.' })),
    }),
    output: callView,
    async handler(input, context): Promise<CallSessionView> {
      return guarded(async () => {
        const accountId = accountOf(context);
        let session = await calls.get(accountId, input.callId);
        const waitMs = Math.min(Math.max(input.waitSeconds ?? 0, 0), MAX_WAIT_SECONDS) * 1000;
        if (waitMs > 0) {
          const baseline = input.sinceVersion ?? session.version;
          // Never outlive the request's own deadline.
          const until = Math.min(Date.now() + waitMs, context.deadline ? context.deadline - 250 : Infinity);
          while (session.version <= baseline && !isTerminal(session.status) && Date.now() < until && !context.signal.aborted) {
            await sleep(Math.min(pollIntervalMs, Math.max(until - Date.now(), 0)), context.signal);
            session = await calls.get(accountId, input.callId);
          }
        }
        const view = presentCallSession(session);
        // The same authorized read: the call was just loaded for this account, so its cost is this account's cost.
        return options.usage ? { ...view, cost: await summarizeCall(options.usage, session) } : view;
      });
    },
  });

  const list = defineCapability({
    name: 'call.list',
    version: 1,
    description: 'Lists the account\'s calls, newest first, inbound and outbound.',
    authorization: [CALL_PERMISSIONS.read],
    effect: 'observation',
    input: s.object({
      status: s.optional(s.array(status)),
      direction: s.optional(direction),
      createdAfter: s.optional(s.timestamp()),
      createdBefore: s.optional(s.timestamp()),
      limit: s.optional(s.integer({ minimum: 1, maximum: 100 })),
      cursor: s.optional(s.string()),
    }),
    output: s.object({ items: s.array(callView), nextCursor: s.nullable(s.string()) }),
    async handler(input, context) {
      return guarded(async () => {
        const page = await calls.list(accountOf(context), {
          status: input.status, direction: input.direction,
          createdAfter: date(input.createdAfter, 'createdAfter'), createdBefore: date(input.createdBefore, 'createdBefore'),
          limit: input.limit, cursor: input.cursor,
        });
        return { items: page.items.map(presentCallSession), nextCursor: page.nextCursor };
      });
    },
  });

  const end = defineCapability({
    name: 'call.end',
    version: 1,
    description: 'Ends a call. Repeating it is harmless: an ended call is returned as it is and the provider is asked to hang up at most once.',
    authorization: [CALL_PERMISSIONS.control],
    effect: 'consequential',
    idempotency: 'supported',
    concurrency: { mode: 'keyed', key: 'callId' },
    input: s.object({ callId: s.string(), reason: s.optional(s.string({ maxLength: 200 })) }),
    output: callView,
    async handler(input, context): Promise<CallSessionView> {
      return guarded(async () => presentCallSession(await calls.end(actorOf(context), input.callId, { reason: input.reason })));
    },
  });

  return createApplication({
    application: { id: CALL_APPLICATION_ID, name: 'Just Text Me calls', version: '1.0.0' },
    capabilities: [create, get, list, end],
    authorizer: permissionAuthorizer(),
    idempotency: durableIdempotencyOnly,
    services: { calls },
  });
}
