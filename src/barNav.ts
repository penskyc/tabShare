import type * as alphaTab from '@coderline/alphatab';

export type Step = { by: 'bar' | 'row'; dir: -1 | 1 };

/** ← / → = previous/next bar, ↑ / ↓ = previous/next row (no modifiers, not while typing), else null. */
export function arrowStep(e: KeyboardEvent): Step | null {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return null;
  const map: Record<string, Step> = {
    ArrowLeft: { by: 'bar', dir: -1 },
    ArrowRight: { by: 'bar', dir: 1 },
    ArrowUp: { by: 'row', dir: -1 },
    ArrowDown: { by: 'row', dir: 1 },
  };
  return map[e.key] ?? null;
}

/**
 * Moves the playback cursor to the start of the previous/next bar (in playback order, so repeats count), or of the
 * first bar on the previous/next row of the rendered score. Returns false if there's nowhere to go.
 */
export function step(api: alphaTab.AlphaTabApi, { by, dir }: Step): boolean {
  const bars = api.tickCache?.masterBars;
  if (!bars?.length) return false;
  const t = api.tickPosition;
  let i = bars.findIndex((b) => t >= b.start && t < b.end);
  if (i < 0) i = t >= bars[bars.length - 1].end ? bars.length - 1 : 0;
  let start: number;
  if (by === 'bar') {
    start = bars[Math.min(bars.length - 1, Math.max(0, i + dir))].start;
  } else {
    const rows = api.renderer.boundsLookup?.staffSystems ?? [];
    const row = rows.findIndex((s) => s.bars.some((b) => b.index === bars[i].masterBar.index));
    const target = rows[row + dir];
    if (row < 0 || !target?.bars.length) return false;
    // That bar may be played more than once (repeats): take the nearest occurrence in the direction of travel.
    const first = target.bars[0].index;
    const hits = bars.filter((b) => b.masterBar.index === first);
    const pick = dir > 0 ? (hits.find((b) => b.start > t) ?? hits[0]) : ([...hits].reverse().find((b) => b.start < t) ?? hits[hits.length - 1]);
    if (!pick) return false;
    start = pick.start;
  }
  api.tickPosition = start;
  api.scrollToCursor();
  return true;
}
