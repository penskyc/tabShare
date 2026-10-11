import { useState } from 'react';
import { setupServer } from './api';

/** First run: claim the server with the code from its log, create the admin account, set the public URL. */
export function Setup({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [baseUrl, setBaseUrl] = useState(location.origin);
  const [tone3000ClientId, setTone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="center-card setup"
      onSubmit={async (e) => {
        e.preventDefault();
        if (password !== confirm) return setError("Passwords don't match");
        setBusy(true);
        setError(null);
        try {
          await setupServer({ code, username, password, baseUrl, tone3000ClientId });
          onDone();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="brand-sm">
        tab<span>Share</span>
      </div>
      <h2>Set up this server</h2>
      <p className="muted small">
        Find the setup code in the server's log (for Docker: <code>docker logs tabshare</code>). It stops a stranger from claiming a new server first.
      </p>
      <label>
        Setup code
        <input className="mono" value={code} onChange={(e) => setCode(e.target.value)} autoFocus required autoComplete="off" />
      </label>
      <label>
        Admin username
        <input value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" />
      </label>
      <label>
        Admin password <span className="muted small">(8+ characters)</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required autoComplete="new-password" />
      </label>
      <label>
        Confirm password
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
      </label>
      <label>
        Public URL <span className="muted small">(what your friends will open)</span>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://tabs.example.com" />
      </label>
      <label>
        TONE3000 client ID <span className="muted small">(optional, for browsing amp models)</span>
        <input value={tone3000ClientId} onChange={(e) => setTone(e.target.value)} placeholder="t3k_pub_…" />
      </label>
      {error && <div className="banner error">{error}</div>}
      <button className="btn primary" disabled={busy}>
        Finish setup
      </button>
      <span className="muted small">You can change all of this later in Admin → Settings.</span>
    </form>
  );
}
