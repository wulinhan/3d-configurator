// GLB writer, browser-portable (DataView, no Buffer).
//
// Same output shape as the embed's node-side writer: one node + mesh per
// part, POSITION + indices, min/max on positions. This is what "publish"
// downloads and what the preview feeds the embed viewer via a blob URL, so
// the preview exercises the exact bytes a merchant would deploy.

import type { ImportedPart } from './types.ts';

const MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const FLOAT = 5126;
const UINT32 = 5125;

const pad4 = (n: number) => (n + 3) & ~3;

export function writeGlb(parts: ImportedPart[], meta: Record<string, unknown> = {}): Uint8Array {
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const meshes: object[] = [];
  const nodes: object[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;

  const pushView = (bytes: Uint8Array): number => {
    const padded = pad4(bytes.length);
    chunks.push(bytes);
    if (padded > bytes.length) chunks.push(new Uint8Array(padded - bytes.length));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    offset += padded;
    return bufferViews.length - 1;
  };

  for (const part of parts) {
    const pos = part.positions;
    const idx = part.indices;
    if (pos.length % 3) throw new Error(`${part.name}: positions not a multiple of 3`);
    if (idx.length % 3) throw new Error(`${part.name}: indices not a multiple of 3`);
    const count = pos.length / 3;
    for (const i of idx) if (i >= count) throw new Error(`${part.name}: index ${i} out of range`);

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (pos[i + a] < min[a]) min[a] = pos[i + a];
        if (pos[i + a] > max[a]) max[a] = pos[i + a];
      }
    }

    accessors.push({
      bufferView: pushView(new Uint8Array(pos.buffer, pos.byteOffset, pos.byteLength)),
      componentType: FLOAT, count, type: 'VEC3', min, max,
    });
    accessors.push({
      bufferView: pushView(new Uint8Array(idx.buffer, idx.byteOffset, idx.byteLength)),
      componentType: UINT32, count: idx.length, type: 'SCALAR',
    });

    meshes.push({
      name: part.name,
      primitives: [{ attributes: { POSITION: accessors.length - 2 }, indices: accessors.length - 1 }],
    });
    nodes.push({ name: part.name, mesh: meshes.length - 1 });
  }

  let binLength = 0;
  for (const c of chunks) binLength += c.length;
  const bin = new Uint8Array(pad4(binLength));
  let at = 0;
  for (const c of chunks) { bin.set(c, at); at += c.length; }

  const gltf = {
    asset: { version: '2.0', generator: 'allin-studio', extras: meta },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes, meshes, accessors, bufferViews,
    buffers: [{ byteLength: binLength }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPadded = new Uint8Array(pad4(jsonBytes.length)).fill(0x20); // spaces
  jsonPadded.set(jsonBytes);

  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, JSON_CHUNK, true);
  out.set(jsonPadded, 20);
  view.setUint32(20 + jsonPadded.length, bin.length, true);
  view.setUint32(24 + jsonPadded.length, BIN_CHUNK, true);
  out.set(bin, 28 + jsonPadded.length);
  return out;
}
