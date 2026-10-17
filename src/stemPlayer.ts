import { YT_ENDED, YT_PAUSED, YT_PLAYING, type YTPlayer } from './OriginalAudio';

/**
 * Plays a song's stems together behind the YouTube player interface, so Room's external-media handler, clock feed
 * and tap sync drive it unchanged. One <audio> per stem (its playbackRate keeps the pitch, like YouTube's) → a gain
 * per stem → master gain. Gains, not element volume: iOS ignores media element volume. The first stem is the clock;
 * the others are pulled back to it when they drift (buffering, seeks).
 */
export class StemPlayer implements YTPlayer {
  private ctx = new AudioContext();
  private master = this.ctx.createGain();
  private els: HTMLAudioElement[];
  private gains: GainNode[];
  private timer: number;
  private volume = 100;

  constructor(urls: string[], onState: (state: number) => void) {
    this.master.connect(this.ctx.destination);
    this.els = urls.map((url) => {
      const el = new Audio(url);
      el.preload = 'auto';
      el.preservesPitch = true;
      return el;
    });
    this.gains = this.els.map((el) => {
      const g = this.ctx.createGain();
      this.ctx.createMediaElementSource(el).connect(g).connect(this.master);
      return g;
    });
    const clock = this.els[0];
    clock.addEventListener('play', () => onState(YT_PLAYING));
    clock.addEventListener('pause', () => !clock.ended && onState(YT_PAUSED));
    clock.addEventListener('ended', () => onState(YT_ENDED));
    this.timer = window.setInterval(() => this.align(), 250);
  }

  private align() {
    const [clock, ...rest] = this.els;
    if (clock.paused) return;
    for (const el of rest) {
      if (el.ended) continue;
      if (Math.abs(el.currentTime - clock.currentTime) > 0.04) el.currentTime = clock.currentTime;
      if (el.paused) el.play().catch(() => {});
    }
  }

  /** Per-stem gain (same order as the URLs). */
  setGains(gains: number[]) {
    this.gains.forEach((g, i) => g.gain.setTargetAtTime(gains[i] ?? 1, this.ctx.currentTime, 0.02));
  }

  playVideo() {
    void this.ctx.resume();
    const t = this.els[0].currentTime;
    for (const el of this.els) {
      if (Math.abs(el.currentTime - t) > 0.04) el.currentTime = t;
      el.play().catch(() => {});
    }
  }
  pauseVideo() {
    for (const el of this.els) el.pause();
  }
  seekTo(seconds: number) {
    for (const el of this.els) el.currentTime = seconds;
  }
  getCurrentTime() {
    return this.els[0].currentTime;
  }
  getDuration() {
    return this.els[0].duration || 0;
  }
  getPlaybackRate() {
    return this.els[0].playbackRate;
  }
  setPlaybackRate(rate: number) {
    for (const el of this.els) el.playbackRate = rate;
  }
  getVolume() {
    return this.volume;
  }
  setVolume(volume: number) {
    this.volume = volume;
    this.master.gain.value = volume / 100;
  }
  destroy() {
    clearInterval(this.timer);
    for (const el of this.els) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    void this.ctx.close();
  }
}

/** Gain of a stem (index into STEM_NAMES) from the mixer: muted or not soloed while others are → 0, else its volume. */
export const stemGain = (i: number, muted: Set<number>, soloed: Set<number>, volumes: number[]) =>
  muted.has(i) || (soloed.size > 0 && !soloed.has(i)) ? 0 : (volumes[i] ?? 1);
