// Anchored placement, checked against numbers rather than pixels.
//
// The reference case throughout is the "Tap to Connect" overlay, whose live
// placement is computed in JavaScript at load time; the manifest has to
// reproduce it declaratively or the migration silently moves the text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLayout, transformBox, modelBounds, type Box } from '../src/runtime/layout.ts';
import type { Manifest } from '../src/manifest/types.ts';

const box = (min: [number, number, number], max: [number, number, number]): Box => ({ min, max });
const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

const manifest = (parts: Manifest['parts']): Manifest => ({
  schema: 1, id: 'test', name: 'Test', units: 'mm',
  models: [{ id: 'm', url: 'm.glb' }],
  parts,
  options: [],
  pricing: { currency: 'SGD' },
});

// Real numbers, straight out of the built GLB.
const BODY = box([-70.25, 0, -29], [70.25, 115, 28]);
const TEXT = box([-62.53, 1.83, 28], [19.26, 9.72, 29]);

test('a part with no placement stays where it was modelled', () => {
  const l = resolveLayout(manifest([{ id: 'body', label: 'Body', mesh: 'm#body' }]), new Map([['body', BODY]]));
  assert.deepEqual(l.get('body')!.translate, [0, 0, 0]);
  assert.deepEqual(l.get('body')!.box, BODY);
});

test('reproduces the Tap to Connect overlay placement', () => {
  const l = resolveLayout(manifest([
    { id: 'body', label: 'Body', mesh: 'm#body' },
    {
      id: 'text', label: 'Text', mesh: 'm#text',
      placement: {
        x: { align: 'center', to: 'body:center', offset: 0 },
        y: { align: 'min', to: 'body:min', offset: 2 },
        z: { align: 'max', to: 'body:max', offset: 1 },
      },
    },
  ]), new Map([['body', BODY], ['text', TEXT]]));

  const t = l.get('text')!;
  // centred on the bar's length, 2 mm above the ground, 1 mm proud of the front
  near((t.box.min[0] + t.box.max[0]) / 2, 0);
  near(t.box.min[1], 2);
  near(t.box.max[2], 29);
  // and unchanged in size — anchoring moves, it never stretches
  near(t.size[0], 81.79, 1e-2);
  near(t.size[1], 7.89, 1e-2);
});

test('an anchor tracks its reference when that reference moves', () => {
  const base = [
    { id: 'body', label: 'Body', mesh: 'm#body', placement: { y: { to: 'origin' as const, offset: 10 } } },
    {
      id: 'text', label: 'Text', mesh: 'm#text',
      placement: { y: { align: 'min' as const, to: 'body:min' as const, offset: 2 } },
    },
  ];
  const l = resolveLayout(manifest(base), new Map([['body', BODY], ['text', TEXT]]));
  // body lifted 10 mm, so the text's 2 mm clearance is now at 12
  near(l.get('body')!.box.min[1], 10);
  near(l.get('text')!.box.min[1], 12);
});

test('scaling happens about the part centre, before anchoring', () => {
  const l = resolveLayout(manifest([
    { id: 'body', label: 'Body', mesh: 'm#body' },
    {
      id: 'text', label: 'Text', mesh: 'm#text',
      placement: {
        scale: [2, 1, 1],
        x: { align: 'center', to: 'body:center', offset: 0 },
        y: { align: 'min', to: 'body:min', offset: 2 },
      },
    },
  ]), new Map([['body', BODY], ['text', TEXT]]));

  const t = l.get('text')!;
  near(t.size[0], (TEXT.max[0] - TEXT.min[0]) * 2, 1e-4);  // doubled along x
  near(t.size[1], TEXT.max[1] - TEXT.min[1], 1e-4);        // untouched on y
  near((t.box.min[0] + t.box.max[0]) / 2, 0);              // still centred
  near(t.box.min[1], 2);                                   // still 2 mm up
});

test('anchoring to max/min/center picks the right edge', () => {
  const target = box([0, 0, 0], [100, 50, 10]);
  const item = box([0, 0, 0], [10, 10, 10]);
  const at = (edge: 'min' | 'center' | 'max', align: 'min' | 'center' | 'max') =>
    resolveLayout(manifest([
      { id: 'a', label: 'A', mesh: 'm#a' },
      { id: 'b', label: 'B', mesh: 'm#b', placement: { x: { align, to: `a:${edge}`, offset: 0 } } },
    ]), new Map([['a', target], ['b', item]])).get('b')!.box;

  near(at('min', 'min').min[0], 0);
  near(at('max', 'max').max[0], 100);
  near(at('center', 'center').min[0], 45);
  near(at('max', 'min').min[0], 100);  // sits flush outside the right edge
  near(at('min', 'max').max[0], 0);    // sits flush outside the left edge
});

test('offset is applied in millimetres in the anchor direction', () => {
  const l = resolveLayout(manifest([
    { id: 'a', label: 'A', mesh: 'm#a' },
    { id: 'b', label: 'B', mesh: 'm#b', placement: { z: { align: 'max', to: 'a:max', offset: -3 } } },
  ]), new Map([['a', box([0, 0, 0], [10, 10, 10])], ['b', box([0, 0, 0], [2, 2, 2])]]));
  near(l.get('b')!.box.max[2], 7); // 3 mm recessed
});

test('a cyclic anchor resolves without hanging', () => {
  const l = resolveLayout(manifest([
    { id: 'a', label: 'A', mesh: 'm#a', placement: { y: { align: 'min', to: 'b:max', offset: 0 } } },
    { id: 'b', label: 'B', mesh: 'm#b', placement: { y: { align: 'min', to: 'a:max', offset: 0 } } },
  ]), new Map([['a', box([0, 0, 0], [1, 1, 1])], ['b', box([0, 0, 0], [1, 1, 1])]]));
  assert.equal(l.size, 2); // degraded, but it terminated and produced transforms
});

test('a part with no geometry is skipped rather than crashing', () => {
  const l = resolveLayout(manifest([{ id: 'ghost', label: 'Ghost', mesh: 'm#ghost' }]), new Map());
  assert.equal(l.size, 0);
});

test('transformBox: a 90° turn about Y swaps the X and Z extents', () => {
  const r = transformBox(box([-5, -1, -20], [5, 1, 20]), [1, 1, 1], [0, 90, 0]);
  near(r.max[0], 20, 1e-6);
  near(r.max[2], 5, 1e-6);
  near(r.max[1], 1, 1e-6);
});

test('transformBox: a 45° turn grows the axis-aligned extent', () => {
  const r = transformBox(box([-10, -1, -10], [10, 1, 10]), [1, 1, 1], [0, 45, 0]);
  near(r.max[0], Math.sqrt(200), 1e-6);
});

test('modelBounds unions only the visible parts', () => {
  const l = resolveLayout(manifest([
    { id: 'a', label: 'A', mesh: 'm#a' },
    { id: 'b', label: 'B', mesh: 'm#b' },
  ]), new Map([['a', box([0, 0, 0], [10, 10, 10])], ['b', box([0, 0, 0], [100, 5, 5])]]));

  near(modelBounds(l).max[0], 100);
  near(modelBounds(l, (id) => id === 'a').max[0], 10);
});
