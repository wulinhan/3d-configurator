// Importer tests. Every fixture is generated in here — a fixture you can
// read is a fixture you can trust, and each one encodes a real-world quirk:
// binary STL whose header starts with "solid", 3MF component transforms,
// GLB node hierarchies with quaternion rotations.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { importStl } from '../src/lib/import-stl.ts';
import { import3mf } from '../src/lib/import-3mf.ts';
import { importGlb } from '../src/lib/import-glb.ts';
import { detectFormat, importModel } from '../src/lib/import-model.ts';
import { writeGlb } from '../src/lib/write-glb.ts';
import { ImportError } from '../src/lib/types.ts';

const near = (a: number, b: number, tol = 1e-4) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b} (±${tol})`);

// ── fixtures ────────────────────────────────────────────────────────────────

/** Axis-aligned box as 12 triangles of soup (like an STL would carry). */
function boxTriangles(w: number, h: number, d: number, ox = 0, oy = 0, oz = 0): number[][] {
  const v = (x: number, y: number, z: number) => [x * w + ox, y * h + oy, z * d + oz];
  const quads = [
    [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)], // z=0
    [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)], // z=d
    [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)], // y=0
    [v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)], // y=h
    [v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)], // x=0
    [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)], // x=w
  ];
  const tris: number[][] = [];
  for (const [a, b, c, d2] of quads) tris.push([...a, ...b, ...c], [...a, ...c, ...d2]);
  return tris;
}

function binaryStl(tris: number[][], header = 'fixture'): Uint8Array {
  const out = new Uint8Array(84 + tris.length * 50);
  const view = new DataView(out.buffer);
  new TextEncoder().encodeInto(header, out);
  view.setUint32(80, tris.length, true);
  tris.forEach((t, i) => {
    const at = 84 + i * 50 + 12;
    t.forEach((val, j) => view.setFloat32(at + j * 4, val, true));
  });
  return out;
}

function asciiStl(tris: number[][]): Uint8Array {
  const lines = ['solid fixture'];
  for (const t of tris) {
    lines.push('facet normal 0 0 0', 'outer loop');
    for (let v = 0; v < 3; v++) lines.push(`vertex ${t[v * 3]} ${t[v * 3 + 1]} ${t[v * 3 + 2]}`);
    lines.push('endloop', 'endfacet');
  }
  lines.push('endsolid fixture');
  return new TextEncoder().encode(lines.join('\n'));
}

function make3mf(modelXml: string): Uint8Array {
  return zipSync({ '3D/3dmodel.model': new TextEncoder().encode(modelXml) });
}

const TWO_PART_3MF = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="1" name="Body" type="model"><mesh>
   <vertices>
    <vertex x="0" y="0" z="0"/><vertex x="40" y="0" z="0"/><vertex x="40" y="20" z="0"/><vertex x="0" y="20" z="0"/>
    <vertex x="0" y="0" z="10"/><vertex x="40" y="0" z="10"/><vertex x="40" y="20" z="10"/><vertex x="0" y="20" z="10"/>
   </vertices>
   <triangles>
    <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/>
    <triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/>
    <triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/>
    <triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/>
    <triangle v1="0" v2="4" v3="7"/><triangle v1="0" v2="7" v3="3"/>
    <triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/>
   </triangles>
  </mesh></object>
  <object id="2" name="Cap" type="model"><mesh>
   <vertices>
    <vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="10" y="10" z="0"/><vertex x="0" y="10" z="0"/>
    <vertex x="0" y="0" z="4"/><vertex x="10" y="0" z="4"/><vertex x="10" y="10" z="4"/><vertex x="0" y="10" z="4"/>
   </vertices>
   <triangles>
    <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/>
    <triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/>
    <triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/>
    <triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/>
    <triangle v1="0" v2="4" v3="7"/><triangle v1="0" v2="7" v3="3"/>
    <triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/>
   </triangles>
  </mesh></object>
 </resources>
 <build>
  <item objectid="1"/>
  <item objectid="2" transform="1 0 0 0 1 0 0 0 1 15 5 10"/>
 </build>
</model>`;

// ── STL ─────────────────────────────────────────────────────────────────────

test('binary STL: 12-triangle box welds to 8 vertices', () => {
  const m = importStl(binaryStl(boxTriangles(40, 20, 10)));
  assert.equal(m.parts.length, 1);
  assert.equal(m.parts[0].positions.length / 3, 8);
  assert.equal(m.parts[0].indices.length / 3, 12);
});

test('ASCII STL parses to the same mesh as binary', () => {
  const tris = boxTriangles(40, 20, 10);
  const a = importStl(binaryStl(tris));
  const b = importStl(asciiStl(tris));
  assert.equal(a.parts[0].positions.length, b.parts[0].positions.length);
  assert.equal(a.parts[0].indices.length, b.parts[0].indices.length);
});

test('a binary STL whose header says "solid" is still read as binary', () => {
  // Several exporters do exactly this; a naive starts-with check mis-parses it.
  const m = importStl(binaryStl(boxTriangles(5, 5, 5), 'solid part made in someCAD'));
  assert.equal(m.parts[0].indices.length / 3, 12);
});

test('garbage is rejected, not silently empty', () => {
  assert.throws(() => importStl(new TextEncoder().encode('hello world')), ImportError);
});

// ── 3MF ─────────────────────────────────────────────────────────────────────

test('3MF: one part per build item, names carried over', () => {
  const m = import3mf(make3mf(TWO_PART_3MF));
  assert.equal(m.unitToMm, 1);
  assert.deepEqual(m.parts.map((p) => p.name), ['Body', 'Cap']);
  assert.equal(m.parts[0].positions.length / 3, 8);
});

test('3MF: build item transform moves the part', () => {
  const m = import3mf(make3mf(TWO_PART_3MF));
  const cap = m.parts[1];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  for (let i = 0; i < cap.positions.length; i += 3) {
    minX = Math.min(minX, cap.positions[i]);
    minY = Math.min(minY, cap.positions[i + 1]);
    minZ = Math.min(minZ, cap.positions[i + 2]);
  }
  near(minX, 15); near(minY, 5); near(minZ, 10);
});

test('3MF: component references compose transforms', () => {
  const xml = `<model unit="millimeter">
   <resources>
    <object id="1" name="leaf"><mesh>
     <vertices><vertex x="0" y="0" z="0"/><vertex x="2" y="0" z="0"/><vertex x="0" y="2" z="0"/></vertices>
     <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
    </mesh></object>
    <object id="2" name="assembly">
     <components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 100 0 0"/></components>
    </object>
   </resources>
   <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 50 0"/></build>
  </model>`;
  const m = import3mf(make3mf(xml));
  assert.equal(m.parts.length, 1);
  // leaf vertex (0,0,0) → component +100x → item +50y
  near(m.parts[0].positions[0], 100);
  near(m.parts[0].positions[1], 50);
});

test('3MF: an assembly of several leaf meshes merges into one part', () => {
  const xml = `<model unit="millimeter">
   <resources>
    <object id="1"><mesh>
     <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
     <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
    </mesh></object>
    <object id="2"><mesh>
     <vertices><vertex x="5" y="0" z="0"/><vertex x="6" y="0" z="0"/><vertex x="5" y="1" z="0"/></vertices>
     <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
    </mesh></object>
    <object id="3" name="pair">
     <components><component objectid="1"/><component objectid="2"/></components>
    </object>
   </resources>
   <build><item objectid="3"/></build>
  </model>`;
  const m = import3mf(make3mf(xml));
  assert.equal(m.parts.length, 1);
  assert.equal(m.parts[0].positions.length / 3, 6);
  assert.equal(m.parts[0].indices.length / 3, 2);
  // second mesh's indices must have been re-based past the first mesh's verts
  assert.deepEqual([...m.parts[0].indices], [0, 1, 2, 3, 4, 5]);
});

test('3MF: metre-unit files report the ×1000 conversion', () => {
  const xml = TWO_PART_3MF.replace('unit="millimeter"', 'unit="meter"');
  assert.equal(import3mf(make3mf(xml)).unitToMm, 1000);
});

test('3MF: unknown unit and missing build both fail loudly', () => {
  assert.throws(() => import3mf(make3mf(TWO_PART_3MF.replace('unit="millimeter"', 'unit="parsec"'))), ImportError);
  const noBuild = TWO_PART_3MF.replace(/<build>[\s\S]*<\/build>/, '<build></build>');
  assert.throws(() => import3mf(make3mf(noBuild)), ImportError);
});

test('3MF: a component cycle is an error, not a hang', () => {
  const xml = `<model unit="millimeter">
   <resources>
    <object id="1"><components><component objectid="2"/></components></object>
    <object id="2"><components><component objectid="1"/></components></object>
   </resources>
   <build><item objectid="1"/></build>
  </model>`;
  assert.throws(() => import3mf(make3mf(xml)), /nesting too deep|cycle/);
});

// ── GLB ─────────────────────────────────────────────────────────────────────

const box = (w: number, h: number, d: number) => {
  const tris = boxTriangles(w, h, d);
  const soup = Float32Array.from(tris.flat());
  // writeGlb wants indexed parts; index the soup trivially
  return { positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) };
};

test('GLB: reads back what writeGlb wrote, exactly', () => {
  const parts = [
    { name: 'body', ...box(40, 20, 10) },
    { name: 'cap', ...box(10, 10, 4) },
  ];
  const m = importGlb(writeGlb(parts));
  assert.deepEqual(m.parts.map((p) => p.name), ['body', 'cap']);
  assert.deepEqual([...m.parts[0].positions], [...parts[0].positions]);
  assert.deepEqual([...m.parts[0].indices], [...parts[0].indices]);
});

/** Hand-build a GLB exercising uint16 indices + a node TRS chain. */
function handGlb(): Uint8Array {
  const positions = Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]);
  const indices = Uint16Array.from([0, 1, 2]);
  const pad = (b: Uint8Array) => {
    const out = new Uint8Array((b.length + 3) & ~3);
    out.set(b);
    return out;
  };
  const posBytes = pad(new Uint8Array(positions.buffer.slice(0)));
  const idxBytes = pad(new Uint8Array(indices.buffer.slice(0)));
  const bin = new Uint8Array(posBytes.length + idxBytes.length);
  bin.set(posBytes); bin.set(idxBytes, posBytes.length);

  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    // parent translates +5x, child rotates 90° about Y (quaternion) and has the mesh
    nodes: [
      { name: 'root', translation: [5, 0, 0], children: [1] },
      { name: 'tri', rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], mesh: 0 },
    ],
    meshes: [{ name: 'tri', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [10, 10, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: posBytes.length, byteLength: indices.byteLength },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = new Uint8Array((jsonBytes.length + 3) & ~3).fill(0x20);
  jsonPadded.set(jsonBytes);
  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonPadded, 20);
  view.setUint32(20 + jsonPadded.length, bin.length, true);
  view.setUint32(24 + jsonPadded.length, 0x004e4942, true);
  out.set(bin, 28 + jsonPadded.length);
  return out;
}

test('GLB: node TRS chains are baked into vertices, uint16 indices widen', () => {
  const m = importGlb(handGlb());
  assert.equal(m.parts.length, 1);
  const p = m.parts[0].positions;
  // (10,0,0) rotated 90° about Y → (0,0,-10), then +5x from the parent → (5,0,-10)
  near(p[3], 5); near(p[4], 0); near(p[5], -10);
  // (0,10,0) is on the axis → stays (0,10,0) + 5x
  near(p[6], 5); near(p[7], 10); near(p[8], 0);
  assert.ok(m.parts[0].indices instanceof Uint32Array);
});

test('GLB: compressed inputs are refused with advice, not garbage', () => {
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' },
    extensionsRequired: ['EXT_meshopt_compression'],
    scenes: [{ nodes: [] }],
  }));
  const jsonPadded = new Uint8Array((json.length + 3) & ~3).fill(0x20);
  jsonPadded.set(json);
  const total = 12 + 8 + jsonPadded.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonPadded, 20);
  assert.throws(() => importGlb(out), /meshopt.*standard|standard.*meshopt/i);
});

test('GLB: metre-scale exports are guessed as metres', () => {
  const parts = [{ name: 'bar', positions: Float32Array.from([0, 0, 0, 0.14, 0, 0, 0, 0.05, 0]), indices: Uint32Array.from([0, 1, 2]) }];
  assert.equal(importGlb(writeGlb(parts)).unitToMm, 1000);
  const mmParts = [{ name: 'bar', positions: Float32Array.from([0, 0, 0, 140, 0, 0, 0, 50, 0]), indices: Uint32Array.from([0, 1, 2]) }];
  assert.equal(importGlb(writeGlb(mmParts)).unitToMm, 1);
});

// ── dispatcher + orientation ────────────────────────────────────────────────

test('detectFormat sniffs content, not filenames', () => {
  assert.equal(detectFormat(writeGlb([{ name: 'x', ...box(1, 1, 1) }])), 'glb');
  assert.equal(detectFormat(make3mf(TWO_PART_3MF)), '3mf');
  assert.equal(detectFormat(binaryStl(boxTriangles(1, 1, 1))), 'stl');
});

test('importModel orients a Z-up print file into Y-up mm space', () => {
  // A 3MF is Z-up: the 40×20×10 box has its 10 on Z (height).
  const m = importModel(make3mf(TWO_PART_3MF), { axes: 'x,z,-y' });
  // In canonical space: Y = 0 at the ground, X/Z centred, height on Y.
  near(m.bounds.min[1], 0);
  near(m.bounds.max[1], 14, 1e-3);            // body 10 tall + cap at z=10 → 14
  near(m.bounds.min[0] + m.bounds.max[0], 0); // X centred
  near(m.bounds.min[2] + m.bounds.max[2], 0); // Z centred
});

test('importModel applies a manual unit override', () => {
  const inches = importModel(binaryStl(boxTriangles(1, 1, 1)), { unitToMm: 25.4 });
  const size = inches.bounds.max.map((v: number, i: number) => v - inches.bounds.min[i]);
  near(size[0], 25.4); near(size[1], 25.4); near(size[2], 25.4);
});

test('3MF production extension: meshes in sub-model files (Bambu/Orca shape)', () => {
  // Root file holds only wrappers referencing 3D/Objects/*.model via p:path —
  // the layout that produced "reference to missing object" before multi-file
  // support existed.
  const sub = (name: string, w: number) => `<?xml version="1.0"?>
   <model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
    <resources>
     <object id="1" name="${name}" type="model"><mesh>
      <vertices><vertex x="0" y="0" z="0"/><vertex x="${w}" y="0" z="0"/><vertex x="0" y="${w}" z="0"/></vertices>
      <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
     </mesh></object>
    </resources>
    <build/>
   </model>`;
  const root = `<?xml version="1.0"?>
   <model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
    <resources>
     <object id="2" type="model">
      <components><component p:path="/3D/Objects/object_1.model" objectid="1"/></components>
     </object>
     <object id="3" type="model">
      <components><component p:path="/3D/Objects/object_2.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></components>
     </object>
    </resources>
    <build>
     <item objectid="2"/>
     <item objectid="3" transform="1 0 0 0 1 0 0 0 1 0 50 0"/>
    </build>
   </model>`;
  const bytes = zipSync({
    '3D/3dmodel.model': new TextEncoder().encode(root),
    '3D/Objects/object_1.model': new TextEncoder().encode(sub('Bar Body', 40)),
    '3D/Objects/object_2.model': new TextEncoder().encode(sub('Bar Cap', 10)),
  });

  const m = import3mf(bytes);
  // Wrapper objects are nameless; the part name comes from the sub-file mesh.
  assert.deepEqual(m.parts.map((p) => p.name), ['Bar Body', 'Bar Cap']);
  // Component transform (+5x) composes with the build item transform (+50y).
  near(m.parts[1].positions[0], 5);
  near(m.parts[1].positions[1], 50);
});

test('3MF: a genuinely dangling reference names the file and asks for a report', () => {
  const root = `<model unit="millimeter">
   <resources>
    <object id="2"><components><component objectid="99"/></components></object>
   </resources>
   <build><item objectid="2"/></build>
  </model>`;
  assert.throws(() => import3mf(make3mf(root)), /missing object "99" in 3D\/3dmodel\.model.*report/);
});

test('3MF: mirrored transforms keep the surface facing outward', () => {
  // Signed volume flips sign when winding inverts; a mirrored placement must
  // re-wind or the part renders see-through under back-face culling.
  const signedVolume = (p: Float32Array, idx: Uint32Array) => {
    let v = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
      v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
        - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
        + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    }
    return v;
  };
  const straight = import3mf(make3mf(TWO_PART_3MF));
  const mirrored = import3mf(make3mf(
    TWO_PART_3MF.replace('<item objectid="1"/>', '<item objectid="1" transform="-1 0 0 0 1 0 0 0 1 0 0 0"/>')));
  const vStraight = signedVolume(straight.parts[0].positions, straight.parts[0].indices);
  const vMirrored = signedVolume(mirrored.parts[0].positions, mirrored.parts[0].indices);
  assert.ok(vStraight > 0, `fixture winding should be outward (${vStraight})`);
  assert.ok(vMirrored > 0, `mirrored part must be re-wound outward (${vMirrored})`);
});
