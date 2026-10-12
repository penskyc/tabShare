import { createElement, useEffect, useRef, useState } from 'react';
import { browseUrl } from '../shared/protocol';
import type { RoomConnection } from './useRoom';
import { native } from './rig/native';

/** Electron's <webview> (desktop app 0.3.2+): a real browser tab inside the page. */
interface WebviewEl extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
}

const START = [
  ['Reverb', 'https://reverb.com/'],
  ['Sweetwater', 'https://www.sweetwater.com/'],
  ['Thomann', 'https://www.thomann.de/'],
  ['YouTube', 'https://www.youtube.com/'],
] as const;

/** What was typed in the address bar → a URL: a site ("reverb.com/…") or a web search for anything else. */
export function toUrl(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return browseUrl(t);
  if (/^[^\s]+\.[a-z]{2,}(\/\S*)?$/i.test(t)) return browseUrl(`https://${t}`);
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

function readFollow() {
  try {
    return localStorage.getItem('tabshare.browser.follow') !== '0';
  } catch {
    return true;
  }
}

/** Browser mode: one page the whole room looks at. The desktop app shows it inline; elsewhere it's a link to open. */
export function Browser({ room }: { room: RoomConnection }) {
  const shared = room.browse;
  const [follow, setFollow] = useState(readFollow);
  const [address, setAddress] = useState(shared?.url ?? '');
  const [loading, setLoading] = useState(false);
  const toggleFollow = (on: boolean) => {
    setFollow(on);
    try {
      localStorage.setItem('tabshare.browser.follow', on ? '1' : '0');
    } catch {
      /* per-session only */
    }
  };

  // ---- desktop: an embedded page that follows (and leads) the room ----
  const embed = !!native?.webview;
  const [initialSrc] = useState(() => shared?.url ?? 'about:blank'); // later pages load via loadURL, not src
  const view = useRef<WebviewEl | null>(null);
  const ready = useRef(false);
  const pending = useRef<string | null>(null);
  const lastShared = useRef(shared?.url ?? null); // the room URL this view last matched, so we don't echo it back
  const followRef = useRef(follow);
  followRef.current = follow;
  const roomRef = useRef(room);
  roomRef.current = room;

  const load = (url: string) => {
    if (!ready.current) {
      pending.current = url;
      return;
    }
    view.current?.loadURL(url).catch(() => {}); // aborted loads (a newer navigation) reject; nothing to do
  };

  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const onReady = () => {
      if (ready.current) return;
      ready.current = true;
      if (pending.current) load(pending.current);
      pending.current = null;
    };
    const onNav = (e: Event) => {
      const ev = e as Event & { url: string; isMainFrame?: boolean };
      if (ev.isMainFrame === false || !/^https?:/i.test(ev.url)) return;
      setAddress(ev.url);
      if (followRef.current && ev.url !== lastShared.current) {
        lastShared.current = ev.url;
        roomRef.current.sendBrowse(ev.url);
      }
    };
    const onStart = () => setLoading(true);
    const onStop = () => setLoading(false);
    el.addEventListener('dom-ready', onReady);
    el.addEventListener('did-navigate', onNav);
    el.addEventListener('did-navigate-in-page', onNav);
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    return () => {
      el.removeEventListener('dom-ready', onReady);
      el.removeEventListener('did-navigate', onNav);
      el.removeEventListener('did-navigate-in-page', onNav);
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
    };
  }, [embed]);

  // Someone else opened a page (or Follow was just turned on): go there.
  useEffect(() => {
    if (!embed || !follow || !shared?.url || shared.url === lastShared.current) return;
    lastShared.current = shared.url;
    setAddress(shared.url);
    load(shared.url);
  }, [embed, follow, shared?.url]);

  const go = (input: string) => {
    const url = toUrl(input);
    if (!url) return;
    if (embed) {
      setAddress(url);
      load(url);
    } else {
      setAddress(''); // shared: the card below shows it
      room.sendBrowse(url);
    }
  };

  const bar = (
    <form
      className="browser-bar"
      onSubmit={(e) => {
        e.preventDefault();
        go(address);
      }}
    >
      {embed && (
        <span className="browser-nav">
          <button type="button" onClick={() => view.current?.goBack()} title="Back" aria-label="Back">
            ←
          </button>
          <button type="button" onClick={() => view.current?.goForward()} title="Forward" aria-label="Forward">
            →
          </button>
          <button type="button" onClick={() => view.current?.reload()} title="Reload" aria-label="Reload">
            {loading ? '✕' : '↻'}
          </button>
        </span>
      )}
      <input className="grow" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Search or type a web address" aria-label="Address" spellCheck={false} />
      <button className="btn" type="submit">
        {embed ? 'Go' : 'Share'}
      </button>
      {embed && (
        <label className="check-line small muted" title="On: you see what others open, and they see what you open. Off: browse on your own.">
          <input type="checkbox" checked={follow} onChange={(e) => toggleFollow(e.target.checked)} /> Browse together
        </label>
      )}
    </form>
  );

  return (
    <div className="browser">
      {bar}
      {shared && <div className="browser-who small muted">Opened by {shared.by}</div>}
      {embed ? (
        <>
          {!shared && address === '' && (
            <div className="browser-start">
              {START.map(([name, url]) => (
                <button key={url} className="btn" onClick={() => go(url)}>
                  {name}
                </button>
              ))}
            </div>
          )}
          {createElement('webview', { ref: view, className: 'browser-view', src: initialSrc, partition: 'persist:tabshare-browser' })}
        </>
      ) : (
        <div className="browser-card">
          {shared ? (
            <>
              <div className="browser-host">{new URL(shared.url).host}</div>
              <div className="mono small muted browser-url">{shared.url}</div>
              <a className="btn primary" href={shared.url} target="_blank" rel="noopener noreferrer">
                Open
              </a>
            </>
          ) : (
            <p className="muted">Nothing shared yet. Type a web address above and press Share, and everyone in the room gets the link.</p>
          )}
          <p className="small muted">
            {native ? 'Update the desktop app to browse together right inside tabShare.' : 'In the desktop app, pages open right inside tabShare and follow along as anyone browses.'}
          </p>
        </div>
      )}
    </div>
  );
}
