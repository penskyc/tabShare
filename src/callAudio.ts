// Call playback. Everyone sends their voice and their instrument as two separate tracks; each plays through its own
// gain here, so "Mike's voice" and "Mike's bass" have independent volumes. Web Audio instead of media elements because
// iOS ignores HTMLMediaElement.volume. Its own AudioContext, so picking the call's speaker doesn't move the rig monitor.

export type MixPart = 'voice' | 'instrument';
export type MixLevels = Record<MixPart, number>;

const MIX_KEY = 'tabshare.callMix';
export const DEFAULT_LEVELS: MixLevels = { voice: 1, instrument: 1 };
/** Levels are remembered per person's name (lowercased), since clientIds change on every reconnect. */
export const mixKey = (name: string) => name.trim().toLowerCase();

export function loadMix(): Record<string, MixLevels> {
  try {
    return JSON.parse(localStorage.getItem(MIX_KEY) ?? '{}');
  } catch {
    return {};
  }
}
export function saveMix(mix: Record<string, MixLevels>) {
  try {
    localStorage.setItem(MIX_KEY, JSON.stringify(mix));
  } catch {
    /* per-session only */
  }
}

// Chrome only delivers remote WebRTC audio to Web Audio while the track is also attached to a media element.
const needsSink = /Chrome\//.test(navigator.userAgent);

interface Voice {
  track: MediaStreamTrack;
  src: MediaStreamAudioSourceNode;
  gain: GainNode;
  sink: HTMLAudioElement | null;
}

export class CallAudio {
  private ctx = new AudioContext({ latencyHint: 'interactive' });
  private nodes = new Map<string, Voice>();

  /** Call from the click that joins the call (autoplay rules). */
  resume() {
    this.ctx.resume().catch(() => {});
  }

  setSink(deviceId: string) {
    (this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(deviceId).catch(() => {});
  }

  /** Plays `track` as `peerId`'s `part` at `level` (0–2); a new track replaces the old one, null stops it. */
  play(peerId: string, part: MixPart, track: MediaStreamTrack | null, level: number) {
    const key = `${peerId}:${part}`;
    const cur = this.nodes.get(key);
    if (cur && cur.track === track) {
      cur.gain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.02);
      return;
    }
    if (cur) this.stop(key);
    if (!track) return;
    const stream = new MediaStream([track]);
    const src = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    gain.gain.value = level;
    src.connect(gain).connect(this.ctx.destination);
    let sink: HTMLAudioElement | null = null;
    if (needsSink) {
      sink = new Audio();
      sink.muted = true;
      sink.srcObject = stream;
      sink.play().catch(() => {});
    }
    this.nodes.set(key, { track, src, gain, sink });
  }

  /** Stops everyone not in `peerIds`. */
  keepOnly(peerIds: string[]) {
    for (const key of [...this.nodes.keys()]) if (!peerIds.includes(key.slice(0, key.lastIndexOf(':')))) this.stop(key);
  }

  close() {
    for (const key of [...this.nodes.keys()]) this.stop(key);
    this.ctx.close().catch(() => {});
  }

  private stop(key: string) {
    const n = this.nodes.get(key);
    if (!n) return;
    n.src.disconnect();
    n.gain.disconnect();
    if (n.sink) n.sink.srcObject = null;
    this.nodes.delete(key);
  }
}
