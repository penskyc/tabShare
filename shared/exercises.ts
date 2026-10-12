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

export const EXERCISES: Exercise[] = [];
void INTERVALS;
void SCALES;
