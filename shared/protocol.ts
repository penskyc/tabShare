// Wire protocol shared by the server and the client.

/** Pins a bar (playback occurrence + position within the bar) to a time in the linked video. Same shape as alphaTab's FlatSyncPoint. */
export interface SyncPoint {
  barIndex: number;
  barOccurence: number;
  barPosition: number;
  millisecondOffset: number;
}

export interface TabVideo {
  videoId: string;
  syncPoints: SyncPoint[];
}

export interface TabMeta {
  id: string;
  fileName: string;
  ext: string;
  size: number;
  uploadedBy: string;
  uploadedAt: number;
  title?: string;
  artist?: string;
  /** Original recording on YouTube, used by the "Original" audio source. */
  youtube?: TabVideo;
}

/** Layout-independent position on the score: master bar index + fraction within that bar's bounds. */
export interface ScorePoint {
  bar: number;
  fx: number;
  fy: number;
}

/** A range in MIDI ticks. Used for selections and loops so they survive different track views / widths. */
export interface TickRange {
  startTick: number;
  endTick: number;
}

export interface LoopState extends TickRange {
  setBy: string;
}

export interface TransportState {
  playing: boolean;
  /** Playback position in ms (song time) at server time `at`. */
  timeMs: number;
  speed: number;
  at: number;
  by: string;
}

/** The room's shared browser page (Browser mode): always shared, live-only. */
export interface BrowseState {
  url: string;
  by: string;
  at: number;
}

/** Shared in jam mode: which tracks are shown, muted and soloed (track indexes), plus metronome and count-in. */
export interface MixState {
  tracks: number[];
  muted: number[];
  soloed: number[];
  /** Per-track volume multiplier by track index (0–2, 1 = default); missing entries mean 1. */
  volumes: number[];
  metronome: boolean;
  countIn: boolean;
  /** Audio source: synthesizer or the tab's linked original recording. */
  source: 'synth' | 'original';
  by: string;
}

export interface LinkPreview {
  url: string;
  title: string;
  description?: string;
  image?: string;
  siteName?: string;
}

export interface ChatMessage {
  id: string;
  from: string;
  color: string;
  text: string;
  at: number;
  preview?: LinkPreview;
}

/** Media state of someone in the video call (null presence.call = not in the call). */
export interface CallState {
  mic: boolean;
  cam: boolean;
  screen: boolean;
}

export interface Presence {
  cursor: ScorePoint | null;
  selection: TickRange | null;
  playTick: number | null;
  tracks: number[];
  call: CallState | null;
}

export interface Peer extends Presence {
  clientId: string;
  name: string;
  color: string;
  jam: boolean;
}

export interface RoomSnapshot {
  id: string;
  name: string;
  tabs: TabMeta[];
  currentTabId: string | null;
  loop: LoopState | null;
  transport: TransportState | null;
  mix: MixState | null;
  browse: BrowseState | null;
  chat: ChatMessage[];
}

export type ClientMessage =
  | { type: 'hello'; name: string; color: string }
  | { type: 'presence'; presence: Partial<Presence> & { jam?: boolean } }
  | { type: 'setTab'; tabId: string }
  | { type: 'tabMeta'; tabId: string; title?: string; artist?: string }
  | { type: 'tabVideo'; tabId: string; youtube: TabVideo | null }
  | { type: 'setLoop'; loop: TickRange | null }
  | { type: 'transport'; playing: boolean; timeMs: number; speed: number }
  | ({ type: 'mix' } & Omit<MixState, 'by'>)
  | { type: 'browse'; url: string }
  | { type: 'chat'; text: string }
  /** WebRTC signaling (SDP / ICE), relayed to one peer in the same room. */
  | { type: 'rtc'; to: string; data: unknown }
  | { type: 'ping'; t: number };

export type ServerMessage =
  | { type: 'welcome'; clientId: string; room: RoomSnapshot; peers: Peer[] }
  | { type: 'peerJoined'; peer: Peer }
  | { type: 'peerLeft'; clientId: string }
  | { type: 'presence'; clientId: string; presence: Partial<Presence> & { jam?: boolean } }
  | { type: 'tabs'; tabs: TabMeta[]; currentTabId: string | null }
  | { type: 'currentTab'; tabId: string | null; by: string }
  | { type: 'loop'; loop: LoopState | null }
  | { type: 'transport'; transport: TransportState }
  | { type: 'mix'; mix: MixState }
  | { type: 'browse'; browse: BrowseState | null }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'chatPreview'; id: string; preview: LinkPreview }
  | { type: 'rtc'; from: string; data: unknown }
  | { type: 'pong'; t: number; server: number }
  | { type: 'error'; message: string };

/** A URL the shared browser may open: http(s), no credentials, at most 2048 characters. Null otherwise. */
export function browseUrl(u: unknown): string | null {
  if (typeof u !== 'string' || u.length > 2048) return null;
  try {
    const url = new URL(u);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** First http(s) link in a chat message; trailing punctuation is not part of the link. */
export const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/i;

export const ALLOWED_EXTENSIONS = ['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'xml', 'musicxml', 'mxl', 'tex', 'capx'];
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
