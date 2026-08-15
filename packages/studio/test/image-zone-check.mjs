// Targeted check of the image-zone flow — NOT the full smoke suite.
// Imports a box, places a zone on its top face, uploads a real logo in the
// customer preview, asserts the plane pose + canvas paint, and screenshots
// the result from an angle that would show any edge bleed-through.
//   node test/image-zone-check.mjs <logo.png> <shot-dir>
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const PORT = 4324;
const LOGO = process.argv[2];
const OUT = process.argv[3];
mkdirSync(OUT, { recursive: true });

const boxXml = (verts, tris) =>
  `<vertices>${verts.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices>` +
  `<triangles>${tris.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles>`;
// A 60×45×12 plate with r=10 ROUNDED corners (arcs tessellated at ~6.4°)
// — the user's real shape: the placed zone must bring the rounded rim
// along as its mask without melting it into a blob.
const RIM = [];
{
  const w = 60, h = 45, r = 10;
  const corner = (cx, cy, a0) => {
    for (let k = 0; k < 14; k++) {
      const a = a0 + (k / 14) * (Math.PI / 2);
      RIM.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  corner(w - r, h - r, 0);
  corner(r, h - r, Math.PI / 2);
  corner(r, r, Math.PI);
  corner(w - r, r, 3 * Math.PI / 2);
}
const roundedPrism = () => {
  const n = RIM.length;
  const verts = [
    ...RIM.map(([x, y]) => [x, y, 0]), ...RIM.map(([x, y]) => [x, y, 12]),
    [30, 22.5, 0], [30, 22.5, 12],
  ];
  const bc = 2 * n, tc = 2 * n + 1;
  const tris = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push([tc, n + i, n + j], [bc, j, i], [i, j, n + j], [i, n + j, n + i]);
  }
  return boxXml(verts, tris);
};
const FIXTURE_3MF = zipSync({
  '3D/3dmodel.model': new TextEncoder().encode(
    `<?xml version="1.0"?><model unit="millimeter">
     <resources><object id="1" name="Base" type="model"><mesh>${roundedPrism()}</mesh></object></resources>
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
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(String(e)));
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

// Place the zone on the top face (top-down click at the part's centre).
const settleCamera = async () => {
  let settled = '';
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(120);
    const now = JSON.stringify(await page.evaluate(() => window.__studioViewer.cameraView()));
    if (now === settled) break;
    settled = now;
  }
};
const clickBaseCentre = async () => {
  const at = await page.evaluate(() => {
    const v = window.__studioViewer;
    const q = v.meshOf('base').position.clone().project(v.camera);
    const r = document.querySelector('.stage canvas').getBoundingClientRect();
    return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height];
  });
  await page.mouse.click(at[0], at[1]);
};
await page.click('.part-name:has-text("Base")');
await page.waitForTimeout(200);
await page.click('[data-testid="place-image"]');
await page.evaluate(() => window.__studioViewCube.go('Top'));
await settleCamera();
await clickBaseCentre();
await page.waitForFunction(() => (window).__studio?.manifest?.options?.some((o) => o.type === 'upload'), { timeout: 20000 });

await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'zone-veil.png') });

// The placed zone conforms to the picked 60×45 chamfered top face.
const fitted = await page.evaluate(() => {
  const z = (window).__studio.manifest.options.find((o) => o.type === 'upload');
  return { w: z.widthMm, h: z.heightMm, spin: z.rotationDeg ?? 0 };
});
check('zone conforms to the picked face (60×45, rotation exactly 0)',
  Math.abs(fitted.w - 60) < 0.6 && Math.abs(fitted.h - 45) < 0.6 && fitted.spin === 0, fitted);
const overlay = await page.evaluate(() => {
  const f = (window).__studioViewer.scene.getObjectByName('image-zone-base-image');
  if (!f) return null;
  f.geometry.computeBoundingBox();
  const bb = f.geometry.boundingBox;
  return {
    verts: f.geometry.attributes.position.count,
    onCarrier: f.parent === (window).__studioViewer.meshOf('base'),
    ySpan: bb.max.y - bb.min.y,
  };
});
check('the overlay is the picked face own triangles, riding the part',
  !!overlay && overlay.verts > 30 && overlay.onCarrier && overlay.ySpan < 0.01, overlay);

// Zone rect stays merchant-editable (framing only).
await page.fill('[data-testid="image-width-base-image"]', '45');
await page.press('[data-testid="image-width-base-image"]', 'Enter');
await page.fill('[data-testid="image-height-base-image"]', '30');
await page.press('[data-testid="image-height-base-image"]', 'Enter');
await page.waitForTimeout(300);

// Customer preview: upload the real logo.
await page.click('[data-testid="publish-cta"]');
  await page.click('[data-testid="preview-open"]'); // in the publish modal head; closes the modal
await page.waitForSelector('.preview-overlay .cfg-tab', { timeout: 20000 });
await page.click('.preview-overlay .cfg-tab:has-text("Base image")');
await page.waitForTimeout(200);
await page.setInputFiles('.preview-overlay .cfg-upload-input', LOGO);
await page.waitForFunction(() => !!(window).__previewViewer?.imageDecalOf?.('base-image'), { timeout: 30000 });
const paint = await page.evaluate(() => {
  const mesh = (window).__previewViewer.imageDecalOf('base-image');
  const canvas = mesh.material.map.image;
  const ctx = canvas.getContext('2d');
  const centre = ctx.getImageData(Math.round(canvas.width / 2), Math.round(canvas.height / 2), 1, 1).data[3];
  return { centre, verts: mesh.geometry.attributes.position.count };
});
check('uploaded logo paints onto the region surface (centre opaque)',
  paint.verts > 30 && paint.centre > 0, paint);

// Arrow + size still work (canvas repaint, no geometry change).
await page.click('.preview-overlay .cfg-arrow-right');
await page.waitForTimeout(250);
await page.click('.preview-overlay .cfg-size-minus');
await page.waitForTimeout(250);
const sel = await page.evaluate(() => JSON.parse((window).__previewPayload.selections['base-image']));
check('arrow pad and 1% size steps land in the payload', sel.u > 0 && sel.s === 99, sel);
await page.fill('.preview-overlay .cfg-size-value', '180');
await page.dispatchEvent('.preview-overlay .cfg-size-value', 'change');
await page.waitForTimeout(250);
const zoomed = await page.evaluate(() => JSON.parse((window).__previewPayload.selections['base-image']).s);
check('typed size beyond 100% crop-zooms (180%)', zoomed === 180, zoomed);

// Screenshot from a low three-quarter angle — where bleed-through showed.
await page.evaluate(() => {
  const v = (window).__previewViewer;
  v.camera.position.set(-70, -50, 90);
  v.camera.lookAt(0, 6, 0);
});
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'zone-under.png') });
await page.evaluate(() => {
  const v = (window).__previewViewer;
  v.camera.position.set(40, 70, 80);
  v.camera.lookAt(0, 6, 0);
});
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'zone-top.png') });

// ── rotated part: the zone must conform to the ROTATED face ────────────────
await page.click('[data-testid="preview-close"]');
await page.waitForTimeout(300);
await page.click('[data-testid="image-remove-base-image"]');
await page.waitForFunction(() => !(window).__studio?.manifest?.options?.some((o) => o.type === 'upload'), { timeout: 20000 });
await page.fill('[data-testid="rot-z"]', '25'); // spin 25° about the vertical
await page.press('[data-testid="rot-z"]', 'Enter');
await page.waitForTimeout(400);
await page.click('[data-testid="place-image"]');
await page.evaluate(() => window.__studioViewCube.go('Top'));
await settleCamera();
await clickBaseCentre();
await page.waitForFunction(() => (window).__studio?.manifest?.options?.some((o) => o.type === 'upload'), { timeout: 20000 });
await page.waitForTimeout(300);
const spun = await page.evaluate(() => {
  const z = (window).__studio.manifest.options.find((o) => o.type === 'upload');
  const mesh = (window).__studioViewer.scene.getObjectByName(`image-zone-${z.id}`);
  return {
    w: z.widthMm, h: z.heightMm,
    verts: mesh?.geometry.attributes.position.count ?? 0,
    onCarrier: mesh?.parent === (window).__studioViewer.meshOf('base'),
  };
});
check('on a rotated part the zone is still the face itself (child of the part)',
  spun.onCarrier && spun.verts > 30
  && ((Math.abs(spun.w - 60) < 0.6 && Math.abs(spun.h - 45) < 0.6)
    || (Math.abs(spun.w - 45) < 0.6 && Math.abs(spun.h - 60) < 0.6)),
  spun);
await page.screenshot({ path: join(OUT, 'zone-rotated.png') });

const noisy = errors.filter((e) => /ShadowMap|deprecated/i.test(e));
check('no shadow-map deprecation warning on the console', noisy.length === 0, noisy);

const failed = checks.filter(([, pass]) => !pass).length;
console.log(failed ? `\n${failed} of ${checks.length} failed` : `\nall ${checks.length} passed`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
