import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as alphaTab from '@coderline/alphatab';
import { PlayerMode } from '@coderline/alphatab';
import type { LinkPreview, Peer, TickRange } from '../shared/protocol';
import { ALLOWED_EXTENSIONS, URL_RE } from '../shared/protocol';
import { deleteTab, downloadTab, getConfig, uploadTab, type Profile, type Session } from './api';
import { useRoom } from './useRoom';
import { ScoreView, type ScoreViewHandle } from './ScoreView';
import { useCall } from './useCall';
import { CallPanel } from './CallPanel';
import { useRig } from './rig/useRig';
import { RigPanel } from './rig/RigPanel';
import { SongsterrSearch } from './SongsterrSearch';
import { Tuner } from './Tuner';
import { setAudioSession } from './audioSession';
import { Fretboard } from './Fretboard';
import { Practice } from './Practice';
import { OriginalAudio, YT_ENDED, YT_PAUSED, YT_PLAYING, type YTPlayer } from './OriginalAudio';
import { playOrder } from '../shared/sync';

const PLAYING = 1; // alphaTab.synth.PlayerState.Playing

function readPref(k: string) {
  try {
    return localStorage.getItem(`tabshare.${k}`);
  } catch {
    return null;
  }
}
function writePref(k: string, v: string) {
  try {
    localStorage.setItem(`tabshare.${k}`, v);
  } catch {
    /* per-session only */
  }
}

/** True when the browser would currently block audio playback (no user gesture on this page yet). */
function isAudioLocked() {
  const nav = navigator as Navigator & { getAutoplayPolicy?: (type: string) => string };
  try {
    if (nav.getAutoplayPolicy) return nav.getAutoplayPolicy('audiocontext') !== 'allowed'; // Firefox
  } catch {
    /* fall through */
  }
  return !!navigator.userActivation && !navigator.userActivation.hasBeenActive; // Chromium, Safari
}

function fmtTime(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const SAMPLE_TEX = `\\title "Shared riff"
\\tempo 100
.
\\track "Guitar"
\\staff {tabs}
\\tuning e5 b4 g4 d4 a3 e3
:8 0.6 3.6 5.6 0.6 3.6 6.6 5.6 r | 0.6 3.6 5.6 3.6 0.6 r r r |`;

interface Props {
  session: Session;
  profile: Profile;
  onLeave: () => void;
}

export function Room({ session, profile, onLeave }: Props) {
  const room = useRoom(session, profile);
  const rig = useRig();
  const call = useCall(room, rig.callStream, rig.voiceStream);
  const scoreRef = useRef<ScoreViewHandle>(null);

  const [api, setApi] = useState<alphaTab.AlphaTabApi | null>(null);
  const [score, setScore] = useState<alphaTab.model.Score | null>(null);
  const [tabData, setTabData] = useState<{ id: string; data: ArrayBuffer; ext: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState({ cur: 0, end: 0 });
  const [speed, setSpeed] = useState(1);
  const [metronome, setMetronome] = useState(false);
  const [countIn, setCountIn] = useState(false);
  const [selection, setSelection] = useState<TickRange | null>(null);
  const [visibleTracks, setVisibleTracks] = useState<number[]>([0]);
  const [muted, setMuted] = useState<Set<number>>(new Set());
  const [soloed, setSoloed] = useState<Set<number>>(new Set());
  const [volumes, setVolumes] = useState<number[]>([]);
  // Jam sync defaults on: shared playback is the point of a room.
  const [jam, setJam] = useState(true);
  const [panel, setPanel] = useState<'tabs' | 'tracks' | 'rig' | 'chat'>('tabs');
  const [sideW, setSideW] = useState(() => Number(readPref('sideW')) || 280);
  const [sideOpen, setSideOpen] = useState(() => readPref('sideOpen') !== '0');
  const toggleSide = (open: boolean) => {
    setSideOpen(open);
    writePref('sideOpen', open ? '1' : '0');
  };
  // Phones and portrait tablets: the side panel is a drawer behind a menu button, so the score gets the whole screen.
  const narrow = useNarrow();
  const [drawer, setDrawer] = useState(false);
  const drawerSwipe = useSwipeToClose(narrow && drawer, () => setDrawer(false));
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [drawer]);
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget;
    const left = handle.parentElement!.getBoundingClientRect().left;
    handle.setPointerCapture(e.pointerId);
    let w = sideW;
    const move = (ev: PointerEvent) => setSideW((w = Math.round(Math.min(560, Math.max(200, ev.clientX - left)))));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      writePref('sideW', String(w));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };
  const [texOpen, setTexOpen] = useState(false);
  // Per-person tools, remembered on this device.
  const [showTuner, setShowTuner] = useState(false);
  // iOS: playback session (ignores the silent switch) unless the call, rig or tuner may be capturing (audioSession.ts).
  useEffect(() => setAudioSession(call.inCall || rig.on || showTuner), [call.inCall, rig.on, showTuner]);
  const [showFretboard, setShowFretboard] = useState(() => readPref('fretboard.open') === '1');
  // Tab | Practice. Practice is solo with its own player; the room's tab stays loaded but paused and muted.
  const [mode, setMode] = useState<'tab' | 'practice'>(() => (readPref('practice.mode') === 'practice' ? 'practice' : 'tab'));
  const switchMode = (m: 'tab' | 'practice') => {
    setMode(m);
    writePref('practice.mode', m);
  };
  const [zoom, setZoom] = useState(() => Number(readPref('zoom')) || 1);
  const toggleFretboard = () => {
    setShowFretboard((v) => (writePref('fretboard.open', v ? '' : '1'), !v));
  };
  const changeZoom = (z: number) => {
    const next = Math.round(Math.min(2, Math.max(0.5, z)) * 10) / 10;
    setZoom(next);
    writePref('zoom', String(next));
  };
  const [toast, setToast] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // Time of the last score click; only seeks right after one are broadcast in jam mode.
  const userSeekAt = useRef(-Infinity);
  // Browsers keep audio muted until the page gets a click/keypress (e.g. right after a reload).
  const [audioLocked, setAudioLocked] = useState(isAudioLocked);
  const jamRef = useRef(jam);
  jamRef.current = jam;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const roomRef = useRef(room);
  roomRef.current = room;

  const peers = useMemo(() => Object.values(room.peers), [room.peers]);
  const currentTab = room.tabs.find((t) => t.id === room.currentTabId) ?? null;

  // ---------- audio source: synth or original recording (YouTube) ----------
  const [source, setSource] = useState<'synth' | 'original'>('synth');
  const [yt, setYt] = useState<YTPlayer | null>(null);
  const ytRef = useRef<YTPlayer | null>(null);
  // Set synchronously when the player is created/destroyed (not on render), so effects running in the same
  // commit as the YouTube box unmounting never touch a destroyed player.
  const onYtPlayer = useCallback((p: YTPlayer | null) => {
    ytRef.current = p;
    setYt(p);
  }, []);
  /** Calls the YouTube player if it's alive; its API throws once the iframe is gone. */
  const ytCall = <T,>(fn: (p: YTPlayer) => T, fallback: T): T => {
    const p = ytRef.current;
    if (!p) return fallback;
    try {
      return fn(p);
    } catch {
      return fallback;
    }
  };
  const original = source === 'original' && !!currentTab?.youtube && !!yt;
  const videoKey = JSON.stringify(currentTab?.youtube ?? null);

  useEffect(() => {
    if (room.status === 'open') room.setPresence({ jam: jamRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.status]);

  // ---------- toasts ----------
  useEffect(() => {
    if (!room.lastEvent) return;
    setToast(room.lastEvent);
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [room.lastEvent]);

  // ---------- load current tab ----------
  useEffect(() => {
    if (!currentTab) {
      setTabData(null);
      setScore(null);
      return;
    }
    if (tabData?.id === currentTab.id) return;
    let cancelled = false;
    setError(null);
    downloadTab(session, currentTab.id)
      .then((data) => !cancelled && setTabData({ id: currentTab.id, data, ext: currentTab.ext }))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTab?.id, session]);

  // ---------- alphaTab events ----------
  useEffect(() => {
    if (!api) return;
    const offs: Array<() => void> = [];
    offs.push(
      api.scoreLoaded.on((s) => {
        setScore(s);
        setVisibleTracks([0]);
        setMuted(new Set());
        setSoloed(new Set());
        setVolumes([]);
        setSelection(null);
        const tabId = roomRef.current.currentTabId;
        if (tabId) roomRef.current.sendTabMeta(tabId, s.title, s.artist);
        // Sync points live in the score model; apply before the player builds its time axis.
        const video = roomRef.current.tabs.find((t) => t.id === tabId)?.youtube;
        s.applyFlatSyncPoints(video?.syncPoints ?? []);
      }),
    );
    offs.push(api.playerReady.on(() => setReady(true)));
    offs.push(
      api.playerStateChanged.on((e) => {
        const isPlaying = e.state === PLAYING;
        setPlaying(isPlaying);
        if (!isPlaying) roomRef.current.setPresence({ playTick: null });
      }),
    );
    let lastPresence = 0;
    let lastUi = 0;
    offs.push(
      api.playerPositionChanged.on((e) => {
        const now = performance.now();
        if (now - lastUi > 100 || e.isSeek) {
          lastUi = now;
          setPos({ cur: e.currentTime, end: e.endTime });
        }
        if (api.playerState === PLAYING && now - lastPresence > 250) {
          lastPresence = now;
          roomRef.current.setPresence({ playTick: e.currentTick });
        }
        // Only broadcast seeks the user caused by clicking the score. Loop wrap-arounds and
        // remotely-applied seeks also report isSeek, and re-broadcasting those made every client
        // keep re-seeking (each seek clears the audio buffer → silence).
        if (e.isSeek && jamRef.current && now - userSeekAt.current < 1000) {
          userSeekAt.current = -Infinity;
          roomRef.current.sendTransport(api.playerState === PLAYING, e.currentTime, speedRef.current);
        }
      }),
    );
    // beatMouseUp also fires with null for any mouseup on the page (e.g. buttons), so require a beat.
    const markUserSeek = (beat: unknown) => {
      if (beat) userSeekAt.current = performance.now();
    };
    offs.push(api.beatMouseDown.on(markUserSeek));
    offs.push(api.beatMouseUp.on(markUserSeek));
    return () => offs.forEach((off) => off());
  }, [api]);

  // ---------- track rendering ----------
  // Tab only: hide standard notation on staves that have a tab (drums, piano and vocals keep theirs). The file's own
  // setting is remembered per staff so turning it off restores it.
  const [tabOnly, setTabOnly] = useState(() => readPref('tabOnly') === '1');
  const notationOf = useRef(new WeakMap<alphaTab.model.Staff, boolean>());
  useEffect(() => {
    if (!api || !score) return;
    for (const staff of score.tracks.flatMap((t) => t.staves)) {
      if (!notationOf.current.has(staff)) notationOf.current.set(staff, staff.showStandardNotation);
      const own = notationOf.current.get(staff)!;
      staff.showStandardNotation = tabOnly && staff.showTablature ? false : own;
    }
    const tracks = score.tracks.filter((t) => visibleTracks.includes(t.index));
    if (tracks.length) api.renderTracks(tracks);
    room.setPresence({ tracks: visibleTracks });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, score, visibleTracks, tabOnly]);

  // ---------- shared loop ----------
  useEffect(() => {
    if (!api || !score) return;
    const loop = room.loop;
    if (!loop) {
      api.playbackRange = null;
      api.isLooping = false;
      api.clearPlaybackRangeHighlight();
      return;
    }
    api.playbackRange = { startTick: loop.startTick, endTick: loop.endTick };
    api.isLooping = true;
    const cache = api.tickCache;
    const lookup = new Set(visibleTracks);
    const start = cache?.findBeat(lookup, loop.startTick)?.beat;
    const end = cache?.findBeat(lookup, loop.endTick - 1)?.beat;
    if (start && end) api.highlightPlaybackRange(start, end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, score, room.loop]);

  // Sync point edits from anyone in the room.
  useEffect(() => {
    if (!api || !score) return;
    score.applyFlatSyncPoints(currentTab?.youtube?.syncPoints ?? []);
    api.updateSyncPoints();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, score, videoKey]);

  // Swap alphaTab's player: synthesizer, or external media driven by the YouTube player.
  useEffect(() => {
    if (!api || !score) return;
    const mode = original ? PlayerMode.EnabledExternalMedia : PlayerMode.EnabledSynthesizer;
    if (api.settings.player.playerMode === mode) return;
    api.pause();
    ytCall((p) => p.pauseVideo(), undefined);
    api.settings.player.playerMode = mode;
    api.updateSettings();
    if (original) {
      const handler: alphaTab.synth.IExternalMediaHandler = {
        get backingTrackDuration() {
          return ytCall((p) => p.getDuration(), 0) * 1000;
        },
        get playbackRate() {
          return ytCall((p) => p.getPlaybackRate(), 1);
        },
        set playbackRate(v) {
          ytCall((p) => p.setPlaybackRate(v), undefined);
        },
        get masterVolume() {
          return ytCall((p) => p.getVolume(), 100) / 100;
        },
        set masterVolume(v) {
          ytCall((p) => p.setVolume(v * 100), undefined);
        },
        seekTo: (ms) => ytCall((p) => p.seekTo(ms / 1000, true), undefined),
        play: () => ytCall((p) => p.playVideo(), undefined),
        pause: () => ytCall((p) => p.pauseVideo(), undefined),
      };
      (api.player as unknown as { output: alphaTab.synth.IExternalMediaSynthOutput }).output.handler = handler;
    }
    setReady(false);
    api.loadMidiForScore();
    api.playbackSpeed = speedRef.current;
  }, [api, score, original]);

  // Feed the video's clock into alphaTab (cursor + position follow the recording).
  useEffect(() => {
    if (!original || !api) return;
    const output = (api.player as unknown as { output: alphaTab.synth.IExternalMediaSynthOutput } | null)?.output;
    const timer = setInterval(() => {
      const t = ytCall((p) => p.getCurrentTime(), undefined);
      if (output && typeof t === 'number') output.updatePosition(t * 1000);
    }, 50);
    return () => clearInterval(timer);
  }, [original, api]);

  // Using YouTube's own play/pause keeps alphaTab's state in step.
  const onYtState = (state: number) => {
    if (!api || !original) return;
    if (state === YT_PLAYING && api.playerState !== PLAYING) api.play();
    if ((state === YT_PAUSED || state === YT_ENDED) && api.playerState === PLAYING) api.pause();
  };

  const getPlayOrder = () => playOrder((api?.tickCache?.masterBars ?? []).map((m) => m.masterBar.index));
  const getCurrentBar = () => {
    if (!api?.tickCache) return 0;
    return api.tickCache.findBeat(new Set(visibleTracks), api.tickPosition)?.beat.voice.bar.index ?? 0;
  };

  // ---------- jam: follow remote transport ----------
  const applyTransport = useCallback(() => {
    const t = roomRef.current.transport;
    if (!api || !t || !ready) return;
    const serverNow = Date.now() + roomRef.current.clockOffset;
    const timeMs = t.playing ? t.timeMs + (serverNow - t.at) * t.speed : t.timeMs;
    api.playbackSpeed = t.speed;
    setSpeed(t.speed);
    api.timePosition = timeMs;
    if (t.playing) api.play();
    else api.pause();
  }, [api, ready]);

  // First click/keypress anywhere unlocks audio. If a jam is already playing, re-sync inside that gesture:
  // while audio was locked the local player couldn't advance, so it's behind.
  const applyTransportRef = useRef(applyTransport);
  applyTransportRef.current = applyTransport;
  useEffect(() => {
    if (!audioLocked) return;
    const unlock = (e: Event) => {
      setAudioLocked(false);
      const onTransportButton = (e.target as HTMLElement | null)?.closest?.('.tp-btn');
      if (!onTransportButton && jamRef.current && roomRef.current.transport?.playing) applyTransportRef.current();
    };
    window.addEventListener('pointerdown', unlock, { capture: true, once: true });
    window.addEventListener('keydown', unlock, { capture: true, once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
    };
  }, [audioLocked]);

  // Re-apply when the transport changes, and once the player becomes ready (a play may have arrived while loading).
  useEffect(() => {
    if (jam) applyTransport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.transport, ready]);

  const toggleJam = () => {
    const next = !jam;
    setJam(next);
    room.setPresence({ jam: next });
    if (next && room.transport?.playing) applyTransport();
    if (next) applyMix();
  };

  // ---------- transport controls ----------
  const playPause = useCallback(() => {
    if (!api || !ready) return;
    const willPlay = api.playerState !== PLAYING;
    if (jamRef.current) roomRef.current.sendTransport(willPlay, api.timePosition, speedRef.current);
    api.playPause();
  }, [api, ready]);

  const stop = () => {
    if (!api) return;
    if (jam) room.sendTransport(false, 0, speed);
    api.stop();
  };

  const changeSpeed = (v: number) => {
    setSpeed(v);
    if (api) api.playbackSpeed = v;
    if (jam && api) room.sendTransport(api.playerState === PLAYING, api.timePosition, v);
  };

  useEffect(() => {
    if (api) api.metronomeVolume = metronome ? 1 : 0;
  }, [api, metronome]);
  // Zoom re-lays out the score; cursors and selections follow because they're stored relative to bars and ticks.
  useEffect(() => {
    if (!api || api.settings.display.scale === zoom) return;
    api.settings.display.scale = zoom;
    api.updateSettings();
    if (api.score) api.render();
  }, [api, zoom]);
  useEffect(() => {
    if (api) api.countInVolume = countIn ? 1 : 0;
  }, [api, countIn]);

  const toggleLoop = () => {
    if (room.loop) room.setLoop(null);
    else if (selection) room.setLoop(selection);
    else if (api) {
      api.isLooping = !api.isLooping;
      setToast(api.isLooping ? 'Looping whole song (select beats to share a loop)' : 'Loop off');
    }
  };

  useEffect(() => {
    if (!api) return;
    if (mode === 'practice') api.pause();
    // Muted, not stopped: remote jam play/seek still moves the hidden tab, so coming back rejoins the jam.
    api.masterVolume = mode === 'practice' ? 0 : 1;
  }, [api, mode]);

  // Space = play/pause (unless typing; Practice has its own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode === 'practice') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        playPause();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playPause, mode]);

  // ---------- tracks: view, mute, solo (shared with jam users via room.mix) ----------
  useEffect(() => {
    if (!api || !score) return;
    for (const t of score.tracks) {
      api.changeTrackMute([t], muted.has(t.index));
      api.changeTrackSolo([t], soloed.has(t.index));
    }
  }, [api, score, muted, soloed]);

  useEffect(() => {
    if (!api || !score) return;
    for (const t of score.tracks) api.changeTrackVolume([t], volumes[t.index] ?? 1);
  }, [api, score, volumes]);

  const toggleSet = (set: Set<number>, i: number) => {
    const n = new Set(set);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    return n;
  };

  type MixChange = {
    tracks?: number[];
    m?: Set<number>;
    s?: Set<number>;
    volumes?: number[];
    metronome?: boolean;
    countIn?: boolean;
    source?: 'synth' | 'original';
  };
  // Track view is your own unless you opt in: a guitarist and a bassist usually want different tracks on screen.
  const [syncView, setSyncView] = useState(() => readPref('jam.syncView') === '1');
  const syncViewRef = useRef(syncView);
  syncViewRef.current = syncView;
  const mixSendTimer = useRef<number | undefined>(undefined);
  const changeMix = (c: MixChange) => {
    const next = {
      tracks: c.tracks ?? visibleTracks,
      m: c.m ?? muted,
      s: c.s ?? soloed,
      volumes: c.volumes ?? volumes,
      metronome: c.metronome ?? metronome,
      countIn: c.countIn ?? countIn,
      source: c.source ?? source,
    };
    setVisibleTracks(next.tracks);
    setMuted(next.m);
    setSoloed(next.s);
    setVolumes(next.volumes);
    setMetronome(next.metronome);
    setCountIn(next.countIn);
    setSource(next.source);
    if (!jamRef.current) return;
    // Volume sliders fire continuously; coalesce into one message per ~150 ms.
    window.clearTimeout(mixSendTimer.current);
    mixSendTimer.current = window.setTimeout(
      () =>
        room.sendMix({
          // Not following the jam's view: send the room's view back unchanged, so others' screens don't change.
          tracks: syncViewRef.current ? next.tracks : (roomRef.current.mix?.tracks ?? next.tracks),
          muted: [...next.m],
          soloed: [...next.s],
          volumes: next.volumes,
          metronome: next.metronome,
          countIn: next.countIn,
          source: next.source,
        }),
      c.volumes ? 150 : 0,
    );
  };
  const setTrackVolume = (i: number, v: number) => {
    const next = [...volumes];
    for (let k = next.length; k < i; k++) next[k] = 1; // no holes in the array
    next[i] = v;
    changeMix({ volumes: next });
  };

  const toggleVisible = (i: number) => {
    const v = visibleTracks;
    if (v.includes(i) && v.length === 1) return; // keep at least one track shown
    changeMix({ tracks: v.includes(i) ? v.filter((x) => x !== i) : [...v, i].sort((a, b) => a - b) });
  };
  const toggleSyncView = (on: boolean) => {
    setSyncView(on);
    syncViewRef.current = on;
    writePref('jam.syncView', on ? '1' : '');
    if (on && jamRef.current) applyMix();
  };
  const toggleMute = (t: alphaTab.model.Track) => changeMix({ m: toggleSet(muted, t.index) });
  const toggleSolo = (t: alphaTab.model.Track) => changeMix({ s: toggleSet(soloed, t.index) });

  const applyMix = useCallback(() => {
    const m = roomRef.current.mix;
    if (!m || !score) return;
    const valid = (a: number[]) => a.filter((i) => i < score.tracks.length);
    const tracks = valid(m.tracks);
    // Same view → keep the array identity so the score isn't re-rendered.
    if (syncViewRef.current && tracks.length) setVisibleTracks((v) => (v.join() === tracks.join() ? v : tracks));
    setMuted(new Set(valid(m.muted)));
    setSoloed(new Set(valid(m.soloed)));
    setVolumes(m.volumes ?? []);
    setMetronome(m.metronome);
    setCountIn(m.countIn);
    setSource(m.source ?? 'synth');
  }, [score]);

  useEffect(() => {
    if (jam) applyMix();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.mix, score]);

  // ---------- uploads ----------
  const upload = useCallback(
    async (file: File) => {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        setToast(`Unsupported file .${ext}. Use Guitar Pro (gp/gp3-5/gpx), MusicXML or alphaTex.`);
        return;
      }
      try {
        const tab = await uploadTab(session, file, file.name, profile.name);
        roomRef.current.setTab(tab.id);
        setToast(`Uploaded ${file.name}`);
      } catch (e) {
        setToast((e as Error).message);
      }
    },
    [session, profile.name],
  );

  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) upload(f);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [upload]);

  // The admin's public URL (Admin → Settings), so an invite copied over the LAN still works for friends outside.
  const [publicUrl, setPublicUrl] = useState(location.origin);
  useEffect(() => void getConfig().then((c) => c.baseUrl && setPublicUrl(c.baseUrl), () => {}), []);
  const inviteLink = `${publicUrl}/#/r/${session.roomId}`;
  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setToast('Invite link copied — share the password separately');
    } catch {
      setToast(inviteLink);
    }
  };

  if (room.status === 'unauthorized') {
    return (
      <div className="center-card">
        <h2>Session expired</h2>
        <p className="muted">The room password may have changed. Rejoin to continue.</p>
        <button className="btn primary" onClick={onLeave}>
          Back to lobby
        </button>
      </div>
    );
  }

  return (
    <div className="room" style={{ ['--side-w' as string]: sideOpen ? `${sideW}px` : '44px' }}>
      <header className="room-head">
        <button className="btn ghost menu-btn" onClick={() => setDrawer(!drawer)} aria-label="Menu" aria-expanded={drawer}>
          ☰
        </button>
        <div className="brand-sm">
          tab<span>Share</span>
        </div>
        <div className="room-title">
          <h1>{room.roomName}</h1>
          <button className="code-chip" onClick={copyInvite} title="Copy invite link">
            <span className="hide-narrow">#{session.roomId} </span>⧉
          </button>
          {room.status !== 'open' && <span className="conn-warn">{room.status}…</span>}
        </div>
        <div className="peers">
          <PeerDot name={`${profile.name} (you)`} color={profile.color} jam={jam} inCall={call.inCall} />
          {peers.map((p) => (
            <PeerDot key={p.clientId} name={p.name} color={p.color} jam={p.jam} inCall={!!p.call} onClick={() => scoreRef.current?.scrollToPeer(p)} />
          ))}
        </div>
        {!call.inCall && (
          <button className="btn" onClick={call.join} title="Join the video/voice call">
            📹 <span className="hide-narrow">{call.peersInCall.length ? `Join call (${call.peersInCall.length})` : 'Start call'}</span>
          </button>
        )}
        <button className="btn ghost" onClick={onLeave}>
          Leave
        </button>
      </header>

      {narrow && drawer && <div className="drawer-veil" onClick={() => setDrawer(false)} />}
      <aside className={`side ${sideOpen || narrow ? '' : 'collapsed'} ${drawer ? 'drawer-open' : ''}`} {...drawerSwipe}>
        {!sideOpen && !narrow ? (
          <nav className="side-rail">
            <button onClick={() => toggleSide(true)} title="Expand panel">
              »
            </button>
            {(
              [
                ['tabs', '📚', 'Library'],
                ['tracks', '🎚', 'Tracks'],
                ['rig', '🎸', 'Rig'],
                ['chat', '💬', 'Chat'],
              ] as const
            ).map(([p, icon, label]) => (
              <button
                key={p}
                title={label}
                onClick={() => {
                  setPanel(p);
                  toggleSide(true);
                }}
              >
                {icon}
              </button>
            ))}
          </nav>
        ) : (
          <>
        <div className="side-resize" onPointerDown={startResize} title="Drag to resize" />
        <nav className="side-tabs">
          {(['tabs', 'tracks', 'rig', 'chat'] as const).map((p) => (
            <button key={p} className={panel === p ? 'on' : ''} onClick={() => setPanel(p)}>
              {p === 'tabs' ? 'Library' : p === 'tracks' ? 'Tracks' : p === 'rig' ? (rig.on ? 'Rig ●' : 'Rig') : `Chat${room.chat.length ? ` · ${room.chat.length}` : ''}`}
            </button>
          ))}
          <button className="side-collapse" onClick={() => (narrow ? setDrawer(false) : toggleSide(false))} title={narrow ? 'Close' : 'Collapse panel'}>
            {narrow ? '✕' : '«'}
          </button>
        </nav>

        {panel === 'tabs' && (
          <div className="panel">
            <div className="row gap">
              <label className="btn primary grow">
                + Add tab
                <input
                  type="file"
                  hidden
                  accept={ALLOWED_EXTENSIONS.map((e) => '.' + e).join(',')}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) upload(f);
                    e.target.value = '';
                  }}
                />
              </label>
              <button className="btn" onClick={() => setTexOpen(true)} title="Write a tab in alphaTex">
                ✎ Write
              </button>
            </div>
            <SongsterrSearch
              session={session}
              by={profile.name}
              onImported={(tab) => {
                room.setTab(tab.id);
                setToast(`Added ${tab.title ?? tab.fileName} from Songsterr`);
              }}
            />
            <ul className="tab-list">
              {room.tabs.length === 0 && <li className="muted small">Library is empty. Search Songsterr above, or add a Guitar Pro file.</li>}
              {room.tabs.map((t) => (
                <li key={t.id} className={t.id === room.currentTabId ? 'active' : ''}>
                  <button
                    className="tab-item"
                    onClick={() => {
                      room.setTab(t.id);
                      setDrawer(false);
                    }}
                  >
                    <strong>{t.title || t.fileName}</strong>
                    <span className="muted small">
                      {t.artist ? `${t.artist} · ` : ''}.{t.ext} · by {t.uploadedBy}
                    </span>
                  </button>
                  <button
                    className="icon-btn"
                    title="Remove from room"
                    onClick={() => {
                      if (window.confirm(`Remove "${t.title || t.fileName}" for everyone?`)) {
                        deleteTab(session, t.id).catch((e) => setToast(e.message));
                      }
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {panel === 'tracks' && (
          <div className="panel">
            {!score && <p className="muted small">Load a tab to see its tracks.</p>}
            {score && (
              <>
                <label className="small muted check-line" title="On: the tracks you see follow the jam. Off: show only the parts you play (mute, solo and volume still sync).">
                  <input type="checkbox" checked={syncView} onChange={(e) => toggleSyncView(e.target.checked)} /> Same track view as the jam
                </label>
                {original && <p className="banner note">Original audio is playing: mute, solo and volume only apply to the synth.</p>}
                <ul className={`track-list ${original ? 'audio-off' : ''}`}>
                  {score.tracks.map((t) => (
                    <li key={t.index}>
                      <label className="track-name">
                        <input type="checkbox" checked={visibleTracks.includes(t.index)} onChange={() => toggleVisible(t.index)} />
                        {t.name || `Track ${t.index + 1}`}
                      </label>
                      <button className={`ms ${muted.has(t.index) ? 'on' : ''}`} onClick={() => toggleMute(t)} title="Mute">
                        M
                      </button>
                      <button className={`ms solo ${soloed.has(t.index) ? 'on' : ''}`} onClick={() => toggleSolo(t)} title="Solo">
                        S
                      </button>
                      <label className="track-vol" title="Track volume (double-click to reset)">
                        <input
                          type="range"
                          min={0}
                          max={2}
                          step={0.05}
                          value={volumes[t.index] ?? 1}
                          aria-label={`${t.name || `Track ${t.index + 1}`} volume`}
                          onChange={(e) => setTrackVolume(t.index, Number(e.target.value))}
                          onDoubleClick={() => setTrackVolume(t.index, 1)}
                        />
                        <span className="mono small">{Math.round((volumes[t.index] ?? 1) * 100)}%</span>
                      </label>
                      <span className="viewers">
                        {peers
                          .filter((p) => p.tracks?.includes(t.index))
                          .map((p) => (
                            <i key={p.clientId} style={{ background: p.color }} title={`${p.name} is viewing`} />
                          ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {panel === 'rig' && <RigPanel rig={rig} inCall={call.inCall} />}
        {panel === 'chat' && <Chat room={room} />}
          </>
        )}
      </aside>

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
          {error && <div className="banner error">{error}</div>}
          {score && (
            <div className="song-head">
              <div>
                <h2>{score.title || currentTab?.fileName}</h2>
                <span className="muted">{[score.artist, score.album].filter(Boolean).join(' — ')}</span>
              </div>
              <div className="song-meta mono">
                ♩ = {score.tempo} {room.loop && <span className="loop-badge">⟲ loop by {room.loop.setBy}</span>}
                <button
                  className={`tab-only ${tabOnly ? 'on' : ''}`}
                  onClick={() => setTabOnly((v) => (writePref('tabOnly', v ? '' : '1'), !v))}
                  title="Hide standard notation and show only the tab (drums and other non-tab parts keep their staff)"
                  aria-pressed={tabOnly}
                >
                  Tab only
                </button>
                <span className="zoom" role="group" aria-label="Zoom">
                  <button onClick={() => changeZoom(zoom - 0.1)} disabled={zoom <= 0.5} aria-label="Zoom out">
                    −
                  </button>
                  <button onClick={() => changeZoom(1)} title="Reset zoom">
                    {Math.round(zoom * 100)}%
                  </button>
                  <button onClick={() => changeZoom(zoom + 0.1)} disabled={zoom >= 2} aria-label="Zoom in">
                    +
                  </button>
                </span>
              </div>
            </div>
          )}
          <ScoreView
            ref={scoreRef}
            data={tabData?.data ?? null}
            ext={tabData?.ext ?? null}
            peers={peers}
            onApi={setApi}
            onPointer={(cursor) => room.setPresence({ cursor })}
            onSelection={(sel) => {
              setSelection(sel);
              room.setPresence({ selection: sel });
            }}
            onLoadError={(m) => setError(`Could not open tab: ${m}`)}
          />
          {showFretboard && <Fretboard api={api} score={score} />}
        </div>
        {mode === 'practice' && <Practice tunerOn={showTuner} onToggleTuner={() => setShowTuner((v) => !v)} />}
      </main>
      {showTuner && <Tuner rig={rig} onClose={() => setShowTuner(false)} />}

      {mode === 'tab' && (
        <footer className="transport">
          <div className="tp-group">
            <button className="tp-btn" onClick={stop} disabled={!ready} title="Stop">
              ■
            </button>
            <button className="tp-btn play" onClick={playPause} disabled={!ready || !score} title="Play / pause (space)">
              {playing ? '❚❚' : '▶'}
            </button>
            <span className="mono time">
              {fmtTime(pos.cur)} / {fmtTime(pos.end)}
            </span>
          </div>
  
          <div className="tp-group">
            <button
              className={`tp-toggle ${room.loop ? 'on' : ''}`}
              onClick={toggleLoop}
              disabled={!score}
              title={room.loop ? 'Clear shared loop' : selection ? 'Loop selection for everyone' : 'Drag across beats to select, then loop'}
            >
              ⟲ {room.loop ? 'Clear loop' : selection ? 'Loop selection' : 'Loop'}
            </button>
            <button className={`tp-toggle ${metronome ? 'on' : ''}`} onClick={() => changeMix({ metronome: !metronome })} disabled={original}>
              Metronome
            </button>
            <button className={`tp-toggle ${countIn ? 'on' : ''}`} onClick={() => changeMix({ countIn: !countIn })} disabled={original}>
              Count-in
            </button>
          </div>
  
          <div className="tp-group">
            <div className="seg-mini" role="group" aria-label="Audio source">
              <button className={source === 'synth' ? 'on' : ''} onClick={() => changeMix({ source: 'synth' })} title="Synthesized playback with per-track controls">
                Synth
              </button>
              <button
                className={source === 'original' ? 'on' : ''}
                onClick={() => changeMix({ source: 'original' })}
                disabled={!score}
                title={currentTab?.youtube ? 'Play the original recording (YouTube)' : 'Link a YouTube recording to this tab'}
              >
                Original
              </button>
            </div>
          </div>
  
          <div className="tp-group speed">
            <label className="small muted" htmlFor="speed">
              Speed
            </label>
            <input id="speed" type="range" min={0.25} max={1.5} step={0.05} value={speed} onChange={(e) => changeSpeed(Number(e.target.value))} />
            <span className="mono">{Math.round(speed * 100)}%</span>
          </div>
  
          <div className="tp-group">
            <button className={`tp-toggle jam ${jam ? 'on' : ''}`} onClick={toggleJam} title="Synced for everyone in jam: play/pause, seek, speed, Synth/Original, track view, mute, solo, metronome and count-in">
              ● Jam sync {jam ? 'on' : 'off'}
            </button>
            {!ready && score && <span className="small muted">loading sounds…</span>}
          </div>
  
          <div className="tp-group">
            <button className={`tp-toggle ${showTuner ? 'on' : ''}`} onClick={() => setShowTuner((v) => !v)} title="Chromatic tuner (uses your rig input or microphone)">
              Tuner
            </button>
            <button className={`tp-toggle ${showFretboard ? 'on' : ''}`} onClick={toggleFretboard} title="Fretboard: scales, arpeggios, and the notes a track plays">
              Fretboard
            </button>
          </div>
        </footer>
      )}

      {source === 'original' && score && (
        <OriginalAudio
          video={currentTab?.youtube}
          getPlayOrder={getPlayOrder}
          getCurrentBar={getCurrentBar}
          onPlayer={onYtPlayer}
          onStateChange={onYtState}
          onSave={(video) => currentTab && room.sendTabVideo(currentTab.id, video)}
        />
      )}
      {texOpen && (
        <TexDialog
          onClose={() => setTexOpen(false)}
          onSubmit={async (name, text) => {
            setTexOpen(false);
            await upload(new File([text], `${name || 'untitled'}.tex`, { type: 'text/plain' }));
          }}
        />
      )}
      {dragging && <div className="drop-veil">Drop to share this tab with the room</div>}
      {toast && <div className="toast">{toast}</div>}
      {audioLocked && (
        // The window-level pointerdown handler does the unlocking; this is just the prompt.
        <button className="audio-unlock">
          🔊 {room.transport?.playing ? `${room.transport.by} is playing. Click to hear it.` : 'Click anywhere to enable sound'}
        </button>
      )}
    </div>
  );
}

function PeerDot({ name, color, jam, inCall, onClick }: { name: string; color: string; jam: boolean; inCall: boolean; onClick?: () => void }) {
  return (
    <button className="peer" style={{ ['--c' as string]: color }} onClick={onClick} title={onClick ? `Jump to ${name}` : name}>
      <span className="peer-ini">{name.slice(0, 1).toUpperCase()}</span>
      {jam && <span className="peer-jam" title="In jam sync" />}
      {inCall && <span className="peer-call" title="In the call">📹</span>}
      <span className="peer-name">{name}</span>
    </button>
  );
}

function Chat({ room }: { room: ReturnType<typeof useRoom> }) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [room.chat.length]);
  return (
    <div className="panel chat">
      <div className="chat-list" ref={listRef}>
        {room.chat.length === 0 && <p className="muted small">Say hi. Chat history stays with the room.</p>}
        {room.chat.map((m) => (
          <div key={m.id} className="chat-msg">
            <b style={{ color: m.color }}>{m.from}</b> <Linkified text={m.text} />
            {m.preview && <LinkCard preview={m.preview} />}
          </div>
        ))}
      </div>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) room.sendChat(text);
          setText('');
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message the room" maxLength={500} />
      </form>
    </div>
  );
}

const LINKS_RE = new RegExp(URL_RE.source, 'gi');

function Linkified({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINKS_RE)) {
    parts.push(text.slice(last, m.index));
    parts.push(
      <a key={m.index} href={m[0]} target="_blank" rel="noopener noreferrer">
        {m[0]}
      </a>,
    );
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <span>{parts}</span>;
}

function LinkCard({ preview }: { preview: LinkPreview }) {
  return (
    <a className="link-card" href={preview.url} target="_blank" rel="noopener noreferrer">
      {preview.image && <img src={preview.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.hidden = true)} />}
      <span className="link-card-body">
        {preview.siteName && <span className="link-card-site">{preview.siteName}</span>}
        <strong>{preview.title}</strong>
        {preview.description && <span className="link-card-desc">{preview.description}</span>}
      </span>
    </a>
  );
}

function TexDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (name: string, text: string) => void }) {
  const [name, setName] = useState('');
  const [text, setText] = useState(SAMPLE_TEX);
  return (
    <div className="modal-veil" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Write a tab (alphaTex)</h3>
        <p className="muted small">
          Fret.string notation, e.g. <code>3.6</code> = 3rd fret on low E. See alphatab.net/docs/alphatex for the full syntax.
        </p>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} spellCheck={false} />
        <div className="row gap end">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSubmit(name.trim(), text)}>
            Add to room
          </button>
        </div>
      </div>
    </div>
  );
}

export type { Peer };

/** Drawer: follows a leftward swipe and closes past a third of its width (or 80 px). Sliders and fields keep their touches. */
function useSwipeToClose(active: boolean, close: () => void) {
  const ref = useRef<HTMLElement>(null);
  const swipe = useRef<{ x: number; y: number; dx: number; horizontal: boolean | null } | null>(null);
  const end = () => {
    const s = swipe.current;
    const el = ref.current;
    swipe.current = null;
    if (!s || !el) return;
    el.style.transition = el.style.transform = '';
    if (s.horizontal && s.dx < -Math.min(80, el.offsetWidth / 3)) close();
  };
  return {
    ref,
    onTouchStart: (e: React.TouchEvent) => {
      if (!active || (e.target as Element).closest('input, select, textarea')) return;
      swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, horizontal: null };
    },
    onTouchMove: (e: React.TouchEvent) => {
      const s = swipe.current;
      const el = ref.current;
      if (!s || !el) return;
      const dx = e.touches[0].clientX - s.x;
      const dy = e.touches[0].clientY - s.y;
      // Decide once, after a few px: vertical drags stay scrolls of the panel.
      if (s.horizontal === null && Math.abs(dx) + Math.abs(dy) > 8) s.horizontal = Math.abs(dx) > Math.abs(dy);
      if (!s.horizontal) return;
      s.dx = Math.min(0, dx);
      el.style.transition = 'none';
      el.style.transform = `translateX(${s.dx}px)`;
    },
    onTouchEnd: end,
    onTouchCancel: end,
  };
}

/** True on small screens and touch-only devices like iPads (same query as the CSS drawer layout). */
function useNarrow() {
  const query = '(max-width: 860px), (max-height: 500px), (hover: none) and (pointer: coarse)';
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}
