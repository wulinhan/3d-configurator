// Text that follows a curved surface.
//
// The flat pipeline (engrave.ts) lays glyphs out in the slot's SKETCH PLANE:
// straight, along a Bend arc, or along a drawn baseline. On a cylinder or a
// dome that plane cuts through the geometry — the middle of a long word
// floats off the surface while the ends sink in. This module bends the same
// per-glyph station engine onto the geometry itself.
//
// Two things make it work:
//
//  1. A PROBE, injected rather than assumed: sketch (u, v) → the surface
//     point and normal under it. The viewer supplies a raycast against the
//     carrier mesh; tests supply an analytic cylinder. Nothing here knows
//     about three.js scenes, so the walk is unit-testable headless.
//
//  2. An ARC-LENGTH walk. Marching in a straight sketch line and dropping
//     each glyph straight down compresses the letters where the surface
//     tilts away — text visibly bunches at a cylinder's shoulder. Instead
//     the baseline is sampled in small steps, each step projected onto the
//     surface, and the REAL 3D distance travelled is accumulated. A glyph
//     lands where the surface distance equals its advance, so spacing on
//     the curve matches spacing on the flat.
//
// The probe reports whatever space the caller works in (the viewer uses
// world space, so a scaled or rotated part needs no special handling); the
// frames come back in that same space.

export type V3 = [number, number, number];

export interface SurfaceSample {
  point: V3;
  /** Outward surface normal — the glyph's extrusion direction. */
  normal: V3;
}

/** Sketch-plane (u, v) → the surface under it, or null where nothing is
 * there (a hole, an overhang, past the end of the geometry). */
export type SurfaceProbe = (u: number, v: number) => SurfaceSample | null;

export interface WrappedGlyph {
  ch: string;
  advance: number;
  /** Where the glyph's advance MIDPOINT sits on the surface. */
  position: V3;
  /** Travel direction along the baseline, tangent to the surface. */
  xAxis: V3;
  /** In-surface "up" for the glyph — normal × travel. */
  yAxis: V3;
  /** Outward surface normal; the extrusion runs along it. */
  normal: V3;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l) : [0, 0, 0];
};

/** One sample of the walk: how far along the surface it is, and what the
 * surface looked like there. */
interface Step { surfaceDist: number; sample: SurfaceSample }

export interface WrapResult {
  glyphs: WrappedGlyph[];
  /** Glyphs the surface could not carry — the run ran off the geometry, or
   * the probe found nothing. The caller falls back to flat placement for
   * these rather than dropping the letters. */
  missed: string[];
  /** How far the surface reaches either side of the origin, mm. */
  reach: { back: number; forward: number };
}

/**
 * Walk a slot's baseline across a surface and place its glyphs on it.
 *
 * `flatAt` is the baseline in the sketch plane (see engrave.baselineAt),
 * sampled by arc length from the run's centre. `glyphs` carry the advances
 * that spacing is measured in. Everything is millimetres.
 */
export function wrapGlyphs(
  glyphs: Array<{ ch: string; advance: number; mid: number }>,
  flatAt: (s: number) => { x: number; y: number },
  probe: SurfaceProbe,
  opts: { stepMm?: number; liftMm?: number } = {},
): WrapResult {
  const step = Math.max(0.05, opts.stepMm ?? 0.4);
  const lift = opts.liftMm ?? 0;
  const need = glyphs.reduce((m, g) => Math.max(m, Math.abs(g.mid) + g.advance), 0);
  // Walk a little past the furthest glyph so its frame has a neighbour to
  // take a tangent from, but never unboundedly far.
  const limit = need * 2 + 10;

  const start = flatAt(0);
  const first = probe(start.x, start.y);
  if (!first) return { glyphs: [], missed: glyphs.map((g) => g.ch), reach: { back: 0, forward: 0 } };

  // Sample outward from the centre in both directions, accumulating the
  // distance actually travelled ACROSS THE SURFACE.
  const walk = (dir: 1 | -1): Step[] => {
    const out: Step[] = [];
    let prev = first;
    let travelled = 0;
    for (let s = dir * step; Math.abs(s) <= limit; s += dir * step) {
      const flat = flatAt(s);
      const hit = probe(flat.x, flat.y);
      if (!hit) break; // the surface ran out — everything beyond is a miss
      travelled += len(sub(hit.point, prev.point));
      out.push({ surfaceDist: dir * travelled, sample: hit });
      prev = hit;
    }
    return out;
  };
  const back = walk(-1);
  const forward = walk(1);
  // One ordered table, centre included, from the far back to the far front.
  const table: Step[] = [...[...back].reverse(), { surfaceDist: 0, sample: first }, ...forward];
  const reach = {
    back: back.length ? Math.abs(back[back.length - 1].surfaceDist) : 0,
    forward: forward.length ? forward[forward.length - 1].surfaceDist : 0,
  };

  const out: WrappedGlyph[] = [];
  const missed: string[] = [];
  for (const g of glyphs) {
    const placed = frameAt(table, g.mid, lift);
    if (!placed) { missed.push(g.ch); continue; }
    out.push({ ch: g.ch, advance: g.advance, ...placed });
  }
  return { glyphs: out, missed, reach };
}

/** The surface frame at a given distance along the walk, interpolated
 * between the two samples that straddle it. Null when the walk never got
 * that far — the run has overrun the geometry. */
function frameAt(
  table: Step[],
  target: number,
  lift: number,
): { position: V3; xAxis: V3; yAxis: V3; normal: V3 } | null {
  if (table.length < 2) return null;
  if (target < table[0].surfaceDist || target > table[table.length - 1].surfaceDist) return null;
  let hi = table.findIndex((s) => s.surfaceDist >= target);
  if (hi <= 0) hi = 1;
  const lo = hi - 1;
  const span = table[hi].surfaceDist - table[lo].surfaceDist;
  const t = span > 1e-9 ? (target - table[lo].surfaceDist) / span : 0;

  const a = table[lo].sample;
  const b = table[hi].sample;
  const position = add(a.point, scale(sub(b.point, a.point), t));
  // The travel direction between the straddling samples IS the tangent.
  const travel = norm(sub(b.point, a.point));
  const rawNormal = norm(add(a.normal, scale(sub(b.normal, a.normal), t)));
  // Orthogonalise: the glyph's forward axis must lie in the surface's
  // tangent plane, or the letter shears where the surface turns.
  const xAxis = norm(sub(travel, scale(rawNormal, dot(travel, rawNormal))));
  if (!len(xAxis)) return null;
  const normal = norm(rawNormal);
  // Right-handed: x × y = z, so the glyph's own +z extrudes outward.
  const yAxis = cross(normal, xAxis);
  return { position: add(position, scale(normal, lift)), xAxis, yAxis, normal };
}
