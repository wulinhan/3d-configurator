// The customiser on a PHONE — emulated touch, 390px wide, pointer: coarse.
//
// Three failure modes this guards, each of which reads as "works on my
// desktop": a page you cannot scroll because the full-width canvas eats
// every vertical swipe; iOS zooming the whole page (and sticking) because a
// focused input's font is under 16px; and a stray pixel of horizontal
// overflow giving the page a sideways wobble. Plus the narrow-container
// layout: the parts rail must stack above the controls, not crush them.
//
//   node test/mobile-check.mjs

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', 'apps', 'demo');
const PORT = 4331;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary',
};

const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const path = join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!path.startsWith(ROOT) || !existsSync(path)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(PORT, r));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

// ── the phone ──────────────────────────────────────────────────────────────
{
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,   // pointer: coarse — what the CSS and the viewer key on
  });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('.cfg-loading'), { timeout: 30000 });
  await page.waitForTimeout(800);

  check('the phone reports a coarse pointer (the emulation the checks rely on)',
    await page.evaluate(() => matchMedia('(pointer: coarse)').matches));
  check('no horizontal overflow anywhere on the page',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })));

  // A vertical swipe on the product must be allowed to SCROLL — the classic
  // embedded-3D trap is touch-action:none across a full-width stage.
  check('the canvas leaves vertical swipes to the page (touch-action: pan-y)',
    await page.evaluate(() => getComputedStyle(document.querySelector('.cfg-stage canvas')).touchAction === 'pan-y'),
    await page.evaluate(() => getComputedStyle(document.querySelector('.cfg-stage canvas')).touchAction));

  check('the parts rail stacks above the controls (single-column config box)',
    await page.evaluate(() => getComputedStyle(document.querySelector('.cfg-config'))
      .gridTemplateColumns.split(' ').length === 1),
    await page.evaluate(() => getComputedStyle(document.querySelector('.cfg-config')).gridTemplateColumns));

  check('tabs and swatches are comfortable touch targets (≥44px, ≥40px)',
    await page.evaluate(() => {
      const tab = document.querySelector('.cfg-tab').getBoundingClientRect();
      const sw = document.querySelector('.cfg-swatch').getBoundingClientRect();
      return tab.height >= 44 && sw.height >= 40;
    }),
    await page.evaluate(() => ({
      tab: document.querySelector('.cfg-tab').getBoundingClientRect().height,
      swatch: document.querySelector('.cfg-swatch').getBoundingClientRect().height,
    })));

  // iOS zooms — and stays zoomed — on any focused input under 16px. The
  // demo's typed field is the custom-colour hex box on the Body tab.
  await page.click('.cfg-tab:has-text("Body")');
  await page.click('.cfg-custom-btn');
  await page.waitForTimeout(300);
  check('text inputs are 16px on touch, so iOS never zoom-locks the page',
    await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.cfg-hex')).fontSize) >= 16),
    await page.evaluate(() => getComputedStyle(document.querySelector('.cfg-hex'))?.fontSize));

  // Summary pills wrap inside the phone width rather than forcing a scroll.
  check('summary pills stay inside the viewport',
    await page.evaluate(() => [...document.querySelectorAll('.cfg-summary-row')]
      .every((r) => r.getBoundingClientRect().right <= window.innerWidth + 1)));

  await page.close();
}

// ── the desktop keeps full orbit capture ───────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('.cfg-loading'), { timeout: 30000 });
  check('a mouse still gets full capture (touch-action: none on fine pointers)',
    await page.evaluate(() => getComputedStyle(document.querySelector('.cfg-stage canvas')).touchAction === 'none'),
    await page.evaluate(() => getComputedStyle(document.querySelector('.cfg-stage canvas')).touchAction));
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${fail ? `${fail} failed, ` : 'all '}${pass} passed\n`);
process.exit(fail ? 1 : 0);
