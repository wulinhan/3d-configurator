// Targeted check of the image zone's merchant-set wording — NOT the full
// smoke suite. Imports a plate, places a zone on its top face, then reads
// the INK on the veil canvas: the default wording, the merchant's own,
// silence when the field is cleared, and shrink-to-fit for a long line.
//   node test/zone-words-check.mjs <shot-dir>
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const PORT = 4327;
const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });

// A plain 60×45×12 plate — the wording is the subject here, not the mask.
const W = 60, H = 45, D = 12;
const VERTS = [
  [0, 0, 0], [W, 0, 0], [W, H, 0], [0, H, 0],
  [0, 0, D], [W, 0, D], [W, H, D], [0, H, D],
];
const TRIS = [
  [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
  [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
  [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
];
const FIXTURE_3MF = zipSync({
  '3D/3dmodel.model': new TextEncoder().encode(
    `<?xml version="1.0"?><model unit="millimeter">
     <resources><object id="1" name="Base" type="model"><mesh>
       <vertices>${VERTS.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices>
       <triangles>${TRIS.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles>
     </mesh></object></resources>
     <build><item objectid="1"/></build>
    </model>`),
});

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 220)));
const checks = [];
const check = (name, pass, got = '') => {
  checks.push([name, pass]);
  console.log(`${pass ? '  ok  ' : '  FAIL'} ${name}${pass ? '' : `  → ${JSON.stringify(got)}`}`);
};

await page.goto(`http://127.0.0.1:${PORT}/`);
await page.setInputFiles('[data-testid="add-model-input"]', {
  name: 'plate.3mf', mimeType: 'application/octet-stream', buffer: Buffer.from(FIXTURE_3MF),
});
await page.waitForFunction(() => window.__studio?.manifest?.parts?.length === 1, { timeout: 30000 });
await page.waitForFunction(() => window.__studioViewerReady === true, { timeout: 30000 });

const settleCamera = async () => {
  let settled = '';
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(120);
    const now = JSON.stringify(await page.evaluate(() => window.__studioViewer.cameraView()));
    if (now === settled) break;
    settled = now;
  }
};
await page.click('.part-name:has-text("Base")');
await page.waitForTimeout(200);
await page.click('[data-testid="place-image"]');
await page.evaluate(() => window.__studioViewCube.go('Top'));
await settleCamera();
await page.evaluate(() => {
  const v = window.__studioViewer;
  const q = v.meshOf('base').position.clone().project(v.camera);
  const r = document.querySelector('.stage canvas').getBoundingClientRect();
  window.__at = [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height];
});
const at = await page.evaluate(() => window.__at);
await page.mouse.click(at[0], at[1]);
await page.waitForFunction(() => window.__studio?.manifest?.options?.some((o) => o.type === 'upload'), { timeout: 20000 });
await page.waitForTimeout(400);

// The veil's canvas is the zone plane's texture. Ink is anything darker than
// the composited veil itself (r ≈ 226); the label is drawn at r ≈ 79.
const ink = () => page.evaluate(() => {
  const mesh = window.__studioViewer.scene.getObjectByName('image-zone-base-image');
  const canvas = mesh.material.map.image;
  const { width: w, height: h } = canvas;
  const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let count = 0, left = w, right = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4] < 150) {
        count++;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  return { count, span: right < 0 ? 0 : (right - left) / w };
});

const seeded = await page.inputValue('[data-testid="image-placeholder-base-image"]');
check('a new zone opens holding the words it is showing', seeded === 'Image here', seeded);

const base = await ink();
check('the default veil is labelled', base.count > 200 && base.span > 0.1 && base.span < 0.9, base);
await page.screenshot({ path: join(OUT, 'zone-words-default.png') });

const setWords = async (value) => {
  await page.fill('[data-testid="image-placeholder-base-image"]', value);
  await page.waitForTimeout(350);
  return ink();
};

const custom = await setWords('Your logo here');
check('the merchant\'s wording repaints the veil, wider than the default',
  custom.count > 200 && custom.span > base.span + 0.02, { base, custom });
await page.screenshot({ path: join(OUT, 'zone-words-custom.png') });

const silent = await setWords('');
check('clearing the field leaves a bare zone — veil, no words', silent.count === 0, silent);
await page.screenshot({ path: join(OUT, 'zone-words-silent.png') });

const long = await setWords('Upload the artwork you would like printed on this face');
check('a long line shrinks to fit rather than running off the veil',
  long.count > 200 && long.span <= 0.9, long);
await page.screenshot({ path: join(OUT, 'zone-words-long.png') });

// The customer's panel says the same thing as the part.
await page.fill('[data-testid="image-placeholder-base-image"]', 'Your logo here');
await page.waitForTimeout(300);
await page.click('[data-testid="publish-cta"]');
  await page.click('[data-testid="preview-open"]'); // in the publish modal head; closes the modal
await page.waitForSelector('.preview-overlay .cfg-tab', { timeout: 20000 });
await page.click('.preview-overlay .cfg-tab:has-text("Base image")');
await page.waitForTimeout(300);
const panel = await page.evaluate(() =>
  [...document.querySelectorAll('.preview-overlay .cfg-upload .cfg-note')].map((n) => n.textContent));
check('the panel hints the same words as the veil', panel.includes('Your logo here'), panel);

// It follows the merchant, not a default: silence in the Studio is silence
// in the panel too.
await page.click('[data-testid="preview-close"]');
await page.waitForTimeout(300);
await page.fill('[data-testid="image-placeholder-base-image"]', '');
await page.waitForTimeout(300);
await page.click('[data-testid="publish-cta"]');
  await page.click('[data-testid="preview-open"]'); // in the publish modal head; closes the modal
await page.waitForSelector('.preview-overlay .cfg-tab', { timeout: 20000 });
await page.click('.preview-overlay .cfg-tab:has-text("Base image")');
await page.waitForTimeout(300);
const quiet = await page.evaluate(() =>
  [...document.querySelectorAll('.preview-overlay .cfg-upload .cfg-note')].map((n) => n.textContent));
check('a blank field says nothing in the panel either', !quiet.some((t) => /logo|Image here/.test(t)), quiet);

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
