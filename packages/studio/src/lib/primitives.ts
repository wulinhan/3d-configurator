// Parts made from numbers instead of files: the four shapes a merchant
// reaches for when the product needs a plinth, a spacer or a decorative
// ring and opening a CAD package for a box would be absurd.
//
// Everything is generated straight into canonical space — millimetres,
// Y-up, sat on the ground, centred on X/Z — which is exactly where
// importModel leaves an uploaded file, so a generated part merges through
// the same door (mergeModel) as an imported one and nothing downstream can
// tell them apart. The viewer flat-shades by default, so curved shapes
// carry enough segments that their facets read as smooth.

import type { ImportedPart } from './types.ts';

export type PrimitiveKind = 'cuboid' | 'cylinder' | 'prism' | 'torus';

export interface PrimitiveSpec {
  kind: PrimitiveKind;
  /** X span for the cuboid; outer diameter for the round shapes. */
  widthMm: number;
  /** Y span (ignored by the torus, whose height is its tube). */
  heightMm: number;
  /** Z span — cuboid only. */
  depthMm: number;
  /** Flat sides — prism only (3..64). */
  sides: number;
  /** Tube diameter — torus only. */
  tubeMm: number;
}

export const PRIMITIVE_DEFAULTS: PrimitiveSpec = {
  kind: 'cuboid',
  widthMm: 60,
  heightMm: 20,
  depthMm: 60,
  sides: 6,
  tubeMm: 10,
};

const dim = (v: number, what: string): number => {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${what} must be a positive size`);
  return Math.min(v, 5000);
};

/** A capped prism around the Y axis: n flat sides for the n-gon, enough
 * sides (96) that the cylinder's facets vanish under flat shading. */
function prismMesh(name: string, sides: number, radius: number, height: number): ImportedPart {
  const n = Math.max(3, Math.min(64, Math.round(sides)));
  // ring verts (shared by wall and caps — flat shading recomputes per face,
  // so sharing costs nothing visually) + the two cap centres.
  const positions = new Float32Array((2 * n + 2) * 3);
  for (let i = 0; i < n; i++) {
    // Start at the top of the screen (−Z) so a flat side, not a corner,
    // faces the default camera — what you'd expect of a hex plinth.
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
    positions.set([x, 0, z], i * 3);
    positions.set([x, height, z], (n + i) * 3);
  }
  const bottomCentre = 2 * n, topCentre = 2 * n + 1;
  positions.set([0, 0, 0], bottomCentre * 3);
  positions.set([0, height, 0], topCentre * 3);

  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // wall quad, wound outward
    indices.push(i, n + i, j, j, n + i, n + j);
    // caps as fans; bottom faces −Y, top faces +Y
    indices.push(bottomCentre, i, j);
    indices.push(topCentre, n + j, n + i);
  }
  return { name, positions, indices: Uint32Array.from(indices) };
}

function torusMesh(name: string, outerRadius: number, tubeRadius: number): ImportedPart {
  const R = outerRadius - tubeRadius; // centreline radius
  if (R <= 0) throw new Error('tube is thicker than the ring itself');
  const MAJ = 96, TUB = 32;
  const positions = new Float32Array(MAJ * TUB * 3);
  for (let i = 0; i < MAJ; i++) {
    const u = (i / MAJ) * Math.PI * 2;
    for (let j = 0; j < TUB; j++) {
      const v = (j / TUB) * Math.PI * 2;
      const r = R + Math.cos(v) * tubeRadius;
      // lying flat on the table: ring in the XZ plane, tube circle vertical,
      // grounded by lifting one tube radius.
      positions.set(
        [Math.cos(u) * r, Math.sin(v) * tubeRadius + tubeRadius, Math.sin(u) * r],
        (i * TUB + j) * 3,
      );
    }
  }
  const indices = new Uint32Array(MAJ * TUB * 6);
  let at = 0;
  for (let i = 0; i < MAJ; i++) {
    const i2 = (i + 1) % MAJ;
    for (let j = 0; j < TUB; j++) {
      const j2 = (j + 1) % TUB;
      const a = i * TUB + j, b = i2 * TUB + j, c = i2 * TUB + j2, d = i * TUB + j2;
      indices.set([a, d, c, a, c, b], at);
      at += 6;
    }
  }
  return { name, positions, indices };
}

export function primitivePart(spec: PrimitiveSpec): ImportedPart {
  switch (spec.kind) {
    case 'cuboid': {
      const w = dim(spec.widthMm, 'width') / 2;
      const d = dim(spec.depthMm, 'depth') / 2;
      const h = dim(spec.heightMm, 'height');
      const positions = new Float32Array([
        -w, 0, -d, w, 0, -d, w, 0, d, -w, 0, d,     // bottom ring
        -w, h, -d, w, h, -d, w, h, d, -w, h, d,     // top ring
      ]);
      const indices = Uint32Array.from([
        0, 1, 2, 0, 2, 3,       // bottom (−Y)
        4, 6, 5, 4, 7, 6,       // top (+Y)
        0, 4, 5, 0, 5, 1,       // −Z face
        2, 6, 7, 2, 7, 3,       // +Z face
        1, 5, 6, 1, 6, 2,       // +X face
        3, 7, 4, 3, 4, 0,       // −X face
      ]);
      return { name: 'cuboid', positions, indices };
    }
    case 'cylinder':
      return prismMesh('cylinder', 96, dim(spec.widthMm, 'diameter') / 2, dim(spec.heightMm, 'height'));
    case 'prism':
      return prismMesh(
        `${Math.max(3, Math.min(64, Math.round(spec.sides)))}-gon`,
        spec.sides, dim(spec.widthMm, 'diameter') / 2, dim(spec.heightMm, 'height'),
      );
    case 'torus':
      return torusMesh('torus', dim(spec.widthMm, 'diameter') / 2, dim(spec.tubeMm, 'tube') / 2);
  }
}
