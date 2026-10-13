// Bridge to the desktop app's native audio engine (desktop/engine.mjs), present only inside the desktop app.

export interface NativeDevice {
  name: string;
  inputs: number;
  outputs: number;
}

export type NativeToEngine =
  | { type: 'devices' }
  | { type: 'start'; device: string; outChannel: number; bufferSize: number }
  | { type: 'stop' }
  | { type: 'params'; params: { channel: number; inGain: number; outGain: number; monitor: boolean; bypass: boolean; voiceChannel?: number } }
  | { type: 'loadModel'; json: string }
  | { type: 'unloadModel' }
  | { type: 'ir'; samples: Float32Array | null }
  | { type: 'vstList' }
  | { type: 'vstLoad'; slot: number; path: string; state?: string }
  | { type: 'vstUnload'; slot: number }
  | { type: 'vstChain'; chain: { slot: number; post: boolean }[] }
  | { type: 'vstEditor'; slot: number }
  | { type: 'vstSaveAll' }
  | { type: 'tap'; on: boolean }
  /** Room audio (desktop 0.4+): join the room's SonoBus group / leave it, send format, per-person mix. */
  | { type: 'netJoin'; user: string; group: string; password: string }
  | { type: 'netLeave' }
  | { type: 'netFormat'; index: number }
  | { type: 'netPeer'; user: string; gain: number; bufferMs: number }
  /** Hear the room with the rig off: open this interface output-only while someone is linked. */
  | { type: 'listen'; on: boolean; device: string; outChannel: number; bufferSize: number }
  /** iOS app: run an OAuth flow in the system sign-in sheet (handled by the app, not the engine). */
  | { type: 'authOpen'; url: string };

/** A VST3 plugin in the rig chain (desktop app only). Saved in localStorage with its state. */
export interface VstEntry {
  slot: number;
  path: string;
  name: string;
  /** After the amp + cab instead of before the amp. */
  post: boolean;
  /** Switched off: stays loaded (settings kept) but the engine skips it. */
  bypass?: boolean;
  state?: string;
}

/** One other desktop app in the room's audio group (user = `ts-<clientId>-<random>`). */
export interface RoomAudioPeer {
  user: string;
  linked: boolean;
  receiving: boolean;
  /** New peers stay muted until their stream is clean. */
  muted: boolean;
  auto: boolean;
  /** What you hear is this late (ms); -1 until measured. */
  latencyMs: number;
  rttMs: number;
  bufferMs: number;
  level: number;
  drops: number;
}

export interface RoomAudioStatus {
  state: 'off' | 'connecting' | 'connected' | 'error';
  error?: string;
  peers: RoomAudioPeer[];
  /** Users whose direct link couldn't be made (they're heard through the call instead). */
  failed: string[];
  listening: boolean;
}

/** Send formats, in the engine's order. */
export const ROOM_AUDIO_FORMATS = ['Opus 96 kbps', 'Opus 128 kbps', 'PCM 16-bit', 'PCM 24-bit'] as const;

/** The room member a room-audio user belongs to. */
export const clientIdOfAudioUser = (user: string) => /^ts-(.+)-[a-z0-9]{4}$/.exec(user)?.[1] ?? null;

export type NativeFromEngine =
  | { type: 'devices'; devices: NativeDevice[] }
  | { type: 'started'; device: string; sampleRate: number; bufferSize: number; latencyMs: number; inputs: number; outputs: number }
  | { type: 'stopped' }
  | { type: 'error'; message: string }
  | { type: 'modelLoaded'; ok: boolean }
  | { type: 'level'; peak: number }
  | { type: 'pcm'; samples: Float32Array }
  /** iOS app: the interface input picked for your voice (iOS uses one input device at a time). */
  | { type: 'voice'; samples: Float32Array }
  | { type: 'vstList'; available: boolean; plugins: { name: string; path: string }[] }
  | { type: 'vstLoaded'; slot: number; name: string; latency: number }
  | { type: 'vstError'; slot: number; message: string }
  | { type: 'vstState'; slot: number; state: string }
  | ({ type: 'netStatus' } & RoomAudioStatus)
  /** Dry input for the tuner (engine 0.2.2+). */
  | { type: 'tap'; samples: Float32Array; sampleRate: number }
  /** iOS app: where the sign-in sheet ended up (the callback URL), or null if canceled. */
  | { type: 'authResult'; url: string | null };

interface NativeBridge {
  platform: string;
  send(msg: NativeToEngine): void;
  onMessage(cb: (msg: NativeFromEngine) => void): () => void;
  /** Desktop 0.2.4+: focus left / came back to the app (all of its windows). */
  onAppFocus?(cb: (focused: boolean) => void): () => void;
  /** Desktop 0.3+: the connect window (server URL, API key, extra headers). */
  openServerSettings?(): void;
  /** Desktop 0.3.2+: Browser mode can embed any site with <webview>. */
  webview?: boolean;
}

export const native = (window as unknown as { tabshareNative?: NativeBridge }).tabshareNative ?? null;

/** The low-latency audio API the desktop engine opens, for UI copy. */
export const NATIVE_DRIVER = native?.platform === 'win32' ? 'ASIO' : 'Core Audio'; // macOS and iOS: Core Audio

/** Desktop installers the web app offers, per OS (served from the server's DATA_DIR/downloads; see /api/config). */
/** Desktop installers are GitHub release assets (the same releases the apps update from). */
export const RELEASES = 'https://github.com/penskyc/tabShare/releases/latest';
export const DESKTOP_DOWNLOADS = {
  win: [{ url: `${RELEASES}/download/tabShare-Windows-x64-Setup.exe`, label: 'get the Windows app (x64)' }],
  mac: [{ url: `${RELEASES}/download/tabShare-Mac.dmg`, label: 'get the Mac app' }], // universal: Apple Silicon + Intel
} as const;
export type DesktopOs = keyof typeof DESKTOP_DOWNLOADS;

/** Same scaling as a Web Audio ConvolverNode with normalize = true, so an IR is as loud in the app as in the browser. */
export function normalizeIr(ir: Float32Array, sampleRate: number) {
  let power = 0;
  for (const v of ir) power += v * v;
  power = Math.sqrt(power / ir.length);
  if (!Number.isFinite(power) || power < 0.000125) power = 0.000125;
  const scale = (1 / power) * 0.00125 * (44100 / sampleRate);
  return ir.map((v) => v * scale);
}
