// 3D text slots: placing one binds a validated text option to a part's
// surface; tuning it re-validates every field; removal and part-delete/rename
// repair cleanly. The extrusion itself is a viewer concern (browser test) —
// this file owns the manifest arithmetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../../embed/src/manifest/validate.ts';
import type { Manifest, TextOption } from '../../embed/src/manifest/types.ts';
import { defaultSelections, applySelection, priceDeltas, sanitiseText, isOptionActive } from '../../embed/src/runtime/state.ts';
import { initManifest, boundsOf, type PartBounds } from '../src/lib/manifest-init.ts';
import {
  addTextSlot, setTextSlot, removeTextSlot, removePart, renamePart, EditError,
} from '../src/lib/manifest-edit.ts';

const tri = (positions: number[]) => ({
  positions: Float32Array.from(positions),
  indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
});
const PARTS = [
  { name: 'body', ...tri([-20, 0, -5, 20, 0, -5, 20, 20, 5, -20, 20, 5, -20, 0, 5, 20, 0, 5]) },
  { name: 'badge', ...tri([-2, 0, -2, 2, 0, -2, 2, 1, 2, -2, 1, 2, -2, 0, 2, 2, 0, 2]) },
];
const RAW = boundsOf(PARTS) as Map<string, PartBounds>;
const fresh = (): Manifest => initManifest(PARTS, {
  name: 'Text Product', bounds: { min: [-20, 0, -5], max: [20, 20, 5] },
});
const valid = (m: Manifest) => assert.deepEqual(validateManifest(m).errors, []);
const PLACE = { origin: [0, 10, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number] };
const slotOf = (m: Manifest, id = 'body-text') => m.options.find((o) => o.id === id) as TextOption;

test('addTextSlot binds a valid slot with merchant-ready defaults', () => {
  const m = addTextSlot(fresh(), 'body', PLACE);
  valid(m);
  const slot = slotOf(m);
  assert.equal(slot.type, 'text');
  assert.equal(slot.part, 'body');
  assert.equal(slot.label, 'Body text');
  assert.deepEqual(slot.origin, [0, 10, 5]);
  assert.deepEqual(slot.normal, [0, 0, 1]);
  assert.equal(slot.font, 'sans-bold');
  assert.equal(slot.sizeMm, 8);
  assert.equal(slot.depthMm, 2);
  assert.equal(slot.maxLength, 20);
  // A second slot on the same part dedupes its id.
  const two = addTextSlot(m, 'body', PLACE);
  valid(two);
  assert.ok(two.options.some((o) => o.id === 'body-text-2'));
  assert.throws(() => addTextSlot(m, 'ghost', PLACE), EditError);
});

test('setTextSlot tunes fields through validation; bad values throw whole', () => {
  let m = addTextSlot(fresh(), 'body', PLACE);
  m = setTextSlot(m, 'body-text', { font: 'serif', sizeMm: 12, depthMm: 3, sinkMm: 1, maxLength: 6, placeholder: 'Hi', pricePerChar: 2 });
  valid(m);
  const slot = slotOf(m);
  assert.equal(slot.font, 'serif');
  assert.equal(slot.sinkMm, 1);
  assert.equal(slot.pricePerChar, 2);
  // Sinking the whole extrusion would leave nothing visible.
  assert.throws(() => setTextSlot(m, 'body-text', { sinkMm: 3 }), /sink/i);
  assert.throws(() => setTextSlot(m, 'body-text', { font: 'comic-sans' as never }), /font/);
  assert.throws(() => setTextSlot(m, 'body-text', { sizeMm: 0 }), /sizeMm/);
  assert.throws(() => setTextSlot(m, 'body-text', { maxLength: 0.5 }), /maxLength/);
  assert.throws(() => setTextSlot(m, 'body-colour', { sizeMm: 5 }), /not a text slot/);
  // Zeroing an optional field clears it instead of storing 0.
  const cleared = setTextSlot(m, 'body-text', { sinkMm: 0 });
  assert.equal(slotOf(cleared).sinkMm, undefined);
});

test('removeTextSlot, removePart and renamePart keep the manifest whole', () => {
  let m = addTextSlot(fresh(), 'body', PLACE);
  assert.ok(!removeTextSlot(m, 'body-text').options.some((o) => o.id === 'body-text'));

  // Deleting the carrier part takes its slot with it.
  const without = removePart(m, 'body', RAW);
  valid(without);
  assert.ok(!without.options.some((o) => o.type === 'text'));

  // Renaming the carrier renames the slot the customers see.
  m = renamePart(m, 'body', 'Shell');
  assert.equal(slotOf(m).label, 'Shell text');
});

test('selections: text sanitises to printable ASCII and clamps to maxLength', () => {
  let m = addTextSlot(fresh(), 'body', PLACE);
  m = setTextSlot(m, 'body-text', { maxLength: 10 });
  const s = defaultSelections(m);
  assert.equal(s['body-text'], '');
  applySelection(m, s, 'body-text', 'Héllo World™ 123');
  assert.equal(s['body-text'], 'Hllo World');
  assert.equal(sanitiseText('ABCdef', 60), 'ABCdef');
});

test('pricing: flat surcharge plus per-character, only while text is typed', () => {
  let m = addTextSlot(fresh(), 'body', PLACE);
  m = setTextSlot(m, 'body-text', { priceDelta: 5, pricePerChar: 2 });
  const s = defaultSelections(m);
  assert.equal(priceDeltas(m, s).filter((d) => d.optionId === 'body-text').length, 0);
  applySelection(m, s, 'body-text', 'Wulin');
  const delta = priceDeltas(m, s).find((d) => d.optionId === 'body-text')!;
  assert.equal(delta.amount, 5 + 2 * 5);
  assert.match(delta.label, /Wulin/);
});

test('a slot on a hidden part is inert — no tab, no charge', () => {
  let m = addTextSlot(fresh(), 'badge', PLACE);
  m = setTextSlot(m, 'badge-text', { priceDelta: 9 });
  // Gate the badge behind an add-on choice defaulting to "no".
  const gated = structuredClone(m);
  gated.options.push({
    id: 'badge-addon', type: 'choice', label: 'Badge', role: 'addon',
    choices: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }], default: 'no',
  });
  gated.parts.find((p) => p.id === 'badge')!.visibleWhen = { option: 'badge-addon', equals: ['yes'] };
  valid(gated);
  const s = defaultSelections(gated);
  applySelection(gated, s, 'badge-text', 'Hi');
  const slot = slotOf(gated, 'badge-text');
  assert.equal(isOptionActive(gated, s, slot), false);
  assert.equal(priceDeltas(gated, s).filter((d) => d.optionId === 'badge-text').length, 0);
  applySelection(gated, s, 'badge-addon', 'yes');
  assert.equal(isOptionActive(gated, s, slot), true);
  assert.equal(priceDeltas(gated, s).find((d) => d.optionId === 'badge-text')!.amount, 9);
});

test('perChar: toggles on with defaults, tunes axis and gap, toggles off clean', () => {
  let m = addTextSlot(fresh(), 'body', PLACE);
  m = setTextSlot(m, 'body-text', { perChar: {} });
  valid(m);
  assert.deepEqual(slotOf(m).perChar, {});
  m = setTextSlot(m, 'body-text', { perChar: { axis: 2, gapMm: 4 } });
  valid(m);
  assert.deepEqual(slotOf(m).perChar, { axis: 2, gapMm: 4 });
  assert.throws(() => setTextSlot(m, 'body-text', { perChar: { axis: 9 as never } }), /axis/);
  assert.throws(() => setTextSlot(m, 'body-text', { perChar: { gapMm: -1 } }), /gapMm/);
  const off = setTextSlot(m, 'body-text', { perChar: null });
  valid(off);
  assert.equal(slotOf(off).perChar, undefined);
});

test('perChar circle: mode and step validate; text colour pins and releases', () => {
  let m = addTextSlot(fresh(), 'body', PLACE);
  m = setTextSlot(m, 'body-text', { perChar: { mode: 'circle', stepDeg: 30 } });
  valid(m);
  assert.deepEqual(slotOf(m).perChar, { mode: 'circle', stepDeg: 30 });
  assert.throws(() => setTextSlot(m, 'body-text', { perChar: { mode: 'spiral' as never } }), /mode/);
  assert.throws(() => setTextSlot(m, 'body-text', { perChar: { mode: 'circle', stepDeg: 0 } }), /stepDeg/);
  assert.throws(() => setTextSlot(m, 'body-text', { perChar: { mode: 'circle', stepDeg: 999 } }), /stepDeg/);

  m = setTextSlot(m, 'body-text', { colourHex: '#C82020' });
  valid(m);
  assert.equal(slotOf(m).colourHex, '#C82020');
  assert.throws(() => setTextSlot(m, 'body-text', { colourHex: 'red' as never }), /RRGGBB/);
  const released = setTextSlot(m, 'body-text', { colourHex: null });
  valid(released);
  assert.equal(slotOf(released).colourHex, undefined);
});

test('validator: the slot geometry rules hold', () => {
  const m = addTextSlot(fresh(), 'body', PLACE);
  const broken = (patch: object) => {
    const draft = structuredClone(m);
    Object.assign(draft.options.find((o) => o.id === 'body-text')!, patch);
    return validateManifest(draft);
  };
  assert.ok(!broken({ normal: [0, 0, 0] }).ok, 'zero normal');
  assert.ok(!broken({ origin: [0, 1] }).ok, 'short origin');
  assert.ok(!broken({ origin: [0, 1, Infinity] }).ok, 'non-finite origin');
  assert.ok(!broken({ depthMm: 0 }).ok, 'zero depth');
  assert.ok(!broken({ sinkMm: 2 }).ok, 'sink equals depth');
  assert.ok(!broken({ part: 'ghost' }).ok, 'unknown part');
  assert.ok(broken({ placeholder: 'a'.repeat(30) }).warnings.some((w) => /maxLength/.test(w.message)),
    'over-long placeholder warns');
});
