// GLB import for merchant uploads.
//
// Deliberately narrower than a full glTF loader: plain float32 POSITION,
// standard index types, node TRS/matrix hierarchies. Compressed or quantised
// inputs (Draco, meshopt, KHR_mesh_quantization) are refused with a message
// that says to export a standard GLB — the Studio compresses on publish, so
// accepting pre-compressed input would mean shipping every decoder just to
// immediately re-encode.
//
// Node transforms are baked into the vertices. A part's placement in the
// manifest is authored in the Studio; whatever hierarchy the merchant's DCC
// exported is an accident of their scene graph, not intent to preserve.

import { ImportError, type ImportedModel, type ImportedPart } from './types.ts';

const MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

const COMPONENT: Record<number, { array: Float32ArrayConstructor | Uint32ArrayConstructor | Uint16ArrayConstructor | Uint8ArrayConstructor; size: number }> = {
  5126: { array: Float32Array, size: 4 },
  5125: { array: Uint32Array, size: 4 },
  5123: { array: Uint16Array, size: 2 },
  5121: { array: Uint8Array, size: 1 },
};
const TYPE_LANES: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

type Mat4 = Float64Array; // column-major, glTF's own convention

const identity = (): Mat4 => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const multiply = (a: Mat4, b: Mat4): Mat4 => {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
};

/** T · R · S from a node's separate fields, per the glTF spec. */
function trs(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): Mat4 {
  const [x, y, z, w] = q;
  const [x2, y2, z2] = [x + x, y + y, z + z];
  const [xx, xy, xz] = [x * x2, x * y2, x * z2];
  const [yy, yz, zz] = [y * y2, y * z2, z * z2];
  const [wx, wy, wz] = [w * x2, w * y2, w * z2];
  return Float64Array.from([
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ]);
}

const transformPoint = (m: Mat4, x: number, y: number, z: number): [number, number, number] => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

export function importGlb(bytes: Uint8Array): ImportedModel {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(0, true) !== MAGIC) throw new ImportError('not a GLB file');

  let at = 12;
  let json: any = null;
  let bin: Uint8Array | null = null;
  while (at + 8 <= bytes.length) {
    const len = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (type === JSON_CHUNK) json = JSON.parse(new TextDecoder().decode(body));
    else if (type === BIN_CHUNK) bin = body;
    at += 8 + len + ((4 - (len % 4)) % 4) * 0; // chunk lengths are pre-padded per spec
    at += (4 - (at % 4)) % 4;
  }
  if (!json) throw new ImportError('GLB has no JSON chunk');

  const unsupported = (json.extensionsRequired ?? []).filter((e: string) =>
    /draco|meshopt|quantization/i.test(e));
  if (unsupported.length) {
    throw new ImportError(
      `GLB requires ${unsupported.join(', ')} — export a standard (uncompressed) GLB; the Studio compresses on publish`);
  }

  const readAccessor = (index: number): { data: Float32Array | Uint32Array | Uint16Array | Uint8Array; lanes: number } => {
    const a = json.accessors?.[index];
    if (!a) throw new ImportError(`missing accessor ${index}`);
    if (a.sparse) throw new ImportError('sparse accessors are not supported');
    if (a.normalized) throw new ImportError('normalized (quantised) accessors are not supported — export standard GLB');
    const comp = COMPONENT[a.componentType];
    const lanes = TYPE_LANES[a.type];
    if (!comp || !lanes) throw new ImportError(`accessor ${index}: unsupported componentType ${a.componentType} / ${a.type}`);
    const v = json.bufferViews?.[a.bufferView];
    if (!v || !bin) throw new ImportError(`accessor ${index}: no backing buffer`);
    const stride = v.byteStride ?? comp.size * lanes;
    const start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const out = new comp.array(a.count * lanes);
    if (stride === comp.size * lanes) {
      const flat = new comp.array(bin.buffer, bin.byteOffset + start, a.count * lanes);
      out.set(flat);
    } else {
      // Interleaved: walk element by element.
      for (let i = 0; i < a.count; i++) {
        const el = new comp.array(bin.buffer, bin.byteOffset + start + i * stride, lanes);
        out.set(el, i * lanes);
      }
    }
    return { data: out, lanes };
  };

  // Walk the scene graph composing world matrices.
  const parts: ImportedPart[] = [];
  const seenNames = new Map<string, number>();

  const visit = (nodeIndex: number, parent: Mat4, depth: number) => {
    if (depth > 64) throw new ImportError('node graph too deep — probably a cycle');
    const node = json.nodes?.[nodeIndex];
    if (!node) return;
    const local: Mat4 = node.matrix ? Float64Array.from(node.matrix) : trs(node.translation, node.rotation, node.scale);
    const world = multiply(parent, local);

    if (node.mesh != null) {
      const mesh = json.meshes?.[node.mesh];
      for (const prim of mesh?.primitives ?? []) {
        if (prim.mode != null && prim.mode !== 4) continue; // triangles only
        if (prim.attributes?.POSITION == null) continue;
        const pos = readAccessor(prim.attributes.POSITION);
        if (pos.lanes !== 3) throw new ImportError('POSITION accessor is not VEC3');

        const positions = new Float32Array(pos.data.length);
        for (let i = 0; i < pos.data.length; i += 3) {
          const [x, y, z] = transformPoint(world, pos.data[i], pos.data[i + 1], pos.data[i + 2]);
          positions[i] = x; positions[i + 1] = y; positions[i + 2] = z;
        }

        let indices: Uint32Array;
        if (prim.indices != null) {
          indices = Uint32Array.from(readAccessor(prim.indices).data);
        } else {
          indices = Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
        }
        const count = positions.length / 3;
        for (const i of indices) if (i >= count) throw new ImportError('triangle index out of range');

        // Negative-determinant node transforms (mirrored exports) flip the
        // winding; re-wind so back-face culling doesn't hollow the part out.
        const det = world[0] * (world[5] * world[10] - world[6] * world[9])
          - world[4] * (world[1] * world[10] - world[2] * world[9])
          + world[8] * (world[1] * world[6] - world[2] * world[5]);
        if (det < 0) {
          for (let t = 0; t < indices.length; t += 3) {
            const swap = indices[t + 1];
            indices[t + 1] = indices[t + 2];
            indices[t + 2] = swap;
          }
        }

        const base = node.name || mesh?.name || `part-${parts.length + 1}`;
        const n = (seenNames.get(base) ?? 0) + 1;
        seenNames.set(base, n);
        parts.push({ name: n === 1 ? base : `${base}-${n}`, positions, indices });
      }
    }
    for (const child of node.children ?? []) visit(child, world, depth + 1);
  };

  const scene = json.scenes?.[json.scene ?? 0];
  for (const root of scene?.nodes ?? []) visit(root, identity(), 0);
  if (!parts.length) throw new ImportError('GLB contains no triangle meshes');

  // glTF is metres by spec — but every real product model we've met is
  // exported in millimetres already, so guess from the size and let the
  // Studio's unit picker override. A 140 mm bar exported in metres reads as
  // 0.14 units; anything under 10 units across is almost certainly metres.
  let span = 0;
  for (const part of parts) {
    for (let i = 0; i < part.positions.length; i++) span = Math.max(span, Math.abs(part.positions[i]));
  }
  return { parts, unitToMm: span > 0 && span < 10 ? 1000 : 1, format: 'glb' };
}
