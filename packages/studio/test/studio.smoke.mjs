// Drive the built Studio in a real browser, through the whole merchant
// journey: upload a two-part 3MF → parts appear with true mm sizes → resize
// with and without lock-aspect → anchor one part against another → add a
// palette colour → allow custom colours with a surcharge → make a part a
// priced add-on → publish, and validate the downloaded manifest with the
// embed's own validator.
//
//   node test/studio.smoke.mjs [--shots <dir>]
//
// Assumes `vite build` has produced dist/ (npm test runs unit tests first,
// then this; the build is a prerequisite).

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const PORT = 4322;

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/ not built — run `npm run build -w @allin/studio` first');
  process.exit(1);
}

const { validateManifest } = await import(
  pathToFileURL(join(HERE, '..', '..', 'embed', 'src', 'manifest', 'validate.ts')).href
);
const { resolveLayout } = await import(
  pathToFileURL(join(HERE, '..', '..', 'embed', 'src', 'runtime', 'layout.ts')).href
);

const argv = process.argv.slice(2);
const shotDir = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null;
if (shotDir) mkdirSync(shotDir, { recursive: true });

// ── fixture: a Z-up two-part 3MF, 40×20 base 10 tall + 10×10 cap 4 tall ────
const boxXml = (verts, tris) =>
  `<vertices>${verts.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices>` +
  `<triangles>${tris.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles>`;
const boxGeom = (w, h, d) => {
  const verts = [[0, 0, 0], [w, 0, 0], [w, h, 0], [0, h, 0], [0, 0, d], [w, 0, d], [w, h, d], [0, h, d]];
  const tris = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];
  return boxXml(verts, tris);
};
const FIXTURE_3MF = zipSync({
  '3D/3dmodel.model': new TextEncoder().encode(
    `<?xml version="1.0"?><model unit="millimeter">
     <resources>
      <object id="1" name="Base" type="model"><mesh>${boxGeom(40, 20, 10)}</mesh></object>
      <object id="2" name="Cap" type="model"><mesh>${boxGeom(10, 10, 4)}</mesh></object>
     </resources>
     <build><item objectid="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 15 5 10"/></build>
    </model>`),
});

// ── serve dist ──────────────────────────────────────────────────────────────
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
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => d.accept());

const shoot = (name) => (shotDir ? page.screenshot({ path: join(shotDir, name) }) : Promise.resolve());
const manifest = () => page.evaluate(() => (window).__studio?.manifest);
const checks = [];
const check = (name, pass, got = '') => {
  checks.push([name, pass, got]);
  console.log(`${pass ? '  ok  ' : '  FAIL'} ${name}${pass ? '' : `  → ${JSON.stringify(got)}`}`);
};
const near = (a, b, tol = 1e-3) => Math.abs(a - b) < tol;

// ── 1. upload ───────────────────────────────────────────────────────────────
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.setInputFiles('[data-testid="file-input"]', {
  name: 'desk-organiser.3mf', mimeType: 'application/octet-stream', buffer: Buffer.from(FIXTURE_3MF),
});
await page.waitForFunction(() => (window).__studioViewerReady === true, { timeout: 20000 });
await page.waitForTimeout(800);
await shoot('1-loaded.png');

let m = await manifest();
check('two parts imported from the 3MF', m?.parts?.length === 2, m?.parts?.length);
check('product named from the filename', m?.name === 'desk organiser', m?.name);
check('parts keep their 3MF names', m?.parts?.[0]?.id === 'base' && m?.parts?.[1]?.id === 'cap',
  m?.parts?.map((p) => p.id));

const measureCoverage = () => page.evaluate(() => {
  const c = document.querySelector('.stage canvas');
  const g = document.createElement('canvas');
  g.width = 120; g.height = 90;
  const x = g.getContext('2d');
  x.drawImage(c, 0, 0, 120, 90);
  const d = x.getImageData(0, 0, 120, 90).data;
  // Compare against the manifest's background colour, not pixel (0,0) — after
  // a camera failure the corner pixel can be model, poisoning the reference.
  // The tolerance is tight (12) because tone mapping renders a white part
  // only ~25 units below the background — form, not glare.
  const bg = [0xF8, 0xF6, 0xF1];
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 12) n++;
  }
  return n / (120 * 90);
});
const coverage = await measureCoverage();
// The fixture's base is white, and a tone-mapped white top face sits within
// the ±12 band of the background — what registers is the dark cap, the front
// faces and the contact shadow, ~2% of the stage. The failure this guards
// against (camera never framed, model microscopic) measures under 0.1%.
check('model renders in the viewer', coverage > 0.012, coverage.toFixed(4));

// ── 2. size panel shows real mm (3MF was Z-up: 10 tall becomes H) ───────────
const sizeOf = async (id) => ({
  w: Number(await page.inputValue('[data-testid="size-w"]')),
  h: Number(await page.inputValue('[data-testid="size-h"]')),
  d: Number(await page.inputValue('[data-testid="size-d"]')),
});
let size = await sizeOf('base');
check('Base shows 40 × 10 × 20 mm (W×H×D after Z-up import)',
  near(size.w, 40) && near(size.h, 10) && near(size.d, 20), size);

// ── 3. locked resize scales all axes ────────────────────────────────────────
await page.fill('[data-testid="size-w"]', '80');
await page.press('[data-testid="size-w"]', 'Enter');
await page.waitForTimeout(200);
size = await sizeOf('base');
check('lock-aspect: width 80 doubles H and D too', near(size.h, 20) && near(size.d, 40), size);

// ── 4. unlocked resize touches one axis ─────────────────────────────────────
await page.uncheck('[data-testid="lock-aspect"]');
await page.fill('[data-testid="size-h"]', '30');
await page.press('[data-testid="size-h"]', 'Enter');
await page.waitForTimeout(200);
size = await sizeOf('base');
check('unlocked: only H moves to 30', near(size.w, 80) && near(size.h, 30) && near(size.d, 40), size);
m = await manifest();
check('scale stored as multipliers', near(m.parts[0].placement.scale[0], 2) && near(m.parts[0].placement.scale[1], 3), m.parts[0].placement.scale);

// ── 5. invalid size is rejected inline, manifest untouched ─────────────────
await page.fill('[data-testid="size-w"]', '-5');
await page.press('[data-testid="size-w"]', 'Enter');
await page.waitForTimeout(200);
check('negative size shows an inline error', await page.isVisible('.field-error'), '');
size = await sizeOf('base');
check('and the value snaps back', near(size.w, 80), size.w);

// ── 6. anchor the cap against the base ──────────────────────────────────────
await page.click('.part-name:has-text("Cap")');
await page.waitForTimeout(150);
await page.selectOption('[data-testid="anchor-y"] select >> nth=0', 'base');
await page.selectOption('[data-testid="anchor-y"] select >> nth=1', 'min');
await page.selectOption('[data-testid="anchor-y"] select >> nth=2', 'max');
await page.fill('[data-testid="offset-y"]', '2');
await page.press('[data-testid="offset-y"]', 'Enter');
await page.waitForTimeout(300);
m = await manifest();
check('cap anchored: my min at base:max + 2 mm',
  JSON.stringify(m.parts[1].placement?.y) === JSON.stringify({ align: 'min', to: 'base:max', offset: 2 }),
  m.parts[1].placement?.y);
// The base was doubled earlier; the camera must have backed off to keep the
// whole model in frame. Inside-the-model looks like coverage near 1.0.
const afterResize = await measureCoverage();
// The camera is focused on the selected cap, so the model fills a good share
// of the frame — but "inside the model" is ~1.0 coverage with no background.
check('camera reframed after the resize (model in view, not engulfing it)',
  afterResize > 0.03 && afterResize < 0.92, afterResize.toFixed(4));
await shoot('2-anchored.png');

// ── 6b. what the viewer draws is where the layout engine says parts are ────
// Guards the transform-pivot class of bug: layout scales about part centres,
// so the meshes must too — a scaled, anchored pair diverges immediately if
// the pivots disagree.
{
  const meshBoxes = await page.evaluate(() => {
    const v = window.__studioViewer;
    const out = {};
    for (const part of window.__studio.manifest.parts) {
      const mesh = v.meshOf(part.id);
      if (!mesh) continue;
      mesh.updateMatrixWorld(true);
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      const V = mesh.position.constructor;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) {
        const w = mesh.localToWorld(new V(x, y, z));
        for (const [a, val] of [[0, w.x], [1, w.y], [2, w.z]]) {
          if (val < min[a]) min[a] = val;
          if (val > max[a]) max[a] = val;
        }
      }
      out[part.id] = { min, max };
    }
    return out;
  });
  const rawEntries = await page.evaluate(() => [...window.__studio.raw.entries()]);
  const layout = resolveLayout(m, new Map(rawEntries));
  let worst = 0;
  for (const [id, t] of layout) {
    const drawn = meshBoxes[id];
    if (!drawn) continue;
    for (let a = 0; a < 3; a++) {
      worst = Math.max(worst, Math.abs(drawn.min[a] - t.box.min[a]), Math.abs(drawn.max[a] - t.box.max[a]));
    }
  }
  check('rendered meshes sit exactly where the layout engine puts them',
    worst < 0.01, `worst divergence ${worst.toFixed(3)} mm`);
}

// ── 6c. combined gizmo: a real pointer drag lands in the manifest ──────────
{
  await page.click('[data-testid="gizmo-transform"]');
  await page.waitForTimeout(300);
  const attached = await page.evaluate(() => {
    const g = window.__studioGizmo;
    return !!(g?.translate?.object && g?.rotate?.object && g?.scale?.object
      && g.translate.object === g.rotate.object && g.rotate.object === g.scale.object);
  });
  check('all three gizmo layers attach to the selected part', attached, '');
  const before = await manifest();
  const xOffsetBefore = before.parts[1].placement?.x?.offset ?? 0;

  // Project the attached mesh's position and its +X direction to screen space.
  const geometry2d = await page.evaluate(() => {
    const v = window.__studioViewer;
    const mesh = v.meshOf('cap');
    const V = mesh.position.constructor;
    const canvas = document.querySelector('.stage canvas');
    const r = canvas.getBoundingClientRect();
    const toPx = (world) => {
      const p = world.clone().project(v.camera);
      return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
    };
    const c = toPx(mesh.position);
    const gizmoScale = mesh.position.clone().sub(v.camera.position).length() / 6; // gizmo world size heuristic
    const x1 = toPx(mesh.position.clone().add(new V(gizmoScale, 0, 0)));
    return { centre: c, xDir: [x1[0] - c[0], x1[1] - c[1]] };
  });
  const len = Math.hypot(...geometry2d.xDir);
  const dir = [geometry2d.xDir[0] / len, geometry2d.xDir[1] / len];

  // Walk in from the arrow tip until the TRANSLATE layer takes the pointer —
  // the combined gizmo nests scale cubes and rings on the same shaft, so the
  // arbitration must hand the outer arrow to translate.
  let grabbed = false;
  for (const dist of [120, 108, 96, 84, 72, 60]) {
    const px = geometry2d.centre[0] + dir[0] * dist;
    const py = geometry2d.centre[1] + dir[1] * dist;
    await page.mouse.move(px, py);
    await page.mouse.down();
    await page.waitForTimeout(60);
    grabbed = await page.evaluate(() => window.__studioGizmo?.translate?.dragging === true);
    if (grabbed) {
      for (let step = 1; step <= 8; step++) {
        await page.mouse.move(px + dir[0] * 8 * step, py + dir[1] * 8 * step);
        await page.waitForTimeout(30);
      }
      // Numbers must go live BEFORE release — throttled commits during drag.
      const midDrag = await manifest();
      check('panel values update live mid-drag',
        (midDrag.parts[1].placement?.x?.offset ?? 0) !== (before.parts[1].placement?.x?.offset ?? 0),
        midDrag.parts[1].placement?.x);
      await page.mouse.up();
      break;
    }
    await page.mouse.up();
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
  check('combined gizmo: the pointer grabbed the translate arrow', grabbed, '');

  m = await manifest();
  const xOffsetAfter = m.parts[1].placement?.x?.offset ?? 0;
  check('the drag committed millimetres into the manifest',
    grabbed && xOffsetAfter > xOffsetBefore, `${xOffsetBefore} → ${xOffsetAfter}`);
  check('the anchored Y axis survived the drag untouched',
    m.parts[1].placement?.y?.to === 'base:max', m.parts[1].placement?.y);
  const verdictAfterDrag = validateManifest(m);
  check('manifest still valid after the drag', verdictAfterDrag.ok, verdictAfterDrag.errors);

  // The whole drag — many throttled live commits plus the release — must be
  // ONE undo step. One Ctrl+Z lands on the pre-drag manifest exactly.
  if (grabbed) {
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);
    m = await manifest();
    check('one undo rewinds the whole drag',
      near(m.parts[1].placement?.x?.offset ?? 0, xOffsetBefore), m.parts[1].placement?.x);
    await page.keyboard.press('Control+Shift+z');
    await page.waitForTimeout(200);
    m = await manifest();
    check('one redo restores the drag',
      near(m.parts[1].placement?.x?.offset ?? 0, xOffsetAfter), m.parts[1].placement?.x);
  }
  const rings = await page.evaluate(() => {
    let quarterArcs = 0, grips = 0;
    const colours = {};
    const walk = (o) => {
      if (o.visible === false) return; // pickers are hidden at the group level
      if (o.isMesh && ['X', 'Y', 'Z'].includes(o.name) && o.geometry?.type === 'TorusGeometry') {
        const arc = o.geometry.parameters.arc;
        if (arc > 1.4 && arc < 1.7) quarterArcs++;
        colours[o.name] = '#' + o.material.color.getHexString();
        // Pinned to its world plane, not spun toward the camera: the pin
        // rewrites the quaternion every frame, so it must match its pose.
      }
      if (o.isMesh && o.geometry?.type === 'SphereGeometry') grips++;
      for (const c of o.children) walk(c);
    };
    walk(window.__studioGizmo.rotate.getHelper());
    const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    const [, , yB] = rgb(colours.Y ?? '#000000');
    const [, zG] = rgb(colours.Z ?? '#000000');
    return { quarterArcs, grips, yIsBlue: yB > 128, zIsGreen: zG > 128, colours };
  });
  check('rotation arcs are axis-aligned quarter rings with 45° grab spheres',
    rings.quarterArcs === 3 && rings.grips === 3, rings);
  check('Z-up colours: the vertical handle wears blue, depth wears green',
    rings.yIsBlue && rings.zIsGreen, rings.colours);
  await shoot('2b-gizmo.png');

  // Clicking empty space deselects and the gizmo goes away. "Empty" is
  // whatever the face picker says is empty — the model's screen footprint
  // moves as the test edits it, so scan for a background pixel.
  const empty = await page.evaluate(() => {
    const r = document.querySelector('.stage canvas').getBoundingClientRect();
    // Grid-scan for background, keeping clear of the toolbar (top-left) and
    // the view cube (top-right).
    // Stay left of the floating properties panel (right ~350px of the stage):
    // a click there lands on the panel, not the canvas.
    for (let fy = 0.15; fy < 0.95; fy += 0.1) {
      for (let fx = 0.05; fx < 0.6; fx += 0.08) {
        if (fy < 0.25 && (fx < 0.35 || fx > 0.75)) continue;
        const x = r.left + r.width * fx, y = r.top + r.height * fy;
        if (!window.__studioViewer.pickFaceAt(x, y)) return [x, y];
      }
    }
    return null;
  });
  check('found an empty pixel to click', !!empty, '');
  await page.mouse.click(empty[0], empty[1]);
  await page.waitForTimeout(600);
  const detached = await page.evaluate(() => ({
    object: !!window.__studioGizmo.translate.object,
    selected: (window).__studio?.manifest && document.querySelector('.part-row.is-active') !== null,
  }));
  check('clicking empty space deselects and hides the gizmo', detached.object === false, detached);
  check('…and the floating properties panel slides away', await page.evaluate(
    () => !document.querySelector('[data-testid="props-float"]')?.classList.contains('is-open')), '');
  await page.click('.part-name:has-text("Cap")');
  await page.waitForTimeout(700);
  check('selecting a part slides the properties panel in', await page.evaluate(
    () => document.querySelector('[data-testid="props-float"]')?.classList.contains('is-open') === true), '');
  await page.click('[data-testid="gizmo-off"]');
}

// ── 6d. view cube: quick views by face and corner ──────────────────────────
{
  // Camera tweens are time-based but frames can crawl under SwiftShader —
  // wait for the orbit to stop moving instead of guessing a delay.
  const settleCamera = async () => {
    let last = '';
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(120);
      const now = JSON.stringify(await page.evaluate(() => window.__studioViewer.cameraView()));
      if (now === last) return;
      last = now;
    }
  };
  const dirNow = () => page.evaluate(() => {
    const v = window.__studioViewer.cameraView();
    const d = [0, 1, 2].map((a) => v.position[a] - v.target[a]);
    const len = Math.hypot(...d);
    return d.map((x) => x / len);
  });

  // A real click in the middle of the cube canvas: the camera starts on the
  // front-upper quadrant, so the centre of the cube is the Front face.
  await page.click('[data-testid="view-cube"]');
  await settleCamera();
  let d = await dirNow();
  check('clicking the cube face swings the camera to Front',
    d[2] > 0.99 && Math.abs(d[0]) < 0.05 && Math.abs(d[1]) < 0.05,
    d.map((x) => x.toFixed(3)));

  const went = await page.evaluate(() => window.__studioViewCube.go('corner+x+y+z'));
  await settleCamera();
  d = await dirNow();
  const k = 1 / Math.sqrt(3);
  check('a corner quick view lands on the isometric diagonal',
    went && Math.abs(d[0] - k) < 0.03 && Math.abs(d[1] - k) < 0.03 && Math.abs(d[2] - k) < 0.03,
    d.map((x) => x.toFixed(3)));
  await shoot('2c-viewcube.png');
}

// ── 6e. save the default camera view ───────────────────────────────────────
{
  await page.click('[data-testid="save-view"]');
  await page.waitForTimeout(200);
  m = await manifest();
  const live = await page.evaluate(() => window.__studioViewer.cameraView());
  const closeEnough = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.05);
  check('Save view marks the camera as merchant-set', m.camera?.userSet === true, m.camera);
  check('…and stores the live camera pose',
    closeEnough(m.camera.position, live.position) && closeEnough(m.camera.target, live.target),
    { saved: m.camera.position, live: live.position });
}

// ── 6f. eyeballs, solo, rename, default colour ─────────────────────────────
{
  await page.click('.tabs button:has-text("Parts")');
  const visible = (id) => page.evaluate((pid) => window.__studioViewer.meshOf(pid)?.visible, id);

  await page.click('[data-testid="eye-cap"]');
  await page.waitForTimeout(150);
  check('eyeball hides the part', (await visible('cap')) === false, '');
  await page.click('[data-testid="eye-cap"]');
  await page.waitForTimeout(150);
  check('…and shows it again', (await visible('cap')) === true, '');

  await page.click('[data-testid="solo-base"]');
  await page.waitForTimeout(150);
  check('solo shows only that part',
    (await visible('base')) === true && (await visible('cap')) === false, '');
  await page.click('[data-testid="show-all"]');
  await page.waitForTimeout(150);
  check('Show all restores everything',
    (await visible('base')) === true && (await visible('cap')) === true, '');
  await page.click('[data-testid="hide-all"]');
  await page.waitForTimeout(150);
  check('Hide all hides everything',
    (await visible('base')) === false && (await visible('cap')) === false, '');
  await page.click('[data-testid="show-all"]');
  await page.waitForTimeout(150);

  await page.click('[data-testid="rename-cap"]');
  await page.fill('[data-testid="rename-input-cap"]', 'Lid');
  await page.press('[data-testid="rename-input-cap"]', 'Enter');
  await page.waitForTimeout(150);
  m = await manifest();
  check('rename changes the label, not the id',
    m.parts[1].label === 'Lid' && m.parts[1].id === 'cap', m.parts[1]);
  await page.click('[data-testid="rename-cap"]');
  await page.fill('[data-testid="rename-input-cap"]', 'Cap');
  await page.press('[data-testid="rename-input-cap"]', 'Enter');
  await page.waitForTimeout(150);

  await page.click('.part-name:has-text("Base")');
  await page.waitForTimeout(150);
  await page.selectOption('[data-testid="default-colour"]', 'red');
  await page.waitForTimeout(250);
  m = await manifest();
  const baseHex = await page.evaluate(() => window.__studioViewer.meshOf('base')?.material.color.getHexString());
  check('default colour set in the Studio paints the preview',
    m.options.find((o) => o.id === 'base-colour')?.default === 'red' && baseHex === 'c82020',
    { manifest: m.options.find((o) => o.id === 'base-colour')?.default, baseHex });
}

// ── 6g. face snapping ──────────────────────────────────────────────────────
{
  await page.evaluate(() => window.__studioViewCube.go('Front'));
  let settled = '';
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(120);
    const now = JSON.stringify(await page.evaluate(() => window.__studioViewer.cameraView()));
    if (now === settled) break;
    settled = now;
  }
  await page.click('[data-testid="snap-tool"]');
  check('snap tool prompts for the moving face',
    /MOVE/.test(await page.textContent('[data-testid="snap-hint"]') ?? ''), '');

  const screenPos = (id) => page.evaluate((pid) => {
    const v = window.__studioViewer;
    const mesh = v.meshOf(pid);
    const q = mesh.position.clone().project(v.camera);
    const r = document.querySelector('.stage canvas').getBoundingClientRect();
    return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height];
  }, id);
  const capAt = await screenPos('cap');
  await page.mouse.click(capAt[0], capAt[1]);
  await page.waitForTimeout(200);
  const baseAt = await screenPos('base');
  await page.mouse.click(baseAt[0], baseAt[1]);
  await page.waitForTimeout(300);
  m = await manifest();
  check('snapping mates the two clicked faces as a live anchor',
    JSON.stringify(m.parts[1].placement?.z) === JSON.stringify({ align: 'max', to: 'base:max', offset: 0 }),
    m.parts[1].placement?.z);
  const snapVerdict = validateManifest(m);
  check('manifest still valid after the snap', snapVerdict.ok, snapVerdict.errors);
}

// ── 7. palette: add a colour, price a swatch ────────────────────────────────
await page.click('.tabs button:has-text("Palette")');
await page.fill('[data-testid="add-swatch"] input[aria-label="New colour name"]', 'Brand Teal');
await page.click('[data-testid="add-swatch"] button');
await page.waitForTimeout(150);
m = await manifest();
const teal = m.palettes[0].swatches.find((s) => s.id === 'brand-teal');
check('new swatch lands in the palette', !!teal, m.palettes[0].swatches.map((s) => s.id));
await page.fill('[data-testid="swatch-price-brand-teal"]', '6');
await page.press('[data-testid="swatch-price-brand-teal"]', 'Enter');
await page.waitForTimeout(150);
m = await manifest();
check('swatch surcharge saved', m.palettes[0].swatches.find((s) => s.id === 'brand-teal')?.priceDelta === 6,
  m.palettes[0].swatches.find((s) => s.id === 'brand-teal'));

// ── 8. custom colours with surcharge (now a part property, Parts tab) ──────
await page.click('.tabs button:has-text("Parts")');
await page.click('.part-name:has-text("Base")');
await page.waitForTimeout(150);
await page.check('[data-testid="custom-toggle-base-colour"]');
await page.fill('[data-testid="custom-price-base-colour"]', '35');
await page.press('[data-testid="custom-price-base-colour"]', 'Enter');
await page.waitForTimeout(150);
m = await manifest();
check('custom colour rule saved with surcharge',
  JSON.stringify(m.options.find((o) => o.id === 'base-colour')?.custom) === JSON.stringify({ allowed: true, priceDelta: 35 }),
  m.options.find((o) => o.id === 'base-colour')?.custom);

// ── 9. cap becomes a priced add-on ──────────────────────────────────────────
await page.click('.tabs button:has-text("Parts")');
await page.click('.part-name:has-text("Cap")');
await page.check('[data-testid="addon-toggle"]');
await page.waitForTimeout(150);
await page.fill('[data-testid="addon-price"]', '15');
await page.press('[data-testid="addon-price"]', 'Enter');
await page.waitForTimeout(150);
m = await manifest();
check('cap hidden behind a yes/no option',
  JSON.stringify(m.parts[1].visibleWhen) === JSON.stringify({ option: 'cap-addon', equals: ['yes'] }),
  m.parts[1].visibleWhen);
check('add-on priced at 15',
  m.options.find((o) => o.id === 'cap-addon')?.choices?.find((c) => c.id === 'yes')?.priceDelta === 15,
  m.options.find((o) => o.id === 'cap-addon'));
await shoot('3-addon.png');

// ── 10. publish: validation + the downloaded manifest itself validates ─────
await page.click('.tabs button:has-text("Publish")');
const report = await page.textContent('[data-testid="validation-report"]');
check('validation report says valid', /Valid —/.test(report ?? ''), report);

const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('[data-testid="download-manifest"]'),
]);
const downloaded = JSON.parse(readFileSync(await download.path(), 'utf8'));
const verdict = validateManifest(downloaded);
check('downloaded manifest passes the embed validator', verdict.ok, verdict.errors);
check('downloaded manifest carries the session edits',
  downloaded.parts[1].visibleWhen?.option === 'cap-addon'
  && downloaded.options.find((o) => o.id === 'base-colour')?.custom?.priceDelta === 35
  && !!downloaded.palettes[0].swatches.find((s) => s.id === 'brand-teal'),
  '');
check('downloaded manifest keeps the saved camera view, not an auto-frame',
  downloaded.camera?.userSet === true
  && m.camera.position.every((v, i) => Math.abs(v - downloaded.camera.position[i]) < 0.01),
  downloaded.camera);

const [modelDl] = await Promise.all([
  page.waitForEvent('download'),
  page.click('[data-testid="download-model"]'),
]);
const glb = readFileSync(await modelDl.path());
check('downloaded GLB has the GLB magic and both parts',
  glb.readUInt32LE(0) === 0x46546c67 && glb.includes('Base') && glb.includes('Cap'), glb.length);
check('downloaded GLB is meshopt-compressed', glb.includes('EXT_meshopt_compression'), '');
check('compression size note appears', /compressed, from/.test(await page.textContent('[data-testid="size-note"]') ?? ''),
  await page.textContent('[data-testid="size-note"]'));
await shoot('4-publish.png');

// ── 11. structure: undo/redo, reorder, variants, groups, preview ───────────
{
  const visible = (id) => page.evaluate((pid) => window.__studioViewer.meshOf(pid)?.visible, id);

  // 11a. keyboard + button undo/redo of an ordinary edit
  await page.click('.tabs button:has-text("Parts")');
  await page.click('.part-name:has-text("Base")');
  await page.waitForTimeout(150);
  await page.fill('[data-testid="size-w"]', '90');
  await page.press('[data-testid="size-w"]', 'Enter');
  await page.waitForTimeout(200);
  await page.click('.tabs button:has-text("Parts")'); // move focus off the input — its own Ctrl+Z is the text field's
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  let w = Number(await page.inputValue('[data-testid="size-w"]'));
  check('Ctrl+Z undoes the size edit', near(w, 80), w);
  await page.click('[data-testid="redo"]');
  await page.waitForTimeout(200);
  w = Number(await page.inputValue('[data-testid="size-w"]'));
  check('Redo button restores it', near(w, 90), w);
  await page.click('[data-testid="undo"]');
  await page.waitForTimeout(200);
  w = Number(await page.inputValue('[data-testid="size-w"]'));
  check('Undo button rewinds again', near(w, 80), w);

  // A pointer drag from a six-dot handle to a target element. `place` picks
  // the drop band: above/below a row reorders, centre of a bundle joins it.
  const dragTo = async (handleSel, targetSel, place) => {
    const h = await page.locator(handleSel).boundingBox();
    const t = await page.locator(targetSel).boundingBox();
    const from = [h.x + h.width / 2, h.y + h.height / 2];
    const to = [
      t.x + t.width / 2,
      place === 'above' ? t.y + 2 : place === 'below' ? t.y + t.height - 2 : t.y + t.height / 2,
    ];
    await page.mouse.move(...from);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(from[0] + (to[0] - from[0]) * i / 6, from[1] + (to[1] - from[1]) * i / 6);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(250);
  };

  // 11b. reorder by dragging the handle — parts order, option order and the
  // explorer all follow
  await dragTo('[data-testid="drag-base"]', '.entry-line:has([data-testid="drag-cap"])', 'below');
  m = await manifest();
  check('dragging a row below another reorders manifest parts and drags the options along',
    m.parts.map((p) => p.id).join(',') === 'cap,base'
    && m.options.findIndex((o) => o.id === 'cap-colour') < m.options.findIndex((o) => o.id === 'base-colour'),
    { parts: m.parts.map((p) => p.id), options: m.options.map((o) => o.id) });
  check('explorer lists the new order', (await page.textContent('.part-rows .part-name'))?.includes('Cap'),
    await page.textContent('.part-rows .part-name'));
  await dragTo('[data-testid="drag-base"]', '.entry-line:has([data-testid="drag-cap"])', 'above');
  m = await manifest();
  check('dragging back above restores the order', m.parts.map((p) => p.id).join(',') === 'base,cap', m.parts.map((p) => p.id));

  // 11c. multi-select → pick-one set. The cap is still an optional add-on
  // from section 9 — creating the set must absorb that, not silently refuse
  // (the exact failure a real merchant hit).
  await page.check('[data-testid="pick-base"]');
  await page.check('[data-testid="pick-cap"]');
  await page.click('[data-testid="make-variant"]');
  await page.fill('[data-testid="structure-label"]', 'Body style');
  await page.click('[data-testid="structure-confirm"]');
  await page.waitForTimeout(300);
  m = await manifest();
  const variant = m.options.find((o) => o.id === 'body-style');
  check('pick-one set created — and it absorbed the cap\'s add-on state',
    variant?.role === 'variant' && variant?.choices?.map((c) => c.id).join(',') === 'base,cap'
    && variant?.default === 'base'
    && !m.options.some((o) => o.id === 'cap-addon')
    && m.parts.every((p) => p.visibleWhen?.option === 'body-style'),
    { variant, options: m.options.map((o) => o.id) });
  check('choices are mutually exclusive — only the default shows',
    (await visible('base')) === true && (await visible('cap')) === false, '');
  await page.click('.entry-members .part-name:has-text("Cap")');
  await page.waitForTimeout(300);
  check('clicking the hidden choice swaps which one shows',
    (await visible('base')) === false && (await visible('cap')) === true, '');
  check('a member\'s editor prices the choice — no add-on toggle to corrupt it',
    (await page.isVisible('[data-testid="variant-price"]'))
    && !(await page.isVisible('[data-testid="addon-toggle"]')), '');

  // 11d. the preview must let customers actually choose between them
  await page.click('[data-testid="preview-open"]');
  await page.waitForSelector('.preview-overlay .cfg-tab', { timeout: 20000 });
  await page.waitForTimeout(400);
  await page.click('.preview-overlay .cfg-tab:has-text("Body style")');
  await page.waitForTimeout(200);
  await page.click('.preview-overlay .cfg-choice:has-text("Cap")');
  await page.waitForTimeout(300);
  check('customers can switch the pick-one set in the preview',
    await page.evaluate(() => (window).__previewPayload?.selections?.['body-style'] === 'cap'),
    await page.evaluate(() => (window).__previewPayload?.selections));
  await page.click('[data-testid="preview-close"]');
  await page.waitForTimeout(200);

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  m = await manifest();
  check('one undo removes the set and restores the cap\'s add-on state',
    !m.options.some((o) => o.id === 'body-style') && m.options.some((o) => o.id === 'cap-addon')
    && m.parts[1].visibleWhen?.option === 'cap-addon'
    && (await visible('base')) === true && (await visible('cap')) === true,
    m.options.map((o) => o.id));

  // 11e. multi-select → assembly: one entry, one merged colour control
  await page.check('[data-testid="pick-base"]');
  await page.check('[data-testid="pick-cap"]');
  await page.click('[data-testid="make-group"]');
  await page.fill('[data-testid="structure-label"]', 'Shell');
  await page.click('[data-testid="structure-confirm"]');
  await page.waitForTimeout(300);
  m = await manifest();
  const shellColour = m.options.find((o) => o.id === 'shell-colour');
  check('assembly recorded; member colour options merged into one',
    m.groups?.[0]?.id === 'shell' && m.groups[0].parts.join(',') === 'base,cap'
    && shellColour?.parts?.length === 2
    && !m.options.some((o) => o.id === 'base-colour' || o.id === 'cap-colour'),
    { groups: m.groups, options: m.options.map((o) => o.id) });
  await page.click('[data-testid="eye-shell"]');
  await page.waitForTimeout(200);
  check('assembly eyeball hides every member',
    (await visible('base')) === false && (await visible('cap')) === false, '');
  await page.click('[data-testid="eye-shell"]');
  await page.waitForTimeout(200);
  check('…and shows them again',
    (await visible('base')) === true && (await visible('cap')) === true, '');

  // Drag a member OUT: below two members the assembly dissolves, and the
  // departing part paints alone again.
  await dragTo('[data-testid="drag-cap"]', '.part-list-head', 'centre');
  m = await manifest();
  check('dragging a member out dissolves the two-part assembly and splits its colour back',
    !m.groups && m.options.some((o) => o.id === 'cap-colour'),
    { groups: m.groups, options: m.options.map((o) => o.id) });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  m = await manifest();
  check('undo re-forms the assembly', m.groups?.[0]?.id === 'shell', m.groups);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  m = await manifest();
  check('a second undo unwinds the assembly itself',
    !m.groups && m.options.some((o) => o.id === 'base-colour') && m.options.some((o) => o.id === 'cap-colour'),
    { groups: m.groups, options: m.options.map((o) => o.id) });
  await shoot('5-structure.png');

  // 11e². the explorer panel resizes and collapses at its divider
  const panelWidth = () => page.evaluate(() => document.querySelector('.panel').getBoundingClientRect().width);
  {
    const divider = await page.locator('[data-testid="panel-divider"]').boundingBox();
    await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(divider.x + i * 24, divider.y + divider.height / 2);
    await page.mouse.up();
    await page.waitForTimeout(250);
    const widened = await panelWidth();
    check('dragging the divider widens the explorer', widened > 420, widened);
    await page.click('[data-testid="panel-divider"]');
    await page.waitForTimeout(350);
    check('clicking the divider collapses it', (await panelWidth()) < 10, await panelWidth());
    await page.click('[data-testid="panel-divider"]');
    await page.waitForTimeout(350);
    check('…and expands it again', (await panelWidth()) > 420, await panelWidth());
  }

  // 11f. the customer preview is the real embed
  await page.click('[data-testid="preview-open"]');
  await page.waitForSelector('.preview-overlay .cfg-swatch', { timeout: 20000 });
  const previewBits = await page.evaluate(() => ({
    swatches: document.querySelectorAll('.preview-overlay .cfg-swatch').length,
    tabs: document.querySelectorAll('.preview-overlay .cfg-tab').length,
    canvas: !!document.querySelector('.preview-overlay .cfg-stage canvas'),
  }));
  check('preview mounts the real embed — swatches, tabs, its own canvas',
    previewBits.swatches > 0 && previewBits.tabs > 0 && previewBits.canvas, previewBits);
  await shoot('6-preview.png');
  await page.click('[data-testid="preview-close"]');
  await page.waitForTimeout(200);
  check('preview closes cleanly',
    await page.evaluate(() => !document.querySelector('.preview-overlay')), '');
}

// ── 12. delete a part ──────────────────────────────────────────────────────
{
  await page.click('.tabs button:has-text("Parts")');
  await page.click('[data-testid="delete-cap"]');
  await page.waitForTimeout(300);
  m = await manifest();
  check('deleting a part removes it and its options',
    m.parts.length === 1 && !m.options.some((o) => o.id === 'cap-colour' || o.id === 'cap-addon'),
    { parts: m.parts.length, options: m.options.map((o) => o.id) });
  const afterDelete = validateManifest(m);
  check('manifest still valid after the delete', afterDelete.ok, afterDelete.errors);
}

check('material has the studio environment (dull-gloss plastic)',
  await page.evaluate(() => !!window.__studioViewer.scene.environment), '');
check('parts render double-sided — stray winding cannot look transparent',
  await page.evaluate(() => window.__studioViewer.meshOf('base')?.material.side === 2 /* THREE.DoubleSide */), '');

check('no console errors across the whole session', errors.length === 0, errors.join(' | '));

const failed = checks.filter(([, pass]) => !pass).length;
console.log(failed ? `\n${failed} of ${checks.length} failed` : `\nall ${checks.length} passed`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
