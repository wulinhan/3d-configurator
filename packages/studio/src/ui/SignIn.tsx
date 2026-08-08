// Sign in. One field, no password — and, when the deployment has them
// switched on, a "Sign in with Google" button above the field and a
// Turnstile human check inside the form.
//
// The shape is the standard magic-link card — ask, then confirm — because a
// merchant has seen it before and there is nothing to learn. What it does
// NOT do is tell you whether the address has an account: the service answers
// a stranger exactly as it answers a customer, and this screen says the same
// thing either way, or the pair of them would leak the difference the
// service went to trouble to hide.
//
// Both extras are discovered from /v1/auth/config at runtime, so switching
// them on is a service secret, never a Studio rebuild — and this page keeps
// working, links-only, against a service that has neither.

import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Me } from '../lib/api.ts';

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

/** Load a third-party script once; concurrent callers share the promise. */
const scripts = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { scripts.delete(src); reject(new Error(`could not load ${src}`)); };
      document.head.append(s);
    }));
  }
  return scripts.get(src)!;
}

/** The two vendors' globals, typed only as far as we touch them. */
interface VendorWindow {
  google?: { accounts: { id: {
    initialize(cfg: { client_id: string; callback: (r: { credential: string }) => void }): void;
    renderButton(el: HTMLElement, cfg: Record<string, unknown>): void;
  } } };
  turnstile?: {
    render(el: HTMLElement, cfg: {
      sitekey: string;
      theme?: 'light' | 'dark' | 'auto';
      size?: 'normal' | 'flexible' | 'compact';
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
    }): string;
    reset(id: string): void;
  };
}
const vendor = window as unknown as VendorWindow;

export function SignIn(props: { token: string | null; onSignedIn: (me: Me) => void }) {
  const { token, onSignedIn } = props;
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spending, setSpending] = useState(!!token);
  const [auth, setAuth] = useState<{ googleClientId: string | null; turnstileSiteKey: string | null } | null>(null);

  const googleRef = useRef<HTMLDivElement | null>(null);
  const turnstileRef = useRef<HTMLDivElement | null>(null);
  // The widget's current token, in a ref: it changes without needing a
  // render, and reading it at submit time must see the latest value.
  const turnstileToken = useRef<string | null>(null);
  const turnstileId = useRef<string | null>(null);
  const signingRef = useRef(false);

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

  // Which extras this deployment has. Fails to "neither", so the card is
  // never blocked on the answer.
  useEffect(() => {
    let live = true;
    void api.authConfig().then((cfg) => { if (live) setAuth(cfg); });
    return () => { live = false; };
  }, []);

  // Google's button renders itself into our div once the config says so.
  useEffect(() => {
    const clientId = auth?.googleClientId;
    if (!clientId || spending || sent) return;
    let live = true;
    void loadScript('https://accounts.google.com/gsi/client').then(() => {
      if (!live || !googleRef.current || !vendor.google) return;
      vendor.google.accounts.id.initialize({
        client_id: clientId,
        callback: ({ credential }) => {
          // Guard re-entry: the button stays clickable while we verify.
          if (signingRef.current) return;
          signingRef.current = true;
          setError(null);
          void api.googleSignIn(credential)
            .then(onSignedIn)
            .catch((err) => setError(err instanceof ApiError ? err.message : 'Google sign-in did not work'))
            .finally(() => { signingRef.current = false; });
        },
      });
      vendor.google.accounts.id.renderButton(googleRef.current, {
        theme: 'outline', size: 'large', width: 296, text: 'continue_with',
      });
    }).catch(() => { /* blocked or offline — the email form stands alone */ });
    return () => { live = false; };
  }, [auth, spending, sent, onSignedIn]);

  // Turnstile, likewise. The token it produces is single-use and short-lived;
  // expiry and use both reset the widget so the next submit has a fresh one.
  useEffect(() => {
    const siteKey = auth?.turnstileSiteKey;
    if (!siteKey || spending || sent) return;
    let live = true;
    void loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit').then(() => {
      if (!live || !turnstileRef.current || !vendor.turnstile || turnstileRef.current.childElementCount) return;
      turnstileId.current = vendor.turnstile.render(turnstileRef.current, {
        sitekey: siteKey,
        // Pinned light, not auto: the card is light whatever the OS thinks,
        // and a dark widget inside it reads as a hole. Flexible width makes
        // the widget fill the form like the buttons do.
        theme: 'light',
        size: 'flexible',
        callback: (t) => { turnstileToken.current = t; },
        'expired-callback': () => { turnstileToken.current = null; },
        'error-callback': () => { turnstileToken.current = null; },
      });
    }).catch(() => { /* blocked or offline — the service will refuse and say why */ });
    return () => { live = false; };
  }, [auth, spending, sent]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    if (auth?.turnstileSiteKey && !turnstileToken.current) {
      setError('please complete the check above first');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.requestLink(address, turnstileToken.current ?? undefined);
      setSent(address);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not send the link');
    } finally {
      // Whether it succeeded or the service refused, that token is spent.
      turnstileToken.current = null;
      if (turnstileId.current && vendor.turnstile) vendor.turnstile.reset(turnstileId.current);
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
              Build a 3D product configurator and put it on your store.
              {auth?.googleClientId
                ? ' Use your Google account, or we’ll email you a link — no password either way.'
                : ' We’ll email you a link — there is no password to forget.'}
            </p>
            {auth?.googleClientId && (
              <>
                <div ref={googleRef} className="auth-google" data-testid="google-signin" />
                <div className="auth-or" aria-hidden="true"><span>or</span></div>
              </>
            )}
            <form onSubmit={submit}>
              <label className="auth-field">
                <span className="field-label">Email</span>
                <input
                  type="email" autoComplete="email" required autoFocus
                  data-testid="signin-email" placeholder="you@yourshop.com"
                  value={email} onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              {auth?.turnstileSiteKey && (
                <div ref={turnstileRef} className="auth-turnstile" data-testid="turnstile" />
              )}
              <button className="cta auth-wide" type="submit" data-testid="signin-submit" disabled={busy}>
                {busy ? 'Sending…' : 'Email me a link'}
              </button>
            </form>
          </>
        )}

        {error && <p className="error auth-error" role="alert" data-testid="signin-error">{error}</p>}
      </div>
    </div>
  );
}
