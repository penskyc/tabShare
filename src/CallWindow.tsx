import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CallState } from '../shared/protocol';

export interface StageTile {
  id: string;
  stream: MediaStream | null;
  name: string;
  color: string;
  state: CallState;
  self: boolean;
}

/**
 * Renders `content` into a second window (a window.open popup or Chrome's Document Picture-in-Picture window).
 * It gets its own React root: events from another document never reach the main root. Styles are copied over.
 */
export function useChildWindow(open: (() => Window | Promise<Window | null> | null) | null, content: ReactNode, onClosed: () => void) {
  const ref = useRef<{ win: Window; root: Root } | null>(null);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const contentRef = useRef(content);
  contentRef.current = content;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let off = () => {};
    Promise.resolve(open())
      .then((win) => {
        if (!win) return onClosedRef.current();
        if (cancelled) return win.close();
        const doc = win.document;
        doc.head.replaceChildren(...[...document.querySelectorAll('link[rel="stylesheet"], style')].map((n) => n.cloneNode(true)));
        doc.title = 'tabShare call';
        doc.body.className = 'call-window';
        const host = doc.createElement('div');
        doc.body.replaceChildren(host);
        ref.current = { win, root: createRoot(host) };
        ref.current.root.render(contentRef.current);
        const gone = () => onClosedRef.current();
        win.addEventListener('pagehide', gone);
        off = () => win.removeEventListener('pagehide', gone);
      })
      .catch(() => onClosedRef.current());
    return () => {
      cancelled = true;
      off();
      const cur = ref.current;
      ref.current = null;
      if (cur) {
        cur.root.unmount();
        cur.win.close();
      }
    };
  }, [open]);

  useEffect(() => {
    ref.current?.root.render(content);
  });
}

/** A muted video for a stream (the call's audio keeps playing from the main window). */
function StageVideo({ tile }: { tile: StageTile }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== tile.stream) ref.current.srcObject = tile.stream;
  }, [tile.stream]);
  const showVideo = tile.state.cam || tile.state.screen;
  return (
    <>
      <video ref={ref} autoPlay playsInline muted className={`${tile.self && !tile.state.screen ? 'mirror' : ''} ${tile.state.screen ? 'contain' : ''}`} hidden={!showVideo} />
      {!showVideo && (
        <div className="cw-avatar" style={{ background: tile.color }}>
          {tile.name.slice(0, 1).toUpperCase()}
        </div>
      )}
      <div className="cw-label">
        {!tile.state.mic && <span title="Muted">🔇 </span>}
        {tile.name}
      </div>
    </>
  );
}

/** Pop-out: everyone else split-screen, you in the bottom-right corner. */
export function CallStage({ tiles, mic, cam, onToggleMic, onToggleCam, onClose }: {
  tiles: StageTile[];
  mic: boolean;
  cam: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onClose: () => void;
}) {
  const others = tiles.filter((t) => !t.self);
  const self = tiles.find((t) => t.self);
  const cols = others.length <= 1 ? 1 : others.length <= 4 ? 2 : 3;
  const [full, setFull] = useState(false);
  const toggleFull = (e: React.MouseEvent) => {
    const doc = (e.currentTarget as HTMLElement).ownerDocument;
    if (doc.fullscreenElement) doc.exitFullscreen();
    else doc.documentElement.requestFullscreen().catch(() => {});
  };
  return (
    <div
      className="cw-stage"
      onDoubleClick={toggleFull}
      ref={(el) => {
        if (el) el.ownerDocument.onfullscreenchange = () => setFull(!!el.ownerDocument.fullscreenElement);
      }}
    >
      <div className="cw-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {others.length ? (
          others.map((t) => (
            <div key={t.id} className="cw-tile" style={{ ['--c' as string]: t.color }}>
              <StageVideo tile={t} />
            </div>
          ))
        ) : (
          <div className="cw-empty">Waiting for others to join the call…</div>
        )}
      </div>
      {self && (
        <div className="cw-self">
          <StageVideo tile={self} />
        </div>
      )}
      <div className="cw-bar">
        <button className={mic ? '' : 'off'} onClick={onToggleMic} title={mic ? 'Mute' : 'Unmute'}>
          {mic ? '🎙' : '🔇'}
        </button>
        <button className={cam ? '' : 'off'} onClick={onToggleCam} title={cam ? 'Stop video' : 'Start video'}>
          {cam ? '📷' : '🚫'}
        </button>
        <button onClick={toggleFull} title={full ? 'Exit full screen' : 'Full screen (or double-click)'}>
          {full ? '🗗' : '⛶'}
        </button>
        <button onClick={onClose} title="Close">
          ✕
        </button>
      </div>
    </div>
  );
}

/** Picture-in-picture: one person's video and a close button. */
export function CallPip({ tile, onClose }: { tile: StageTile | undefined; onClose: () => void }) {
  return (
    <div className="cw-pip">
      {tile ? <StageVideo tile={tile} /> : <div className="cw-empty">No one else is in the call</div>}
      <button className="cw-pip-close" onClick={onClose} title="Close" aria-label="Close picture-in-picture">
        ✕
      </button>
    </div>
  );
}
