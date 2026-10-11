// AudioWorklet that plays PCM blocks posted from the desktop engine, so the native rig can be mixed into the call.
// Keeps a small jitter buffer: waits for ~1024 samples before starting, drops the oldest audio if it falls behind.

declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const SIZE = 16384;
const MASK = SIZE - 1;
const START = 1024;
const MAX = 4096;

class PcmFeed extends AudioWorkletProcessor {
  private buf = new Float32Array(SIZE);
  private r = 0;
  private w = 0;
  private playing = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Float32Array>) => {
      for (const v of e.data) this.buf[this.w++ & MASK] = v;
      if (this.w - this.r > MAX) this.r = this.w - START;
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0][0];
    const avail = this.w - this.r;
    if (avail < (this.playing ? out.length : START)) {
      this.playing = false;
      out.fill(0);
      return true;
    }
    this.playing = true;
    for (let i = 0; i < out.length; i++) out[i] = this.buf[this.r++ & MASK];
    return true;
  }
}

registerProcessor('pcm-feed', PcmFeed);
