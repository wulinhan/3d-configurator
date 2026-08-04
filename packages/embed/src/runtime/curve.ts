// The closed smooth curve behind an image zone's reshapeable boundary.
//
// Merchants drag anchor points; the boundary is the closed Catmull-Rom
// spline through them, expressed as cubic Bézier segments (the standard
// uniform Catmull-Rom → Bézier conversion: control points sit a sixth of
// the neighbour chord along the tangent). Both the Studio's handle overlay
// and the runtime's mask rendering call this module, so what the merchant
// shapes is exactly what clips the customer's image.

export type Pt = [number, number];

export interface CurveSegment { p0: Pt; c1: Pt; c2: Pt; p1: Pt }

/** The closed loop through `points`, one cubic Bézier per consecutive pair. */
export function closedCurveSegments(points: Pt[]): CurveSegment[] {
  const n = points.length;
  if (n < 3) return [];
  const at = (i: number) => points[((i % n) + n) % n];
  return points.map((_, i) => {
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

/**
 * Trace the closed curve into a 2D context, mapping each curve-space point
 * through `map` (typically millimetres → canvas pixels). The caller strokes
 * or fills; mapping the points instead of transforming the context keeps
 * line widths and dashes uniform whatever the zone's aspect ratio.
 */
export function tracePath(
  ctx: Pick<CanvasRenderingContext2D, 'moveTo' | 'bezierCurveTo' | 'closePath'>,
  points: Pt[],
  map: (p: Pt) => Pt = (p) => p,
): void {
  const segs = closedCurveSegments(points);
  if (!segs.length) return;
  ctx.moveTo(...map(segs[0].p0));
  for (const s of segs) ctx.bezierCurveTo(...map(s.c1), ...map(s.c2), ...map(s.p1));
  ctx.closePath();
}

/** The rectangle's worth of anchors a fresh boundary starts from: corners
 * and edge midpoints, inset so the smooth curve stays inside the zone —
 * Catmull-Rom bulges ~6% past a convex corner, so the anchors sit at 44%. */
export function defaultBoundary(widthMm: number, heightMm: number): Pt[] {
  const w = widthMm * 0.44, h = heightMm * 0.44;
  return [[-w, -h], [0, -h], [w, -h], [w, 0], [w, h], [0, h], [-w, h], [-w, 0]];
}
