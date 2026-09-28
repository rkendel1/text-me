import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, Platform, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

const SESSION_KEY = 'app.textme.session';
const ATTENTION_CATEGORY = 'OWNER_ATTENTION';
const REPLY_ACTION = 'REPLY';
const TAKE_OVER_ACTION = 'TAKE_OVER';
const configuredBaseUrl = Constants.expoConfig?.extra?.apiBaseUrl;
const BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL || configuredBaseUrl || 'https://text-me-five.vercel.app').replace(/\/+$/, '');
const BASE_ORIGIN = new URL(BASE_URL).origin;

type NativeMessage =
  | { type: 'session'; token?: string | null }
  | { type: 'signedOut' }
  | { type: 'enablePush' }
  | { type: 'accountReady'; accountId?: string };

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

function controlPlaneUrl(input: string): string | null {
  try {
    if (input.startsWith('/')) return new URL(input, BASE_URL).href;
    const url = new URL(input);
    if (url.protocol === 'textme:') {
      const path = [url.hostname, url.pathname].join('/').replace(/^\/+/, '');
      return new URL(`/${path}${url.search}`, BASE_URL).href;
    }
    return url.origin === BASE_ORIGIN ? url.href : null;
  } catch {
    return null;
  }
}

async function api(path: string, token: string, body: Record<string, unknown>) {
  const response = await fetch(new URL(path, BASE_URL), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(result.error || `Request failed (${response.status})`);
  }
}

function AppContent() {
  const webView = useRef<WebView>(null);
  const session = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [sourceUrl, setSourceUrl] = useState(BASE_URL);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const sendToPage = useCallback((event: Record<string, unknown>) => {
    const value = JSON.stringify(event);
    webView.current?.injectJavaScript(`window.attnNativeEvent && window.attnNativeEvent(${value}); true;`);
  }, []);

  const pushState = useCallback(async () => {
    const permission = await Notifications.getPermissionsAsync();
    const state = permission.status === 'denied' ? 'denied' : permission.status === 'granted' ? 'on' : 'off';
    sendToPage({ type: 'pushState', state });
  }, [sendToPage]);

  const registerPush = useCallback(async (askPermission: boolean) => {
    try {
      const permission = askPermission
        ? await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } })
        : await Notifications.getPermissionsAsync();
      if (permission.status !== 'granted') {
        sendToPage({ type: 'pushState', state: permission.status === 'denied' ? 'denied' : 'off' });
        return;
      }
      if (Platform.OS !== 'ios') throw new Error('Android push registration is not connected to the server yet.');
      if (!session.current) throw new Error('Sign in before enabling notifications.');
      const nativeToken = await Notifications.getDevicePushTokenAsync();
      await api('/owner/push/devices', session.current, {
        platform: 'ios',
        apnsToken: String(nativeToken.data),
        label: Device.deviceName || 'iPhone app',
      });
      sendToPage({ type: 'pushState', state: 'on' });
    } catch (error) {
      sendToPage({ type: 'pushState', state: 'off', error: error instanceof Error ? error.message : 'Couldn’t turn on notifications.' });
    }
  }, [sendToPage]);

  const openInPage = useCallback((input: string) => {
    const url = controlPlaneUrl(input);
    if (!url) return;
    if (ready) sendToPage({ type: 'open', url });
    else setSourceUrl(url);
  }, [ready, sendToPage]);

  const handleNotification = useCallback(async (response: Notifications.NotificationResponse | null) => {
    if (!response) return;
    const data = response.notification.request.content.data;
    const url = typeof data.url === 'string' ? data.url : BASE_URL;
    const attentionId = typeof data.attentionId === 'string' ? data.attentionId : null;
    const userText = 'userText' in response && typeof response.userText === 'string' ? response.userText.trim() : '';
    if (response.actionIdentifier === REPLY_ACTION && attentionId && userText && session.current) {
      try {
        await api(`/owner/attention/${encodeURIComponent(attentionId)}/actions`, session.current, {
          action: 'reply', body: userText, commandId: `ios:${attentionId}:reply`,
        });
        return;
      } catch {
        openInPage(`${url}${url.includes('?') ? '&' : '?'}intent=reply`);
        return;
      }
    }
    openInPage(response.actionIdentifier === TAKE_OVER_ACTION
      ? `${url}${url.includes('?') ? '&' : '?'}intent=take_over`
      : url);
  }, [openInPage]);

  useEffect(() => {
    void (async () => {
      try {
        session.current = await SecureStore.getItemAsync(SESSION_KEY);
      } catch {
        // Unsigned simulator builds do not have a Keychain access group. A signed
        // development or release build persists the session normally.
        session.current = null;
      }
      try {
        await Notifications.setNotificationCategoryAsync(ATTENTION_CATEGORY, [
          {
            identifier: REPLY_ACTION,
            buttonTitle: 'Reply',
            textInput: { submitButtonTitle: 'Send', placeholder: 'Your answer' },
          },
          {
            identifier: TAKE_OVER_ACTION,
            buttonTitle: 'Take Over',
            options: { opensAppToForeground: true },
          },
        ]);
      } catch {
        // Notification actions are unavailable in unsigned simulator builds.
      }
      setReady(true);
      const initialUrl = await Linking.getInitialURL();
      if (initialUrl) openInPage(initialUrl);
      await handleNotification(await Notifications.getLastNotificationResponseAsync());
    })();

    const linkSubscription = Linking.addEventListener('url', ({ url }) => openInPage(url));
    const notificationSubscription = Notifications.addNotificationResponseReceivedListener(handleNotification);
    const tokenSubscription = Notifications.addPushTokenListener(() => { void registerPush(false); });
    return () => {
      linkSubscription.remove();
      notificationSubscription.remove();
      tokenSubscription.remove();
    };
  }, [handleNotification, openInPage, registerPush]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!canGoBack) return false;
      webView.current?.goBack();
      return true;
    });
    return () => subscription.remove();
  }, [canGoBack]);

  const bootstrap = useMemo(() => {
    const token = JSON.stringify(session.current);
    const platform = JSON.stringify(Platform.OS);
    return `window.__ATTN_SESSION__=${token};window.__ATTN_PLATFORM__=${platform};true;`;
  }, [ready]);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    let message: NativeMessage;
    try { message = JSON.parse(event.nativeEvent.data) as NativeMessage; } catch { return; }
    if (message.type === 'session') {
      session.current = message.token || null;
      if (message.token) {
        void SecureStore.setItemAsync(SESSION_KEY, message.token, {
          keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        }).catch(() => undefined);
      } else {
        void SecureStore.deleteItemAsync(SESSION_KEY).catch(() => undefined);
      }
      void registerPush(false);
    } else if (message.type === 'signedOut') {
      session.current = null;
      void SecureStore.deleteItemAsync(SESSION_KEY).catch(() => undefined);
    } else if (message.type === 'enablePush') {
      void registerPush(true);
    } else if (message.type === 'accountReady') {
      void registerPush(false);
    }
  }, [registerPush]);

  const onNavigationStateChange = useCallback((navigation: WebViewNavigation) => {
    setCanGoBack(navigation.canGoBack);
  }, []);

  if (!ready) {
    return <View style={styles.loading}><StatusBar style="auto" /><ActivityIndicator size="large" color="#1683ff" /></View>;
  }

  if (loadError) {
    return (
      <SafeAreaView style={styles.offline}>
        <StatusBar style="auto" />
        <Text style={styles.offlineTitle}>You’re offline</Text>
        <Text style={styles.offlineBody}>Your assistant keeps working.</Text>
        <Text style={styles.retry} onPress={() => { setLoadError(false); setSourceUrl(BASE_URL); }}>Try Again</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="auto" />
      <WebView
        ref={webView}
        source={{ uri: sourceUrl }}
        injectedJavaScriptBeforeContentLoaded={bootstrap}
        onMessage={onMessage}
        onNavigationStateChange={onNavigationStateChange}
        onLoadEnd={() => { void pushState(); }}
        onError={() => setLoadError(true)}
        onShouldStartLoadWithRequest={(request) => {
          const internal = request.url === 'about:blank' || controlPlaneUrl(request.url) !== null;
          if (!internal) void Linking.openURL(request.url);
          return internal;
        }}
        allowsBackForwardNavigationGestures
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        style={styles.webView}
      />
    </SafeAreaView>
  );
}

export default function App() {
  return <SafeAreaProvider><AppContent /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  webView: { flex: 1, backgroundColor: '#000' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f2f2f7' },
  offline: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f2f2f7' },
  offlineTitle: { color: '#1d1d1f', fontSize: 20, fontWeight: '700' },
  offlineBody: { color: '#6e6e73', fontSize: 17, marginTop: 6 },
  retry: { color: '#007aff', fontSize: 17, fontWeight: '600', marginTop: 14 },
});
