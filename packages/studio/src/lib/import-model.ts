// Entry point for an uploaded file: sniff the format, parse, orient into
// canonical space (mm, Y-up, ground-centred), ready for manifest-init.
//
// Detection is by content, not filename — merchants rename things, and a zip
// magic number doesn't lie.

import { importStl } from './import-stl.ts';
import { import3mf } from './import-3mf.ts';
import { importGlb } from './import-glb.ts';
import { ImportError, type ImportedModel, type ImportedPart } from './types.ts';
// The embed's orienter is plain ESM with no node dependencies — one
// implementation of "what canonical space means" for pipeline and Studio.
// @ts-ignore — plain-JS module without declarations
import { orientParts } from '../../../embed/tools/orient.mjs';

export const AXIS_PRESETS = [
  { id: 'y-up', label: 'Y up (glTF standard)', axes: 'x,y,z' },
  { id: 'z-up', label: 'Z up (3D printing / CAD)', axes: 'x,z,-y' },
  { id: 'tap-legacy', label: 'Tap Bar legacy (y,z,x)', axes: 'y,z,x' },
] as const;

export function detectFormat(bytes: Uint8Array): 'glb' | '3mf' | 'stl' {
  if (bytes.length > 4) {
    const magic = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
    if (magic === 0x46546c67) return 'glb';
  }
  if (bytes.length > 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return '3mf'; // zip
  return 'stl';
}

export function parseModel(bytes: Uint8Array): ImportedModel {
  switch (detectFormat(bytes)) {
    case 'glb': return importGlb(bytes);
    case '3mf': return import3mf(bytes);
    case 'stl': return importStl(bytes);
  }
}

/**
 * Guarantee every part a non-empty, unique name. Idempotent.
 *
 * The manifest's `mesh: "model#<name>"` references must match the GLB's mesh
 * names byte for byte, and the viewer keys geometry by name — a duplicate
 * silently binds two parts to one mesh. Both the manifest and the published
 * GLB are built from this same array, so normalising once here keeps them
 * agreeing by construction.
 */
export function normalizeParts(parts: ImportedPart[]): ImportedPart[] {
  const seen = new Map<string, number>();
  return parts.map((part, i) => {
    const base = part.name.trim() || `part-${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? { ...part, name: base } : { ...part, name: `${base}-${n}` };
  });
}

export interface OrientedModel {
  parts: ImportedPart[];
  bounds: { min: number[]; max: number[] };
  format: string;
  unitToMm: number;
}

/**
 * Parse + orient in one step. `axes` names which way the file is up (see
 * AXIS_PRESETS); `unitToMm` overrides the file's own claim when the merchant
 * corrects it in the UI.
 */
export function importModel(bytes: Uint8Array, opts: { axes?: string; unitToMm?: number } = {}): OrientedModel {
  const model = parseModel(bytes);
  const unitToMm = opts.unitToMm ?? model.unitToMm;
  if (!Number.isFinite(unitToMm) || unitToMm <= 0) throw new ImportError(`bad unit scale ${unitToMm}`);
  const oriented = orientParts(normalizeParts(model.parts), { axes: opts.axes ?? 'x,y,z', scaleToMm: unitToMm });
  return { parts: oriented.parts, bounds: oriented.bounds, format: model.format, unitToMm };
}
