// Gizmo commit ops. A drag ends as an applyGizmoPose call; these tests pin
// the arithmetic that turns a mesh pose back into manifest placement — the
// part of the gizmo that can be wrong without looking wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../../embed/src/manifest/validate.ts';
import { resolveLayout } from '../../embed/src/runtime/layout.ts';
import type { Manifest } from '../../embed/src/manifest/types.ts';
import { initManifest, boundsOf, type PartBounds } from '../src/lib/manifest-init.ts';
import {
  withScale, nudge, applyGizmoPose, withAnchor, sizeMm, EditError, type GizmoPose,
} from '../src/lib/manifest-edit.ts';

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

const tri = (positions: number[]) => ({
  positions: Float32Array.from(positions),
  indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
});
const PARTS = [
  { name: 'body', ...tri([-20, 0, -5, 20, 0, -5, 20, 20, 5, -20, 20, 5, -20, 0, 5, 20, 0, 5]) },
  { name: 'cap', ...tri([-5, 0, -5, 5, 0, -5, 5, 4, 5, -5, 4, 5, -5, 0, 5, 5, 0, 5]) },
];
const RAW = boundsOf(PARTS) as Map<string, PartBounds>;

const fresh = (): Manifest => initManifest(PARTS, {
  name: 'Gizmo Product',
  bounds: { min: [-20, 0, -5], max: [20, 20, 5] },
});

const valid = (m: Manifest) => {
  const r = validateManifest(m);
  assert.deepEqual(r.errors, []);
};

/** The pose the viewer would render for a part: centre + layout translate. */
const poseOf = (m: Manifest, partId: string): GizmoPose => {
  const b = RAW.get(partId)!;
  const centre = [0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2);
  const t = resolveLayout(m, RAW).get(partId)!;
  const part = m.parts.find((p) => p.id === partId)!;
  return {
    position: [0, 1, 2].map((a) => centre[a] + t.translate[a]) as [number, number, number],
    rotationDeg: [...(part.placement?.rotation ?? [0, 0, 0])] as [number, number, number],
    scale: [...(part.placement?.scale ?? [1, 1, 1])] as [number, number, number],
  };
};

// ── withScale / nudge ───────────────────────────────────────────────────────

test('withScale writes multipliers and rejects non-positive axes', () => {
  const m = withScale(fresh(), 'cap', [2, 1, 1]);
  valid(m);
  assert.deepEqual(sizeMm(m, 'cap', RAW.get('cap')!), [20, 4, 10]);
  for (const bad of [[0, 1, 1], [-1, 1, 1], [NaN, 1, 1]] as [number, number, number][]) {
    assert.throws(() => withScale(fresh(), 'cap', bad), EditError);
  }
});

test('nudge shifts an as-modelled part by adding origin offsets', () => {
  const m = nudge(fresh(), 'cap', [5, 0, -3]);
  valid(m);
  const cap = m.parts.find((p) => p.id === 'cap')!;
  assert.deepEqual(cap.placement!.x, { to: 'origin', offset: 5 });
  assert.equal(cap.placement!.y, undefined); // zero delta leaves the axis alone
  assert.deepEqual(cap.placement!.z, { to: 'origin', offset: -3 });
});

test('nudge on an anchored axis slides the offset, keeping the anchor', () => {
  let m = withAnchor(fresh(), 'cap', 1, { align: 'min', to: 'body', edge: 'max', offset: 2 });
  m = nudge(m, 'cap', [0, 3, 0]);
  valid(m);
  assert.deepEqual(m.parts.find((p) => p.id === 'cap')!.placement!.y,
    { align: 'min', to: 'body:max', offset: 5 });
});

test('nudges accumulate', () => {
  let m = nudge(fresh(), 'cap', [1, 0, 0]);
  m = nudge(m, 'cap', [2.5, 0, 0]);
  assert.deepEqual(m.parts.find((p) => p.id === 'cap')!.placement!.x, { to: 'origin', offset: 3.5 });
});

// ── applyGizmoPose ──────────────────────────────────────────────────────────

test('an untouched pose is a no-op', () => {
  const m = fresh();
  const next = applyGizmoPose(m, 'cap', RAW, poseOf(m, 'cap'));
  assert.deepEqual(next, m);
});

test('a translate drag lands as offsets, and layout reproduces the pose', () => {
  const m = fresh();
  const pose = poseOf(m, 'cap');
  pose.position = [pose.position[0] + 7, pose.position[1], pose.position[2] - 2];
  const next = applyGizmoPose(m, 'cap', RAW, pose);
  valid(next);
  // Round-trip: rendering the new manifest must put the mesh where it was dropped.
  const after = poseOf(next, 'cap');
  near(after.position[0], pose.position[0]);
  near(after.position[2], pose.position[2]);
});

test('a translate drag on an anchored part slides along the anchor', () => {
  let m = withAnchor(fresh(), 'cap', 1, { align: 'min', to: 'body', edge: 'max', offset: 2 });
  const pose = poseOf(m, 'cap');
  pose.position = [pose.position[0], pose.position[1] + 4, pose.position[2]];
  const next = applyGizmoPose(m, 'cap', RAW, pose);
  valid(next);
  const y = next.parts.find((p) => p.id === 'cap')!.placement!.y!;
  assert.equal(y.to, 'body:max', 'the anchor must survive the drag');
  near(y.offset!, 6);
  // ...and the anchor still tracks: moving the body moves the dropped cap.
  const moved = nudge(next, 'body', [0, 10, 0]);
  const t = resolveLayout(moved, RAW).get('cap')!;
  const before = resolveLayout(next, RAW).get('cap')!;
  near(t.translate[1] - before.translate[1], 10);
});

test('a rotate drag commits degrees; a scale drag commits multipliers', () => {
  const m = fresh();
  const pose = poseOf(m, 'cap');
  pose.rotationDeg = [0, 45, 0];
  pose.scale = [2, 2, 2];
  const next = applyGizmoPose(m, 'cap', RAW, pose);
  valid(next);
  const cap = next.parts.find((p) => p.id === 'cap')!;
  assert.deepEqual(cap.placement!.rotation, [0, 45, 0]);
  assert.deepEqual(cap.placement!.scale, [2, 2, 2]);
});

test('rotation + translation in one drag stay consistent', () => {
  // Rotating changes the AABB, which changes where layout puts the mesh —
  // the translation delta must be measured against the post-rotation layout.
  const m = fresh();
  const pose = poseOf(m, 'cap');
  pose.rotationDeg = [0, 90, 0];
  pose.position = [pose.position[0] + 3, pose.position[1], pose.position[2]];
  const next = applyGizmoPose(m, 'cap', RAW, pose);
  valid(next);
  const after = poseOf(next, 'cap');
  near(after.position[0], pose.position[0], 1e-3);
  assert.deepEqual(after.rotationDeg, [0, 90, 0]);
});

test('scaling through the gizmo keeps the panel arithmetic honest', () => {
  // Proportions are locked by default, so dragging ONE handle takes the
  // whole part with it — the panel's Lock proportions box and the
  // viewport's scale gizmo have to agree about that.
  const m = fresh();
  const pose = poseOf(m, 'cap');
  pose.scale = [3, 1, 1];
  const locked = applyGizmoPose(m, 'cap', RAW, pose);
  assert.deepEqual(sizeMm(locked, 'cap', RAW.get('cap')!), [30, 12, 30]);

  // Unlocked, each axis is its own: the same drag stretches width alone.
  const free = withScale(m, 'cap', [1, 1, 1], false);
  const next = applyGizmoPose(free, 'cap', RAW, { ...poseOf(free, 'cap'), scale: [3, 1, 1] });
  assert.deepEqual(sizeMm(next, 'cap', RAW.get('cap')!), [30, 4, 10]);
});

test('poses with junk are refused', () => {
  const m = fresh();
  const pose = poseOf(m, 'cap');
  pose.scale = [0, 1, 1];
  assert.throws(() => applyGizmoPose(m, 'cap', RAW, pose), EditError);
  assert.throws(() => applyGizmoPose(m, 'ghost', RAW, poseOf(m, 'cap')), EditError);
});
