// 3D text slots: placing one binds a validated text option to a part's
// surface; tuning it re-validates every field; removal and part-delete/rename
// repair cleanly. The extrusion itself is a viewer concern (browser test) —
// this file owns the manifest arithmetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../../embed/src/manifest/validate.ts';
import type { Manifest, TextOption } from '../../embed/src/manifest/types.ts';
import {
  defaultSelections, applySelection, priceDeltas, sanitiseText, isOptionActive,
  textColour, textColourChoices,
} from '../../embed/src/runtime/state.ts';
import { initManifest, boundsOf, type PartBounds } from '../src/lib/manifest-init.ts';
import {
  addTextSlot, setTextSlot, setTextPath, removeTextSlot, removePart, renamePart, EditError,
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

test('bendDeg curves the run through validation; 0 straightens it back off', () => {
  let m = addTextSlot(fresh(), 'body', PLACE);
  assert.equal(slotOf(m).bendDeg, undefined, 'slots start straight');
  m = setTextSlot(m, 'body-text', { bendDeg: 90 });
  valid(m);
  assert.equal(slotOf(m).bendDeg, 90);
  // A smile is a negative bend; the full circle is the extreme of the range.
  valid(setTextSlot(m, 'body-text', { bendDeg: -360 }));
  assert.throws(() => setTextSlot(m, 'body-text', { bendDeg: 400 }), /bendDeg/);
  assert.throws(() => setTextSlot(m, 'body-text', { bendDeg: NaN }), /bendDeg/);
  // Zero is "straight" — the default, not a stored field.
  assert.equal(slotOf(setTextSlot(m, 'body-text', { bendDeg: 0 })).bendDeg, undefined);
});

test('setTextPath draws the freeform baseline; Bend and path displace each other', () => {
  let m = addTextSlot(fresh(), 'body', PLACE);
  m = setTextPath(m, 'body-text', [[-20.0004, 0], [0, 8], [20, 0]]);
  valid(m);
  assert.deepEqual(slotOf(m).path, [[-20, 0], [0, 8], [20, 0]], 'anchors round to microns');

  // The two baselines are alternatives: each clears the other.
  const bent = setTextSlot(m, 'body-text', { bendDeg: 90 });
  assert.equal(slotOf(bent).path, undefined, 'turning Bend straightens the drawn curve');
  const redrawn = setTextPath(bent, 'body-text', [[-10, 0], [10, 0]]);
  assert.equal(slotOf(redrawn).bendDeg, undefined, 'drawing a path clears Bend');

  // Bad paths never reach the manifest; null clears back to straight.
  assert.throws(() => setTextPath(m, 'body-text', [[0, 0]]), /path/);
  assert.throws(() => setTextPath(m, 'body-text', [[NaN, 0], [1, 1]]), /path/);
  assert.throws(() => setTextPath(m, 'body-colour', [[-1, 0], [1, 0]]), /not a text slot/);
  assert.equal(slotOf(setTextPath(m, 'body-text', null)).path, undefined);
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
  // Negative gaps are legal — interlocking pieces overlap on purpose.
  m = setTextSlot(m, 'body-text', { perChar: { gapMm: -2 } });
  valid(m);
  assert.equal(slotOf(m).perChar?.gapMm, -2);
  assert.throws(() => setTextSlot(m, 'body-text', { perChar: { gapMm: -900 } }), /gapMm/);
  const off = setTextSlot(m, 'body-text', { perChar: null });
  valid(off);
  assert.equal(slotOf(off).perChar, undefined);
});

test('style: engraved validates, ignores the sink rule, and reverts to embossed', () => {
  let m = addTextSlot(fresh(), 'body', PLACE);
  m = setTextSlot(m, 'body-text', { style: 'deboss' });
  valid(m);
  assert.equal(slotOf(m).style, 'deboss');
  // Emboss's sink-vs-depth rule does not apply to an engraved slot…
  m = setTextSlot(m, 'body-text', { sinkMm: 99 });
  valid(m);
  // …but snaps back into force when the style returns to embossed.
  assert.throws(() => setTextSlot(m, 'body-text', { style: 'emboss' }), /sink/i);
  const back = setTextSlot(m, 'body-text', { style: 'emboss', sinkMm: 0 });
  valid(back);
  assert.equal(slotOf(back).style, 'emboss');
  assert.throws(() => setTextSlot(m, 'body-text', { style: 'etched' as never }), /style/);
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

test('the merchant colour stands alone; the checkbox only adds a customer choice', () => {
  let m = addTextSlot(fresh(), 'body', PLACE);
  // Pinning a colour needs no permission from the customer-choice flag.
  m = setTextSlot(m, 'body-text', { colourHex: '#C82020' });
  valid(m);
  assert.equal(slotOf(m).colourHex, '#C82020');
  assert.equal(slotOf(m).customerColour, undefined);
  const locked = defaultSelections(m);
  assert.equal(locked['body-text:colour'], undefined, 'a locked slot has no colour to choose');
  assert.equal(textColour(m, locked, slotOf(m)), '#C82020', 'and renders in the merchant colour');

  // Opening the choice keeps that colour as the opening one.
  m = setTextSlot(m, 'body-text', { customerColour: true });
  valid(m);
  assert.equal(slotOf(m).colourHex, '#C82020');
  const s = defaultSelections(m);
  assert.equal(s['body-text:colour'], '#C82020');

  // Narrowing the offer to two swatches: anything else is refused.
  const palette = m.palettes![0].swatches;
  m = setTextSlot(m, 'body-text', { colourChoices: [palette[0].hex, palette[1].hex] });
  valid(m);
  assert.deepEqual(textColourChoices(m, slotOf(m)), [palette[0].hex.toUpperCase(), palette[1].hex.toUpperCase()]);
  applySelection(m, s, 'body-text:colour', palette[1].hex);
  assert.equal(s['body-text:colour'], palette[1].hex.toUpperCase());
  const offPalette = palette.find((sw) => ![palette[0].hex, palette[1].hex].includes(sw.hex));
  if (offPalette) {
    applySelection(m, s, 'body-text:colour', offPalette.hex);
    assert.equal(s['body-text:colour'], '', 'a swatch outside the offer never sticks');
  }

  // Closing the choice again keeps the colour and drops only the offer.
  m = setTextSlot(m, 'body-text', { customerColour: null });
  assert.equal(slotOf(m).colourHex, '#C82020', 'the merchant colour survives');
  assert.equal(slotOf(m).customerColour, undefined);
  assert.equal(slotOf(m).colourChoices, undefined);
});

test('a slot placed on a curve wraps from the start; a flat pick does not', () => {
  const curved = addTextSlot(fresh(), 'body', { ...PLACE, curved: true });
  valid(curved);
  assert.equal(slotOf(curved).wrapSurface, true, 'the merchant should not have to notice');

  const flat = addTextSlot(fresh(), 'body', { ...PLACE, curved: false });
  assert.equal(slotOf(flat).wrapSurface, undefined);
  assert.equal(slotOf(addTextSlot(fresh(), 'body', PLACE)).wrapSurface, undefined, 'absent = flat');
});

test('wrapping is a slot field like any other: set, tuned, cleared', () => {
  let m = addTextSlot(fresh(), 'body', PLACE);
  m = setTextSlot(m, 'body-text', { wrapSurface: true, liftMm: 2 });
  valid(m);
  assert.equal(slotOf(m).wrapSurface, true);
  assert.equal(slotOf(m).liftMm, 2);

  // Engraved slots wrap too — the cut follows the surface.
  valid(setTextSlot(m, 'body-text', { style: 'deboss' }));

  assert.throws(() => setTextSlot(m, 'body-text', { liftMm: -1 }), /liftMm/);
  assert.throws(() => setTextSlot(m, 'body-text', { liftMm: 99 }), /liftMm/);

  // Turning wrapping off drops the float with it — a lift means nothing
  // against a flat plane.
  const off = setTextSlot(m, 'body-text', { wrapSurface: null });
  assert.equal(slotOf(off).wrapSurface, undefined);
  assert.equal(slotOf(off).liftMm, undefined);
});
