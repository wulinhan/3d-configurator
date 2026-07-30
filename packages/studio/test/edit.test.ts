// Manifest-edit tests. The one property that matters everywhere: an edit
// either returns a manifest that still validates, or throws — the UI is thin
// and this layer is the only thing standing between a merchant and a broken
// product page. Every test that gets a manifest back re-validates it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../../embed/src/manifest/validate.ts';
import type { Manifest, ChoiceOption, ColourOption } from '../../embed/src/manifest/types.ts';
import { initManifest, boundsOf, type PartBounds } from '../src/lib/manifest-init.ts';
import {
  sizeMm, withSizeMm, withAnchor, withRotation,
  addSwatch, removeSwatch, setSwatchPrice,
  setCustomColour, setChoicePrice,
  makePartOptional, makePartRequired,
  withProductName, withCurrency, EditError,
} from '../src/lib/manifest-edit.ts';

const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

/** A two-part model in canonical space: 40×20×10 body, 10×4×10 cap. */
const tri = (positions: number[]): { positions: Float32Array; indices: Uint32Array } => ({
  positions: Float32Array.from(positions),
  indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
});
const PARTS = [
  { name: 'body', ...tri([-20, 0, -5, 20, 0, -5, 20, 20, 5, -20, 20, 5, -20, 0, 5, 20, 0, 5]) },
  { name: 'cap', ...tri([-5, 0, -5, 5, 0, -5, 5, 4, 5, -5, 4, 5, -5, 0, 5, 5, 0, 5]) },
];
const RAW = boundsOf(PARTS);
const BODY = RAW.get('body')!;
const CAP = RAW.get('cap')!;

const fresh = (): Manifest => initManifest(PARTS, {
  name: 'Test Product',
  bounds: { min: [-20, 0, -5], max: [20, 20, 5] },
});

const valid = (m: Manifest) => {
  const { ok, errors } = validateManifest(m);
  assert.deepEqual(errors, []);
  assert.ok(ok);
};

// ── init ────────────────────────────────────────────────────────────────────

test('initManifest produces a valid manifest with one colour option per part', () => {
  const m = fresh();
  valid(m);
  assert.equal(m.parts.length, 2);
  assert.equal(m.options.filter((o) => o.type === 'colour').length, 2);
  assert.equal(m.id, 'test-product');
  assert.equal(m.parts[0].mesh, 'model#body');
});

test('initManifest survives hostile part names', () => {
  const parts = [
    { name: '', ...tri([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
    { name: 'Ünïcode / Näme!!', ...tri([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
    { name: 'body', ...tri([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
    { name: 'body', ...tri([0, 0, 0, 1, 0, 0, 0, 1, 0]) }, // duplicate name
  ];
  const m = initManifest(parts, { name: 'X', bounds: { min: [0, 0, 0], max: [1, 1, 1] } });
  valid(m);
  assert.equal(new Set(m.parts.map((p) => p.id)).size, 4);
});

test('initManifest frames the camera from the model size', () => {
  const m = fresh();
  // span is 40 → distance 2.2× that, looking at the model's vertical centre
  near(m.camera!.position![2], 88);
  near(m.camera!.target![1], 10);
});

// ── sizing ──────────────────────────────────────────────────────────────────

test('sizeMm reports raw bbox × scale', () => {
  const m = fresh();
  assert.deepEqual(sizeMm(m, 'body', BODY), [40, 20, 10]);
  const wider = withSizeMm(m, 'body', 0, 80, BODY, false);
  assert.deepEqual(sizeMm(wider, 'body', BODY), [80, 20, 10]);
});

test('unlocked sizing moves one axis only', () => {
  const m = withSizeMm(fresh(), 'body', 1, 30, BODY, false);
  valid(m);
  assert.deepEqual(sizeMm(m, 'body', BODY), [40, 30, 10]);
});

test('locked sizing scales all axes by the same ratio', () => {
  const m = withSizeMm(fresh(), 'body', 0, 80, BODY, true);
  valid(m);
  assert.deepEqual(sizeMm(m, 'body', BODY), [80, 40, 20]);
});

test('locking after a stretch preserves the stretched proportions', () => {
  // Merchant stretches X unlocked, then re-locks and doubles the height:
  // the X stretch must scale with it, not snap back to uniform.
  let m = withSizeMm(fresh(), 'body', 0, 80, BODY, false);  // 80×20×10
  m = withSizeMm(m, 'body', 1, 40, BODY, true);             // ×2 on every axis
  valid(m);
  assert.deepEqual(sizeMm(m, 'body', BODY), [160, 40, 20]);
});

test('sizing rejects zero, negative and non-finite millimetres', () => {
  for (const bad of [0, -5, NaN, Infinity]) {
    assert.throws(() => withSizeMm(fresh(), 'body', 0, bad, BODY, false), EditError);
  }
});

test('sizing a flat axis is refused', () => {
  const flat: PartBounds = { min: [0, 0, 0], max: [10, 0, 10] };
  assert.throws(() => withSizeMm(fresh(), 'body', 1, 5, flat, false), /flat/);
});

test('sizing an unknown part is refused', () => {
  assert.throws(() => withSizeMm(fresh(), 'ghost', 0, 10, BODY, false), EditError);
});

// ── anchoring ───────────────────────────────────────────────────────────────

test('withAnchor writes the axis placement', () => {
  const m = withAnchor(fresh(), 'cap', 1, { align: 'min', to: 'body', edge: 'max', offset: 2 });
  valid(m);
  assert.deepEqual(m.parts.find((p) => p.id === 'cap')!.placement!.y,
    { align: 'min', to: 'body:max', offset: 2 });
});

test('withAnchor back to origin', () => {
  let m = withAnchor(fresh(), 'cap', 1, { align: 'min', to: 'body', edge: 'max', offset: 2 });
  m = withAnchor(m, 'cap', 1, { origin: true });
  valid(m);
  assert.deepEqual(m.parts.find((p) => p.id === 'cap')!.placement!.y, { to: 'origin', offset: 0 });
});

test('withAnchor refuses a self-anchor and an anchor cycle', () => {
  assert.throws(() => withAnchor(fresh(), 'cap', 1, { align: 'min', to: 'cap', edge: 'max', offset: 0 }), EditError);
  const anchored = withAnchor(fresh(), 'cap', 1, { align: 'min', to: 'body', edge: 'max', offset: 0 });
  assert.throws(() => withAnchor(anchored, 'body', 1, { align: 'min', to: 'cap', edge: 'max', offset: 0 }),
    /cycle/);
});

test('withRotation stores degrees and validates', () => {
  const m = withRotation(fresh(), 'cap', [0, 90, 0]);
  valid(m);
  assert.deepEqual(m.parts.find((p) => p.id === 'cap')!.placement!.rotation, [0, 90, 0]);
  assert.throws(() => withRotation(fresh(), 'cap', [0, NaN, 0]), EditError);
});

// ── palettes ────────────────────────────────────────────────────────────────

test('addSwatch slugs the name and uppercases the hex', () => {
  const m = addSwatch(fresh(), 'default', 'Ocean Blue', '#1e90ff');
  valid(m);
  const s = m.palettes![0].swatches.at(-1)!;
  assert.equal(s.id, 'ocean-blue');
  assert.equal(s.hex, '#1E90FF');
});

test('addSwatch dedupes colliding ids and rejects bad input', () => {
  let m = addSwatch(fresh(), 'default', 'Ocean Blue', '#1E90FF');
  m = addSwatch(m, 'default', 'ocean blue', '#2E90FF');
  valid(m);
  assert.equal(m.palettes![0].swatches.at(-1)!.id, 'ocean-blue-2');
  assert.throws(() => addSwatch(fresh(), 'default', 'X', 'red'), EditError);
  assert.throws(() => addSwatch(fresh(), 'default', '  ', '#FF0000'), EditError);
});

test('removeSwatch retargets options that defaulted to it, and says which', () => {
  const m = fresh();
  const opt = m.options[0] as ColourOption; // defaults to 'white'
  assert.equal(opt.default, 'white');
  const { manifest: next, retargeted } = removeSwatch(m, 'default', 'white');
  valid(next);
  assert.ok(retargeted.includes(opt.id));
  assert.ok(!next.palettes![0].swatches.some((s) => s.id === 'white'));
  assert.notEqual((next.options[0] as ColourOption).default, 'white');
});

test('removeSwatch leaves unreferencing options alone and keeps the last swatch', () => {
  const m = fresh();
  const { retargeted } = removeSwatch(m, 'default', 'red'); // nothing defaults to red
  assert.deepEqual(retargeted, []);
  let cut = m;
  for (const s of [...cut.palettes![0].swatches].slice(0, -1)) {
    cut = removeSwatch(cut, 'default', s.id).manifest;
  }
  assert.equal(cut.palettes![0].swatches.length, 1);
  assert.throws(() => removeSwatch(cut, 'default', cut.palettes![0].swatches[0].id), /last swatch/);
});

test('setSwatchPrice sets, clears, and refuses negatives', () => {
  let m = setSwatchPrice(fresh(), 'default', 'red', 6);
  valid(m);
  assert.equal(m.palettes![0].swatches.find((s) => s.id === 'red')!.priceDelta, 6);
  m = setSwatchPrice(m, 'default', 'red', undefined);
  assert.equal(m.palettes![0].swatches.find((s) => s.id === 'red')!.priceDelta, undefined);
  assert.throws(() => setSwatchPrice(fresh(), 'default', 'red', -1), EditError);
});

// ── custom colours & pricing ────────────────────────────────────────────────

test('setCustomColour turns the rule on with a surcharge', () => {
  const m = fresh();
  const next = setCustomColour(m, m.options[0].id, { allowed: true, priceDelta: 35 });
  valid(next);
  assert.deepEqual((next.options[0] as ColourOption).custom, { allowed: true, priceDelta: 35 });
});

test('setCustomColour off wipes the old surcharge', () => {
  const m = setCustomColour(fresh(), fresh().options[0].id, { allowed: true, priceDelta: 35 });
  const off = setCustomColour(m, m.options[0].id, { allowed: false });
  assert.deepEqual((off.options[0] as ColourOption).custom, { allowed: false });
});

test('setCustomColour refuses negatives and non-colour options', () => {
  const m = makePartOptional(fresh(), 'cap', 12);
  assert.throws(() => setCustomColour(m, 'cap-addon', { allowed: true }), /not a colour/);
  assert.throws(() => setCustomColour(fresh(), fresh().options[0].id, { allowed: true, priceDelta: -3 }), EditError);
});

// ── optional parts ──────────────────────────────────────────────────────────

test('makePartOptional hides the part behind a priced yes/no choice', () => {
  const m = makePartOptional(fresh(), 'cap', 15);
  valid(m);
  const part = m.parts.find((p) => p.id === 'cap')!;
  assert.deepEqual(part.visibleWhen, { option: 'cap-addon', equals: ['yes'] });
  const option = m.options.find((o) => o.id === 'cap-addon') as ChoiceOption;
  assert.equal(option.default, 'no');
  assert.equal(option.choices.find((c) => c.id === 'yes')!.priceDelta, 15);
});

test('makePartOptional twice is an error; makePartRequired undoes it cleanly', () => {
  const m = makePartOptional(fresh(), 'cap', 15);
  assert.throws(() => makePartOptional(m, 'cap', 15), /already optional/);
  const back = makePartRequired(m, 'cap');
  valid(back);
  assert.equal(back.parts.find((p) => p.id === 'cap')!.visibleWhen, undefined);
  assert.ok(!back.options.some((o) => o.id === 'cap-addon'));
  assert.throws(() => makePartRequired(back, 'cap'), /not optional/);
});

test('a free add-on is allowed — zero price is a choice, not an error', () => {
  const m = makePartOptional(fresh(), 'cap', 0);
  valid(m);
  const option = m.options.find((o) => o.id === 'cap-addon') as ChoiceOption;
  assert.equal(option.choices.find((c) => c.id === 'yes')!.priceDelta, undefined);
});

test('setChoicePrice edits an add-on price later', () => {
  let m = makePartOptional(fresh(), 'cap', 15);
  m = setChoicePrice(m, 'cap-addon', 'yes', 20);
  valid(m);
  assert.equal((m.options.find((o) => o.id === 'cap-addon') as ChoiceOption).choices[1].priceDelta, 20);
  assert.throws(() => setChoicePrice(m, 'cap-addon', 'maybe', 5), EditError);
});

// ── misc + immutability ─────────────────────────────────────────────────────

test('withProductName renames id and name together', () => {
  const m = withProductName(fresh(), 'Néw Nãme 2.0');
  valid(m);
  assert.equal(m.name, 'Néw Nãme 2.0');
  assert.equal(m.id, 'n-w-n-me-2-0');
  assert.throws(() => withProductName(fresh(), '   '), EditError);
});

test('withCurrency validates the code', () => {
  assert.equal(withCurrency(fresh(), 'USD').pricing.currency, 'USD');
  assert.throws(() => withCurrency(fresh(), 'dollars'), EditError);
});

test('every operation leaves the input manifest untouched', () => {
  const m = fresh();
  const before = JSON.stringify(m);
  withSizeMm(m, 'body', 0, 80, BODY, true);
  withAnchor(m, 'cap', 1, { align: 'min', to: 'body', edge: 'max', offset: 2 });
  addSwatch(m, 'default', 'New', '#123456');
  removeSwatch(m, 'default', 'red');
  setCustomColour(m, m.options[0].id, { allowed: true, priceDelta: 35 });
  makePartOptional(m, 'cap', 15);
  withProductName(m, 'Other');
  assert.equal(JSON.stringify(m), before);
});

test('a chain of every edit still validates at the end', () => {
  let m = fresh();
  m = withProductName(m, 'Chained Product');
  m = withSizeMm(m, 'body', 0, 80, BODY, true);
  m = withSizeMm(m, 'cap', 1, 8, CAP, false);
  m = withAnchor(m, 'cap', 1, { align: 'min', to: 'body', edge: 'max', offset: 2 });
  m = withAnchor(m, 'cap', 0, { align: 'center', to: 'body', edge: 'center', offset: 0 });
  m = withRotation(m, 'cap', [0, 45, 0]);
  m = addSwatch(m, 'default', 'Brand Teal', '#0FBABA', 6);
  m = removeSwatch(m, 'default', 'grey').manifest;
  m = setCustomColour(m, m.options.find((o) => o.type === 'colour')!.id, { allowed: true, priceDelta: 35 });
  m = makePartOptional(m, 'cap', 15);
  m = setChoicePrice(m, 'cap-addon', 'yes', 18);
  m = withCurrency(m, 'USD');
  valid(m);
  assert.deepEqual(sizeMm(m, 'body', BODY), [80, 40, 20]);
});

// ── camera framing ──────────────────────────────────────────────────────────

test('frameCamera refits the camera after the model outgrows it', async () => {
  const { frameCamera } = await import('../src/lib/manifest-edit.ts');
  let m = fresh();
  const before = m.camera!;
  // Blow the body up 10× — the init camera is now inside the model.
  m = withSizeMm(m, 'body', 0, 400, BODY, true);
  const framed = frameCamera(m, RAW as Map<string, PartBounds>);
  valid(framed);
  assert.ok(framed.camera!.position![2] > before.position![2] * 4,
    `camera should back way off: ${before.position![2]} → ${framed.camera!.position![2]}`);
  // Scale is applied about the part's own centre (see Placement.scale), so
  // the ×10 body spans y −90..110 and its centre stays at 10.
  near(framed.camera!.target![1], 10, 1);
  assert.ok(framed.camera!.maxDistance! > framed.camera!.minDistance!);
});

test('frameCamera follows anchored parts, not just scale', async () => {
  const { frameCamera } = await import('../src/lib/manifest-edit.ts');
  // Hang the cap 100 mm above the body: the frame must include it.
  let m = withAnchor(fresh(), 'cap', 1, { align: 'min', to: 'body', edge: 'max', offset: 100 });
  const framed = frameCamera(m, RAW as Map<string, PartBounds>);
  valid(framed);
  // model now spans y 0..124 → target near 62
  near(framed.camera!.target![1], 62, 1);
});
