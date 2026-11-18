// Records the rig's processed instrument into ideas. Chunks go to the pending store as they arrive (crash-safe), the
// joined take uploads on stop, and takes left over from earlier visits upload when the room opens.
import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_IDEA_MS } from '../../shared/protocol';
import { defaultIdeaLabel } from '../../shared/ideas';
import { UploadError, uploadIdea, type Session } from '../api';
import { addChunk, dropTake, listTakes, pendingAvailable, putTake, takeBlob, type PendingTake } from './pending';

/** MediaRecorder hands over a chunk this often (ms): at most this much is lost in a crash. */
const TIMESLICE_MS = 2000;
/** A not-done take untouched this long belongs to no live recording (crash, closed tab). */
const STALE_MS = 10_000;
const RETRY_S = [2, 5, 15, 30, 60];

export type PendingState = 'saving' | 'waiting' | 'failed';

const MIME_CHOICES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg'];

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function useRecorder(opts: { session: Session; stream: MediaStream | null; by: string; model: string | null }) {
  const { session, stream } = opts;
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [pending, setPending] = useState<{ take: PendingTake; state: PendingState }[]>([]);
  const [protectedStorage, setProtectedStorage] = useState(true);

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const rec = useRef<{ recorder: MediaRecorder; take: PendingTake; stream: MediaStream; started: number; seq: number; writes: Promise<void> } | null>(null);
  const inFlight = useRef(new Set<string>());
  const retries = useRef(new Map<string, { n: number; timer: number }>());
  const mounted = useRef(true);

  const setState = useCallback((take: PendingTake, state: PendingState | null) => {
    setPending((list) => {
      const rest = list.filter((p) => p.take.id !== take.id);
      return state ? [...rest, { take, state }] : rest;
    });
  }, []);

  const upload = useCallback(
    async (take: PendingTake) => {
      if (inFlight.current.has(take.id)) return;
      inFlight.current.add(take.id);
      const r = retries.current.get(take.id);
      if (r) clearTimeout(r.timer);
      setState(take, 'saving');
      try {
        const blob = await takeBlob(take);
        if (blob.size === 0) {
          // Nothing was captured (stopped or crashed before the first chunk).
          await dropTake(take.id);
          setState(take, null);
          return;
        }
        await uploadIdea(sessionRef.current, take, blob);
        await dropTake(take.id);
        retries.current.delete(take.id);
        setState(take, null);
      } catch (e) {
        const status = e instanceof UploadError ? e.status : 0;
        const temporary = status === 0 || status === 408 || status === 429 || status >= 500;
        if (!temporary) {
          setState(take, 'failed');
          return;
        }
        setState(take, 'waiting');
        if (!mounted.current) return;
        const n = (retries.current.get(take.id)?.n ?? 0) + 1;
        const delay = RETRY_S[Math.min(n - 1, RETRY_S.length - 1)] * 1000;
        retries.current.set(take.id, { n, timer: window.setTimeout(() => void upload(take), delay) });
      } finally {
        inFlight.current.delete(take.id);
      }
    },
    [setState],
  );

  // Takes from earlier visits (or a crash): upload them. Not-done takes still being written by another tab wait.
  const recover = useCallback(async () => {
    const takes = await listTakes(session.roomId);
    let later = false;
    for (const t of takes) {
      if (t.id === rec.current?.take.id || inFlight.current.has(t.id) || retries.current.has(t.id)) continue;
      if (!t.done && Date.now() - t.updatedAt < STALE_MS) {
        later = true;
        continue;
      }
      void upload(t);
    }
    if (later && mounted.current) window.setTimeout(() => void recover(), STALE_MS);
  }, [session.roomId, upload]);

  useEffect(() => {
    mounted.current = true;
    void pendingAvailable().then(setProtectedStorage);
    void recover();
    return () => {
      mounted.current = false;
      for (const r of retries.current.values()) clearTimeout(r.timer);
      retries.current.clear();
    };
  }, [recover]);

  const stop = useCallback(() => {
    const r = rec.current;
    if (r && r.recorder.state !== 'inactive') r.recorder.stop();
  }, []);

  const start = useCallback(() => {
    const s = optsRef.current.stream;
    if (!s || rec.current || typeof MediaRecorder === 'undefined') return;
    const mimeType = MIME_CHOICES.find((m) => MediaRecorder.isTypeSupported?.(m));
    const recorder = new MediaRecorder(s, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 128000 });
    const now = Date.now();
    const take: PendingTake = {
      id: newId(),
      roomId: sessionRef.current.roomId,
      label: defaultIdeaLabel(new Date(now)),
      tags: [],
      by: optsRef.current.by,
      model: optsRef.current.model,
      mime: mimeType ?? 'audio/webm',
      createdAt: now,
      durationMs: 0,
      done: false,
      updatedAt: now,
    };
    const state = { recorder, take, stream: s, started: performance.now(), seq: 0, writes: putTake(take) };
    rec.current = state;
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      const seq = state.seq++;
      take.durationMs = performance.now() - state.started;
      take.updatedAt = Date.now();
      if (recorder.mimeType) take.mime = recorder.mimeType;
      state.writes = state.writes.then(() => addChunk(take.id, seq, e.data)).then(() => putTake(take));
    };
    recorder.onstop = () => {
      take.durationMs = performance.now() - state.started;
      take.done = true;
      take.updatedAt = Date.now();
      for (const t of s.getTracks()) t.removeEventListener('ended', stop);
      rec.current = null;
      setRecording(false);
      setElapsedMs(0);
      // The last dataavailable fires just before stop: wait for every chunk write, then upload.
      const final = { ...take };
      void state.writes.then(() => putTake(final)).then(() => upload(final));
    };
    for (const t of s.getTracks()) t.addEventListener('ended', stop);
    recorder.start(TIMESLICE_MS);
    setRecording(true);
    setElapsedMs(0);
  }, [stop, upload]);

  // Elapsed time + the 15-minute cap.
  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => {
      const r = rec.current;
      if (!r) return;
      const ms = performance.now() - r.started;
      setElapsedMs(ms);
      if (ms >= MAX_IDEA_MS) stop();
    }, 250);
    return () => clearInterval(id);
  }, [recording, stop]);

  // The rig turned off or restarted (new stream): end the take and save it.
  useEffect(() => {
    if (rec.current && rec.current.stream !== stream) stop();
  }, [stream, stop]);

  // Leaving the room (unmount) mid-take: stop so the take saves and uploads.
  useEffect(() => () => stop(), [stop]);

  const retry = useCallback(
    (id: string) => {
      const p = pending.find((x) => x.take.id === id);
      if (p) void upload(p.take);
    },
    [pending, upload],
  );

  return {
    canRecord: !!stream && typeof MediaRecorder !== 'undefined',
    recording,
    elapsedMs,
    start,
    stop,
    pending: [...pending].sort((a, b) => b.take.createdAt - a.take.createdAt),
    retry,
    protectedStorage,
  };
}
