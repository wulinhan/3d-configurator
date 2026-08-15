// The export writers: bytes a slicer, a modelling tool or a browser will
// actually accept. Format guarantees only — the geometry itself comes
// baked from the viewer, which the browser test exercises.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { writeStl, writeObj, write3mf, exportModel, type ExportMesh } from '../src/lib/export-model.ts';
import { importGlb } from '../src/lib/import-glb.ts';

const tri = (name: string, at = 0): ExportMesh => ({
  name,
  positions: Float32Array.from([at, 0, 0, at + 10, 0, 0, at, 10, 0]),
  indices: Uint32Array.from([0, 1, 2]),
});

test('binary STL: header, count, 50 bytes a triangle, unit normal', () => {
  const bytes = writeStl([tri('a'), tri('b', 20)]);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(80, true), 2);
  assert.equal(bytes.length, 84 + 2 * 50);
  // first triangle lies in the XY plane — normal is ±Z, unit length
  const [nx, ny, nz] = [view.getFloat32(84, true), view.getFloat32(88, true), view.getFloat32(92, true)];
  assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-5, 'unit normal');
  assert.ok(Math.abs(Math.abs(nz) - 1) < 1e-5, 'normal along Z');
});

test('every format leaves Z-up: Studio +Y becomes the build plate\'s +Z', async () => {
  // a vertex 5mm ABOVE the ground (y=5), 2mm towards the camera (z=2) —
  // an open triangle, so the Manifold cleanup passes it through untouched
  // and the raw byte positions stay predictable.
  const mesh: ExportMesh = {
    name: 'plate',
    positions: Float32Array.from([0, 5, 2, 10, 5, 2, 0, 15, 2]),
    indices: Uint32Array.from([0, 1, 2]),
  };
  const stl = await exportModel([mesh], 'stl', 'x');
  const view = new DataView(stl.buffer, stl.byteOffset);
  // first vertex sits after header+count+normal: (x, −z, y) = (0, −2, 5)
  assert.equal(view.getFloat32(96, true), 0);
  assert.equal(view.getFloat32(100, true), -2);
  assert.equal(view.getFloat32(104, true), 5);

  const mf = strFromU8(unzipSync(await exportModel([mesh], '3mf', 'x'))['3D/3dmodel.model']);
  assert.ok(mf.includes('<vertex x="0.0000" y="-2.0000" z="5.0000"/>'), '3MF rotated');

  const obj = new TextDecoder().decode(await exportModel([mesh], 'obj', 'x'));
  assert.ok(obj.includes('v 0.0000 -2.0000 5.0000'), 'OBJ rotated too');

  // the GLB round-trips through our own importer, rotated the same way
  const glb = await exportModel([mesh], 'glb', 'x');
  const back = importGlb(glb).parts[0].positions;
  assert.deepEqual([back[0], back[1], back[2]], [0, -2, 5], 'GLB rotated too');
});

test('OBJ: one o-group per part, faces numbered across the whole file', () => {
  const text = writeObj([tri('plate'), tri('ridge lines', 20)]);
  assert.ok(text.includes('o plate'));
  assert.ok(text.includes('o ridge_lines'), 'group names carry no spaces');
  assert.ok(text.includes('f 1 2 3'));
  assert.ok(text.includes('f 4 5 6'), 'second mesh offsets past the first');
});

test('3MF: a zip package, objects kept separate, resources closed before build', () => {
  const bytes = write3mf([tri('base'), tri('a<b', 20)], 'Test & Thing');
  const files = unzipSync(bytes);
  assert.ok(files['[Content_Types].xml'] && files['_rels/.rels'], 'package plumbing present');
  const model = strFromU8(files['3D/3dmodel.model']);
  assert.equal((model.match(/<object /g) ?? []).length, 2);
  assert.ok(model.indexOf('</resources>') < model.indexOf('<build>'), 'valid element order');
  assert.ok(model.includes('name="a&lt;b"'), 'names are XML-escaped');
  assert.ok(model.includes('Test &amp; Thing'), 'title is XML-escaped');
  assert.ok(model.includes('unit="millimeter"'));
});

test('exportModel: GLB magic, and an empty scene is refused', async () => {
  const glb = await exportModel([tri('a')], 'glb', 'x');
  assert.equal(new DataView(glb.buffer, glb.byteOffset).getUint32(0, true), 0x46546c67);
  await assert.rejects(() => exportModel([], 'stl', 'x'), /nothing visible/);
});
