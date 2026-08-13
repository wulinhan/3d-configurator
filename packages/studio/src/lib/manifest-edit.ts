// Every edit the Studio can make, as pure functions: manifest in, new
// manifest out, original untouched.
//
// The invariant that matters: an operation either returns a manifest that
// still passes validateManifest, or it throws. The Studio's UI is thin — it
// calls these and re-renders — so this file is where "the merchant can't
// produce a broken product page" is actually enforced, and where the tests
// concentrate.

import type {
  Manifest, Part, Option, ColourOption, ChoiceOption, TextOption, UploadOption, TextureType, AxisPlacement, AnchorEdge, Hex, RepeatSpec,
} from '../../../embed/src/manifest/types.ts';
import { validateManifest } from '../../../embed/src/manifest/validate.ts';
import { resolveLayout, modelBounds } from '../../../embed/src/runtime/layout.ts';
import { slug } from './manifest-init.ts';
import type { PartBounds } from './manifest-init.ts';

export class EditError extends Error {}

const HEX = /^#[0-9a-fA-F]{6}$/;
export type Axis = 0 | 1 | 2;
export const AXIS_NAMES = ['x', 'y', 'z'] as const;

const isColour = (o: Option): o is ColourOption => o.type === 'colour';
const isChoice = (o: Option): o is ChoiceOption => o.type === 'choice';

/** Clone, apply, validate. Nothing invalid ever leaves this file. */
function edit(manifest: Manifest, apply: (draft: Manifest) => void): Manifest {
  const draft = structuredClone(manifest);
  apply(draft);
  const { ok, errors } = validateManifest(draft);
  if (!ok) {
    throw new EditError(errors.map((e) => `${e.path}: ${e.message}`).join('; '));
  }
  return draft;
}

function partOf(m: Manifest, partId: string): Part {
  const part = m.parts.find((p) => p.id === partId);
  if (!part) throw new EditError(`no part "${partId}"`);
  return part;
}

function optionOf(m: Manifest, optionId: string): Option {
  const option = m.options.find((o) => o.id === optionId);
  if (!option) throw new EditError(`no option "${optionId}"`);
  return option;
}

// ── size ────────────────────────────────────────────────────────────────────

/** Real millimetres, per axis — raw bbox × scale. What the panel displays. */
export function sizeMm(manifest: Manifest, partId: string, raw: PartBounds): [number, number, number] {
  const scale = partOf(manifest, partId).placement?.scale ?? [1, 1, 1];
  return [0, 1, 2].map((a) => (raw.max[a] - raw.min[a]) * scale[a]) as [number, number, number];
}

/**
 * Set one axis to a millimetre value.
 *
 * Locked: every axis is multiplied by the same ratio, preserving whatever
 * proportions the part currently has (which may already be non-uniform if it
 * was stretched while unlocked — locking afterwards must not snap it back).
 * Unlocked: only the named axis moves.
 */
export function withSizeMm(
  manifest: Manifest, partId: string, axis: Axis, mm: number, raw: PartBounds, lock: boolean,
): Manifest {
  if (!Number.isFinite(mm) || mm <= 0) throw new EditError(`size must be a positive number of millimetres, got ${mm}`);
  const base = raw.max[axis] - raw.min[axis];
  if (base <= 0) throw new EditError('part is flat on that axis — it cannot be sized along it');

  return edit(manifest, (draft) => {
    const part = partOf(draft, partId);
    const scale = [...(part.placement?.scale ?? [1, 1, 1])] as [number, number, number];
    const target = mm / base;
    if (lock) {
      const ratio = target / scale[axis];
      for (let a = 0; a < 3; a++) scale[a] *= ratio;
    } else {
      scale[axis] = target;
    }
    part.placement = { ...part.placement, scale, lockAspect: lock };
  });
}

/** Union size of an explorer entry (assembly / variant set) in laid-out mm. */
export function entrySizeMm(manifest: Manifest, entryId: string, raw: Map<string, PartBounds>): [number, number, number] {
  const entry = entriesOf(manifest).find((e) => e.id === entryId);
  if (!entry) throw new EditError(`no explorer entry "${entryId}"`);
  const layout = resolveLayout(manifest, raw);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const id of entry.parts) {
    const box = layout.get(id)?.box;
    if (!box) continue;
    for (const a of [0, 1, 2]) {
      min[a] = Math.min(min[a], box.min[a]);
      max[a] = Math.max(max[a], box.max[a]);
    }
  }
  if (!Number.isFinite(min[0])) throw new EditError('no geometry to size');
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

/**
 * Resize a whole entry the way one part resizes: every member's scale
 * multiplies by the same ratio and member centres converge on (or spread
 * from) the entry's union centre by it, so the entry scales rigidly about
 * its own middle. Centres land through the same offset slides the position
 * fields use, so anchors survive — the centre pass runs twice because
 * sliding an anchored member before the part it rides has settled would
 * leave it a step behind.
 */
export function withEntrySizeMm(
  manifest: Manifest, entryId: string, axis: Axis, mm: number, raw: Map<string, PartBounds>, lock: boolean,
): Manifest {
  if (!Number.isFinite(mm) || mm <= 0) throw new EditError(`size must be a positive number of millimetres, got ${mm}`);
  const entry = entriesOf(manifest).find((e) => e.id === entryId);
  if (!entry) throw new EditError(`no explorer entry "${entryId}"`);
  const layout = resolveLayout(manifest, raw);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const id of entry.parts) {
    const box = layout.get(id)?.box;
    if (!box) continue;
    for (const a of [0, 1, 2]) {
      min[a] = Math.min(min[a], box.min[a]);
      max[a] = Math.max(max[a], box.max[a]);
    }
  }
  const base = max[axis] - min[axis];
  if (!Number.isFinite(base) || base <= 0) throw new EditError('the set is flat on that axis — it cannot be sized along it');
  const r = mm / base;
  const factors: [number, number, number] = lock ? [r, r, r] : [1, 1, 1];
  if (!lock) factors[axis] = r;
  const unionCentre = [0, 1, 2].map((a) => (min[a] + max[a]) / 2);

  // Targets from the layout BEFORE anything moves.
  const targets = new Map<string, number[]>();
  for (const id of entry.parts) {
    const box = layout.get(id)?.box;
    if (!box) continue;
    const centre = [0, 1, 2].map((a) => (box.min[a] + box.max[a]) / 2);
    targets.set(id, [0, 1, 2].map((a) => unionCentre[a] + (centre[a] - unionCentre[a]) * factors[a]));
  }

  let next = edit(manifest, (draft) => {
    for (const id of entry.parts) {
      const part = partOf(draft, id);
      const scale = [...(part.placement?.scale ?? [1, 1, 1])] as [number, number, number];
      for (let a = 0; a < 3; a++) scale[a] *= factors[a];
      part.placement = { ...part.placement, scale };
    }
    scalePatternGaps(draft, entry.parts, factors);
  });
  for (let pass = 0; pass < 2; pass++) {
    for (const [id, target] of targets) {
      for (const a of [0, 1, 2] as Axis[]) {
        if (factors[a] === 1) continue; // untouched axis — centres stay put
        next = setPartCentre(next, id, a, round3(target[a]), raw);
      }
    }
  }
  return next;
}

/** 3×3 rotation matrices, row-major, column-vector convention — enough to
 * compose rigid turns without pulling three.js into the edit layer. */
type Mat3 = [number, number, number, number, number, number, number, number, number];
const DEG = Math.PI / 180;
const mat3Mul = (a: Mat3, b: Mat3): Mat3 => {
  const out = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
};
/** three.js Euler order 'XYZ' — the order layout feeds mesh.rotation — is
 * the matrix Rx·Ry·Rz. Composing any other order here would make the panel
 * and the viewport disagree about what a turn means. */
const eulerToMat3 = ([x, y, z]: [number, number, number]): Mat3 => {
  const cx = Math.cos(x * DEG), sx = Math.sin(x * DEG);
  const cy = Math.cos(y * DEG), sy = Math.sin(y * DEG);
  const cz = Math.cos(z * DEG), sz = Math.sin(z * DEG);
  const rx: Mat3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const ry: Mat3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rz: Mat3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mat3Mul(rx, mat3Mul(ry, rz));
};
const mat3ToEuler = (m: Mat3): [number, number, number] => {
  const clamped = Math.min(1, Math.max(-1, m[2]));
  const y = Math.asin(clamped);
  let x: number, z: number;
  if (Math.abs(clamped) < 0.9999999) {
    x = Math.atan2(-m[5], m[8]);
    z = Math.atan2(-m[1], m[0]);
  } else {
    x = Math.atan2(m[7], m[4]);
    z = 0;
  }
  return [x / DEG, y / DEG, z / DEG];
};
const mat3Apply = (m: Mat3, v: number[]): [number, number, number] => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/** The union bounding box of an entry\'s members, from the CURRENT layout —
 * its centre is what the panel\'s absolute position fields speak about. */
export function entryBoxOf(
  manifest: Manifest, entryId: string, raw: Map<string, PartBounds>,
): { min: number[]; max: number[]; centre: [number, number, number] } {
  const entry = entriesOf(manifest).find((e) => e.id === entryId);
  if (!entry) throw new EditError(`no explorer entry "${entryId}"`);
  const layout = resolveLayout(manifest, raw);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const id of entry.parts) {
    const box = layout.get(id)?.box;
    if (!box) continue;
    for (const a of [0, 1, 2]) {
      min[a] = Math.min(min[a], box.min[a]);
      max[a] = Math.max(max[a], box.max[a]);
    }
  }
  if (!Number.isFinite(min[0])) throw new EditError('the set has no placed geometry yet');
  return { min, max, centre: [0, 1, 2].map((a) => (min[a] + max[a]) / 2) as [number, number, number] };
}

/**
 * Turn a whole entry — assembly or variant set — rigidly about a pivot.
 *
 * Rigid means what a hand means: every member spins by the same amount AND
 * orbits the pivot, so the assembly turns as one object instead of each
 * part pirouetting in place. Each member\'s stored rotation is composed in
 * matrix space (Euler components cannot simply be added once anything is
 * already turned), and centres are landed with setPartCentre in two passes
 * so members anchored to each other settle instead of double-moving.
 *
 * The pivot defaults to the union centre; the gizmo passes its own centre
 * of mass so the viewport turn happens about the handles the user grabbed.
 */
export function rotateEntry(
  manifest: Manifest, entryId: string, deltaDeg: [number, number, number],
  raw: Map<string, PartBounds>, pivot?: [number, number, number],
): Manifest {
  if (deltaDeg.some((d) => !Number.isFinite(d))) throw new EditError('rotation must be finite degrees');
  if (deltaDeg.every((d) => d === 0)) return manifest;
  const entry = entriesOf(manifest).find((e) => e.id === entryId);
  if (!entry) throw new EditError(`no explorer entry "${entryId}"`);
  const box = entryBoxOf(manifest, entryId, raw);
  const p = pivot ?? box.centre;
  const d = eulerToMat3(deltaDeg);

  const layout = resolveLayout(manifest, raw);
  const targets = new Map<string, [number, number, number]>();
  for (const id of entry.parts) {
    const b = layout.get(id)?.box;
    if (!b) continue;
    const centre = [0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2);
    const spun = mat3Apply(d, [centre[0] - p[0], centre[1] - p[1], centre[2] - p[2]]);
    targets.set(id, [p[0] + spun[0], p[1] + spun[1], p[2] + spun[2]]);
  }

  let next = edit(manifest, (draft) => {
    for (const id of entry.parts) {
      const part = partOf(draft, id);
      const composed = mat3ToEuler(mat3Mul(d, eulerToMat3(part.placement?.rotation ?? [0, 0, 0])));
      part.placement = { ...part.placement, rotation: composed.map(round3) as [number, number, number] };
    }
  });
  for (let pass = 0; pass < 2; pass++) {
    for (const [id, target] of targets) {
      for (const a of [0, 1, 2] as Axis[]) next = setPartCentre(next, id, a, round3(target[a]), raw);
    }
  }
  return next;
}

/**
 * A member's live patterns are part of the entry's shape: scaling the entry
 * scales their linear spacing too, or per-letter runs and repeat rows crowd
 * together while their pieces grow. Angular steps (circle mode) are
 * size-free and stay. Mutates the DRAFT — call inside edit().
 */
function scalePatternGaps(draft: Manifest, partIds: string[], factors: [number, number, number]): void {
  for (const option of draft.options) {
    if (option.type !== 'text' || !option.perChar || !partIds.includes(option.part)) continue;
    const axis = option.perChar.axis ?? 0;
    if ((option.perChar.mode ?? 'line') === 'line' && factors[axis] !== 1) {
      option.perChar = { ...option.perChar, gapMm: round3((option.perChar.gapMm ?? 5) * factors[axis]) };
    }
  }
  for (const id of partIds) {
    const part = draft.parts.find((p) => p.id === id);
    for (const spec of part?.repeats ?? []) {
      const axis = spec.axis ?? 0;
      if (spec.mode === 'line' && factors[axis] !== 1) spec.gapMm = round3((spec.gapMm ?? 5) * factors[axis]);
    }
  }
}

/**
 * Scale a whole entry by a factor about a pivot — the gizmo\'s handle drag,
 * where withEntrySizeMm is the panel\'s absolute field. Uniform on purpose:
 * an assembly stretched on one axis shears its joints apart, which is never
 * what grabbing a corner of the whole thing means.
 */
export function scaleEntryBy(
  manifest: Manifest, entryId: string, factor: number,
  raw: Map<string, PartBounds>, pivot?: [number, number, number],
): Manifest {
  if (!Number.isFinite(factor) || factor <= 0) throw new EditError('scale must be a positive factor');
  if (Math.abs(factor - 1) < 1e-9) return manifest;
  const entry = entriesOf(manifest).find((e) => e.id === entryId);
  if (!entry) throw new EditError(`no explorer entry "${entryId}"`);
  const box = entryBoxOf(manifest, entryId, raw);
  const p = pivot ?? box.centre;

  const layout = resolveLayout(manifest, raw);
  const targets = new Map<string, [number, number, number]>();
  for (const id of entry.parts) {
    const b = layout.get(id)?.box;
    if (!b) continue;
    const centre = [0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2);
    targets.set(id, [0, 1, 2].map((a) => p[a] + (centre[a] - p[a]) * factor) as [number, number, number]);
  }
  let next = edit(manifest, (draft) => {
    for (const id of entry.parts) {
      const part = partOf(draft, id);
      const scale = (part.placement?.scale ?? [1, 1, 1]).map((v) => round3(v * factor)) as [number, number, number];
      part.placement = { ...part.placement, scale };
    }
    scalePatternGaps(draft, entry.parts, [factor, factor, factor]);
  });
  for (let pass = 0; pass < 2; pass++) {
    for (const [id, target] of targets) {
      for (const a of [0, 1, 2] as Axis[]) next = setPartCentre(next, id, a, round3(target[a]), raw);
    }
  }
  return next;
}

/** Land the entry\'s union centre at an absolute coordinate on one axis —
 * the panel\'s position fields, speaking the same mm a part\'s do. */
export function setEntryCentre(
  manifest: Manifest, entryId: string, axis: Axis, mm: number, raw: Map<string, PartBounds>,
): Manifest {
  if (!Number.isFinite(mm)) throw new EditError('position must be a number of millimetres');
  const entry = entriesOf(manifest).find((e) => e.id === entryId);
  if (!entry) throw new EditError(`no explorer entry "${entryId}"`);
  const box = entryBoxOf(manifest, entryId, raw);
  const delta = mm - box.centre[axis];
  if (Math.abs(delta) < 1e-9) return manifest;
  const deltas: [number, number, number] = [0, 0, 0];
  deltas[axis] = round3(delta);
  // The entry may be an assembly, a variant set, or a bare part — the same
  // rigid slide serves all three (a part with a live run counts as one).
  if (entry.kind === 'group') return nudgeGroup(manifest, entryId, deltas);
  if (entry.kind === 'variant') return nudgeVariant(manifest, entryId, deltas);
  return nudgePartsTogether(manifest, entry.parts, deltas);
}

// ── position ────────────────────────────────────────────────────────────────

/**
 * Anchor one axis: "put my `align` edge at `ref`'s `edge`, offset mm away" —
 * or back to `origin` (where the model was authored) with a plain offset.
 */
export function withAnchor(
  manifest: Manifest, partId: string, axis: Axis,
  spec: { align: AnchorEdge; to: string; edge: AnchorEdge; offset: number } | { origin: true; offset?: number },
): Manifest {
  return edit(manifest, (draft) => {
    const part = partOf(draft, partId);
    const placement: AxisPlacement = 'origin' in spec
      ? { to: 'origin', offset: spec.offset ?? 0 }
      : { align: spec.align, to: `${spec.to}:${spec.edge}`, offset: spec.offset };
    part.placement = { ...part.placement, [AXIS_NAMES[axis]]: placement };
  });
}

export function withRotation(manifest: Manifest, partId: string, rotation: [number, number, number]): Manifest {
  if (rotation.some((r) => !Number.isFinite(r))) throw new EditError('rotation must be finite degrees');
  return edit(manifest, (draft) => {
    const part = partOf(draft, partId);
    part.placement = { ...part.placement, rotation };
  });
}

// ── palette ─────────────────────────────────────────────────────────────────

export function addSwatch(manifest: Manifest, paletteId: string, name: string, hex: Hex, priceDelta?: number): Manifest {
  if (!HEX.test(hex)) throw new EditError(`"${hex}" is not #RRGGBB`);
  if (!name.trim()) throw new EditError('a swatch needs a name — it goes on the order');
  return edit(manifest, (draft) => {
    const palette = draft.palettes?.find((p) => p.id === paletteId);
    if (!palette) throw new EditError(`no palette "${paletteId}"`);
    let id = slug(name);
    for (let n = 2; palette.swatches.some((s) => s.id === id); n++) id = `${slug(name)}-${n}`;
    palette.swatches.push({ id, name: name.trim(), hex: hex.toUpperCase(), ...(priceDelta ? { priceDelta } : {}) });
  });
}

/**
 * Remove a swatch. Options defaulting to it are retargeted to the palette's
 * first remaining swatch — silently losing the default would break render,
 * and blocking the removal would make palette cleanup impossible.
 * Returns the retargeted option ids so the UI can say so.
 */
export function removeSwatch(manifest: Manifest, paletteId: string, swatchId: string): { manifest: Manifest; retargeted: string[] } {
  const retargeted: string[] = [];
  const next = edit(manifest, (draft) => {
    const palette = draft.palettes?.find((p) => p.id === paletteId);
    if (!palette) throw new EditError(`no palette "${paletteId}"`);
    const at = palette.swatches.findIndex((s) => s.id === swatchId);
    if (at === -1) throw new EditError(`no swatch "${swatchId}" in palette "${paletteId}"`);
    if (palette.swatches.length === 1) throw new EditError('a palette cannot lose its last swatch');
    palette.swatches.splice(at, 1);
    for (const option of draft.options) {
      if (isColour(option) && option.palette === paletteId && option.default === swatchId) {
        option.default = palette.swatches[0].id;
        retargeted.push(option.id);
      }
    }
  });
  return { manifest: next, retargeted };
}

/** Make a swatch a gradient (hex2 + direction), retune it, or take it back
 * to a solid (hex2 undefined clears both fields). */
export function setSwatchGradient(
  manifest: Manifest, paletteId: string, swatchId: string,
  gradient: { hex2: Hex; axis?: 'x' | 'y' | 'z' } | undefined,
): Manifest {
  if (gradient && !HEX.test(gradient.hex2)) throw new EditError(`"${gradient.hex2}" is not #RRGGBB`);
  if (gradient?.axis !== undefined && !['x', 'y', 'z'].includes(gradient.axis)) {
    throw new EditError(`gradient direction must be "x", "y" or "z"`);
  }
  return edit(manifest, (draft) => {
    const swatch = draft.palettes?.find((p) => p.id === paletteId)?.swatches.find((s) => s.id === swatchId);
    if (!swatch) throw new EditError(`no swatch "${swatchId}" in palette "${paletteId}"`);
    if (gradient) {
      swatch.hex2 = gradient.hex2.toUpperCase() as Hex;
      if (gradient.axis && gradient.axis !== 'y') swatch.gradientAxis = gradient.axis;
      else delete swatch.gradientAxis; // 'y' is the default — keep the manifest lean
    } else {
      delete swatch.hex2;
      delete swatch.gradientAxis;
    }
  });
}

export function setSwatchPrice(manifest: Manifest, paletteId: string, swatchId: string, priceDelta: number | undefined): Manifest {
  if (priceDelta != null && (!Number.isFinite(priceDelta) || priceDelta < 0)) {
    throw new EditError('a swatch surcharge must be zero or more');
  }
  return edit(manifest, (draft) => {
    const swatch = draft.palettes?.find((p) => p.id === paletteId)?.swatches.find((s) => s.id === swatchId);
    if (!swatch) throw new EditError(`no swatch "${swatchId}" in palette "${paletteId}"`);
    if (priceDelta) swatch.priceDelta = priceDelta;
    else delete swatch.priceDelta;
  });
}

// ── options: custom colours & pricing ───────────────────────────────────────

export function setCustomColour(
  manifest: Manifest, optionId: string, rule: { allowed: boolean; priceDelta?: number; priceLabel?: string },
): Manifest {
  if (rule.allowed && rule.priceDelta != null && (!Number.isFinite(rule.priceDelta) || rule.priceDelta < 0)) {
    throw new EditError('the custom-colour surcharge must be zero or more');
  }
  return edit(manifest, (draft) => {
    const option = optionOf(draft, optionId);
    if (!isColour(option)) throw new EditError(`option "${optionId}" is not a colour option`);
    option.custom = rule.allowed
      ? { allowed: true, ...(rule.priceDelta != null ? { priceDelta: rule.priceDelta } : {}), ...(rule.priceLabel ? { priceLabel: rule.priceLabel } : {}) }
      : { allowed: false };
  });
}

export function setChoicePrice(manifest: Manifest, optionId: string, choiceId: string, priceDelta: number | undefined): Manifest {
  if (priceDelta != null && (!Number.isFinite(priceDelta) || priceDelta < 0)) {
    throw new EditError('a choice surcharge must be zero or more');
  }
  return edit(manifest, (draft) => {
    const option = optionOf(draft, optionId);
    if (!isChoice(option)) throw new EditError(`option "${optionId}" is not a choice option`);
    const choice = option.choices.find((c) => c.id === choiceId);
    if (!choice) throw new EditError(`no choice "${choiceId}" on option "${optionId}"`);
    if (priceDelta) choice.priceDelta = priceDelta;
    else delete choice.priceDelta;
  });
}

// ── optional parts (per-part pricing) ───────────────────────────────────────

/**
 * "How much extra a part is if it's selected": the part becomes an add-on —
 * hidden by default, shown when the customer picks it, surcharge attached.
 * Mechanically: a yes/no choice option plus visibleWhen on the part.
 */
export function makePartOptional(manifest: Manifest, partId: string, priceDelta: number, label?: string): Manifest {
  if (!Number.isFinite(priceDelta) || priceDelta < 0) throw new EditError('the add-on price must be zero or more');
  return edit(manifest, (draft) => {
    const part = partOf(draft, partId);
    const optionId = `${partId}-addon`;
    if (draft.options.some((o) => o.id === optionId)) throw new EditError(`"${partId}" is already optional`);
    draft.options.push({
      id: optionId,
      type: 'choice',
      label: label ?? part.label,
      choices: [
        { id: 'no', label: 'None' },
        { id: 'yes', label: `Add ${label ?? part.label}`, ...(priceDelta ? { priceDelta } : {}) },
      ],
      default: 'no',
    });
    part.visibleWhen = { option: optionId, equals: ['yes'] };
  });
}

/** Undo makePartOptional: the part is always there again, its option gone. */
export function makePartRequired(manifest: Manifest, partId: string): Manifest {
  return edit(manifest, (draft) => {
    const part = partOf(draft, partId);
    const rule = part.visibleWhen;
    if (!rule) throw new EditError(`"${partId}" is not optional`);
    delete part.visibleWhen;
    const at = draft.options.findIndex((o) => o.id === rule.option);
    if (at !== -1) draft.options.splice(at, 1);
  });
}

// ── gizmo commits ───────────────────────────────────────────────────────────

/** Set a part's scale multipliers directly — what a scale gizmo commits. */
export function withScale(manifest: Manifest, partId: string, scale: [number, number, number], lockAspect?: boolean): Manifest {
  if (scale.some((v) => !Number.isFinite(v) || v <= 0)) {
    throw new EditError('every scale axis must be a positive number');
  }
  return edit(manifest, (draft) => {
    const part = partOf(draft, partId);
    part.placement = {
      ...part.placement,
      scale,
      ...(lockAspect != null ? { lockAspect } : {}),
    };
  });
}

/** Remember whether a part's proportions are locked. The panel's tick box
 * and the viewport's scale gizmo both read this, so the two agree about
 * what dragging a scale handle should do. */
export function setLockAspect(manifest: Manifest, partId: string, lockAspect: boolean): Manifest {
  return edit(manifest, (draft) => {
    const part = partOf(draft, partId);
    part.placement = { ...part.placement, lockAspect };
  });
}

/**
 * Shift a part by millimetre deltas — what a translate gizmo commits.
 *
 * Works uniformly for anchored and as-modelled axes because both resolve
 * linearly in `offset`: an anchored axis keeps its anchor and slides along
 * it, an origin axis just moves. Dragging never silently rewires what a
 * part is anchored to.
 */
export function nudge(manifest: Manifest, partId: string, deltas: [number, number, number]): Manifest {
  if (deltas.some((v) => !Number.isFinite(v))) throw new EditError('nudge deltas must be finite millimetres');
  return edit(manifest, (draft) => {
    const part = partOf(draft, partId);
    const placement = { ...part.placement };
    (['x', 'y', 'z'] as const).forEach((name, axis) => {
      if (!deltas[axis]) return;
      const current: AxisPlacement = placement[name] ?? { to: 'origin', offset: 0 };
      placement[name] = { ...current, offset: (current.offset ?? 0) + deltas[axis] };
    });
    part.placement = placement;
  });
}

/**
 * Bring a part to the origin: centred on X and Z, sitting on the ground
 * (min-Y at 0). Implemented as offset slides, so anchors survive — the part
 * is moved, not re-wired.
 */
export function partToOrigin(manifest: Manifest, partId: string, raw: Map<string, PartBounds>): Manifest {
  partOf(manifest, partId);
  const box = resolveLayout(manifest, raw).get(partId)?.box;
  if (!box) throw new EditError(`no geometry for "${partId}"`);
  const deltas: [number, number, number] = [
    -(box.min[0] + box.max[0]) / 2,
    -box.min[1],
    -(box.min[2] + box.max[2]) / 2,
  ];
  if (deltas.every((d) => Math.abs(d) < 1e-9)) return manifest;
  return nudge(manifest, partId, deltas);
}

/** Is the part already centred on X/Z and sitting on the ground? The
 * "To origin" button reads this to disable itself rather than offering a
 * move that would do nothing. */
export function isPartAtOrigin(manifest: Manifest, partId: string, raw: Map<string, PartBounds>): boolean {
  const box = resolveLayout(manifest, raw).get(partId)?.box;
  if (!box) return false;
  return Math.abs(box.min[0] + box.max[0]) < 1e-6
    && Math.abs(box.min[1]) < 1e-6
    && Math.abs(box.min[2] + box.max[2]) < 1e-6;
}

/** Bring a whole assembly to the origin, moving it as one rigid thing. */
export function groupToOrigin(manifest: Manifest, groupId: string, raw: Map<string, PartBounds>): Manifest {
  const group = manifest.groups?.find((g) => g.id === groupId);
  if (!group) throw new EditError(`no assembly "${groupId}"`);
  const deltas = toOriginDeltas(manifest, group.parts, raw);
  if (deltas.every((d) => Math.abs(d) < 1e-9)) return manifest;
  return nudgePartsTogether(manifest, group.parts, deltas);
}

export interface GizmoPose {
  /** World position of the mesh (whose origin is the part's raw centre). */
  position: [number, number, number];
  /** Euler XYZ, degrees. */
  rotationDeg: [number, number, number];
  scale: [number, number, number];
}

/**
 * Commit whatever a gizmo did to the mesh back into the manifest.
 *
 * The viewer positions a part's mesh at `rawCentre + layoutTranslate`, so the
 * translation delta is measured against where layout put it — computed here
 * with the same engine, keeping this testable without a renderer.
 */
export function applyGizmoPose(
  manifest: Manifest, partId: string, raw: Map<string, PartBounds>, pose: GizmoPose,
): Manifest {
  const bounds = raw.get(partId);
  if (!bounds) throw new EditError(`no geometry for part "${partId}"`);
  const centre = [0, 1, 2].map((a) => (bounds.min[a] + bounds.max[a]) / 2);

  const part = partOf(manifest, partId);
  const round = (v: number) => Math.round(v * 1000) / 1000;

  let next = manifest;
  const oldScale = part.placement?.scale ?? [1, 1, 1];
  if (pose.scale.some((v, a) => Math.abs(v - oldScale[a]) > 1e-6)) {
    // Junk is refused before the lock can launder it into a valid ratio.
    if (pose.scale.some((v) => !Number.isFinite(v) || v <= 0)) {
      throw new EditError('every scale axis must be a positive number');
    }
    // With proportions locked (the default), dragging ONE scale handle
    // resizes the whole part: the handle that moved furthest from 1 sets
    // the ratio, and every axis takes it. Unlocked, each axis is its own.
    let scale = pose.scale;
    if (part.placement?.lockAspect ?? true) {
      const drive = pose.scale
        .map((v, a) => v / (oldScale[a] || 1))
        .reduce((best, r) => (Math.abs(Math.log(r)) > Math.abs(Math.log(best)) ? r : best), 1);
      scale = oldScale.map((v) => v * drive) as [number, number, number];
    }
    next = withScale(next, partId, scale.map(round) as [number, number, number]);
  }
  const oldRotation = part.placement?.rotation ?? [0, 0, 0];
  if (pose.rotationDeg.some((v, a) => Math.abs(v - oldRotation[a]) > 1e-6)) {
    next = withRotation(next, partId, pose.rotationDeg.map(round) as [number, number, number]);
  }

  // Where does layout put the mesh under the (possibly just-updated)
  // manifest? Any remaining difference is the drag's translation.
  const t = resolveLayout(next, raw).get(partId);
  if (!t) throw new EditError(`layout could not place part "${partId}"`);
  const deltas = [0, 1, 2].map((a) => round(pose.position[a] - (centre[a] + t.translate[a]))) as [number, number, number];
  if (deltas.some((d) => d !== 0)) next = nudge(next, partId, deltas);
  return next;
}

// ── part management ─────────────────────────────────────────────────────────

/** Rename a part's label everywhere it shows. Ids and mesh bindings stay. */
export function renamePart(manifest: Manifest, partId: string, label: string): Manifest {
  if (!label.trim()) throw new EditError('a part needs a name');
  const wasLabel = partOf(manifest, partId).label;
  return edit(manifest, (draft) => {
    partOf(draft, partId).label = label.trim();
    // Options that exist purely for this part read better renamed with it —
    // including the part's entry in any variant set, which customers read.
    for (const option of draft.options) {
      if (isColour(option) && option.parts.length === 1 && option.parts[0] === partId) option.label = label.trim();
      if (option.id === `${partId}-addon`) {
        option.label = label.trim();
        if (isChoice(option)) {
          const yes = option.choices.find((c) => c.id === 'yes');
          if (yes) yes.label = `Add ${label.trim()}`;
        }
      }
      if (isChoice(option) && option.role === 'variant') {
        const choice = option.choices.find((c) => c.id === partId);
        if (choice) choice.label = label.trim();
      }
      // Slots ride the part's rename only while they still wear the DEFAULT
      // name — a name the merchant typed themselves is theirs, and renaming
      // the part must not overwrite what customers already read as "Engraving".
      if (option.type === 'text' && option.part === partId && option.label === `${wasLabel} text`) {
        option.label = `${label.trim()} text`;
      }
      if (option.type === 'upload' && option.part === partId && option.label === `${wasLabel} image`) {
        option.label = `${label.trim()} image`;
      }
    }
  });
}

/** Set a part's surface finish — what the Finish tab edits. `texture: null`
 * removes the procedural finish. */
export function setPartMaterial(
  manifest: Manifest,
  partId: string,
  material: {
    roughness?: number; metalness?: number; flatShading?: boolean;
    texture?: { type: TextureType; scaleMm?: number; strength?: number } | null;
  },
): Manifest {
  for (const key of ['roughness', 'metalness'] as const) {
    const v = material[key];
    if (v !== undefined && (!Number.isFinite(v) || v < 0 || v > 1)) {
      throw new EditError(`${key} must be between 0 and 1`);
    }
  }
  return edit(manifest, (draft) => {
    const part = partOf(draft, partId);
    const { texture, ...rest } = material;
    part.material = { ...part.material, ...rest };
    if (texture === null) delete part.material.texture;
    else if (texture !== undefined) part.material.texture = texture;
  });
}

/**
 * Delete a part, and repair everything that referenced it: parts anchored to
 * it keep their current world position (the anchor collapses to an origin
 * offset computed from the pre-removal layout), its solo colour options and
 * add-on option go, shared colour options just drop it from their list, and
 * dangling colour links re-point somewhere safe.
 */
export function removePart(manifest: Manifest, partId: string, raw: Map<string, PartBounds>): Manifest {
  partOf(manifest, partId);
  const layout = resolveLayout(manifest, raw);

  return edit(manifest, (draft) => {
    for (const part of draft.parts) {
      if (part.id === partId) continue;
      (['x', 'y', 'z'] as const).forEach((name, axis) => {
        const placement = part.placement?.[name];
        if (placement?.to && placement.to !== 'origin' && placement.to.split(':')[0] === partId) {
          const t = layout.get(part.id);
          part.placement = { ...part.placement, [name]: { to: 'origin', offset: t ? round3(t.translate[axis]) : 0 } };
        }
      });
    }

    draft.parts = draft.parts.filter((p) => p.id !== partId);

    // Models nothing references any more go with the part — deleting the
    // last part returns the project to the empty viewport, not a ghost.
    const usedModels = new Set(draft.parts.map((p) => p.mesh.split('#')[0]));
    draft.models = draft.models.filter((m) => usedModels.has(m.id));

    draft.options = draft.options.filter((option) => {
      if (option.id === `${partId}-addon`) return false;
      if ((option.type === 'text' || option.type === 'upload') && option.part === partId) return false;
      if (isColour(option)) {
        option.parts = option.parts.filter((id) => id !== partId);
        return option.parts.length > 0 || option.source === 'used';
      }
      if (isChoice(option) && option.role === 'variant') {
        option.choices = option.choices.filter((c) => c.id !== partId);
        if (option.choices.length < 2) {
          // One variant is no choice — the survivors become always-visible.
          for (const part of draft.parts) {
            if (part.visibleWhen?.option === option.id) delete part.visibleWhen;
          }
          return false;
        }
        if (option.default === partId) option.default = option.choices[0].id;
      }
      return true;
    });

    // Groups shed the member; a one-part group dissolves.
    if (draft.groups) {
      draft.groups = draft.groups
        .map((g) => ({ ...g, parts: g.parts.filter((id) => id !== partId) }))
        .filter((g) => g.parts.length >= 2);
      if (!draft.groups.length) delete draft.groups;
    }

    // Repair colour links and @defaults that pointed at removed options.
    const optionIds = new Set(draft.options.map((o) => o.id));
    const firstColour = draft.options.find((o) => isColour(o) && o.source !== 'used');
    for (const option of draft.options) {
      if (!isColour(option)) continue;
      if (option.linkedTo && !optionIds.has(option.linkedTo)) delete option.linkedTo;
      if (option.default.startsWith('@') && !optionIds.has(option.default.slice(1))) {
        option.default = firstColour && firstColour.id !== option.id
          ? `@${firstColour.id}`
          : draft.palettes?.[0]?.swatches[0]?.id ?? option.default;
      }
    }
  });
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** The colour customers see first for a part — set from the Studio. */
export function setDefaultSwatch(manifest: Manifest, optionId: string, swatchId: string): Manifest {
  return edit(manifest, (draft) => {
    const option = optionOf(draft, optionId);
    if (!isColour(option)) throw new EditError(`option "${optionId}" is not a colour option`);
    option.default = swatchId;
  });
}

/** Give one part exactly another part's placement (position axes + rotation). */
export function copyPlacement(manifest: Manifest, fromId: string, toId: string): Manifest {
  if (fromId === toId) throw new EditError('a part cannot copy its own position');
  const from = partOf(manifest, fromId);
  return edit(manifest, (draft) => {
    const to = partOf(draft, toId);
    const source = structuredClone(from.placement ?? {});
    // Never copy an anchor pointing at the destination itself.
    (['x', 'y', 'z'] as const).forEach((name) => {
      const a = source[name];
      if (a?.to && a.to !== 'origin' && a.to.split(':')[0] === toId) delete source[name];
    });
    to.placement = {
      ...to.placement,
      x: source.x, y: source.y, z: source.z,
      rotation: source.rotation,
    };
  });
}

/**
 * Put a part at exactly another part's location and rotation. Centre lands
 * on centre — the only reading of "same location" that holds when the two
 * parts are different sizes (copied edge-anchors align an edge, not the
 * body). Expressed as live centre→centre anchors, so the pair keeps
 * coinciding when the source later moves. Scale is untouched.
 */
export function matchPose(manifest: Manifest, fromId: string, toId: string): Manifest {
  if (fromId === toId) throw new EditError('pick a different part to match');
  partOf(manifest, fromId);
  return edit(manifest, (draft) => {
    const from = partOf(draft, fromId);
    const to = partOf(draft, toId);
    const placement = { ...(to.placement ?? {}) };
    for (const name of ['x', 'y', 'z'] as const) {
      placement[name] = { align: 'center', to: `${fromId}:center`, offset: 0 };
    }
    if (from.placement?.rotation) placement.rotation = [...from.placement.rotation] as [number, number, number];
    else delete placement.rotation;
    to.placement = placement;
  });
}

/** The laid-out centre of a part, in absolute millimetres. */
export function partCentreMm(manifest: Manifest, partId: string, raw: Map<string, PartBounds>): [number, number, number] {
  partOf(manifest, partId);
  const box = resolveLayout(manifest, raw).get(partId)?.box;
  if (!box) throw new EditError(`no geometry for "${partId}"`);
  return [0, 1, 2].map((a) => (box.min[a] + box.max[a]) / 2) as [number, number, number];
}

/**
 * Place a part's centre at an absolute coordinate on one axis. The panel's
 * position fields speak absolute space; storage stays anchored — the move
 * is an offset slide under whatever anchor the axis has, so joints hold.
 */
export function setPartCentre(
  manifest: Manifest, partId: string, axis: Axis, valueMm: number, raw: Map<string, PartBounds>,
): Manifest {
  if (!Number.isFinite(valueMm)) throw new EditError('position must be finite millimetres');
  const centre = partCentreMm(manifest, partId, raw);
  const delta = valueMm - centre[axis];
  if (Math.abs(delta) < 1e-9) return manifest;
  const deltas: [number, number, number] = [0, 0, 0];
  deltas[axis] = delta;
  return nudge(manifest, partId, deltas);
}

/**
 * Snap two parts face to face. The merchant clicked a face on the part that
 * should MOVE, then a face on the part that stays; the moving part's clicked
 * face is anchored flush against the target's. Expressed as an anchor, so
 * the joint keeps holding when the target part later moves or resizes.
 */
export function snapFaces(
  manifest: Manifest,
  moving: { partId: string; normal: [number, number, number] },
  target: { partId: string; normal: [number, number, number] },
): Manifest {
  if (moving.partId === target.partId) throw new EditError('pick faces on two different parts');
  const axisOf = (n: [number, number, number]): Axis => {
    const abs = n.map(Math.abs);
    const axis = abs.indexOf(Math.max(...abs));
    if (abs[axis] < 0.7) throw new EditError('that face is too angled to snap along one axis');
    return axis as Axis;
  };
  const axis = axisOf(target.normal);
  if (axisOf(moving.normal) !== axis) {
    throw new EditError('the two faces must face along the same axis to snap');
  }
  const movingEdge: AnchorEdge = moving.normal[axis] > 0 ? 'max' : 'min';
  const targetEdge: AnchorEdge = target.normal[axis] > 0 ? 'max' : 'min';
  let next = withAnchor(manifest, moving.partId, axis, {
    align: movingEdge, to: target.partId, edge: targetEdge, offset: 0,
  });
  // The faces must actually MEET, not merely share a plane: a part left at
  // its old lateral position "snaps" into empty air beside the target. The
  // two in-plane axes centre onto the target — all three anchors are live,
  // and the merchant can slide the offsets afterwards.
  for (const lateral of [0, 1, 2] as Axis[]) {
    if (lateral === axis) continue;
    next = withAnchor(next, moving.partId, lateral, {
      align: 'center', to: target.partId, edge: 'center', offset: 0,
    });
  }
  return next;
}

// ── groups & variants ───────────────────────────────────────────────────────

/**
 * Group parts so they read and behave as one thing. Their solo colour
 * options merge into a single option painting every member — one colour
 * control for the customer, which is most of what "one part" means to them.
 */
export function makeGroup(manifest: Manifest, partIds: string[], label: string): Manifest {
  if (partIds.length < 2) throw new EditError('a group needs at least two parts');
  if (!label.trim()) throw new EditError('a group needs a name');
  for (const id of partIds) {
    partOf(manifest, id);
    if (manifest.groups?.some((g) => g.parts.includes(id))) {
      throw new EditError(`part "${id}" is already in a group`);
    }
  }
  return edit(manifest, (draft) => {
    let groupId = slug(label);
    for (let n = 2; (draft.groups ?? []).some((g) => g.id === groupId) || draft.parts.some((p) => p.id === groupId); n++) {
      groupId = `${slug(label)}-${n}`;
    }
    draft.groups = [...(draft.groups ?? []), { id: groupId, label: label.trim(), parts: [...partIds] }];
    // Members KEEP their own colour options: an assembly moves as one thing,
    // but each part stays individually colourable — a clicker's base and
    // button are one object with two finishes.
  });
}

/** Drop a loose part into an existing assembly, merging its colour option. */
export function addPartToGroup(manifest: Manifest, groupId: string, partId: string): Manifest {
  const group = manifest.groups?.find((g) => g.id === groupId);
  if (!group) throw new EditError(`no assembly "${groupId}"`);
  partOf(manifest, partId);
  if (group.parts.includes(partId)) return manifest;
  if (manifest.groups!.some((g) => g.parts.includes(partId))) {
    throw new EditError(`part "${partId}" is already in an assembly`);
  }
  return edit(manifest, (draft) => {
    const g = draft.groups!.find((x) => x.id === groupId)!;
    g.parts.push(partId);
    const merged = draft.options.find(
      (o): o is ColourOption => isColour(o) && o.id === `${groupId}-colour`);
    if (!merged) return;
    const solo = draft.options.find((o): o is ColourOption =>
      isColour(o) && o.source !== 'used' && o.parts.length === 1 && o.parts[0] === partId);
    if (solo && solo.id !== merged.id) {
      draft.options = draft.options.filter((o) => o.id !== solo.id);
      for (const option of draft.options) {
        if (!isColour(option)) continue;
        if (option.linkedTo === solo.id) option.linkedTo = merged.id;
        if (option.default === `@${solo.id}`) option.default = `@${merged.id}`;
      }
      if (!merged.parts.includes(partId)) merged.parts.push(partId);
    } else if (!draft.options.some((o) => isColour(o) && o.parts.includes(partId))) {
      merged.parts.push(partId);
    }
  });
}

/**
 * Pull one part out of an assembly. The part gets its own colour option back
 * (split from the shared one); an assembly left with one member dissolves.
 */
export function removePartFromGroup(manifest: Manifest, groupId: string, partId: string): Manifest {
  const group = manifest.groups?.find((g) => g.id === groupId);
  if (!group || !group.parts.includes(partId)) {
    throw new EditError(`"${partId}" is not in assembly "${groupId}"`);
  }
  return edit(manifest, (draft) => {
    const g = draft.groups!.find((x) => x.id === groupId)!;
    g.parts = g.parts.filter((p) => p !== partId);
    if (g.parts.length < 2) {
      draft.groups = draft.groups!.filter((x) => x.id !== groupId);
      if (!draft.groups.length) delete draft.groups;
    }
    const merged = draft.options.find((o): o is ColourOption =>
      isColour(o) && o.id === `${groupId}-colour` && o.parts.includes(partId));
    if (merged && merged.parts.length > 1) {
      merged.parts = merged.parts.filter((p) => p !== partId);
      let soloId = `${partId}-colour`;
      for (let n = 2; draft.options.some((o) => o.id === soloId); n++) soloId = `${partId}-colour-${n}`;
      const solo: ColourOption = {
        ...structuredClone(merged), id: soloId, label: partOf(draft, partId).label, parts: [partId],
      };
      draft.options.splice(draft.options.findIndex((o) => o.id === merged.id) + 1, 0, solo);
    }
  });
}

/** Dissolve a group. The merged colour option stays — it still makes sense. */
export function ungroup(manifest: Manifest, groupId: string): Manifest {
  if (!manifest.groups?.some((g) => g.id === groupId)) throw new EditError(`no group "${groupId}"`);
  return edit(manifest, (draft) => {
    draft.groups = (draft.groups ?? []).filter((g) => g.id !== groupId);
    if (!draft.groups.length) delete draft.groups;
  });
}

export function renameGroup(manifest: Manifest, groupId: string, label: string): Manifest {
  if (!label.trim()) throw new EditError('a group needs a name');
  return edit(manifest, (draft) => {
    const group = (draft.groups ?? []).find((g) => g.id === groupId);
    if (!group) throw new EditError(`no group "${groupId}"`);
    group.label = label.trim();
    const option = draft.options.find((o) => o.id === `${groupId}-colour`);
    if (option) option.label = label.trim();
  });
}

/**
 * Move a set of parts together by millimetre deltas. Parts anchored to
 * another part IN the set are carried by the anchor already — nudging them
 * too would move them twice.
 */
function nudgePartsTogether(manifest: Manifest, partIds: string[], deltas: [number, number, number]): Manifest {
  const setIds = new Set(partIds);
  let next = manifest;
  for (const partId of partIds) {
    const part = partOf(manifest, partId);
    const effective: [number, number, number] = [...deltas];
    (['x', 'y', 'z'] as const).forEach((name, axis) => {
      const to = part.placement?.[name]?.to;
      if (to && to !== 'origin' && setIds.has(to.split(':')[0])) effective[axis] = 0;
    });
    if (effective.some((d) => d !== 0)) next = nudge(next, partId, effective);
  }
  return next;
}

/** The union box of a set of parts, then deltas that land it at the origin. */
function toOriginDeltas(manifest: Manifest, partIds: string[], raw: Map<string, PartBounds>): [number, number, number] {
  const layout = resolveLayout(manifest, raw);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const partId of partIds) {
    const box = layout.get(partId)?.box;
    if (!box) continue;
    for (const a of [0, 1, 2]) {
      min[a] = Math.min(min[a], box.min[a]);
      max[a] = Math.max(max[a], box.max[a]);
    }
  }
  if (!Number.isFinite(min[0])) throw new EditError('no geometry to move');
  return [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2];
}

/** Move a whole assembly by millimetre deltas. */
export function nudgeGroup(manifest: Manifest, groupId: string, deltas: [number, number, number]): Manifest {
  const group = manifest.groups?.find((g) => g.id === groupId);
  if (!group) throw new EditError(`no group "${groupId}"`);
  return nudgePartsTogether(manifest, group.parts, deltas);
}

/** Move every member of a variant set by millimetre deltas. */
export function nudgeVariant(manifest: Manifest, optionId: string, deltas: [number, number, number]): Manifest {
  const option = optionOf(manifest, optionId);
  if (!isChoice(option) || option.role !== 'variant') throw new EditError(`"${optionId}" is not a variant set`);
  return nudgePartsTogether(manifest, option.choices.map((c) => c.id), deltas);
}

/**
 * Glue a part to another body's face (or unglue it, spec undefined). The
 * target may be a part, an assembly, or a variant set; validation refuses
 * unknown bodies, self-attachment and attachment cycles. While attached the
 * part's own position is overridden by layout — rotation and size still
 * belong to the part.
 */
export function setAttach(
  manifest: Manifest, partId: string,
  spec: { to: string; face: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-'; gapMm?: number; offsetMm?: [number, number, number] } | undefined,
): Manifest {
  if (spec) {
    if (spec.gapMm != null && !Number.isFinite(spec.gapMm)) throw new EditError('the gap must be a number of millimetres');
    if (spec.offsetMm && spec.offsetMm.some((v) => !Number.isFinite(v))) throw new EditError('offsets must be numbers of millimetres');
  }
  return edit(manifest, (draft) => {
    const part = partOf(draft, partId);
    if (!spec) { delete part.attach; return; }
    part.attach = {
      to: spec.to,
      face: spec.face,
      ...(spec.gapMm ? { gapMm: round3(spec.gapMm) } : {}),
      ...(spec.offsetMm && spec.offsetMm.some((v) => v !== 0)
        ? { offsetMm: spec.offsetMm.map(round3) as [number, number, number] } : {}),
    };
  });
}

/** Slide ANY explorer entry — assembly, variant set, or bare part — rigidly.
 * The gizmo's travel path speaks entry ids; this is its one door. */
export function nudgeEntry(manifest: Manifest, entryId: string, deltas: [number, number, number]): Manifest {
  const entry = entriesOf(manifest).find((e) => e.id === entryId);
  if (!entry) throw new EditError(`no explorer entry "${entryId}"`);
  return nudgePartsTogether(manifest, entry.parts, deltas);
}

/** Bring a variant set to the origin, moving all members as one rigid thing. */
export function variantToOrigin(manifest: Manifest, optionId: string, raw: Map<string, PartBounds>): Manifest {
  const option = optionOf(manifest, optionId);
  if (!isChoice(option) || option.role !== 'variant') throw new EditError(`"${optionId}" is not a variant set`);
  const ids = option.choices.map((c) => c.id);
  const deltas = toOriginDeltas(manifest, ids, raw);
  if (deltas.every((d) => Math.abs(d) < 1e-9)) return manifest;
  return nudgePartsTogether(manifest, ids, deltas);
}

/** Rename a variant set — the label customers see on its panel tab. */
export function renameVariantSet(manifest: Manifest, optionId: string, label: string): Manifest {
  if (!label.trim()) throw new EditError('the set needs a name — customers see it');
  return edit(manifest, (draft) => {
    const option = draft.options.find((o) => o.id === optionId);
    if (!option || !isChoice(option) || option.role !== 'variant') {
      throw new EditError(`"${optionId}" is not a variant set`);
    }
    option.label = label.trim();
  });
}

/**
 * In a draft: drop a part's own optional-add-on gate. Joining a pick-one set
 * supersedes being an add-on, and refusing over it was the failure merchants
 * actually hit — the tiny error was easy to miss and the set silently never
 * existed, so the preview had nothing to choose between.
 */
function absorbAddon(draft: Manifest, partId: string): void {
  const part = partOf(draft, partId);
  const rule = part.visibleWhen;
  if (!rule || rule.option !== `${partId}-addon`) return;
  const option = draft.options.find((o) => o.id === rule.option);
  if (option && isChoice(option) && option.role !== 'variant') {
    delete part.visibleWhen;
    draft.options = draft.options.filter((o) => o.id !== rule.option);
  }
}

/**
 * Turn parts into customer-selectable variants: a choice option where
 * exactly one of the parts is visible at a time. A part that was an optional
 * add-on sheds that (the choice replaces it); a part in someone else's
 * choice is refused.
 */
export function makeVariantChoice(manifest: Manifest, partIds: string[], label: string): Manifest {
  if (partIds.length < 2) throw new EditError('a choice needs at least two parts');
  if (!label.trim()) throw new EditError('the choice needs a name — customers see it');
  for (const id of partIds) {
    const part = partOf(manifest, id);
    if (part.visibleWhen && part.visibleWhen.option !== `${id}-addon`) {
      throw new EditError(`part "${id}" is already part of another choice`);
    }
  }
  return edit(manifest, (draft) => {
    for (const id of partIds) absorbAddon(draft, id);
    let optionId = slug(label);
    for (let n = 2; draft.options.some((o) => o.id === optionId); n++) optionId = `${slug(label)}-${n}`;
    draft.options.push({
      id: optionId,
      type: 'choice',
      role: 'variant',
      label: label.trim(),
      choices: partIds.map((id) => ({ id, label: partOf(draft, id).label })),
      default: partIds[0],
    });
    for (const id of partIds) {
      partOf(draft, id).visibleWhen = { option: optionId, equals: [id] };
    }
  });
}

/** Drop a loose part into an existing pick-one set. */
export function addPartToChoice(manifest: Manifest, optionId: string, partId: string): Manifest {
  const option = optionOf(manifest, optionId);
  if (!isChoice(option) || option.role !== 'variant') throw new EditError(`"${optionId}" is not a pick-one set`);
  if (option.choices.some((c) => c.id === partId)) return manifest;
  const part = partOf(manifest, partId);
  if (part.visibleWhen && part.visibleWhen.option !== `${partId}-addon`) {
    throw new EditError(`part "${partId}" already belongs to another choice`);
  }
  if (manifest.groups?.some((g) => g.parts.includes(partId))) {
    throw new EditError(`part "${partId}" is in an assembly — take it out first`);
  }
  return edit(manifest, (draft) => {
    absorbAddon(draft, partId);
    const o = draft.options.find((x) => x.id === optionId) as ChoiceOption;
    o.choices.push({ id: partId, label: partOf(draft, partId).label });
    partOf(draft, partId).visibleWhen = { option: optionId, equals: [partId] };
  });
}

/**
 * Pull one part out of a pick-one set: the part is always included again.
 * Below two remaining choices the set dissolves — "pick one of one" is not a
 * choice.
 */
export function removePartFromChoice(manifest: Manifest, optionId: string, partId: string): Manifest {
  const option = optionOf(manifest, optionId);
  if (!isChoice(option) || option.role !== 'variant' || !option.choices.some((c) => c.id === partId)) {
    throw new EditError(`"${partId}" is not one of the choices in "${optionId}"`);
  }
  return edit(manifest, (draft) => {
    const o = draft.options.find((x) => x.id === optionId) as ChoiceOption;
    o.choices = o.choices.filter((c) => c.id !== partId);
    const part = draft.parts.find((p) => p.id === partId);
    if (part?.visibleWhen?.option === optionId) delete part.visibleWhen;
    if (o.choices.length < 2) {
      draft.options = draft.options.filter((x) => x.id !== optionId);
      for (const p of draft.parts) {
        if (p.visibleWhen?.option === optionId) delete p.visibleWhen;
      }
    } else if (o.default === partId) {
      o.default = o.choices[0].id;
    }
  });
}

/** Undo makeVariantChoice: every part always visible again, option gone. */
export function dissolveVariantChoice(manifest: Manifest, optionId: string): Manifest {
  const option = manifest.options.find((o) => o.id === optionId);
  if (!option || !isChoice(option) || option.role !== 'variant') {
    throw new EditError(`"${optionId}" is not a variant choice`);
  }
  return edit(manifest, (draft) => {
    draft.options = draft.options.filter((o) => o.id !== optionId);
    for (const part of draft.parts) {
      if (part.visibleWhen?.option === optionId) delete part.visibleWhen;
    }
  });
}

/**
 * The clone engine behind Duplicate and Repeat: stamp N copies of an
 * explorer entry — parts, internal anchors, colour options, and (for
 * assemblies / variant sets) the structure itself. A copy lands either by a
 * uniform `deltas` nudge (anchors between members remap to the cloned
 * members; anchors to outside parts stay outside), or by `memberCentres` —
 * absolute laid-out centres per part, which COLLAPSE every anchor on that
 * clone to plain origin offsets (a rotated copy cannot keep axis-aligned
 * joints). `spinDeg` adds to each clone's own vertical rotation.
 * NOTE: the caller must rebuild the viewer's model after this — new parts
 * need meshes.
 */
function stampEntryCopies(
  manifest: Manifest,
  entryId: string,
  copies: Array<{
    deltas?: [number, number, number];
    spinDeg?: number;
    memberCentres?: Map<string, [number, number, number]>;
  }>,
  labelOf: (base: string, k: number) => string,
  raw?: Map<string, PartBounds>,
): Manifest {
  const entry = entriesOf(manifest).find((e) => e.id === entryId);
  if (!entry) throw new EditError(`no explorer entry "${entryId}"`);
  const sourceIds = entry.parts;
  const copyIds: string[][] = [];

  const next = edit(manifest, (draft) => {
    const usedPartIds = new Set(draft.parts.map((p) => p.id));
    const usedOptionIds = new Set(draft.options.map((o) => o.id));
    const dedupe = (base: string, used: Set<string>) => {
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
      return id;
    };

    let insertAt = Math.max(...sourceIds.map((id) => draft.parts.findIndex((p) => p.id === id)));
    for (let k = 0; k < copies.length; k++) {
      const idMap = new Map<string, string>();
      for (const oldId of sourceIds) idMap.set(oldId, dedupe(`${oldId}-copy`, usedPartIds));

      // Clone the parts. Internal anchors follow the clones; visibility rules
      // are stripped (the variant case re-adds its own below — an add-on\'s
      // yes/no option shouldn\'t silently gate two parts).
      const clones: Part[] = sourceIds.map((oldId) => {
        const source = draft.parts.find((p) => p.id === oldId)!;
        const clone = structuredClone(source);
        clone.id = idMap.get(oldId)!;
        clone.label = labelOf(source.label, k);
        delete clone.visibleWhen;
        for (const name of ['x', 'y', 'z'] as const) {
          const a = clone.placement?.[name];
          if (a?.to && a.to !== 'origin') {
            const [ref, edge] = a.to.split(':');
            if (idMap.has(ref)) a.to = `${idMap.get(ref)}:${edge}`;
          }
        }
        const spin = copies[k].spinDeg;
        if (spin) {
          const rotation = clone.placement?.rotation ?? [0, 0, 0];
          clone.placement = { ...clone.placement, rotation: [rotation[0], rotation[1] + spin, rotation[2]] };
        }
        // An absolute landing spot replaces every anchor with plain origin
        // offsets: modelled centre + offset = target centre. Scale and spin
        // act about the centre, so they don't shift it.
        const centre = copies[k].memberCentres?.get(oldId);
        const bounds = raw?.get(oldId);
        if (centre && bounds) {
          const rawCentre = [0, 1, 2].map((a) => (bounds.min[a] + bounds.max[a]) / 2);
          clone.placement = {
            ...clone.placement,
            x: { to: 'origin', offset: round3(centre[0] - rawCentre[0]) },
            y: { to: 'origin', offset: round3(centre[1] - rawCentre[1]) },
            z: { to: 'origin', offset: round3(centre[2] - rawCentre[2]) },
          };
        }
        return clone;
      });
      draft.parts.splice(insertAt + 1, 0, ...clones);
      insertAt += clones.length;

      // Clone colour options that paint only entry members.
      const sourceSet = new Set(sourceIds);
      const colourClones: ColourOption[] = [];
      const colourIdMap = new Map<string, string>();
      for (const option of draft.options) {
        if (!isColour(option) || !option.parts.length || !option.parts.every((p) => sourceSet.has(p))) continue;
        const clone = structuredClone(option);
        clone.id = dedupe(`${option.id}-copy`, usedOptionIds);
        colourIdMap.set(option.id, clone.id);
        clone.label = labelOf(option.label, k);
        clone.parts = option.parts.map((p) => idMap.get(p)!);
        colourClones.push(clone);
      }
      for (const clone of colourClones) {
        if (clone.linkedTo && colourIdMap.has(clone.linkedTo)) clone.linkedTo = colourIdMap.get(clone.linkedTo);
        if (clone.default.startsWith('@') && colourIdMap.has(clone.default.slice(1))) {
          clone.default = `@${colourIdMap.get(clone.default.slice(1))}`;
        }
      }
      draft.options.push(...colourClones);

      if (entry.kind === 'group') {
        const source = draft.groups!.find((g) => g.id === entry.id)!;
        const usedGroupIds = new Set(draft.groups!.map((g) => g.id));
        draft.groups!.push({
          id: dedupe(`${entry.id}-copy`, usedGroupIds),
          label: labelOf(source.label, k),
          parts: sourceIds.map((p) => idMap.get(p)!),
        });
      } else if (entry.kind === 'variant') {
        const source = draft.options.find((o) => o.id === entry.id) as ChoiceOption;
        const newOptionId = dedupe(`${entry.id}-copy`, usedOptionIds);
        draft.options.push({
          ...structuredClone(source),
          id: newOptionId,
          label: labelOf(source.label, k),
          choices: source.choices.map((c) => ({ ...structuredClone(c), id: idMap.get(c.id)! })),
          default: idMap.get(source.default) ?? idMap.get(source.choices[0].id)!,
        });
        for (const oldId of sourceIds) {
          const clone = draft.parts.find((p) => p.id === idMap.get(oldId))!;
          clone.visibleWhen = { option: newOptionId, equals: [idMap.get(oldId)!] };
        }
      }

      copyIds.push(sourceIds.map((id) => idMap.get(id)!));
    }
  });

  let out = next;
  for (let k = 0; k < copies.length; k++) {
    const deltas = copies[k].deltas;
    if (deltas && deltas.some((d) => d !== 0)) out = nudgePartsTogether(out, copyIds[k], deltas);
  }
  return out;
}

/**
 * Duplicate an explorer entry — a loose part, an assembly, or a variant set.
 * The copy lands beside the original, offset by its own width, and is
 * immediately repositionable as one thing.
 */
export function duplicateEntry(manifest: Manifest, entryId: string, raw: Map<string, PartBounds>): Manifest {
  const entry = entriesOf(manifest).find((e) => e.id === entryId);
  if (!entry) throw new EditError(`no explorer entry "${entryId}"`);
  const layout = resolveLayout(manifest, raw);
  let width = 0;
  for (const id of entry.parts) {
    const box = layout.get(id)?.box;
    if (box) width = Math.max(width, box.max[0] - box.min[0]);
  }
  return stampEntryCopies(manifest, entryId, [{ deltas: [Math.max(width * 1.1, width + 5), 0, 0] }],
    (base) => `${base} copy`);
}

/**
 * Repeat an entry along a line or around a circle — the pattern tool.
 * Line: copies march along one axis, pitched at the entry\'s own size plus a
 * clear gap. Circle: a RIGID rotation about the vertical axis through the
 * world origin — the original is taken as facing the tangent, and copy i is
 * the whole entry (every part\'s centre AND its own rotation) turned by
 * i·360°/count, so every instance keeps facing its way round the ring.
 * Anchors on circle copies collapse to absolute offsets: a rotated copy
 * cannot keep axis-aligned joints. `count` is the TOTAL number of
 * instances, original included. Studio-only — the stamped copies are
 * ordinary parts by the time customers see them.
 */
// ── live repeats (parts) ────────────────────────────────────────────────────

/**
 * Add a pattern to a part. Unlike the stamping tool below — which is still
 * how a whole assembly is copied — this stays a PARAMETER of the part: the
 * renderer spawns the copies, the merchant retunes them afterwards, and
 * several stack into a grid.
 */
export function addRepeat(
  manifest: Manifest,
  partId: string,
  spec?: Partial<Omit<RepeatSpec, 'id'>>,
): Manifest {
  partOf(manifest, partId);
  return edit(manifest, (draft) => {
    const part = partOf(draft, partId);
    const repeats = part.repeats ?? [];
    let id = `${partId}-repeat`;
    for (let n = 2; repeats.some((r) => r.id === id); n++) id = `${partId}-repeat-${n}`;
    // Stacking should build a GRID, not a longer line: a new row picks the
    // first axis the existing rows aren't already marching along.
    const taken = new Set(repeats.filter((r) => r.mode === 'line').map((r) => r.axis ?? 0));
    const freeAxis = ([0, 2, 1] as Axis[]).find((a) => !taken.has(a)) ?? 0;
    repeats.push({
      id,
      mode: spec?.mode ?? 'line',
      count: Math.round(spec?.count ?? 3),
      ...(spec?.axis != null ? { axis: spec.axis } : { axis: freeAxis }),
      ...(spec?.gapMm != null ? { gapMm: spec.gapMm } : { gapMm: 5 }),
      ...(spec?.stepDeg != null ? { stepDeg: spec.stepDeg } : {}),
    });
    part.repeats = repeats;
  });
}

/** Retune a pattern in place — what makes a repeat live. */
export function setRepeat(
  manifest: Manifest,
  partId: string,
  repeatId: string,
  patch: Partial<Omit<RepeatSpec, 'id'>>,
): Manifest {
  const part = partOf(manifest, partId);
  if (!part.repeats?.some((r) => r.id === repeatId)) {
    throw new EditError(`"${partId}" has no repeat "${repeatId}"`);
  }
  return edit(manifest, (draft) => {
    const spec = partOf(draft, partId).repeats!.find((r) => r.id === repeatId)!;
    Object.assign(spec, patch);
    if (patch.count != null) spec.count = Math.round(patch.count);
    // Switching pattern drops the other mode's knob rather than leaving a
    // stale number to reappear on the way back.
    if (patch.mode === 'circle') delete spec.axis;
    if (patch.mode === 'line') delete spec.stepDeg;
  });
}

export function removeRepeat(manifest: Manifest, partId: string, repeatId: string): Manifest {
  const part = partOf(manifest, partId);
  if (!part.repeats?.some((r) => r.id === repeatId)) {
    throw new EditError(`"${partId}" has no repeat "${repeatId}"`);
  }
  return edit(manifest, (draft) => {
    const p = partOf(draft, partId);
    p.repeats = p.repeats!.filter((r) => r.id !== repeatId);
    if (!p.repeats.length) delete p.repeats;
  });
}

export function repeatEntry(
  manifest: Manifest,
  entryId: string,
  raw: Map<string, PartBounds>,
  opts: { count: number; mode: 'line' | 'circle'; axis?: Axis; gapMm?: number },
): Manifest {
  if (!Number.isInteger(opts.count) || opts.count < 2 || opts.count > 24) {
    throw new EditError('repeat count must be a whole number between 2 and 24');
  }
  const entry = entriesOf(manifest).find((e) => e.id === entryId);
  if (!entry) throw new EditError(`no explorer entry "${entryId}"`);
  const layout = resolveLayout(manifest, raw);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const id of entry.parts) {
    const box = layout.get(id)?.box;
    if (!box) continue;
    for (const a of [0, 1, 2]) {
      min[a] = Math.min(min[a], box.min[a]);
      max[a] = Math.max(max[a], box.max[a]);
    }
  }
  if (!Number.isFinite(min[0])) throw new EditError('no geometry to repeat');

  const copies: Array<{
    deltas?: [number, number, number];
    spinDeg?: number;
    memberCentres?: Map<string, [number, number, number]>;
  }> = [];
  if (opts.mode === 'line') {
    const axis = opts.axis ?? 0;
    const pitch = (max[axis] - min[axis]) + (opts.gapMm ?? 5);
    for (let i = 1; i < opts.count; i++) {
      const deltas: [number, number, number] = [0, 0, 0];
      deltas[axis] = pitch * i;
      copies.push({ deltas });
    }
  } else {
    const cx = (min[0] + max[0]) / 2;
    const cz = (min[2] + max[2]) / 2;
    if (Math.hypot(cx, cz) < 1) {
      throw new EditError('move the entry away from the origin first — the circle runs around the origin');
    }
    for (let i = 1; i < opts.count; i++) {
      const phi = (2 * Math.PI * i) / opts.count;
      const cosP = Math.cos(phi), sinP = Math.sin(phi);
      // Rotate every member's laid-out centre about the origin by +phi (in
      // the ground plane); the matching body spin is −phi in three.js's
      // Y-rotation convention — together they are one rigid turn.
      const centres = new Map<string, [number, number, number]>();
      for (const id of entry.parts) {
        const box = layout.get(id)?.box;
        if (!box) continue;
        const m = [0, 1, 2].map((a) => (box.min[a] + box.max[a]) / 2);
        centres.set(id, [m[0] * cosP - m[2] * sinP, m[1], m[0] * sinP + m[2] * cosP]);
      }
      copies.push({ memberCentres: centres, spinDeg: -(360 * i) / opts.count });
    }
  }
  return stampEntryCopies(manifest, entryId, copies, (base, k) => `${base} ${k + 2}`, raw);
}


/** Merge scene-rendering knobs — what the Finish tab's Scene sliders edit. */
export function setScene(
  manifest: Manifest,
  scene: { exposure?: number; environmentIntensity?: number; shadowOpacity?: number },
): Manifest {
  return edit(manifest, (draft) => {
    draft.scene = { ...draft.scene, ...scene };
  });
}

// ── explorer entries & ordering ─────────────────────────────────────────────

export type ExplorerEntry =
  | { kind: 'part'; id: string; parts: [string] }
  | { kind: 'group'; id: string; label: string; parts: string[] }
  | { kind: 'variant'; id: string; label: string; parts: string[] };

/**
 * The explorer's row model: groups and variant choices fold their members
 * into one entry, ordered by each entry's first part in manifest order —
 * which is also the order customers meet things in.
 */
export function entriesOf(manifest: Manifest): ExplorerEntry[] {
  const claimed = new Map<string, ExplorerEntry>();
  for (const g of manifest.groups ?? []) {
    const entry: ExplorerEntry = { kind: 'group', id: g.id, label: g.label, parts: [...g.parts] };
    for (const p of g.parts) claimed.set(p, entry);
  }
  for (const o of manifest.options) {
    if (isChoice(o) && o.role === 'variant') {
      const parts = o.choices.map((c) => c.id).filter((id) => manifest.parts.some((p) => p.id === id));
      const entry: ExplorerEntry = { kind: 'variant', id: o.id, label: o.label, parts };
      for (const p of parts) if (!claimed.has(p)) claimed.set(p, entry);
    }
  }
  const out: ExplorerEntry[] = [];
  const emitted = new Set<ExplorerEntry>();
  for (const part of manifest.parts) {
    const entry = claimed.get(part.id);
    if (!entry) {
      out.push({ kind: 'part', id: part.id, parts: [part.id] });
    } else if (!emitted.has(entry)) {
      emitted.add(entry);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Move an explorer entry to a specific position (what a drag drop commits).
 * Rebuilds the parts array from the new entry order (an entry's parts travel
 * together) and re-sorts options to follow — options order is what the
 * customer panel renders.
 */
export function moveEntryTo(manifest: Manifest, entryId: string, toIndex: number): Manifest {
  const entries = entriesOf(manifest);
  const at = entries.findIndex((e) => e.id === entryId);
  if (at === -1) throw new EditError(`no explorer entry "${entryId}"`);
  const to = Math.max(0, Math.min(entries.length - 1, toIndex));
  if (to === at) return manifest;
  const reordered = [...entries];
  const [entry] = reordered.splice(at, 1);
  reordered.splice(to, 0, entry);

  return edit(manifest, (draft) => {
    const byId = new Map(draft.parts.map((p) => [p.id, p]));
    draft.parts = reordered.flatMap((e) => e.parts.map((id) => byId.get(id)!).filter(Boolean));

    const partIndex = new Map(draft.parts.map((p, i) => [p.id, i]));
    const orderKey = (o: Option): number => {
      if (isColour(o)) return Math.min(...o.parts.map((p) => partIndex.get(p) ?? Infinity), Infinity);
      if (isChoice(o) && o.role === 'variant') {
        return Math.min(...o.choices.map((c) => partIndex.get(c.id) ?? Infinity), Infinity);
      }
      if (isChoice(o) && o.id.endsWith('-addon')) {
        return partIndex.get(o.id.slice(0, -'-addon'.length)) ?? Infinity;
      }
      return Infinity;
    };
    draft.options = draft.options
      .map((o, i) => ({ o, i, key: orderKey(o) }))
      .sort((a, b) => a.key - b.key || a.i - b.i)
      .map((x) => x.o);
  });
}

/** Move an explorer entry one step up or down. */
export function moveEntry(manifest: Manifest, entryId: string, direction: -1 | 1): Manifest {
  const entries = entriesOf(manifest);
  const at = entries.findIndex((e) => e.id === entryId);
  if (at === -1) throw new EditError(`no explorer entry "${entryId}"`);
  const to = at + direction;
  if (to < 0 || to >= entries.length) return manifest;
  return moveEntryTo(manifest, entryId, to);
}

// ── 3D text slots ───────────────────────────────────────────────────────────

const TEXT_DEFAULTS = { font: 'sans-bold', sizeMm: 8, depthMm: 2, maxLength: 20, placeholder: 'Text' } as const;

/**
 * Bind a text slot to a picked flat surface of a part. `origin` and `normal`
 * are in the part's local mesh space (what the viewer's surface pick
 * reports), so the slot rides every later move of the part. Defaults are a
 * merchant starting point: 8 mm bold text embossed 2 mm proud.
 */
export function addTextSlot(
  manifest: Manifest,
  partId: string,
  place: {
    origin: [number, number, number];
    normal: [number, number, number];
    /** The pick landed on a curve, so the slot wraps from the start —
     * merchants shouldn't have to know their face is curved before the
     * text looks right on it. */
    curved?: boolean;
  },
): Manifest {
  const part = partOf(manifest, partId);
  let id = `${partId}-text`;
  for (let n = 2; manifest.options.some((o) => o.id === id); n++) id = `${partId}-text-${n}`;
  return edit(manifest, (draft) => {
    draft.options.push({
      id,
      type: 'text',
      label: `${part.label} text`,
      part: partId,
      origin: place.origin.map(round3) as [number, number, number],
      normal: place.normal.map(round3) as [number, number, number],
      ...TEXT_DEFAULTS,
      ...(place.curved ? { wrapSurface: true } : {}),
    });
  });
}

/** The fields a merchant tunes after placing a slot. `perChar: null` turns
 * one-piece-per-letter back off; `colourHex: null` re-matches the part. */
export type TextSlotPatch = Partial<Pick<TextOption,
  'font' | 'sizeMm' | 'depthMm' | 'sinkMm' | 'rotationDeg' | 'bendDeg' | 'liftMm' | 'maxLength' | 'placeholder' | 'priceDelta' | 'pricePerChar' | 'label' | 'style' | 'origin'>>
  & { perChar?: { mode?: 'line' | 'circle'; axis?: Axis; gapMm?: number; stepDeg?: number } | null }
  & { colourHex?: Hex | null }
  & { customerColour?: boolean | null }
  & { colourChoices?: Hex[] | null }
  & { wrapSurface?: boolean | null };

export function setTextSlot(manifest: Manifest, optionId: string, patch: TextSlotPatch): Manifest {
  const option = manifest.options.find((o) => o.id === optionId);
  if (!option || option.type !== 'text') throw new EditError(`"${optionId}" is not a text slot`);
  return edit(manifest, (draft) => {
    const o = draft.options.find((x) => x.id === optionId) as TextOption;
    const { perChar, colourHex, customerColour, colourChoices, wrapSurface, origin, ...rest } = patch;
    Object.assign(o, rest);
    // The sketch plane's origin, typed rather than picked. Part-local mm,
    // same space the face pick writes — the plane's ORIENTATION (the normal)
    // stays as picked, so this slides the text without re-aiming it.
    if (origin !== undefined) {
      if (!Array.isArray(origin) || origin.length !== 3 || origin.some((n) => !Number.isFinite(n))) {
        throw new EditError('position must be three finite numbers, millimetres in the part\'s space');
      }
      o.origin = origin.map(round3) as [number, number, number];
    }
    if (perChar === null) delete o.perChar;
    else if (perChar !== undefined) o.perChar = perChar;
    // The merchant's colour stands on its own — it is what the text renders
    // in whether or not customers may repaint it.
    if (colourHex === null) delete o.colourHex;
    else if (colourHex !== undefined) o.colourHex = colourHex;
    // Closing the choice keeps that colour and drops only the offer.
    if (customerColour === null || customerColour === false) {
      delete o.customerColour;
      delete o.colourChoices;
    } else if (customerColour) o.customerColour = true;
    if (colourChoices === null || colourChoices?.length === 0) delete o.colourChoices;
    else if (colourChoices !== undefined) o.colourChoices = colourChoices;
    // Straightening the slot back onto its sketch plane drops the lift with
    // it — a float only means something against a surface.
    if (wrapSurface === null || wrapSurface === false) { delete o.wrapSurface; delete o.liftMm; }
    else if (wrapSurface) o.wrapSurface = true;
    // Bend and a drawn path are alternative baselines — turning the Bend
    // dial straightens away any drawn curve.
    if (patch.bendDeg !== undefined) delete o.path;
    // The example text is what customers see and type back, so it can never
    // outrun the limit: shortening maxLength trims it to fit.
    if (o.placeholder && o.placeholder.length > (o.maxLength ?? 20)) {
      o.placeholder = o.placeholder.slice(0, o.maxLength ?? 20);
    }
    // An emptied field falls back to its default rather than validating as 0.
    for (const key of ['sinkMm', 'rotationDeg', 'bendDeg', 'liftMm', 'priceDelta', 'pricePerChar'] as const) {
      if (o[key] === 0) delete o[key];
    }
  });
}

/**
 * Draw (or clear, with null) a text slot's freeform baseline: 2–64 anchors
 * in the slot's sketch plane, mm relative to origin. The letters walk the
 * open curve through them. Setting a path clears bendDeg — the two are
 * alternative baselines and the drawn one wins.
 */
export function setTextPath(
  manifest: Manifest,
  optionId: string,
  path: Array<[number, number]> | null,
): Manifest {
  const option = manifest.options.find((o) => o.id === optionId);
  if (!option || option.type !== 'text') throw new EditError(`"${optionId}" is not a text slot`);
  return edit(manifest, (draft) => {
    const o = draft.options.find((x) => x.id === optionId) as TextOption;
    if (path === null || path.length === 0) {
      delete o.path;
      return;
    }
    o.path = path.map(([u, v]) => [round3(u), round3(v)] as [number, number]);
    delete o.bendDeg;
  });
}

export function removeTextSlot(manifest: Manifest, optionId: string): Manifest {
  const option = manifest.options.find((o) => o.id === optionId);
  if (!option || option.type !== 'text') throw new EditError(`"${optionId}" is not a text slot`);
  return edit(manifest, (draft) => {
    draft.options = draft.options.filter((o) => o.id !== optionId);
  });
}

/**
 * Reorder a text slot or image zone among its SIBLINGS — the options of the
 * same kind on the same part. The customiser renders tabs in `options`
 * order, so this is what "move up" means to a customer: the two siblings
 * swap places in the global array and every other option keeps its position.
 * Asking to move past either end is a no-op, not an error — the buttons stay
 * clickable at the edges and simply do nothing, like every reorder control.
 */
export function moveOption(manifest: Manifest, optionId: string, direction: -1 | 1): Manifest {
  const option = manifest.options.find((o) => o.id === optionId);
  if (!option || (option.type !== 'text' && option.type !== 'upload')) {
    throw new EditError(`"${optionId}" is not a text slot or image zone`);
  }
  const siblings = manifest.options
    .map((o, index) => ({ o, index }))
    .filter(({ o }) => o.type === option.type && (o as TextOption | UploadOption).part === (option as TextOption | UploadOption).part);
  const at = siblings.findIndex(({ o }) => o.id === optionId);
  const to = at + direction;
  if (to < 0 || to >= siblings.length) return manifest;
  return edit(manifest, (draft) => {
    const a = siblings[at].index;
    const b = siblings[to].index;
    [draft.options[a], draft.options[b]] = [draft.options[b], draft.options[a]];
  });
}

// ── image zones ─────────────────────────────────────────────────────────────

const IMAGE_DEFAULTS = { widthMm: 30, heightMm: 20, placeholder: 'Image here' } as const;

/**
 * Bind an image zone to a picked surface of a part. Like text slots, `origin`
 * and `normal` are in the part's local mesh space. When the pick measured
 * the face (see fitZoneToRegion), the zone CONFORMS to it — centred on the
 * face, aligned with its edges, opened to its extents; otherwise it opens
 * at the hand-tuned defaults.
 */
export function addImageZone(
  manifest: Manifest,
  partId: string,
  place: {
    origin: [number, number, number];
    normal: [number, number, number];
    widthMm?: number;
    heightMm?: number;
    rotationDeg?: number;
  },
): Manifest {
  const part = partOf(manifest, partId);
  let id = `${partId}-image`;
  for (let n = 2; manifest.options.some((o) => o.id === id); n++) id = `${partId}-image-${n}`;
  const clampMm = (v: number | undefined, fallback: number) =>
    v != null && Number.isFinite(v) ? Math.min(500, Math.max(1, round3(v))) : fallback;
  const spin = place.rotationDeg != null && Number.isFinite(place.rotationDeg)
    ? Math.round(place.rotationDeg * 10) / 10 : 0;
  return edit(manifest, (draft) => {
    draft.options.push({
      id,
      type: 'upload',
      label: `${part.label} image`,
      part: partId,
      origin: place.origin.map(round3) as [number, number, number],
      normal: place.normal.map(round3) as [number, number, number],
      widthMm: clampMm(place.widthMm, IMAGE_DEFAULTS.widthMm),
      heightMm: clampMm(place.heightMm, IMAGE_DEFAULTS.heightMm),
      // Seeded rather than left implicit, so the field the merchant opens
      // holds the words the empty zone is actually showing.
      placeholder: IMAGE_DEFAULTS.placeholder,
      ...(spin ? { rotationDeg: spin } : {}),
    });
  });
}

/** The fields a merchant tunes after placing an image zone. */
export type ImageZonePatch = Partial<Pick<UploadOption,
  'widthMm' | 'heightMm' | 'rotationDeg' | 'priceDelta' | 'maxBytes' | 'label' | 'placeholder'>>;

export function setImageZone(manifest: Manifest, optionId: string, patch: ImageZonePatch): Manifest {
  const option = manifest.options.find((o) => o.id === optionId);
  if (!option || option.type !== 'upload') throw new EditError(`"${optionId}" is not an image zone`);
  return edit(manifest, (draft) => {
    const o = draft.options.find((x) => x.id === optionId) as UploadOption;
    Object.assign(o, patch);
    // An emptied field falls back to its default rather than validating as 0.
    for (const key of ['rotationDeg', 'priceDelta'] as const) {
      if (o[key] === 0) delete o[key];
    }
  });
}

/**
 * Slide a zone's centre within its own plane: `du`/`dv` are millimetres
 * along the ZONE's on-surface axes — including its spin, so a zone fitted
 * to a rotated face slides along its own edges, exactly where the fields
 * point on screen.
 */
export function nudgeImageZone(manifest: Manifest, optionId: string, du: number, dv: number): Manifest {
  const option = manifest.options.find((o) => o.id === optionId);
  if (!option || option.type !== 'upload') throw new EditError(`"${optionId}" is not an image zone`);
  if (!Number.isFinite(du) || !Number.isFinite(dv)) throw new EditError('nudge must be finite');
  // Rebuild the viewer's zone basis from the normal alone…
  const [nx, ny, nz] = option.normal;
  const len = Math.hypot(nx, ny, nz) || 1;
  const n = [nx / len, ny / len, nz / len];
  const up = Math.abs(n[1]) < 0.99 ? [0, 1, 0] : [0, 0, -1];
  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (v: number[]) => { const l = Math.hypot(...v) || 1; return v.map((c) => c / l); };
  const xAxis = norm(cross(up, n));
  const yAxis = norm(cross(n, xAxis));
  // …then turn the step into the zone's spun frame: rotating (du, dv) by
  // rotationDeg about the normal is the same turn the renderer applies.
  const theta = (option.rotationDeg ?? 0) * Math.PI / 180;
  const su = du * Math.cos(theta) - dv * Math.sin(theta);
  const sv = du * Math.sin(theta) + dv * Math.cos(theta);
  return edit(manifest, (draft) => {
    const o = draft.options.find((x) => x.id === optionId) as UploadOption;
    o.origin = o.origin.map((c, i) => round3(c + xAxis[i] * su + yAxis[i] * sv)) as [number, number, number];
  });
}

export function removeImageZone(manifest: Manifest, optionId: string): Manifest {
  const option = manifest.options.find((o) => o.id === optionId);
  if (!option || option.type !== 'upload') throw new EditError(`"${optionId}" is not an image zone`);
  return edit(manifest, (draft) => {
    draft.options = draft.options.filter((o) => o.id !== optionId);
  });
}

// ── camera ──────────────────────────────────────────────────────────────────

/**
 * Fit the manifest's camera to the model as currently laid out.
 *
 * Called at publish: the init camera was framed for the model as imported,
 * and every resize or anchor since has moved the goalposts. Runs the same
 * layout engine the renderer uses, so what it frames is what ships.
 */
export function frameCamera(manifest: Manifest, raw: Map<string, PartBounds>): Manifest {
  const bounds = modelBounds(resolveLayout(manifest, raw));
  if (!Number.isFinite(bounds.min[0])) throw new EditError('no geometry to frame');
  const centre = [0, 1, 2].map((a) => (bounds.min[a] + bounds.max[a]) / 2);
  const span = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
    1,
  );
  return edit(manifest, (draft) => {
    draft.camera = {
      ...draft.camera,
      fov: draft.camera?.fov ?? 38,
      position: [centre[0], centre[1] + span * 0.35, centre[2] + span * 2.1],
      target: [centre[0], centre[1], centre[2]] as [number, number, number],
      minDistance: span * 0.4,
      maxDistance: span * 8,
    };
  });
}

/**
 * Persist the camera pose the merchant is looking at right now as the view
 * customers open to. Marks the camera userSet so publish keeps it verbatim
 * instead of auto-framing.
 */
export function setCameraView(
  manifest: Manifest,
  view: { position: [number, number, number]; target: [number, number, number]; fov?: number },
): Manifest {
  const nums = [...view.position, ...view.target, ...(view.fov != null ? [view.fov] : [])];
  if (nums.some((n) => !Number.isFinite(n))) throw new EditError('camera view must be finite numbers');
  if (view.fov != null && (view.fov <= 0 || view.fov >= 180)) throw new EditError('fov must be between 0 and 180');
  const round = (v: number) => Math.round(v * 100) / 100;
  return edit(manifest, (draft) => {
    draft.camera = {
      ...draft.camera,
      position: view.position.map(round) as [number, number, number],
      target: view.target.map(round) as [number, number, number],
      ...(view.fov != null ? { fov: view.fov } : {}),
      userSet: true,
    };
  });
}

// ── misc ────────────────────────────────────────────────────────────────────

export function withProductName(manifest: Manifest, name: string): Manifest {
  if (!name.trim()) throw new EditError('the product needs a name');
  return edit(manifest, (draft) => {
    draft.name = name.trim();
    draft.id = slug(name);
  });
}

export function withCurrency(manifest: Manifest, currency: string): Manifest {
  if (!/^[A-Z]{3}$/.test(currency)) throw new EditError('currency must be a 3-letter code like SGD or USD');
  return edit(manifest, (draft) => { draft.pricing.currency = currency; });
}
