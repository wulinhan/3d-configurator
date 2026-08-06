// Curved text: with `bendDeg` set the run's baseline follows a circular
// arc — per-glyph stations, each glyph turned to the local tangent — and
// the SAME merged prism feeds the emboss mesh, the engrave cutter and the
// pocket lining/floor, so the arc carries through the whole text pipeline.
// Asserted headless against a real bundled font: this is exactly the
// geometry the viewer renders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import sansBold from '../src/fonts/sans-bold.ts';
import { buildTextGeometry, bendStations, pocketFloor, pocketLining } from '../src/runtime/engrave.ts';
import type { TextOption } from '../src/manifest/types.ts';

const font = new FontLoader().parse(sansBold as never);
const spec = (over: Partial<TextOption> = {}): TextOption => ({
  id: 't', type: 'text', label: 'T', part: 'p',
  origin: [0, 0, 0], normal: [0, 0, 1], sizeMm: 10, depthMm: 2, ...over,
});
const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);
const span = (geo: { computeBoundingBox(): void; boundingBox: { min: Record<'x' | 'y' | 'z', number>; max: Record<'x' | 'y' | 'z', number> } | null }, axis: 'x' | 'y' | 'z') => {
  geo.computeBoundingBox();
  return geo.boundingBox!.max[axis] - geo.boundingBox!.min[axis];
};

test('stations: no bend is the straight run — even pitch on the baseline', () => {
  const st = bendStations('HHH', font, spec());
  assert.equal(st.length, 3);
  const a = st[0].advance;
  near(st[1].x - st[0].x, a);
  near(st[2].x - st[1].x, a);
  near(st[1].x, 0); // odd count: the middle glyph sits on the origin
  for (const s of st) { near(s.y, 0); near(s.angleRad, 0); }
});

test('stations: +90° arches up — crest centred, ends drop and turn outward', () => {
  const st = bendStations('HHH', font, spec({ bendDeg: 90 }));
  const a = st[0].advance;
  const r = (3 * a) / (Math.PI / 2); // L / θ
  near(st[1].x, 0); near(st[1].y, 0); near(st[1].angleRad, 0);
  // End glyphs sit ±30° round the arc (a third of the 90° each side of centre).
  near(st[2].x, r * Math.sin(Math.PI / 6));
  near(st[2].y, r * (Math.cos(Math.PI / 6) - 1));
  assert.ok(st[2].y < 0, 'positive bend: the ends drop below the crest');
  near(st[2].angleRad, -Math.PI / 6);
  // Mirror-symmetric on the left.
  near(st[0].x, -st[2].x); near(st[0].y, st[2].y); near(st[0].angleRad, -st[2].angleRad);
});

test('stations: negative bend smiles — ends rise, tangents flip', () => {
  const up = bendStations('HHH', font, spec({ bendDeg: 90 }));
  const down = bendStations('HHH', font, spec({ bendDeg: -90 }));
  near(down[2].x, up[2].x);
  near(down[2].y, -up[2].y);
  assert.ok(down[2].y > 0, 'negative bend: the ends rise');
  near(down[2].angleRad, -up[2].angleRad);
});

test('stations: spaces advance the pen but never land a glyph', () => {
  const st = bendStations('H H', font, spec({ bendDeg: 90 }));
  assert.equal(st.length, 2);
  near(st[0].x, -st[1].x); // still symmetric about the origin
  assert.ok(st[1].x - st[0].x > st[0].advance, 'the space holds the two apart');
});

test('stations: ±360° closes the circle at even angular pitch', () => {
  const st = bendStations('HHHH', font, spec({ bendDeg: 360 }));
  const step = Math.PI / 2; // 360° over 4 glyphs
  for (let i = 1; i < st.length; i++) near(st[i].angleRad - st[i - 1].angleRad, -step);
  // ...and the seam between last and first is one step too, closing it.
  near(2 * Math.PI - (st[0].angleRad - st[3].angleRad), step);
});

test('geometry: the bent run arches — taller, same depth, still centred', () => {
  const straight = buildTextGeometry('HELLO', font, spec());
  const bent = buildTextGeometry('HELLO', font, spec({ bendDeg: 120 }));
  assert.ok(span(bent, 'y') > span(straight, 'y') * 1.3, 'the arch adds height');
  near(span(bent, 'z'), span(straight, 'z'), 1e-6); // extrusion depth untouched
  // Both centre on the sketch origin — Slide and Rotate behave identically.
  bent.computeBoundingBox();
  const bb = bent.boundingBox!;
  near(bb.min.x + bb.max.x, 0, 1e-6);
  near(bb.min.y + bb.max.y, 0, 1e-6);
});

test('engrave: the pocket walls and floor follow the arc', () => {
  const s = spec({ bendDeg: 120, style: 'deboss' });
  const floor = pocketFloor('HI', font, s);
  const verts = floor.attributes.position;
  assert.ok(verts.count >= 3, 'a bent cut still has a floor');
  // Posed at full sink on a +z face: every floor vertex lies at −depth.
  for (let i = 0; i < verts.count; i++) near(verts.getZ(i), -s.depthMm, 1e-4);
  // The floor is genuinely bent: taller than the straight slot's floor.
  assert.ok(span(floor, 'y') > span(pocketFloor('HI', font, spec({ style: 'deboss' })), 'y') * 1.1);
  assert.ok(pocketLining('HI', font, s).length >= 9, 'the bent pocket keeps its side walls');
});
