import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import express, { type Request, type Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  type ChatMessage,
  type ClientMessage,
  type MixState,
  type Peer,
  type ServerMessage,
  type TabMeta,
  type TransportState,
} from '../shared/protocol.js';
import {
  checkPassword,
  createRoom,
  DATA_DIR,
  deleteRoom,
  getRoom,
  issueToken,
  listRooms,
  randomCode,
  saveSoon,
  setPassword,
  tabFilePath,
  verifyToken,
  type StoredRoom,
} from './store.js';
import { URL_RE, unfurl } from './unfurl.js';
import { downloadSong, searchSongs } from './songsterr/index.js';
import {
  adminSettings,
  changeAccount,
  checkAdmin,
  completeSetup,
  createApiKey,
  issueAdminSession,
  listApiKeys,
  listenPort,
  needsSetup,
  publicSettings,
  revokeApiKey,
  roomsNeedAdmin,
  updateSettings,
  verifyAdminSession,
  verifyApiKey,
} from './config.js';

const PORT = listenPort();
const VERSION: string = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const app = express();
// Behind cloudflared / a LAN proxy, use X-Forwarded-For from private-network hops for rate limiting.
app.set('trust proxy', 'loopback, uniquelocal');
app.use(express.json({ limit: '64kb' }));

// ---------- brute-force guard ----------

const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; since: number }>();

function lockedOut(ip: string) {
  const f = failures.get(ip);
  if (f && Date.now() - f.since > FAIL_WINDOW_MS) failures.delete(ip);
  return (failures.get(ip)?.count ?? 0) >= FAIL_LIMIT;
}

function recordFailure(ip: string) {
  const f = failures.get(ip);
  if (f) f.count++;
  else failures.set(ip, { count: 1, since: Date.now() });
}

/** Admin access: a session from /api/admin/login (Authorization: Bearer …) or an API key (X-Api-Key). */
function requireAdmin(req: Request, res: Response) {
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (verifyAdminSession(bearer) || verifyApiKey(req.header('x-api-key'))) return true;
  res.status(needsSetup() ? 503 : 401).json({ error: needsSetup() ? 'The server is not set up yet' : 'Admin sign-in required' });
  return false;
}

/** The desktop app identifies itself in its user agent and must bring a valid API key (revocable per person). */
const isDesktop = (ua: string | undefined) => !!ua && ua.includes('tabShareDesktop/');

// ---------- live (in-memory) room state ----------

interface Client {
  ws: WebSocket;
  peer: Peer;
}

interface LiveRoom {
  clients: Map<string, Client>;
  transport: TransportState | null;
  mix: MixState | null;
}

const live = new Map<string, LiveRoom>();
function liveRoom(id: string) {
  let r = live.get(id);
  if (!r) {
    r = { clients: new Map(), transport: null, mix: null };
    live.set(id, r);
  }
  return r;
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(roomId: string, msg: ServerMessage, exceptId?: string) {
  const r = live.get(roomId);
  if (!r) return;
  const data = JSON.stringify(msg);
  for (const [id, c] of r.clients) {
    if (id !== exceptId && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }
}

// ---------- REST ----------

function str(v: unknown, max: number) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function authed(req: Request, res: Response): StoredRoom | null {
  const room = getRoom(String(req.params.id));
  const token = req.header('x-room-token') ?? req.query.token;
  if (!verifyToken(room, token)) {
    res.status(401).json({ error: 'Not authorized for this room' });
    return null;
  }
  return room;
}

app.get('/api/health', (_req, res) => void res.json({ ok: true }));
// Private app: keep every page and file out of search engines (robots.txt covers polite crawlers, this the rest).
app.use((_req, res, next) => (res.setHeader('X-Robots-Tag', 'noindex, nofollow'), next()));
app.use((req, res, next) => {
  if (!isDesktop(req.header('user-agent')) || req.path === '/api/health' || verifyApiKey(req.header('x-api-key'))) return next();
  res.status(401).json({ error: 'This server needs an API key from its admin for the desktop app' });
});
// Legacy update feed for desktop apps up to 0.2.x, which update from the server they load (newer ones use GitHub).
const downloadsDir = path.join(DATA_DIR, 'downloads');
app.use('/downloads', express.static(downloadsDir, { cacheControl: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

// Public client config. The TONE3000 publishable key (t3k_pub_…) is safe to expose; it's an OAuth client_id.
app.get('/api/config', (_req, res) => void res.json({ ...publicSettings(), setupNeeded: needsSetup(), version: VERSION }));

// ---------- first-run setup ----------

app.post('/api/setup', (req, res) => {
  const ip = req.ip ?? '?';
  if (lockedOut(ip)) return void res.status(429).json({ error: 'Too many attempts, try again later' });
  const b = req.body ?? {};
  const err = completeSetup({ code: str(b.code, 20), username: str(b.username, 40), password: typeof b.password === 'string' ? b.password : '', baseUrl: b.baseUrl, tone3000ClientId: b.tone3000ClientId });
  if (err) {
    if (err.startsWith('Wrong setup code')) recordFailure(ip);
    return void res.status(400).json({ error: err });
  }
  res.json({ token: issueAdminSession() });
});

// ---------- admin sign-in and settings ----------

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip ?? '?';
  if (lockedOut(ip)) return void res.status(429).json({ error: 'Too many attempts, try again later' });
  if (needsSetup()) return void res.status(503).json({ error: 'The server is not set up yet' });
  if (!checkAdmin(req.body?.username, req.body?.password)) {
    recordFailure(ip);
    return void res.status(401).json({ error: 'Wrong username or password' });
  }
  res.json({ token: issueAdminSession() });
});

app.get('/api/admin/settings', (req, res) => {
  if (requireAdmin(req, res)) res.json(adminSettings());
});

app.put('/api/admin/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const before = adminSettings().port;
  const err = updateSettings(req.body ?? {});
  if (err) return void res.status(400).json({ error: err });
  res.json({ ...adminSettings(), restartRequired: adminSettings().port !== before || adminSettings().listeningOn !== PORT });
});

app.put('/api/admin/account', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body ?? {};
  const err = changeAccount(typeof b.currentPassword === 'string' ? b.currentPassword : '', str(b.username, 40), typeof b.newPassword === 'string' ? b.newPassword : '');
  if (err) return void res.status(400).json({ error: err });
  res.json({ token: issueAdminSession() }); // the old sessions just stopped working
});

// Exits so the container's restart policy brings the server back (on the new port, if it changed).
app.post('/api/admin/restart', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 300);
});

app.get('/api/admin/keys', (req, res) => {
  if (requireAdmin(req, res)) res.json(listApiKeys());
});

app.post('/api/admin/keys', (req, res) => {
  if (requireAdmin(req, res)) res.json(createApiKey(str(req.body?.name, 60)));
});

app.delete('/api/admin/keys/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!revokeApiKey(req.params.id)) return void res.status(404).json({ error: 'No such key' });
  res.json({ ok: true });
});

// The desktop app checks its server URL + key (and any extra headers) here before connecting.
app.get('/api/desktop/hello', (_req, res) => void res.json({ ok: true, name: 'tabShare', version: VERSION, ...publicSettings() }));

app.post('/api/rooms', (req, res) => {
  if (roomsNeedAdmin() && !requireAdmin(req, res)) return;
  const name = str(req.body?.name, 80);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!name) return void res.status(400).json({ error: 'Room name required' });
  if (password.length < 4) return void res.status(400).json({ error: 'Password must be at least 4 characters' });
  const room = createRoom(name, password);
  res.json({ roomId: room.id, name: room.name, token: issueToken(room) });
});

// ---------- admin ----------

/** Disconnects everyone in a room; clients see 4401 and are sent back to the lobby. */
function kickAll(roomId: string, reason: string) {
  for (const c of live.get(roomId)?.clients.values() ?? []) c.ws.close(4401, reason);
}

app.get('/api/admin/rooms', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(
    listRooms().map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      tabs: r.tabs.length,
      bytes: r.tabs.reduce((n, t) => n + t.size, 0),
      online: [...(live.get(r.id)?.clients.values() ?? [])].map((c) => c.peer.name),
    })),
  );
});

app.delete('/api/admin/rooms/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  kickAll(req.params.id, 'room deleted');
  if (!deleteRoom(req.params.id)) return void res.status(404).json({ error: 'Room not found' });
  res.json({ ok: true });
});

app.post('/api/admin/rooms/:id/password', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const room = getRoom(req.params.id);
  if (!room) return void res.status(404).json({ error: 'Room not found' });
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (password.length < 4) return void res.status(400).json({ error: 'Password must be at least 4 characters' });
  setPassword(room, password);
  kickAll(room.id, 'password changed');
  res.json({ ok: true });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = getRoom(req.params.id);
  if (!room) return void res.status(404).json({ error: 'Room not found' });
  res.json({ roomId: room.id, name: room.name });
});

app.post('/api/rooms/:id/join', (req, res) => {
  const room = getRoom(req.params.id);
  if (!room) return void res.status(404).json({ error: 'Room not found' });
  const ip = req.ip ?? '?';
  if (lockedOut(ip)) return void res.status(429).json({ error: 'Too many attempts, try again later' });
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!checkPassword(room, password)) {
    recordFailure(ip);
    return void res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ roomId: room.id, name: room.name, token: issueToken(room) });
});

app.post(
  '/api/rooms/:id/tabs',
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  (req, res) => {
    const room = authed(req, res);
    if (!room) return;
    const fileName = str(req.query.name, 200) || 'untitled.gp';
    const ext = path.extname(fileName).slice(1).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return void res.status(400).json({ error: `Unsupported file type .${ext}` });
    }
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) return void res.status(400).json({ error: 'Empty file' });
    res.json(addTab(room, fileName, ext, body, str(req.query.by, 40)));
  },
);

// Songsterr: room members only, so the server isn't an open proxy.
app.get('/api/rooms/:id/songsterr', async (req, res) => {
  if (!authed(req, res)) return;
  const q = str(req.query.q, 120);
  if (!q) return void res.json([]);
  try {
    res.json(await searchSongs(q));
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

app.post('/api/rooms/:id/songsterr/:songId', async (req, res) => {
  const room = authed(req, res);
  if (!room) return;
  const songId = Number(req.params.songId);
  if (!Number.isInteger(songId) || songId <= 0) return void res.status(400).json({ error: 'Bad song id' });
  try {
    const song = await downloadSong(songId);
    const fileName = `${song.artist} - ${song.title}.gp`.replace(/[\\/:*?"<>|]/g, '').slice(0, 200);
    res.json(addTab(room, fileName, 'gp', song.data, str(req.query.by, 40), { title: song.title, artist: song.artist }));
  } catch (e) {
    res.status(502).json({ error: `Songsterr import failed: ${(e as Error).message}` });
  }
});

/** Stores a tab file in the room's library and tells everyone. */
function addTab(room: StoredRoom, fileName: string, ext: string, body: Buffer, by: string, extra: Partial<TabMeta> = {}): TabMeta {
  const tab: TabMeta = { id: randomCode(10), fileName, ext, size: body.length, uploadedBy: by || 'someone', uploadedAt: Date.now(), ...extra };
  fs.writeFileSync(tabFilePath(room.id, tab), body);
  room.tabs.push(tab);
  if (!room.currentTabId) room.currentTabId = tab.id;
  saveSoon();
  broadcast(room.id, { type: 'tabs', tabs: room.tabs, currentTabId: room.currentTabId });
  return tab;
}

app.get('/api/rooms/:id/tabs/:tabId', (req, res) => {
  const room = authed(req, res);
  if (!room) return;
  const tab = room.tabs.find((t) => t.id === req.params.tabId);
  if (!tab) return void res.status(404).json({ error: 'Tab not found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(tabFilePath(room.id, tab));
});

app.delete('/api/rooms/:id/tabs/:tabId', (req, res) => {
  const room = authed(req, res);
  if (!room) return;
  const idx = room.tabs.findIndex((t) => t.id === req.params.tabId);
  if (idx < 0) return void res.status(404).json({ error: 'Tab not found' });
  const [tab] = room.tabs.splice(idx, 1);
  fs.rmSync(tabFilePath(room.id, tab), { force: true });
  if (room.currentTabId === tab.id) {
    room.currentTabId = room.tabs[0]?.id ?? null;
    room.loop = null;
  }
  saveSoon();
  broadcast(room.id, { type: 'tabs', tabs: room.tabs, currentTabId: room.currentTabId });
  res.json({ ok: true });
});

// Static client in production.
const distDir = path.resolve('dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api|\/ws).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

// ---------- WebSocket ----------

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  if (isDesktop(req.headers['user-agent']) && !verifyApiKey(req.headers['x-api-key'])) return void ws.close(4401, 'API key required');
  const url = new URL(req.url ?? '', 'http://x');
  const room = getRoom(url.searchParams.get('room') ?? '');
  if (!verifyToken(room, url.searchParams.get('token'))) {
    send(ws, { type: 'error', message: 'Not authorized' });
    ws.close(4401, 'unauthorized');
    return;
  }
  const lr = liveRoom(room.id);
  const clientId = randomCode(8);
  let joined = false;

  // Heartbeat so dead connections drop their presence.
  let alive = true;
  ws.on('pong', () => (alive = true));
  const hb = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 20000);

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'ping') return send(ws, { type: 'pong', t: msg.t, server: Date.now() });

    if (msg.type === 'hello') {
      if (joined) return;
      joined = true;
      const peer: Peer = {
        clientId,
        name: str(msg.name, 40) || 'Guest',
        color: /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : '#e85d75',
        jam: false,
        cursor: null,
        selection: null,
        playTick: null,
        tracks: [0],
        call: null,
      };
      lr.clients.set(clientId, { ws, peer });
      send(ws, {
        type: 'welcome',
        clientId,
        room: {
          id: room.id,
          name: room.name,
          tabs: room.tabs,
          currentTabId: room.currentTabId,
          loop: room.loop,
          transport: lr.transport,
          mix: lr.mix,
          chat: room.chat.slice(-100),
        },
        peers: [...lr.clients.values()].filter((c) => c.peer.clientId !== clientId).map((c) => c.peer),
      });
      broadcast(room.id, { type: 'peerJoined', peer }, clientId);
      return;
    }

    const me = lr.clients.get(clientId);
    if (!me) return;

    switch (msg.type) {
      case 'presence': {
        Object.assign(me.peer, msg.presence);
        broadcast(room.id, { type: 'presence', clientId, presence: msg.presence }, clientId);
        break;
      }
      case 'setTab': {
        if (!room.tabs.some((t) => t.id === msg.tabId) || room.currentTabId === msg.tabId) break;
        room.currentTabId = msg.tabId;
        room.loop = null;
        lr.transport = null;
        lr.mix = null;
        saveSoon();
        broadcast(room.id, { type: 'currentTab', tabId: msg.tabId, by: me.peer.name });
        break;
      }
      case 'tabMeta': {
        const tab = room.tabs.find((t) => t.id === msg.tabId);
        if (!tab || (tab.title && tab.title === msg.title)) break;
        tab.title = str(msg.title, 120) || undefined;
        tab.artist = str(msg.artist, 120) || undefined;
        saveSoon();
        broadcast(room.id, { type: 'tabs', tabs: room.tabs, currentTabId: room.currentTabId });
        break;
      }
      case 'tabVideo': {
        const tab = room.tabs.find((t) => t.id === msg.tabId);
        if (!tab) break;
        const y = msg.youtube;
        if (!y) delete tab.youtube;
        else {
          if (typeof y.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(y.videoId)) break;
          const num = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
          const points = (Array.isArray(y.syncPoints) ? y.syncPoints : [])
            .filter((p) => p && num(p.barIndex, 0, 100000) && num(p.barOccurence, 0, 1000) && num(p.barPosition, 0, 1) && num(p.millisecondOffset, 0, 24 * 3600 * 1000))
            .slice(0, 5000)
            .map((p) => ({ barIndex: Math.floor(p.barIndex), barOccurence: Math.floor(p.barOccurence), barPosition: p.barPosition, millisecondOffset: p.millisecondOffset }));
          tab.youtube = { videoId: y.videoId, syncPoints: points };
        }
        saveSoon();
        broadcast(room.id, { type: 'tabs', tabs: room.tabs, currentTabId: room.currentTabId });
        break;
      }
      case 'setLoop': {
        const l = msg.loop;
        room.loop =
          l && Number.isFinite(l.startTick) && Number.isFinite(l.endTick) && l.endTick > l.startTick
            ? { startTick: l.startTick, endTick: l.endTick, setBy: me.peer.name }
            : null;
        saveSoon();
        broadcast(room.id, { type: 'loop', loop: room.loop });
        break;
      }
      case 'transport': {
        lr.transport = {
          playing: !!msg.playing,
          timeMs: Math.max(0, Number(msg.timeMs) || 0),
          speed: Math.min(2, Math.max(0.1, Number(msg.speed) || 1)),
          at: Date.now(),
          by: me.peer.name,
        };
        broadcast(room.id, { type: 'transport', transport: lr.transport }, clientId);
        break;
      }
      case 'mix': {
        const ints = (v: unknown) =>
          Array.isArray(v) ? [...new Set(v.filter((n) => Number.isInteger(n) && n >= 0 && n < 256))].slice(0, 64) : [];
        lr.mix = {
          tracks: ints(msg.tracks),
          muted: ints(msg.muted),
          soloed: ints(msg.soloed),
          volumes: Array.isArray(msg.volumes)
            ? msg.volumes.slice(0, 64).map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(2, Math.max(0, v)) : 1))
            : [],
          metronome: msg.metronome === true,
          countIn: msg.countIn === true,
          source: msg.source === 'original' ? 'original' : 'synth',
          by: me.peer.name,
        };
        broadcast(room.id, { type: 'mix', mix: lr.mix }, clientId);
        break;
      }
      case 'rtc': {
        const target = lr.clients.get(String(msg.to));
        if (target) send(target.ws, { type: 'rtc', from: clientId, data: msg.data });
        break;
      }
      case 'chat': {
        const text = str(msg.text, 500);
        if (!text) break;
        const message: ChatMessage = { id: randomCode(10), from: me.peer.name, color: me.peer.color, text, at: Date.now() };
        room.chat.push(message);
        if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
        saveSoon();
        broadcast(room.id, { type: 'chat', message });
        const link = text.match(URL_RE)?.[0];
        if (link) {
          unfurl(link).then((preview) => {
            if (!preview || !room.chat.includes(message)) return;
            message.preview = preview;
            saveSoon();
            broadcast(room.id, { type: 'chatPreview', id: message.id, preview });
          });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    clearInterval(hb);
    if (lr.clients.delete(clientId)) broadcast(room.id, { type: 'peerLeft', clientId });
    if (lr.clients.size === 0) live.delete(room.id);
  });
});

server.listen(PORT, () => console.log(`tabShare server on http://localhost:${PORT}`));
