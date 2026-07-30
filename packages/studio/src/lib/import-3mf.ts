// 3MF import — the format our own products (and most slicer workflows) start
// life in. A 3MF is a zip; the geometry lives in an XML "model" entry as
// <object> elements holding meshes, composed via <component> references and
// placed by <build><item> entries, each optionally carrying a 3×4 affine
// transform.
//
// The XML is parsed with regexes rather than a DOM. That is a deliberate
// trade: these files are machine-written (Bambu Studio, PrusaSlicer, Fusion,
// our own exporter), attribute layouts are utterly regular, and a DOM parser
// isn't available in a worker-less Node test run. The regexes anchor on
// attribute names, not order, and every reference is checked so a file that
// defeats them fails loudly, not quietly.

import { unzipSync } from 'fflate';
import { ImportError, type ImportedModel, type ImportedPart } from './types.ts';

// 3MF spec, §3.4: metres, not millimetres, is the oddball to watch for.
const UNIT_TO_MM: Record<string, number> = {
  micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000,
};

/** Row-major 3×4 affine: rows are the basis vectors, last row the translation. */
type Affine = number[]; // 12 numbers

const IDENTITY: Affine = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

const compose = (outer: Affine, inner: Affine): Affine => {
  // v' = (v · inner) · outer, both row-vector convention — matching the spec's
  // definition that a component's transform maps it into its parent's space.
  const r: Affine = new Array(12);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      r[row * 3 + col] =
        inner[row * 3] * outer[col] +
        inner[row * 3 + 1] * outer[3 + col] +
        inner[row * 3 + 2] * outer[6 + col] +
        (row === 3 ? outer[9 + col] : 0);
    }
  }
  return r;
};

const apply = (m: Affine, x: number, y: number, z: number): [number, number, number] => [
  x * m[0] + y * m[3] + z * m[6] + m[9],
  x * m[1] + y * m[4] + z * m[7] + m[10],
  x * m[2] + y * m[5] + z * m[8] + m[11],
];

const attr = (tag: string, name: string): string | undefined =>
  tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];

const parseTransform = (spec: string | undefined): Affine => {
  if (!spec) return IDENTITY;
  const nums = spec.trim().split(/\s+/).map(Number);
  if (nums.length !== 12 || nums.some((n) => !Number.isFinite(n))) {
    throw new ImportError(`bad 3MF transform "${spec}" — expected 12 numbers`);
  }
  return nums;
};

interface ObjectDef {
  name?: string;
  mesh?: { positions: Float32Array; indices: Uint32Array };
  components: Array<{ objectId: string; transform: Affine }>;
}

export function import3mf(bytes: Uint8Array): ImportedModel {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new ImportError('not a 3MF file (zip container failed to open)');
  }

  // The payload is conventionally 3D/3dmodel.model, but the spec only fixes
  // the extension, so fall back to any .model entry.
  const modelPath = entries['3D/3dmodel.model']
    ? '3D/3dmodel.model'
    : Object.keys(entries).find((k) => k.endsWith('.model'));
  if (!modelPath) throw new ImportError('no 3D model payload inside the 3MF');
  const xml = new TextDecoder().decode(entries[modelPath]);

  const unit = xml.match(/<model[^>]*\sunit="([^"]*)"/)?.[1] ?? 'millimeter';
  const unitToMm = UNIT_TO_MM[unit];
  if (!unitToMm) throw new ImportError(`unknown 3MF unit "${unit}"`);

  // ── objects ───────────────────────────────────────────────────────────────
  const objects = new Map<string, ObjectDef>();
  for (const m of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const [, tag, body] = m;
    const id = attr(tag, 'id');
    if (!id) continue;
    const def: ObjectDef = { name: attr(tag, 'name'), components: [] };

    const meshBody = body.match(/<mesh\b[^>]*>([\s\S]*?)<\/mesh>/)?.[1];
    if (meshBody) {
      const positions: number[] = [];
      for (const v of meshBody.matchAll(/<vertex\b([^>]*)\/>/g)) {
        positions.push(Number(attr(v[1], 'x') ?? 0), Number(attr(v[1], 'y') ?? 0), Number(attr(v[1], 'z') ?? 0));
      }
      const indices: number[] = [];
      for (const t of meshBody.matchAll(/<triangle\b([^>]*)\/>/g)) {
        indices.push(Number(attr(t[1], 'v1')), Number(attr(t[1], 'v2')), Number(attr(t[1], 'v3')));
      }
      const count = positions.length / 3;
      if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= count)) {
        throw new ImportError(`object ${id}: triangle index out of range (${count} vertices)`);
      }
      def.mesh = { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
    }

    for (const c of body.matchAll(/<component\b([^>]*)\/>/g)) {
      const objectId = attr(c[1], 'objectid');
      if (!objectId) throw new ImportError(`object ${id}: component without objectid`);
      def.components.push({ objectId, transform: parseTransform(attr(c[1], 'transform')) });
    }
    objects.set(id, def);
  }
  if (!objects.size) throw new ImportError('3MF contains no objects');

  // ── flatten: every leaf mesh under an object, transforms composed ─────────
  const collect = (id: string, into: Array<{ positions: Float32Array; indices: Uint32Array }>, m: Affine, depth: number) => {
    if (depth > 32) throw new ImportError('3MF component nesting too deep — probably a reference cycle');
    const def = objects.get(id);
    if (!def) throw new ImportError(`reference to missing object "${id}"`);
    if (def.mesh) {
      const src = def.mesh.positions;
      const positions = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        const [x, y, z] = apply(m, src[i], src[i + 1], src[i + 2]);
        positions[i] = x; positions[i + 1] = y; positions[i + 2] = z;
      }
      into.push({ positions, indices: def.mesh.indices });
    }
    for (const c of def.components) collect(c.objectId, into, compose(m, c.transform), depth + 1);
  };

  // ── build items: one part per item ────────────────────────────────────────
  const items = [...xml.matchAll(/<item\b([^>]*?)\/?>(?:<\/item>)?/g)]
    .map((m) => ({ objectId: attr(m[1], 'objectid'), transform: parseTransform(attr(m[1], 'transform')) }))
    .filter((i): i is { objectId: string; transform: Affine } => !!i.objectId);
  if (!items.length) throw new ImportError('3MF has no <build> items — nothing is placed in the scene');

  const parts: ImportedPart[] = [];
  const seenNames = new Map<string, number>();
  for (const item of items) {
    const pieces: Array<{ positions: Float32Array; indices: Uint32Array }> = [];
    collect(item.objectId, pieces, item.transform, 0);
    if (!pieces.length) continue;

    // An item that fans out to several leaf meshes is a printed assembly —
    // merge it: one build item is one placeable thing.
    let vertexCount = 0, indexCount = 0;
    for (const p of pieces) { vertexCount += p.positions.length; indexCount += p.indices.length; }
    const positions = new Float32Array(vertexCount);
    const indices = new Uint32Array(indexCount);
    let vAt = 0, iAt = 0;
    for (const p of pieces) {
      positions.set(p.positions, vAt);
      for (let i = 0; i < p.indices.length; i++) indices[iAt + i] = p.indices[i] + vAt / 3;
      vAt += p.positions.length;
      iAt += p.indices.length;
    }

    const base = objects.get(item.objectId)?.name || `part-${parts.length + 1}`;
    const n = (seenNames.get(base) ?? 0) + 1;
    seenNames.set(base, n);
    parts.push({ name: n === 1 ? base : `${base}-${n}`, positions, indices });
  }
  if (!parts.length) throw new ImportError('3MF build items reference no meshes');

  return { parts, unitToMm, format: '3mf' };
}
