# tabShare mobile (iPhone / iPad)

The tabShare site in a full-screen WebView, plus a native low-latency instrument rig. Like the desktop app it loads
your server's live site, so web changes need no new build. iOS/iPadOS 17+, built locally with Xcode (no Expo cloud),
distributed through TestFlight.

- `App.tsx`: asks for the server address once (also editable in Settings → tabShare), then shows the site.
  External links open in Safari.
- `src/bridge.ts`: injects `window.tabshareNative` (platform `ios`) into the server's pages: the same protocol as the
  desktop engine (`src/rig/native.ts` in the web app), so the rig panel drives the native engine. Float32 sample
  arrays cross as base64.
- `modules/tabshare-audio`: local Expo module. `TabshareEngine.mm`: one RemoteIO unit (input rendered inside the
  output callback) at 48 kHz and the rig panel's buffer size, NeuralAmpModelerCore (amp model + its partitioned FFT
  convolver for the cab IR), lock-free FIFOs to a 20 ms timer that sends `pcm` (call), `voice`, `tap` (tuner) and
  `level` messages. Models swap under a mutex the audio thread only try-locks. Measurement mode (no AGC/EQ).
- `plugins/`: config plugins. `withSceneLifecycle` (iOS 27 requires the scene life cycle; switches Expo's template
  to `ExpoAppSceneDelegate`) and `withSettingsBundle`.

**One input device on iOS.** With an interface plugged in, iOS records only from it, so while the rig is on your
voice in the call comes from another interface input (rig panel → *Voice (call)*), or you're silent while playing.
The rig's voice stream replaces the call's mic, and the page releases its own mic capture. Rig off: back to the
built-in mic. No VST3 on iOS (the plugins section is hidden).

```sh
npm install                 # also fetches NAM core + Eigen into modules/tabshare-audio/ios/vendor (gitignored)
npm run prebuild            # generates ios/ (never edited by hand; config lives in app.json + plugins/)
npm run ios                 # build + run on a USB/Wi-Fi paired iPhone/iPad (pick it in the prompt)
npm run testflight          # Release archive + upload with the Apple account signed in to Xcode
node scripts/web-test.mjs   # web side of the iOS rig in Chrome, fake engine (needs `npm run dev` in the repo root)
```

TestFlight, one time: create the app in App Store Connect (My Apps → + → New App, bundle ID
`dev.coreypensky.tabshare`). The build number is the upload time, the version is `version` in `app.json`.

Not yet: TONE3000 browsing (its sign-in popup needs `window.opener`, which iOS web views don't provide; load `.nam`
files from Files instead), background audio, Android.
