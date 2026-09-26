# Audit: Owner Communication End-to-End

## Executive result

FAIL

The repository is not currently sufficient evidence that a real owner can connect a real Mac, configure the system from the web, receive an owner request in Messages, reply in Messages.app, and have that mediated response reach the caller. The local audit did confirm the backend/web topology, the single-conversation voice→SMS model, and a route-registration bug that previously blocked audit execution. It did **not** confirm real Mac runtime, real Messages permissions, real Photon integration, or real Twilio end-to-end delivery.

## Environment

| Item | Value |
| --- | --- |
| Commit | `0c4adb776a6f09b5dfe07d219c22530ef5032909` |
| Backend environment | Node/TypeScript Express app started by `npm run dev` or `npm start`; `createApp` is wired from `src/server.ts` | 
| Database | PostgreSQL required by `src/config.ts:13-35`; schema provisioned by `PostgresConversationRepository.initialize()` in `src/repositories/postgres-conversation-repository.ts:45-84` |
| Web environment | Inline SPA served from `GET /` in `src/app.ts:397-420` |
| Mac version | BLOCKED — no macOS host in this audit environment |
| Messages environment | BLOCKED — no Messages.app / Full Disk Access context available |
| Bridge version | Source-only bridge classes in `src/owner/bridge.ts:4-145`; no packaged macOS app or CLI entrypoint found in the repository |
| Provider configuration | Twilio env vars are mandatory in production (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`) per `src/config.ts:19-33`; no real provider credentials were available in this audit environment |

## Actual repository topology

- **Backend start:** `npm start` runs `node dist/server.js`; `npm run dev` runs `tsx watch src/server.ts` (`package.json:6-10`).
- **Web app start:** no separate frontend build exists; the web control plane is inline HTML/JS returned by `GET /` (`src/app.ts:397-420`).
- **Postgres provisioning:** the production entrypoint creates a `pg.Pool`, instantiates `PostgresConversationRepository`, and calls `initialize()` before serving traffic (`src/server.ts:8-27`).
- **Mac bridge start:** no startup script or packaged executable exists in this repo. The only bridge runtime is the `MacOSMessagesBridge` class (`src/owner/bridge.ts:77-145`).
- **Mac bridge packaging/distribution:** none found. There is no Electron app, LaunchAgent, notarization metadata, signing config, or install flow.
- **Environment configuration:** `.env.example` plus `src/config.ts:13-35`.
- **Twilio configuration:** webhook auth and SMS sending are wired through `src/app.ts:134-145`, `src/telephony/twilio-provider.ts`, and `src/messaging/twilio-provider.ts`; all depend on runtime env vars.
- **Photon loading:** the repo contains only an adapter interface wrapper (`src/owner/photon-imessage-adapter.ts:8-42`). No Photon package dependency or concrete runtime client is installed in `package.json`.
- **Test database provisioning:** tests use in-memory repositories/services instead of Postgres (`test/app.test.ts:23-123`, `test/owner-channel.test.ts:99-145`).
- **Production vs test mode:** production uses Postgres plus Twilio config from `src/server.ts:8-27`; tests and local fake flows rely on in-memory services and fake providers via `createApp` defaults (`src/app.ts:89-115`).

## Durable model audit

### What is present

- `Conversation` and append-only `ConversationEvent` are first-class and persisted in Postgres (`src/domain/conversation.ts:55-70`, `src/repositories/postgres-conversation-repository.ts:45-84`).
- `OwnerDevice` exists, including `status`, `setupStatus`, health, selected chat, and timestamps (`src/owner/device.ts:33-48`).
- `OwnerConfiguration` exists and carries a numeric `revision` (`src/owner/configuration.ts:30-36`).

### What is absent or not durable

- No durable `Owner`, `OwnerChannel`, `OwnerAssistantChat`, `OwnerConfigurationRevision`, or `Delivery` table/entity exists in Postgres. `OwnerChannel` is only an interface (`src/owner/channel.ts:14-16`), configuration audit events are in-memory (`src/owner/configuration.ts:52-116`), and delivery state is represented only as conversation events.
- Device sessions, pairing codes, device records, configuration state, and configuration audit history all default to in-memory Maps (`src/owner/device.ts:56-80`, `src/owner/configuration.ts:52-54`).
- `ConversationChannel` only enumerates `voice | sms | web`; macOS Messages is represented as an event/message source, not a first-class conversation channel (`src/domain/conversation.ts:7-10`, `src/services/conversation-engine.ts:115-162`).

### Model conclusions

- **Single conversation identity:** PASS (with caveat). Voice, caller SMS, and owner replies all attach to one `Conversation` through `conversation_events`; the repository never creates a second conversation during voice→SMS transition (`src/services/conversation-service.ts:73-113`, `src/http/presenters.ts:26-30`).
- **Multiple devices per owner:** PASS. `OwnerDeviceStore.list(ownerId)` and `OwnerDeviceService.setPrimary()` clearly support multiple records (`src/owner/device.ts:50-72`, `src/owner/device.ts:210-226`).
- **Unambiguous device lifecycle:** FAIL. The required states `ready` and `unhealthy` are inferred through `setupStatus`/`health`, but there is no persistent `ready`, `unhealthy`, or `revoked-session` state machine beyond in-memory derivation (`src/owner/device.ts:4-11`, `src/owner/device.ts:235-240`).
- **Channel state independent of device:** FAIL. Channel enablement lives in configuration, but there is no durable channel record independent from device state (`src/owner/configuration.ts:21-36`, `src/owner/channel.ts:19-21`).
- **Authoritative, versioned configuration:** FAIL. Revision numbers exist, but only in memory; there is no durable revision log or authoritative replay source after restart (`src/owner/configuration.ts:52-116`).

## Journey results

| Stage | Result | Evidence |
| --- | --- | --- |
| Backend boots with production wiring | PASS | `src/server.ts:8-27`, `npm run build` succeeded locally |
| Web control plane serves | PASS | `GET /` returns inline SPA from `src/app.ts:397-420` |
| Database schema auto-provisions | PASS | `PostgresConversationRepository.initialize()` creates/updates tables (`src/repositories/postgres-conversation-repository.ts:45-84`) |
| QR pairing API exists | PASS | `POST /owner/devices/pair/qr` returns `{ deviceId, pairingUri, expiresAt }` (`src/app.ts:192-202`) |
| QR is actually rendered by the web app | FAIL | Endpoint returns JSON only; no QR image/canvas/SVG generation path exists in `src/app.ts:192-202` or the SPA in `src/app.ts:397-420` |
| Pairing credential is opaque, owner-bound, single-use, and expiring | PASS | `OwnerDeviceService.pair()`/`activate()` use random base64url codes, owner-bound entries, 10-minute expiry, and delete the code on activation (`src/owner/device.ts:83-136`); covered by `test/owner-channel.test.ts:99-135` |
| Device activation route is externally callable on a cold app | PASS | This PR moved `POST /owner/devices/activate` to top-level registration (`src/app.ts:227-235`) and added regression coverage in `test/app.test.ts:413-428` |
| SMS consent and voice→SMS transition routes are externally callable on a cold app | PASS | This PR moved `POST /conversations/:id/sms-consent` and `POST /conversations/:id/convert-to-text` to top-level registration (`src/app.ts:442-466`) and added regression coverage in `test/app.test.ts:358-381` |
| Real Twilio call answer | NOT RUN | No real Twilio credentials/webhooks available in this environment |
| Explicit voice→SMS consent flow | PASS (simulated) | Local fake-provider flow passes in `test/app.test.ts:328-381`; real phone/Twilio path not run |
| Caller SMS durability/idempotency | PASS (simulated) | Existing tests cover idempotent conversation reuse and text-active messaging paths (`test/app.test.ts:153-174`, `test/app.test.ts:328-410`) |
| Owner request reaches real Messages.app | BLOCKED | No runnable macOS app/bridge packaging, no real Messages integration host, and production server does not wire a real owner channel (`src/server.ts:15-27`) |
| Owner reply from Messages.app reaches backend and then caller | BLOCKED | No real Mac/Photon runtime available; only fake adapter/unit bridge coverage exists (`test/owner-channel.test.ts:30-97`) |
| Browser owner reply mediation | PASS (simulated) | Authenticated owner inbox path is covered in `test/app.test.ts:430-466` |
| Channel toggles change runtime behavior | PASS (service-level), FAIL (durable end-to-end) | `OwnerConfigurationService.isChannelEnabled()` gates macOS owner sends (`src/owner/configuration.ts:107-110`, `src/owner/macos-messages-channel.ts:18-20`), but configuration is not durable across restart |
| Configuration sync to devices | FAIL | Device config is fetched ad hoc from in-memory configuration (`src/app.ts:299-306`); no durable revision stream, replay, or offline catch-up exists |
| Delivery observation distinguishes send request from observed send | FAIL | Bridge confirms delivery by matching outgoing body text to a pending map, not by stable provider correlation (`src/owner/bridge.ts:102-118`) |
| Real deployment parity | FAIL | No packaged Mac runtime, no persisted owner/device/configuration model, and no evidence of production HTTPS/origin/rate-limit/deployment documentation beyond basic env vars |

## Findings

### GAP-001 — Audit-harness routes were previously registered only inside other request handlers
- **Severity:** High
- **Boundary:** HTTP surface between the web/bridge audit harness and the backend.
- **Evidence:** Before this PR, manual probing returned `404` for `POST /owner/devices/activate`, `POST /conversations/:id/sms-consent`, and `POST /conversations/:id/convert-to-text` on a cold app. This PR moves those registrations to top level in `src/app.ts:227-235` and `src/app.ts:442-466`, with regression tests in `test/app.test.ts:358-381` and `test/app.test.ts:413-428`.
- **Smallest corrective PR:** Done in this PR: register those routes during app construction, not during unrelated request execution.

### GAP-002 — The “QR” pairing flow does not render a QR code or expose a web onboarding flow
- **Severity:** High
- **Boundary:** Web control plane → owner pairing UX.
- **Evidence:** `POST /owner/devices/pair/qr` returns JSON only (`src/app.ts:192-202`). The inline SPA at `src/app.ts:397-420` has conversation and device list controls, but no pairing, QR display, scan status, or activation UI.
- **Smallest corrective PR:** Add an authenticated web pairing screen that requests `/owner/devices/pair/qr` and renders an actual QR image/SVG plus expiry/activation state.

### GAP-003 — Production startup does not wire a real macOS owner channel, device persistence, or configuration persistence
- **Severity:** Critical
- **Boundary:** Backend composition root → Mac owner-messaging path.
- **Evidence:** `src/server.ts:15-27` injects only the conversation repository and Twilio messaging provider. `createApp()` therefore falls back to in-memory `OwnerDeviceService` and `OwnerConfigurationService` (`src/app.ts:95-97`), and no `ownerChannel` or `ownerMessagesAdapter` is provided.
- **Smallest corrective PR:** Introduce production implementations for owner device store, configuration store, and Mac owner channel wiring; inject them from `src/server.ts`.

### GAP-004 — There is no distributable/signed Mac bridge application in the repository
- **Severity:** Critical
- **Boundary:** Ordinary owner machine → Mac bridge runtime.
- **Evidence:** The repo contains reusable bridge classes (`src/owner/bridge.ts:77-145`) and an adapter interface (`src/owner/photon-imessage-adapter.ts:8-42`), but no app bundle, LaunchAgent, installer, signing, notarization, or CLI entrypoint. `package.json` has no Photon dependency and no bridge script.
- **Smallest corrective PR:** Add a concrete macOS bridge package/app with install/run instructions, startup integration, and production Photon client wiring.

### GAP-005 — Device sessions, device records, pairing state, and configuration audit history are lost on restart
- **Severity:** Critical
- **Boundary:** Backend process lifetime → durable owner/device/configuration state.
- **Evidence:** `OwnerDeviceService` keeps pairing codes and sessions in Maps (`src/owner/device.ts:74-77`), and the default store is `InMemoryOwnerDeviceStore` (`src/owner/device.ts:56-72`). `OwnerConfigurationService` keeps configuration and audit history in Maps (`src/owner/configuration.ts:52-54`).
- **Smallest corrective PR:** Add Postgres-backed stores for owner devices, sessions, pairing credentials, configuration state, and configuration audit events; inject them in production.

### GAP-006 — Configuration is versioned numerically but not durably revisioned or replayable
- **Severity:** High
- **Boundary:** Web settings change → offline/restarted device synchronization.
- **Evidence:** `OwnerConfiguration` has a `revision` field (`src/owner/configuration.ts:30-36`), but updates only overwrite an in-memory object and append an in-memory audit event (`src/owner/configuration.ts:82-116`). Device config fetch is a simple read of current state (`src/app.ts:299-303`), so there is no durable revision history or ordering enforcement.
- **Smallest corrective PR:** Persist each configuration revision with monotonic ordering and have devices request/apply the latest authoritative revision from durable storage.

### GAP-007 — Apple Messages delivery confirmation is inferred from matching message body text
- **Severity:** High
- **Boundary:** Backend owner-delivery request → bridge observation of a sent Messages item.
- **Evidence:** `MacOSMessagesBridge.trackDelivery()` stores `deliveryId -> body`, and outgoing observation confirmation searches for the first pending delivery with the same body (`src/owner/bridge.ts:102-118`). Two identical bodies can therefore confirm the wrong delivery.
- **Smallest corrective PR:** Correlate sends and observations with a stable provider/request identifier or bridge-generated nonce persisted alongside the delivery request.

### GAP-008 — macOS Messages is not a first-class durable conversation channel
- **Severity:** Medium
- **Boundary:** Domain model → observability/reporting.
- **Evidence:** `ConversationChannel` is limited to `voice | sms | web` (`src/domain/conversation.ts:7-10`). Owner Messages replies are represented only via event payload `source` values (`src/services/conversation-engine.ts:115-162`, `src/http/presenters.ts:6-17`).
- **Smallest corrective PR:** Promote owner-channel source/delivery metadata to durable structured fields (or a first-class owner-delivery table) so operators can query Messages-vs-browser behavior without parsing raw event payloads.

## Validation run for this PR

- `npm test -- test/app.test.ts` ✅
- `npm run build` ✅
- Manual post-fix route probe ✅
  - `POST /owner/devices/activate` now returns `401 Invalid or expired pairing code` instead of `404`
  - `POST /conversations/:id/convert-to-text` now reaches business logic and returns `409 Owner phone number is not configured` instead of `404`
  - `POST /conversations/:id/sms-consent` now returns `200` instead of `404`

## Overall conclusion

This repository demonstrates a promising append-only conversation core and simulated voice/SMS/browser owner flows, but it does **not** yet prove the required real-owner, real-Mac, real-Messages, real-Twilio end-to-end journey. The highest-risk blockers are the missing production Mac bridge/runtime wiring, missing durable owner/device/configuration persistence, and weak delivery-confirmation semantics.
