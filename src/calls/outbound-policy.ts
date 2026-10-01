/**
 * The outbound policy gate: the one place that decides whether the application may place a call, and
 * from which number. It runs before anything is created or dialed, and it is not part of the provider.
 *
 * It enforces only what the product can enforce today. It is not a legal or compliance system: consent,
 * calling windows, recording consent, AI disclosure and do-not-call handling are separate product/legal
 * decisions that do not exist yet (see docs/call-session.md).
 */

/** Who is asking for the call. */
export type OutboundOrigin =
  /** A program or agent through the AppPort capability, acting autonomously. The default-off gate applies. */
  | 'agent'
  /** The owner pressed "test call", confirmed on their own phone. Human-initiated; the agent gate does not apply. */
  | 'owner_test'
  /** The request arrived over any transport other than the in-process one (MCP included). Placing a call is refused until that is a deliberate decision. */
  | 'untrusted_transport';

export interface OutboundCallRequest {
  accountId: string;
  /** Who asked (a principal id), for the log. */
  principalId?: string;
  origin: OutboundOrigin;
  /** Already normalised to E.164. */
  to: string;
  /** The caller id the request asked for, if it named one. */
  from?: string;
}

export type OutboundDenialReason =
  | 'outbound_disabled'
  | 'transport_not_supported'
  | 'no_caller_id'
  | 'caller_id_not_owned'
  | 'destination_is_own_line'
  | 'duplicate_destination';

export type OutboundPolicyDecision =
  | { allowed: true; /** The number the call is placed from: always one the account owns. */ callerId: string }
  | { allowed: false; reason: OutboundDenialReason; message: string };

export interface OutboundPolicy {
  evaluate(request: OutboundCallRequest): Promise<OutboundPolicyDecision>;
}

export interface OutboundPolicyDependencies {
  /** The platform switch for autonomous (agent-originated) outbound calling. Off by default. */
  agentCallsEnabled: boolean;
  /** The numbers this account owns and may call from (its assistant line). */
  ownedCallerIds(accountId: string): Promise<string[]>;
  /** Destinations of this account's outbound calls that are still in progress. */
  activeOutboundDestinations(accountId: string): Promise<string[]>;
}

const deny = (reason: OutboundDenialReason, message: string): OutboundPolicyDecision => ({ allowed: false, reason, message });

export class DefaultOutboundPolicy implements OutboundPolicy {
  constructor(private readonly dependencies: OutboundPolicyDependencies) {}

  async evaluate(request: OutboundCallRequest): Promise<OutboundPolicyDecision> {
    if (request.origin === 'untrusted_transport') {
      return deny('transport_not_supported', 'Placing a call is not available over this transport: it cannot carry the request\'s idempotency key, timeout and trace id.');
    }
    if (request.origin === 'agent' && !this.dependencies.agentCallsEnabled) {
      return deny('outbound_disabled', 'Outbound calling by agents is not enabled.');
    }

    // Caller id: only ever a number this account owns. A request may name one, but it must be one of those.
    const owned = await this.dependencies.ownedCallerIds(request.accountId);
    if (owned.length === 0) return deny('no_caller_id', 'This account has no assistant line to call from.');
    if (request.from && !owned.includes(request.from)) {
      return deny('caller_id_not_owned', 'The caller id is not a number this account owns.');
    }
    const callerId = request.from ?? owned[0];

    if (owned.includes(request.to)) return deny('destination_is_own_line', 'A call cannot be placed to this account\'s own assistant line.');
    // An agent may not stack calls on the same person. (The owner's own test call is exempt.)
    if (request.origin === 'agent' && (await this.dependencies.activeOutboundDestinations(request.accountId)).includes(request.to)) {
      return deny('duplicate_destination', 'A call to this number is already in progress.');
    }
    return { allowed: true, callerId };
  }
}

/** With no policy configured, nothing is allowed. */
export const denyAllOutboundPolicy: OutboundPolicy = {
  async evaluate() {
    return deny('outbound_disabled', 'Outbound calling is not configured.');
  },
};
