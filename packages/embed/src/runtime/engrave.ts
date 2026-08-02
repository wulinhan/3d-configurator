// Text-on-surface geometry: glyph extrusion, sketch-plane posing, and the
// engraved (boolean-difference) cut. Pure functions of geometry + slot spec,
// pulled out of the Viewer so the cut pipeline is unit-testable in node —
// the failure this guards against (a see-through pocket on an imperfect
// merchant mesh) was found with pixels, but is asserted here with maths.

import * as THREE from 'three';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js';
import type { Font } from 'three/examples/jsm/loaders/FontLoader.js';
import type { TextOption } from '../manifest/types.ts';

type Csg = typeof import('three-bvh-csg');

/** One extruded glyph run, centred on the sketch origin. */
export function buildTextGeometry(text: string, font: Font, spec: TextOption): THREE.BufferGeometry {
  const geo = new TextGeometry(text, {
    font,
    size: spec.sizeMm,
    depth: spec.depthMm,
    curveSegments: 4,
    bevelEnabled: false,
  });
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  // Centre the run on the sketch origin; extrusion spans z 0..depth.
  geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, 0);
  return geo;
}

/**
 * Pose a glyph mesh onto its sketch plane, in the carrier's local space.
 * Basis: text faces along the surface normal. Up is the world's up
 * projected onto the face; on horizontal faces (normal ≈ ±Y) it
 * degenerates, so -Z steps in — text on a top face reads from the model's
 * front. Sink lowers the sketch plane into the part; what stays proud of
 * the surface is depth − sink.
 */
export function placeGlyph(mesh: THREE.Object3D, spec: TextOption): void {
  const n = new THREE.Vector3(...spec.normal).normalize();
  const upRef = Math.abs(n.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1);
  const xAxis = new THREE.Vector3().crossVectors(upRef, n).normalize();
  const yAxis = new THREE.Vector3().crossVectors(n, xAxis).normalize();
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, n));
  if (spec.rotationDeg) {
    mesh.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(n, spec.rotationDeg * Math.PI / 180));
  }
  mesh.position.set(...spec.origin).addScaledVector(n, -(spec.sinkMm ?? 0));
}

/** The triangle soup of one material group, index resolved — CSG results
 * label part-surface faces group 0 and cut faces group 1. */
export function trianglesOfGroup(geo: THREE.BufferGeometry, materialIndex: number): number[] {
  const pos = geo.attributes.position;
  const index = geo.index;
  const total = index ? index.count : pos.count;
  const groups = geo.groups.length ? geo.groups : [{ start: 0, count: total, materialIndex: 0 }];
  const out: number[] = [];
  for (const group of groups) {
    if (group.materialIndex !== materialIndex) continue;
    const end = Math.min(group.start + group.count, total);
    for (let i = group.start; i < end; i++) {
      const at = index ? index.getX(i) : i;
      out.push(pos.getX(at), pos.getY(at), pos.getZ(at));
    }
  }
  return out;
}

/**
 * The engraved pocket's own surface: the glyph prism's side walls plus its
 * bottom lid (the floor), posed exactly where the cut runs — everything
 * but the top lid, which is the opening.
 */
export function pocketLining(text: string, font: Font, spec: TextOption): number[] {
  const prism = buildTextGeometry(text, font, spec); // exact depth, flush with the surface
  const posed = new THREE.Mesh(prism);
  placeGlyph(posed, { ...spec, sinkMm: spec.depthMm });
  posed.updateMatrixWorld();
  const matrix = posed.matrixWorld;
  const pos = prism.attributes.position;
  const out: number[] = [];
  const v = new THREE.Vector3();
  // ExtrudeGeometry groups: 0 = the two lids, 1 = the side walls. The lids
  // separate cleanly by extrusion depth (bottom at z≈0, top at z≈depth).
  for (const group of prism.groups) {
    for (let i = group.start; i < group.start + group.count; i += 3) {
      if (group.materialIndex === 0) {
        const cap = Math.max(pos.getZ(i), pos.getZ(i + 1), pos.getZ(i + 2));
        if (cap > spec.depthMm / 2) continue; // top lid — the opening
      }
      for (let c = 0; c < 3; c++) {
        v.fromBufferAttribute(pos, i + c).applyMatrix4(matrix);
        out.push(v.x, v.y, v.z);
      }
    }
  }
  prism.dispose();
  return out;
}

/**
 * `source` minus the extruded text volume — a real boolean difference, in
 * the carrier part's local space. The subtraction only KEEPS the part's
 * own clipped faces (the letter-shaped hole opens through them); the
 * pocket itself — walls and floor — is then closed with an exact lining
 * built from the glyph prism directly. Building the lining ourselves is
 * what makes engraving robust: a merchant mesh with open shells or flipped
 * winding can confuse the CSG's inside/outside test and leave the pocket
 * see-through, but the lining never depends on the part mesh being a
 * perfect manifold. On a hard CSG failure the part stays uncut.
 */
export function cutTextGeometry(
  source: THREE.BufferGeometry,
  text: string,
  font: Font,
  spec: TextOption,
  csg: Csg,
): THREE.BufferGeometry {
  const { Evaluator, Brush, SUBTRACTION } = csg;
  // The cutter overshoots the surface by 0.2mm so the hole opens cleanly.
  const cutGeo = buildTextGeometry(text, font, { ...spec, depthMm: spec.depthMm + 0.2 });
  try {
    const evaluator = new Evaluator();
    evaluator.attributes = ['position', 'normal'];
    evaluator.useGroups = true; // group 0 = faces from the part, 1 = cut faces
    if (!source.attributes.normal) source.computeVertexNormals();
    const posed = new THREE.Mesh(cutGeo);
    placeGlyph(posed, { ...spec, sinkMm: spec.depthMm }); // cutter bottom at full depth
    const a = new Brush(source);
    a.updateMatrixWorld();
    const b = new Brush(cutGeo);
    b.position.copy(posed.position);
    b.quaternion.copy(posed.quaternion);
    b.updateMatrixWorld();
    const out = evaluator.evaluate(a, b, SUBTRACTION);

    const merged = new THREE.BufferGeometry();
    const soup = new Float32Array([
      ...trianglesOfGroup(out.geometry, 0),
      ...pocketLining(text, font, spec),
    ]);
    merged.setAttribute('position', new THREE.BufferAttribute(soup, 3));
    merged.computeVertexNormals();
    out.geometry.dispose();
    return merged;
  } catch (err) {
    console.warn('[configurator] engrave failed — showing the part uncut', err);
    return source.clone();
  } finally {
    cutGeo.dispose();
  }
}
