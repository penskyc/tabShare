// TONE3000 "Select" flow (OAuth 2 + PKCE, popup). Docs: https://www.tone3000.com/api, https://github.com/tone-3000/api
import { native } from './native';

const T3K = 'https://www.tone3000.com';
const TOKENS_KEY = 'tabshare.t3k.tokens';

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export interface T3kModel {
  id: number;
  name: string;
  size: string;
  model_url: string;
  architecture_version: number | null;
}

export interface T3kTone {
  id: number;
  title: string;
  gear?: string;
}

const redirectUri = () => `${location.origin}/t3k-callback.html`;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
const sha256 = async (s: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));

function readTokens(): Tokens | null {
  try {
    return JSON.parse(localStorage.getItem(TOKENS_KEY) ?? 'null');
  } catch {
    return null;
  }
}
function saveTokens(t: Tokens | null) {
  try {
    if (t) localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
    else localStorage.removeItem(TOKENS_KEY);
  } catch {
    /* session only */
  }
}

async function tokenRequest(clientId: string, body: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${T3K}/api/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description ?? data.error ?? `TONE3000 sign-in failed (${res.status})`);
  const t = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in ?? 3600) * 1000 };
  saveTokens(t);
  return t;
}

async function accessToken(clientId: string): Promise<string | null> {
  const t = readTokens();
  if (!t) return null;
  if (t.expires_at - 60_000 > Date.now()) return t.access_token;
  try {
    return (await tokenRequest(clientId, { grant_type: 'refresh_token', refresh_token: t.refresh_token })).access_token;
  } catch {
    saveTokens(null);
    return null;
  }
}

async function api<T>(clientId: string, path: string): Promise<T> {
  const token = await accessToken(clientId);
  if (!token) throw new Error('Not connected to TONE3000');
  const res = await fetch(path.startsWith('http') ? path : `${T3K}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) saveTokens(null);
  if (!res.ok) throw new Error(`TONE3000 request failed (${res.status})`);
  return (res.headers.get('content-type') ?? '').includes('json') ? res.json() : (res.text() as Promise<T>);
}

type CallbackParams = Record<string, string | null>;

const inIosApp = () => native?.platform === 'ios';

function viaPopup(url: URL) {
  const popup = window.open(url, 't3k', 'width=1100,height=800');
  if (!popup) throw new Error('Popup blocked: allow popups for this site to browse TONE3000.');
  return new Promise<CallbackParams>((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.data?.type !== 't3k-callback') return;
      cleanup();
      resolve(e.data.params);
    };
    const closedTimer = setInterval(() => {
      if (popup.closed) {
        cleanup();
        reject(new Error('canceled'));
      }
    }, 500);
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      clearInterval(closedTimer);
    };
    window.addEventListener('message', onMessage);
  });
}

/** iOS app: WKWebView has no popups, so the app runs the flow in Apple's sign-in sheet and returns the callback URL. */
function viaApp(url: URL) {
  return new Promise<CallbackParams>((resolve, reject) => {
    const off = native!.onMessage((m) => {
      if (m.type !== 'authResult') return;
      off();
      if (!m.url) return reject(new Error('canceled'));
      const q = new URL(m.url).searchParams;
      resolve(Object.fromEntries(['code', 'state', 'tone_id', 'error'].map((k) => [k, q.get(k)])));
    });
    native!.send({ type: 'authOpen', url: url.href });
  });
}

/**
 * Opens the TONE3000 catalog in a popup (a sign-in sheet in the iOS app); resolves with the picked tone id once the user selects a tone
 * (signing in along the way if needed). Rejects if the popup is blocked, closed or fails.
 */
export async function selectTone(clientId: string): Promise<number> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  // The "app." prefix tells t3k-callback.html to hand the result to the iOS app's sign-in sheet (no opener there).
  const state = (inIosApp() ? 'app.' : '') + b64url(crypto.getRandomValues(new Uint8Array(16)));
  const url = new URL(`${T3K}/api/v1/oauth/authorize`);
  for (const [k, v] of Object.entries({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    code_challenge: await sha256(verifier),
    code_challenge_method: 'S256',
    state,
    prompt: 'select_tone',
    format: 'nam',
    architecture: '2',
    preview: 'true',
    menubar: 'true',
  })) {
    url.searchParams.set(k, v);
  }
  const params = inIosApp() ? await viaApp(url) : await viaPopup(url);

  if (params.state !== state) throw new Error('TONE3000 sign-in failed (state mismatch).');
  if (params.error) throw new Error(`TONE3000: ${params.error}`);
  if (!params.code) throw new Error('canceled');
  await tokenRequest(clientId, { grant_type: 'authorization_code', code: params.code, code_verifier: verifier, redirect_uri: redirectUri() });
  if (!params.tone_id) throw new Error('canceled');
  return Number(params.tone_id);
}

export async function getTone(clientId: string, toneId: number) {
  return api<T3kTone>(clientId, `/api/v1/tones/${toneId}`);
}

/** All NAM models of a tone (A2 first, then legacy A1). Our engine loads both. */
export async function listModels(clientId: string, toneId: number): Promise<T3kModel[]> {
  type Page = { data: T3kModel[] };
  const [a2, legacy] = await Promise.all([
    api<Page>(clientId, `/api/v1/models?tone_id=${toneId}&architecture=2&page_size=100`).catch(() => ({ data: [] })),
    api<Page>(clientId, `/api/v1/models?tone_id=${toneId}&page_size=100`).catch(() => ({ data: [] })),
  ]);
  const seen = new Set<number>();
  // architecture_version is null for non-NAM files (IRs).
  return [...a2.data, ...legacy.data].filter((m) => m.architecture_version != null && !seen.has(m.id) && !!seen.add(m.id));
}

export async function downloadModel(clientId: string, m: T3kModel): Promise<string> {
  return api<string>(clientId, m.model_url);
}

export const isConnected = () => !!readTokens();
export const disconnect = () => saveTokens(null);
