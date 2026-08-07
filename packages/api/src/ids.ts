// Identifiers, tokens and the clock — the three things that make a service
// hard to test unless they are injected.

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** Crockford base32 without the ambiguous letters: no I, L, O or U, so an id
 * read aloud or copied out of an email survives the trip. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export type IdPrefix = 'usr' | 'org' | 'prj' | 'rev' | 'pub' | 'ast' | 'upl' | 'ses' | 'lgn';

/** 80 bits of randomness behind a readable prefix. The prefix is for humans
 * reading logs — the entropy is what makes the id unguessable. */
export function newId(prefix: IdPrefix): string {
  const bytes = randomBytes(10);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 32] + ALPHABET[(b >> 3) % 32];
  return `${prefix}_${out.slice(0, 16)}`;
}

/**
 * A secret the user carries: session cookies, magic links.
 *
 * 32 bytes, base64url, never stored as issued — see `hashToken`. The caller
 * emails or sets the return value and keeps only the hash.
 */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What goes in the database. SHA-256 is right here (not bcrypt): these are
 * long random secrets, not passwords, so there is no dictionary to slow an
 * attacker down against — only a lookup to make impossible. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time compare, for the places a hash is checked rather than looked
 * up by. */
export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Time, as a dependency.
 *
 * Expiry is the one behaviour that cannot be tested by waiting, so the clock
 * is injected everywhere and the tests move it by hand.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock the tests drive. */
export function fixedClock(start: Date): Clock & { advance(ms: number): void } {
  let at = start.getTime();
  return {
    now: () => new Date(at),
    advance: (ms: number) => { at += ms; },
  };
}
