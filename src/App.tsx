import { useEffect, useState } from 'react';
import {
  PEER_COLORS,
  clearSession,
  adminLogin,
  createRoom,
  getAdminToken,
  getConfig,
  getProfile,
  getSession,
  joinRoom,
  lookupRoom,
  recentSessions,
  saveProfile,
  saveSession,
  type Profile,
  type Session,
} from './api';
import { Room } from './Room';
import { Admin } from './Admin';
import { Setup } from './Setup';
import { native } from './rig/native';

function roomFromHash() {
  const m = location.hash.match(/^#\/r\/([a-z0-9]+)/i);
  return m ? m[1].toLowerCase() : null;
}

export function App() {
  const [setupNeeded, setSetupNeeded] = useState(false);
  useEffect(() => void getConfig().then((c) => setSetupNeeded(c.setupNeeded), () => {}), []);
  const [isAdmin, setIsAdmin] = useState(location.hash.startsWith('#/admin'));
  const [roomId, setRoomId] = useState(roomFromHash());
  const [profile, setProfile] = useState<Profile>(getProfile());
  const [session, setSession] = useState<Session | null>(() => (roomId ? getSession(roomId) : null));

  useEffect(() => {
    const onHash = () => {
      const id = roomFromHash();
      setIsAdmin(location.hash.startsWith('#/admin'));
      setRoomId(id);
      setSession(id ? getSession(id) : null);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const enter = (s: Session, p: Profile) => {
    saveProfile(p);
    setProfile(p);
    saveSession(s);
    setSession(s);
    setRoomId(s.roomId);
    location.hash = `#/r/${s.roomId}`;
  };

  if (setupNeeded)
    return (
      <Setup
        onDone={() => {
          setSetupNeeded(false);
          location.hash = '#/admin';
        }}
      />
    );
  if (isAdmin) return <Admin />;

  if (session && roomId === session.roomId && profile.name) {
    return (
      <Room
        session={session}
        profile={profile}
        onLeave={() => {
          clearSession(session.roomId);
          setSession(null);
          location.hash = '#/';
        }}
      />
    );
  }

  return <Lobby initialRoomId={roomId} profile={profile} existing={session} onEnter={enter} />;
}

function Lobby({
  initialRoomId,
  profile,
  existing,
  onEnter,
}: {
  initialRoomId: string | null;
  profile: Profile;
  existing: Session | null;
  onEnter: (s: Session, p: Profile) => void;
}) {
  const [mode, setMode] = useState<'join' | 'create'>(initialRoomId ? 'join' : 'create');
  const [name, setName] = useState(profile.name);
  const [color, setColor] = useState(profile.color);
  const [roomName, setRoomName] = useState('');
  const [code, setCode] = useState(initialRoomId ?? '');
  const [password, setPassword] = useState('');
  // Creating a room needs the admin's sign-in unless the server allows anyone (Admin → Settings).
  const [adminUser, setAdminUser] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [needAdmin, setNeedAdmin] = useState(!getAdminToken());
  useEffect(() => void getConfig().then((c) => setNeedAdmin(c.requireAdminForRooms && !getAdminToken()), () => {}), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [foundName, setFoundName] = useState<string | null>(null);
  const recent = recentSessions();

  useEffect(() => {
    setFoundName(null);
    const c = code.trim().toLowerCase();
    if (mode !== 'join' || c.length < 6) return;
    const t = setTimeout(() => {
      lookupRoom(c)
        .then((r) => setFoundName(r.name))
        .catch(() => setFoundName(''));
    }, 250);
    return () => clearTimeout(t);
  }, [code, mode]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Pick a display name');
    setBusy(true);
    setError(null);
    try {
      if (!existing && mode === 'create' && needAdmin) await adminLogin(adminUser, adminPassword);
      const s = existing ?? (mode === 'create' ? await createRoom(roomName.trim(), password) : await joinRoom(code.trim().toLowerCase(), password));
      onEnter(s, { name: name.trim(), color });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lobby">
      <section className="lobby-hero">
        <div className="brand">
          tab<span>Share</span>
        </div>
        <p className="tagline">Open a tab. Invite the band. Everyone sees the same score, hears the same mix, and plays along together.</p>
        <ul className="features">
          <li>Songsterr search &amp; import · Guitar Pro, MusicXML, alphaTex</li>
          <li>Live cursors, selections, playheads &amp; shared loops</li>
          <li>Jam sync: play, speed, tracks &amp; mix for everyone</li>
          <li>Synth or the original recording, tap-synced to the tab</li>
          <li>Tuner &amp; fretboard: scales, arpeggios, follow any track</li>
          <li>Video call: pop-out split screen, picture-in-picture, screen share</li>
          <li>Amp rig: NAM models, TONE3000, cab IRs, sent into the call</li>
          <li>Desktop app for Windows &amp; Mac: ASIO / Core Audio, VST3, auto-updates</li>
        </ul>
        <div className="staff-art" aria-hidden>
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} />
          ))}
        </div>
      </section>

      <form className="lobby-card" onSubmit={submit}>
        {!existing && (
          <div className="seg">
            <button type="button" className={mode === 'create' ? 'on' : ''} onClick={() => setMode('create')}>
              Create room
            </button>
            <button type="button" className={mode === 'join' ? 'on' : ''} onClick={() => setMode('join')}>
              Join room
            </button>
          </div>
        )}

        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Corey" autoFocus />
        </label>
        <div className="swatches">
          {PEER_COLORS.map((c) => (
            <button type="button" key={c} className={c === color ? 'on' : ''} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Color ${c}`} />
          ))}
        </div>

        {existing ? (
          <p className="muted">Rejoining <b>{existing.roomName}</b></p>
        ) : mode === 'create' ? (
          <label>
            Room name
            <input value={roomName} onChange={(e) => setRoomName(e.target.value)} maxLength={80} placeholder="Friday night jam" required />
          </label>
        ) : (
          <label>
            Room code
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="abc123" className="mono" required />
            {foundName && <span className="hint ok">→ {foundName}</span>}
            {foundName === '' && <span className="hint bad">No room with that code</span>}
          </label>
        )}

        {!existing && (
          <label>
            Room password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={4} required />
          </label>
        )}

        {!existing && mode === 'create' && needAdmin && (
          <div className="row gap">
            <label className="grow">
              Admin username <span className="muted">(only the host creates rooms)</span>
              <input value={adminUser} onChange={(e) => setAdminUser(e.target.value)} autoComplete="username" required />
            </label>
            <label className="grow">
              Admin password
              <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} autoComplete="current-password" required />
            </label>
          </div>
        )}

        {error && <div className="banner error">{error}</div>}
        <button className="btn primary big" disabled={busy}>
          {busy ? '…' : existing ? 'Enter room' : mode === 'create' ? 'Create & enter' : 'Join'}
        </button>

        <a className="muted small admin-link" href="#/admin">
          Admin
        </a>
        {native?.openServerSettings && (
          <button type="button" className="muted small admin-link link-btn" onClick={() => native!.openServerSettings!()}>
            Desktop app: change server
          </button>
        )}

        {recent.length > 0 && !existing && (
          <div className="recent">
            <span className="muted small">Recent rooms</span>
            {recent.map((s) => (
              <a key={s.roomId} href={`#/r/${s.roomId}`}>
                {s.roomName} <span className="mono muted">#{s.roomId}</span>
              </a>
            ))}
          </div>
        )}
      </form>
    </div>
  );
}
