// Sign in. One field, no password.
//
// The shape is the standard magic-link card — ask, then confirm — because a
// merchant has seen it before and there is nothing to learn. What it does
// NOT do is tell you whether the address has an account: the service answers
// a stranger exactly as it answers a customer, and this screen says the same
// thing either way, or the pair of them would leak the difference the
// service went to trouble to hide.

import { useEffect, useState } from 'react';
import { api, ApiError, go, type Me } from '../lib/api.ts';

const MARK = (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 2.5 21 7.2v9.6L12 21.5 3 16.8V7.2z" />
    <path d="M3 7.2 12 12v9.5" /><path d="M21 7.2 12 12" />
  </svg>
);
const SENT = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
    <path d="m3.5 7 8.5 6 8.5-6" />
  </svg>
);

export function SignIn(props: { token: string | null; onSignedIn: (me: Me) => void }) {
  const { token, onSignedIn } = props;
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spending, setSpending] = useState(!!token);

  // A link in the URL is spent immediately, and the fragment is cleared
  // before anything else happens — a screenshot, a shoulder, or a shared
  // tab should not carry a working credential.
  useEffect(() => {
    if (!token) return;
    let live = true;
    void (async () => {
      try {
        const me = await api.consumeLink(token);
        if (!live) return;
        history.replaceState(null, '', '/');
        onSignedIn(me);
      } catch (err) {
        if (!live) return;
        history.replaceState(null, '', '/signin');
        setError(err instanceof ApiError ? err.message : 'that link did not work');
        setSpending(false);
      }
    })();
    return () => { live = false; };
  }, [token, onSignedIn]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      await api.requestLink(address);
      setSent(address);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not send the link');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card" data-testid="signin-card">
        <span className="auth-mark" aria-hidden="true">{MARK}</span>

        {spending ? (
          <>
            <h1>Signing you in…</h1>
            <p className="auth-sub">One moment.</p>
          </>
        ) : sent ? (
          <>
            <span className="auth-sent" aria-hidden="true">{SENT}</span>
            <h1>Check your inbox</h1>
            <p className="auth-sub" data-testid="signin-sent">
              If <strong>{sent}</strong> has an account, a sign-in link is on its way.
              It works once and expires in 15 minutes.
            </p>
            <button
              className="ghost auth-wide" data-testid="signin-again"
              onClick={() => { setSent(null); setError(null); }}
            >Use a different address</button>
          </>
        ) : (
          <>
            <h1>Sign in to Studio</h1>
            <p className="auth-sub">
              Build a 3D product configurator and put it on your store. We&rsquo;ll email you a
              link — there is no password to forget.
            </p>
            <form onSubmit={submit}>
              <label className="auth-field">
                <span className="field-label">Email</span>
                <input
                  type="email" autoComplete="email" required autoFocus
                  data-testid="signin-email" placeholder="you@yourshop.com"
                  value={email} onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <button className="cta auth-wide" type="submit" data-testid="signin-submit" disabled={busy}>
                {busy ? 'Sending…' : 'Email me a link'}
              </button>
            </form>
          </>
        )}

        {error && <p className="error auth-error" role="alert" data-testid="signin-error">{error}</p>}
      </div>

      <button className="auth-escape" onClick={() => go('/')}>
        Or keep working without an account
      </button>
    </div>
  );
}
