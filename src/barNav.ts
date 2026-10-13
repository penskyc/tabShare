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
  let barIndex: number;
  if (by === 'bar') {
    const target = bars[Math.min(bars.length - 1, Math.max(0, i + dir))];
    start = target.start;
    barIndex = target.masterBar.index;
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
    barIndex = first;
  }
  api.tickPosition = start;
  revealRow(api, barIndex);
  return true;
}

/**
 * Scrolls the row holding `barIndex` into view (only if it isn't already). Not api.scrollToCursor(): alphaTab moves its
 * cursor a moment after tickPosition is set, so that scrolled to the old row and moving up left the new one hidden.
 */
function revealRow(api: alphaTab.AlphaTabApi, barIndex: number) {
  const row = api.renderer.boundsLookup?.staffSystems.find((s) => s.bars.some((b) => b.index === barIndex))?.visualBounds;
  const scroller = api.settings.player.scrollElement;
  const host = (api.container as unknown as { element?: HTMLElement }).element;
  if (!row || !host || !(scroller instanceof HTMLElement)) return;
  const margin = 24;
  const hostBox = host.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  const top = hostBox.top - box.top + scroller.scrollTop + row.y;
  const to: ScrollToOptions = { behavior: 'smooth' };
  if (top < scroller.scrollTop + margin || top + row.h > scroller.scrollTop + scroller.clientHeight - margin) to.top = Math.max(0, top - 2 * margin);
  // Horizontal layout is one long row: bring the bar itself into view sideways.
  const bar = api.renderer.boundsLookup?.findMasterBarByIndex(barIndex)?.visualBounds;
  const left = bar ? hostBox.left - box.left + scroller.scrollLeft + bar.x : scroller.scrollLeft;
  if (bar && (left < scroller.scrollLeft + margin || left + bar.w > scroller.scrollLeft + scroller.clientWidth - margin)) to.left = Math.max(0, left - 2 * margin);
  if (to.top != null || to.left != null) scroller.scrollTo(to);
}
