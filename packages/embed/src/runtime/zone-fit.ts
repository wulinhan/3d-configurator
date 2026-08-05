// Fit an image zone to a picked surface region.
//
// A zone placed from a click should CONFORM to the face under it: sit in
// the face's plane, align with the face's own edges (not the world axes —
// the part or its geometry may be rotated any which way), and open at the
// face's actual size. This module does that fit as pure geometry so it is
// testable headless: project the region into the zone's canonical in-plane
// basis, take the longest boundary edge as the face's principal direction,
// and measure the extents in that rotated frame.

type Vec3 = [number, number, number];

export interface ZoneFit {
  /** Centre of the fitted rectangle, in the same (part-local) space. */
  centre: Vec3;
  /** In-plane rotation of the face's principal edge vs the canonical basis
   * — becomes the zone's rotationDeg, so the frame runs with the edges. */
  angleDeg: number;
  widthMm: number;
  heightMm: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
};
const round1 = (v: number) => Math.round(v * 10) / 10;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The rectangle that hugs a picked coplanar region. `triangles` are the
 * region's triangles as local-space vertex triples; `normal` its outward
 * local normal (the zone's projection direction). Null when degenerate.
 */
export function fitZoneToRegion(triangles: Vec3[][], normal: Vec3): ZoneFit | null {
  const n = norm(normal);
  if (!triangles.length || (!n[0] && !n[1] && !n[2])) return null;
  // Canonical in-plane basis — the same convention the renderer, the glyph
  // placement and the Studio's handle overlay all build from the normal.
  const upRef: Vec3 = Math.abs(n[1]) < 0.99 ? [0, 1, 0] : [0, 0, -1];
  const x = norm(cross(upRef, n));
  const y = cross(n, x);

  // The plane offset along n is the region's CREST — the surface weld
  // tolerates a whisper of crowning, and a zone anchored to the average
  // height would sit half-buried in it.
  let planeW = -Infinity;
  for (const tri of triangles) {
    for (const p of tri) planeW = Math.max(planeW, dot(p, n));
  }
  // The weld can leak a triangle or two down a fillet where the first ring
  // still reads near-coplanar; those dip well below the crest and would
  // drag the rim (and the fitted extents) over the edge with them — the
  // one-corner "tail". Real crowning stays within the weld's tolerance, so
  // anything deeper than ~0.6mm below the crest is a leak, not the face.
  const flat = triangles.filter((tri) => tri.every((p) => dot(p, n) > planeW - 0.6));
  const region = flat.length ? flat : triangles;

  // Project every vertex into (u, v).
  const uv: Array<[number, number]> = [];
  for (const tri of region) {
    for (const p of tri) uv.push([dot(p, x), dot(p, y)]);
  }

  // Boundary edges: shared interior edges appear twice, the rim once. The
  // LONGEST rim edge is the face's principal direction — for rectangular
  // and chamfered faces that is a true side; for round faces any short rim
  // segment wins and the fit degrades gracefully to an axis-aligned box.
  const counts = new Map<string, [number, number, number, number]>();
  const pkey = (p: [number, number]) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
  for (let t = 0; t < uv.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = uv[t + e], b = uv[t + ((e + 1) % 3)];
      const key = [pkey(a), pkey(b)].sort().join('|');
      if (counts.has(key)) counts.delete(key);
      else counts.set(key, [a[0], a[1], b[0], b[1]]);
    }
  }
  let angle = 0, longest = 0;
  for (const [au, av, bu, bv] of counts.values()) {
    const len = Math.hypot(bu - au, bv - av);
    if (len <= longest) continue;
    longest = len;
    angle = Math.atan2(bv - av, bu - au);
  }
  // A direction, not an arrow: fold into (−90°, 90°] — and snap the near
  // misses, so tessellation noise never stores a -0.1° "rotation" on a
  // face that is simply straight.
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle <= -Math.PI / 2) angle += Math.PI;
  const snap = Math.PI / 180; // 1°
  if (Math.abs(angle) < snap) angle = 0;
  else if (Math.abs(angle - Math.PI / 2) < snap) angle = Math.PI / 2;

  // Extents in the rotated frame; centre mapped back out.
  const cos = Math.cos(angle), sin = Math.sin(angle);
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const [u, v] of uv) {
    const ur = u * cos + v * sin;
    const vr = -u * sin + v * cos;
    uMin = Math.min(uMin, ur); uMax = Math.max(uMax, ur);
    vMin = Math.min(vMin, vr); vMax = Math.max(vMax, vr);
  }
  const width = uMax - uMin, height = vMax - vMin;
  if (!(width > 1e-3) || !(height > 1e-3)) return null;
  const ucR = (uMin + uMax) / 2, vcR = (vMin + vMax) / 2;
  const uc = ucR * cos - vcR * sin;
  const vc = ucR * sin + vcR * cos;

  return {
    centre: [
      round3(x[0] * uc + y[0] * vc + n[0] * planeW),
      round3(x[1] * uc + y[1] * vc + n[1] * planeW),
      round3(x[2] * uc + y[2] * vc + n[2] * planeW),
    ],
    angleDeg: round1(angle * 180 / Math.PI),
    widthMm: Math.min(500, Math.max(1, round1(width))),
    heightMm: Math.min(500, Math.max(1, round1(height))),
  };
}
