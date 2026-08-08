// The service, assembled.
//
// `createApp` takes its world as an argument — database, object store,
// mailer, clock — so the tests drive the real routes against a real Postgres
// and never open a socket or send an email. `main.ts` is the only place that
// decides what the real world is.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Sql } from './sql.ts';
import type { ObjectStore } from './storage.ts';
import type { Clock } from './ids.ts';
import type { Mailer } from './mail.ts';
import {
  type Ctx, type Route, match, respond, errorBody, corsHeaders, cookies, clientIp, NO_CONTENT,
} from './http.ts';
import { unauthorised, forbidden, notFound } from './errors.ts';
import { userForSession, type User } from './store.ts';
import { studioRoutes } from './routes/studio.ts';
import { publicRoutes } from './routes/public.ts';

export interface Config {
  /** Where the Studio is served from. Cookie-authenticated requests must
   * come from one of these, which is also the CSRF defence. */
  studioOrigins: string[];
  /** The Studio's URL, used to build sign-in links. */
  appBase: string;
  /** This service's public URL, used to build manifest/model/upload URLs. */
  publicBase: string;
  sessionTtlMs: number;
  loginTtlMs: number;
  /** Workspace and published GLBs. Generous — models are the big thing here. */
  maxModelBytes: number;
  /** Ceiling on customer artwork, before the zone's own `maxBytes` applies. */
  maxImageBytes: number;
  /** Set false only for plain-HTTP local development. */
  cookieSecure: boolean;
  /** See CookieOptions.sameSite — 'none' only when the Studio and this
   * service are on different registrable domains. */
  cookieSameSite: 'lax' | 'none';
  /** Read X-Forwarded-For. True behind a load balancer, false otherwise —
   * see clientIp for why this is not the default. */
  trustProxy: boolean;
  revisionsKept: number;
  /** Set → the Studio shows a "Sign in with Google" button. Public by
   * nature (it ends up in the page), which is why it lives in config while
   * the verification lives in Deps. */
  googleClientId?: string;
  /** Set → the sign-in form carries a Turnstile human check. The paired
   * SECRET never appears here — it is inside Deps.verifyTurnstile. */
  turnstileSiteKey?: string;
}

export const SESSION_COOKIE = 'cfg_session';

export interface Deps {
  sql: Sql;
  store: ObjectStore;
  clock: Clock;
  mail: Mailer;
  config: Config;
  log?: (message: string, err?: unknown) => void;
  /** Absent → Google sign-in is off. Injected so the tests can hand in a
   * fake instead of Google. */
  verifyGoogleToken?: (credential: string) => Promise<{ email: string; name?: string } | null>;
  /** Absent → no human check on the sign-in form. Same injection reasoning. */
  verifyTurnstile?: (token: string, ip?: string) => Promise<boolean>;
}

export interface Session { user: User }

/**
 * Who is calling, if anyone.
 *
 * Cookie only. There is no bearer-token path yet: every authenticated caller
 * today is the Studio in a browser, and adding an API-key scheme before
 * anything needs one is how you end up with two auth paths and one of them
 * untested.
 */
export async function currentUser(deps: Deps, ctx: Ctx): Promise<User | null> {
  const token = cookies(ctx.req)[SESSION_COOKIE];
  if (!token) return null;
  return userForSession(deps.sql, token, deps.clock.now());
}

export async function requireUser(deps: Deps, ctx: Ctx): Promise<User> {
  const user = await currentUser(deps, ctx);
  if (!user) throw unauthorised();
  return user;
}

/**
 * The CSRF check.
 *
 * A cookie-authenticated write must announce an Origin we know. SameSite=Lax
 * already blocks the cross-site form post; this closes the rest, and costs a
 * merchant nothing because the Studio is the only thing that makes these
 * calls.
 */
export function requireStudioOrigin(deps: Deps, ctx: Ctx): void {
  if (ctx.req.method === 'GET' || ctx.req.method === 'OPTIONS') return;
  const { studioOrigins } = deps.config;
  if (!studioOrigins.length) return;   // single-origin dev setups
  if (!ctx.origin || !studioOrigins.includes(ctx.origin)) {
    throw forbidden('this request must come from the Studio');
  }
}

export interface App {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  routes: Route[];
}

export function createApp(deps: Deps): App {
  const log = deps.log ?? ((message: string, err?: unknown) => console.error(`[api] ${message}`, err ?? ''));
  const routes: Route[] = [...studioRoutes(deps), ...publicRoutes(deps)];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://internal');
    const origin = (req.headers.origin ?? '').toLowerCase();
    const method = (req.method ?? 'GET').toUpperCase();

    // Studio routes speak to a credentialed browser app; the published ones
    // are open reads. Which set a path belongs to decides its CORS.
    const isStudioApi = url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/v1/uploads');
    const cors = isStudioApi
      ? corsHeaders(origin, deps.config.studioOrigins, true)
      : corsHeaders(origin, null, false);

    if (method === 'OPTIONS') { respond(res, 204, NO_CONTENT, cors); return; }

    for (const route of routes) {
      if (route.method !== method) continue;
      const params = match(route.pattern, url.pathname);
      if (!params) continue;
      const ctx: Ctx = { req, res, params, query: url.searchParams, origin };
      try {
        const out = await route.handler(ctx);
        if (res.headersSent) return;      // the handler wrote its own response
        const extra = (res as ServerResponse & { _extraHeaders?: Record<string, string> })._extraHeaders ?? {};
        respond(res, out === NO_CONTENT ? 204 : 200, out, { ...cors, ...extra });
      } catch (err) {
        if (res.headersSent) return;
        const { status, body } = errorBody(err, log);
        respond(res, status, body, cors);
      }
      return;
    }
    respond(res, 404, { error: 'not_found', message: `no route for ${method} ${url.pathname}` }, cors);
  }

  return { handle, routes };
}

/** Handlers add response headers (Set-Cookie, Cache-Control) through this,
 * because they return their body rather than writing it. */
export function addHeaders(ctx: Ctx, headers: Record<string, string>): void {
  const res = ctx.res as ServerResponse & { _extraHeaders?: Record<string, string> };
  res._extraHeaders = { ...res._extraHeaders, ...headers };
}

export { clientIp, notFound };
