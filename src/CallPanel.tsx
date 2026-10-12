import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallState } from '../shared/protocol';
import type { Profile } from './api';
import type { CallControls } from './useCall';
import { CallPip, CallStage, useChildWindow, type StageTile } from './CallWindow';
import { native } from './rig/native';

type DocPip = { requestWindow(opts: { width: number; height: number }): Promise<Window> };
const docPip = (window as unknown as { documentPictureInPicture?: DocPip }).documentPictureInPicture;
// The iOS app's web view can't open windows (pop-out, desktop PiP); WebKit's own video PiP stops once the app is left.
const desktopApp = !!native && native.platform !== 'ios';

let sharedCtx: AudioContext | null = null;
const audioCtx = () => (sharedCtx ??= new AudioContext());

/** True while the track's level is above `threshold` RMS (with a short hang time). */
function useActive(track: MediaStreamTrack | null | undefined, enabled: boolean, threshold: number) {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!track || !enabled) {
      setSpeaking(false);
      return;
    }
    const ctx = audioCtx();
    ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let on = false;
    let lastLoud = 0;
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      const now = performance.now();
      if (Math.sqrt(sum / buf.length) > threshold) lastLoud = now;
      const next = now - lastLoud < 350;
      if (next !== on) setSpeaking((on = next));
    }, 100);
    return () => {
      clearInterval(timer);
      src.disconnect();
    };
  }, [track, enabled, threshold]);
  return speaking;
}

interface TileProps {
  stream: MediaStream | null;
  name: string;
  color: string;
  state: CallState;
  self?: boolean;
  /** Their voice and instrument tracks, for the activity lights (instrument null: not sending one). */
  voice: MediaStreamTrack | null;
  instrument: MediaStreamTrack | null;
  pinned: boolean;
  onPin: () => void;
}

function Tile({ stream, name, color, state, self, voice, instrument, pinned, onPin }: TileProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const speaking = useActive(voice, state.mic, 0.035);
  const playing = useActive(instrument, true, 0.02);
  const showVideo = state.cam || state.screen;

  // Video only: call audio plays through the mix (callAudio.ts).
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream && new MediaStream(stream.getVideoTracks());
  }, [stream]);

  return (
    <div
      className={`tile ${speaking ? 'speaking' : ''} ${pinned ? 'pinned' : ''}`}
      style={{ ['--c' as string]: color }}
      onClick={onPin}
      title={pinned ? 'Click to shrink' : 'Click to enlarge'}
    >
      <video ref={ref} autoPlay playsInline muted className={self && !state.screen ? 'mirror' : ''} hidden={!showVideo} />
      {!showVideo && <div className="tile-avatar">{name.slice(0, 1).toUpperCase()}</div>}
      <div className="tile-label">
        {!state.mic && <span title="Muted">🔇</span>} {name}
        {state.screen && <span className="muted"> · screen</span>}
      </div>
      {/* Lights up while audio actually arrives on that track: is their voice / instrument coming through? */}
      <div className="tile-meters">
        <span className={speaking ? 'on' : ''} title={speaking ? 'Voice coming through' : 'No voice signal'}>
          🎤
        </span>
        {instrument && (
          <span className={playing ? 'on' : ''} title={playing ? 'Instrument coming through' : 'No instrument signal'}>
            🎸
          </span>
        )}
      </div>
    </div>
  );
}

export function CallPanel({ call, profile }: { call: CallControls; profile: Profile }) {
  const [pinned, setPinned] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const others = call.peersInCall;
  const sinkSupported = 'setSinkId' in AudioContext.prototype;
  const [mixOpen, setMixOpen] = useState(false);
  const [popout, setPopout] = useState(false);
  const [pip, setPip] = useState(false);
  const pipDismissed = useRef(false);

  const stageTiles: StageTile[] = [
    { id: 'self', stream: call.localStream, name: `${profile.name} (you)`, color: profile.color, state: { mic: call.mic, cam: call.cam, screen: call.screen }, self: true },
    ...others.map((p) => ({ id: p.clientId, stream: call.remoteStreams[p.clientId] ?? null, name: p.name, color: p.color, state: p.call!, self: false })),
  ];
  // PiP shows one person: whoever has video on (screen share first), else the first person in the call.
  const remote = stageTiles.filter((t) => !t.self);
  const pipTile = remote.find((t) => t.state.screen) ?? remote.find((t) => t.state.cam) ?? remote[0];

  const openPopout = useCallback(() => window.open('', 'tabshare-call', 'popup,width=1100,height=680'), []);
  // Desktop: a window main.js makes borderless, always on top, bottom-right. Browser: Chrome's Document PiP.
  const openPip = useCallback(
    () => (desktopApp ? window.open('', 'tabshare-pip', 'popup,width=360,height=203') : docPip ? docPip.requestWindow({ width: 360, height: 203 }) : null),
    [],
  );
  const closePip = useCallback(() => {
    pipDismissed.current = true;
    setPip(false);
  }, []);
  useChildWindow(
    call.inCall && popout ? openPopout : null,
    <CallStage tiles={stageTiles} mic={call.mic} cam={call.cam} onToggleMic={call.toggleMic} onToggleCam={call.toggleCam} onClose={() => setPopout(false)} />,
    () => setPopout(false),
  );
  useChildWindow(call.inCall && pip && !popout ? openPip : null, <CallPip tile={pipTile} onClose={closePip} />, () => setPip(false));

  // Desktop: pop the PiP when tabShare loses focus (switching apps), close it when you come back.
  const hasOthers = others.length > 0;
  useEffect(() => {
    if (!desktopApp || !call.inCall || !hasOthers) return setPip(false);
    const onFocus = () => {
      pipDismissed.current = false;
      setPip(false);
    };
    if (native!.onAppFocus) return native!.onAppFocus((focused) => (focused ? onFocus() : !pipDismissed.current && setPip(true)));
    // Older desktop builds: the page's own blur (focus moving into an iframe, like the YouTube player, isn't leaving).
    const onBlur = () =>
      setTimeout(() => {
        if (!document.hasFocus() && !pipDismissed.current) setPip(true);
      }, 150);
    addEventListener('blur', onBlur);
    addEventListener('focus', onFocus);
    return () => {
      removeEventListener('blur', onBlur);
      removeEventListener('focus', onFocus);
    };
  }, [call.inCall, hasOthers]);

  // Browser: Chrome's automatic picture-in-picture for video calls (it fires on tab switch, like Google Meet).
  useEffect(() => {
    if (native || !docPip || !call.inCall || !navigator.mediaSession) return;
    try {
      navigator.mediaSession.setActionHandler('enterpictureinpicture' as MediaSessionAction, () => setPip(true));
    } catch {
      return; // this Chrome doesn't know the action
    }
    return () => {
      try {
        navigator.mediaSession.setActionHandler('enterpictureinpicture' as MediaSessionAction, null);
      } catch {
        /* ignore */
      }
    };
  }, [call.inCall]);

  if (!call.inCall) {
    if (!others.length && !call.error) return null;
    return (
      <div className="call-invite">
        {others.length > 0 && (
          <span>
            📹 {others.map((p) => p.name).join(', ')} {others.length === 1 ? 'is' : 'are'} in the call
          </span>
        )}
        {call.error && <span className="call-error">{call.error}</span>}
        <button className="btn primary" onClick={call.join}>
          Join call
        </button>
      </div>
    );
  }

  const tiles = [
    {
      id: 'self',
      stream: call.localStream,
      voice: call.localStream?.getAudioTracks()[0] ?? null,
      instrument: call.localInstrument,
      name: `${profile.name} (you)`,
      color: profile.color,
      state: { mic: call.mic, cam: call.cam, screen: call.screen },
      self: true,
    },
    ...others.map((p) => ({
      id: p.clientId,
      stream: call.remoteStreams[p.clientId] ?? null,
      voice: call.remoteParts[p.clientId]?.voice ?? null,
      instrument: call.remoteParts[p.clientId]?.instrument ?? null,
      name: p.name,
      color: p.color,
      state: p.call!,
      self: false,
    })),
  ].sort((a, b) => Number(b.id === pinned) - Number(a.id === pinned));

  return (
    <div className="call-panel">
      <div className="tiles">
        {tiles.map((t) => (
          <Tile key={t.id} {...t} pinned={t.id === pinned} onPin={() => setPinned(pinned === t.id ? null : t.id)} />
        ))}
      </div>
      <div className="call-controls">
        <button className={`call-btn ${call.mic ? '' : 'off'}`} onClick={call.toggleMic} title={call.mic ? 'Mute' : 'Unmute'}>
          {call.mic ? '🎤' : '🔇'} <span>{call.mic ? 'Mute' : 'Unmute'}</span>
        </button>
        <button className={`call-btn ${call.cam ? '' : 'off'}`} onClick={call.toggleCam} title={call.cam ? 'Stop video' : 'Start video'}>
          📷 <span>{call.cam ? 'Stop video' : 'Start video'}</span>
        </button>
        {(desktopApp || !native) && (
          <button className={`call-btn ${popout ? 'on' : ''}`} onClick={() => setPopout(!popout)} title="Open the video in its own window (split screen, full screen)">
            ⧉ <span>Pop out</span>
          </button>
        )}
        {!native && docPip && hasOthers && (
          <button className={`call-btn ${pip ? 'on' : ''}`} onClick={() => (pip ? closePip() : ((pipDismissed.current = false), setPip(true)))} title="Floating picture-in-picture window">
            ▣ <span>PiP</span>
          </button>
        )}
        {'getDisplayMedia' in navigator.mediaDevices && (
          <button className={`call-btn ${call.screen ? 'on' : ''}`} onClick={call.toggleScreen} title="Share screen">
            🖥 <span>{call.screen ? 'Stop share' : 'Share'}</span>
          </button>
        )}
        {hasOthers && (
          <button className={`call-btn ${mixOpen ? 'on' : ''}`} onClick={() => setMixOpen(!mixOpen)} title="Each person's voice and instrument volume">
            🎚 <span>Mix</span>
          </button>
        )}
        <div className="call-settings-wrap">
          <button className={`call-btn ${settings ? 'on' : ''}`} onClick={() => setSettings(!settings)} title="Devices & audio">
            ⚙ <span>Settings</span>
          </button>
          {settings && (
            <div className="call-settings">
              <label>
                Microphone
                <select value={call.micId} onChange={(e) => call.selectMic(e.target.value)}>
                  <option value="">Default</option>
                  {call.devices.mics.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || 'Microphone'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Camera
                <select value={call.camId} onChange={(e) => call.selectCam(e.target.value)}>
                  <option value="">Default</option>
                  {call.devices.cams.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || 'Camera'}
                    </option>
                  ))}
                </select>
              </label>
              {sinkSupported && (
                <label>
                  Speaker
                  <select value={call.speakerId} onChange={(e) => call.selectSpeaker(e.target.value)}>
                    <option value="">Default</option>
                    {call.devices.speakers.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || 'Speaker'}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="check">
                <input type="checkbox" checked={call.originalSound} onChange={call.toggleOriginalSound} />
                <span>
                  Original sound <span className="muted small">— for instruments: no noise suppression/echo cancel. Use headphones.</span>
                </span>
              </label>
            </div>
          )}
        </div>
        <button className="call-btn leave" onClick={call.leave}>
          Leave call
        </button>
        {call.error && (
          <span className="call-error" onClick={call.clearError}>
            {call.error} ✕
          </span>
        )}
      </div>
      {mixOpen && hasOthers && (
        <div className="call-mix">
          {others.map((p) => {
            const levels = call.levelsFor(p.name);
            return (
              <div className="call-mix-row" key={p.clientId}>
                <span className="call-mix-name" style={{ color: p.color }}>
                  {p.name}
                </span>
                {(['voice', 'instrument'] as const).map((part) => (
                  <label key={part} className="call-mix-level" title="Double-click for 100%">
                    <span>{part === 'voice' ? '🎤 Voice' : '🎸 Instrument'}</span>
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={0.05}
                      value={levels[part]}
                      aria-label={`${p.name} ${part} volume`}
                      onChange={(e) => call.setLevel(p.name, part, Number(e.target.value))}
                      onDoubleClick={() => call.setLevel(p.name, part, 1)}
                    />
                    <span className="call-mix-pct">{Math.round(levels[part] * 100)}%</span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
