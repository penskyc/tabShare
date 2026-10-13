// Drums mode: seeded, style-based drum grooves arranged into song sections, written as alphaTex percussion.
// Design: docs/superpowers/specs/2026-10-13-drums-mode-design.md

export const SECTION_TYPES = ['intro', 'verse', 'prechorus', 'chorus', 'bridge', 'solo', 'breakdown', 'outro'] as const;
export type DrumSectionType = (typeof SECTION_TYPES)[number];
export const SECTION_LABELS: Record<DrumSectionType, string> = {
  intro: 'Intro',
  verse: 'Verse',
  prechorus: 'Pre-chorus',
  chorus: 'Chorus',
  bridge: 'Bridge',
  solo: 'Solo',
  breakdown: 'Breakdown',
  outro: 'Outro',
};

export interface DrumSection {
  type: DrumSectionType;
  bars: number;
  /** uint32; the whole groove of the section follows from it. */
  seed: number;
}
export interface DrumSong {
  style: string;
  tempo: number;
  sections: DrumSection[];
}

/** General MIDI drum numbers (what alphaTex percussion notes are written as). */
export const KIT = {
  kick: 36,
  stick: 37,
  snare: 38,
  hat: 42,
  pedal: 44,
  open: 46,
  crash: 49,
  ride: 51,
  bell: 53,
  cowbell: 56,
  tom1: 50,
  tom2: 47,
  tom3: 45,
  tom4: 43,
} as const;
type Inst = keyof typeof KIT;

export interface DrumHit {
  n: number;
  g?: true; // ghost
  a?: true; // accent
}
export type Ts = '4/4' | '12/8';

/** One pattern: per instrument, a step string — x hit, g ghost, a accent, . nothing. */
type Pattern = Partial<Record<Inst, string>>;
type Mutation = 'kickPush' | 'ghosts' | 'openHat' | 'hat16' | 'kickDouble';
type Feel = 'sparse' | 'main' | 'big';
interface Style {
  label: string;
  ts: Ts;
  tempo: number;
  sparse: Pattern[];
  main: Pattern[];
  big: Pattern[];
  fills: Pattern[];
  mutations: Mutation[];
}

const H8 = 'x.x.x.x.x.x.x.x.';
const H16 = 'xxxxxxxxxxxxxxxx';
const BACK = '....x.......x...';
const BACK_A = '....a.......a...';
// 4/4 fills: the last beat or the last two beats (earlier steps are ignored).
const FILLS_44: Pattern[] = [
  { snare: '............xxxx' },
  { snare: '............xx..', tom1: '..............x.', tom3: '...............x' },
  { snare: '........xx......', tom1: '..........xx....', tom2: '............xx..', tom4: '..............xx', kick: '........x.......' },
  { snare: '........x.x.x.x.', kick: '.........x.x.x.x' },
  { tom1: '........xx......', tom2: '..........xx....', tom3: '............xx..', tom4: '..............xx' },
  { snare: '............a.a.', kick: '............x.x.', tom4: '.............x.x' },
];
// 12/8 fills: last beat (3 steps) or last two beats (6 steps).
const FILLS_128: Pattern[] = [
  { snare: '.........xxx' },
  { snare: '......xxx...', tom1: '.........x..', tom3: '..........x.', tom4: '...........x' },
  { snare: '......x.xx.x', kick: '.......x..x.' },
  { tom1: '......xx....', tom3: '........xx..', tom4: '..........xx' },
];

export const STYLES: Record<string, Style> = {
  rock: {
    label: 'Rock',
    ts: '4/4',
    tempo: 110,
    sparse: [
      { hat: H8, kick: 'x.......x.......' },
      { hat: H8, kick: 'x.......x.......', stick: '....x.......x...' },
      { ride: H8, kick: 'x...............' },
    ],
    main: [
      { hat: H8, kick: 'x.......x.x.....', snare: BACK },
      { hat: H8, kick: 'x.....x.x.......', snare: BACK },
      { hat: H8, kick: 'x.x.....x.x.....', snare: BACK },
      { hat: H8, kick: 'x.......x.....x.', snare: BACK },
    ],
    big: [
      { ride: H8, kick: 'x.......x.x.....', snare: BACK_A },
      { hat: 'x...x...x...x...', open: '..x...x...x...x.', kick: 'x.......x.x.....', snare: BACK_A },
      { ride: 'x.x.x.x.x.x.x.x.', bell: 'x...x...x...x...', kick: 'x.x.....x.x.....', snare: BACK_A },
    ],
    fills: FILLS_44,
    mutations: ['kickPush', 'openHat', 'kickDouble'],
  },
  pop: {
    label: 'Pop',
    ts: '4/4',
    tempo: 100,
    sparse: [
      { hat: H8, kick: 'x.......x.......' },
      { hat: H16, kick: 'x...............', stick: '....x.......x...' },
    ],
    main: [
      { hat: H16, kick: 'x.......x.x.....', snare: BACK },
      { hat: H8, kick: 'x..x....x.......', snare: BACK },
      { hat: H16, kick: 'x......x..x.....', snare: BACK },
    ],
    big: [
      { open: '..x...x...x...x.', hat: 'x...x...x...x...', kick: 'x...x...x...x...', snare: BACK_A },
      { ride: H8, kick: 'x.......x.x.....', snare: BACK_A },
      { hat: H16, kick: 'x...x...x...x...', snare: BACK_A },
    ],
    fills: FILLS_44,
    mutations: ['kickPush', 'hat16', 'openHat'],
  },
  funk: {
    label: 'Funk',
    ts: '4/4',
    tempo: 100,
    sparse: [
      { hat: H16, kick: 'x..x......x.....' },
      { hat: H16, kick: 'x.........x.....', snare: '.......g.g......' },
    ],
    main: [
      { hat: H16, kick: 'x..x..x...x..x..', snare: '....x..g.g..x..g' },
      { hat: H16, kick: 'x.x...x...x.x...', snare: '....x.g..g..x...' },
      { hat: H16, kick: 'x......x.x.x....', snare: '.g..x..g.g.gx..g' },
    ],
    big: [
      { hat: H16, open: '......x.......x.', kick: 'x..x..x...x..x..', snare: '....a..g.g..a..g' },
      { ride: H8, kick: 'x.x...x...x.x...', snare: '....a.g..g..a...' },
    ],
    fills: FILLS_44,
    mutations: ['ghosts', 'kickPush', 'openHat'],
  },
  blues: {
    label: 'Blues shuffle',
    ts: '12/8',
    tempo: 90,
    sparse: [
      { hat: 'x.xx.xx.xx.x', kick: 'x.....x.....' },
      { ride: 'x.xx.xx.xx.x', kick: 'x...........' },
    ],
    main: [
      { hat: 'x.xx.xx.xx.x', kick: 'x.....x.....', snare: '...x.....x..' },
      { hat: 'x.xx.xx.xx.x', kick: 'x.x...x.x...', snare: '...x.....x..' },
      { ride: 'x.xx.xx.xx.x', kick: 'x.....x.....', snare: '...x.....x..' },
    ],
    big: [
      { ride: 'x.xx.xx.xx.x', kick: 'x.x...x.x...', snare: '...a.....a..' },
      { hat: 'x.xx.xx.xx.x', open: '...x.....x..', kick: 'x.....x.....', snare: '...a.....a..' },
    ],
    fills: FILLS_128,
    mutations: ['ghosts', 'kickPush'],
  },
  punk: {
    label: 'Punk',
    ts: '4/4',
    tempo: 170,
    sparse: [{ hat: H8, kick: 'x...x...x...x...' }],
    main: [
      { hat: H8, kick: 'x.x...x.x.x...x.', snare: BACK },
      { hat: H8, kick: 'x...x...x...x...', snare: '..x...x...x...x.' },
    ],
    big: [
      { ride: H8, kick: 'x...x...x...x...', snare: '..a...a...a...a.' },
      { hat: H8, kick: 'x.x.x.x.x.x.x.x.', snare: BACK_A },
    ],
    fills: FILLS_44,
    mutations: ['kickPush'],
  },
  metal: {
    label: 'Metal',
    ts: '4/4',
    tempo: 140,
    sparse: [
      { ride: H8, kick: 'x.......x.......' },
      { hat: H8, kick: 'x.x.x.x.x.x.x.x.' },
    ],
    main: [
      { hat: H8, kick: 'x.x.x.x.x.x.x.x.', snare: BACK },
      { hat: H8, kick: 'xx..xx..xx..xx..', snare: BACK },
    ],
    big: [
      { ride: H8, kick: H16, snare: BACK_A },
      { hat: H8, kick: H16, snare: '..a...a...a...a.' },
    ],
    fills: FILLS_44,
    mutations: ['kickDouble'],
  },
  reggae: {
    label: 'Reggae',
    ts: '4/4',
    tempo: 75,
    sparse: [{ hat: H8, stick: '........x.......' }],
    main: [
      { hat: H8, kick: '........x.......', stick: '........x.......' },
      { hat: 'x.xxx.xxx.xxx.xx', kick: '........x.......', stick: '........x.......' },
    ],
    big: [
      { hat: H8, kick: 'x...x...x...x...', snare: '........a.......' },
      { open: '..x...x...x...x.', kick: 'x...x...x...x...', snare: BACK_A },
    ],
    fills: [{ snare: '............x.x.', tom3: '.............x.x' }, FILLS_44[0]],
    mutations: ['openHat'],
  },
  hiphop: {
    label: 'Hip-hop',
    ts: '4/4',
    tempo: 90,
    sparse: [{ hat: H8, kick: 'x......x..x.....' }],
    main: [
      { hat: H8, kick: 'x......x..x.....', snare: BACK },
      { hat: H8, kick: 'x.x.......x..x..', snare: '....x.......x..g' },
      { hat: H16, kick: 'x......x.xx.....', snare: BACK },
    ],
    big: [
      { hat: H16, open: '..............x.', kick: 'x......x..x..x..', snare: BACK_A },
      { hat: H8, kick: 'x.x....x..x.....', snare: BACK_A },
    ],
    fills: [FILLS_44[0], FILLS_44[5]],
    mutations: ['ghosts', 'kickPush', 'openHat'],
  },
  train: {
    label: 'Train beat',
    ts: '4/4',
    tempo: 120,
    sparse: [{ snare: 'g.g.g.g.g.g.g.g.', kick: 'x.......x.......' }],
    main: [
      { snare: 'ggggagggggggaggg', kick: 'x.......x.......' },
      { snare: 'g.g.a.g.g.g.a.g.', kick: 'x.......x.......', hat: '..x...x...x...x.' },
    ],
    big: [
      { snare: 'ggggagggggggaggg', kick: 'x.......x.......', ride: H8 },
      { snare: 'g.g.a.g.g.g.a.g.', kick: 'x...x...x...x...', hat: H8 },
    ],
    fills: [FILLS_44[0], FILLS_44[3]],
    mutations: ['kickPush'],
  },
  jazz: {
    label: 'Jazz swing',
    ts: '12/8',
    tempo: 130,
    sparse: [
      { ride: 'x..x.xx..x.x', pedal: '...x.....x..' },
      { ride: 'x..x.xx..x.x', pedal: '...x.....x..', kick: 'g..g..g..g..' },
    ],
    main: [
      { ride: 'x..x.xx..x.x', pedal: '...x.....x..', kick: 'g..g..g..g..', snare: '.....g......' },
      { ride: 'x..x.xx..x.x', pedal: '...x.....x..', kick: 'g..g..g..g..', snare: '........g..g' },
    ],
    big: [
      { ride: 'x..x.xx..x.x', bell: 'x.....x.....', pedal: '...x.....x..', kick: 'g..g..g..g..', snare: '..g.....g...' },
      { ride: 'x..x.xx..x.x', pedal: '...x.....x..', kick: 'x.....x.....', snare: '.....a.....g' },
    ],
    fills: [FILLS_128[0], FILLS_128[2]],
    mutations: ['ghosts'],
  },
};

const FEEL: Record<DrumSectionType, Feel> = {
  intro: 'sparse',
  breakdown: 'sparse',
  outro: 'sparse',
  verse: 'main',
  prechorus: 'main',
  solo: 'main',
  chorus: 'big',
  bridge: 'big',
};

/** mulberry32: small, fast, deterministic. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rand = ReturnType<typeof rng>;
const pick = <T>(r: Rand, list: readonly T[]) => list[Math.floor(r() * list.length)];

const stepsOf = (ts: Ts) => (ts === '4/4' ? 16 : 12);

function toGrid(p: Pattern, n: number): DrumHit[][] {
  const grid: DrumHit[][] = Array.from({ length: n }, () => []);
  for (const [inst, steps] of Object.entries(p) as [Inst, string][]) {
    for (let i = 0; i < n; i++) {
      const c = steps[i];
      if (c === 'x') grid[i].push({ n: KIT[inst] });
      else if (c === 'g') grid[i].push({ n: KIT[inst], g: true });
      else if (c === 'a') grid[i].push({ n: KIT[inst], a: true });
    }
  }
  return grid;
}
const has = (step: DrumHit[], n: number) => step.some((h) => h.n === n);
const add = (step: DrumHit[], h: DrumHit) => {
  if (!has(step, h.n)) step.push(h);
};

function mutate(grid: DrumHit[][], m: Mutation, r: Rand, ts: Ts) {
  const n = grid.length;
  const off8 = ts === '4/4' ? [2, 6, 10, 14] : [2, 5, 8, 11];
  if (m === 'kickPush') add(grid[pick(r, off8)], { n: KIT.kick });
  if (m === 'kickDouble' && ts === '4/4') {
    const s = pick(r, [6, 7, 14, 15]);
    add(grid[s], { n: KIT.kick });
  }
  if (m === 'ghosts') {
    for (let k = 0; k < 2; k++) {
      const s = Math.floor(r() * n);
      if (!has(grid[s], KIT.snare) && s % (ts === '4/4' ? 4 : 3) !== 0) add(grid[s], { n: KIT.snare, g: true });
    }
  }
  if (m === 'openHat' && ts === '4/4') {
    const s = pick(r, [6, 14]);
    if (has(grid[s], KIT.hat)) grid[s] = grid[s].filter((h) => h.n !== KIT.hat).concat({ n: KIT.open });
  }
  if (m === 'hat16' && ts === '4/4' && grid.some((st) => has(st, KIT.hat))) {
    for (const st of grid) if (!has(st, KIT.open)) add(st, { n: KIT.hat });
  }
}

function section(style: Style, sec: DrumSection, last: boolean, first: boolean): DrumHit[][][] {
  const r = rng(sec.seed);
  const n = stepsOf(style.ts);
  const base = toGrid(pick(r, style[FEEL[sec.type]]), n);
  for (let k = Math.floor(r() * 3); k > 0; k--) mutate(base, pick(r, style.mutations), r, style.ts);
  const variant = base.map((s) => [...s]);
  if (style.mutations.length) mutate(variant, pick(r, style.mutations), r, style.ts);
  // A fill replaces the groove from the beat its first hit falls in to the end of the bar.
  const fill = toGrid(pick(r, style.fills), n);
  const beat = n / 4;
  const fillFrom = Math.floor(fill.findIndex((s) => s.length) / beat) * beat;
  const bars: DrumHit[][][] = [];
  for (let b = 0; b < sec.bars; b++) {
    const bar = (b % 4 === 3 ? variant : base).map((s) => [...s]);
    if (b === sec.bars - 1 && last) {
      // The song ends: crash + kick on beat 1, then silence.
      bars.push(bar.map((_, i) => (i === 0 ? [{ n: KIT.crash }, { n: KIT.kick }] : [])));
      continue;
    }
    if (b === sec.bars - 1 && sec.bars > 1) for (let i = fillFrom; i < n; i++) bar[i] = [...fill[i]];
    if (b === 0 && !first) {
      bar[0] = bar[0].filter((h) => h.n !== KIT.hat && h.n !== KIT.ride && h.n !== KIT.open);
      add(bar[0], { n: KIT.crash });
      add(bar[0], { n: KIT.kick });
    }
    bars.push(bar);
  }
  return bars;
}

export interface BuiltDrums {
  ts: Ts;
  bars: DrumHit[][][];
  /** Index of each section's first bar. */
  sectionStartBars: number[];
}

export function buildDrums(song: DrumSong): BuiltDrums {
  const style = STYLES[song.style] ?? STYLES.rock;
  const bars: DrumHit[][][] = [];
  const sectionStartBars: number[] = [];
  song.sections.forEach((s, i) => {
    sectionStartBars.push(bars.length);
    bars.push(...section(style, s, i === song.sections.length - 1, i === 0));
  });
  return { ts: style.ts, bars, sectionStartBars };
}

/** Empty steps after a note merge into a longer note when it stays aligned (16th/8th/quarter; 12/8: 8th/dotted quarter). */
export function drumsToAlphaTex(song: DrumSong, title: string): string {
  const { ts, bars, sectionStartBars } = buildDrums(song);
  const hit = (h: DrumHit) => `${h.n}${h.g ? '{g}' : h.a ? '{ac}' : ''}`;
  const out = bars.map((bar, bi) => {
    const beats: string[] = [];
    for (let i = 0; i < bar.length; ) {
      const free = (k: number) => bar.slice(i + 1, i + k).every((s) => s.length === 0);
      let len = 1;
      if (ts === '4/4') len = i % 4 === 0 && free(4) ? 4 : i % 2 === 0 && free(2) ? 2 : 1;
      else len = i % 3 === 0 && free(3) ? 3 : 1;
      const dur = ts === '4/4' ? { 1: ':16', 2: ':8', 4: ':4' }[len] : len === 3 ? ':4' : ':8';
      const dot = ts === '12/8' && len === 3 ? '{d}' : '';
      const h = bar[i];
      const body = h.length === 0 ? 'r' : h.length === 1 ? hit(h[0]) : `(${h.map(hit).join(' ')})`;
      beats.push(`${dur} ${body}${dot}`);
      i += len;
    }
    const sec = sectionStartBars.indexOf(bi);
    const marker = sec >= 0 ? `\\section "${SECTION_LABELS[song.sections[sec].type]}" ` : '';
    const tsMark = bi === 0 ? `\\ts ${ts === '4/4' ? '4 4' : '12 8'} ` : '';
    return `${tsMark}${marker}${beats.join(' ')}`;
  });
  return [`\\title "${title.replace(/"/g, "'")}"`, `\\tempo ${song.tempo}`, '\\track "Drums"', '\\instrument percussion', out.join(' | ') + ' |'].join('\n');
}

const ARRANGEMENT: [DrumSectionType, number][] = [
  ['intro', 4],
  ['verse', 8],
  ['chorus', 8],
  ['verse', 8],
  ['chorus', 8],
  ['bridge', 4],
  ['chorus', 8],
  ['outro', 4],
];
export const newSeed = (r: () => number = Math.random) => Math.floor(r() * 4294967296) >>> 0;

/** A fresh song in a style: the standard arrangement, every section seeded from `seed`. */
export function defaultSong(style: string, seed: number): DrumSong {
  const r = rng(seed);
  return { style, tempo: STYLES[style]?.tempo ?? 100, sections: ARRANGEMENT.map(([type, bars]) => ({ type, bars, seed: newSeed(r) })) };
}

/** Trust boundary: a song from the network or storage, or null. Unknown fields are dropped. */
export function drumSong(u: unknown): DrumSong | null {
  if (!u || typeof u !== 'object') return null;
  const s = u as Record<string, unknown>;
  if (typeof s.style !== 'string' || !Object.hasOwn(STYLES, s.style)) return null;
  if (typeof s.tempo !== 'number' || !Number.isInteger(s.tempo) || s.tempo < 40 || s.tempo > 240) return null;
  if (!Array.isArray(s.sections) || s.sections.length < 1 || s.sections.length > 32) return null;
  const sections: DrumSection[] = [];
  for (const x of s.sections) {
    const v = (x ?? {}) as Record<string, unknown>;
    if (!SECTION_TYPES.includes(v.type as DrumSectionType)) return null;
    if (typeof v.bars !== 'number' || !Number.isInteger(v.bars) || v.bars < 1 || v.bars > 16) return null;
    if (typeof v.seed !== 'number' || !Number.isInteger(v.seed) || v.seed < 0 || v.seed > 4294967295) return null;
    sections.push({ type: v.type as DrumSectionType, bars: v.bars, seed: v.seed });
  }
  return { style: s.style, tempo: s.tempo, sections };
}
