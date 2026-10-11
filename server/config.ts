// Server settings and admin access, kept in DATA_DIR/config.json and edited from the first-run setup and #/admin:
// the admin account, the public URL, the listen port, the TONE3000 key and API keys (for desktop apps and scripts).
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DATA_DIR, hashSecret, randomCode, safeEqual, sign } from './store.js';

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SESSION_DAYS = 30;

export interface ApiKeyInfo {
  id: string;
  name: string;
  /** First characters of the key, so people can tell keys apart. */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}
interface ApiKeyRecord extends ApiKeyInfo {
  hash: string;
}

interface Config {
  admin: { username: string; salt: string; hash: string } | null;
  /** Public address people use (invite links, the desktop app setup). Empty = whatever address the browser used. */
  baseUrl: string;
  /** Listen port; null = PORT env or 3001. Takes effect after a restart. */
  port: number | null;
  tone3000ClientId: string;
  /** Only the admin can create rooms (on by default, so a public server can't be filled with rooms by strangers). */
  requireAdminForRooms: boolean;
  apiKeys: ApiKeyRecord[];
}

const env = process.env;

function load(): Config {
  if (fs.existsSync(CONFIG_FILE)) {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>;
    return { admin: null, baseUrl: '', port: null, tone3000ClientId: '', requireAdminForRooms: true, apiKeys: [], ...c };
  }
  // Older installs were configured with environment variables: carry them over so nothing breaks.
  const c: Config = { admin: null, baseUrl: env.PUBLIC_URL ?? '', port: null, tone3000ClientId: env.TONE3000_CLIENT_ID ?? '', requireAdminForRooms: true, apiKeys: [] };
  if (env.ADMIN_PASSWORD) {
    const salt = randomBytes(16).toString('hex');
    c.admin = { username: env.ADMIN_USERNAME || 'admin', salt, hash: hashSecret(env.ADMIN_PASSWORD, salt) };
    console.log(`Admin account "${c.admin.username}" created from ADMIN_PASSWORD; manage it from #/admin from now on.`);
  }
  save(c);
  return c;
}

function save(c: Config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

const config = load();

/** One-time code printed to the server log; first-run setup needs it, so a stranger can't claim a fresh server. */
export const setupCode = config.admin ? '' : randomCode(8);
if (setupCode) {
  console.log('\n  tabShare needs setting up. Open the server in a browser and enter this setup code:\n');
  console.log(`      ${setupCode}\n`);
}

export const needsSetup = () => !config.admin;
export const publicSettings = () => ({ baseUrl: config.baseUrl, tone3000ClientId: config.tone3000ClientId || null, requireAdminForRooms: config.requireAdminForRooms });
export const roomsNeedAdmin = () => config.requireAdminForRooms;
export const listenPort = () => config.port ?? Number(env.PORT ?? 3001);

const cleanUrl = (u: unknown) => (typeof u === 'string' ? u.trim().replace(/\/+$/, '').slice(0, 300) : '');
const validUrl = (u: string) => !u || /^https?:\/\/[^\s/]+/i.test(u);

export function completeSetup(input: { code: string; username: string; password: string; baseUrl: unknown; tone3000ClientId: unknown }) {
  if (!needsSetup()) return 'Already set up';
  if (!safeEqual(input.code.trim().toLowerCase(), setupCode)) return 'Wrong setup code (it is printed in the server log)';
  // Validate everything before saving anything: a half-finished setup would lock the setup page.
  const baseUrl = cleanUrl(input.baseUrl);
  if (!validUrl(baseUrl)) return 'The public URL must start with http:// or https://';
  const err = setAccount(input.username, input.password);
  if (err) return err;
  config.baseUrl = baseUrl;
  config.tone3000ClientId = typeof input.tone3000ClientId === 'string' ? input.tone3000ClientId.trim().slice(0, 200) : '';
  save(config);
  return null;
}

function setAccount(username: string, password: string) {
  const u = username.trim();
  if (!/^[\w.@-]{1,40}$/.test(u)) return 'Username: 1–40 letters, numbers, . _ - @';
  if (password.length < 8) return 'Password must be at least 8 characters';
  const salt = randomBytes(16).toString('hex');
  config.admin = { username: u, salt, hash: hashSecret(password, salt) };
  return null;
}

export function checkAdmin(username: unknown, password: unknown) {
  const a = config.admin;
  if (!a || typeof username !== 'string' || typeof password !== 'string') return false;
  return safeEqual(username.trim().toLowerCase(), a.username.toLowerCase()) && safeEqual(hashSecret(password, a.salt), a.hash);
}

/** Signed session token; bound to the password hash, so changing the password signs everyone out. */
export function issueAdminSession() {
  const a = config.admin!;
  const payload = `${a.username}.${Date.now() + SESSION_DAYS * 86400_000}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(`admin:${payload}:${a.hash}`)}`;
}

export function verifyAdminSession(token: unknown) {
  const a = config.admin;
  if (!a || typeof token !== 'string') return false;
  const [b64, mac] = token.split('.');
  if (!b64 || !mac) return false;
  const payload = Buffer.from(b64, 'base64url').toString();
  const expires = Number(payload.split('.').pop());
  return expires > Date.now() && safeEqual(mac, sign(`admin:${payload}:${a.hash}`));
}

export function changeAccount(currentPassword: string, username: string, newPassword: string) {
  if (!checkAdmin(config.admin?.username, currentPassword)) return 'Current password is wrong';
  const err = setAccount(username || config.admin!.username, newPassword || currentPassword);
  if (err) return err;
  save(config);
  return null;
}

// ---------- API keys ----------

const keyHash = (key: string) => createHash('sha256').update(key).digest('hex'); // keys are random, so a plain hash is enough
const info = ({ hash: _hash, ...k }: ApiKeyRecord): ApiKeyInfo => k;

export const listApiKeys = () => config.apiKeys.map(info);

export function createApiKey(name: string) {
  const key = `tsk_${randomBytes(24).toString('base64url')}`;
  const rec: ApiKeyRecord = { id: randomCode(10), name: name.trim().slice(0, 60) || 'API key', prefix: key.slice(0, 8), createdAt: Date.now(), lastUsedAt: null, hash: keyHash(key) };
  config.apiKeys.push(rec);
  save(config);
  return { key, info: info(rec) };
}

export function revokeApiKey(id: string) {
  const n = config.apiKeys.length;
  config.apiKeys = config.apiKeys.filter((k) => k.id !== id);
  if (config.apiKeys.length === n) return false;
  save(config);
  return true;
}

let lastUsedSave = 0;
export function verifyApiKey(key: unknown) {
  if (typeof key !== 'string' || !key.startsWith('tsk_')) return false;
  const h = keyHash(key);
  const rec = config.apiKeys.find((k) => safeEqual(k.hash, h));
  if (!rec) return false;
  rec.lastUsedAt = Date.now();
  if (Date.now() - lastUsedSave > 60_000) {
    lastUsedSave = Date.now();
    save(config);
  }
  return true;
}

// ---------- settings ----------

export const adminSettings = () => ({
  username: config.admin?.username ?? '',
  baseUrl: config.baseUrl,
  port: config.port,
  listeningOn: listenPort(),
  tone3000ClientId: config.tone3000ClientId,
  requireAdminForRooms: config.requireAdminForRooms,
});

export function updateSettings(s: { baseUrl?: unknown; port?: unknown; tone3000ClientId?: unknown; requireAdminForRooms?: unknown }) {
  if (s.baseUrl !== undefined) {
    const u = cleanUrl(s.baseUrl);
    if (!validUrl(u)) return 'The public URL must start with http:// or https://';
    config.baseUrl = u;
  }
  if (s.port !== undefined) {
    const p = s.port === null || s.port === '' ? null : Number(s.port);
    if (p !== null && !(Number.isInteger(p) && p >= 1 && p <= 65535)) return 'Port must be 1–65535';
    config.port = p;
  }
  if (s.tone3000ClientId !== undefined) config.tone3000ClientId = String(s.tone3000ClientId).trim().slice(0, 200);
  if (s.requireAdminForRooms !== undefined) config.requireAdminForRooms = s.requireAdminForRooms === true;
  save(config);
  return null;
}
