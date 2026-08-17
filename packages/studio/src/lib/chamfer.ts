// Edge treatment for a finished part: cut a flat chamfer or roll a round-over
// along its top and/or bottom printed edges. Runs on the Manifold kernel, so
// the result is watertight by construction — the same guarantee the exporters
// lean on.
//
// The approach is slicing, not edge-finding: the treated band (the top
// `sizeMm` of the part, say) is rebuilt as a stack of thin layers, each one
// the part's OWN cross-section at that height inset by the profile — a
// straight line of insets for a chamfer, a quarter-circle for a round-over.
// The untreated middle is kept exactly (an intersection with a slab, not a
// re-mesh). Because every layer slices the real solid, this handles hollow
// parts, text, holes and slanted walls alike: inner rims ease over just like
// outer ones, and a wall thinner than the inset simply vanishes into the
// bevel — the same thing a physical router bit would do.

import { manifold } from './manifold.ts';
import type { ImportedPart } from './types.ts';

export interface ChamferOpts {
  /** 'chamfer' — flat 45° bevel. 'round' — quarter-circle round-over. */
  style: 'chamfer' | 'round';
  edges: 'top' | 'bottom' | 'both';
  /** The bevel's height and depth in mm (a 45° profile is symmetric). */
  sizeMm: number;
}

export class ChamferError extends Error {}

// Layer thickness of the band approximation. 0.25 mm matches a typical
// print's own layer height, so the stair-steps disappear under the printer's.
const LAYER_MM = 0.25;
const MIN_LAYERS = 4;
const MAX_LAYERS = 24;

/** Inset from the wall at height `t` into the band (0 at band start). */
const insetAt = (style: ChamferOpts['style'], t: number, size: number) =>
  style === 'chamfer' ? t : size - Math.sqrt(Math.max(0, size * size - t * t));

/**
 * The band rebuilt as thin extrusions. `zStart` is where the band leaves the
 * untouched middle; `direction` is +1 building up (top edge) or −1 building
 * down (bottom edge). Empty slices are skipped — a dome that tapers away
 * before the band ends just ends there.
 */
type Wasm = Awaited<ReturnType<typeof manifold>>;
type Solid = InstanceType<Wasm['Manifold']>;

function bandLayers(
  wasm: Wasm, solid: Solid, opts: ChamferOpts, zStart: number, direction: 1 | -1,
): Solid[] {
  const layers = Math.min(MAX_LAYERS, Math.max(MIN_LAYERS, Math.round(opts.sizeMm / LAYER_MM)));
  const dz = opts.sizeMm / layers;
  const out: Solid[] = [];
  for (let i = 0; i < layers; i++) {
    // Slice at the layer's middle-side face, inset by the profile at its
    // far face — the stair always sits inside the ideal surface, so the
    // outermost face genuinely reaches the full inset.
    const zNear = zStart + direction * i * dz;
    const inset = insetAt(opts.style, (i + 1) * dz, opts.sizeMm);
    const cross = solid.slice(zNear);
    try {
      if (cross.isEmpty()) continue;
      // Simplify after offset (the kernel's own advice): the rounding join
      // sprinkles micro-segments that would otherwise stack up over the
      // dozens of layers and survive as zero-area slivers in the union.
      const shrunk = cross.offset(-inset, 'Round').simplify(1e-4);
      try {
        if (shrunk.isEmpty()) continue;
        const layer = shrunk.extrude(dz)
          .translate(0, 0, direction === 1 ? zNear : zNear - dz);
        out.push(layer);
      } finally {
        shrunk.delete();
      }
    } finally {
      cross.delete();
    }
  }
  return out;
}

/**
 * The core, in Manifold's Z-up frame: keep the middle exactly, rebuild the
 * treated bands, union. Throws ChamferError when the size doesn't fit the
 * part or the mesh can't be made watertight.
 */
function chamferSolid(wasm: Wasm, solid: Solid, opts: ChamferOpts): Solid {
  const box = solid.boundingBox();
  const [xMin, yMin, zMin] = box.min;
  const [xMax, yMax, zMax] = box.max;
  const height = zMax - zMin;
  const budget = opts.edges === 'both' ? opts.sizeMm * 2 : opts.sizeMm;
  if (opts.sizeMm <= 0) throw new ChamferError('Edge size must be above zero.');
  if (budget >= height - 0.05) {
    throw new ChamferError(
      `Edge size is too large — this part is ${height.toFixed(1)} mm tall, so ` +
      `${opts.edges === 'both' ? 'each edge' : 'the edge'} can take at most ` +
      `${((height - 0.05) / (opts.edges === 'both' ? 2 : 1)).toFixed(1)} mm.`);
  }

  const midLo = opts.edges === 'top' ? zMin : zMin + opts.sizeMm;
  const midHi = opts.edges === 'bottom' ? zMax : zMax - opts.sizeMm;
  const pad = 1;
  const slab = wasm.Manifold.cube([xMax - xMin + pad * 2, yMax - yMin + pad * 2, midHi - midLo], false)
    .translate(xMin - pad, yMin - pad, midLo);
  const middle = wasm.Manifold.intersection(solid, slab);
  slab.delete();

  const pieces: Solid[] = [middle];
  if (opts.edges !== 'bottom') pieces.push(...bandLayers(wasm, solid, opts, midHi, 1));
  if (opts.edges !== 'top') pieces.push(...bandLayers(wasm, solid, opts, midLo, -1));

  const merged = wasm.Manifold.union(pieces as Parameters<Wasm['Manifold']['union']>[0]);
  for (const p of pieces) p.delete();
  // The union of dozens of thin coplanar layers leaves slivers thinner than
  // float32 can represent — degenerate once written out. 2 µm is far below
  // anything a printer resolves and collapses them all.
  const clean = merged.simplify(0.002);
  merged.delete();
  if (clean.isEmpty()) {
    clean.delete();
    throw new ChamferError('The edge treatment removed the whole part — try a smaller size.');
  }
  return clean;
}

/**
 * Apply the edge treatment to a part's mesh. Studio meshes are Y-up;
 * Manifold slices normal to Z, so the mesh rotates +90° about X on the way
 * in — (x, y, z) → (x, −z, y) — and back on the way out. "Top" and
 * "bottom" therefore mean what the merchant sees on screen.
 */
export async function chamferPart(part: ImportedPart, opts: ChamferOpts): Promise<ImportedPart> {
  const wasm = await manifold();
  const p = part.positions;
  const zUp = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    zUp[i] = p[i];
    zUp[i + 1] = -p[i + 2];
    zUp[i + 2] = p[i + 1];
  }

  const build = (indices: Uint32Array): Solid => {
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties: zUp, triVerts: indices });
    mesh.merge();
    return new wasm.Manifold(mesh);
  };
  let solid: Solid;
  try {
    solid = build(part.indices);
  } catch {
    throw new ChamferError('This mesh is not watertight, so its edges cannot be rebuilt. Re-import it or repair it first.');
  }
  try {
    if (solid.isEmpty()) {
      throw new ChamferError('This mesh is not watertight, so its edges cannot be rebuilt. Re-import it or repair it first.');
    }
    // Negative volume = the mesh is inside-out. Projects imported while the
    // orienter mis-counted mirror parity carry these; every slice of an
    // inverted solid is "outside", so flip it right way out first — the
    // treated part comes back outward-wound, which is simply more correct.
    if (solid.volume() < 0) {
      const flipped = new Uint32Array(part.indices);
      for (let t = 0; t < flipped.length; t += 3) {
        const tmp = flipped[t + 1]; flipped[t + 1] = flipped[t + 2]; flipped[t + 2] = tmp;
      }
      solid.delete();
      solid = build(flipped);
    }
    const treated = chamferSolid(wasm, solid, opts);
    try {
      const mesh = treated.getMesh();
      const v = mesh.vertProperties;
      const positions = new Float32Array(v.length);
      for (let i = 0; i < v.length; i += 3) {
        positions[i] = v[i];
        positions[i + 1] = v[i + 2];
        positions[i + 2] = -v[i + 1];
      }
      return { name: part.name, positions, indices: Uint32Array.from(mesh.triVerts) };
    } finally {
      treated.delete();
    }
  } finally {
    solid.delete();
  }
}
