// Turn a manifest's anchored placements into concrete transforms.
//
// Kept free of three.js on purpose: this is the part most likely to be wrong,
// and it's far cheaper to test "put my underside 2 mm above the body's
// underside" against numbers than against pixels. The Studio also needs the
// same answer to draw its gizmos, so it can't live inside the renderer.

import type { Manifest, Part, AxisPlacement, AnchorEdge } from '../manifest/types.ts';

export interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

export interface PartTransform {
  /** Applied about the part's own centre, before anchoring. */
  scale: [number, number, number];
  /** Degrees, XYZ order, about the part's own centre. */
  rotation: [number, number, number];
  /** World translation to apply after scale/rotation. */
  translate: [number, number, number];
  /** Where the part ends up — what the Studio labels and what anchors read. */
  box: Box;
  /** Size in millimetres, the number the Studio's W/H/D fields show. */
  size: [number, number, number];
}

const edgeOf = (box: Box, edge: AnchorEdge, axis: number): number =>
  edge === 'min' ? box.min[axis]
    : edge === 'max' ? box.max[axis]
      : (box.min[axis] + box.max[axis]) / 2;

const DEG = Math.PI / 180;

/**
 * Scale and rotate a box about its own centre.
 *
 * Rotating an axis-aligned box yields the AABB of the rotated box, which can
 * be marginally larger than the AABB of the rotated mesh. That's the safe
 * direction to be wrong in — an anchor never lets a part clip into its
 * reference — and it only differs for non-right-angle rotations.
 */
export function transformBox(box: Box, scale: [number, number, number], rotation: [number, number, number]): Box {
  const c = [0, 1, 2].map((a) => (box.min[a] + box.max[a]) / 2);
  const h = [0, 1, 2].map((a) => ((box.max[a] - box.min[a]) / 2) * scale[a]);

  if (rotation.every((r) => r === 0)) {
    return {
      min: [c[0] - h[0], c[1] - h[1], c[2] - h[2]],
      max: [c[0] + h[0], c[1] + h[1], c[2] + h[2]],
    };
  }

  const [rx, ry, rz] = rotation.map((d) => d * DEG);
  const [cx, sx] = [Math.cos(rx), Math.sin(rx)];
  const [cy, sy] = [Math.cos(ry), Math.sin(ry)];
  const [cz, sz] = [Math.cos(rz), Math.sin(rz)];
  // three.js default Euler order is XYZ, i.e. R = Rz · Ry · Rx.
  const m = [
    [cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz],
    [cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz],
    [-sy, sx * cy, cx * cy],
  ];
  // The half-extent of a rotated box is |M| · h — absolute values, because
  // each axis picks up the magnitude of every contribution.
  const rh = m.map((row) => row.reduce((s, v, i) => s + Math.abs(v) * h[i], 0));
  return {
    min: [c[0] - rh[0], c[1] - rh[1], c[2] - rh[2]],
    max: [c[0] + rh[0], c[1] + rh[1], c[2] + rh[2]],
  };
}

/**
 * @param manifest validated manifest
 * @param boxes    each part's untransformed bounding box, straight from the GLB
 */
export function resolveLayout(manifest: Manifest, boxes: Map<string, Box>): Map<string, PartTransform> {
  const parts = new Map<string, Part>(manifest.parts.map((p) => [p.id, p]));
  const out = new Map<string, PartTransform>();

  const resolve = (id: string, seen: Set<string>): PartTransform | undefined => {
    const done = out.get(id);
    if (done) return done;
    const part = parts.get(id);
    const raw = boxes.get(id);
    if (!part || !raw) return undefined;
    // validateManifest rejects cycles, but a manifest can reach the runtime
    // by other routes; refusing to recurse beats a blown stack.
    if (seen.has(id)) return undefined;
    seen.add(id);

    const scale = part.placement?.scale ?? [1, 1, 1];
    const rotation = part.placement?.rotation ?? [0, 0, 0];
    const local = transformBox(raw, scale, rotation);

    const translate: [number, number, number] = [0, 0, 0];
    (['x', 'y', 'z'] as const).forEach((name, axis) => {
      const a: AxisPlacement | undefined = part.placement?.[name];
      const offset = a?.offset ?? 0;
      if (!a?.to || a.to === 'origin') { translate[axis] = offset; return; }

      const [refId, edge] = a.to.split(':') as [string, AnchorEdge];
      const ref = resolve(refId, seen);
      if (!ref) { translate[axis] = offset; return; }

      // "put my `align` edge at the reference's `edge`, plus offset"
      translate[axis] = edgeOf(ref.box, edge, axis) + offset - edgeOf(local, a.align ?? 'center', axis);
    });

    const box: Box = {
      min: [local.min[0] + translate[0], local.min[1] + translate[1], local.min[2] + translate[2]],
      max: [local.max[0] + translate[0], local.max[1] + translate[1], local.max[2] + translate[2]],
    };
    const result: PartTransform = {
      scale, rotation, translate, box,
      size: [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]],
    };
    out.set(id, result);
    return result;
  };

  for (const part of manifest.parts) resolve(part.id, new Set());

  // ── attachments ──────────────────────────────────────────────────────────
  // A part glued to a body's face: its own translate is overridden so its
  // opposite face sits gapMm off the target's face, centred on the other two
  // axes, plus any offset. Targets may be assemblies or variant sets (their
  // union box), so this runs AFTER every box exists; three passes let a
  // charm hang off a part that itself hangs off something (cycles are
  // refused at validation).
  const followers = manifest.parts.filter((p) => p.attach && out.has(p.id));
  for (let pass = 0; pass < 3 && followers.length; pass++) {
    for (const part of followers) {
      const a = part.attach!;
      const t = out.get(part.id)!;
      const ids = attachTargetParts(manifest, a.to).filter((id) => id !== part.id);
      const union: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (const id of ids) {
        const ref = out.get(id);
        if (!ref) continue;
        for (let ax = 0; ax < 3; ax++) {
          if (ref.box.min[ax] < union.min[ax]) union.min[ax] = ref.box.min[ax];
          if (ref.box.max[ax] > union.max[ax]) union.max[ax] = ref.box.max[ax];
        }
      }
      if (!Number.isFinite(union.min[0])) continue;

      const axis = { x: 0, y: 1, z: 2 }[a.face[0] as 'x' | 'y' | 'z'];
      const sign = a.face[1] === '+' ? 1 : -1;
      const gap = a.gapMm ?? 0;
      const off = a.offsetMm ?? [0, 0, 0];
      for (let ax = 0; ax < 3; ax++) {
        const ownCentre = (t.box.min[ax] + t.box.max[ax]) / 2;
        const want = ax === axis
          ? (sign > 0 ? union.max[ax] : union.min[ax]) + sign * (gap + t.size[ax] / 2) + off[ax]
          : (union.min[ax] + union.max[ax]) / 2 + off[ax];
        const delta = want - ownCentre;
        if (Math.abs(delta) < 1e-9) continue;
        t.translate[ax] += delta;
        t.box.min[ax] += delta;
        t.box.max[ax] += delta;
      }
    }
  }
  return out;
}

/** The parts a body id names: itself, an assembly's members, or a variant
 * set's choices. Shared with the runtime, which uses it to spot attachments
 * whose target carries a per-letter run. */
export function attachTargetParts(manifest: Manifest, id: string): string[] {
  if (manifest.parts.some((p) => p.id === id)) return [id];
  const g = manifest.groups?.find((x) => x.id === id);
  if (g) return [...g.parts];
  const o = manifest.options.find((x) => x.id === id);
  if (o && o.type === 'choice' && (o as { role?: string }).role === 'variant') {
    return (o as { choices: Array<{ id: string }> }).choices
      .map((c) => c.id).filter((pid) => manifest.parts.some((p) => p.id === pid));
  }
  return [];
}

/** Union of every visible part — what the camera frames and the floor sits under. */
export function modelBounds(layout: Map<string, PartTransform>, visible?: (id: string) => boolean): Box {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const [id, t] of layout) {
    if (visible && !visible(id)) continue;
    for (let a = 0; a < 3; a++) {
      if (t.box.min[a] < min[a]) min[a] = t.box.min[a];
      if (t.box.max[a] > max[a]) max[a] = t.box.max[a];
    }
  }
  return { min, max };
}
