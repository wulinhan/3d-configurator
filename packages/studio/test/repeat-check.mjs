// Targeted check of live part repeats — NOT the full smoke suite.
// Adds a pattern to a part, retunes it, stacks a second one, and asserts
// the viewport spawns/moves real copies each time.
//   node test/repeat-check.mjs <shot-dir>
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });
const box = (w, h, d) => {
  const v = [[0,0,0],[w,0,0],[w,h,0],[0,h,0],[0,0,d],[w,0,d],[w,h,d],[0,h,d]];
  const q = [[0,3,2,1],[4,5,6,7],[0,1,5,4],[2,3,7,6],[1,2,6,5],[0,4,7,3]];
  const t = q.flatMap(([a,b,c,dd]) => [[a,b,c],[a,c,dd]]);
  return `<vertices>${v.map(([x,y,z])=>`<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices>`
    + `<triangles>${t.map(([a,b,c])=>`<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles>`;
};
const FIXTURE = zipSync({ '3D/3dmodel.model': new TextEncoder().encode(
  `<?xml version="1.0"?><model unit="millimeter"><resources>
   <object id="1" name="Tile" type="model"><mesh>${box(20,20,4)}</mesh></object>
   </resources><build><item objectid="1"/></build></model>`) });
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json' };
const server = createServer((req,res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const p = join(DIST, rel === '/' ? 'index.html' : rel);
  if (!p.startsWith(DIST) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(4332, r));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2 });
const checks = [];
const check = (name, pass, got = '') => {
  checks.push([name, pass]);
  console.log(`${pass ? '  ok  ' : '  FAIL'} ${name}${pass ? '' : `  → ${JSON.stringify(got)}`}`);
};
// How many meshes in the scene carry this part's id.
const copies = () => page.evaluate(() => {
  let n = 0;
  window.__studioViewer.scene.traverse((o) => { if (o.isMesh && o.userData.part === 'tile') n++; });
  return n;
});
const spread = () => page.evaluate(() => {
  const xs = [];
  window.__studioViewer.scene.traverse((o) => { if (o.isMesh && o.userData.part === 'tile') xs.push(o.position.x); });
  return Math.max(...xs) - Math.min(...xs);
});

await page.goto('http://127.0.0.1:4332/');
await page.setInputFiles('[data-testid="add-model-input"]', { name: 't.3mf', mimeType: 'application/octet-stream', buffer: Buffer.from(FIXTURE) });
await page.waitForFunction(() => window.__studio?.manifest?.parts?.length === 1, { timeout: 30000 });
await page.waitForFunction(() => window.__studioViewerReady === true, { timeout: 30000 });
await page.click('.part-name:has-text("Tile")');
await page.waitForTimeout(300);
check('one part, one mesh before any pattern', await copies() === 1, await copies());

// Add a pattern: copies spawn live.
await page.click('[data-testid="repeat-add"]');
await page.waitForTimeout(500);
const afterAdd = await copies();
const spreadAdd = await spread();
check('adding a pattern spawns copies in the viewport', afterAdd === 3, afterAdd);

// Retune the count: the row re-forms without re-stamping anything.
const id = await page.evaluate(() => window.__studio.manifest.parts[0].repeats[0].id);
await page.fill(`[data-testid="repeat-count-${id}"]`, '5');
await page.press(`[data-testid="repeat-count-${id}"]`, 'Enter');
await page.waitForTimeout(500);
check('retuning the count updates live', await copies() === 5, await copies());

// Retune the gap: same copies, further apart.
await page.fill(`[data-testid="repeat-gap-${id}"]`, '30');
await page.press(`[data-testid="repeat-gap-${id}"]`, 'Enter');
await page.waitForTimeout(500);
const spreadGap = await spread();
check('retuning the gap re-spaces the row live', await copies() === 5 && spreadGap > spreadAdd, { spreadGap, spreadAdd });

// Stack a second pattern (it opens at the default 3): 5 × 3 = 15 copies.
await page.click('[data-testid="repeat-add"]');
await page.waitForTimeout(600);
const stacked = await copies();
check('a second pattern stacks into a grid', stacked === 15, stacked);
const parts = await page.evaluate(() => window.__studio.manifest.parts.length);
check('the copies are the part, not new parts in the explorer', parts === 1, parts);

await page.evaluate(() => {
  const v = window.__studioViewer;
  v.camera.position.set(60, 180, 220);
  v.camera.lookAt(60, 0, 20);
});
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'repeat-grid.png') });

// Removing the patterns returns the part to one mesh.
const ids = await page.evaluate(() => window.__studio.manifest.parts[0].repeats.map((r) => r.id));
for (const rid of ids) { await page.click(`[data-testid="repeat-remove-${rid}"]`); await page.waitForTimeout(300); }
check('removing the patterns leaves the part alone', await copies() === 1, await copies());

const failed = checks.filter(([, p]) => !p).length;
console.log(failed ? `\n${failed} of ${checks.length} failed` : `\nall ${checks.length} passed`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
