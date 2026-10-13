// Native audio engine (Electron utility process): ASIO (Windows) / Core Audio (macOS) in → channel pick → input gain → NAM (WASM) → cab IR →
// output gain → ASIO out, at the driver's buffer size. Also streams the processed signal to the page for the call, and
// (room audio) sends it to the other desktop apps in the room over SonoBus's networking, mixing theirs into the output.
// Protocol: messages on the MessagePort the main process hands over (see main.js / preload.cjs, src/rig/native.ts).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import audify from 'audify';
import { createNamModule, NamWasmModule } from '@opendaw/nam-wasm';
import { Convolver } from './convolver.mjs';

const { RtAudio, RtAudioApi, RtAudioFormat } = audify;
const API = process.platform === 'darwin' ? RtAudioApi.MACOSX_CORE : RtAudioApi.WINDOWS_ASIO;
const require = createRequire(import.meta.url);
const MAX_BLOCK = 2048;
const FEED_BLOCK = 512; // samples per message to the page (call audio; latency there doesn't matter much)
const MAX_IR_SECONDS = 0.5;
// Room audio: SonoBus's public connection server. Fixed here, not taken from the page (the page is remote content).
const ROOM_AUDIO_SERVER = { host: 'aoo.sonobus.net', port: 10998 }; // shortcut: longer IR tails are cut; cab IRs are well under this

/** The DSP chain, independent of the audio device so it can be tested offline. */
export class Dsp {
  static async create() {
    const wasmBinary = readFileSync(require.resolve('@opendaw/nam-wasm/nam.wasm'));
    const module = await createNamModule({ wasmBinary, locateFile: (p) => p });
    return new Dsp(NamWasmModule.fromModule(module, MAX_BLOCK));
  }

  constructor(nam) {
    this.nam = nam;
    this.nam.setMaxBufferSize(MAX_BLOCK);
    this.id = nam.createInstance();
    this.sampleRate = 0;
    this.modelJson = null;
    this.ir = null;
    this.conv = null;
    this.block = 0;
    this.params = { channel: 0, inGain: 1, outGain: 0.5, monitor: true, bypass: false };
    // VST3 plugins (desktop/native addon): slot numbers before the amp and after the cab, in order.
    this.vst = null;
    this.vstPre = [];
    this.vstPost = [];
  }

  /** (Re)configures for a stream. Reloads the model when the rate changes, since NAM is rate-dependent. */
  configure(sampleRate, block) {
    if (sampleRate !== this.sampleRate) {
      this.sampleRate = sampleRate;
      this.nam.setSampleRate(sampleRate);
      if (this.modelJson) this.loadModel(this.modelJson);
    }
    this.block = block;
    this.x = new Float32Array(block);
    this.y = new Float32Array(block);
    this.setIr(this.ir);
  }

  loadModel(json) {
    this.modelJson = json;
    const ok = this.nam.loadModel(this.id, json);
    if (!ok) this.modelJson = null;
    return ok;
  }

  unloadModel() {
    this.modelJson = null;
    this.nam.unloadModel(this.id);
  }

  /** @param {Float32Array|null} ir already at the stream's sample rate and normalized by the page */
  setIr(ir) {
    this.ir = ir ? ir.subarray(0, Math.round(MAX_IR_SECONDS * (this.sampleRate || 48000))) : null;
    this.conv = this.ir && this.block ? new Convolver(this.ir, this.block) : null;
  }

  /**
   * Processes one block. Returns the mono processed signal (for the call) and writes the stereo monitor mix into `out`.
   * @param {Float32Array} input interleaved, `nIn` channels @param {Float32Array} out interleaved stereo
   */
  process(input, nIn, out) {
    const { x, y, params } = this;
    const ch = Math.min(params.channel, nIn - 1);
    let peak = 0;
    for (let i = 0; i < x.length; i++) {
      const v = input[i * nIn + ch];
      if (Math.abs(v) > peak) peak = Math.abs(v);
      x[i] = v * params.inGain;
    }
    for (const slot of this.vstPre) this.vst.process(slot, x);
    if (params.bypass || !this.modelJson) y.set(x);
    else this.nam.process(this.id, x, y);
    if (this.conv) this.conv.process(y);
    for (const slot of this.vstPost) this.vst.process(slot, y);
    for (let i = 0; i < y.length; i++) {
      y[i] *= params.outGain;
      out[2 * i] = out[2 * i + 1] = params.monitor ? y[i] : 0;
    }
    this.peak = Math.max(this.peak ?? 0, peak * params.inGain);
    return y;
  }
}

// ---------- device + messaging (only when running as the Electron utility process) ----------

if (process.parentPort) {
  // Listeners must be attached synchronously (parentPort drops messages that arrive before), so the WASM loads in
  // the background and port messages wait for it, in order.
  let dsp = null;
  const ready = Dsp.create().then((d) => (dsp = d));

  // VST3 hosting is optional: without the native addon (not built) the rig works without plugins.
  let vst = null;
  try {
    vst = require('./native/build/Release/tabshare_vst.node');
    // macOS runs the plugins in a separate host process (see native/vst.cpp); executables can't run from inside the asar.
    const host = fileURLToPath(new URL('./native/build/Release/tabshare_plugin_host', import.meta.url)).replace('app.asar', 'app.asar.unpacked');
    vst.init((type, slot, state) => {
      if (type === 'editorClosed') send({ type: 'vstState', slot, state });
      else if (type === 'hostExited' && rtKind === 'rig') {
        // A plugin took the host down. Stop like a crashed engine would; turning the rig on starts a new host and the
        // page loads its chain again.
        send({ type: 'error', message: 'The plugin host stopped (a plugin may have crashed). Turn the rig back on.' });
        stop();
      }
    }, host);
  } catch (e) {
    console.error('VST hosting unavailable:', e.message);
  }
  ready.then(() => (dsp.vst = vst));

  // Room audio (tabshare_net.node, optional like VST hosting): without it the page never sees netStatus.
  let net = null;
  try {
    net = new (require('./native/build/Release/tabshare_net.node').Room)();
  } catch (e) {
    console.error('Room audio unavailable:', e.message);
  }
  let netJoin = null; // { user, group, groupPassword, format } while the page is in a room
  let listen = { on: false }; // Hear the room with the rig off: { on, device, outChannel, bufferSize }
  let rtKind = null; // 'rig' | 'listen'
  let stream = { sampleRate: 48000, block: 128 };
  const netStart = () => netJoin && net.start({ ...netJoin, ...ROOM_AUDIO_SERVER, sampleRate: stream.sampleRate, blockSize: stream.block });
  const vstSlots = new Set();
  const unloadAllVst = () => {
    for (const slot of vstSlots) vst.unload(slot);
    vstSlots.clear();
    dsp.vstPre = [];
    dsp.vstPost = [];
  };
  let port = null;
  let rt = null;
  // Tuner tap: the selected input channel, dry (before gain and amp), only while the page's tuner is open.
  let tapOn = false;
  const tap = new Float32Array(1024);
  let tapLen = 0;
  const send = (m) => port?.postMessage(m); // MessagePortMain can only transfer ports, so PCM is copied

  const listDevices = () => {
    try {
      return new RtAudio(API)
        .getDevices()
        .filter((d) => d.inputChannels > 0 && d.outputChannels > 0)
        .map((d) => ({ name: d.name, inputs: d.inputChannels, outputs: d.outputChannels }));
    } catch {
      return [];
    }
  };

  const stop = () => {
    if (!rt) return;
    try {
      if (rt.isStreamRunning()) rt.stop();
      if (rt.isStreamOpen()) rt.closeStream();
    } catch {
      /* driver already gone */
    }
    rt = null;
    net?.setSending(false);
    if (rtKind === 'rig') send({ type: 'stopped' });
    rtKind = null;
  };

  const start = ({ device, outChannel = 0, bufferSize = 128 }) => {
    stop();
    const api = new RtAudio(API);
    const d = api.getDevices().find((x) => x.name === device) ?? api.getDevices().find((x) => x.inputChannels > 0 && x.outputChannels > 1);
    if (!d)
      throw new Error(
        process.platform === 'darwin'
          ? 'No audio interface with inputs and outputs found. Plug it in (or build an Aggregate Device in Audio MIDI Setup), or use the browser rig.'
          : 'No ASIO driver found. Install your interface’s ASIO driver (or ASIO4ALL), or use the browser rig.',
      );
    // Use the rate the interface is already running at, so we don't flip its clock under other apps.
    const sampleRate = d.preferredSampleRate || 48000;
    const nIn = d.inputChannels;
    const firstOut = Math.min(outChannel, Math.max(0, d.outputChannels - 2));
    // audify plays queued blocks; a reply that comes back late would queue up and add latency for good,
    // so blocks are dropped once more than one is waiting.
    let written = 0;
    let consumed = 0;
    const feed = new Float32Array(FEED_BLOCK);
    let feedLen = 0;
    let outBytes, out;
    const block = api.openStream(
      { deviceId: d.id, nChannels: 2, firstChannel: firstOut },
      { deviceId: d.id, nChannels: nIn, firstChannel: 0 },
      RtAudioFormat.RTAUDIO_FLOAT32,
      sampleRate,
      Math.min(bufferSize, MAX_BLOCK),
      'tabShare',
      (buf) => {
        const input = buf.byteOffset % 4 === 0 ? new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4) : new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
        const y = dsp.process(input, nIn, out);
        if (netJoin) net.process(y, out);
        if (written - consumed < 2) {
          api.write(outBytes);
          written++;
        }
        if (tapOn) {
          const ch = Math.min(dsp.params.channel, nIn - 1);
          for (let i = 0; i < block; i++) {
            tap[tapLen++] = input[i * nIn + ch];
            if (tapLen === tap.length) {
              send({ type: 'tap', samples: tap, sampleRate: dsp.sampleRate });
              tapLen = 0;
            }
          }
        }
        for (let i = 0; i < y.length; i++) {
          feed[feedLen++] = y[i];
          if (feedLen === FEED_BLOCK) {
            send({ type: 'pcm', samples: feed });
            feedLen = 0;
          }
        }
      },
      () => consumed++,
      0,
      (type, msg) => type > 1 && send({ type: 'error', message: `Audio driver: ${msg}` }), // 0/1 are warnings
    );
    outBytes = Buffer.alloc(block * 2 * 4);
    out = new Float32Array(outBytes.buffer, outBytes.byteOffset, block * 2);
    dsp.configure(api.getStreamSampleRate() || sampleRate, block);
    vst?.prepare(dsp.sampleRate, block);
    api.start();
    rt = api;
    rtKind = 'rig';
    stream = { sampleRate: dsp.sampleRate, block };
    netStart();
    net?.setSending(true);
    const latencyMs = ((api.getStreamLatency() + block) / dsp.sampleRate) * 1000;
    send({ type: 'started', device: d.name, sampleRate: dsp.sampleRate, bufferSize: block, latencyMs, inputs: nIn, outputs: d.outputChannels });
  };

  // Hear the room with the rig off: the same interface, output only, playing the other players' mix.
  const startListen = () => {
    const api = new RtAudio(API);
    const d = api.getDevices().find((x) => x.name === listen.device) ?? api.getDevices().find((x) => x.outputChannels > 1);
    if (!d) return;
    const sampleRate = d.preferredSampleRate || 48000;
    const firstOut = Math.min(listen.outChannel ?? 0, Math.max(0, d.outputChannels - 2));
    let outBytes, out;
    const write = () => {
      out.fill(0);
      net.process(null, out);
      api.write(outBytes);
    };
    const block = api.openStream(
      { deviceId: d.id, nChannels: 2, firstChannel: firstOut },
      null,
      RtAudioFormat.RTAUDIO_FLOAT32,
      sampleRate,
      Math.min(listen.bufferSize || 128, MAX_BLOCK),
      'tabShare room audio',
      null,
      () => rtKind === 'listen' && write(), // output-only: refill one block per block played
      0,
      (type, msg) => type > 1 && send({ type: 'error', message: `Audio driver: ${msg}` }),
    );
    outBytes = Buffer.alloc(block * 2 * 4);
    out = new Float32Array(outBytes.buffer, outBytes.byteOffset, block * 2);
    rt = api;
    rtKind = 'listen';
    stream = { sampleRate: api.getStreamSampleRate() || sampleRate, block };
    netStart();
    net.setSending(false);
    api.start();
    write();
    write();
  };
  // Open the listen stream only while someone is actually linked, so being alone in a room never grabs the interface.
  const reconcileListen = (status) => {
    const want = listen.on && netJoin && rtKind !== 'rig' && status.peers.some((p) => p.linked);
    try {
      if (want && !rtKind) startListen();
      else if (!want && rtKind === 'listen') stop();
    } catch (e) {
      if (rtKind === 'listen') stop();
      listen = { on: false };
      send({ type: 'error', message: `Room audio output: ${e instanceof Error ? e.message : e}` });
    }
  };

  const onMessage = (m) => {
    try {
      if (m.type === 'devices') send({ type: 'devices', devices: listDevices() });
      else if (m.type === 'start') start(m);
      else if (m.type === 'stop') stop();
      else if (m.type === 'params') Object.assign(dsp.params, m.params);
      else if (m.type === 'loadModel') send({ type: 'modelLoaded', ok: dsp.loadModel(m.json) });
      else if (m.type === 'unloadModel') dsp.unloadModel();
      else if (m.type === 'ir') dsp.setIr(m.samples ?? null);
      else if (m.type === 'tap') tapOn = !!m.on;
      else if (net && m.type === 'netJoin') {
        netJoin = { user: String(m.user), group: String(m.group), groupPassword: String(m.password), format: netJoin?.format ?? 1 };
        netStart();
      } else if (net && m.type === 'netLeave') {
        netJoin = null;
        net.stop();
        if (rtKind === 'listen') stop();
      } else if (net && m.type === 'netFormat') {
        if (netJoin) netJoin.format = m.index;
        net.setFormat(m.index);
      } else if (net && m.type === 'netPeer') net.setPeer(String(m.user), { gain: Number(m.gain), bufferMs: Number(m.bufferMs) || 0 });
      else if (m.type === 'listen') listen = { on: !!m.on, device: m.device, outChannel: m.outChannel, bufferSize: m.bufferSize };
      else if (m.type === 'vstList') send({ type: 'vstList', available: !!vst, plugins: vst ? vst.list() : [] });
      else if (vst && m.type === 'vstLoad') {
        // The page is remote content: only load bundles from the installed-plugin folders, never a path it made up.
        if (!vst.list().some((p) => p.path === m.path)) {
          send({ type: 'vstError', slot: m.slot, message: `Not an installed VST3 plugin: ${m.path}` });
          return;
        }
        vstSlots.add(m.slot);
        vst.load(m.slot, m.path, m.state || undefined).then(
          (name) => send({ type: 'vstLoaded', slot: m.slot, name, latency: vst.latency(m.slot) }),
          (e) => send({ type: 'vstError', slot: m.slot, message: e.message }),
        );
      } else if (vst && m.type === 'vstUnload') {
        vstSlots.delete(m.slot);
        dsp.vstPre = dsp.vstPre.filter((x) => x !== m.slot);
        dsp.vstPost = dsp.vstPost.filter((x) => x !== m.slot);
        vst.unload(m.slot);
      } else if (vst && m.type === 'vstChain') {
        dsp.vstPre = m.chain.filter((c) => !c.post).map((c) => c.slot);
        dsp.vstPost = m.chain.filter((c) => c.post).map((c) => c.slot);
      } else if (vst && m.type === 'vstEditor') vst.openEditor(m.slot);
      else if (vst && m.type === 'vstSaveAll') for (const slot of vstSlots) send({ type: 'vstState', slot, state: vst.getState(slot) });
    } catch (e) {
      if (m.type === 'start') stop();
      send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  // Room audio status for the page (also how it learns the feature exists), 4 Hz.
  setInterval(() => {
    if (!net) return;
    const status = net.status();
    reconcileListen(status);
    send({ type: 'netStatus', ...status, listening: rtKind === 'listen' });
  }, 250);

  // Input meter for the page, ~20 Hz.
  setInterval(() => {
    if (rtKind !== 'rig') return;
    send({ type: 'level', peak: dsp.peak ?? 0 });
    dsp.peak = 0;
  }, 50);

  // A new port means the page (re)loaded: whatever the old page started is orphaned, so stop it.
  process.parentPort.on('message', (e) => {
    if (e.data?.type !== 'port') return;
    stop();
    if (vst && dsp) unloadAllVst(); // the new page loads its own chain
    netJoin = null;
    listen = { on: false };
    net?.stop();
    tapOn = false;
    port = e.ports[0];
    port.on('message', (ev) => ready.then(() => onMessage(ev.data)));
    port.start();
  });
}
