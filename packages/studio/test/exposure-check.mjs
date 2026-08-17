// Can a customer tell white from silver — or does the render blow the
// highlights out and hand back the same flat 255?
//
// The marketing site's older configurators did exactly that: their lights
// summed past full scale, so every light colour clipped to one white. The
// Studio's viewer is built not to (filmic tone mapping, a small ambient
// share, colour-managed sRGB), and this proves it on real pixels rather
// than on trust — at the default staging AND at the brightest a merchant
// can crank the Light slider, which is the setting that could put the
// fault back.
//
//   node test/exposure-check.mjs

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = 4457;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm',
};
const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const path = join(DIST, rel === '/' ? 'index.html' : rel);
  if (!path.startsWith(DIST) || !existsSync(path)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(PORT, r));

let fail = 0;
const check = (name, ok, got = '') => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name} -> ${JSON.stringify(got)}`); }
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__studioViewerReady === true, { timeout: 30000 });

// A cuboid gives a big flat top facing the key light — the exact surface
// the marketing configurators blew out.
await page.click('[data-testid="new-shape"]');
await page.click('[data-testid="shape-add"]');
await page.waitForFunction(() => (window.__studio?.manifest?.parts?.length ?? 0) === 1, { timeout: 20000 });
await page.waitForFunction(() => window.__studioViewerReady === true, { timeout: 30000 });
await page.waitForTimeout(600);

/** Paint every part one colour, drop the selection chrome, then read the
 * model where it certainly is: a box at the middle of the stage. Picking
 * pixels by colour would quietly discard the very whites under test. */
const sample = async (hex) => page.evaluate(async (h) => {
  const v = window.__studioViewer;
  v.highlight(null);
  v.setSelectionEmphasis(null); // the white rim would read as blown-out pixels
  for (const p of window.__studio.manifest.parts) {
    const m = v.meshOf(p.id);
    if (m?.material) m.material.color.set(h);
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const c = document.querySelector('.stage canvas');
  const g = document.createElement('canvas');
  g.width = c.width; g.height = c.height;
  g.getContext('2d').drawImage(c, 0, 0);
  const half = Math.round(Math.min(c.width, c.height) * 0.10);
  const box = g.getContext('2d').getImageData(
    Math.round(c.width / 2) - half, Math.round(c.height / 2) - half, half * 2, half * 2).data;
  let n = 0, pure = 0, sum = 0, peak = 0;
  for (let i = 0; i < box.length; i += 4) {
    const r = box[i], gg = box[i + 1], b = box[i + 2];
    const L = 0.299 * r + 0.587 * gg + 0.114 * b;
    n++; sum += L; peak = Math.max(peak, L);
    if (r === 255 && gg === 255 && b === 255) pure++;
  }
  return { n, mean: Math.round(sum / n), peak: Math.round(peak), pctPure: +(100 * pure / n).toFixed(2) };
}, hex);

const WHITE = '#FEFEFE', SILVER = '#C8C8C8';

// Default staging, then the two knobs a merchant can push: Light to its
// maximum and Reflect to its maximum. Colours must stay apart at all of
// them — a slider should not be able to reinstate the fault.
const cases = [
  ['default staging', {}, 40],
  ['Light slider at max', { exposure: 1.0 }, 10],
  ['Reflect slider at max', { env: 1.0 }, 10],
];
for (const [label, knobs, minGap] of cases) {
  await page.evaluate((k) => {
    const v = window.__studioViewer;
    if (k.exposure !== undefined) v.renderer.toneMappingExposure = k.exposure;
    if (k.env !== undefined) v.scene.environmentIntensity = k.env;
  }, knobs);
  const w = await sample(WHITE);
  const s = await sample(SILVER);
  const gap = w.mean - s.mean;
  console.log(`\n${label}: white ${w.mean} (${w.pctPure}% pure) · silver ${s.mean} · gap ${gap}`);
  check(`${label}: white never blows out to a flat sheet`, w.pctPure < 1, w);
  check(`${label}: white still reads bright`, w.mean >= 200, w.mean);
  check(`${label}: silver stays clearly apart from white (>=${minGap})`, gap >= minGap, { white: w.mean, silver: s.mean, gap });
  await page.evaluate(() => {
    const v = window.__studioViewer;
    v.renderer.toneMappingExposure = 0.6;
    v.scene.environmentIntensity = 0.5;
  });
}

// and the one combination that DOES flatten must be called out, not hidden
const warns = await page.evaluate(() => {
  const f = window.__studioHighlightsFlatten;
  return f ? [f(undefined, undefined), f(1.0, 0.5), f(0.6, 1.0), f(1.0, 1.0)] : null;
});
if (warns) {
  check('the flattening warning stays quiet at sane settings', warns[0] === false && warns[1] === false && warns[2] === false, warns);
  check('…and fires when both sliders are maxed together', warns[3] === true, warns);
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
