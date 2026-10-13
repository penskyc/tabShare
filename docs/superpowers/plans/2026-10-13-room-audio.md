# Room Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop apps in the same tabShare room hear each other's instruments with SonoBus-grade latency, over
SonoBus's AOO networking and public connection server, separate from the WebRTC call.

**Architecture:** A JUCE-free N-API addon (`tabshare_net.node`) wraps SonoBus's AOO fork (client + per-peer
source/sink, one UDP socket, 4 threads). The engine calls `net.process()` inside its audio callback. The server hands
each joined member derived group credentials in `welcome`; the page drives the engine with `net*` messages and shows a
Room audio section in the Rig panel. Spec: `docs/superpowers/specs/2026-10-13-room-audio-design.md`. SonoBus/AOO
details (handshake, threads, formats, jitter logic, gotchas): the AOO brief, copied to
`docs/superpowers/specs/2026-10-13-aoo-brief.md` in Task 1.

**Tech Stack:** C++20, node-addon-api, CMake (cmake-js), AOO `essej/aoo@9960da7f277b2e0a4ef2725c33895559b634cab7`
(BSD), Opus `xiph/opus v1.5.2` (BSD), Electron 44 utility process, React 19 + TS.

## File map

| File | Responsibility |
|---|---|
| `desktop/native/CMakeLists.txt` | + FetchContent aoo/opus, target `tabshare_net` |
| `desktop/native/net/room.hpp/.cpp` | `Room`: socket, threads, client, peers, handshake, jitter auto, mix |
| `desktop/native/net/addon.cpp` | N-API wrapper: start/stop/process/setFormat/setPeer/status/testServer |
| `desktop/native/net.test.mjs` | two clients via the local test server: link, tone, gain, format, stop |
| `desktop/engine.mjs` | load addon, `net*` + `listen` messages, mix in callback, output-only stream, netStatus |
| `desktop/package.json` | test script includes net.test.mjs; version 0.4.0 |
| `server/store.ts` | `audioCredentials(room)` |
| `server/index.ts` | `audio` in welcome |
| `server/audio.test.ts` | credentials stable / rotate / format |
| `shared/protocol.ts` | `RoomAudio` type, `welcome.audio` |
| `src/useRoom.ts` | keep `audio` from welcome |
| `src/rig/native.ts` | message types |
| `src/rig/useRig.ts` | net join/leave, format, peers prefs, listen, roomAudio state |
| `src/rig/RoomAudio.tsx` | Room audio section UI |
| `src/rig/RigPanel.tsx` | render section, ASIO4ALL warning |
| `src/useCall.ts` | instrument level 0 for natively linked peers |
| `src/Room.tsx` | pass room audio + linked ids |
| `.playwright-mcp/room-audio-bot.mjs` | E2E: packaged app + Node bot member |

---

### Task 1: Build AOO + Opus into a new addon target

**Files:** Modify `desktop/native/CMakeLists.txt`; create `desktop/native/net/addon.cpp` (stub), copy brief.

- [ ] Copy the brief: `cp <scratchpad>/aoo-brief.md docs/superpowers/specs/2026-10-13-aoo-brief.md`.
- [ ] CMake, after the JUCE block:

```cmake
FetchContent_Declare(opus GIT_REPOSITORY https://github.com/xiph/opus.git GIT_TAG v1.5.2 GIT_SHALLOW TRUE)
set(OPUS_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_PKG_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_CMAKE_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(opus)
# SonoBus's AOO fork (BSD): the protocol aoo.sonobus.net and SonoBus apps speak.
FetchContent_Declare(aoo GIT_REPOSITORY https://github.com/essej/aoo.git GIT_TAG 9960da7f277b2e0a4ef2725c33895559b634cab7)
FetchContent_Populate(aoo)
set(AOO ${aoo_SOURCE_DIR})
add_library(tabshare_net SHARED net/addon.cpp net/room.cpp
  ${AOO}/lib/src/client.cpp ${AOO}/lib/src/server.cpp ${AOO}/lib/src/codec_opus.cpp ${AOO}/lib/src/codec_pcm.cpp
  ${AOO}/lib/src/common.cpp ${AOO}/lib/src/net_utils.cpp ${AOO}/lib/src/sink.cpp ${AOO}/lib/src/source.cpp
  ${AOO}/lib/src/sync.cpp ${AOO}/lib/src/time.cpp ${AOO}/deps/md5/md5.c
  ${AOO}/deps/oscpack/osc/OscOutboundPacketStream.cpp ${AOO}/deps/oscpack/osc/OscReceivedElements.cpp
  ${AOO}/deps/oscpack/osc/OscTypes.cpp ${CMAKE_JS_SRC})
set_target_properties(tabshare_net PROPERTIES PREFIX "" SUFFIX ".node")
target_include_directories(tabshare_net PRIVATE ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR} ${AOO}/lib ${AOO}/deps ${CMAKE_CURRENT_BINARY_DIR}/opusinc)
target_compile_definitions(tabshare_net PRIVATE NAPI_VERSION=8 NAPI_DISABLE_CPP_EXCEPTIONS USE_CODEC_OPUS=1
  AOO_TIMEFILTER_CHECK=0 AOO_STATIC OSC_HOST_LITTLE_ENDIAN=1 _WINSOCK_DEPRECATED_NO_WARNINGS _CRT_SECURE_NO_WARNINGS)
target_link_libraries(tabshare_net PRIVATE ${CMAKE_JS_LIB} opus $<$<PLATFORM_ID:Windows>:ws2_32>)
```

  AOO includes `<opus/opus_multistream.h>`: copy opus's `include/*.h` to `${CMAKE_CURRENT_BINARY_DIR}/opusinc/opus/`
  with `file(COPY ...)`.
- [ ] Stub `addon.cpp` exporting `version()` → `"aoo"`; `npm run build:native` (from `desktop/`), expect
  `native/build/Release/tabshare_net.node`; `node -e "console.log(require('./native/build/Release/tabshare_net.node').version())"` fails under
  plain Node ABI? The addon is built for Electron's ABI (`--runtime=electron`); tests run with
  `ELECTRON_RUN_AS_NODE=1 npx electron --test ...` like vst.test (check how `npm test` runs vst.test and reuse it).
- [ ] Fix compile errors (MSVC) until it builds; commit.

### Task 2: `Room` core (native)

**Files:** `desktop/native/net/room.hpp`, `room.cpp`.

Class `Room` (one per engine), following the brief section by section:

- `start(Config{user, group, groupPassword, host, port, sampleRate, blockSize, format})`: `aoo_initialize()` once,
  `WSAStartup` once (Windows), UDP socket AF_INET bound to port 0 (1 MB buffers, 20 ms recv timeout), dummy source
  id 0, `iclient::create(this, clientSend, localPort)`, threads: recv, send, events, client (`run()`), then
  `client->connect(host, port, user, "")`. On CONNECT result>0 → `group_join(group, groupPassword)`; on unexpected
  DISCONNECT → reconnect timer 1 s (events thread).
- Endpoints: `std::map<std::string, std::unique_ptr<Endpoint>>` keyed `ip:port`, never freed while running;
  `Endpoint{sockaddr_in addr; Room* room}`; `endpointSend(void* ep, data, n)` → `sendto`.
- Peer: `{id, user, Endpoint* ep, isink* sink, isource* source, remoteSourceId, gain, bufferMs, auto, baseline,
  lastDrop, lastDecrease, drops, safetyMuted, rttMs, level, linked, failed, work buffer}`. `std::shared_mutex`
  peersMutex: audio thread takes shared lock with `try_lock_shared` (skip mixing that block if a writer holds it);
  peer add/remove and `setup` take exclusive.
- recv dispatch exactly as brief §2 (sink/source/client/peer/`/sb`), then notify send thread.
- send loop as brief §2: dummy `send()`, `client->send()`, per peer `source->send()`, `sink->send()`, `/sb/ping`
  every 2 s per linked peer.
- events: client events per brief §3 table; source events (INVITE on dummy 0 and per-peer, UNINVITE, PING); sink
  events (SOURCE_ADD re-invite, BLOCK_LOST → drops + auto increase, PING → auto decrease, SOURCE_STATE).
- formats per brief §5: `0 → opus 96000`, `1 → opus 128000`, `2 → pcm INT16`, `3 → pcm INT24`; mono.
- `process(const float* in /*nullable*/, float* outStereo, int n)`: `t = aoo_osctime_get()`, per peer zero work,
  `sink->process`, peak level, mix `work * gain * 0.596` (0 when safety-muted), then `in` → each peer's
  `source->process` (sources started only while sending; `setSending(bool)` toggles `start/stop` on change).
- `status()` snapshot copied under the mutex; `setPeer(user, gain, bufferMs)` (0 = auto) stored by user even before
  the peer links (applied on link).
- `stop()`: group_leave, disconnect, quit, join threads, destroy sinks/sources, close socket.
- Test server: `startServer(port)` creates `aoo::net::iserver::create(port)` and runs it on a thread (tests only).

- [ ] Write `room.hpp`/`room.cpp`; build; commit.

### Task 3: N-API wrapper + native test

**Files:** `desktop/native/net/addon.cpp`, `desktop/native/net.test.mjs`, `desktop/package.json` test script.

`addon.cpp`: module-level `Room room;` + exports `start(obj)`, `stop()`, `process(in|null, out)` (Float32Array, no
copies), `setFormat(i)`, `setPeer(user, {gain, bufferMs})`, `setSending(bool)`, `status()` → plain object,
`startTestServer(port)`, `stopTestServer()`. For the test, a second `Room` is needed: export a `Room` class too
(`new net.Room()`), and make the module-level functions use a default instance.

Test (`desktop/native/net.test.mjs`, run like vst.test):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const net = createRequire(import.meta.url)('./build/Release/tabshare_net.node');
const SR = 48000, N = 128, sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('two rooms link through a local server and hear each other', async () => {
  net.startTestServer(10998 + 7);
  const a = new net.Room(), b = new net.Room();
  const cfg = (user) => ({ user, group: 'g1', groupPassword: 'pw', host: '127.0.0.1', port: 10998 + 7, sampleRate: SR, blockSize: N, format: 1 });
  a.start(cfg('ts-a-1111')); b.start(cfg('ts-b-2222'));
  a.setSending(true);
  const tone = new Float32Array(N), out = new Float32Array(2 * N);
  let phase = 0, energy = 0, linked = false;
  // Drive both like audio callbacks (real time, 128 @ 48k = 2.67 ms) for up to 8 s.
  for (let i = 0; i < 3000 && !(linked && energy > 1); i++) {
    for (let k = 0; k < N; k++) tone[k] = 0.5 * Math.sin((phase += (2 * Math.PI * 440) / SR));
    out.fill(0); a.process(tone, new Float32Array(2 * N));
    b.process(null, out);
    for (let k = 0; k < 2 * N; k++) energy += out[k] * out[k];
    linked = b.status().peers.some((p) => p.linked);
    await sleep(2.67);
  }
  assert.ok(linked, 'b links to a');
  assert.ok(energy > 1, `tone arrives (energy ${energy})`);
  b.setPeer(b.status().peers[0].user, { gain: 0, bufferMs: 0 });
  // after gain 0: 200 blocks of silence
  let after = 0;
  for (let i = 0; i < 200; i++) { out.fill(0); a.process(tone, new Float32Array(2 * N)); b.process(null, out); for (const v of out) after += v * v; await sleep(2.67); }
  assert.equal(after, 0);
  a.stop(); b.stop(); net.stopTestServer();
});
```

- [ ] Write test, run, expect FAIL before the wrapper exists → implement → PASS. Add to `npm test`. Commit.

### Task 4: Server credentials + protocol

**Files:** `server/store.ts`, `server/index.ts`, `shared/protocol.ts`, `server/audio.test.ts`.

```ts
// store.ts
/** SonoBus group for the room's instrument audio: derived, so a password change rotates the password. */
export function audioCredentials(room: StoredRoom): RoomAudio {
  return {
    group: 'tabshare-' + createHmac('sha256', secret).update(`group:${room.id}`).digest('hex').slice(0, 16),
    password: createHmac('sha256', secret).update(`audio:${room.id}:${room.hash}`).digest('base64url'),
  };
}
// protocol.ts
export interface RoomAudio { group: string; password: string }
// welcome: { type: 'welcome'; clientId; room; peers; audio?: RoomAudio }
```

Test: same room twice → equal; after `setRoomPassword` → group equal, password differs; group matches
`/^tabshare-[0-9a-f]{16}$/`.

- [ ] Test (fail) → implement → pass → commit.

### Task 5: Engine integration

**Files:** `desktop/engine.mjs`, `src/rig/native.ts`.

- Load `tabshare_net.node` like the VST addon (optional; missing → no netStatus).
- Messages: `netJoin {group, password, user}` → `net.start({... host:'aoo.sonobus.net', port:10998, sampleRate:
  dsp.sampleRate || 48000, blockSize: block || 128, format})`; keep the join config so a stream (re)start calls
  `net.start` again with the stream's rate/block (Room re-setup). `netLeave` → `net.stop()`. `netFormat`, `netPeer`.
  `listen {on, device, outChannel, bufferSize}`: remember; while rig off and on + any linked peer → open output-only
  stream; close when none linked / rig starts / off.
- Callback: rig stream → `net.process(y, out)` after `dsp.process`; listen stream → `out.fill(0); net.process(null,
  out)`.
- `setSending(rt is a rig stream)`.
- 4 Hz timer: `send({type:'netStatus', ...net.status(), listening})`; also reconcile the listen stream.
- `native.ts`: add the message types (`RoomAudioStatus`, `RoomAudioPeer`).
- [ ] Implement; offline check: `npm test` in desktop; commit.

### Task 6: Page: useRig + Room audio UI + call de-dup + ASIO4ALL warning

**Files:** `src/useRoom.ts`, `src/rig/useRig.ts`, `src/rig/RoomAudio.tsx`, `src/rig/RigPanel.tsx`, `src/useCall.ts`,
`src/Room.tsx`, `src/styles.css`.

- useRoom keeps `audio` from welcome on the room state.
- `useRig(roomAudio, clientId)`: when `netStatus` has been seen and both known → `netJoin {group, password, user:
  'ts-' + clientId + '-' + rand4}`; on change/unmount `netLeave`. Prefs `native.netFormat` (default 1),
  `native.hearRoom` (default '1'), `tabshare.roomAudio` per name. Returns `roomAudio: status|null`, `setNetFormat`,
  `setHearRoom`, `setPeerMix(name, user, {gain, bufferMs})`, `linkedClientIds: Set<string>` (from `ts-<id>-` users).
  Sends `listen` whenever hearRoom/device/channel/buffer change.
- `RoomAudio.tsx`: section (desktop only, shown once netStatus arrives): Hear the room checkbox, Send format select,
  status line, rows per peer (name from room peers by clientId; linked/connecting/failed; latency; drops; volume
  0–200%; buffer Auto checkbox + 1–100 ms slider).
- useCall: `useCall(room, instrument, voice, linkedIds)`; in the play effect, instrument level 0 when
  `linkedIds.has(id)`.
- RigPanel: warning when `rig.nativeDevice` matches `/asio4all/i`.
- [ ] Implement; typecheck; vite build; commit.

### Task 7: Bugs from the first session

- [ ] ASIO4ALL vs the Razer mic: with the engine on ASIO4ALL (monitor muted), check in the app whether the call's mic
  track stays live (getUserMedia track `readyState`/`muted` + analyser level). Record the result in the notes; the
  warning text states what was observed.
- [ ] Latency when a second member joins: run `.playwright-mcp/cadence-win.mjs`-style probe (engine callback gaps) while a
  headless browser joins the room; compare gaps before/after. Fix if the cause is found; else record.

### Task 8: End to end + release

- [ ] `.playwright-mcp/room-audio-bot.mjs`: start dev; Node bot joins the room over WS (gets `audio`), starts a
  `Room` with the addon under Electron-as-Node, sends a 220 Hz tone; the desktop app (dev, then packaged) in the same
  room with the rig on: Rig panel row for the bot shows Linked + latency, engine status level > 0. Rig off + Hear the
  room: engine opens the output-only stream after the bot links.
- [ ] Live variant against aoo.sonobus.net (bot + app on this PC).
- [ ] Web: typecheck, `npm test`, vite build; push; deploy; verify live bundle.
- [ ] Desktop 0.4.0: bump, `npm run build:native`, `npm test`, `npm run dist`, packaged smoke + bot test,
  `npm run publish`; copy Mac 0.3.3 files onto v0.4.0 as the stopgap; verify feeds.
- [ ] CLAUDE.md (layout + design decision), README (room audio, unencrypted note), NOTES progress log + Mac session
  to-do.
