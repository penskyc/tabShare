import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type * as alphaTab from '@coderline/alphatab';
import { ARPEGGIOS, inSet, intervalName, noteName, ROOTS, SCALES, TUNINGS } from '../shared/music';

const PREF = 'tabshare.fretboard';
const INLAYS = [3, 5, 7, 9, 15, 17, 19, 21];
const W = 1200;
const LEFT = 52; // room for open-string notes left of the nut
const ROW = 30;

interface Prefs {
  inst: 'guitar' | 'bass';
  tuning: number;
  root: number;
  scale: string;
  arp: string;
  labels: 'notes' | 'intervals' | 'none';
  emphasizeRoot: boolean;
  leftHanded: boolean;
  frets: number;
  /** Track index whose notes light up under the playhead, or -1. */
  follow: number;
}
const DEFAULTS: Prefs = { inst: 'guitar', tuning: 0, root: 9, scale: 'Minor pentatonic', arp: 'Off', labels: 'notes', emphasizeRoot: true, leftHanded: false, frets: 15, follow: -1 };

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREF) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

type Spot = { s: number; f: number };

/** Easyfrets-style fretboard: scales/arpeggios for any tuning, and the notes a track plays under the playhead. */
/** Practice mode drives the board: follow this track, show these resting dots; the saved prefs aren't changed. */
export interface ForcedBoard {
  follow: number;
  root: number;
  set: number[];
}

export function Fretboard({ api, score, forced }: { api: alphaTab.AlphaTabApi | null; score: alphaTab.model.Score | null; forced?: ForcedBoard }) {
  const [saved, setP] = useState<Prefs>(loadPrefs);
  const p: Prefs = forced ? { ...saved, follow: forced.follow, root: forced.root, inst: 'bass', tuning: 0 } : saved;
  const [playing, setPlaying] = useState<Spot[]>([]);
  const set = (patch: Partial<Prefs>) => setP((old) => ({ ...old, ...patch }));

  useEffect(() => {
    try {
      localStorage.setItem(PREF, JSON.stringify(saved));
    } catch {
      /* storage blocked */
    }
  }, [saved]);

  // Stringed tracks of the current tab (drums and pianos can't be shown on a fretboard).
  const tracks = useMemo(
    () => (score?.tracks ?? []).filter((t) => t.staves[0]?.isStringed && !t.staves[0].isPercussion).map((t) => ({ index: t.index, name: t.name })),
    [score],
  );
  const followed = p.follow >= 0 ? score?.tracks[p.follow] : undefined;
  const following = !!followed && tracks.some((t) => t.index === p.follow);

  // Strings lowest first. alphaTab lists tunings highest string first; note.string 1 is the lowest.
  const strings = following
    ? [...followed!.staves[0].stringTuning.tunings].reverse()
    : (TUNINGS[p.inst][p.tuning] ?? TUNINGS[p.inst][0]).notes;

  useEffect(() => {
    setPlaying([]);
    if (!api || !following) return;
    // The tick lookup covers every track, shown or not (activeBeatsChanged only reports rendered tracks).
    const only = new Set([p.follow]);
    let hint: alphaTab.midi.MidiTickLookupFindBeatResult | null = null;
    let last: alphaTab.model.Beat | null = null;
    const handler = (e: alphaTab.synth.PositionChangedEventArgs) => {
      hint = api.tickCache?.findBeat(only, e.currentTick, hint) ?? null;
      const beat = hint?.beat ?? null;
      if (beat === last) return;
      last = beat;
      setPlaying(beat ? beat.notes.filter((n) => !n.isDead).map((n) => ({ s: n.string - 1, f: n.fret })) : []);
    };
    api.playerPositionChanged.on(handler);
    return () => api.playerPositionChanged.off(handler);
  }, [api, following, p.follow]);

  const scale = forced ? forced.set : (SCALES[p.scale] ?? []);
  const arp = forced ? [] : (ARPEGGIOS[p.arp] ?? []);
  const n = strings.length;
  const H = n * ROW + 34;
  // Fret spacing between real (shrinking) and even, so high frets stay usable.
  const fretX = (f: number) => {
    const real = (1 - Math.pow(2, -f / 12)) / (1 - Math.pow(2, -p.frets / 12));
    return LEFT + (W - LEFT - 12) * (0.55 * real + 0.45 * (f / p.frets));
  };
  const mx = (x: number) => (p.leftHanded ? W - x : x);
  const noteX = (f: number) => (f === 0 ? LEFT - 24 : (fretX(f - 1) + fretX(f)) / 2);
  const rowY = (s: number) => 16 + (n - 1 - s) * ROW + ROW / 2; // highest string on top, like tab
  const label = (midi: number) => (p.labels === 'notes' ? noteName(midi, p.root) : p.labels === 'intervals' ? intervalName(midi, p.root) : '');

  const dots: ReactElement[] = [];
  for (let s = 0; s < n; s++) {
    for (let f = 0; f <= p.frets; f++) {
      const midi = strings[s] + f;
      const isPlaying = playing.some((x) => x.s === s && x.f === f);
      const isArp = arp.length > 0 && inSet(midi, p.root, arp);
      const isScale = inSet(midi, p.root, scale);
      if (!isPlaying && !isArp && !isScale) continue;
      const isRoot = p.emphasizeRoot && (isScale || isArp) && inSet(midi, p.root, [0]);
      const cls = isPlaying ? 'playing' : isRoot ? 'root' : isArp ? 'arp' : 'scale';
      dots.push(
        <g key={`${s}-${f}`} className={`fb-dot ${cls}`} transform={`translate(${mx(noteX(f))} ${rowY(s)})`}>
          <circle r={11.5} />
          <text dy="0.35em">{isPlaying && !isScale && !isArp && p.labels === 'none' ? '' : label(midi)}</text>
        </g>,
      );
    }
  }

  return (
    <div className="fretboard">
      <div className="fb-controls">
        {!forced && (
        <label>
          Follow
          <select value={following ? p.follow : -1} onChange={(e) => set({ follow: Number(e.target.value) })} title="Light up the notes this track plays under the playhead">
            <option value={-1}>Off</option>
            {tracks.map((t) => (
              <option key={t.index} value={t.index}>
                {t.name || `Track ${t.index + 1}`}
              </option>
            ))}
          </select>
        </label>
        )}
        {!forced && !following && (
          <>
            <div className="seg-mini" role="group" aria-label="Instrument">
              {(['guitar', 'bass'] as const).map((i) => (
                <button key={i} className={p.inst === i ? 'on' : ''} onClick={() => set({ inst: i, tuning: 0 })}>
                  {i === 'guitar' ? 'Guitar' : 'Bass'}
                </button>
              ))}
            </div>
            <label>
              Tuning
              <select value={p.tuning} onChange={(e) => set({ tuning: Number(e.target.value) })}>
                {TUNINGS[p.inst].map((t, i) => (
                  <option key={t.name} value={i}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {!forced && (
          <>
        <label>
          Root
          <select value={p.root} onChange={(e) => set({ root: Number(e.target.value) })}>
            {ROOTS.map((r, i) => (
              <option key={r} value={i}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label>
          Scale
          <select value={p.scale} onChange={(e) => set({ scale: e.target.value })}>
            {Object.keys(SCALES).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Arpeggio
          <select value={p.arp} onChange={(e) => set({ arp: e.target.value })}>
            {Object.keys(ARPEGGIOS).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
          </>
        )}
        <label>
          Labels
          <select value={p.labels} onChange={(e) => set({ labels: e.target.value as Prefs['labels'] })}>
            <option value="notes">Notes</option>
            <option value="intervals">Intervals</option>
            <option value="none">None</option>
          </select>
        </label>
        <label>
          Frets
          <select value={p.frets} onChange={(e) => set({ frets: Number(e.target.value) })}>
            {[12, 15, 21, 24].map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={p.emphasizeRoot} onChange={(e) => set({ emphasizeRoot: e.target.checked })} /> Roots
        </label>
        <label className="check">
          <input type="checkbox" checked={p.leftHanded} onChange={(e) => set({ leftHanded: e.target.checked })} /> Left-handed
        </label>
      </div>
      <div className="fb-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} className="fb-svg" role="img" aria-label={forced ? 'Practice fretboard' : `${following ? 'Notes played by ' + (followed!.name || 'the track') : 'Fretboard'}: ${p.scale === 'Off' ? '' : ROOTS[p.root] + ' ' + p.scale}`}>
          <rect className="fb-wood" x={Math.min(mx(fretX(0)), mx(fretX(p.frets)))} y={16} width={Math.abs(fretX(p.frets) - fretX(0))} height={n * ROW} rx={3} />
          {INLAYS.filter((f) => f <= p.frets).map((f) => (
            <circle key={f} className="fb-inlay" cx={mx(noteX(f))} cy={16 + (n * ROW) / 2} r={6} />
          ))}
          {[12, 24].filter((f) => f <= p.frets).map((f) => (
            <g key={f}>
              <circle className="fb-inlay" cx={mx(noteX(f))} cy={16 + n * ROW * 0.28} r={6} />
              <circle className="fb-inlay" cx={mx(noteX(f))} cy={16 + n * ROW * 0.72} r={6} />
            </g>
          ))}
          {Array.from({ length: p.frets + 1 }, (_, f) => (
            <line key={f} className={f === 0 ? 'fb-nut' : 'fb-fret'} x1={mx(fretX(f))} x2={mx(fretX(f))} y1={16} y2={16 + n * ROW} />
          ))}
          {strings.map((_, s) => (
            <line key={s} className="fb-string" x1={mx(fretX(0))} x2={mx(fretX(p.frets))} y1={rowY(s)} y2={rowY(s)} style={{ strokeWidth: 2.4 - 1.5 * (s / Math.max(1, n - 1)) }} />
          ))}
          {Array.from({ length: p.frets }, (_, i) => i + 1)
            .filter((f) => INLAYS.includes(f) || f === 12 || f === 24 || f === 1)
            .map((f) => (
              <text key={f} className="fb-num" x={mx(noteX(f))} y={H - 4} textAnchor="middle">
                {f}
              </text>
            ))}
          {dots}
        </svg>
      </div>
    </div>
  );
}
