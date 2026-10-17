import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SyncPoint, TabVideo } from '../shared/protocol';
import { mergeSyncPoints, parseYouTubeId, shiftSyncPoints, type PlayedBar } from '../shared/sync';
import { StemPlayer } from './stemPlayer';

const readLocal = (k: string) => {
  try {
    return localStorage.getItem(`tabshare.${k}`);
  } catch {
    return null;
  }
};
const writeLocal = (k: string, v: string) => {
  try {
    if (v) localStorage.setItem(`tabshare.${k}`, v);
    else localStorage.removeItem(`tabshare.${k}`);
  } catch {
    /* storage blocked */
  }
};

/** The subset of the YouTube IFrame player API we use. */
export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlaybackRate(): number;
  setPlaybackRate(rate: number): void;
  getVolume(): number;
  setVolume(volume: number): void;
  destroy(): void;
}

declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: object) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<void> | null = null;
function loadYouTubeApi() {
  apiPromise ??= new Promise<void>((resolve) => {
    if (window.YT?.Player) return resolve();
    window.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  });
  return apiPromise;
}

export const YT_PLAYING = 1;
export const YT_PAUSED = 2;
export const YT_ENDED = 0;

interface Props {
  video: TabVideo | undefined;
  /** Stems mode: the stems' URLs once they exist (they play instead of YouTube), and the panel that makes them. */
  stems?: { urls: string[] | null; panel: ReactNode };
  /** Sync points of what's playing (the video's, or uploaded stems' own). */
  syncPoints: SyncPoint[];
  onSaveSync: (points: SyncPoint[]) => void;
  /** Bars in playback order, for mapping taps to (bar, occurrence). */
  getPlayOrder: () => PlayedBar[];
  /** 0-based master bar index under the cursor, used as the default tap start. */
  getCurrentBar: () => number;
  onPlayer: (p: YTPlayer | null) => void;
  onStateChange: (state: number) => void;
  onSave: (video: TabVideo | null) => void;
}

export function OriginalAudio({ video, stems, syncPoints, onSaveSync, getPlayOrder, getCurrentBar, onPlayer, onStateChange, onSave }: Props) {
  const stemUrls = stems?.urls ?? null;
  // Something to play: the stems in Stems mode, else the YouTube video.
  const media = stems ? !!stemUrls : !!video;
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState(false);
  const [showSync, setShowSync] = useState(false);
  // Minimize = the smallest player YouTube allows, no tools. The box can be dragged by its title bar; both remembered.
  const [mini, setMini] = useState(() => readLocal('yt.mini') === '1');
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      return JSON.parse(readLocal('yt.pos') ?? 'null');
    } catch {
      return null;
    }
  });
  const boxRef = useRef<HTMLDivElement>(null);
  const toggleMini = () => {
    setMini((m) => (writeLocal('yt.mini', m ? '' : '1'), !m));
  };
  // Keep a dragged box on screen when the window shrinks.
  useEffect(() => {
    if (!pos) return;
    const clamp = () => {
      const el = boxRef.current;
      if (!el) return;
      const x = Math.max(0, Math.min(pos.x, innerWidth - el.offsetWidth));
      const y = Math.max(0, Math.min(pos.y, innerHeight - el.offsetHeight));
      if (x !== pos.x || y !== pos.y) setPos({ x, y });
    };
    clamp();
    addEventListener('resize', clamp);
    return () => removeEventListener('resize', clamp);
  }, [pos, mini, showSync]);
  const startDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button') || !boxRef.current) return;
    const r = boxRef.current.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev: PointerEvent) => setPos({ x: ev.clientX - dx, y: ev.clientY - dy });
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      writeLocal('yt.pos', JSON.stringify({ x: ev.clientX - dx, y: ev.clientY - dy }));
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };
  const [startBar, setStartBar] = useState(1);
  const [tapping, setTapping] = useState<{ order: PlayedBar[]; start: number; taps: SyncPoint[] } | null>(null);
  const cb = useRef({ onPlayer, onStateChange });
  cb.current = { onPlayer, onStateChange };

  // Stems mode: the stem player (no video to show).
  const stemKey = stemUrls?.join(' ');
  useEffect(() => {
    if (!stemKey) return;
    const player = new StemPlayer(stemKey.split(' '), (s) => cb.current.onStateChange(s));
    playerRef.current = player;
    cb.current.onPlayer(player);
    return () => {
      cb.current.onPlayer(null);
      player.destroy();
      playerRef.current = null;
    };
  }, [stemKey]);

  // (Re)create the YouTube player when the video changes.
  const videoId = stems ? undefined : video?.videoId;
  useEffect(() => {
    if (!videoId || !hostRef.current) return;
    let cancelled = false;
    const mount = document.createElement('div');
    hostRef.current.replaceChildren(mount);
    loadYouTubeApi().then(() => {
      if (cancelled || !window.YT) return;
      const player = new window.YT.Player(mount, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => {
            playerRef.current = player;
            cb.current.onPlayer(player);
          },
          onStateChange: (e: { data: number }) => cb.current.onStateChange(e.data),
        },
      });
    });
    return () => {
      cancelled = true;
      cb.current.onPlayer(null);
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [videoId]);

  const saveUrl = () => {
    const id = parseYouTubeId(url);
    setUrlError(!id);
    if (id) {
      onSave({ videoId: id, syncPoints: id === video?.videoId ? video.syncPoints : [] });
      setUrl('');
    }
  };

  const startTapping = () => {
    const order = getPlayOrder();
    const start = Math.max(0, order.findIndex((b) => b.index === startBar - 1));
    setTapping({ order, start, taps: [] });
  };

  const tap = () => {
    const p = playerRef.current;
    if (!p || !tapping) return;
    const pos = tapping.start + tapping.taps.length;
    const bar = tapping.order[pos];
    if (!bar) return;
    const point: SyncPoint = { barIndex: bar.index, barOccurence: bar.occurrence, barPosition: 0, millisecondOffset: Math.max(0, p.getCurrentTime() * 1000) };
    setTapping({ ...tapping, taps: [...tapping.taps, point] });
  };

  const finishTapping = () => {
    if (media && tapping?.taps.length) onSaveSync(mergeSyncPoints(syncPoints, tapping.taps));
    setTapping(null);
  };

  // T (or Enter) taps while tap-sync is active.
  const tapRef = useRef(tap);
  tapRef.current = tap;
  useEffect(() => {
    if (!tapping) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code === 'KeyT' || e.code === 'Enter') {
        e.preventDefault();
        tapRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tapping]);

  const nextBar = tapping ? tapping.order[tapping.start + tapping.taps.length] : undefined;

  return (
    <div
      ref={boxRef}
      className={`original-box ${mini ? 'mini' : ''} ${stems ? 'stems' : ''}`}
      style={pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined}
    >
      <div className="original-head" onPointerDown={startDrag} title="Drag to move">
        <strong>{stems ? 'Stems' : 'Original audio'}</strong>
        {media && !mini && <span className="muted small">{syncPoints.length ? `${syncPoints.length} sync points` : 'not synced yet'}</span>}
        {media && !mini && (
          <button className={`call-btn ${showSync ? 'on' : ''}`} onClick={() => setShowSync(!showSync)}>
            ⏱ Sync
          </button>
        )}
        {media && (
          <button className="call-btn yt-min" onClick={toggleMini} aria-label={mini ? 'Expand' : 'Minimize'} title={mini ? 'Expand' : 'Minimize'}>
            {mini ? '▢' : '–'}
          </button>
        )}
      </div>

      {/* YouTube's terms require a visible player of at least 200×200. */}
      <div className="original-video" ref={hostRef} hidden={!!stems || !video} />

      {stems && !mini && stems.panel}

      {(!media || (showSync && !mini)) && (!stems || media) && (
        <div className="original-tools">
          {!stems && (
            <>
              <div className="row gap">
                <input
                  placeholder={video ? 'Replace YouTube link…' : 'Paste a YouTube link for this tab'}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveUrl()}
                />
                <button className="btn" onClick={saveUrl}>
                  Link
                </button>
              </div>
              {urlError && <span className="call-error">That doesn't look like a YouTube link.</span>}
            </>
          )}

          {media && !tapping && (
            <>
              <p className="muted small">
                Tap sync: play the {stems ? 'song' : 'video'} and press <b>T</b> on the first beat of every bar. Tapping just
                bar 1 sets the start offset; more taps follow tempo changes.
              </p>
              <div className="row gap">
                <label className="small muted row gap">
                  Start at bar
                  <input type="number" min={1} value={startBar} onChange={(e) => setStartBar(Math.max(1, Number(e.target.value) || 1))} style={{ width: 70 }} />
                </label>
                <button className="btn ghost" onClick={() => setStartBar(getCurrentBar() + 1)} title="Use the bar under the cursor">
                  ↦ cursor
                </button>
                <button className="btn primary" onClick={startTapping}>
                  Start tapping
                </button>
              </div>
              <div className="row gap">
                <span className="small muted">Shift all</span>
                <button className="btn" disabled={!syncPoints.length} onClick={() => onSaveSync(shiftSyncPoints(syncPoints, -50))}>
                  −50 ms
                </button>
                <button className="btn" disabled={!syncPoints.length} onClick={() => onSaveSync(shiftSyncPoints(syncPoints, 50))}>
                  +50 ms
                </button>
                <button className="btn ghost" disabled={!syncPoints.length} onClick={() => window.confirm('Clear all sync points?') && onSaveSync([])}>
                  Clear
                </button>
                {!stems && (
                  <button className="btn ghost danger" onClick={() => window.confirm('Unlink the video from this tab?') && onSave(null)}>
                    Unlink
                  </button>
                )}
              </div>
            </>
          )}

          {tapping && (
            <div className="tap-panel">
              <button className="tap-btn" onClick={tap} disabled={!nextBar}>
                {nextBar ? (
                  <>
                    TAP <span>bar {nextBar.index + 1}{nextBar.occurrence ? ` (repeat ${nextBar.occurrence + 1})` : ''}</span>
                  </>
                ) : (
                  'End of song'
                )}
              </button>
              <span className="muted small">{tapping.taps.length} tapped · press T</span>
              <div className="row gap">
                <button className="btn ghost" onClick={() => setTapping(null)}>
                  Cancel
                </button>
                <button className="btn primary" onClick={finishTapping} disabled={!tapping.taps.length}>
                  Save {tapping.taps.length} points
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
