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
  /**
   * The face's actual rim as zone-frame points (u across, v up, origin at
   * the zone centre), present when the face is NOT simply the fitted
   * rectangle — rounded corners, chamfers, circles. Becomes the zone's
   * boundary, so the image is masked to the true shape of the surface.
   */
  outline?: Array<[number, number]>;
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

  // Is the face actually its bounding rectangle? Compare areas: a rounded
  // or chamfered face fills measurably less than its box, and then the rim
  // itself becomes the zone's mask.
  let area = 0;
  for (let t = 0; t < uv.length; t += 3) {
    const [au, av] = uv[t], [bu, bv] = uv[t + 1], [cu2, cv2] = uv[t + 2];
    area += Math.abs((bu - au) * (cv2 - av) - (cu2 - au) * (bv - av)) / 2;
  }
  let outline: Array<[number, number]> | undefined;
  if (area < width * height * 0.985) {
    let loop = walkLoop([...counts.values()]);
    if (loop && loop.length >= 3) {
      // Canonicalise the ring — consistent winding, fixed starting point —
      // so the same face always yields the same anchors whichever triangle
      // happened to seed the weld ("Reset shape" must reproduce placement).
      let area2 = 0;
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        area2 += a[0] * b[1] - b[0] * a[1];
      }
      if (area2 < 0) loop = [...loop].reverse();
      let s = 0;
      for (let i = 1; i < loop.length; i++) {
        if (loop[i][0] < loop[s][0] - 1e-9
          || (Math.abs(loop[i][0] - loop[s][0]) < 1e-9 && loop[i][1] < loop[s][1])) s = i;
      }
      loop = [...loop.slice(s), ...loop.slice(0, s)];
      // Into the zone frame (rotate by −angle about the rect centre), with
      // a 1% inset so the smoothed curve stays inside the true rim.
      const zoneFrame = loop.map(([u, v]): [number, number] => {
        const du = u * cos + v * sin - ucR;
        const dv = -u * sin + v * cos - vcR;
        return [du * 0.99, dv * 0.99];
      });
      outline = outlineAnchors(zoneFrame, Math.max(width, height))
        .map(([u, v]): [number, number] => [round1(u), round1(v)]);
      if (outline.length < 3 || outline.length > 32) outline = undefined;
    }
  }

  return {
    centre: [
      round3(x[0] * uc + y[0] * vc + n[0] * planeW),
      round3(x[1] * uc + y[1] * vc + n[1] * planeW),
      round3(x[2] * uc + y[2] * vc + n[2] * planeW),
    ],
    angleDeg: round1(angle * 180 / Math.PI),
    widthMm: Math.min(500, Math.max(1, round1(width))),
    heightMm: Math.min(500, Math.max(1, round1(height))),
    ...(outline ? { outline } : {}),
  };
}

/** Chain boundary edges into the region's rim polygon (the longest loop
 * when there are several — holes stay holes). Null when the rim is torn. */
function walkLoop(edges: Array<[number, number, number, number]>): Array<[number, number]> | null {
  const key = (u: number, v: number) => `${Math.round(u * 1000)},${Math.round(v * 1000)}`;
  const byPoint = new Map<string, Array<{ to: string; toPt: [number, number]; used: boolean }>>();
  const at = (k: string, pt: [number, number], to: string, toPt: [number, number]) => {
    const list = byPoint.get(k) ?? [];
    list.push({ to, toPt, used: false });
    byPoint.set(k, list);
  };
  for (const [au, av, bu, bv] of edges) {
    const ka = key(au, av), kb = key(bu, bv);
    at(ka, [au, av], kb, [bu, bv]);
    at(kb, [bu, bv], ka, [au, av]);
  }
  let best: Array<[number, number]> | null = null;
  for (const [start, outs] of byPoint) {
    for (const first of outs) {
      if (first.used) continue;
      const loop: Array<[number, number]> = [first.toPt];
      first.used = true;
      // Retire the reverse half-edge too, or the walk bounces straight back.
      const firstRev = (byPoint.get(first.to) ?? []).find((e) => !e.used && e.to === start);
      if (firstRev) firstRev.used = true;
      let atKey = first.to;
      let guard = edges.length + 2;
      while (atKey !== start && guard-- > 0) {
        const nexts = byPoint.get(atKey) ?? [];
        const step = nexts.find((e) => !e.used && e.to !== key(...loop[loop.length - 2] ?? [NaN, NaN]));
        const chosen = step ?? nexts.find((e) => !e.used);
        if (!chosen) break;
        chosen.used = true;
        // Also retire the reverse half-edge so the walk never doubles back.
        const rev = (byPoint.get(chosen.to) ?? []).find((e) => !e.used && e.to === atKey);
        if (rev) rev.used = true;
        loop.push(chosen.toPt);
        atKey = chosen.to;
      }
      if (atKey === start && loop.length >= 3 && (!best || loop.length > best.length)) best = loop;
    }
  }
  return best;
}

/**
 * Turn the raw rim polygon into boundary anchors that keep the SHAPE.
 *
 * Two failure modes bracket this problem. Uniform resampling + smoothing
 * follows tessellation zigzag or, smoothed, CONTRACTS the loop — corners
 * melt and the veil reads far rounder than the face. Aggressive
 * corner-preserving simplification leaves long straights against short
 * corner chords, and the uniform Catmull-Rom the boundary renders with
 * kinks at exactly those spacing jumps. So: simplify with a SMALL
 * tolerance (drops tessellation noise, keeps the corner arcs' own
 * points), then split any long chord so spacing stays balanced and the
 * curve cannot kink. No smoothing pass — nothing contracts.
 */
function outlineAnchors(loop: Array<[number, number]>, maxDim: number): Array<[number, number]> {
  // Ramer-Douglas-Peucker on an open run.
  const dp = (pts: Array<[number, number]>, tol: number): Array<[number, number]> => {
    if (pts.length <= 2) return pts;
    const [ax, ay] = pts[0];
    const [bx, by] = pts[pts.length - 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let worst = 0, at = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst <= tol) return [pts[0], pts[pts.length - 1]];
    const left = dp(pts.slice(0, at + 1), tol);
    return [...left.slice(0, -1), ...dp(pts.slice(at), tol)];
  };
  const dpClosed = (pts: Array<[number, number]>, tol: number): Array<[number, number]> => {
    // Split the ring at its two most distant points so DP sees open runs.
    let aIdx = 0, far = -1;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
      if (d > far) { far = d; aIdx = i; }
    }
    let bIdx = 0; far = -1;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[aIdx][0], pts[i][1] - pts[aIdx][1]);
      if (d > far) { far = d; bIdx = i; }
    }
    const [lo, hi] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
    const half1 = pts.slice(lo, hi + 1);
    const half2 = [...pts.slice(hi), ...pts.slice(0, lo + 1)];
    return [...dp(half1, tol).slice(0, -1), ...dp(half2, tol).slice(0, -1)];
  };

  // Small tolerance: above the tessellation noise, below the corner arcs.
  let tol = Math.max(0.05, maxDim * 0.004);
  let pts = dpClosed(loop, tol);
  for (let i = 0; i < 5 && pts.length > 28; i++) {
    tol *= 1.7;
    pts = dpClosed(loop, tol);
  }
  if (pts.length < 3) return pts;

  // Balance the spacing: split chords much longer than the median so the
  // uniform Catmull-Rom never sees a spacing cliff at a corner.
  const chord = (i: number) => {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  };
  const sorted = pts.map((_, i) => chord(i)).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    out.push(a);
    const len = chord(i);
    const splits = Math.min(4, Math.floor(len / (2.5 * median)));
    for (let k = 1; k <= splits && out.length < 32; k++) {
      const t = k / (splits + 1);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    if (out.length >= 32) break;
  }
  return out;
}
