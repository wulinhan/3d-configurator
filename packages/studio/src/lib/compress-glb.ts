// Meshopt compression for publish, in the browser.
//
// Same recipe as the embed pipeline's compress step (weld → quantise-14 →
// EXT_meshopt_compression): measured on Tap Bar 3 it cut the wire cost to
// 46 KB gzipped from the 227 KB raw GLB, and quantisation error stays two
// orders of magnitude below a printer layer line. The embed runtime loads
// the result through its lazy meshopt decoder.
//
// WebIO instead of NodeIO is the only difference from the pipeline tool —
// everything else must stay identical, because the fidelity numbers were
// verified against exactly these settings.

import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt, quantize, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

export const QUANTIZE_POSITION = 14;

export async function compressGlb(bytes: Uint8Array): Promise<Uint8Array> {
  await MeshoptEncoder.ready;
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const doc = await io.readBinary(bytes);
  await doc.transform(
    weld(),
    quantize({ quantizePosition: QUANTIZE_POSITION }),
    meshopt({ encoder: MeshoptEncoder }),
  );
  return io.writeBinary(doc);
}
