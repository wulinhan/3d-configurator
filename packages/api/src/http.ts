// A router, a body reader and the CORS rules. No framework — the same
// reasoning as the embed: this service does one small thing, and a
// dependency that owns its request lifecycle would be the largest thing in
// the repository.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, badRequest, tooLarge } from './errors.ts';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  /** Path segments captured by the route pattern (`:id` → params.id). */
  params: Record<string, string>;
  query: URLSearchParams;
  /** The request's Origin header, lowercased, or ''. */
  origin: string;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

export interface Route {
  method: Method;
  /** `/v1/projects/:id/model` — `:name` captures one segment. */
  pattern: string;
  handler: Handler;
}

/** Sent instead of a JSON body when a handler answers with bytes or has
 * already written the response itself. */
export class Raw {
  bytes: Uint8Array;
  contentType: string;
  headers: Record<string, string>;
  constructor(bytes: Uint8Array, contentType: string, headers: Record<string, string> = {}) {
    this.bytes = bytes;
    this.contentType = contentType;
    this.headers = headers;
  }
}

export class Redirect {
  location: string;
  status: number;
  constructor(location: string, status = 302) {
    this.location = location;
    this.status = status;
  }
}

/** No content. */
export const NO_CONTENT = Symbol('no-content');

const segments = (path: string) => path.split('/').filter(Boolean);

export function match(pattern: string, path: string): Record<string, string> | null {
  const p = segments(pattern);
  const s = segments(path);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

/**
 * Read the whole body, refusing anything over the limit.
 *
 * The check is on bytes ARRIVING, not on Content-Length: a client that lies
 * about its length would otherwise stream us out of memory while we trusted
 * the header.
 */
export async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > limit) throw tooLarge(`body over ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export async function readJson<T>(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<T> {
  const bytes = await readBody(req, limit);
  if (!bytes.length) return {} as T;
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
  } catch {
    throw badRequest('body must be JSON');
  }
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  secure: boolean;
  /**
   * `lax` is right whenever the Studio and this service share a registrable
   * domain — studio.example.com and api.example.com are the SAME SITE, and
   * so are two ports on localhost, because a port is not part of a site.
   * Put them on genuinely different domains and the browser will drop the
   * session cookie silently; `none` is the escape hatch, and it REQUIRES
   * Secure, which is enforced below rather than left as a footnote.
   */
  sameSite?: 'lax' | 'none';
  path?: string;
}

export function cookieHeader(name: string, value: string, o: CookieOptions): string {
  const sameSite = o.sameSite ?? 'lax';
  const secure = o.secure || sameSite === 'none';
  const bits = [
    `${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? '/'}`, 'HttpOnly',
    `SameSite=${sameSite === 'none' ? 'None' : 'Lax'}`,
  ];
  if (secure) bits.push('Secure');
  if (o.maxAgeSeconds != null) bits.push(`Max-Age=${o.maxAgeSeconds}`);
  return bits.join('; ');
}

/**
 * CORS for the two audiences this service has.
 *
 * The Studio sends cookies, so its origins must be echoed exactly and
 * allow-listed by configuration — `*` is not even legal with credentials.
 * The published endpoints send no cookies and are read by whichever
 * storefront the merchant allowed, so they answer per-project (see
 * `allowedOrigin`), and an empty list there means "anywhere", which is how a
 * project starts.
 */
export function corsHeaders(origin: string, allowed: string[] | null, credentials: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, x-configurator-studio',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
  if (allowed === null || allowed.length === 0) {
    // No credentials are involved on the open endpoints, so a wildcard here
    // grants nothing a plain <script> tag could not already fetch.
    headers['access-control-allow-origin'] = credentials ? origin : '*';
  } else if (origin && allowed.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
  }
  if (credentials) headers['access-control-allow-credentials'] = 'true';
  return headers;
}

/** Does this storefront get to embed this product? An empty allowlist is
 * open — a merchant's first integration must not fail on a setting they have
 * not been told about yet. */
export const allowedOrigin = (origin: string, allowed: string[]): boolean =>
  allowed.length === 0 || allowed.includes(origin);

/**
 * A fixed-window limiter, per process.
 *
 * Enough to blunt a script hammering magic links or uploads. It is NOT a
 * distributed limiter: run more than one instance and each gets its own
 * window, so the real ceiling is the limit times the instance count. Say so
 * here rather than discovering it during an incident.
 */
export function rateLimiter(limit: number, windowMs: number) {
  const seen = new Map<string, { count: number; resetAt: number }>();
  return (key: string, now: number): boolean => {
    const entry = seen.get(key);
    if (!entry || entry.resetAt <= now) {
      seen.set(key, { count: 1, resetAt: now + windowMs });
      // Opportunistic sweep — this map must not become the leak.
      if (seen.size > 10_000) for (const [k, v] of seen) if (v.resetAt <= now) seen.delete(k);
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
  };
}

/** The client's address, honouring a proxy header only when we are told to
 * trust one — reading X-Forwarded-For unconditionally lets any caller
 * choose their own rate-limit bucket. */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function respond(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (body === NO_CONTENT) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  if (body instanceof Raw) {
    res.writeHead(status, { 'content-type': body.contentType, ...headers, ...body.headers });
    res.end(Buffer.from(body.bytes));
    return;
  }
  if (body instanceof Redirect) {
    res.writeHead(body.status, { location: body.location, ...headers });
    res.end();
    return;
  }
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(text);
}

export function errorBody(err: unknown, log: (message: string, err: unknown) => void): { status: number; body: unknown } {
  if (err instanceof ApiError) {
    return { status: err.status, body: { error: err.code, message: err.message, detail: err.detail } };
  }
  // Anything unrecognised is our bug. It goes to the log in full and to the
  // client as nothing at all.
  log('unhandled', err);
  return { status: 500, body: { error: 'internal', message: 'something went wrong' } };
}
