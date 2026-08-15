// Writers for taking the model OUT of the Studio — the laid-out, baked
// meshes the viewer reports, in whichever format the next tool speaks:
// STL for a slicer that wants one solid, 3MF for one that keeps parts
// separate, OBJ for DCC tools, GLB for the web. All millimetres, all
// triangle lists — no materials, because the downstream tool assigns its
// own.
//
// The 3MF here mirrors the marketing site's image-to-3MF writer (the same
// package layout slicers were already accepting); the GLB rides the
// existing writeGlb.

import { zipSync, strToU8 } from 'fflate';
import { writeGlb } from './write-glb.ts';

export interface ExportMesh {
  name: string;
  positions: Float32Array;
  indices: Uint32Array;
}

export const EXPORT_FORMATS = [
  { id: 'stl', label: 'STL — one solid, for slicers', ext: 'stl', mime: 'model/stl' },
  { id: '3mf', label: '3MF — parts kept separate', ext: '3mf', mime: 'model/3mf' },
  { id: 'obj', label: 'OBJ — for modelling tools', ext: 'obj', mime: 'text/plain' },
  { id: 'glb', label: 'GLB — for the web', ext: 'glb', mime: 'model/gltf-binary' },
] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number]['id'];

export function exportModel(meshes: ExportMesh[], format: ExportFormat, title: string): Uint8Array {
  if (!meshes.length) throw new Error('nothing visible to export');
  switch (format) {
    case 'stl': return writeStl(meshes);
    case '3mf': return write3mf(meshes, title);
    case 'obj': return strToU8(writeObj(meshes));
    case 'glb': return writeGlb(meshes);
  }
}

/** Binary STL: header, triangle count, then normal + 3 vertices each. STL
 * has no part concept — everything lands as one soup, which is exactly
 * what a slicer's "import as single object" expects. */
export function writeStl(meshes: ExportMesh[]): Uint8Array {
  const triCount = meshes.reduce((n, m) => n + m.indices.length / 3, 0);
  const bytes = new Uint8Array(84 + triCount * 50);
  const view = new DataView(bytes.buffer);
  strToU8('AllIn Studio export (mm)').forEach((b, i) => { bytes[i] = b; });
  view.setUint32(80, triCount, true);
  let at = 84;
  for (const mesh of meshes) {
    const p = mesh.positions;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t] * 3, mesh.indices[t + 1] * 3, mesh.indices[t + 2] * 3];
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      view.setFloat32(at, nx, true); view.setFloat32(at + 4, ny, true); view.setFloat32(at + 8, nz, true);
      at += 12;
      for (const i of [a, b, c]) {
        view.setFloat32(at, p[i], true);
        view.setFloat32(at + 4, p[i + 1], true);
        view.setFloat32(at + 8, p[i + 2], true);
        at += 12;
      }
      at += 2; // attribute byte count stays 0
    }
  }
  return bytes;
}

/** Wavefront OBJ: one `o` group per part, shared 1-based vertex numbering. */
export function writeObj(meshes: ExportMesh[]): string {
  const lines: string[] = ['# AllIn Studio export, millimetres'];
  let offset = 1;
  for (const mesh of meshes) {
    lines.push(`o ${mesh.name.replace(/\s+/g, '_')}`);
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      lines.push(`v ${p[i].toFixed(4)} ${p[i + 1].toFixed(4)} ${p[i + 2].toFixed(4)}`);
    }
    const x = mesh.indices;
    for (let t = 0; t < x.length; t += 3) {
      lines.push(`f ${offset + x[t]} ${offset + x[t + 1]} ${offset + x[t + 2]}`);
    }
    offset += p.length / 3;
  }
  return lines.join('\n') + '\n';
}

const xmlSafe = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A minimal, slicer-friendly 3MF package: one object per part, all built. */
export function write3mf(meshes: ExportMesh[], title: string): Uint8Array {
  let res = ' <resources>\n';
  meshes.forEach((mesh, i) => {
    const v: string[] = [], t: string[] = [];
    const p = mesh.positions;
    for (let k = 0; k < p.length; k += 3) {
      v.push(`     <vertex x="${p[k].toFixed(4)}" y="${p[k + 1].toFixed(4)}" z="${p[k + 2].toFixed(4)}"/>`);
    }
    const x = mesh.indices;
    for (let k = 0; k < x.length; k += 3) {
      t.push(`     <triangle v1="${x[k]}" v2="${x[k + 1]}" v3="${x[k + 2]}"/>`);
    }
    res += `  <object id="${i + 1}" type="model" name="${xmlSafe(mesh.name)}">\n   <mesh>\n    <vertices>\n${v.join('\n')}\n    </vertices>\n    <triangles>\n${t.join('\n')}\n    </triangles>\n   </mesh>\n  </object>\n`;
  });
  res += ' </resources>\n';
  let build = ' <build>\n';
  meshes.forEach((_, i) => { build += `  <item objectid="${i + 1}"/>\n`; });
  build += ' </build>\n';
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <metadata name="Title">${xmlSafe(title)}</metadata>
${res}${build}</model>
`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
  });
}
