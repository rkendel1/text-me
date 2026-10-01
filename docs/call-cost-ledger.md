# Call cost ledger

Every call is made economically observable from durable state: what was used, by whom, priced at what, and whether that is an estimate or settled.
This document says what is built. Where something is not built or not verified, it says so.

```
CallSession ─► CallProvider ─► provider adapter ─► normalized usage ─► pricing resolver ─► cost ledger
 (the call)    (interface)     (Twilio today)       (UsageEvent)        (price book)       (usage + cost components)
```

Twilio, Telnyx and any later carrier all end at the same normalized usage model. AI vendors and models enter the same way, from the runtime instead of an adapter.

**Invariants**

- **Carrier choice is an infrastructure decision, not a domain-model decision.** Nothing in `src/calls` (including `src/calls/cost`) names a carrier or an AI vendor, branches on one, or contains a price. A test enforces it.
- **AI provider and model choice is an execution decision, not a call-domain decision.** The ledger records `provider`, `product`, `model`, `metric`, `quantity`, `unit`: no table or type is vendor-shaped.
- **Historical cost is immutable with respect to future pricing changes.** Each usage event is priced once, when recorded, and the rate used is stored on the cost component. A new rate is added to the price book; nothing recorded is rewritten.
- **Logs are not accounting.** Structured logs (`call.usage.*`) help debugging; the ledger tables are the only source of cost.

## Source-grounded audit (before the change)

| | What the source shows |
|---|---|
| Call lifecycle | `CallSession` (`src/calls/model.ts`), statuses `created → initiating → ringing → answered → in_progress → ending → terminal`; `transitionCallSession` is the only status writer; provider callbacks enter `CallSessionService.applyProviderEvent`; inbound by webhook, outbound by `call.create` (policy-gated, off by default) with reconciliation of lost dials. |
| Provider abstraction | `CallProvider` (`src/calls/provider.ts`): `createCall`, `endCall`, `findDialedCalls`. One adapter, `TwilioCallProvider`, plus `FakeCallProvider`. Status vocabulary is translated in `provider-status.ts`. |
| AI / voice | Realtime voice through the AI SDK Gateway (`src/voice/realtime`, `RealtimeConnector.modelId`, default `openai/gpt-realtime-2` style ids); one integrated realtime model, so there is **no separate STT/TTS** to charge. The text agent (`generateText`) serves SMS conversations, not calls. |
| Where usage is observable | (1) Twilio status callbacks (`CallDuration`; the adapter parsed it but **it was dropped before reaching the service**); (2) Twilio's call resource after the call (`duration`, `price`); (3) the realtime event `response-done` (carries `raw`); (4) the media-stream start/stop in the call bridge; (5) the voicemail `<Record>` callback (`RecordingDuration`, `RecordingSid`). |
| Persistence | Postgres via `pg`, tables created with `CREATE TABLE IF NOT EXISTS` under an advisory-lock `migrate()` helper (no migration tool). `call_sessions`, `call_provider_events`. |
| Billing / metering | Stripe subscription state only (`src/billing/stripe.ts`, `subscriptions`). **No usage, metering or cost concept existed.** |
| Attachment seams | `applyProviderEvent`; `CallBridge` response/stream events; the voicemail route; `CallProvider.getCallUsage` (new); `call.get` output. |

Provider-neutral: call id, lifecycle, direction, objective, destination, caller identity, usage events, the ledger, the reconciliation contract, the outcome. Provider-specific (inside the adapter): the dialing API, webhook format, provider call SID, media transport, recording API, AMD API, status mapping, lookup, failure semantics, pricing lookup.

## The ledger

Two **insert-only** tables (`PostgresCallUsageStore`, `src/repositories/postgres-call-usage-repository.ts`); the code has no `UPDATE` or `DELETE` against them, and a test checks that no other file writes them.

`call_usage_events`: `call_session_id` (FK to `call_sessions`, the one canonical call), `account_id`, `subject`, `idempotency_key` (unique), `category`, `provider`, `product`, `model`, `metric`, `quantity`, `unit`, `basis` (`estimated` | `final`), `source`, `reported_amount`/`reported_currency` (a charge the provider itself states), `occurred_at`, `recorded_at`, `metadata`.

`call_cost_components`: one per usage event (unique), written in the same transaction: `amount`, `currency`, `rate_source` (`rate_card` | `provider_reported` | `unpriced`), `rate_id`, `rate`, `rate_per`, `rate_unit`, `priced_quantity`, `priced_at`.

- **Idempotency.** The key is deterministic and scoped to the call (a carrier callback's own event id, `ai:<call>:<response>:<metric>`, a recording or stream id). A replayed webhook, a retried job, a second instance or reconciliation records nothing the second time (`ON CONFLICT DO NOTHING`, tested with 20 simultaneous deliveries).
- **Estimated vs final.** `subject` names the quantity being measured (one call's duration at one carrier). Observations of one subject are successive readings: the authoritative one wins, otherwise the latest; different subjects add. A correction is therefore a new event, and the estimate it supersedes stays in the ledger with the price it had.
- **Not final merely because the call ended.** A call's cost is `final` only when the call is over, nothing is derived, nothing is unpriced, and every observed dimension is authoritative.
- **No fabricated usage.** Token counts come only from what the runtime reported (nothing from elapsed time); media-stream and recording figures are our own observations and are `estimated`. A call that never connected has no telephony cost unless the carrier reported one.
- **Active calls.** An estimate is derived on read from the call's lifecycle times and the price book, never stored (no timer writes rows). It is flagged `derived`.

### Pricing

`UsageEvent → PriceBook.resolve → CostComponent` (`src/calls/cost/pricing.ts`). A rate has `provider, product, metric, model?, unit, rate, per, currency, effectiveFrom, effectiveTo`. The default book is loaded from `src/billing/call-reference-rates.ts`, **configuration data**: Twilio and Telnyx US list prices as supplied to the project on 2026-10-01 (unverified against an invoice; not a statement of this account's charges). Telnyx is listed only so its usage can be priced when an adapter reports it; nothing is routed to it. **No AI rate is configured**: AI usage is recorded and shown as unpriced until a rate for the model is added. Changing a price means adding a rate with a later `effectiveFrom`.

A provider-stated charge (Twilio's rated `price`) is used as the amount; no rate is applied or invented.

### Providers

`CallProvider.getCallUsage(providerCallId)` returns normalized observations (`key, category, product, metric, quantity, unit, basis, reportedAmount?`). `TwilioCallProvider` implements it with `calls(sid).fetch()`: `duration` seconds, and `price`/`priceUnit` once Twilio has rated the call (Twilio states a charge as a negative number; the adapter reports it absolute). A rated call is `final`; one with a duration but no price is an `estimate`. How long Twilio takes to rate a call is **not verified**.

A future carrier implements the same method; `test/call-cost-ledger.test.ts` runs a provider contract over Twilio (against an SDK stub) and the fake provider. No Telnyx adapter was written.

### Where usage is recorded

| Usage | Source | Basis |
|---|---|---|
| Telephony duration | status callback `CallDuration` on a terminal status | estimated |
| Telephony duration + charge | `finalize-call-usage` cron, from the carrier's call record | final when rated |
| AI voice tokens | realtime `response-done` `raw.response.usage` (OpenAI's documented shape; whether the Gateway passes it through unchanged is unverified) | final (reported by the model vendor) |
| Media stream | bridge, stream open to close | estimated, **non-finalizable** (see below) |
| Recording | voicemail callback `RecordingDuration` | estimated; superseded by the carrier's own recording record (`finalize-call-usage`) when completed and rated |
| AI usage not reported | a `response-done` with no usage: one marker per call (`metric: invocation`, `unavailable`) | estimated, unpriced, **non-finalizable** |

`finalize-call-usage` (`GET /api/internal/cron/finalize-call-usage`, every 15 minutes in `vercel.json`, the same `CRON_SECRET` bearer auth as reconciliation) asks the carrier for ended calls that have no authoritative telephony entry. See [Finalization](#finalization) for the exact policy. Read-only at the carrier; it can never create a call.

### Reading it

- **Per call:** `call.get` gains an optional `cost` (`status: unknown|estimated|final`, `estimatedCost`, `finalCost`, `breakdown` by category, `unpricedUsage`, `derived`). It is additive; `call.list`, `call.create` and `call.end` are unchanged, and a deployment without a ledger returns exactly what it did. The MCP projection inherits it; there is no MCP-specific path. Access is the existing `call.read` authorization and account scoping: another account's call is `NOT_FOUND`.
- **Aggregates:** `CallCostLedger.aggregate({ accountId, dimension, from, to })` over the durable ledger: `category`, `provider`, `model`, `direction`, `outcome` (the call's final status), `day`, `month`, each with amount, authoritative amount, calls, and cost per call. Capped at 20,000 usage rows per query (reported as `truncated`). Not exposed over HTTP or AppPort; no analytics surface was built.
- **Outcome economics:** the call domain has no task outcome taxonomy, so none was invented; the call's terminal status is the outcome. "Cost per completed call" is `outcome = completed`. Linking cost to a task or campaign later needs only a reference from that work to the `CallSession` id.

## Discrepancies found re-reading the first version against the code

1. **Recording could never have been superseded.** The callback estimate and the carrier's report used different `subject` strings, so a settled recording figure would have been added beside the estimate instead of replacing it. Both now use `<provider>:<providerCallId>:recording:<recordingSid>`.
2. **"Eventually final" was overstated.** A call that used a media stream can never be `final` (Twilio has no per-call media figure). The summary now says so explicitly (`nonFinalizable`) and reports `authoritativeCost` for the settled part.
3. **Newest-first finalization could starve old calls** and re-asked unrated calls on every run. Replaced by the fair, bounded policy below, with durable attempt state.
4. **A runtime that reports no usage looked fully accounted.** It now leaves an explicit unavailable marker.
5. The claim that realtime usage is "final (reported by the model vendor)" holds only if the Gateway forwards usage; that is unverified (see Known limitations).

## Migration safety

Additive: three new tables (the two ledger tables and the operational `call_usage_finalization`) created with `CREATE TABLE IF NOT EXISTS` and indexes with `IF NOT EXISTS`; `call_sessions` is untouched. Existing calls work unchanged and have no ledger rows. **Nothing is backfilled**: historical usage that was never recorded cannot be reconstructed deterministically (the dropped callback durations are gone), so those calls show `unknown` (or a derived estimate while their lifecycle times exist) rather than invented figures. Rollback is dropping the three tables; nothing else references them.

## Finality, and the life of an observation

```
observed ─► normalized ─► priced ─► authoritative ─► included in final cost
(a callback,  (UsageEvent,  (CostComponent,  (basis = final:    (the call is over and every
 a report,     provider-     once, with the   the provider or    observed usage is authoritative
 a runtime     neutral)      rate kept)       runtime settled    and priced)
 event)                                       it)
```

An estimate is an **immutable observation, not a mutable placeholder**. It is never edited when better information arrives: the better observation is a new event on the same `subject`, the authoritative one wins for the call's cost, and the estimate stays in the ledger with the price it had.

`summarizeCost` states each call's cost as one of:

| `status` | Meaning |
|---|---|
| `unknown` | Nothing observed, and nothing derivable (a call that never connected, for instance). |
| `estimated` | Some part is estimated, derived or unpriced. `authoritativeCost` still reports the settled part, `pending` lists categories that may still be settled (waiting, not wrong), `nonFinalizable` lists categories that can never be, and `unpricedUsage` counts usage with no price. |
| `final` | The call is over, nothing is derived, nothing is unpriced, and **every** observed usage is authoritative. `finalCost` is then set. |

| Case | Result |
|---|---|
| A. telephony, AI, media, recording all authoritative | `final` |
| B. telephony and AI authoritative, media estimated | `estimated`; media is `nonFinalizable` |
| C. telephony authoritative, AI usage unavailable | `estimated`; the unavailable marker is unpriced and `nonFinalizable`; no tokens are derived |
| D. call still active | never `final`, whatever was recorded |
| E. ended, provider has not rated it | `estimated`; telephony `pending` |
| F. no rate and no reported charge | `estimated`; `unpricedUsage > 0` |

**Giving up asking is not settling.** A call whose attempts are used up stays `estimated`; it is reported as `exhausted` and nothing is ever promoted to authoritative because the asking stopped.

**What can actually be final today.** Media-stream usage has no per-call authoritative figure from Twilio (its Usage Records are account-level aggregates by category and date, with no call identifier, so they cannot be attributed to one call). Every call that used a media stream, which includes every realtime-voice call, therefore stays `estimated` with `nonFinalizable: ['media']`, and `authoritativeCost` is the figure to read for the settled part. A future carrier that reports a settled media figure per call would make such calls `final` with no domain change (its adapter lists the category in `authoritativeUsage` and reports it).

**Active-call estimate.** Computed on read, from: the call's `answeredAt`, `endedAt` (or now), its direction, and the price book's rate in force at `answeredAt`. Flagged `derived: true`; never stored; used only while no telephony usage has been recorded, so a recorded observation, authoritative or not, always replaces it.

### Finalization

`CallCostLedger.finalizeCompletedCalls`, run by the `finalize-call-usage` cron:

- **Eligible:** terminal calls tied to a provider call, with no authoritative telephony usage, that ended between 48 hours (the horizon) and 10 minutes ago.
- **Fair:** never-asked calls first (oldest first), then the least recently asked. A newer call cannot starve an older one, and the order is not newest-first. (The first version was newest-first, which could leave old calls unasked while new ones kept arriving.)
- **Bounded:** at most one attempt per call per hour and at most 24 in all, tracked durably in `call_usage_finalization` (attempts, last attempt, last outcome), which is operational bookkeeping and the only ledger-adjacent table updated in place. The attempt is claimed with a database row lock, so two instances cannot both take it.
- **Exhausted calls remain inspectable:** the state row and `health()`.
- **Report:** each run returns `examined, skipped, recorded, duplicates, notReady, failed` and the database-wide `pending` and `exhausted` counts.
- `CallCostLedger.health()` is an internal function (no route, no AppPort capability): calls with usage in a window that are authoritative, estimated, with unpriced usage, or holding non-finalizable estimates, plus pending-rating and exhausted counts.

## Verified

**Nothing in this document has been verified against a real Twilio account or the live AI Gateway.** This environment has no Twilio credentials and no Gateway key, and outbound access to `twilio.com` and `openai.com` is blocked, so no call was placed and no vendor price page could be read. What *was* verified is the installed SDK's type surface and source, which fixes what can be asked, not what is returned:

- `calls(sid).fetch()` returns `duration`, `price`, `priceUnit`, `status`, `direction` (strings); `calls(sid).recordings.list()` returns recordings with `sid`, `status` (`processing | completed | absent | deleted`), `duration`, `price`, `priceUnit` (`node_modules/twilio/lib/rest/api/v2010/account/{call,recording}.d.ts`, `call/recording.d.ts`).
- Twilio's `usage.records` take a category and a date range and carry no call identifier, so media-stream usage cannot be attributed to a call from them.
- The Gateway's realtime model (`@ai-sdk/gateway`, `GatewayRealtimeModel.parseServerEvent`) returns the server event unchanged; the AI SDK's normalized `response-done` event has `responseId`, `status` and `raw: unknown` and **no usage field**, and the SDK itself never reads usage. Usage can therefore only come from `raw`, whose content is whatever the Gateway forwards.

`scripts/verify-call-usage.ts` is a read-only probe for someone with credentials: it prints a call's raw fields next to what the adapter reports, with the call's age, so rating latency and field availability can be observed by running it repeatedly. It was not run here.

## Repository-tested but externally unverified

Proven by tests (against an SDK stub, a fake provider and real Postgres), not by real provider execution:

- Twilio adapter mapping: duration and a rated `price` (negative, reported absolute) → a settled telephony observation; no price → an estimate; recordings (completed and rated → settled; processing → estimate; absent or without duration → nothing); never any media observation.
- The finality cases A-F, the active-call estimate, immutability of estimates and prices, historical pricing stability (including an AI rate change), input and output tokens priced separately.
- Idempotency under 20 simultaneous deliveries; webhook, recording callback, AI usage and two finalizers running concurrently against Postgres (repeated); atomic event-plus-price writes; recovery after a failed write, a failed finalization and a restarted process.
- Fair, bounded finalization across instances, exhaustion, the horizon, and health counts.
- `call.get` cost over AppPort and MCP (identical output), tenant isolation, a call with no ledger, an unpriced call, and no pricing internals or provider ids in the output.
- The provider contract (none / multiple observations / estimated / authoritative / metadata / duplicates / priceable) over the Twilio adapter and the fake provider.
- Guards: no carrier SDK, price field or rate literal under `src/calls`; price fields read only in the Twilio adapter; rates declared only under `src/billing`.

## Known limitations

- **Unverified, so conservative:** when Twilio assigns `price` after a call ends, whether it can be absent permanently or change later, what a zero-duration or failed call reports, whether media-streamed or recorded calls report differently, and whether a recording's `price` is a per-minute fee or a one-time fee (the SDK describes it as "the one-time cost of creating the recording"; it is used as stated, without a rate). A rated `price` is treated as settled the first time it is seen; if Twilio revises it, the revised value is a new observation that supersedes the old one (same subject, different idempotency key) but nothing re-asks once a call is settled.
- **The AI Gateway's usage is unverified.** The ledger reads `raw.response.usage` (OpenAI's Realtime `response.done` shape) and records only fields that are present and numeric. If the Gateway does not forward it, every response is recorded as "unavailable" (once per call) and no token count is derived from time or transcript. Whether usage arrives once or more than once per response, whether cached tokens overlap input tokens, and which model identifier the Gateway reports are unknown; replays are harmless because the key is the response id and metric. The model recorded is the one configured (`connector.modelId`).
- **No AI rate is configured.** The current realtime model (`openai/gpt-realtime-2` by default, `REALTIME_MODEL` to change) has no price in `src/billing/call-reference-rates.ts`, because no authoritative price source was reachable and a remembered price would be a guess. AI usage is recorded and shown unpriced (so a call is never `final` on AI usage until a rate exists). To add it, put the vendor's published input, output (and cached, if separately priced) rates into that file as `provider: 'openai', product: 'realtime', model: 'gpt-realtime-2'` rates per metric, with `unit: 'token'`, `per: 1_000_000` and an `effectiveFrom` date; no code changes.
- **Media-stream usage is never authoritative** (see above), so realtime-voice calls are never `final`.
- Finalization policy numbers (hourly attempts, 24 attempts, 48 hour horizon) are conservative choices, not measured: they should be revisited once rating latency is observed.
- Amounts are `NUMERIC(24,9)` in Postgres and JavaScript numbers in memory, rounded to 9 places (6 when presented).
- Cached tokens may overlap input tokens in a vendor's accounting; each metric is recorded as reported and overlap is a matter of how rates are configured.
- The SMS text agent's AI usage is not call-bound and is not metered.
- No Telnyx adapter exists. To add one: implement `CallProvider` (including `getCallUsage` and `authoritativeUsage`) in `src/telephony`, and add its rates (already listed) to the price book; nothing in `src/calls` changes.
