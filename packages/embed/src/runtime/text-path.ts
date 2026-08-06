// The open smooth curve behind a text slot's freeform baseline.
//
// Merchants drag anchor points in the slot's sketch plane; the baseline is
// the OPEN Catmull-Rom spline through them (ends clamped), expressed as
// cubic Bézier segments — the same uniform Catmull-Rom → Bézier conversion
// the image-zone boundary once used, minus the closing segment. Both the
// Studio's handle overlay and the glyph layout call this module, so what
// the merchant shapes is exactly the curve the letters walk.

export type Pt = [number, number];

export interface CurveSegment { p0: Pt; c1: Pt; c2: Pt; p1: Pt }

/** The open curve through `points`, one cubic Bézier per consecutive pair.
 * End tangents are clamped (the missing neighbour is the endpoint itself),
 * so the curve starts and ends exactly on the outer anchors. */
export function openCurveSegments(points: Pt[]): CurveSegment[] {
  const n = points.length;
  if (n < 2) return [];
  const at = (i: number) => points[Math.max(0, Math.min(n - 1, i))];
  return points.slice(0, -1).map((_, i) => {
    const p0 = at(i), p1 = at(i + 1), before = at(i - 1), after = at(i + 2);
    const c1: Pt = [p0[0] + (p1[0] - before[0]) / 6, p0[1] + (p1[1] - before[1]) / 6];
    const c2: Pt = [p1[0] - (after[0] - p0[0]) / 6, p1[1] - (after[1] - p0[1]) / 6];
    return { p0, c1, c2, p1 };
  });
}

/** A point along one segment, t in [0, 1] (de Casteljau, expanded). */
export function curvePoint(seg: CurveSegment, t: number): Pt {
  const u = 1 - t;
  const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
  return [
    w0 * seg.p0[0] + w1 * seg.c1[0] + w2 * seg.c2[0] + w3 * seg.p1[0],
    w0 * seg.p0[1] + w1 * seg.c1[1] + w2 * seg.c2[1] + w3 * seg.p1[1],
  ];
}

export interface PathWalk {
  /** Total arc length, mm. */
  length: number;
  /** The point and tangent angle at arc length `s`. Beyond the ends the
   * walk extends STRAIGHT along the end tangent, so text longer than the
   * drawn curve overruns predictably instead of bunching. */
  at(s: number): { point: Pt; angleRad: number };
}

/**
 * Arc-length parameterisation of the open curve: the spline is sampled
 * densely into a polyline (32 steps per span — well under a tenth of a
 * millimetre of sag at glyph scale) with cumulative lengths, and stations
 * are found by lookup + linear interpolation. Null when the anchors carry
 * no length to walk (fewer than 2, or all coincident).
 */
export function walkPath(points: Pt[], stepsPerSeg = 32): PathWalk | null {
  const segs = openCurveSegments(points);
  if (!segs.length) return null;
  const pts: Pt[] = [segs[0].p0];
  for (const seg of segs) {
    for (let k = 1; k <= stepsPerSeg; k++) pts.push(curvePoint(seg, k / stepsPerSeg));
  }
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const length = cum[cum.length - 1];
  if (!(length > 1e-6)) return null;

  const between = (i: number, j: number): Pt => {
    const d: Pt = [pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]];
    const len = Math.hypot(d[0], d[1]) || 1;
    return [d[0] / len, d[1] / len];
  };
  // First/last stretch with actual length — coincident samples at a clamped
  // end would otherwise yield a zero tangent.
  const dirFrom = (i: number, step: number): Pt => {
    for (let j = i + step; j >= 0 && j < pts.length; j += step) {
      if (Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]) > 1e-9) {
        return step > 0 ? between(i, j) : between(j, i);
      }
    }
    return [1, 0];
  };

  return {
    length,
    at(s: number) {
      if (s <= 0) {
        const d = dirFrom(0, +1);
        return { point: [pts[0][0] + d[0] * s, pts[0][1] + d[1] * s], angleRad: Math.atan2(d[1], d[0]) };
      }
      if (s >= length) {
        const last = pts.length - 1;
        const d = dirFrom(last, -1);
        const over = s - length;
        return { point: [pts[last][0] + d[0] * over, pts[last][1] + d[1] * over], angleRad: Math.atan2(d[1], d[0]) };
      }
      // Binary search the cumulative table for the covering sample pair.
      let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= s) lo = mid; else hi = mid;
      }
      const span = cum[hi] - cum[lo] || 1;
      const t = (s - cum[lo]) / span;
      const d = between(lo, hi);
      return {
        point: [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t],
        angleRad: Math.atan2(d[1], d[0]),
      };
    },
  };
}
