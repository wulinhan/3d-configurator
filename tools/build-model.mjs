// One command from a live configurator page to a shippable model:
//
//   node configurator/tools/build-model.mjs visualisation/tap-bar-3-configurator.html models/tap-bar-3.glb --axes y,z,x
//
// extract → orient → compress → verify, and it exits non-zero if the
// compressed model drifted from the original. Nothing ships unchecked.
//
// `--axes` is the source model's axis convention (see tools/orient.mjs). The
// existing configurators bake this in as `THREE.x = 3MF.y - CX`, i.e. `y,z,x`
// for every Tap Bar.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readGeo, geoToParts } from './extract-geo.mjs';
import { partsToGlb } from './glb.mjs';
import { orientParts } from './orient.mjs';
import { compressGlb } from './compress.mjs';
import { compare, DEFAULT_TOLERANCE_MM } from './verify.mjs';

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
  else positional.push(argv[i]);
}
const flag = (name, fallback) => flags[name] ?? fallback;
const [src, dest] = positional;
if (!src || !dest) { console.error('usage: build-model.mjs <configurator.html> <out.glb> [--axes y,z,x] [--scale 1]'); process.exit(1); }

const kb = (b) => (b.length / 1024).toFixed(0).padStart(4) + ' KB';
const raw = readFileSync(src, 'utf8');

// 1. Extract, then normalise into canonical space (mm, Y-up, centred on the
//    ground plane) so manifest anchors mean the same thing for every product.
//    The intermediate stays on disk because verify needs an uncompressed
//    reference to diff the compressed output against.
const oriented = orientParts(geoToParts(readGeo(raw)), {
  axes: flag('axes', 'x,y,z'),
  scaleToMm: Number(flag('scale', 1)),
});
const parts = oriented.parts;
const dim = oriented.bounds.max.map((v, i) => v - oriented.bounds.min[i]);
console.log(`orient   axes ${oriented.axes} → ${dim.map((v) => v.toFixed(1)).join(' × ')} mm ` +
  `(W×H×D), origin at ground centre`);
const plain = partsToGlb(parts, { units: 'mm', source: basename(src), axes: oriented.axes });
const plainPath = join(dirname(dest), `${basename(dest, extname(dest))}.raw.glb`);
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(plainPath, plain);
console.log(`extract  ${parts.length} parts, ${parts.reduce((n, p) => n + p.positions.length / 3, 0)} verts → ${plainPath}`);

// 2. Compress.
const packed = await compressGlb(plain);
writeFileSync(dest, packed);
console.log(`compress ${kb(plain)} (gz ${kb(gzipSync(plain))}) → ${kb(packed)} (gz ${kb(gzipSync(packed))})  ${(plain.length / packed.length).toFixed(1)}×`);

// 3. Verify.
const rows = await compare(plainPath, dest);
let worstBox = 0, worstVert = 0, missing = [];
for (const r of rows) {
  if (r.missing) { missing.push(r.name); continue; }
  worstBox = Math.max(worstBox, r.box);
  worstVert = Math.max(worstVert, r.vert);
}
if (missing.length) { console.error(`verify   FAIL — parts dropped: ${missing.join(', ')}`); process.exit(1); }
if (worstBox >= DEFAULT_TOLERANCE_MM || worstVert >= DEFAULT_TOLERANCE_MM) {
  console.error(`verify   FAIL — bbox ${worstBox.toFixed(4)} mm, vertex ${worstVert.toFixed(4)} mm ` +
    `exceeds ${DEFAULT_TOLERANCE_MM} mm tolerance`);
  process.exit(1);
}
console.log(`verify   PASS — worst bbox ${worstBox.toFixed(4)} mm, worst vertex ${worstVert.toFixed(4)} mm ` +
  `(tolerance ${DEFAULT_TOLERANCE_MM} mm)`);
