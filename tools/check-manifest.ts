// Validate a manifest, and cross-check it against the models it references —
// a manifest can be internally consistent and still name a mesh that isn't in
// the GLB, which the validator alone can't see.
//
//   node configurator/tools/check-manifest.ts configurator/demo/tap-bar-3.manifest.json

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { validateManifest } from '../src/manifest/validate.ts';
import type { Manifest } from '../src/manifest/types.ts';
// @ts-ignore — plain-JS tool module, no declarations
import { glbMeshNames } from './glb.mjs';

const [file] = process.argv.slice(2);
if (!file) { console.error('usage: check-manifest.ts <manifest.json>'); process.exit(1); }

const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
const { ok, errors, warnings } = validateManifest(raw);

for (const w of warnings) console.warn(`  warn  ${w.path}: ${w.message}`);
for (const e of errors) console.error(`  error ${e.path}: ${e.message}`);

if (!ok) { console.error(`\n${file}: ${errors.length} error(s)`); process.exit(1); }

// Meshes referenced by parts must actually exist in the referenced GLB.
const m = raw as Manifest;
const base = dirname(resolve(file));
let meshErrors = 0;
for (const source of m.models) {
  const path = resolve(base, source.url);
  if (!existsSync(path)) {
    console.error(`  error models."${source.id}".url: ${source.url} not found`);
    meshErrors++;
    continue;
  }
  // Mesh names live in the JSON chunk, so this reads compressed GLBs without
  // needing a meshopt decoder.
  const names = new Set<string>(glbMeshNames(readFileSync(path)));
  for (const part of m.parts) {
    const [sid, mesh] = part.mesh.split('#');
    if (sid !== source.id) continue;
    if (!names.has(mesh)) {
      console.error(`  error parts."${part.id}".mesh: "${mesh}" is not in ${source.url} (has: ${[...names].join(', ')})`);
      meshErrors++;
    }
  }
  const used = new Set(m.parts.filter((p) => p.mesh.startsWith(`${source.id}#`)).map((p) => p.mesh.split('#')[1]));
  for (const name of names) {
    if (!used.has(name)) console.warn(`  warn  models."${source.id}": mesh "${name}" is in the GLB but no part uses it`);
  }
}
if (meshErrors) { console.error(`\n${file}: ${meshErrors} mesh reference error(s)`); process.exit(1); }

console.log(`${file}: OK — ${m.parts.length} parts, ${m.options.length} options, ` +
  `${(m.palettes ?? []).reduce((n, p) => n + p.swatches.length, 0)} swatches` +
  (warnings.length ? `, ${warnings.length} warning(s)` : ''));
