# Release audit: iOS + Vercel control plane

Audited 2026-09-26 against `main` at `97fa7fd`; fixes are in this PR.

**Statuses:** **PASS** means implemented *and* exercised by an automated test
or the browser acceptance run. **GAP** means incomplete. **BLOCKED** means it
depends on credentials or hardware this environment doesn't have. **NOT
TESTED** means the code exists but no meaningful journey or test has run it. A
feature is never marked PASS just because the code exists.

**Evidence:**
- **Tests:** `npm test` passes 78/78 with Postgres (`TEST_DATABASE_URL`).
  `test/release-contract.test.ts` holds the release contract tests.
- **Browser acceptance:** `npm run acceptance` passed 12/12 steps, run against
  the full stack in **production mode**: `NODE_ENV=production`, Postgres, real
  AI SDK connector, signed Twilio webhooks and media stream. The only
  stand-ins were the external services: the AI Gateway model, a scripted
  Twilio caller, the SMS provider and the push service.
- **Screenshots:** `docs/screenshots/release/`.

---

## 1. Implementation audit

### What exists

| Area | Implementation |
|---|---|
| Web control plane | One static app, `public/index.html` (Apple HIG, iOS navigation stack), with a service worker (`public/sw.js`), served by the same Express server as the API |
| iOS | Before this PR, only the web app on iPhone (Home Screen app with Web Push). **This PR adds `ios/`**, a native SwiftUI app that hosts the same control plane |
| Server | Express (`src/http-app.ts`). Entry is `src/server.ts` (HTTP server plus the media-stream WebSocket); composition is in `src/bootstrap.ts` |
| State | Neon Postgres for conversations, runtime, commands, overrides, attention, notification deliveries, devices, configuration and sessions. A Postgres `LISTEN/NOTIFY` bus carries changes across instances |
| Live updates | Server-sent events: `/owner/events` (owner-wide) and `/conversations/:id/runtime/events` |
| Commands | Durable `runtime_commands` rows, idempotent by `commandId`, with states `accepted → applied/noop/rejected → applied_live` |
| Attention | Durable `owner_attention`. The NotificationRouter sends to Web Push, **APNs (new)**, Mac Messages and owner SMS |
| AI | AI SDK 7 through Vercel AI Gateway: realtime voice (`openai/gpt-realtime-2`) and text (`anthropic/claude-haiku-4.5`) |
| Telephony | Twilio `<Connect><Stream>`, bidirectional μ-law audio |

### Findings

| # | Finding | Before | Now |
|---|---|---|---|
| 1 | **Twilio webhooks behind Vercel's proxy.** Signatures were checked against `request.protocol` (http), but Twilio signs the https URL, so every production call, SMS and status webhook would have been rejected with 403 | GAP (P0) | **PASS**: the public URL and forwarded proto are checked (test: *Twilio webhooks verify behind Vercel's proxy*) |
| 2 | Authentication was one static access key, stored in `localStorage`, accepted in any `?token=`, compared without constant time, with no expiry or revocation | GAP | **PASS**: sessions (§2) |
| 3 | Off Vercel, production with no AI credential silently used `FakeConversationModel`, fake speech and fake voice | GAP | **PASS**: startup fails with a clear message |
| 4 | `createApp` silently used in-memory stores for anything not passed in | GAP | **PASS**: `production: true` refuses to start and names what's missing |
| 5 | `REALTIME_VOICE=off` in production gave callers a canned greeting and a recording nobody handled | GAP | **PASS**: refused in production |
| 6 | The text model was only created when realtime voice was on | GAP | **PASS**: independent of realtime voice |
| 7 | Web commands carried no `commandId`, so a retry after a lost response could apply a command twice | GAP | **PASS**: every command has an id; replay is safe (tested) |
| 8 | Tapping a stale notification (already answered elsewhere) still acted, e.g. took over | GAP | **PASS**: returns `409 attention_resolved`; the surface just shows the current state |
| 9 | No production health or smoke path | GAP | **PASS**: `/health` and `/health/ready` |
| 10 | No identity or bootstrap endpoint; each surface assembled state itself | GAP | **PASS**: `/owner/me` and `/owner/control-plane` |
| 11 | No native push; iOS required the Home Screen web app | GAP | **PASS** on the server (APNs over HTTP/2, tested against a real HTTP/2 server); **NOT TESTED** against Apple |
| 12 | No native iOS app | GAP | **NOT TESTED**: `ios/` written, not compiled (§3) |
| 13 | A real phone number couldn't be used; `TWILIO_PHONE_NUMBER` was required and was the number callers dial | GAP | **PASS**: keep your real number with carrier forwarding (§7) |
| 14 | Rate limits key on the client IP, which is Vercel's proxy address because `trust proxy` is off, so all clients share one bucket | GAP (minor) | Open. Harmless for a single owner, but sign-in attempts are limited globally (20 per 15 minutes) |
| 15 | One owner per deployment; no self-serve accounts | GAP (known) | **PASS**: multi-tenant accounts, self-serve sign-up and onboarding; see `docs/saas-readiness.md` |
| 16 | A missing or invalid environment variable crashed the function at load (`INTERNAL_FUNCTION_INVOCATION_FAILED`, seen on the first production deploy) with no explanation | GAP | **PASS**: every problem is reported at once on a setup page and at `/health/ready` (values never shown) |
| 17 | A failed first database setup (e.g. a Neon cold start) made every later request on that instance fail | GAP | **PASS**: setup is retried on the next request; the app page still loads, and API calls get `503 database_unavailable` |

### Browser-only and iOS-only assumptions

| Assumption | Where | Handling |
|---|---|---|
| Web Push on iPhone works only from the Home Screen app (iOS 16.4+) and shows no action buttons | Web | The tap carries the intent; the native app uses APNs with Reply and Take Over actions |
| `WKWebView` has no service worker | iOS app | The page detects the native frame and hands push to the app (`NATIVE` bridge) |
| iOS won't dial `*`/`#` codes from a link | Forwarding setup | The codes have Copy buttons, with "paste into the keypad" instructions |
| `EventSource` can't send headers | Web | Only `…/events` routes accept `?token=`, and only a session token |

---

## 2. The canonical contract (one control plane, two surfaces)

```
Browser (Vercel) ─┐
                  ├── same routes, same session model, same commands, same state (Neon)
iOS app ──────────┘   (the app hosts the same page and adds APNs, the Keychain and link routing)
```

There is no web-specific or iOS-specific business logic. The iOS app runs the
same `public/index.html`. Its native code calls only
`POST /owner/push/devices` (register APNs) and
`POST /owner/attention/:id/actions` (lock-screen Reply). Both are the same
routes the web uses.

| Need | Route |
|---|---|
| Sign up / in / out | `POST /auth/signup {email, password, name, platform}` or `POST /auth/sessions {email, password, platform}` → `{token, user, account, memberships, onboarding}`; `DELETE /auth/session`; `GET /me` |
| Signed-in devices | `GET /auth/sessions`; `DELETE /auth/sessions/:id` (also stops that device's notifications) |
| Current user | `GET /owner/me` |
| The plane and its state | `GET /owner/control-plane` → `plane.status` (`online` / `working` / `awaiting_attention` / `offline`), `live`, `attention`, `configuration.revision` |
| State changes | `GET /owner/events` (SSE); after any event, re-read the snapshot |
| Commands | `POST/PATCH /conversations/:id/runtime/*` with `commandId`; status at `GET /conversations/:id/runtime/commands` |
| Errors | JSON `{error, code}`, with codes `session_expired`, `session_revoked`, `attention_resolved`, `invalid_access_key`, `apns_not_configured` |
| Attention | `GET /owner/attention[/:id]`; `POST /owner/attention/:id/{opened,dismiss,actions}` |
| Take / release control | `POST …/runtime/takeover`, `POST …/runtime/return-to-assistant` |
| Conversation | `GET /conversations/:id`; `POST /conversations/:id/messages {body, idempotencyKey}` |
| Configuration | `GET/PATCH /owner/configuration` |
| Notifications | `POST /owner/push/devices` (web subscription, or `{platform:'ios', apnsToken}`) |
| Health | `GET /health` (liveness), `GET /health/ready` (smoke) |

**Sessions:**
- 30-day expiry that slides while the session is used; revocable one device at a time.
- Tokens are stored hashed; passwords are stored as scrypt hashes and never on a device.
- There is no shared access key: scripts and the acceptance run sign in to an account like any surface.

---

## 3. iOS app (`ios/`)

The app hosts the control plane and adds only native capabilities: APNs, the
Keychain session, routing from a notification (including cold start), universal
links and `textme://` links, and **Reply from the lock screen without opening
the app**. It does not need the browser to be open. Build steps are in
`ios/README.md`.

**Status: NOT TESTED.**
- This environment has no Mac, Xcode or Swift toolchain (swift.org and Swift
  apt packages are blocked).
- The code has been reviewed but never compiled.
- Everything the app depends on in the backend is PASS: sessions, iOS device
  registration, APNs delivery, stale-notification handling, universal links
  (`/.well-known/apple-app-site-association`) and the reply action.

---

## 4. Notification and re-entry lifecycle

Flow: plane event → attention (Neon) → router → Web Push / APNs → tap → authenticated app → `/conversations/:id/live?attention=…` → current state → action.

| Case | Web | iOS app | Evidence |
|---|---|---|---|
| App open | Banner plus live update over SSE | Banner (`willPresent`) plus live page | acceptance steps 7–9 |
| Backgrounded | Service worker focuses the window and posts `open` | `didReceive` → `LinkRouter` → page `open` | web: iphone-owner tests; iOS: NOT TESTED |
| Terminated | Service worker `openWindow(url)`; the page boots straight into the conversation | Delegate set in `didFinishLaunching`; the pending link is the first page loaded | web: deep-link cold open tested; iOS: NOT TESTED |
| Deep link | `/conversations/:id/live` | Universal link or `textme://` | acceptance step 8 |
| Stale / already resolved | Shows current state, "Already handled", no action | Same page; lock-screen Reply gets 409, and a follow-up notification says so | contract test *stale notifications never act*; acceptance step 10 |
| Reconnect after network loss | SSE reconnects, re-reads state, flushes queued commands | Same page; the offline page has a Retry button | acceptance step 11; `docs/screenshots/release/13–14` |
| Auth expiry | 401 `session_expired` → sign-in with the reason | Same page; the Keychain is cleared on `signedOut` | contract test; acceptance step 12 (revoked) |
| Duplicate notification | Web Push `tag` = attention id | APNs `apns-collapse-id` = attention id | contract test (APNs headers) |
| Command while disconnected | Queued with the same `commandId` / idempotency key and sent on reconnect | Same page; lock-screen Reply retry is idempotent (`ios:<attention>:reply`) | screenshots 13–14. The flush was triggered directly in that run; the automatic trigger on the `online` event is NOT TESTED |

---

## 5. Production configuration

### Vercel

| Item | Value |
|---|---|
| Framework preset | Express, auto-detected. The entry is `src/server.ts` via `package.json#main` |
| Build command | `npm run build` (`tsc`), then Vercel compiles the entry. TypeScript is pinned to 5.9 because Vercel's builder can't use TypeScript 7 |
| Functions | `vercel.json`: Fluid compute, `maxDuration: 800` for all functions (`"**/*"`) |
| Static files | `public/` is served from the CDN; `/`, `/conversations/*/live` and `/sw.js` are served by the app |
| Deep links | `/conversations/:id/live` returns the app shell |
| Production domain | `https://<project>.vercel.app`, taken from `VERCEL_PROJECT_PRODUCTION_URL` automatically, or `PUBLIC_BASE_URL` |
| Preview vs production | Previews are production-mode too (no fakes). They share the Neon database unless you set per-environment variables; point Twilio only at production |
| Smoke | `GET /health/ready` must return `200` with every check `ok` |

### iOS

| Item | Where |
|---|---|
| Production API URL | `ios/Config/Release.xcconfig` → `ATTN_HOST` (https only; enforced at launch) |
| Bundle id / team | `ATTN_BUNDLE_ID`, `ATTN_TEAM_ID`; they must match `APNS_BUNDLE_ID` and `APNS_TEAM_ID` on the server |
| Push entitlement | `aps-environment`: `production` in Release, `development` in Debug |
| Deep links | Associated domain `applinks:$(ATTN_HOST)`, plus the `textme://` scheme |
| Time-sensitive notifications | Entitlement `com.apple.developer.usernotifications.time-sensitive` |

### Backend

| Item | Status |
|---|---|
| Authentication | PASS: sessions, hashed, expiring, revocable |
| Command authorization | PASS: owner-scoped; attention actions resolve the conversation server-side |
| State persistence | PASS: Neon (tested with Postgres) |
| Attention and delivery persistence | PASS |
| Reconnect | PASS: a fresh instance recovers live state from Neon (Postgres test) |
| No local-infrastructure dependency | PASS: production refuses fakes, in-memory stores and http public URLs |

---

## 6. Environment variables: where to get each one

Set these in **Vercel → your project → Settings → Environment Variables**
(Production). After changing any of them, redeploy.

### Set automatically (nothing to do)

| Variable | Set by |
|---|---|
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Vercel → **Storage → Create Database → Neon** → connect it to the project. The integration adds both: pooled for queries, direct for `LISTEN/NOTIFY` |
| `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_GIT_COMMIT_SHA` | Vercel, on every deployment |
| `VERCEL_OIDC_TOKEN` | Vercel. Authenticates to AI Gateway, so no AI key is needed on Vercel. Make sure AI Gateway is enabled for your team (Vercel dashboard → **AI Gateway**) with billing or credits |

### Required: you create or copy these

| Variable | What | How to get it |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | The platform's Twilio account id (`AC…`). Its phone numbers are the pool of assistant lines accounts claim during setup | [console.twilio.com](https://console.twilio.com) → Account Info on the dashboard. Upgrade from trial: trial accounts play a trial message and can only call verified numbers. Buy numbers (voice + SMS) into it for the pool, or turn on `TELEPHONY_NUMBER_PURCHASE` |
| `TWILIO_AUTH_TOKEN` | Twilio auth token; also used to verify webhook signatures | Same Account Info panel → Auth Token (click to reveal) |

### Optional

| Variable | What | How to get it |
|---|---|---|
| `TELEPHONY_NUMBER_PURCHASE` | `on` lets an account buy a new assistant line when the pool is empty (the platform pays for it) | Leave unset to hand out only numbers already in the Twilio account. To text US callers from any line, complete **Messaging → Regulatory Compliance → A2P 10DLC** registration |
| `PUBLIC_BASE_URL` | A custom domain, e.g. `https://assistant.example.com` | Vercel → Settings → Domains; then set it here (https only) |
| `AI_GATEWAY_API_KEY` | Only when **not** on Vercel | Vercel dashboard → **AI Gateway → API Keys → Create** |
| `AI_GATEWAY_TEAM` | Team slug, only if the key belongs to a different team | Vercel team settings |
| `REALTIME_MODEL` | Voice model (default `openai/gpt-realtime-2`) | Vercel AI Gateway → Models |
| `REALTIME_VOICE_NAME` | Voice, e.g. `marin` | The model provider's voice list |
| `TEXT_MODEL` | Text model (default `anthropic/claude-haiku-4.5`) | Vercel AI Gateway → Models |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push keys. They're generated once and stored in Neon automatically; set these only to pin them | `npx web-push generate-vapid-keys`; subject `mailto:you@example.com` |
| `APNS_KEY_ID` | Native iOS push: the key's id | [developer.apple.com](https://developer.apple.com/account) → **Certificates, IDs & Profiles → Keys → +** → enable **Apple Push Notifications service** → Continue → Register. The Key ID is shown |
| `APNS_PRIVATE_KEY` | Contents of that key's `.p8` file (writing newlines as `\n` is fine) | Downloaded once on that page; Apple won't show it again |
| `APNS_TEAM_ID` | Your Apple Team ID (also used for universal links) | developer.apple.com → **Membership details** |
| `APNS_BUNDLE_ID` | The iOS app's bundle id, e.g. `app.textme.owner` | **Identifiers → +** (App IDs), with Push Notifications, Associated Domains and Time Sensitive Notifications enabled. Same value as `ATTN_BUNDLE_ID` in `ios/Config/Release.xcconfig` |
| `APNS_ENVIRONMENT` | `production` (TestFlight / App Store) or `development` (run from Xcode) | Match how you install the app |

### Never set (customer identity)

`OWNER_PHONE_NUMBER`, `OWNER_ID`, `OWNER_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`,
`USER_NAME`, `USER_PHONE`, `USER_EMAIL`, `ACCOUNT_ID`, `DEVICE_ID`: the
deployment refuses to start while any of these is set, because customers,
their numbers and their devices live in the database. A deployment that
predates accounts migrates once with `npm run migrate:legacy`
(`docs/saas-migration.md`).

### Local development only

`PORT`, `NODE_ENV`, `TEST_DATABASE_URL` (tests), and `AI_GATEWAY_BASE_URL`
(points the Gateway at a simulator). For the Mac bridge:
`MAC_BRIDGE_DATA_DIR`, `MAC_BRIDGE_PORT`, `PHOTON_CLIENT_MODULE`.

---

## 7. Keep your real phone number

A mobile carrier can only deliver a call to something that answers calls in
software, so the assistant needs a line on the telephony side. Callers never
see it:

```
caller dials YOUR number ──(you don't answer / decline / busy / no signal)──▶ carrier forwards
                                                                    ──▶ assistant line (Twilio) ──▶ your assistant
```

- **Setup:** the setup step **Your number**. The account claims its own
  assistant line from the platform's pool (pointed at this deployment), then
  verifies the owner's mobile number with a code texted from that line, and
  shows the forwarding code for the carrier: `**004*<line>#` for AT&T, T-Mobile and most
  carriers, or `*71<line>` for Verizon. Paste it into the Phone keypad and call.
- **Proof, not assumption:** the app shows **Forwarding works** only after a
  real forwarded call arrives. Twilio's `ForwardedFrom` is recorded as
  `call.forwarded` (tested; screenshot 11).
- **Limits:**
  - Texts the assistant sends to callers come from the assistant line; carriers
    can't send SMS as your number.
  - Texts people send to your real number still go to you.
  - A number porting service could move your number itself to Twilio instead;
    that's a larger change and isn't needed.

---

## 8. Release matrix

| Journey | Web / Vercel | iOS app | Backend | Status |
|---|---|---|---|---|
| Authenticate | PASS (acceptance 2) | NOT TESTED | PASS | Release-critical PASS on web and backend; iOS needs a device run |
| Load live plane | PASS (acceptance 3) | NOT TESTED | PASS | as above |
| Observe state | PASS (acceptance 4) | NOT TESTED | PASS | as above |
| Issue command | PASS (acceptance 5) | NOT TESTED | PASS | as above |
| Receive acknowledgement | PASS (`applied_live`) | NOT TESTED | PASS | as above |
| Receive attention | PASS (two sessions, live) | NOT TESTED | PASS | as above |
| Notification / deep link | Deep link PASS; real Web Push **BLOCKED** (needs Apple's push service and a phone) | APNs **BLOCKED** (needs Apple credentials and a device) | PASS (payloads, APNs HTTP/2 tested) | External blocker |
| Take control | PASS (tests); stale take-over refused (acceptance 10) | NOT TESTED | PASS | as above |
| Resolve attention | PASS (acceptance 9) | Lock-screen Reply: NOT TESTED | PASS | as above |
| Reconnect | PASS (SSE re-sync; offline queue) | NOT TESTED | PASS (new instance recovers from Neon) | as above |
| Persist across refresh / restart | PASS (acceptance 11: A, B and the API agree) | NOT TESTED | PASS | as above |
| Deployed on Vercel | **BLOCKED**: this environment can't deploy (no Vercel access). The build is reproduced locally with `vercel build` | — | — | External blocker |

**External blockers, and how to clear them:**

1. **Deploy to Vercel.** Merge, and let Vercel build `main`. Set the variables
   in §6. Then check that `/health/ready` returns 200 and run:
   `ACCEPTANCE_PASSWORD=… npm run acceptance -- --url https://<project>.vercel.app --email <account email> [--other-email <second account>]`.
   Call the account's number when it asks.
2. **Real telephony and AI.** A Twilio number, Twilio's signature on real
   webhooks, and the AI Gateway realtime model are all exercised by the step
   above.
3. **iOS app.** Build it on a Mac (`ios/README.md`), install it on a physical
   iPhone, and run the §9 journey.

## 9. iOS acceptance (physical iPhone, still to run)

1. Install and open the app, then sign in with an account's email and
   password (or create one and finish setup). **Settings → Signed-in devices**
   lists "iPhone app". Sign out and in as a second account: the control plane
   and notifications switch with it.
2. The Now screen shows the plane status. Turn on notifications; the device
   appears in `GET /owner/push/devices` as `platform: ios`.
3. Call your number and don't answer, so the forwarded call reaches the
   assistant. Live state appears.
4. Ask for something that needs you. An APNs notification arrives.
5. Tap it to open that conversation directly. Tap **Take Over**, then hand back.
   The command status shows `applied_live`.
6. **Terminate the app** by swiping it away.
7. From the browser, place another call that needs you. A notification arrives.
8. Long-press it and use **Reply** from the lock screen. The caller hears the
   answer, and the app never opened.
9. Tap the next notification with the app terminated. It opens straight into
   the conversation, and the state matches the browser's.
10. From the browser, sign out "iPhone app". The iPhone is signed out, and it
    stops receiving notifications.
