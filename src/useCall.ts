import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallState, Peer } from '../shared/protocol';
import type { RoomConnection } from './useRoom';
import { CallAudio, DEFAULT_LEVELS, loadMix, mixKey, saveMix, type MixLevels, type MixPart } from './callAudio';

// shortcut: STUN only — peers behind strict/symmetric NAT can't connect; add a TURN server (e.g. coturn) to ICE_SERVERS if that happens.
const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

type Signal = { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };

interface Conn {
  pc: RTCPeerConnection;
  pending: RTCIceCandidateInit[];
}

export interface Devices {
  mics: MediaDeviceInfo[];
  cams: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
}

const pref = (k: string) => {
  try {
    return localStorage.getItem(`tabshare.${k}`) ?? '';
  } catch {
    return '';
  }
};
const savePref = (k: string, v: string) => {
  try {
    localStorage.setItem(`tabshare.${k}`, v);
  } catch {
    /* per-session only */
  }
};

export const callSupported = () => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

/**
 * Mesh WebRTC call over the room WebSocket. The peer with the lower clientId always offers, so there's
 * no glare; each connection has three transceivers in a fixed order — voice, instrument, video — and every media
 * change (mute, camera, device switch, screen share, rig on/off) is a replaceTrack — no renegotiation.
 */
const NO_IDS = new Set<string>();

export function useCall(
  room: RoomConnection,
  instrumentStream: MediaStream | null = null,
  voiceStream: MediaStream | null = null,
  /** Desktop app: people whose instrument you already hear through room audio (their call instrument is skipped). */
  directIds: Set<string> = NO_IDS,
) {
  const [inCall, setInCall] = useState(false);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [screen, setScreen] = useState(false);
  const [originalSound, setOriginalSound] = useState(pref('originalSound') === '1');
  const [micId, setMicId] = useState(pref('micId'));
  const [camId, setCamId] = useState(pref('camId'));
  const [speakerId, setSpeakerId] = useState(pref('speakerId'));
  const [devices, setDevices] = useState<Devices>({ mics: [], cams: [], speakers: [] });
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  // Per peer: voice + video (tiles, speaking ring) and the instrument (only played, through the mix).
  const [remote, setRemote] = useState<Record<string, { stream: MediaStream; voice: MediaStreamTrack | null; instrument: MediaStreamTrack | null }>>({});
  const [mix, setMix] = useState(loadMix);
  const callAudio = useRef<CallAudio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnectTick, setReconnectTick] = useState(0);

  const conns = useRef(new Map<string, Conn>());
  const micTrack = useRef<MediaStreamTrack | null>(null);
  // Voice and instrument go out as separate tracks (receivers set their volumes independently; mute only disables the
  // voice, and the instrument skips voice processing).
  const instrumentRef = useRef(instrumentStream);
  instrumentRef.current = instrumentStream;
  /** What a transceiver sends: by kind, and for audio by position (first = voice, second = instrument). */
  const outTrack = (pc: RTCPeerConnection, t: RTCRtpTransceiver) => {
    if (t.receiver.track.kind === 'video') return screenTrack.current ?? camTrack.current;
    const audio = pc.getTransceivers().filter((x) => x.receiver.track.kind === 'audio');
    return audio.indexOf(t) === 1 ? (instrumentRef.current?.getAudioTracks()[0] ?? null) : micTrack.current;
  };
  // iOS app with the rig on: the voice comes from the interface via the rig (iOS has one input device), so it stands in
  // for the mic, and WebKit's own mic capture is released so it doesn't fight the native engine for the hardware.
  const voiceRef = useRef(voiceStream);
  voiceRef.current = voiceStream;
  const rigVoiceTrack = () => voiceRef.current?.getAudioTracks()[0]?.clone() ?? null;
  const camTrack = useRef<MediaStreamTrack | null>(null);
  const screenTrack = useRef<MediaStreamTrack | null>(null);
  const roomRef = useRef(room);
  roomRef.current = room;

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    setDevices({
      mics: all.filter((d) => d.kind === 'audioinput'),
      cams: all.filter((d) => d.kind === 'videoinput'),
      speakers: all.filter((d) => d.kind === 'audiooutput'),
    });
  }, []);

  useEffect(() => {
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);

  /** Pushes the current local tracks to every connection and refreshes the self-view. */
  const syncTracks = useCallback(() => {
    const video = screenTrack.current ?? camTrack.current;
    for (const { pc } of conns.current.values()) {
      for (const t of pc.getTransceivers()) t.sender.replaceTrack(outTrack(pc, t)).catch(() => {});
    }
    setLocalStream(new MediaStream([micTrack.current, video].filter((t): t is MediaStreamTrack => !!t)));
  }, []);

  const audioConstraints = useCallback(
    (deviceId: string, original: boolean): MediaTrackConstraints => ({
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: !original,
      noiseSuppression: !original,
      autoGainControl: !original,
    }),
    [],
  );
  const videoConstraints = (deviceId: string): MediaTrackConstraints => ({
    deviceId: deviceId ? { exact: deviceId } : undefined,
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 24 },
  });

  const announce = useCallback((state: CallState | null) => roomRef.current.setPresence({ call: state }), []);

  // ---------- peer connections ----------

  const closeConn = useCallback((peerId: string) => {
    conns.current.get(peerId)?.pc.close();
    conns.current.delete(peerId);
    setRemote((s) => {
      if (!s[peerId]) return s;
      const next = { ...s };
      delete next[peerId];
      return next;
    });
  }, []);

  const makeConn = useCallback(
    (peerId: string, initiator: boolean) => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const conn: Conn = { pc, pending: [] };
      conns.current.set(peerId, conn);
      pc.onicecandidate = (e) => e.candidate && roomRef.current.sendRtc(peerId, { candidate: e.candidate.toJSON() } satisfies Signal);
      pc.ontrack = () => {
        const all = pc.getTransceivers();
        const [voice = null, instrument = null] = all.filter((t) => t.receiver.track.kind === 'audio').map((t) => t.receiver.track);
        const video = all.find((t) => t.receiver.track.kind === 'video')?.receiver.track;
        const stream = new MediaStream([voice, video].filter((t): t is MediaStreamTrack => !!t));
        setRemote((s) => ({ ...s, [peerId]: { stream, voice, instrument } }));
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          // Opus defaults to ~32 kbps: more for the voice, music quality for the instrument.
          pc.getTransceivers()
            .filter((t) => t.receiver.track.kind === 'audio')
            .forEach((t, i) => {
              const params = t.sender.getParameters();
              if (!params.encodings?.length) return;
              params.encodings[0].maxBitrate = i === 1 ? 128_000 : 64_000;
              t.sender.setParameters(params).catch(() => {});
            });
        }
        if (pc.connectionState === 'failed') {
          closeConn(peerId);
          setReconnectTick((n) => n + 1); // the effect below re-creates it
        }
      };
      if (initiator) {
        const video = screenTrack.current ?? camTrack.current;
        pc.addTransceiver(micTrack.current ?? 'audio', { direction: 'sendrecv' });
        pc.addTransceiver(instrumentRef.current?.getAudioTracks()[0] ?? 'audio', { direction: 'sendrecv' });
        pc.addTransceiver(video ?? 'video', { direction: 'sendrecv' });
        pc.createOffer()
          .then((offer) => pc.setLocalDescription(offer))
          .then(() => roomRef.current.sendRtc(peerId, { sdp: pc.localDescription!.toJSON() } satisfies Signal))
          .catch((e) => console.warn('offer failed', e));
        // The offer can race the other side subscribing to signaling; retry if it's never answered.
        setTimeout(() => {
          if (conns.current.get(peerId)?.pc === pc && pc.signalingState === 'have-local-offer') {
            closeConn(peerId);
            setReconnectTick((n) => n + 1);
          }
        }, 6000);
      }
      return conn;
    },
    [closeConn],
  );

  const flush = async (conn: Conn) => {
    for (const c of conn.pending.splice(0)) await conn.pc.addIceCandidate(c).catch(() => {});
  };

  // Incoming signaling.
  useEffect(() => {
    if (!inCall) return;
    return room.onRtc(async (from, raw) => {
      const data = raw as Signal;
      try {
        if (data.sdp?.type === 'offer') {
          closeConn(from); // a new offer always means a fresh connection from the initiator
          const conn = makeConn(from, false);
          await conn.pc.setRemoteDescription(data.sdp);
          for (const t of conn.pc.getTransceivers()) {
            t.direction = 'sendrecv';
            await t.sender.replaceTrack(outTrack(conn.pc, t));
          }
          await conn.pc.setLocalDescription(await conn.pc.createAnswer());
          room.sendRtc(from, { sdp: conn.pc.localDescription!.toJSON() } satisfies Signal);
          await flush(conn);
        } else if (data.sdp?.type === 'answer') {
          const conn = conns.current.get(from);
          if (!conn) return;
          await conn.pc.setRemoteDescription(data.sdp);
          await flush(conn);
        } else if (data.candidate) {
          const conn = conns.current.get(from);
          if (!conn) return;
          if (conn.pc.remoteDescription) await conn.pc.addIceCandidate(data.candidate).catch(() => {});
          else conn.pending.push(data.candidate);
        }
      } catch (e) {
        console.warn('signaling error', e);
      }
    });
  }, [inCall, room.onRtc, room.sendRtc, makeConn, closeConn]);

  // Keep one connection per peer that's in the call; the lower clientId offers.
  const peersInCall = Object.values(room.peers).filter((p) => p.call);
  const peerKey = peersInCall.map((p) => p.clientId).sort().join(',');
  useEffect(() => {
    if (!inCall || !room.clientId) return;
    const wanted = new Set(peersInCall.map((p) => p.clientId));
    for (const id of [...conns.current.keys()]) if (!wanted.has(id)) closeConn(id);
    for (const id of wanted) {
      if (!conns.current.has(id) && room.clientId < id) makeConn(id, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inCall, peerKey, room.clientId, reconnectTick]);

  // ---------- local media controls ----------

  const join = useCallback(async () => {
    setError(null);
    if (!callSupported()) {
      setError('Calls need HTTPS (or localhost). Open tabShare through its https:// address.');
      return;
    }
    // Created inside the click, so autoplay rules let it play.
    callAudio.current ??= new CallAudio();
    callAudio.current.resume();
    callAudio.current.setSink(speakerId);
    try {
      const rigVoice = rigVoiceTrack();
      const audio = rigVoice ? false : audioConstraints(micId, originalSound);
      const fallbackAudio = rigVoice ? false : audioConstraints('', originalSound);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio,
        video: videoConstraints(camId),
      }).catch((e) => {
        // Saved device unplugged, or no camera: fall back to defaults / audio only.
        if (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') {
          return navigator.mediaDevices.getUserMedia({ audio: fallbackAudio, video: true }).catch(() =>
            fallbackAudio ? navigator.mediaDevices.getUserMedia({ audio: fallbackAudio }) : new MediaStream(),
          );
        }
        throw e;
      });
      micTrack.current = rigVoice ?? stream.getAudioTracks()[0] ?? null;
      camTrack.current = stream.getVideoTracks()[0] ?? null;
      const hasCam = !!camTrack.current;
      setMic(true);
      setCam(hasCam);
      setScreen(false);
      setInCall(true);
      syncTracks();
      announce({ mic: true, cam: hasCam, screen: false });
      refreshDevices(); // labels are only visible after permission is granted
    } catch (e) {
      const err = e as DOMException;
      setError(err.name === 'NotAllowedError' ? 'Microphone/camera permission was blocked. Allow it in the address bar and try again.' : err.message);
    }
  }, [micId, camId, speakerId, originalSound, audioConstraints, syncTracks, announce, refreshDevices]);

  const leave = useCallback(() => {
    for (const id of [...conns.current.keys()]) closeConn(id);
    for (const t of [micTrack, camTrack, screenTrack]) {
      t.current?.stop();
      t.current = null;
    }
    callAudio.current?.close();
    callAudio.current = null;
    setLocalStream(null);
    setInCall(false);
    setScreen(false);
    announce(null);
  }, [closeConn, announce]);

  // Leave cleanly when the room unmounts.
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useEffect(() => () => leaveRef.current(), []);

  const state = (patch: Partial<CallState>): CallState => ({ mic, cam, screen, ...patch });

  const toggleMic = () => {
    const next = !mic;
    if (micTrack.current) micTrack.current.enabled = next;
    setMic(next);
    announce(state({ mic: next }));
  };

  const toggleCam = async () => {
    if (cam) {
      camTrack.current?.stop(); // release the camera (light off), not just disable it
      camTrack.current = null;
      setCam(false);
      syncTracks();
      announce(state({ cam: false }));
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(camId) });
      camTrack.current = s.getVideoTracks()[0];
      setCam(true);
      syncTracks();
      announce(state({ cam: true }));
    } catch (e) {
      setError(`Camera unavailable: ${(e as Error).message}`);
    }
  };

  const stopShare = useCallback(() => {
    screenTrack.current?.stop();
    screenTrack.current = null;
    setScreen(false);
    syncTracks();
  }, [syncTracks]);

  const toggleScreen = async () => {
    if (screen) {
      stopShare();
      announce(state({ screen: false }));
      return;
    }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
      const track = s.getVideoTracks()[0];
      track.onended = () => {
        stopShare();
        roomRef.current.setPresence({ call: { mic: micTrack.current?.enabled ?? false, cam: !!camTrack.current, screen: false } });
      };
      screenTrack.current = track;
      setScreen(true);
      syncTracks();
      announce(state({ screen: true }));
    } catch {
      /* user cancelled the picker */
    }
  };

  const restartMic = async (deviceId: string, original: boolean) => {
    if (!inCall || voiceRef.current) return; // the rig's voice input is in use (iOS app)
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceId, original) });
      micTrack.current?.stop();
      micTrack.current = s.getAudioTracks()[0];
      micTrack.current.enabled = mic;
      syncTracks();
    } catch (e) {
      setError(`Microphone unavailable: ${(e as Error).message}`);
    }
  };

  // iOS app: the rig turned on or off mid-call; swap between its voice input and the regular mic.
  useEffect(() => {
    if (!inCall) return;
    const rigVoice = rigVoiceTrack();
    if (!rigVoice) {
      restartMic(micId, originalSound);
      return;
    }
    micTrack.current?.stop();
    micTrack.current = rigVoice;
    rigVoice.enabled = mic;
    syncTracks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceStream]);

  // The rig turned on or off (or restarted): send its new track.
  useEffect(() => {
    if (inCall) syncTracks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrumentStream]);

  // Play everyone through the mix; levels follow the person's name.
  const levelsFor = useCallback((name: string): MixLevels => ({ ...DEFAULT_LEVELS, ...mix[mixKey(name)] }), [mix]);
  const peerNames = Object.values(room.peers).map((p) => `${p.clientId}=${p.name}`).join(',');
  useEffect(() => {
    const audio = callAudio.current;
    if (!audio) return;
    for (const [id, r] of Object.entries(remote)) {
      const levels = levelsFor(room.peers[id]?.name ?? '');
      audio.play(id, 'voice', r.voice, levels.voice);
      audio.play(id, 'instrument', r.instrument, directIds.has(id) ? 0 : levels.instrument);
    }
    audio.keepOnly(Object.keys(remote));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, levelsFor, peerNames, directIds]);
  const setLevel = (name: string, part: MixPart, value: number) =>
    setMix((m) => {
      const next = { ...m, [mixKey(name)]: { ...levelsFor(name), [part]: value } };
      saveMix(next);
      return next;
    });

  const selectMic = (id: string) => {
    setMicId(id);
    savePref('micId', id);
    restartMic(id, originalSound);
  };

  const selectCam = async (id: string) => {
    setCamId(id);
    savePref('camId', id);
    if (!inCall || !cam) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(id) });
      camTrack.current?.stop();
      camTrack.current = s.getVideoTracks()[0];
      syncTracks();
    } catch (e) {
      setError(`Camera unavailable: ${(e as Error).message}`);
    }
  };

  const selectSpeaker = (id: string) => {
    setSpeakerId(id);
    savePref('speakerId', id);
    callAudio.current?.setSink(id);
  };

  const toggleOriginalSound = () => {
    const next = !originalSound;
    setOriginalSound(next);
    savePref('originalSound', next ? '1' : '');
    restartMic(micId, next);
  };

  return {
    inCall,
    mic,
    cam,
    screen,
    originalSound,
    micId,
    camId,
    speakerId,
    devices,
    localStream,
    remoteStreams: Object.fromEntries(Object.entries(remote).map(([id, r]) => [id, r.stream])),
    remoteParts: remote as Record<string, { voice: MediaStreamTrack | null; instrument: MediaStreamTrack | null }>,
    localInstrument: instrumentStream?.getAudioTracks()[0] ?? null,
    levelsFor,
    setLevel,
    peersInCall: peersInCall as Peer[],
    error,
    clearError: () => setError(null),
    join,
    leave,
    toggleMic,
    toggleCam,
    toggleScreen,
    selectMic,
    selectCam,
    selectSpeaker,
    toggleOriginalSound,
  };
}

export type CallControls = ReturnType<typeof useCall>;
