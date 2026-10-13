# Drums mode — design

Date: 2026-10-13. Status: approved in brainstorming (Corey: "it's all approved").

## Goal

A drum machine to play along to: pick a style and tempo, get a song arrangement (Intro, Verse, Chorus, …) whose
sections are generated drum grooves, edit the arrangement, reroll any section, play it with the existing synth.
Solo by default, with a switch to share it with the room. Songs can be saved to the room.

## Decisions

| Question | Decision |
|---|---|
| Who hears it | Solo by default; "Share with the room" toggle (C). |
| Structure | Style + editable arrangement of sections, 🎲 per section, auto fills (A). |
| Saving | Saved to the room, listed and reopenable (A). |
| Generator | Rules-based groove generator, seeded per section (approach 1). No new dependencies. |
| Where | Its own mode: Tab \| Practice \| Drums \| Browser. Entering it pauses + mutes the tab like Practice. |

Non-goals (v1): editing individual hits (step sequencer), bass/chords accompaniment, odd meters beyond 4/4 and 12/8,
humanized timing, audio export.

## UI

- Top bar: **Style** (Rock, Pop, Funk, Blues shuffle, Punk, Metal, Reggae, Hip-hop, Train beat, Jazz swing), **Tempo**
  (40–240), **🎲 New song**, **Share with the room** toggle, **Save** (inline name field) and **Open** (the room's saved
  drum songs, with delete).
- Arrangement strip: section blocks `type bars` with 🎲 (reroll), ⟲ (loop this section), ←/→ (move), ✕ (delete), and
  "+ Section". Types: Intro, Verse, Pre-chorus, Chorus, Bridge, Solo, Breakdown, Outro; 1–16 bars. The playing block is
  highlighted.
- Score: the drum part in standard drum notation (alphaTab), ← → ↑ ↓ keys, Light/Dark theme and sound bank as elsewhere.
- Transport: play/pause, stop, loop (whole song, or the looped section), count-in, metronome, Tuner.

## Data

```ts
type DrumSectionType = 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge' | 'solo' | 'breakdown' | 'outro';
interface DrumSection { type: DrumSectionType; bars: number; seed: number }   // bars 1–16, seed uint32
interface DrumSong { style: string; tempo: number; sections: DrumSection[] }   // ≤ 32 sections
interface DrumShare { song: DrumSong; playing: boolean; timeMs: number; at: number; loop: number | null; by: string }
interface SavedDrumSong { id: string; name: string; song: DrumSong; by: string; at: number }
```

A song is fully determined by `DrumSong` (seeds, not notes), so sharing and saving send a few hundred bytes and every
client generates the identical part.

## Generator (`shared/drums.ts`, pure, unit tested)

- **Grid:** 16 steps per bar (16ths) in 4/4; 12 steps (8ths) in 12/8 (Blues shuffle, Jazz swing).
- **Kit (GM drum numbers):** kick 36, snare 38, side stick 37, closed hat 42, pedal hat 44, open hat 46, crash 49,
  ride 51, ride bell 53, toms 50/47/45/43, cowbell 56.
- **Style table:** per style a time signature and, per section *feel* (sparse = intro/breakdown/outro, main =
  verse/prechorus/solo, big = chorus/bridge), a list of base patterns written as step strings per instrument
  (`kick: 'x.......x.x.....'`), plus a list of fills and the style's allowed mutations.
- **Section build (seeded PRNG, mulberry32):** pick a base pattern for the section's feel → apply 0–2 seeded mutations
  (extra kick on an off-step, ghost snares for funk, open hat on the "and" of 4, hat ↔ ride on big sections) → bars
  follow an A A A B shape (B = a small variation) → the last bar of every section gets a fill over its last 1–2 beats
  (except a 1-bar section) → crash on beat 1 of each section after the first.
- **Output:** `buildDrums(song) → { bars: DrumStep[][], sectionStartBars: number[], ts }`; `drumsToAlphaTex()` merges
  empty steps into longer notes/rests where aligned (16th/8th/quarter) and writes `\instrument percussion` with GM
  numbers, ghost `{g}`, accent `{ac}`, `\ts 12 8` for 12/8.
- **Validation:** `drumSong(u: unknown): DrumSong | null` (style in list, tempo 40–240, 1–32 sections, known types,
  bars 1–16 int, seed uint32) — used by the server for every shared/saved song.

## Sharing + saving (server)

- `room.drums: DrumShare | null` — live-only (like `browse`), sent in the welcome. Client → `{type:'drums', state}`
  (validated: song via `drumSong`, `loop` an index or null, numbers finite); server stamps `at`/`by`, broadcasts.
- Saved songs persist in `StoredRoom.drumSongs` (≤ 50 per room, name ≤ 60 chars). `{type:'saveDrums', name, song}`,
  `{type:'deleteDrums', id}` → broadcast `{type:'drumSongs', songs}`; the welcome includes the list.
- Client with Share on: every edit, reroll, play, stop and loop change sends the full `DrumShare`; incoming states are
  applied (regenerate if the song changed, then seek to `timeMs + (serverNow − at)` and play/pause). Only user actions
  send — never applying a remote state (no echo loops, same rule as jam sync). Share off: nothing sent or applied.

## Testing

- Unit: every style × section type × 20 seeds: each bar fills its time signature, only kit notes, deterministic (same
  seed → same output), different seeds differ for most sections, fills only in last bars, alphaTex parses in Node with
  the expected note count; `drumSong` rejects bad input.
- Browser (2 users): generate + play (score renders, position advances), reroll changes only that section, section
  loop, save → appears for the other user → open, Share on → other user's song + play state follow, Share off → not.
