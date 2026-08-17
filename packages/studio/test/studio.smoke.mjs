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
// A second file to ADD to the project mid-session — authored far from the
// origin on purpose, so landing centred-and-grounded proves normalisation.
const SECOND_3MF = zipSync({
  '3D/3dmodel.model': new TextEncoder().encode(
    `<?xml version="1.0"?><model unit="millimeter">
     <resources>
      <object id="1" name="Hook" type="model"><mesh>${boxGeom(8, 8, 8)}</mesh></object>
     </resources>
     <build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 70 40 25"/></build>
    </model>`),
});

// ── serve dist ──────────────────────────────────────────────────────────────
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  // without the right MIME, WebAssembly streaming compilation logs a
  // console error while falling back — which trips the no-errors check
  '.wasm': 'application/wasm',
};
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

// ── 1. viewport-first start + first import ──────────────────────────────────
// The Studio opens straight into the 3D viewport — no dropzone gate. The
// first file comes in through the same ＋ Add parts input as every later one.
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__studioViewerReady === true, { timeout: 20000 });
check('Studio opens into the 3D viewport with no model', await page.isVisible('.stage canvas'), '');
check('empty explorer points at ＋ Add parts', await page.isVisible('[data-testid="empty-parts"]'), '');
// The Import button opens a dialog: dropzone + the orientation preset.
await page.click('[data-testid="add-model"]');
check('the import dialog opens with a dropzone', await page.isVisible('[data-testid="import-dropzone"]'), '');
check('orientation preset lives in the import dialog', await page.isVisible('[data-testid="axes-preset"]'), '');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
let m = await manifest();
check('empty project is a valid manifest with no parts or models',
  m?.parts?.length === 0 && m?.models?.length === 0, { parts: m?.parts?.length, models: m?.models?.length });
check('no Orbit tab — orbiting is the default, not a mode',
  !(await page.$('[data-testid="gizmo-off"]')), '');
check('with nothing imported the viewport tools are disabled',
  await page.evaluate(() =>
    document.querySelector('[data-testid="gizmo-transform"]')?.disabled === true
    && document.querySelector('[data-testid="snap-tool"]')?.disabled === true), '');
await shoot('0-empty.png');

await page.setInputFiles('[data-testid="add-model-input"]', {
  name: 'desk-organiser.3mf', mimeType: 'application/octet-stream', buffer: Buffer.from(FIXTURE_3MF),
});
await page.waitForFunction(() => (window).__studio?.manifest?.parts?.length === 2, { timeout: 20000 });
await page.waitForFunction(() => (window).__studioViewerReady === true, { timeout: 20000 });
await page.waitForTimeout(800);
await shoot('1-loaded.png');

m = await manifest();
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

// The stepper triangles tweak without typing: one click = one step.
await page.click('[data-testid="rot-x-up"]');
await page.waitForTimeout(150);
m = await manifest();
check('stepper arrows tweak a field (+5° on rotation X)', m.parts[0].placement?.rotation?.[0] === 5, m.parts[0].placement?.rotation);
await page.click('[data-testid="rot-x-down"]');
await page.waitForTimeout(150);
m = await manifest();
check('…and step it back to zero', (m.parts[0].placement?.rotation?.[0] ?? 0) === 0, m.parts[0].placement?.rotation);

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
// Anchors hide behind a one-line summary chip per axis; expanding an axis
// reveals the full-width dropdown and the min/centre/max icon triads.
const pick = async (selectId, optionValue) => {
  await page.click(`[data-testid="${selectId}"]`);
  await page.click(`[data-testid="${selectId}-opt-${optionValue}"]`);
  await page.waitForTimeout(120);
};
check('anchor controls stay hidden until the axis is expanded',
  !(await page.isVisible('[data-testid="anchor-mode-y"]')), '');
check('axis names wear their gizmo colours (X red)', await page.evaluate(() => {
  const el = document.querySelector('[data-testid="anchor-x"] .axis-name');
  return !!el && getComputedStyle(el).color === 'rgb(212, 74, 58)';
}), await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="anchor-x"] .axis-name')).color));
await page.click('[data-testid="anchor-summary-y"]');
await pick('anchor-mode-y', 'base');
await page.click('[data-testid="anchor-my-y-min"]');
await page.waitForTimeout(120);
await page.click('[data-testid="anchor-their-y-max"]');
await page.waitForTimeout(150);
check('the summary chip reads the anchor in plain words',
  /min → Base max/.test(await page.textContent('[data-testid="anchor-summary-y"]') ?? ''),
  await page.textContent('[data-testid="anchor-summary-y"]'));
await page.fill('[data-testid="offset-y"]', '2');
await page.press('[data-testid="offset-y"]', 'Enter');
await page.waitForTimeout(300);
m = await manifest();
check('cap anchored: my min at base:max + 2 mm',
  JSON.stringify(m.parts[1].placement?.y) === JSON.stringify({ align: 'min', to: 'base:max', offset: 2 }),
  m.parts[1].placement?.y);

// The row's number field speaks ABSOLUTE millimetres (part centre); typing a
// new value slides the offset under the anchor instead of rewiring it.
// Base top: raw 0..10 scaled ×3 about its centre (5) → spans −10..20.
const zAbs = Number(await page.inputValue('[data-testid="pos-y"]'));
check('the position field shows the absolute centre', near(zAbs, 24), zAbs); // base top 20 + 2 + half of 4
await page.fill('[data-testid="pos-y"]', String(zAbs + 5));
await page.press('[data-testid="pos-y"]', 'Enter');
await page.waitForTimeout(250);
m = await manifest();
check('absolute position edits slide the anchored offset',
  near(m.parts[1].placement?.y?.offset ?? 0, 7) && m.parts[1].placement?.y?.to === 'base:max',
  m.parts[1].placement?.y);
await page.keyboard.press('Control+z');
await page.waitForTimeout(250);
m = await manifest();
check('…and one undo puts it back', near(m.parts[1].placement?.y?.offset ?? 0, 2), m.parts[1].placement?.y);
// The base was doubled earlier; the camera must have backed off to keep the
// whole model in frame. Inside-the-model looks like coverage near 1.0.
const afterResize = await measureCoverage();
// The camera is focused on the selected cap, so the model fills a good share
// of the frame — but "inside the model" is ~1.0 coverage with no background.
// The failure modes this guards are extremes: a camera that never refit shows
// the model microscopic (<0.001), a camera inside the model shows ~1.0 with
// no background. The doubled part is WHITE, and a tone-mapped white top face
// sits within the background band, so healthy coverage here is only ~0.03.
check('camera reframed after the resize (model in view, not engulfing it)',
  afterResize > 0.02 && afterResize < 0.92, afterResize.toFixed(4));
await shoot('2-anchored.png');

// ── 6a. edge chamfer: rebuild the cap's edges, then restore ────────────────
// The Edges section is a GEOMETRY edit through the Manifold kernel (WASM in
// the browser): Apply swaps the part's mesh for a bevelled rebuild, Restore
// puts the stashed original back. Base and cap don't share meshes, so the
// manifest must come through untouched.
{
  const vertsOfCap = () => page.evaluate(() =>
    window.__studioViewer?.meshOf?.('cap')?.geometry?.attributes?.position?.count ?? null);
  check('the Edges section offers style, where and size',
    await page.isVisible('[data-testid="edges-style"]')
    && await page.isVisible('[data-testid="edges-where"]')
    && await page.isVisible('[data-testid="edges-size"]'), '');
  const beforeVerts = await vertsOfCap();
  const meshRefBefore = (await manifest()).parts[1].mesh;
  await page.fill('[data-testid="edges-size"]', '1');
  await page.press('[data-testid="edges-size"]', 'Enter');
  await page.click('[data-testid="edges-apply"]');
  await page.waitForFunction((n) => {
    const c = window.__studioViewer?.meshOf?.('cap')?.geometry?.attributes?.position?.count;
    return !!c && c !== n;
  }, beforeVerts, { timeout: 30_000 });
  const afterVerts = await vertsOfCap();
  check('applying a chamfer rebuilt the cap mesh (more vertices than the box had)',
    afterVerts > beforeVerts, `${beforeVerts} → ${afterVerts}`);
  m = await manifest();
  check('an unshared mesh keeps its manifest reference', m.parts[1].mesh === meshRefBefore, m.parts[1].mesh);
  check('the restore button appeared', await page.isVisible('[data-testid="edges-restore"]'), '');
  await page.click('[data-testid="edges-restore"]');
  await page.waitForFunction((n) =>
    window.__studioViewer?.meshOf?.('cap')?.geometry?.attributes?.position?.count === n,
  beforeVerts, { timeout: 15_000 });
  check('restore brought the original geometry back', await vertsOfCap() === beforeVerts, await vertsOfCap());
  check('…and the restore button folded away', !(await page.isVisible('[data-testid="edges-restore"]')), '');
}

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
  const pill = await page.evaluate(() => ({
    pill: document.querySelector('.mode-pill')?.getBoundingClientRect().left ?? -1,
    active: document.querySelector('.gizmo-bar button.is-active')?.getBoundingClientRect().left ?? -2,
  }));
  check('the mode pill slid under the active mode', Math.abs(pill.pill - pill.active) < 2, pill);
  check('origin axes step aside while the gizmo shows its own',
    await page.evaluate(() => window.__studioAxes.visible === false), '');
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
  check('…and the origin axes return', await page.evaluate(() => window.__studioAxes.visible === true), '');
  await page.click('.part-name:has-text("Cap")');
  await page.waitForTimeout(700);
  check('selecting a part slides the properties panel in', await page.evaluate(
    () => document.querySelector('[data-testid="props-float"]')?.classList.contains('is-open') === true), '');
  const chrome = await page.evaluate(() => {
    const bar = document.querySelector('.gizmo-bar').getBoundingClientRect();
    const panel = document.querySelector('[data-testid="props-float"]').getBoundingClientRect();
    const cube = document.querySelector('.viewcube').getBoundingClientRect();
    const stage = document.querySelector('.stage').getBoundingClientRect();
    return {
      widthDiff: Math.abs(bar.width - panel.width),
      rightDiff: Math.abs(bar.right - panel.right),
      stacked: bar.bottom <= panel.top,
      cubeFromLeft: cube.left - stage.left,
    };
  });
  check('tool row sits right above the properties panel, same width and edge',
    chrome.widthDiff < 2 && chrome.rightDiff < 2 && chrome.stacked, chrome);
  check('view cube lives in the top-left corner', chrome.cubeFromLeft < 120, chrome.cubeFromLeft);
  // No Orbit tab any more — Transform is a toggle, and the deselect a few
  // checks back already disarmed it on its own.
  check('deselecting disarmed Transform (orbit is the default state)',
    await page.evaluate(() => !document.querySelector('[data-testid="gizmo-transform"].is-active')), '');
  await page.click('[data-testid="gizmo-transform"]');
  await page.waitForTimeout(200);
  check('Transform arms on click',
    await page.evaluate(() => !!document.querySelector('[data-testid="gizmo-transform"].is-active')
      && !!window.__studioGizmo.translate.object), '');
  await page.click('[data-testid="gizmo-transform"]');
  await page.waitForTimeout(200);
  check('…and toggles back off on a second click',
    await page.evaluate(() => !document.querySelector('[data-testid="gizmo-transform"].is-active')
      && !window.__studioGizmo.translate.object), '');

  // …and clicking empty space deselects, which disarms Transform by itself.
  await page.click('[data-testid="gizmo-transform"]');
  await page.waitForTimeout(150);
  const bareSpot = await page.evaluate(() => {
    const r = document.querySelector('.stage canvas').getBoundingClientRect();
    for (let fy = 0.15; fy < 0.95; fy += 0.1) {
      for (let fx = 0.05; fx < 0.6; fx += 0.08) {
        if (fy < 0.25 && (fx < 0.35 || fx > 0.75)) continue;
        const x = r.left + r.width * fx, y = r.top + r.height * fy;
        if (!window.__studioViewer.pickFaceAt(x, y)) return [x, y];
      }
    }
    return null;
  });
  await page.mouse.click(bareSpot[0], bareSpot[1]);
  await page.waitForTimeout(600);
  check('clicking away from the part drops back to orbiting',
    await page.evaluate(() => !document.querySelector('[data-testid="gizmo-transform"].is-active')
      && !window.__studioGizmo.translate.object), '');
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

  // Rename is double-click on the name — no pencil button.
  await page.dblclick('.part-name:has-text("Cap")');
  await page.fill('[data-testid="rename-input-cap"]', 'Lid');
  await page.press('[data-testid="rename-input-cap"]', 'Enter');
  await page.waitForTimeout(150);
  m = await manifest();
  check('double-click rename changes the label, not the id',
    m.parts[1].label === 'Lid' && m.parts[1].id === 'cap', m.parts[1]);
  await page.dblclick('.part-name:has-text("Lid")');
  await page.fill('[data-testid="rename-input-cap"]', 'Cap');
  await page.press('[data-testid="rename-input-cap"]', 'Enter');
  await page.waitForTimeout(150);

  await page.click('.part-name:has-text("Base")');
  await page.waitForTimeout(150);
  // The colour dropdown is the Studio's own swatch listbox.
  await page.click('[data-testid="default-colour"]');
  check('colour dropdown lists swatch chips, not a native menu',
    await page.evaluate(() => document.querySelectorAll('.ui-select-pop .chip.small').length > 3), '');
  await page.click('[data-testid="default-colour-opt-red"]');
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
  const overlay = (slot) => page.evaluate(
    (s) => !!window.__studioViewer.scene.getObjectByName(`surface-highlight-${s}`), slot);

  // Hovering pre-highlights the whole flat surface under the pointer…
  const capAt = await screenPos('cap');
  await page.mouse.move(capAt[0], capAt[1]);
  await page.waitForTimeout(200);
  check('hovering pre-highlights the flat surface before picking', await overlay('hover'), '');

  // …and the first pick keeps its glow while the second is chosen.
  await page.mouse.click(capAt[0], capAt[1]);
  await page.waitForTimeout(200);
  check('the chosen surface stays highlighted', await overlay('first'), '');

  const baseAt = await screenPos('base');
  await page.mouse.click(baseAt[0], baseAt[1]);
  await page.waitForTimeout(300);
  m = await manifest();
  check('snap mates the faces flush along the clicked axis',
    JSON.stringify(m.parts[1].placement?.z) === JSON.stringify({ align: 'max', to: 'base:max', offset: 0 }),
    m.parts[1].placement?.z);
  check('…and centres the part onto the target, so the faces actually meet',
    JSON.stringify(m.parts[1].placement?.x) === JSON.stringify({ align: 'center', to: 'base:center', offset: 0 })
    && JSON.stringify(m.parts[1].placement?.y) === JSON.stringify({ align: 'center', to: 'base:center', offset: 0 }),
    { x: m.parts[1].placement?.x, y: m.parts[1].placement?.y });
  check('highlights clear once the snap lands',
    !(await overlay('first')) && !(await overlay('hover')), '');
  const snapVerdict = validateManifest(m);
  check('manifest still valid after the snap', snapVerdict.ok, snapVerdict.errors);
}

// ── 6h. finish tab: gloss/metal sliders apply live and undo cleanly ────────
{
  const before = (await manifest()).parts[0].material?.roughness;
  await page.click('.tabs button:has-text("Finish")');
  await page.waitForTimeout(150);
  await page.locator('[data-testid="gloss-base"]').evaluate((el) => {
    // React tracks the input's value itself; a plain `el.value = …` is
    // invisible to its change detection. Go through the native setter.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '0.9');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(250);
  m = await manifest();
  check('gloss slider writes roughness into the manifest',
    near(m.parts[0].material?.roughness ?? -1, 0.1), m.parts[0].material);
  check('…and the viewer material follows live', await page.evaluate(() =>
    Math.abs(window.__studioViewer.meshOf('base').material.roughness - 0.1) < 1e-6), '');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  m = await manifest();
  check('finish edits undo like everything else',
    (m.parts[0].material?.roughness ?? undefined) === (before ?? undefined), m.parts[0].material);

  // Scene sliders: staging knobs land in the manifest AND on the renderer.
  await page.locator('[data-testid="scene-exposure"]').evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '0.85');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(250);
  m = await manifest();
  check('the light slider writes scene.exposure',
    near(m.scene?.exposure ?? -1, 0.85), m.scene);
  check('…and the renderer follows live', await page.evaluate(() =>
    Math.abs(window.__studioViewer.renderer.toneMappingExposure - 0.85) < 1e-6), '');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  check('undo returns the default staging', await page.evaluate(() =>
    Math.abs(window.__studioViewer.renderer.toneMappingExposure - 0.6) < 1e-6), '');

  // Procedural texture library: pick a finish, tune it, clear it.
  await pick('texture-base', 'leather');
  await page.waitForTimeout(250);
  m = await manifest();
  check('texture library applies to the part', m.parts[0].material?.texture?.type === 'leather', m.parts[0].material);
  check('…and the viewer bump-maps it live',
    await page.evaluate(() => !!(window).__studioViewer.meshOf('base').material.normalMap), '');
  await page.locator('[data-testid="texscale-base"]').evaluate((el) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, '20');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(250);
  m = await manifest();
  check('the grain-size slider writes the scale', m.parts[0].material?.texture?.scaleMm === 20, m.parts[0].material?.texture);
  await pick('texture-base', '');
  await page.waitForTimeout(250);
  check('None clears the finish and the bump map',
    await page.evaluate(() => !(window).__studioViewer.meshOf('base').material.normalMap), '');

  await page.click('.tabs button:has-text("Parts")');
  await page.waitForTimeout(150);
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

// ── 10. publish: the topbar CTA opens the tab; the download validates ──────
await page.click('[data-testid="publish-cta"]');
await page.waitForTimeout(200);
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
// Publish now lives in a floating modal off the CTA — close it to move on.
await page.click('[data-testid="publish-close"]');
await page.waitForTimeout(200);
check('the publish modal closes', await page.evaluate(() => !document.querySelector('.publish-modal')), '');

// Export: its own topbar dialog (where Preview used to live) — it exports
// exactly the ☑-TICKED parts, so tick one first; the dialog closes itself
// after each save.
check('with nothing ticked the Export button is inactive',
  await page.evaluate(() => document.querySelector('[data-testid="export-open"]')?.disabled === true), '');
await page.check('[data-testid="pick-base"]');
await page.waitForTimeout(150);
await page.click('[data-testid="export-open"]');
check('the export dialog names what it exports',
  /Base/.test(await page.textContent('[data-testid="export-parts"]') ?? ''),
  await page.textContent('[data-testid="export-parts"]'));
const [stlDl] = await Promise.all([
  page.waitForEvent('download'),
  page.click('[data-testid="export-download"]'),
]);
const stl = readFileSync(await stlDl.path());
const stlTris = stl.readUInt32LE(80);
check('STL export is well-formed and carries real triangles',
  stlDl.suggestedFilename().endsWith('.stl') && stlTris > 0 && stl.length === 84 + stlTris * 50,
  { name: stlDl.suggestedFilename(), bytes: stl.length, tris: stlTris });
await page.click('[data-testid="export-open"]');
await page.click('[data-testid="export-format"]');
await page.click('[data-testid="export-format-opt-3mf"]');
const [mfDl] = await Promise.all([
  page.waitForEvent('download'),
  page.click('[data-testid="export-download"]'),
]);
const mf = readFileSync(await mfDl.path());
check('3MF export is a zip package with the parts kept separate',
  mfDl.suggestedFilename().endsWith('.3mf') && mf[0] === 0x50 && mf[1] === 0x4b,
  { name: mfDl.suggestedFilename(), bytes: mf.length });
await page.uncheck('[data-testid="pick-base"]'); // leave the tick-set clean

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

  // Move-to-origin from the properties panel; one undo brings it back.
  await page.click('.part-name:has-text("Cap")');
  await page.waitForTimeout(400);
  await page.click('[data-testid="to-origin"]');
  await page.waitForTimeout(250);
  const capBox = await page.evaluate(() => window.__studioViewer.partBox('cap'));
  check('To origin centres the part on the flat axes and grounds it',
    Math.abs((capBox.min[0] + capBox.max[0]) / 2) < 1e-3
    && Math.abs(capBox.min[1]) < 1e-3
    && Math.abs((capBox.min[2] + capBox.max[2]) / 2) < 1e-3,
    capBox);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(250);

  // Match: land exactly at another part's location (and rotation), live.
  await page.click('[data-testid="match-select"]');
  await page.click('[data-testid="match-select-opt-base"]');
  await page.click('[data-testid="match-apply"]');
  await page.waitForTimeout(250);
  const boxes = await page.evaluate(() => ({
    cap: window.__studioViewer.partBox('cap'), base: window.__studioViewer.partBox('base'),
  }));
  check('Match lands the part centre-on-centre with the target',
    [0, 1, 2].every((a) =>
      Math.abs((boxes.cap.min[a] + boxes.cap.max[a]) / 2 - (boxes.base.min[a] + boxes.base.max[a]) / 2) < 1e-3),
    boxes);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(250);

  // Duplicate a single part straight from its row button.
  await page.click('[data-testid="duplicate-base"]');
  await page.waitForFunction(() => (window).__studio?.manifest?.parts?.length === 3, { timeout: 20000 });
  await page.waitForFunction(() => (window).__studioViewerReady === true, { timeout: 20000 });
  m = await manifest();
  check('a loose part duplicates from its row',
    m.parts.some((p) => p.id === 'base-copy') && m.options.some((o) => o.id === 'base-colour-copy'),
    { parts: m.parts.map((p) => p.id) });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  m = await manifest();
  check('one undo removes the part copy', m.parts.length === 2, m.parts.map((p) => p.id));

  // A pointer drag from a six-dot handle to a target element. `place` picks
  // the drop band: above/below a row reorders, centre of a bundle joins it.
  let ghostSeen = false;
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
      if (i === 3 && await page.isVisible('.drag-ghost')) ghostSeen = true;
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
  check('a card rides the cursor while dragging', ghostSeen, '');
  await dragTo('[data-testid="drag-base"]', '.entry-line:has([data-testid="drag-cap"])', 'above');
  m = await manifest();
  check('dragging back above restores the order', m.parts.map((p) => p.id).join(',') === 'base,cap', m.parts.map((p) => p.id));

  // 11c. variant set: the button waits until two parts are ticked, then the
  // flow names the set. The cap is still an optional add-on from section 9 —
  // creating the set must absorb that, not silently refuse (the exact
  // failure a real merchant hit).
  check('the variant-set button waits for a selection (disabled until parts are ticked)',
    await page.evaluate(() => document.querySelector('[data-testid="new-variant"]')?.disabled === true), '');
  await page.check('[data-testid="pick-base"]');
  await page.check('[data-testid="pick-cap"]');
  await page.click('[data-testid="new-variant"]');
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

  // Double-click renames the set inline, right in the explorer.
  await page.dblclick('.part-name:has-text("Body style")');
  await page.fill('[data-testid="rename-input-body-style"]', 'Tile');
  await page.press('[data-testid="rename-input-body-style"]', 'Enter');
  await page.waitForTimeout(200);
  m = await manifest();
  check('double-click renames the variant set inline',
    m.options.find((o) => o.id === 'body-style')?.label === 'Tile', m.options.find((o) => o.id === 'body-style')?.label);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  m = await manifest();
  check('…and the rename is one undo step',
    m.options.find((o) => o.id === 'body-style')?.label === 'Body style',
    m.options.find((o) => o.id === 'body-style')?.label);

  // Soloing a HIDDEN variant member selects it too — otherwise solo shows
  // nothing, since the member's visibleWhen still hides it.
  await page.click('[data-testid="solo-cap"]');
  await page.waitForTimeout(300);
  check('soloing a hidden variant member shows it (solo selects it as well)',
    (await visible('cap')) === true && (await visible('base')) === false, '');
  await page.click('[data-testid="show-all"]');
  await page.waitForTimeout(200);

  await page.click('.entry-members .part-name:has-text("Cap")');
  await page.waitForTimeout(300);
  check('clicking the hidden choice swaps which one shows',
    (await visible('base')) === false && (await visible('cap')) === true, '');
  check('a member\'s editor prices the choice — no add-on toggle to corrupt it',
    (await page.isVisible('[data-testid="variant-price"]'))
    && !(await page.isVisible('[data-testid="addon-toggle"]')), '');

  // Duplicate the whole set from the explorer: parts, joints, colours and
  // exclusivity all copied; the viewer rebuilds so the copies render.
  await page.click('.part-name:has-text("Body style")');
  await page.waitForTimeout(200);
  check('the set header opens the variant editor',
    await page.isVisible('[data-testid="variant-editor-body-style"]'), '');
  check('the set editor transforms like a part — position, rotation, no set-management section',
    (await page.isVisible('[data-testid="set-pos-x"]'))
    && (await page.isVisible('[data-testid="set-rot-x"]'))
    && !(await page.isVisible('[data-testid="section-variant-set"]')), '');
  await page.click('[data-testid="duplicate-body-style"]');
  await page.waitForFunction(() => (window).__studio?.manifest?.parts?.length === 4, { timeout: 20000 });
  await page.waitForFunction(() => (window).__studioViewerReady === true, { timeout: 20000 });
  m = await manifest();
  check('duplicating a variant set copies parts and its exclusive choice',
    m.parts.length === 4
    && m.parts.some((p) => p.id === 'base-copy') && m.parts.some((p) => p.id === 'cap-copy')
    && m.options.some((o) => o.id === 'body-style-copy')
    && m.parts.find((p) => p.id === 'base-copy')?.visibleWhen?.option === 'body-style-copy',
    { parts: m.parts.map((p) => p.id), options: m.options.map((o) => o.id) });
  const copyVerdict = validateManifest(m);
  check('manifest still valid after the duplicate', copyVerdict.ok, copyVerdict.errors);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  m = await manifest();
  check('one undo removes the whole copy', m.parts.length === 2, m.parts.map((p) => p.id));

  // 11d. the preview must let customers actually choose between them — and
  // the panel is either-or too: the hidden side has no colour tab or row.
  await page.click('[data-testid="publish-cta"]');
  await page.click('[data-testid="preview-open"]'); // in the publish modal head; closes the modal
  await page.waitForSelector('.preview-overlay .cfg-tab', { timeout: 45000 });
  await page.waitForTimeout(400);
  // The active tab wears a ✓ — strip it, these checks are about the NAMES.
  const tabTexts = () => page.$$eval('.preview-overlay .cfg-tab', (els) => els.map((e) => (e.textContent ?? '').replace('✓', '')));
  let previewTabs = await tabTexts();
  check('the variant set folds into ONE tab, named for the current member',
    previewTabs.includes('Body style (Base)') && !previewTabs.includes('Base') && !previewTabs.includes('Cap'),
    previewTabs);
  await page.click('.preview-overlay .cfg-tab:has-text("Body style")');
  await page.waitForTimeout(200);
  check('the member choice and its colour swatches are picked together in that tab',
    await page.evaluate(() => document.querySelectorAll('.preview-overlay .cfg-choice').length >= 2
      && document.querySelectorAll('.preview-overlay .cfg-swatch').length > 0), '');
  // Pick a NON-default colour, then switch member: the colour must follow.
  // (Base's default is already red from the default-colour test upstream.)
  await page.click('.preview-overlay .cfg-swatch[aria-label="Sky Blue"]');
  await page.waitForTimeout(200);
  check('a swatch picked in the folded tab lands on the visible member',
    await page.evaluate(() => (window).__previewPayload?.selections?.['base-colour'] === 'blue'),
    await page.evaluate(() => (window).__previewPayload?.selections));
  await page.click('.preview-overlay .cfg-choice:has-text("Cap")');
  await page.waitForTimeout(300);
  check('customers can switch the variant set in the preview',
    await page.evaluate(() => (window).__previewPayload?.selections?.['body-style'] === 'cap'),
    await page.evaluate(() => (window).__previewPayload?.selections));
  check('…and the chosen colour carried over to the incoming member',
    await page.evaluate(() => (window).__previewPayload?.selections?.['cap-colour'] === 'blue'),
    await page.evaluate(() => (window).__previewPayload?.selections));
  previewTabs = await tabTexts();
  check('switching renames the tab to the new member — either-or in the panel as well',
    previewTabs.includes('Body style (Cap)') && !previewTabs.includes('Body style (Base)'), previewTabs);
  check('…and the configuration summary reads "set (member)" for the picked side only',
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.preview-overlay .cfg-summary-part')].map((e) => e.textContent);
      return rows.includes('Body style (Cap)') && !rows.some((r) => r === 'Base' || r === 'Cap');
    }), '');
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
  check('assembly recorded; every member keeps its own colour option',
    m.groups?.[0]?.id === 'shell' && m.groups[0].parts.join(',') === 'base,cap'
    && m.options.some((o) => o.id === 'base-colour') && m.options.some((o) => o.id === 'cap-colour')
    && !m.options.some((o) => o.id === 'shell-colour'),
    { groups: m.groups, options: m.options.map((o) => o.id) });
  check('the assembly header carries a delete ✕ of its own',
    await page.isVisible('[data-testid="delete-shell"]'), '');

  // Opening the assembly's editor + Transform parks the FULL gizmo at the
  // set's centre of mass — an assembly transforms like a part now.
  await page.click('.part-name:has-text("Shell")');
  await page.waitForTimeout(200);
  await page.click('[data-testid="gizmo-transform"]');
  await page.waitForTimeout(300);
  const setGizmo = await page.evaluate(() => ({
    translate: !!window.__studioGizmo.translate.object,
    rotate: !!window.__studioGizmo.rotate.object,
  }));
  check('the full gizmo parks at the assembly\'s centre of mass',
    setGizmo.translate && setGizmo.rotate, setGizmo);
  await page.click('[data-testid="gizmo-transform"]');
  await page.waitForTimeout(150);
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
  check('dragging a member out dissolves the two-part assembly; colours untouched',
    !m.groups && m.options.some((o) => o.id === 'cap-colour') && m.options.some((o) => o.id === 'base-colour'),
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
  await page.click('[data-testid="publish-cta"]');
  await page.click('[data-testid="preview-open"]'); // in the publish modal head; closes the modal
  await page.waitForSelector('.preview-overlay .cfg-swatch', { timeout: 45000 });
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

// ── 12. delete: our own dialog, mass delete from the selection bar ─────────
{
  await page.click('.tabs button:has-text("Parts")');

  // Mass delete: checking parts offers Delete; cancelling keeps everything.
  await page.check('[data-testid="pick-base"]');
  await page.check('[data-testid="pick-cap"]');
  await page.click('[data-testid="delete-selected"]');
  check('mass delete asks with the Studio\'s own dialog, not the browser prompt',
    await page.isVisible('[data-testid="confirm-delete"]'), '');
  await page.click('[data-testid="confirm-delete-cancel"]');
  await page.waitForTimeout(150);
  m = await manifest();
  check('cancelling the dialog keeps every part', m.parts.length === 2, m.parts.length);
  await page.uncheck('[data-testid="pick-base"]');
  await page.uncheck('[data-testid="pick-cap"]');

  await page.click('[data-testid="delete-cap"]');
  await page.click('[data-testid="confirm-delete-confirm"]');
  await page.waitForTimeout(300);
  m = await manifest();
  check('confirming deletes the part and its options',
    m.parts.length === 1 && !m.options.some((o) => o.id === 'cap-colour' || o.id === 'cap-addon'),
    { parts: m.parts.length, options: m.options.map((o) => o.id) });
  const afterDelete = validateManifest(m);
  check('manifest still valid after the delete', afterDelete.ok, afterDelete.errors);
}

// ── 13. add parts from a second file ───────────────────────────────────────
{
  await page.setInputFiles('[data-testid="add-model-input"]', {
    name: 'hooks.3mf', mimeType: 'application/octet-stream', buffer: Buffer.from(SECOND_3MF),
  });
  await page.waitForFunction(() => (window).__studio?.manifest?.parts?.length === 2, { timeout: 20000 });
  await page.waitForFunction(() => (window).__studioViewerReady === true, { timeout: 20000 });
  m = await manifest();
  check('a second file adds its parts to the project',
    m.parts.length === 2 && m.parts.some((p) => p.id === 'hook')
    && m.options.some((o) => o.id === 'hook-colour'),
    { parts: m.parts.map((p) => p.id), options: m.options.map((o) => o.id) });
  const addVerdict = validateManifest(m);
  check('manifest still valid after adding parts', addVerdict.ok, addVerdict.errors);
  const hookBox = await page.evaluate(() => window.__studioViewer.partBox('hook'));
  check('added parts land centred on the flat axes, sitting on the ground',
    Math.abs((hookBox.min[0] + hookBox.max[0]) / 2) < 1e-3
    && Math.abs(hookBox.min[1]) < 1e-3
    && Math.abs((hookBox.min[2] + hookBox.max[2]) / 2) < 1e-3,
    hookBox);
}

// ── 14. live repeats: a pattern is a parameter of the part ────────────────
{
  await page.click('.part-name:has-text("Base")');
  await page.waitForTimeout(200);
  check('part editor offers the pattern tool', await page.isVisible('[data-testid="repeat-add"]'), '');
  const copies = () => page.evaluate(() => {
    let n = 0;
    window.__studioViewer.scene.traverse((o) => { if (o.isMesh && o.userData.part === 'base') n++; });
    return n;
  });
  const gridBefore = await page.evaluate(() => window.__studioGrid.scale.x);
  await page.click('[data-testid="repeat-add"]');
  await page.waitForTimeout(500);
  m = await manifest();
  const rid = m.parts.find((p) => p.id === 'base').repeats[0].id;
  check('adding a pattern spawns copies WITHOUT adding parts',
    await copies() === 3 && m.parts.length === 2, { copies: await copies(), parts: m.parts.length });
  const repeatVerdict = validateManifest(m);
  check('manifest still valid with the pattern', repeatVerdict.ok, repeatVerdict.errors);

  // Retuning is live: the row re-forms, it is not re-stamped.
  await page.fill(`[data-testid="repeat-count-${rid}"]`, '4');
  await page.press(`[data-testid="repeat-count-${rid}"]`, 'Enter');
  await page.fill(`[data-testid="repeat-gap-${rid}"]`, '6');
  await page.press(`[data-testid="repeat-gap-${rid}"]`, 'Enter');
  await page.waitForTimeout(500);
  check('retuning count and gap updates the row live', await copies() === 4, await copies());

  // Copies march along X, pitched at the base's width plus the 6mm gap.
  const spread = await page.evaluate(() => {
    const xs = [];
    window.__studioViewer.scene.traverse((o) => { if (o.isMesh && o.userData.part === 'base') xs.push(o.position.x); });
    return xs.sort((a, b) => a - b);
  });
  const width = await page.evaluate(() => {
    const b = window.__studioViewer.partBox('base');
    return b.max[0] - b.min[0];
  });
  check('copies sit gap apart edge-to-edge along X',
    spread.length === 4 && spread.every((x, i) => i === 0 || near(x - spread[i - 1], width + 6, 0.1)),
    { spread, width });

  // The desk grows under the marching copies.
  const gridAfter = await page.evaluate(() => window.__studioGrid.scale.x);
  check('the ground grid expands to cover the repeated row', gridAfter > gridBefore, { gridBefore, gridAfter });

  // Stacking: a second pattern repeats everything the first produced, on a
  // different axis by default — a grid, not a longer line.
  await page.click('[data-testid="repeat-add"]');
  await page.waitForTimeout(600);
  m = await manifest();
  check('a second pattern stacks into a grid',
    await copies() === 12 && m.parts.find((p) => p.id === 'base').repeats.length === 2
    && m.parts.length === 2, { copies: await copies(), parts: m.parts.length });

  // Removing the patterns returns the part to one mesh.
  const ids = await page.evaluate(() => window.__studio.manifest.parts.find((p) => p.id === 'base').repeats.map((r) => r.id));
  for (const id of ids) { await page.click(`[data-testid="repeat-remove-${id}"]`); await page.waitForTimeout(300); }
  check('removing the patterns leaves the part alone',
    await copies() === 1 && (await manifest()).parts.find((p) => p.id === 'base').repeats === undefined, await copies());
}

// ── 15. 3D text: place on a face, tune the typeface, customer types ────────
{
  await page.click('.part-name:has-text("Base")');
  await page.waitForTimeout(200);
  await page.click('[data-testid="place-text"]');
  check('placing text prompts for a face', await page.isVisible('[data-testid="text-pick-hint"]'), '');

  // Look straight down, then click the base's centre — the ray lands on its
  // top face, so the slot's sketch plane must come back as local +Y.
  await page.evaluate(() => window.__studioViewCube.go('Top'));
  let settled = '';
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(120);
    const now = JSON.stringify(await page.evaluate(() => window.__studioViewer.cameraView()));
    if (now === settled) break;
    settled = now;
  }
  const baseAt = await page.evaluate(() => {
    const v = window.__studioViewer;
    const q = v.meshOf('base').position.clone().project(v.camera);
    const r = document.querySelector('.stage canvas').getBoundingClientRect();
    return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height];
  });
  await page.mouse.click(baseAt[0], baseAt[1]);
  await page.waitForFunction(() => (window).__studio?.manifest?.options?.some((o) => o.type === 'text'), { timeout: 20000 });
  m = await manifest();
  const slot = m.options.find((o) => o.type === 'text');
  check('the slot binds to the base with merchant-ready defaults',
    slot.part === 'base' && slot.font === 'sans-bold' && slot.depthMm === 2 && slot.placeholder === 'Text',
    slot);
  check('the sketch plane is the picked TOP face (local +Y normal, on the surface)',
    Math.abs(slot.normal[1] - 1) < 0.01 && slot.origin[1] > 0, { origin: slot.origin, normal: slot.normal });
  const textVerdict = validateManifest(m);
  check('manifest still valid with the text slot', textVerdict.ok, textVerdict.errors);

  // The placeholder extrudes on the model as a real mesh (font loads lazily).
  await page.waitForFunction(() => {
    const mesh = (window).__studioViewer?.textMeshOf?.(`${'base-text'}`);
    return !!mesh && mesh.geometry.attributes.position.count > 0;
  }, { timeout: 20000 });
  check('the placeholder text extrudes on the model', true, '');

  // The typeface dropdown reshapes the glyphs.
  const vertsBefore = await page.evaluate(() => (window).__studioViewer.textMeshOf('base-text').geometry.attributes.position.count);
  await pick('text-font-base-text', 'serif');
  m = await manifest();
  check('the typeface dropdown writes the font', m.options.find((o) => o.type === 'text')?.font === 'serif',
    m.options.find((o) => o.type === 'text')?.font);
  await page.waitForFunction((before) => {
    const mesh = (window).__studioViewer.textMeshOf('base-text');
    return mesh && mesh.geometry.attributes.position.count !== before;
  }, vertsBefore, { timeout: 20000 });
  check('…and the extrusion rebuilds in the new face', true, '');

  // Bend curves the run along an arc. The glyph geometry lives in sketch
  // space (posing is the mesh's quaternion), so its own y-span growing is
  // the arch; typing 0 straightens and clears the field.
  const flatBounds = await page.evaluate(() => {
    const g = (window).__studioViewer.textMeshOf('base-text').geometry;
    g.computeBoundingBox();
    return g.boundingBox.max.y - g.boundingBox.min.y;
  });
  await page.fill('[data-testid="text-bend-base-text"]', '120');
  await page.press('[data-testid="text-bend-base-text"]', 'Enter');
  m = await manifest();
  check('the Bend field writes bendDeg', m.options.find((o) => o.type === 'text')?.bendDeg === 120,
    m.options.find((o) => o.type === 'text'));
  await page.waitForFunction((flat) => {
    const g = (window).__studioViewer.textMeshOf('base-text')?.geometry;
    if (!g) return false;
    g.computeBoundingBox();
    return (g.boundingBox.max.y - g.boundingBox.min.y) > flat * 1.3;
  }, flatBounds, { timeout: 20000 });
  check('…and the run arches on the model', true, '');
  await page.fill('[data-testid="text-bend-base-text"]', '0');
  await page.press('[data-testid="text-bend-base-text"]', 'Enter');
  m = await manifest();
  check('Bend 0 straightens — the default, not a stored field',
    m.options.find((o) => o.type === 'text')?.bendDeg === undefined, m.options.find((o) => o.type === 'text'));

  // Freeform baseline: arming drops three seeded anchor dots on the face;
  // dragging the middle one bows the curve and the letters follow it;
  // Escape ends shaping and Straighten clears the path.
  await page.click('[data-testid="text-curve-base-text"]');
  await page.waitForSelector('[data-testid="shape-overlay"]', { timeout: 10000 });
  await page.waitForTimeout(400);
  check('arming baseline shaping seeds three anchor dots',
    await page.locator('.shape-anchor').count() === 3, '');
  const midDot = await page.locator('[data-testid="shape-anchor-1"]').boundingBox();
  await page.mouse.move(midDot.x + midDot.width / 2, midDot.y + midDot.height / 2);
  await page.mouse.down();
  await page.mouse.move(midDot.x + midDot.width / 2, midDot.y + midDot.height / 2 - 60, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  m = await manifest();
  const drawnPath = m.options.find((o) => o.type === 'text')?.path;
  check('dragging the middle dot stores the drawn baseline (and keeps Bend clear)',
    Array.isArray(drawnPath) && drawnPath.length === 3 && Math.abs(drawnPath[1][1]) > 1
    && m.options.find((o) => o.type === 'text')?.bendDeg === undefined, drawnPath);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Escape ends baseline shaping',
    await page.locator('[data-testid="shape-overlay"]').count() === 0, '');
  await page.click('[data-testid="text-curve-off-base-text"]');
  m = await manifest();
  check('Straighten clears the drawn baseline',
    m.options.find((o) => o.type === 'text')?.path === undefined, m.options.find((o) => o.type === 'text'));

  // The text takes its own colour, independent of the part it sits on.
  // The merchant's colour stands on its own — no permission needed from the
  // customer-choice box, which only adds a picker on top.
  await pick('text-colour-base-text', '#C82020');
  m = await manifest();
  check('the text-colour dropdown pins the slot colour',
    m.options.find((o) => o.type === 'text')?.colourHex === '#C82020',
    m.options.find((o) => o.type === 'text'));
  await page.waitForFunction(() => {
    const v = (window).__studioViewer;
    const g = v.textMeshOf('base-text');
    return !!g && g.material !== v.meshOf('base').material
      && g.material.color.getHexString().toUpperCase() === 'C82020';
  }, { timeout: 20000 });
  check('…and the glyph renders in it, independent of the part', true, '');

  // Engraved: a real boolean difference — the letters are cut INTO the part.
  const baseVerts = await page.evaluate(() => (window).__studioViewer.meshOf('base').geometry.attributes.position.count);
  await pick('text-style-base-text', 'deboss');
  await page.waitForFunction((before) => {
    const v = (window).__studioViewer;
    return !v.textMeshOf('base-text') && v.meshOf('base').geometry.attributes.position.count !== before;
  }, baseVerts, { timeout: 30000 });
  check('engraved style cuts the letters into the part — no glyph, new geometry', true, '');
  await pick('text-style-base-text', 'emboss');
  await page.waitForFunction((before) => {
    const v = (window).__studioViewer;
    return !!v.textMeshOf('base-text') && v.meshOf('base').geometry.attributes.position.count === before;
  }, baseVerts, { timeout: 30000 });
  check('back to embossed: pristine part restored, glyph returns', true, '');

  // One piece per letter: the template spawns a copy per placeholder char.
  await page.click('[data-testid="text-spawn-base-text"]');
  await page.fill('[data-testid="text-placeholder-base-text"]', 'AB');
  await page.waitForFunction(() => {
    const v = (window).__studioViewer;
    return !!v?.scene?.getObjectByName('percopy-base-text-1') && !v.scene.getObjectByName('percopy-base-text-2');
  }, { timeout: 20000 });
  m = await manifest();
  check('one-piece-per-letter records perChar on the slot',
    !!m.options.find((o) => o.type === 'text')?.perChar, m.options.find((o) => o.type === 'text'));
  const row = await page.evaluate(() => {
    const v = (window).__studioViewer;
    const carrier = v.meshOf('base');
    const copy = v.scene.getObjectByName('percopy-base-text-1');
    const box = v.partBox('base');
    return { dx: copy.position.x - carrier.position.x, width: box.max[0] - box.min[0], visible: copy.visible };
  });
  check('“AB” spawns exactly two pieces, pitched a template-width plus the gap apart',
    near(row.dx, row.width + 5, 0.1) && row.visible, row);
  await page.waitForFunction(() => !!(window).__studioViewer?.scene?.getObjectByName('text-base-text-1'), { timeout: 20000 });
  check('each piece carries its own letter', await page.evaluate(() => {
    const v = (window).__studioViewer;
    const g0 = v.scene.getObjectByName('text-base-text-0');
    const g1 = v.scene.getObjectByName('text-base-text-1');
    return !!g0 && !!g1 && g1.parent?.name === 'percopy-base-text-1';
  }), '');

  // Around a circle: the same pieces swing round the origin instead — each
  // one step° further AND spun to face its way round, the same rigid turn
  // the repeat tool stamps.
  await pick('text-spawn-mode-base-text', 'circle');
  await page.fill('[data-testid="text-spawn-step-base-text"]', '45');
  await page.press('[data-testid="text-spawn-step-base-text"]', 'Enter');
  await page.waitForFunction(() => {
    const v = (window).__studioViewer;
    const copy = v?.scene?.getObjectByName('percopy-base-text-1');
    return !!copy && Math.abs(copy.quaternion.y) > 0.1;
  }, { timeout: 20000 });
  const ring = await page.evaluate(() => {
    const v = (window).__studioViewer;
    const src2 = v.meshOf('base');
    const copy = v.scene.getObjectByName('percopy-base-text-1');
    return {
      srcR: Math.hypot(src2.position.x, src2.position.z),
      copyR: Math.hypot(copy.position.x, copy.position.z),
      spunY: copy.quaternion.y,
    };
  });
  check('circle spawning keeps each piece at the template radius, spun to face round',
    near(ring.srcR, ring.copyR, 0.1) && Math.abs(ring.spunY) > 0.1, ring);

  // Back to a linear run for the preview leg.
  await pick('text-spawn-mode-base-text', 'line');
  await page.waitForFunction(() => {
    const copy = (window).__studioViewer?.scene?.getObjectByName('percopy-base-text-1');
    return !!copy && Math.abs(copy.quaternion.y) < 0.01;
  }, { timeout: 20000 });

  // Per-character pricing reaches the real embed in the preview.
  await page.fill('[data-testid="text-perchar-base-text"]', '2');
  await page.press('[data-testid="text-perchar-base-text"]', 'Enter');
  await page.waitForTimeout(200);
  await page.click('[data-testid="publish-cta"]');
  await page.click('[data-testid="preview-open"]'); // in the publish modal head; closes the modal
  await page.waitForSelector('.preview-overlay .cfg-tab', { timeout: 45000 });
  await page.click('.preview-overlay .cfg-tab:has-text("Base text")');
  await page.waitForTimeout(200);
  check('the customiser offers the text input', await page.isVisible('.preview-overlay .cfg-text-input'), '');
  check('…and says each letter becomes its own piece',
    /own piece/.test(await page.textContent('.preview-overlay .cfg-text') ?? ''), '');
  await page.fill('.preview-overlay .cfg-text-input', 'Hi');
  await page.waitForTimeout(300);
  check('typed text lands in the payload, priced per character',
    await page.evaluate(() => (window).__previewPayload?.selections?.['base-text'] === 'Hi'
      && (window).__previewPayload?.priceDeltas?.some((d) => d.optionId === 'base-text' && d.amount === 4)),
    await page.evaluate(() => (window).__previewPayload));
  // The customiser recentres the growing run: its centre of mass eases onto
  // the world origin rather than the row growing off to one side.
  await page.waitForTimeout(900);
  check('the growing run eases its centre of mass onto the origin',
    await page.evaluate(() => {
      const v = (window).__previewViewer;
      const mesh = v?.meshOf?.('base');
      const copy = v?.scene?.getObjectByName('percopy-base-text-1');
      if (!mesh || !copy) return false;
      return Math.abs((mesh.position.x + copy.position.x) / 2) < 0.5;
    }),
    await page.evaluate(() => ({
      base: (window).__previewViewer?.meshOf?.('base')?.position?.x,
      copy: (window).__previewViewer?.scene?.getObjectByName('percopy-base-text-1')?.position?.x,
    })));
  await page.click('[data-testid="preview-close"]');
  await page.waitForTimeout(200);

  // Removing the slot clears the option, the extrusion and the spawned row.
  await page.click('[data-testid="text-remove-base-text"]');
  await page.waitForFunction(() => !(window).__studio?.manifest?.options?.some((o) => o.type === 'text'), { timeout: 20000 });
  await page.waitForFunction(() => {
    const v = (window).__studioViewer;
    return !v.textMeshOf('base-text') && !v.scene.getObjectByName('percopy-base-text-1')
      && !v.scene.getObjectByName('text-base-text-0');
  }, { timeout: 20000 });
  check('removing the slot clears the option, the extrusion and the spawned pieces', true, '');
}

// ── 16. image zone: place on a face, tune, customer uploads an image ───────
{
  await page.click('.part-name:has-text("Base")');
  await page.waitForTimeout(200);
  check('part editor offers image-zone placement', await page.isVisible('[data-testid="place-image"]'), '');
  await page.click('[data-testid="place-image"]');
  check('placing an image zone prompts for a face', await page.isVisible('[data-testid="text-pick-hint"]'), '');

  // Look straight down and click the base's centre — the zone's plane must
  // come back as the top face (local +Y).
  await page.evaluate(() => window.__studioViewCube.go('Top'));
  let settled = '';
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(120);
    const now = JSON.stringify(await page.evaluate(() => window.__studioViewer.cameraView()));
    if (now === settled) break;
    settled = now;
  }
  const baseAt = await page.evaluate(() => {
    const v = window.__studioViewer;
    const q = v.meshOf('base').position.clone().project(v.camera);
    const r = document.querySelector('.stage canvas').getBoundingClientRect();
    return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height];
  });
  await page.mouse.click(baseAt[0], baseAt[1]);
  await page.waitForFunction(() => (window).__studio?.manifest?.options?.some((o) => o.type === 'upload'), { timeout: 20000 });
  m = await manifest();
  const zone = m.options.find((o) => o.type === 'upload');
  const zbox = await page.evaluate(() => window.__studioViewer.partBox('base'));
  const spanX = zbox.max[0] - zbox.min[0], spanZ = zbox.max[2] - zbox.min[2];
  check('the zone conforms to the picked top face: sized to its edges',
    zone.part === 'base' && zone.label === 'Base image'
    && ((Math.abs(zone.widthMm - spanX) < 0.6 && Math.abs(zone.heightMm - spanZ) < 0.6)
      || (Math.abs(zone.widthMm - spanZ) < 0.6 && Math.abs(zone.heightMm - spanX) < 0.6)),
    { zone: { w: zone.widthMm, h: zone.heightMm }, spanX, spanZ });
  check('the zone plane is the picked TOP face (local +Y normal, on the surface)',
    Math.abs(zone.normal[1] - 1) < 0.01 && zone.origin[1] > 0, { origin: zone.origin, normal: zone.normal });
  const zoneVerdict = validateManifest(m);
  check('manifest still valid with the image zone', zoneVerdict.ok, zoneVerdict.errors);

  // With no image uploaded, the zone renders as the picked face's OWN
  // triangles (the same region the highlight shows), lifted a hair off the
  // surface and parented to the part — the face itself is the mask, so
  // nothing can bleed or protrude.
  await page.waitForFunction(() => {
    const f = (window).__studioViewer?.scene?.getObjectByName('image-zone-base-image');
    return !!f && f.geometry.attributes.position.count >= 6;
  }, { timeout: 20000 });
  const overlay = await page.evaluate(() => {
    const f = (window).__studioViewer.scene.getObjectByName('image-zone-base-image');
    f.geometry.computeBoundingBox();
    const bb = f.geometry.boundingBox;
    const box = (window).__studioViewer.partBox('base');
    return {
      onCarrier: f.parent === (window).__studioViewer.meshOf('base'),
      span: bb.max.y - bb.min.y,
      above: bb.min.y - (box.max[1] - box.min[1]) / 1, // local top ≈ box height when grounded
    };
  });
  check('the zone overlay rides the part as its own surface triangles',
    overlay.onCarrier && overlay.span < 0.01, overlay);

  // Zone width is merchant-editable and regenerates the frame.
  await page.fill('[data-testid="image-width-base-image"]', '40');
  await page.press('[data-testid="image-width-base-image"]', 'Enter');
  await page.waitForFunction(() => (window).__studio?.manifest?.options?.find((o) => o.type === 'upload')?.widthMm === 40, { timeout: 20000 });
  check('the width field writes the zone size', true, '');

  // The customer flow: upload → decal appears → reposition → resize → remove.
  await page.click('[data-testid="publish-cta"]');
  await page.click('[data-testid="preview-open"]'); // in the publish modal head; closes the modal
  await page.waitForSelector('.preview-overlay .cfg-tab', { timeout: 45000 });
  await page.click('.preview-overlay .cfg-tab:has-text("Base image")');
  await page.waitForTimeout(200);
  check('the customiser offers the upload button', await page.isVisible('.preview-overlay .cfg-upload-btn'), '');
  const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('.preview-overlay .cfg-upload-input', { name: 'logo.png', mimeType: 'image/png', buffer: PNG_1PX });
  await page.waitForFunction(() => {
    const d = (window).__previewViewer?.imageDecalOf?.('base-image');
    return !!d && d.geometry.attributes.position.count > 0;
  }, { timeout: 20000 });
  check('the uploaded image lands on the zone surface', true, '');
  const sel0 = await page.evaluate(() => JSON.parse((window).__previewPayload.selections['base-image']));
  check('the payload carries the image at full size, centred',
    sel0.img.startsWith('data:image/') && sel0.u === 0 && sel0.v === 0 && sel0.s === 100, sel0);

  // The position pad nudges the image inside the zone; − steps the size down.
  await page.click('.preview-overlay .cfg-arrow-right');
  await page.waitForTimeout(300);
  const sel1 = await page.evaluate(() => JSON.parse((window).__previewPayload.selections['base-image']));
  check('the → arrow slides the image along the zone', sel1.u > 0, sel1);
  await page.click('.preview-overlay .cfg-size-minus');
  await page.waitForTimeout(300);
  const sel2 = await page.evaluate(() => JSON.parse((window).__previewPayload.selections['base-image']));
  check('the − button steps the size down 1% to 99%', sel2.s === 99, sel2);
  check('…and the size field shows it',
    await page.evaluate(() => document.querySelector('.preview-overlay .cfg-size-value')?.value === '99'), '');
  // Typing a size beyond 100% crop-zooms inside the zone.
  await page.fill('.preview-overlay .cfg-size-value', '250');
  await page.dispatchEvent('.preview-overlay .cfg-size-value', 'change');
  await page.waitForTimeout(300);
  const sel3 = await page.evaluate(() => JSON.parse((window).__previewPayload.selections['base-image']));
  check('typing 250% in the size field lands in the payload', sel3.s === 250, sel3);

  await page.click('.preview-overlay .cfg-upload-remove');
  await page.waitForFunction(() => {
    const v = (window).__previewViewer;
    return !v.imageDecalOf('base-image')
      && v.scene.getObjectByName('image-zone-base-image')?.visible === true;
  }, { timeout: 20000 });
  check('Remove image clears the picture and brings the veil back',
    await page.evaluate(() => (window).__previewPayload.selections['base-image'] === ''), '');
  await page.click('[data-testid="preview-close"]');
  await page.waitForTimeout(200);

  // Removing the zone clears the option and its plane.
  await page.click('[data-testid="image-remove-base-image"]');
  await page.waitForFunction(() => !(window).__studio?.manifest?.options?.some((o) => o.type === 'upload'), { timeout: 20000 });
  await page.waitForFunction(() => !(window).__studioViewer?.scene?.getObjectByName('image-zone-base-image'), { timeout: 20000 });
  check('removing the zone clears the option and the zone plane', true, '');
}

check('material has the studio environment (dull-gloss plastic)',
  await page.evaluate(() => !!window.__studioViewer.scene.environment), '');
check('parts render double-sided — stray winding cannot look transparent',
  await page.evaluate(() => window.__studioViewer.meshOf('base')?.material.side === 2 /* THREE.DoubleSide */), '');

// ── 14b. parts born without a file: primitives + traced templates ──────────
{
  const before = (await manifest()).parts.length;

  // A parametric shape lands as an ordinary part with its own colour option.
  await page.click('[data-testid="new-shape"]');
  check('the shape dialog opens', await page.isVisible('[data-testid="shape-dialog"]'), '');
  await page.click('[data-testid="shape-kind"]');
  await page.click('[data-testid="shape-kind-opt-torus"]');
  await page.click('[data-testid="shape-add"]');
  await page.waitForFunction((n) => (window).__studio?.manifest?.parts?.length === n + 1, before, { timeout: 20000 });
  m = await manifest();
  const torus = m.parts[m.parts.length - 1];
  check('the torus arrived as an ordinary part', torus.id.startsWith('torus'), torus.id);
  check('…with its own colour option',
    m.options.some((o) => o.type === 'colour' && o.parts.includes(torus.id)), '');

  // Artwork in, colouring template out: an SVG ring becomes a plate shaped
  // like the artwork with the drawn line standing proud on top.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
    + '<circle cx="100" cy="100" r="60" fill="none" stroke="#000" stroke-width="10"/></svg>';
  await page.setInputFiles('[data-testid="image-template-input"]', {
    name: 'pendant.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg),
  });
  await page.waitForSelector('[data-testid="template-add"]:not([disabled])', { timeout: 20000 });
  check('the template dialog previews the traced masks',
    await page.isVisible('[data-testid="trace-preview"]'), '');
  await page.click('[data-testid="template-add"]');
  await page.waitForFunction((n) => (window).__studio?.manifest?.parts?.length === n + 3, before, { timeout: 30000 });
  m = await manifest();
  const ids = m.parts.slice(-2).map((p) => p.id);
  check('plate and outlines arrive as two parts',
    ids[0].includes('base') && ids[1].includes('outlines'), ids);
  await page.waitForFunction(() => (window).__studioViewerReady === true, { timeout: 20000 });
  // The regression that shipped once: parts in the manifest, nothing on the
  // canvas. The template plate must be a BOUND mesh with real geometry.
  check('the template plate actually renders (mesh bound, geometry non-empty)',
    await page.evaluate((id) => {
      const mesh = (window).__studioViewer.meshOf(id);
      return !!mesh && mesh.geometry.getAttribute('position').count > 0;
    }, ids[0]), ids[0]);

  // And the underlying cause, pinned directly: a part NAMED with a space —
  // GLTFLoader sanitises node names, the viewer must look up both forms.
  const SPACED_3MF = zipSync({
    '3D/3dmodel.model': new TextEncoder().encode(
      `<?xml version="1.0"?><model unit="millimeter">
       <resources>
        <object id="1" name="Wall Hook" type="model"><mesh>${boxGeom(6, 6, 6)}</mesh></object>
       </resources>
       <build><item objectid="1"/></build>
      </model>`),
  });
  await page.setInputFiles('[data-testid="add-model-input"]', {
    name: 'wall-hook.3mf', mimeType: 'application/octet-stream', buffer: Buffer.from(SPACED_3MF),
  });
  await page.waitForFunction((n) => (window).__studio?.manifest?.parts?.length === n + 4, before, { timeout: 20000 });
  await page.waitForFunction(() => (window).__studioViewerReady === true, { timeout: 20000 });
  m = await manifest();
  const spaced = m.parts[m.parts.length - 1];
  check('a part named with a space still binds and renders',
    await page.evaluate((id) => {
      const mesh = (window).__studioViewer.meshOf(id);
      return !!mesh && mesh.geometry.getAttribute('position').count > 0;
    }, spaced.id), spaced.id);
  check('the viewer took every generated part without complaint', errors.length === 0, errors.join(' | '));
}

// ── 15. new project resets to the empty viewport ───────────────────────────
{
  await page.click('[data-testid="new-project"]');
  await page.waitForFunction(() => (window).__studio?.manifest?.parts?.length === 0, { timeout: 20000 });
  await page.waitForFunction(() => (window).__studioViewerReady === true, { timeout: 20000 });
  m = await manifest();
  check('new project returns to an empty viewport, ready to import',
    m.parts.length === 0 && m.models.length === 0 && m.name === 'New Product'
    && await page.isVisible('[data-testid="empty-parts"]'),
    { parts: m.parts.length, name: m.name });
}

check('no console errors across the whole session', errors.length === 0, errors.join(' | '));

const failed = checks.filter(([, pass]) => !pass).length;
console.log(failed ? `\n${failed} of ${checks.length} failed` : `\nall ${checks.length} passed`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
