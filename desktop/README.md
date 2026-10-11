# tabShare desktop (Windows + macOS)

A tabShare server's web app in a window, plus a native amp engine so the instrument rig runs through your interface's
**ASIO** driver (Windows) or **Core Audio** (macOS) instead of the browser's audio stack. Monitoring drops from about
50–70 ms (browser) to about 5–25 ms (driver buffer dependent). Same rooms, same UI: it loads the server's site, so web
updates need no reinstall.

- `main.js`: Electron main process. Window, permissions, link handling, spawns the engine and hands the page a
  MessagePort to it. Which server: `server.json` in the app's data folder (encrypted with `safeStorage`), set in the
  connect window (`connect.html`): URL, API key, extra headers. The key and headers are added only to requests to that
  origin (`webRequest.onBeforeSendHeaders`, WebSocket included); the user agent carries `tabShareDesktop/<version>`, which
  the server answers with 401 unless the key is valid (then the connect window reopens). Screen-share picker:
  `picker.html`. Updates: electron-updater from GitHub releases.
- `preload.cjs`: exposes `window.tabshareNative` (send / onMessage) to the app's own origin only.
- `engine.mjs`: utility process. audify (RtAudio: ASIO on Windows, Core Audio on macOS) duplex stream → input channel → gain → NAM (`@opendaw/nam-wasm`) → cab IR (`convolver.mjs`) → gain → ASIO out; streams the processed signal back to the page for the call.
- `native/`: VST3 hosting (JUCE 8, fetched by CMake). `plugins.cpp` holds 16 fixed plugin slots (load, editor
  windows, state on the JUCE message thread; `process(slot, buffer)` from the engine's audio callback). Plugins run
  before the amp (`vstPre`) or after the cab (`vstPost`). The engine works without it (no plugins section).
  - Windows: `tabshare_vst.node` hosts the slots in process and runs its own JUCE message thread.
  - macOS: JUCE's message loop and plugin windows need a process main thread, which a utility process doesn't have,
    so the slots run in `tabshare_plugin_host` (`host.cpp`). `tabshare_vst.node` is a JUCE-free client that starts it
    and talks over two socketpairs (`ipc.h`): control frames, and one synchronous audio round trip per plugin per block
    (13–78 µs measured; past half a block it passes the dry signal). If the host dies (a plugin crashed), the engine
    stops the rig with an error; turning it on starts a new host and the page loads the chain again.
- Page side: `src/rig/native.ts` (protocol), `src/rig/useRig.ts` (native branch), `src/rig/pcm-feed.ts` (call feed worklet).

```sh
npm install
npm start                                   # asks for a server on first run (Server… in the menu to change it)
$env:TABSHARE_URL='http://localhost:5173'; $env:TABSHARE_API_KEY='tsk_…'; npm start   # skip the connect window (dev/tests)
                                            # TABSHARE_USER_DATA=<dir> runs against a throwaway profile
npm test                                    # convolver + offline NAM chain (needs ../.playwright-mcp/test.nam)
node smoke.mjs [dist/win-unpacked/tabShare.exe]        # end to end vs local dev; monitor muted, nothing is audible
npm run build:native                        # VST addon (+ plugin host on macOS); Windows: VS 2022 C++ tools + cmake (`pip install --user cmake`), macOS: Xcode CLT + `brew install cmake`
npm run dist                                # Windows: dist/tabShare-Windows-x64-Setup.exe (build:native first, or the app ships without VST) (stop `npm run dev` first or Vite can lock dist/)
npm run dist:mac                            # macOS: dist/tabShare-macOS-{arm64,x64}.dmg (native addon + plugin host are universal), Developer ID signed + notarized (keychain profile `tabshare`)
                                            # unsigned test build: npx electron-builder --mac -c.mac.identity=- -c.mac.hardenedRuntime=false
                                            # (ad-hoc + hardened runtime can't launch: no Team ID, so library validation rejects Electron's own framework)
                                            # node smoke.mjs dist/mac-arm64/tabShare.app/Contents/MacOS/tabShare
npm run publish                             # Windows: build + upload to the GitHub release for this version (GH_TOKEN)
npm run publish:mac                         # macOS: sign, notarize, upload dmg + zip + latest-mac.yml (GH_TOKEN)
```

VST notes: plugins are listed from the standard VST3 folders by file name only (nothing is loaded until added, so a
broken plugin can't break the list). The rig is mono: the guitar feeds every plugin input and stereo outputs are folded
to mono. Settings are saved when you close a plugin's window and when the rig stops, and restored on every start. If a
plugin crashes the engine process, main.js starts a new one and the page says so. Licensed plugins need to be activated
on the PC like in any DAW.

Latency notes: the engine adds one buffer on top of the driver (audify hands input to JS and plays the reply on the
next callback). The ASIO buffer size is often fixed by the interface's own control panel (UA: Console → Settings →
Hardware → Buffer Size); the app shows what the driver actually used. The installer is unsigned, so Windows SmartScreen
asks once ("More info" → "Run anyway").

macOS notes: Core Audio lists only devices that have both inputs and outputs (an interface, or an Aggregate Device from
Audio MIDI Setup). The main process asks for microphone access at startup; without it the engine's input is silent.
Signing: `npm run dist:mac` signs with the
Developer ID Application certificate in the keychain (hardened runtime; `resources/entitlements.mac.plist` for the app and its
helpers: JIT for V8/WASM, audio input, camera; `resources/sign.cjs` gives `tabshare_plugin_host` alone
`entitlements.host.plist` with library validation off, since it loads other developers' plugins) and
notarizes with the notarytool keychain profile `tabshare` (`xcrun notarytool store-credentials tabshare --apple-id …
--team-id <your team id>`). Plugins that share Objective-C class names (Plugin Alliance's licenser) log "implemented in
both" warnings in the host; harmless so far.
