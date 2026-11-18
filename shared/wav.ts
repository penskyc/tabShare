/** 16-bit PCM WAV from one Float32Array per channel (equal lengths), samples clamped to [-1, 1]. */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
  const nch = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * nch * 2;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const str = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nch * 2, true);
  v.setUint16(32, nch * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  let at = 44;
  for (let f = 0; f < frames; f++)
    for (let c = 0; c < nch; c++) {
      const x = Math.max(-1, Math.min(1, channels[c][f]));
      v.setInt16(at, x < 0 ? Math.round(x * 32768) : Math.round(x * 32767), true);
      at += 2;
    }
  return out;
}

/** The same bytes as encodeWav, as a header part + data parts of `frames` frames each (no second full-size copy). */
export function encodeWavParts(channels: Float32Array[], sampleRate: number, frames = 48000): Uint8Array<ArrayBuffer>[] {
  const total = channels[0]?.length ?? 0;
  const header = encodeWav(channels.map(() => new Float32Array(0)), sampleRate).slice(0, 44);
  const v = new DataView(header.buffer);
  const dataBytes = total * channels.length * 2;
  v.setUint32(4, 36 + dataBytes, true);
  v.setUint32(40, dataBytes, true);
  const parts: Uint8Array<ArrayBuffer>[] = [header];
  for (let at = 0; at < total; at += frames) parts.push(encodeWav(channels.map((c) => c.subarray(at, Math.min(total, at + frames))), sampleRate).slice(44));
  return parts;
}
