// End-to-end check of the demo page in a real browser.
//
// The unit tests cover placement and pricing arithmetic; this covers the part
// they can't — that a manifest plus a GLB actually becomes pixels, and that
// clicking a swatch changes them. It earned its keep immediately: quantised
// models carry their de-quantisation scale on the GLB node, and reading the
// geometry without it rendered a 140 mm bar about 2 mm wide. Every unit test
// still passed.
//
//   node configurator/test/demo.smoke.mjs [--shots <dir>]

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', 'demo');
const PORT = 4321;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary',
};

const argv = process.argv.slice(2);
const shotDir = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null;
if (shotDir) mkdirSync(shotDir, { recursive: true });
const shoot = (page, name) => (shotDir ? page.screenshot({ path: join(shotDir, name) }) : Promise.resolve());

const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const path = join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!path.startsWith(ROOT) || !existsSync(path)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({
  // Containers and CI have no GPU; SwiftShader gives a real WebGL context in software.
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !document.querySelector('.cfg-loading'), { timeout: 20000 });
await page.waitForTimeout(1200);

const read = () => page.evaluate(() => ({
  total: document.getElementById('total').textContent,
  payload: JSON.parse(document.getElementById('payload').textContent),
  swatches: document.querySelectorAll('.cfg-swatch').length,
  // Downsample the WebGL canvas so we can prove the render actually changed —
  // a configurator that reports the right colour but draws the old one is the
  // failure mode users notice and tests usually don't.
  pixels: (() => {
    const c = document.querySelector('.cfg-stage canvas');
    const g = document.createElement('canvas');
    g.width = 40; g.height = 30;
    g.getContext('2d').drawImage(c, 0, 0, 40, 30);
    return [...g.getContext('2d').getImageData(0, 0, 40, 30).data].join(',');
  })(),
  // How much of the stage the model covers, as a share of sampled pixels that
  // differ from the background. Catches "renders, but microscopic".
  coverage: (() => {
    const c = document.querySelector('.cfg-stage canvas');
    const g = document.createElement('canvas');
    g.width = 120; g.height = 90;
    const ctx = g.getContext('2d');
    ctx.drawImage(c, 0, 0, 120, 90);
    const d = ctx.getImageData(0, 0, 120, 90).data;
    const bg = [d[0], d[1], d[2]];
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) n++;
    }
    return n / (120 * 90);
  })(),
}));

const amount = (s) => Number(String(s).replace(/[^0-9.]/g, ''));

const step = async (label, action, shot) => {
  if (action) await action();
  await page.waitForTimeout(700);
  const s = await read();
  if (shot) await shoot(page, shot);
  console.log(`\n── ${label}`);
  console.log(`   total ${s.total}   deltas ${JSON.stringify(s.payload.priceDeltas.map((d) => [d.label, d.amount]))}`);
  return s;
};

const a = await step('default', null, '1-default.png');

// Sleeves → Teal. The text links to the sleeves, so it must follow.
const b = await step('sleeves → Teal', async () => {
  await page.click('.cfg-tab:has-text("Sleeves")');
  await page.click('.cfg-swatch[aria-label="Teal"]');
}, '2-teal.png');

const c = await step('body → custom #FF5733', async () => {
  await page.click('.cfg-tab:has-text("Body")');
  await page.click('.cfg-custom-btn');
  await page.fill('.cfg-hex', 'FF5733');
}, '3-custom.png');

// The same bespoke colour on a second part is still one filament change.
const d = await step('tiles → the same custom colour', async () => {
  await page.click('.cfg-tab:has-text("Tiles")');
  await page.click('.cfg-custom-btn');
  await page.fill('.cfg-hex', 'FF5733');
}, '4-custom-shared.png');

const e = await step('stand → Oak', async () => {
  await page.click('.cfg-tab:has-text("Desk stand")');
  await page.click('.cfg-choice:has-text("Oak stand")');
}, '5-stand.png');

await page.click('.cfg-tab:has-text("Text")');
await page.waitForTimeout(300);
const textPanel = await page.evaluate(() => ({
  swatches: document.querySelectorAll('.cfg-swatch').length,
  hasCustom: !!document.querySelector('.cfg-custom-btn'),
}));
await shoot(page, '6-text.png');

console.log('\n══ assertions');
const checks = [
  ['no console errors or failed requests', errors.length === 0, errors.join(' | ')],
  ['all 17 palette swatches render', a.swatches === 17, a.swatches],
  ['model fills a sane share of the stage', a.coverage > 0.05, a.coverage.toFixed(4)],
  ['default total is the base price', amount(a.total) === 129, a.total],
  ['default carries no surcharge', a.payload.priceDeltas.length === 0, a.payload.priceDeltas.length],
  ['canvas repaints on a colour change', a.pixels !== b.pixels, 'identical pixels'],
  ['linked text follows the sleeves', b.payload.colourNames['text-colour'] === 'Teal', b.payload.colourNames['text-colour']],
  ['one custom colour costs 35', c.payload.deltaTotal === 35, c.payload.deltaTotal],
  ['the same colour twice still costs 35', d.payload.deltaTotal === 35, d.payload.deltaTotal],
  ['…and shows as one line, not two', d.payload.priceDeltas.length === 1, d.payload.priceDeltas.length],
  ['the oak stand adds 24', e.payload.deltaTotal === 59, e.payload.deltaTotal],
  ['the cart totals 188', amount(e.total) === 188, e.total],
  ['text offers only colours already in use', textPanel.swatches === 3, textPanel.swatches],
  ['text has no custom-colour button', textPanel.hasCustom === false, textPanel.hasCustom],
];

let failed = 0;
for (const [name, pass, got] of checks) {
  console.log(`${pass ? '  ok  ' : '  FAIL'} ${name}${pass ? '' : `  → ${got}`}`);
  if (!pass) failed++;
}
console.log(failed ? `\n${failed} failed` : `\nall ${checks.length} passed`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
