// The fabrication contract: what the Studio generates and what the STL
// export writes must be WATERTIGHT — no non-manifold edges for a slicer's
// auto-repair to "fix" (the repair is what mangled a QR template into
// confetti). The audit here is what a slicer effectively does: weld
// vertices by exact coordinate, then require that every directed edge
// appears exactly once and its reverse exactly once.
//
// The checkerboard is the QR failure mode distilled: ink squares that
// touch only at corners. Before the Manifold port, its extrusion had 50
// doubled edges; the 5-micron inset must keep it at zero forever.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templateFromRaster, TEMPLATE_DEFAULTS, type Raster } from '../src/lib/trace-image.ts';
import { exportModel, type ExportMesh } from '../src/lib/export-model.ts';

interface Audit { verts: number; tris: number; degenerate: number; doubled: number; unmatched: number }

const audit = (positions: Float32Array, indices: Uint32Array): Audit => {
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
    if ((edges.get(`${v}>${u}`) ?? 0) !== n) unmatched++;
  }
  return { verts: vid.size, tris: indices.length / 3, degenerate, doubled, unmatched };
};

const watertight = (a: Audit, what: string) => {
  assert.equal(a.degenerate, 0, `${what}: degenerate triangles`);
  assert.equal(a.doubled, 0, `${what}: doubled edges (non-manifold contact)`);
  assert.equal(a.unmatched, 0, `${what}: unmatched edges (holes)`);
  assert.ok(a.tris > 0, `${what}: has triangles at all`);
};

/** Corner-touching ink squares — every other cell, like a QR code. */
const checkerboard = (): Raster => {
  const w = 40, h = 40;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cell = ((x / 5) | 0) + ((y / 5) | 0);
      const v = (cell % 2 === 0 && x >= 5 && x < 35 && y >= 5 && y < 35) ? 0 : 255;
      const p = (y * w + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { data, width: w, height: h };
};

test('a QR-like template is watertight — corner-touching cells become separate solids', async () => {
  const parts = await templateFromRaster(checkerboard(), { ...TEMPLATE_DEFAULTS, widthMm: 40 });
  assert.equal(parts.length, 2);
  for (const part of parts) watertight(audit(part.positions, part.indices), part.name);
});

test('STL export unions touching parts into one watertight solid', async () => {
  const parts = await templateFromRaster(checkerboard(), { ...TEMPLATE_DEFAULTS, widthMm: 40 });
  const stl = await exportModel(parts as ExportMesh[], 'stl', 'x');
  const view = new DataView(stl.buffer, stl.byteOffset);
  const tris = view.getUint32(80, true);
  assert.equal(stl.length, 84 + tris * 50);
  // unpack the soup and audit it exactly as a slicer would
  const positions = new Float32Array(tris * 9);
  const indices = new Uint32Array(tris * 3);
  for (let t = 0; t < tris; t++) {
    const at = 84 + t * 50 + 12; // skip the normal
    for (let v = 0; v < 9; v++) positions[t * 9 + v] = view.getFloat32(at + v * 4, true);
    indices[t * 3] = t * 3; indices[t * 3 + 1] = t * 3 + 1; indices[t * 3 + 2] = t * 3 + 2;
  }
  watertight(audit(positions, indices), 'unioned STL');
});

test('a mesh that is not manifold still exports as a plain soup (no refusal)', async () => {
  const open: ExportMesh = {
    name: 'open-tri',
    positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]),
    indices: Uint32Array.from([0, 1, 2]),
  };
  const stl = await exportModel([open], 'stl', 'x');
  assert.equal(new DataView(stl.buffer, stl.byteOffset).getUint32(80, true), 1);
});
