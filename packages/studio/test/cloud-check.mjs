// The hosted Studio, end to end — NOT the full smoke suite.
//
// Boots the real service (real Postgres via PGlite, bytes in a Map, mail in
// an array), serves a Studio built against it, and drives a browser through
// the whole thing: sign in with a magic link, land on an empty dashboard,
// create a product, import a model, watch it save, RELOAD to prove it was
// saved, publish, and fetch the published manifest from outside.
//
// The reload is the point. Everything else here could pass while the Studio
// still lost your work on close.
//
//   node --experimental-strip-types test/cloud-check.mjs <dist-dir> <shot-dir>

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../api/src/sql.ts';
import { createApp } from '../../api/src/app.ts';
import { memoryStore } from '../../api/src/storage.ts';
import { consoleMailer } from '../../api/src/mail.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = process.argv[2] ?? join(HERE, '..', 'dist-cloud');
const OUT = process.argv[3];
mkdirSync(OUT, { recursive: true });

const API_PORT = 4402;
const APP_PORT = 4403;
const API = `http://127.0.0.1:${API_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;

// ── the service ───────────────────────────────────────────────────────────
const db = new PGlite();
const sql = {
  async query(text, params) {
    const out = await db.query(text, params);
    return { rows: out.rows, rowCount: out.affectedRows ?? out.rows.length };
  },
};
await migrate(sql);
const mail = consoleMailer(() => {});
const app = createApp({
  sql,
  store: memoryStore(),
  clock: { now: () => new Date() },
  mail,
  log: () => {},
  config: {
    studioOrigins: [APP],
    appBase: APP,
    publicBase: API,
    sessionTtlMs: 30 * 24 * 3600_000,
    loginTtlMs: 15 * 60_000,
    maxModelBytes: 32 * 1024 * 1024,
    maxImageBytes: 4 * 1024 * 1024,
    // Two ports on one host are the SAME SITE, so a Lax cookie crosses
    // between them — exactly as it will between studio.example.com and
    // api.example.com in production.
    cookieSecure: false,
    cookieSameSite: 'lax',
    trustProxy: false,
    revisionsKept: 20,
  },
});
const apiServer = createServer((req, res) => { void app.handle(req, res); });
await new Promise((r) => apiServer.listen(API_PORT, '127.0.0.1', r));

// ── the Studio, with an SPA fallback ──────────────────────────────────────
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const appServer = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  let path = join(DIST, rel === '/' ? 'index.html' : rel);
  // /p/prj_x and /signin are client routes, not files.
  if (!path.startsWith(DIST) || !existsSync(path) || !extname(path)) path = join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((r) => appServer.listen(APP_PORT, '127.0.0.1', r));

// A 60×45×12 plate.
const V = [[0, 0, 0], [60, 0, 0], [60, 45, 0], [0, 45, 0], [0, 0, 12], [60, 0, 12], [60, 45, 12], [0, 45, 12]];
const T = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
  [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
const FIXTURE = zipSync({
  '3D/3dmodel.model': new TextEncoder().encode(
    `<?xml version="1.0"?><model unit="millimeter">
     <resources><object id="1" name="Base" type="model"><mesh>
       <vertices>${V.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices>
       <triangles>${T.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles>
     </mesh></object></resources><build><item objectid="1"/></build></model>`),
});

const checks = [];
const check = (name, pass, got = '') => {
  checks.push([name, pass]);
  console.log(`${pass ? '  ok  ' : '  FAIL'} ${name}${pass ? '' : `  → ${JSON.stringify(got)}`}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e.stack ?? e).slice(0, 500)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('PAGE:', m.text().slice(0, 300)); });

try {
  // ── sign in ─────────────────────────────────────────────────────────────
  await page.goto(APP);
  await page.waitForSelector('[data-testid="signin-card"]', { timeout: 20000 });
  check('a signed-out visitor lands on sign-in, not on an empty editor',
    await page.isVisible('[data-testid="signin-email"]'));
  await page.screenshot({ path: join(OUT, '1-signin.png') });

  await page.fill('[data-testid="signin-email"]', 'ada@example.com');
  await page.click('[data-testid="signin-submit"]');
  await page.waitForSelector('[data-testid="signin-sent"]', { timeout: 20000 });
  const sent = await page.textContent('[data-testid="signin-sent"]');
  check('the confirmation names the address without confirming it has an account',
    /ada@example\.com/.test(sent) && /if /i.test(sent), sent);
  await page.screenshot({ path: join(OUT, '2-signin-sent.png') });

  const token = mail.sent.at(-1).text.match(/#([\w-]+)/)[1];
  await page.goto(`${APP}/signin#${token}`);
  await page.waitForSelector('[data-testid="dash-empty"]', { timeout: 20000 });
  check('the link signs you in and the fragment is wiped from the URL',
    !page.url().includes(token) && page.url().endsWith('/'), page.url());
  check('a new account gets a workshop of its own',
    (await page.textContent('[data-testid="org-name"]')).includes('ada'));
  await page.screenshot({ path: join(OUT, '3-dashboard-empty.png') });

  // ── author ──────────────────────────────────────────────────────────────
  await page.click('[data-testid="new-product"]');
  // The file input is deliberately hidden (the button in the explorer opens
  // it), so wait for it to be ATTACHED rather than visible.
  await page.waitForSelector('[data-testid="back-to-products"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="add-model-input"]', { state: 'attached', timeout: 20000 });
  const projectUrl = page.url();
  check('creating a product opens the editor at its own address',
    /\/p\/prj_[\w-]+$/.test(projectUrl), projectUrl);

  await page.setInputFiles('[data-testid="add-model-input"]', {
    name: 'plate.3mf', mimeType: 'application/octet-stream', buffer: Buffer.from(FIXTURE),
  });
  await page.waitForFunction(() => window.__studio?.manifest?.parts?.length === 1, { timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="save-state"]')?.textContent === 'Saved', { timeout: 30000 });
  check('the editor says so when the work is safe', true);
  await page.screenshot({ path: join(OUT, '4-editor-saved.png') });

  // ── the whole point ─────────────────────────────────────────────────────
  await page.goto(projectUrl);
  await page.waitForFunction(() => window.__studio?.manifest?.parts?.length === 1, { timeout: 30000 });
  await page.waitForFunction(() => window.__studioViewerReady === true, { timeout: 30000 });
  const after = await page.evaluate(() => {
    const m = window.__studio.manifest;
    const v = window.__studioViewer;
    const mesh = v?.meshOf(m.parts[0].id);
    mesh?.geometry.computeBoundingBox();
    const bb = mesh?.geometry.boundingBox;
    return {
      name: m.name,
      part: m.parts[0].label,
      // The saved model is reopened WITHOUT re-orienting: orient it again
      // and every part would jump the first time it was reopened.
      span: bb ? [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z] : null,
    };
  });
  check('a reload brings the product back — manifest and geometry',
    after.part === 'Base' && !!after.span
    && Math.abs(after.span[0] - 60) < 0.5 && Math.abs(after.span[2] - 45) < 0.5, after);

  // ── publish ─────────────────────────────────────────────────────────────
  await page.click('[data-testid="publish-cta"]');
  await page.waitForSelector('[data-testid="publish-now"]', { timeout: 20000 });
  await page.click('[data-testid="publish-now"]');
  await page.waitForSelector('[data-testid="live-url"]', { timeout: 60000 });
  const liveUrl = await page.textContent('[data-testid="live-url"]');
  const snippet = await page.textContent('[data-testid="snippet"]');
  check('publishing hands back a live address, not a download',
    liveUrl.startsWith(`${API}/e/prj_`) && liveUrl.endsWith('/manifest.json'), liveUrl);
  check('and a snippet built on that address', snippet.includes(liveUrl), snippet);
  await page.screenshot({ path: join(OUT, '5-published.png') });

  // Fetched from outside the browser: what a storefront would actually get.
  const served = await (await fetch(liveUrl, { headers: { origin: 'https://shop.example.com' } })).json();
  check('the published manifest is real, and names the upload endpoint',
    served.parts?.length === 1 && served.uploads?.url === `${API}/v1/uploads`
    && !!served.uploads?.publication, served.uploads);

  const version2 = await page.textContent('[data-testid="version-list"]');
  check('the version is listed and marked live', /v1/.test(version2) && /Live/.test(version2), version2);

  await page.click('[data-testid="publish-close"]');
  await page.click('[data-testid="back-to-products"]');
  await page.waitForSelector('[data-testid="project-grid"]', { timeout: 20000 });
  const card = await page.textContent('[data-testid="project-grid"]');
  check('the dashboard now shows it as published', /Published/.test(card), card);
  await page.screenshot({ path: join(OUT, '6-dashboard-published.png') });
} catch (err) {
  console.log(`\nSTOPPED: ${err}`);
  check(`the run got as far as ${checks.length} checks`, false, String(err).slice(0, 300));
} finally {
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  await browser.close();
  apiServer.close();
  appServer.close();
  await db.close();
  process.exit(checks.length && !failed.length ? 0 : 1);
}
