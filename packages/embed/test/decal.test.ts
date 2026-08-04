// Decal visibility cull: a projector only paints what it can see. The
// projection box reaches through the part, so without this filter an image
// stamped on the top face also lands on side walls and the underside — the
// QR-bleeding-out-of-every-edge bug, asserted headless here. The cull must
// be winding-independent: merchant meshes routinely arrive flipped (the
// viewer renders double-sided for exactly that reason).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { cullHiddenFromProjector, DECAL_FACING_LIMIT } from '../src/runtime/decal.ts';

// A 20×10×20 box sat on the origin, like a part in the viewer: the decal
// projector looks straight down at the top face (y = 10).
function box(): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(20, 10, 20).toNonIndexed();
  geometry.translate(0, 5, 0);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld();
  return mesh;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Non-indexed decal-shaped geometry from triangles, with uvs. */
function geom(...tris: number[][][]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos = Float32Array.from(tris.flat(2));
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let i = 0; i < pos.length / 3; i++) {
    uv[i * 2] = pos[i * 3];
    uv[i * 2 + 1] = pos[i * 3 + 2];
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

const TOP = [[-2, 10, -2], [2, 10, -2], [-2, 10, 2]];        // on the visible top face
const TOP_FLIPPED = [[-2, 10, -2], [-2, 10, 2], [2, 10, -2]]; // same face, reversed winding
const BOTTOM = [[-2, 0, -2], [2, 0, -2], [-2, 0, 2]];        // underside — projector can't see it
const WALL = [[10, 2, -2], [10, 8, -2], [10, 5, 2]];         // vertical side — raked away

test('walls and the underside are culled; the top face stays, uvs intact', () => {
  const out = cullHiddenFromProjector(geom(TOP, BOTTOM, WALL), UP, box())!;
  assert.equal(out.attributes.position.count, 3, 'only the seen triangle survives');
  assert.deepEqual([...(out.attributes.position.array as Float32Array)], TOP.flat());
  assert.deepEqual([...(out.attributes.uv.array as Float32Array)], TOP.flatMap((p) => [p[0], p[2]]));
});

test('winding proves nothing: a flipped top-face triangle still takes the image', () => {
  const out = cullHiddenFromProjector(geom(TOP_FLIPPED, BOTTOM), UP, box())!;
  assert.equal(out.attributes.position.count, 3);
  assert.deepEqual([...(out.attributes.position.array as Float32Array)], TOP_FLIPPED.flat());
});

test('a steeply raked face (curved surface) still takes the image', () => {
  // ~45° on the top surface's shoulder — well inside the ~81° rake limit,
  // and nothing above it to block the projector.
  const raked = [[-8, 10, -8], [-4, 12, -8], [-8, 11, -4]];
  const out = cullHiddenFromProjector(geom(raked), UP, box())!;
  assert.equal(out.attributes.position.count, 3);
  assert.ok(DECAL_FACING_LIMIT < Math.cos(Math.PI / 4), 'limit is looser than 45°');
});

test('nothing the projector can see means no decal at all', () => {
  assert.equal(cullHiddenFromProjector(geom(BOTTOM, WALL), UP, box()), null);
  // Degenerate zero-area triangles never sneak through.
  assert.equal(cullHiddenFromProjector(geom([[0, 10, 0], [0, 10, 0], [0, 10, 0]]), UP, box()), null);
});
