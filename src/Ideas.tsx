// Ideas panel: one tap records the rig (processed instrument), every take saves to the room, find them again by
// label, tag and date; play, rename, tag, download (WAV) or delete.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Idea } from '../shared/protocol';
import { allTags, filterIdeas, safeFileName } from '../shared/ideas';
import { encodeWav } from '../shared/wav';
import { deleteIdea, ideaUrl, updateIdea, type Session } from './api';
import { getAudioContext } from './rig/audioContext';
import type { RigControls } from './rig/useRig';
import type { PendingState, Recorder } from './ideas/useRecorder';

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDate = (t: number) =>
  new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

const PENDING_TEXT: Record<PendingState, string> = {
  saving: 'Saving…',
  waiting: 'Waiting to upload',
  failed: "Couldn't upload",
};

interface Props {
  session: Session;
  ideas: Idea[];
  rig: RigControls;
  /** Lives in Room, so a take keeps recording while other panels are open. */
  rec: Recorder;
  openRig: () => void;
}

export function Ideas({ session, ideas, rig, rec, openRig }: Props) {
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tags = useMemo(() => allTags(ideas), [ideas]);
  const shown = useMemo(() => filterIdeas(ideas, query, tag), [ideas, query, tag]);

  // Someone deleted the idea that's playing: stop.
  useEffect(() => {
    if (playing && !ideas.some((i) => i.id === playing)) setPlaying(null);
  }, [ideas, playing]);
  useEffect(() => {
    if (tag && !tags.some((t) => t.toLowerCase() === tag.toLowerCase())) setTag(null);
  }, [tags, tag]);

  const meterPct = Math.min(100, Math.round(rig.level * 100));

  return (
    <div className="panel ideas">
      <div className={`ideas-rec ${rec.recording ? 'on' : ''}`}>
        <button
          className="ideas-rec-btn"
          onClick={rec.recording ? rec.stop : rec.start}
          disabled={!rec.recording && !rec.canRecord}
          aria-label={rec.recording ? 'Stop recording' : 'Record an idea'}
          title={rec.recording ? 'Stop (saves the take)' : 'Record an idea'}
        >
          <i />
        </button>
        <div className="ideas-rec-info">
          {rec.canRecord || rec.recording ? (
            <>
              <strong>{rec.recording ? `Recording · ${fmt(rec.elapsedMs)}` : 'Record · 0:00'}</strong>
              <div className="rig-meter ideas-meter" title="Input level">
                <i style={{ width: `${meterPct}%` }} className={rig.level > 0.9 ? 'clip' : ''} />
              </div>
            </>
          ) : (
            <button className="btn ghost ideas-rig-link" onClick={openRig}>
              Turn on the rig to record
            </button>
          )}
        </div>
      </div>
      {!rec.protectedStorage && <p className="muted small">Takes aren't protected against a reload in this window.</p>}
      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <input className="ideas-search" placeholder="Search or filter by tag…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {tags.length > 0 && (
        <div className="ideas-tags">
          {tags.map((t) => (
            <button key={t} className={`ideas-tag ${tag?.toLowerCase() === t.toLowerCase() ? 'on' : ''}`} onClick={() => setTag(tag?.toLowerCase() === t.toLowerCase() ? null : t)}>
              {t}
            </button>
          ))}
        </div>
      )}

      <ul className="ideas-list">
        {rec.pending.map(({ take, state }) => (
          <li key={take.id} className="idea pending" data-state={state}>
            <strong>{take.label ?? 'Idea'}</strong>
            <div className="muted small">
              {PENDING_TEXT[state]} · {fmt(take.durationMs)}
              {state !== 'saving' && (
                <button className="link-btn" onClick={() => rec.retry(take.id)}>
                  Retry
                </button>
              )}
            </div>
          </li>
        ))}
        {shown.map((idea) => (
          <IdeaRow
            key={idea.id}
            idea={idea}
            session={session}
            tags={tags}
            playing={playing === idea.id}
            onPlay={(on) => setPlaying(on ? idea.id : null)}
            onError={setError}
          />
        ))}
        {ideas.length === 0 && rec.pending.length === 0 && <li className="muted small ideas-empty">No ideas yet. Turn on the rig, hit record, play.</li>}
        {ideas.length > 0 && shown.length === 0 && <li className="muted small ideas-empty">Nothing matches.</li>}
      </ul>
    </div>
  );
}

function IdeaRow({
  idea,
  session,
  tags,
  playing,
  onPlay,
  onError,
}: {
  idea: Idea;
  session: Session;
  tags: string[];
  playing: boolean;
  onPlay: (on: boolean) => void;
  onError: (e: string) => void;
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const [pos, setPos] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(idea.label);
  const [newTag, setNewTag] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const dur = idea.durationMs / 1000;

  // Only one idea plays at a time; the <audio> is made on first play.
  useEffect(() => {
    if (!playing) {
      audio.current?.pause();
      return;
    }
    if (!audio.current) {
      const a = new Audio(ideaUrl(session, idea.id));
      a.preload = 'auto';
      a.ontimeupdate = () => setPos(a.currentTime);
      a.onended = () => {
        onPlay(false);
        setPos(0);
        a.currentTime = 0;
      };
      audio.current = a;
      if (pendingSeek.current !== null) a.currentTime = pendingSeek.current;
      pendingSeek.current = null;
    }
    audio.current.play().catch(() => onPlay(false));
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      audio.current?.pause();
      audio.current = null;
    },
    [],
  );

  const seek = (t: number) => {
    setPos(t);
    if (audio.current) audio.current.currentTime = t;
    else {
      pendingSeek.current = t;
      onPlay(true);
    }
  };

  const save = async (patch: { label?: string; tags?: string[] }) => {
    try {
      await updateIdea(session, idea.id, patch);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const commitLabel = () => {
    setRenaming(false);
    const l = label.trim();
    if (l && l !== idea.label) void save({ label: l });
    else setLabel(idea.label);
  };
  const addTag = () => {
    const t = newTag.trim();
    setNewTag('');
    if (t && !idea.tags.some((x) => x.toLowerCase() === t.toLowerCase())) void save({ tags: [...idea.tags, t] });
  };

  const download = async () => {
    setBusy(true);
    try {
      const res = await fetch(ideaUrl(session, idea.id));
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const buf = await getAudioContext().decodeAudioData(await res.arrayBuffer());
      const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
      const url = URL.createObjectURL(new Blob([encodeWav(channels, buf.sampleRate)], { type: 'audio/wav' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeFileName(idea.label)}.wav`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    onPlay(false);
    try {
      await deleteIdea(session, idea.id);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <li className="idea" data-id={idea.id}>
      {renaming ? (
        <input
          className="idea-label-input"
          autoFocus
          value={label}
          maxLength={100}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitLabel();
            if (e.key === 'Escape') {
              setLabel(idea.label);
              setRenaming(false);
            }
          }}
        />
      ) : (
        <strong className="idea-label" title="Rename" onClick={() => (setLabel(idea.label), setRenaming(true))}>
          {idea.label}
        </strong>
      )}
      <div className="muted small idea-meta">{[idea.by, fmtDate(idea.createdAt), fmt(idea.durationMs), idea.model].filter(Boolean).join(' · ')}</div>
      <div className="idea-player">
        <button className="idea-play" onClick={() => onPlay(!playing)} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <input type="range" min={0} max={dur} step={0.05} value={Math.min(pos, dur)} onChange={(e) => seek(Number(e.target.value))} aria-label="Position" />
        <span className="mono small">{fmt(pos * 1000)}</span>
      </div>
      <div className="ideas-tags">
        {idea.tags.map((t) => (
          <span key={t} className="ideas-tag">
            {t}
            <button aria-label={`Remove tag ${t}`} onClick={() => void save({ tags: idea.tags.filter((x) => x !== t) })}>
              ×
            </button>
          </span>
        ))}
        {idea.tags.length < 10 && (
          <input
            className="idea-tag-input"
            placeholder="+ tag"
            list={`idea-tags-${idea.id}`}
            value={newTag}
            maxLength={30}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTag()}
            onBlur={addTag}
          />
        )}
        <datalist id={`idea-tags-${idea.id}`}>
          {tags
            .filter((t) => !idea.tags.some((x) => x.toLowerCase() === t.toLowerCase()))
            .map((t) => (
              <option key={t} value={t} />
            ))}
        </datalist>
      </div>
      <div className="idea-actions">
        <button className="link-btn" onClick={download} disabled={busy}>
          {busy ? 'Preparing…' : 'Download'}
        </button>
        {confirmDelete ? (
          <span className="small">
            Delete?{' '}
            <button className="link-btn danger" onClick={remove}>
              Yes
            </button>{' '}
            <button className="link-btn" onClick={() => setConfirmDelete(false)}>
              No
            </button>
          </span>
        ) : (
          <button className="link-btn" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
      </div>
    </li>
  );
}
