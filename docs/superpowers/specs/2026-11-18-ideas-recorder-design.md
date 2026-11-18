# Ideas recorder: design

Date: 2026-11-18. Status: draft for Corey's approval.

## Why

Corey noodles alone with the rig on, and good riffs come out and vanish. He wants to hit record, keep the take, and come
back to it later to listen again. It's "voice memos for the amp", inside tabShare, using the rig that's already there.

## What it is

A new **Ideas** tab in the side panel (Library · Tracks · Rig · **Ideas** · Chat). At the top: a big record button with
the elapsed time and a level meter. Under it: a search/filter box and the room's saved ideas, newest first.

### Recording (Corey's choices)

- Records **only the instrument through the rig**, as you hear it (amp model, cab IR, VST plugins). No backing track,
  no tab, no drums, no call audio.
- **The rig must be on.** With the rig off the button is disabled and says "Turn on the rig to record", linking to the Rig panel.
- Tap to start, tap to stop. **Every take saves automatically** when it stops (no keep/discard prompt); you delete the
  bad ones.
- Works wherever the rig runs: Chrome (Web Audio rig), the Windows/macOS desktop app (native engine) and the iOS app.

### Finding ideas later (Corey's choices)

- Each idea has a **label**, **tags** and a **date**.
- The date and time are filled in automatically. The label defaults to `Idea · Nov 18, 9:42 pm` and can be renamed any time.
- Tags are free text (`riff`, `slow`, `drop D`), with the room's existing tags suggested while typing.
- The list filters by tag and searches labels.
- Each idea shows who recorded it, its length and the amp model that was loaded.
- Play / pause / scrub, rename, edit tags, **download**, delete.

### Room behaviour (proposed by me, approved by Corey)

- Ideas are saved **in the room** on the server (there are no personal accounts). Anyone in the room can hear them.
- New/edited/deleted ideas appear for everyone in the room live (like the Library's tab list).
- Anyone in the room can rename, tag or delete any idea (same as tabs).
- Listening is **local**: playing an idea doesn't play it for others, and jam sync ignores it.
- Ideas live until deleted; deleting the room deletes them.
- A take is capped at **15 minutes** (recording stops and saves at the cap).
- **Download** is in v1 (Corey asked for it), so an idea can go into Ableton.
- *My call:* **no cap on the number of ideas or room disk use** (Corey: "save as much as they want"). The server has
  plenty of disk; the full list goes in `welcome` / `ideas` without paging (hundreds of entries are a few tens of KB).
- *My call:* **if the rig stops or restarts mid-take** (rig turned off, desktop engine restart or crash, iOS engine
  restart after an interruption), the take stops and saves what was captured, like pressing stop. The rig controls
  aren't locked while recording. The idea's model name is the one loaded when recording started.

## Non-goals (v1)

Recording over a backing track or the tab; attaching an idea to a tab; trimming/editing audio; recording the dry signal
for re-amping; multitrack/overdubs; sharing playback over jam sync; per-person privacy.

## Anti-goals

- A take lost after the user pressed stop and the upload was confirmed. Saving must be dependable.
- Recording that disturbs the rig or call (extra latency, glitches, the call losing the instrument).
- Anything slower than one tap to start capturing an idea.

## Dependability (Corey's choice: "safe")

A take must survive a failed upload, a reload, the app quitting and a crash mid-take, losing at most the last few
seconds.

- While recording, `MediaRecorder` runs with a timeslice of a few seconds (`start(2000)` or so), and each chunk is
  written straight to IndexedDB under a pending-take record (`{roomId, takeId, label, by, model, startedAt, mime,
  chunks}`), separate per room.
- On stop, the chunks are joined and uploaded with the single raw-body `POST`; the pending record is deleted only after
  the server confirms. Failed uploads retry with backoff while the page is open.
- When a room opens (or the page reloads) and pending takes exist for that room, they upload automatically. A crashed
  take's duration is computed from its chunks or the decoded audio, not from the stopped time.
- The Ideas list shows pending takes at the top as "Saving…" / "Waiting to upload" with a retry button, so it's clear
  nothing was lost. The upload uses the take's id, so a retry after a lost response doesn't create a duplicate
  (server: same id = same idea).
- If IndexedDB is unavailable (private window), recording still works with in-memory retry, and the panel says takes
  aren't protected against a reload.
- Webm from timesliced/crashed recordings has no duration header; the builder fixes that (e.g. a duration fix-up or
  server-side duration from the client's measured value) so `<audio>` can scrub.

## How (decided)

- **Signal:** the rig already exposes the processed instrument as a `MediaStream` (`instrumentStream` in
  `src/rig/useRig.ts`), on both the Web Audio path and the native engine path (pcm-feed). Record that stream with
  `MediaRecorder`, independent of "Send to call".
- **Format:** whatever `MediaRecorder` gives on the platform (Chrome/Electron `audio/webm;codecs=opus`, WebKit/iOS
  `audio/mp4`), ~128 kbps. The server stores it as is.
- **Download = WAV**, made in the browser (fetch → `decodeAudioData` → 16-bit PCM WAV at the decoded rate), named after
  the label, e.g. `Slow minor groove.wav`. Ableton can't open webm/opus, which is why download isn't the raw file.
- **Storage:** `StoredRoom.ideas?: Idea[]` (metadata in rooms.json); audio at `files/<room>/ideas/<id>.<ext>`.
  `Idea = { id, label, tags: string[], createdAt, by (name), durationMs, model?: string, mime, size }`.
- **API**, following the tabs/stems routes (room token in `X-Room-Token` or `?token=`):
  `POST /api/rooms/:id/ideas` (raw body, metadata in query; size limit ~ 20 MB), `GET /api/rooms/:id/ideas/:ideaId`
  (audio, supports Range so `<audio>` can scrub), `PATCH` label/tags, `DELETE`. Each change broadcasts an `ideas`
  WS message with the full list; `welcome` includes `ideas`. Add types to `shared/protocol.ts` first.
- Server validation: label ≤ 100 chars, ≤ 10 tags of ≤ 30 chars each, mime is `audio/webm` or `audio/mp4`
  (or `audio/ogg` if a browser gives it), duration ≤ 15 min (+ slack).
- Deleting the room removes `files/<room>/` as today, including ideas.
- Update the user guide (`public/guide/`) with an Ideas section, and CLAUDE.md's layout notes.

## Left to the builder

- Exact component split (`src/Ideas.tsx` + a small `useRecorder` hook is the obvious shape).
- How the meter is fed (an AnalyserNode on the rig's shared AudioContext is the obvious choice).
- Upload retry/backoff details, provided the dependability anti-goal holds.
- Visual details within the existing side-panel style; the phone drawer layout must still work.

## Testing

- Unit tests (`npm test`): idea routes: upload, list in welcome, patch validation, delete removes the file, 401
  without token, oversize/unsupported mime rejected.
- Playwright (2 users, prod build, rig input stubbed with an oscillator): rig off → button disabled; rig on → record
  ~3 s → idea appears for both users with the model name; play it (duration > 0, audio element advances); rename +
  tags sync to the other user; tag filter + search; download returns a valid WAV (RIFF header, sensible length);
  delete removes it for both; phone width 390 px has no sideways scroll.
- Desktop app smoke: native engine rig on → a recording uploads and plays back.
- Not verifiable here: iOS app recording (WebKit `audio/mp4`): check by hand on the iPad.
