// The custom-site integration, exactly as docs/custom.md tells a developer to
// write it — in a real browser.
//
// The three platform guides lean on a plugin or a theme block; a bespoke
// storefront leans on the API surface directly, so that surface is a promise
// this repository makes to somebody else's codebase. This drives the guide's
// own code: programmatic mount(), the returned handle, the DOM event, the
// payload-on-mount, and post() re-emission.
//
// The payload-on-mount is the one worth pinning. Without it every integration
// silently loses the DEFAULT configuration — a customer who likes the product
// as it opens and clicks straight through would produce an order with no
// specification on it at all, and nothing in a unit test would notice.
//
//   node test/custom-mount-check.mjs

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', 'apps', 'demo');
const PORT = 4324;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary',
};

const MANIFEST = '/tap-bar-3.manifest.json';

// A page with NO data-configurator attribute: auto-mount must not fire, so
// everything here is the documented programmatic path.
const PAGE = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/embed.css">
<div id="host" style="width:1100px;height:620px"></div>
<script type="module">
  import { mount } from '/embed.js';
  // Exactly the listener docs/custom.md prints.
  window.__seen = [];
  document.addEventListener('configurator:change', (e) => { window.__seen.push(e.detail); });
  const manifestUrl = '${MANIFEST}';
  window.__cfg = await mount({
    root: document.getElementById('host'),
    manifest: await (await fetch(manifestUrl)).json(),
    baseUrl: new URL(manifestUrl, location.href).href,
  });
  window.__ready = true;
</script>`;

const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
    return;
  }
  // The bare harness page has no icon; answer it so the strict console-error
  // check below is not spending its life on our own 404.
  if (rel === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const path = join(ROOT, rel);
  if (!path.startsWith(ROOT) || !existsSync(path)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });

const checks = [];
const check = (name, pass, got) => { checks.push([name, pass, got]); };

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('.cfg-loading'), { timeout: 30000 });

  // ── the handle mount() resolves with ──────────────────────────────────────
  const handle = await page.evaluate(() => ({
    keys: Object.keys(window.__cfg).sort(),
    postIsFn: typeof window.__cfg.post === 'function',
    productId: window.__cfg.manifest.id,
    selectionKeys: Object.keys(window.__cfg.selections).length,
  }));
  check('mount() resolves with viewer, selections, manifest, post',
    JSON.stringify(handle.keys) === JSON.stringify(['manifest', 'post', 'selections', 'viewer']), handle.keys);
  check('post() is callable for re-emitting on demand', handle.postIsFn, handle.postIsFn);
  check('the manifest comes back on the handle', !!handle.productId, handle.productId);
  check('selections are populated from the manifest defaults', handle.selectionKeys > 0, handle.selectionKeys);

  // ── a payload before the customer touches anything ────────────────────────
  const first = await page.evaluate(() => window.__seen[0] ?? null);
  check('a payload is emitted on mount, with no interaction', !!first, first);
  check('…and it is the documented event shape', first?.type === 'configurator:change', first?.type);
  check('…carrying the default selections', !!first && Object.keys(first.selections).length > 0,
    first && Object.keys(first.selections).length);
  check('…and a currency for the cart to format with', !!first?.currency, first?.currency);
  check('the default configuration costs nothing extra',
    first?.deltaTotal === 0 && first?.priceDeltas.length === 0, first?.deltaTotal);

  // The demo manifest is self-hosted (no service behind it), so there is no
  // publication to pin — the field is absent rather than empty, which is what
  // the guide tells the developer to branch on.
  check('publicationId is absent when the manifest is self-hosted',
    !('publicationId' in (first ?? {})), first?.publicationId);

  // ── a real change produces a new payload ──────────────────────────────────
  const before = await page.evaluate(() => window.__seen.length);
  const rawBefore = await page.evaluate(() => JSON.stringify(window.__cfg.selections));
  await page.click('.cfg-tab');
  await page.waitForTimeout(150);
  const swatches = await page.$$('.cfg-swatch');
  await swatches[swatches.length - 1].click();
  await page.waitForFunction((n) => window.__seen.length > n, before, { timeout: 10000 });

  const latest = await page.evaluate(() => window.__seen[window.__seen.length - 1]);
  check('changing a swatch emits a fresh payload',
    JSON.stringify(latest.selections) !== JSON.stringify(first.selections), latest.selections);
  check('colourNames names the colour for a pick list',
    Object.keys(latest.colourNames ?? {}).length > 0, latest.colourNames);

  // The handle's `selections` is the LIVE, RAW state — it moves with the
  // customer, but it is not the payload's `selections`, which are resolved
  // (a linked colour reads as "@other-option" raw and as the actual hex once
  // resolved). Integrations must read the payload, not this object; the guide
  // says so because this check proved the two genuinely differ.
  const rawAfter = await page.evaluate(() => JSON.stringify(window.__cfg.selections));
  check('the handle\'s selections object is live', rawAfter !== rawBefore, rawAfter);
  check('…and is RAW, so the payload stays the thing to read',
    rawAfter !== JSON.stringify(latest.selections), 'raw and resolved happened to match');

  // ── post() re-emits on demand ─────────────────────────────────────────────
  const n = await page.evaluate(() => { const was = window.__seen.length; window.__cfg.post(); return was; });
  const after = await page.evaluate(() => window.__seen.length);
  check('post() re-emits the current state without a change', after === n + 1, `${n} → ${after}`);

  check('no console errors across the whole session', errors.length === 0, errors.join(' | '));
} catch (err) {
  check(`the run got as far as ${checks.length} checks`, false, String(err).slice(0, 300));
} finally {
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok, got] of checks) console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  → ${JSON.stringify(got)}`}`);
  console.log(`\n${failed.length ? `${failed.length} of ${checks.length} failed` : `all ${checks.length} passed`}`);
  await browser.close();
  server.close();
  process.exit(checks.length && !failed.length ? 0 : 1);
}
