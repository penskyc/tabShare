// Room audio (desktop app 0.4+): the engine joins the room's SonoBus group, sends your rig to the other desktop apps
// and plays theirs with low latency, separate from the call. This hook drives it and holds the per-person mix.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RoomConnection } from '../useRoom';
import { clientIdOfAudioUser, native, type RoomAudioPeer, type RoomAudioStatus } from './native';
import type { RigControls } from './useRig';

const PREF = 'tabshare.rig.native.';
const MIX_KEY = 'tabshare.roomAudio';

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: still works for this session */
  }
}

/** Per person, by name (clientIds change on every visit): volume 0–2, jitter buffer ms (0 = automatic). */
export interface PersonMix {
  gain: number;
  bufferMs: number;
}
const DEFAULT_MIX: PersonMix = { gain: 1, bufferMs: 0 };

export interface RoomAudioRow extends RoomAudioPeer {
  clientId: string | null;
  name: string;
  mix: PersonMix;
}

export function useRoomAudio(room: RoomConnection, rig: RigControls) {
  const [status, setStatus] = useState<RoomAudioStatus | null>(null);
  const [format, setFormatState] = useState(() => Number(read(PREF + 'netFormat') ?? 1));
  const [hearRoom, setHearRoomState] = useState(() => read(PREF + 'hearRoom') !== '0');
  const [mix, setMix] = useState<Record<string, PersonMix>>(() => {
    try {
      return JSON.parse(read(MIX_KEY) || '{}');
    } catch {
      return {};
    }
  });
  const available = !!status;

  useEffect(() => native?.onMessage((m) => m.type === 'netStatus' && setStatus(m)), []);

  // One audio user per visit: unique on the shared server, and the clientId tells the page who it is.
  const user = useMemo(() => (room.clientId ? `ts-${room.clientId}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}` : null), [room.clientId]);
  const group = room.audio?.group;
  const password = room.audio?.password;
  const engineOff = status?.state === 'off';
  useEffect(() => {
    if (!native || !available || !group || !password || !user) return;
    native.send({ type: 'netJoin', user, group, password });
    native.send({ type: 'netFormat', index: format });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, group, password, user, engineOff]); // engineOff: a restarted engine forgot the room, join again
  useEffect(() => () => native?.send({ type: 'netLeave' }), []);

  useEffect(() => {
    if (!native || !available) return;
    native.send({ type: 'listen', on: hearRoom, device: rig.inputId, outChannel: Number(rig.outputId) || 0, bufferSize: rig.bufferSize });
  }, [available, hearRoom, rig.inputId, rig.outputId, rig.bufferSize]);

  const rows: RoomAudioRow[] = useMemo(
    () =>
      (status?.peers ?? []).map((p) => {
        const clientId = clientIdOfAudioUser(p.user);
        const name = (clientId && room.peers[clientId]?.name) || 'Someone';
        return { ...p, clientId, name, mix: { ...DEFAULT_MIX, ...mix[name] } };
      }),
    [status, room.peers, mix],
  );

  // Apply everyone's saved volume/buffer when they link and when it changes.
  const mixKey = rows.map((r) => `${r.user}=${r.mix.gain}/${r.mix.bufferMs}`).join(',');
  useEffect(() => {
    if (!native) return;
    for (const r of rows) native.send({ type: 'netPeer', user: r.user, gain: r.mix.gain, bufferMs: r.mix.bufferMs });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mixKey]);

  const setPersonMix = useCallback((name: string, patch: Partial<PersonMix>) => {
    setMix((m) => {
      const next = { ...m, [name]: { ...DEFAULT_MIX, ...m[name], ...patch } };
      write(MIX_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const setFormat = (index: number) => {
    setFormatState(index);
    write(PREF + 'netFormat', String(index));
    native?.send({ type: 'netFormat', index });
  };
  const setHearRoom = (on: boolean) => {
    setHearRoomState(on);
    write(PREF + 'hearRoom', on ? '1' : '0');
  };

  /** Members you hear directly: their call instrument is skipped so nothing plays twice. */
  const linkedClientIds = useMemo(
    () => new Set(rows.filter((r) => r.linked && r.clientId).map((r) => r.clientId!)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows.map((r) => `${r.clientId}:${r.linked}`).join(',')],
  );
  const failedNames = (status?.failed ?? []).map((u) => room.peers[clientIdOfAudioUser(u) ?? '']?.name).filter((n): n is string => !!n);

  return { available, status, rows, failedNames, format, setFormat, hearRoom, setHearRoom, setPersonMix, linkedClientIds };
}

export type RoomAudioControls = ReturnType<typeof useRoomAudio>;
