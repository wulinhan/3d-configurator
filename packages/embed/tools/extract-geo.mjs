// Pull the baked GEO object out of an existing *-configurator.html and write
// each part as a GLB. Lets us move to the runtime-loaded pipeline using
// geometry that's already known-good on the live site, instead of re-deriving
// it from the source 3MFs (several of which aren't in this repo).
//
//   node configurator/tools/extract-geo.mjs visualisation/tap-bar-3-configurator.html out/tap-bar-3.glb

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { partsToGlb, glbToParts } from './glb.mjs';

/** Slice out the `const GEO = { … }` literal by brace matching. */
export function readGeo(html) {
  const at = html.indexOf('const GEO = {');
  if (at === -1) throw new Error('no GEO literal found');
  const start = html.indexOf('{', at);
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('unterminated GEO literal');
}

export function geoToParts(geo) {
  return Object.entries(geo).map(([name, g]) => ({
    name,
    positions: Float32Array.from(g.p),
    indices: Uint32Array.from(g.i),
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [src, dest] = process.argv.slice(2);
  if (!src || !dest) { console.error('usage: extract-geo.mjs <configurator.html> <out.glb>'); process.exit(1); }

  const html = readFileSync(src, 'utf8');
  const parts = geoToParts(readGeo(html));
  const glb = partsToGlb(parts, { units: 'mm', source: src });
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, glb);

  // Verify by reading it straight back — a converter you don't check is a
  // converter that silently drops a part.
  const back = glbToParts(readFileSync(dest));
  let worstPos = 0, badIdx = 0;
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i], b = back[i];
    if (a.name !== b.name) throw new Error(`part ${i} name changed: ${a.name} → ${b.name}`);
    if (a.positions.length !== b.positions.length) throw new Error(`${a.name}: vertex count changed`);
    if (a.indices.length !== b.indices.length) throw new Error(`${a.name}: index count changed`);
    for (let k = 0; k < a.positions.length; k++) worstPos = Math.max(worstPos, Math.abs(a.positions[k] - b.positions[k]));
    for (let k = 0; k < a.indices.length; k++) if (a.indices[k] !== b.indices[k]) badIdx++;
  }
  if (badIdx) throw new Error(`${badIdx} indices differ after round-trip`);

  const htmlBytes = Buffer.byteLength(html);
  console.log(`${src} → ${dest}`);
  for (const p of back) {
    const size = ((p.positions.byteLength + p.indices.byteLength) / 1024).toFixed(1);
    console.log(`  ${p.name.padEnd(14)} ${String(p.positions.length / 3).padStart(6)} verts  ${String(p.indices.length / 3).padStart(6)} tris  ${size.padStart(7)} KB`);
  }
  console.log(`  GLB ${(glb.length / 1024).toFixed(0)} KB vs source HTML ${(htmlBytes / 1024).toFixed(0)} KB` +
    `  (${(htmlBytes / glb.length).toFixed(1)}× smaller)`);
  console.log(`  round-trip: ${parts.length} parts identical, worst vertex delta ${worstPos.toExponential(2)} mm`);
}
