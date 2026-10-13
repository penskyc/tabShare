import { useEffect, useMemo, useRef, useState } from 'react';
import * as alphaTab from '@coderline/alphatab';
import { ScoreView } from './ScoreView';
import { arrowStep, step } from './barNav';
import type { RoomConnection } from './useRoom';
import { buildDrums, defaultSong, drumSong, drumsToAlphaTex, newSeed, SECTION_LABELS, SECTION_TYPES, STYLES, type DrumSectionType, type DrumSong } from '../shared/drums';

const PLAYING = alphaTab.synth.PlayerState.Playing;
const SONG_KEY = 'tabshare.drums.song';
const SHARE_KEY = 'tabshare.drums.share';

function loadSong(): DrumSong {
  try {
    const s = drumSong(JSON.parse(localStorage.getItem(SONG_KEY) ?? 'null'));
    if (s) return s;
  } catch {
    /* fall through */
  }
  return defaultSong('rock', newSeed());
}
function save(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* per-session only */
  }
}

/** Drums mode: a generated drum song to play along to. Solo, or shared with the room (everyone hears the same part). */
export function Drums({ room, tunerOn, onToggleTuner }: { room: RoomConnection; tunerOn: boolean; onToggleTuner: () => void }) {
  const [song, setSongState] = useState<DrumSong>(loadSong);
  const [share, setShare] = useState(() => {
    try {
      return localStorage.getItem(SHARE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [loop, setLoop] = useState<number | null>(null); // looped section index
  const [current, setCurrent] = useState<number | null>(null); // section under the play position
  const [metronome, setMetronome] = useState(false);
  const [countIn, setCountIn] = useState(false);
  const [tempoDraft, setTempoDraft] = useState(song.tempo);
  const [saveName, setSaveName] = useState('');
  const [picked, setPicked] = useState('');

  const [api, setApi] = useState<alphaTab.AlphaTabApi | null>(null);
  const [ready, setReady] = useState(false);
  const [midiCount, setMidiCount] = useState(0); // bumps when a new song's ticks are ready
  const [playing, setPlaying] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const built = useMemo(() => buildDrums(song), [song]);
  const data = useMemo(() => new TextEncoder().encode(drumsToAlphaTex(song, `${STYLES[song.style].label} drums`)).buffer as ArrayBuffer, [song]);

  // ---- sharing: every user action sends the whole state; incoming states are applied without sending ----
  const live = useRef({ share, song, loop, api });
  live.current = { share, song, loop, api };
  const send = (next: { song?: DrumSong; playing?: boolean; timeMs?: number; loop?: number | null }) => {
    if (!live.current.share) return;
    const a = live.current.api;
    room.sendDrums({
      song: next.song ?? live.current.song,
      playing: next.playing ?? (a?.playerState === PLAYING),
      timeMs: next.timeMs ?? a?.timePosition ?? 0,
      loop: next.loop !== undefined ? next.loop : live.current.loop,
    });
  };
  const setSong = (next: DrumSong, opts: { local?: boolean } = {}) => {
    setSongState(next);
    setTempoDraft(next.tempo);
    save(SONG_KEY, JSON.stringify(next));
    if (!opts.local) send({ song: next, playing: false, timeMs: 0 });
  };

  // A shared play/stop that arrived while the new song was still loading waits for the player.
  const pending = useRef<typeof room.drums>(null);
  const applyTransport = (st: NonNullable<typeof room.drums>) => {
    const a = live.current.api;
    if (!a) return;
    const serverNow = Date.now() + room.clockOffset;
    a.timePosition = st.playing ? st.timeMs + (serverNow - st.at) : st.timeMs;
    // Only on a change: a second play() before alphaTab's worklet starts leaves a source that pause() can't stop.
    const isPlaying = a.playerState === PLAYING;
    if (st.playing && !isPlaying) a.play();
    else if (!st.playing && isPlaying) a.pause();
  };
  useEffect(() => {
    const st = room.drums;
    if (!share || !st) return;
    setLoop(st.loop);
    if (JSON.stringify(st.song) !== JSON.stringify(live.current.song)) {
      pending.current = st;
      setSong(st.song, { local: true });
    } else if (ready) applyTransport(st);
    else pending.current = st;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.drums, share]);
  const toggleShare = (on: boolean) => {
    setShare(on);
    save(SHARE_KEY, on ? '1' : '');
    live.current.share = on;
    // Turning it on joins what the room is playing, or offers yours if nothing is shared yet.
    if (on && !room.drums) send({});
  };

  // ---- player ----
  useEffect(() => {
    if (!api) return;
    const offs = [
      api.playerReady.on(() => setReady(true)),
      api.playerStateChanged.on((e) => setPlaying(e.state === PLAYING)),
      // Not midiLoaded: in alphaTab 1.8 subscribing to it recurses forever in the worker player's getter.
      // midiLoad fires once the tick cache is built, just before the player gets the file, hence the setTimeout.
      api.midiLoad.on(() => {
        setMidiCount((n) => n + 1);
        setTimeout(() => {
          if (pending.current) applyTransport(pending.current);
          pending.current = null;
        });
      }),
    ];
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  useEffect(() => {
    if (api) api.metronomeVolume = metronome ? 1 : 0;
  }, [api, metronome]);
  useEffect(() => {
    if (api) api.countInVolume = countIn ? 1 : 0;
  }, [api, countIn]);

  // Loop the whole song, or one section (a playback range over its bars).
  useEffect(() => {
    if (!api) return;
    api.isLooping = true;
    const bars = api.tickCache?.masterBars;
    if (loop == null || !bars?.length || loop >= song.sections.length) {
      api.playbackRange = null;
      return;
    }
    const first = built.sectionStartBars[loop];
    const last = first + song.sections[loop].bars - 1;
    const range = new alphaTab.synth.PlaybackRange();
    range.startTick = bars[first].start;
    range.endTick = bars[Math.min(last, bars.length - 1)].end;
    api.playbackRange = range;
  }, [api, loop, built, song.sections, midiCount]);

  // Which section is playing (for the highlight).
  useEffect(() => {
    if (!api) return;
    return api.playerPositionChanged.on((e) => {
      const bars = api.tickCache?.masterBars ?? [];
      const bar = bars.find((b) => e.currentTick >= b.start && e.currentTick < b.end)?.masterBar.index ?? 0;
      let s = 0;
      while (s + 1 < built.sectionStartBars.length && built.sectionStartBars[s + 1] <= bar) s++;
      setCurrent((c) => (c === s ? c : s));
    });
  }, [api, built]);

  const playPause = () => {
    if (!api || !ready) return;
    send({ playing: api.playerState !== PLAYING, timeMs: api.timePosition });
    api.playPause();
  };
  const stop = () => {
    if (!api) return;
    api.stop();
    send({ playing: false, timeMs: 0 });
  };
  const keys = useRef({ playPause, api });
  keys.current = { playPause, api };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        keys.current.playPause();
      }
      const arrow = arrowStep(e);
      if (arrow && keys.current.api) {
        e.preventDefault();
        step(keys.current.api, arrow);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Tempo: commit after the slider settles (a new tempo regenerates the score).
  useEffect(() => {
    if (tempoDraft === song.tempo) return;
    const t = setTimeout(() => setSong({ ...song, tempo: tempoDraft }), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tempoDraft]);

  // ---- arrangement editing ----
  const sections = song.sections;
  const editSections = (next: DrumSong['sections']) => setSong({ ...song, sections: next });
  const setLoopShared = (l: number | null) => {
    setLoop(l);
    send({ loop: l });
  };
  const remove = (i: number) => {
    if (sections.length === 1) return;
    editSections(sections.filter((_, k) => k !== i));
    if (loop != null) setLoopShared(loop === i ? null : loop > i ? loop - 1 : loop);
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j], next[i]];
    editSections(next);
    if (loop === i) setLoopShared(j);
  };
  const patch = (i: number, p: Partial<DrumSong['sections'][number]>) => editSections(sections.map((s, k) => (k === i ? { ...s, ...p } : s)));

  return (
    <div className="practice drums">
      <div className="practice-bar">
        <label>
          Style
          <select value={song.style} onChange={(e) => setSong({ ...song, style: e.target.value, tempo: STYLES[e.target.value].tempo })}>
            {Object.entries(STYLES).map(([id, s]) => (
              <option key={id} value={id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tempo
          <span className="practice-num">
            <input type="range" min={40} max={240} value={tempoDraft} onChange={(e) => setTempoDraft(Number(e.target.value))} aria-label="Tempo" />
            <span className="mono">{tempoDraft}</span>
          </span>
        </label>
        <button className="btn" onClick={() => setSong({ ...defaultSong(song.style, newSeed()), tempo: song.tempo })} title="A new arrangement with new grooves">
          🎲 New song
        </button>
        <label className="drums-share small" title="Everyone in the room who opens Drums hears this song, and play/stop follows">
          <input type="checkbox" checked={share} onChange={(e) => toggleShare(e.target.checked)} /> Share with the room
        </label>
        {share && room.drums && <span className="small muted">shared by {room.drums.by}</span>}
        <span className="drums-save">
          <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Name this beat" aria-label="Song name" maxLength={60} />
          <button
            className="btn"
            disabled={!saveName.trim()}
            onClick={() => {
              room.saveDrums(saveName.trim(), song);
              setSaveName('');
            }}
          >
            Save
          </button>
        </span>
        {room.drumSongs.length > 0 && (
          <span className="drums-save">
            <select
              value={picked}
              aria-label="Saved drum songs"
              onChange={(e) => {
                setPicked(e.target.value);
                const s = room.drumSongs.find((x) => x.id === e.target.value);
                if (s) setSong(s.song);
              }}
            >
              <option value="">Open saved…</option>
              {room.drumSongs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.by}
                </option>
              ))}
            </select>
            {picked && (
              <button
                className="btn ghost"
                onClick={() => {
                  room.deleteDrums(picked);
                  setPicked('');
                }}
                title="Delete this saved song from the room"
              >
                Delete
              </button>
            )}
          </span>
        )}
      </div>

      <div className="drums-arrangement" role="list" aria-label="Arrangement">
        {sections.map((s, i) => (
          <div key={i} role="listitem" className={`drums-section ${current === i && playing ? 'now' : ''} ${loop === i ? 'looped' : ''}`}>
            <select value={s.type} onChange={(e) => patch(i, { type: e.target.value as DrumSectionType })} aria-label={`Section ${i + 1} type`}>
              {SECTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SECTION_LABELS[t]}
                </option>
              ))}
            </select>
            <select value={s.bars} onChange={(e) => patch(i, { bars: Number(e.target.value) })} aria-label={`Section ${i + 1} bars`}>
              {Array.from({ length: 16 }, (_, k) => k + 1).map((n) => (
                <option key={n} value={n}>
                  {n} bar{n > 1 ? 's' : ''}
                </option>
              ))}
            </select>
            <span className="drums-section-tools">
              <button onClick={() => patch(i, { seed: newSeed() })} title="New groove for this section" aria-label={`Reroll section ${i + 1}`}>
                🎲
              </button>
              <button className={loop === i ? 'on' : ''} onClick={() => setLoopShared(loop === i ? null : i)} title="Loop this section" aria-label={`Loop section ${i + 1}`}>
                ⟲
              </button>
              <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move section ${i + 1} left`}>
                ←
              </button>
              <button onClick={() => move(i, 1)} disabled={i === sections.length - 1} aria-label={`Move section ${i + 1} right`}>
                →
              </button>
              <button onClick={() => remove(i)} disabled={sections.length === 1} aria-label={`Delete section ${i + 1}`}>
                ✕
              </button>
            </span>
          </div>
        ))}
        {sections.length < 32 && (
          <button className="btn ghost drums-add" onClick={() => editSections([...sections, { type: 'verse', bars: 4, seed: newSeed() }])}>
            + Section
          </button>
        )}
      </div>

      {loadError && <div className="banner error">{loadError}</div>}
      <ScoreView data={data} ext="tex" peers={[]} onApi={setApi} onPointer={() => {}} onSelection={() => {}} onLoadError={setLoadError} />

      <div className="transport practice-transport">
        <div className="tp-group">
          <button className="tp-btn" onClick={stop} disabled={!ready} title="Stop">
            ■
          </button>
          <button className="tp-btn play" onClick={playPause} disabled={!ready} title="Play / pause (space)">
            {playing ? '❚❚' : '▶'}
          </button>
          <span className="mono time">♩ = {song.tempo}</span>
        </div>
        <div className="tp-group">
          <span className="small muted">{loop == null ? '⟲ Looping the whole song' : `⟲ Looping ${SECTION_LABELS[sections[loop].type]} (section ${loop + 1})`}</span>
          <button className={`tp-toggle ${metronome ? 'on' : ''}`} onClick={() => setMetronome(!metronome)}>
            Metronome
          </button>
          <button className={`tp-toggle ${countIn ? 'on' : ''}`} onClick={() => setCountIn(!countIn)}>
            Count-in
          </button>
        </div>
        {!ready && <span className="small muted">loading sounds…</span>}
        <div className="tp-group">
          <button className={`tp-toggle ${tunerOn ? 'on' : ''}`} onClick={onToggleTuner} title="Chromatic tuner (uses your rig input or microphone)">
            Tuner
          </button>
        </div>
      </div>
    </div>
  );
}
