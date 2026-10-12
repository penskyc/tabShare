import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as alphaTab from '@coderline/alphatab';
import {
  allParams,
  BASS_TUNINGS,
  CATEGORIES,
  defaults,
  EXERCISES,
  MAX_FRET,
  pc,
  place,
  sanitize,
  toAlphaTex,
  tuningOf,
  type Built,
  type Exercise,
  type Opts,
} from './exercises.js';

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

const DUMMY: Exercise = {
  id: 'X',
  category: 'Warm-up',
  name: 'Dummy',
  description: '',
  tips: [],
  kind: 'tab',
  params: [
    { id: 'key', label: 'Key', kind: 'key', default: 4 },
    { id: 'scale', label: 'Scale', kind: 'choice', options: ['A', 'B'], default: 'A' },
    { id: 'fret', label: 'Fret', kind: 'number', min: 1, max: 9, default: 1 },
  ],
  build: () => ({ bars: [], fretboard: { root: 0, set: [] }, allowed: [] }),
};

test('playable exercises also get bass and tempo settings', () => {
  assert.deepEqual(allParams(DUMMY).map((p) => p.id), ['key', 'scale', 'fret', 'tuning', 'tempo']);
  assert.deepEqual(allParams({ ...DUMMY, kind: 'fretboard' }).map((p) => p.id), ['key', 'scale', 'fret']);
  assert.deepEqual(defaults(DUMMY), { key: 4, scale: 'A', fret: 1, tuning: '4-string', tempo: 80 });
});

test('sanitize keeps valid saved settings and drops stale ones', () => {
  assert.deepEqual(sanitize(DUMMY, { key: 7, scale: 'B', fret: 5, tuning: '5-string', tempo: 120 }), { key: 7, scale: 'B', fret: 5, tuning: '5-string', tempo: 120 });
  assert.deepEqual(sanitize(DUMMY, { key: 12, scale: 'Gone', fret: 99, tuning: '7-string', tempo: 'fast' }), defaults(DUMMY));
  assert.deepEqual(sanitize(DUMMY, null), defaults(DUMMY));
  assert.deepEqual(tuningOf({ tuning: '5-string' }), FIVE);
  assert.deepEqual(tuningOf({ tuning: 'nope' }), FOUR);
});

/** Every combination of key, choice options and tuning; number settings at min, default and max. */
function* combos(ex: Exercise): Generator<Opts> {
  const params = allParams(ex).filter((p) => p.id !== 'tempo');
  const values = params.map((p) => (p.kind === 'key' ? [...Array(12).keys()] : p.kind === 'choice' ? p.options : [...new Set([p.min, p.default, p.max])]));
  function* rec(i: number, o: Opts): Generator<Opts> {
    if (i === params.length) return yield { ...o, tempo: 80 };
    for (const v of values[i]) yield* rec(i + 1, { ...o, [params[i].id]: v });
  }
  yield* rec(0, {});
}
const midisOf = (b: Built, t: number[]) => b.bars.flat().filter((n) => !n.rest).map((n) => t[n.string] + n.fret);

test('the library: 22 exercises, unique ids, known categories, text for each', () => {
  assert.equal(EXERCISES.length, 22);
  assert.equal(new Set(EXERCISES.map((e) => e.id)).size, 22);
  for (const e of EXERCISES) {
    assert.ok(CATEGORIES.includes(e.category), e.id);
    assert.ok(e.description.length > 20 && e.tips.length >= 2, e.id);
  }
});

test('every playable exercise, in every key/option/tuning: notes on the neck, in the allowed set, full 4/4 bars, valid alphaTex', () => {
  for (const ex of EXERCISES.filter((e) => e.kind === 'tab')) {
    for (const o of combos(ex)) {
      const t = tuningOf(o);
      const b = ex.build(o, t);
      const where = `${ex.id} ${JSON.stringify(o)}`;
      assert.ok(b.bars.length > 0, where);
      for (const bar of b.bars) {
        assert.equal(bar.reduce((s, n) => s + (16 / n.duration) * (n.dotted ? 1.5 : 1), 0), 16, `bar length ${where}`);
        for (const n of bar) {
          if (n.rest) continue;
          assert.ok(n.string >= 0 && n.string < t.length && n.fret >= 0 && n.fret <= MAX_FRET, `on neck ${where}`);
          assert.ok(b.allowed.includes(pc(t[n.string] + n.fret)), `pitch ${t[n.string] + n.fret} not allowed ${where}`);
        }
      }
      const score = parse(toAlphaTex(b, { tempo: 80, tuning: t, title: ex.name }));
      const parsed = score.tracks[0].staves[0].bars.flatMap((bar) => bar.voices[0].beats.flatMap((x) => x.notes)).length;
      assert.equal(parsed, b.bars.flat().filter((n) => !n.rest).length, `alphaTex note count ${where}`);
    }
  }
});

test('fretboard-only exercises show something and play nothing', () => {
  for (const ex of EXERCISES.filter((e) => e.kind === 'fretboard')) {
    for (const o of combos(ex)) {
      const b = ex.build(o, tuningOf(o));
      assert.equal(b.bars.length, 0, ex.id);
      assert.ok(b.fretboard.set.length > 0, ex.id);
    }
  }
});

const byId = (id: string) => EXERCISES.find((e) => e.id === id)!;

test('C major scale, one octave, up and down', () => {
  const ex = byId('S1');
  const o = { ...defaults(ex), key: 0, scale: 'Major', octaves: '1' };
  assert.deepEqual(midisOf(ex.build(o, FOUR), FOUR), [36, 38, 40, 41, 43, 45, 47, 48, 47, 45, 43, 41, 40, 38, 36]);
});

test('root-5th-octave over I-IV-V-I in C walks near the previous root', () => {
  const ex = byId('WB1');
  const o = { ...defaults(ex), key: 0, progression: 'I-IV-V-I' };
  const m = midisOf(ex.build(o, FOUR), FOUR);
  assert.deepEqual(m.slice(0, 4), [36, 43, 48, 43]); // C: root, 5th, octave, 5th
  assert.equal(m[4], 41); // F root is the F just above C, not the low one
});

test('chromatic approach lands a half step from the next root', () => {
  const ex = byId('WB3');
  const o = { ...defaults(ex), key: 0, progression: 'I-IV-V-I' };
  const m = midisOf(ex.build(o, FOUR), FOUR);
  assert.equal(Math.abs(m[3] - m[4]), 1);
});

test('16th funk has ghost notes', () => {
  const ex = byId('G2');
  const b = ex.build(defaults(ex), FOUR);
  assert.ok(b.bars[0].some((n) => n.dead));
  assert.ok(b.bars[0].every((n) => n.duration === 16));
});
