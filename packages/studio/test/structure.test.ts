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
  addPartToGroup, removePartFromGroup, addPartToChoice, removePartFromChoice,
  entriesOf, moveEntry, moveEntryTo, withAnchor, makePartOptional, EditError,
  partToOrigin, groupToOrigin, nudge,
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

test('makeVariantChoice absorbs an add-on part instead of refusing', () => {
  // The failure a merchant actually hit: a part still marked "customer
  // selects this part" made choice creation silently impossible. Joining a
  // pick-one set now supersedes the add-on.
  const withAddon = makePartOptional(fresh(), 'lid', 5);
  const m = makeVariantChoice(withAddon, ['lid', 'flat-lid'], 'Lid style');
  valid(m);
  assert.ok(!m.options.some((o) => o.id === 'lid-addon'), 'add-on option is gone');
  assert.deepEqual(m.parts.find((p) => p.id === 'lid')!.visibleWhen,
    { option: 'lid-style', equals: ['lid'] });
});

test('makeVariantChoice still refuses parts already in another choice', () => {
  const varianted = makeVariantChoice(fresh(), ['lid', 'flat-lid'], 'Lid');
  assert.throws(() => makeVariantChoice(varianted, ['flat-lid', 'badge'], 'Again'), /already/);
});

test('addPartToChoice and removePartFromChoice grow and shrink the set', () => {
  let m = makeVariantChoice(fresh(), ['lid', 'flat-lid'], 'Lid style');
  m = addPartToChoice(m, 'lid-style', 'badge');
  valid(m);
  let option = m.options.find((o) => o.id === 'lid-style') as ChoiceOption;
  assert.deepEqual(option.choices.map((c) => c.id), ['lid', 'flat-lid', 'badge']);
  assert.deepEqual(m.parts.find((p) => p.id === 'badge')!.visibleWhen,
    { option: 'lid-style', equals: ['badge'] });

  // Removing the default retargets it; removing below two dissolves the set.
  m = removePartFromChoice(m, 'lid-style', 'lid');
  valid(m);
  option = m.options.find((o) => o.id === 'lid-style') as ChoiceOption;
  assert.deepEqual(option.choices.map((c) => c.id), ['flat-lid', 'badge']);
  assert.equal(option.default, 'flat-lid');
  assert.equal(m.parts.find((p) => p.id === 'lid')!.visibleWhen, undefined);
  m = removePartFromChoice(m, 'lid-style', 'badge');
  valid(m);
  assert.ok(!m.options.some((o) => o.id === 'lid-style'));
  assert.ok(m.parts.every((p) => !p.visibleWhen));
});

test('addPartToChoice absorbs add-ons, refuses grouped or other-choice parts', () => {
  let m = makeVariantChoice(makePartOptional(fresh(), 'badge', 3), ['lid', 'flat-lid'], 'Lid style');
  m = addPartToChoice(m, 'lid-style', 'badge');
  valid(m);
  assert.ok(!m.options.some((o) => o.id === 'badge-addon'));

  const grouped = makeGroup(makeVariantChoice(fresh(), ['lid', 'flat-lid'], 'Lid'), ['body', 'badge'], 'Shell');
  assert.throws(() => addPartToChoice(grouped, 'lid', 'badge'), /assembly/);
});

test('addPartToGroup merges the newcomer\'s colour option into the shared one', () => {
  let m = makeGroup(fresh(), ['body', 'badge'], 'Shell');
  m = addPartToGroup(m, 'shell', 'lid');
  valid(m);
  assert.deepEqual(m.groups![0].parts, ['body', 'badge', 'lid']);
  const merged = m.options.find((o) => o.id === 'shell-colour') as ColourOption;
  assert.ok(merged.parts.includes('lid'));
  assert.ok(!m.options.some((o) => o.id === 'lid-colour'));
  const painted = m.options.flatMap((o) => (o.type === 'colour' ? o.parts : []));
  assert.equal(new Set(painted).size, painted.length, 'no part painted twice');
  assert.equal(addPartToGroup(m, 'shell', 'lid'), m, 'already a member is a no-op');
});

test('removePartFromGroup splits the colour back out; below two the assembly dissolves', () => {
  let m = addPartToGroup(makeGroup(fresh(), ['body', 'badge'], 'Shell'), 'shell', 'lid');
  m = removePartFromGroup(m, 'shell', 'lid');
  valid(m);
  assert.deepEqual(m.groups![0].parts, ['body', 'badge']);
  const split = m.options.find((o) => o.type === 'colour' && (o as ColourOption).parts.join() === 'lid');
  assert.ok(split, 'departing part paints alone again');
  m = removePartFromGroup(m, 'shell', 'badge');
  valid(m);
  assert.equal(m.groups, undefined, 'one-member assembly dissolves');
});

test('partToOrigin centres X/Z and grounds the part, sliding offsets not anchors', () => {
  let m = withAnchor(fresh(), 'badge', 1, { align: 'min', to: 'body', edge: 'max', offset: 1 });
  m = nudge(m, 'badge', [7, 0, 3]);
  m = partToOrigin(m, 'badge', RAW);
  valid(m);
  const box = resolveLayout(m, RAW).get('badge')!.box;
  near((box.min[0] + box.max[0]) / 2, 0);
  near(box.min[1], 0);
  near((box.min[2] + box.max[2]) / 2, 0);
  // The y anchor survived — the part moved, its wiring didn't.
  assert.equal(m.parts.find((p) => p.id === 'badge')!.placement!.y!.to, 'body:max');
  assert.equal(partToOrigin(m, 'badge', RAW), m, 'already at origin is a no-op');
});

test('groupToOrigin moves the assembly as one rigid thing', () => {
  let m = withAnchor(fresh(), 'badge', 1, { align: 'min', to: 'body', edge: 'max', offset: 1 });
  m = makeGroup(m, ['body', 'badge'], 'Shell');
  m = nudgeGroup(m, 'shell', [12, 4, -6]);
  const before = resolveLayout(m, RAW);
  const gap = before.get('badge')!.box.min[1] - before.get('body')!.box.max[1];
  m = groupToOrigin(m, 'shell', RAW);
  valid(m);
  const after = resolveLayout(m, RAW);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const id of ['body', 'badge']) {
    const box = after.get(id)!.box;
    for (const a of [0, 1, 2]) {
      min[a] = Math.min(min[a], box.min[a]);
      max[a] = Math.max(max[a], box.max[a]);
    }
  }
  near((min[0] + max[0]) / 2, 0);
  near(min[1], 0);
  near((min[2] + max[2]) / 2, 0);
  // Rigid: the badge kept its distance from the body.
  near(after.get('badge')!.box.min[1] - after.get('body')!.box.max[1], gap);
});

test('moveEntryTo lands an entry at an arbitrary position and clamps', () => {
  let m = makeVariantChoice(fresh(), ['lid', 'flat-lid'], 'Lid style');
  // entries: body, [lid-style], badge → send body to the end
  m = moveEntryTo(m, 'body', 2);
  valid(m);
  assert.deepEqual(m.parts.map((p) => p.id), ['lid', 'flat-lid', 'badge', 'body']);
  assert.equal(moveEntryTo(m, 'badge', 99).parts.at(-1)!.id, 'badge', 'clamped to the end');
  assert.throws(() => moveEntryTo(m, 'ghost', 0), EditError);
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
