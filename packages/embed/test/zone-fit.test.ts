// Zone-to-face fitting: a placed image zone must CONFORM to the picked
// surface — centred on it, aligned with its edges (not the world axes),
// sized to its extents. The fit is pure geometry, asserted headless here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitZoneToRegion } from '../src/runtime/zone-fit.ts';
import { closedCurveSegments, curvePoint } from '../src/runtime/curve.ts';

type V3 = [number, number, number];
const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) < tol;

/** A rectangle as two triangles: centre, in-plane axes a (half-width) and
 * b (half-height) given as full 3D vectors. */
function rect(centre: V3, a: V3, b: V3): V3[][] {
  const add = (...vs: V3[]): V3 => vs.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]] as V3);
  const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
  const c0 = add(centre, neg(a), neg(b));
  const c1 = add(centre, a, neg(b));
  const c2 = add(centre, a, b);
  const c3 = add(centre, neg(a), b);
  return [[c0, c1, c2], [c0, c2, c3]];
}

test('an axis-aligned top face fits exactly: centre, size, no spin', () => {
  // 40×20 rectangle at height 10, normal +Y (u runs along x, v along −z).
  const fit = fitZoneToRegion(rect([5, 10, -3], [20, 0, 0], [0, 0, 10]), [0, 1, 0])!;
  assert.ok(near(fit.widthMm, 40) && near(fit.heightMm, 20), `${fit.widthMm}×${fit.heightMm}`);
  assert.ok(near(fit.angleDeg, 0), `angle ${fit.angleDeg}`);
  assert.deepEqual(fit.centre.map((v) => Math.round(v * 10) / 10), [5, 10, -3]);
});

test('a rotated face aligns the zone with ITS edges, not the world axes', () => {
  // The same 40×20 face spun 30° in the plane (normal +Z this time).
  const rad = Math.PI / 6;
  const a: V3 = [20 * Math.cos(rad), 20 * Math.sin(rad), 0];
  const b: V3 = [-10 * Math.sin(rad), 10 * Math.cos(rad), 0];
  const fit = fitZoneToRegion(rect([5, 3, 2], a, b), [0, 0, 1])!;
  assert.ok(near(fit.widthMm, 40) && near(fit.heightMm, 20), `${fit.widthMm}×${fit.heightMm}`);
  assert.ok(near(Math.abs(fit.angleDeg), 30, 0.2), `angle ${fit.angleDeg}`);
  assert.deepEqual(fit.centre.map((v) => Math.round(v * 10) / 10), [5, 3, 2]);
});

test('a non-rectangular face brings its rim along as the zone mask', () => {
  // A 60×45 top face with 10mm chamfered corners (octagon), normal +Y.
  // In-plane: u along x, v along −z.
  const pts: Array<[number, number]> = [
    [10, 0], [50, 0], [60, 10], [60, 35], [50, 45], [10, 45], [0, 35], [0, 10],
  ];
  const tris: V3[][] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    tris.push([
      [pts[0][0], 12, pts[0][1]],
      [pts[i][0], 12, pts[i][1]],
      [pts[i + 1][0], 12, pts[i + 1][1]],
    ]);
  }
  const fit = fitZoneToRegion(tris, [0, 1, 0])!;
  assert.ok(near(fit.widthMm, 60, 0.2) && near(fit.heightMm, 45, 0.2), `${fit.widthMm}×${fit.heightMm}`);
  assert.ok(fit.outline && fit.outline.length >= 6 && fit.outline.length <= 24,
    `outline ${fit.outline?.length} anchors`);
  for (const [u, v] of fit.outline!) {
    assert.ok(Math.abs(u) <= 30.1 && Math.abs(v) <= 22.6, `(${u}, ${v}) outside the zone`);
    // The chamfer means no anchor sits in a true rectangle corner.
    assert.ok(Math.abs(u) + Math.abs(v) < 45, `(${u}, ${v}) is an uncut corner`);
  }
  // A plain rectangle carries no mask — the zone rect IS the face.
  const plain = fitZoneToRegion(rect([0, 10, 0], [20, 0, 0], [0, 0, 10]), [0, 1, 0])!;
  assert.equal(plain.outline, undefined);
});

// A 60×45 top face with r=10 rounded corners at height 8, normal +Y,
// rim tessellated at 6° arc steps, fanned from the centre.
function roundedRectFace(): V3[][] {
  const w = 60, h = 45, r = 10;
  const rim: Array<[number, number]> = [];
  const corner = (cx: number, cz: number, a0: number) => {
    for (let k = 0; k <= 15; k++) {
      const a = a0 + (k / 15) * (Math.PI / 2);
      rim.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
    }
  };
  corner(w / 2 - r, h / 2 - r, 0);
  corner(-(w / 2 - r), h / 2 - r, Math.PI / 2);
  corner(-(w / 2 - r), -(h / 2 - r), Math.PI);
  corner(w / 2 - r, -(h / 2 - r), 3 * Math.PI / 2);
  return rim.map(([x, z], i) => {
    const [nx, nz] = rim[(i + 1) % rim.length];
    return [[0, 8, 0], [x, 8, z], [nx, 8, nz]] as V3[];
  });
}

test('a rounded-rectangle face keeps its shape — no melting into a blob', () => {
  const w = 60, h = 45, r = 10;
  const fit = fitZoneToRegion(roundedRectFace(), [0, 1, 0])!;
  assert.ok(near(fit.widthMm, w, 0.2) && near(fit.heightMm, h, 0.2), `${fit.widthMm}×${fit.heightMm}`);
  assert.ok(fit.outline && fit.outline.length >= 8, `outline ${fit.outline?.length} anchors`);

  // Render the boundary curve and measure it against the IDEAL rounded
  // rect (signed distance ≤ 0 inside). It must hug the rim — anything
  // melting corners or bowing edges inward strays several millimetres.
  const sdf = (u: number, v: number) => {
    const qx = Math.abs(u) - (w / 2 - r), qy = Math.abs(v) - (h / 2 - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
  let worst = 0;
  for (const seg of closedCurveSegments(fit.outline!)) {
    for (let t = 0; t <= 1; t += 0.1) {
      const [u, v] = curvePoint(seg, t);
      // note: the fit stores v in the zone frame (v up = −z here), but the
      // rounded rect is symmetric, so the sdf reads the same either way.
      worst = Math.max(worst, Math.abs(sdf(u, v)));
    }
  }
  assert.ok(worst < 1.5, `curve strays ${worst.toFixed(2)}mm from the face rim`);
  // Tessellation noise never stores a phantom rotation on a straight face.
  assert.equal(fit.angleDeg, 0);
});

test('a fillet triangle leaking into the weld cannot drag a tail', () => {
  // The weld sometimes admits the first fillet ring at one corner: a
  // triangle dipping 2mm below the crest, jutting past the rim. It must
  // not inflate the extents or pull the mask outline over the edge.
  const leak: V3[][] = [[[29, 8, -21], [33, 6, -25], [28, 6, -19]]];
  const fit = fitZoneToRegion([...roundedRectFace(), ...leak], [0, 1, 0])!;
  assert.ok(near(fit.widthMm, 60, 0.2) && near(fit.heightMm, 45, 0.2), `${fit.widthMm}×${fit.heightMm}`);
  for (const [u, v] of fit.outline!) {
    assert.ok(Math.abs(u) <= 30.1 && Math.abs(v) <= 22.6, `(${u}, ${v}) tails past the face`);
  }
});

test('degenerate input fits nothing', () => {
  assert.equal(fitZoneToRegion([], [0, 1, 0]), null);
  assert.equal(fitZoneToRegion(rect([0, 0, 0], [1, 0, 0], [0, 0, 1]), [0, 0, 0]), null);
  // A zero-area sliver has no extent to open a zone over.
  assert.equal(fitZoneToRegion([[[0, 0, 0], [1, 0, 0], [2, 0, 0]]], [0, 1, 0]), null);
});
