// Targeted check of the curved-text flow — NOT the full smoke suite.
// Imports a plate, places a text slot on its top face, bends the run and
// asserts the glyph mesh arches on the model; screenshots the result.
//   node test/text-bend-check.mjs <shot-dir>
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { zipSync } from 'fflate';

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = 4327;
const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });

const box = (w, h, d) => {
  const verts = [
    [0, 0, 0], [w, 0, 0], [w, h, 0], [0, h, 0],
    [0, 0, d], [w, 0, d], [w, h, d], [0, h, d],
  ];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
  const tris = quads.flatMap(([a, b, c, dd]) => [[a, b, c], [a, c, dd]]);
  return `<vertices>${verts.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices>` +
    `<triangles>${tris.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles>`;
};
const FIXTURE_3MF = zipSync({
  '3D/3dmodel.model': new TextEncoder().encode(
    `<?xml version="1.0"?><model unit="millimeter">
     <resources><object id="1" name="Base" type="model"><mesh>${box(80, 60, 10)}</mesh></object></resources>
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
const checks = [];
const check = (name, pass, got = '') => {
  checks.push([name, pass]);
  console.log(`${pass ? '  ok  ' : '  FAIL'} ${name}${pass ? '' : `  → ${JSON.stringify(got)}`}`);
};

await page.goto(`http://127.0.0.1:${PORT}/`);
await page.setInputFiles('[data-testid="add-model-input"]', {
  name: 'plate.3mf', mimeType: 'application/octet-stream', buffer: Buffer.from(FIXTURE_3MF),
});
await page.waitForFunction(() => (window).__studio?.manifest?.parts?.length === 1, { timeout: 30000 });
await page.waitForFunction(() => (window).__studioViewerReady === true, { timeout: 30000 });

// Place a text slot on the top face.
await page.click('.part-name:has-text("Base")');
await page.waitForTimeout(200);
await page.click('[data-testid="place-text"]');
await page.evaluate(() => window.__studioViewCube.go('Top'));
let settled = '';
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(120);
  const now = JSON.stringify(await page.evaluate(() => window.__studioViewer.cameraView()));
  if (now === settled) break;
  settled = now;
}
const at = await page.evaluate(() => {
  const v = window.__studioViewer;
  const q = v.meshOf('base').position.clone().project(v.camera);
  const r = document.querySelector('.stage canvas').getBoundingClientRect();
  return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height];
});
await page.mouse.click(at[0], at[1]);
await page.waitForFunction(() => (window).__studio?.manifest?.options?.some((o) => o.type === 'text'), { timeout: 20000 });

// A longer placeholder makes the arch obvious.
await page.fill('[data-testid="text-placeholder-base-text"]', 'HELLO WORLD');
await page.waitForFunction(() => {
  const m = (window).__studioViewer?.textMeshOf?.('base-text');
  return !!m && m.geometry.attributes.position.count > 0
    && (window).__studio.manifest.options.find((o) => o.type === 'text')?.placeholder === 'HELLO WORLD';
}, { timeout: 20000 });
const flat = await page.evaluate(() => {
  const g = (window).__studioViewer.textMeshOf('base-text').geometry;
  g.computeBoundingBox();
  return g.boundingBox.max.y - g.boundingBox.min.y;
});

// Bend 120°: the run arches on the model.
await page.fill('[data-testid="text-bend-base-text"]', '120');
await page.press('[data-testid="text-bend-base-text"]', 'Enter');
await page.waitForTimeout(400);
const bent = await page.evaluate(() => {
  const z = (window).__studio.manifest.options.find((o) => o.type === 'text');
  const g = (window).__studioViewer.textMeshOf('base-text').geometry;
  g.computeBoundingBox();
  return { bendDeg: z.bendDeg, span: g.boundingBox.max.y - g.boundingBox.min.y };
});
check('Bend writes bendDeg and the run arches on the model',
  bent.bendDeg === 120 && bent.span > flat * 1.5, { ...bent, flat });

// Deselect (left-click empty space closes the floating properties panel),
// then frame the text mesh from a three-quarter angle for the shots.
const frameText = async () => {
  await page.mouse.click(620, 140);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const v = (window).__studioViewer;
    const t = v.camera.position.clone(); // scratch Vector3
    v.textMeshOf('base-text').getWorldPosition(t);
    v.camera.position.set(t.x, t.y + 110, t.z + 130);
    v.camera.lookAt(t.x, t.y, t.z);
  });
};
await frameText();
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'text-arch.png') });

// A negative bend smiles.
await page.fill('[data-testid="text-bend-base-text"]', '-120');
await page.press('[data-testid="text-bend-base-text"]', 'Enter');
await page.waitForTimeout(500);
const smile = await page.evaluate(() => (window).__studio.manifest.options.find((o) => o.type === 'text')?.bendDeg);
check('negative bend accepted (smile)', smile === -120, smile);
await frameText();
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'text-smile.png') });

// Zero straightens and clears the field from the manifest.
await page.fill('[data-testid="text-bend-base-text"]', '0');
await page.press('[data-testid="text-bend-base-text"]', 'Enter');
await page.waitForTimeout(400);
const cleared = await page.evaluate(() => {
  const z = (window).__studio.manifest.options.find((o) => o.type === 'text');
  const g = (window).__studioViewer.textMeshOf('base-text').geometry;
  g.computeBoundingBox();
  return { bendDeg: z.bendDeg, span: g.boundingBox.max.y - g.boundingBox.min.y };
});
check('Bend 0 straightens the run and clears the field',
  cleared.bendDeg === undefined && Math.abs(cleared.span - flat) < 0.01, { ...cleared, flat });

// ── freeform baseline: draw a curve and watch the letters walk it ──────────
await page.evaluate(() => window.__studioViewCube.go('Top'));
settled = '';
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(120);
  const now = JSON.stringify(await page.evaluate(() => window.__studioViewer.cameraView()));
  if (now === settled) break;
  settled = now;
}
await page.click('.part-name:has-text("Base")'); // reopen the slot editor
await page.waitForTimeout(300);
await page.click('[data-testid="text-curve-base-text"]');
await page.waitForSelector('[data-testid="shape-overlay"]', { timeout: 10000 });
await page.waitForTimeout(400);
const dots = await page.locator('.shape-anchor').count();
const seeded = await page.evaluate(() => (window).__studio.manifest.options.find((o) => o.type === 'text')?.path);
check('arming seeds a straight 3-anchor baseline with draggable dots',
  dots === 3 && Array.isArray(seeded) && seeded.length === 3 && seeded.every((p) => p[1] === 0),
  { dots, seeded });

// Drag the middle anchor: the letters must follow the curve live.
const mid = await page.locator('[data-testid="shape-anchor-1"]').boundingBox();
await page.mouse.move(mid.x + mid.width / 2, mid.y + mid.height / 2);
await page.mouse.down();
await page.mouse.move(mid.x + mid.width / 2, mid.y + mid.height / 2 - 80, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(500);
const drawn = await page.evaluate(() => {
  const z = (window).__studio.manifest.options.find((o) => o.type === 'text');
  const g = (window).__studioViewer.textMeshOf('base-text').geometry;
  g.computeBoundingBox();
  return { path: z.path, bendDeg: z.bendDeg, span: g.boundingBox.max.y - g.boundingBox.min.y };
});
check('dragging the middle dot bows the baseline and the run follows',
  Array.isArray(drawn.path) && Math.abs(drawn.path[1][1]) > 3
  && drawn.bendDeg === undefined && drawn.span > flat * 1.4,
  { ...drawn, flat });

await page.keyboard.press('Escape'); // done shaping
await page.waitForTimeout(300);
const overlayGone = await page.locator('[data-testid="shape-overlay"]').count();
check('Escape ends shaping and clears the dots', overlayGone === 0, overlayGone);
await frameText();
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'text-path.png') });

const failed = checks.filter(([, pass]) => !pass).length;
console.log(failed ? `\n${failed} of ${checks.length} failed` : `\nall ${checks.length} passed`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
