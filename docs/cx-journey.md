# CX journeys and audit guide

This is the script for the end-to-end audit on a **real Vercel deployment,
real Neon database, real Twilio number, real caller and real owner**. Each
journey lists the exact steps, what the caller and owner should experience,
and the evidence that proves it (UI, audit timeline, and Neon rows).

A simulated provider never counts as a pass. The "Local evidence" column in
the matrix at the end records what this PR proved against the full local stack
(Postgres, signed Twilio webhooks and media stream, the real AI SDK code path
against a Gateway stand-in). The production audit fills in the last column.

## Setup (once)

1. Deploy to Vercel, add **Neon** from the Vercel Marketplace, and set the
   environment variables from the README. Confirm `https://<project>.vercel.app`
   loads the sign-in screen.
2. Sign in with `OWNER_AUTH_TOKEN`. First run shows **Welcome → Connect your
   number → How should I normally handle calls?**
3. In Twilio, paste the three webhook URLs shown on the Connect screen
   (Voice, Messaging, Status callback) into the phone number, HTTP POST.
4. Keep two devices ready: the **caller's phone** and the **owner's phone**
   (control plane open at `/`, optionally installed to the home screen).

### Evidence tools

- `GET /conversations/:id/audit` (owner auth): one ordered timeline of every
  conversation event, runtime event and command, with ids:
  `turnId` (caller or model turn), `responseId` (model response),
  `commandId`, `messageId`, `requestId` (owner request), `streamSid`,
  `callSid`, `providerMessageId` (Twilio SMS SID), `revision`.
- `GET /conversations/:id/runtime/commands`: each owner command with
  `status` (`accepted` → `applied`/`noop`/`rejected` → `applied_live`),
  `processedAt`, `appliedLiveAt`.
- Neon SQL (examples below). The runtime is identified by
  `conversation_id` + `configuration_revision`.

```sql
-- Authoritative state for one conversation
SELECT * FROM conversation_runtimes WHERE conversation_id = $1;
SELECT type, payload, occurred_at FROM conversation_events WHERE conversation_id = $1 ORDER BY occurred_at;
SELECT type, status, processed_at, applied_live_at FROM runtime_commands WHERE conversation_id = $1 ORDER BY created_at;
SELECT field, value, expires_at FROM conversation_runtime_overrides WHERE conversation_id = $1;
```

---

## Journey A — first call

| Step | Caller | Owner | Evidence |
|---|---|---|---|
| 1 | Calls the Twilio number | — | Twilio webhook `POST /webhooks/twilio/voice` returns `<Connect><Stream>` |
| 2 | Hears the short greeting (“Hi, this is Randy’s assistant. How can I help?”) immediately — no disclaimer, no menu | Now shows a **Live** card | `voice.started` with `streamSid`, `callSid`; model = `openai/gpt-realtime-2` (or `REALTIME_MODEL`) |
| 3 | Explains why they’re calling | Live transcript updates within ~1s | `speech.transcript` (`turnId`), `ai.response` (`responseId`) |
| 4 | Is asked their name if they didn’t give it | Card shows name + reason | `caller.identified`, `assistant.activity` “Noted caller …” |
| 5 | Gets a natural spoken answer | — | audio heard; `ai.response` text matches what was said |
| 6 | Hangs up | Card moves to **Recent** | `call.ended`, `voice.completed` `outcome: ended`; rows persist in Neon |

## Journey B — owner intervention (“Ask me”)

| Step | Caller | Owner | Evidence |
|---|---|---|---|
| 1 | Asks something only Randy can decide (“Can we move to Friday at 2?”) | — | — |
| 2 | Hears “Let me check with Randy” — never silence | **Owner Needed** card with the question and one-tap answers; banner if the app is open; Messages/SMS notification | `owner.attention.requested` (`requestId`, `suggestedReplies`), `assistant.activity` “Asked Randy: …”, runtime `status: owner_needed` |
| 3 | — | Taps **Friday at 2 works** (or replies from Messages/SMS) | `owner.message` (`messageId`, `requestId`, `source`); command `answer_owner_request` |
| 4 | Hears the answer relayed naturally (“Randy says Friday at 2 works…”) | Card clears | `runtime.owner_speech` (`commandId`), command `applied_live`; next `ai.response` contains the relay |

Pass requires the notification to arrive **only** here, not for routine calls (see H).

## Journey C — takeover

| Step | Caller | Owner | Evidence |
|---|---|---|---|
| 1 | Is mid-conversation | Opens the call, taps **Take Over** | command `takeover` → `applied_live`; runtime `status: takeover`, `aiMode: owner_only` |
| 2 | Keeps talking; the assistant **does not** answer on its own | Sees each caller turn in the transcript | `speech.transcript` continues; no autonomous `ai.response` after the takeover timestamp |
| 3 | — | Types “Friday at 2 works.” | `owner.message`, `runtime.owner_speech` |
| 4 | Hears it relayed by the assistant (mediated, not read out verbatim) | — | `ai.response` relaying it |
| 5 | — | Taps **Hand Back** | command `return_to_assistant` → `applied_live`; assistant answers again |

## Journey D — live adjustment

| Step | Owner | Evidence |
|---|---|---|
| 1 | During a call, **Adjust → Ask me before making commitments** | commands `set_override` (`aiMode`, `askOwnerWhen`, `allowCommitments`) → `applied_live`; runtime revision increments |
| 2 | Caller asks for a commitment | assistant escalates (`owner.attention.requested`) instead of agreeing |
| 3 | **Adjust → Response style → Detailed** | `set_override verbosity` → `applied_live`; next `ai.response` is longer |
| 4 | Open **Settings** | Defaults unchanged (“These changes apply only to <name>”); `owner_configurations` row unchanged |

## Journey E — voice controls

| Step | Owner | Evidence |
|---|---|---|
| 1 | **Adjust → Transcription off** | `set_override transcriptionEnabled=false` → `applied_live`; strip shows *Transcribe Off* |
| 2 | Caller speaks | no new `speech.transcript` events |
| 3 | **Transcription on** | `applied_live`; the next caller turn appears again |
| 4 | **Voice off** | the assistant stops speaking audio (text-only session); **Voice on** restores it |

## Journey F — voice → SMS

| Step | Caller | Owner | Evidence |
|---|---|---|---|
| 1 | Assistant offers to continue by text; caller says “Sure” | — | — |
| 2 | Hears “A text is on its way,” goodbye; call ends | Card shows **Texting** | `assistant.activity` “Moved the conversation to text”, `sms.consent.granted`, `conversation.channel_transitioned`, `sms.sent` (`providerMessageId`) |
| 3 | Receives “…continuing our conversation here” from the same number | — | Twilio message log |
| 4 | Replies by SMS | The reply appears in the **same** conversation; the assistant answers (or escalates) | `caller.message` (`providerMessageId`), `assistant.message`; same `conversation_id` |
| 5 | — | Owner answers from web, Messages or SMS | caller receives the mediated reply (“Randy says…”) |

## Journey G — restart / reconnect

| Step | Owner | Evidence |
|---|---|---|
| 1 | During an active call, hard-refresh the browser (or kill the PWA) | — |
| 2 | Reopen | Same conversation state, controls, open request and transcript (all from Neon) |
| 3 | Tap **Pause** | command `pause` → `applied_live` even if the request is served by a different Vercel instance than the call (LISTEN/NOTIFY) |

## Journey H — no owner involvement

| Step | Caller | Owner | Evidence |
|---|---|---|---|
| 1 | Calls with something simple (“Confirming lunch Friday”) | — | — |
| 2 | Assistant handles it and ends the call | **No notification** | no `owner.attention.requested`; no owner SMS/Messages delivery |
| 3 | — | Conversation is in **Recent** as “Handled · …” | full history in Neon |

---

## Acceptance matrix

| Capability | Required | Local evidence in this PR | Production audit |
|---|---|---|---|
| Real phone call | PASS | Signed Twilio voice webhook + signed media stream accepted locally | ☐ |
| AI answers | PASS | Greeting requested on stream start; audio streamed back (tests, harness) | ☐ |
| Caller speech understood | PASS | `input-transcription-completed` → `speech.transcript` (tests) | ☐ |
| AI response spoken | PASS | `audio-delta` → Twilio `media`, playback marks (tests, harness) | ☐ |
| Live transcript | PASS | SSE + list/detail refresh; screenshots 06, 11, 12 | ☐ |
| Owner sees active call | PASS | Now card with Live pill; screenshots 05, 10 | ☐ |
| Owner can stop AI | PASS | Stop → farewell → hang-up (test “owner stop says goodbye…”) | ☐ |
| Owner can take over | PASS | Autonomous replies cancelled during takeover (tests) | ☐ |
| Owner can return control | PASS | `return_to_assistant` → `applied_live` (tests) | ☐ |
| Owner can change behavior live | PASS | `set_override` → live `session-update` (tests Journey C/D) | ☐ |
| Voice toggle affects runtime | PASS | Live `session-update` switches output audio ↔ text (test “Journey E”) | ☐ |
| Transcription toggle affects runtime | PASS | Test “Journey E” | ☐ |
| Owner request reaches owner | PASS | Owner SMS notification + Owner Needed card (test “Journey B”) | ☐ |
| Owner reply reaches caller | PASS | Web / SMS / Messages reply relayed on the call (test “Journey B”, screenshot 13) | ☐ |
| SMS transition | PASS | `transition_to_text` → consent, intro SMS, text_active (tests, harness) | ☐ |
| Same conversation preserved | PASS | Caller SMS lands on the same conversation (test “Journey F”) | ☐ |
| Browser refresh preserves control | PASS | All state loaded from the API; nothing authoritative in the browser | ☐ |
| Neon contains authoritative state | PASS | Postgres stores for conversations, runtime, overrides, commands, config, devices | ☐ |
| No production in-memory authority | PASS | In-memory stores are test defaults only; bootstrap wires Postgres everywhere. Live call sockets are per-instance by nature and reload state from Postgres on every command | ☐ |
| AI SDK is actual runtime path | PASS | `gateway.experimental_realtime` + `generateText` via `createGateway` (test drives the real SDK connector) | ☐ |
| Production Vercel deployment | PASS | Not done in this PR | ☐ |
| Real Twilio path | PASS | Not done in this PR | ☐ |

## Known limits to check during the audit

- **Vercel WebSockets are in public beta.** Calls rely on the Function holding
  the Twilio media stream; `vercel.json` sets `maxDuration: 800` (raise it if
  your plan allows longer calls). Verify a 10+ minute call during the audit.
- **`schedule` and `send_sms` tools are not implemented**: there is no
  calendar backend, and texting is only offered through `transition_to_text`
  with consent. The assistant takes a message or asks the owner instead.
- The legacy record-and-transcribe pipeline (`/conversations/:id/turns`, fake
  speech/voice providers) remains for local development without a Gateway
  key; production always answers with realtime voice when Gateway auth is
  present.
