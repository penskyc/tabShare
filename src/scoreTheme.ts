// Light or dark score paper, per person (tabshare.scoreTheme). ScoreView applies it to every alphaTab instance
// (room tab and Practice), so one toggle covers both.
import { useSyncExternalStore } from 'react';
import * as alphaTab from '@coderline/alphatab';

const KEY = 'tabshare.scoreTheme';
type Resources = alphaTab.RenderingResources;
type ColorKey = 'staffLineColor' | 'barSeparatorColor' | 'barNumberColor' | 'mainGlyphColor' | 'secondaryGlyphColor' | 'scoreInfoColor';

const rgb = (hex: string, a = 255) => new alphaTab.model.Color(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), a);
const DARK: Record<ColorKey, alphaTab.model.Color> = {
  staffLineColor: rgb('#5d5d72'),
  barSeparatorColor: rgb('#9a9ab0'),
  barNumberColor: rgb('#ff7a3d'),
  mainGlyphColor: rgb('#ecebf3'),
  secondaryGlyphColor: rgb('#ecebf3', 110),
  scoreInfoColor: rgb('#ecebf3'),
};
const KEYS = Object.keys(DARK) as ColorKey[];

function read() {
  try {
    return localStorage.getItem(KEY) === 'dark';
  } catch {
    return false;
  }
}
let dark = read();
const listeners = new Set<() => void>();

export function setScoreDark(v: boolean) {
  dark = v;
  try {
    localStorage.setItem(KEY, v ? 'dark' : 'light');
  } catch {
    /* per-session only */
  }
  listeners.forEach((l) => l());
}
export const isScoreDark = () => dark;
export function onScoreThemeChange(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const useScoreDark = () => useSyncExternalStore(onScoreThemeChange, () => dark);

/** Remembers alphaTab's own (light) colors, then returns a function that switches this instance's resources. */
export function themer(res: Resources) {
  const light = Object.fromEntries(KEYS.map((k) => [k, res[k]])) as Record<ColorKey, alphaTab.model.Color>;
  return (isDark: boolean) => {
    for (const k of KEYS) res[k] = (isDark ? DARK : light)[k];
  };
}
