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
| Media stream | bridge, stream open to close | estimated |
| Recording | voicemail callback `RecordingDuration` | estimated |

`finalize-call-usage` (`GET /api/internal/cron/finalize-call-usage`, every 15 minutes in `vercel.json`, the same `CRON_SECRET` bearer auth as reconciliation) asks the carrier for ended calls that have no authoritative telephony entry: 10 minutes after they end, up to 48 hours, newest first, 25 at a time. Read-only at the carrier; it can never create a call. Calls a carrier never rates are asked again until the 48 hours pass.

### Reading it

- **Per call:** `call.get` gains an optional `cost` (`status: unknown|estimated|final`, `estimatedCost`, `finalCost`, `breakdown` by category, `unpricedUsage`, `derived`). It is additive; `call.list`, `call.create` and `call.end` are unchanged, and a deployment without a ledger returns exactly what it did. The MCP projection inherits it; there is no MCP-specific path. Access is the existing `call.read` authorization and account scoping: another account's call is `NOT_FOUND`.
- **Aggregates:** `CallCostLedger.aggregate({ accountId, dimension, from, to })` over the durable ledger: `category`, `provider`, `model`, `direction`, `outcome` (the call's final status), `day`, `month`, each with amount, authoritative amount, calls, and cost per call. Capped at 20,000 usage rows per query (reported as `truncated`). Not exposed over HTTP or AppPort; no analytics surface was built.
- **Outcome economics:** the call domain has no task outcome taxonomy, so none was invented; the call's terminal status is the outcome. "Cost per completed call" is `outcome = completed`. Linking cost to a task or campaign later needs only a reference from that work to the `CallSession` id.

## Migration safety

Additive: two new tables created with `CREATE TABLE IF NOT EXISTS` and indexes with `IF NOT EXISTS`; `call_sessions` is untouched. Existing calls work unchanged and have no ledger rows. **Nothing is backfilled**: historical usage that was never recorded cannot be reconstructed deterministically (the dropped callback durations are gone), so those calls show `unknown` (or a derived estimate while their lifecycle times exist) rather than invented figures. Rollback is dropping the two tables; nothing else references them.

## Known limitations

- Twilio rating latency, `calls(sid).fetch()` field availability for every call type, and gateway pass-through of realtime usage are unverified against real services.
- Media Streams and recording have no authoritative carrier figure in this implementation, so a call that used them stays `estimated` forever. Reading Twilio's Usage records for them is a follow-up.
- Cached tokens may overlap input tokens in a vendor's accounting; the ledger records each metric as reported and leaves overlap to how rates are configured.
- Amounts are `NUMERIC(24,9)` in Postgres and JavaScript numbers in memory, rounded to 9 places (6 when presented).
- A call that is never rated is re-asked for 48 hours; with a very large backlog of such calls, finalization throughput (25 per 15 minutes) bounds how quickly new calls are served (newest first).
