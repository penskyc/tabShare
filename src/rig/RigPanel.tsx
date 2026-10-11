import { useEffect, useState } from 'react';
import type { RigControls } from './useRig';
import * as t3k from './tone3000';
import { DESKTOP_DOWNLOADS, NATIVE_DRIVER, type DesktopOs } from './native';

let configPromise: Promise<{ tone3000ClientId: string | null }> | null = null;

/** The TONE3000 tone the current model came from, with all its captures, so the user can switch between them. */
interface PickedTone {
  id: number;
  title: string;
  models: t3k.T3kModel[];
  selectedId: number;
}
const TONE_KEY = 'tabshare.rig.tone';
function readTone(): PickedTone | null {
  try {
    return JSON.parse(localStorage.getItem(TONE_KEY) ?? 'null');
  } catch {
    return null;
  }
}
function writeTone(t: PickedTone | null) {
  try {
    if (t) localStorage.setItem(TONE_KEY, JSON.stringify(t));
    else localStorage.removeItem(TONE_KEY);
  } catch {
    /* session only */
  }
}
// Downloaded capture JSON by model id, so flipping back and forth in the dropdown is instant.
const captureCache = new Map<number, string>();

const captureLabel = (m: t3k.T3kModel) => `${m.name || 'Capture'} · ${m.size}${m.architecture_version === 2 ? ' · A2' : ''}`;
const loadConfig = () => (configPromise ??= fetch('/api/config').then((r) => r.json()).catch(() => ({ tone3000ClientId: null })));

export function RigPanel({ rig, inCall }: { rig: RigControls; inCall: boolean }) {
  const [clientId, setClientId] = useState<string | null>(null);
  const [desktopDownload, setDesktopDownload] = useState<(typeof DESKTOP_DOWNLOADS)[DesktopOs] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [t3kError, setT3kError] = useState<string | null>(null);
  const [tone, setToneState] = useState<PickedTone | null>(readTone);
  const setTone = (t: PickedTone | null) => {
    setToneState(t);
    writeTone(t);
  };

  useEffect(() => {
    loadConfig().then((c) => {
      setClientId(c.tone3000ClientId);
      const os: DesktopOs | null = navigator.userAgent.includes('Windows') ? 'win' : navigator.userAgent.includes('Macintosh') ? 'mac' : null;
      setDesktopDownload(os ? DESKTOP_DOWNLOADS[os] : null);
    });
  }, []);

  const browse = async () => {
    if (!clientId) return;
    setT3kError(null);
    setBrowsing(true);
    try {
      const toneId = await t3k.selectTone(clientId);
      const [tone, models] = await Promise.all([t3k.getTone(clientId, toneId).catch(() => null), t3k.listModels(clientId, toneId)]);
      const title = tone?.title ?? `Tone ${toneId}`;
      if (!models.length) throw new Error(`"${title}" has no NAM models.`);
      await pick({ id: toneId, title, models, selectedId: models[0].id }, models[0]);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== 'canceled') setT3kError(msg);
    } finally {
      setBrowsing(false);
    }
  };

  /** Downloads (or reuses) a capture of the tone and loads it into the amp. */
  const pick = async (t: PickedTone, m: t3k.T3kModel) => {
    if (!clientId) return;
    setT3kError(null);
    setBrowsing(true);
    try {
      let json = captureCache.get(m.id);
      if (!json) {
        const data = await t3k.downloadModel(clientId, m);
        json = typeof data === 'string' ? data : JSON.stringify(data);
        captureCache.set(m.id, json);
      }
      rig.loadModel({ name: `${t.title}${m.name && m.name !== t.title ? ` · ${m.name}` : ''}`, json });
      setTone({ ...t, selectedId: m.id });
    } catch (e) {
      const msg = (e as Error).message;
      setT3kError(msg === 'Not connected to TONE3000' ? 'Your TONE3000 session expired. Click Browse TONE3000 to sign in again.' : msg);
    } finally {
      setBrowsing(false);
    }
  };

  const meterPct = Math.min(100, Math.round(rig.level * 100));

  return (
    <div className="panel rig">
      {rig.native ? (
        <p className="muted small">
          Play through a NAM amp model and send it into the call. Desktop app: your interface runs through <strong>{NATIVE_DRIVER}</strong> for
          low-latency monitoring. Use headphones.
        </p>
      ) : (
        <p className="muted small">
          Play through a NAM amp model and send it into the call. Pick your audio interface below (ASIO interfaces show up under their regular
          Windows/macOS device name). Use headphones.
          {desktopDownload && (
            <>
              {' '}
              For much lower latency, <a href={desktopDownload.url}>{desktopDownload.label}</a>.
            </>
          )}
        </p>
      )}
      {rig.native && !rig.inputs.length && (
        <span className="call-error">
          {NATIVE_DRIVER === 'ASIO'
            ? "No ASIO driver found. Install your interface's ASIO driver (or ASIO4ALL) and restart the app."
            : 'No audio interface with inputs and outputs found. Plug it in and restart the app.'}
        </span>
      )}

      {!rig.on ? (
        <button className="btn primary" onClick={rig.start}>
          🎸 Turn on rig
        </button>
      ) : (
        <button className="btn" onClick={rig.stop}>
          Turn off rig
        </button>
      )}
      {rig.error && (
        <span className="call-error" onClick={rig.clearError}>
          {rig.error} ✕
        </span>
      )}

      <section className="rig-section">
        <h4>Input</h4>
        <label>
          {rig.native ? `${NATIVE_DRIVER} device` : 'Device'}
          <select value={rig.inputId} onChange={(e) => rig.selectInput(e.target.value)}>
            {!rig.native && <option value="">Default input</option>}
            {rig.inputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Audio input'}
              </option>
            ))}
          </select>
        </label>
        <div className="row gap">
          <label className="grow">
            Channel
            <select value={rig.channel} onChange={(e) => rig.selectChannel(e.target.value)}>
              {Array.from({ length: rig.channelCount }, (_, i) => (
                <option key={i} value={String(i + 1)}>
                  Input {i + 1}
                </option>
              ))}
            </select>
          </label>
          <div className="rig-meter" title="Input level — aim for peaks in the green">
            <i style={{ width: `${meterPct}%` }} className={rig.level > 0.9 ? 'clip' : ''} />
          </div>
        </div>
        <label>
          Input gain <span className="mono small">{rig.inputDb > 0 ? '+' : ''}{rig.inputDb} dB</span>
          <input type="range" min={-24} max={24} step={1} value={rig.inputDb} onChange={(e) => rig.changeInputDb(Number(e.target.value))} />
        </label>
      </section>

      <section className="rig-section">
        <h4>Amp (NAM)</h4>
        <div className="rig-model">
          <strong>{rig.model?.name ?? 'No model (clean DI)'}</strong>
          {rig.model && <span className={`rig-status ${rig.modelStatus}`}>{rig.on ? rig.modelStatus : 'loads when the rig is on'}</span>}
        </div>
        <div className="row gap wrap">
          <label className="btn">
            Load .nam
            <input type="file" accept=".nam,application/json" hidden onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                rig.loadModelFile(f);
                setTone(null); // a local file isn't one of the tone's captures
              }
              e.target.value = '';
            }} />
          </label>
          {clientId ? (
            <button className="btn" onClick={browse} disabled={browsing}>
              {browsing ? 'TONE3000…' : 'Browse TONE3000'}
            </button>
          ) : (
            <span className="muted small" title="Set TONE3000_CLIENT_ID (a t3k_pub_… key) on the server">TONE3000 not configured</span>
          )}
          {rig.model && (
            <>
              <button className={`btn ${rig.bypass ? 'on-outline' : ''}`} onClick={() => rig.setBypass(!rig.bypass)}>
                {rig.bypass ? 'Bypassed' : 'Bypass'}
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  rig.loadModel(null);
                  setTone(null);
                }}
              >
                Remove
              </button>
            </>
          )}
        </div>
        {t3kError && <span className="call-error" onClick={() => setT3kError(null)}>{t3kError} ✕</span>}
        {tone && rig.model && (
          <label>
            Capture <span className="muted small">({tone.models.length} in “{tone.title}”)</span>
            <select
              value={tone.selectedId}
              disabled={browsing}
              onChange={(e) => {
                const m = tone.models.find((x) => x.id === Number(e.target.value));
                if (m) pick(tone, m);
              }}
            >
              {tone.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {captureLabel(m)}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      {rig.native && rig.vstAvailable && <VstSection rig={rig} />}

      <section className="rig-section">
        <h4>Cab IR</h4>
        <div className="row gap wrap">
          <span className="grow small">{rig.irName ?? <span className="muted">None (use with amp-only captures)</span>}</span>
          <label className={`btn ${rig.on ? '' : 'disabled'}`} title={rig.on ? '' : 'Turn the rig on first'}>
            Load .wav
            <input type="file" accept=".wav,audio/wav" hidden disabled={!rig.on} onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) rig.loadIrFile(f);
              e.target.value = '';
            }} />
          </label>
          {rig.irName && (
            <button className="btn ghost" onClick={rig.clearIr}>
              Clear
            </button>
          )}
        </div>
      </section>

      <section className="rig-section">
        <h4>Output</h4>
        {rig.outputSelectable && (
          <label>
            {rig.native ? 'Monitor outputs' : 'Monitor device'}
            <select value={rig.outputId} onChange={(e) => rig.selectOutput(e.target.value)}>
              {!rig.native && <option value="">Default output</option>}
              {rig.outputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Audio output'}
                </option>
              ))}
            </select>
          </label>
        )}
        {rig.native && (
          <label>
            Buffer size <span className="muted small">(smaller = lower latency; raise it if you hear crackles)</span>
            <select value={rig.bufferSize} onChange={(e) => rig.changeBufferSize(Number(e.target.value))}>
              {[32, 64, 128, 256, 512].map((n) => (
                <option key={n} value={n}>
                  {n} samples
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Output level <span className="mono small">{rig.outputDb > 0 ? '+' : ''}{rig.outputDb} dB</span>
          <input type="range" min={-40} max={12} step={1} value={rig.outputDb} onChange={(e) => rig.changeOutputDb(Number(e.target.value))} />
        </label>
        <label className="check">
          <input type="checkbox" checked={rig.monitor} onChange={rig.toggleMonitor} /> Hear myself (monitor)
        </label>
        <label className="check">
          <input type="checkbox" checked={rig.sendToCall} onChange={rig.toggleSend} /> Send to call {!inCall && <span className="muted small">(join the call to be heard)</span>}
        </label>
        {rig.on && rig.latencyMs != null && (
          <span className="muted small">
            {rig.native
              ? `Round-trip latency ≈ ${rig.latencyMs} ms (${NATIVE_DRIVER}, as reported by the driver).`
              : `Browser output latency ≈ ${rig.latencyMs} ms (plus your interface's input latency).`}
          </span>
        )}
      </section>
    </div>
  );
}

/** Desktop app: VST3 plugins before the amp or after the cab, each with its own window. */
function VstSection({ rig }: { rig: RigControls }) {
  const [pick, setPick] = useState('');
  const q = pick.trim().toLowerCase();
  const match = q ? (rig.vstPlugins.find((p) => p.name.toLowerCase() === q) ?? rig.vstPlugins.find((p) => p.name.toLowerCase().includes(q))) : undefined;
  return (
    <section className="rig-section">
      <h4>Plugins (VST3)</h4>
      {rig.vstChain.length === 0 && <span className="muted small">None. Add pedals, amp sims or effects from your VST3 folder.</span>}
      <ul className="vst-chain">
        {rig.vstChain.map((v, i) => (
          <li key={v.slot} className={v.bypass ? 'bypassed' : ''}>
            <button
              className={`vst-power ${v.bypass ? '' : 'on'}`}
              onClick={() => rig.toggleVstBypass(v.slot)}
              aria-pressed={!v.bypass}
              aria-label={`${v.bypass ? 'Turn on' : 'Bypass'} ${v.name}`}
              title={v.bypass ? 'Off (bypassed): click to turn on' : 'On: click to bypass'}
            >
              ⏻
            </button>
            <div className="grow">
              <strong>{v.name}</strong>
              <span className="muted small"> {rig.on ? (rig.vstStatus[v.slot] ?? '') : 'loads when the rig is on'}</span>
            </div>
            <button className="btn small" onClick={() => rig.toggleVstPost(v.slot)} title="Where in the chain this plugin runs">
              {v.post ? 'After amp' : 'Before amp'}
            </button>
            <button className="btn small" onClick={() => rig.openVstEditor(v.slot)} disabled={!rig.on} title="Open the plugin's window">
              Edit
            </button>
            <button className="btn ghost small" onClick={() => rig.moveVst(v.slot, -1)} disabled={i === 0} aria-label={`Move ${v.name} up`}>
              ↑
            </button>
            <button className="btn ghost small" onClick={() => rig.removeVst(v.slot)} aria-label={`Remove ${v.name}`}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <form
        className="row gap"
        onSubmit={(e) => {
          e.preventDefault();
          if (!match || rig.vstChain.length >= 16) return;
          rig.addVst(match.path);
          setPick('');
        }}
      >
        {/* Typing filters the datalist live; Enter adds the exact name, or else the first plugin containing the text. */}
        <input className="grow" list="vst-plugins" value={pick} onChange={(e) => setPick(e.target.value)} placeholder="Search plugins…" aria-label="VST3 plugin" />
        <datalist id="vst-plugins">
          {rig.vstPlugins.map((p) => (
            <option key={p.path} value={p.name} />
          ))}
        </datalist>
        <button className="btn" disabled={!match || rig.vstChain.length >= 16}>
          Add
        </button>
      </form>
    </section>
  );
}
