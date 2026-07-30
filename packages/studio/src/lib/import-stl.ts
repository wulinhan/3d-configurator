// STL import — binary and ASCII.
//
// STL is triangle soup: every triangle carries its own three vertices, so a
// cube arrives as 36 unshared vertices. They're welded here (exact-match on
// the raw float bits — slicers emit identical bytes for identical corners)
// because everything downstream sizes and prices by real vertex counts, and
// a soup mesh triples memory for nothing.
//
// STL has no parts and no units. It becomes a single part named "model", and
// unitToMm is reported as 1 with the caller left to ask the merchant — the
// format genuinely does not say.

import { ImportError, type ImportedModel } from './types.ts';

export function importStl(bytes: Uint8Array): ImportedModel {
  const soup = looksBinary(bytes) ? readBinary(bytes) : readAscii(bytes);
  return { parts: [weld(soup)], unitToMm: 1, format: 'stl' };
}

/**
 * "solid" at byte 0 does NOT mean ASCII — several exporters write binary
 * files whose 80-byte header happens to start with the word. The reliable
 * test is the length equation: binary is exactly 84 + 50·triangleCount bytes.
 */
function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true);
  return bytes.length === 84 + 50 * count;
}

function readBinary(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const count = view.getUint32(80, true);
  const out = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    const at = 84 + t * 50 + 12; // skip the normal; it's recomputed at render
    for (let v = 0; v < 9; v++) out[t * 9 + v] = view.getFloat32(at + v * 4, true);
  }
  return out;
}

function readAscii(bytes: Uint8Array): Float32Array {
  const text = new TextDecoder().decode(bytes);
  if (!/^\s*solid/.test(text)) throw new ImportError('not an STL file (no binary length match, no "solid" header)');
  const values: number[] = [];
  for (const m of text.matchAll(/vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g)) {
    values.push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  if (!values.length || values.length % 9) {
    throw new ImportError(`ASCII STL parse failed: ${values.length / 3} vertices is not a whole number of triangles`);
  }
  return Float32Array.from(values);
}

function weld(soup: Float32Array) {
  const seen = new Map<string, number>();
  const positions: number[] = [];
  const indices = new Uint32Array(soup.length / 3);
  for (let v = 0; v < soup.length / 3; v++) {
    const [x, y, z] = [soup[v * 3], soup[v * 3 + 1], soup[v * 3 + 2]];
    const key = `${x},${y},${z}`;
    let idx = seen.get(key);
    if (idx === undefined) {
      idx = positions.length / 3;
      positions.push(x, y, z);
      seen.set(key, idx);
    }
    indices[v] = idx;
  }
  return { name: 'model', positions: Float32Array.from(positions), indices };
}
