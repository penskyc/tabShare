// AudioWorklet processor running Neural Amp Modeler (WASM). Mono in → mono out.
// Bundled separately by Vite (`?worker&url`) and loaded with audioWorklet.addModule().
import { createNamModule, NamWasmModule } from '@opendaw/nam-wasm';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

type Msg = { type: 'init'; wasm: ArrayBuffer } | { type: 'loadModel'; json: string } | { type: 'unloadModel' } | { type: 'bypass'; value: boolean };

class NamProcessor extends AudioWorkletProcessor {
  private nam: NamWasmModule | null = null;
  private id = -1;
  private bypass = false;
  private pendingModel: string | null = null;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Msg>) => this.onMessage(e.data);
  }

  private async onMessage(m: Msg) {
    if (m.type === 'init') {
      try {
        // locateFile stops Emscripten calling `new URL(..., import.meta.url)`: URL doesn't exist in
        // AudioWorkletGlobalScope. The bytes come from wasmBinary, so the path is never fetched.
        const module = await createNamModule({ wasmBinary: m.wasm, locateFile: (path) => path });
        this.nam = NamWasmModule.fromModule(module);
        this.nam.setSampleRate(sampleRate);
        this.id = this.nam.createInstance();
        this.port.postMessage({ type: 'ready' });
        if (this.pendingModel) this.load(this.pendingModel);
      } catch (err) {
        this.port.postMessage({ type: 'error', message: String(err) });
      }
    } else if (m.type === 'loadModel') {
      if (this.nam) this.load(m.json);
      else this.pendingModel = m.json;
    } else if (m.type === 'unloadModel') {
      this.pendingModel = null;
      this.nam?.unloadModel(this.id);
    } else if (m.type === 'bypass') {
      this.bypass = m.value;
    }
  }

  private load(json: string) {
    this.pendingModel = null;
    const ok = this.nam!.loadModel(this.id, json);
    const loudness = ok && this.nam!.hasModelLoudness(this.id) ? this.nam!.getModelLoudness(this.id) : null;
    this.port.postMessage({ type: 'modelLoaded', ok, loudness });
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }
    if (this.bypass || !this.nam || !this.nam.hasModel(this.id)) output.set(input);
    else this.nam.process(this.id, input, output);
    return true;
  }
}

registerProcessor('nam-processor', NamProcessor);
