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
// A 60×45×12 plate with 10mm chamfered corners — the top face is an
// octagon, so the placed zone must bring the rim along as its mask.
const OCT = [[10, 0], [50, 0], [60, 10], [60, 35], [50, 45], [10, 45], [0, 35], [0, 10]];
const octPrism = () => {
  const verts = [...OCT.map(([x, y]) => [x, y, 0]), ...OCT.map(([x, y]) => [x, y, 12])];
  const tris = [];
  for (let i = 1; i < 7; i++) { tris.push([8, 8 + i, 8 + i + 1], [0, i + 1, i]); }
  for (let i = 0; i < 8; i++) { const j = (i + 1) % 8; tris.push([i, j, 8 + j], [i, 8 + j, 8 + i]); }
  return boxXml(verts, tris);
};
const FIXTURE_3MF = zipSync({
  '3D/3dmodel.model': new TextEncoder().encode(
    `<?xml version="1.0"?><model unit="millimeter">
     <resources><object id="1" name="Base" type="model"><mesh>${octPrism()}</mesh></object></resources>
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

// The placed zone conforms to the picked 60×45 chamfered top face.
const fitted = await page.evaluate(() => {
  const z = (window).__studio.manifest.options.find((o) => o.type === 'upload');
  return { w: z.widthMm, h: z.heightMm, spin: z.rotationDeg ?? 0, mask: z.boundary?.length ?? 0 };
});
check('zone conforms to the picked face (60×45, no spin)',
  Math.abs(fitted.w - 60) < 0.6 && Math.abs(fitted.h - 45) < 0.6 && Math.abs(fitted.spin) < 0.5, fitted);
check('…and the chamfered rim arrives as the zone mask', fitted.mask >= 6 && fitted.mask <= 24, fitted);
check('mask anchors cut the corners — nothing overhangs the chamfers',
  await page.evaluate(() => {
    const z = (window).__studio.manifest.options.find((o) => o.type === 'upload');
    return z.boundary.every(([u, v]) => Math.abs(u) + Math.abs(v) < 45 && Math.abs(u) <= 30.1 && Math.abs(v) <= 22.6);
  }), '');

// Widen the zone, then check the plane pose.
await page.fill('[data-testid="image-width-base-image"]', '45');
await page.press('[data-testid="image-width-base-image"]', 'Enter');
await page.fill('[data-testid="image-height-base-image"]', '30');
await page.press('[data-testid="image-height-base-image"]', 'Enter');
await page.waitForTimeout(300);
const pose = await page.evaluate(() => {
  const f = (window).__studioViewer.scene.getObjectByName('image-zone-base-image');
  const box = (window).__studioViewer.partBox('base');
  return { quad: f?.geometry.attributes.position.count, y: f?.position.y, top: box.max[1] };
});
check('zone renders as one plane 0.3mm above the top face',
  pose.quad === 4 && pose.y > pose.top && pose.y < pose.top + 1, pose);

// Customer preview: upload the real logo.
await page.click('[data-testid="preview-open"]');
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
  const corner = ctx.getImageData(2, 2, 1, 1).data[3];
  return { centre, corner, quad: mesh.geometry.attributes.position.count };
});
check('uploaded logo paints the zone canvas (single quad, centre opaque)',
  paint.quad === 4 && paint.centre > 0, paint);
check('…masked to the face rim: the chamfered corner stays transparent',
  paint.corner === 0, paint);

// Arrow + size still work (canvas repaint, no geometry change).
await page.click('.preview-overlay .cfg-arrow-right');
await page.waitForTimeout(250);
await page.click('.preview-overlay .cfg-size-minus');
await page.waitForTimeout(250);
const sel = await page.evaluate(() => JSON.parse((window).__previewPayload.selections['base-image']));
check('arrow pad and size steps land in the payload', sel.u > 0 && sel.s === 90, sel);

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
  const Vec = mesh.position.constructor;
  const ax = new Vec(1, 0, 0).applyQuaternion(mesh.quaternion);
  let deg = Math.atan2(-ax.z, ax.x) * 180 / Math.PI; // in-plane world angle
  deg = ((deg % 90) + 90) % 90; // edge direction, mod the rectangle's symmetry
  return { w: z.widthMm, h: z.heightMm, deg: Math.min(deg, 90 - deg) };
});
check('on a rotated part the zone runs with the face edges (25° world spin)',
  Math.abs(spun.deg - 25) < 1
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
