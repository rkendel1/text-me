# Telnyx carrier provider

Carrier selection does not change the CallSession domain model.

```
CallSession
    ↓
CallProvider (src/calls/provider.ts — unchanged)
 ├── TwilioCallProvider (src/telephony/twilio-call-provider.ts)
 └── TelnyxCallProvider (src/telephony/telnyx-call-provider.ts — this PR)
```

Telnyx AI Assistant is not the JTM agent runtime in this integration. The
agent runtime stays the JTM/Vercel AI SDK realtime bridge; no `assistantId`,
assistant configuration, prompt management, tool registry or Telnyx
conversation state was added to CallSession.

## Configuration

`TELEPHONY_PROVIDER=telnyx` swaps the adapter (default stays `twilio`).
Telnyx mode requires `TELNYX_CONNECTION_ID` (Voice API application),
`TELNYX_API_KEY` (bearer key) and `TELNYX_PUBLIC_KEY` (base64 webhook signing
key, Mission Control → Settings → Public Keys); startup fails closed without
them. `OUTBOUND_AGENT_CALLS=off` still denies before any provider is
contacted. No migration: a CallSession keeps its creation provider, and
webhooks resolve per provider. No dynamic routing, least-cost routing or
failover. Outbound dials carry `client_state: jtm` (base64); per-call
correlation travels in `webhook_url?…callId=` like Twilio's `statusUrl`.

### Webhook setup

One Voice API application delivers every event to its primary URL (plus
optional failover): `POST /webhooks/telnyx/voice` handles `call.initiated`
(inbound ring, like `/webhooks/twilio/voice`); `POST
/webhooks/telnyx/status?callId=…` handles answered/bridged/hangup plus
observations (like `/webhooks/twilio/status`). Both verify Ed25519 first,
acknowledge `200` + `{}` (no instruction document), and answer/decline parked
calls with call-control commands after recording the CallSession.

## Recording, media, AMD

Recording: `call.recording.saved` parses as a null-status observation; no
recording commands are sent and `getCallUsage` reports nothing `final`, so
there is no recording cost path. Media: the realtime runtime speaks Twilio
Media Streams framing; Telnyx streaming (`stream_url`,
`streaming.started/stopped/failed`) is a separate family this PR does not
bridge — Telnyx calls are answered at the signaling level (+ greeting) and
cannot use the existing voice runtime unchanged. AMD: never requested on
dial; `call.machine.detection.ended` variants parse as observations. Nothing
provider-specific is silently treated as a domain state.

## Reconciliation and usage

`findDialedCalls` always returns `{ outcome: 'not_found', conclusive:
false }`: no Telnyx list-by-from/to endpoint was verified, so no heuristic is
invented. Unconfirmed dials stay unconfirmed until a webhook attaches the id;
never redialed, never attached ambiguously, terminal state never violated.
`getCallUsage` returns `null` with `authoritativeUsage = []`: no per-call
settled-usage source was verified, so Telnyx calls stay `estimated` rather
than presenting guessed charges. Telnyx reference rates already exist in the
price book for the day real figures arrive; AI Assistant usage is never
metered here.

## Differences (Twilio vs Telnyx)

Outbound: `calls.create` vs `POST /v2/calls`. Answer: inline TwiML vs
`actions/answer` after recording. Hangup: `calls(sid).update` vs
`actions/hangup` (mode accepted, same command). Auth: HMAC
`X-Twilio-Signature` vs Ed25519 headers over raw bytes. Event id:
`(CallSid, CallStatus, seq?)` vs `data.id`. Recording/media/AMD/usage:
Twilio settled figures vs Telnyx observed-only / signaling-only / null usage
in this PR. Reconciliation: Twilio list heuristic (never conclusive) vs
Telnyx always-inconclusive.

## Verification, assumptions, limitations

New suites: `test/telnyx-provider.test.ts` (mapping + parsing) and
`test/telnyx-contract.test.ts` (signature + CallProvider contract over
stubbed `fetch`: success / 4xx / 5xx / timeout-abort / empty id /
hangup+answer / inconclusive lookup / null usage). Real Telnyx tests: none
performed (no credentials/number available); nothing is claimed
live-verified. Unverified assumptions: per-call `webhook_url` delivery,
`actions/answer` + `actions/speak` shapes, hangup code mapping,
`call.initiated` on both legs, and the `<timestamp>|<raw>` Ed25519
construction (matches the official Node SDK's `unwrap()`). Limitations:
signaling-level answer only (greeting or silence), no Telnyx voicemail
recording, no AMD/transcription/streaming commands, estimated-only cost,
webhook-only reconciliation, and the owner test call / spoken verification
code still dial through Twilio.

## Follow-ups

Media-transport adapter (Telnyx socket → existing `RealtimeVoiceService`
shape, behind `CallProvider`, never `if twilio/else` in the runtime);
Telnyx-native Voice AI runtime evaluation only after this contract is proven
(never as a carrier-selection side effect); `PhoneNumberClient` parity for
Telnyx numbers; verified settled-usage source → `authoritativeUsage`;
verified exact lookup → reconciliation search. No provider-neutral contract
change was necessary: `CallProvider`, `TelephonyProvider`, `DialUrls`,
`CallSession` and the ledger are untouched in shape (one additive getter on
the service for the webhook routes' call-control access).
