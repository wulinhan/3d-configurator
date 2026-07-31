// Groups, variant choices, explorer entries and ordering. The properties
// that matter: grouping merges colours without double-painting, variants are
// mutually exclusive by construction, group moves never move a member twice,
// and reordering carries whole entries and drags the option order along.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../../embed/src/manifest/validate.ts';
import { resolveLayout } from '../../embed/src/runtime/layout.ts';
import { defaultSelections, visibleParts } from '../../embed/src/runtime/state.ts';
import type { Manifest, ColourOption, ChoiceOption } from '../../embed/src/manifest/types.ts';
import { initManifest, boundsOf, type PartBounds } from '../src/lib/manifest-init.ts';
import {
  makeGroup, ungroup, renameGroup, nudgeGroup,
  makeVariantChoice, dissolveVariantChoice,
  entriesOf, moveEntry, withAnchor, makePartOptional, EditError,
} from '../src/lib/manifest-edit.ts';

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);
const tri = (positions: number[]) => ({
  positions: Float32Array.from(positions),
  indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
});
const PARTS = [
  { name: 'body', ...tri([-20, 0, -5, 20, 0, -5, 20, 20, 5, -20, 20, 5, -20, 0, 5, 20, 0, 5]) },
  { name: 'lid', ...tri([-5, 0, -5, 5, 0, -5, 5, 4, 5, -5, 4, 5, -5, 0, 5, 5, 0, 5]) },
  { name: 'flat-lid', ...tri([-5, 0, -5, 5, 0, -5, 5, 2, 5, -5, 2, 5, -5, 0, 5, 5, 0, 5]) },
  { name: 'badge', ...tri([-2, 0, -2, 2, 0, -2, 2, 1, 2, -2, 1, 2, -2, 0, 2, 2, 0, 2]) },
];
const RAW = boundsOf(PARTS) as Map<string, PartBounds>;
const fresh = (): Manifest => initManifest(PARTS, {
  name: 'Structured Product', bounds: { min: [-20, 0, -5], max: [20, 20, 5] },
});
const valid = (m: Manifest) => assert.deepEqual(validateManifest(m).errors, []);

// ── groups ──────────────────────────────────────────────────────────────────

test('makeGroup records the group and merges member colour options into one', () => {
  const m = makeGroup(fresh(), ['body', 'badge'], 'Shell');
  valid(m);
  assert.deepEqual(m.groups, [{ id: 'shell', label: 'Shell', parts: ['body', 'badge'] }]);
  const merged = m.options.find((o) => o.id === 'shell-colour') as ColourOption;
  assert.deepEqual(merged.parts.sort(), ['badge', 'body']);
  assert.ok(!m.options.some((o) => o.id === 'body-colour' || o.id === 'badge-colour'));
  // No part painted by two colour options.
  const painted = m.options.flatMap((o) => (o.type === 'colour' ? o.parts : []));
  assert.equal(new Set(painted).size, painted.length);
});

test('makeGroup refuses singles, blanks, and double membership', () => {
  assert.throws(() => makeGroup(fresh(), ['body'], 'X'), EditError);
  assert.throws(() => makeGroup(fresh(), ['body', 'badge'], '  '), EditError);
  const grouped = makeGroup(fresh(), ['body', 'badge'], 'Shell');
  assert.throws(() => makeGroup(grouped, ['badge', 'lid'], 'Other'), /already in a group/);
});

test('ungroup dissolves the group but keeps the merged colour option', () => {
  const m = ungroup(makeGroup(fresh(), ['body', 'badge'], 'Shell'), 'shell');
  valid(m);
  assert.equal(m.groups, undefined);
  assert.ok(m.options.some((o) => o.id === 'shell-colour'));
});

test('renameGroup renames the group and its merged option', () => {
  const m = renameGroup(makeGroup(fresh(), ['body', 'badge'], 'Shell'), 'shell', 'Chassis');
  assert.equal(m.groups![0].label, 'Chassis');
  assert.equal(m.options.find((o) => o.id === 'shell-colour')!.label, 'Chassis');
});

test('nudgeGroup moves members once, even when anchored to each other', () => {
  // badge rides on the body; nudging the group must not move it twice.
  let m = withAnchor(fresh(), 'badge', 1, { align: 'min', to: 'body', edge: 'max', offset: 1 });
  m = makeGroup(m, ['body', 'badge'], 'Shell');
  const before = resolveLayout(m, RAW);
  const moved = nudgeGroup(m, 'shell', [5, 10, 0]);
  valid(moved);
  const after = resolveLayout(moved, RAW);
  for (const id of ['body', 'badge']) {
    near(after.get(id)!.translate[0] - before.get(id)!.translate[0], 5);
    near(after.get(id)!.translate[1] - before.get(id)!.translate[1], 10);
  }
});

// ── variants ────────────────────────────────────────────────────────────────

test('makeVariantChoice: exactly one variant visible, customers pick', () => {
  const m = makeVariantChoice(fresh(), ['lid', 'flat-lid'], 'Lid style');
  valid(m);
  const option = m.options.find((o) => o.id === 'lid-style') as ChoiceOption;
  assert.equal(option.role, 'variant');
  assert.deepEqual(option.choices.map((c) => c.id), ['lid', 'flat-lid']);

  const s = defaultSelections(m);
  let visible = visibleParts(m, s);
  assert.ok(visible.has('lid') && !visible.has('flat-lid'), 'default variant shows');
  s['lid-style'] = 'flat-lid';
  visible = visibleParts(m, s);
  assert.ok(!visible.has('lid') && visible.has('flat-lid'), 'switching swaps visibility');
});

test('makeVariantChoice refuses parts that are already add-ons or variants', () => {
  const withAddon = makePartOptional(fresh(), 'lid', 5);
  assert.throws(() => makeVariantChoice(withAddon, ['lid', 'flat-lid'], 'Lid'), /already/);
  const varianted = makeVariantChoice(fresh(), ['lid', 'flat-lid'], 'Lid');
  assert.throws(() => makeVariantChoice(varianted, ['flat-lid', 'badge'], 'Again'), /already/);
});

test('dissolveVariantChoice makes everything visible again', () => {
  const m = dissolveVariantChoice(makeVariantChoice(fresh(), ['lid', 'flat-lid'], 'Lid style'), 'lid-style');
  valid(m);
  assert.ok(!m.options.some((o) => o.id === 'lid-style'));
  const visible = visibleParts(m, defaultSelections(m));
  assert.ok(visible.has('lid') && visible.has('flat-lid'));
  assert.throws(() => dissolveVariantChoice(m, 'body-colour'), EditError);
});

// ── explorer entries & ordering ─────────────────────────────────────────────

test('entriesOf folds groups and variants into single entries, in part order', () => {
  let m = makeGroup(fresh(), ['body', 'badge'], 'Shell');
  m = makeVariantChoice(m, ['lid', 'flat-lid'], 'Lid style');
  const entries = entriesOf(m);
  assert.deepEqual(entries.map((e) => `${e.kind}:${e.id}`), ['group:shell', 'variant:lid-style']);
  assert.deepEqual(entries[0].parts, ['body', 'badge']);
  assert.deepEqual(entries[1].parts, ['lid', 'flat-lid']);
});

test('moveEntry moves whole entries and drags option order with them', () => {
  let m = makeVariantChoice(fresh(), ['lid', 'flat-lid'], 'Lid style');
  // body, [lid variant], badge → move the variant entry down past badge
  m = moveEntry(m, 'lid-style', 1);
  valid(m);
  assert.deepEqual(m.parts.map((p) => p.id), ['body', 'badge', 'lid', 'flat-lid']);
  // options follow: badge's colour option now precedes the lid options
  const order = m.options.map((o) => o.id);
  assert.ok(order.indexOf('badge-colour') < order.indexOf('lid-colour'), order.join(','));
  assert.ok(order.indexOf('badge-colour') < order.indexOf('lid-style'), order.join(','));
});

test('moveEntry at the edge is a no-op; unknown entries are refused', () => {
  const m = fresh();
  assert.equal(moveEntry(m, 'body', -1), m);
  assert.throws(() => moveEntry(m, 'ghost', 1), EditError);
});

test('a grouped manifest round-trips the validator and layout', () => {
  let m = makeGroup(fresh(), ['body', 'badge'], 'Shell');
  m = makeVariantChoice(m, ['lid', 'flat-lid'], 'Lid style');
  m = moveEntry(m, 'shell', 1);
  valid(m);
  assert.equal(resolveLayout(m, RAW).size, 4);
});

test('removePart repairs variant choices and groups it leaves behind', async () => {
  const { removePart } = await import('../src/lib/manifest-edit.ts');
  // Deleting one of three variants keeps the choice; one of two dissolves it.
  let m = makeVariantChoice(fresh(), ['lid', 'flat-lid', 'badge'], 'Style');
  m = removePart(m, 'flat-lid', RAW);
  valid(m);
  let option = m.options.find((o) => o.id === 'style') as ChoiceOption;
  assert.deepEqual(option.choices.map((c) => c.id), ['lid', 'badge']);
  m = removePart(m, 'lid', RAW);
  valid(m);
  assert.ok(!m.options.some((o) => o.id === 'style'));
  assert.equal(m.parts.find((p) => p.id === 'badge')!.visibleWhen, undefined);

  let g = makeGroup(fresh(), ['body', 'badge'], 'Shell');
  g = removePart(g, 'badge', RAW);
  valid(g);
  assert.equal(g.groups, undefined, 'a one-part group dissolves');
});
