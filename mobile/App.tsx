// tabShare for iPhone/iPad: the tabShare site in a full-screen WebView, plus the native low-latency rig
// (modules/tabshare-audio) behind window.tabshareNative. First launch asks which server to use.
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import TabshareAudio from './modules/tabshare-audio/src/TabshareAudioModule';
import { bridgeScript, isEngineMessage } from './src/bridge';

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

const AUTH_CALLBACK = 'tabshare://t3k-callback';

/** The URL of an `authOpen` message from the page, if it's a TONE3000 page (the only sign-in the page asks for). */
function authOpenUrl(json: string) {
  try {
    const m = JSON.parse(json);
    return m?.type === 'authOpen' && typeof m.url === 'string' && m.url.startsWith('https://www.tone3000.com/') ? m.url : null;
  } catch {
    return null;
  }
}

/** Normalizes what was typed ("tabs.example.com" -> https://tabs.example.com) and checks it's a tabShare server. */
async function checkServer(input: string) {
  const raw = input.trim().replace(/\/+$/, '');
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const origin = originOf(url);
  if (!origin) throw new Error('That isn’t a web address.');
  const res = await fetch(`${origin}/api/health`).catch(() => null);
  if (!res?.ok) throw new Error(`No tabShare server answered at ${origin}.`);
  return origin;
}

function Connect({ initial, error, onConnected }: { initial: string; error: string; onConnected: (origin: string) => void }) {
  const [value, setValue] = useState(initial);
  const [message, setMessage] = useState(error);
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    setMessage('');
    try {
      onConnected(await checkServer(value));
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <KeyboardAvoidingView behavior="padding" style={styles.connect}>
      <Text style={styles.title}>
        tab<Text style={styles.accent}>Share</Text>
      </Text>
      <Text style={styles.label}>Server address</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={setValue}
        onSubmitEditing={connect}
        placeholder="tabs.example.com"
        placeholderTextColor="#6b6b78"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        autoFocus
      />
      {!!message && <Text style={styles.error}>{message}</Text>}
      <Pressable style={[styles.button, busy && styles.busy]} onPress={connect} disabled={busy || !value.trim()}>
        {busy ? <ActivityIndicator color="#1a0d05" /> : <Text style={styles.buttonText}>Connect</Text>}
      </Pressable>
      <Text style={styles.hint}>Ask whoever runs your tabShare server for its address. You can change it later in Settings → tabShare.</Text>
    </KeyboardAvoidingView>
  );
}

export default function App() {
  const [origin, setOrigin] = useState(() => originOf(TabshareAudio.getServerUrl()));
  const [loadError, setLoadError] = useState('');
  const web = useRef<WebView>(null);

  // Engine -> page: forward each message into the page's bridge.
  useEffect(() => {
    const sub = TabshareAudio.addListener('onMessage', ({ json }) => web.current?.injectJavaScript(`window.__tabshareNativeReceive && window.__tabshareNativeReceive(${json}); true;`));
    return () => sub.remove();
  }, []);

  if (!origin || loadError)
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar style="light" />
        <Connect
          initial={origin.replace(/^https:\/\//, '')}
          error={loadError}
          onConnected={(o) => {
            TabshareAudio.setServerUrl(o);
            setLoadError('');
            setOrigin(o);
          }}
        />
      </SafeAreaView>
    );

  const toPage = (msg: object) => web.current?.injectJavaScript(`window.__tabshareNativeReceive && window.__tabshareNativeReceive(${JSON.stringify(msg)}); true;`);

  const onMessage = (e: WebViewMessageEvent) => {
    // Page -> engine (or app), only from the server's own pages.
    if (originOf(e.nativeEvent.url) !== origin) return;
    const data = e.nativeEvent.data;
    if (isEngineMessage(data)) return TabshareAudio.send(data);
    const auth = authOpenUrl(data);
    // TONE3000 sign-in: WKWebView can't do the popup, so use the system sheet; t3k-callback.html redirects to our scheme.
    if (auth)
      WebBrowser.openAuthSessionAsync(auth, AUTH_CALLBACK)
        .then((r) => toPage({ type: 'authResult', url: r.type === 'success' ? r.url : null }))
        .catch(() => toPage({ type: 'authResult', url: null }));
  };

  return (
    // Edge to edge: the page keeps clear of the status bar itself (viewport-fit=cover + env(safe-area-inset-*)).
    <View style={styles.screen}>
      <StatusBar style="light" />
      <WebView
        ref={web}
        source={{ uri: origin }}
        style={styles.screen}
        contentInsetAdjustmentBehavior="never"
        injectedJavaScriptBeforeContentLoaded={bridgeScript(origin)}
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly
        onMessage={onMessage}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
        allowsBackForwardNavigationGestures={false}
        applicationNameForUserAgent="tabShareMobile/0.1.0"
        // Chat links and other sites open in Safari; the app stays on its server.
        onShouldStartLoadWithRequest={(req) => {
          if (originOf(req.url) === origin) return true;
          // window.open() lands here as a top-frame load (no new windows); never let it replace the room with a blank page.
          if (/^(about|blob|data):/.test(req.url)) return !req.isTopFrame;
          Linking.openURL(req.url);
          return false;
        }}
        onError={(e) => setLoadError(`Couldn’t reach ${origin} (${e.nativeEvent.description}).`)}
        webviewDebuggingEnabled={__DEV__}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0e0e13' },
  connect: { flex: 1, justifyContent: 'center', padding: 28, maxWidth: 520, width: '100%', alignSelf: 'center', gap: 12 },
  title: { color: '#f2f2f5', fontSize: 44, fontWeight: '800', letterSpacing: -1.5, marginBottom: 24 },
  accent: { color: '#f4874b' },
  label: { color: '#a7a7b3', fontSize: 14 },
  input: { borderWidth: 1, borderColor: '#2c2c36', borderRadius: 10, padding: 14, color: '#f2f2f5', fontSize: 17, backgroundColor: '#17171d' },
  error: { color: '#ff7a7a', fontSize: 14 },
  button: { backgroundColor: '#f4874b', borderRadius: 10, padding: 15, alignItems: 'center', marginTop: 6 },
  busy: { opacity: 0.6 },
  buttonText: { color: '#1a0d05', fontSize: 17, fontWeight: '700' },
  hint: { color: '#6b6b78', fontSize: 13, marginTop: 10 },
});
