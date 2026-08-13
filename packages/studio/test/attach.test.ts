// Attach-to-body: a part glued to a FACE of another body at a gap — and the
// gradient swatches that shipped in the same batch. These pin the layout
// arithmetic (face, gap, offset, union targets, follower chains), the
// validation that keeps a manifest honest, and the edit ops the panel calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../../embed/src/manifest/validate.ts';
import { resolveLayout } from '../../embed/src/runtime/layout.ts';
import type { Manifest } from '../../embed/src/manifest/types.ts';
import { initManifest, boundsOf, type PartBounds } from '../src/lib/manifest-init.ts';
import { makeGroup, setAttach, setSwatchGradient, EditError } from '../src/lib/manifest-edit.ts';

const near = (a: number, b: number, tol = 0.02) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);
const tri = (positions: number[]) => ({
  positions: Float32Array.from(positions),
  indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
});
// A 10-cube at the origin, a second 10-cube 20mm along X, and a small 4-cube
// charm parked far away at x≈50 — the thing that gets attached.
const box = (cx: number, half: number) => tri([
  cx - half, 0, -half, cx + half, 0, -half, cx + half, half * 2, half,
  cx - half, half * 2, half, cx - half, 0, half, cx + half, 0, half,
]);
const PARTS = [
  { name: 'left', ...box(0, 5) },
  { name: 'right', ...box(20, 5) },
  { name: 'charm', ...box(50, 2) },
];
const RAW = boundsOf(PARTS) as Map<string, PartBounds>;
const fresh = (): Manifest => initManifest(PARTS, {
  name: 'Pair', bounds: { min: [-5, 0, -5], max: [52, 10, 5] },
});
const valid = (m: Manifest) => assert.deepEqual(validateManifest(m).errors, []);
const boxOf = (m: Manifest, id: string) => resolveLayout(m, RAW).get(id)!.box;

test('attach lands the part against the face, gap honoured, centred on the other axes', () => {
  const m = setAttach(fresh(), 'charm', { to: 'left', face: 'x+', gapMm: 3 });
  valid(m);
  const target = boxOf(m, 'left');
  const charm = boxOf(m, 'charm');
  near(charm.min[0], target.max[0] + 3);                       // face + gap
  near((charm.min[1] + charm.max[1]) / 2, (target.min[1] + target.max[1]) / 2); // centred
  near((charm.min[2] + charm.max[2]) / 2, (target.min[2] + target.max[2]) / 2);
});

test('every face means its own side, and offsets slide off dead-centre', () => {
  const under = setAttach(fresh(), 'charm', { to: 'left', face: 'y-', gapMm: 1 });
  const b = boxOf(under, 'left');
  near(boxOf(under, 'charm').max[1], b.min[1] - 1);

  const shifted = setAttach(fresh(), 'charm', { to: 'left', face: 'x+', gapMm: 0, offsetMm: [0, 4, -2] });
  const t = boxOf(shifted, 'left');
  const c = boxOf(shifted, 'charm');
  near(c.min[0], t.max[0]);
  near((c.min[1] + c.max[1]) / 2, (t.min[1] + t.max[1]) / 2 + 4);
  near((c.min[2] + c.max[2]) / 2, (t.min[2] + t.max[2]) / 2 - 2);
});

test('an assembly target means its UNION box — the charm hangs off the whole thing', () => {
  let m = makeGroup(fresh(), ['left', 'right'], 'Pair');
  m = setAttach(m, 'charm', { to: 'pair', face: 'x+', gapMm: 2 });
  valid(m);
  const l = boxOf(m, 'left');
  const r = boxOf(m, 'right');
  const c = boxOf(m, 'charm');
  near(c.min[0], Math.max(l.max[0], r.max[0]) + 2);
  // Centred on the union, not on either member.
  near((c.min[2] + c.max[2]) / 2, (Math.min(l.min[2], r.min[2]) + Math.max(l.max[2], r.max[2])) / 2);
});

test('the attachment FOLLOWS the target: move the target, the charm rides along', () => {
  let m = setAttach(fresh(), 'charm', { to: 'right', face: 'x+', gapMm: 1 });
  const before = boxOf(m, 'charm');
  // Slide the target 15mm along X by its own offset (translate is additive).
  m = {
    ...m,
    parts: m.parts.map((p) => (p.id === 'right'
      ? { ...p, placement: { ...p.placement, x: { to: 'origin' as const, offset: 15 } } }
      : p)),
  };
  const after = boxOf(m, 'charm');
  near(after.min[0] - before.min[0], 15);
});

test('follower chains resolve (a tag on the charm on the clicker), cycles are refused', () => {
  let m = setAttach(fresh(), 'charm', { to: 'left', face: 'x+', gapMm: 2 });
  m = setAttach(m, 'right', { to: 'charm', face: 'x+', gapMm: 1 });
  valid(m);
  const charm = boxOf(m, 'charm');
  near(boxOf(m, 'right').min[0], charm.max[0] + 1);

  // charm → left while left → charm is a loop; validation must say so.
  const looped = structuredClone(m);
  looped.parts.find((p) => p.id === 'left')!.attach = { to: 'right', face: 'x-' };
  const verdict = validateManifest(looped);
  assert.ok(verdict.errors.some((e) => /cycle/.test(e.message)), JSON.stringify(verdict.errors));
});

test('junk is refused: unknown bodies, self-attachment, bad faces', () => {
  assert.throws(() => setAttach(fresh(), 'charm', { to: 'ghost', face: 'x+' }), EditError);
  assert.throws(() => setAttach(fresh(), 'charm', { to: 'charm', face: 'x+' }), EditError);
  const grouped = makeGroup(fresh(), ['left', 'charm'], 'Bundle');
  // A body CONTAINING the part is self-attachment in disguise.
  assert.throws(() => setAttach(grouped, 'charm', { to: 'bundle', face: 'x+' }), EditError);
  assert.throws(() => setAttach(fresh(), 'charm', { to: 'left', face: 'up' as never }), EditError);
  // Detach restores the part's own authored position.
  const off = setAttach(setAttach(fresh(), 'charm', { to: 'left', face: 'x+' }), 'charm', undefined);
  assert.equal(off.parts.find((p) => p.id === 'charm')!.attach, undefined);
  near(boxOf(off, 'charm').min[0], boxOf(fresh(), 'charm').min[0]);
});

test('gradient swatches: set, retune, clear — and junk refused', () => {
  const m = fresh();
  const paletteId = m.palettes![0].id;
  const swatchId = m.palettes![0].swatches[0].id;
  let g = setSwatchGradient(m, paletteId, swatchId, { hex2: '#FFD35D', axis: 'x' });
  valid(g);
  let sw = g.palettes![0].swatches[0];
  assert.equal(sw.hex2, '#FFD35D');
  assert.equal(sw.gradientAxis, 'x');
  // The default direction ('y', bottom to top) is not stored — manifests stay lean.
  g = setSwatchGradient(g, paletteId, swatchId, { hex2: '#FFD35D', axis: 'y' });
  sw = g.palettes![0].swatches[0];
  assert.equal(sw.gradientAxis, undefined);
  assert.equal(sw.hex2, '#FFD35D');
  g = setSwatchGradient(g, paletteId, swatchId, undefined);
  sw = g.palettes![0].swatches[0];
  assert.equal(sw.hex2, undefined);
  assert.throws(() => setSwatchGradient(m, paletteId, swatchId, { hex2: 'gold' as never }), EditError);
});
