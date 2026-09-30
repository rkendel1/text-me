# CallSession

`CallSession` is the canonical, durable domain object for one phone call, inbound or outbound.
This document describes what is built. Where something is deliberately not built, it says so.

1. **CallSession is the canonical call domain object.** One record, one lifecycle, for every call.
2. **Twilio is a provider, not the domain model.** The application owns `CallSession.id`; Twilio owns `providerCallId`.
3. **Inbound and outbound share the same lifecycle.** `direction` is a field, not a separate architecture.
4. **AppPort exposes the capabilities** (`call.create`, `call.get`, `call.list`, `call.end`).
5. **MCP projects AppPort.** It is an adapter over the same capabilities, never a source of truth.
6. **The voice runtime operates against the CallSession.** The media stream reports into it; it never decides lifecycle.
7. **Autonomous outbound dialing is disabled by default.** `call.create` can place one outbound call through Twilio, only when `OUTBOUND_AGENT_CALLS=on`. See [Outbound execution](#outbound-execution) and [Not built](#not-built).

```mermaid
flowchart LR
  subgraph Consumers
    WEB[control plane / Stop]
    VR[voice runtime]
    MCPC[MCP client]
  end
  WEB -->|in-process| APP
  VR -->|transitions| SVC
  MCPC --> MCP["@appport/mcp bridge (projection)"] --> APP
  APP["AppPort application<br/>call.create / get / list / end"] --> SVC[CallSessionService]
  SVC --> TR["transitionCallSession()<br/>the only writer of status"]
  TR --> DB[("call_sessions<br/>call_provider_events")]
  SVC -->|dial / end| CP[CallProvider]
  CP --> TW[TwilioCallProvider]
  TWH[Twilio webhooks] --> ADAPT["TwilioProvider<br/>status mapping"] --> SVC
  TWH --> VR
```

## The object

`src/calls/model.ts` (`CallSessionRecord`), table `call_sessions`:

| Field | Meaning |
|---|---|
| `id` | `call_` + uuid. **The domain identity.** Never a Twilio SID |
| `accountId` | The tenant. Every read and write is scoped by it |
| `direction` | `inbound` \| `outbound` |
| `status` | `created initiating ringing answered in_progress ending completed failed no_answer busy canceled` |
| `provider`, `providerCallId` | The telephony provider and its id for the call (null until the provider has one). Unique together |
| `from`, `to` | E.164 when valid. A carrier's `anonymous` caller is stored as null, never a reason to drop a call |
| `conversationId` | The owner-facing conversation (attention, SMS continuation) this call belongs to |
| `startedAt`, `answeredAt`, `endedAt`, `endReason` | Set by transitions |
| `version` | Increments on every persisted change; lets `call.get` wait for "the next state" |
| `requestedBy`, `traceId`, `idempotencyKey`, `requestFingerprint` | Who/what asked, for correlation and dedupe |
| `endClaimedAt`, `lastProviderStatus` | Internal: who may ask the provider to hang up; the last provider word, for diagnosis |

`conversations.status` (`received → answered → completed`) remains for the existing owner UI. It is a
**projection** of the CallSession lifecycle, written by the status webhook after the CallSession
transition; it is not a second source of truth for calls.

## Lifecycle

```mermaid
stateDiagram-v2
  [*] --> created
  created --> initiating: dial
  created --> ringing: inbound (already at the provider)
  initiating --> ringing
  ringing --> answered
  answered --> in_progress: voice runtime engaged
  in_progress --> ending: hang-up requested / stream ended
  ending --> completed
  initiating --> failed
  ringing --> no_answer
  ringing --> busy
  ringing --> failed
  in_progress --> failed
  created --> canceled
  initiating --> canceled
  ringing --> canceled
  answered --> canceled
  in_progress --> canceled
  ending --> canceled
```

Rules (`decideTransition`, pure and tested exhaustively):

- Active states only move **forward**; a provider may skip events it never delivered (`ringing → completed` is allowed once dialing began).
- `completed` needs a call that got going (never from `created`); `no_answer`/`busy` only from `initiating`/`ringing`; `failed`/`canceled` from any active state; `ending` needs a provider call.
- **Terminal states are final**: nothing leaves `completed failed no_answer busy canceled`.
- A repeated transition is a `noop`; a late or earlier-state event is `stale`; a forward move the lifecycle forbids is `invalid`.

**One writer.** `transitionCallSession()` (`src/calls/transition.ts`) is the only code that writes `status`. It loads
the current state under the store's lock, validates, persists the status with the timestamps it implies, and is
safe to retry. Application commands use `strict` mode (an invalid move throws); provider callbacks and runtime
observations use `lenient` mode (late, duplicate or out-of-order events are reported, never errors). A test
(`architecture: status changes only through the transition function…`) fails the build if another module writes a status.

## Provider events and idempotency

```text
Twilio callback → TwilioProvider.parseStatusUpdate → mapTwilioCallStatus() → CallSessionStatus | null
                → CallSessionService.applyProviderEvent → transitionCallSession
```

- `src/calls/provider-status.ts` is the translation boundary: `queued/initiated→initiating`, `ringing→ringing`, `in-progress→answered`, `completed`, `busy`, `failed`, `no-answer→no_answer`, `canceled`. **A status not in the table maps to `null` and is acknowledged with 200**; it used to be an HTTP 400.
- **Event identity** is built only from fields Twilio sends: `CallSid:CallStatus`, plus `:SequenceNumber` when the callback carries one. (Twilio documents `SequenceNumber` for status callbacks; this was not re-verified against Twilio in this environment, and its absence is handled.)
- Each callback is recorded once in `call_provider_events (provider, event_id)` **inside the same transaction** that locks the session row (`SELECT … FOR UPDATE`). A redelivery, even one racing another instance, is reported as `duplicate` and changes nothing. Tests: 10 simultaneous identical callbacks → exactly one applied; two server instances on one database → one recorded event.
- Side effects of the status webhook (owner attention, conversation projection) run only for an `applied` event.
- A callback for a call we never saw: early lifecycle events (`initiated`/`ringing`) are acknowledged (the call may still be registering); anything else is a 404 as before. A call that predates CallSessions is **adopted** from its conversation on first contact.
- `completed` (or any terminal status) after the call already ended, and `ringing` after `answered`, are `stale`: acknowledged, nothing changes.

## Capabilities (AppPort)

`src/appport/call-application.ts`. One AppPort application, `app.justtextme.calls`, built with `@appport/core`. No second capability system.

| Capability | Permission | Notes |
|---|---|---|
| `call.create@1` | `call.create` (admins/owners) | Establishes the domain object, returns `{callId, status}`. **Outbound: requires `call.dial`, passes the outbound policy, is persisted, then dialed through Twilio; returns at `initiating` without waiting for the callee** (see [Outbound execution](#outbound-execution)). Inbound: requires `call.ingest` (the telephony webhook only) and a provider call; it is recorded as `ringing`. Idempotent |
| `call.get@1` | `call.read` | The canonical state. `waitSeconds` (clamped to 20, and never past the request's deadline) and `sinceVersion` make `create → get → wait → get` work without push |
| `call.list@1` | `call.read` | `status[]`, `direction`, `createdAfter/Before`, `limit` (≤100), opaque `cursor`; newest first; inbound and outbound |
| `call.end@1` | `call.control` | Idempotent. A terminal call is returned as is; otherwise exactly one request claims the hang-up and asks the provider. Keyed concurrency on `callId` |

No `call.answer`: nothing in the current architecture needs an explicit answer operation (inbound calls are answered by the webhook's TwiML).
Outputs carry `callId`, never the provider id or any internal field, so no consumer has to understand Twilio.

**Ownership.** The account comes from the authorized session (`session.attributes.accountId`), never from input. Another account's
call is reported exactly like a missing one (`NOT_FOUND`, same message), for `get`, `end` and `list`. Members read and end; only
admins/owners create; `call.ingest` is held only by the telephony webhook's session (`telephonySessionFor`, built from the account that
owns the *called number*). AuthBoundry is not required; the `Session` the capabilities run under is the seam where it could decide.

**Request metadata is preserved**, on the AppPort envelope: the idempotency key and trace id become part of the durable record
(`idempotencyKey`, `traceId`) and of every log line; `timeoutMs`/deadline bounds `call.get` waits. AppPort core's built-in idempotency
replay cache is **in memory** and replays a stored response whatever the new input is, which on a serverless deployment would make key reuse
depend on which instance answered. The call application therefore disables it and lets the durable CallSession decide: unique per
(account, key) with a request fingerprint, so the same request is the same call everywhere, and a *different* request under the same key is a `CONFLICT`.

**In-process.** `CallCapabilityClient` (`src/appport/call-client.ts`) calls `application.handleRequest` directly: no HTTP round trip, same
validation, authorization and metadata. Owner **Stop** uses it (`call.end`, idempotency key `owner-stop:<conversation>`).

**MCP.** `createCallMcpBridge` (`src/appport/mcp.ts`) is `@appport/mcp`'s own `createMcpBridge`, unchanged, restricted to `call.*`. It
yields the tools `call_create`, `call_get`, `call_list`, `call_end` with the capabilities' own schemas and permissions, through the same
dispatch. There is no JSON-RPC, transport or MCP implementation in this repository. **Not yet mounted on a network endpoint**: `@appport/mcp@1.0.2`
ships no server or transport (it says "wire `listTools`/`callTool` into an MCP server").

> **Known limitation — metadata over MCP.** `@appport/mcp@1.0.2`'s `callTool` builds its request from only `requestId`, `capability` and
> `input`, so an idempotency key, timeout and trace id **cannot be carried over MCP** with the published package. The fix is small and is
> prepared as [`upstream/appport-mcp-request-metadata.patch`](upstream/appport-mcp-request-metadata.patch) against
> `rkendel1/appport` (`callTool(name, args, meta?)`, with a test that fails without it). Until it is released and adopted, **do not expose
> outbound dialing over MCP**. This is enforced, not just documented: only the `in-process` transport may place a call; a request arriving with
> `transport: mcp` (or anything else) is refused by the outbound policy (`transport_not_supported`) before anything is persisted or dialed.
> The patch is prepared as a separate change and is not released.

## Outbound execution

```mermaid
flowchart LR
  A["AppPort call.create<br/>(validate, authorize call.dial)"] --> P["OutboundPolicy<br/>evaluateOutbound"]
  P -- denied --> X["CALL_POLICY_DENIED<br/>nothing persisted, Twilio never called"]
  P -- allowed --> S[("CallSession created<br/>durable, idempotent")]
  S --> C["claimOutboundDial<br/>(Postgres row lock, once)"]
  C --> CP["CallProvider.createCall"] --> TW[Twilio]
  TW -- "status callbacks ?callId=" --> L["transitionCallSession<br/>ringing, answered, in_progress, completed"]
  TW -- "answer webhook /voice/outbound" --> VR["existing voice runtime<br/>(same conversation and media stream path)"]
  VR --> L
```

1. **Validate.** `to` must be E.164 after stripping spaces, dots, dashes and parentheses; a leading `+` is required and nothing is guessed. `from` is optional and, if given, must be owned. `objective` (optional, 500 chars) is a domain field. No URLs, credentials or Twilio parameters are accepted.
2. **Authorize.** `call.dial` (held by `phone.manage` roles), in addition to `call.create`.
3. **Policy** (`src/calls/outbound-policy.ts`, before any provider call). Denies: a non-`in-process` transport; the platform gate off; no caller ID or a caller ID the account does not own (resolved from its own assistant line, never from input); a destination that is the account's own line; for agent calls, a second call to a destination that still has an unfinished call. The gate is **off by default** (`OUTBOUND_AGENT_CALLS=on` enables it). The owner-confirmed test call is a separate origin (`owner_test`) and is not subject to the agent gate. There is no consent model here and none is faked.
4. **Persist.** The CallSession is created (unique per account and idempotency key, with a request fingerprint). An agent call **requires** an idempotency key.
5. **Claim.** `claimOutboundDial` atomically moves `created` to `initiating` and stamps `dial_claimed_at`; exactly one caller wins. Two instances, a retried request and a crashed request cannot produce two Twilio calls.
6. **Provider.** `TwilioCallProvider.createCall` sends only `from`, `to`, the answer URL, the status callback URL and the four status events, all built by the server with a `callId` hint. It is the only place `calls.create` is used.
7. **Callbacks and lifecycle.** Twilio's callbacks drive `ringing`, `answered`, `in_progress`, `completed` (or `busy`, `no_answer`, `failed`, `canceled`) through `transitionCallSession`. A callback that arrives before the provider response is persisted is matched by the `callId` hint and adopts the provider id, so ordering does not matter.
8. **Voice.** When the callee answers, `/webhooks/twilio/voice/outbound` verifies the session (known, outbound, not over or ending, line belongs to the account) and enters the existing runtime. The assistant speaks first, is told it placed the call for its owner, and is given the objective **quoted as data, not as authority**: it grants no permission to disclose or do anything.

### Why `call.create` is asynchronous

A phone call takes seconds to tens of seconds to connect and minutes to finish; an AppPort request has a deadline and a serverless function has a time limit.
Holding the request open would tie the result to a transport timeout, make a retry indistinguishable from a second call, and lose the call when the
connection drops. So `call.create` returns the `callId` at `initiating` once the durable record exists and the dial has been attempted, and the
caller observes the rest with `call.get` (`waitSeconds`/`sinceVersion`) as Twilio's callbacks arrive. Creation is separated from provider execution
so each can fail independently and be reasoned about.

### Failure model

| Situation | Result |
|---|---|
| Twilio **rejects** (4xx other than 408) | `failed`, reason `provider_rejected`, `dial_outcome=rejected`; no provider id is invented |
| Twilio **times out** or the response is lost (5xx, 408, network) | The call may exist. `dial_outcome=unconfirmed`; **never redialed, never failed on a guess**. Callbacks carrying the `callId` hint attach it, and [reconciliation](#unconfirmed-outbound-calls) looks for it at the provider |
| Row persisted, process dies before dialing | The session stays `created`; nothing was sent; a retry with the same key finds it and executes the claim |
| Twilio accepts, process dies before recording | Callbacks adopt the provider id |
| `call.end` while the request is in flight | The call is cancelled once the provider id is known |

There is no retry loop. A second attempt needs a new, explicit request.

### Unconfirmed outbound calls

```mermaid
flowchart LR
  T[Twilio request] -->|response lost| U["initiating<br/>dial_outcome = unconfirmed"]
  U -->|callback with callId hint| A[attached]
  U -->|"cron, after the grace period"| R["claimReconciliation<br/>(row lock, attempt counted)"]
  R --> L["provider.findDialedCalls<br/>(read-only)"]
  L -->|one candidate| A
  L -->|none / ambiguous / error| U
  L -->|provider guarantees absence| F["failed, rejected"]
  A --> S["session follows provider state<br/>(ended locally: hung up once, stays ended)"]
```

`failed` means the provider definitively refused; `unconfirmed` means the application does not know. Reconciliation never converts the second into the first unless the provider itself guarantees absence (`conclusive`). Twilio's adapter never does, so against Twilio an unknown dial stays `unconfirmed`, and after the attempts are used up it is left for an operator (visible as `exhausted` in the cron response and the `call.reconciliation.summary` log). No new domain status was added.

- **Trigger.** Vercel Cron (`vercel.json`, every 5 minutes) calls `GET /api/internal/cron/reconcile-calls` with `Authorization: Bearer $CRON_SECRET` (Vercel's own mechanism). The secret is compared in constant time, never logged, and with no `CRON_SECRET` configured every request is refused (503). The route only reconciles; nothing it calls can place a call.
- **Eligible:** outbound, no provider id, `dial_outcome` `pending` or `unconfirmed` (a process that died mid-request leaves `pending`), claimed longer ago than the **grace period**, fewer than the **maximum attempts**, not looked at within the **retry interval**. It does not matter whether the session was ended locally meanwhile.
- **Bounds.** Grace: 120 s by default (`OUTBOUND_CALL_RECONCILIATION_GRACE_SECONDS`, 60-3600), and never less than twice the 20 s dial timeout in any case, so an in-flight request is not raced. Batch: 25 (`OUTBOUND_CALL_RECONCILIATION_BATCH_SIZE`, 1-100). Maximum attempts: 5, spaced at least 60 s apart (fixed). A run also stops taking attempts after 240 s. `OUTBOUND_CALL_RECONCILIATION_ENABLED=off` disables it. There is no setting that redials.
- **Coordination.** `claimReconciliation` re-checks eligibility under the `SELECT ... FOR UPDATE` row lock, counts the attempt (`reconciliation_attempts`, `last_reconciliation_at`) and releases. Two instances cannot both take the same attempt. Attaching the provider id is a locked write too; whoever attaches it is the only one that hangs up a call that was ended locally.
- **Matching.** Twilio has no lookup by our own reference, so the adapter lists calls between the two numbers (`calls.list`, 20 newest) and keeps those Twilio created within 30 s before to 5 min after our claim. Candidates already owned by another session are discarded. Exactly one remaining candidate is ours; several are ambiguous and are never guessed.
- **Local intent wins.** If the session was ended (`canceled`) while its dial was unknown and the call turns up live at Twilio, the id is attached and the call is hung up once; the session is never moved out of its terminal state. A callback that attaches the id first does the same hang-up instead.
- **Observability.** `call.reconciliation.started|confirmed|rejected|still_unconfirmed|failed|summary`, with `callId`, `providerCallId` when known, `attempt`, `traceId`, masked numbers. The summary carries the counters (examined, confirmed, stillUnconfirmed, failed, unresolved, exhausted); there is no metrics framework in the repository.
- **Not verified against Twilio.** Everything above was tested against a stub of the Twilio SDK and a fake provider, never against Twilio. Specifically UNVERIFIED: how soon a just-created call appears in `calls.list`, list ordering, whether `dateCreated` is populated for queued calls, and whether Twilio emits `canceled` in status callbacks for a call cancelled while ringing (the domain treats `canceled` as terminal, and a call that existed and was cancelled is `accepted`, not `rejected`). The existing conservative behavior is unchanged.

### Owner test call

`PhoneNumberService.placeTestCall` now goes through the same service (origin `owner_test`): one call path, one CallSession, one Twilio adapter.

### Schema

`call_sessions` gains `objective`, `dial_claimed_at` and `dial_outcome` (CHECK: `pending|accepted|rejected|unconfirmed`), added with `ADD COLUMN IF NOT EXISTS`,
and the partial index `idx_call_sessions_unconfirmed_dial` for reconciliation.

## Provider boundary

`CallProvider` (`src/calls/provider.ts`): `createCall`, `endCall(providerCallId, {mode: 'cancel' | 'complete'})`. `TwilioCallProvider`
(`src/telephony/twilio-call-provider.ts`) is the **only** place `client.calls.create/update` is used (a test guards this), including
the owner test call and the spoken verification code. `cancel` is used for a call not yet answered and `complete` for one that was;
Twilio's acceptance of `canceled` for a ringing call was not exercised against Twilio here.

## Where calls come from

- **Inbound.** `POST /webhooks/twilio/voice` → the conversation as before → `CallSessionService.openProviderCall` (idempotent on the provider call) → `ringing` → after the existing TwiML decision, `answered`. The media stream (`<Parameter callSessionId>`) or, without a stream host, the first spoken turn moves it to `in_progress`; the stream's claim is **verified** (the session must be this conversation's, in this account) and ignored otherwise. A stream that ends records `ending`; one that fails records `failed`; the provider's callbacks complete it. **If the CallSession cannot be recorded, the call is still answered** (logged, not dropped).
- **Outbound agent call.** `call.create` with `direction: outbound`; see [Outbound execution](#outbound-execution).
- **Owner test call** (existing, human-confirmed). `CallSessionService.placeOutbound` (origin `owner_test`) → `created` → `initiating` → Twilio's id attached → status callbacks (`initiated/ringing/answered/completed` are now requested) → the owner presses 1 and Twilio requests instructions on the *same* call, which is linked to its new conversation.

## Persistence

Created on first use with the repository's existing convention (`CREATE TABLE IF NOT EXISTS` under the advisory-lock `migrate()` helper; no new tooling):

- `call_sessions`, CHECK constraints on `direction` and `status`.
- `call_provider_events (provider, event_id)` primary key, cascade-deleted with the session.
- Indexes, each tied to a query: unique `(provider, provider_call_id)` (webhook lookup and one session per provider call); unique `(account_id, idempotency_key)` (retry lands on the same call); `(account_id, created_at DESC, id DESC)` (`call.list` keyset paging); `(account_id, status, created_at DESC)` (`call.list` by status); `(conversation_id)` (owner Stop resolves a conversation's call); `call_provider_events (call_session_id)` (cascade and diagnostics).

## Observability

`src/calls/log.ts`: one JSON line per event through `console` (the repository's existing convention, tagged `[call]`), always carrying `callId`,
`providerCallId` and `traceId`; phone numbers are masked (`+1••••••0123`); nothing secret is logged. The trace id is Vercel's `x-vercel-id` (else `x-request-id`)
for webhooks and the AppPort request's trace id for capabilities.

## Not built

Deliberately left for later PRs: bulk, scheduled or campaign dialing, automated retries, caller-ID rotation, contact lists;  answering-machine detection; AI-disclosure, consent, calling-window and
recording-consent policy; voicemail strategy; an MCP server transport; `call.answer`/`call.handoff`; an `operations.*`
view of calls (core's operation reader has no per-tenant ownership hook, so calls are read through `call.get`).
