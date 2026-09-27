# SaaS audit: where customer identity lived, and where it lives now

This audit was taken on the single-owner code at commit `64b6988` (the parent
of the multi-tenant change). Every **source** reference below points at that
commit, so each finding can be checked against the code as it was. The
**replacement** column describes what the code does now.

The single-owner deployment belonged to one person: the deployment's
environment named them (`OWNER_ID`, `OWNER_PHONE_NUMBER`, `OWNER_AUTH_TOKEN`,
`TWILIO_PHONE_NUMBER`), and code filled every gap with that person (`'owner'`,
`'Randy'`). The target is an account-owned model:

```
authenticated principal (session) → membership → authorized account → resource
```

Legend. **Tenant-specific**: the value or behavior identifies or belongs to one
customer. **Migration**: what `npm run migrate:legacy` (see
[`saas-migration.md`](saas-migration.md)) does for the existing deployment.
**Tests**: where the replacement is proven.

Test files: `tenancy` = `test/tenancy.test.ts`, `isolation` =
`test/multi-tenant-isolation.test.ts`, `scaling` =
`test/horizontal-scaling.test.ts`, `migration` = `test/legacy-migration.test.ts`,
`release` = `test/release-contract.test.ts`, `journey` =
`scripts/saas-browser-journey.ts` (`npm run journey:saas`).

---

## 1. Environment variables

| # | Current behavior | Source | Tenant-specific | Replacement | Migration | Tests |
|---|---|---|---|---|---|---|
| E1 | `OWNER_PHONE_NUMBER` was required; it was the owner's mobile, the SMS fallback destination, and the number whose texts counted as owner replies | `src/config.ts:103,117-118,156`; `src/services/conversation-service.ts:45`; `src/http-app.ts:357,372,576`; `src/bootstrap.ts:125` | Yes (a person's phone) | `phone_numbers` row, `kind='personal'`, verified by a code texted from the account's own line (`PhoneNumberService.startPersonalVerification/confirmPersonalVerification`). Read per account via `personalNumber(accountId)` | Passed once as `--personal-number`; stored `verified` with `verification_status='migrated'`; SMS fallback stays on (`messages.smsEnabled`) | tenancy (lifecycle, one account per verified number), isolation (SMS fallback to each account's own number), migration |
| E2 | `OWNER_ID` (default `'owner'`) was stamped on every row and was the only identity in the system | `src/config.ts:157`; `src/http-app.ts:316`; `src/services/conversation-service.ts:46` | Yes (the tenant key) | Opaque `acct_…` ids from `accounts`; the request's account comes from the session and a live membership | Every `owner_id='owner'` row is re-owned by a deterministic account id | migration, isolation |
| E3 | `OWNER_AUTH_TOKEN` was the one shared access key; any holder was "the owner". Without it the API ran **open** (`authenticate()` returned the owner for every request) | `src/config.ts:104,158`; `src/auth/sessions.ts:83,88-92`; `src/http-app.ts:140,456,481` | Yes (a customer credential in platform config) | `users` with scrypt password hashes; `POST /auth/signup`, `POST /auth/sessions {email,password}`; sessions carry `userId` + active `accountId`. No access key, no open mode | Owner gets email + password; access-key sessions table dropped | tenancy, release ("no shared access key", "access keys are gone") |
| E4 | `TWILIO_PHONE_NUMBER` was the deployment's single assistant line, and the sender of every text | `src/config.ts:113,120-121,155`; `src/bootstrap.ts:120-125,139-143`; `src/telephony/phone-number.ts:111-126` | Yes (a number assigned to one customer) | `phone_numbers` row `kind='assistant_line'` claimed from the platform pool (`POST /account/phone/line`); `AccountMessenger` sends every text from the sending account's line | Adopted with `--assistant-line` (or the provider account's only number) through `adoptAssistantLine` | tenancy (claim, race), isolation (texts `from` each account's line), migration |
| E5 | Missing customer variables were reported as "missing" at startup (so an operator was told to set them) | `src/config.ts:101-105`; `src/startup-failure.ts` | — | Only platform variables are required. The customer variables now **refuse** startup with an explanation (`customerIdentityProblems`) so no hidden legacy path stays active | Remove them after migrating | release ("customer identity there refuses to start") |
| E6 | `TWILIO_ACCOUNT_SID/AUTH_TOKEN`, `APNS_*`, `VAPID_*`, AI Gateway, `DATABASE_URL*` | `src/config.ts` | No (platform) | Unchanged: platform secrets, never sent to clients. `TELEPHONY_NUMBER_PURCHASE` added (platform policy) | — | release (health never echoes secrets) |

## 2. Hardcoded constants

| # | Current behavior | Source | Tenant-specific | Replacement | Migration | Tests |
|---|---|---|---|---|---|---|
| H1 | Default configuration named the owner "Randy": `ownerName`, greeting, introduction ("…he gets your message") | `src/owner/configuration.ts:109-113` | Yes | New accounts start with no name; greeting and introduction follow the account's own name until customized (`defaultGreeting/defaultIntroduction`), set in the identity step | The owner's stored configuration moves with the account unchanged | tenancy (greeting follows the name), isolation (A's calls say "Avery's assistant", B's "Blake's") |
| H2 | SMS introduction to callers said "this is Randy's assistant … Randy prefers text" | `src/services/conversation-service.ts:148` | Yes | Uses the conversation's account's owner name (`ownerNameFor(accountId)`) | — | app ("this is Randy's assistant" only for the Randy account) |
| H3 | Non-realtime greeting "This is Randy's assistant. He isn't taking calls" in the Twilio and fake providers | `src/telephony/twilio-provider.ts:117`; `src/telephony/fake-provider.ts:62` | Yes | `answerCall(conversation, { greeting })` with the account's greeting | — | app ("fake provider exercises the same lifecycle") |
| H4 | Fake model's canned reply named Randy | `src/conversation/fake-model.ts:9` | Yes (dev only) | Neutral wording | — | — |
| H5 | Prompts assumed a male owner ("on his behalf", "asking him") | `src/voice/realtime/session-config.ts:79,115` | Yes (a person's pronouns) | Neutral wording ("on their behalf", "asking them"); defaults use "they" | — | — |
| H6 | `conversation.ownerId ?? 'owner'` fallbacks when loading settings for a call | `src/runtime/service.ts:590`; `src/voice/realtime/call-bridge.ts:79,197` | Yes (defaulted to the one owner) | `accountId` is required on a conversation; the call bridge refuses to start a call without one and uses its conversation's account | Legacy rows get an account | isolation (bus), release |

## 3. Singleton and process-local state

| # | Current behavior | Source | Tenant-specific | Replacement | Migration | Tests |
|---|---|---|---|---|---|---|
| S1 | `PhoneNumberService` resolved "the assistant line" once and cached it in the process | `src/telephony/phone-number.ts:92,110-127` | Yes | No cache: each account's line is a row; any instance reads it | — | scaling |
| S2 | `OwnerAuthService` was constructed with one `ownerId` for everyone | `src/http-app.ts:481`; `src/auth/sessions.ts:57-64` | Yes | `AuthService` is identity-free; sessions name the user and account | — | release, tenancy |
| S3 | The plane had no record: `id: plane_${owner}` | `src/http-app.ts:1224` | Yes | `planes` table (one per account), created in the application step | Created from the owner's assistant name | tenancy, migration |
| S4 | Onboarding was one boolean in the single configuration | `src/owner/configuration.ts` (`onboarding.completed`); `public/index.html:2193` | Yes | Account onboarding state machine persisted on `accounts.onboarding_state`, derived from durable facts | Evaluated for the migrated account (must be `ready`) | tenancy, migration, journey |
| S5 | Runtime changes were read-modify-write; `expectedRevision` was checked before an unconditional save, so two instances could both "win" | `src/runtime/service.ts:523-575` (`applyCommand`), `src/repositories/postgres-conversation-runtime-repository.ts` (`save`) | No (correctness under scale) | Compare-and-set on `configuration_revision` in one statement (`save(runtime, expectedRevision)`); the loser gets `409 stale_revision`. Found by the Postgres scaling test | — | scaling ("different commands racing on one revision: exactly one wins") |
| S6 | A command id was checked for replay, then recorded: two instances receiving the same command at once both executed it (and the loser could mark the winner's command rejected) | `src/runtime/service.ts:80-104` | No (correctness under scale) | `commands.record` is the idempotency gate (`INSERT … ON CONFLICT DO NOTHING` returns whether this call inserted); only the inserter executes, others wait for its outcome | — | scaling ("concurrent submissions of the same command … applied once") |
| S7 | Rate limits are per process (express-rate-limit memory store) | `src/http-app.ts:335-346,1120` | No | Unchanged; limits are abuse protection, not correctness. Per-instance limits are looser, never wrong | — | — |
| S8 | Web Push VAPID keys cached per process after first load from `app_secrets` | `src/attention/surfaces.ts` | No (platform secret) | Unchanged; the durable copy decides, every instance agrees (`getOrCreate`) | — | vercel-runtime (concurrent cold starts agree) |
| S9 | Filesystem state | Server: none (`public/` is static). Mac bridge keeps its own device credential on the Mac | Device-held | Unchanged: the Mac's credential is its device session; its account comes from the server | — | isolation (jobs) |

## 4. Data access: queries and filters

| # | Current behavior | Source | Tenant-specific | Replacement | Migration | Tests |
|---|---|---|---|---|---|---|
| D1 | `repository.list()` loaded **every** conversation in the database; callers filtered in memory | `src/repositories/postgres-conversation-repository.ts:146-160`; used at `src/http-app.ts:1205,1249,1595`, `src/runtime/service.ts:186`, `src/services/conversation-service.ts:167,235,248,355` | Yes | `list(accountId)` with `WHERE account_id = $1` (and an index); every caller passes the authorized account | — | isolation (reads) |
| D2 | Filters were **fail-open**: `!conversation.ownerId \|\| conversation.ownerId === owner` showed ownerless conversations to everyone | `src/http-app.ts:1206,1597`; `src/runtime/service.ts:187,202` | Yes | Scoped queries; ownership checks require `accountId` on both sides (`requireOwnedConversation`, `assertOwnedBy`) | Ownerless legacy conversations are assigned to the migrated account | isolation |
| D3 | `runtime.requireOwnedConversation` allowed conversations with no owner | `src/runtime/service.ts:732` | Yes | Fails closed when either side has no account | — | isolation (writes/commands → 404) |
| D4 | `/conversations/:id`, `/messages`, `/audit` enforced ownership only when an access key was configured | `src/http-app.ts:1539,1619-1623,1639-1646` | Yes | Always enforced | — | isolation, app |
| D5 | `/conversations/:id/turns`, `/convert-to-text`, `/sms-consent` had **no authentication** | `src/http-app.ts:1692,1714,1727` | Yes | `tenant('conversation.control')` + ownership | — | app ("the scripted pipeline is not open to anyone"), isolation |
| D6 | Caller history for the AI (`priorConversations`) searched all conversations by caller phone | `src/services/conversation-service.ts:246-252` | Yes (cross-customer context leak) | Only the conversation's own account | — | isolation (instructions never mention the other owner) |
| D7 | Surface devices: `setStatus(id)` unscoped; the same push token could stay active in two accounts | `src/attention/stores.ts:26,111`; `src/attention/postgres.ts:284` | Yes | `setStatus(accountId, id, …)`; `upsert` retires the token's registration in every other account (one physical device, one signed-in account) | Legacy devices re-owned; `user_id` set | isolation (iOS: same phone, different account) |
| D8 | Attention/notification/command rows carried `owner_id` from the deployment owner | `src/attention/postgres.ts`, `src/repositories/*` | Yes | Column renamed to `account_id` at startup (`renameOwnerColumn`); values set from the conversation's account | Rows re-owned | migration, isolation |

## 5. Provider, phone number and notification configuration

| # | Current behavior | Source | Tenant-specific | Replacement | Migration | Tests |
|---|---|---|---|---|---|---|
| P1 | Every call was attributed to `OWNER_ID`, whatever number was dialed | `src/services/conversation-service.ts:81-90`; `src/http-app.ts:165-219` | Yes | The called number (`To`) resolves the account (`resolveLine`); a number no account owns hears "not in service" and creates nothing | Old line adopted by the account | app ("a call to a number no account owns"), isolation |
| P2 | Owner SMS replies: any text from `OWNER_PHONE_NUMBER` answered whichever conversation was waiting, deployment-wide | `src/http-app.ts:576-586`; `src/services/conversation-service.ts:166-177,234-243` | Yes | The line texted resolves the account; only that account's verified personal number counts as its owner, and only that account's conversations are candidates | — | isolation ("A's number can't answer B's callers") |
| P3 | SMS fallback surface texted one deployment-wide number | `src/attention/surfaces.ts` (`OwnerSmsSurface`); `src/http-app.ts:357` | Yes | Per account: its verified number, from its own line, only if it opted in (`messages.smsEnabled`) | SMS fallback kept on | isolation (notifications) |
| P4 | Messaging `from` was the single line | `src/bootstrap.ts:139-143`; `src/messaging/twilio-provider.ts` | Yes | `MessagingInput.from` is required; `AccountMessenger` supplies the account's line | — | app, isolation |
| P5 | No provider configuration record | — | — | `provider_configurations` (account, telephony/messaging provider, settings); credentials stay platform secrets | Created | tenancy |
| P6 | No entitlements | — | — | `subscriptions` (plan, status, entitlements: lines, members, accounts per user) checked when claiming lines and adding members | Created | tenancy |
| P7 | Notification routing: `event → owner settings → surfaces` with one owner | `src/http-app.ts:351-370`; `src/attention/router.ts` | Yes | `event → conversation → account → account preferences/channels → delivery`; `NotificationChannelResolver` exposes the account's channels (`GET /account/notifications`) | — | isolation (A receives A's, never B's) |

## 6. Clients

| # | Current behavior | Source | Tenant-specific | Replacement | Migration | Tests |
|---|---|---|---|---|---|---|
| C1 | Web sign-in asked for the access key; also exchanged `?token=` and a stored `ownerToken` | `public/index.html:569,788-816,1000-1008` | Yes | Email/password sign-in and sign-up; boot is `authenticate → /me → memberships → active account → setup state → control plane`; legacy keys are ignored and removed | Owner signs in with email + password | journey |
| C2 | First run assumed the one owner ("Keep your number" with the deployment's line) | `public/index.html:1961-2035` | Yes | Setup checklist (✓/○) and steps driven by `GET /account/onboarding`; an unfinished account never sees an empty control plane | — | journey |
| C3 | Sign-out kept the page (and its state) alive | `public/index.html:1852-1856` | — | Sign-out and account switches reload a clean page; `403 no_membership` sends the user to the account picker | — | journey (same browser, other account: nothing of the first) |
| C4 | iOS Keychain slot named "owner"; APNs registration only on session change | `ios/TextMe/Core.swift:40`; `ios/TextMe/ControlPlaneView.swift` | Naming | Keychain slot "session"; the page posts `accountReady` and the app re-registers its token for the active account | Devices sign in again (old sessions dropped) | isolation (iOS) |
| C5 | Acceptance script signed in with `--key` | `scripts/acceptance.mjs:5,73-74` | Yes | `--email` + `ACCEPTANCE_PASSWORD`; optional `--other-email` proves cross-account isolation on a deployment | — | — |
| C6 | Mac bridge read `ownerId` from its device configuration | `src/owner/bridge-agent.ts:73,346` | Informational | `accountId` from the server; the server never trusts it (the device's own record decides) | Macs keep their device sessions (re-owned) | isolation (jobs) |

## 7. Implicit "there is one …" assumptions

| Assumption | Where it showed | Now |
|---|---|---|
| One user | Access key; `/owner/me` returned the configuration's name | `users` + memberships; `/me` returns the signed-in user |
| One account | `OWNER_ID`; unscoped lists | `accounts`; `account_id` on every owned row; scoped queries |
| One phone number | `TWILIO_PHONE_NUMBER`, cached line, one `from` | One line per account (entitlement), from a shared pool with unique ownership |
| One device | Push tokens not tied to an account; SMS to one number | Devices belong to an account (and user); a token serves one account at a time |
| One notification destination | `OwnerSmsSurface(ownerPhone)` | Channels resolved per account |
| One control plane | `plane_${owner}`, one onboarding flag | One plane record and onboarding state per account; the same deployment serves all |

## 8. Background work (jobs)

| Job | Ownership it carries | Worker check | Tests |
|---|---|---|---|
| Runtime command (`runtime_commands`) → the live call on whichever instance holds it | `account_id`, `conversation_id` | Command-carrying runtime events include `accountId`; the call bridge ignores any for another account; `markCommandAppliedLive(commandId, conversationId)` asserts job and conversation share an account (`assertJobOwnership`) | isolation ("a live call only ever applies commands of its own account") |
| Mac delivery (`owner_message_deliveries`) → claimed by the Mac, reply routed back | `account_id`, `device_id`, `conversation_id` | Queue reads are by the authenticated device; before a reply is applied the delivery, the Mac and the conversation must share an account | isolation (jobs, forged delivery refused) |
| Notification delivery (`notification_deliveries`) | `account_id`, `attention_id` | Surfaces take the attention's account; device lists are scoped and re-checked per device | isolation (notifications) |
| Retries | Command ids and dedupe keys are the retry identity | A retried command keeps its original account (the stored row) and a reused id from another account is refused (`409`) | isolation, scaling |

## 9. Endpoint authorization

Every route below answers: **who is calling**, **which account**, **does the
membership allow it**, **does the resource belong to that account**. `tenant(x)`
= a valid session, a live membership in the session's active account, and role
permission `x` (`src/tenancy/authorization.ts`). Resource checks name the function
that enforces them; a foreign id always answers 404.

| Route(s) | Caller | Account | Permission | Resource check |
|---|---|---|---|---|
| `POST /auth/signup`, `POST /auth/sessions` | Anonymous (rate limited) | Created / the user's membership (`accountId` only if a member) | — | Password verified (constant work for unknown emails) |
| `GET/DELETE /auth/session`, `GET /auth/sessions`, `DELETE /auth/sessions/:id` | Principal | — | Own sessions only | `auth.revoke(userId, id)` finds only the user's sessions |
| `POST /auth/session/account`, `POST /accounts`, `GET/PATCH /me` | Principal | Target must be a membership | — | `resolveContext(user, account)` |
| `GET /account`, `/account/onboarding`, `/account/members`, `/account/notifications`, `/owner/me`, `/owner/control-plane`, `/owner/configuration`, `/owner/configuration/events`, `/owner/devices`, `/owner/push/devices`, `GET /account/phone` | Session | Active | `account.read` | Scoped reads |
| `POST /account/onboarding/identity`, `POST /account/plane` | Session | Active | `account.manage` | — |
| `POST/DELETE /account/members…` | Session | Active | `members.manage` | Last owner can't be removed |
| `GET /account/audit` | Session | Active | `account.manage` | Scoped |
| `POST /account/phone/line`, `/account/phone/personal(/verify)`, `/account/phone/connect` | Session | Active | `phone.manage` | Unique indexes: a line or verified number can't be another account's |
| `PATCH /owner/configuration`, `POST /account/notifications/sms` | Session | Active | `settings.manage` | — |
| `GET /conversations`, `GET /conversations/:id(/runtime\|/runtime/commands\|/audit\|/runtime/events)`, `GET /owner/attention(/:id)`, `POST /owner/attention/:id/opened`, `GET /owner/events` | Session (streams: `?token=`) | Active | `conversation.read` | `requireOwnedConversation`, `attention.get(id, account)`; the owner stream drops events whose conversation isn't the account's |
| `POST /conversations/:id/runtime/*`, `PATCH/DELETE …/runtime(/overrides)`, `POST /conversations/:id/messages`, `/turns`, `/convert-to-text`, `/sms-consent`, `POST /owner/attention/:id/{dismiss,actions}` | Session | Active | `conversation.control` | `requireOwnedConversation` (runtime service and routes); attention actions take the conversation from the stored attention |
| `POST /owner/push/devices`, `GET /owner/push/config`, `POST /owner/push/test` | Session | Active | `device.register` | Device stored under the account and user; token retired elsewhere |
| `DELETE /owner/push/devices/:id` | Session | Active | `device.register` (own) / `device.manage` (others') | Scoped lookup |
| `POST /owner/devices/pair(/qr)`, `GET /owner/devices/pair/:id`, `POST /owner/devices/:id/{test,revoke,primary,messages/chat}` | Session | Active | `device.manage` | `device.accountId === account` in `OwnerDeviceService` |
| `POST /owner/devices/activate`, `/owner/devices/:id/activate` | Mac with a single-use pairing code | The pairing's account | Code | Code consumed atomically; device and pairing must match |
| `/owner/devices/:id/{status,heartbeat,configuration,messages/chats,deliveries…,probe/:probeId,messages/replies}` | Mac (device session) | The device's account | Device credential for **that** device id | Delivery/device/conversation must share an account (`assertJobOwnership`) |
| `POST /webhooks/twilio/voice`, `/sms` | Twilio (signature verified) | Resolved from the called line | — | Unknown line: not answered / 404; SMS owner = that account's verified number |
| `POST /webhooks/fake/voice`, `/webhooks/fake/status` | Local development only (never registered in production) | Resolved from the called line, like Twilio's | — | Same as Twilio's |
| `POST /webhooks/twilio/status`, `/voicemail`, `/voice/continue` | Twilio (signature verified) | From the conversation (by provider call id / id we issued) | — | The conversation's own account |
| `WS /media-stream` | Twilio (signature verified) | From the conversation we put in the TwiML | — | Bridge runs as the conversation's account |
| `GET /health`, `/health/ready`, `/.well-known/…`, `/`, static assets, `/conversations/:id/live` (shell) | Anyone | — | — | No customer data (the shell loads data only after sign-in) |
