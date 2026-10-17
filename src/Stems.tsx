import { useRef, useState } from 'react';
import { AUDIO_EXTENSIONS, MAX_AUDIO_BYTES, STEM_NAMES, type StemName, type TabMeta } from '../shared/protocol';
import { deleteStems, startStems, type Session } from './api';

const LABELS: Record<StemName, string> = { vocals: 'Vocals', drums: 'Drums', bass: 'Bass', guitar: 'Guitar', piano: 'Piano', other: 'Other' };

/** Makes, shows the progress of, and removes a tab's stems (in the Stems box). Everyone in the room sees the progress. */
export function StemsPanel({ session, tab }: { session: Session; tab: TabMeta }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const s = tab.stems;
  const working = s?.status === 'queued' || s?.status === 'running';

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const upload = (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_AUDIO_BYTES) return setError('That file is over 100 MB.');
    void run(() => startStems(session, tab.id, f));
  };
  const remove = () => window.confirm('Remove the stems of this tab?') && void run(() => deleteStems(session, tab.id));

  if (s?.status === 'ready') {
    return (
      <div className="stems-panel row gap">
        <span className="small muted">
          {s.names.length} stems from {s.from === 'youtube' ? (s.videoId === tab.youtube?.videoId ? 'the YouTube video' : 'an earlier YouTube video') : 'an uploaded file'}
        </span>
        <button className="btn ghost small" onClick={remove} disabled={busy}>
          Remove
        </button>
      </div>
    );
  }

  return (
    <div className="stems-panel">
      {working ? (
        <>
          <p className="small">
            Separating… <span className="muted">{s.stage}</span>
          </p>
          <progress max={1} value={s.progress ?? 0} />
          <p className="muted small">Takes a few minutes. Everyone in the room can keep playing; the stems appear for all when ready.</p>
          <button className="btn ghost small" onClick={remove} disabled={busy}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <p className="muted small">
            Split the original recording into vocals, drums, bass, guitar, piano and other, so you can mute and solo them. It
            takes a few minutes, once per tab.
          </p>
          {s?.status === 'error' && <p className="call-error">Couldn't make stems: {s.error}</p>}
          <div className="row gap">
            <button
              className="btn primary"
              disabled={busy || !tab.youtube}
              title={tab.youtube ? '' : 'Link a YouTube video in Original first'}
              onClick={() => void run(() => startStems(session, tab.id))}
            >
              From the YouTube video
            </button>
            <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
              Upload audio…
            </button>
            <input
              ref={fileRef}
              type="file"
              hidden
              accept={AUDIO_EXTENSIONS.map((e) => `.${e}`).join(',')}
              onChange={(e) => (upload(e.target.files?.[0]), (e.target.value = ''))}
            />
          </div>
          {!tab.youtube && <p className="muted small">No YouTube video is linked to this tab: link one in Original, or upload a file.</p>}
        </>
      )}
      {error && <p className="call-error">{error}</p>}
    </div>
  );
}

interface MixerProps {
  names: StemName[];
  muted: Set<number>;
  soloed: Set<number>;
  volumes: number[];
  onMute: (i: number) => void;
  onSolo: (i: number) => void;
  onVolume: (i: number, v: number) => void;
}

/** Mute / solo / volume per stem, in the Tracks panel. Indexes are into STEM_NAMES (that's what the mix shares). */
export function StemMixer({ names, muted, soloed, volumes, onMute, onSolo, onVolume }: MixerProps) {
  return (
    <ul className="track-list stem-list">
      {names.map((name) => {
        const i = STEM_NAMES.indexOf(name);
        return (
          <li key={name}>
            <span className="track-name">{LABELS[name]}</span>
            <button className={`ms ${muted.has(i) ? 'on' : ''}`} onClick={() => onMute(i)} title="Mute">
              M
            </button>
            <button className={`ms solo ${soloed.has(i) ? 'on' : ''}`} onClick={() => onSolo(i)} title="Solo">
              S
            </button>
            <label className="track-vol" title="Stem volume (double-click to reset)">
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={volumes[i] ?? 1}
                aria-label={`${LABELS[name]} volume`}
                onChange={(e) => onVolume(i, Number(e.target.value))}
                onDoubleClick={() => onVolume(i, 1)}
              />
              <span className="mono small">{Math.round((volumes[i] ?? 1) * 100)}%</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
