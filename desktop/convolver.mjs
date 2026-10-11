// Uniformly partitioned overlap-save FFT convolution, for cab IRs in the native engine (Node has no ConvolverNode).
// Latency-free: each call to process() returns the convolved block for that same block.

function fftTables(n) {
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  return { rev, cos, sin };
}

/** In-place iterative radix-2 FFT. inverse=true computes the unscaled inverse. */
function fft(re, im, t, inverse) {
  const n = re.length;
  for (let i = 0; i < n; i++) {
    const j = t.rev[i];
    if (j > i) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  const sign = inverse ? -1 : 1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = t.cos[k * step];
        const wi = sign * t.sin[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

export class Convolver {
  /** @param {Float32Array} ir impulse response @param {number} block samples per process() call (power of two) */
  constructor(ir, block) {
    this.B = block;
    const n = (this.N = block * 2);
    this.t = fftTables(n);
    this.P = Math.max(1, Math.ceil(ir.length / block));
    // Spectrum of each IR partition, zero-padded to 2B.
    this.Hr = []; this.Hi = [];
    for (let p = 0; p < this.P; p++) {
      const re = new Float64Array(n);
      const im = new Float64Array(n);
      for (let i = 0; i < block && p * block + i < ir.length; i++) re[i] = ir[p * block + i];
      fft(re, im, this.t, false);
      this.Hr.push(re); this.Hi.push(im);
    }
    // Frequency-domain delay line of past input spectra (ring buffer).
    this.Xr = Array.from({ length: this.P }, () => new Float64Array(n));
    this.Xi = Array.from({ length: this.P }, () => new Float64Array(n));
    this.pos = 0;
    this.prev = new Float64Array(block);
    this.yr = new Float64Array(n);
    this.yi = new Float64Array(n);
  }

  /** Convolves one block in place. @param {Float32Array} x length === block */
  process(x) {
    const { B, N, P } = this;
    const xr = this.Xr[this.pos];
    const xi = this.Xi[this.pos];
    // Overlap-save input: [previous block, current block].
    for (let i = 0; i < B; i++) {
      xr[i] = this.prev[i];
      xr[B + i] = x[i];
      this.prev[i] = x[i];
    }
    xi.fill(0);
    fft(xr, xi, this.t, false);

    const yr = this.yr.fill(0);
    const yi = this.yi.fill(0);
    for (let p = 0; p < P; p++) {
      const k = (this.pos - p + P) % P;
      const ar = this.Xr[k], ai = this.Xi[k], hr = this.Hr[p], hi = this.Hi[p];
      for (let i = 0; i < N; i++) {
        yr[i] += ar[i] * hr[i] - ai[i] * hi[i];
        yi[i] += ar[i] * hi[i] + ai[i] * hr[i];
      }
    }
    fft(yr, yi, this.t, true);
    for (let i = 0; i < B; i++) x[i] = yr[B + i] / N;
    this.pos = (this.pos + 1) % P;
  }
}
