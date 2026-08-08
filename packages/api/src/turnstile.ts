// Cloudflare Turnstile — the human check on the sign-in form.
//
// The widget in the Studio produces a single-use token; only Cloudflare can
// say whether it is real, so verification is one POST to their siteverify
// endpoint with our secret. Anything other than an explicit success —
// including Cloudflare being unreachable — counts as failure, because the
// endpoint this guards sends email, and "the checker was down" must not be
// a way to make us send email.

export type TurnstileVerifier = (token: string, ip?: string) => Promise<boolean>;

export function turnstileVerifier(secret: string): TurnstileVerifier {
  return async (token, ip) => {
    try {
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      });
      if (!res.ok) return false;
      const body = await res.json() as { success?: boolean };
      return body.success === true;
    } catch {
      return false;
    }
  };
}
