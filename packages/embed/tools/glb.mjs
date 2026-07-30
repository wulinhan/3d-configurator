// Minimal glTF 2.0 / GLB writer for configurator part meshes.
//
// The current configurators bake geometry into the HTML as JSON arrays, which
// is why they weigh 0.6–1.4 MB each. A merchant's product page can't carry
// that, and self-serve needs models fetched at runtime rather than compiled
// in — so parts ship as GLB instead.
//
// Deliberately small: one node + mesh per part, POSITION + indices only.
// Normals are computed at load time because the renderer flat-shades (it
// de-indexes first), so shipping them would be wasted bytes.

const MAGIC = 0x46546c67;   // "glTF"
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const FLOAT = 5126;
const UINT32 = 5125;

const pad4 = (n) => (n + 3) & ~3;

/**
 * @param {Array<{name: string, positions: Float32Array|number[], indices: Uint32Array|number[]}>} parts
 * @param {object} [meta] copied into asset.extras (units, source file, …)
 * @returns {Buffer} GLB bytes
 */
export function partsToGlb(parts, meta = {}) {
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const nodes = [];
  const chunks = [];
  let offset = 0;

  const pushView = (bytes) => {
    const padded = pad4(bytes.length);
    chunks.push(bytes, Buffer.alloc(padded - bytes.length));
    const view = { buffer: 0, byteOffset: offset, byteLength: bytes.length };
    offset += padded;
    return bufferViews.push(view) - 1;
  };

  for (const part of parts) {
    const pos = part.positions instanceof Float32Array ? part.positions : Float32Array.from(part.positions);
    const idx = part.indices instanceof Uint32Array ? part.indices : Uint32Array.from(part.indices);
    if (pos.length % 3) throw new Error(`${part.name}: positions not a multiple of 3`);
    if (idx.length % 3) throw new Error(`${part.name}: indices not a multiple of 3`);
    const count = pos.length / 3;
    for (const i of idx) if (i >= count) throw new Error(`${part.name}: index ${i} out of range (${count} verts)`);

    // POSITION accessors are required to carry min/max — viewers use them for
    // frustum culling and, for us, for auto-framing the camera.
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = pos[i + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }

    const posAccessor = accessors.push({
      bufferView: pushView(Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength)),
      componentType: FLOAT, count, type: 'VEC3', min, max,
    }) - 1;
    const idxAccessor = accessors.push({
      bufferView: pushView(Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength)),
      componentType: UINT32, count: idx.length, type: 'SCALAR',
    }) - 1;

    const mesh = meshes.push({
      name: part.name,
      primitives: [{ attributes: { POSITION: posAccessor }, indices: idxAccessor }],
    }) - 1;
    nodes.push({ name: part.name, mesh });
  }

  const bin = Buffer.concat(chunks);
  const gltf = {
    asset: { version: '2.0', generator: 'allin-configurator', extras: meta },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };

  const jsonBytes = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc(pad4(jsonBytes.length) - jsonBytes.length, 0x20)]); // spaces
  const binPadded = Buffer.concat([bin, Buffer.alloc(pad4(bin.length) - bin.length)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonHeader.writeUInt32LE(JSON_CHUNK, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binPadded.length, 0);
  binHeader.writeUInt32LE(BIN_CHUNK, 4);

  return Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binPadded]);
}

/** Split a GLB into its JSON manifest and binary payload. */
export function glbChunks(buf) {
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error('not a GLB');
  const total = buf.readUInt32LE(8);
  if (total !== buf.length) throw new Error(`length mismatch: header ${total}, actual ${buf.length}`);

  let p = 12, json = null, bin = null;
  while (p < buf.length) {
    const len = buf.readUInt32LE(p);
    const type = buf.readUInt32LE(p + 4);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === JSON_CHUNK) json = JSON.parse(body.toString('utf8'));
    else if (type === BIN_CHUNK) bin = body;
    p += 8 + len;
  }
  if (!json) throw new Error('missing JSON chunk');
  return { json, bin };
}

/**
 * Mesh names only. Reads the JSON chunk and ignores the payload, so it works
 * on compressed GLBs too — no decoder needed to answer "does this file
 * contain a mesh called `body`?".
 */
export function glbMeshNames(buf) {
  return (glbChunks(buf).json.meshes ?? []).map((m) => m.name);
}

/** Read a GLB back into {name, positions, indices} — used to verify a write. */
export function glbToParts(buf) {
  const { json, bin } = glbChunks(buf);
  if (!bin) throw new Error('missing BIN chunk');

  const read = (accessorIndex, Type) => {
    const a = json.accessors[accessorIndex];
    const v = json.bufferViews[a.bufferView];
    const per = Type === Float32Array ? 3 : 1;
    return new Type(bin.buffer, bin.byteOffset + (v.byteOffset || 0), a.count * per);
  };

  return json.meshes.map((m) => {
    const prim = m.primitives[0];
    return {
      name: m.name,
      positions: read(prim.attributes.POSITION, Float32Array),
      indices: read(prim.indices, Uint32Array),
      min: json.accessors[prim.attributes.POSITION].min,
      max: json.accessors[prim.attributes.POSITION].max,
    };
  });
}
