# Text Me for iOS

The iOS app is the control plane hosted natively. It shows the same page as the
browser at the Vercel deployment and uses the same API, sessions, state and
commands, so there is one control plane with two surfaces, not two apps. The
native code adds only what a web page can't do on iOS:

| Native piece | Why |
|---|---|
| APNs registration (`Notifications.swift`) | Real push, including when the app is terminated |
| Notification tap → exact conversation (`LinkRouter`) | Cold start, background and foreground all land on `/conversations/<id>/live` |
| **Reply** from the lock screen | Sent with `POST /owner/attention/:id/actions` without opening the app |
| **Take Over** action | Opens the conversation and runs the take-over command |
| Session in the Keychain (`SessionStore`) | Lock-screen replies work while the app is closed |
| Universal links and `textme://` | Links to a conversation open the app |

It does **not** need the browser (or anything else) to be open: attention is
created on the server and delivered by APNs.

## One binary, every customer

Nothing about a customer is compiled in. `Config/*.xcconfig` holds only the
platform's domain, bundle id and team. On first launch:

```
authenticate (sign in or create an account on the page)
    ↓
resolve the user, their memberships and the active account   (GET /me)
    ↓
load the account's setup state → finish onboarding if needed
    ↓
load that account's control plane                             (GET /owner/control-plane)
```

User A → Account A → Phone A and User B → Account B → Phone B run the same
build. Signing out, signing in as someone else, or switching accounts reloads
the page for the new account, and the app re-registers the phone's APNs token
for it (`accountReady`); the server retires that token's registration in any
other account, so a phone never gets notifications for an account it's no
longer signed in to.

## Build

Requirements: Xcode 15+, iOS 17 device, an Apple Developer account.

```bash
brew install xcodegen
cd ios
# Edit Config/Release.xcconfig: ATTN_HOST (your Vercel domain), ATTN_BUNDLE_ID, ATTN_TEAM_ID
xcodegen
open TextMe.xcodeproj
```

In the Apple Developer portal, enable **Push Notifications**, **Associated
Domains** and **Time Sensitive Notifications** for the bundle id, and create an
APNs auth key (.p8).

## Server configuration (Vercel environment variables)

| Variable | Value |
|---|---|
| `APNS_KEY_ID` | The .p8 key's Key ID |
| `APNS_TEAM_ID` | Your Team ID (also used for universal links) |
| `APNS_PRIVATE_KEY` | Contents of the .p8 file (newlines may be written as `\n`) |
| `APNS_BUNDLE_ID` | Same as `ATTN_BUNDLE_ID` |
| `APNS_ENVIRONMENT` | `production` (TestFlight/App Store) or `development` (Xcode debug builds) |

`GET /health/ready` reports `optional.nativePush` once these are set, and
`/.well-known/apple-app-site-association` starts serving universal links.

## How the app and page talk

| Direction | Message |
|---|---|
| page → app | `{type: 'session', token}` after sign-in; `{type: 'accountReady', accountId}` once the account is resolved; `{type: 'signedOut'}`; `{type: 'enablePush'}` |
| app → page | `attnNativeEvent({type: 'pushState', state})`; `attnNativeEvent({type: 'open', url})` |
| app → page, before load | `window.__ATTN_SESSION__` (the Keychain session) |

## Status

This code was written without a Mac: it has **not been compiled or run**. The
server side it depends on (account sign-in, sessions, APNs delivery, iOS device
registration and its hand-over between accounts, universal links,
stale-notification handling) is covered by automated tests
(`test/multi-tenant-isolation.test.ts` has the "same phone, different account" case). See
`docs/release-audit.md` for the device acceptance steps that remain.
