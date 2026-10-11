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
  | { type: 'params'; params: { channel: number; inGain: number; outGain: number; monitor: boolean; bypass: boolean } }
  | { type: 'loadModel'; json: string }
  | { type: 'unloadModel' }
  | { type: 'ir'; samples: Float32Array | null }
  | { type: 'vstList' }
  | { type: 'vstLoad'; slot: number; path: string; state?: string }
  | { type: 'vstUnload'; slot: number }
  | { type: 'vstChain'; chain: { slot: number; post: boolean }[] }
  | { type: 'vstEditor'; slot: number }
  | { type: 'vstSaveAll' }
  | { type: 'tap'; on: boolean };

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

export type NativeFromEngine =
  | { type: 'devices'; devices: NativeDevice[] }
  | { type: 'started'; device: string; sampleRate: number; bufferSize: number; latencyMs: number; inputs: number; outputs: number }
  | { type: 'stopped' }
  | { type: 'error'; message: string }
  | { type: 'modelLoaded'; ok: boolean }
  | { type: 'level'; peak: number }
  | { type: 'pcm'; samples: Float32Array }
  | { type: 'vstList'; available: boolean; plugins: { name: string; path: string }[] }
  | { type: 'vstLoaded'; slot: number; name: string; latency: number }
  | { type: 'vstError'; slot: number; message: string }
  | { type: 'vstState'; slot: number; state: string }
  /** Dry input for the tuner (engine 0.2.2+). */
  | { type: 'tap'; samples: Float32Array; sampleRate: number };

interface NativeBridge {
  platform: string;
  send(msg: NativeToEngine): void;
  onMessage(cb: (msg: NativeFromEngine) => void): () => void;
  /** Desktop 0.2.4+: focus left / came back to the app (all of its windows). */
  onAppFocus?(cb: (focused: boolean) => void): () => void;
  /** Desktop 0.3+: the connect window (server URL, API key, extra headers). */
  openServerSettings?(): void;
}

export const native = (window as unknown as { tabshareNative?: NativeBridge }).tabshareNative ?? null;

/** The low-latency audio API the desktop engine opens, for UI copy. */
export const NATIVE_DRIVER = native?.platform === 'darwin' ? 'Core Audio' : 'ASIO';

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
