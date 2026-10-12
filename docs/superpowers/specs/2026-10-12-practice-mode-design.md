# Practice mode — design

Date: 2026-10-12. Status: approved in brainstorming, awaiting spec review.

## Goal

A **Tab | Practice** switch in the room's main area. Practice mode offers bass exercises that are generated as
playable tabs (notation, synth, loop, metronome) with the fretboard lighting each note, plus a few fretboard-only
theory views.

## Decisions

| Question | Decision |
|---|---|
| What an exercise is | A short tab generated from key, tempo, tuning and options; regenerates on any change. |
| Solo or shared | Solo. Nothing about practice is sent to the room; jam sync never touches it. |
| Tracking | None in v1. Only per-exercise settings are remembered (localStorage). |
| Instrument | Bass: 4-string standard by default, 5-string (low B) option. |
| v1 scope | All playable categories (warm-up, scales, arpeggios, walking bass, groove) + theory as fretboard views. No ear training. |
| Architecture | Separate Practice view with its own alphaTab player (Approach 1). |

Non-goals (v1): practice logging/stats/favorites, guitar exercises, shared/synced practice, ear training, editing
the generated tab.

## UI

- **Switch:** two-button `Tab | Practice` toggle at the left of the main area's header; always visible (drawer
  layout included). Remembered in `tabshare.practice.mode`. Entering Practice pauses your tab playback; the room,
  presence, chat, call, tuner and rig are unaffected.
- **Practice area** (replaces the score area; side panel stays):
  - **Picker bar:** category, exercise, then the exercise's settings (key, tuning, tempo 40–200, exercise options).
    Any change regenerates immediately.
  - **Info strip:** description + 2–3 tips (collapsible).
  - **Score:** the generated exercise (2–8 bars typical).
  - **Fretboard:** always shown; Follow is locked to the exercise track while playing; when stopped it shows the
    exercise's pitch set (scale / chord tones) as dots.
  - **Transport** (replaces the tab transport in Practice): play/pause, stop, loop (on by default), metronome,
    count-in, **speed up each loop** (+N BPM per pass, default +2, up to a target tempo). Tuner and rig buttons stay.
- **Theory items** have no score: picker + fretboard only.
- Settings are remembered per exercise: `tabshare.practice.<exerciseId>` = `{ key, tuning, tempo, ...options }`.

## Exercises (v1)

Every playable exercise takes key (where meaningful), tempo and tuning.

**Warm-up**
1. Chromatic crawl: 1-2-3-4 across all strings, up and back. Option: start fret (1–9).
2. Spider walk: 1-2-3-4 shifting up one fret per string. Option: start fret.
3. String crossing: alternating string skips on one fret. Option: fret.

**Scales** (scale options: major, natural minor, major pentatonic, minor pentatonic, dorian, mixolydian, blues)
4. Scale, one position: options scale, octaves (1/2).
5. Scale in thirds: option scale.
6. Scale sequences: groups of 3 or 4, up and down. Options scale, group size.
7. Find the note (fretboard-only): every position of a chosen note.

**Arpeggios & chord tones**
8. Triad arpeggio: major/minor/dim/aug; root position or inversion 1/2.
9. 7th-chord arpeggio: maj7, 7, m7, m7♭5.
10. Diatonic arpeggios: the key's chords I–vii in order; triads or 7ths.

**Walking bass** (quarter notes, 4/4). Progression option for 11–13: I-IV-V-I, I-vi-ii-V, ii-V-I, 12-bar blues.
11. Root-5th-octave.
12. Chord tones: pattern 1-3-5-3 or 1-3-5-6.
13. Chromatic approach: chord tones, last beat a half step into the next bar's root.
14. 12-bar blues walk: chord tones + approach notes over I-IV-V.
15. ii-V-I walk: major or minor.

**Groove** (root, or root-5th; over 1–4 chords)
16. 8th-note lock-in.
17. 16th funk with ghost notes (dead notes between accents).
18. Syncopation (anticipations on the "and" of 4).
19. Reggae one-drop (rest on 1, root on 3).
20. R&B / Motown (root, octave, 5th pickup).

**Theory** (fretboard-only)
21. Intervals from a root: pick an interval; all its positions on the neck.
22. Diatonic chords: chord tones of degree I–vii in a key.

Descriptions and tips are adapted from the author's earlier bass practice library.

## Code structure

### `shared/exercises.ts` (pure, unit tested)

```ts
type ParamSpec =
  | { id: string; label: string; kind: 'key'; default: number }
  | { id: string; label: string; kind: 'choice'; options: string[]; default: string }
  | { id: string; label: string; kind: 'number'; min: number; max: number; step?: number; default: number };

interface PracticeNote { string: number; fret: number; duration: 1 | 2 | 4 | 8 | 16; dotted?: boolean; dead?: boolean; rest?: boolean }
interface Built {
  bars: PracticeNote[][];                       // empty for fretboard-only exercises
  fretboard: { root: number; set: number[] };   // pitch classes relative to root, shown while stopped
}
interface Exercise {
  id: string; category: string; name: string; description: string; tips: string[];
  kind: 'tab' | 'fretboard';
  params: ParamSpec[];                           // tempo + tuning are added by the UI for kind 'tab'
  build(opts: Record<string, string | number>, tuning: number[]): Built;
}
export const EXERCISES: Exercise[];
export function toAlphaTex(built: Built, o: { tempo: number; tuning: number[]; title: string }): string;
export function defaults(ex: Exercise): Record<string, string | number>;
export function sanitize(ex: Exercise, saved: unknown): Record<string, string | number>; // bad/old values → defaults
```

- Reuses `ROOTS`, `SCALES`, `ARPEGGIOS`, `TUNINGS` from `shared/music.ts`.
- One shared **fingering helper** places pitches: from a start position, choose string + fret within a 4–5 fret
  span, shifting only when needed; frets 0–15 (open strings allowed). If a key/position would exceed fret 15, the
  pattern is generated an octave lower.
- Generators produce `PracticeNote`s only; `toAlphaTex` is the single place that writes alphaTex (tuning, `\tempo`,
  bass instrument, durations, dead notes `x`, rests).

### `src/Practice.tsx`

Picker (rendered from `ParamSpec`s), info strip, its own `<ScoreView data={tex} ext="tex">`, `<Fretboard forced>`,
and the practice transport. Owns its alphaTab api. Loop / metronome / count-in / tempo via alphaTab player settings
as in Room. Speed-up: on each loop wrap (`playerPositionChanged` jumping back to the start), raise tempo by the
step until the target. Render errors go through `onLoadError` and show in the practice area with the picker still
usable.

### `src/Fretboard.tsx`

New optional prop `forced?: { follow: number; root: number; set: number[] }`. When set, Follow is locked to that
track and the resting dots use `root`/`set`; the user's saved fretboard prefs (`tabshare.fretboard`) are not written.

### `src/Room.tsx`

Mode state + the toggle. In Practice: render `<Practice>`; keep the tab `ScoreView` mounted but hidden (no reload,
position kept); pause the tab player on entry; hide the tab transport and fretboard. Jam handling is unchanged:
remote transport still updates the hidden tab player, so returning to Tab rejoins a running jam. Practice never
broadcasts.

No server or protocol changes.

## Error handling

- Saved settings that no longer match the exercise's params → `sanitize` falls back to defaults.
- alphaTex render failure → message in the practice area (should be unreachable; unit tests load every output).
- Audio locked after reload → the existing unlock banner covers practice playback.

## Testing

- **Unit** (`shared/exercises.test.ts`, part of `npm test`), for every exercise × key × option value × tuning
  (4- and 5-string):
  - every note's pitch is in the allowed set (scale / chord tones / declared approach notes);
  - frets 0–15, strings exist in the tuning;
  - each bar's durations fill 4/4;
  - `toAlphaTex` output loads in alphaTab in Node with the expected note count.
- **Browser** (Playwright): Tab → Practice → Tab keeps the tab loaded at the same position; picking an exercise and
  changing the key re-renders; play lights fretboard notes; loop + speed-up raises the tempo after a pass (seek, since
  headless playback is slow); a second user's jam play doesn't affect the practice player.
- `npm run typecheck`, `npm test`, `npx vite build` before committing.
