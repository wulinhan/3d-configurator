// Compress a part GLB for delivery over the wire.
//
// Merchants embed the configurator on their own product pages, so model weight
// is their page-speed budget, not ours. Measured on Tap Bar 3 (17k verts):
//
//   raw GLB from extract-geo   601 KB   (226 KB gzipped)
//   Draco (edgebreaker)         58 KB   ( 51 KB gzipped)
//   quantize-14 + meshopt      106 KB   ( 46 KB gzipped)
//
// Meshopt wins on the wire and its decoder is ~5 KB of WASM against Draco's
// ~200 KB, which matters more than the 12 KB file-size gap when the decoder is
// downloaded on every first visit.
//
// Fidelity at quantizePosition 14 (verified by tools/verify.mjs):
//   worst bbox drift 0.0038 mm, worst vertex drift 0.0076 mm, area Δ ≤0.081%
// — two orders of magnitude below a 0.2 mm printer layer line.
//
//   node configurator/tools/compress.mjs in.glb out.glb
//
// Needs @gltf-transform/{core,extensions,functions} and meshoptimizer, which
// live in the configurator package rather than the site's root manifest.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt, quantize, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

export const QUANTIZE_POSITION = 14;

export async function compressGlb(bytes) {
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const doc = await io.readBinary(new Uint8Array(bytes));
  await doc.transform(
    weld(),                                              // merge duplicate verts
    quantize({ quantizePosition: QUANTIZE_POSITION }),   // float32 → 14-bit ints
    meshopt({ encoder: MeshoptEncoder }),                // EXT_meshopt_compression
  );
  return Buffer.from(await io.writeBinary(doc));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [src, dest] = process.argv.slice(2);
  if (!src || !dest) { console.error('usage: compress.mjs <in.glb> <out.glb>'); process.exit(1); }

  const raw = readFileSync(src);
  const out = await compressGlb(raw);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out);

  const kb = (b) => (b.length / 1024).toFixed(0).padStart(4) + ' KB';
  console.log(`${src} → ${dest}`);
  console.log(`  before ${kb(raw)}  (gz ${kb(gzipSync(raw))})`);
  console.log(`  after  ${kb(out)}  (gz ${kb(gzipSync(out))})  ${(raw.length / out.length).toFixed(1)}× smaller`);
}
