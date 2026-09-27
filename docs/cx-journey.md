# CX journeys and audit guide

This is the script for the end-to-end audit on a **real Vercel deployment,
real Neon database, real Twilio number, real caller and real owner**. Each
journey lists the exact steps, what the caller and owner should experience,
and the evidence that proves it (UI, audit timeline, and Neon rows).

A simulated provider never counts as a pass. The "Local evidence" column in
the matrix at the end records what this PR proved against the full local stack
(Postgres, signed Twilio webhooks and media stream, the real AI SDK code path
against a Gateway stand-in). The production audit fills in the last column.

## Setup (once), on an iPhone, with no Mac

1. Deploy to Vercel, add **Neon** from the Vercel Marketplace, and set the
   environment variables from the README. No Mac, Photon or Messages settings
   exist or are needed.
2. On the iPhone, open `https://<project>.vercel.app` in Safari and sign in.
   First run: **Welcome → Your number → Connect My Number** (the server points
   the Twilio number at this deployment; nothing to paste) → **How should your
   assistant handle calls?** → **Add to Home Screen** → open from the Home
   Screen → **Turn On Notifications** → ready.
3. **Settings → Notifications → Send a Test Notification** should arrive on
   the lock screen.

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
| 2 | Hears “Let me check with Randy” — never silence | Lock-screen notification **“Jordan needs you” / “Can you do Friday at 2?”** | `owner.attention.requested`; attention `assistant_needs_owner` → `delivered`; `notification.sent` (`surface: web_push`, `notificationId`, `attentionId`); runtime `status: owner_needed` |
| 3 | — | Taps the notification → **that live call opens directly** (no inbox); taps **Friday at 2 works** | attention `opened`, then `owner.message` (`messageId`, `requestId`); command `answer_owner_request` |
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

## Journey I — the whole product on an iPhone, no Mac

This is the acceptance journey. Every step must work with **no Mac, no
Photon and no Messages authorization** anywhere in the account.

| # | Step | Evidence |
|---|---|---|
| 1–5 | iPhone owner with no Mac signs in, connects the number, chooses behavior, adds to Home Screen, turns on notifications | `owner_surface_devices` row (`platform: web`, capabilities `push, deep_link`); `owner_configurations.onboarding.completed` |
| 6–9 | Someone calls; the assistant answers, transcribes, replies by voice; everything lands in Neon | `voice.started` (realtime), `speech.transcript`, `ai.response` |
| 10 | **No unnecessary interruption** | attention `conversation_started` is `passive` and has **no** `notification_deliveries` row |
| 11–12 | The assistant needs the owner; the iPhone gets a notification | attention `assistant_needs_owner` `delivered`; `notification.sent` via `web_push` |
| 13–15 | Tap → the exact live conversation, with the transcript | URL `/conversations/<id>/live?attention=<id>`; attention `opened` |
| 16–18 | **Reply** or **Take Over** from the live screen (or the notification's own action where the platform shows one) | `POST /owner/attention/:id/actions`; command `answer_owner_request` or `take_over` → `applied_live`; attention `acted` |
| 19 | **Adjust** this call | one `adjust_interaction` command; the live screen shows *Temporary settings*; **Reset to defaults** clears it; Settings unchanged |
| 20–21 | **Text**: the conversation moves to SMS and continues as the same conversation | `conversation.channel_transitioned`; same `conversation_id` for caller SMS |
| 22 | Close the app, reopen it (or reload) | `/conversations/<id>/live` rebuilds everything from the API |
| 23 | At no point is a Mac involved | no `owner.delivery.*` events; no `mac_messages` deliveries |

## Journey J — connect a Mac by QR (optional integration)

The Mac is an executor: it pairs by scanning a code and then follows the
owner's settings. Nothing is typed on the Mac. Screenshots:
[`docs/screenshots/qr-pairing`](screenshots/qr-pairing), captured by driving
the real bridge process (`npm run bridge:macos`) whose camera saw the QR the
iPhone displayed, against the local production stack.

| # | Step | Expected, and where to verify it |
|---|---|---|
| 1 | Settings → Connected devices → **Connect a Mac…** | QR sheet, *Waiting for Mac…*, 5:00 countdown (06). `owner_pairing_credentials` row; QR payload is `attn://pair/<token>?s=<deployment>` only |
| 2 | On the Mac run the bridge | **Connect this Mac** opens with the camera (07). Nothing to configure |
| 3 | Hold the iPhone up to the Mac camera | Mac shows *Mac connected* (12); iPhone switches to *Mac connected ✓* within ~1.5 s (08) and continues into Messages setup (09). Credential row deleted; `device.connected` audit |
| 4 | Pick your own thread as the assistant chat | Only the owner's own thread is offered (09); `assistant.chat.changed` audit; within one sync the Mac shows *Watching Messages* (10) |
| 5 | **Test Connection** | Five checks pass, *Nothing was sent* (11); no message appears in Messages |
| 6 | Turn **Apple Messages** off | Mac stops watching without restarting (14); iPhone shows *Connected · Apple Messages off* (15); `owner.channel.disabled` audit; Mac deliveries stop |
| 7 | Scan the same QR again (another Mac) | Rejected: *That code has expired or was already used* |
| 8 | Revoke the Mac | Confirm sheet (16); the Mac's next request is 401, it forgets its credential and returns to the scanner with *This Mac was disconnected* (17); `device.revoked` audit |
| 9 | Connect again with a new code | Works; the Mac is a new active device |
| 10 | A setting fails to save | *Unable to update setting. Try again.* and the control shows the stored value (05) |

### Real-device acceptance (must be run on hardware)

The automated run above uses a stand-in for Messages. Before release, run it on
a real Mac and iPhone against the Vercel deployment:

1. Mac with the bridge built (`npm install && npm run build && npm run bridge:macos`).
   Grant **Full Disk Access** and **Automation → Messages** when macOS asks.
2. Do steps 1–5 above. Confirm the chat list contains only your own thread.
3. Place a test call; when the assistant asks you something, confirm the
   question arrives in your own Messages thread on the Mac and on the iPhone.
4. Reply in that thread from the iPhone. Confirm the caller hears the answer and
   the reply appears once in the live conversation (not twice).
5. Turn Apple Messages off, place another call that needs you: nothing arrives in
   Messages; the push notification still arrives.
6. Revoke the Mac. Confirm the bridge returns to the scanner within ~5 s and no
   further messages are sent from the Mac.
7. Quit and relaunch the bridge while connected: it reconnects without a new
   code.

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
| iPhone owner needs no Mac | PASS | Production composition starts and runs with no Mac config (Postgres test); no Mac delivery attempts (tests) | ☐ |
| Owner attention is durable | PASS | `owner_attention` + `notification_deliveries` in Neon (Postgres test) | ☐ |
| Push to the iPhone | PASS | Payload + deep link recorded exactly as sent to the push service (tests, harness); real APNs delivery needs the production audit | ☐ |
| Notification → exact live conversation | PASS | Cold open of the push URL lands on the live call in ~270 ms (screenshot `iphone-default/07`) | ☐ |
| Zero-navigation Take Over / Reply | PASS | Attention actions resolve the conversation server-side (tests, screenshot 08) | ☐ |
| Quiet by default | PASS | Only `assistant_needs_owner`/`error` interrupt; opt-in for routine calls (tests) | ☐ |
| Production Vercel deployment | PASS | Not done in this PR | ☐ |
| Real Twilio path | PASS | Not done in this PR | ☐ |

## Known limits to check during the audit

- **iOS web push needs the Home Screen app** (iOS 16.4+) and shows no action
  buttons, so the tap opens the live conversation, where Reply and Take Over
  are one tap away. Chrome and Android show the buttons.
- There are no self-serve accounts yet: one deployment serves one owner,
  signed in to their account (email and password).

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
