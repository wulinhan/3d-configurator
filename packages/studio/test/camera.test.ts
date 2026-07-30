// Saved camera views and the view-cube direction table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../../embed/src/manifest/validate.ts';
import type { Manifest } from '../../embed/src/manifest/types.ts';
import { initManifest, type PartBounds } from '../src/lib/manifest-init.ts';
import { setCameraView, frameCamera, EditError } from '../src/lib/manifest-edit.ts';
import { FACES, CORNERS } from '../src/ui/view-cube.ts';

const tri = (positions: number[]) => ({
  positions: Float32Array.from(positions),
  indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
});
const PARTS = [{ name: 'body', ...tri([-20, 0, -5, 20, 0, -5, 20, 20, 5]) }];
const fresh = (): Manifest => initManifest(PARTS, {
  name: 'Cam Product', bounds: { min: [-20, 0, -5], max: [20, 20, 5] },
});

test('setCameraView stores the pose, rounds it, and marks it userSet', () => {
  const m = setCameraView(fresh(), { position: [10.123456, 50, 200], target: [0, 25.0009, 0] });
  assert.deepEqual(validateManifest(m).errors, []);
  assert.deepEqual(m.camera!.position, [10.12, 50, 200]);
  assert.deepEqual(m.camera!.target, [0, 25, 0]);
  assert.equal(m.camera!.userSet, true);
});

test('setCameraView keeps unrelated camera settings', () => {
  const base = fresh();
  const m = setCameraView(base, { position: [0, 0, 100], target: [0, 0, 0] });
  assert.equal(m.camera!.background, base.camera!.background);
  assert.equal(m.camera!.minDistance, base.camera!.minDistance);
});

test('setCameraView rejects junk', () => {
  assert.throws(() => setCameraView(fresh(), { position: [NaN, 0, 0], target: [0, 0, 0] }), EditError);
  assert.throws(() => setCameraView(fresh(), { position: [0, 0, 1], target: [0, 0, 0], fov: 0 }), EditError);
  assert.throws(() => setCameraView(fresh(), { position: [0, 0, 1], target: [0, 0, 0], fov: 200 }), EditError);
});

test('a saved view survives frameCamera-style publishes by contract', () => {
  // The publish rule: userSet → keep verbatim; otherwise auto-frame. The UI
  // owns the branch; this pins that the two ops leave distinguishable state.
  const saved = setCameraView(fresh(), { position: [5, 5, 5], target: [0, 0, 0] });
  assert.equal(saved.camera!.userSet, true);
  const raw = new Map<string, PartBounds>([['body', { min: [-20, 0, -5], max: [20, 20, 5] }]]);
  const framed = frameCamera(fresh(), raw);
  assert.notEqual(framed.camera!.userSet, true);
});

test('the cube offers 6 named faces and 8 unit-length corner views', () => {
  assert.equal(FACES.length, 6);
  assert.equal(CORNERS.length, 8);
  assert.equal(new Set([...FACES, ...CORNERS].map((t) => t.name)).size, 14);
  for (const { name, dir } of [...FACES, ...CORNERS]) {
    const len = Math.hypot(...dir);
    assert.ok(Math.abs(len - 1) < 1e-9, `${name} is not unit length (${len})`);
  }
  // Corners cover every octant exactly once.
  const octants = new Set(CORNERS.map((c) => c.dir.map(Math.sign).join(',')));
  assert.equal(octants.size, 8);
});
