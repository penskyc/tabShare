// Offline check of the native DSP chain with a real NAM capture (no audio device needed).
// Run from desktop/: node --test engine.test.mjs  (NAM_FILE overrides the model path)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Dsp } from './engine.mjs';

const NAM = process.env.NAM_FILE ?? '../.playwright-mcp/test.nam';
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

test('NAM + IR chain processes a guitar-ish signal faster than real time', { skip: !existsSync(NAM) && 'no test .nam file' }, async () => {
  const dsp = await Dsp.create();
  const B = 128;
  dsp.configure(48000, B);
  assert.ok(dsp.loadModel(readFileSync(NAM, 'utf8')), 'model loads');
  dsp.setIr(Float32Array.from({ length: 4800 }, (_, i) => (i === 0 ? 1 : Math.exp(-i / 300) * Math.sin(i) * 0.3)));
  dsp.params.outGain = 1;

  const nIn = 2;
  const input = new Float32Array(B * nIn);
  const out = new Float32Array(B * 2);
  const blocks = Math.ceil((48000 * 2) / B); // 2 s of audio
  const wet = [];
  const t0 = performance.now();
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < B; i++) input[i * nIn] = 0.2 * Math.sin((2 * Math.PI * 110 * (b * B + i)) / 48000); // input 1 only
    const y = dsp.process(input, nIn, out);
    if (b > blocks / 2) wet.push(...y);
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 2000 / 2, `2 s of audio took ${ms.toFixed(0)} ms (needs headroom for real time)`);
  assert.ok(rms(wet) > 0.01, `wet signal present (rms ${rms(wet)})`);
  assert.equal(out[0], out[1], 'monitor is dual-mono');

  dsp.params.channel = 1; // input 2 is silent
  for (let b = 0; b < 400; b++) dsp.process(input, nIn, out);
  assert.ok(rms(dsp.process(input, nIn, out)) < 1e-3, 'channel select picks input 2');

  dsp.params.channel = 0;
  dsp.params.monitor = false;
  dsp.process(input, nIn, out);
  assert.ok(out.every((v) => v === 0), 'monitor off writes silence');
  console.log(`  2 s of NAM+IR audio in ${ms.toFixed(0)} ms`);
});
