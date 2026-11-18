// Takes that aren't confirmed by the server yet. Chunks are written to IndexedDB while recording, so a reload, a quit
// or a crash loses at most the last chunk; the take uploads on the next visit. Without IndexedDB (private windows, some
// embedded browsers) everything lives in memory: retries still work, a reload loses the take.

export interface PendingTake {
  id: string;
  roomId: string;
  /** Null = let the server pick (only for takes saved before labels were made client-side). */
  label: string | null;
  tags: string[];
  by: string;
  model: string | null;
  mime: string;
  createdAt: number;
  durationMs: number;
  /** False while recording (or if the page died mid-take). */
  done: boolean;
  /** Last write (a chunk or the stop): a take that isn't done and hasn't been written for a while is a crash leftover. */
  updatedAt: number;
  /** The server refused it (not a network problem): kept for Download/Discard, never re-sent automatically. */
  failed?: boolean;
}

const DB = 'tabshare-ideas';
const TAKES = 'takes';
const CHUNKS = 'chunks';

const memTakes = new Map<string, PendingTake>();
const memChunks = new Map<string, Blob[]>();

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(TAKES, { keyPath: 'id' });
        req.result.createObjectStore(CHUNKS); // key [takeId, seq]
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** Runs one transaction; resolves with the request's result, or undefined if IndexedDB failed. */
async function run<T>(stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(stores, mode);
      const req = fn(tx);
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** All chunk keys of one take (only called once IndexedDB exists). */
const chunkRange = (takeId: string) => IDBKeyRange.bound([takeId, 0], [takeId, Number.MAX_SAFE_INTEGER]);

/** True when takes survive a reload (IndexedDB works here). */
export async function pendingAvailable(): Promise<boolean> {
  return (await openDb()) !== null;
}

export async function putTake(t: PendingTake): Promise<void> {
  memTakes.set(t.id, { ...t });
  await run([TAKES], 'readwrite', (tx) => void tx.objectStore(TAKES).put(t));
}

export async function addChunk(takeId: string, seq: number, data: Blob): Promise<void> {
  const list = memChunks.get(takeId) ?? [];
  list[seq] = data;
  memChunks.set(takeId, list);
  await run([CHUNKS], 'readwrite', (tx) => void tx.objectStore(CHUNKS).put(data, [takeId, seq]));
}

/** Every take for the room that the server hasn't confirmed (this page's and earlier visits'). */
export async function listTakes(roomId: string): Promise<PendingTake[]> {
  const stored = (await run<PendingTake[]>([TAKES], 'readonly', (tx) => tx.objectStore(TAKES).getAll())) ?? [];
  const all = new Map<string, PendingTake>(stored.map((t) => [t.id, t]));
  for (const t of memTakes.values()) all.set(t.id, t);
  return [...all.values()].filter((t) => t.roomId === roomId).sort((a, b) => a.createdAt - b.createdAt);
}

/** The take's audio: its chunks in order. */
export async function takeBlob(t: PendingTake): Promise<Blob> {
  const stored = await run<Blob[]>([CHUNKS], 'readonly', (tx) => tx.objectStore(CHUNKS).getAll(chunkRange(t.id)));
  const mem = (memChunks.get(t.id) ?? []).filter(Boolean);
  const parts = stored && stored.length >= mem.length ? stored : mem;
  return new Blob(parts, { type: t.mime });
}

/** Forget a take once the server has it. */
export async function dropTake(id: string): Promise<void> {
  memTakes.delete(id);
  memChunks.delete(id);
  await run([TAKES, CHUNKS], 'readwrite', (tx) => {
    tx.objectStore(TAKES).delete(id);
    tx.objectStore(CHUNKS).delete(chunkRange(id));
  });
}
