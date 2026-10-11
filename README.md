# tabShare

**Guitar tabs, played together.** A self-hosted web app for practising songs with friends from different houses:
everyone sees the same score with each other's cursors, hears the same mix, and can talk, jam and play through an amp
rig in the same room. Think Songsterr / Guitar Pro, multiplayer, on your own server.

- **Shared tabs:** Guitar Pro 3–8, MusicXML and alphaTex, rendered as notation + tab. Search Songsterr and import a
  song for the whole room in one click.
- **Play together:** live cursors, selections and playheads; shared loops; **jam sync** keeps play/pause/seek/speed
  and the whole mix (tracks, mute/solo, volume, metronome, count-in) in step for everyone.
- **Synth or the original:** synth playback with per-track controls, or the original recording on YouTube, tap-synced
  to the bars.
- **Practice tools:** speed trainer, metronome, count-in, loops, zoom, a chromatic **tuner**, and a **fretboard** that
  shows scales/arpeggios in any tuning or lights up the notes a track is playing.
- **Video & voice call:** peer-to-peer (good for 4–5 people), screen share, pop-out split screen, picture-in-picture,
  chat with link previews.
- **Amp rig:** play guitar or bass through [Neural Amp Modeler](https://www.neuralampmodeler.com/) captures (local
  `.nam` files or browsed from TONE3000), cab IRs, and VST3 plugins (desktop app), sent straight into the call.
- **Desktop app** (Windows, macOS Apple Silicon): the same rooms, with a native **ASIO / Core Audio** engine for
  low-latency monitoring (about 5–25 ms instead of the browser's 50–70 ms) and VST3 hosting. Updates itself.

Rooms are private: the admin creates them, people join with a link and the room password.

## Run the server (Docker)

```yaml
# compose.yaml
services:
  tabshare:
    image: ghcr.io/penskyc/tabshare:latest
    container_name: tabshare
    restart: unless-stopped
    ports:
      - "3001:3001"
    volumes:
      - ./data:/data
```

```sh
docker compose up -d
docker logs tabshare   # shows the one-time setup code
```

Or without compose:

```sh
docker run -d --name tabshare --restart unless-stopped -p 3001:3001 -v ./data:/data ghcr.io/penskyc/tabshare:latest
```

Open `http://your-server:3001`. The first visit asks for:

1. the **setup code** from the server log (so nobody else can claim a fresh server),
2. an **admin username and password**,
3. the **public URL** your friends will use (for invite links and the desktop app),
4. optionally a **TONE3000 client ID** to browse amp models in the Rig panel.

Everything lives in `/data` (rooms, uploaded tabs, `config.json`). Back that folder up.

### Admin (`/#/admin`)

- **Rooms:** see who's online, change a room's password (kicks everyone), delete rooms.
- **API keys:** one per person for the desktop app (and for scripts: send it as `X-Api-Key`). Shown once; revoke any
  time.
- **Settings:** public URL, port, TONE3000 client ID, and *Require admin sign-in to create rooms* (on by default; turn
  it off to let anyone with the link create rooms).
- **Account:** change the admin username/password (signs other sessions out).

Changing the port in Settings changes the port **inside** the container; update your port mapping to match, or just
change the host side of the mapping (`8080:3001`) and leave the setting alone.

### HTTPS, remote access

Cameras, microphones and the amp rig need a secure origin: run it behind HTTPS (a reverse proxy, Tailscale, or a
Cloudflare Tunnel). `localhost` works without it. Calls are peer-to-peer with public STUN servers only; very strict
networks may need a TURN server.

If you protect the server with **Cloudflare Access** (or anything that wants extra request headers), give desktop users
a service token: the desktop app's connect screen has an *Extra headers* section (`CF-Access-Client-Id`,
`CF-Access-Client-Secret`).

### Environment variables (optional)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | Listen port, unless set in Admin → Settings |
| `DATA_DIR` | `/data` (image) | Where rooms, tabs and settings are stored |
| `SESSION_SECRET` | random, saved in `/data` | Signs room and admin sessions |
| `ADMIN_PASSWORD` / `ADMIN_USERNAME` | — | Skip the setup page: create the admin account on first start |
| `PUBLIC_URL`, `TONE3000_CLIENT_ID` | — | Initial settings for that first start |

### TONE3000 (optional)

Create a **publishable** key (`t3k_pub_…`) at [TONE3000](https://www.tone3000.com/) and register the redirect URL
`https://your-server/t3k-callback.html`. Never use a secret key: the app is a public OAuth client with PKCE.

## Desktop app

Download the latest build from [Releases](https://github.com/penskyc/tabShare/releases/latest):

| Platform | File |
|---|---|
| Windows 10/11, 64-bit (x64; also runs on Windows on ARM via emulation) | [`tabShare-Windows-x64-Setup.exe`](https://github.com/penskyc/tabShare/releases/latest/download/tabShare-Windows-x64-Setup.exe) |
| macOS 12+, Apple Silicon (M1 and later; arm64) | [`tabShare-macOS-arm64.dmg`](https://github.com/penskyc/tabShare/releases/latest/download/tabShare-macOS-arm64.dmg) |

Intel Macs aren't built yet. On first launch it asks for:

- the **server URL**,
- an **API key** from the server's admin (Admin → API keys),
- optional **extra headers** (e.g. Cloudflare Access service-token headers).

The key and headers are stored encrypted with the OS keychain and are sent only to that server. Change them later with
*tabShare → Server…* (Ctrl/Cmd + ,) or the link in the lobby. The app checks GitHub for updates and asks before
restarting.

Windows: the installer isn't code-signed, so SmartScreen asks once (*More info → Run anyway*). Audio interfaces need an
ASIO driver (or ASIO4ALL). macOS asks for microphone, camera and (for screen sharing) screen-recording permission.

## Develop

```sh
npm install
npm run dev        # server on :3001 + Vite on :5173 (loads .env: e.g. ADMIN_PASSWORD=devadmin)
npm test           # server + shared unit tests
npm run typecheck
npm run build
```

Desktop app: see [`desktop/README.md`](desktop/README.md) (Electron; the VST3 host needs CMake and a C++ toolchain).
Project notes for contributors and AI assistants are in [`CLAUDE.md`](CLAUDE.md).

## Credits

tabShare stands on a lot of other people's work. Thank you.

**Music and audio**

- [alphaTab](https://alphatab.net) by Daniel Kuschny: score rendering, Guitar Pro/MusicXML import and synth playback (MPL-2.0).
- [Bravura](https://github.com/steinbergmedia/bravura) music font by Steinberg (SIL OFL 1.1), shipped with alphaTab.
- [SONiVOX](https://github.com/coderline/alphaTab) General MIDI soundfont by Sonic Network (Apache-2.0), shipped with alphaTab.
- [Neural Amp Modeler](https://github.com/sdatkinson/NeuralAmpModelerCore) by Steven Atkinson (MIT), via
  [nam-wasm](https://github.com/andremichelle/nam-wasm) by André Michelle (MIT).
- [songsterr-downloader](https://github.com/Metaphysics0/songsterr-downloader) by Ryan Roberts: the Songsterr JSON → Guitar Pro converter in `server/songsterr/` (MIT).
- [RtAudio](https://github.com/thestk/rtaudio) by Gary P. Scavone (MIT-style), via [audify](https://github.com/almoghamdani/audify) by Almog Hamdani (MIT): ASIO / Core Audio I/O.
- [JUCE](https://juce.com) by Raw Material Software (AGPLv3): VST3 plugin hosting, including Steinberg's VST3 SDK (MIT).
- [fflate](https://github.com/101arrowz/fflate) by Arjun Barrett (MIT).

**App and tooling**

- [React](https://react.dev) (MIT), [Vite](https://vite.dev) (MIT), [TypeScript](https://www.typescriptlang.org) (Apache-2.0), [tsx](https://tsx.is) (MIT).
- [Express](https://expressjs.com) (MIT) and [ws](https://github.com/websockets/ws) (MIT).
- [Electron](https://www.electronjs.org) (MIT), [electron-builder / electron-updater](https://www.electron.build) (MIT), [cmake-js](https://github.com/cmake-js/cmake-js) (MIT), [node-addon-api](https://github.com/nodejs/node-addon-api) (MIT).
- [Playwright](https://playwright.dev) (Apache-2.0) for end-to-end tests.

**Fonts** (SIL OFL 1.1, via Google Fonts): [Space Grotesk](https://github.com/floriankarsten/space-grotesk) by Florian Karsten, [JetBrains Mono](https://www.jetbrains.com/lp/mono/), [Instrument Serif](https://github.com/Instrument/instrument-serif).

**Services it talks to:** [Songsterr](https://www.songsterr.com) (tab search and data), [TONE3000](https://www.tone3000.com) (amp captures), [YouTube](https://www.youtube.com) IFrame Player API (original recordings), and Cloudflare / Google public STUN servers (calls). tabShare isn't affiliated with any of them; respect their terms.

## License

[AGPL-3.0](LICENSE). If you run a modified tabShare server for other people, you must offer them its source.
Third-party components keep their own licenses (above).
