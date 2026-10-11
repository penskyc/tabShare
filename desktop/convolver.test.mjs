import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Convolver } from './convolver.mjs';

test('partitioned convolution matches direct convolution', () => {
  const B = 64;
  const ir = Float32Array.from({ length: 300 }, (_, i) => Math.sin(i * 0.37) * Math.exp(-i / 80));
  const input = Float32Array.from({ length: B * 12 }, (_, i) => Math.sin(i * 0.11) + (i % 7) / 10);
  const conv = new Convolver(ir, B);
  const out = new Float32Array(input.length);
  for (let b = 0; b < input.length / B; b++) {
    const block = input.slice(b * B, (b + 1) * B);
    conv.process(block);
    out.set(block, b * B);
  }
  for (let n = 0; n < input.length; n++) {
    let want = 0;
    for (let k = 0; k < ir.length && k <= n; k++) want += ir[k] * input[n - k];
    assert.ok(Math.abs(out[n] - want) < 1e-4, `sample ${n}: ${out[n]} vs ${want}`);
  }
});
