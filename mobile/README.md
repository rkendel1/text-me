# Text Me Expo app

This is the Expo replacement for the legacy Swift shell in `../ios`. It hosts the production control plane and provides native secure session storage, APNs registration, notification actions, universal links, and `textme://` deep links.

## Run it

```bash
cd mobile
npm install
npx expo run:ios
```

Remote push needs a development or release build; do not use Expo Go for push testing. To point a development build at the local server:

```bash
EXPO_PUBLIC_API_BASE_URL=http://localhost:3000 npx expo run:ios
```

For EAS builds:

```bash
npx eas-cli build --profile development --platform ios
npx eas-cli build --profile production --platform ios
```

The iOS bundle ID remains `app.textme.owner`. Configure its Apple push credential in EAS, and keep the server's `APNS_BUNDLE_ID` set to the same value.

## Architecture

- The WebView is the same UI and API used by the browser.
- The page passes sessions and push requests through `window.ReactNativeWebView`.
- The Expo app persists the session in SecureStore and registers the raw APNs token with `/owner/push/devices`.
- Notification taps, Reply, and Take Over use the existing deep-link and attention-action APIs.

The Swift project is intentionally retained until the Expo build has completed device acceptance testing.
