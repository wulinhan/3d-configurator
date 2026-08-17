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
import { type EdgeChain, type V3, add3, sub3, scale, dot, cross, norm } from './edges.ts';

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
 * A part's mesh as a Manifold solid: welded, validated, and righted if it
 * arrives inside-out (projects imported while the orienter mis-counted
 * mirror parity carry inverted meshes — every boolean against one is
 * "outside", so flip it right way out; the treated part comes back
 * outward-wound, which is simply more correct).
 */
function solidFrom(wasm: Wasm, positions: Float32Array, indices: Uint32Array): Solid {
  const build = (tris: Uint32Array): Solid => {
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties: positions, triVerts: tris });
    mesh.merge();
    return new wasm.Manifold(mesh);
  };
  let solid: Solid;
  try {
    solid = build(indices);
  } catch {
    throw new ChamferError('This mesh is not watertight, so its edges cannot be rebuilt. Re-import it or repair it first.');
  }
  if (solid.isEmpty()) {
    solid.delete();
    throw new ChamferError('This mesh is not watertight, so its edges cannot be rebuilt. Re-import it or repair it first.');
  }
  if (solid.volume() < 0) {
    const flipped = new Uint32Array(indices);
    for (let t = 0; t < flipped.length; t += 3) {
      const tmp = flipped[t + 1]; flipped[t + 1] = flipped[t + 2]; flipped[t + 2] = tmp;
    }
    solid.delete();
    solid = build(flipped);
  }
  return solid;
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

  const solid = solidFrom(wasm, zUp, part.indices);
  try {
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

// ── Per-edge treatment (the Fusion-style picker's engine) ──────────────────
//
// Selected edge chains are treated one segment at a time: at every chain
// vertex the corner's cross-section profile is computed (a triangle for a
// chamfer, a fan of arc strips for a round-over), and each segment becomes
// the convex hulls bridging its two end profiles. Convex (outside) edges
// SUBTRACT their hulls; concave (valley) edges ADD theirs — the same code
// either way. Working directly in canonical Y-up space: booleans have no up.

export interface EdgeOpts {
  style: 'chamfer' | 'round';
  sizeMm: number;
}

const ARC_STEPS = 8;

interface Profile {
  /** The wedge apex: outside the corner for convex, inside for concave. */
  apex: V3;
  /** Contact points, corner first: A on face one, arc samples, B on face two. */
  rim: V3[];
}

/** The cross-section of the cut/fill at one chain vertex. */
function profileAt(p: V3, tangent: V3, nA: V3, nB: V3, convex: boolean, opts: EdgeOpts): Profile | null {
  // In-face directions away from the edge, each perpendicular to the walk.
  const pick = (n: V3, away: V3): V3 => {
    const u = norm(cross(n, tangent));
    const s = dot(u, away);
    if (Math.abs(s) < 1e-6) return u;
    return s > 0 ? scale(u, -1) : u;
  };
  const u1 = pick(nA, nB);
  const u2 = pick(nB, nA);
  const h = norm(add3(nA, nB));
  if (dot(u1, u1) < 0.5 || dot(u2, u2) < 0.5 || dot(h, h) < 0.5) return null;

  const alpha = Math.acos(Math.min(1, Math.max(-1, dot(u1, u2))));
  if (alpha < 0.08 || alpha > Math.PI - 0.03) return null; // knife edge / near-flat

  const size = opts.sizeMm;
  const depth = Math.max(0.3, size * 0.6);
  const apex = add3(p, scale(h, convex ? depth : -depth));

  if (opts.style === 'chamfer') {
    return { apex, rim: [add3(p, scale(u1, size)), add3(p, scale(u2, size))] };
  }

  // Round-over: circle of radius `size` tangent to both faces. Tangent
  // points sit d = r/tan(α/2) along each face; the centre q = r/sin(α/2)
  // along the bisector — inside the material for a convex edge, out in the
  // air for a concave one, both falling out of the same formula.
  const d = size / Math.tan(alpha / 2);
  const q = size / Math.sin(alpha / 2);
  const w = norm(add3(u1, u2));
  const c = add3(p, scale(w, q));
  const A = add3(p, scale(u1, d));
  const B = add3(p, scale(u2, d));
  const v1 = sub3(A, c), v2 = sub3(B, c);
  const beta = Math.acos(Math.min(1, Math.max(-1, dot(norm(v1), norm(v2)))));
  const rim: V3[] = [];
  for (let i = 0; i <= ARC_STEPS; i++) {
    const t = i / ARC_STEPS;
    // slerp between the two radius vectors
    const s0 = Math.sin((1 - t) * beta), s1 = Math.sin(t * beta);
    const v = beta < 1e-4 ? v1 : norm(add3(scale(v1, s0), scale(v2, s1)));
    rim.push(add3(c, scale(v, size)));
  }
  return { apex, rim };
}

/**
 * Treat exactly the SELECTED edge chains of a part. Throws ChamferError
 * with a reason a merchant can act on — the UI surfaces it as a toast.
 */
export async function chamferEdges(
  part: ImportedPart,
  chains: EdgeChain[],
  chainIds: string[],
  opts: EdgeOpts,
): Promise<ImportedPart> {
  if (opts.sizeMm <= 0) throw new ChamferError('Edge size must be above zero.');
  const picked = chains.filter((c) => chainIds.includes(c.id));
  if (!picked.length) throw new ChamferError('Select at least one edge first.');

  const wasm = await manifold();
  const solid = solidFrom(wasm, part.positions, part.indices);
  const cutters: Solid[] = [];
  const fillers: Solid[] = [];

  try {
    for (const chain of picked) {
      const segs = chain.segs;
      const count = segs.length;
      // Per-vertex tangent and side normals, averaged across the two
      // adjacent segments so neighbouring hulls share an identical
      // cross-section — the union stays gap-free along a curved rim.
      const points = chain.closed ? count : count + 1;
      const profiles: (Profile | null)[] = [];
      for (let i = 0; i < points; i++) {
        const prev = chain.closed ? segs[(i - 1 + count) % count] : segs[i - 1];
        const next = chain.closed ? segs[i % count] : segs[i];
        const at: V3 = next ? next.a : prev.b;
        let tangent: V3 = [0, 0, 0];
        let nA: V3 = [0, 0, 0];
        let nB: V3 = [0, 0, 0];
        for (const s of [prev, next]) {
          if (!s) continue;
          tangent = add3(tangent, norm(sub3(s.b, s.a)));
          nA = add3(nA, s.n1);
          nB = add3(nB, s.n2);
        }
        // Open chains end at corners other edges own — nudge the end
        // profiles a whisker outward so the cut runs fully through.
        let p = at;
        if (!chain.closed && (i === 0 || i === points - 1)) {
          p = add3(at, scale(norm(tangent), i === 0 ? -0.05 : 0.05));
        }
        profiles.push(profileAt(p, norm(tangent), norm(nA), norm(nB), segs[0].convex, opts));
      }

      for (let i = 0; i < count; i++) {
        const p0 = profiles[i];
        const p1 = profiles[chain.closed ? (i + 1) % points : i + 1];
        if (!p0 || !p1) continue;
        const strips = Math.min(p0.rim.length, p1.rim.length) - 1;
        for (let j = 0; j < strips; j++) {
          try {
            const hull = wasm.Manifold.hull([
              p0.apex, p0.rim[j], p0.rim[j + 1],
              p1.apex, p1.rim[j], p1.rim[j + 1],
            ]);
            if (hull.isEmpty()) { hull.delete(); continue; }
            (segs[i].convex ? cutters : fillers).push(hull);
          } catch { /* degenerate sliver — skip the strip */ }
        }
      }
    }

    if (!cutters.length && !fillers.length) {
      throw new ChamferError('These edges are too irregular to treat — try different edges.');
    }

    let result = solid;
    if (fillers.length) {
      result = wasm.Manifold.union([result, ...fillers]);
    }
    if (cutters.length) {
      const cut = cutters.length > 1 ? wasm.Manifold.union(cutters) : cutters[0];
      const next = wasm.Manifold.difference(result, cut);
      if (cutters.length > 1) cut.delete();
      if (result !== solid) result.delete();
      result = next;
    }

    const clean = result.simplify(0.002);
    if (result !== solid) result.delete();
    try {
      if (clean.isEmpty()) {
        throw new ChamferError('That size removes the whole part — try a smaller size.');
      }
      const pieces = clean.decompose();
      const n = pieces.length;
      for (const piece of pieces) piece.delete();
      if (n > 1) {
        throw new ChamferError(`That size cuts the part into ${n} pieces — try a smaller size.`);
      }
      const mesh = clean.getMesh();
      return {
        name: part.name,
        positions: new Float32Array(mesh.vertProperties),
        indices: Uint32Array.from(mesh.triVerts),
      };
    } finally {
      clean.delete();
    }
  } finally {
    solid.delete();
    for (const s of [...cutters, ...fillers]) { try { s.delete(); } catch { /* consumed */ } }
  }
}
