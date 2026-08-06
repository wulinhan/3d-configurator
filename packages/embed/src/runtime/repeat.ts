// Live part patterns: turning a part's `repeats` into the transforms its
// copies render at.
//
// A repeat is a PARAMETER of the part, not a pile of stamped duplicates —
// the merchant tweaks count/gap/step and the row re-forms, and several
// repeats stack (each one repeats everything the ones before it produced,
// so ×3 along X then ×2 along Y is a 3×2 grid). Pure geometry, so the
// stacking arithmetic is unit-tested headless and the viewer just applies
// what comes out.

import type { RepeatSpec } from '../manifest/types.ts';

export interface Instance {
  /** Where this copy's centre sits, in the same mm space as the layout. */
  centre: [number, number, number];
  /** Extra turn about the vertical axis, degrees (circle mode). */
  spinDeg: number;
}

/**
 * Every copy of a part under its repeat stack, ORIGINAL FIRST.
 *
 * `centre` is the part's laid-out centre and `size` its laid-out extent
 * (both mm); line pitch is the size along the axis plus the gap, and
 * circle copies turn about the vertical axis through the world origin —
 * the original taken as facing the tangent, matching the stamping tool.
 */
export function repeatInstances(
  repeats: RepeatSpec[] | undefined,
  centre: [number, number, number],
  size: [number, number, number],
): Instance[] {
  let out: Instance[] = [{ centre: [...centre] as [number, number, number], spinDeg: 0 }];
  for (const spec of repeats ?? []) {
    const count = Math.floor(spec.count);
    if (!Number.isFinite(count) || count < 2) continue;
    const next: Instance[] = [];
    for (const base of out) {
      next.push(base);
      for (let i = 1; i < count; i++) {
        if (spec.mode === 'circle') {
          // Rotate the copy's centre about the origin in the ground plane;
          // the matching body spin is negative in three.js's Y convention,
          // so together they read as one rigid turn.
          const step = spec.stepDeg ?? 360 / count;
          const phi = (step * i * Math.PI) / 180;
          const cos = Math.cos(phi), sin = Math.sin(phi);
          next.push({
            centre: [
              base.centre[0] * cos - base.centre[2] * sin,
              base.centre[1],
              base.centre[0] * sin + base.centre[2] * cos,
            ],
            spinDeg: base.spinDeg - step * i,
          });
        } else {
          const axis = spec.axis ?? 0;
          const pitch = size[axis] + (spec.gapMm ?? 5);
          const c = [...base.centre] as [number, number, number];
          c[axis] += pitch * i;
          next.push({ centre: c, spinDeg: base.spinDeg });
        }
      }
    }
    out = next;
    // A runaway stack is a merchant mistake, not a reason to hang the tab.
    if (out.length > 512) break;
  }
  return out;
}

/** How many copies a stack produces, the original included. */
export function repeatCount(repeats: RepeatSpec[] | undefined): number {
  return (repeats ?? []).reduce((n, r) => {
    const count = Math.floor(r.count);
    return Number.isFinite(count) && count >= 2 ? n * count : n;
  }, 1);
}
