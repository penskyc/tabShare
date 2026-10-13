import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { ChatMessage, LoopState, SavedDrumSong, TabMeta } from '../shared/protocol.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret');
const FILES_DIR = path.join(DATA_DIR, 'files');

export interface StoredRoom {
  id: string;
  name: string;
  salt: string;
  hash: string;
  createdAt: number;
  tabs: TabMeta[];
  currentTabId: string | null;
  loop: LoopState | null;
  chat: ChatMessage[];
  /** Drums mode songs saved to the room (≤ 50). */
  drumSongs?: SavedDrumSong[];
}

fs.mkdirSync(FILES_DIR, { recursive: true });

const secret: Buffer = (() => {
  if (process.env.SESSION_SECRET) return Buffer.from(process.env.SESSION_SECRET);
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE);
  const s = randomBytes(32);
  fs.writeFileSync(SECRET_FILE, s);
  return s;
})();

const rooms: Map<string, StoredRoom> = new Map(
  fs.existsSync(ROOMS_FILE)
    ? Object.entries(JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')) as Record<string, StoredRoom>)
    : [],
);

let saveTimer: NodeJS.Timeout | null = null;
export function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = ROOMS_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(rooms), null, 2));
      fs.renameSync(tmp, ROOMS_FILE);
    } catch (e) {
      // e.g. Windows EPERM while another process holds rooms.json; state is still in memory, so retry.
      console.error('Saving rooms failed, retrying:', (e as Error).message);
      setTimeout(saveSoon, 1000);
    }
  }, 250);
}

// Unambiguous alphabet for room codes people read aloud / type.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function randomCode(len: number) {
  const bytes = randomBytes(len);
  let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}

function hashPassword(password: string, salt: string) {
  return scryptSync(password, salt, 32).toString('hex');
}

export function createRoom(name: string, password: string): StoredRoom {
  let id = randomCode(6);
  while (rooms.has(id)) id = randomCode(6);
  const salt = randomBytes(16).toString('hex');
  const room: StoredRoom = {
    id,
    name,
    salt,
    hash: hashPassword(password, salt),
    createdAt: Date.now(),
    tabs: [],
    currentTabId: null,
    loop: null,
    chat: [],
  };
  rooms.set(id, room);
  fs.mkdirSync(path.join(FILES_DIR, id), { recursive: true });
  saveSoon();
  return room;
}

export function getRoom(id: string) {
  return rooms.get(id);
}

export function listRooms() {
  return [...rooms.values()];
}

export function deleteRoom(id: string) {
  if (!rooms.delete(id)) return false;
  fs.rmSync(path.join(FILES_DIR, id), { recursive: true, force: true });
  saveSoon();
  return true;
}

export function setPassword(room: StoredRoom, password: string) {
  room.salt = randomBytes(16).toString('hex');
  room.hash = hashPassword(password, room.salt);
  saveSoon();
}

export function checkPassword(room: StoredRoom, password: string) {
  const a = Buffer.from(hashPassword(password, room.salt), 'hex');
  const b = Buffer.from(room.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** HMAC with the server secret (room tokens, admin sessions). */
export const sign = (data: string) => createHmac('sha256', secret).update(data).digest('base64url');

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const hashSecret = hashPassword;

/** Room tokens are bound to the password hash, so changing a room password invalidates them. */
export function issueToken(room: StoredRoom) {
  return createHmac('sha256', secret).update(`${room.id}:${room.hash}`).digest('base64url');
}

export function verifyToken(room: StoredRoom | undefined, token: unknown): room is StoredRoom {
  if (!room || typeof token !== 'string') return false;
  const expected = Buffer.from(issueToken(room));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function tabFilePath(roomId: string, tab: TabMeta) {
  return path.join(FILES_DIR, roomId, `${tab.id}.${tab.ext}`);
}
