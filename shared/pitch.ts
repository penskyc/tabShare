// Monophonic pitch detection for the tuner: McLeod Pitch Method (normalized square difference function).
// Works from low B on a 5-string bass (31 Hz) up past the 24th fret of a high E (1.3 kHz).

export interface Pitch {
  /** Hz */
  freq: number;
  /** 0..1, how periodic the signal is (the NSDF peak). */
  clarity: number;
}

/**
 * @param buf time-domain samples, ideally ~85 ms (4096 at 48 kHz) so low bass notes get two full periods
 * @returns null for silence or noise
 */
export function detectPitch(buf: Float32Array, sampleRate: number, minHz = 28, maxHz = 1400): Pitch | null {
  // Halve the rate (averaging pairs is a cheap low-pass); 24 kHz is plenty below 1.4 kHz and quarters the work.
  const dec = sampleRate >= 32000 ? 2 : 1;
  const n = Math.floor(buf.length / dec);
  const x = new Float32Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < dec; k++) v += buf[i * dec + k];
    x[i] = v / dec;
    energy += x[i] * x[i];
  }
  if (Math.sqrt(energy / n) < 0.002) return null; // silence
  const sr = sampleRate / dec;
  const tauMin = Math.max(2, Math.floor(sr / maxHz));
  const tauMax = Math.min(n - 2, Math.ceil(sr / minHz));
  if (tauMax <= tauMin) return null;

  const nsdf = new Float32Array(tauMax + 2);
  for (let tau = 0; tau <= tauMax + 1; tau++) {
    let acf = 0;
    let m = 0;
    for (let i = 0; i + tau < n; i++) {
      acf += x[i] * x[i + tau];
      m += x[i] * x[i] + x[i + tau] * x[i + tau];
    }
    nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
  }

  // Highest point of each positive lobe after the first zero crossing ("key maxima").
  const peaks: number[] = [];
  let tau = 1;
  while (tau <= tauMax && nsdf[tau] > 0) tau++;
  while (tau <= tauMax) {
    while (tau <= tauMax && nsdf[tau] <= 0) tau++;
    let best = -1;
    while (tau <= tauMax && nsdf[tau] > 0) {
      if (tau >= tauMin && (best < 0 || nsdf[tau] > nsdf[best])) best = tau;
      tau++;
    }
    if (best > 0) peaks.push(best);
  }
  if (!peaks.length) return null;
  const top = Math.max(...peaks.map((p) => nsdf[p]));
  // The first lobe that is nearly as strong as the best one is the fundamental (later ones are its multiples).
  const pick = peaks.find((p) => nsdf[p] >= 0.9 * top)!;
  const clarity = nsdf[pick];
  if (clarity < 0.6) return null;

  // Parabolic interpolation around the peak for sub-sample accuracy.
  const a = nsdf[pick - 1];
  const b = nsdf[pick];
  const c = nsdf[pick + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return { freq: sr / (pick + shift), clarity };
}

/** Nearest equal-tempered note: MIDI number and how many cents the frequency is off from it. */
export function nearestNote(freq: number, a4 = 440) {
  const exact = 69 + 12 * Math.log2(freq / a4);
  const midi = Math.round(exact);
  return { midi, cents: (exact - midi) * 100 };
}
