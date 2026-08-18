// Feature-edge detection for the Edges tool: find the SHARP edges of a
// mesh (where two faces meet at a real angle), then chain collinear-enough
// segments into the edges a person would name — a box has twelve, a
// cylinder has its two rims (the wall facets meet at ~4° and stay out).
// Chains are what the viewer highlights, the merchant clicks, and the
// chamfer maths cuts along.
//
// Everything works on the raw mesh in canonical space (mm, Y-up). Vertices
// are welded by exact coordinate first, so a triangle-soup import chains
// just like an indexed mesh.

export type V3 = [number, number, number];

export interface EdgeSeg {
  a: V3;
  b: V3;
  /** Outward normal of the face on each side, at this segment. */
  n1: V3;
  n2: V3;
  /** True for an outside corner (material inside the wedge), false for an
   * inside one (a valley — treating it ADDS material). */
  convex: boolean;
}

export interface EdgeChain {
  id: string;
  /** Ordered polyline in raw mesh space, exactly on the edge — the viewer
   * centres a thin tube on it, whose visible quarter hugs the corner. */
  displayPoints: Float32Array;
  closed: boolean;
  lengthMm: number;
  segs: EdgeSeg[];
  /** Length-weighted overall direction — ~zero for a closed ring. What
   * "select similar" compares to find the parallel brothers of an edge. */
  dir: V3;
  /** Length-weighted midpoint — how an edge AMENDMENT refinds its edges
   * after the mesh around them was rebuilt by an earlier amendment. */
  centroid: V3;
}

export const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/** Sharp edges of the mesh, chained into selectable runs. */
export function featureEdges(
  positions: Float32Array,
  indices: Uint32Array,
  angleDeg = 25,
): EdgeChain[] {
  // Weld by exact coordinate so soups and indexed meshes read the same.
  const vid = new Map<string, number>();
  const verts: V3[] = [];
  const remap = new Uint32Array(positions.length / 3);
  for (let i = 0; i < positions.length / 3; i++) {
    const p: V3 = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const k = `${p[0]},${p[1]},${p[2]}`;
    let id = vid.get(k);
    if (id === undefined) { id = verts.length; vid.set(k, id); verts.push(p); }
    remap[i] = id;
  }

  // Face normals, and each directed edge's owning face.
  interface HalfEdge { face: number; from: number; to: number }
  const normals: V3[] = [];
  const half = new Map<string, HalfEdge>(); // "from>to" as wound
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    const n = norm(cross(sub3(verts[b], verts[a]), sub3(verts[c], verts[a])));
    const face = normals.length;
    normals.push(n);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      half.set(`${u}>${v}`, { face, from: u, to: v });
    }
  }

  // A feature segment: the two faces across an edge disagree by more than
  // the threshold. Only clean two-sided edges qualify — a boundary or a
  // non-manifold fan is not something a chamfer can follow.
  const minDot = Math.cos((angleDeg * Math.PI) / 180);
  interface Feature { u: number; v: number; n1: V3; n2: V3; convex: boolean; rA: number; rB: number }
  interface Raw { u: number; v: number; f1: number; f2: number; n1: V3; n2: V3; convex: boolean }
  const raws: Raw[] = [];
  // Union-find over faces: faces joined across every SMOOTH edge collapse
  // into surface regions (a barrel, a top disc, one octagon facet). A
  // feature edge then knows which region lies on each side — what lets a
  // chain follow an n-gon rim around its corners without leaking down a
  // vertical edge.
  const parent = normals.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const [key, he] of half) {
    const [u, v] = key.split('>').map(Number);
    if (u > v) continue; // visit each undirected edge once
    const twin = half.get(`${v}>${u}`);
    if (!twin) continue;
    const n1 = normals[he.face], n2 = normals[twin.face];
    if (dot(n1, n2) >= minDot) {
      parent[find(he.face)] = find(twin.face);
      continue;
    }
    // Convex iff the winding direction (as face 1 owns it) agrees with
    // n1 × n2 — verified against a cube (all convex) in the tests.
    const dir = norm(sub3(verts[v], verts[u]));
    const convex = dot(cross(n1, n2), dir) > 0;
    raws.push({ u, v, f1: he.face, f2: twin.face, n1, n2, convex });
  }
  const features: Feature[] = [];
  const featureAt = new Map<number, number[]>(); // vertex -> feature indices
  for (const r of raws) {
    const idx = features.length;
    features.push({ u: r.u, v: r.v, n1: r.n1, n2: r.n2, convex: r.convex, rA: find(r.f1), rB: find(r.f2) });
    for (const w of [r.u, r.v]) {
      const list = featureAt.get(w) ?? [];
      list.push(idx);
      featureAt.set(w, list);
    }
  }

  // Chain: walk from any unvisited segment in both directions, continuing
  // only through vertices where exactly two feature edges meet at a gentle
  // turn (< 45°) with the same convexity — a cube corner (three edges)
  // breaks the chain, a cylinder rim (many gentle turns) runs right round.
  const used = new Set<number>();
  const chains: EdgeChain[] = [];
  const segDir = (f: Feature, from: number): V3 =>
    norm(from === f.u ? sub3(verts[f.v], verts[f.u]) : sub3(verts[f.u], verts[f.v]));
  const other = (f: Feature, w: number) => (w === f.u ? f.v : f.u);

  // Continue through a vertex when exactly ONE outgoing edge reads as the
  // same physical edge carrying on: same convexity, sharing a surface
  // region with the incoming edge, turning less than 75°. An octagon rim
  // turns 45° at each corner while sharing the top face all the way round
  // — one loop; a box corner turns 90° everywhere — twelve edges; the
  // vertical edge at that octagon corner fails the angle test and stays
  // its own edge.
  const COS_75 = Math.cos((75 * Math.PI) / 180);
  const shares = (a: Feature, b: Feature) =>
    a.rA === b.rA || a.rA === b.rB || a.rB === b.rA || a.rB === b.rB;
  const nextOf = (f: number, at: number): number | null => {
    const here = featureAt.get(at) ?? [];
    const into = segDir(features[f], other(features[f], at)); // arriving direction
    const fits = here.filter((n) => n !== f && !used.has(n)
      && features[n].convex === features[f].convex
      && shares(features[n], features[f])
      && dot(into, segDir(features[n], at)) > COS_75);
    return fits.length === 1 ? fits[0] : null;
  };

  for (let start = 0; start < features.length; start++) {
    if (used.has(start)) continue;
    used.add(start);
    // Ordered vertex path, and the feature per step.
    let path = [features[start].u, features[start].v];
    let steps = [start];
    // forward
    for (;;) {
      const n = nextOf(steps[steps.length - 1], path[path.length - 1]);
      if (n === null) break;
      used.add(n);
      steps.push(n);
      path.push(other(features[n], path[path.length - 1]));
    }
    let closed = false;
    if (path[path.length - 1] === path[0]) {
      closed = true;
      path = path.slice(0, -1);
    } else {
      // backward
      for (;;) {
        const n = nextOf(steps[0], path[0]);
        if (n === null) break;
        used.add(n);
        steps.unshift(n);
        path.unshift(other(features[n], path[0]));
      }
    }

    // Orient each step's n1 consistently with the walk (n1 = the face that
    // owns the walk-direction half-edge), so "side one" means the same
    // physical side all along the chain.
    const segs: EdgeSeg[] = steps.map((s, i) => {
      const f = features[s];
      const from = path[i], to = closed ? path[(i + 1) % path.length] : path[i + 1];
      const forward = f.u === from && f.v === to;
      return {
        a: verts[from], b: verts[to],
        n1: forward ? f.n1 : f.n2,
        n2: forward ? f.n2 : f.n1,
        convex: f.convex,
      };
    });

    let lengthMm = 0;
    let run: V3 = [0, 0, 0];
    let mid: V3 = [0, 0, 0];
    for (const s of segs) {
      const l = Math.hypot(...sub3(s.b, s.a));
      lengthMm += l;
      run = add3(run, sub3(s.b, s.a));
      mid = add3(mid, scale(add3(s.a, s.b), l / 2));
    }
    const dir = norm(run);
    const centroid: V3 = lengthMm > 0 ? scale(mid, 1 / lengthMm) : segs[0].a;

    // Display polyline: the exact edge. The tube the viewer draws is a
    // mesh, not a hairline, so there is nothing to z-fight — centring it
    // on the true corner is what makes the highlight SIT on the edge.
    const pts = new Float32Array((path.length + (closed ? 1 : 0)) * 3);
    for (let i = 0; i < path.length; i++) pts.set(verts[path[i]], i * 3);
    if (closed) pts.set(pts.slice(0, 3), path.length * 3);

    chains.push({ id: `e${chains.length}`, displayPoints: pts, closed, lengthMm, segs, dir, centroid });
  }

  // Longest first: the edges someone most likely wants sit at the top of
  // any listing, and ids stay stable for a given mesh.
  chains.sort((a, b) => b.lengthMm - a.lengthMm);
  chains.forEach((c, i) => { c.id = `e${i}`; });
  return chains;
}

/**
 * The "grab the whole family" gesture: given one chain, every chain that
 * reads as its sibling. For a straight edge that means the PARALLEL edges
 * of matching convexity and similar length — double-click one vertical of
 * an octagon and all eight answer. For a closed ring (whose net direction
 * is zero) it means the other rings of similar size — a cylinder's two
 * rims. Always includes the chain itself.
 */
export function similarChains(chains: EdgeChain[], id: string): string[] {
  const ref = chains.find((c) => c.id === id);
  if (!ref) return [id];
  const sameKind = (c: EdgeChain) =>
    c.segs[0]?.convex === ref.segs[0]?.convex
    && c.lengthMm > ref.lengthMm * 0.7 && c.lengthMm < ref.lengthMm * 1.45;
  const straight = Math.hypot(...ref.dir) > 0.5;
  const out = chains.filter((c) => {
    if (!sameKind(c)) return false;
    if (!straight) return c.closed === ref.closed && Math.hypot(...c.dir) <= 0.5;
    return Math.hypot(...c.dir) > 0.5 && Math.abs(dot(c.dir, ref.dir)) > 0.95;
  }).map((c) => c.id);
  return out.includes(id) ? out : [id, ...out];
}
