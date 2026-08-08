// The only file that decides what the real world is: a Postgres pool, an
// object store, a mail provider, the system clock. Everything else takes
// those as arguments, which is why the tests can run the real routes without
// any of them.

import { createServer } from 'node:http';
import pg from 'pg';
import { createApp, type Config } from './app.ts';
import { migrate, cleanConnectionString, type Sql } from './sql.ts';
import { systemClock } from './ids.ts';
import { consoleMailer, resendMailer } from './mail.ts';
import { fsStore, s3Store, type ObjectStore } from './storage.ts';
import { pruneExpiredSessions, pruneUnclaimedUploads } from './store.ts';
import { googleVerifier } from './google.ts';
import { turnstileVerifier } from './turnstile.ts';

const env = (key: string, fallback?: string): string => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) throw new Error(`${key} is required`);
  return value;
};
const list = (key: string): string[] =>
  (process.env[key] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const config: Config = {
  studioOrigins: list('STUDIO_ORIGINS'),
  appBase: env('APP_BASE', 'http://localhost:5173'),
  publicBase: env('PUBLIC_BASE', 'http://localhost:4400'),
  sessionTtlMs: Number(env('SESSION_TTL_DAYS', '30')) * 24 * 3600_000,
  loginTtlMs: Number(env('LOGIN_TTL_MINUTES', '15')) * 60_000,
  maxModelBytes: Number(env('MAX_MODEL_BYTES', String(64 * 1024 * 1024))),
  maxImageBytes: Number(env('MAX_IMAGE_BYTES', String(8 * 1024 * 1024))),
  cookieSecure: env('COOKIE_SECURE', 'true') !== 'false',
  cookieSameSite: env('COOKIE_SAMESITE', 'lax') === 'none' ? 'none' : 'lax',
  trustProxy: env('TRUST_PROXY', 'false') === 'true',
  revisionsKept: Number(env('REVISIONS_KEPT', '50')),
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  turnstileSiteKey: process.env.TURNSTILE_SITE_KEY,
};

// Turnstile is a PAIR: the site key renders the widget, the secret verifies
// its tokens. One without the other would either show a widget nothing
// checks, or demand a token nothing can produce — refuse to half-start
// rather than let sign-in break quietly.
if (!!process.env.TURNSTILE_SITE_KEY !== !!process.env.TURNSTILE_SECRET) {
  throw new Error('TURNSTILE_SITE_KEY and TURNSTILE_SECRET must be set together (or neither)');
}

// A pasted secret often arrives wearing its `.env` prefix, its console
// label, or the quotes from a psql snippet — see cleanConnectionString.
const { url: databaseUrl, cleaned } = cleanConnectionString(env('DATABASE_URL'));
if (cleaned) {
  console.warn('[api] DATABASE_URL had extra text around the connection string — '
    + 'using the URL found inside it; tidy the secret when convenient');
}
const pool = new pg.Pool({
  connectionString: databaseUrl,
  // Managed Postgres (Neon, Supabase, RDS) is reached across the internet,
  // so TLS is verified rather than merely used. The `rejectUnauthorized:
  // false` that most guides copy turns the encryption into decoration —
  // it accepts any certificate, including an attacker's.
  ssl: /sslmode=(require|verify-ca|verify-full)/.test(databaseUrl)
    ? { rejectUnauthorized: true }
    : undefined,
  // Neon's pooled endpoint multiplexes for us; this cap is about not letting
  // one instance monopolise it.
  max: Number(env('DB_POOL_MAX', '10')),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
// An idle client that dies — a database restart, a network blip — emits on
// the POOL, and an unhandled 'error' event takes the process down. Logging
// it lets the pool discard the client and carry on, which is what it is for.
pool.on('error', (err) => console.error('[api] idle client error', err));

const sql: Sql = {
  async query(text, params) {
    const out = await pool.query(text, params as unknown[]);
    return { rows: out.rows as never[], rowCount: out.rowCount ?? 0 };
  },
};

/**
 * A CDN base the BROWSER can actually read from.
 *
 * R2's `pub-….r2.dev` address is Cloudflare's "public development URL", and
 * it answers with no CORS headers whatever the bucket's CORS policy says —
 * that policy only applies to a custom domain and the S3 API. A model
 * served from there downloads fine and is then unreadable to the page that
 * asked for it, so the configurator renders an empty viewport on every
 * storefront while every URL in the chain returns 200.
 *
 * Ignoring it is better than honouring it: the service streams the model
 * itself, which costs Fly egress but WORKS. Silently, though, would be its
 * own trap — hence the noise.
 */
const cdnBase = (() => {
  const base = process.env.CDN_BASE;
  if (!base) return undefined;
  if (/(^|\/\/)[^/]*\.r2\.dev(\/|$)/.test(base)) {
    console.warn('[api] IGNORING CDN_BASE — an r2.dev address serves no CORS headers, so the'
      + ' browser cannot read the model and every configurator would render empty.'
      + ' Serving models through the service instead. To use the CDN, attach an R2 CUSTOM'
      + ' DOMAIN (models.your-domain.com) and set CDN_BASE to that.');
    return undefined;
  }
  return base;
})();

const store: ObjectStore = process.env.S3_BUCKET
  ? await s3Store({
    bucket: env('S3_BUCKET'),
    region: env('S3_REGION', 'auto'),
    endpoint: process.env.S3_ENDPOINT,
    accessKeyId: env('S3_ACCESS_KEY_ID'),
    secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
    cdnBase,
  })
  : fsStore(env('STORAGE_DIR', './.storage'));

const mail = process.env.RESEND_API_KEY
  ? resendMailer(env('RESEND_API_KEY'), env('MAIL_FROM'))
  : consoleMailer();

// Boot narrates itself. When a platform reports nothing but "health checks
// never passed", the app's own log is the only place the real reason lives,
// and a silent startup makes "cannot reach the database" and "crashed on a
// bad config" look identical.
console.log(`[api] starting — port ${env('PORT', '4400')}, public base ${config.publicBase}`);

// Say WHICH host and database, parsed out of the URL. A malformed
// DATABASE_URL fails as `getaddrinfo ENOTFOUND <whatever pg made of it>`,
// which is a puzzle; "database host: base" is not. The password is never
// printed — only the parts that identify the wrong value.
try {
  const parsed = new URL(databaseUrl);
  console.log(`[api] database host ${parsed.hostname}, db ${parsed.pathname.replace('/', '') || '(none)'}`);
  if (!parsed.hostname.includes('.')) {
    console.error(`[api] "${parsed.hostname}" is not a hostname — DATABASE_URL looks like it has`
      + ' stray text in it. It must be the connection string ALONE, on one line,'
      + ' with no label, quotes or line break.');
  }
} catch {
  // The trap the real deploy fell into: Neon's console has a field labelled
  // "Pooler host", and a host alone is not a connection string. Name that
  // case specifically, with the host they gave folded into the template —
  // a generic "not a URL" sent three deploys in a row to the same failure.
  if (/^[\w-]+(\.[\w-]+)+/.test(databaseUrl) && !databaseUrl.includes('://')) {
    console.error(`[api] DATABASE_URL is just a HOSTNAME. It must be the whole connection string:`
      + ` postgresql://USER:PASSWORD@${databaseUrl.split('/')[0]}/DBNAME?sslmode=require`
      + ' — copy the "Connection string" from Neon, not the host field.');
  }
  console.error('[api] DATABASE_URL is not a URL at all — paste the connection string alone,'
    + ' with no "DATABASE_URL=" prefix and no surrounding quotes.');
}

try {
  const probe = await sql.query<{ now: Date }>('select now() as now');
  console.log(`[api] database reachable (${probe.rows[0]?.now?.toISOString?.() ?? 'ok'})`);
} catch (err) {
  console.error('[api] CANNOT REACH THE DATABASE — check DATABASE_URL (pooled host, sslmode=require)');
  throw err;
}
await migrate(sql);
console.log('[api] schema applied');

const app = createApp({
  sql, store, clock: systemClock, mail, config,
  verifyGoogleToken: process.env.GOOGLE_CLIENT_ID ? googleVerifier(env('GOOGLE_CLIENT_ID')) : undefined,
  verifyTurnstile: process.env.TURNSTILE_SECRET ? turnstileVerifier(env('TURNSTILE_SECRET')) : undefined,
});

// Housekeeping, in-process. Sessions that have expired and artwork nobody
// ordered — an abandoned basket must not become storage the merchant pays
// for forever.
const HOUR = 3600_000;
setInterval(() => {
  void (async () => {
    try {
      await pruneExpiredSessions(sql, new Date());
      const keys = await pruneUnclaimedUploads(sql, new Date(Date.now() - 24 * HOUR));
      for (const key of keys) await store.delete(key);
    } catch (err) {
      console.error('[api] janitor', err);
    }
  })();
}, HOUR).unref();

const port = Number(env('PORT', '4400'));
const server = createServer((req, res) => { void app.handle(req, res); });
server.listen(port, () => {
  console.log(`[api] listening on ${port}; public base ${config.publicBase}`);
  if (!process.env.RESEND_API_KEY) console.log('[api] no mail provider — sign-in links print here');
  if (!process.env.S3_BUCKET) console.log('[api] no object store — bytes go to local disk');
  console.log(`[api] Google sign-in ${config.googleClientId ? 'on' : 'off'}; `
    + `Turnstile ${config.turnstileSiteKey ? 'on' : 'off'}`);
});

// A deploy replaces machines, and a merchant mid-publish is streaming a
// multi-megabyte model. Stop accepting new connections, let the ones in
// flight finish, then close the pool — rather than dropping a publish on
// the floor and leaving a half-written asset behind.
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    console.log(`[api] ${signal} — draining`);
    server.close(() => { void pool.end().then(() => process.exit(0)); });
    // A client holding a connection open must not hold the deploy open too.
    setTimeout(() => process.exit(0), 15_000).unref();
  });
}
