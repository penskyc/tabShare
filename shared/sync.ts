import type { SyncPoint } from './protocol.js';

/** Extracts the 11-char video id from any common YouTube URL form (or a bare id). */
export function parseYouTubeId(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id: string | null = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      id = u.searchParams.get('v') ?? u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/]+)/)?.[1] ?? null;
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** One entry per bar as it is actually played (repeats/jumps expanded), with its occurrence count. */
export interface PlayedBar {
  index: number;
  occurrence: number;
}

export function playOrder(masterBarIndexes: number[]): PlayedBar[] {
  const seen = new Map<number, number>();
  return masterBarIndexes.map((index) => {
    const occurrence = seen.get(index) ?? 0;
    seen.set(index, occurrence + 1);
    return { index, occurrence };
  });
}

/** Replaces existing points for the tapped bars with the new taps; result is sorted by video time. */
export function mergeSyncPoints(existing: SyncPoint[], taps: SyncPoint[]): SyncPoint[] {
  const key = (p: SyncPoint) => `${p.barIndex}:${p.barOccurence}:${p.barPosition}`;
  const tapped = new Set(taps.map(key));
  return [...existing.filter((p) => !tapped.has(key(p))), ...taps].sort((a, b) => a.millisecondOffset - b.millisecondOffset);
}

export function shiftSyncPoints(points: SyncPoint[], ms: number): SyncPoint[] {
  return points.map((p) => ({ ...p, millisecondOffset: Math.max(0, p.millisecondOffset + ms) }));
}
