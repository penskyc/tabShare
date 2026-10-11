import { useState } from 'react';
import type { TabMeta } from '../shared/protocol';
import { importSongsterr, searchSongsterr, type Session, type SongsterrHit } from './api';

/** Library panel: search Songsterr and import a song as a Guitar Pro tab. */
export function SongsterrSearch({ session, by, onImported }: { session: Session; by: string; onImported: (tab: TabMeta) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SongsterrHit[] | null>(null);
  const [busy, setBusy] = useState<number | 'search' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy('search');
    setError(null);
    try {
      setHits(await searchSongsterr(session, q.trim()));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const pick = async (h: SongsterrHit) => {
    setBusy(h.songId);
    setError(null);
    try {
      onImported(await importSongsterr(session, h.songId, by));
      setHits(null);
      setQ('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="songsterr">
      <form className="row gap" onSubmit={search}>
        <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Songsterr: artist or song" aria-label="Search Songsterr" />
        <button className="btn" disabled={busy !== null}>
          {busy === 'search' ? '…' : 'Search'}
        </button>
      </form>
      {error && (
        <span className="call-error" onClick={() => setError(null)}>
          {error} ✕
        </span>
      )}
      {hits && (
        <ul className="tab-list">
          {hits.length === 0 && <li className="muted small">No songs found.</li>}
          {hits.map((h) => (
            <li key={h.songId}>
              <button className="tab-item" onClick={() => pick(h)} disabled={busy !== null} title="Add to the library">
                <strong>{busy === h.songId ? 'Importing…' : h.title}</strong>
                <span className="muted small">
                  {h.artist} · {h.tracks} track{h.tracks === 1 ? '' : 's'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
