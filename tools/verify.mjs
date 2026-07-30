// Prove a compressed GLB still matches the original geometry.
//
// weld() merges duplicate vertices and quantize() rewrites coordinates as
// integers with a scale baked into the parent node, so vertex order and count
// both change. The comparison therefore has to be order-independent: bounding
// box, surface area, and a grid-hashed nearest-neighbour search that reports
// how far the worst original vertex sits from anything in the compressed mesh.
//
//   node configurator/tools/verify.mjs original.glb compressed.glb [tolerance-mm]

import { readFileSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

export const DEFAULT_TOLERANCE_MM = 0.05; // a quarter of a 0.2 mm layer line

async function load(path) {
  await MeshoptDecoder.ready; // WASM must be instantiated before it's registered
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.readBinary(new Uint8Array(readFileSync(path)));

  const parts = new Map();
  for (const mesh of doc.getRoot().listMeshes()) {
    const prim = mesh.listPrimitives()[0];
    const pos = prim.getAttribute('POSITION');
    const n = pos.getCount();
    // getElement() undoes accessor normalisation; the node transform undoes
    // quantize()'s scale/offset. Both files then share one millimetre space.
    const node = doc.getRoot().listNodes().find((nd) => nd.getMesh() === mesh);
    const s = node ? node.getScale() : [1, 1, 1];
    const t = node ? node.getTranslation() : [0, 0, 0];
    const verts = new Float64Array(n * 3);
    const tmp = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      pos.getElement(i, tmp);
      for (let a = 0; a < 3; a++) verts[i * 3 + a] = tmp[a] * s[a] + t[a];
    }
    const idx = prim.getIndices();
    parts.set(mesh.getName(), {
      verts,
      indices: idx ? idx.getArray() : Uint32Array.from({ length: n }, (_, i) => i),
      count: n,
    });
  }
  return parts;
}

const bounds = ({ verts }) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 3)
    for (let a = 0; a < 3; a++) {
      if (verts[i + a] < min[a]) min[a] = verts[i + a];
      if (verts[i + a] > max[a]) max[a] = verts[i + a];
    }
  return { min, max };
};

const area = ({ verts, indices }) => {
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    const u = [verts[b] - verts[a], verts[b + 1] - verts[a + 1], verts[b + 2] - verts[a + 2]];
    const v = [verts[c] - verts[a], verts[c + 1] - verts[a + 1], verts[c + 2] - verts[a + 2]];
    sum += Math.hypot(
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ) / 2;
  }
  return sum;
};

/** Farthest any vertex of `orig` sits from the nearest vertex of `comp`, in mm. */
export function maxNearest(orig, comp, cell = 1.0) {
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const grid = new Map();
  for (let i = 0; i < comp.verts.length; i += 3) {
    const k = key(comp.verts[i], comp.verts[i + 1], comp.verts[i + 2]);
    let bucket = grid.get(k);
    if (!bucket) grid.set(k, bucket = []);
    bucket.push(i);
  }
  let worst = 0;
  for (let i = 0; i < orig.verts.length; i += 3) {
    const [x, y, z] = [orig.verts[i], orig.verts[i + 1], orig.verts[i + 2]];
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const bucket = grid.get(key(x + dx * cell, y + dy * cell, z + dz * cell));
      if (!bucket) continue;
      for (const j of bucket) {
        const d = (comp.verts[j] - x) ** 2 + (comp.verts[j + 1] - y) ** 2 + (comp.verts[j + 2] - z) ** 2;
        if (d < best) best = d;
      }
    }
    if (best > worst) worst = best;
  }
  return Math.sqrt(worst);
}

export async function compare(originalPath, compressedPath) {
  const A = await load(originalPath);
  const B = await load(compressedPath);
  const rows = [];
  for (const [name, a] of A) {
    const b = B.get(name);
    if (!b) { rows.push({ name, missing: true }); continue; }
    const ba = bounds(a), bb = bounds(b);
    let box = 0;
    for (let i = 0; i < 3; i++) box = Math.max(box, Math.abs(ba.min[i] - bb.min[i]), Math.abs(ba.max[i] - bb.max[i]));
    const aA = area(a);
    rows.push({
      name, from: a.count, to: b.count, box,
      vert: maxNearest(a, b),
      areaPct: aA ? Math.abs(aA - area(b)) / aA * 100 : 0,
    });
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [orig, comp, tolArg] = process.argv.slice(2);
  if (!orig || !comp) { console.error('usage: verify.mjs <original.glb> <compressed.glb> [tolerance-mm]'); process.exit(1); }
  const tol = tolArg ? Number(tolArg) : DEFAULT_TOLERANCE_MM;

  const rows = await compare(orig, comp);
  let worstBox = 0, worstVert = 0, worstArea = 0, missing = 0;
  console.log('part           verts (orig→out)    bbox drift   vertex drift   area Δ');
  for (const r of rows) {
    if (r.missing) { console.log(`  ${r.name}: MISSING from compressed file`); missing++; continue; }
    worstBox = Math.max(worstBox, r.box);
    worstVert = Math.max(worstVert, r.vert);
    worstArea = Math.max(worstArea, r.areaPct);
    console.log(`  ${r.name.padEnd(13)}${String(r.from).padStart(6)} → ${String(r.to).padStart(6)}` +
      `      ${r.box.toFixed(4)} mm     ${r.vert.toFixed(4)} mm   ${r.areaPct.toFixed(3)}%`);
  }
  console.log(`\nworst bbox drift   ${worstBox.toFixed(4)} mm`);
  console.log(`worst vertex drift ${worstVert.toFixed(4)} mm`);
  console.log(`worst area change  ${worstArea.toFixed(3)}%`);

  const ok = !missing && worstBox < tol && worstVert < tol;
  console.log(ok ? `PASS — under ${tol} mm, invisible on screen and below print tolerance`
                 : 'FAIL — geometry moved too far; raise quantizePosition or drop compression');
  if (!ok) process.exit(1);
}
