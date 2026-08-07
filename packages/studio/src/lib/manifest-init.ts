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

/**
 * Merge a second imported model into an existing project: parts are renamed
 * clear of collisions, appended to the mesh list, and added to the manifest
 * with their own colour options on the existing palette. The incoming file
 * was normalised by importModel, so its parts arrive centred on X/Z with
 * their combined bottom on the ground — exactly where added parts should
 * appear.
 */
export function mergeModel(
  current: { parts: ImportedPart[]; manifest: Manifest },
  incoming: ImportedPart[],
): { parts: ImportedPart[]; manifest: Manifest } {
  const usedNames = new Set(current.parts.map((p) => p.name));
  const renamed = normalizeParts(incoming).map((part) => {
    let name = part.name;
    for (let n = 2; usedNames.has(name); n++) name = `${part.name}-${n}`;
    usedNames.add(name);
    return { ...part, name };
  });

  const manifest = structuredClone(current.manifest);
  // An empty project starts with no model source at all (nothing to fetch);
  // the first added file brings the source into being.
  if (!manifest.models.length) manifest.models.push({ id: 'model', url: 'model.glb' });
  const usedIds = new Set(manifest.parts.map((p) => p.id));
  const usedOptions = new Set(manifest.options.map((o) => o.id));
  const paletteId = manifest.palettes?.[0]?.id ?? 'default';
  // Alternate defaults across the whole project, like initManifest — since an
  // empty project's FIRST file also arrives through here, defaulting all
  // parts to one swatch would open a multi-part model as a single white blob.
  const swatches = manifest.palettes?.[0]?.swatches ?? [];
  const defaultFor = (nthPart: number) =>
    swatches[nthPart % 2 ? 0 : Math.min(1, swatches.length - 1)]?.id ?? 'white';
  const modelId = manifest.models[0]?.id ?? 'model';

  for (const part of renamed) {
    let id = slug(part.name);
    for (let n = 2; usedIds.has(id); n++) id = `${slug(part.name)}-${n}`;
    usedIds.add(id);
    manifest.parts.push({ id, label: titleCase(part.name), mesh: `${modelId}#${part.name}` });
    let optionId = `${id}-colour`;
    for (let n = 2; usedOptions.has(optionId); n++) optionId = `${id}-colour-${n}`;
    usedOptions.add(optionId);
    manifest.options.push({
      id: optionId,
      type: 'colour',
      label: titleCase(part.name),
      parts: [id],
      palette: paletteId,
      default: defaultFor(manifest.parts.length),
      custom: { allowed: false },
    });
  }

  return { parts: [...current.parts, ...renamed], manifest };
}

/**
 * The placeholder box an empty project is sized against. No model is ever
 * fetched for it — it only gives the ground grid something to be as big as
 * until the first file arrives.
 */
export const EMPTY_BOUNDS: PartBounds = { min: [-60, 0, -60], max: [60, 80, 60] };

/**
 * A new, empty product.
 *
 * Shared by the standalone Studio's "New project" and by creating one on the
 * service, so a saved empty project is byte-for-byte what an unsaved one is.
 * The service will happily store `{}` — an autosave must never be refused —
 * but `{}` is not something the editor can open, and this is the one place
 * that decides what "empty" means.
 */
export function emptyManifest(name = 'New Product'): Manifest {
  const manifest = initManifest([], { name, bounds: EMPTY_BOUNDS });
  manifest.models = [];
  return manifest;
}
