import { Linking, StyleSheet, Text, View } from 'react-native';

const APP_URL = 'https://text-me-five.vercel.app';

/**
 * The mobile shell depends on a native WebView, so its browser target is an
 * instruction page. The actual browser app remains the production control plane.
 */
export default function WebInstructions() {
  return (
    <View style={styles.page}>
      <Text style={styles.title}>Text Me Native</Text>
      <Text style={styles.body}>This Metro page is not the iOS app.</Text>
      <Text style={styles.command}>cd mobile{`\n`}npm run ios</Text>
      <Text style={styles.body}>The app opens on a simulated iPhone in Xcode 27 Device Hub.</Text>
      <Text style={styles.link} onPress={() => void Linking.openURL(APP_URL)}>Open the browser app</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    minHeight: '100vh' as never,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: '#0b0b0d',
  },
  title: { color: '#fff', fontSize: 34, fontWeight: '700', marginBottom: 12 },
  body: { color: '#a1a1a6', fontSize: 18, textAlign: 'center', maxWidth: 560, marginVertical: 8 },
  command: {
    color: '#fff',
    backgroundColor: '#202024',
    fontFamily: 'monospace',
    fontSize: 18,
    lineHeight: 28,
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderRadius: 12,
    marginVertical: 16,
  },
  link: { color: '#1683ff', fontSize: 18, fontWeight: '600', marginTop: 12 },
});
