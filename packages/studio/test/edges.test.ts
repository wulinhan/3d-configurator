// The edge picker's contract: featureEdges finds the edges a person would
// name (a box's twelve, a cylinder's two rims, nothing on a smooth torus),
// and chamferEdges cuts EXACTLY the picked ones — watertight, right amount
// of material, other edges untouched, and refusals that say why.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { featureEdges } from '../src/lib/edges.ts';
import { chamferEdges, ChamferError } from '../src/lib/chamfer.ts';
import { primitivePart, type PrimitiveSpec } from '../src/lib/primitives.ts';
import type { ImportedPart } from '../src/lib/types.ts';

const spec = (over: Partial<PrimitiveSpec>): PrimitiveSpec => ({
  kind: 'cuboid', widthMm: 20, heightMm: 10, depthMm: 20, sides: 6, tubeMm: 10, ...over,
});

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

const watertight = (part: ImportedPart, label: string) => {
  const { positions, indices } = part;
  const vid = new Map<string, number>();
  const remap: number[] = [];
  for (let i = 0; i < positions.length / 3; i++) {
    const k = `${positions[i * 3]},${positions[i * 3 + 1]},${positions[i * 3 + 2]}`;
    if (!vid.has(k)) vid.set(k, vid.size);
    remap.push(vid.get(k)!);
  }
  const edges = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      edges.set(`${u}>${v}`, (edges.get(`${u}>${v}`) ?? 0) + 1);
    }
  }
  for (const [k, n] of edges) {
    const [u, v] = k.split('>');
    assert.equal(n, 1, `${label}: doubled edge`);
    assert.ok(edges.has(`${v}>${u}`), `${label}: unmatched edge`);
  }
};

test('a box shows its twelve edges, all convex, correctly measured', () => {
  const box = primitivePart(spec({}));
  const chains = featureEdges(box.positions, box.indices);
  assert.equal(chains.length, 12);
  assert.ok(chains.every((c) => c.segs.every((s) => s.convex)), 'all convex');
  const lengths = chains.map((c) => Math.round(c.lengthMm)).sort((a, b) => a - b);
  assert.deepEqual(lengths, [10, 10, 10, 10, 20, 20, 20, 20, 20, 20, 20, 20]);
  assert.ok(chains.every((c) => !c.closed), 'box edges are open runs');
});

test('a cylinder shows its two rims as closed chains; its wall facets stay quiet', () => {
  const cyl = primitivePart(spec({ kind: 'cylinder', widthMm: 30, heightMm: 12 }));
  const chains = featureEdges(cyl.positions, cyl.indices);
  assert.equal(chains.length, 2);
  assert.ok(chains.every((c) => c.closed), 'rims close on themselves');
});

test('a torus has no sharp edges to offer', () => {
  const donut = primitivePart(spec({ kind: 'torus', widthMm: 40, tubeMm: 8 }));
  assert.equal(featureEdges(donut.positions, donut.indices).length, 0);
});

test('chamfering ONE box edge removes exactly that corner and nothing else', async () => {
  const box = primitivePart(spec({}));   // 20 × 10 × 20
  const chains = featureEdges(box.positions, box.indices);
  const target = chains[0]; // a 20 mm edge
  const cut = await chamferEdges(box, chains, [target.id], { style: 'chamfer', sizeMm: 2 });
  watertight(cut, 'one-edge chamfer');
  // A 45° chamfer of leg s along length L removes s²/2·L.
  const removed = volumeOf(box) - volumeOf(cut);
  assert.ok(Math.abs(removed - (2 * 2) / 2 * 20) < 1.5, `removed ${removed.toFixed(1)} ≈ 40`);
  // The other eleven edges survive: the treated mesh still shows 11 of the
  // original sharp chains (the cut edge became two shallower ones).
  const after = featureEdges(cut.positions, cut.indices);
  assert.ok(after.length >= 11, `${after.length} chains remain`);
});

test('a round-over on a closed rim stays watertight and keeps more than the chamfer', async () => {
  const cyl = primitivePart(spec({ kind: 'cylinder', widthMm: 30, heightMm: 12 }));
  const rims = featureEdges(cyl.positions, cyl.indices);
  const flat = await chamferEdges(cyl, rims, [rims[0].id], { style: 'chamfer', sizeMm: 2 });
  const round = await chamferEdges(cyl, rims, [rims[0].id], { style: 'round', sizeMm: 2 });
  watertight(flat, 'rim chamfer');
  watertight(round, 'rim round');
  assert.ok(volumeOf(round) > volumeOf(flat), 'round hugs the corner');
  assert.ok(volumeOf(round) < volumeOf(cyl), 'material came off');
});

test('several edges at once, and both rims of a cylinder together', async () => {
  const box = primitivePart(spec({}));
  const chains = featureEdges(box.positions, box.indices);
  const four = chains.slice(0, 4).map((c) => c.id);
  const cut = await chamferEdges(box, chains, four, { style: 'chamfer', sizeMm: 1.5 });
  watertight(cut, 'four edges');
  assert.ok(volumeOf(cut) < volumeOf(box));

  const cyl = primitivePart(spec({ kind: 'cylinder', widthMm: 30, heightMm: 12 }));
  const rims = featureEdges(cyl.positions, cyl.indices);
  const both = await chamferEdges(cyl, rims, rims.map((c) => c.id), { style: 'round', sizeMm: 1.5 });
  watertight(both, 'both rims');
});

test('a concave valley FILLS instead of cutting', async () => {
  // An L-shaped extrusion: two boxes sharing a face, welded through the
  // kernel — its inside corner is the concave case.
  const a = primitivePart(spec({ widthMm: 20, heightMm: 5, depthMm: 20 }));
  const b = primitivePart(spec({ widthMm: 10, heightMm: 10, depthMm: 20 }));
  // shift the tall box to the left edge of the flat one
  const shifted = new Float32Array(b.positions);
  for (let i = 0; i < shifted.length; i += 3) shifted[i] -= 5;
  const { manifold } = await import('../src/lib/manifold.ts');
  const wasm = await manifold();
  const mk = (p: Float32Array, ix: Uint32Array) => {
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties: p, triVerts: ix });
    mesh.merge();
    return new wasm.Manifold(mesh);
  };
  const union = wasm.Manifold.union(mk(a.positions, a.indices), mk(shifted, b.indices));
  const mesh = union.getMesh();
  const ell: ImportedPart = {
    name: 'ell',
    positions: new Float32Array(mesh.vertProperties),
    indices: Uint32Array.from(mesh.triVerts),
  };
  union.delete();

  const chains = featureEdges(ell.positions, ell.indices);
  const valley = chains.filter((c) => c.segs.every((s) => !s.convex));
  assert.ok(valley.length >= 1, `found ${valley.length} concave chain(s)`);
  const filled = await chamferEdges(ell, chains, [valley[0].id], { style: 'round', sizeMm: 1.5 });
  watertight(filled, 'filled valley');
  assert.ok(volumeOf(filled) > volumeOf(ell), 'a valley treatment ADDS material');
});

test('refusals say why', async () => {
  const box = primitivePart(spec({}));
  const chains = featureEdges(box.positions, box.indices);
  await assert.rejects(
    () => chamferEdges(box, chains, [], { style: 'chamfer', sizeMm: 1 }),
    (e: Error) => e instanceof ChamferError && /select at least one/i.test(e.message));
  await assert.rejects(
    () => chamferEdges(box, chains, [chains[0].id], { style: 'chamfer', sizeMm: 0 }),
    (e: Error) => e instanceof ChamferError && /above zero/i.test(e.message));
  // A cut deep enough to consume the part is refused, not returned empty.
  const slab = primitivePart(spec({ widthMm: 40, heightMm: 4, depthMm: 8 }));
  const slabChains = featureEdges(slab.positions, slab.indices);
  await assert.rejects(
    () => chamferEdges(slab, slabChains, slabChains.map((c) => c.id), { style: 'chamfer', sizeMm: 6 }),
    (e: Error) => e instanceof ChamferError && /removes the whole part/i.test(e.message));
});

test('an n-gon rim chains into ONE loop, its verticals stay separate', () => {
  const oct = primitivePart(spec({ kind: 'prism', sides: 8, widthMm: 30, heightMm: 12 }));
  const chains = featureEdges(oct.positions, oct.indices);
  const rims = chains.filter((c) => c.closed);
  const verts = chains.filter((c) => !c.closed);
  assert.equal(rims.length, 2, 'top and bottom rims');
  assert.ok(rims.every((c) => c.segs.length === 8), 'each rim runs all eight segments');
  assert.equal(verts.length, 8, 'eight vertical edges');
});

test('"similar" grabs the family: all verticals of an octagon, both rims, four of a box', async () => {
  const { similarChains } = await import('../src/lib/edges.ts');
  const oct = primitivePart(spec({ kind: 'prism', sides: 8, widthMm: 30, heightMm: 12 }));
  const chains = featureEdges(oct.positions, oct.indices);
  const vertical = chains.find((c) => !c.closed)!;
  assert.equal(similarChains(chains, vertical.id).length, 8, 'all eight verticals');
  const rim = chains.find((c) => c.closed)!;
  assert.equal(similarChains(chains, rim.id).length, 2, 'both rims');

  const box = primitivePart(spec({}));
  const bc = featureEdges(box.positions, box.indices);
  const upright = bc.find((c) => Math.abs(c.dir[1]) > 0.9)!;
  assert.equal(similarChains(bc, upright.id).length, 4, 'the four uprights');
});

test('a chamfer follows an octagon rim around its corners, watertight', async () => {
  const oct = primitivePart(spec({ kind: 'prism', sides: 8, widthMm: 30, heightMm: 12 }));
  const chains = featureEdges(oct.positions, oct.indices);
  const rim = chains.find((c) => c.closed)!;
  const cut = await chamferEdges(oct, chains, [rim.id], { style: 'chamfer', sizeMm: 1.5 });
  watertight(cut, 'octagon rim chamfer');
  assert.ok(volumeOf(cut) < volumeOf(oct), 'material came off the rim');
});
