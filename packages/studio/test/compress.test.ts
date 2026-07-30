// Compression fidelity. The browser publish path must match the pipeline's
// verified numbers, so the same checks run here: the compressed file is
// meshopt-tagged, much smaller, and geometrically indistinguishable —
// order-independent comparison, since welding reorders vertices.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { compressGlb } from '../src/lib/compress-glb.ts';
import { writeGlb } from '../src/lib/write-glb.ts';
import type { ImportedPart } from '../src/lib/types.ts';

/** A lumpy test part: a jittered grid so quantisation has real work to do. */
function bumpyPlate(name: string, nx: number, nz: number, w: number, d: number): ImportedPart {
  const positions = new Float32Array(nx * nz * 3);
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const at = (i * nz + j) * 3;
      positions[at] = (i / (nx - 1) - 0.5) * w;
      positions[at + 1] = rand() * 3;
      positions[at + 2] = (j / (nz - 1) - 0.5) * d;
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < nx - 1; i++) {
    for (let j = 0; j < nz - 1; j++) {
      const a = i * nz + j, b = a + 1, c = a + nz, e = c + 1;
      indices.push(a, c, b, b, c, e);
    }
  }
  return { name, positions, indices: Uint32Array.from(indices) };
}

const PARTS = [bumpyPlate('plate', 40, 40, 120, 80), bumpyPlate('lid', 20, 20, 40, 40)];
const RAW_GLB = writeGlb(PARTS);

async function decode(bytes: Uint8Array) {
  await MeshoptDecoder.ready;
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.readBinary(bytes);
  const out = new Map<string, { verts: Float64Array; count: number }>();
  for (const mesh of doc.getRoot().listMeshes()) {
    const prim = mesh.listPrimitives()[0];
    const pos = prim.getAttribute('POSITION')!;
    const node = doc.getRoot().listNodes().find((n) => n.getMesh() === mesh);
    const s = node?.getScale() ?? [1, 1, 1];
    const t = node?.getTranslation() ?? [0, 0, 0];
    const n = pos.getCount();
    const verts = new Float64Array(n * 3);
    const tmp = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      pos.getElement(i, tmp);
      for (let a = 0; a < 3; a++) verts[i * 3 + a] = tmp[a] * s[a] + t[a];
    }
    out.set(mesh.getName(), { verts, count: n });
  }
  return out;
}

const bbox = (verts: Float64Array) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (verts[i + a] < min[a]) min[a] = verts[i + a];
      if (verts[i + a] > max[a]) max[a] = verts[i + a];
    }
  }
  return { min, max };
};

test('compressGlb produces a meshopt-tagged GLB the loader will recognise', async () => {
  const packed = await compressGlb(RAW_GLB);
  const json = new TextDecoder().decode(packed.subarray(20, 20 + new DataView(packed.buffer, packed.byteOffset).getUint32(12, true)));
  assert.match(json, /EXT_meshopt_compression/);
  assert.equal(new DataView(packed.buffer, packed.byteOffset).getUint32(0, true), 0x46546c67);
});

test('compression actually compresses', async () => {
  const packed = await compressGlb(RAW_GLB);
  assert.ok(packed.length < RAW_GLB.length * 0.6,
    `${packed.length} bytes vs raw ${RAW_GLB.length}`);
  const gzRaw = gzipSync(RAW_GLB).length;
  const gzPacked = gzipSync(packed).length;
  assert.ok(gzPacked < gzRaw, `gz ${gzPacked} should beat raw gz ${gzRaw}`);
});

test('every part survives with its name and its geometry within 0.05 mm', async () => {
  const before = await decode(RAW_GLB);
  const after = await decode(await compressGlb(RAW_GLB));
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());

  for (const [name, a] of before) {
    const b = after.get(name)!;
    const ba = bbox(a.verts), bb = bbox(b.verts);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(ba.min[axis] - bb.min[axis]) < 0.05, `${name} min[${axis}] drifted`);
      assert.ok(Math.abs(ba.max[axis] - bb.max[axis]) < 0.05, `${name} max[${axis}] drifted`);
    }
    // Order-independent: farthest original vertex from its nearest compressed
    // neighbour. Coarse O(n·m) is fine at fixture size.
    let worst = 0;
    for (let i = 0; i < a.verts.length; i += 3) {
      let best = Infinity;
      for (let j = 0; j < b.verts.length; j += 3) {
        const d = (a.verts[i] - b.verts[j]) ** 2 + (a.verts[i + 1] - b.verts[j + 1]) ** 2 + (a.verts[i + 2] - b.verts[j + 2]) ** 2;
        if (d < best) best = d;
      }
      worst = Math.max(worst, best);
    }
    assert.ok(Math.sqrt(worst) < 0.05, `${name}: worst vertex drift ${Math.sqrt(worst).toFixed(4)} mm`);
  }
});
