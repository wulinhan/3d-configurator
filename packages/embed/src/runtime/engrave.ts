// Text-on-surface geometry: glyph extrusion, sketch-plane posing, and the
// engraved (boolean-difference) cut. Pure functions of geometry + slot spec,
// pulled out of the Viewer so the cut pipeline is unit-testable in node —
// the failure this guards against (a see-through pocket on an imperfect
// merchant mesh) was found with pixels, but is asserted here with maths.

import * as THREE from 'three';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js';
import type { Font } from 'three/examples/jsm/loaders/FontLoader.js';
import type { TextOption } from '../manifest/types.ts';
import { walkPath, type Pt } from './text-path.ts';
import { wrapGlyphs, type SurfaceProbe } from './wrap.ts';

type Csg = typeof import('three-bvh-csg');

/** Does this slot curve its run — a drawn baseline path, or a Bend arc? */
const curved = (spec: TextOption): boolean => (spec.path?.length ?? 0) >= 2 || !!spec.bendDeg;

/** One extruded glyph run, centred on the sketch origin. With `bendDeg`
 * or a drawn `path`, the run curves along that baseline — built per glyph
 * and merged, so every consumer (emboss mesh, engrave cutter, pocket
 * lining and floor) gets the curve for free. */
export function buildTextGeometry(text: string, font: Font, spec: TextOption): THREE.BufferGeometry {
  if (curved(spec)) {
    const bent = bentTextGeometry(text, font, spec);
    if (bent) return bent;
  }
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

/** Font metrics: how far the pen advances for one character, in mm at the
 * slot's size. Spaces have real advances; characters the font lacks fall
 * back to '?' (what generateShapes substitutes anyway). */
type FontMetrics = { resolution?: number; glyphs: Record<string, { ha?: number } | undefined> };

/**
 * Per-glyph stations of a curved run, in the sketch plane. The BASELINE is
 * either the drawn `path` (an open Catmull-Rom through the merchant's
 * anchors — it wins when both are set) or the `bendDeg` circular arc:
 * positive bends arch up (the middle is the crest, the ends drop away),
 * negative bends smile. Each printable glyph lands with its advance
 * midpoint at (x, y), turned by `angleRad` to the local tangent — spacing
 * along the baseline equals the straight run's spacing, so kerning
 * survives the curve. On a path the run centres on the curve's arc-length
 * middle and overruns extend straight past the ends. Spaces advance the
 * pen but land nothing. Pure layout maths, unit-tested headless; geometry
 * assembly happens in bentTextGeometry.
 */
export function glyphStations(
  text: string,
  font: Font,
  spec: TextOption,
): Array<{ ch: string; x: number; y: number; angleRad: number; advance: number }> {
  const run = glyphRun(text, font, spec);
  const at = baselineAt(spec, run.total);
  return run.glyphs.map((g) => ({ ch: g.ch, advance: g.advance, ...at(g.mid) }));
}

/** The characters that land, with their advances and their midpoints along
 * the baseline (signed, from the run's centre). Spaces advance the pen but
 * never land, so they shape the spacing without leaving a glyph. */
export function glyphRun(
  text: string,
  font: Font,
  spec: TextOption,
): { glyphs: Array<{ ch: string; advance: number; mid: number }>; total: number } {
  const data = (font as Font & { data: FontMetrics }).data;
  const scale = spec.sizeMm / (data.resolution ?? 1000);
  const advance = (ch: string) => ((data.glyphs[ch] ?? data.glyphs['?'])?.ha ?? 0) * scale;
  const chars = [...text];
  const total = chars.reduce((sum, ch) => sum + advance(ch), 0);
  const glyphs: Array<{ ch: string; advance: number; mid: number }> = [];
  let pen = -total / 2; // the run is centred on the sketch origin
  for (const ch of chars) {
    const a = advance(ch);
    const mid = pen + a / 2;
    pen += a;
    if (ch.trim() && a > 0) glyphs.push({ ch, advance: a, mid });
  }
  return { glyphs, total };
}

/**
 * The slot's baseline as a function of arc length from the run's centre:
 * the drawn `path` when there is one, else the `bendDeg` arc, else the
 * straight line. Sampling it by arc length is what lets the surface walk
 * (see wrap.ts) re-space glyphs by the distance they actually travel.
 */
export function baselineAt(
  spec: TextOption,
  totalAdvance: number,
): (s: number) => { x: number; y: number; angleRad: number } {
  const walk = (spec.path?.length ?? 0) >= 2 ? walkPath(spec.path as Pt[]) : null;
  if (walk) {
    return (s) => {
      const st = walk.at(walk.length / 2 + s);
      return { x: st.point[0], y: st.point[1], angleRad: st.angleRad };
    };
  }
  const theta = ((spec.bendDeg ?? 0) * Math.PI) / 180;
  if (!theta || !(totalAdvance > 0)) return (s) => ({ x: s, y: 0, angleRad: 0 });
  // Signed radius: the arc through the origin, tangent to +x there.
  // p(α) = (R sin α, R (cos α − 1)) walks the circle at unit arc speed,
  // and the tangent turns by −α — both signs of bend fall out of R.
  const r = totalAdvance / theta;
  return (s) => {
    const alpha = s / r;
    return { x: r * Math.sin(alpha), y: r * (Math.cos(alpha) - 1), angleRad: -alpha };
  };
}

/** The bent run as ONE merged prism: each glyph is extruded alone, centred
 * on its advance, then rigidly carried to its arc station. The extrude
 * group convention is preserved (0 = the two lids, 1 = the walls) and z
 * still spans 0..depth, so prismTriangles reads a bent run exactly like a
 * straight one — the engraved pocket's walls and floor follow the arc with
 * no extra code. Null when nothing printable survives (the straight path
 * then yields the canonical empty geometry). */
function bentTextGeometry(text: string, font: Font, spec: TextOption): THREE.BufferGeometry | null {
  const stations = glyphStations(text, font, spec);
  if (!stations.length) return null;
  const lids: number[] = [];
  const walls: number[] = [];
  const v = new THREE.Vector3();
  const pose = new THREE.Matrix4();
  const centreAdvance = new THREE.Matrix4();
  for (const st of stations) {
    const glyph = new TextGeometry(st.ch, {
      font,
      size: spec.sizeMm,
      depth: spec.depthMm,
      curveSegments: 4,
      bevelEnabled: false,
    });
    const pos = glyph.attributes.position;
    if (!pos) { glyph.dispose(); continue; }
    pose.makeRotationZ(st.angleRad).setPosition(st.x, st.y, 0)
      .multiply(centreAdvance.makeTranslation(-st.advance / 2, 0, 0));
    const groups = glyph.groups.length ? glyph.groups : [{ start: 0, count: pos.count, materialIndex: 0 }];
    for (const g of groups) {
      const sink = g.materialIndex === 1 ? walls : lids;
      for (let i = g.start; i < g.start + g.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(pose);
        sink.push(v.x, v.y, v.z);
      }
    }
    glyph.dispose();
  }
  if (!lids.length && !walls.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from([...lids, ...walls]), 3));
  geo.addGroup(0, lids.length / 3, 0);
  geo.addGroup(lids.length / 3, walls.length / 3, 1);
  geo.computeVertexNormals(); // triangle soup → flat shading, same as ExtrudeGeometry
  // A Bend arc keeps the straight run's convention — centred on the sketch
  // origin. A drawn path does NOT recentre: the glyph baseline sits exactly
  // ON the curve the merchant dragged, wherever they put it.
  if ((spec.path?.length ?? 0) < 2) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, 0);
  }
  return geo;
}

/**
 * A run laid ON the part's surface: each glyph is extruded alone and
 * carried to its own surface frame, then everything is merged into one
 * geometry — already posed, so the mesh that carries it needs no transform
 * of its own. `toTarget` converts the probe's space into the space the
 * geometry will live in (the viewer probes in WORLD space and bakes into
 * the carrier's local space, which is what keeps a scaled or rotated part
 * honest). Extrude groups are preserved, and letters the surface could not
 * carry come back in `missed` for the caller to place flat.
 */
export function wrappedTextGeometry(
  text: string,
  font: Font,
  spec: TextOption,
  probe: SurfaceProbe,
  toTarget?: THREE.Matrix4,
  /** Which part of each glyph prism to keep, filtered in the GLYPH's own
   * frame before it is carried to the surface — 'walls' and 'floor' are how
   * an engraved pocket is lined and floored, exactly as the flat path does
   * it (see prismTriangles). */
  keep: 'all' | 'walls' | 'floor' = 'all',
): { geometry: THREE.BufferGeometry; missed: string[] } | null {
  const run = glyphRun(text, font, spec);
  if (!run.glyphs.length) return null;
  const wrapped = wrapGlyphs(run.glyphs, baselineAt(spec, run.total), probe, { liftMm: spec.liftMm });
  if (!wrapped.glyphs.length) return null;

  const lids: number[] = [];
  const walls: number[] = [];
  const v = new THREE.Vector3();
  const pose = new THREE.Matrix4();
  const centreAdvance = new THREE.Matrix4();
  for (const g of wrapped.glyphs) {
    const glyph = new TextGeometry(g.ch, {
      font, size: spec.sizeMm, depth: spec.depthMm, curveSegments: 4, bevelEnabled: false,
    });
    const pos = glyph.attributes.position;
    if (!pos) { glyph.dispose(); continue; }
    // The glyph's own frame IS the surface frame at its station: +x runs
    // with the baseline, +y is in-surface up, +z extrudes outward.
    pose.makeBasis(
      new THREE.Vector3(...g.xAxis),
      new THREE.Vector3(...g.yAxis),
      new THREE.Vector3(...g.normal),
    ).setPosition(...g.position);
    if (toTarget) pose.premultiply(toTarget);
    // TextGeometry lays a glyph from its own left edge; centre it on its
    // advance so the station lands mid-letter, as the flat path does.
    pose.multiply(centreAdvance.makeTranslation(-g.advance / 2, 0, 0));
    const groups = glyph.groups.length ? glyph.groups : [{ start: 0, count: pos.count, materialIndex: 0 }];
    for (const grp of groups) {
      const isWalls = grp.materialIndex === 1;
      if (keep !== 'all' && (keep === 'walls') !== isWalls) continue;
      const sink = isWalls ? walls : lids;
      for (let i = grp.start; i < grp.start + grp.count; i += 3) {
        // The pocket's FLOOR is the inner lid; the outer one is the opening
        // and is never kept. Judged in the glyph's own frame, where the
        // extrusion still runs 0..depth along +z.
        if (keep === 'floor') {
          const cap = Math.max(pos.getZ(i), pos.getZ(i + 1), pos.getZ(i + 2));
          if (cap > spec.depthMm / 2) continue;
        }
        for (let c = 0; c < 3; c++) {
          v.fromBufferAttribute(pos, i + c).applyMatrix4(pose);
          sink.push(v.x, v.y, v.z);
        }
      }
    }
    glyph.dispose();
  }
  if (!lids.length && !walls.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from([...lids, ...walls]), 3));
  geometry.addGroup(0, lids.length / 3, 0);
  geometry.addGroup(lids.length / 3, walls.length / 3, 1);
  geometry.computeVertexNormals();
  return { geometry, missed: wrapped.missed };
}

/**
 * Pose a glyph mesh onto its sketch plane, in the carrier's local space.
 * Basis: text faces along the surface normal. Up is the world's up
 * projected onto the face; on horizontal faces (normal ≈ ±Y) it
 * degenerates, so -Z steps in — text on a top face reads from the model's
 * front. Sink lowers the sketch plane into the part; what stays proud of
 * the surface is depth − sink.
 */
export function placeGlyph(
  mesh: THREE.Object3D,
  spec: TextOption,
  /** The carrier part's scale. Text is authored in REAL millimetres, so the
   * glyph carries its inverse: resizing the part to fit more text must not
   * blow the lettering up with it. */
  partScale: [number, number, number] = [1, 1, 1],
): void {
  const n = new THREE.Vector3(...spec.normal).normalize();
  const upRef = Math.abs(n.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1);
  const xAxis = new THREE.Vector3().crossVectors(upRef, n).normalize();
  const yAxis = new THREE.Vector3().crossVectors(n, xAxis).normalize();
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, n));
  if (spec.rotationDeg) {
    mesh.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(n, spec.rotationDeg * Math.PI / 180));
  }
  mesh.scale.set(...invScale(partScale));
  mesh.position.set(...spec.origin).addScaledVector(n, -(spec.sinkMm ?? 0));
}

/** 1/scale per axis, guarding the degenerate zero. */
export function invScale(scale: [number, number, number]): [number, number, number] {
  return scale.map((v) => (Math.abs(v) > 1e-9 ? 1 / v : 1)) as [number, number, number];
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

/** Triangles of the posed glyph prism, filtered to one region: its side
 * walls, or its bottom lid (the pocket floor). The top lid — the opening —
 * is never kept. ExtrudeGeometry groups: 0 = the two lids, 1 = the walls;
 * the lids separate cleanly by extrusion depth. */
function prismTriangles(
  text: string, font: Font, spec: TextOption, keep: 'walls' | 'floor',
  partScale: [number, number, number] = [1, 1, 1],
): number[] {
  const prism = buildTextGeometry(text, font, spec); // exact depth, flush with the surface
  const posed = new THREE.Mesh(prism);
  placeGlyph(posed, { ...spec, sinkMm: spec.depthMm }, partScale);
  posed.updateMatrixWorld();
  const matrix = posed.matrixWorld;
  const pos = prism.attributes.position;
  const out: number[] = [];
  const v = new THREE.Vector3();
  for (const group of prism.groups) {
    const isWalls = group.materialIndex === 1;
    if ((keep === 'walls') !== isWalls) continue;
    for (let i = group.start; i < group.start + group.count; i += 3) {
      if (keep === 'floor') {
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

/** The engraved pocket's side walls, posed where the cut runs. The floor is
 * NOT included — it renders as its own mesh so it can carry the slot's text
 * colour (see pocketFloor). */
export function pocketLining(
  text: string, font: Font, spec: TextOption, partScale: [number, number, number] = [1, 1, 1],
): number[] {
  return prismTriangles(text, font, spec, 'walls', partScale);
}

/** The pocket's flat floor as its own geometry, in the carrier's local
 * space — the face that carries the slot's text colour. */
export function pocketFloor(
  text: string, font: Font, spec: TextOption, partScale: [number, number, number] = [1, 1, 1],
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',
    new THREE.BufferAttribute(Float32Array.from(prismTriangles(text, font, spec, 'floor', partScale)), 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * `source` minus a run that FOLLOWS THE SURFACE — the engraved twin of
 * wrappedTextGeometry.
 *
 * The cutter is the same wrapped prism, pushed a depth INWARD (so it spans
 * from just proud of the surface down to full depth) and overshooting by
 * 0.2mm so the hole opens cleanly. Everything is already posed in the
 * target space, so the brush needs no transform of its own. As in the flat
 * cut, only the part's own clipped faces are kept and the pocket is then
 * CLOSED with an exact lining built from the same prism — a merchant mesh
 * with open shells can confuse the CSG's inside/outside test, but the
 * lining never depends on the part being a perfect manifold.
 */
export function cutWrappedTextGeometry(
  source: THREE.BufferGeometry,
  text: string,
  font: Font,
  spec: TextOption,
  csg: Csg,
  probe: SurfaceProbe,
  toTarget?: THREE.Matrix4,
): THREE.BufferGeometry {
  const { Evaluator, Brush, SUBTRACTION } = csg;
  // Sunk by a full depth: the prism's outer lid sits at the surface and
  // its floor a depth below, which is exactly the pocket to remove.
  const sunk = { ...spec, liftMm: (spec.liftMm ?? 0) - spec.depthMm };
  const cutter = wrappedTextGeometry(
    text, font, { ...sunk, depthMm: spec.depthMm + 0.2 }, probe, toTarget);
  const lining = wrappedTextGeometry(text, font, sunk, probe, toTarget, 'walls');
  if (!cutter) return source.clone();
  try {
    const evaluator = new Evaluator();
    evaluator.attributes = ['position', 'normal'];
    evaluator.useGroups = true; // group 0 = faces from the part, 1 = cut faces
    if (!source.attributes.normal) source.computeVertexNormals();
    const a = new Brush(source);
    a.updateMatrixWorld();
    const b = new Brush(cutter.geometry);
    b.updateMatrixWorld(); // already posed in the target space
    const out = evaluator.evaluate(a, b, SUBTRACTION);

    const wallPos = lining?.geometry.attributes.position;
    const walls: number[] = [];
    if (wallPos) for (let i = 0; i < wallPos.count; i++) walls.push(wallPos.getX(i), wallPos.getY(i), wallPos.getZ(i));
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([...trianglesOfGroup(out.geometry, 0), ...walls]), 3));
    merged.computeVertexNormals();
    out.geometry.dispose();
    return merged;
  } catch (err) {
    console.warn('[configurator] wrapped engrave failed — showing the part uncut', err);
    return source.clone();
  } finally {
    cutter.geometry.dispose();
    lining?.geometry.dispose();
  }
}

/** The wrapped pocket's floor — the face that carries the slot's text
 * colour, following the surface like the rest of the cut. */
export function wrappedPocketFloor(
  text: string,
  font: Font,
  spec: TextOption,
  probe: SurfaceProbe,
  toTarget?: THREE.Matrix4,
): THREE.BufferGeometry | null {
  const out = wrappedTextGeometry(
    text, font, { ...spec, liftMm: (spec.liftMm ?? 0) - spec.depthMm }, probe, toTarget, 'floor');
  if (!out) return null;
  out.geometry.computeVertexNormals();
  return out.geometry;
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
  /** The carrier's scale — the cut is made in the part's UNSCALED local
   * space, so the cutter shrinks by its inverse and the engraving comes out
   * the authored size once the part's own scale is applied. */
  partScale: [number, number, number] = [1, 1, 1],
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
    placeGlyph(posed, { ...spec, sinkMm: spec.depthMm }, partScale); // cutter bottom at full depth
    const a = new Brush(source);
    a.updateMatrixWorld();
    const b = new Brush(cutGeo);
    b.position.copy(posed.position);
    b.quaternion.copy(posed.quaternion);
    b.scale.copy(posed.scale);
    b.updateMatrixWorld();
    const out = evaluator.evaluate(a, b, SUBTRACTION);

    const merged = new THREE.BufferGeometry();
    const soup = new Float32Array([
      ...trianglesOfGroup(out.geometry, 0),
      ...pocketLining(text, font, spec, partScale),
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
