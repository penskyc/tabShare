import { useCallback, useEffect, useRef, useState } from 'react';
import processorUrl from './nam-processor.ts?worker&url';
import wasmUrl from '@opendaw/nam-wasm/nam.wasm?url';
import feedUrl from './pcm-feed.ts?worker&url';
import { contextSinkSupported, getAudioContext } from './audioContext';
import { native, normalizeIr, type NativeDevice, type NativeFromEngine, type VstEntry } from './native';

const pref = (k: string) => {
  try {
    return localStorage.getItem(`tabshare.rig.${k}`) ?? '';
  } catch {
    return '';
  }
};
const savePref = (k: string, v: string) => {
  try {
    if (v) localStorage.setItem(`tabshare.rig.${k}`, v);
    else localStorage.removeItem(`tabshare.rig.${k}`);
  } catch {
    /* model too big for storage, or storage blocked: keep it for this session only */
  }
};

const dbToGain = (db: number) => Math.pow(10, db / 20);

export interface RigModel {
  name: string;
  json: string;
}

/** 1-based input channel number, as a string. */
type Channel = string;
type Device = { deviceId: string; label: string };
// Device picks differ between the browser (MediaDevices) and the desktop app (ASIO drivers), so they're stored apart.
const devKey = (k: string) => (native ? `native.${k}` : k);

/**
 * Instrument rig: audio interface input → channel pick → input gain → NAM (AudioWorklet/WASM) → cab IR →
 * output gain → local monitor and a MediaStream that the call mixes in.
 * Inside the desktop app the same chain runs in the native ASIO engine instead (see native.ts); the page then only
 * sends it settings and plays its processed signal into the call.
 */
export function useRig() {
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Device[]>([]);
  const [outputs, setOutputs] = useState<Device[]>([]);
  const [inputId, setInputId] = useState(pref(devKey('inputId')));
  const [channel, setChannel] = useState<Channel>(pref(devKey('channel')) || '1');
  // iOS app: which interface input carries your voice into the call while the rig is on ('' = none).
  const [voiceChannel, setVoiceChannel] = useState<Channel>(pref('native.voiceChannel'));
  const [outputId, setOutputId] = useState(pref(devKey('outputId')));
  const [nativeDevices, setNativeDevices] = useState<NativeDevice[]>([]);
  const [bufferSize, setBufferSize] = useState(Number(pref('native.bufferSize')) || 128);
  const [vstAvailable, setVstAvailable] = useState(false);
  const [vstPlugins, setVstPlugins] = useState<{ name: string; path: string }[]>([]);
  const [vstChain, setVstChain] = useState<VstEntry[]>(() => {
    try {
      return JSON.parse(pref('native.vst') || '[]');
    } catch {
      return [];
    }
  });
  const [vstStatus, setVstStatus] = useState<Record<number, string>>({});
  const [inputDb, setInputDb] = useState(Number(pref('inputDb')) || 0);
  const [outputDb, setOutputDb] = useState(pref('outputDb') ? Number(pref('outputDb')) : -6);
  const [monitor, setMonitor] = useState(pref('monitor') !== '0');
  const [sendToCall, setSendToCall] = useState(pref('send') !== '0');
  const [bypass, setBypass] = useState(false);
  const [model, setModel] = useState<RigModel | null>(() => {
    const name = pref('modelName');
    const json = pref('modelJson');
    return name && json ? { name, json } : null;
  });
  const [modelStatus, setModelStatus] = useState<'none' | 'loading' | 'ok' | 'error'>('none');
  const [irName, setIrName] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [instrumentStream, setInstrumentStream] = useState<MediaStream | null>(null);

  const nodes = useRef<{
    stream: MediaStream;
    src: MediaStreamAudioSourceNode;
    splitter: ChannelSplitterNode;
    inGain: GainNode;
    nam: AudioWorkletNode;
    convolver: ConvolverNode;
    outGain: GainNode;
    monitorGain: GainNode;
    send: MediaStreamAudioDestinationNode;
    meter: AnalyserNode;
  } | null>(null);
  const workletLoaded = useRef(false);
  const wasmBytes = useRef<ArrayBuffer | null>(null);
  // Desktop app only: the call feed fed by the engine, its sample rate, and the IR file (re-sent on every engine start).
  const feed = useRef<{ ctx: AudioContext; node: AudioWorkletNode; voice: AudioWorkletNode | null } | null>(null);
  const [voiceStream, setVoiceStream] = useState<MediaStream | null>(null);
  const engineRate = useRef(48000);
  const irBytes = useRef<ArrayBuffer | null>(null);

  const nativeDev = nativeDevices.find((d) => d.name === inputId) ?? nativeDevices.find((d) => d.inputs > 0) ?? nativeDevices[0];
  // Windows: only the picked driver gets loaded (to learn its channels), never the whole list.
  useEffect(() => {
    if (native && nativeDev?.probed === false) native.send({ type: 'devices', probe: nativeDev.name });
  }, [nativeDev?.name, nativeDev?.probed]);

  const refreshDevices = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    setInputs(all.filter((d) => d.kind === 'audioinput'));
    setOutputs(all.filter((d) => d.kind === 'audiooutput'));
  }, []);

  useEffect(() => {
    if (native || !navigator.mediaDevices) return;
    refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
  }, [refreshDevices]);

  const openInput = async (deviceId: string) =>
    navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // A guitar is not a voice: all browser voice processing off, both channels kept.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
        latency: { ideal: 0 },
      } as MediaTrackConstraints,
    });

  /** Connects the chosen input channel into the chain. */
  const routeChannel = (n: NonNullable<typeof nodes.current>, ch: Channel) => {
    n.splitter.disconnect();
    // A mono device only has channel 0; fall back to it for "input 2".
    const idx = ch === '2' && n.src.channelCount > 1 ? 1 : 0;
    n.splitter.connect(n.inGain, idx);
  };

  const start = useCallback(async () => {
    setError(null);
    if (native) {
      native.send({ type: 'start', device: nativeDev?.name ?? '', outChannel: Number(outputId) || 0, bufferSize });
      return; // the engine answers with 'started' or 'error'
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError('The rig needs HTTPS (or localhost).');
      return;
    }
    try {
      const ctx = getAudioContext();
      await ctx.resume();
      if (!workletLoaded.current) {
        await ctx.audioWorklet.addModule(processorUrl);
        workletLoaded.current = true;
      }
      wasmBytes.current ??= await (await fetch(wasmUrl)).arrayBuffer();

      const stream = await openInput(inputId).catch((e) => {
        if (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') return openInput('');
        throw e;
      });
      const src = ctx.createMediaStreamSource(stream);
      const splitter = ctx.createChannelSplitter(2);
      const inGain = ctx.createGain();
      const nam = new AudioWorkletNode(ctx, 'nam-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
      const convolver = ctx.createConvolver();
      const outGain = ctx.createGain();
      const monitorGain = ctx.createGain();
      const send = ctx.createMediaStreamDestination();
      const meter = ctx.createAnalyser();
      meter.fftSize = 1024;

      nam.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'modelLoaded') setModelStatus(m.ok ? 'ok' : 'error');
        if (m.type === 'error') setError(`Amp engine failed to start: ${m.message}`);
      };
      nam.port.postMessage({ type: 'init', wasm: wasmBytes.current.slice(0) });

      src.connect(splitter);
      inGain.connect(meter);
      inGain.connect(nam);
      nam.connect(outGain); // convolver is spliced in when an IR is loaded
      outGain.connect(monitorGain).connect(ctx.destination);
      outGain.connect(send);

      const n = { stream, src, splitter, inGain, nam, convolver, outGain, monitorGain, send, meter };
      nodes.current = n;
      routeChannel(n, channel);
      inGain.gain.value = dbToGain(inputDb);
      outGain.gain.value = dbToGain(outputDb);
      monitorGain.gain.value = monitor ? 1 : 0;
      if (outputId && contextSinkSupported()) await (ctx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(outputId).catch(() => {});
      setLatencyMs(Math.round(((ctx.baseLatency ?? 0) + ((ctx as AudioContext).outputLatency ?? 0)) * 1000));
      setInstrumentStream(send.stream);
      setOn(true);
      refreshDevices(); // device labels appear after permission
    } catch (e) {
      const err = e as DOMException;
      setError(err.name === 'NotAllowedError' ? 'Audio input permission was blocked.' : err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputId, channel, inputDb, outputDb, monitor, outputId, refreshDevices, nativeDev, bufferSize]);

  /** Desktop app: the engine stopped (or was told to), so drop the call feed. */
  const engineOff = useCallback(() => {
    feed.current?.ctx.close();
    feed.current = null;
    setInstrumentStream(null);
    setVoiceStream(null);
    setOn(false);
    setLevel(0);
  }, []);

  const stop = useCallback(() => {
    if (native) {
      native.send({ type: 'vstSaveAll' }); // plugin settings come back as vstState before the engine stops
      native.send({ type: 'stop' });
      engineOff();
      return;
    }
    const n = nodes.current;
    if (!n) return;
    n.stream.getTracks().forEach((t) => t.stop());
    for (const node of [n.src, n.splitter, n.inGain, n.nam, n.convolver, n.outGain, n.monitorGain, n.meter]) node.disconnect();
    nodes.current = null;
    setInstrumentStream(null);
    setOn(false);
    setLevel(0);
  }, [engineOff]);

  useEffect(() => () => stop(), [stop]);

  // Send the current model to the engine whenever it (or the engine) changes.
  useEffect(() => {
    const port = nodes.current?.nam.port;
    const post = native ? native.send : port && ((m: object) => port.postMessage(m));
    if (!post || !on) return;
    if (model) {
      setModelStatus('loading');
      post({ type: 'loadModel', json: model.json });
    } else {
      post({ type: 'unloadModel' });
      setModelStatus('none');
    }
  }, [model, on]);

  // ---------- desktop app engine ----------

  const sendIr = async (bytes: ArrayBuffer, sampleRate: number) => {
    const buffer = await new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(bytes.slice(0)); // resampled to the engine rate
    native!.send({ type: 'ir', samples: normalizeIr(buffer.getChannelData(0), sampleRate) });
  };

  const onEngineStarted = async (m: Extract<NativeFromEngine, { type: 'started' }>) => {
    engineRate.current = m.sampleRate;
    setLatencyMs(Math.round(m.latencyMs * 10) / 10);
    setBufferSize(m.bufferSize); // the driver may insist on its own size
    // The processed signal comes back as PCM; play it into a MediaStream at the engine's rate for the call.
    const ctx = new AudioContext({ sampleRate: m.sampleRate });
    await ctx.audioWorklet.addModule(feedUrl);
    const node = new AudioWorkletNode(ctx, 'pcm-feed', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    // iOS app: the voice input arrives the same way and becomes the call's mic (see useCall), since iOS can't use the
    // built-in mic while the interface is the input. Silent when no voice input is picked.
    let voice: AudioWorkletNode | null = null;
    if (native?.platform === 'ios') {
      voice = new AudioWorkletNode(ctx, 'pcm-feed', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      const voiceDest = ctx.createMediaStreamDestination();
      voice.connect(voiceDest);
      setVoiceStream(voiceDest.stream);
    }
    feed.current?.ctx.close();
    feed.current = { ctx, node, voice };
    setInstrumentStream(dest.stream);
    setOn(true);
    // Plugins are (re)loaded on every start with their saved settings, so a restarted engine comes back the same.
    for (const v of vstChainRef.current) {
      setVstStatus((st) => ({ ...st, [v.slot]: 'loading' }));
      native!.send({ type: 'vstLoad', slot: v.slot, path: v.path, state: v.state });
    }
    if (irBytes.current) await sendIr(irBytes.current, m.sampleRate).catch(() => {});
  };
  const vstChainRef = useRef(vstChain);
  vstChainRef.current = vstChain;
  const saveChain = (chain: VstEntry[]) => {
    vstChainRef.current = chain;
    setVstChain(chain);
    savePref('native.vst', chain.length ? JSON.stringify(chain) : '');
  };
  const onEngineStartedRef = useRef(onEngineStarted);
  onEngineStartedRef.current = onEngineStarted;

  useEffect(() => {
    if (!native) return;
    const off = native.onMessage((m) => {
      if (m.type === 'devices') setNativeDevices(m.devices);
      else if (m.type === 'started') onEngineStartedRef.current(m).catch((e) => setError(`Call feed: ${(e as Error).message}`));
      else if (m.type === 'stopped') engineOff();
      else if (m.type === 'error') setError(m.message);
      else if (m.type === 'modelLoaded') setModelStatus(m.ok ? 'ok' : 'error');
      else if (m.type === 'level') setLevel(m.peak);
      else if (m.type === 'pcm') feed.current?.node.port.postMessage(m.samples, [m.samples.buffer]);
      else if (m.type === 'voice') feed.current?.voice?.port.postMessage(m.samples, [m.samples.buffer]);
      else if (m.type === 'vstList') {
        setVstAvailable(m.available);
        setVstPlugins(m.plugins);
      } else if (m.type === 'vstLoaded') setVstStatus((st) => ({ ...st, [m.slot]: m.latency ? `ok · ${m.latency} smp` : 'ok' }));
      else if (m.type === 'vstError') setVstStatus((st) => ({ ...st, [m.slot]: `error: ${m.message}` }));
      else if (m.type === 'vstState') saveChainRef.current(vstChainRef.current.map((v) => (v.slot === m.slot ? { ...v, state: m.state } : v)));
    });
    native.send({ type: 'devices' });
    native.send({ type: 'vstList' });
    return off;
  }, [engineOff]);

  const saveChainRef = useRef(saveChain);
  saveChainRef.current = saveChain;

  // The plugin order/positions go to the engine whenever they change (loads finish asynchronously; empty slots pass through).
  useEffect(() => {
    // Bypassed plugins are simply left out of the chain: still loaded, so switching them back on is instant.
    if (native && on) native.send({ type: 'vstChain', chain: vstChain.filter((v) => !v.bypass).map(({ slot, post }) => ({ slot, post })) });
  }, [vstChain, on]);

  const addVst = (path: string) => {
    const used = new Set(vstChain.map((v) => v.slot));
    const slot = Array.from({ length: 16 }, (_, i) => i).find((i) => !used.has(i));
    const plugin = vstPlugins.find((p) => p.path === path);
    if (slot == null || !plugin) return;
    saveChain([...vstChain, { slot, path, name: plugin.name, post: false }]);
    if (on) {
      setVstStatus((st) => ({ ...st, [slot]: 'loading' }));
      native!.send({ type: 'vstLoad', slot, path });
    }
  };
  const removeVst = (slot: number) => {
    native!.send({ type: 'vstUnload', slot });
    saveChain(vstChain.filter((v) => v.slot !== slot));
  };
  const toggleVstPost = (slot: number) => saveChain(vstChain.map((v) => (v.slot === slot ? { ...v, post: !v.post } : v)));
  const toggleVstBypass = (slot: number) => saveChain(vstChain.map((v) => (v.slot === slot ? { ...v, bypass: !v.bypass } : v)));
  const moveVst = (slot: number, dir: -1 | 1) => {
    const i = vstChain.findIndex((v) => v.slot === slot);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= vstChain.length) return;
    const next = [...vstChain];
    [next[i], next[j]] = [next[j], next[i]];
    saveChain(next);
  };
  const openVstEditor = (slot: number) => native!.send({ type: 'vstEditor', slot });

  // All the knobs go to the engine as one message.
  useEffect(() => {
    if (!native || !on) return;
    native.send({
      type: 'params',
      params: { channel: Number(channel) - 1, inGain: dbToGain(inputDb), outGain: dbToGain(outputDb), monitor, bypass, voiceChannel: Number(voiceChannel || 0) - 1 },
    });
  }, [on, channel, inputDb, outputDb, monitor, bypass, voiceChannel]);

  useEffect(() => {
    nodes.current?.nam.port.postMessage({ type: 'bypass', value: bypass });
  }, [bypass, on]);

  // Input level meter (peak, 0..1). The desktop engine sends its own.
  useEffect(() => {
    if (!on || native) return;
    const buf = new Float32Array(1024);
    const timer = setInterval(() => {
      const m = nodes.current?.meter;
      if (!m) return;
      m.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      setLevel(peak);
    }, 60);
    return () => clearInterval(timer);
  }, [on]);

  // ---------- controls ----------

  const restart = () => {
    if (!on) return;
    stop();
    // Restart with the new device on the next tick so state has settled.
    setTimeout(() => startRef.current(), 0);
  };

  const selectInput = async (id: string) => {
    setInputId(id);
    savePref(devKey('inputId'), id);
    restart();
  };
  const startRef = useRef(start);
  startRef.current = start;

  const selectChannel = (ch: Channel) => {
    setChannel(ch);
    savePref(devKey('channel'), ch);
    if (nodes.current) routeChannel(nodes.current, ch);
  };

  const selectOutput = async (id: string) => {
    setOutputId(id);
    savePref(devKey('outputId'), id);
    if (native) restart(); // ASIO output channels are fixed when the stream opens
    else if (on && contextSinkSupported()) {
      await (getAudioContext() as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(id).catch((e) => setError(`Output device: ${e.message}`));
    }
  };

  const changeBufferSize = (size: number) => {
    setBufferSize(size);
    savePref('native.bufferSize', String(size));
    restart();
  };

  const changeInputDb = (db: number) => {
    setInputDb(db);
    savePref('inputDb', String(db));
    if (nodes.current) nodes.current.inGain.gain.value = dbToGain(db);
  };
  const changeOutputDb = (db: number) => {
    setOutputDb(db);
    savePref('outputDb', String(db));
    if (nodes.current) nodes.current.outGain.gain.value = dbToGain(db);
  };
  const toggleMonitor = () => {
    const next = !monitor;
    setMonitor(next);
    savePref('monitor', next ? '1' : '0');
    if (nodes.current) nodes.current.monitorGain.gain.value = next ? 1 : 0;
  };
  const toggleSend = () => {
    const next = !sendToCall;
    setSendToCall(next);
    savePref('send', next ? '1' : '0');
  };

  const loadModel = (m: RigModel | null) => {
    setModel(m);
    savePref('modelName', m?.name ?? '');
    savePref('modelJson', m?.json ?? '');
  };

  const loadModelFile = async (file: File) => {
    const json = await file.text();
    try {
      JSON.parse(json);
    } catch {
      setError(`${file.name} isn't a valid .nam file.`);
      return;
    }
    loadModel({ name: file.name.replace(/\.nam$/i, ''), json });
  };

  const loadIrFile = async (file: File) => {
    if (native) {
      try {
        const bytes = await file.arrayBuffer();
        await sendIr(bytes, engineRate.current);
        irBytes.current = bytes;
        setIrName(file.name.replace(/\.wav$/i, ''));
      } catch {
        setError(`Couldn't read ${file.name} as an impulse response (.wav).`);
      }
      return;
    }
    const n = nodes.current;
    if (!n) return;
    try {
      const buffer = await getAudioContext().decodeAudioData(await file.arrayBuffer());
      n.convolver.buffer = buffer;
      n.nam.disconnect();
      n.nam.connect(n.convolver).connect(n.outGain);
      setIrName(file.name.replace(/\.wav$/i, ''));
    } catch {
      setError(`Couldn't read ${file.name} as an impulse response (.wav).`);
    }
  };

  const clearIr = () => {
    if (native) {
      irBytes.current = null;
      native.send({ type: 'ir', samples: null });
      setIrName(null);
      return;
    }
    const n = nodes.current;
    if (!n) return;
    n.nam.disconnect();
    n.convolver.disconnect();
    n.nam.connect(n.outGain);
    setIrName(null);
  };

  return {
    on,
    error,
    clearError: () => setError(null),
    /** Browser rig only: the selected input channel (after input gain, before the amp), for the tuner. */
    tapNode: on && !native ? (nodes.current?.inGain ?? null) : null,
    /** True inside the desktop app (native ASIO engine). */
    native: !!native,
    inputs: native ? nativeDevices.map((d) => ({ deviceId: d.name, label: d.probed && !d.inputs ? `${d.name} (not connected)` : d.name })) : inputs,
    outputs: native
      ? Array.from({ length: Math.floor((nativeDev?.outputs ?? 2) / 2) }, (_, i) => ({ deviceId: String(i * 2), label: `Out ${i * 2 + 1}/${i * 2 + 2}` }))
      : outputs,
    inputId: native ? (nativeDev?.name ?? '') : inputId,
    channel,
    channelCount: native ? (nativeDev?.inputs ?? 2) : 2,
    outputId: native ? outputId || '0' : outputId,
    bufferSize,
    vstAvailable,
    vstPlugins,
    vstChain,
    vstStatus,
    addVst,
    removeVst,
    toggleVstPost,
    toggleVstBypass,
    moveVst,
    openVstEditor,
    inputDb,
    outputDb,
    monitor,
    sendToCall,
    bypass,
    model,
    modelStatus,
    irName,
    level,
    latencyMs,
    /** Processed instrument signal for the call (null when the rig is off or not sending). */
    callStream: sendToCall ? instrumentStream : null,
    /** iOS app with the rig on: replaces the mic in the call (null otherwise). */
    voiceStream,
    /** iOS app: the voice input picker applies (iOS uses one input device, so voice comes from the interface). */
    voiceSupported: native?.platform === 'ios',
    voiceChannel,
    selectVoiceChannel: (ch: Channel) => {
      setVoiceChannel(ch);
      savePref('native.voiceChannel', ch);
    },
    start,
    stop,
    selectInput,
    selectChannel,
    selectOutput,
    changeBufferSize,
    changeInputDb,
    changeOutputDb,
    toggleMonitor,
    toggleSend,
    setBypass,
    loadModel,
    loadModelFile,
    loadIrFile,
    clearIr,
    outputSelectable: !!native || contextSinkSupported(),
  };
}

export type RigControls = ReturnType<typeof useRig>;
