// Text that follows a curved surface. The walk is fed an ANALYTIC surface
// here — a cylinder, a dome, a tilted plane — so every assertion is exact
// maths rather than "looks right on a mesh": glyphs must sit ON the
// surface, face outward along its normal, and be spaced by the distance
// they actually travel across it, not by their flat shadow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import sansBold from '../src/fonts/sans-bold.ts';
import { glyphRun, baselineAt, wrappedTextGeometry } from '../src/runtime/engrave.ts';
import { wrapGlyphs, type SurfaceProbe, type V3 } from '../src/runtime/wrap.ts';
import type { TextOption } from '../src/manifest/types.ts';

const font = new FontLoader().parse(sansBold as never);
const spec = (over: Partial<TextOption> = {}): TextOption => ({
  id: 't', type: 'text', label: 'T', part: 'p',
  origin: [0, 0, 0], normal: [0, 0, 1], sizeMm: 6, depthMm: 1.5, ...over,
});
const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);
const len = (v: V3) => Math.hypot(v[0], v[1], v[2]);
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Lay a run out on a probe, using the slot's real font metrics. */
function layout(text: string, s: TextOption, probe: SurfaceProbe, stepMm = 0.2) {
  const run = glyphRun(text, font, s);
  return { run, ...wrapGlyphs(run.glyphs, baselineAt(s, run.total), probe, { stepMm }) };
}

/**
 * A cylinder of radius R lying along the world Y axis, wrapped from the
 * outside: the sketch plane is the tangent plane at (R, 0, 0), u runs
 * around the barrel and v along the axis. The probe reports where a ray
 * from the sketch point lands on the barrel — which, for a tangent plane,
 * is the point at angle u/R... but the walk must not be TOLD that; it has
 * to discover the spacing by measuring. So the probe projects radially,
 * exactly as a raycast from outside would.
 */
const cylinderProbe = (R: number): SurfaceProbe => (u, v) => {
  // Sketch point in world: tangent plane at (R,0,0), pushed out along +x.
  const p: V3 = [R, v, -u];
  // Radial projection onto the barrel (the ray a viewer would cast inward).
  const r = Math.hypot(p[0], p[2]);
  if (r < 1e-9) return null;
  const k = R / r;
  return { point: [p[0] * k, p[1], p[2] * k], normal: [p[0] / r, 0, p[2] / r] };
};

test('a flat probe reproduces the flat layout exactly', () => {
  // A plane at z = 0 facing +z: wrapping must change nothing at all.
  const flat: SurfaceProbe = (u, v) => ({ point: [u, v, 0], normal: [0, 0, 1] });
  const { run, glyphs, missed } = layout('HELLO', spec(), flat);
  assert.equal(missed.length, 0);
  assert.equal(glyphs.length, run.glyphs.length);
  glyphs.forEach((g, i) => {
    near(g.position[0], run.glyphs[i].mid, 1e-3);
    near(g.position[1], 0, 1e-6);
    near(g.position[2], 0, 1e-6);
    // Frame: travelling +x, up +y, facing +z.
    near(g.xAxis[0], 1, 1e-6);
    near(g.yAxis[1], 1, 1e-6);
    near(g.normal[2], 1, 1e-6);
  });
});

test('on a cylinder every glyph sits ON the barrel, facing straight out', () => {
  const R = 20;
  const { glyphs, missed } = layout('WRAPPED', spec(), cylinderProbe(R));
  assert.equal(missed.length, 0, 'a 20mm barrel carries the whole word');
  for (const g of glyphs) {
    // The defining property: distance from the axis is the radius.
    near(Math.hypot(g.position[0], g.position[2]), R, 1e-3);
    // The normal points straight out from the axis, and the frame is sane.
    near(dot(g.normal, [g.position[0] / R, 0, g.position[2] / R]), 1, 1e-3);
    near(len(g.xAxis), 1, 1e-6);
    near(dot(g.xAxis, g.normal), 0, 1e-6);   // forward lies in the surface
    near(dot(g.xAxis, g.yAxis), 0, 1e-6);    // ...and the frame is orthogonal
  }
});

test('spacing is measured ALONG the surface, not across the flat shadow', () => {
  // This is the whole point of the arc-length walk. On a tight barrel the
  // flat plane's x is a CHORD; stepping by it would bunch the letters as
  // the surface curves away. Consecutive glyphs must be their advance
  // apart measured around the barrel.
  const R = 12;
  const s = spec();
  const { run, glyphs } = layout('IIIIIII', s, cylinderProbe(R), 0.1);
  assert.equal(glyphs.length, run.glyphs.length);
  for (let i = 1; i < glyphs.length; i++) {
    const a = glyphs[i - 1].position;
    const b = glyphs[i].position;
    // Angle between them around the axis → arc length.
    const angle = Math.abs(Math.atan2(b[2], b[0]) - Math.atan2(a[2], a[0]));
    const arc = angle * R;
    near(arc, run.glyphs[i].mid - run.glyphs[i - 1].mid, 0.05);
    // The straight-line chord is SHORTER than the arc — proof the walk is
    // not just placing glyphs at their flat x.
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    assert.ok(chord < arc, `chord ${chord} should trail arc ${arc}`);
  }
});

test('a run longer than the surface reports the letters that fell off', () => {
  // A 6mm-wide strip: only the middle of a long word can land on it.
  const strip: SurfaceProbe = (u, v) => (Math.abs(u) <= 3
    ? { point: [u, v, 0], normal: [0, 0, 1] }
    : null);
  const { glyphs, missed, reach } = layout('MMMMMMMMM', spec(), strip);
  assert.ok(missed.length > 0, 'the overrun is reported, not silently dropped');
  assert.ok(glyphs.length >= 1, 'what fits still lands');
  assert.ok(reach.forward <= 3.5 && reach.back <= 3.5, 'the walk stops at the edge');
  // Everything that landed is genuinely on the strip.
  for (const g of glyphs) assert.ok(Math.abs(g.position[0]) <= 3.5, `${g.position[0]}`);
});

test('lift floats the run off the surface along its own normal', () => {
  const R = 15;
  const run = glyphRun('AB', font, spec());
  const on = wrapGlyphs(run.glyphs, baselineAt(spec(), run.total), cylinderProbe(R), { stepMm: 0.2 });
  const up = wrapGlyphs(run.glyphs, baselineAt(spec(), run.total), cylinderProbe(R), { stepMm: 0.2, liftMm: 2 });
  on.glyphs.forEach((g, i) => {
    near(Math.hypot(g.position[0], g.position[2]), R, 1e-3);
    // Lifted along the LOCAL normal, so the radius grows by exactly the lift.
    near(Math.hypot(up.glyphs[i].position[0], up.glyphs[i].position[2]), R + 2, 1e-3);
  });
});

test('a dome carries text too — the walk never assumes an unrollable surface', () => {
  // A sphere of radius R centred at the origin, probed from above: this is
  // doubly curved, so a "flatten and print" scheme could not do it.
  const R = 25;
  const dome: SurfaceProbe = (u, v) => {
    const d2 = u * u + v * v;
    if (d2 > R * R * 0.8) return null; // stay off the steep skirt
    // Project the sketch point straight down onto the sphere.
    const y = Math.sqrt(R * R - d2);
    const p: V3 = [u, y, v];
    return { point: p, normal: [p[0] / R, p[1] / R, p[2] / R] };
  };
  const { glyphs, missed } = layout('DOME', spec({ sizeMm: 5 }), dome);
  assert.equal(missed.length, 0);
  for (const g of glyphs) {
    near(len(g.position), R, 1e-2, );        // on the sphere
    near(dot(g.normal, [g.position[0] / R, g.position[1] / R, g.position[2] / R]), 1, 1e-3);
    near(dot(g.xAxis, g.normal), 0, 1e-6);   // frame still tangent
  }
});

test('a bent baseline still wraps — the two curves compose', () => {
  // Bend curves the run inside the sketch plane; the wrap then lays that
  // curve onto the barrel. Both must show: the letters ride the cylinder
  // AND climb along its axis.
  const R = 30;
  const { glyphs, missed } = layout('ARCH', spec({ bendDeg: 60 }), cylinderProbe(R));
  assert.equal(missed.length, 0);
  for (const g of glyphs) near(Math.hypot(g.position[0], g.position[2]), R, 1e-2);
  const ys = glyphs.map((g) => g.position[1]);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 0.5, 'the bend lifts the ends along the axis');
});

test('a probe that finds nothing at the origin gives up cleanly', () => {
  const nothing: SurfaceProbe = () => null;
  const { glyphs, missed } = layout('GONE', spec(), nothing);
  assert.equal(glyphs.length, 0);
  assert.equal(missed.length, 4, 'every letter is reported for flat fallback');
});

// ── geometry assembly ───────────────────────────────────────────────────────

test('wrappedTextGeometry bakes the run onto the barrel, ready to render', () => {
  const R = 18;
  const geo = wrappedTextGeometry('WRAP', font, spec(), cylinderProbe(R));
  assert.ok(geo, 'a barrel under the slot yields geometry');
  const pos = geo!.geometry.attributes.position;
  assert.ok(pos.count > 100, 'four letters of real geometry');
  assert.equal(geo!.missed.length, 0);

  // Every vertex hugs the barrel: the run's base sits ON it and its outer
  // face a depth above. Letters stay RIGID, so a glyph's corners chord a
  // fraction of a millimetre off the curve — that is the known limit of
  // per-glyph wrapping, and it must stay small.
  let min = Infinity, max = -Infinity;
  let width = 0;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getZ(i));
    min = Math.min(min, r);
    max = Math.max(max, r);
    width = Math.max(width, Math.abs(pos.getY(i)));
  }
  near(min, R, 0.05, );                                  // the base touches down
  assert.ok(max >= R + spec().depthMm - 0.01, `outer face at ${max}`);
  assert.ok(max < R + spec().depthMm + 1, `chord lift ${max - R - spec().depthMm}mm is small`);

  // The discriminator against "one flat slab tangent to the barrel": such a
  // slab's far corners would sit a couple of millimetres further out.
  const runWidth = glyphRun('WRAP', font, spec()).total;
  const slabCorner = Math.hypot(R + spec().depthMm, runWidth / 2);
  assert.ok(max < slabCorner - 1.5, `${max} must beat a flat slab's ${slabCorner}`);

  // The extrude group convention survives, so the engrave pipeline could
  // read a wrapped run exactly like a flat one.
  assert.equal(geo!.geometry.groups.length, 2);
  assert.deepEqual(geo!.geometry.groups.map((g) => g.materialIndex), [0, 1]);
});

test('the geometry lands in the caller\'s target space', () => {
  // The viewer probes in WORLD space and bakes into the carrier's local
  // space; here that conversion is a plain 100mm shift along x.
  const R = 18;
  const plain = wrappedTextGeometry('AB', font, spec(), cylinderProbe(R))!;
  const shifted = wrappedTextGeometry(
    'AB', font, spec(), cylinderProbe(R), new THREE.Matrix4().makeTranslation(100, 0, 0))!;
  const a = plain.geometry.attributes.position;
  const b = shifted.geometry.attributes.position;
  assert.equal(a.count, b.count);
  for (let i = 0; i < a.count; i += 17) {
    near(b.getX(i) - a.getX(i), 100, 1e-3);
    near(b.getY(i), a.getY(i), 1e-3);
    near(b.getZ(i), a.getZ(i), 1e-3);
  }
});

test('no surface under the slot yields nothing to render, not a broken mesh', () => {
  assert.equal(wrappedTextGeometry('X', font, spec(), () => null), null);
});
