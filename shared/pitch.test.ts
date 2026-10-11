import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, nearestNote } from './pitch.js';
import { closestString, inSet, intervalName, midiToHz, noteName, noteWithOctave, SCALES, TUNINGS } from './music.js';

const SR = 48000;
/** A plucked-string-like tone: fundamental plus harmonics, a little noise. */
function tone(freq: number, harmonics = [1, 0.5, 0.33, 0.25], n = 4096, noise = 0.01) {
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  return Float32Array.from({ length: n }, (_, i) =>
    harmonics.reduce((s, a, h) => s + a * Math.sin((2 * Math.PI * freq * (h + 1) * i) / SR + h), 0) * 0.3 + noise * rand(),
  );
}
const cents = (a: number, b: number) => 1200 * Math.log2(a / b);

test('detects guitar and bass notes within a cent (2 above 1 kHz)', () => {
  for (const f of [30.87, 41.2, 55, 82.41, 110, 146.83, 196, 246.94, 329.63, 440, 987.77, 1318.5]) {
    const p = detectPitch(tone(f), SR);
    assert.ok(p, `no pitch for ${f} Hz`);
    // Open strings are all under 400 Hz (< 1 cent); up at the 24th fret the 24 kHz decimation costs a little.
    assert.ok(Math.abs(cents(p.freq, f)) < (f < 1000 ? 1 : 2), `${f} Hz read as ${p.freq.toFixed(2)} Hz`);
  }
});

test('a weak fundamental under a strong 2nd harmonic still reads as the fundamental (no octave jump)', () => {
  const p = detectPitch(tone(82.41, [0.3, 1, 0.6, 0.4]), SR)!;
  assert.ok(Math.abs(cents(p.freq, 82.41)) < 2, `read ${p.freq}`);
});

test('a slightly detuned string reads the right cents', () => {
  const f = midiToHz(45) * Math.pow(2, 12 / 1200); // A2, 12 cents sharp
  const { midi, cents: c } = nearestNote(detectPitch(tone(f), SR)!.freq);
  assert.equal(midi, 45);
  assert.ok(Math.abs(c - 12) < 1, `cents ${c}`);
});

test('silence and noise give no pitch', () => {
  assert.equal(detectPitch(new Float32Array(4096), SR), null);
  assert.equal(detectPitch(tone(440, [], 4096, 0.3), SR), null);
});

test('music helpers', () => {
  assert.equal(noteWithOctave(40), 'E2');
  assert.equal(noteName(70, 5), 'B♭'); // F major spells flats
  assert.equal(noteName(70, 7), 'A♯');
  assert.equal(intervalName(64, 60), '3');
  assert.ok(inSet(57, 9, SCALES['Minor pentatonic'])); // A in A minor pentatonic
  assert.ok(!inSet(59, 9, SCALES['Minor pentatonic'])); // B is not
  assert.equal(closestString(29, TUNINGS.bass[0].notes), 0); // F1 → E string
  assert.equal(closestString(41, TUNINGS.bass[0].notes), 3); // F2 → G string
  assert.equal(closestString(24, TUNINGS.bass[4].notes), 0); // C1 → low B on a 5-string
  assert.equal(closestString(29, TUNINGS.bass[4].notes), 1); // F1 → E string
});
