// One thing only: the Manifold WASM loads in the BUILT app and a traced
// template lands as bound, rendering meshes. The full smoke suite covers
// the rest; this is the deploy risk of the Manifold port.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = 4441;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const path = join(DIST, rel === '/' ? 'index.html' : rel);
  if (!path.startsWith(DIST) || !existsSync(path)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

let fail = 0;
const check = (name, ok, got = '') => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name} -> ${JSON.stringify(got)}`); }
};

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__studioViewerReady === true, { timeout: 30000 });

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
  + '<rect x="20" y="20" width="60" height="60" fill="#000"/>'
  + '<rect x="80" y="80" width="60" height="60" fill="#000"/>'  // corner-touching pair
  + '<circle cx="100" cy="100" r="80" fill="none" stroke="#000" stroke-width="8"/></svg>';
await page.setInputFiles('[data-testid="image-template-input"]', {
  name: 'qr-ish.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg),
});
await page.waitForSelector('[data-testid="template-add"]:not([disabled])', { timeout: 20000 });
await page.click('[data-testid="template-add"]');
// splitting is on by default, so the SVG's loose pieces land as their own
// parts — at least the plate plus one piece, exact count is the tracer's
await page.waitForFunction(() => (window.__studio?.manifest?.parts?.length ?? 0) >= 2, { timeout: 30000 });
await page.waitForFunction(() => window.__studioViewerReady === true, { timeout: 30000 });

const m = await page.evaluate(() => window.__studio.manifest);
check('template arrived as plate + pieces',
  m.parts.length >= 2 && m.parts.some((p) => p.id.includes('base')), m.parts.map((p) => p.id));
check('the Manifold-built meshes are bound and non-empty',
  await page.evaluate(() => window.__studio.manifest.parts.every((p) => {
    const mesh = window.__studioViewer.meshOf(p.id);
    return !!mesh && mesh.geometry.getAttribute('position').count > 0;
  })), '');
check('no console errors (WASM loaded cleanly)', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
