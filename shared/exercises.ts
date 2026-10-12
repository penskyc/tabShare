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

export const pc = (m: number) => ((m % 12) + 12) % 12;

/** One beat before placement: a pitch (null = rest), or a fixed string/fret for shape drills. */
interface Ev {
  midi: number | null;
  dur: Dur;
  dotted?: boolean;
  dead?: boolean;
  at?: { string: number; fret: number };
}
const sixteenths = (n: PracticeNote) => (16 / n.duration) * (n.dotted ? 1.5 : 1);

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
  bars: toBars(
    cells.map((at) => ({ midi: t[at.string] + at.fret, dur, at })),
    t,
  ),
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
      const bar = (s: number) => [0, 1, 2, 3].flatMap(() => [
        { string: s, fret: f },
        { string: s + 2, fret: f },
      ]);
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
      const set = ({ Major: [0, 4, 7], Minor: [0, 3, 7], Diminished: [0, 3, 6], Augmented: [0, 4, 8] } as Record<string, number[]>)[String(o.quality)];
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
      const set = ({ maj7: [0, 4, 7, 11], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], 'm7♭5': [0, 3, 6, 10] } as Record<string, number[]>)[String(o.chord)];
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
      overChords(grooveChords(o), t, (c, r) =>
        [r, r, r, r, r, r, o.notes === 'Root' ? r : r + c.t5, o.notes === 'Root' ? r : r + c.t5].map((m): Ev => ({ midi: m, dur: 8 })),
      ),
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
        'Rx.Rx.xORxRx..Rx'.split('').map((ch): Ev => (ch === '.' ? { midi: null, dur: 16 } : { midi: ch === 'O' ? r + 12 : r, dur: 16, ...(ch === 'x' ? { dead: true } : {}) })),
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
