import { useCallback, useEffect, useState } from 'react';
import {
  adminChangeAccount,
  adminCreateKey,
  adminDeleteRoom,
  adminGetSettings,
  adminListKeys,
  adminListRooms,
  adminLogin,
  adminRestart,
  adminRevokeKey,
  adminSaveSettings,
  adminSetRoomPassword,
  getAdminToken,
  getConfig,
  setAdminToken,
  type AdminRoom,
  type AdminSettings,
  type ApiKeyInfo,
} from './api';

type Tab = 'rooms' | 'keys' | 'settings' | 'account';
const when = (t: number | null) => (t ? new Date(t).toLocaleString() : '—');

export function Admin() {
  const [signedIn, setSignedIn] = useState(!!getAdminToken());
  const [tab, setTab] = useState<Tab>('rooms');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** Runs an admin action; an expired session sends you back to sign-in. */
  const act = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      setError(null);
      return await fn();
    } catch (e) {
      if (!getAdminToken()) setSignedIn(false);
      setError((e as Error).message);
    }
  }, []);

  if (!signedIn) return <SignIn onDone={() => setSignedIn(true)} />;

  return (
    <div className="admin">
      <header className="row gap wrap">
        <h2 className="grow">tabShare admin</h2>
        <div className="seg-mini" role="tablist" aria-label="Admin sections">
          {(['rooms', 'keys', 'settings', 'account'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => (setTab(t), setError(null), setNotice(null))}>
              {t === 'rooms' ? 'Rooms' : t === 'keys' ? 'API keys' : t === 'settings' ? 'Settings' : 'Account'}
            </button>
          ))}
        </div>
        <a className="btn" href="#/">
          Lobby
        </a>
        <button
          className="btn ghost"
          onClick={() => {
            setAdminToken('');
            setSignedIn(false);
          }}
        >
          Sign out
        </button>
      </header>
      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner">{notice}</div>}
      {tab === 'rooms' && <Rooms act={act} />}
      {tab === 'keys' && <Keys act={act} />}
      {tab === 'settings' && <Settings act={act} setNotice={setNotice} />}
      {tab === 'account' && <Account act={act} setNotice={setNotice} />}
    </div>
  );
}

type Act = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

function SignIn({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="center-card"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await adminLogin(username, password);
          onDone();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>tabShare admin</h2>
      <input placeholder="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
      <input type="password" placeholder="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <div className="banner error">{error}</div>}
      <button className="btn primary" disabled={busy}>
        Sign in
      </button>
      <a className="muted small" href="#/">
        ← Lobby
      </a>
    </form>
  );
}

function Rooms({ act }: { act: Act }) {
  const [rooms, setRooms] = useState<AdminRoom[] | null>(null);
  const load = useCallback(() => act(adminListRooms).then((r) => r && setRooms(r)), [act]);
  useEffect(() => void load(), [load]);
  if (!rooms) return null;
  return (
    <section>
      <div className="row gap">
        <h3 className="grow">Rooms · {rooms.length}</h3>
        <button className="btn" onClick={load}>
          Refresh
        </button>
      </div>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Room</th>
            <th>Code</th>
            <th>Created</th>
            <th>Tabs</th>
            <th>Online</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rooms.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No rooms yet. Create one from the lobby.
              </td>
            </tr>
          )}
          {[...rooms]
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className="mono">
                  <a href={`#/r/${r.id}`}>#{r.id}</a>
                </td>
                <td>{new Date(r.createdAt).toLocaleDateString()}</td>
                <td>
                  {r.tabs} <span className="muted small">({(r.bytes / 1024 / 1024).toFixed(1)} MB)</span>
                </td>
                <td>{r.online.length ? r.online.join(', ') : <span className="muted">—</span>}</td>
                <td className="row gap end">
                  <button
                    className="btn"
                    onClick={() => {
                      const next = window.prompt(`New password for "${r.name}" (min 4 chars). Connected users will be kicked.`);
                      if (next) act(() => adminSetRoomPassword(r.id, next)).then(load);
                    }}
                  >
                    Password
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => {
                      if (window.confirm(`Delete "${r.name}" and all its tabs? This can't be undone.`)) act(() => adminDeleteRoom(r.id)).then(load);
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </section>
  );
}

function Keys({ act }: { act: Act }) {
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<{ key: string; name: string } | null>(null);
  const [serverUrl, setServerUrl] = useState(location.origin);
  const load = useCallback(() => act(adminListKeys).then((k) => k && setKeys(k)), [act]);
  useEffect(() => {
    void load();
    getConfig().then((c) => c.baseUrl && setServerUrl(c.baseUrl));
  }, [load]);
  return (
    <section className="admin-section">
      <p className="muted">
        API keys connect the desktop app (and scripts) to this server. Make one per person so you can revoke it on its own. The key is shown once.
      </p>
      <form
        className="row gap"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await act(() => adminCreateKey(name));
          if (r) {
            setFresh({ key: r.key, name: r.info.name });
            setName('');
            load();
          }
        }}
      >
        <input className="grow" placeholder="Who is it for? e.g. Mike's desktop app" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <button className="btn primary">Create key</button>
      </form>
      {fresh && (
        <div className="key-reveal">
          <strong>{fresh.name}</strong>: copy this now, it won't be shown again.
          <div className="row gap">
            <code className="grow mono">{fresh.key}</code>
            <button className="btn" onClick={() => navigator.clipboard?.writeText(fresh.key)}>
              Copy
            </button>
          </div>
          <span className="muted small">
            In the desktop app: Server URL <code>{serverUrl}</code> and this key.
          </span>
        </div>
      )}
      <table className="admin-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            <th>Created</th>
            <th>Last used</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {keys?.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No keys yet.
              </td>
            </tr>
          )}
          {keys?.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td className="mono">{k.prefix}…</td>
              <td>{when(k.createdAt)}</td>
              <td>{when(k.lastUsedAt)}</td>
              <td className="row end">
                <button
                  className="btn danger"
                  onClick={() => window.confirm(`Revoke "${k.name}"? Apps using it are disconnected.`) && act(() => adminRevokeKey(k.id)).then(load)}
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Settings({ act, setNotice }: { act: Act; setNotice: (s: string | null) => void }) {
  const [s, setS] = useState<AdminSettings | null>(null);
  const [restart, setRestart] = useState(false);
  useEffect(() => void act(adminGetSettings).then((r) => r && setS(r)), [act]);
  if (!s) return null;
  const set = (patch: Partial<AdminSettings>) => setS({ ...s, ...patch });
  return (
    <form
      className="admin-section settings-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await act(() =>
          adminSaveSettings({ baseUrl: s.baseUrl, port: s.port, tone3000ClientId: s.tone3000ClientId, requireAdminForRooms: s.requireAdminForRooms }),
        );
        if (r) {
          setS(r);
          setRestart(r.restartRequired);
          getConfig(true);
          setNotice(r.restartRequired ? 'Saved. The new port takes effect after a restart.' : 'Saved.');
        }
      }}
    >
      <label>
        Public URL
        <input value={s.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder={location.origin} />
        <span className="muted small">The address your friends use (invite links and desktop app setup). Leave empty to use whatever address the browser is on.</span>
      </label>
      <label>
        Port
        <input type="number" min={1} max={65535} value={s.port ?? ''} placeholder={String(s.listeningOn)} onChange={(e) => set({ port: e.target.value ? Number(e.target.value) : null })} />
        <span className="muted small">
          Listening on {s.listeningOn}. In Docker this is the port inside the container: change your port mapping to match, or change only the host side of the mapping.
        </span>
      </label>
      <label>
        TONE3000 client ID
        <input value={s.tone3000ClientId} onChange={(e) => set({ tone3000ClientId: e.target.value })} placeholder="t3k_pub_…" />
        <span className="muted small">Publishable key for "Browse TONE3000" in the Rig panel. Register the redirect URL {(s.baseUrl || location.origin) + '/t3k-callback.html'}.</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.requireAdminForRooms} onChange={(e) => set({ requireAdminForRooms: e.target.checked })} /> Require admin sign-in to create rooms
      </label>
      <div className="row gap">
        <button className="btn primary">Save</button>
        {restart && (
          <button
            type="button"
            className="btn"
            onClick={() =>
              window.confirm('Restart the server now? Everyone is disconnected for a few seconds.') &&
              act(adminRestart).then(() => setNotice(`Restarting… if you changed the port, open the server on port ${s.port ?? s.listeningOn}.`))
            }
          >
            Restart server
          </button>
        )}
      </div>
    </form>
  );
}

function Account({ act, setNotice }: { act: Act; setNotice: (s: string | null) => void }) {
  const [username, setUsername] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  useEffect(() => void act(adminGetSettings).then((r) => r && setUsername(r.username)), [act]);
  return (
    <form
      className="admin-section settings-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await act(async () => (await adminChangeAccount(current, username, next), true));
        if (ok) {
          setCurrent('');
          setNext('');
          setNotice('Account updated. Other signed-in browsers were signed out.');
        }
      }}
    >
      <label>
        Username
        <input value={username} autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label>
        New password <span className="muted small">(leave empty to keep it)</span>
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={next ? 8 : undefined} />
      </label>
      <label>
        Current password
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <button className="btn primary">Update account</button>
    </form>
  );
}
