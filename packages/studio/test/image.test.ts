// Image zones: placing one binds a validated upload option to a part's
// surface; tuning it re-validates every field; nudging slides the zone in
// its own surface plane; removal and part-delete/rename repair cleanly. The
// projected decal itself is a viewer concern (browser test) — this file owns
// the manifest arithmetic and the customer-selection contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../../embed/src/manifest/validate.ts';
import type { Manifest, UploadOption } from '../../embed/src/manifest/types.ts';
import {
  defaultSelections, applySelection, parseUploadState, priceDeltas,
} from '../../embed/src/runtime/state.ts';
import { initManifest, boundsOf, type PartBounds } from '../src/lib/manifest-init.ts';
import {
  addImageZone, setImageZone, nudgeImageZone, removeImageZone, removePart, renamePart, EditError,
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
  name: 'Image Product', bounds: { min: [-20, 0, -5], max: [20, 20, 5] },
});
const valid = (m: Manifest) => assert.deepEqual(validateManifest(m).errors, []);
const PLACE = { origin: [0, 10, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number] };
const zoneOf = (m: Manifest, id = 'body-image') => m.options.find((o) => o.id === id) as UploadOption;
const IMG = 'data:image/png;base64,iVBORw0KGgo=';

test('addImageZone binds a valid zone with merchant-ready defaults', () => {
  const m = addImageZone(fresh(), 'body', PLACE);
  valid(m);
  const zone = zoneOf(m);
  assert.equal(zone.type, 'upload');
  assert.equal(zone.part, 'body');
  assert.equal(zone.label, 'Body image');
  assert.deepEqual(zone.origin, [0, 10, 5]);
  assert.deepEqual(zone.normal, [0, 0, 1]);
  assert.equal(zone.widthMm, 30);
  assert.equal(zone.heightMm, 20);
  // A second zone on the same part dedupes its id.
  const two = addImageZone(m, 'body', PLACE);
  valid(two);
  assert.ok(two.options.some((o) => o.id === 'body-image-2'));
  assert.throws(() => addImageZone(m, 'ghost', PLACE), EditError);
});

test('setImageZone tunes fields through validation; bad values throw whole', () => {
  let m = addImageZone(fresh(), 'body', PLACE);
  m = setImageZone(m, 'body-image', { widthMm: 60, heightMm: 40, wrapMm: 12, rotationDeg: 45, priceDelta: 5 });
  valid(m);
  const zone = zoneOf(m);
  assert.equal(zone.widthMm, 60);
  assert.equal(zone.heightMm, 40);
  assert.equal(zone.wrapMm, 12);
  assert.equal(zone.rotationDeg, 45);
  assert.equal(zone.priceDelta, 5);
  // Zeroing an optional field clears it back to its default.
  const cleared = setImageZone(m, 'body-image', { wrapMm: 0, rotationDeg: 0, priceDelta: 0 });
  assert.equal(zoneOf(cleared).wrapMm, undefined);
  assert.equal(zoneOf(cleared).rotationDeg, undefined);
  assert.equal(zoneOf(cleared).priceDelta, undefined);
  // Out-of-range sizes never reach the manifest.
  assert.throws(() => setImageZone(m, 'body-image', { widthMm: 600 }), EditError);
  assert.throws(() => setImageZone(m, 'body-image', { heightMm: -1 }), EditError);
  assert.throws(() => setImageZone(m, 'body-text', { widthMm: 10 }), EditError, 'not an image zone');
});

test('nudgeImageZone slides the origin in the zone surface plane', () => {
  // Normal +Z: the zone's on-surface axes are world X (du) and Y (dv).
  let m = addImageZone(fresh(), 'body', PLACE);
  m = nudgeImageZone(m, 'body-image', 3, -2);
  valid(m);
  assert.deepEqual(zoneOf(m).origin, [3, 8, 5]);

  // Normal +Y (a top face): du still runs along X, dv runs along -Z — the
  // same reference-up convention the viewer projects with.
  let top = addImageZone(fresh(), 'body', { origin: [0, 20, 0], normal: [0, 1, 0] });
  top = nudgeImageZone(top, 'body-image', 4, 5);
  assert.deepEqual(zoneOf(top).origin, [4, 20, -5]);

  assert.throws(() => nudgeImageZone(m, 'body-image', NaN, 0), EditError);
});

test('removeImageZone deletes the option; removePart takes its zones with it', () => {
  const m = addImageZone(fresh(), 'body', PLACE);
  const gone = removeImageZone(m, 'body-image');
  valid(gone);
  assert.ok(!gone.options.some((o) => o.id === 'body-image'));
  assert.throws(() => removeImageZone(gone, 'body-image'), EditError);

  const noPart = removePart(m, 'body', RAW);
  valid(noPart);
  assert.ok(!noPart.options.some((o) => o.type === 'upload'), 'zone must not outlive its part');
});

test('renamePart ripples into the zone label', () => {
  const m = renamePart(addImageZone(fresh(), 'body', PLACE), 'body', 'Shell');
  assert.equal(zoneOf(m).label, 'Shell image');
});

test('customer selections clamp to the zone and price when used', () => {
  let m = addImageZone(fresh(), 'body', PLACE);
  m = setImageZone(m, 'body-image', { priceDelta: 5 });
  const s = defaultSelections(m);
  assert.equal(s['body-image'], '', 'no image by default');
  assert.deepEqual(priceDeltas(m, s).filter((d) => d.optionId === 'body-image'), []);

  // The offset may roam but never leave the 30×20 zone.
  applySelection(m, s, 'body-image', JSON.stringify({ img: IMG, u: 999, v: -999, s: 250 }));
  const state = parseUploadState(s['body-image'])!;
  assert.equal(state.u, 15);
  assert.equal(state.v, -10);
  assert.equal(state.s, 100);

  const deltas = priceDeltas(m, s).filter((d) => d.optionId === 'body-image');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].amount, 5);

  // Garbage never sticks: not JSON, or not an image data URL, clears it.
  applySelection(m, s, 'body-image', 'not json');
  assert.equal(s['body-image'], '');
  applySelection(m, s, 'body-image', JSON.stringify({ img: 'javascript:alert(1)', u: 0, v: 0, s: 100 }));
  assert.equal(s['body-image'], '');
});

test('validator rejects broken zones', () => {
  const m = addImageZone(fresh(), 'body', PLACE);
  const broken = structuredClone(m);
  const zone = zoneOf(broken);
  zone.normal = [0, 0, 0];
  assert.ok(validateManifest(broken).errors.some((e) => e.message.includes('zero vector')));
  zone.normal = [0, 0, 1];
  (zone as { origin: unknown }).origin = [1, 2];
  assert.ok(validateManifest(broken).errors.some((e) => e.path.endsWith('.origin')));
});
