import type { TabMeta } from '../shared/protocol';

export interface Session {
  roomId: string;
  roomName: string;
  token: string;
}

const KEY = 'tabshare.sessions';
const PROFILE_KEY = 'tabshare.profile';

function readJSON<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: session only lives in memory */
  }
}

export function getSession(roomId: string): Session | null {
  return readJSON<Record<string, Session>>(KEY, {})[roomId] ?? null;
}

export function saveSession(s: Session) {
  const all = readJSON<Record<string, Session>>(KEY, {});
  all[s.roomId] = s;
  writeJSON(KEY, all);
}

export function clearSession(roomId: string) {
  const all = readJSON<Record<string, Session>>(KEY, {});
  delete all[roomId];
  writeJSON(KEY, all);
}

export function recentSessions(): Session[] {
  return Object.values(readJSON<Record<string, Session>>(KEY, {}));
}

export interface Profile {
  name: string;
  color: string;
}

export const PEER_COLORS = ['#ff5d73', '#ffb347', '#ffe156', '#5ce1a5', '#4dc9ff', '#8c7bff', '#ff7ae0', '#9be15d'];

export function getProfile(): Profile {
  return readJSON<Profile>(PROFILE_KEY, {
    name: '',
    color: PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)],
  });
}

export function saveProfile(p: Profile) {
  writeJSON(PROFILE_KEY, p);
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

type RoomResponse = { roomId: string; name: string; token: string };

// ---------- server config ----------

export interface ServerConfig {
  baseUrl: string;
  tone3000ClientId: string | null;
  requireAdminForRooms: boolean;
  setupNeeded: boolean;
  version: string;
}
let configPromise: Promise<ServerConfig> | null = null;
/** Public server settings (cached; `refresh` after setup or a settings change). */
export const getConfig = (refresh = false) => {
  if (refresh || !configPromise) configPromise = fetch('/api/config').then((r) => json<ServerConfig>(r));
  return configPromise;
};

// ---------- admin sign-in ----------

// The admin session (30 days) is kept in this browser until sign-out or a password change.
const ADMIN_KEY = 'tabshare.adminToken';
export const getAdminToken = () => {
  try {
    return localStorage.getItem(ADMIN_KEY) ?? '';
  } catch {
    return '';
  }
};
export const setAdminToken = (t: string) => {
  try {
    if (t) localStorage.setItem(ADMIN_KEY, t);
    else localStorage.removeItem(ADMIN_KEY);
  } catch {
    /* session only */
  }
};

export async function adminLogin(username: string, password: string) {
  const r = await json<{ token: string }>(
    await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }),
  );
  setAdminToken(r.token);
  return r.token;
}

export async function setupServer(input: { code: string; username: string; password: string; baseUrl: string; tone3000ClientId: string }) {
  const r = await json<{ token: string }>(
    await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  );
  setAdminToken(r.token);
  await getConfig(true);
}

/** Admin request; a 401 means the session ended, so it's dropped. */
async function adminFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAdminToken()}`, ...init.headers },
  });
  if (res.status === 401) setAdminToken('');
  return json<T>(res);
}

export async function createRoom(name: string, password: string): Promise<Session> {
  const r = await adminFetch<RoomResponse>('/api/rooms', { method: 'POST', body: JSON.stringify({ name, password }) });
  return { roomId: r.roomId, roomName: r.name, token: r.token };
}

export interface AdminRoom {
  id: string;
  name: string;
  createdAt: number;
  tabs: number;
  bytes: number;
  online: string[];
}

export const adminListRooms = () => adminFetch<AdminRoom[]>('/api/admin/rooms');
export const adminDeleteRoom = (roomId: string) => adminFetch(`/api/admin/rooms/${roomId}`, { method: 'DELETE' });
export const adminSetRoomPassword = (roomId: string, password: string) =>
  adminFetch(`/api/admin/rooms/${roomId}/password`, { method: 'POST', body: JSON.stringify({ password }) });

export interface AdminSettings {
  username: string;
  baseUrl: string;
  port: number | null;
  listeningOn: number;
  tone3000ClientId: string;
  requireAdminForRooms: boolean;
}
export const adminGetSettings = () => adminFetch<AdminSettings>('/api/admin/settings');
export const adminSaveSettings = (patch: Partial<Omit<AdminSettings, 'username' | 'listeningOn'>>) =>
  adminFetch<AdminSettings & { restartRequired: boolean }>('/api/admin/settings', { method: 'PUT', body: JSON.stringify(patch) });
export const adminRestart = () => adminFetch('/api/admin/restart', { method: 'POST' });
export async function adminChangeAccount(currentPassword: string, username: string, newPassword: string) {
  const r = await adminFetch<{ token: string }>('/api/admin/account', { method: 'PUT', body: JSON.stringify({ currentPassword, username, newPassword }) });
  setAdminToken(r.token);
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}
export const adminListKeys = () => adminFetch<ApiKeyInfo[]>('/api/admin/keys');
export const adminCreateKey = (name: string) => adminFetch<{ key: string; info: ApiKeyInfo }>('/api/admin/keys', { method: 'POST', body: JSON.stringify({ name }) });
export const adminRevokeKey = (id: string) => adminFetch(`/api/admin/keys/${id}`, { method: 'DELETE' });

export async function lookupRoom(roomId: string): Promise<{ roomId: string; name: string }> {
  return json(await fetch(`/api/rooms/${encodeURIComponent(roomId)}`));
}

export async function joinRoom(roomId: string, password: string): Promise<Session> {
  const r = await json<RoomResponse>(
    await fetch(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
  );
  return { roomId: r.roomId, roomName: r.name, token: r.token };
}

export async function uploadTab(s: Session, file: Blob, fileName: string, by: string): Promise<TabMeta> {
  const q = new URLSearchParams({ name: fileName, by });
  return json(
    await fetch(`/api/rooms/${s.roomId}/tabs?${q}`, {
      method: 'POST',
      headers: { 'x-room-token': s.token, 'Content-Type': 'application/octet-stream' },
      body: file,
    }),
  );
}

export interface SongsterrHit {
  songId: number;
  artist: string;
  title: string;
  tracks: number;
}

export async function searchSongsterr(s: Session, q: string): Promise<SongsterrHit[]> {
  return json(await fetch(`/api/rooms/${s.roomId}/songsterr?${new URLSearchParams({ q })}`, { headers: { 'x-room-token': s.token } }));
}

/** The server builds a Guitar Pro file from Songsterr and adds it to the room's library. */
export async function importSongsterr(s: Session, songId: number, by: string): Promise<TabMeta> {
  return json(
    await fetch(`/api/rooms/${s.roomId}/songsterr/${songId}?${new URLSearchParams({ by })}`, { method: 'POST', headers: { 'x-room-token': s.token } }),
  );
}

export async function deleteTab(s: Session, tabId: string) {
  return json(
    await fetch(`/api/rooms/${s.roomId}/tabs/${tabId}`, { method: 'DELETE', headers: { 'x-room-token': s.token } }),
  );
}

export async function downloadTab(s: Session, tabId: string): Promise<ArrayBuffer> {
  const res = await fetch(`/api/rooms/${s.roomId}/tabs/${tabId}`, { headers: { 'x-room-token': s.token } });
  if (!res.ok) throw new Error(`Could not load tab (${res.status})`);
  return res.arrayBuffer();
}
