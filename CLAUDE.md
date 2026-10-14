# tabShare — project notes for Claude

Self-hosted, multiplayer guitar-tab web app: the Songsterr / Ultimate Guitar / Guitar Pro 8 feature set, shared like
Figma / Google Docs, plus a Windows/macOS desktop app. Public repo github.com/penskyc/tabShare (AGPL-3.0). Personal
deployment notes, if any, live in the gitignored `CLAUDE.local.md`; read it too when it exists.

**What it does today:** admin-gated password rooms with invite links; Guitar Pro / MusicXML / alphaTex tabs (upload,
drag-drop, in-app alphaTex editor, **Songsterr search + one-click import**) rendered by alphaTab; live cursors, selections and playheads; synth playback with
speed, metronome, count-in, per-track view/mute/solo/volume; shared loops; **jam sync** (on by default) that syncs
play/pause/seek/speed plus the whole mix (tracks, mute, solo, volume, metronome, count-in, Synth/Original);
**Original audio**: a YouTube recording per tab with tap-to-sync bar points; chat with clickable links + Open Graph
previews; mesh WebRTC **video/voice call** (device pickers, mute, camera, screen share, "original sound"); **room audio**
(desktop apps hear each other's instruments peer to peer via SonoBus's networking); **instrument
rig**: audio-interface input → NAM amp model (WASM) → cab IR → monitor + mixed into the call, with local `.nam` files or
**TONE3000** browsing and a capture dropdown; resizable/collapsible side panel; `#/admin` room management; a **desktop app** (`desktop/`, Electron, Windows +
macOS) that loads the live site and runs the rig through a native **ASIO** (Windows) / **Core Audio** (macOS) engine.

## Layout

- `server/index.ts`: Express 5 REST (`/api/rooms`, join, tab upload/download/delete, `/api/health`) and the `ws` WebSocket at `/ws` (presence relay, tab switch, loop, transport, chat). Serves `dist/` in production.
- `server/store.ts`: JSON persistence in `DATA_DIR` (`rooms.json`, `files/<room>/<tab>.<ext>`, `secret`). scrypt password hashes; room tokens are HMAC(secret, roomId:hash), so changing a password invalidates them.
- `shared/protocol.ts`: every wire type, plus `URL_RE` (chat link detection, shared by client and server). Change it first when adding a message.
- `shared/sync.ts`: YouTube id parsing, bar play order with repeat occurrences, merging and shifting sync points (tests in `shared/sync.test.ts`).
- `src/OriginalAudio.tsx`: "Original" audio source. YouTube IFrame player box plus tap-sync tools.
- `src/rig/`: instrument rig. `useRig.ts` (audio graph), `nam-processor.ts` (AudioWorklet + @opendaw/nam-wasm), `audioContext.ts` (one shared 48 kHz interactive AudioContext for the rig and the call mixer), `tone3000.ts` (OAuth PKCE popup Select flow + model download), `RigPanel.tsx`. `public/t3k-callback.html` relays the OAuth redirect to the opener.
- `server/songsterr/`: Songsterr search + import. `index.ts` (search `/api/songs?pattern=`, meta `/api/meta/<id>` → revisionId + image, part JSONs from the CloudFront CDN), plus the JSON → GP7 converter vendored from Metaphysics0/songsterr-downloader (MIT, `LICENSE` kept; changed: import paths, and unnamed tracks take the instrument name). Room-scoped routes `GET /api/rooms/:id/songsterr?q=` and `POST /api/rooms/:id/songsterr/:songId` (→ `addTab`). UI: `src/SongsterrSearch.tsx` in the Library panel. Live test: `SONGSTERR_LIVE=1 npm test`.
- `server/unfurl.ts`: chat link previews (Open Graph / twitter / `<title>`), with an SSRF guard. Tests in `server/unfurl.test.ts` (`npm test`).
- `src/useRoom.ts`: WS client hook (reconnect, presence throttle at 50 ms, clock-offset ping).
- `src/ScoreView.tsx`: alphaTab instance and the SVG overlay for remote cursors, selections and playheads.
- `src/Room.tsx`: room UI, transport, jam sync, shared loop, tracks, library, chat.
- `src/useCall.ts` + `src/CallPanel.tsx`: mesh WebRTC video/voice call (signaling over the room WS: `rtc` messages relayed by the server, `presence.call` = {mic,cam,screen} or null).
- `desktop/`: Windows + macOS app (own package.json, not in the Docker image). `native/` = VST3 hosting (`plugins.cpp` slots, `vst.cpp` addon, macOS `host.cpp` + `ipc.h`; JUCE via CMake FetchContent, `npm run build:native`). `main.js` (window, permissions, engine spawn + MessagePort), `preload.cjs` (`window.tabshareNative`), `engine.mjs` (utility process: audify/RtAudio ASIO or Core Audio + NAM WASM + `convolver.mjs`). Page side: `src/rig/native.ts` (protocol), the `native` branches in `useRig.ts`, `src/rig/pcm-feed.ts`. See `desktop/README.md`.
- `public/welcome/`: landing page (static `index.html` + `img/` screenshots), served by the app at `/welcome/` (no public copy anywhere). `index.html` redirects a bare visit (`/` with no hash, outside the desktop app) there; "Log in" goes to the lobby at `/#/`; invite links (`/#/r/…`) and the desktop app never see it. `noindex` meta + the global `X-Robots-Tag` + robots.txt keep it out of search. Screenshots come from `.playwright-mcp/shots.mjs` and `shots-desktop.mjs` (not committed; they still write to `site/img`, so update the path).
- `public/guide/`: user guide (static wiki page: every feature, troubleshooting, admin), served at `/guide/`. Linked from the
  welcome nav, the lobby and the room header's **?** (new tab; the desktop app opens it in the system browser). Reuses
  `../welcome/img/`. **Update it when a feature changes.** Check: `.playwright-mcp/guide-check.mjs` (production build).
- `shared/pitch.ts` (McLeod pitch detection, `nearestNote`) + `shared/music.ts` (note names, scales, arpeggios, guitar/bass tuning presets); tests in `shared/pitch.test.ts`.
- `src/Tuner.tsx`: tuner panel (transport "Tuner"). Input: desktop engine `tap` messages (dry selected channel, engine 0.2.2+; falls back to the mic if none arrive in 1.5 s), else the browser rig's `tapNode` (inGain), else getUserMedia. Detects every 50 ms on 4096 samples, median of 5.
- `src/Fretboard.tsx`: fretboard drawer under the score (transport "Fretboard"): tunings, root, scales, arpeggios, notes/intervals, roots, left-handed, 12–24 frets, and **Follow** a stringed track: `api.tickCache.findBeat(Set([track]), tick)` on `playerPositionChanged` (works for tracks that aren't rendered; `activeBeatsChanged` only reports rendered ones). Prefs in `tabshare.fretboard`, open state in `tabshare.fretboard.open`.
- `src/CallWindow.tsx`: renders the call into a second window: `useChildWindow(open, content, onClosed)` (own React root, since events from another document never reach the main root; styles copied; videos muted, audio stays in the main page), `CallStage` (pop-out: others split-screen, you bottom-right, mute/cam/full screen) and `CallPip`. CallPanel: **⧉ Pop out** (`window.open('', 'tabshare-call')`), desktop auto-PiP (`window.open('', 'tabshare-pip')`; main.js makes it borderless, always on top, bottom-right, shown without focus) driven by `native.onAppFocus`, browser **PiP** button + Chrome's auto-PiP via `mediaSession` 'enterpictureinpicture' (Document Picture-in-Picture). Classes are `cw-*` (the copied stylesheet already has `.stage`).
- `shared/exercises.ts` + `src/Practice.tsx`: **Practice mode** (Tab | Practice switch in the stage bar). 22 bass
  exercises generated from key/options/tuning/tempo: pitches → `place()` (5-fret hand position) → 4/4 bars →
  `toAlphaTex` (the only alphaTex writer; alphaTex string 1 = highest string). Practice has its own ScoreView/alphaTab
  api (solo, never synced) and the Fretboard in `forced` mode (locked Follow + resting dots, saved prefs untouched).
  Room keeps the tab view mounted but hidden (`.tab-view.off`, visibility so alphaTab keeps its width) and paused +
  muted (`masterVolume = 0`) while practicing, so remote jam moves still update it. Speed trainer = `playbackSpeed` on
  each loop wrap. Settings per exercise in `tabshare.practice.<id>`. Tests: `shared/exercises.test.ts` builds every
  exercise × key × option × tuning and parses the alphaTex in Node (`AlphaTexImporter`). Spec/plan in `docs/superpowers/`.
- `shared/drums.ts` + `src/Drums.tsx`: **Drums mode** (Tab | Practice | Drums | Browser). A drum song = `{style, tempo, sections: [{type, bars, seed}]}`
  (seeds, not notes: every client generates the same part). `buildDrums` = rules-based grooves per style (10 styles, 4/4
  or 12/8) × section feel, seeded mutations, fills in each section's last bar, crash on section starts; `drumsToAlphaTex`
  writes `instrument percussion` + GM drum numbers + `clef neutral`. Own ScoreView like Practice (the tab pauses +
  mutes). Section loop = `api.playbackRange` over the section's bars. **Share with the room** (`tabshare.drums.share`,
  default off): `room.drums` (`DrumShare`, live-only, `drums` WS message, song validated by `drumSong()`); only user
  actions send. Saved songs: `StoredRoom.drumSongs` (≤ 50; `saveDrums`/`deleteDrums`). alphaTab 1.8 gotcha: never
  subscribe to `api.midiLoaded` with the worker player (its getter recurses forever); use `midiLoad` + a setTimeout.
  Tests: `shared/drums.test.ts`, `.playwright-mcp/drums.mjs` (2 users). Spec/plan in `docs/superpowers/`.
- `src/Browser.tsx`: **Browser mode** (fourth switch, after Drums). One shared page per room: `room.browse` (`BrowseState`, live-only like transport; `browse` WS message, URL checked by `browseUrl()` in shared/protocol.ts: http(s), no credentials, ≤ 2048). Desktop app 0.3.2+ (`native.webview`) embeds it with Electron `<webview>` (sites that refuse iframes still load); main.js `will-attach-webview` forces no preload / no Node / sandbox / partition `persist:tabshare-browser` (its own cookies, so the server API key header never reaches it; no camera/mic; pop-ups load in place). **Keep the app's own user agent for embedded pages**: a rewritten "plain Chrome" UA fails Cloudflare Turnstile (header and JS UA disagree; Reverb sign-in). "Browse together" (`tabshare.browser.follow`, default on): your navigations are shared and others' move you. Elsewhere (web, iOS, older apps) the shared URL is a card with Open + a box to share a link. The tab keeps playing in Browser mode (only Practice and Drums pause/mute it); the Browser view stays mounted once opened. Test: `.playwright-mcp/browser-test.mjs` (Electron + Chrome).
- Phone/tablet layout: the side panel becomes a drawer (☰) at `(max-width: 860px), (max-height: 500px), (hover: none) and (pointer: coarse)` (phones in any orientation, every iPad), in `styles.css` and `useNarrow` (Room.tsx); the compact header (icon-only buttons) is only for small screens.
- `mobile/`: iPhone/iPad app (Expo SDK 57, local Xcode builds, TestFlight). WebView of the server + `window.tabshareNative` bridge (`src/bridge.ts`) to a native rig (`modules/tabshare-audio`: RemoteIO + NeuralAmpModelerCore). iOS has one input device, so with the rig on the call's voice comes from an interface input (`voice` stream replaces the mic in `useCall`). See `mobile/README.md`.
- **Room audio** (desktop 0.4+): `desktop/native/net/` → `tabshare_net.node` (JUCE-free N-API): SonoBus's AOO fork
  (`essej/aoo@9960da7`, BSD) + Opus 1.5.2 via CMake FetchContent. `room.cpp` = one UDP socket, threads recv/send/events/
  client, SonoBus's handshake (dummy source 0, per peer sink+source with the same id, re-invite on SOURCE_ADD), `/sb/ping`
  RTT, AutoFull jitter buffer, safety mute for new peers. Server `aoo.sonobus.net:10998` is fixed in engine.mjs (not from
  the page). Group = `audioCredentials(room)` (server/store.ts, HMAC; password rotates with the room password), sent in
  `welcome.audio`. AOO user = `ts-<clientId>-<4>`. Engine: rig callback `net.process(y, out)`; rig off + Hear the room
  + someone linked → output-only stream. Page: `src/rig/useRoomAudio.ts` + `RoomAudio.tsx` (Rig panel), call skips the
  instrument of linked peers. **Gotcha: AOO plays Opus sharp/gappy when the audio block > the Opus frame**, so the frame is
  the smallest 120·2^k ≥ block (128 → 240). Spec/brief/plan in `docs/superpowers/`. Tests: `desktop/native/net.test.mjs`
  (local AOO server; `NET_LIVE=1` = aoo.sonobus.net), `.playwright-mcp/room-audio-e2e.mjs` (app + bot member).
- **ASIO driver loading** (Windows): RtAudio's device listing loads every installed ASIO driver, and wrapper drivers
  (ASIO4ALL, FL Studio ASIO) take over Windows audio devices: a USB call mic went silent for good. `desktop/scripts/
  patch-audify.mjs` (run by `npm run build:native`) rebuilds audify's RtAudio with a `TABSHARE_ASIO_ONLY` filter; the
  engine lists names from the registry and loads only the picked driver (`devices` + `probe`). Probe:
  `.playwright-mcp/asio4all-mic.mjs`.
- `desktop/picker.html` + `picker-preload.cjs`: screen-share picker (thumbnails of screens + windows, tabShare's own windows excluded, screens labelled with resolution and "main").
- `src/App.tsx`: hash routing (`#/r/<code>`, `#/admin`) and the lobby (create/join).
- `src/Admin.tsx`: admin page (list rooms with who's online, change a room's password, delete a room).

## Key design decisions

- **Instrument rig**: graph = getUserMedia (EC/NS/AGC off, 2 ch) → ChannelSplitter (input 1/2) → inGain → AudioWorklet `nam-processor` → [Convolver when an IR is loaded] → outGain → monitor (ctx.destination, output device via `AudioContext.setSinkId`) + a MediaStreamDestination that the call mixes in. Browsers can't open ASIO; interfaces show up as their WASAPI/CoreAudio device. NAM WASM gotchas inside AudioWorkletGlobalScope: no `fetch` and no `URL`. The main thread sends the wasm bytes (`wasmBinary`), and `locateFile` must be passed or Emscripten calls `new URL(..., import.meta.url)` and throws. The processor is built with `?worker&url` and `worker.format: 'es'` (self-contained bundle). The model JSON is kept in localStorage (`tabshare.rig.*`). Call audio: voice (mic) and instrument (rig) go out as **two separate tracks** (see Video call), so receivers set each person's voice and instrument volume independently; mic mute = `micTrack.enabled = false`, so the guitar keeps flowing. Senders get 64 kbps (voice) / 128 kbps (instrument) once connected. **TONE3000**: the publishable key comes from `/api/config` (`TONE3000_CLIENT_ID` env). The Select flow runs in a popup with PKCE (in the iOS app: the system sign-in sheet, see `mobile/README.md`); tokens live in localStorage with refresh. Models are listed A2 + legacy (non-NAM entries are filtered out) and downloaded with Bearer.

- **Desktop app / native rig**: Electron loads `TABSHARE_URL` (default the live site), so web changes ship without a reinstall; only `desktop/` changes need a new installer. The engine opens ASIO on Windows and
Core Audio on macOS (`API` in engine.mjs); the page shows `NATIVE_DRIVER` from `native.platform`. macOS: main.js asks
for microphone access (TCC) before the engine starts; the dmg is arm64, hardened runtime with
`resources/entitlements.mac.plist`, signed with Developer ID and notarized by `npm run dist:mac`. **macOS plugins run
in a separate process** (`tabshare_plugin_host`): JUCE's Mac message loop (`CFRunLoopGetMain`, `[NSApp run]`) and
plugin windows need a process main thread, which a utility process doesn't have (its main run loop isn't pumped). The
macOS addon is a JUCE-free client with the same JS API: control frames + one synchronous audio round trip per plugin
per block over socketpairs (13–78 µs; dry past half a block). Host death → `hostExited` → engine stops with an error.
Security: the engine only loads `vstLoad` paths that are in its own `vst.list()` (the page is remote content), and only
the plugin host is signed with library validation off (`resources/sign.cjs` + `entitlements.host.plist`).
The host must call `juce::initialiseNSApplication()` itself (else `[NSApp run]` returns at once and main exits). `/api/config.desktopDownloads` = `{win, mac}`, picked by user agent. `useRig` checks `window.tabshareNative`: when present, the same state/controls drive the engine (`start/stop/params/loadModel/ir` messages) instead of the Web Audio graph. Engine chain: ASIO duplex stream (all input channels opened, channel picked in JS; 2 output channels at the chosen pair) → gain → NAM → partitioned FFT convolver → gain → out. It runs at the interface's **current** rate (`preferredSampleRate`, so other apps' clocks aren't flipped) and the buffer size the driver accepts (UA forces its Console setting). Windows (patched audify, `scripts/patch-audify.mjs`, desktop 0.4.1+): **direct output**: the ASIO thread hands JS the
block and waits up to 70% of a block for its output, playing it in the same callback (latency = driver in+out); a late
answer plays silence. More than 1% late blocks two seconds running → the engine falls back to stock audify (queued:
output plays on the next callback, + 1 buffer; blocks dropped if more than one is queued). macOS uses stock audify
(queued). The engine sends `audioStats` once a second (late/empty/dropped/skipped/xruns, mode) and the Rig panel shows
dropouts in the last 10 s. Mike's Focusrite 4i4 crackled on everything the app played while what it sent was clean;
not yet confirmed fixed. Probe: `.playwright-mcp/sync-probe.mjs`. The patch also makes ASIO's preferred rate the
interface's current one (stock RtAudio picks the highest ≤ 48 kHz). IRs are decoded + resampled by the page (OfflineAudioContext at the engine rate) and normalized like a ConvolverNode (`normalizeIr`), truncated to 0.5 s. The processed signal comes back as 512-sample PCM messages → `pcm-feed` worklet in its own AudioContext at the engine rate → MediaStream → the call mixer (unchanged). Gotchas: Electron `MessagePortMain.postMessage` only transfers ports (PCM is copied); the utility process must attach `parentPort` listeners synchronously or the port message is lost. Prefs for the native device/channel/output are stored under `tabshare.rig.native.*`. Autoplay is disabled in the app (`autoplay-policy` switch), so no unlock banner. Screen share picks the primary screen (no picker). **VST3**: `tabshare_vst.node` (JUCE) hosts plugins in 16 fixed slots; the engine calls `process(slot, mono block)` inside its audio callback (try_lock per slot, so a load/unload never blocks audio; empty/busy slots pass through). Loading, editor windows and get/setState run on a JUCE message thread the addon starts itself. The page owns the chain (`tabshare.rig.native.vst`: slot, path, name, post, base64 state), sends `vstLoad` for every entry on each engine start, `vstChain` for order/position, and `vstSaveAll` before stop; `vstState` also arrives when a plugin window closes. A new page port unloads all plugins. If the engine process dies, main.js forks a new one and the preload tells the page (error + stopped).
- **Original audio (YouTube)**: `TabMeta.youtube = {videoId, syncPoints}` is saved per tab (`tabVideo` WS message, validated on the server). The audio source (`MixState.source`) is part of the jam mix like everything else: per-user with jam off, shared with jam on. In Original mode alphaTab runs `PlayerMode.EnabledExternalMedia`: `updateSettings()` swaps the player, an `IExternalMediaHandler` sends play/pause/seek/speed/volume to the YT player, `loadMidiForScore()` rebuilds it, and a 50 ms interval feeds `yt.getCurrentTime()` into `output.updatePosition()`. YT's own play/pause controls are mirrored into alphaTab through onStateChange. Sync points are alphaTab FlatSyncPoints applied with `score.applyFlatSyncPoints` on scoreLoaded and whenever they change (`api.updateSyncPoints()`). Tap sync maps each T press to the next bar in playback order (from `tickCache.masterBars`, so repeats count). Track mute/solo/volume, metronome and count-in don't apply in Original mode, and the UI greys them out. YouTube ToS: the player stays visible, at least 200 px tall. **Always call the YT player through `ytCall()`**: the real YT API throws once its iframe is destroyed. `ytRef` is set synchronously in `onYtPlayer` (not during render), so effects in the same commit as the box unmounting don't see a dead player. `ErrorBoundary` (main.tsx) shows a reload screen instead of a blank page if something throws.

- **Video call**: mesh P2P, good for about 4–5 people. The lower clientId always sends the offer (no glare), and an unanswered offer is retried after 6 s. Each connection has three transceivers in a fixed order: audio (voice), audio (instrument), video; mute, camera, device switch, screen share and rig on/off are all `replaceTrack`, so nothing is renegotiated. Playback (`src/callAudio.ts`): each remote voice and instrument track goes through its own GainNode in a call-only AudioContext (`setSinkId` = the call's speaker choice; iOS ignores media element volume, hence Web Audio; Chrome needs the track on a muted `<audio>` too or Web Audio gets silence). The call panel's **🎚 Mix** sets them (0–200%), saved per person's name in `tabshare.callMix`. Tile `<video>`s are video only. A peer on a pre-mix page has one audio m-line: you'd get their voice+instrument as "voice" and they'd hear only your voice until they reload. Turning the camera off stops the track (camera light goes off). STUN only (Cloudflare and Google); no TURN, so strict NATs can fail (see the shortcut comment). It needs a secure context: works over HTTPS and on localhost, not over plain http to a LAN address. Device choices and the "original sound" setting are kept in localStorage.

- **Self-hosting / auth** (`server/config.ts`, `DATA_DIR/config.json`): first boot prints a one-time setup code to the log; `#/setup` claims the server with it (admin username/password, public URL, TONE3000 client ID). Validate everything before saving: a half-saved setup would lock the setup page. `ADMIN_PASSWORD` (+ `ADMIN_USERNAME`, `PUBLIC_URL`, `TONE3000_CLIENT_ID`) on a first start with no config skips setup (that's how pre-0.3 installs migrate). Admin requests: `Authorization: Bearer <session>` (`/api/admin/login`, HMAC-signed, 30 days, bound to the password hash so a password change signs everyone out) or `X-Api-Key` (API keys `tsk_…`, sha256-hashed, shown once, revocable). Settings: public URL (invite links, desktop setup), port (`listenPort()`, restart via `/api/admin/restart` = exit and let the container restart), TONE3000 key, `requireAdminForRooms` (default on). The desktop app sends `tabShareDesktop/<version>` in its user agent; such requests (HTTP and the WS upgrade) need a valid `X-Api-Key` (401 otherwise). Browsers keep using room passwords. Failed sign-ins and setup codes count toward the per-IP lockout. `/downloads` is only the legacy update feed for desktop ≤0.2.x. Older admin notes: Deleting a room or changing its password closes every socket in it with code 4401. Failed admin or room-join passwords count per IP: 10 in 15 min gets a 429 (`trust proxy` is set to loopback and uniquelocal so the limit works behind cloudflared). The client keeps the admin password in sessionStorage.

- **Positions are layout-independent.** Cursors are `{bar, fx, fy}` relative to MasterBarBounds. Selections and loops are MIDI tick ranges. So they line up for peers with different widths or track views.
- **Per-user vs shared:** track view, mute, solo, per-track volume (`volumes[]`, multiplier 0–2), metronome, count-in and Synth/Original `source` are per-user with jam off. With jam on they're shared through `room.mix` (live-only server state, reset on tab switch, sent in the welcome). Users with jam on send a `mix` message on every toggle and apply incoming ones. Turning jam on or joining late adopts the current mix. The **track view** follows the jam only while "Same track view as the jam" is ticked (`tabshare.jam.syncView`, default on); unticked, incoming `tracks` are ignored and your `mix` messages send the room's current `tracks` back unchanged. "Tab only" (`tabshare.tabOnly`, default on, per person) hides standard notation on guitar and bass staves (GM programs 24–39) that have a tab. The tab, the loop and the chat are always per-room.
- **Jam sync defaults on** (toggle per user). Transport messages carry `timeMs` + server `at`. Receivers extrapolate using the clock offset. Only *user-caused* changes are broadcast: play/pause/stop/speed buttons, and seeks within 1 s of a `beatMouseDown`/`beatMouseUp` that has a non-null beat. NEVER broadcast from `playerPositionChanged.isSeek` on its own. alphaTab reports isSeek for loop wrap-arounds (`tickPosition = startTick`) and for remotely applied seeks, and `beatMouseUp(null)` fires on every page mouseup. Re-broadcasting those made clients keep re-seeking each other, and every seek clears the audio buffer, so people heard silence. Audio lock: `isAudioLocked()` (Firefox `getAutoplayPolicy`, otherwise `userActivation.hasBeenActive`) is checked when the room mounts. While locked, a banner is shown, and the first pointerdown/keydown anywhere (capture) unlocks. If a jam is playing it also re-applies the transport inside that gesture, because the local player couldn't advance while locked. It skips this if the click is on a transport button.
- **Score layout** (`tabshare.layout`, per person, Tab mode only): Page / Horizontal / Parchment picker next to zoom,
  alphaTab `display.layoutMode` (same effect as zoom). Horizontal = one endless row: `.tab-view.horizontal` lets the
  paper grow sideways, and `barNav` reveal + `scrollToPeer` scroll on both axes. ↑ / ↓ do nothing there (one row).
- **Keyboard**: Space play/pause; ← / → previous/next bar (playback order, repeats count), ↑ / ↓ first bar of the previous/next rendered row (`src/barNav.ts`; `tickCache.masterBars` + `boundsLookup.staffSystems`). Ignored while typing. In Tab mode an arrow seek is marked user-caused (`userSeekAt`), so jam sync shares it; Practice has the same keys.
- **Loop**: with a selection, pressing Loop sets a room-wide loop. Without one, it toggles a local whole-song loop.
- **Uploads**: raw body with `?name=`. Max 25 MB. Allowed extensions are in `ALLOWED_EXTENSIONS`. alphaTab can't import MIDI.
- alphaTab 1.8: the Vite plugin is the separate package `@coderline/alphatab-vite` (the built-in `@coderline/alphatab/vite` export is broken). Font and soundfont are copied into `public/` by the `postinstall` script. **Score theme** (`src/scoreTheme.ts`, `tabshare.scoreTheme`): Light/Dark button in the song header; ScoreView sets alphaTab's `display.resources` colors + `.score-paper.dark` on every instance (tab and Practice). **Sound banks** (`src/soundfont.ts`): Light = alphaTab's `sonivox.sf2` (1.3 MB, forced on touch devices and the iOS app); GeneralUser GS (32 MB) and MuseScore General (40 MB SF3, default on web/desktop) are picked per person in the Tracks panel (`tabshare.soundBank`) and swapped live with `api.loadSoundFont(url)`. They're not in git: `scripts/fetch-soundfonts.mjs` (sha256-pinned, with their licenses) runs in the Docker build; run `npm run soundfonts` once on a dev machine.

## Commands

`npm test` (server + shared unit tests) · `npm run dev` (server :3001 + vite :5173, loads `.env`) · `npm run typecheck` · `npm run build` · `npm start` (prod, serves dist)

Local `.env` (gitignored): `ADMIN_PASSWORD=devadmin`, `TONE3000_CLIENT_ID=t3k_pub_localtest` (dummy value so the Browse button shows; the real flow is mocked in tests).

**Windows gotcha:** stopping `npm run dev` from a background task leaves orphan node processes holding ports 3001/5173. Kill them afterwards: PowerShell `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -like '*Websites\tabShare*' } | % { Stop-Process -Id $_.ProcessId -Force }`.

## How we test (Playwright MCP)

- Multi-user: one `browser.newContext()` per user, create the room as the first user (admin `admin` / `devadmin` locally, from `.env`), the others join via `A.url()`. A fresh server for setup tests: spawn `server/index.ts` with an empty `DATA_DIR` and read the setup code from its stdout.
- Media: `addInitScript` stubs `navigator.mediaDevices.getUserMedia` (canvas `captureStream` for video, an oscillator → `MediaStreamDestination` for audio) and `enumerateDevices`. Real WebRTC still runs between the contexts.
- Measure audio by hooking `AudioContext.prototype.createMediaStreamDestination` or by analysing remote `<video>.srcObject` RMS.
- YouTube: headless Chromium can't play it. Use a fake `window.YT.Player` with a controllable clock. The real embed DOES load, and it is the only way to catch real-API crashes (see the Synth blank-page bug).
- TONE3000: mock `https://www.tone3000.com/**` with `ctx.route` (authorize → 302 to the callback with code/state/tone_id, token, tones, models, files).
- Real NAM files: copy a `.nam` into `.playwright-mcp/` (gitignored) to upload it in tests.
- Always: `npm run typecheck`, `npm test`, `npx vite build` before committing.

## Not yet verified / known limits

- Real audio interface + real rig latency in the browser (≈ 50–70 ms; no ASIO in browsers, only inputs 1/2). The Windows desktop app has been played through with a real bass and several VSTs (works).
- The full TONE3000 sign-in → pick → download with the user's real account.
- Real YouTube audio playback in Original mode; real cameras/mics; calls across two different home networks (STUN only, no TURN server).
- Autoplay: after a reload each user needs one click (the banner explains this). It can't be bypassed.

## Releasing

- Server: pushing to `main` builds `ghcr.io/penskyc/tabshare:latest` (GitHub Actions).
- Desktop: bump `desktop/package.json` `version`, then on each OS `npm run build:native`, `npm test`, `npm run dist`,
  smoke-test the package (`node smoke.mjs <app>` against `npm run dev`), and publish with `npm run publish` (Windows) /
  `npm run publish:mac` (macOS, signs + notarizes): electron-builder builds, then `release.mjs` checks the installer's
  sha512 against `latest*.yml`, creates release `vX.Y.Z` if needed and uploads with `gh` (signed in). Don't use
  electron-builder's own `--publish`: it raced itself and uploaded an installer that didn't match `latest.yml`, which
  the updater rejects. Apps update from GitHub.
- After pulling, run `npm install` in `desktop/` before building: a build missing a new dependency packages fine but
  crashes at launch.

## Roadmap / ideas

- Editing tabs collaboratively (CRDT, e.g. Yjs over the alphaTex or score model).
- Ultimate Guitar text-tab / chord-sheet import (plain text tab → alphaTex).
- Chord diagrams panel, tuner, fretboard view, lyrics/chords mode.
- Per-room roles (host-only transport). (Room password change/deletion is done, in `#/admin`.)
- Optional TURN server (e.g. coturn) for friends behind strict NATs.
- Browse TONE3000 IRs (cab impulse responses) like NAM models; save rig presets per user.
- Show remote players' rig/amp name in their call tile.
- Comments and annotations pinned to bars (Figma-style).
- Bar-range loop presets, A/B loop markers (practice mode already has a speed-up trainer).
- Practice mode next: progress tracking (log/stats), guitar exercises, shared practice over jam sync, ear training.
- Mobile layout polish, PWA install.
