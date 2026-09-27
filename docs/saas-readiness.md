# SaaS readiness

Is this a real multi-tenant SaaS? Each answer below says what is true today and
what proves it. Test files: `tenancy` = `test/tenancy.test.ts`, `isolation` =
`test/multi-tenant-isolation.test.ts`, `scaling` =
`test/horizontal-scaling.test.ts`, `migration` = `test/legacy-migration.test.ts`,
`release` = `test/release-contract.test.ts`, `journey` = `npm run journey:saas`
(two browsers against one deployment, through the real UI). The Postgres tests
run with `TEST_DATABASE_URL` set; all of them pass against a real Postgres.

The findings behind this, with sources, are in [`saas-audit.md`](saas-audit.md).

```
                    ┌───────────────────────────┐
                    │  Vercel web  ·  iOS app   │   same page, same API
                    └─────────────┬─────────────┘
                    authenticated principal (session: user + active account)
                                  │
                         membership check, every request
                                  │
             ┌────────────────────┼────────────────────┐
         Account A            Account B            Account N
   user · line · number   user · line · number   …   (account_id on every row)
   devices · plane        devices · plane
   attention · commands   attention · commands
                                  │
             Postgres (all state) · LISTEN/NOTIFY (live fan-out) · Twilio/APNs/Web Push (platform credentials)
```

## Identity

| Question | Answer | Proof |
|---|---|---|
| Can anyone create an account? | **Yes.** `POST /auth/signup` (web and iOS) creates a user, an account and an owner membership; no deployment change | tenancy ("anyone can sign up"), journey |
| Can multiple users exist? | **Yes.** Users are rows with unique emails and scrypt password hashes | tenancy, isolation |
| Can users belong to different accounts? | **Yes.** Memberships join users and accounts (owner, admin, member). A user can own several accounts (`POST /accounts`) and be added to others (`POST /account/members`); a session has an active account and switches with `POST /auth/session/account`. The API never assumes user id = account id | tenancy ("several accounts", "authorization is principal + membership…") |

## Isolation

| Question | Answer | Proof |
|---|---|---|
| Is every resource tenant-scoped? | **Yes.** `account_id` on conversations, runtime commands, attention, notification deliveries, push devices, Mac devices, pairing codes, device sessions, Mac deliveries, configuration (and its revisions and audit), phone numbers, planes, subscriptions, provider configuration, memberships, sessions and audit events. Conversation children (events, runtime state, overrides) are reachable only through their conversation | saas-audit §4, isolation |
| Are all API reads authorized? | **Yes.** Every read runs as `tenant(action)`: session → live membership → role permission, and lists are scoped in the query itself. Another account's id answers 404 | isolation ("reads") |
| Are all writes authorized? | **Yes.** Same gate, plus the resource must belong to the account (`requireOwnedConversation`, device and attention checks). Commands, replies, settings, devices, Macs and attention of another account are refused and leave no trace | isolation ("writes and commands") |
| Does anything rely on frontend filtering? | **No.** The server scopes every response; the page renders what it's given | isolation |
| Fails closed? | **Yes.** No session → 401; no membership (e.g. just removed) → 403 on the next request on any instance; missing ownership on either side → 404; unknown called number → not answered | tenancy, isolation, app |

## Configuration

| Question | Answer | Proof |
|---|---|---|
| Are customer values removed from environment variables? | **Yes.** `OWNER_PHONE_NUMBER`, `OWNER_ID`, `OWNER_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` (and `USER_*`, `ACCOUNT_ID`, `DEVICE_ID`) are read by nothing, and the deployment refuses to start while any is set | release ("customer identity there refuses to start") |
| Are platform secrets separated from customer state? | **Yes.** Platform: Twilio credentials, APNs key, VAPID keys, AI Gateway, database. Customer: names, numbers, settings, devices, channels, provider choices — all in the database, per account. No platform credential is ever returned to a client (`/owner/push/config` returns only the public VAPID key) | release (health never echoes secrets or customer data) |
| Where do assistant lines come from? | The platform's Twilio account is a pool; an account claims one (unique ownership enforced by the database) or, with `TELEPHONY_NUMBER_PURCHASE=on`, buys one | tenancy ("claimed by exactly one account") |

## Scale

| Question | Answer | Proof |
|---|---|---|
| Can multiple API instances serve the same account? | **Yes.** Requests hop between instances (A → B → A → C) and see the same account state; a call's media stream on one instance obeys commands sent to others (Postgres `LISTEN/NOTIFY`) | scaling (in-memory and Postgres) |
| Concurrent commands? | Safe. Runtime writes are compare-and-set on the revision (one of two racing commands wins; the other gets `409 stale_revision`), and a command id is claimed atomically (the same command sent to two instances runs once). Both races were found by the Postgres scaling test and fixed | scaling |
| Can workers restart safely? | **Yes.** A restarted instance recovers sessions, conversations, runtime, commands and attention from the database; the owner can answer through it and the live call on another instance relays it | scaling, vercel-runtime |
| Is there any process-local authoritative state? | **No.** Process-local: open WebSockets for live calls (by nature; control reaches them through the bus), SSE subscriptions, caches of platform secrets, and rate-limit counters (abuse protection only). None is the source of truth | saas-audit §3 |
| Session renewal across instances? | Shared: one instance's renewal is what every other reads | scaling |

## Web

| Question | Answer | Proof |
|---|---|---|
| Can arbitrary customers use the Vercel deployment? | **Yes.** Sign up, set up (name → assistant line and verified number → assistant → notifications) and use the control plane, with no deployment configuration. An unfinished account sees its setup checklist, never an empty control plane | journey, tenancy |
| Several customers at once? | **Yes.** Two browsers, two accounts, simultaneous live streams: each sees only its own | isolation ("sessions and browsers"), journey |
| Refresh, re-entry, deep links? | The session persists (30 days, sliding); boot is authenticate → `/me` → active account → setup state → control plane; deep links open after that, scoped to the account | journey, release |
| Stale state after sign-out/sign-in? | None: sign-out and account switches reload a clean page; the old token is dead on every instance | isolation, journey |

## iOS

| Question | Answer | Proof |
|---|---|---|
| Can arbitrary customers use the same binary? | **Yes.** Nothing about a customer is compiled in (`Config/*.xcconfig` holds the platform domain, bundle id and team). The app hosts the same page and follows the same bootstrap | `ios/README.md` |
| Does signing into a different account change the control plane correctly? | **Yes.** The control plane, and the phone's notifications: registering an APNs token for one account retires it from any other, and the app re-registers when the page reports `accountReady` | isolation ("iOS: one app, one phone") |
| Compiled and run on a device? | **Not yet.** The Swift was changed without a Mac; the server side is tested. The device checklist is `docs/release-audit.md` §9 | — |

## Notifications

| Question | Answer | Proof |
|---|---|---|
| Are notification routes tenant-scoped? | **Yes.** event → conversation → account → that account's preferences and channels (its push devices, its Mac, its verified number from its own line) → delivery records with the account. There is no deployment-wide destination | isolation ("A receives A's events, B receives B's"), app |
| Can one user's event notify another? | No. Tested for Web Push, APNs and SMS, and for a phone that moved between accounts | isolation |

## Migration

| Question | Answer | Proof |
|---|---|---|
| Does the existing account work through the new architecture? | **Yes.** `npm run migrate:legacy` turns the single owner into an ordinary account (deterministic ids, idempotent), re-owns all data, adopts the line and number through the phone-number lifecycle, and evaluates onboarding to `ready`. On a deployment with no customer variables the owner signs in and finds everything; new calls to the old line land in the account; a new customer sees none of it | migration, [`saas-migration.md`](saas-migration.md) |

## Definition of done

| # | Criterion | Status |
|---|---|---|
| 1 | A new person can sign up without changing deployment configuration | ✅ |
| 2 | They can create their own account | ✅ |
| 3 | They can enter their own name/profile | ✅ |
| 4 | They can configure/claim their own phone number | ✅ (line from the pool; mobile verified by code) |
| 5 | They can connect their own device/application/plane | ✅ (plane; push devices; optional Mac) |
| 6 | They receive only their own events and notifications | ✅ |
| 7 | They control only their own resources | ✅ |
| 8 | Their configuration persists independently of environment variables | ✅ |
| 9 | Another customer can do the same simultaneously | ✅ |
| 10 | The same Vercel deployment serves both | ✅ (tested locally with the production composition; not deployed from this environment) |
| 11 | The same iOS binary serves both | ✅ by construction and server tests; not yet run on a device |
| 12 | Multiple backend instances serve requests interchangeably | ✅ |
| 13 | No customer-specific environment variables remain | ✅ (and they refuse startup) |
| 14 | Tenant isolation is enforced server-side | ✅ |
| 15 | The existing account is migrated and passes the same paths as a new customer | ✅ |
| 16 | Automated tests prove cross-tenant isolation | ✅ |

## Known limits

- **Not deployed from here.** This environment can't deploy to Vercel or call
  Twilio/APNs; the production composition is exercised locally against
  Postgres with provider stand-ins. Run `docs/saas-migration.md` and the
  acceptance journey (with `--other-email`) on the real deployment.
- **Email verification and password reset** aren't built: sign-up trusts the
  email address it's given. Phone numbers *are* verified.
- **Invitations** add an existing user by email; there's no invite email yet.
- **Billing** is an entitlements record (`subscriptions`), not a payment
  integration.
- **Rate limits** are per instance.
