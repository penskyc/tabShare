/** 16-bit PCM WAV from one Float32Array per channel (equal lengths), samples clamped to [-1, 1]. */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
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
