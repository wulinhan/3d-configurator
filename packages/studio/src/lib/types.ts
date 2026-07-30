// Shared shape for everything the importers produce: plain triangle meshes in
// the source file's own coordinate space. Orientation into canonical space
// (mm, Y-up, ground-centred) happens after import, in one place, for every
// format alike.

export interface ImportedPart {
  name: string;
  positions: Float32Array; // xyz triples
  indices: Uint32Array;    // triangle list
}

export interface ImportedModel {
  parts: ImportedPart[];
  /** Multiplier that converts the file's units to millimetres (1 = already mm). */
  unitToMm: number;
  /** 'stl' | '3mf' | 'glb' — for messages, not behaviour. */
  format: string;
}

export class ImportError extends Error {}
