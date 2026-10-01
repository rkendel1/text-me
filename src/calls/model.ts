import { randomUUID } from 'node:crypto';

/**
 * CallSession: the canonical, durable domain object for one phone call, inbound or outbound.
 *
 * The application owns `id`. The telephony provider owns `providerCallId`; it is an external
 * reference and never a domain identity. Nothing in this module knows a provider's vocabulary.
 */
export const CALL_SESSION_STATUSES = [
  'created', 'initiating', 'ringing', 'answered', 'in_progress', 'ending',
  'completed', 'failed', 'no_answer', 'busy', 'canceled',
] as const;
export type CallSessionStatus = typeof CALL_SESSION_STATUSES[number];

export type CallDirection = 'inbound' | 'outbound';
export const CALL_DIRECTIONS: readonly CallDirection[] = ['inbound', 'outbound'];

export const TERMINAL_STATUSES: ReadonlySet<CallSessionStatus> = new Set(['completed', 'failed', 'no_answer', 'busy', 'canceled']);
export const isTerminal = (status: CallSessionStatus): boolean => TERMINAL_STATUSES.has(status);

/** The forward-only order of a call's active life. Terminal states sit outside it. */
const ACTIVE_RANK: Partial<Record<CallSessionStatus, number>> = {
  created: 0, initiating: 1, ringing: 2, answered: 3, in_progress: 4, ending: 5,
};

/**
 * What the provider request for an outbound call came to. `pending`: a process claimed the dial and its
 * request is in flight. `accepted`: the provider returned a call id. `rejected`: the provider refused it
 * (definitively: no call exists). `unconfirmed`: the request timed out or failed ambiguously, so a call
 * may or may not exist; the session stays observable and is never re-dialed.
 */
export const DIAL_OUTCOMES = ['pending', 'accepted', 'rejected', 'unconfirmed'] as const;
export type DialOutcome = typeof DIAL_OUTCOMES[number];

/** The durable record. `accountId` is the tenant; every read and write is scoped by it. */
export interface CallSessionRecord {
  id: string;
  accountId: string;
  direction: CallDirection;
  status: CallSessionStatus;
  provider: string;
  providerCallId: string | null;
  from: string | null;
  to: string | null;
  /** The owner-facing conversation this call belongs to (the SMS/attention thread), once it exists. */
  conversationId: string | null;
  startedAt: Date | null;
  answeredAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Increments on every persisted change; lets a client wait for "the next state". */
  version: number;
  /** Who asked for the call (principal id or `system`). */
  requestedBy: string | null;
  /** The request/trace that created it, for correlation. */
  traceId: string | null;
  idempotencyKey: string | null;
  requestFingerprint: string | null;
  /** Set by the one request that won the right to ask the provider to end the call. */
  endClaimedAt: Date | null;
  /** The last provider status seen, verbatim, for diagnosis only. */
  lastProviderStatus: string | null;
  /** What an outbound call is for. Describes the goal; it is not authority to do anything. */
  objective: string | null;
  /** Set by the one process that won the right to place this outbound call with the provider. */
  dialClaimedAt: Date | null;
  dialOutcome: DialOutcome | null;
  /** How many times reconciliation has looked for this call at the provider after an unconfirmed dial. */
  reconciliationAttempts: number;
  lastReconciliationAt: Date | null;
}

/** What capabilities and clients see: no provider id, no idempotency or claim internals. */
export interface CallSessionView {
  callId: string;
  direction: CallDirection;
  status: CallSessionStatus;
  provider: string;
  from: string | null;
  to: string | null;
  conversationId: string | null;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  objective: string | null;
  /** Outbound only: how the request to the provider went. `null` for a call nothing dialed. */
  execution: DialOutcome | null;
  /** `call.get` only: what the call has cost (see `CallCostLedger`). */
  cost?: Omit<import('./cost/model.js').CallCostSummary, 'callId'>;
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function presentCallSession(record: CallSessionRecord): CallSessionView {
  return {
    callId: record.id,
    direction: record.direction,
    status: record.status,
    provider: record.provider,
    from: record.from,
    to: record.to,
    conversationId: record.conversationId,
    startedAt: iso(record.startedAt),
    answeredAt: iso(record.answeredAt),
    endedAt: iso(record.endedAt),
    endReason: record.endReason,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    version: record.version,
    objective: record.objective,
    execution: record.dialOutcome,
  };
}

export function createCallSessionId(): string {
  return `call_${randomUUID().replaceAll('-', '')}`;
}

// ----- Transition rules (pure) -----

export type TransitionDecision =
  | { kind: 'apply' }
  /** Already in that state: a retry or a duplicate. Harmless. */
  | { kind: 'noop' }
  /** The session has moved past this state (terminal, or further along): an out-of-order or replayed event. */
  | { kind: 'stale'; reason: 'terminal' | 'behind' }
  /** A forward move the lifecycle does not allow. */
  | { kind: 'invalid'; reason: string };

/**
 * created → initiating → ringing → answered → in_progress → ending → completed
 *
 * Active states only move forward (a provider may skip states whose events it never delivered).
 * `ending` means "the provider was asked to hang up" so it needs a provider call to exist.
 * Terminal states are final: nothing leaves them.
 */
export function decideTransition(
  current: { status: CallSessionStatus; direction: CallDirection; providerCallId?: string | null },
  to: CallSessionStatus,
): TransitionDecision {
  if (current.status === to) return { kind: 'noop' };
  if (isTerminal(current.status)) return { kind: 'stale', reason: 'terminal' };

  const from = ACTIVE_RANK[current.status]!;
  switch (to) {
    case 'canceled':
    case 'failed':
      return { kind: 'apply' };
    case 'no_answer':
    case 'busy':
      // Only a call that was dialed and had not been picked up can go unanswered.
      return from === ACTIVE_RANK.initiating || from === ACTIVE_RANK.ringing
        ? { kind: 'apply' }
        : from > ACTIVE_RANK.ringing! ? { kind: 'stale', reason: 'behind' } : { kind: 'invalid', reason: `${current.status} cannot become ${to}` };
    case 'completed':
      // A completion needs a call that got going: never from `created`.
      return from >= ACTIVE_RANK.initiating! ? { kind: 'apply' } : { kind: 'invalid', reason: `${current.status} cannot become completed` };
    case 'created':
      return { kind: 'stale', reason: 'behind' };
    default: {
      const target = ACTIVE_RANK[to]!;
      if (target <= from) return { kind: 'stale', reason: 'behind' };
      // Only an inbound call (or one that already has a provider call) can be "ringing" without being dialed by us.
      if (current.status === 'created' && to !== 'initiating') {
        if (to === 'ringing' && (current.direction === 'inbound' || current.providerCallId)) return { kind: 'apply' };
        return { kind: 'invalid', reason: `created cannot become ${to}` };
      }
      if (to === 'ending' && !current.providerCallId) return { kind: 'invalid', reason: 'a call with no provider call cannot be ending' };
      return { kind: 'apply' };
    }
  }
}

export class CallTransitionError extends Error {
  constructor(readonly callId: string, readonly from: CallSessionStatus, readonly to: CallSessionStatus, readonly detail: string) {
    super(`Call ${callId}: cannot go from ${from} to ${to} (${detail})`);
  }
}

/** The fields a transition into `to` sets beyond the status itself. */
export function transitionTimestamps(
  current: Pick<CallSessionRecord, 'startedAt' | 'answeredAt' | 'endedAt' | 'endReason'>,
  to: CallSessionStatus,
  now: Date,
  reason?: string,
): Partial<Pick<CallSessionRecord, 'startedAt' | 'answeredAt' | 'endedAt' | 'endReason'>> {
  const patch: Partial<Pick<CallSessionRecord, 'startedAt' | 'answeredAt' | 'endedAt' | 'endReason'>> = {};
  if (!current.startedAt && to !== 'created') patch.startedAt = now;
  if ((to === 'answered' || to === 'in_progress') && !current.answeredAt) patch.answeredAt = now;
  if (isTerminal(to)) {
    patch.endedAt = current.endedAt ?? now;
    patch.endReason = current.endReason ?? reason ?? to;
  } else if (to === 'ending' && reason && !current.endReason) {
    patch.endReason = reason;
  }
  return patch;
}
