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
  /** Ordered polyline in raw mesh space, lifted ~0.15 mm off the surface
   * along the corner bisector so the display line never z-fights the faces. */
  displayPoints: Float32Array;
  closed: boolean;
  lengthMm: number;
  segs: EdgeSeg[];
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
  interface Feature { u: number; v: number; n1: V3; n2: V3; convex: boolean }
  const features: Feature[] = [];
  const featureAt = new Map<number, number[]>(); // vertex -> feature indices
  for (const [key, he] of half) {
    const [u, v] = key.split('>').map(Number);
    if (u > v) continue; // visit each undirected edge once
    const twin = half.get(`${v}>${u}`);
    if (!twin) continue;
    const n1 = normals[he.face], n2 = normals[twin.face];
    if (dot(n1, n2) >= minDot) continue;
    // Convex iff the winding direction (as face 1 owns it) agrees with
    // n1 × n2 — verified against a cube (all convex) in the tests.
    const dir = norm(sub3(verts[v], verts[u]));
    const convex = dot(cross(n1, n2), dir) > 0;
    const idx = features.length;
    features.push({ u, v, n1, n2, convex });
    for (const w of [u, v]) {
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

  const nextOf = (f: number, at: number): number | null => {
    const here = featureAt.get(at) ?? [];
    if (here.length !== 2) return null;
    const n = here[0] === f ? here[1] : here[0];
    if (used.has(n)) return null;
    if (features[n].convex !== features[f].convex) return null;
    const into = segDir(features[f], other(features[f], at)); // arriving direction
    const out = segDir(features[n], at);
    return dot(into, out) > Math.SQRT1_2 ? n : null; // < 45° turn
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
    for (const s of segs) lengthMm += Math.hypot(...sub3(s.b, s.a));

    // Display polyline: each path vertex lifted along the average corner
    // bisector of its adjacent segments.
    const pts = new Float32Array((path.length + (closed ? 1 : 0)) * 3);
    for (let i = 0; i < path.length; i++) {
      const near = segs.filter((_, j) => closed
        ? j === i || j === (i - 1 + segs.length) % segs.length
        : j === i || j === i - 1);
      let h: V3 = [0, 0, 0];
      for (const s of near) h = add3(h, add3(s.n1, s.n2));
      const lift = scale(norm(h), 0.15);
      const p = add3(verts[path[i]], lift);
      pts.set(p, i * 3);
    }
    if (closed) pts.set(pts.slice(0, 3), path.length * 3);

    chains.push({ id: `e${chains.length}`, displayPoints: pts, closed, lengthMm, segs });
  }

  // Longest first: the edges someone most likely wants sit at the top of
  // any listing, and ids stay stable for a given mesh.
  chains.sort((a, b) => b.lengthMm - a.lengthMm);
  chains.forEach((c, i) => { c.id = `e${i}`; });
  return chains;
}
