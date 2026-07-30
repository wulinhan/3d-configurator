// First manifest from a freshly imported model — the starting point every
// Studio edit operates on. Deliberately conservative: one colour option per
// part, one starter palette, camera framed from the model's real size.
// Everything here is a default the merchant is expected to change; nothing
// here should be a decision they can't.

import type { Manifest, Part, ColourOption } from '../../../embed/src/manifest/types.ts';
import type { ImportedPart } from './types.ts';
import { normalizeParts } from './import-model.ts';

export interface PartBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

/** Untransformed bbox per part, keyed by (unique, normalised) part name. */
export function boundsOf(parts: ImportedPart[]): Map<string, PartBounds> {
  const out = new Map<string, PartBounds>();
  for (const part of normalizeParts(parts)) {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const p = part.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (p[i + a] < min[a]) min[a] = p[i + a];
        if (p[i + a] > max[a]) max[a] = p[i + a];
      }
    }
    out.set(part.name, { min, max });
  }
  return out;
}

/**
 * The same bounds keyed by manifest part id, resolved through each part's
 * mesh reference — the one link that is guaranteed to hold, since ids are
 * slugs that can collide where names cannot.
 */
export function boundsByPartId(manifest: Manifest, byName: Map<string, PartBounds>): Map<string, PartBounds> {
  const out = new Map<string, PartBounds>();
  for (const part of manifest.parts) {
    const bounds = byName.get(part.mesh.split('#')[1]);
    if (bounds) out.set(part.id, bounds);
  }
  return out;
}

// A working palette so the first render isn't a wall of grey. Merchants
// replace these; they're the same finishes the demo product uses.
const STARTER_SWATCHES = [
  { id: 'white', name: 'White', hex: '#FEFEFE' },
  { id: 'black', name: 'Black', hex: '#1A1A1A' },
  { id: 'grey', name: 'Grey', hex: '#9E9E9E' },
  { id: 'red', name: 'Red', hex: '#C82020' },
  { id: 'orange', name: 'Orange', hex: '#F9912F' },
  { id: 'yellow', name: 'Yellow', hex: '#FDD35D' },
  { id: 'green', name: 'Forest Green', hex: '#246B2C' },
  { id: 'blue', name: 'Sky Blue', hex: '#3C78D7' },
];

export interface InitOptions {
  /** Product name; the id is its slug. */
  name: string;
  currency?: string;
  /** Combined model bounds in canonical mm space, for camera framing. */
  bounds: PartBounds;
}

export function initManifest(rawParts: ImportedPart[], opts: InitOptions): Manifest {
  // Same normalisation importModel applies, and it's idempotent — so the mesh
  // names referenced here match the GLB written from importModel's output
  // even if a caller hands us un-normalised parts.
  const parts = normalizeParts(rawParts);
  const usedIds = new Set<string>();
  const partDefs: Part[] = [];
  const options: ColourOption[] = [];

  for (const part of parts) {
    let id = slug(part.name);
    for (let n = 2; usedIds.has(id); n++) id = `${slug(part.name)}-${n}`;
    usedIds.add(id);

    partDefs.push({ id, label: titleCase(part.name), mesh: `model#${part.name}` });
    options.push({
      id: `${id}-colour`,
      type: 'colour',
      label: titleCase(part.name),
      parts: [id],
      palette: 'default',
      // Alternate so a multi-part model doesn't open as one white blob.
      default: partDefs.length % 2 ? 'white' : 'black',
      custom: { allowed: false },
    });
  }

  const size = opts.bounds.max.map((v, i) => v - opts.bounds.min[i]);
  const span = Math.max(...size, 1);
  const centreY = (opts.bounds.min[1] + opts.bounds.max[1]) / 2;

  return {
    schema: 1,
    id: slug(opts.name),
    name: opts.name,
    version: '0.1.0',
    units: 'mm',
    models: [{ id: 'model', url: 'model.glb' }],
    parts: partDefs,
    palettes: [{ id: 'default', label: 'Finish Colour', swatches: structuredClone(STARTER_SWATCHES) }],
    options,
    camera: {
      fov: 38,
      position: [0, centreY + span * 0.35, span * 2.2],
      target: [0, centreY, 0],
      minDistance: span * 0.5,
      maxDistance: span * 6,
      background: '#F8F6F1',
    },
    pricing: { currency: opts.currency ?? 'SGD' },
  };
}

const titleCase = (s: string): string =>
  s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() || 'Part';
