// Post-processing for projected image decals.
//
// three's DecalGeometry stamps EVERY triangle inside the projection box —
// side walls, the part's underside, anything the box reaches through. For
// an image zone that reads as the picture bleeding around edges and showing
// up on the back of the part. The filter here keeps a triangle only when
// the projector can actually see it, in two winding-independent passes
// (merchant meshes routinely arrive with flipped winding — the viewer
// renders double-sided for exactly that reason, so triangle orientation
// proves nothing):
//
//   1. rake: a triangle whose PLANE is turned more than ~81° from the
//      projection direction is a wall, whichever way it winds;
//   2. sight: a ray from the projector to each survivor's centroid must
//      reach it first — the far side of the part and anything shadowed by
//      an overhang gets hit somewhere closer and drops out.

import * as THREE from 'three';

/** cos(~81°): faces raked up to this far from the projector still take the
 * image (a hemisphere keeps its curvature); steeper is a wall. */
export const DECAL_FACING_LIMIT = 0.15;

/** Slack when comparing the ray's first hit against the triangle itself —
 * millimetres, generous enough for float noise on hand-scale models. */
const SIGHT_TOLERANCE_MM = 0.1;

/**
 * A copy of `geometry` (non-indexed, as DecalGeometry emits) keeping only
 * triangles the projector looking along `-dir` can see on `carrier`.
 * `dir` is the projection direction pointing OUT of the surface toward the
 * projector, in the same (world) space as the geometry. Returns null when
 * nothing survives. The input is untouched; the caller disposes it.
 */
export function cullHiddenFromProjector(
  geometry: THREE.BufferGeometry,
  dir: THREE.Vector3,
  carrier: THREE.Mesh,
  minDot: number = DECAL_FACING_LIMIT,
): THREE.BufferGeometry | null {
  const pos = geometry.attributes.position;
  if (!pos) return null;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const rayOrigin = new THREE.Vector3();
  const back = dir.clone().negate();
  const raycaster = new THREE.Raycaster();
  // Far enough that the origin clears any part the projector points at.
  carrier.geometry.computeBoundingSphere();
  const reach = (carrier.geometry.boundingSphere?.radius ?? 100) * Math.max(...carrier.getWorldScale(new THREE.Vector3()).toArray().map(Math.abs), 1) * 2 + 10;

  const keep: number[] = [];
  for (let i = 0; i + 2 < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    const face = ab.subVectors(b, a).cross(ac.subVectors(c, a)); // ∝ face normal
    // Winding-agnostic rake test: |n·dir| > minDot·|n| — degenerate
    // (zero-area) triangles drop out on their own.
    if (Math.abs(face.dot(dir)) <= minDot * face.length()) continue;

    // Line of sight: does the projector reach this triangle first?
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    rayOrigin.copy(centroid).addScaledVector(dir, reach);
    raycaster.set(rayOrigin, back);
    raycaster.far = reach + SIGHT_TOLERANCE_MM;
    const hit = raycaster.intersectObject(carrier, false)[0];
    // No hit at all (open shell grazing) gives the benefit of the doubt.
    if (hit && hit.distance < reach - SIGHT_TOLERANCE_MM) continue;
    keep.push(i);
  }
  if (!keep.length) return null;

  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv'] as const) {
    const src = geometry.attributes[name] as THREE.BufferAttribute | undefined;
    if (!src) continue;
    const size = src.itemSize;
    const array = new Float32Array(keep.length * 3 * size);
    keep.forEach((tri, t) => {
      array.set((src.array as Float32Array).subarray(tri * size, (tri + 3) * size), t * 3 * size);
    });
    out.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  return out;
}
