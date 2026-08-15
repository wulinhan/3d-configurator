// Parts born from numbers and from artwork: the primitive generators and
// the image→colouring-template tracer. These pin what matters — canonical
// space (grounded, centred, in millimetres), watertight-enough topology
// (every index in range, no degenerate output), and the template contract:
// the drawn lines stand PROUD of a plate shaped like the artwork's own
// silhouette, enclosed regions filled rather than punched through.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { primitivePart, type PrimitiveSpec } from '../src/lib/primitives.ts';
import {
  traceLoops, simplifyRing, fillEnclosed, templateMasks, templateFromRaster,
  hexDistance, colourName, TEMPLATE_DEFAULTS, type Raster,
} from '../src/lib/trace-image.ts';
import type { ImportedPart } from '../src/lib/types.ts';

const near = (a: number, b: number, tol = 0.05) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

const boundsOf = (part: ImportedPart) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < part.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = part.positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
};

const sane = (part: ImportedPart) => {
  assert.ok(part.positions.length >= 9, 'has vertices');
  assert.ok(part.indices.length >= 3 && part.indices.length % 3 === 0, 'whole triangles');
  const n = part.positions.length / 3;
  for (const i of part.indices) assert.ok(i < n, `index ${i} in range`);
};

const spec = (over: Partial<PrimitiveSpec>): PrimitiveSpec => ({
  kind: 'cuboid', widthMm: 60, heightMm: 20, depthMm: 40, sides: 6, tubeMm: 10, ...over,
});

test('a cuboid is exactly its dimensions, grounded and centred', () => {
  const part = primitivePart(spec({ kind: 'cuboid' }));
  sane(part);
  assert.equal(part.indices.length, 36); // 12 triangles
  const { min, max } = boundsOf(part);
  assert.deepEqual([min[0], max[0]], [-30, 30]);
  assert.deepEqual([min[1], max[1]], [0, 20]);   // sat on the ground
  assert.deepEqual([min[2], max[2]], [-20, 20]);
});

test('a cylinder rounds to its diameter; a prism keeps flat sides', () => {
  const cyl = primitivePart(spec({ kind: 'cylinder', widthMm: 50, heightMm: 12 }));
  sane(cyl);
  const cb = boundsOf(cyl);
  near(cb.max[0] - cb.min[0], 50, 0.2); // 96 segments ≈ the true circle
  assert.deepEqual([cb.min[1], cb.max[1]], [0, 12]);

  const hex = primitivePart(spec({ kind: 'prism', sides: 6, widthMm: 50 }));
  sane(hex);
  assert.equal(hex.name, '6-gon');
  // 6 sides: ring verts 12 + 2 centres, 6*4 = 24 triangles
  assert.equal(hex.positions.length / 3, 14);
  assert.equal(hex.indices.length / 3, 24);
});

test('a torus lies flat, grounded, its hole real', () => {
  const part = primitivePart(spec({ kind: 'torus', widthMm: 60, tubeMm: 10 }));
  sane(part);
  const { min, max } = boundsOf(part);
  near(min[1], 0, 0.01);           // grounded
  near(max[1], 10, 0.1);           // height = tube diameter
  near(max[0] - min[0], 60, 0.5);  // outer diameter
  // no vertex near the centre — the hole exists
  for (let i = 0; i < part.positions.length; i += 3) {
    const r = Math.hypot(part.positions[i], part.positions[i + 2]);
    assert.ok(r > 15, 'vertices stay out of the hole');
  }
});

test('a tube thicker than the ring is refused', () => {
  assert.throws(() => primitivePart(spec({ kind: 'torus', widthMm: 20, tubeMm: 30 })));
});

// ── the tracer, on synthetic pixels ────────────────────────────────────────

/** A white raster with a painter callback for the dark pixels. */
const raster = (w: number, h: number, dark: (x: number, y: number) => boolean): Raster => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = dark(x, y) ? 0 : 255;
      const p = (y * w + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { data, width: w, height: h };
};

test('traceLoops finds a square and its hole as two loops', () => {
  const w = 20, h = 20;
  const ink = new Uint8Array(w * h);
  for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) ink[y * w + x] = 1;
  for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) ink[y * w + x] = 0;
  const rings = traceLoops(ink, w, h);
  assert.equal(rings.length, 2);
  const simplified = rings.map((r) => simplifyRing(r, 0.8));
  for (const r of simplified) assert.ok(r.length <= 8, 'squares simplify to corners');
});

test('fillEnclosed keeps what an outline surrounds', () => {
  const w = 30, h = 30;
  const ink = new Uint8Array(w * h);
  // a hollow ring of ink from r=8..11 around the centre
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - 15, y - 15);
      if (r >= 8 && r <= 11) ink[y * w + x] = 1;
    }
  }
  const sil = fillEnclosed(ink, w, h);
  assert.equal(sil[15 * w + 15], 1, 'the enclosed centre is plate');
  assert.equal(sil[15 * w + 1], 0, 'outside stays outside');
  assert.equal(sil[15 * w + 15 - 9], 1, 'the ink itself is plate');
});

test('a traced ring becomes a plate with ridges standing proud', async () => {
  const w = 60, h = 60;
  const img = raster(w, h, (x, y) => {
    const r = Math.hypot(x - 30, y - 30);
    return r >= 16 && r <= 20;
  });
  const opts = { ...TEMPLATE_DEFAULTS, widthMm: 60, baseMm: 3, ridgeMm: 1.5, widenMm: 0 };
  const { parts } = await templateFromRaster(img, opts);
  assert.equal(parts.length, 2);
  const [base, ridges] = parts;
  sane(base); sane(ridges);

  const bb = boundsOf(base);
  near(bb.min[1], 0, 0.01);
  near(bb.max[1], 3, 0.01);                 // base thickness
  near(bb.max[0] - bb.min[0], 40, 3);       // plate spans the ring's 40px ≈ 40mm
  near((bb.min[0] + bb.max[0]) / 2, 0, 0.5); // centred X
  near((bb.min[2] + bb.max[2]) / 2, 0, 0.5); // centred Z

  const rb = boundsOf(ridges);
  near(rb.min[1], 3, 0.01);                 // ridges START at the base top
  near(rb.max[1], 4.5, 0.01);               // and stand ridgeMm proud
  assert.ok(rb.min[0] >= bb.min[0] - 0.5 && rb.max[0] <= bb.max[0] + 0.5, 'ridges stay on the plate');
});

test('thickened lines grow the ink mask, and a blank image is refused', async () => {
  const w = 60, h = 60;
  const img = raster(w, h, (x, y) => y === 30 && x >= 10 && x < 50);
  const thin = templateMasks(img, { widenMm: 0, widthMm: 60, baseGrowMm: 0 });
  const thick = templateMasks(img, { widenMm: 4, widthMm: 60, baseGrowMm: 0 });
  const count = (m: Uint8Array) => m.reduce((a, b) => a + b, 0);
  assert.ok(count(thick.groups[0].ink) > count(thin.groups[0].ink) * 2, 'widen widens');

  await assert.rejects(
    () => templateFromRaster(raster(20, 20, () => false), TEMPLATE_DEFAULTS),
    /blank or too faint/,
  );
});

test('a three-colour artwork becomes three colour parts, named and hexed', async () => {
  const w = 90, h = 60;
  const data = new Uint8ClampedArray(w * h * 4);
  data.fill(255); // white page
  const paint = (x: number, y: number, r: number, g: number, b: number) => {
    const p = (y * w + x) * 4;
    data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
  };
  for (let y = 10; y < 50; y++) {
    for (let x = 5; x < 30; x++) paint(x, y, 200, 30, 30);    // red block
    for (let x = 32; x < 57; x++) paint(x, y, 30, 60, 190);   // blue block
    for (let x = 59; x < 84; x++) paint(x, y, 20, 20, 20);    // black block
  }
  const img: Raster = { data, width: w, height: h };

  const masks = templateMasks(img, { widthMm: 90, widenMm: 0, baseGrowMm: 0 });
  assert.equal(masks.groups.length, 3, 'three colours detected');
  const hexes = masks.groups.map((g) => g.hex);
  assert.ok(hexes.some((x) => hexDistance(x, '#C81E1E') < 12), `a red group in ${hexes}`);
  assert.ok(hexes.some((x) => hexDistance(x, '#1E3CBE') < 12), `a blue group in ${hexes}`);

  const result = await templateFromRaster(img, { ...TEMPLATE_DEFAULTS, widthMm: 90 });
  assert.equal(result.parts.length, 4); // base + three colours
  assert.equal(result.hexes[0], null, 'the base carries no artwork colour');
  const names = result.parts.slice(1).map((p) => p.name).sort();
  assert.deepEqual(names, ['black', 'blue', 'red'].sort(), names.join(','));
  // every colour part stands on the base at the same ridge height
  for (const part of result.parts.slice(1)) {
    const { min, max } = boundsOf(part);
    near(min[1], TEMPLATE_DEFAULTS.baseMm, 0.01);
    near(max[1], TEMPLATE_DEFAULTS.baseMm + TEMPLATE_DEFAULTS.ridgeMm, 0.01);
  }

  // the palette-mapping yardstick: nearest of a small palette
  const palette = [
    { id: 'white', hex: '#FEFEFE' }, { id: 'red', hex: '#C82020' }, { id: 'blue', hex: '#3C78D7' },
  ];
  const redGroup = hexes.find((x) => hexDistance(x, '#C81E1E') < 12)!;
  const nearest = palette.reduce((best, s) =>
    (hexDistance(redGroup, s.hex) < hexDistance(redGroup, best.hex) ? s : best), palette[0]);
  assert.equal(nearest.id, 'red', 'nearest palette swatch found by Lab distance');
  assert.equal(colourName('#C82020'), 'red');
  assert.equal(colourName('#1A1A1A'), 'black');
});

test('loose pieces split into their own parts; the cap keeps patterns whole', async () => {
  const w = 80, h = 60;
  // one big blob and one small far-away speck, same colour
  const img = raster(w, h, (x, y) =>
    (Math.hypot(x - 25, y - 30) < 14) || (x >= 62 && x < 68 && y >= 10 && y < 16));

  const split = await templateFromRaster(img, { ...TEMPLATE_DEFAULTS, widthMm: 80 });
  assert.equal(split.parts.length, 3, 'base + blob + speck');
  assert.deepEqual(split.parts.map((p) => p.name), ['base', 'outlines', 'outlines-2']);
  assert.equal(split.hexes[1], split.hexes[2], 'both pieces wear the group colour');

  const whole = await templateFromRaster(img, { ...TEMPLATE_DEFAULTS, widthMm: 80, splitParts: false });
  assert.equal(whole.parts.length, 2, 'splitting off keeps one part per colour');

  // dictating ONE colour flattens a multi-colour artwork into line-art mode
  const data = new Uint8ClampedArray(w * h * 4);
  data.fill(255);
  for (let y = 20; y < 40; y++) {
    for (let x = 10; x < 30; x++) { const p = (y * w + x) * 4; data[p] = 200; data[p + 1] = 30; data[p + 2] = 30; }
    for (let x = 40; x < 60; x++) { const p = (y * w + x) * 4; data[p] = 20; data[p + 1] = 20; data[p + 2] = 20; }
  }
  const masks = templateMasks({ data, width: w, height: h }, { widthMm: 80, widenMm: 0, baseGrowMm: 0, maxColours: 1 });
  assert.equal(masks.groups.length, 1, 'one colour cap merges everything');
});

test('the base is optional — lines-only lands one part, on the ground', async () => {
  const w = 60, h = 60;
  const img = raster(w, h, (x, y) => {
    const r = Math.hypot(x - 30, y - 30);
    return r >= 16 && r <= 20;
  });
  const { parts } = await templateFromRaster(img, { ...TEMPLATE_DEFAULTS, withBase: false, baseMm: 0 });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].name, 'outlines');
  const { min, max } = boundsOf(parts[0]);
  near(min[1], 0, 0.01);                          // grounded, no plate underneath
  near(max[1], TEMPLATE_DEFAULTS.ridgeMm, 0.01);  // just the line height
  near((min[0] + max[0]) / 2, 0, 0.5);            // still centred
});

test('grow base pushes the plate outward along its outline', async () => {
  const w = 60, h = 60;
  const dark = (x: number, y: number) => {
    const r = Math.hypot(x - 30, y - 30);
    return r >= 16 && r <= 20;
  };
  const img = raster(w, h, dark);
  const plain = templateMasks(img, { widenMm: 0, widthMm: 60, baseGrowMm: 0 });
  const grown = templateMasks(img, { widenMm: 0, widthMm: 60, baseGrowMm: 5 });
  const count = (m: Uint8Array) => m.reduce((a, b) => a + b, 0);
  assert.ok(grown.width > plain.width, 'the canvas pads so the border cannot clip');
  assert.ok(count(grown.silhouette) > count(plain.silhouette) * 1.3, 'the plate grew');

  const opts = { ...TEMPLATE_DEFAULTS, widthMm: 60, baseGrowMm: 5 };
  const { parts: [base, ridges] } = await templateFromRaster(img, opts);
  const bb = boundsOf(base), rb = boundsOf(ridges);
  // ring artwork spans 40px = 40mm; a 5mm border adds 10mm across
  near(bb.max[0] - bb.min[0], 50, 3);
  // the ridges still sit registered on the plate, standing proud of it
  near(rb.min[1], opts.baseMm, 0.01);
  assert.ok(rb.min[0] > bb.min[0] && rb.max[0] < bb.max[0], 'border surrounds the lines');
});
