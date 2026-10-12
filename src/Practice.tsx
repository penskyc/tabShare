import { useEffect, useMemo, useRef, useState } from 'react';
import type * as alphaTab from '@coderline/alphatab';
import { ScoreView } from './ScoreView';
import { Fretboard } from './Fretboard';
import { arrowStep, step } from './barNav';
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
  const [speedUp, setSpeedUp] = useState<SpeedUp>(() => ({ on: false, step: 2, target: 120, ...((load('speedup') as Partial<SpeedUp> | null) ?? {}) }));
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
      return ex.build(opts, tuningOf(opts));
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  }, [ex, opts]);
  const data = useMemo(() => {
    if (ex.kind !== 'tab' || built instanceof Error) return null;
    return new TextEncoder().encode(toAlphaTex(built, { tempo: base, tuning: tuningOf(opts), title: ex.name })).buffer as ArrayBuffer;
  }, [ex, built, base, opts]);

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

  // Speed trainer: every time the loop wraps, raise the tempo by `step` until `target` (through playbackSpeed, so the
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
  const apiRef = useRef(api);
  apiRef.current = api;
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
      const arrow = arrowStep(e);
      if (arrow && apiRef.current) {
        e.preventDefault();
        step(apiRef.current, arrow);
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
        <button
          className="btn ghost"
          onClick={() => {
            setShowTips(!showTips);
            save('tips', !showTips);
          }}
        >
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
