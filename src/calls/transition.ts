import {
  CallTransitionError,
  decideTransition,
  transitionTimestamps,
  type CallSessionRecord,
  type CallSessionStatus,
} from './model.js';
import type { CallSessionPatch, CallSessionStore, ProviderEventInput } from './store.js';

export type TransitionOutcome = 'applied' | 'noop' | 'stale' | 'rejected' | 'duplicate' | 'not_found';

export interface TransitionOptions {
  /**
   * `strict` is for application commands: a transition the lifecycle does not allow throws.
   * `lenient` is for provider callbacks and runtime observations: an event that arrives late,
   * twice or out of order is reported as `stale`/`noop`, never as an error.
   */
  mode: 'strict' | 'lenient';
  reason?: string;
  now?: Date;
  /** Non-status fields to persist together with an applied transition. */
  also?: Pick<CallSessionPatch, 'providerCallId' | 'conversationId' | 'lastProviderStatus' | 'endClaimedAt'>;
  providerEvent?: ProviderEventInput;
}

export interface TransitionResult {
  outcome: TransitionOutcome;
  session: CallSessionRecord | null;
  detail?: string;
}

/**
 * THE way a CallSession's status changes. Nothing else writes `status`.
 *
 * It loads the current state under the store's lock, validates the move, persists the new status
 * with the timestamps it implies, and is safe to retry: repeating a transition is a `noop`, and a
 * provider event seen before is reported as a `duplicate` without running again.
 */
export async function transitionCallSession(
  store: CallSessionStore,
  id: string,
  to: CallSessionStatus,
  options: TransitionOptions,
): Promise<TransitionResult> {
  const now = options.now ?? new Date();
  let decision: ReturnType<typeof decideTransition> | undefined;
  let before: CallSessionStatus | undefined;

  const result = await store.mutate(id, (current) => {
    before = current.status;
    decision = decideTransition(current, to);
    if (decision.kind === 'apply') {
      return {
        patch: { status: to, ...transitionTimestamps(current, to, now, options.reason), ...options.also },
        eventOutcome: 'applied',
      };
    }
    // A redelivered event that changes nothing may still carry a first-seen provider id; keep the record steady.
    return { patch: null, eventOutcome: decision.kind === 'invalid' ? 'rejected' : decision.kind };
  }, { now, ...(options.providerEvent ? { providerEvent: options.providerEvent } : {}) });

  if (!result) return { outcome: 'not_found', session: null };
  if (result.duplicateEvent) return { outcome: 'duplicate', session: result.session };
  if (!decision) throw new Error('transition was not evaluated');

  switch (decision.kind) {
    case 'apply':
      return { outcome: 'applied', session: result.session };
    case 'noop':
      return { outcome: 'noop', session: result.session };
    case 'stale':
      if (options.mode === 'strict') {
        throw new CallTransitionError(id, before!, to, decision.reason === 'terminal' ? 'the call has already ended' : 'the call is already further along');
      }
      return { outcome: 'stale', session: result.session, detail: decision.reason };
    case 'invalid':
      if (options.mode === 'strict') throw new CallTransitionError(id, before!, to, decision.reason);
      return { outcome: 'rejected', session: result.session, detail: decision.reason };
  }
}

export interface EndClaimResult {
  /** True only for the one request that won the right to ask the provider to hang up. */
  claimed: boolean;
  outcome: 'claimed' | 'already_claimed' | 'terminal' | 'invalid' | 'not_found';
  session: CallSessionRecord | null;
}

/**
 * Moves a provider-backed call to `ending` and marks that someone is asking the provider to hang
 * up, atomically. Of any number of concurrent or repeated `call.end` requests exactly one claims,
 * so the provider is asked once. A failed provider request releases the claim (`releaseEndClaim`)
 * and leaves the call `ending`, so a retry can claim again.
 */
export async function claimCallEnd(
  store: CallSessionStore,
  id: string,
  options: { reason: string; now?: Date },
): Promise<EndClaimResult> {
  const now = options.now ?? new Date();
  let outcome = 'invalid' as EndClaimResult['outcome'];
  const result = await store.mutate(id, (current) => {
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'no_answer' ||
      current.status === 'busy' || current.status === 'canceled') {
      outcome = 'terminal';
      return { patch: null };
    }
    if (current.endClaimedAt) {
      outcome = 'already_claimed';
      return { patch: null };
    }
    const decision = decideTransition(current, 'ending');
    if (decision.kind === 'apply') {
      outcome = 'claimed';
      return { patch: { status: 'ending', endClaimedAt: now, ...transitionTimestamps(current, 'ending', now, options.reason) } };
    }
    if (decision.kind === 'noop') {
      // Already `ending` (a previous claim failed and was released): claim again without re-transitioning.
      outcome = 'claimed';
      return { patch: { endClaimedAt: now } };
    }
    outcome = 'invalid';
    return { patch: null };
  }, { now });
  if (!result) return { claimed: false, outcome: 'not_found', session: null };
  return { claimed: outcome === 'claimed', outcome, session: result.session };
}

/** Lets a later `call.end` ask the provider again after a failed attempt. Changes no status. */
export async function releaseEndClaim(store: CallSessionStore, id: string): Promise<void> {
  await store.mutate(id, (current) => (current.endClaimedAt ? { patch: { endClaimedAt: null } } : { patch: null }));
}
