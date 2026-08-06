// Targeted check of surface-wrapped text — NOT the full smoke suite.
// Imports a real cylinder, places a text slot on its barrel, turns Wrap on
// and asserts the rendered glyph vertices hug the barrel.
//   node test/wrap-check.mjs <shot-dir>
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });

// A 60mm-tall barrel, radius 20, standing on the ground (axis = Z in the
// file's Z-up space, which import turns into the viewer's Y-up).
const R = 20, H = 60, SEG = 64;
const cylinder = () => {
  const verts = [];
  for (let i = 0; i < SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    verts.push([R * Math.cos(a), R * Math.sin(a), 0], [R * Math.cos(a), R * Math.sin(a), H]);
  }
  verts.push([0, 0, 0], [0, 0, H]);
  const bc = SEG * 2, tc = SEG * 2 + 1;
  const tris = [];
  for (let i = 0; i < SEG; i++) {
    const j = (i + 1) % SEG;
    const b0 = i * 2, t0 = i * 2 + 1, b1 = j * 2, t1 = j * 2 + 1;
    tris.push([b0, b1, t1], [b0, t1, t0], [bc, b1, b0], [tc, t0, t1]);
  }
  return `<vertices>${verts.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices>`
    + `<triangles>${tris.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles>`;
};
const FIXTURE = zipSync({ '3D/3dmodel.model': new TextEncoder().encode(
  `<?xml version="1.0"?><model unit="millimeter"><resources>
   <object id="1" name="Barrel" type="model"><mesh>${cylinder()}</mesh></object>
   </resources><build><item objectid="1"/></build></model>`) });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const p = join(DIST, rel === '/' ? 'index.html' : rel);
  if (!p.startsWith(DIST) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(4334, r));
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const checks = [];
const check = (name, pass, got = '') => {
  checks.push([name, pass]);
  console.log(`${pass ? '  ok  ' : '  FAIL'} ${name}${pass ? '' : `  → ${JSON.stringify(got)}`}`);
};
// Radial spread of the glyph mesh's vertices about the barrel's axis.
const glyphRadii = () => page.evaluate(() => {
  const m = window.__studioViewer.textMeshOf('barrel-text');
  if (!m) return null;
  m.updateMatrixWorld();
  const pos = m.geometry.attributes.position;
  const e = m.matrixWorld.elements; // column-major; applied by hand, no THREE here
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const r = Math.hypot(wx, wz);
    min = Math.min(min, r); max = Math.max(max, r);
  }
  return { min, max, count: pos.count };
});

await page.goto('http://127.0.0.1:4334/');
await page.setInputFiles('[data-testid="add-model-input"]', {
  name: 'barrel.3mf', mimeType: 'application/octet-stream', buffer: Buffer.from(FIXTURE),
});
await page.waitForFunction(() => window.__studio?.manifest?.parts?.length === 1, { timeout: 30000 });
await page.waitForFunction(() => window.__studioViewerReady === true, { timeout: 30000 });

// Place the slot on the barrel's SIDE: look from the front and click the
// silhouette's middle, which lands on the curved wall.
await page.click('.part-name:has-text("Barrel")');
await page.waitForTimeout(300);
await page.click('[data-testid="place-text"]');
await page.evaluate(() => window.__studioViewCube.go('Front'));
await page.waitForTimeout(2500);
const at = await page.evaluate(() => {
  const v = window.__studioViewer;
  const q = v.meshOf('barrel').position.clone().project(v.camera);
  const r = document.querySelector('.stage canvas').getBoundingClientRect();
  return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height];
});
await page.mouse.click(at[0], at[1]);
await page.waitForFunction(() => window.__studio?.manifest?.options?.some((o) => o.type === 'text'), { timeout: 20000 });
await page.fill('[data-testid="text-placeholder-barrel-text"]', 'WRAPPED');
await page.waitForTimeout(1200);

// A flat slot's sketch plane is TANGENT at the pick point, so the run
// touches the barrel in the middle and its ends fly off into the air —
// the further from centre, the worse. That gap is what wrapping closes.
const flat = await glyphRadii();
check('a flat slot flies off the barrel at its ends',
  !!flat && flat.max > 25, flat);

await page.check('[data-testid="text-wrap-barrel-text"]');
await page.waitForTimeout(1500);
const wrapped = await glyphRadii();
check('Wrap writes the flag', await page.evaluate(
  () => window.__studio.manifest.options.find((o) => o.type === 'text')?.wrapSurface === true), '');
check('wrapped glyphs hug the barrel — nothing sinks in, nothing floats far off',
  !!wrapped && wrapped.min > 19.6 && wrapped.max < 20 + 2 + 1.5, wrapped);
check('wrapping brings the ends back down onto the barrel',
  !!wrapped && wrapped.max < flat.max - 8,
  { flatMax: flat?.max, wrappedMax: wrapped?.max });

await page.evaluate(() => {
  const v = window.__studioViewer;
  v.camera.position.set(105, 75, 105);
  v.camera.lookAt(0, 28, 0);
});
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, 'wrap-cylinder.png') });

// Float above: the whole run moves outward by the lift.
await page.fill('[data-testid="text-lift-barrel-text"]', '3');
await page.press('[data-testid="text-lift-barrel-text"]', 'Enter');
await page.waitForTimeout(1200);
const lifted = await glyphRadii();
check('Float above pushes the run out along the surface normal',
  !!lifted && lifted.min > wrapped.min + 2.5, { before: wrapped?.min, after: lifted?.min });

// Turning it off returns to the flat plane.
await page.uncheck('[data-testid="text-wrap-barrel-text"]');
await page.waitForTimeout(1200);
const off = await glyphRadii();
check('unchecking returns the run to the flat sketch plane',
  !!off && Math.abs(off.max - flat.max) < 0.2
  && (await page.evaluate(() => window.__studio.manifest.options.find((o) => o.type === 'text')?.liftMm)) === undefined,
  { flatMin: flat?.min, offMin: off?.min });

const failed = checks.filter(([, p]) => !p).length;
console.log(failed ? `\n${failed} of ${checks.length} failed` : `\nall ${checks.length} passed`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
