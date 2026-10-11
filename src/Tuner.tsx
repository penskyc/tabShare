import { useEffect, useRef, useState } from 'react';
import { closestString, noteWithOctave, TUNINGS } from '../shared/music';
import { detectPitch, nearestNote } from '../shared/pitch';
import { getAudioContext } from './rig/audioContext';
import { native } from './rig/native';
import type { RigControls } from './rig/useRig';

const N = 4096; // ~85 ms at 48 kHz: two periods of a low B on a 5-string bass
const PREF = 'tabshare.tuner';

type Reading = { midi: number; cents: number; freq: number } | null;
/** "+3", "-12", "0" (Math.round(-0.3) is -0, which would print as "-0"). */
const fmtCents = (c: number) => {
  const r = Math.round(c) || 0;
  return r > 0 ? `+${r}` : String(r);
};

function loadPref(): { inst: 'guitar' | 'bass'; idx: number } {
  try {
    return { inst: 'guitar', idx: 0, ...JSON.parse(localStorage.getItem(PREF) ?? '{}') };
  } catch {
    return { inst: 'guitar', idx: 0 };
  }
}

/**
 * Chromatic tuner. Listens to the rig's dry input when the rig is on (desktop engine tap or the browser rig's input
 * node), otherwise to the microphone / interface input.
 */
export function Tuner({ rig, onClose }: { rig: RigControls; onClose: () => void }) {
  const [pref, setPref] = useState(loadPref);
  const [reading, setReading] = useState<Reading>(null);
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [useMic, setUseMic] = useState(false);
  const tunings = TUNINGS[pref.inst];
  const strings = (tunings[pref.idx] ?? tunings[0]).notes;

  useEffect(() => {
    try {
      localStorage.setItem(PREF, JSON.stringify(pref));
    } catch {
      /* storage blocked */
    }
  }, [pref]);

  // Pick the input and expose `read()` → the latest N samples.
  useEffect(() => {
    let read: (() => { buf: Float32Array; sr: number } | null) | null = null;
    const cleanup: (() => void)[] = [];
    let cancelled = false;

    if (native && rig.on && !useMic) {
      // Desktop engine: dry samples of the selected input channel.
      const ring = new Float32Array(N);
      let filled = 0;
      let sr = 48000;
      const off = native.onMessage((m) => {
        if (m.type !== 'tap') return;
        sr = m.sampleRate;
        const s = m.samples;
        ring.copyWithin(0, s.length);
        ring.set(s, N - s.length);
        filled = Math.min(N, filled + s.length);
      });
      native.send({ type: 'tap', on: true });
      setSource(`${rig.inputId || 'interface'} · input ${rig.channel}`);
      read = () => (filled >= N ? { buf: ring, sr } : null);
      // An older desktop engine has no tap: fall back to the mic rather than showing nothing.
      const fallback = setTimeout(() => filled === 0 && setUseMic(true), 1500);
      cleanup.push(() => {
        clearTimeout(fallback);
        off();
        native!.send({ type: 'tap', on: false });
      });
    } else {
      const ctx = getAudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = N;
      const buf = new Float32Array(N);
      read = () => {
        analyser.getFloatTimeDomainData(buf);
        return { buf, sr: ctx.sampleRate };
      };
      if (rig.tapNode && !useMic) {
        rig.tapNode.connect(analyser);
        setSource(`rig input ${rig.channel}`);
        cleanup.push(() => rig.tapNode?.disconnect(analyser));
      } else {
        ctx.resume();
        navigator.mediaDevices
          ?.getUserMedia({
            audio: {
              deviceId: !native && rig.inputId ? { exact: rig.inputId } : undefined,
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          })
          .catch(() => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }))
          .then((stream) => {
            if (cancelled) return stream.getTracks().forEach((t) => t.stop());
            const src = ctx.createMediaStreamSource(stream);
            src.connect(analyser);
            setSource(stream.getAudioTracks()[0]?.label || 'microphone');
            cleanup.push(() => {
              src.disconnect();
              stream.getTracks().forEach((t) => t.stop());
            });
          })
          .catch((e) => setError(e.name === 'NotAllowedError' ? 'Microphone access was blocked.' : e.message));
      }
      cleanup.push(() => analyser.disconnect());
    }

    // Detect ~20×/s; median of the last few readings keeps the needle steady.
    const recent: number[] = [];
    let silentSince = 0;
    const timer = setInterval(() => {
      const r = read?.();
      const p = r && detectPitch(r.buf, r.sr);
      if (!p) {
        if (!silentSince) silentSince = performance.now();
        if (performance.now() - silentSince > 600) {
          recent.length = 0;
          setReading(null);
        }
        return;
      }
      silentSince = 0;
      recent.push(p.freq);
      if (recent.length > 5) recent.shift();
      const freq = [...recent].sort((a, b) => a - b)[recent.length >> 1];
      setReading({ ...nearestNote(freq), freq });
    }, 50);
    cleanup.push(() => clearInterval(timer));

    return () => {
      cancelled = true;
      cleanup.forEach((f) => f());
    };
  }, [rig.on, rig.tapNode, rig.inputId, rig.channel, useMic]);

  const inTune = reading && Math.abs(reading.cents) < 5;
  const target = reading ? closestString(reading.midi, strings) : -1;

  return (
    <div className="tuner" role="dialog" aria-label="Tuner">
      <div className="tuner-head">
        <strong>Tuner</strong>
        <span className="muted small" title="Input">{source}</span>
        <button className="btn ghost small" onClick={onClose} aria-label="Close tuner">
          ✕
        </button>
      </div>
      {error && <span className="call-error">{error}</span>}
      <div className={`tuner-note ${inTune ? 'in' : ''}`}>
        {reading ? noteWithOctave(reading.midi) : '—'}
      </div>
      <div className="tuner-scale" aria-hidden>
        <span className="tick" />
        {reading && <i className={inTune ? 'in' : ''} style={{ left: `${50 + Math.max(-50, Math.min(50, reading.cents))}%` }} />}
      </div>
      <div className="tuner-read mono small">
        {reading ? `${fmtCents(reading.cents)} cents · ${reading.freq.toFixed(1)} Hz` : 'Play a string'}
      </div>
      <div className="row gap">
        <div className="seg-mini" role="group" aria-label="Instrument">
          {(['guitar', 'bass'] as const).map((i) => (
            <button key={i} className={pref.inst === i ? 'on' : ''} onClick={() => setPref({ inst: i, idx: 0 })}>
              {i === 'guitar' ? 'Guitar' : 'Bass'}
            </button>
          ))}
        </div>
        <select className="grow" value={pref.idx} onChange={(e) => setPref({ ...pref, idx: Number(e.target.value) })} aria-label="Tuning">
          {tunings.map((t, i) => (
            <option key={t.name} value={i}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="tuner-strings">
        {strings.map((s, i) => (
          <span key={i} className={i === target ? (inTune && reading?.midi === s ? 'in' : 'target') : ''}>
            {noteWithOctave(s)}
          </span>
        ))}
      </div>
    </div>
  );
}
