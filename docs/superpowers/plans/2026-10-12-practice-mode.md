# Practice Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tab | Practice switch in the room; Practice offers 22 bass exercises generated as playable alphaTex tabs (or fretboard views), with its own player and the fretboard following each note.

**Architecture:** Pure generators in `shared/exercises.ts` turn (exercise, settings, tuning) into notes and then alphaTex; `src/Practice.tsx` renders them with its own `ScoreView` (own alphaTab api, so jam sync never reaches it), a practice transport and a `Fretboard` with a new `forced` prop. `Room.tsx` adds the mode switch, keeps the tab view mounted but hidden, and pauses + mutes the tab player while practicing.

**Tech Stack:** TypeScript, React 19, alphaTab 1.8 (alphaTex), node:test via `tsx --test`, Playwright (playwright-core from `desktop/node_modules`) for the browser check.

Spec: `docs/superpowers/specs/2026-10-12-practice-mode-design.md`.

alphaTex facts verified against alphaTab 1.8 in Node (2026-10-12):
- `\track "Bass"`, `\staff {tabs}`, `\instrument 33`, `\tuning g2 d2 a1 e1` (highest string first; octave = floor(midi/12) - 1, so E1 = 28).
- Beat syntax `:4 3.4` = quarter note, fret 3 on string 4; alphaTex string 1 is the HIGHEST string. With `n` strings, our 0-based lowest-first index `s` is alphaTex string `n - s`.
- Dead note `3.4{x}`, dotted beat `3.4{d}`, rest `r`, bars separated by `|`.
- Node parse: `new alphaTab.importer.AlphaTexImporter()`, `initFromString(tex, new alphaTab.Settings())`, `readScore()` (throws `AlphaTexErrorWithDiagnostics` on errors).

## File map

| File | Responsibility |
|---|---|
| `shared/exercises.ts` (create) | Types, fingering (`place`), bar building, 22 exercises, `toAlphaTex`, `allParams`/`defaults`/`sanitize`. No DOM, no React. |
| `shared/exercises.test.ts` (create) | Exhaustive generator checks + alphaTex parse in Node. Runs in `npm test` (glob `shared/*.test.ts`). |
| `src/Fretboard.tsx` (modify) | Optional `forced` prop: locked Follow + resting dots, without touching saved prefs. |
| `src/Practice.tsx` (create) | Practice UI: picker, tips, own ScoreView, Fretboard, practice transport, speed-up trainer. |
| `src/Room.tsx` (modify) | Mode state + switch, hide tab view, pause/mute tab player, hide tab footer, Space-key guard. |
| `src/styles.css` (modify) | `.stage-bar`, `.tab-view(.off)`, `.practice*`. |
| `CLAUDE.md` (modify) | Layout + design notes for practice mode. |

---

### Task 1: Exercise engine core (types, fingering, bars, alphaTex)

**Files:**
- Create: `shared/exercises.ts`
- Test: `shared/exercises.test.ts`

- [ ] **Step 1: Write the failing tests for the core**

`shared/exercises.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as alphaTab from '@coderline/alphatab';
import { BASS_TUNINGS, MAX_FRET, place, toAlphaTex, type Built } from './exercises.js';

const FOUR = BASS_TUNINGS['4-string'];
const FIVE = BASS_TUNINGS['5-string'];

export function parse(tex: string) {
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
  assert.deepEqual(notes.map((n) => [n.string - 1, n.fret, n.isDead]), [
    [0, 3, false],
    [3, 5, false],
    [1, 3, true],
    [1, 7, false],
    [3, 0, false],
    [3, 0, false],
  ]);
  assert.equal(st.bars[1].voices[0].beats[0].dots, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test shared/exercises.test.ts`
Expected: FAIL, `Cannot find module './exercises.js'` (or similar).

- [ ] **Step 3: Write the core of `shared/exercises.ts`**

```ts
// Practice mode: bass exercises generated as playable tabs (alphaTex) or fretboard views.
// Design: docs/superpowers/specs/2026-10-12-practice-mode-design.md
import { INTERVALS, SCALES, TUNINGS } from './music';

export type Dur = 1 | 2 | 4 | 8 | 16;

/** One beat of the generated tab. `string` 0 is the lowest string. */
export interface PracticeNote {
  string: number;
  fret: number;
  duration: Dur;
  dotted?: boolean;
  dead?: boolean;
  rest?: boolean;
}

export interface Built {
  bars: PracticeNote[][];
  /** Dots shown on the fretboard while stopped: a root pitch class and intervals above it. */
  fretboard: { root: number; set: number[] };
  /** Pitch classes (0–11) any played note may have. */
  allowed: number[];
}

export type Opts = Record<string, string | number>;

export type ParamSpec =
  | { id: string; label: string; kind: 'key'; default: number }
  | { id: string; label: string; kind: 'choice'; options: string[]; default: string }
  | { id: string; label: string; kind: 'number'; min: number; max: number; step?: number; default: number };

export interface Exercise {
  id: string;
  category: string;
  name: string;
  description: string;
  tips: string[];
  kind: 'tab' | 'fretboard';
  params: ParamSpec[];
  build(o: Opts, tuning: number[]): Built;
}

export const MAX_FRET = 15;
export const BASS_TUNINGS: Record<string, number[]> = { '4-string': TUNINGS.bass[0].notes, '5-string': TUNINGS.bass[4].notes };

export const pc = (m: number) => ((m % 12) + 12) % 12;

/** One beat before placement: a pitch (null = rest), or a fixed string/fret for shape drills. */
interface Ev {
  midi: number | null;
  dur: Dur;
  dotted?: boolean;
  dead?: boolean;
  at?: { string: number; fret: number };
}
const sixteenths = (e: { dur: Dur; dotted?: boolean }) => (16 / e.dur) * (e.dotted ? 1.5 : 1);

/** String + fret for each pitch: keep a 5-fret hand position (open strings allowed near the nut), shift only when a note doesn't fit. */
export function place(midis: number[], tuning: number[]): { string: number; fret: number }[] {
  let pos = -1;
  return midis.map((m) => {
    const opts = tuning.map((open, s) => ({ string: s, fret: m - open })).filter((c) => c.fret >= 0 && c.fret <= MAX_FRET);
    if (!opts.length) throw new Error(`pitch ${m} is off the neck`);
    const inHand = pos >= 0 ? opts.find((c) => (c.fret >= pos && c.fret <= pos + 4) || (c.fret === 0 && pos <= 2)) : undefined;
    if (inHand) return inHand;
    const target = pos < 0 ? 0 : pos + 2;
    const pick = opts.reduce((a, b) => (Math.abs(b.fret - target) < Math.abs(a.fret - target) ? b : a));
    pos = Math.max(1, pick.fret - 1);
    return pick;
  });
}

const REST_SIZES: Dur[] = [1, 2, 4, 8, 16];

/** Places the pitches and splits the beats into 4/4 bars; the last bar is padded with rests. */
function toBars(evs: Ev[], tuning: number[]): PracticeNote[][] {
  const spots = place(evs.filter((e) => e.midi != null && !e.at).map((e) => e.midi!), tuning);
  let k = 0;
  let used = 0;
  const bars: PracticeNote[][] = [[]];
  const push = (n: PracticeNote) => {
    if (used === 16) {
      bars.push([]);
      used = 0;
    }
    const t = sixteenths(n);
    if (used + t > 16) throw new Error('beat crosses a bar line');
    bars[bars.length - 1].push(n);
    used += t;
  };
  for (const e of evs) {
    const len = { duration: e.dur, ...(e.dotted ? { dotted: true } : {}) };
    if (e.midi == null) push({ string: 0, fret: 0, rest: true, ...len });
    else push({ ...(e.at ?? spots[k++]), ...len, ...(e.dead ? { dead: true } : {}) });
  }
  while (used < 16) {
    const d = REST_SIZES.find((x) => 16 / x <= 16 - used && used % (16 / x) === 0)!;
    push({ string: 0, fret: 0, rest: true, duration: d });
  }
  return bars;
}

const TEX_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const texPitch = (m: number) => `${TEX_NAMES[pc(m)]}${Math.floor(m / 12) - 1}`;

/** The only place alphaTex is written. Bass (GM 33, fingered), tab staff only. */
export function toAlphaTex(b: Built, o: { tempo: number; tuning: number[]; title: string }): string {
  const n = o.tuning.length;
  const beat = (x: PracticeNote) => {
    const fx = [x.dead && 'x', x.dotted && 'd'].filter(Boolean).join(' ');
    const body = x.rest ? 'r' : `${x.fret}.${n - x.string}`;
    return `:${x.duration} ${body}${fx ? `{${fx}}` : ''}`;
  };
  return [
    `\\title "${o.title.replace(/"/g, "'")}"`,
    `\\tempo ${Math.round(o.tempo)}`,
    '\\track "Bass"',
    '\\staff {tabs}',
    '\\instrument 33',
    `\\tuning ${[...o.tuning].reverse().map(texPitch).join(' ')}`,
    b.bars.map((bar) => bar.map(beat).join(' ')).join(' | ') + ' |',
  ].join('\n');
}

export const EXERCISES: Exercise[] = [];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test shared/exercises.test.ts`
Expected: 3 tests pass. If the dead+dotted or rest syntax is rejected, `readScore()` throws with diagnostics: print `e.parserDiagnostics.items` / `e.semanticDiagnostics.items` and fix `beat()`.

- [ ] **Step 5: Commit**

```bash
git add shared/exercises.ts shared/exercises.test.ts
git commit -m "Practice: exercise engine core (fingering, bars, alphaTex)"
```

---

### Task 2: Settings helpers (allParams, defaults, sanitize)

**Files:**
- Modify: `shared/exercises.ts`
- Test: `shared/exercises.test.ts`

- [ ] **Step 1: Add failing tests** (append to `shared/exercises.test.ts`; extend the import line with `allParams, defaults, sanitize, tuningOf, type Exercise`)

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test shared/exercises.test.ts`
Expected: FAIL, `allParams` is not exported.

- [ ] **Step 3: Implement** (add to `shared/exercises.ts`, after `BASS_TUNINGS`)

```ts
const TUNING_PARAM: ParamSpec = { id: 'tuning', label: 'Bass', kind: 'choice', options: Object.keys(BASS_TUNINGS), default: '4-string' };
const TEMPO_PARAM: ParamSpec = { id: 'tempo', label: 'Tempo', kind: 'number', min: 40, max: 200, step: 1, default: 80 };

/** Every setting an exercise shows: its own, plus bass and tempo for playable ones. */
export const allParams = (ex: Exercise): ParamSpec[] => (ex.kind === 'tab' ? [...ex.params, TUNING_PARAM, TEMPO_PARAM] : ex.params);
export const tuningOf = (o: Opts) => BASS_TUNINGS[String(o.tuning)] ?? BASS_TUNINGS['4-string'];
export const defaults = (ex: Exercise): Opts => Object.fromEntries(allParams(ex).map((p) => [p.id, p.default]));

/** Saved settings from an older version (renamed options, out-of-range numbers) fall back to the defaults. */
export function sanitize(ex: Exercise, saved: unknown): Opts {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  const o = defaults(ex);
  for (const p of allParams(ex)) {
    const v = s[p.id];
    if (p.kind === 'choice' && typeof v === 'string' && p.options.includes(v)) o[p.id] = v;
    if (p.kind === 'key' && typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 12) o[p.id] = v;
    if (p.kind === 'number' && typeof v === 'number' && v >= p.min && v <= p.max) o[p.id] = v;
  }
  return o;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test shared/exercises.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add shared/exercises.ts shared/exercises.test.ts
git commit -m "Practice: exercise settings (defaults, sanitize)"
```

---

### Task 3: The 22 exercises

**Files:**
- Modify: `shared/exercises.ts` (replace `export const EXERCISES: Exercise[] = [];`)
- Test: `shared/exercises.test.ts`

- [ ] **Step 1: Add failing tests** (append; extend the import with `EXERCISES, CATEGORIES, pc, type Opts`)

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test shared/exercises.test.ts`
Expected: FAIL, `CATEGORIES` not exported / 0 exercises.

- [ ] **Step 3: Implement the library** (in `shared/exercises.ts`, replace the empty `EXERCISES`)

```ts
export const CATEGORIES = ['Warm-up', 'Scales', 'Arpeggios', 'Walking bass', 'Groove', 'Theory'];

const ALL = [...Array(12).keys()];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const SCALE_SETS: Record<string, number[]> = {
  Major: SCALES['Major (Ionian)'],
  'Natural minor': SCALES['Natural minor (Aeolian)'],
  'Major pentatonic': SCALES['Major pentatonic'],
  'Minor pentatonic': SCALES['Minor pentatonic'],
  Dorian: SCALES.Dorian,
  Mixolydian: SCALES.Mixolydian,
  Blues: SCALES.Blues,
};
const SCALE_NAMES = Object.keys(SCALE_SETS);

/** The lowest playable note of pitch class `key`. */
const lowestOf = (key: number, t: number[]) => t[0] + pc(key - t[0]);
const topOf = (t: number[]) => Math.max(...t) + MAX_FRET;
/** Notes above the neck's range drop by octaves. */
const fold = (m: number, t: number[]) => {
  while (m > topOf(t)) m -= 12;
  return m;
};
/** Note `i` of a scale/chord built on `root` (i may run past one octave). */
const degree = (root: number, set: number[], i: number) => root + 12 * Math.floor(i / set.length) + set[((i % set.length) + set.length) % set.length];
const pcsOf = (root: number, set: number[]) => [...new Set(set.map((s) => pc(root + s)))];
const run = (midis: number[], dur: Dur, t: number[]): Ev[] => midis.map((m) => ({ midi: fold(m, t), dur }));
const upDown = (asc: number[]) => [...asc, ...asc.slice(0, -1).reverse()];
const key = (d = 0): ParamSpec => ({ id: 'key', label: 'Key', kind: 'key', default: d });
const choice = (id: string, label: string, options: string[], d = options[0]): ParamSpec => ({ id, label, kind: 'choice', options, default: d });
const num = (id: string, label: string, min: number, max: number, d: number): ParamSpec => ({ id, label, kind: 'number', min, max, step: 1, default: d });

// ---- chords for walking bass and grooves ----
interface Chord {
  root: number; // pitch class
  t3: number;
  t5: number;
  t6: number;
  t7: number;
}
/** The diatonic 7th chord on degree d (0 = I) of a major key. */
const diatonic = (k: number, d: number): Chord => {
  const tone = (n: number) => degree(0, MAJOR, d + n) - MAJOR[d];
  return { root: pc(k + MAJOR[d]), t3: tone(2), t5: tone(4), t6: tone(5), t7: tone(6) };
};
const dom = (k: number, semis: number): Chord => ({ root: pc(k + semis), t3: 4, t5: 7, t6: 9, t7: 10 });
const PROGRESSIONS: Record<string, (k: number) => Chord[]> = {
  'I-IV-V-I': (k) => [0, 3, 4, 0].map((d) => diatonic(k, d)),
  'I-vi-ii-V': (k) => [0, 5, 1, 4].map((d) => diatonic(k, d)),
  'ii-V-I': (k) => [1, 4, 0, 0].map((d) => diatonic(k, d)),
  '12-bar blues': (k) => [0, 0, 0, 0, 5, 5, 0, 0, 7, 5, 0, 7].map((s) => dom(k, s)),
};
const PROG_NAMES = Object.keys(PROGRESSIONS);
const GROOVE_PROGS = ['One chord', ...PROG_NAMES];
const grooveChords = (o: Opts) => (o.progression === 'One chord' ? [0, 0, 0, 0].map(() => diatonic(Number(o.key), 0)) : PROGRESSIONS[String(o.progression)](Number(o.key)));

/** Each chord's root near the previous one (within a tritone), kept on the neck. */
function rootsFor(chords: Chord[], t: number[]): number[] {
  const out: number[] = [];
  for (const c of chords) {
    const prev = out[out.length - 1];
    let m = prev === undefined ? lowestOf(c.root, t) : prev + pc(c.root - prev);
    if (prev !== undefined && m - prev > 6) m -= 12;
    if (m < t[0]) m += 12;
    out.push(m);
  }
  return out;
}
const approach = (next: number, t: number[]) => (next - 1 >= t[0] ? next - 1 : next + 1);

/** One bar per chord; `bar` returns that bar's beats from the chord, its root and the next chord's root. */
function overChords(chords: Chord[], t: number[], bar: (c: Chord, r: number, next: number) => Ev[], withApproach = false): Built {
  const roots = rootsFor(chords, t);
  const allowed = new Set<number>();
  const evs = chords.flatMap((c, i) => {
    const next = roots[(i + 1) % roots.length];
    for (const s of [0, c.t3, c.t5, c.t6, c.t7]) allowed.add(pc(c.root + s));
    if (withApproach) allowed.add(pc(approach(next, t)));
    return bar(c, roots[i], next).map((e) => (e.midi == null ? e : { ...e, midi: fold(e.midi, t) }));
  });
  return { bars: toBars(evs, t), fretboard: { root: chords[0].root, set: [0, chords[0].t3, chords[0].t5, chords[0].t7] }, allowed: [...allowed] };
}
const q = (...midis: number[]): Ev[] => midis.map((m) => ({ midi: m, dur: 4 }));

// ---- shape drills (fixed string/fret) ----
const shape = (cells: { string: number; fret: number }[], dur: Dur, t: number[]): Built => ({
  bars: toBars(cells.map((at) => ({ midi: t[at.string] + at.fret, dur, at })), t),
  fretboard: { root: pc(t[0] + cells[0].fret), set: [] },
  allowed: ALL,
});

export const EXERCISES: Exercise[] = [
  // ---------- Warm-up ----------
  {
    id: 'W1',
    category: 'Warm-up',
    name: 'Chromatic crawl',
    description: 'Four frets per string, one finger per fret, up across all strings and back down.',
    tips: ['Index, middle, ring, pinky: one finger per fret.', 'Keep fingers close to the strings and leave each one down until you need it.', 'Alternate plucking fingers on every note.'],
    kind: 'tab',
    params: [num('fret', 'Start fret', 1, 9, 1)],
    build(o, t) {
      const f = Number(o.fret);
      const up = t.flatMap((_, s) => [0, 1, 2, 3].map((i) => ({ string: s, fret: f + i })));
      const down = [...t.keys()].reverse().flatMap((s) => [3, 2, 1, 0].map((i) => ({ string: s, fret: f + i })));
      return shape([...up, ...down], 4, t);
    },
  },
  {
    id: 'W2',
    category: 'Warm-up',
    name: 'Spider walk',
    description: 'One-finger-per-fret groups that shift up a fret on each new string, then come back down.',
    tips: ['Shift smoothly: no gap between strings.', 'Watch the fretting hand at first, then try it without looking.', 'Start slow; evenness beats speed.'],
    kind: 'tab',
    params: [num('fret', 'Start fret', 1, 8, 1)],
    build(o, t) {
      const f = Number(o.fret);
      const up = t.flatMap((_, s) => [0, 1, 2, 3].map((i) => ({ string: s, fret: f + s + i })));
      const down = [...t.keys()].reverse().flatMap((s) => [3, 2, 1, 0].map((i) => ({ string: s, fret: f + s + i })));
      return shape([...up, ...down], 4, t);
    },
  },
  {
    id: 'W3',
    category: 'Warm-up',
    name: 'String crossing',
    description: 'Skip a string back and forth on one fret (E–D, A–G, …) in steady eighth notes.',
    tips: ['Use alternate plucking (index, middle) the whole time.', 'Mute the string you just left with your plucking hand.', 'Aim for the same volume on every string.'],
    kind: 'tab',
    params: [num('fret', 'Fret', 0, 12, 5)],
    build(o, t) {
      const f = Number(o.fret);
      const pairs = [...Array(t.length - 2).keys()];
      const bar = (s: number) => [0, 1, 2, 3].flatMap(() => [{ string: s, fret: f }, { string: s + 2, fret: f }]);
      return shape([...pairs, ...pairs.slice(0, -1).reverse()].flatMap(bar), 8, t);
    },
  },
  // ---------- Scales ----------
  {
    id: 'S1',
    category: 'Scales',
    name: 'Scale in one position',
    description: 'The scale from its lowest root, up one or two octaves and back down, in eighth notes.',
    tips: ['Say the note names out loud as you play.', 'Two octaves goes as high as fits by the 15th fret.', 'Switch keys: the shape stays the same, only the position moves.'],
    kind: 'tab',
    params: [key(0), choice('scale', 'Scale', SCALE_NAMES), choice('octaves', 'Octaves', ['1', '2'], '2')],
    build(o, t) {
      const set = SCALE_SETS[String(o.scale)];
      const root = lowestOf(Number(o.key), t);
      const asc: number[] = [];
      for (let i = 0; ; i++) {
        const m = degree(root, set, i);
        if (m > root + 12 * Number(o.octaves) || m > topOf(t)) break;
        asc.push(m);
      }
      return { bars: toBars(run(upDown(asc), 8, t), t), fretboard: { root: pc(root), set }, allowed: pcsOf(root, set) };
    },
  },
  {
    id: 'S2',
    category: 'Scales',
    name: 'Scale in thirds',
    description: 'Skip one scale note each time: 1-3, 2-4, 3-5 … up the octave and back down.',
    tips: ['Thirds are the building blocks of chords; hear them.', 'Keep it in one position as long as you can.', 'Try it with the metronome on 2 and 4.'],
    kind: 'tab',
    params: [key(0), choice('scale', 'Scale', SCALE_NAMES)],
    build(o, t) {
      const set = SCALE_SETS[String(o.scale)];
      const root = lowestOf(Number(o.key), t);
      const d = (i: number) => degree(root, set, i);
      const L = set.length;
      const up = [...Array(L).keys()].flatMap((i) => [d(i), d(i + 2)]);
      const down = [...Array(L).keys()].reverse().flatMap((i) => [d(i + 2), d(i)]);
      return { bars: toBars(run([...up, ...down, root], 8, t), t), fretboard: { root: pc(root), set }, allowed: pcsOf(root, set) };
    },
  },
  {
    id: 'S3',
    category: 'Scales',
    name: 'Scale sequences',
    description: 'Groups of 3 or 4 scale notes, each group starting one note higher, then the same coming down.',
    tips: ['Accent the first note of each group.', 'Groups of 3 in eighth notes shift against the beat: count it.', 'Great for speed once it is even at a slow tempo.'],
    kind: 'tab',
    params: [key(0), choice('scale', 'Scale', SCALE_NAMES), choice('group', 'Group', ['3', '4'])],
    build(o, t) {
      const set = SCALE_SETS[String(o.scale)];
      const root = lowestOf(Number(o.key), t);
      const d = (i: number) => degree(root, set, i);
      const g = Number(o.group);
      const L = set.length;
      const up = [...Array(L).keys()].flatMap((i) => [...Array(g).keys()].map((j) => d(i + j)));
      const down: number[] = [];
      for (let i = L + g - 2; i >= g - 1; i--) for (let j = 0; j < g; j++) down.push(d(i - j));
      return { bars: toBars(run([...up, ...down], 8, t), t), fretboard: { root: pc(root), set }, allowed: pcsOf(root, set) };
    },
  },
  {
    id: 'S4',
    category: 'Scales',
    name: 'Find the note',
    description: 'Every place one note lives on the neck. Find them all, then play them low to high.',
    tips: ['Octaves: two strings up, two frets up.', 'The 12th fret repeats the open strings.', 'Pick a new note each day.'],
    kind: 'fretboard',
    params: [key(5)],
    build: (o) => ({ bars: [], fretboard: { root: Number(o.key), set: [0] }, allowed: [Number(o.key)] }),
  },
  // ---------- Arpeggios ----------
  {
    id: 'A1',
    category: 'Arpeggios',
    name: 'Triad arpeggio',
    description: 'Root, third and fifth over two octaves and back, from root position or an inversion.',
    tips: ['Major has a major third (4 frets), minor a minor third (3 frets).', 'Inversions start on the third or the fifth.', 'Let each note ring into the next.'],
    kind: 'tab',
    params: [key(0), choice('quality', 'Triad', ['Major', 'Minor', 'Diminished', 'Augmented']), choice('inversion', 'Start on', ['Root', '3rd', '5th'])],
    build(o, t) {
      const set = { Major: [0, 4, 7], Minor: [0, 3, 7], Diminished: [0, 3, 6], Augmented: [0, 4, 8] }[String(o.quality)]!;
      const root = lowestOf(Number(o.key), t);
      const s = ['Root', '3rd', '5th'].indexOf(String(o.inversion));
      const asc = [...Array(7).keys()].map((i) => degree(root, set, s + i)).filter((m) => m <= topOf(t));
      return { bars: toBars(run(upDown(asc), 8, t), t), fretboard: { root: pc(root), set }, allowed: pcsOf(root, set) };
    },
  },
  {
    id: 'A2',
    category: 'Arpeggios',
    name: '7th-chord arpeggio',
    description: 'The four notes of a 7th chord over two octaves and back.',
    tips: ['maj7 sounds dreamy, 7 bluesy, m7 smooth, m7♭5 tense.', 'Know where the 7th sits relative to the root: one fret or two below the octave.', 'These are the notes walking lines are built from.'],
    kind: 'tab',
    params: [key(0), choice('chord', 'Chord', ['maj7', '7', 'm7', 'm7♭5'])],
    build(o, t) {
      const set = { maj7: [0, 4, 7, 11], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], 'm7♭5': [0, 3, 6, 10] }[String(o.chord)]!;
      const root = lowestOf(Number(o.key), t);
      const asc = [...Array(9).keys()].map((i) => degree(root, set, i)).filter((m) => m <= topOf(t));
      return { bars: toBars(run(upDown(asc), 8, t), t), fretboard: { root: pc(root), set }, allowed: pcsOf(root, set) };
    },
  },
  {
    id: 'A3',
    category: 'Arpeggios',
    name: 'Diatonic arpeggios',
    description: 'The chord on every degree of the major key, I through vii, one bar each.',
    tips: ['Major key chords: I ii iii IV V vi vii°.', 'Notice which chords are major and which are minor.', 'Say the Roman numeral as each bar starts.'],
    kind: 'tab',
    params: [key(0), choice('chord', 'Chords', ['Triads', '7ths'])],
    build(o, t) {
      const root = lowestOf(Number(o.key), t);
      const pattern = o.chord === '7ths' ? [0, 2, 4, 6] : [0, 2, 4, 2];
      const evs = [...Array(7).keys()].flatMap((d) => run(pattern.map((n) => degree(root, MAJOR, d + n)), 4, t));
      return { bars: toBars([...evs, { midi: root, dur: 4 }], t), fretboard: { root: pc(root), set: MAJOR }, allowed: pcsOf(root, MAJOR) };
    },
  },
  // ---------- Walking bass ----------
  {
    id: 'WB1',
    category: 'Walking bass',
    name: 'Root, 5th, octave',
    description: 'Four quarter notes per chord: root, fifth, octave, fifth.',
    tips: ['Land on the root on beat 1 of every bar.', 'Keep the notes the same length: connected, not choppy.', 'Count out loud: 1, 2, 3, 4.'],
    kind: 'tab',
    params: [key(0), choice('progression', 'Progression', PROG_NAMES)],
    build: (o, t) => overChords(PROGRESSIONS[String(o.progression)](Number(o.key)), t, (c, r) => q(r, r + c.t5, r + 12, r + c.t5)),
  },
  {
    id: 'WB2',
    category: 'Walking bass',
    name: 'Chord tones',
    description: 'Walk up each chord: 1-3-5-3 or 1-3-5-6.',
    tips: ['The third tells the listener major or minor.', 'The sixth adds a classic 50s/Motown sound.', 'Watch for the minor chords (ii, vi).'],
    kind: 'tab',
    params: [key(0), choice('progression', 'Progression', PROG_NAMES), choice('pattern', 'Pattern', ['1-3-5-3', '1-3-5-6'])],
    build: (o, t) =>
      overChords(PROGRESSIONS[String(o.progression)](Number(o.key)), t, (c, r) => q(r, r + c.t3, r + c.t5, o.pattern === '1-3-5-6' ? r + c.t6 : r + c.t3)),
  },
  {
    id: 'WB3',
    category: 'Walking bass',
    name: 'Chromatic approach',
    description: 'Root, third, fifth, then a half step into the next chord’s root.',
    tips: ['The approach note pulls your ear into the next bar.', 'From below or above: both work.', 'This is the core move of jazz walking.'],
    kind: 'tab',
    params: [key(0), choice('progression', 'Progression', PROG_NAMES)],
    build: (o, t) => overChords(PROGRESSIONS[String(o.progression)](Number(o.key)), t, (c, r, next) => q(r, r + c.t3, r + c.t5, approach(next, t)), true),
  },
  {
    id: 'WB4',
    category: 'Walking bass',
    name: '12-bar blues walk',
    description: 'Chord tones through a 12-bar blues, approaching each chord change by a half step.',
    tips: ['I7 for 4 bars, IV7 for 2, I7 for 2, V7 IV7 I7 V7.', 'Same chord next bar: walk 1-3-5-6.', 'Chord change next bar: approach it chromatically.'],
    kind: 'tab',
    params: [key(9)],
    build: (o, t) =>
      overChords(PROGRESSIONS['12-bar blues'](Number(o.key)), t, (c, r, next) => q(r, r + c.t3, r + c.t5, pc(next) === pc(r) ? r + c.t6 : approach(next, t)), true),
  },
  {
    id: 'WB5',
    category: 'Walking bass',
    name: 'ii-V-I walk',
    description: 'The most common jazz cadence, walked twice: chord tones plus a chromatic approach.',
    tips: ['Major: ii m7, V7, I maj7. Minor: ii m7♭5, V7, i m7.', 'Hear the pull from V to I.', 'Learn it in every key; it shows up everywhere.'],
    kind: 'tab',
    params: [key(0), choice('quality', 'Key type', ['Major', 'Minor'])],
    build(o, t) {
      const k = Number(o.key);
      const minorI: Chord = { root: k, t3: 3, t5: 7, t6: 9, t7: 10 };
      const once =
        o.quality === 'Minor'
          ? [{ root: pc(k + 2), t3: 3, t5: 6, t6: 8, t7: 10 }, dom(k, 7), minorI, minorI]
          : [diatonic(k, 1), dom(k, 7), diatonic(k, 0), diatonic(k, 0)];
      return overChords([...once, ...once], t, (c, r, next) => q(r, r + c.t3, r + c.t5, approach(next, t)), true);
    },
  },
  // ---------- Groove ----------
  {
    id: 'G1',
    category: 'Groove',
    name: '8th-note lock-in',
    description: 'Steady eighth notes on the root (or root and fifth). Lock in with the metronome.',
    tips: ['Turn the metronome on and make it disappear under your notes.', 'Same length, same volume, every note.', 'Rock and punk live here.'],
    kind: 'tab',
    params: [key(4), choice('progression', 'Chords', GROOVE_PROGS), choice('notes', 'Notes', ['Root', 'Root + 5th'])],
    build: (o, t) =>
      overChords(grooveChords(o), t, (c, r) => [r, r, r, r, r, r, o.notes === 'Root' ? r : r + c.t5, o.notes === 'Root' ? r : r + c.t5].map((m) => ({ midi: m, dur: 8 }))),
  },
  {
    id: 'G2',
    category: 'Groove',
    name: '16th funk with ghost notes',
    description: 'Sixteenth-note funk: accented roots and octaves with muted ghost notes in between.',
    tips: ['Ghost notes (x): fret lightly so the string is muted, then pluck.', 'Accents loud, ghosts quiet.', 'Feel the 16ths even when you are not playing them.'],
    kind: 'tab',
    params: [key(4), choice('progression', 'Chords', GROOVE_PROGS)],
    build: (o, t) =>
      overChords(grooveChords(o), t, (_c, r) =>
        'Rx.Rx.xORxRx..Rx'.split('').map((ch) => (ch === '.' ? { midi: null, dur: 16 } : { midi: ch === 'O' ? r + 12 : r, dur: 16, ...(ch === 'x' ? { dead: true } : {}) })),
      ),
  },
  {
    id: 'G3',
    category: 'Groove',
    name: 'Syncopation',
    description: 'Push the next chord early: it arrives on the “and” of beat 4.',
    tips: ['Count “1 and 2 and 3 and 4 and”.', 'The anticipation is the next bar’s root, played early.', 'Rests are part of the groove: stop the string.'],
    kind: 'tab',
    params: [key(9), choice('progression', 'Chords', GROOVE_PROGS, 'I-IV-V-I')],
    build: (o, t) =>
      overChords(grooveChords(o), t, (c, r, next) => [
        { midi: r, dur: 4 },
        { midi: null, dur: 8 },
        { midi: r, dur: 8 },
        { midi: r + c.t5, dur: 4 },
        { midi: null, dur: 8 },
        { midi: next, dur: 8 },
      ]),
  },
  {
    id: 'G4',
    category: 'Groove',
    name: 'Reggae one-drop',
    description: 'Silence on beat 1, the bass drops in on beat 3.',
    tips: ['Resist playing on 1: the space is the groove.', 'Play behind the beat, relaxed.', 'Round, warm tone: pluck near the neck.'],
    kind: 'tab',
    params: [key(7), choice('progression', 'Chords', GROOVE_PROGS)],
    build: (o, t) =>
      overChords(grooveChords(o), t, (c, r) => [
        { midi: null, dur: 2 },
        { midi: r, dur: 4 },
        { midi: r + c.t5, dur: 8 },
        { midi: r, dur: 8 },
      ]),
  },
  {
    id: 'G5',
    category: 'Groove',
    name: 'R&B / Motown',
    description: 'Dotted rhythms bouncing between root, octave and fifth.',
    tips: ['Dotted eighth + sixteenth = long-short.', 'The octave jump should feel effortless: use your index and pinky (or ring).', 'Think James Jamerson.'],
    kind: 'tab',
    params: [key(0), choice('progression', 'Chords', GROOVE_PROGS, 'I-vi-ii-V')],
    build: (o, t) =>
      overChords(grooveChords(o), t, (c, r) => [
        { midi: r, dur: 8, dotted: true },
        { midi: r, dur: 16 },
        { midi: r + 12, dur: 4 },
        { midi: r + c.t5, dur: 8, dotted: true },
        { midi: r + c.t5, dur: 16 },
        { midi: r + 12, dur: 4 },
      ]),
  },
  // ---------- Theory ----------
  {
    id: 'T1',
    category: 'Theory',
    name: 'Intervals from a root',
    description: 'Every place an interval sits above the root, across the whole neck.',
    tips: ['Learn each interval as a shape: the 5th is one string up, two frets up.', 'Say the interval name as you play it.', 'Octave shapes repeat these everywhere.'],
    kind: 'fretboard',
    params: [key(0), choice('interval', 'Interval', INTERVALS.slice(1), '5')],
    build: (o) => ({ bars: [], fretboard: { root: Number(o.key), set: [0, INTERVALS.indexOf(String(o.interval))] }, allowed: [] }),
  },
  {
    id: 'T2',
    category: 'Theory',
    name: 'Diatonic chords',
    description: 'The chord tones of any degree of a major key, shown on the neck.',
    tips: ['I, IV, V are major; ii, iii, vi minor; vii° diminished.', 'Find the root first, then the third tells you the quality.', 'Pair it with the diatonic arpeggios exercise.'],
    kind: 'fretboard',
    params: [key(0), choice('degree', 'Degree', ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']), choice('chord', 'Chord', ['Triad', '7th'])],
    build(o) {
      const c = diatonic(Number(o.key), ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'].indexOf(String(o.degree)));
      return { bars: [], fretboard: { root: c.root, set: o.chord === '7th' ? [0, c.t3, c.t5, c.t7] : [0, c.t3, c.t5] }, allowed: [] };
    },
  },
];
```

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test shared/exercises.test.ts`
Expected: all tests pass. Likely failures and fixes:
- `pitch … is off the neck`: a generator went below `t[0]`; raise that start by an octave.
- `beat crosses a bar line`: a per-bar pattern doesn't add up to 16 sixteenths; recount it.
- alphaTex note count mismatch: print the tex for that combo and fix `toAlphaTex`.
- Runtime over ~20 s: limit the alphaTex parse to keys 0 and 7 (`if (Number(o.key) % 7 === 0)`), keep the other checks for every combo.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all existing tests + the new ones pass.

- [ ] **Step 6: Commit**

```bash
git add shared/exercises.ts shared/exercises.test.ts
git commit -m "Practice: 22 bass exercises (warm-up, scales, arpeggios, walking, groove, theory)"
```

---

### Task 4: Fretboard `forced` prop

**Files:**
- Modify: `src/Fretboard.tsx`

- [ ] **Step 1: Change the signature and effective values** (`src/Fretboard.tsx:37` onward)

Replace the component's first lines and the derived values:

```tsx
/** Practice mode drives the board: follow this track, show these resting dots; the saved prefs aren't changed. */
export interface ForcedBoard {
  follow: number;
  root: number;
  set: number[];
}

export function Fretboard({ api, score, forced }: { api: alphaTab.AlphaTabApi | null; score: alphaTab.model.Score | null; forced?: ForcedBoard }) {
  const [saved, setP] = useState<Prefs>(loadPrefs);
  const p: Prefs = forced ? { ...saved, follow: forced.follow, root: forced.root, inst: 'bass' } : saved;
  const [playing, setPlaying] = useState<Spot[]>([]);
  const set = (patch: Partial<Prefs>) => setP((old) => ({ ...old, ...patch }));

  useEffect(() => {
    try {
      localStorage.setItem(PREF, JSON.stringify(saved));
    } catch {
      /* storage blocked */
    }
  }, [saved]);
```

and replace the `scale`/`arp` lines (`src/Fretboard.tsx:81-82`):

```tsx
  const scale = forced ? forced.set : (SCALES[p.scale] ?? []);
  const arp = forced ? [] : (ARPEGGIOS[p.arp] ?? []);
```

- [ ] **Step 2: Hide the controls practice owns**

In the JSX, wrap the Follow `<label>` and the instrument/tuning block, and the Root, Scale and Arpeggio labels so they render only when `!forced`:

```tsx
        {!forced && (
          <label>
            Follow
            {/* existing select unchanged */}
          </label>
        )}
        {!forced && !following && (
          <>{/* existing instrument + tuning controls unchanged */}</>
        )}
        {!forced && (
          <>
            {/* existing Root, Scale, Arpeggio labels unchanged */}
          </>
        )}
```

Labels, Frets, Roots and Left-handed stay visible in both modes (they edit `saved`, so they persist).

The svg `aria-label` uses `p.scale`; in forced mode make it `forced ? 'Practice fretboard' : …existing…` so it doesn't name the Tab-mode scale.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/Fretboard.tsx
git commit -m "Fretboard: forced mode for practice (locked follow + resting dots, prefs untouched)"
```

---

### Task 5: Practice view

**Files:**
- Create: `src/Practice.tsx`
- Modify: `src/styles.css` (append)

- [ ] **Step 1: Write `src/Practice.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import type * as alphaTab from '@coderline/alphatab';
import { ScoreView } from './ScoreView';
import { Fretboard } from './Fretboard';
import { allParams, CATEGORIES, EXERCISES, sanitize, toAlphaTex, tuningOf, type Built, type Opts, type ParamSpec } from '../shared/exercises';
import { ROOTS } from '../shared/music';

const PLAYING = 1; // alphaTab.synth.PlayerState.Playing

function load(k: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(`tabshare.practice.${k}`) ?? 'null');
  } catch {
    return null;
  }
}
function save(k: string, v: unknown) {
  try {
    localStorage.setItem(`tabshare.practice.${k}`, JSON.stringify(v));
  } catch {
    /* per-session only */
  }
}

interface SpeedUp {
  on: boolean;
  step: number;
  target: number;
}

function Param({ p, value, onChange }: { p: ParamSpec; value: string | number; onChange: (v: string | number) => void }) {
  if (p.kind === 'key')
    return (
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {ROOTS.map((r, i) => (
          <option key={r} value={i}>
            {r}
          </option>
        ))}
      </select>
    );
  if (p.kind === 'choice')
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {p.options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  return (
    <span className="practice-num">
      <input type="range" min={p.min} max={p.max} step={p.step ?? 1} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="mono">{value}</span>
    </span>
  );
}

/** Practice mode: generated bass exercises with their own player (never synced to the room). */
export function Practice({ tunerOn, onToggleTuner }: { tunerOn: boolean; onToggleTuner: () => void }) {
  const [exId, setExId] = useState(() => {
    const id = load('exercise');
    return EXERCISES.some((e) => e.id === id) ? (id as string) : EXERCISES[0].id;
  });
  const ex = EXERCISES.find((e) => e.id === exId)!;
  const [opts, setOpts] = useState<Opts>(() => sanitize(ex, load(ex.id)));
  const pick = (id: string) => {
    const next = EXERCISES.find((e) => e.id === id)!;
    setExId(id);
    setOpts(sanitize(next, load(id)));
    save('exercise', id);
  };
  const change = (id: string, v: string | number) =>
    setOpts((o) => {
      const n = { ...o, [id]: v };
      save(exId, n);
      return n;
    });

  const [showTips, setShowTips] = useState(() => load('tips') !== false);
  const [loop, setLoop] = useState(true);
  const [metronome, setMetronome] = useState(false);
  const [countIn, setCountIn] = useState(false);
  const [speedUp, setSpeedUp] = useState<SpeedUp>(() => ({ on: false, step: 2, target: 120, ...((load('speedup') as Partial<SpeedUp>) ?? {}) }));
  const changeSpeedUp = (patch: Partial<SpeedUp>) =>
    setSpeedUp((s) => {
      const n = { ...s, ...patch };
      save('speedup', n);
      return n;
    });

  const [api, setApi] = useState<alphaTab.AlphaTabApi | null>(null);
  const [score, setScore] = useState<alphaTab.model.Score | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [liveTempo, setLiveTempo] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const tuning = tuningOf(opts);
  const base = Number(opts.tempo) || 80;
  const built = useMemo<Built | Error>(() => {
    try {
      return ex.build(opts, tuning);
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
    // tuning is derived from opts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ex, opts]);
  const data = useMemo(() => {
    if (ex.kind !== 'tab' || built instanceof Error) return null;
    return new TextEncoder().encode(toAlphaTex(built, { tempo: base, tuning, title: ex.name })).buffer as ArrayBuffer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ex, built, base]);

  useEffect(() => {
    if (!api) return;
    const offs = [
      api.scoreLoaded.on((s) => {
        setScore(s);
        setLoadError(null);
      }),
      api.playerReady.on(() => setReady(true)),
      api.playerStateChanged.on((e) => setPlaying(e.state === PLAYING)),
    ];
    return () => offs.forEach((off) => off());
  }, [api]);
  useEffect(() => {
    if (api) api.isLooping = loop;
  }, [api, loop, data]);
  useEffect(() => {
    if (api) api.metronomeVolume = metronome ? 1 : 0;
  }, [api, metronome]);
  useEffect(() => {
    if (api) api.countInVolume = countIn ? 1 : 0;
  }, [api, countIn]);

  // Speed trainer: every time the loop wraps, raise the tempo by `step` until `target` (via playbackSpeed, so the
  // score isn't regenerated mid-play).
  const speedRef = useRef(speedUp);
  speedRef.current = speedUp;
  const tempoRef = useRef(base);
  useEffect(() => {
    if (!api) return;
    tempoRef.current = base;
    api.playbackSpeed = 1;
    setLiveTempo(null);
    let last = 0;
    return api.playerPositionChanged.on((e) => {
      const s = speedRef.current;
      if (s.on && api.playerState === PLAYING && e.currentTick < last - 960) {
        tempoRef.current = Math.min(Math.max(s.target, base), tempoRef.current + s.step);
        api.playbackSpeed = tempoRef.current / base;
        setLiveTempo(tempoRef.current);
      }
      last = e.currentTick;
    });
  }, [api, base, data]);

  const playPause = () => {
    if (api && ready) api.playPause();
  };
  const stop = () => {
    if (!api) return;
    api.stop();
    tempoRef.current = base;
    api.playbackSpeed = 1;
    setLiveTempo(null);
  };
  const playRef = useRef(playPause);
  playRef.current = playPause;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        playRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const board = built instanceof Error ? undefined : { follow: 0, ...built.fretboard };
  const error = built instanceof Error ? `Could not build this exercise: ${built.message}` : loadError;

  return (
    <div className="practice">
      <div className="practice-bar">
        <label>
          Exercise
          <select value={exId} onChange={(e) => pick(e.target.value)}>
            {CATEGORIES.map((c) => (
              <optgroup key={c} label={c}>
                {EXERCISES.filter((x) => x.category === c).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {allParams(ex).map((p) => (
          <label key={p.id}>
            {p.label}
            <Param p={p} value={opts[p.id]} onChange={(v) => change(p.id, v)} />
          </label>
        ))}
        <button className="link small" onClick={() => (setShowTips(!showTips), save('tips', !showTips))}>
          {showTips ? 'Hide tips' : 'Tips'}
        </button>
      </div>
      {showTips && (
        <div className="practice-info">
          <p>{ex.description}</p>
          <ul>
            {ex.tips.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {error && <div className="banner error">{error}</div>}
      {ex.kind === 'tab' ? (
        <ScoreView data={data} ext="tex" peers={[]} onApi={setApi} onPointer={() => {}} onSelection={() => {}} onLoadError={setLoadError} />
      ) : (
        <div className="practice-spacer" />
      )}
      {board && <Fretboard api={ex.kind === 'tab' ? api : null} score={ex.kind === 'tab' ? score : null} forced={board} />}
      <div className="transport practice-transport">
        {ex.kind === 'tab' && (
          <>
            <div className="tp-group">
              <button className="tp-btn" onClick={stop} disabled={!ready} title="Stop">
                ■
              </button>
              <button className="tp-btn play" onClick={playPause} disabled={!ready || !score} title="Play / pause (space)">
                {playing ? '❚❚' : '▶'}
              </button>
              <span className="mono time">♩ = {liveTempo ?? base}</span>
            </div>
            <div className="tp-group">
              <button className={`tp-toggle ${loop ? 'on' : ''}`} onClick={() => setLoop(!loop)}>
                ⟲ Loop
              </button>
              <button className={`tp-toggle ${metronome ? 'on' : ''}`} onClick={() => setMetronome(!metronome)}>
                Metronome
              </button>
              <button className={`tp-toggle ${countIn ? 'on' : ''}`} onClick={() => setCountIn(!countIn)}>
                Count-in
              </button>
            </div>
            <div className="tp-group">
              <button className={`tp-toggle ${speedUp.on ? 'on' : ''}`} onClick={() => changeSpeedUp({ on: !speedUp.on })} title="Raise the tempo every time the loop comes around">
                Speed up each loop
              </button>
              {speedUp.on && (
                <span className="small muted">
                  +<input className="practice-small" type="number" min={1} max={20} value={speedUp.step} onChange={(e) => changeSpeedUp({ step: Number(e.target.value) || 1 })} /> BPM up to{' '}
                  <input className="practice-small" type="number" min={40} max={300} value={speedUp.target} onChange={(e) => changeSpeedUp({ target: Number(e.target.value) || base })} />
                </span>
              )}
            </div>
            {!ready && <span className="small muted">loading sounds…</span>}
          </>
        )}
        <div className="tp-group">
          <button className={`tp-toggle ${tunerOn ? 'on' : ''}`} onClick={onToggleTuner} title="Chromatic tuner (uses your rig input or microphone)">
            Tuner
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append styles** to `src/styles.css`

```css
/* ---------- practice mode ---------- */
.stage-bar { display: flex; align-items: center; gap: 10px; padding: 8px 16px; background: var(--bg); border-bottom: 1px solid var(--line); }
.tab-view { flex: 1; display: flex; flex-direction: column; min-height: 0; }
/* Practice keeps the tab mounted (no reload, same position) but out of sight; visibility keeps its size, so alphaTab
   doesn't re-lay out at 0 px. */
.stage { position: relative; }
.tab-view.off { position: absolute; inset: 0; visibility: hidden; pointer-events: none; }
.tab-view > .banner, .practice > .banner { margin: 10px 16px 0; }
.practice { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.practice-bar { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: end; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--bg); font-size: 12px; color: var(--muted); }
.practice-bar label { display: grid; gap: 3px; }
.practice-num { display: flex; gap: 6px; align-items: center; }
.practice-num input { width: 110px; }
.practice-num .mono { min-width: 28px; color: var(--text); }
.practice-info { padding: 8px 16px; font-size: 13px; border-bottom: 1px solid var(--line); background: var(--bg-2); }
.practice-info p { margin: 0 0 4px; }
.practice-info ul { margin: 0; padding-left: 18px; color: var(--muted); }
.practice-spacer { flex: 1; }
.practice-transport { grid-area: auto; }
.practice-small { width: 52px; }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If `.on()` isn't typed as returning an unsubscribe function, use the same pattern as `Room.tsx:227`.)

- [ ] **Step 4: Commit**

```bash
git add src/Practice.tsx src/styles.css
git commit -m "Practice view: picker, tips, own player, fretboard, speed trainer"
```

---

### Task 6: Room integration

**Files:**
- Modify: `src/Room.tsx` (imports; state near `src/Room.tsx:126`; Space handler `src/Room.tsx:453-465`; JSX `src/Room.tsx:830-941`)

- [ ] **Step 1: Import and state**

```tsx
import { Practice } from './Practice';
```

Next to `showFretboard` state:

```tsx
  // Tab | Practice. Practice is solo: its own player; the room's tab stays loaded but paused and muted.
  const [mode, setMode] = useState<'tab' | 'practice'>(() => (readPref('practice.mode') === 'practice' ? 'practice' : 'tab'));
  const switchMode = (m: 'tab' | 'practice') => {
    setMode(m);
    writePref('practice.mode', m);
  };
  useEffect(() => {
    if (!api) return;
    if (mode === 'practice') api.pause();
    // Muted, not stopped: remote jam play/seek still moves the hidden tab, so coming back rejoins the jam.
    api.masterVolume = mode === 'practice' ? 0 : 1;
  }, [api, mode]);
```

- [ ] **Step 2: Space key only drives the tab in Tab mode**

In the Space handler effect (`src/Room.tsx:453`): add `if (mode === 'practice') return;` as the first line of `onKey`, and add `mode` to the effect's dependency array: `}, [playPause, mode]);`

- [ ] **Step 3: JSX**

Replace the `<main className="stage">` block (`src/Room.tsx:830-869`) with:

```tsx
      <main className="stage">
        <CallPanel call={call} profile={profile} />
        <div className="stage-bar">
          <div className="seg-mini" role="group" aria-label="Mode">
            <button className={mode === 'tab' ? 'on' : ''} onClick={() => switchMode('tab')}>
              Tab
            </button>
            <button className={mode === 'practice' ? 'on' : ''} onClick={() => switchMode('practice')}>
              Practice
            </button>
          </div>
        </div>
        <div className={`tab-view ${mode === 'practice' ? 'off' : ''}`} aria-hidden={mode === 'practice'}>
          {/* existing children, unchanged: error banner, song-head, ScoreView, Fretboard */}
        </div>
        {mode === 'practice' && <Practice tunerOn={showTuner} onToggleTuner={() => setShowTuner((v) => !v)} />}
      </main>
```

and render the tab footer only in Tab mode: `{mode === 'tab' && (<footer className="transport">…existing…</footer>)}`.

- [ ] **Step 4: Typecheck, unit tests, build**

Run: `npm run typecheck && npm test && npx vite build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/Room.tsx
git commit -m "Room: Tab | Practice switch (tab stays loaded, paused and muted while practicing)"
```

---

### Task 7: Browser check (Playwright, not committed)

**Files:**
- Create: `.playwright-mcp/practice.mjs` (gitignored)

- [ ] **Step 1: Write the script**

```js
// Practice mode end to end: two users, A has a tab loaded and jam on; A switches to Practice.
// Usage: npm run dev, then: node .playwright-mcp/practice.mjs
import { chromium } from '../desktop/node_modules/playwright-core/index.mjs';

const url = 'http://localhost:5173';
const api = 'http://localhost:3001';
let failed = false;
const fail = (m) => ((failed = true), console.error('FAIL:', m));
const ok = (m) => console.log('ok:', m);
const post = (p, body, headers = {}) => fetch(api + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then((r) => r.json());

const { token } = await post('/api/admin/login', { username: 'admin', password: 'devadmin' });
const admin = { authorization: `Bearer ${token}` };
const { roomId } = await post('/api/rooms', { name: 'Practice test', password: 'smoke1234' }, admin);
const join = await post(`/api/rooms/${roomId}/join`, { password: 'smoke1234' });
const tex = '\\title "Room riff"\n\\tempo 100\n.\n\\track "Guitar"\n\\staff {tabs}\n\\tuning e5 b4 g4 d4 a3 e3\n:8 0.6 3.6 5.6 0.6 3.6 6.6 5.6 r | 0.6 3.6 5.6 3.6 0.6 r r r |';
await fetch(`${api}/api/rooms/${roomId}/tabs?name=riff.tex`, { method: 'POST', headers: { 'x-room-token': join.token, 'content-type': 'application/octet-stream' }, body: tex });

const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const enter = async (name) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`${name} page error: ${e.message}`));
  await page.goto(`${url}/#/r/${roomId}`);
  await page.getByPlaceholder('e.g. Corey').fill(name);
  await page.locator('input[type=password]').first().fill('smoke1234');
  await page.locator('button.btn.primary.big').click();
  await page.locator('.song-head h2').waitFor({ timeout: 15000 });
  return page;
};
try {
  const A = await enter('Corey');
  const B = await enter('Mike');

  await A.getByRole('button', { name: 'Practice', exact: true }).click();
  await A.locator('.practice .score-paper svg').first().waitFor({ timeout: 15000 });
  ok('practice renders an exercise');
  if (await A.locator('footer.transport').count()) fail('tab transport still shown in practice');

  // Change the key: the tab re-renders with different frets.
  const frets = () => A.evaluate(() => [...document.querySelectorAll('.practice .at-surface text')].map((t) => t.textContent).join(','));
  const before = await frets();
  await A.getByLabel('Key').selectOption({ label: 'G' });
  await A.waitForTimeout(1500);
  if ((await frets()) === before) fail('key change did not re-render');
  else ok('key change re-renders');

  // Play: the fretboard lights a note.
  await A.locator('.practice .tp-btn.play').click();
  await A.locator('.practice .fb-dot.playing').first().waitFor({ timeout: 15000 });
  ok('fretboard follows playback');

  // A jam play from Mike must not touch the practice player.
  await B.locator('.tp-btn.play').click();
  await A.waitForTimeout(1500);
  if (await A.locator('.practice .tp-btn.play', { hasText: '❚❚' }).count()) ok('practice still playing its own exercise');
  await A.locator('.practice .tp-btn').first().click(); // stop

  // Back to Tab: same tab still loaded, no reload.
  await A.getByRole('button', { name: 'Tab', exact: true }).click();
  const title = await A.locator('.song-head h2').textContent();
  if (title !== 'Room riff') fail(`tab title after switching back: ${title}`);
  else ok('tab still loaded after practice');
  if (!(await A.locator('footer.transport').count())) fail('tab transport missing after switching back');
  await A.screenshot({ path: '.playwright-mcp/practice-back.png' });
} catch (e) {
  fail(e.stack ?? String(e));
} finally {
  await browser.close();
  await fetch(`${api}/api/admin/rooms/${roomId}`, { method: 'DELETE', headers: admin });
  console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exitCode = failed ? 1 : 0;
}
```

- [ ] **Step 2: Run against `npm run dev`**

Run: `npm run dev` (background, from the repo root), then `node .playwright-mcp/practice.mjs`.
Expected: `RESULT: PASS`. Then stop the dev server and kill orphan node processes (CLAUDE.md "Windows gotcha").

- [ ] **Step 3: Visual check** with screenshots of Practice at 1400×900 and 390×844 (phone): picker wraps, fretboard scrolls sideways, no horizontal page scroll. Fix CSS if needed and commit any change:

```bash
git add src/styles.css
git commit -m "Practice: layout fixes from the browser check"
```

---

### Task 8: Docs, deploy, notes

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.local/NOTES.md` (private repo)

- [ ] **Step 1: CLAUDE.md** — add to **Layout**:

```markdown
- `shared/exercises.ts` + `src/Practice.tsx`: **Practice mode** (Tab | Practice switch in the stage bar). 22 bass
  exercises generated from key/options/tuning/tempo: notes → `place()` (5-fret hand position) → 4/4 bars →
  `toAlphaTex` (the only alphaTex writer). Practice has its own ScoreView/alphaTab api (solo, never synced) and the
  Fretboard in `forced` mode. Room keeps the tab view mounted but hidden (`.tab-view.off`) and paused + muted
  (`masterVolume = 0`) while practicing, so remote jam moves still update it. Settings per exercise in
  `tabshare.practice.<id>`. Tests: `shared/exercises.test.ts` builds every exercise × key × option × tuning and parses
  the alphaTex in Node.
```

and remove "Bar-range loop presets, A/B loop markers, speed-up-each-loop trainer." from Roadmap → replace with "Bar-range loop presets, A/B loop markers (practice mode has a speed-up trainer)."

- [ ] **Step 2: Verify and commit**

Run: `npm run typecheck && npm test && npx vite build`
Expected: pass.

```bash
git add CLAUDE.md
git commit -m "CLAUDE.md: practice mode"
git push
```

- [ ] **Step 3: Deploy** (per `.local/NOTES.md`): wait for the image build (`gh run watch …`), then `npm run deploy`; check the live site loads and Practice renders an exercise.

- [ ] **Step 4: Progress log** in `.local/NOTES.md` (newest first, absolute date): what shipped, what was verified, what wasn't (real bass playing along, phone layout on a real device). Commit + push the notes repo.
