# Text Me Expo app

This is the Expo replacement for the legacy Swift shell in `../ios`. It hosts the production control plane and provides native secure session storage, APNs registration, notification actions, universal links, and `textme://` deep links.

## Run it

```bash
cd mobile
npm install
npm run ios
```

`npm run ios` is the local Xcode 27-compatible runner. It finds or boots an
iPhone simulator, keeps Metro on port 8081, builds with Xcode, and installs the
app with `simctl`. It then selects that iPhone in Xcode 27 Device Hub so the
native screen is visible. Expo SDK 54's built-in `i` command still looks for the old
`Simulator.app` location, so do not use that command on this Xcode version.

Do not open `http://127.0.0.1:8081` to use the native app. That address belongs
to Metro's development server; the iOS app is the window shown in Device Hub.

Remote push needs a development or release build; do not use Expo Go for push testing. To point a development build at the local server:

```bash
EXPO_PUBLIC_API_BASE_URL=http://localhost:3000 npm run ios
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
