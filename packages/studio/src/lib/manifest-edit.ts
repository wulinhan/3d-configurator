// Every edit the Studio can make, as pure functions: manifest in, new
// manifest out, original untouched.
//
// The invariant that matters: an operation either returns a manifest that
// still passes validateManifest, or it throws. The Studio's UI is thin — it
// calls these and re-renders — so this file is where "the merchant can't
// produce a broken product page" is actually enforced, and where the tests
// concentrate.

import type {
  Manifest, Part, Option, ColourOption, ChoiceOption, AxisPlacement, AnchorEdge, Hex,
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
    next = withScale(next, partId, pose.scale.map(round) as [number, number, number]);
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
  return edit(manifest, (draft) => {
    partOf(draft, partId).label = label.trim();
    // Options that exist purely for this part read better renamed with it.
    for (const option of draft.options) {
      if (isColour(option) && option.parts.length === 1 && option.parts[0] === partId) option.label = label.trim();
      if (option.id === `${partId}-addon`) {
        option.label = label.trim();
        if (isChoice(option)) {
          const yes = option.choices.find((c) => c.id === 'yes');
          if (yes) yes.label = `Add ${label.trim()}`;
        }
      }
    }
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
  if (manifest.parts.length === 1) throw new EditError('the last part cannot be deleted');
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

    draft.options = draft.options.filter((option) => {
      if (option.id === `${partId}-addon`) return false;
      if (isColour(option)) {
        option.parts = option.parts.filter((id) => id !== partId);
        return option.parts.length > 0 || option.source === 'used';
      }
      return true;
    });

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
  return withAnchor(manifest, moving.partId, axis, {
    align: movingEdge, to: target.partId, edge: targetEdge, offset: 0,
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
