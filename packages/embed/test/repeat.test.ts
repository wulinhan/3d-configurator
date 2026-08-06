// Live part patterns: a part's `repeats` are parameters, not stamped
// copies, so the arithmetic that turns them into instance transforms has
// to hold under retuning and STACKING (each pattern repeats everything the
// ones before it produced). Pure geometry, asserted headless.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repeatInstances, repeatCount } from '../src/runtime/repeat.ts';
import type { RepeatSpec } from '../src/manifest/types.ts';

const CENTRE: [number, number, number] = [10, 5, 0];
const SIZE: [number, number, number] = [20, 8, 6];
const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

test('no repeats is just the part itself', () => {
  const out = repeatInstances(undefined, CENTRE, SIZE);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].centre, CENTRE);
  assert.equal(repeatCount(undefined), 1);
});

test('a linear pattern marches at size + gap, original first', () => {
  const line: RepeatSpec = { id: 'r', mode: 'line', count: 3, axis: 0, gapMm: 5 };
  const out = repeatInstances([line], CENTRE, SIZE);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0].centre, CENTRE, 'the original leads');
  near(out[1].centre[0], 10 + 25); // 20mm wide + 5mm gap
  near(out[2].centre[0], 10 + 50);
  for (const inst of out) { near(inst.centre[1], 5); near(inst.centre[2], 0); near(inst.spinDeg, 0); }
  assert.equal(repeatCount([line]), 3);
});

test('a negative gap overlaps on purpose', () => {
  const out = repeatInstances([{ id: 'r', mode: 'line', count: 2, axis: 0, gapMm: -20 }], CENTRE, SIZE);
  near(out[1].centre[0], 10, 1e-9); // 20 − 20 = no pitch at all
});

test('a circular pattern rings the origin and turns each copy with it', () => {
  const out = repeatInstances([{ id: 'r', mode: 'circle', count: 4 }], [10, 0, 0], SIZE);
  assert.equal(out.length, 4);
  // 90° steps around the vertical axis: (10,0,0) → (0,0,10) → (−10,0,0) → …
  near(out[1].centre[0], 0, 1e-9); near(out[1].centre[2], 10, 1e-9);
  near(out[2].centre[0], -10, 1e-9);
  near(out[3].centre[2], -10, 1e-9);
  // The body spin matches the swing, so each copy faces the tangent.
  assert.deepEqual(out.map((i) => i.spinDeg), [0, -90, -180, -270]);
  // Every copy keeps its distance from the centre.
  for (const inst of out) near(Math.hypot(inst.centre[0], inst.centre[2]), 10, 1e-9);
});

test('an explicit step overrides the even division — a fan, not a ring', () => {
  const out = repeatInstances([{ id: 'r', mode: 'circle', count: 3, stepDeg: 30 }], [10, 0, 0], SIZE);
  assert.deepEqual(out.map((i) => i.spinDeg), [0, -30, -60]);
});

test('patterns STACK into a grid — each repeats what came before', () => {
  const stack: RepeatSpec[] = [
    { id: 'a', mode: 'line', count: 3, axis: 0, gapMm: 5 },  // 3 across
    { id: 'b', mode: 'line', count: 2, axis: 2, gapMm: 4 },  // ×2 deep
  ];
  const out = repeatInstances(stack, [0, 0, 0], SIZE);
  assert.equal(out.length, 6);
  assert.equal(repeatCount(stack), 6);
  const at = out.map((i) => [i.centre[0], i.centre[2]]);
  // Row pitch 25 along x, 10 along z (6mm deep + 4mm gap).
  assert.deepEqual(at, [[0, 0], [0, 10], [25, 0], [25, 10], [50, 0], [50, 10]]);
});

test('nonsense counts are skipped, and a runaway stack is capped', () => {
  assert.equal(repeatInstances([{ id: 'r', mode: 'line', count: 1 }], CENTRE, SIZE).length, 1);
  assert.equal(repeatInstances([{ id: 'r', mode: 'line', count: NaN }], CENTRE, SIZE).length, 1);
  const huge: RepeatSpec[] = Array.from({ length: 5 }, (_, i) => (
    { id: `r${i}`, mode: 'line' as const, count: 8, axis: 0 as const, gapMm: 1 }));
  assert.ok(repeatInstances(huge, CENTRE, SIZE).length <= 4096, 'never unbounded');
});
