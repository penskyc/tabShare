// Which sound bank the synth uses. Phones, tablets and the iOS app always use the small built-in one; web and desktop
// pick per person (default MuseScore General). The full banks come from scripts/fetch-soundfonts.mjs.
import { useSyncExternalStore } from 'react';

export const SOUND_BANKS = [
  { id: 'light', name: 'Light', size: '1.3 MB', url: '/soundfont/sonivox.sf2' },
  { id: 'generaluser', name: 'GeneralUser GS', size: '32 MB', url: '/soundfont/GeneralUser-GS.sf2' },
  { id: 'musescore', name: 'MuseScore General', size: '40 MB', url: '/soundfont/MuseScore_General.sf3' },
] as const;
export type SoundBankId = (typeof SOUND_BANKS)[number]['id'];

const KEY = 'tabshare.soundBank';
const DEFAULT_FULL: SoundBankId = 'musescore';

/** Touch-only devices (phones, iPads) and the iOS app: keep the 1.3 MB bank (download size, memory). */
export const lightOnly = () =>
  (window as Window & { tabshareNative?: { platform?: string } }).tabshareNative?.platform === 'ios' || matchMedia('(hover: none) and (pointer: coarse)').matches;

function read(): SoundBankId {
  if (lightOnly()) return 'light';
  try {
    const v = localStorage.getItem(KEY);
    if (SOUND_BANKS.some((b) => b.id === v)) return v as SoundBankId;
  } catch {
    /* storage blocked */
  }
  return DEFAULT_FULL;
}

let current = read();
const listeners = new Set<() => void>();

export const soundBankUrl = () => SOUND_BANKS.find((b) => b.id === current)!.url;

export function setSoundBank(id: SoundBankId) {
  if (lightOnly() || id === current) return;
  current = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* per-session only */
  }
  listeners.forEach((l) => l());
}

export function onSoundBankChange(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const useSoundBank = () => useSyncExternalStore(onSoundBankChange, () => current);
