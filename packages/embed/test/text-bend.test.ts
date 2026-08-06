// Curved text: the run's baseline follows either the `bendDeg` circular
// arc or a drawn `path` (open Catmull-Rom through the merchant's anchors)
// — per-glyph stations, each glyph turned to the local tangent — and the
// SAME merged prism feeds the emboss mesh, the engrave cutter and the
// pocket lining/floor, so the curve carries through the whole text
// pipeline. Asserted headless against a real bundled font: this is
// exactly the geometry the viewer renders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import sansBold from '../src/fonts/sans-bold.ts';
import { buildTextGeometry, glyphStations, placeGlyph, pocketFloor, pocketLining } from '../src/runtime/engrave.ts';
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
  const st = glyphStations('HHH', font, spec());
  assert.equal(st.length, 3);
  const a = st[0].advance;
  near(st[1].x - st[0].x, a);
  near(st[2].x - st[1].x, a);
  near(st[1].x, 0); // odd count: the middle glyph sits on the origin
  for (const s of st) { near(s.y, 0); near(s.angleRad, 0); }
});

test('stations: +90° arches up — crest centred, ends drop and turn outward', () => {
  const st = glyphStations('HHH', font, spec({ bendDeg: 90 }));
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
  const up = glyphStations('HHH', font, spec({ bendDeg: 90 }));
  const down = glyphStations('HHH', font, spec({ bendDeg: -90 }));
  near(down[2].x, up[2].x);
  near(down[2].y, -up[2].y);
  assert.ok(down[2].y > 0, 'negative bend: the ends rise');
  near(down[2].angleRad, -up[2].angleRad);
});

test('stations: spaces advance the pen but never land a glyph', () => {
  const st = glyphStations('H H', font, spec({ bendDeg: 90 }));
  assert.equal(st.length, 2);
  near(st[0].x, -st[1].x); // still symmetric about the origin
  assert.ok(st[1].x - st[0].x > st[0].advance, 'the space holds the two apart');
});

test('stations: ±360° closes the circle at even angular pitch', () => {
  const st = glyphStations('HHHH', font, spec({ bendDeg: 360 }));
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

// ── freeform baseline paths ─────────────────────────────────────────────────

test('path: a straight horizontal path reproduces the straight run exactly', () => {
  // The run centres on the curve's arc-length middle, so a path symmetric
  // about the origin lands every glyph where the straight layout would.
  const straight = glyphStations('HHH', font, spec());
  const onPath = glyphStations('HHH', font, spec({ path: [[-40, 0], [40, 0]] }));
  assert.equal(onPath.length, straight.length);
  straight.forEach((s, i) => {
    near(onPath[i].x, s.x, 1e-6);
    near(onPath[i].y, s.y, 1e-6);
    near(onPath[i].angleRad, 0, 1e-6);
  });
});

test('path: a vertical path marches the letters upward, turned 90°', () => {
  const st = glyphStations('HHH', font, spec({ path: [[0, -40], [0, 40]] }));
  const a = st[0].advance;
  st.forEach((s) => { near(s.x, 0, 1e-6); near(s.angleRad, Math.PI / 2, 1e-6); });
  near(st[1].y, 0, 1e-6); // centred on the curve's middle
  near(st[2].y - st[1].y, a, 1e-6);
});

test('path: the curve through a raised middle anchor arches the run', () => {
  // Ends level, middle up: the outer glyphs sit lower than the middle one
  // and their tangents lean opposite ways — a freeform arch.
  const st = glyphStations('HHH', font, spec({ path: [[-30, 0], [0, 12], [30, 0]] }));
  assert.ok(st[1].y > st[0].y && st[1].y > st[2].y, 'middle glyph rides the raised anchor');
  assert.ok(st[0].angleRad > 0.05, 'left glyph climbs');
  assert.ok(st[2].angleRad < -0.05, 'right glyph descends');
  near(st[0].y, st[2].y, 0.1); // symmetric path, symmetric landing
});

test('path: a run longer than the curve overruns straight past the ends', () => {
  const st = glyphStations('HHHHHHHH', font, spec({ path: [[-10, 0], [10, 0]] }));
  assert.equal(st.length, 8);
  assert.ok(st[0].x < -10 && st[st.length - 1].x > 10, 'outer glyphs pass the anchors');
  st.forEach((s) => { near(s.y, 0, 1e-6); near(s.angleRad, 0, 1e-6); });
  const a = st[0].advance;
  for (let i = 1; i < st.length; i++) near(st[i].x - st[i - 1].x, a, 1e-6);
});

test('path: the drawn path wins when bendDeg is also set', () => {
  const both = glyphStations('HHH', font, spec({ path: [[-40, 0], [40, 0]], bendDeg: 120 }));
  const pathOnly = glyphStations('HHH', font, spec({ path: [[-40, 0], [40, 0]] }));
  both.forEach((s, i) => { near(s.x, pathOnly[i].x); near(s.y, pathOnly[i].y); near(s.angleRad, pathOnly[i].angleRad); });
});

test('path geometry: the baseline sits ON the curve — no recentring', () => {
  // A path lifted 15mm above the origin: the glyph's baseline must land at
  // v=15, not be pulled back to centre on the origin like a Bend run.
  const geo = buildTextGeometry('H', font, spec({ path: [[-20, 15], [20, 15]] }));
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  near(bb.min.y, 15, 0.5); // 'H' has no descender: its baseline IS the bottom
  // Advance-centred on the path middle — side bearings may skew the OUTLINE
  // a couple of millimetres, which is correct typography, not drift.
  near(bb.min.x + bb.max.x, 0, 3);
});

test('path engrave: the pocket follows the drawn curve', () => {
  const s = spec({ path: [[-25, 0], [0, 10], [25, 0]], style: 'deboss' });
  const floor = pocketFloor('HI', font, s);
  const verts = floor.attributes.position;
  assert.ok(verts.count >= 3, 'a path cut still has a floor');
  for (let i = 0; i < verts.count; i++) near(verts.getZ(i), -s.depthMm, 1e-4);
  // The raised middle drags the floor up with it.
  floor.computeBoundingBox();
  assert.ok(floor.boundingBox!.max.y > 9, 'the floor rides the curve');
  assert.ok(pocketLining('HI', font, s).length >= 9, 'walls intact');
});

// ── text keeps its authored millimetres ─────────────────────────────────────

test('a glyph carries the inverse of its part scale, so resizing the part leaves the lettering alone', () => {
  const mesh = new THREE.Object3D();
  placeGlyph(mesh, spec(), [2, 2, 2]);
  // The part doubles; the glyph halves, so the two cancel in world space.
  near(mesh.scale.x, 0.5); near(mesh.scale.y, 0.5); near(mesh.scale.z, 0.5);

  // Non-uniform stretching is cancelled axis by axis — 8mm text on a part
  // stretched 3× wide is still 8mm text, not 24mm.
  placeGlyph(mesh, spec(), [3, 1, 0.5]);
  near(mesh.scale.x, 1 / 3); near(mesh.scale.y, 1); near(mesh.scale.z, 2);

  // An unscaled part leaves the glyph at its natural size.
  placeGlyph(mesh, spec(), [1, 1, 1]);
  near(mesh.scale.x, 1);
  // A degenerate zero never divides by zero.
  placeGlyph(mesh, spec(), [0, 1, 1]);
  near(mesh.scale.x, 1);
});

test('an engraved pocket shrinks with the part so the cut stays true size', () => {
  const s = spec({ style: 'deboss' });
  const plain = pocketFloor('HI', font, s);
  const onScaled = pocketFloor('HI', font, s, [2, 2, 2]);
  // Same letters, half the local size: the part's own 2× scale restores them.
  near(span(onScaled, 'x'), span(plain, 'x') / 2, 1e-4);
  near(span(onScaled, 'y'), span(plain, 'y') / 2, 1e-4);
});
