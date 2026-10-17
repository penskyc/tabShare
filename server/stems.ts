// Stems of a tab's original recording, made by a StemDeck sidecar (github.com/stemdeckapp/stemdeck, pinned version:
// its HTTP API is the one its own web app uses, not a stable interface). StemDeck queues jobs itself; we submit, poll
// every tab that has a job, copy the finished stems next to the tab file and delete the job on StemDeck's side.
import fs from 'node:fs';
import path from 'node:path';
import { STEM_NAMES, type StemName, type TabMeta, type TabStems } from '../shared/protocol.js';
import { FILES_DIR, listRooms, saveSoon, type StoredRoom } from './store.js';

const base = () => (process.env.STEMDECK_URL ?? '').replace(/\/+$/, '');
export const stemsEnabled = () => !!base();

const POLL_MS = Number(process.env.STEMDECK_POLL_MS ?? 3000);
const TIMEOUT_MS = 5 * 60 * 1000; // a stem's first MP3 request transcodes it

export const stemsDir = (roomId: string, tab: TabMeta) => path.join(FILES_DIR, roomId, `${tab.id}.stems`);
export const stemFile = (roomId: string, tab: TabMeta, name: StemName) => path.join(stemsDir(roomId, tab), `${name}.mp3`);

async function call(p: string, init: RequestInit = {}) {
  // StemDeck's server mode answers other machines only "over https" (for its own web app's secure context) and trusts
  // X-Forwarded-Proto from reverse proxies; we're its only client, on the internal network.
  const headers = { ...(init.headers as Record<string, string>), 'X-Forwarded-Proto': 'https' };
  const res = await fetch(base() + p, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    let detail = '';
    try {
      detail = String(((await res.json()) as { detail?: unknown }).detail ?? '');
    } catch {
      /* not JSON */
    }
    throw new Error(detail || `StemDeck answered ${res.status}`);
  }
  return res;
}

type Source = { youtube: string } | { file: Buffer; name: string };

/** Submits a job for the tab. The caller has checked that no job is running for it. */
export async function startStems(room: StoredRoom, tab: TabMeta, src: Source, onChange: (room: StoredRoom) => void) {
  let res: Response;
  if ('youtube' in src) {
    res = await call('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${src.youtube}` }),
    });
  } else {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(src.file)]), src.name);
    res = await call('/api/jobs', { method: 'POST', body: form });
  }
  const { job_id } = (await res.json()) as { job_id: string };
  removeFiles(room.id, tab);
  tab.stems = {
    status: 'queued',
    from: 'youtube' in src ? 'youtube' : 'upload',
    ...('youtube' in src ? { videoId: src.youtube } : {}),
    jobId: job_id,
    stage: 'Queued',
    progress: 0,
    names: [],
  };
  saveSoon();
  onChange(room);
}

interface JobState {
  status: string;
  progress?: number;
  stage?: string;
  error?: string | null;
  stem_presence?: Record<string, number> | null;
}

const busy = new Set<string>();

/** One poll of every tab with a job. Exported for tests; `watchStems` runs it on a timer. */
export async function pollStems(onChange: (room: StoredRoom) => void) {
  for (const room of listRooms()) {
    for (const tab of room.tabs) {
      const s = tab.stems;
      if (!s?.jobId || (s.status !== 'queued' && s.status !== 'running') || busy.has(s.jobId)) continue;
      busy.add(s.jobId);
      try {
        await pollOne(room, tab, s, onChange);
      } catch (e) {
        // StemDeck down or restarting: keep waiting. A job it no longer knows is lost.
        if ((e as Error).message === 'job not found') fail(room, tab, 'StemDeck lost the job. Try again.', onChange);
      } finally {
        busy.delete(s.jobId);
      }
    }
  }
}

async function pollOne(room: StoredRoom, tab: TabMeta, s: TabStems, onChange: (room: StoredRoom) => void) {
  const job = (await (await call(`/api/jobs/${s.jobId}`)).json()) as JobState;
  if (tab.stems !== s) return; // removed or restarted meanwhile
  if (job.status === 'error' || job.status === 'cancelled' || job.status === 'stopped' || job.status === 'unavailable') {
    return fail(room, tab, job.error || `StemDeck job ${job.status}`, onChange);
  }
  if (job.status !== 'done') {
    const status = job.status === 'queued' ? 'queued' : 'running';
    const progress = Math.round((job.progress ?? 0) * 100) / 100;
    if (status !== s.status || progress !== s.progress || job.stage !== s.stage) {
      Object.assign(s, { status, progress, stage: job.stage });
      saveSoon();
      onChange(room);
    }
    return;
  }
  const names = STEM_NAMES.filter((n) => !job.stem_presence || (job.stem_presence[n] ?? 0) >= 1);
  const dir = stemsDir(room.id, tab);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const data = Buffer.from(await (await call(`/api/jobs/${s.jobId}/stems/${name}.mp3`)).arrayBuffer());
    if (tab.stems !== s) return;
    fs.writeFileSync(path.join(dir, `${name}.mp3`), data);
  }
  const jobId = s.jobId!;
  tab.stems = { status: 'ready', from: s.from, ...(s.videoId ? { videoId: s.videoId } : {}), names, ...(s.syncPoints ? { syncPoints: s.syncPoints } : {}) };
  saveSoon();
  onChange(room);
  call(`/api/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});
}

function fail(room: StoredRoom, tab: TabMeta, error: string, onChange: (room: StoredRoom) => void) {
  if (!tab.stems) return;
  tab.stems = { status: 'error', from: tab.stems.from, error: error.slice(0, 300), names: [] };
  saveSoon();
  onChange(room);
}

function removeFiles(roomId: string, tab: TabMeta) {
  fs.rmSync(stemsDir(roomId, tab), { recursive: true, force: true });
}

/** Removes a tab's stems (and stops its job, best effort). Also used when the tab is deleted. */
export function removeStems(roomId: string, tab: TabMeta) {
  const jobId = tab.stems?.jobId;
  if (jobId && stemsEnabled()) {
    call(`/api/jobs/${jobId}/cancel`, { method: 'POST' })
      .catch(() => {})
      .then(() => call(`/api/jobs/${jobId}`, { method: 'DELETE' }))
      .catch(() => {});
  }
  delete tab.stems;
  removeFiles(roomId, tab);
}

/** Polls StemDeck while the server runs (jobs saved before a restart are picked up again). */
export function watchStems(onChange: (room: StoredRoom) => void) {
  if (!stemsEnabled()) return;
  setInterval(() => void pollStems(onChange), POLL_MS).unref();
}
