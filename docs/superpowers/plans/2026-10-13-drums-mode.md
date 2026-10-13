# Drums Mode Implementation Plan

> Executed inline (Corey approved running straight through). Spec: `docs/superpowers/specs/2026-10-13-drums-mode-design.md`.

**Goal:** a Drums mode with a seeded, style-based groove generator, an editable section arrangement, solo or shared
playback, and drum songs saved to the room.

**Architecture:** pure generator in `shared/drums.ts` → alphaTex percussion → its own `ScoreView` (like Practice).
Sharing = live `room.drums` state relayed by the server (like `browse`); saved songs persisted in `StoredRoom`.

alphaTex facts (verified in Node, alphaTab 1.8): `\instrument percussion` + notes as GM drum numbers (`(36 42)`),
ghost `{g}`, accent `{ac}`, plays on channel 9. Articulation names are rejected.

## Tasks

1. **Generator core + tests** — `shared/drums.ts`, `shared/drums.test.ts`
   - Types, `STYLES`, `SECTION_TYPES`, seeded PRNG, `drumSong()` validation, `buildDrums()`, `drumsToAlphaTex()`,
     `defaultSong(style, seed)`.
   - Tests: every style × type × 20 seeds → bars fill the time signature, kit-only notes, deterministic, seeds vary,
     crash on section starts, fill in last bars, alphaTex parses with the right note count; `drumSong` rejects bad
     input. Commit.
2. **Protocol + server** — `shared/protocol.ts`, `server/store.ts`, `server/index.ts`, `src/useRoom.ts`
   - `DrumShare`, `SavedDrumSong`; `RoomSnapshot.drums` + `drumSongs`; messages `drums`, `saveDrums`, `deleteDrums`
     → `drums`, `drumSongs`. Live `lr.drums`; `room.drumSongs` persisted (≤ 50). Hook exposes state + senders.
     Typecheck + tests. Commit.
3. **Drums view** — `src/Drums.tsx`, `src/styles.css`
   - Style/tempo/new song/share/save/open; arrangement strip (reroll, loop, move, delete, add, type, bars); ScoreView;
     transport; section highlight from the play position; section loop via `api.playbackRange`; arrow keys; local
     song remembered in `tabshare.drums.song`; share apply/send. Commit.
4. **Room wiring** — `src/Room.tsx`
   - Mode `'drums'` (button after Practice); pauses + mutes the tab like Practice; tab footer hidden. Commit.
5. **Browser test** — `.playwright-mcp/drums.mjs` (2 users): renders + plays, reroll changes one section, loop,
   save → visible to Mike → open, share on follows song + play, share off doesn't.
6. **Docs + ship** — CLAUDE.md (layout + design notes), landing grid cell, typecheck/test/build, push, deploy, notes.
