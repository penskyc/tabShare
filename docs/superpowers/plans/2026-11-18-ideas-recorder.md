# Ideas Recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An **Ideas** side-panel tab that records the rig's processed instrument with one tap, saves every take to the
room (crash-safe), and lets anyone in the room find (label/tags/date), play, rename, tag, download (WAV) and delete them.

**Architecture:** `MediaRecorder` on the rig's existing `instrumentStream` (both the Web Audio and native-engine paths)
with a 2 s timeslice; each chunk goes to IndexedDB first, the joined take uploads with one raw-body `POST` keyed by a
client-made id (idempotent), and pending takes resume on the next room visit. Server keeps `StoredRoom.ideas` metadata
+ files in `files/<room>/ideas/`, broadcasts the full list as an `ideas` WS message. WAV download is encoded in the
browser.

**Tech Stack:** React 19 + TS, Express 5 + ws, node:test via tsx, Playwright (Edge on this Mac, `channel: 'msedge'`).

**Spec:** `docs/superpowers/specs/2026-11-18-ideas-recorder-design.md`

## Global Constraints

- Rig must be on to record; off → button disabled, text "Turn on the rig to record", link to the Rig panel.
- Every take saves automatically on stop; no keep/discard prompt.
- Take cap **15 minutes** (`MAX_IDEA_MS = 15 * 60 * 1000`); recording stops and saves at the cap.
- Default label `Idea · Nov 18, 9:42 pm` (`Idea · ` + `toLocaleString('en-US', {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'})` with the comma after the day, lowercase am/pm).
- Label ≤ 100 chars; ≤ 10 tags, each ≤ 30 chars (trimmed, empty dropped, case-insensitive de-duplicated).
- Accepted mimes: `audio/webm`, `audio/mp4`, `audio/ogg` (codec parameters ignored). Upload limit `MAX_IDEA_BYTES = 20 * 1024 * 1024`.
- No cap on idea count or room disk use; full list in `welcome` and every `ideas` broadcast.
- Rig stops/restarts mid-take (rig off, engine restart/crash, iOS engine restart = the recorded stream's tracks end) → take stops and saves like pressing stop. Rig controls are not locked. `model` = the model name loaded when recording started.
- Anyone in the room can rename/tag/delete any idea. Playback is local only (no jam sync, no WS message).
- Download = 16-bit PCM WAV named `<label>.wav` (filesystem-unsafe characters replaced by `_`).
- Pending takes stay in IndexedDB until the server confirms the upload; private window (no IndexedDB) → in-memory retry + the panel says "Takes aren't protected against a reload in this window."
- Update `public/guide/` (Ideas section) and CLAUDE.md's Layout notes.

## Review Focus

1. **Page closed mid-take** → reopening the room uploads everything up to the last 2 s chunk and the idea plays. (Task 5 e2e: close page without stopping.)
2. **Upload response lost / retried** → still exactly one idea (same id). (Task 2 unit test: second `addIdea` with the same id returns `created: false`, no duplicate.)
3. **Webm from MediaRecorder has no duration** → the scrubber uses `idea.durationMs` and seeking to the middle plays from there. (Task 5 e2e: seek to 50 %, `currentTime` ≈ half.)
4. **Rig turned off while recording** → take saved, button back to disabled. (Task 5 e2e.)
5. **Two users in the room, one deletes the idea the other is playing** → the other's player stops cleanly, no page error. (Task 5 e2e.)

---

### Task 1: Shared types, validation, filtering, WAV encoder

**Files:**
- Modify: `shared/protocol.ts` (types + constants; `RoomSnapshot.ideas`; `ServerMessage` `ideas`)
- Create: `shared/ideas.ts`, `shared/wav.ts`
- Test: `shared/ideas.test.ts`, `shared/wav.test.ts`

**Interfaces:**
- Produces (protocol.ts):
  - `interface Idea { id: string; label: string; tags: string[]; createdAt: number; by: string; durationMs: number; model: string | null; mime: string; size: number }`
  - `RoomSnapshot.ideas: Idea[]`; `ServerMessage` `| { type: 'ideas'; ideas: Idea[] }`
  - `IDEA_MIMES = ['audio/webm', 'audio/mp4', 'audio/ogg'] as const`, `MAX_IDEA_MS`, `MAX_IDEA_BYTES`
- Produces (ideas.ts):
  - `ideaId(s: unknown): string | null` (accepts `/^[A-Za-z0-9_-]{8,32}$/`)
  - `baseMime(m: unknown): (typeof IDEA_MIMES)[number] | null` (strips `;codecs=…`, lower-case)
  - `ideaExt(mime: Idea['mime']): 'webm' | 'm4a' | 'ogg'`
  - `cleanLabel(s: unknown): string | null` (trim, ≤ 100, empty → null)
  - `cleanTags(t: unknown): string[] | null` (array of strings → rules above; non-array → null)
  - `defaultIdeaLabel(d: Date): string`
  - `filterIdeas(ideas: Idea[], query: string, tag: string | null): Idea[]` (newest first; query matches label or tags, case-insensitive; `tag` exact case-insensitive)
  - `allTags(ideas: Idea[]): string[]` (unique, sorted by use count desc then alpha)
  - `safeFileName(label: string): string`
- Produces (wav.ts): `encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array` (16-bit PCM, interleaved, clamped)

- [ ] **Step 1: Write failing tests**
  - `ideas.test.ts`: `ideaId('abcDEF12_-')` ok, `ideaId('../x')` null; `baseMime('audio/webm;codecs=opus') === 'audio/webm'`, `baseMime('video/webm') === null`; `cleanTags([' Riff','riff','', 'x'.repeat(31), ...11 tags])` → trims, dedups case-insensitively, rejects (null) a 31-char tag, and >10 tags → null; `cleanLabel('  ')` null, 101 chars null; `defaultIdeaLabel(new Date(2026,10,18,21,42))` === `'Idea · Nov 18, 9:42 pm'`; `filterIdeas` sorts newest first, `'drop'` matches tag `drop D`, tag filter `'RIFF'` matches `riff`; `allTags` ordering; `safeFileName('a/b:c?')` === `'a_b_c_'`.
  - `wav.test.ts`: `encodeWav([new Float32Array([0, 1, -1, 2])], 48000)` → bytes 0–3 `RIFF`, 8–11 `WAVE`, sample rate at offset 24 = 48000, channels at 22 = 1, data size at 40 = 8, samples `0, 32767, -32768, 32767` (clamped); two channels interleave.
- [ ] **Step 2:** `npm test` → new tests FAIL (modules missing).
- [ ] **Step 3:** Implement the types and functions above.
- [ ] **Step 4:** `npm test` and `npm run typecheck` → PASS. (Typecheck will flag places that build a `RoomSnapshot`; add `ideas: room.ideas ?? []` in the server welcome and `ideas` state stub in `useRoom.ts` only as far as needed to compile, or leave for Task 2/3 if typecheck already passes.)
- [ ] **Step 5:** Commit `Ideas: shared types, validation, WAV encoder`.

### Task 2: Server storage, routes, broadcast

**Files:**
- Modify: `server/store.ts` (`StoredRoom.ideas?: Idea[]`)
- Create: `server/ideas.ts`
- Modify: `server/index.ts` (routes, welcome `ideas`, broadcast)
- Test: `server/ideas.test.ts`

**Interfaces:**
- Consumes: Task 1 validators.
- Produces (server/ideas.ts):
  - `ideaFile(roomId: string, idea: Pick<Idea, 'id' | 'mime'>): string` → `FILES_DIR/<room>/ideas/<id>.<ext>`
  - `addIdea(room: StoredRoom, q: Record<string, unknown>, body: Buffer, mime: unknown): { idea: Idea; created: boolean } | string` — `q` holds `id, label, tags (JSON string array), by, model, durationMs, createdAt`; string = 400 error message. Same id already present → `{ idea: existing, created: false }`, file untouched. `durationMs` must be 1…`MAX_IDEA_MS + 30_000` (rounded); `createdAt` = the given value if finite and ≤ now + 1 min (pending takes may upload days later), else now. Missing label → `defaultIdeaLabel(new Date(createdAt))`. `by` ≤ 40, `model` ≤ 100 or null. Writes the file, pushes the idea, `saveSoon()`.
  - `patchIdea(room: StoredRoom, id: string, patch: { label?: unknown; tags?: unknown }): Idea | string | null` (null = not found)
  - `removeIdea(room: StoredRoom, id: string): boolean` (deletes the file too)
- Routes in index.ts (all `authed`):
  - `POST /api/rooms/:id/ideas` — `express.raw({ type: () => true, limit: MAX_IDEA_BYTES })`, mime from `Content-Type`, metadata in query. 200 `Idea` (created or existing), 400 with `{error}`. Broadcast `{type:'ideas', ideas: room.ideas}` when created.
  - `GET /api/rooms/:id/ideas/:ideaId` — `res.sendFile` with `Content-Type: idea.mime` (Express handles Range).
  - `PATCH /api/rooms/:id/ideas/:ideaId` — JSON `{label?, tags?}`; 200 Idea / 400 / 404; broadcast.
  - `DELETE /api/rooms/:id/ideas/:ideaId` — 200 / 404; broadcast.
  - `welcome.room.ideas = room.ideas ?? []`.

- [ ] **Step 1: Write failing tests** (`server/ideas.test.ts`, temp `DATA_DIR` set before importing, like `stems.test.ts`): add → file exists with body bytes, idea fields set, default label when none; same id again → `created: false`, one idea, original file bytes; bad mime / bad id / empty body / durationMs 0 or > cap / 11 tags → string error, nothing written; patch label + tags → updated, invalid tags → string, unknown id → null; remove → file gone, list empty, unknown id → false.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement `server/ideas.ts`, the `StoredRoom` field, routes, welcome field.
- [ ] **Step 4:** `npm test`, `npm run typecheck` → PASS. Manual curl against `npm run dev`: upload a small webm with a room token → 200; GET with `Range: bytes=0-9` → 206; without token → 401.
- [ ] **Step 5:** Commit `Ideas: server storage and routes`.

### Task 3: Client data layer: API, room state, pending store, recorder hook

**Files:**
- Modify: `src/api.ts`, `src/useRoom.ts`
- Create: `src/ideas/pending.ts`, `src/ideas/useRecorder.ts`
- Modify: `src/rig/useRig.ts` (expose `recordStream: on ? instrumentStream : null`, independent of Send to call)

**Interfaces:**
- Produces (api.ts): `uploadIdea(s: Session, take: PendingTake, blob: Blob): Promise<Idea>`, `ideaUrl(s: Session, id: string): string` (`?token=`), `updateIdea(s: Session, id: string, patch: { label?: string; tags?: string[] }): Promise<Idea>`, `deleteIdea(s: Session, id: string): Promise<void>`.
- Produces (useRoom): `ideas: Idea[]` from `welcome` and `ideas` messages.
- Produces (pending.ts), IndexedDB db `tabshare-ideas`, stores `takes` (key `id`) and `chunks` (key `[takeId, seq]`):
  - `interface PendingTake { id: string; roomId: string; label: string | null; tags: string[]; by: string; model: string | null; mime: string; createdAt: number; durationMs: number; done: boolean }`
  - `pendingAvailable(): Promise<boolean>`; `putTake(t: PendingTake)`; `addChunk(takeId: string, seq: number, data: Blob)`; `listTakes(roomId: string): Promise<PendingTake[]>`; `takeBlob(t: PendingTake): Promise<Blob>` (chunks in seq order, `type: t.mime`); `dropTake(id: string)`.
  - Every call is wrapped so a failing IndexedDB never throws into recording (falls back to in-memory chunks).
- Produces (useRecorder.ts): `useRecorder(opts: { session: Session; stream: MediaStream | null; by: string; model: string | null }): { canRecord: boolean; recording: boolean; elapsedMs: number; start(): void; stop(): void; pending: { take: PendingTake; state: 'saving' | 'waiting' | 'failed' }[]; retry(id: string): void; protectedStorage: boolean }`
  - `start`: id = 16 random base64url chars; `MediaRecorder(stream, { mimeType: first supported of 'audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg', audioBitsPerSecond: 128000 })`, `start(2000)`; `putTake` immediately (done: false); each `dataavailable` → `addChunk` + update `durationMs` = now − start.
  - Stops on: `stop()`, elapsed ≥ `MAX_IDEA_MS`, any track of the stream firing `ended`, or `stream` prop changing/becoming null (rig off or restarted).
  - On stop: `putTake({...done: true, durationMs})` → `uploadIdea` → on 200 `dropTake`; failure → `waiting`, retry after 2/5/15/30/60 s (then every 60 s) while mounted; 4xx other than 408/429 → `failed` (kept, Retry button).
  - On mount (and when `session.roomId` changes): `listTakes(roomId)`; each take (done or not: a not-done take is a crash leftover; its `durationMs` is the last chunk's) uploads the same way. Don't upload a take that is currently being recorded in this tab.
- [ ] **Step 1:** Implement; `npm run typecheck` passes. (Behaviour is tested end to end in Task 5; IndexedDB isn't available under `node --test`.)
- [ ] **Step 2:** Commit `Ideas: recorder hook, pending store, API`.

### Task 4: Ideas panel UI + download

**Files:**
- Create: `src/Ideas.tsx`
- Modify: `src/Room.tsx` (panel union `'ideas'`, tab label `Ideas` between Rig and Chat in both the tab row and the collapsed rail (icon 💡), render `<Ideas …/>`), `src/styles.css` (`.ideas-*` classes)

**Interfaces:**
- Consumes: Tasks 1–3. Props: `{ session: Session; ideas: Idea[]; rig: ReturnType<typeof useRig>; me: string; openRig(): void }`.
- Layout (mockup A, approved): top card = round record button (red; stop square while recording), "Record · m:ss" / elapsed, level meter from `rig.level`; below it a search box (`Search or filter by tag…`) and tag chips from `allTags`; then pending takes ("Saving…" / "Waiting to upload" / "Couldn't upload · Retry"), then `filterIdeas(...)` rows.
- Row: label (click → inline rename, Enter/blur saves via `updateIdea`, Esc cancels), meta line `by · date · m:ss · model`, tag chips (× removes) + "+ tag" input with `<datalist>` from `allTags`, a player (play/pause, scrub bar driven by `idea.durationMs`, `<audio src={ideaUrl}>` per row created lazily on first play; only one plays at a time), Download, Delete (confirm in the row: "Delete? Yes / No", no `window.confirm`).
- Download: fetch `ideaUrl` → `getAudioContext().decodeAudioData` (`src/rig/audioContext.ts`) → `encodeWav([...channels], buffer.sampleRate)` → `<a download={safeFileName(label) + '.wav'}>` blob URL.
- Rig off: button disabled + "Turn on the rig to record" button calling `openRig()`. `!protectedStorage`: muted note under the button (Global Constraints text).
- If the playing idea disappears from `ideas` (deleted by someone), pause and drop its audio element.
- [ ] **Step 1:** Implement; `npm run typecheck` and `npx vite build` pass.
- [ ] **Step 2:** `npm run dev`, open a room in a browser with a real or virtual input, rig on, record 5 s, check the row, play, rename, tag, download opens in a player as WAV.
- [ ] **Step 3:** Commit `Ideas: side panel tab with recorder, list, playback, download`.

### Task 5: End-to-end checks, desktop smoke, docs

**Files:**
- Create: `.playwright-mcp/ideas.mjs` (gitignored; `npm i --no-save playwright-core` if missing; Edge on this Mac)
- Modify: `desktop/smoke.mjs` (after the tuner step: open Ideas, record 2 s, stop, expect one idea row whose play advances)
- Modify: `public/guide/index.html` (Ideas section + contents entry), `CLAUDE.md` (Layout bullet for `src/Ideas.tsx`, `src/ideas/`, `server/ideas.ts`, `shared/ideas.ts`, `shared/wav.ts`)

`ideas.mjs` runs against a production build (`npx vite build`, server with a temp `DATA_DIR`, `ADMIN_PASSWORD=devadmin`), two contexts (Corey, Mike), `getUserMedia` stubbed with an oscillator (see CLAUDE.md "How we test"). Assertions:
- [ ] Rig off → record button disabled, "Turn on the rig to record" shown.
- [ ] Rig on → record 3 s → stop → one idea for both users within 3 s; label matches `/^Idea · /`, meta shows `0:03`±1 and the model name if one is loaded.
- [ ] Play: `audio.currentTime` advances; seek to 50 % → `currentTime` ≈ `durationMs/2000` ± 0.5 s (Review Focus 3).
- [ ] Rename + add tag `riff` on Corey → Mike sees both; Mike filters by `riff` → 1 row, search `zzz` → 0 rows.
- [ ] Download → WAV bytes start with `RIFF`, length > 44.
- [ ] Rig off during a take → idea saved, button disabled (Review Focus 4).
- [ ] Crash: start recording, wait 5 s, `page.close()` without stopping, reopen the room in the same context → an idea of ≥ 3 s appears and plays (Review Focus 1).
- [ ] Upload failure: route `POST **/ideas*` to abort once → row shows "Waiting to upload", then the idea appears once; total ideas +1 (Review Focus 2).
- [ ] Mike plays an idea, Corey deletes it → Mike's row disappears, no page errors (Review Focus 5).
- [ ] Phone 390×844: Ideas panel in the drawer, no sideways scroll.
- [ ] No page errors in either context throughout.

Then:
- [ ] `npm run typecheck`, `npm test`, `npx vite build` → all pass.
- [ ] Desktop smoke on this Mac: `cd desktop && node smoke.mjs` against `npm run dev` → passes including the Ideas step (native engine `instrumentStream`).
- [ ] Guide: `.playwright-mcp/guide-check.mjs` isn't on this Mac; check the new section by hand on the production build (anchor works, no sideways scroll at 390).
- [ ] Commit `Ideas: e2e check, desktop smoke step, guide + notes`.
- [ ] iOS (WebKit `audio/mp4`) is not verifiable here: list it as "not verified" in the progress log.
