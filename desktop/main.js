// tabShare desktop: a tabShare server's web app in a window, plus a native ASIO / Core Audio amp engine (engine.mjs) in a
// utility process. Which server, its API key and any extra headers (e.g. Cloudflare Access) come from the connect window.
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, MessageChannelMain, net, safeStorage, screen, session, shell, systemPreferences, utilityProcess } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import updater from 'electron-updater';

const here = path.dirname(fileURLToPath(import.meta.url));

/** { url, apiKey, headers: [{ name, value }] } of the server this app connects to (null until set up). */
let server = null;
let APP_URL = '';
let APP_ORIGIN = '';
// Popups the app opens itself (TONE3000 sign-in) must keep window.opener for the OAuth relay.
const popupOrigins = () => [APP_ORIGIN, 'https://www.tone3000.com', 'https://tone3000.com'];
// Browser mode's embedded pages: their own cookie jar (never the app's session, so the server API key isn't sent)
// and no camera/mic/screen. The page asks for it with <webview>; will-attach-webview forces these settings.
const BROWSER_PARTITION = 'persist:tabshare-browser';
const isWeb = (url) => /^https?:///i.test(url);
const serverFile = () => path.join(app.getPath('userData'), 'server.json');

/** Saved with the OS keychain (safeStorage) when available: the key and headers like CF-Access-Client-Secret are secrets. */
function loadServer() {
  if (process.env.TABSHARE_URL) return { url: process.env.TABSHARE_URL, apiKey: process.env.TABSHARE_API_KEY ?? '', headers: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(serverFile(), 'utf8'));
    return raw.enc ? JSON.parse(safeStorage.decryptString(Buffer.from(raw.enc, 'base64'))) : raw.plain;
  } catch {
    return null;
  }
}
function saveServer(s) {
  const json = JSON.stringify(s);
  const data = safeStorage.isEncryptionAvailable() ? { enc: safeStorage.encryptString(json).toString('base64') } : { plain: s };
  fs.mkdirSync(path.dirname(serverFile()), { recursive: true });
  fs.writeFileSync(serverFile(), JSON.stringify(data));
}
function useServer(s) {
  server = s;
  APP_URL = s.url;
  APP_ORIGIN = new URL(s.url).origin;
}
/** The key and extra headers go only to the server itself (pages, API and the WebSocket), never to other sites. */
const authHeaders = (s) => ({ ...(s.apiKey ? { 'X-Api-Key': s.apiKey } : {}), ...Object.fromEntries(s.headers.filter((h) => h.name).map((h) => [h.name, h.value])) });
const isServerUrl = (url) => {
  const o = originOf(url);
  return !!APP_ORIGIN && (o === APP_ORIGIN || o === APP_ORIGIN.replace(/^http/, 'ws'));
};

/** Checks a server URL + key + headers against /api/desktop/hello. */
async function testServer(s) {
  let url;
  try {
    url = new URL(s.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    return { ok: false, error: 'Enter the server address, like https://tabs.example.com' };
  }
  try {
    const res = await net.fetch(`${url.origin}/api/desktop/hello`, { headers: { ...authHeaders(s), 'User-Agent': app.userAgentFallback }, signal: AbortSignal.timeout(8000) });
    if (res.status === 401) return { ok: false, error: 'The server refused the API key. Ask its admin for a key (Admin → API keys).' };
    if (res.status === 403) return { ok: false, error: 'Access denied before reaching tabShare (check the extra headers, e.g. Cloudflare Access).' };
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.name !== 'tabShare') return { ok: false, error: `That address doesn't look like a tabShare server (HTTP ${res.status}).` };
    return { ok: true, version: body.version };
  } catch (e) {
    return { ok: false, error: `Couldn't reach the server: ${e.message}` };
  }
}

let connectWindow = null;
let connectError = '';
/** The connect window: first run, "Server…" in the menu, or when the server stops accepting the key. */
function openConnect(error = '') {
  connectError = error;
  if (connectWindow) return connectWindow.focus();
  connectWindow = new BrowserWindow({
    width: 560,
    height: 600,
    title: 'Connect to a tabShare server',
    autoHideMenuBar: true,
    backgroundColor: '#0e0e13',
    parent: mainWindow ?? undefined,
    modal: !!mainWindow,
    webPreferences: { preload: path.join(here, 'connect-preload.cjs'), contextIsolation: true, sandbox: true },
  });
  connectWindow.loadFile(path.join(here, 'connect.html'));
  connectWindow.on('closed', () => {
    connectWindow = null;
    if (!mainWindow && !server) app.quit(); // closed on first run without connecting
  });
}

ipcMain.handle('connect-load', () => ({
  server: server && { url: server.url, hasKey: !!server.apiKey, headers: server.headers },
  canCancel: !!mainWindow,
  error: connectError,
}));
ipcMain.handle('connect-test', (_e, s) => testServer({ ...s, apiKey: s.keepKey ? server?.apiKey ?? '' : s.apiKey }));
ipcMain.handle('connect-save', async (_e, input) => {
  const s = { url: new URL(input.url).origin, apiKey: input.keepKey ? server?.apiKey ?? '' : input.apiKey, headers: input.headers };
  const r = await testServer(s);
  if (!r.ok) return r;
  saveServer(s);
  useServer(s);
  if (mainWindow) mainWindow.loadURL(APP_URL);
  else createWindow();
  connectWindow?.close();
  return r;
});
ipcMain.on('open-connect', () => openConnect());

// Tests run the app against a throwaway profile instead of the real one.
if (process.env.TABSHARE_USER_DATA) app.setPath('userData', process.env.TABSHARE_USER_DATA);
// The server recognizes the desktop app by this and requires its API key.
app.userAgentFallback = `${app.userAgentFallback} tabShareDesktop/${app.getVersion()}`;
// No "click to enable sound" banner: a desktop app may play jam audio straight away.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let engine = null;
let mainWindow = null;
let quitting = false;
const startEngine = () => {
  engine = utilityProcess.fork(path.join(here, 'engine.mjs'), [], { serviceName: 'tabShare audio engine', stdio: 'pipe' });
  engine.stdout.on('data', (d) => process.stdout.write(`[engine] ${d}`));
  engine.stderr.on('data', (d) => process.stderr.write(`[engine] ${d}`));
  engine.on('exit', (code) => {
    console.error(`[engine] exited (${code})`);
    engine = null;
    // A plugin can take the engine down with it: bring up a fresh one so the page can turn the rig back on.
    if (!quitting && mainWindow && !mainWindow.isDestroyed()) connectEngine(mainWindow);
  });
};

/** Gives the page a fresh MessagePort to the engine (on every load, so reloads get a clean engine state). */
const connectEngine = (win) => {
  if (!engine) startEngine();
  const { port1, port2 } = new MessageChannelMain();
  engine.postMessage({ type: 'port' }, [port1]);
  win.webContents.postMessage('engine-port', null, [port2]);
};

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

/**
 * Windows the page opens itself (window.open('', name)) for the call: a pop-out stage, and a small always-on-top
 * picture-in-picture box in the bottom-right corner while tabShare isn't focused. The page renders into them.
 */
const CALL_WINDOWS = {
  'tabshare-call': () => ({ width: 1100, height: 680, title: 'tabShare call', autoHideMenuBar: true, backgroundColor: '#0e0e13' }),
  'tabshare-pip': () => {
    const { workArea } = screen.getDisplayMatching(mainWindow.getBounds());
    const width = 360;
    const height = 203;
    return {
      x: workArea.x + workArea.width - width - 16,
      y: workArea.y + workArea.height - height - 16,
      width,
      height,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      minimizable: false,
      maximizable: false,
      show: false, // shown without taking focus, see did-create-window
      backgroundColor: '#000000',
      title: 'tabShare',
    };
  },
};

/** "Screen 2 · 1920×1080 · main" so it's clear which monitor is which (windows keep their title). */
function screenLabel(src) {
  if (!src.id.startsWith('screen:')) return src.name;
  const d = screen.getAllDisplays().find((x) => String(x.id) === src.display_id);
  if (!d) return src.name;
  const main = d.id === screen.getPrimaryDisplay().id ? ' · main' : '';
  return `${src.name} · ${d.size.width * d.scaleFactor}×${d.size.height * d.scaleFactor}${main}`;
}

/** Screen-share picker: thumbnails of every screen and window (except tabShare's own); resolves the chosen source. */
async function pickSource() {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 400, height: 225 } });
  const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
  const list = sources
    .filter((src) => !own.has(src.id))
    .map((src) => ({ id: src.id, name: screenLabel(src), screen: src.id.startsWith('screen:'), thumb: src.thumbnail.toDataURL() }));
  const picker = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    width: 820,
    height: 600,
    title: 'Share your screen',
    autoHideMenuBar: true,
    backgroundColor: '#0e0e13',
    webPreferences: { preload: path.join(here, 'picker-preload.cjs'), contextIsolation: true, sandbox: true },
  });
  picker.webContents.once('did-finish-load', () => picker.webContents.send('sources', list));
  picker.loadFile(path.join(here, 'picker.html'));
  return new Promise((resolve) => {
    const done = (id) => {
      ipcMain.removeListener('picker-choice', onChoice);
      if (!picker.isDestroyed()) picker.close();
      resolve(sources.find((src) => src.id === id) ?? null);
    };
    const onChoice = (e, id) => e.sender === picker.webContents && done(id);
    ipcMain.on('picker-choice', onChoice);
    picker.on('closed', () => done(null));
  });
}

function createWindow() {
  const win = (mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'tabShare',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, webviewTag: true },
  }));
  // The page is remote content, so it doesn't get to choose how an embedded page runs: no preload, no Node, sandboxed,
  // in the browser partition, http(s) only.
  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    if (!isWeb(params.src) && params.src !== 'about:blank') return e.preventDefault();
    delete prefs.preload;
    Object.assign(prefs, { nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true });
    params.partition = BROWSER_PARTITION;
  });
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === 'about:blank' && CALL_WINDOWS[frameName]) return { action: 'allow', overrideBrowserWindowOptions: CALL_WINDOWS[frameName]() };
    if (popupOrigins().includes(originOf(url))) return { action: 'allow' };
    shell.openExternal(url); // chat links etc. open in the real browser
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (originOf(url) === APP_ORIGIN) return;
    e.preventDefault();
    shell.openExternal(url);
  });
  win.webContents.on('did-create-window', (child, { frameName }) => {
    if (frameName !== 'tabshare-pip') return;
    child.setAlwaysOnTop(true, 'floating');
    // skipTransformProcessType: otherwise macOS briefly hides tabShare's windows and Dock icon every time PiP opens.
    child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    child.showInactive(); // never steal focus from whatever the user switched to
  });
  // Tell the page when focus leaves tabShare entirely (not just moves to its pop-out or the screen picker), for the
  // call's picture-in-picture. Main-process focus is the OS's; the page's own blur also fires for iframes.
  win.on('blur', () =>
    setTimeout(() => {
      if (!win.isDestroyed() && !BrowserWindow.getFocusedWindow()) win.webContents.send('app-focus', false);
    }, 100),
  );
  win.on('focus', () => win.webContents.send('app-focus', true));
  win.webContents.on('did-finish-load', () => connectEngine(win));
  // The admin revoked the key (or it's wrong): ask for a new one instead of showing a bare error page.
  win.webContents.on('did-navigate', (_e, url, code) => {
    if (code === 401 && isServerUrl(url)) openConnect('The server no longer accepts this API key. Ask its admin for a new one.');
  });
  win.on('closed', () => (mainWindow = null));
  win.loadURL(APP_URL);
}

app.whenReady().then(async () => {
  // macOS: the engine (a child process) reads the interface's inputs under the app's microphone permission, which
  // only the main process can ask for. Without it Core Audio delivers silence.
  if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone');
  // Camera/mic/screen and friends only for the app itself.
  session.defaultSession.setPermissionRequestHandler((wc, _perm, cb) => cb(originOf(wc.getURL()) === APP_ORIGIN));
  // Electron passes the origin with a trailing slash ("https://host/"), so normalize it: a failed check makes
  // enumerateDevices hide every device (one unlabeled "default" per kind), even after mic access was granted.
  session.defaultSession.setPermissionCheckHandler((_wc, _perm, origin) => originOf(origin) === APP_ORIGIN);
  // Screen share: our own picker (Chromium's isn't available in Electron). Cancelling denies the request.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const source = await pickSource().catch(() => null);
    cb(source ? { video: source } : {});
  });
  ipcMain.on('app-origin', (e) => (e.returnValue = APP_ORIGIN));
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  browserSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'fullscreen' || perm === 'clipboard-sanitized-write'));
  browserSession.setPermissionCheckHandler((_wc, perm) => perm === 'fullscreen' || perm === 'clipboard-sanitized-write');
  // Inside an embedded page: links that open new windows load in place; non-web links (mailto:) go to the OS.
  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() !== 'webview') return;
    wc.setWindowOpenHandler(({ url }) => {
      if (isWeb(url)) wc.loadURL(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (ev, url) => {
      if (isWeb(url)) return;
      ev.preventDefault();
      if (/^(mailto|tel):/i.test(url)) shell.openExternal(url);
    });
  });
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    if (server && isServerUrl(details.url)) Object.assign(details.requestHeaders, authHeaders(server));
    cb({ requestHeaders: details.requestHeaders });
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      {
        label: 'tabShare',
        submenu: [
          { label: 'Server…', accelerator: 'CmdOrCtrl+,', click: () => openConnect() },
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
  startEngine();
  const saved = loadServer();
  if (saved) {
    useServer(saved);
    createWindow();
  } else openConnect();
  if (app.isPackaged) checkForUpdates();
});

/**
 * Updates come from the project's GitHub releases (the `publish` config baked in at build time), whatever server the
 * app connects to. They download in the background; the user picks when to restart (never mid-jam), else on quit.
 */
function checkForUpdates() {
  const { autoUpdater } = updater;
  autoUpdater.on('error', (e) => console.error('[update]', e.message));
  autoUpdater.once('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `tabShare ${info.version} is ready`,
      detail: 'Restart to finish updating. If you choose Later, it installs the next time you quit.',
    });
    if (response === 0) {
      quitting = true;
      autoUpdater.quitAndInstall();
    }
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {}); // offline etc.: the 'error' handler logs it
  check();
  setInterval(check, 60 * 60 * 1000);
}

app.on('window-all-closed', () => {
  quitting = true;
  engine?.kill();
  app.quit();
});
