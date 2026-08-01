// Part management ops: rename, delete (with reference repair), default
// colours, match-position, and face snapping. Every op must leave a manifest
// the validator accepts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../../embed/src/manifest/validate.ts';
import { resolveLayout } from '../../embed/src/runtime/layout.ts';
import type { Manifest, ColourOption, ChoiceOption } from '../../embed/src/manifest/types.ts';
import { initManifest, boundsOf, type PartBounds } from '../src/lib/manifest-init.ts';
import {
  renamePart, removePart, setDefaultSwatch, copyPlacement, snapFaces,
  withAnchor, makePartOptional, nudge, withRotation,
  matchPose, partCentreMm, setPartCentre, EditError,
} from '../src/lib/manifest-edit.ts';

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);
const tri = (positions: number[]) => ({
  positions: Float32Array.from(positions),
  indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
});
const PARTS = [
  { name: 'body', ...tri([-20, 0, -5, 20, 0, -5, 20, 20, 5, -20, 20, 5, -20, 0, 5, 20, 0, 5]) },
  { name: 'cap', ...tri([-5, 0, -5, 5, 0, -5, 5, 4, 5, -5, 4, 5, -5, 0, 5, 5, 0, 5]) },
  { name: 'fin', ...tri([-2, 0, -2, 2, 0, -2, 2, 8, 2, -2, 8, 2, -2, 0, 2, 2, 0, 2]) },
];
const RAW = boundsOf(PARTS) as Map<string, PartBounds>;
const fresh = (): Manifest => initManifest(PARTS, {
  name: 'Parts Product', bounds: { min: [-20, 0, -5], max: [20, 20, 5] },
});
const valid = (m: Manifest) => assert.deepEqual(validateManifest(m).errors, []);

// ── rename ──────────────────────────────────────────────────────────────────

test('renamePart renames the part, its colour option, and its add-on option', () => {
  let m = makePartOptional(fresh(), 'cap', 10);
  m = renamePart(m, 'cap', 'Lid');
  valid(m);
  assert.equal(m.parts.find((p) => p.id === 'cap')!.label, 'Lid');
  assert.equal(m.options.find((o) => o.id === 'cap-colour')!.label, 'Lid');
  const addon = m.options.find((o) => o.id === 'cap-addon') as ChoiceOption;
  assert.equal(addon.label, 'Lid');
  assert.equal(addon.choices.find((c) => c.id === 'yes')!.label, 'Add Lid');
});

test('renamePart refuses a blank name and keeps ids stable', () => {
  assert.throws(() => renamePart(fresh(), 'cap', '   '), EditError);
  const m = renamePart(fresh(), 'cap', 'Lid');
  assert.ok(m.parts.some((p) => p.id === 'cap'), 'the id must not change — it binds the mesh');
});

// ── delete ──────────────────────────────────────────────────────────────────

test('removePart deletes the part, its options, and stays valid', () => {
  const m = removePart(makePartOptional(fresh(), 'cap', 10), 'cap', RAW);
  valid(m);
  assert.ok(!m.parts.some((p) => p.id === 'cap'));
  assert.ok(!m.options.some((o) => o.id === 'cap-colour'));
  assert.ok(!m.options.some((o) => o.id === 'cap-addon'));
});

test('removePart keeps anchored parts where they were', () => {
  // fin rides 2 mm above the cap; deleting the cap must not teleport the fin.
  let m = withAnchor(fresh(), 'fin', 1, { align: 'min', to: 'cap', edge: 'max', offset: 2 });
  m = nudge(m, 'cap', [0, 10, 0]); // move the cap so the fin's position is non-trivial
  const before = resolveLayout(m, RAW).get('fin')!.translate[1];
  const after = removePart(m, 'cap', RAW);
  valid(after);
  const fin = after.parts.find((p) => p.id === 'fin')!;
  assert.equal(fin.placement!.y!.to, 'origin', 'the anchor collapses to an origin offset');
  near(resolveLayout(after, RAW).get('fin')!.translate[1], before);
});

test('removePart cannot delete the last part', () => {
  let m = fresh();
  m = removePart(m, 'cap', RAW);
  m = removePart(m, 'fin', RAW);
  assert.throws(() => removePart(m, 'body', RAW), /last part/);
});

// ── default colour ──────────────────────────────────────────────────────────

test('setDefaultSwatch changes what customers open to', () => {
  const m = setDefaultSwatch(fresh(), 'cap-colour', 'red');
  valid(m);
  assert.equal((m.options.find((o) => o.id === 'cap-colour') as ColourOption).default, 'red');
});

test('setDefaultSwatch rejects a swatch that is not in the palette', () => {
  assert.throws(() => setDefaultSwatch(fresh(), 'cap-colour', 'chartreuse'), EditError);
});

// ── match position ──────────────────────────────────────────────────────────

test('copyPlacement duplicates position axes and rotation', () => {
  let m = withAnchor(fresh(), 'cap', 1, { align: 'min', to: 'body', edge: 'max', offset: 2 });
  m = nudge(m, 'cap', [7, 0, 0]);
  m = copyPlacement(m, 'cap', 'fin');
  valid(m);
  const cap = m.parts.find((p) => p.id === 'cap')!.placement!;
  const fin = m.parts.find((p) => p.id === 'fin')!.placement!;
  assert.deepEqual(fin.y, cap.y);
  assert.deepEqual(fin.x, cap.x);
});

test('copyPlacement never creates a self-anchor', () => {
  // cap is anchored to fin; fin copying cap's placement must drop that axis
  // rather than anchor fin to itself.
  const m = withAnchor(fresh(), 'cap', 1, { align: 'min', to: 'fin', edge: 'max', offset: 2 });
  const next = copyPlacement(m, 'cap', 'fin');
  valid(next);
  assert.equal(next.parts.find((p) => p.id === 'fin')!.placement?.y, undefined);
  assert.throws(() => copyPlacement(m, 'cap', 'cap'), EditError);
});

test('copyPlacement does not copy scale — position only', () => {
  const base = fresh();
  const capScaled = {
    ...base,
    parts: base.parts.map((p) => (p.id === 'cap' ? { ...p, placement: { scale: [2, 2, 2] as [number, number, number] } } : p)),
  };
  const next = copyPlacement(capScaled, 'cap', 'fin');
  assert.equal(next.parts.find((p) => p.id === 'fin')!.placement?.scale, undefined);
});

// ── match pose & absolute positioning ───────────────────────────────────────

test('matchPose lands centre on centre with the same rotation, as live anchors', () => {
  let m = withRotation(fresh(), 'body', [0, 30, 0]);
  m = nudge(m, 'body', [11, 3, -4]);
  m = matchPose(m, 'body', 'cap');
  valid(m);
  const layout = resolveLayout(m, RAW);
  for (const a of [0, 1, 2]) {
    near((layout.get('cap')!.box.min[a] + layout.get('cap')!.box.max[a]) / 2,
      (layout.get('body')!.box.min[a] + layout.get('body')!.box.max[a]) / 2);
  }
  assert.deepEqual(m.parts.find((p) => p.id === 'cap')!.placement!.rotation, [0, 30, 0]);
  // Live: moving the source carries the matched part with it.
  const moved = resolveLayout(nudge(m, 'body', [5, 0, 0]), RAW);
  near((moved.get('cap')!.box.min[0] + moved.get('cap')!.box.max[0]) / 2,
    (moved.get('body')!.box.min[0] + moved.get('body')!.box.max[0]) / 2);
  assert.throws(() => matchPose(m, 'cap', 'cap'), EditError);
});

test('matchPose refuses to create an anchor cycle', () => {
  const m = matchPose(fresh(), 'body', 'cap'); // cap follows body
  assert.throws(() => matchPose(m, 'cap', 'body'), EditError);
});

test('setPartCentre speaks absolute mm; storage stays an anchored offset', () => {
  let m = withAnchor(fresh(), 'cap', 1, { align: 'min', to: 'body', edge: 'max', offset: 2 });
  near(partCentreMm(m, 'cap', RAW)[1], 24); // body top 20 + 2 + half of 4
  m = setPartCentre(m, 'cap', 1, 30, RAW);
  valid(m);
  near(partCentreMm(m, 'cap', RAW)[1], 30);
  const y = m.parts.find((p) => p.id === 'cap')!.placement!.y!;
  assert.equal(y.to, 'body:max', 'the anchor survived — only the offset slid');
  near(y.offset ?? 0, 8);
  assert.equal(setPartCentre(m, 'cap', 1, 30, RAW), m, 'setting the current value is a no-op');
});

// ── snapping ────────────────────────────────────────────────────────────────

test('snapFaces mates the clicked faces flush and centres them onto each other', () => {
  // Merchant clicks the cap's bottom (−y), then the body's top (+y):
  // cap min-y anchors to body max-y, offset 0 — touching — and the two
  // in-plane axes centre onto the body, so the faces actually meet instead
  // of sharing a plane in empty air.
  const m = snapFaces(fresh(), { partId: 'cap', normal: [0, -1, 0] }, { partId: 'body', normal: [0, 1, 0] });
  valid(m);
  const cap = m.parts.find((p) => p.id === 'cap')!.placement!;
  assert.deepEqual(cap.y, { align: 'min', to: 'body:max', offset: 0 });
  assert.deepEqual(cap.x, { align: 'center', to: 'body:center', offset: 0 });
  assert.deepEqual(cap.z, { align: 'center', to: 'body:center', offset: 0 });
  // The joint is an anchor, so moving the body carries the cap.
  const moved = nudge(m, 'body', [0, 5, 0]);
  const layout = resolveLayout(moved, RAW);
  near(layout.get('cap')!.box.min[1], layout.get('body')!.box.max[1]);
  near((layout.get('cap')!.box.min[0] + layout.get('cap')!.box.max[0]) / 2,
    (layout.get('body')!.box.min[0] + layout.get('body')!.box.max[0]) / 2);
});

test('snapFaces rejects same part, angled faces, and mismatched axes', () => {
  assert.throws(() => snapFaces(fresh(), { partId: 'cap', normal: [0, -1, 0] }, { partId: 'cap', normal: [0, 1, 0] }), EditError);
  assert.throws(() => snapFaces(fresh(), { partId: 'cap', normal: [0.6, 0.6, 0.52] }, { partId: 'body', normal: [0, 1, 0] }), /angled|axis/);
  assert.throws(() => snapFaces(fresh(), { partId: 'cap', normal: [1, 0, 0] }, { partId: 'body', normal: [0, 1, 0] }), /same axis/);
});
