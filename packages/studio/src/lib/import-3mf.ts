// 3MF import — the format our own products (and most slicer workflows) start
// life in. A 3MF is a zip; the geometry lives in XML "model" entries as
// <object> elements holding meshes, composed via <component> references and
// placed by <build><item> entries, each optionally carrying a 3×4 affine
// transform.
//
// Two dialects matter in practice. PrusaSlicer writes everything into one
// model file. Bambu Studio and Orca Slicer use the Production Extension:
// the root file holds only references (`<component p:path="/3D/Objects/…"
// objectid="1"/>`), and the meshes live in separate sub-model files inside
// the zip. Objects are therefore keyed by (file, id), and every reference
// resolves within its own file unless it carries a path.
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

/** Determinant of the linear part — negative means the transform mirrors. */
const det3 = (m: Affine): number =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) -
  m[1] * (m[3] * m[8] - m[5] * m[6]) +
  m[2] * (m[3] * m[7] - m[4] * m[6]);

const apply = (m: Affine, x: number, y: number, z: number): [number, number, number] => [
  x * m[0] + y * m[3] + z * m[6] + m[9],
  x * m[1] + y * m[4] + z * m[7] + m[10],
  x * m[2] + y * m[5] + z * m[8] + m[11],
];

const attr = (tag: string, name: string): string | undefined =>
  tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];

// The Production Extension's path attribute arrives under whatever namespace
// prefix the writer chose (`p:path` from Bambu/Orca) — accept any prefix.
const pathAttr = (tag: string): string | undefined =>
  tag.match(/(?:^|\s)(?:\w+:)?path="([^"]*)"/)?.[1];

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
  components: Array<{ objectId: string; path?: string; transform: Affine }>;
}

export function import3mf(bytes: Uint8Array): ImportedModel {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new ImportError('not a 3MF file (zip container failed to open)');
  }

  // Parse EVERY model entry, not just the root: production-extension files
  // (Bambu Studio, Orca) spread objects across 3D/Objects/*.model sub-files.
  const modelFiles = Object.keys(entries).filter((k) => k.endsWith('.model'));
  if (!modelFiles.length) throw new ImportError('no 3D model payload inside the 3MF');
  const rootPath = entries['3D/3dmodel.model']
    ? '3D/3dmodel.model'
    : modelFiles.find((k) => new TextDecoder().decode(entries[k]).includes('<build')) ?? modelFiles[0];
  const rootXml = new TextDecoder().decode(entries[rootPath]);

  const unit = rootXml.match(/<model[^>]*\sunit="([^"]*)"/)?.[1] ?? 'millimeter';
  const unitToMm = UNIT_TO_MM[unit];
  if (!unitToMm) throw new ImportError(`unknown 3MF unit "${unit}"`);

  // Package paths are absolute ("/3D/Objects/x.model"); zip keys are not.
  const normalizePath = (p: string): string => decodeURIComponent(p).replace(/^\/+/, '');

  // ── objects, keyed by (file, id) ──────────────────────────────────────────
  const files = new Map<string, Map<string, ObjectDef>>();
  for (const filePath of modelFiles) {
    const xml = new TextDecoder().decode(entries[filePath]);
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
          throw new ImportError(`${filePath}, object ${id}: triangle index out of range (${count} vertices)`);
        }
        def.mesh = { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
      }

      for (const c of body.matchAll(/<component\b([^>]*)\/>/g)) {
        const objectId = attr(c[1], 'objectid');
        if (!objectId) throw new ImportError(`${filePath}, object ${id}: component without objectid`);
        def.components.push({ objectId, path: pathAttr(c[1]), transform: parseTransform(attr(c[1], 'transform')) });
      }
      objects.set(id, def);
    }
    files.set(filePath, objects);
  }
  if (![...files.values()].some((m) => m.size)) throw new ImportError('3MF contains no objects');

  const lookup = (filePath: string, id: string): ObjectDef => {
    const def = files.get(filePath)?.get(id);
    if (!def) {
      throw new ImportError(
        `reference to missing object "${id}" in ${filePath} — the file may use a 3MF feature this importer doesn't know; please report it with the file`);
    }
    return def;
  };

  // ── flatten: every leaf mesh under an object, transforms composed ─────────
  const collect = (filePath: string, id: string, into: Array<{ positions: Float32Array; indices: Uint32Array }>, m: Affine, depth: number) => {
    if (depth > 32) throw new ImportError('3MF component nesting too deep — probably a reference cycle');
    const def = lookup(filePath, id);
    if (def.mesh) {
      const src = def.mesh.positions;
      const positions = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        const [x, y, z] = apply(m, src[i], src[i + 1], src[i + 2]);
        positions[i] = x; positions[i + 1] = y; positions[i + 2] = z;
      }
      // A mirroring transform (slicers mirror parts freely) turns triangles
      // inside out; with back-face culling that renders as see-through
      // patches. Re-wind so the surface stays outward.
      let indices = def.mesh.indices;
      if (det3(m) < 0) {
        indices = new Uint32Array(indices.length);
        for (let t = 0; t < indices.length; t += 3) {
          indices[t] = def.mesh.indices[t];
          indices[t + 1] = def.mesh.indices[t + 2];
          indices[t + 2] = def.mesh.indices[t + 1];
        }
      }
      into.push({ positions, indices });
    }
    for (const c of def.components) {
      // A pathless reference stays in the component's own file — ids are only
      // unique per file, which is why the key is the pair.
      collect(c.path ? normalizePath(c.path) : filePath, c.objectId, into, compose(m, c.transform), depth + 1);
    }
  };

  // ── build items: one part per item (build lives in the root file) ─────────
  const items = [...rootXml.matchAll(/<item\b([^>]*?)\/?>(?:<\/item>)?/g)]
    .map((m) => ({ objectId: attr(m[1], 'objectid'), path: pathAttr(m[1]), transform: parseTransform(attr(m[1], 'transform')) }))
    .filter((i): i is { objectId: string; path?: string; transform: Affine } => !!i.objectId);
  if (!items.length) throw new ImportError('3MF has no <build> items — nothing is placed in the scene');

  const parts: ImportedPart[] = [];
  const seenNames = new Map<string, number>();
  for (const item of items) {
    const itemFile = item.path ? normalizePath(item.path) : rootPath;
    const pieces: Array<{ positions: Float32Array; indices: Uint32Array }> = [];
    collect(itemFile, item.objectId, pieces, item.transform, 0);
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

    // Prefer the item object's own name; a nameless single-reference wrapper
    // (Bambu's usual root shape) borrows the name of what it points at.
    const itemDef = files.get(itemFile)?.get(item.objectId);
    const soleRef = itemDef?.components.length === 1 && !itemDef.mesh ? itemDef.components[0] : undefined;
    const base = itemDef?.name
      || (soleRef ? files.get(soleRef.path ? normalizePath(soleRef.path) : itemFile)?.get(soleRef.objectId)?.name : undefined)
      || `part-${parts.length + 1}`;
    const n = (seenNames.get(base) ?? 0) + 1;
    seenNames.set(base, n);
    parts.push({ name: n === 1 ? base : `${base}-${n}`, positions, indices });
  }
  if (!parts.length) throw new ImportError('3MF build items reference no meshes');

  return { parts, unitToMm, format: '3mf' };
}
