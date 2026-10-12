import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as alphaTab from '@coderline/alphatab';
import { BASS_TUNINGS, MAX_FRET, place, toAlphaTex, type Built } from './exercises.js';

const FOUR = BASS_TUNINGS['4-string'];
const FIVE = BASS_TUNINGS['5-string'];

function parse(tex: string) {
  const i = new alphaTab.importer.AlphaTexImporter();
  i.initFromString(tex, new alphaTab.Settings());
  return i.readScore();
}

test('place keeps every pitch and stays on the neck', () => {
  for (const t of [FOUR, FIVE]) {
    const midis = Array.from({ length: Math.max(...t) + MAX_FRET - t[0] + 1 }, (_, i) => t[0] + i);
    const spots = place(midis, t);
    spots.forEach((s, i) => {
      assert.ok(s.string >= 0 && s.string < t.length);
      assert.ok(s.fret >= 0 && s.fret <= MAX_FRET);
      assert.equal(t[s.string] + s.fret, midis[i]);
    });
  }
  assert.throws(() => place([FOUR[0] - 1], FOUR), /off the neck/);
});

test('place stays in one hand position for a C major scale', () => {
  const c = [36, 38, 40, 41, 43, 45, 47, 48];
  const frets = place(c, FOUR).map((s) => s.fret);
  assert.ok(Math.max(...frets) - Math.min(...frets.filter((f) => f > 0)) <= 4, `frets ${frets}`);
});

test('toAlphaTex writes tuning, tempo, dead notes, dots and rests that alphaTab reads back', () => {
  const b: Built = {
    bars: [
      [
        { string: 0, fret: 3, duration: 4 },
        { string: 3, fret: 5, duration: 4 },
        { string: 1, fret: 3, duration: 8, dead: true },
        { string: 0, fret: 0, duration: 8, rest: true },
        { string: 1, fret: 7, duration: 4 },
      ],
      [
        { string: 3, fret: 0, duration: 2, dotted: true },
        { string: 3, fret: 0, duration: 4 },
      ],
    ],
    fretboard: { root: 0, set: [] },
    allowed: [],
  };
  const score = parse(toAlphaTex(b, { tempo: 90, tuning: FOUR, title: 'Test "q"' }));
  const st = score.tracks[0].staves[0];
  assert.equal(score.tempo, 90);
  assert.equal(score.tracks[0].playbackInfo.program, 33);
  assert.deepEqual([...st.stringTuning.tunings], [43, 38, 33, 28]);
  assert.equal(st.bars.length, 2);
  const notes = st.bars.flatMap((bar) => bar.voices[0].beats.flatMap((x) => x.notes));
  // alphaTab's note.string is 1-based from the lowest string.
  assert.deepEqual(
    notes.map((n) => [n.string - 1, n.fret, n.isDead]),
    [
      [0, 3, false],
      [3, 5, false],
      [1, 3, true],
      [1, 7, false],
      [3, 0, false],
      [3, 0, false],
    ],
  );
  assert.equal(st.bars[1].voices[0].beats[0].dots, 1);
});
