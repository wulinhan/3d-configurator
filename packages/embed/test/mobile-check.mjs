// The customiser on a PHONE — emulated touch, 390px wide, pointer: coarse.
//
// The contract under test: the CANVAS owns every touch (one finger orbits,
// it never scrolls the page), and in exchange the stage is STICKY at the
// viewport top so the part list and controls scroll past underneath it —
// the product never scrolls out of view. Plus the classic mobile traps
// that each read as "works on my desktop": iOS zooming the whole page (and
// sticking) because a focused input's font is under 16px; a stray pixel of
// horizontal overflow giving the page a sideways wobble; and the
// narrow-container layout, where the parts rail must stack above the
// controls rather than crush them.
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

  // A touch on the product ORBITS it — it must never scroll the page.
  // (Scrolling belongs to the panel below; the sticky stage keeps the
  // product in view while that happens.)
  check('the canvas keeps every touch for the orbit (touch-action: none)',
    await page.evaluate(() => getComputedStyle(document.querySelector('.cfg-stage canvas')).touchAction === 'none'),
    await page.evaluate(() => getComputedStyle(document.querySelector('.cfg-stage canvas')).touchAction));

  // The stage pins to the top of the viewport…
  check('the stage is sticky at the viewport top',
    await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector('.cfg-stage'));
      return s.position === 'sticky' && parseFloat(s.top) === 0;
    }),
    await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector('.cfg-stage'));
      return { position: s.position, top: s.top };
    }));

  // …and holds there while the panel scrolls under it. Scroll far enough
  // that the stage would have left the viewport if it were in normal flow.
  check('scrolling slides the panel under the stage, not the stage away',
    await page.evaluate(async () => {
      const stage = document.querySelector('.cfg-stage');
      const flowTop = stage.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, flowTop + stage.getBoundingClientRect().height);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const rect = stage.getBoundingClientRect();
      const stuck = window.scrollY > flowTop && Math.abs(rect.top) <= 1;
      window.scrollTo(0, 0);
      return stuck;
    }),
    await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      stageTop: document.querySelector('.cfg-stage').getBoundingClientRect().top,
    })));

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
