// The Edges section's contract: a chamfer or round-over rebuilds a part
// through the Manifold kernel, so the result must stay WATERTIGHT (same
// audit as manifold.test.ts), keep the part's overall bounds, and actually
// move the treated faces by the asked-for amount — in the Studio's Y-up
// frame, since the merchant reads "top" off the screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chamferPart, ChamferError, type ChamferOpts } from '../src/lib/chamfer.ts';
import { primitivePart, type PrimitiveSpec } from '../src/lib/primitives.ts';
import type { ImportedPart } from '../src/lib/types.ts';

const spec = (over: Partial<PrimitiveSpec>): PrimitiveSpec => ({
  kind: 'cuboid', widthMm: 20, heightMm: 10, depthMm: 20, sides: 6, tubeMm: 10, ...over,
});

const auditWatertight = (part: ImportedPart, label: string) => {
  const { positions, indices } = part;
  const key = (i: number) => `${positions[i * 3]},${positions[i * 3 + 1]},${positions[i * 3 + 2]}`;
  const vid = new Map<string, number>();
  const remap: number[] = [];
  for (let i = 0; i < positions.length / 3; i++) {
    const k = key(i);
    if (!vid.has(k)) vid.set(k, vid.size);
    remap.push(vid.get(k)!);
  }
  const edges = new Map<string, number>();
  let degenerate = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = `${u}>${v}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  let unmatched = 0, doubled = 0;
  for (const [k, n] of edges) {
    const [u, v] = k.split('>');
    if (n > 1) doubled++;
    if (edges.get(`${v}>${u}`) === undefined) unmatched++;
  }
  assert.equal(degenerate, 0, `${label}: no degenerate triangles`);
  assert.equal(doubled, 0, `${label}: no doubled edges`);
  assert.equal(unmatched, 0, `${label}: every edge has its reverse`);
};

const boundsOf = (part: ImportedPart) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const p = part.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (p[i + a] < min[a]) min[a] = p[i + a];
      if (p[i + a] > max[a]) max[a] = p[i + a];
    }
  }
  return { min, max };
};

/** Widest |x| reach among vertices in a horizontal band of the part. */
const reachAtY = (part: ImportedPart, yLo: number, yHi: number) => {
  const p = part.positions;
  let reach = 0;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i + 1] >= yLo && p[i + 1] <= yHi) reach = Math.max(reach, Math.abs(p[i]));
  }
  return reach;
};

/** Signed volume by divergence theorem — winding-sensitive on purpose. */
const volumeOf = (part: ImportedPart) => {
  const p = part.positions, ix = part.indices;
  let six = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [ix[t] * 3, ix[t + 1] * 3, ix[t + 2] * 3];
    six += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return six / 6;
};

const chamfer = (over: Partial<ChamferOpts>) =>
  ({ style: 'chamfer', edges: 'top', sizeMm: 2, ...over }) as ChamferOpts;

test('a top chamfer keeps the bounds, shrinks the top face, leaves the middle alone', async () => {
  const box = primitivePart(spec({}));   // 20 × 10 × 20, y 0..10
  const cut = await chamferPart(box, chamfer({ edges: 'top', sizeMm: 2 }));
  auditWatertight(cut, 'top chamfer');
  const { min, max } = boundsOf(cut);
  assert.ok(Math.abs(min[1]) < 0.01 && Math.abs(max[1] - 10) < 0.01, 'height preserved');
  assert.ok(Math.abs(max[0] - 10) < 0.01, 'full width survives below the bevel');
  // The topmost band carries the full inset: 10 − 2 = 8 mm reach.
  assert.ok(Math.abs(reachAtY(cut, 9.9, 10.1) - 8) < 0.05, `top face inset by the full size (reach ${reachAtY(cut, 9.9, 10.1)})`);
  // Below the band the walls are untouched.
  assert.ok(Math.abs(reachAtY(cut, 0, 7.9) - 10) < 0.001, 'walls below the band exact');
  assert.ok(volumeOf(cut) < volumeOf(box), 'material was removed');
});

test('"both" treats the bottom edge too; "bottom" leaves the top sharp', async () => {
  const box = primitivePart(spec({}));
  const both = await chamferPart(box, chamfer({ edges: 'both', sizeMm: 2 }));
  auditWatertight(both, 'both edges');
  assert.ok(reachAtY(both, -0.1, 0.1) < 8.1, 'bottom face inset');
  assert.ok(reachAtY(both, 9.9, 10.1) < 8.1, 'top face inset');
  const bottom = await chamferPart(box, chamfer({ edges: 'bottom', sizeMm: 2 }));
  auditWatertight(bottom, 'bottom only');
  assert.ok(reachAtY(bottom, -0.1, 0.1) < 8.1, 'bottom face inset');
  assert.ok(Math.abs(reachAtY(bottom, 9.9, 10.1) - 10) < 0.001, 'top face untouched');
});

test('a round-over eases in — it keeps more material than a chamfer of the same size', async () => {
  const box = primitivePart(spec({}));
  const flat = await chamferPart(box, chamfer({ style: 'chamfer', sizeMm: 3 }));
  const round = await chamferPart(box, chamfer({ style: 'round', sizeMm: 3 }));
  auditWatertight(round, 'round-over');
  assert.ok(volumeOf(round) > volumeOf(flat), 'round profile hugs the corner');
  // Both end at the same top inset.
  assert.ok(Math.abs(reachAtY(round, 9.9, 10.1) - 7) < 0.05, 'round reaches the full inset at the top');
});

test('hollow parts ease over on both rims and stay watertight', async () => {
  // A torus is the stress case: every horizontal slice is an annulus, so
  // the band layers must offset inner and outer contours together.
  const donut = primitivePart(spec({ kind: 'torus', widthMm: 40, tubeMm: 8 }));
  const cut = await chamferPart(donut, chamfer({ edges: 'both', sizeMm: 1.5 }));
  auditWatertight(cut, 'chamfered torus');
  assert.ok(volumeOf(cut) < volumeOf(donut), 'material came off the rims');
  const { min, max } = boundsOf(cut);
  const before = boundsOf(donut);
  // A torus has no sharp top edge — its crest thins below the inset near
  // the top, so the last sliver is shaved (a router would do the same).
  // The loss must stay within the treatment size; the equator is untouched.
  assert.ok(max[1] <= before.max[1] + 0.01 && max[1] >= before.max[1] - 1.5, `crest shave bounded (top ${max[1].toFixed(2)})`);
  assert.ok(min[1] >= before.min[1] - 0.01 && min[1] <= before.min[1] + 1.5, 'base shave bounded');
  assert.ok(Math.abs(max[0] - before.max[0]) < 0.01, 'equator width exact — the middle band is kept, not re-meshed');
});

test('a size the part cannot fit is refused with a plain message', async () => {
  const box = primitivePart(spec({ heightMm: 4 }));
  await assert.rejects(() => chamferPart(box, chamfer({ edges: 'both', sizeMm: 2 })), ChamferError);
  await assert.rejects(() => chamferPart(box, chamfer({ edges: 'top', sizeMm: 5 })), ChamferError);
  await assert.rejects(() => chamferPart(box, chamfer({ sizeMm: 0 })), ChamferError);
});

test('a legacy inside-out mesh (imported before the winding fix) is righted and treated', async () => {
  const box = primitivePart(spec({}));
  const flipped = new Uint32Array(box.indices);
  for (let t = 0; t < flipped.length; t += 3) {
    const tmp = flipped[t + 1]; flipped[t + 1] = flipped[t + 2]; flipped[t + 2] = tmp;
  }
  const inv = { ...box, indices: flipped };
  assert.ok(volumeOf(inv) < 0, 'fixture really is inside-out');
  const cut = await chamferPart(inv, chamfer({ sizeMm: 2 }));
  auditWatertight(cut, 'righted mesh');
  assert.ok(volumeOf(cut) > 0, 'comes back outward-wound');
  assert.ok(Math.abs(reachAtY(cut, 9.9, 10.1) - 8) < 0.05, 'full inset reached');
});

test('re-applying to the treated mesh still works (the Studio re-applies from the stash, but the maths must not care)', async () => {
  const box = primitivePart(spec({}));
  const once = await chamferPart(box, chamfer({ sizeMm: 2 }));
  const twice = await chamferPart(once, chamfer({ sizeMm: 1 }));
  auditWatertight(twice, 'second pass');
});
