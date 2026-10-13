# Room audio: low-latency instruments between desktop apps (SonoBus networking)

Date: 2026-10-13. Status: approved by Corey (design discussed in chat, "everything is approved").

## Why

First real session with Mike went badly: the instrument over the WebRTC call is voice-grade (Opus 128 kbps through a
browser jitter buffer, often 100+ ms), Mike's rig sounded staticky, and Corey's call mic went silent when his rig came
on. Corey and Mike already use SonoBus in Ableton and it works well. So the desktop apps get SonoBus's networking
built in, driven by the tabShare room, and the call goes back to voice + video only.

## Decisions (from the brainstorm)

- **Who**: desktop apps only (Windows + macOS). Browser and iOS people keep today's call-based instrument audio as a
  fallback, both ways.
- **Connecting**: SonoBus's public connection server `aoo.sonobus.net:10998` (TCP login/groups + UDP address
  handshake). It only introduces peers; audio is peer to peer (AOO hole punching). No relay: a pair that can't punch
  through falls back to the call's instrument audio.
- **Rig off**: "Hear the room" (on by default): the app still plays everyone's instruments with low latency.
- **Controls** (SonoBus-lite): your send format in the Rig panel (Opus 96 / Opus 128 / PCM 16 / PCM 24, default
  Opus 128); per person: volume, jitter buffer (Auto, or a manual ms value), live latency + dropout readout.
- **Library**: build AOO from SonoBus's fork (essej/aoo, `sono` branch, commit `9960da7`, BSD license) into a new
  native module. Opus from xiph/opus (BSD) built with CMake. No JUCE in this module.

## Architecture

### Native module `desktop/native/net/` → `tabshare_net.node`

Separate N-API addon (no JUCE), built on both OSes by the existing `npm run build:native` (same CMake project,
second target). Loaded in process by `engine.mjs` (unlike VST hosting on macOS, AOO needs no main thread).

JS API (all calls from the engine's JS thread; `process` runs inside the audio callback and never blocks or allocates
in steady state):

- `start({ user, group, groupPassword, sampleRate, blockSize, format })` → connects to the fixed server
  (`aoo.sonobus.net:10998`, hard-coded in the engine; the page can't point it elsewhere) and joins the group.
  Idempotent: calling again with new rate/block re-runs `setup` on every source/sink.
- `stop()` → leave group, disconnect, join threads, close the socket.
- `process(monoIn | null, outStereo)` → adds every peer's audio (mono, centred at 0.596 per side × peer gain) into
  `outStereo` (interleaved) and, when `monoIn` is given, sends it to every peer. `null` = hear only (sources
  stopped).
- `setFormat(index)` → 0 Opus 96, 1 Opus 128, 2 PCM 16, 3 PCM 24 (mono, so bitrate = per-channel rate).
- `setPeer(user, { gain, bufferMs })` → `bufferMs` 0 = Auto.
- `status()` → `{ state: 'off'|'connecting'|'connected'|'error', error?, peers: [{ user, linked, failed, latencyMs,
  bufferMs, auto, drops, level }] }` (polled by the engine at 4 Hz).

Inside, following SonoBus (see the brief in the plan): one IPv4 UDP socket; threads for receive, send (every ≤ 20 ms
and on notify; calls `client->send()` which drives the server handshake and hole punching), events (20 ms), and the
client (`run()`). Handshake identical to SonoBus: a dummy source id 0, per peer a sink + source with the same id,
invite their source 0 on `PEER_JOIN`, accept invites on our source 0 and per-peer sources, re-invite on
`SOURCE_ADD`. Reply to `/sb/ping` with `/sb/pngack` and send our own `/sb/ping` every 2 s for RTT. Auto jitter
buffer = SonoBus's AutoFull: start low, +1 block on drops > 0.5/s (≤ every 0.5 s), −1 block after 10 s clean, floor at
the level where drops came back; new peers are safety-muted until drops settle. Reconnect to the server every 1 s
after an unexpected disconnect; peers survive it.

Windows: `WSAStartup` in the module; link `ws2_32`. Defines: `USE_CODEC_OPUS=1 AOO_TIMEFILTER_CHECK=0 AOO_STATIC
OSC_HOST_LITTLE_ENDIAN=1`.

### Engine (`desktop/engine.mjs`)

- Rig on: `y = dsp.process(...)` → `net.process(y, out)` (remote mix added after your own monitor signal, so the
  Monitor toggle only affects you).
- Rig off + Hear the room + someone linked: opens the same device **output only** and calls `net.process(null, out)`.
  The device opens only while at least one peer is linked, so joining a room alone never grabs the interface.
- New messages (page → engine): `netJoin { group, password, user }`, `netLeave`, `netFormat { index }`,
  `netPeer { user, gain, bufferMs }`, `listen { on, device, outChannel, bufferSize }`. Engine → page: `netStatus`
  (also tells the page the feature exists; older engines never send it, so the UI stays hidden there).
- Network runs while the page is in a room (`netJoin` on join), independent of whether the device is open.

### Server + protocol

- `welcome` gains `audio: { group, password }`: group = `tabshare-` + 16 chars of HMAC(secret, `group:<roomId>`),
  password = HMAC(secret, `audio:<roomId>:<passwordHash>`). Derived, not stored; a room password change rotates it,
  so removed people can't keep listening. Only sent to people who joined with the password.
- AOO username = `ts-<clientId>-<4 random chars>` (unique on the shared server; the page maps it to the room member by
  clientId). Empty user password.

### Page

- `useRig`: `netJoin` when the engine reports net support and the room's `audio` is known; `netLeave` on leave.
  State: `roomAudio` = latest `netStatus`. Prefs: `tabshare.rig.native.netFormat`, `tabshare.rig.native.hearRoom`
  (default on), per person `tabshare.roomAudio` keyed by name `{ gain, bufferMs }`.
- Rig panel (desktop app only): **Room audio** section: Hear the room toggle, Send format, server status, and one
  row per room member with a desktop app: name, linked / connecting / couldn't connect (call fallback), latency ms,
  dropouts, volume slider (0–200%), buffer `Auto` or a ms slider (1–100).
- Call: the instrument track from anyone you hear directly is played at 0 (`useCall` gets the set of linked
  clientIds), so nothing doubles. Your mic is never replaced on desktop (unchanged; the voice-from-interface path stays
  iOS only).
- **ASIO4ALL warning** in the Rig panel when the chosen driver is ASIO4ALL: it takes every Windows audio device,
  including a USB call mic. Likely cause of Corey's silent mic and maybe Mike's static; checked during the build.

## Error handling

- Server unreachable / login refused: status `error` with the message, retry every 5 s; call fallback keeps working.
- Peer can't be reached (`PEER_JOINFAIL`): row says "couldn't connect, using the call"; their call instrument plays.
- Engine death: existing path (main.js forks a new engine, page re-sends start + netJoin).
- AOO sends audio unencrypted (as SonoBus does); the group password keeps strangers out of the group, not off the
  wire. Noted in the README.

## Testing

- `desktop/native/net.test.mjs` (node --test, needs the built addon): two clients in one process against a local AOO
  server (a tiny test server target built from AOO's `server.cpp`) on 127.0.0.1: both link, a sine sent by A arrives
  at B with the right pitch, gain 0 silences it, format switch keeps audio flowing, stop is clean. Live variant
  (`AOO_LIVE=1`) against aoo.sonobus.net.
- End to end on Corey's PC: the packaged app in a room + a Node "bot" member (WS join for the secret + the addon) sending
  a tone: the Rig panel lists the bot as linked with a latency, the engine reports its level; Hear the room opens the
  device only once the bot links. Packaged smoke (`smoke.mjs`) still passes.
- Unit test for the server's audio credentials (stable per room, rotate on password change, absent without join).
- Web: typecheck, `npm test`, vite build; Playwright check that the browser rig shows no Room audio section.
- Not verifiable here: two real players across the internet (Corey + Mike), latency by ear, macOS build (Mac session).

## Release

Desktop 0.4.0. Windows built and published here; Mac built on the Mac mini (stopgap: copy the Mac 0.3.3 files onto
v0.4.0 like earlier releases). Web part deploys as usual and stays hidden for older apps.
