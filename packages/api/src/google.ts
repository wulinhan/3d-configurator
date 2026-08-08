// "Sign in with Google", verified server-side without a dependency.
//
// The button in the Studio hands the browser an ID TOKEN — a JWT signed by
// Google — and the browser posts it to us. Nothing about that hop is
// trustworthy until the signature checks out against Google's published
// keys, so this file is the whole feature: everything else is the ordinary
// session machinery.
//
// Verified locally rather than via Google's tokeninfo endpoint: one less
// network call on the sign-in path, and the keys cache for an hour.

import crypto from 'node:crypto';

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export type GoogleIdentity = { email: string; name?: string };
export type GoogleVerifier = (credential: string) => Promise<GoogleIdentity | null>;

let cache: { at: number; keys: Map<string, crypto.KeyObject> } | null = null;

/** Google's current signing keys, by key id. Refetched when stale or when a
 * kid we have never seen arrives — which is exactly what key rotation looks
 * like from here. */
async function keyFor(kid: string): Promise<crypto.KeyObject | null> {
  if (!cache || Date.now() - cache.at > 3600_000 || !cache.keys.has(kid)) {
    const res = await fetch(CERTS_URL);
    if (!res.ok) throw new Error(`could not fetch Google's signing keys (${res.status})`);
    const { keys } = await res.json() as { keys: Array<crypto.JsonWebKey & { kid: string }> };
    cache = {
      at: Date.now(),
      keys: new Map(keys.map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })])),
    };
  }
  return cache.keys.get(kid) ?? null;
}

/**
 * A verifier bound to OUR client id.
 *
 * Every check here exists because skipping it admits a real attack: the
 * signature (anyone can mint an unsigned JWT), the audience (a token issued
 * to some other app's client id is not a sign-in to THIS one), the issuer
 * and expiry, and `email_verified` — a Google account can carry an email
 * address its owner never proved, and treating it as proven would let
 * anyone claim anyone.
 *
 * Returns null for anything that does not hold; the route turns that into
 * one uniform "could not be verified" so the response never says which
 * check failed.
 */
export function googleVerifier(clientId: string): GoogleVerifier {
  return async (credential) => {
    const parts = credential.split('.');
    if (parts.length !== 3) return null;

    let header: { alg?: string; kid?: string };
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { return null; }
    if (header.alg !== 'RS256' || !header.kid) return null;

    const key = await keyFor(header.kid);
    if (!key) return null;
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    if (!crypto.verify('RSA-SHA256', signed, key, Buffer.from(parts[2], 'base64url'))) return null;

    if (payload.aud !== clientId) return null;
    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    if (typeof payload.email !== 'string' || payload.email_verified !== true) return null;

    return { email: payload.email, name: typeof payload.name === 'string' ? payload.name : undefined };
  };
}
