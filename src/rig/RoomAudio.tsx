// Rig panel section: low-latency instrument audio between the desktop apps in the room (SonoBus networking).
import { ROOM_AUDIO_FORMATS } from './native';
import type { RoomAudioControls, RoomAudioRow } from './useRoomAudio';

const STATE_TEXT = { off: 'Off', connecting: 'Connecting…', connected: 'Connected', error: 'Not connected' } as const;

export function RoomAudioSection({ ra, rigOn }: { ra: RoomAudioControls; rigOn: boolean }) {
  const s = ra.status!;
  return (
    <section className="rig-section room-audio">
      <h4>Room audio</h4>
      <span className="muted small">
        Desktop apps in this room hear each other's instruments directly, with low latency (SonoBus's networking), whether
        or not you're in the call. {rigOn ? 'Your rig is being sent.' : 'Turn on your rig to be heard.'}
      </span>
      <span className={`ra-state ${s.state}`}>
        {STATE_TEXT[s.state]}
        {s.error && s.state === 'error' ? `: ${s.error}` : ''}
        {s.listening && ' · playing through your interface'}
      </span>
      <label className="check" title="With your rig off, open your interface for output only while someone is playing">
        <input type="checkbox" checked={ra.hearRoom} onChange={(e) => ra.setHearRoom(e.target.checked)} /> Hear the room
        while my rig is off
      </label>
      <label>
        Send format
        <select value={ra.format} onChange={(e) => ra.setFormat(Number(e.target.value))}>
          {ROOM_AUDIO_FORMATS.map((f, i) => (
            <option key={f} value={i}>
              {f}
              {i === 1 ? ' (default)' : i >= 2 ? ' (uncompressed, more upload)' : ''}
            </option>
          ))}
        </select>
      </label>
      {ra.rows.length === 0 && ra.failedNames.length === 0 && (
        <span className="muted small">No one else here with the desktop app yet.</span>
      )}
      <ul className="ra-peers">
        {ra.rows.map((r) => (
          <PeerRow key={r.user} r={r} ra={ra} />
        ))}
        {ra.failedNames.map((n) => (
          <li key={n} className="ra-peer failed">
            <strong>{n}</strong> <span className="muted small">couldn't connect directly; you hear them through the call</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PeerRow({ r, ra }: { r: RoomAudioRow; ra: RoomAudioControls }) {
  const status = !r.linked ? 'connecting…' : r.muted ? 'settling…' : r.receiving ? 'playing' : 'linked';
  return (
    <li className="ra-peer">
      <div className="row gap">
        <span className={`ra-dot ${r.level > 0.01 ? 'on' : ''}`} aria-hidden />
        <strong className="grow">{r.name}</strong>
        <span className="muted small">
          {status}
          {r.latencyMs >= 0 && ` · ≈ ${Math.round(r.latencyMs)} ms`}
          {r.drops > 0 && ` · ${r.drops} dropouts`}
        </span>
      </div>
      <label className="row gap small">
        Volume
        <input
          className="grow"
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={r.mix.gain}
          onChange={(e) => ra.setPersonMix(r.name, { gain: Number(e.target.value) })}
          onDoubleClick={() => ra.setPersonMix(r.name, { gain: 1 })}
          aria-label={`${r.name} volume`}
        />
        <span className="mono">{Math.round(r.mix.gain * 100)}%</span>
      </label>
      <div className="row gap small">
        <label className="check" title="Grows when the connection drops audio, shrinks when it's clean">
          <input type="checkbox" checked={r.mix.bufferMs === 0} onChange={(e) => ra.setPersonMix(r.name, { bufferMs: e.target.checked ? 0 : Math.max(1, Math.round(r.bufferMs)) })} />{' '}
          Auto buffer
        </label>
        {r.mix.bufferMs === 0 ? (
          <span className="muted mono">{r.bufferMs.toFixed(1)} ms</span>
        ) : (
          <>
            <input
              className="grow"
              type="range"
              min={1}
              max={100}
              step={1}
              value={r.mix.bufferMs}
              onChange={(e) => ra.setPersonMix(r.name, { bufferMs: Number(e.target.value) })}
              aria-label={`${r.name} jitter buffer`}
            />
            <span className="mono">{r.mix.bufferMs} ms</span>
          </>
        )}
      </div>
    </li>
  );
}
