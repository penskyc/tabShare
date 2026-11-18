import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav } from './wav.js';

const text = (b: Uint8Array, at: number) => String.fromCharCode(...b.slice(at, at + 4));

test('encodeWav: 16-bit PCM header and clamped samples (mono)', () => {
  const b = encodeWav([new Float32Array([0, 1, -1, 2])], 48000);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  assert.equal(text(b, 0), 'RIFF');
  assert.equal(v.getUint32(4, true), b.length - 8);
  assert.equal(text(b, 8), 'WAVE');
  assert.equal(text(b, 12), 'fmt ');
  assert.equal(v.getUint16(20, true), 1); // PCM
  assert.equal(v.getUint16(22, true), 1); // channels
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getUint32(28, true), 48000 * 2); // byte rate
  assert.equal(v.getUint16(32, true), 2); // block align
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(text(b, 36), 'data');
  assert.equal(v.getUint32(40, true), 8);
  assert.deepEqual([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true)), [0, 32767, -32768, 32767]);
});

test('encodeWav: two channels interleave', () => {
  const b = encodeWav([new Float32Array([0.5, 0]), new Float32Array([-0.5, 1])], 44100);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(40, true), 8);
  assert.deepEqual([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true)), [16384, -16384, 0, 32767]);
});
