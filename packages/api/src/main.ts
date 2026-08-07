// The only file that decides what the real world is: a Postgres pool, an
// object store, a mail provider, the system clock. Everything else takes
// those as arguments, which is why the tests can run the real routes without
// any of them.

import { createServer } from 'node:http';
import pg from 'pg';
import { createApp, type Config } from './app.ts';
import { migrate, type Sql } from './sql.ts';
import { systemClock } from './ids.ts';
import { consoleMailer, resendMailer } from './mail.ts';
import { fsStore, s3Store, type ObjectStore } from './storage.ts';
import { pruneExpiredSessions, pruneUnclaimedUploads } from './store.ts';

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
};

const pool = new pg.Pool({ connectionString: env('DATABASE_URL') });
const sql: Sql = {
  async query(text, params) {
    const out = await pool.query(text, params as unknown[]);
    return { rows: out.rows as never[], rowCount: out.rowCount ?? 0 };
  },
};

const store: ObjectStore = process.env.S3_BUCKET
  ? await s3Store({
    bucket: env('S3_BUCKET'),
    region: env('S3_REGION', 'auto'),
    endpoint: process.env.S3_ENDPOINT,
    accessKeyId: env('S3_ACCESS_KEY_ID'),
    secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
    cdnBase: process.env.CDN_BASE,
  })
  : fsStore(env('STORAGE_DIR', './.storage'));

const mail = process.env.RESEND_API_KEY
  ? resendMailer(env('RESEND_API_KEY'), env('MAIL_FROM'))
  : consoleMailer();

await migrate(sql);
const app = createApp({ sql, store, clock: systemClock, mail, config });

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
createServer((req, res) => { void app.handle(req, res); }).listen(port, () => {
  console.log(`[api] listening on ${port}; public base ${config.publicBase}`);
  if (!process.env.RESEND_API_KEY) console.log('[api] no mail provider — sign-in links print here');
});
