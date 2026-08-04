// The boundary curve: closed Catmull-Rom through the merchant's anchors,
// expressed as cubic Béziers. The Studio's handles and the runtime's clip
// mask both consume this module, so its geometry IS the product's shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closedCurveSegments, curvePoint, tracePath, defaultBoundary, type Pt } from '../src/runtime/curve.ts';

const SQUARE: Pt[] = [[-10, -10], [10, -10], [10, 10], [-10, 10]];

test('the closed loop has one segment per anchor, each landing on the next', () => {
  const segs = closedCurveSegments(SQUARE);
  assert.equal(segs.length, 4);
  segs.forEach((seg, i) => {
    assert.deepEqual(seg.p0, SQUARE[i]);
    assert.deepEqual(seg.p1, SQUARE[(i + 1) % 4]);
    assert.deepEqual(curvePoint(seg, 0), SQUARE[i]);
    assert.deepEqual(curvePoint(seg, 1), SQUARE[(i + 1) % 4]);
  });
  // Fewer than three anchors is no loop at all.
  assert.deepEqual(closedCurveSegments([[0, 0], [1, 1]]), []);
});

test('the curve is smooth: joined tangents mirror across each anchor', () => {
  const segs = closedCurveSegments(SQUARE);
  for (let i = 0; i < segs.length; i++) {
    const incoming = segs[(i + 3) % 4];
    const outgoing = segs[i];
    // C1 continuity for uniform Catmull-Rom: p0 − c2_prev == c1 − p0.
    const inTangent = [outgoing.p0[0] - incoming.c2[0], outgoing.p0[1] - incoming.c2[1]];
    const outTangent = [outgoing.c1[0] - outgoing.p0[0], outgoing.c1[1] - outgoing.p0[1]];
    assert.ok(Math.abs(inTangent[0] - outTangent[0]) < 1e-9 && Math.abs(inTangent[1] - outTangent[1]) < 1e-9,
      `kink at anchor ${i}`);
  }
});

test('tracePath maps millimetres through the caller\'s transform', () => {
  const calls: string[] = [];
  const ctx = {
    moveTo: (x: number, y: number) => calls.push(`M${x},${y}`),
    bezierCurveTo: (...args: number[]) => calls.push(`C${args.join(',')}`),
    closePath: () => calls.push('Z'),
  };
  tracePath(ctx, SQUARE, ([u, v]) => [u * 2, v * 2]);
  assert.equal(calls[0], 'M-20,-20');
  assert.equal(calls.length, 6, 'move + four curves + close');
  assert.equal(calls.at(-1), 'Z');
  // An un-drawable boundary draws nothing.
  const empty: string[] = [];
  tracePath({ moveTo: () => empty.push('m'), bezierCurveTo: () => empty.push('c'), closePath: () => empty.push('z') },
    [[0, 0]]);
  assert.deepEqual(empty, []);
});

test('a fresh boundary hugs the zone rectangle from inside it', () => {
  const points = defaultBoundary(30, 20);
  assert.equal(points.length, 8);
  for (const [u, v] of points) {
    assert.ok(Math.abs(u) <= 15 && Math.abs(v) <= 10, `(${u}, ${v}) escapes the 30×20 zone`);
  }
  // The curve through the seed anchors stays inside the zone too.
  for (const seg of closedCurveSegments(points)) {
    for (let t = 0; t <= 1; t += 0.1) {
      const [u, v] = curvePoint(seg, t);
      assert.ok(Math.abs(u) <= 15 && Math.abs(v) <= 10, `curve point (${u}, ${v}) escapes`);
    }
  }
});
