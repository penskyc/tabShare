// Songsterr search + import as a Guitar Pro file. The JSON → GP7 converter in this folder is vendored from
// github.com/Metaphysics0/songsterr-downloader (MIT, see LICENSE).
import { SongsterrToAlphaTabConverter } from './songsterr-to-alphatab.converter.js';
import type { SongsterrRevisionTrackPayload, SongsterrStateMetaCurrent } from './types.js';

const API = 'https://www.songsterr.com/api';
const CDN = 'https://dqsljvtekg760.cloudfront.net';
const TIMEOUT_MS = 10_000;

export interface SongsterrHit {
  songId: number;
  artist: string;
  title: string;
  tracks: number;
}

async function get(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Referer: 'https://www.songsterr.com/' } });
  if (!res.ok) throw new Error(`Songsterr ${res.status} for ${new URL(url).pathname}`);
  return res;
}

export async function searchSongs(query: string): Promise<SongsterrHit[]> {
  const songs = (await (await get(`${API}/songs?${new URLSearchParams({ pattern: query, size: '25' })}`)).json()) as Array<{
    songId: number;
    artist: string;
    title: string;
    tracks?: unknown[];
    isJunk?: boolean;
  }>;
  return songs.filter((s) => !s.isJunk).map((s) => ({ songId: s.songId, artist: s.artist, title: s.title, tracks: s.tracks?.length ?? 0 }));
}

interface MetaTrack {
  instrumentId: number;
  name?: string;
  title?: string;
  tuning?: number[];
  isDrums?: boolean;
}

/** Builds a Guitar Pro 7 file of the song's current revision. */
export async function downloadSong(songId: number): Promise<{ data: Buffer; artist: string; title: string }> {
  const meta = (await (await get(`${API}/meta/${songId}`)).json()) as {
    revisionId: number;
    image: string;
    title: string;
    artist: string;
    tracks: MetaTrack[];
  };
  if (!meta.image || !meta.tracks?.length) throw new Error('This song has no tab data on Songsterr');
  const state: SongsterrStateMetaCurrent = {
    songId,
    revisionId: meta.revisionId,
    image: meta.image,
    title: meta.title,
    artist: meta.artist,
    // The page's partId is the track's index in this list.
    tracks: meta.tracks.map((t, partId) => ({ ...t, partId, isDrums: t.isDrums ?? t.instrumentId === 1024 })),
  };
  const parts = await Promise.all(
    state.tracks.map(async (trackMeta) => ({
      trackMeta,
      revision: (await (await get(`${CDN}/${songId}/${meta.revisionId}/${meta.image}/${trackMeta.partId}.json`)).json()) as SongsterrRevisionTrackPayload,
    })),
  );
  const { data } = new SongsterrToAlphaTabConverter().toGp7({ meta: state, revisions: parts });
  return { data: Buffer.from(data), artist: meta.artist, title: meta.title };
}
