# Stems: mute/solo the original recording (design)

Corey, 2026-10-16: "implement stem separation when using the original tracks so we can keep solo/mute
functionality", using StemDeck (github.com/stemdeckapp/stemdeck, Apache-2.0).

## Decisions (asked and answered)

- Audio for the stems: **the tab's linked YouTube video by default, an uploaded audio file as the alternative**.
- Mixer: **one row per stem** (vocals, drums, bass, guitar, piano, other) with mute / solo / volume, shared through
  jam sync like the track mix. No mapping of tab tracks onto stems.
- Separation: **StemDeck as a sidecar container** (`ghcr.io/stemdeckapp/stemdeck:0.20.0`, CPU, Demucs
  `htdemucs_6s`), reached by the tabShare server only. `STEMDECK_URL` unset = the feature is hidden.

## How it works

- **Server** (`server/stems.ts`): `POST /api/rooms/:id/tabs/:tab/stems?from=youtube` (the linked video) or with a raw
  audio body `?name=song.mp3` (mp3/wav/flac/ogg/opus/m4a, ≤ 100 MB) submits a StemDeck job (`POST /api/jobs`, JSON
  `{url}` or multipart `file`). StemDeck queues jobs itself, so tabShare keeps no queue: a 3 s poller follows every
  tab whose `stems.status` is `queued`/`running` (`GET /api/jobs/{id}`; restart-safe, since the job id is saved). On
  `done` it downloads each stem as MP3 (`/api/jobs/{id}/stems/{name}.mp3`, ~190 kbps, ~35 MB a song) into
  `files/<room>/<tab>.stems/`, then deletes the StemDeck job. Stems StemDeck measures as silent
  (`stem_presence` < 1) are left out. Every status change rewrites `TabMeta.stems` and broadcasts `tabs`.
  `GET …/stems/:name.mp3` streams a stem (room token, Range). `DELETE …/stems` cancels/removes. Deleting a tab or
  room removes its stems. One job per tab at a time.
- **Data**: `TabMeta.stems = {status, from, videoId?, stage?, progress?, error?, jobId?, names, syncPoints?}`.
  YouTube stems share the video's timeline, so they use `tab.youtube.syncPoints`; uploaded stems keep their own
  `syncPoints` (set with the same tap-sync tool, `stemSync` WS message).
- **Mix**: `MixState.source` gains `'stems'`; `MixState.stemMuted / stemSoloed / stemVolumes` index into
  `STEM_NAMES`. Server validates and defaults them (older clients send none).
- **Client**: a third source button (Synth | Original | Stems). `src/stemPlayer.ts` = one `<audio>` per stem
  (pitch-preserving `playbackRate`) → GainNode per stem → master gain in its own AudioContext (gains, not element
  volume: iOS ignores media element volume). It implements the `YTPlayer` interface, so Room's external-media handler,
  clock feed and tap sync drive it unchanged. Element 0 is the clock; the others are pulled back when they drift
  > 40 ms. The Original box shows the stem player's tools in Stems mode; before stems exist it offers
  "Separate from the YouTube video" / "Upload audio" and shows StemDeck's stage + progress to the whole room. The
  Tracks panel shows the stem mixer in Stems mode (tab tracks greyed, as in Original mode).

## Not doing

- Lead/backing vocal split, key change, StemDeck's own lyrics/sections/beat grid.
- GPU (TrueNAS has none; ~3–6 min per song on the Ryzen 9 7940HS is fine for a one-time job).
- Proxying StemDeck's UI. It stays on the internal network.

## Risk

YouTube downloads through yt-dlp go against YouTube's terms and break when YouTube blocks the server's IP; the upload
path is the fallback. StemDeck's API is internal to its web app, so the image is pinned to a version.

## Testing

- `server/stems.test.ts`: fake StemDeck HTTP server; youtube + upload jobs go queued → running → ready, files saved,
  job deleted, silent stems left out, StemDeck error → `error`, restart resumes polling.
- `.playwright-mcp/stems.mjs`: fake StemDeck, 2 users: separate → both see progress → ready; Stems mode plays through
  the stem player; muting a stem syncs to the other user and sets that stem's gain to 0.
- Live: real StemDeck on TrueNAS with a real YouTube video.
