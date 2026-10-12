import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import * as alphaTab from '@coderline/alphatab';
import type { Peer, ScorePoint, TickRange } from '../shared/protocol';
import { onSoundBankChange, soundBankUrl } from './soundfont';
import { isScoreDark, onScoreThemeChange, themer, useScoreDark } from './scoreTheme';

type BoundsLookup = NonNullable<alphaTab.AlphaTabApi['renderer']['boundsLookup']>;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Flattened beat geometry for the first staff of every rendered bar, rebuilt after each render. */
interface BeatGeom {
  start: number;
  end: number;
  x: number;
  w: number;
  system: number;
}

interface Layout {
  lookup: BoundsLookup;
  bars: Map<number, Rect>;
  systems: Rect[];
  beats: BeatGeom[];
}

export interface ScoreViewHandle {
  scrollToPeer: (peer: Peer) => void;
}

interface Props {
  ref?: Ref<ScoreViewHandle>;
  data: ArrayBuffer | null;
  ext: string | null;
  peers: Peer[];
  onApi: (api: alphaTab.AlphaTabApi | null) => void;
  onPointer: (p: ScorePoint | null) => void;
  onSelection: (r: TickRange | null) => void;
  onLoadError: (message: string) => void;
}

const rect = (b: { x: number; y: number; w: number; h: number }): Rect => ({ x: b.x, y: b.y, w: b.w, h: b.h });

function buildLayout(lookup: BoundsLookup): Layout {
  const bars = new Map<number, Rect>();
  const systems: Rect[] = [];
  const beats: BeatGeom[] = [];
  lookup.staffSystems.forEach((sys, si) => {
    systems.push(rect(sys.realBounds));
    for (const mb of sys.bars) {
      if (!bars.has(mb.index)) bars.set(mb.index, rect(mb.realBounds));
      const staffBar = mb.bars[0];
      if (!staffBar) continue;
      for (const bb of staffBar.beats) {
        const start = bb.beat.absolutePlaybackStart;
        beats.push({ start, end: start + bb.beat.playbackDuration, x: bb.realBounds.x, w: bb.realBounds.w, system: si });
      }
    }
  });
  return { lookup, bars, systems, beats };
}

function pointFromXY(layout: Layout, x: number, y: number): ScorePoint | null {
  const systems = layout.lookup.staffSystems;
  if (!systems.length) return null;
  let sys = systems.find((s) => y >= s.realBounds.y && y <= s.realBounds.y + s.realBounds.h);
  if (!sys) {
    // Between systems: snap to the nearest one so the cursor never disappears.
    let best = Infinity;
    for (const s of systems) {
      const d = Math.min(Math.abs(y - s.realBounds.y), Math.abs(y - (s.realBounds.y + s.realBounds.h)));
      if (d < best) {
        best = d;
        sys = s;
      }
    }
  }
  if (!sys || !sys.bars.length) return null;
  const bars = sys.bars;
  const mb =
    bars.find((b) => x >= b.realBounds.x && x <= b.realBounds.x + b.realBounds.w) ??
    (x < bars[0].realBounds.x ? bars[0] : bars[bars.length - 1]);
  const r = mb.realBounds;
  return { bar: mb.index, fx: (x - r.x) / r.w, fy: (y - r.y) / r.h };
}

function xyFromPoint(layout: Layout, p: ScorePoint): { x: number; y: number } | null {
  const r = layout.bars.get(p.bar);
  if (!r) return null;
  return { x: r.x + p.fx * r.w, y: r.y + p.fy * r.h };
}

function rangeRects(layout: Layout, range: TickRange): Rect[] {
  const bySystem = new Map<number, { min: number; max: number }>();
  for (const b of layout.beats) {
    if (b.start < range.startTick || b.start >= range.endTick) continue;
    const cur = bySystem.get(b.system);
    if (cur) {
      cur.min = Math.min(cur.min, b.x);
      cur.max = Math.max(cur.max, b.x + b.w);
    } else bySystem.set(b.system, { min: b.x, max: b.x + b.w });
  }
  return [...bySystem].map(([si, { min, max }]) => {
    const s = layout.systems[si];
    return { x: min, y: s.y, w: max - min, h: s.h };
  });
}

function tickLine(layout: Layout, tick: number): Rect | null {
  const b = layout.beats.find((g) => tick >= g.start && tick < g.end);
  if (!b) return null;
  const s = layout.systems[b.system];
  return { x: b.x + ((tick - b.start) / (b.end - b.start)) * b.w, y: s.y, w: 2, h: s.h };
}

export function ScoreView({ ref, data, ext, peers, onApi, onPointer, onSelection, onLoadError }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<alphaTab.AlphaTabApi | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [loading, setLoading] = useState(false);
  const dark = useScoreDark();

  // Latest callbacks without re-creating the alphaTab instance.
  const cb = useRef({ onApi, onPointer, onSelection, onLoadError });
  cb.current = { onApi, onPointer, onSelection, onLoadError };

  useEffect(() => {
    const api = new alphaTab.AlphaTabApi(mainRef.current!, {
      core: { fontDirectory: '/font/', useWorkers: true },
      display: { layoutMode: alphaTab.LayoutMode.Page, scale: 1.0 },
      player: {
        playerMode: alphaTab.PlayerMode.EnabledSynthesizer,
        soundFont: soundBankUrl(),
        scrollElement: scrollRef.current!,
        enableUserInteraction: true,
        scrollOffsetY: -40,
      },
    } as alphaTab.json.SettingsJson);
    apiRef.current = api;
    // Light/dark paper: set before the first render, re-render on a switch.
    const theme = themer(api.settings.display.resources);
    theme(isScoreDark());
    const offTheme = onScoreThemeChange(() => {
      theme(isScoreDark());
      api.updateSettings();
      if (api.score) api.render();
    });

    api.renderStarted.on(() => setLoading(true));
    api.renderFinished.on(() => {
      setLoading(false);
      const lookup = api.renderer.boundsLookup;
      if (lookup) setLayout(buildLayout(lookup));
    });
    api.playbackRangeChanged.on((e) => {
      const r = e.playbackRange;
      cb.current.onSelection(r ? { startTick: r.startTick, endTick: r.endTick } : null);
    });
    api.error.on((e) => {
      setLoading(false);
      cb.current.onLoadError(e.message ?? String(e));
    });

    // Switching the sound bank reloads it in place (no page reload; playback keeps its position).
    const offBank = onSoundBankChange(() => api.loadSoundFont(soundBankUrl(), false));

    cb.current.onApi(api);
    return () => {
      offBank();
      offTheme();
      cb.current.onApi(null);
      apiRef.current = null;
      api.destroy();
    };
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    if (!api || !data) return;
    setLayout(null);
    setLoading(true);
    try {
      if (ext === 'tex') api.tex(new TextDecoder().decode(data));
      else api.load(new Uint8Array(data));
    } catch (e) {
      setLoading(false);
      cb.current.onLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [data, ext]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToPeer(peer) {
        const el = scrollRef.current;
        if (!el || !layout) return;
        let y: number | null = null;
        if (peer.cursor) y = xyFromPoint(layout, peer.cursor)?.y ?? null;
        if (y == null && peer.playTick != null) y = tickLine(layout, peer.playTick)?.y ?? null;
        if (y != null) el.scrollTo({ top: Math.max(0, y - el.clientHeight / 3), behavior: 'smooth' });
      },
    }),
    [layout],
  );

  const lastSent = useRef(0);
  const onMove = (e: React.PointerEvent) => {
    if (!layout || !wrapRef.current) return;
    const now = performance.now();
    if (now - lastSent.current < 40) return;
    lastSent.current = now;
    const box = wrapRef.current.getBoundingClientRect();
    cb.current.onPointer(pointFromXY(layout, e.clientX - box.left, e.clientY - box.top));
  };

  const overlays = useMemo(() => {
    if (!layout) return null;
    return peers.map((p) => {
      const cursor = p.cursor ? xyFromPoint(layout, p.cursor) : null;
      const sel = p.selection ? rangeRects(layout, p.selection) : [];
      const play = p.playTick != null ? tickLine(layout, p.playTick) : null;
      return (
        <g key={p.clientId}>
          {sel.map((r, i) => (
            <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={p.color} fillOpacity={0.16} stroke={p.color} strokeOpacity={0.7} strokeDasharray="4 3" rx={3} />
          ))}
          {play && <rect x={play.x} y={play.y} width={play.w} height={play.h} fill={p.color} opacity={0.85} />}
          {cursor && (
            <g transform={`translate(${cursor.x},${cursor.y})`} className="peer-cursor">
              <path d="M0 0 L0 16 L4.5 12 L8 19 L10.5 18 L7 11 L13 11 Z" fill={p.color} stroke="#0b0b10" strokeWidth={1.2} />
              <foreignObject x={12} y={14} width={160} height={24}>
                <span className="peer-tag" style={{ background: p.color }}>
                  {p.name}
                </span>
              </foreignObject>
            </g>
          )}
        </g>
      );
    });
  }, [layout, peers]);

  return (
    <div className="score-scroll" ref={scrollRef}>
      {!data && (
        <div className="score-empty">
          <div className="score-empty-mark">𝄞</div>
          <p>No tab loaded yet.</p>
          <p className="muted">Drop a Guitar Pro file (.gp, .gp5, .gpx…) or MusicXML anywhere on the page, or use “Add tab”.</p>
        </div>
      )}
      <div className={`score-paper ${dark ? 'dark' : ''}`} ref={wrapRef} onPointerMove={onMove} onPointerLeave={() => cb.current.onPointer(null)} hidden={!data}>
        <div ref={mainRef} className="score-main" />
        <svg className="score-overlay">{overlays}</svg>
        {loading && <div className="score-loading">Rendering…</div>}
      </div>
    </div>
  );
}
