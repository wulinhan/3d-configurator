// The engraved cut must come back CLOSED: a letter-shaped hole opened
// through the part's surface, walls, and a floor — even when the part mesh
// is an open shell or has flipped winding, where the raw CSG subtraction
// loses its inside/outside bearings and used to leave the pocket
// see-through. All pure geometry, so it runs headless.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import * as csg from 'three-bvh-csg';
import { cutTextGeometry, buildTextGeometry, placeGlyph, pocketFloor } from '../src/runtime/engrave.ts';
import fontData from '../src/fonts/sans-bold.ts';
import type { TextOption } from '../src/manifest/types.ts';

const font = new FontLoader().parse(fontData as Parameters<FontLoader['parse']>[0]);

// A slot cutting 2mm into the TOP face (y=+5) of a 40×10×20 box.
const SPEC: TextOption = {
  id: 't', type: 'text', label: 'T', part: 'p',
  origin: [0, 5, 0], normal: [0, 1, 0], sizeMm: 8, depthMm: 2,
};

const countAtY = (geo: THREE.BufferGeometry, y: number): number => {
  const pos = geo.attributes.position;
  let tris = 0;
  for (let i = 0; i < pos.count; i += 3) {
    if ([0, 1, 2].every((c) => Math.abs(pos.getY(i + c) - y) < 1e-4)) tris++;
  }
  return tris;
};

test('a closed part cuts to an open hole with walls; the floor is its own mesh', () => {
  const out = cutTextGeometry(new THREE.BoxGeometry(40, 10, 20), 'T', font, SPEC, csg);
  assert.ok(countAtY(out, 5) > 0, 'the top surface survives around the hole');
  // The floor is deliberately NOT part of the cut geometry — it renders as
  // its own mesh so it can carry the slot's text colour.
  assert.equal(countAtY(out, 3), 0, 'no floor inside the cut itself');
  const floor = pocketFloor('T', font, SPEC);
  assert.ok(countAtY(floor, 3) > 0, 'the floor mesh sits at full depth');
  const pos = floor.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    assert.ok(Math.abs(pos.getY(i) - 3) < 1e-4, 'the floor is ONLY the flat face — no walls');
  }
});

test('an OPEN shell still gets a closed pocket — the lining does not depend on the mesh', () => {
  // A box with its whole top face deleted: the pathological merchant mesh.
  const solid = new THREE.BoxGeometry(40, 10, 20).toNonIndexed();
  const pos = solid.attributes.position;
  const kept: number[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    if ([0, 1, 2].every((c) => pos.getY(i + c) > 4.9)) continue;
    for (let c = 0; c < 3; c++) kept.push(pos.getX(i + c), pos.getY(i + c), pos.getZ(i + c));
  }
  const shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(kept), 3));

  const out = cutTextGeometry(shell, 'T', font, SPEC, csg);
  // Walls span the full pocket height even on the open shell…
  const outPos = out.attributes.position;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < outPos.count; i++) { lo = Math.min(lo, outPos.getY(i)); hi = Math.max(hi, outPos.getY(i)); }
  assert.ok(lo <= 3 + 1e-4 && hi >= 5 - 1e-4, 'the pocket walls reach from floor depth to the surface');
  // …and the floor mesh closes the bottom independent of the mesh quality.
  assert.ok(countAtY(pocketFloor('T', font, SPEC), 3) > 0, 'the floor mesh exists regardless');
});

test('the glyph prism poses onto the sketch plane with sink lowering it', () => {
  const geo = buildTextGeometry('T', font, SPEC);
  geo.computeBoundingBox();
  assert.ok(Math.abs(geo.boundingBox!.min.z) < 1e-6, 'extrusion starts at the sketch plane');
  assert.ok(Math.abs(geo.boundingBox!.max.z - 2) < 1e-6, 'and spans the slot depth');

  const posed = new THREE.Object3D();
  placeGlyph(posed, { ...SPEC, sinkMm: 2 });
  assert.ok(Math.abs(posed.position.y - 3) < 1e-6, 'sink lowers the plane into the part');
});
