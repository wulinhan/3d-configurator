// An assembly transforms like a part: an absolute position, a rigid turn, a
// uniform scale — every member spinning AND orbiting together, joints kept.
// These pin the arithmetic the assembly gizmo and panel fields ride on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../../embed/src/manifest/validate.ts';
import { resolveLayout } from '../../embed/src/runtime/layout.ts';
import type { Manifest } from '../../embed/src/manifest/types.ts';
import { initManifest, boundsOf, type PartBounds } from '../src/lib/manifest-init.ts';
import {
  makeGroup, withAnchor, rotateEntry, scaleEntryBy, setEntryCentre, entryBoxOf, EditError,
} from '../src/lib/manifest-edit.ts';

const near = (a: number, b: number, tol = 0.02) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);
const tri = (positions: number[]) => ({
  positions: Float32Array.from(positions),
  indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
});
// Two 10-cubes: one centred at origin height 0–10, one sitting 20mm along X.
const box = (cx: number) => tri([
  cx - 5, 0, -5, cx + 5, 0, -5, cx + 5, 10, 5,
  cx - 5, 10, 5, cx - 5, 0, 5, cx + 5, 0, 5,
]);
const PARTS = [
  { name: 'left', ...box(0) },
  { name: 'right', ...box(20) },
];
const RAW = boundsOf(PARTS) as Map<string, PartBounds>;
const fresh = (): Manifest => initManifest(PARTS, {
  name: 'Pair', bounds: { min: [-5, 0, -5], max: [25, 10, 5] },
});
const valid = (m: Manifest) => assert.deepEqual(validateManifest(m).errors, []);

const centreOf = (m: Manifest, id: string): number[] => {
  const b = resolveLayout(m, RAW).get(id)!.box;
  return [0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2);
};

test('rotateEntry turns the whole assembly rigidly: members spin AND orbit', () => {
  const grouped = makeGroup(fresh(), ['left', 'right'], 'Pair');
  const before = entryBoxOf(grouped, 'pair', RAW);
  const [lc, rc] = [centreOf(grouped, 'left'), centreOf(grouped, 'right')];

  const turned = rotateEntry(grouped, 'pair', [0, 90, 0], RAW);
  valid(turned);

  // Every member wears the turn…
  for (const id of ['left', 'right']) {
    const rot = turned.parts.find((p) => p.id === id)!.placement!.rotation!;
    near(rot[1], 90, 0.01);
  }
  // …and orbits the union centre: +90° about Y maps (x,z)→(z+cx, -(x-cx)).
  const c = before.centre;
  const expect = (was: number[]) => [
    c[0] + (was[2] - c[2]), was[1], c[2] - (was[0] - c[0]),
  ];
  const [lAfter, rAfter] = [centreOf(turned, 'left'), centreOf(turned, 'right')];
  for (const [got, want] of [[lAfter, expect(lc)], [rAfter, expect(rc)]] as const) {
    for (const a of [0, 1, 2]) near(got[a], want[a]);
  }
  // The union centre itself does not move — that is what "about" means.
  const after = entryBoxOf(turned, 'pair', RAW);
  for (const a of [0, 1, 2]) near(after.centre[a], before.centre[a]);
});

test('two 45° turns equal one 90° turn — composition is matrix, not addition', () => {
  const grouped = makeGroup(fresh(), ['left', 'right'], 'Pair');
  const twice = rotateEntry(rotateEntry(grouped, 'pair', [0, 45, 0], RAW), 'pair', [0, 45, 0], RAW);
  const once = rotateEntry(grouped, 'pair', [0, 90, 0], RAW);
  for (const id of ['left', 'right']) {
    const a = centreOf(twice, id);
    const b = centreOf(once, id);
    for (const axis of [0, 1, 2]) near(a[axis], b[axis], 0.05);
  }
  valid(twice);
});

test('rotateEntry keeps anchored joints: the pair stays 20mm apart through a turn', () => {
  let m = makeGroup(fresh(), ['left', 'right'], 'Pair');
  m = withAnchor(m, 'right', 0, { align: 'min', to: 'left', edge: 'max', offset: 10 });
  const turned = rotateEntry(m, 'pair', [0, 0, 30], RAW);
  valid(turned);
  const [l, r] = [centreOf(turned, 'left'), centreOf(turned, 'right')];
  const gap = Math.hypot(r[0] - l[0], r[1] - l[1], r[2] - l[2]);
  near(gap, 20, 0.05);
});

test('scaleEntryBy grows every member about the pivot, uniformly', () => {
  const grouped = makeGroup(fresh(), ['left', 'right'], 'Pair');
  const before = entryBoxOf(grouped, 'pair', RAW);
  const scaled = scaleEntryBy(grouped, 'pair', 2, RAW);
  valid(scaled);
  const after = entryBoxOf(scaled, 'pair', RAW);
  for (const a of [0, 1, 2]) {
    near(after.max[a] - after.min[a], (before.max[a] - before.min[a]) * 2, 0.05);
    near(after.centre[a], before.centre[a], 0.05);
  }
  assert.throws(() => scaleEntryBy(grouped, 'pair', 0, RAW), EditError);
  assert.throws(() => scaleEntryBy(grouped, 'pair', -1, RAW), EditError);
});

test('setEntryCentre lands the union centre at an absolute coordinate', () => {
  const grouped = makeGroup(fresh(), ['left', 'right'], 'Pair');
  const moved = setEntryCentre(setEntryCentre(grouped, 'pair', 0, 100, RAW), 'pair', 1, 40, RAW);
  valid(moved);
  const box = entryBoxOf(moved, 'pair', RAW);
  near(box.centre[0], 100);
  near(box.centre[1], 40);
  // Members kept their spacing — the move was rigid.
  const [l, r] = [centreOf(moved, 'left'), centreOf(moved, 'right')];
  near(r[0] - l[0], 20, 0.05);
});

test('junk is refused before it can shear an assembly apart', () => {
  const grouped = makeGroup(fresh(), ['left', 'right'], 'Pair');
  assert.throws(() => rotateEntry(grouped, 'pair', [NaN, 0, 0], RAW), EditError);
  assert.throws(() => rotateEntry(grouped, 'ghost', [0, 10, 0], RAW), EditError);
  assert.throws(() => setEntryCentre(grouped, 'pair', 0, NaN, RAW), EditError);
  // A zero turn is a no-op, not a revision.
  assert.equal(rotateEntry(grouped, 'pair', [0, 0, 0], RAW), grouped);
});
