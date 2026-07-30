// Selection state: what the customer has chosen, what colour each part ends
// up, what it costs on top, and what gets posted to the host page.
//
// Pure functions over a manifest — no DOM, no three.js — because this is the
// logic the merchant's cart trusts. If the surcharge arithmetic is wrong the
// customer is undercharged, and that is not a bug you want to find in
// production.

import type {
  Manifest, Option, ColourOption, ChoiceOption, SelectionPayload, Hex,
} from '../manifest/types.ts';

export type Selections = Record<string, string>;

const isColour = (o: Option): o is ColourOption => o.type === 'colour';
const isChoice = (o: Option): o is ChoiceOption => o.type === 'choice';
const HEX = /^#[0-9a-fA-F]{6}$/;

export const isCustomColour = (value: string): boolean => HEX.test(value);

/** Every option's starting value, before the customer touches anything. */
export function defaultSelections(manifest: Manifest): Selections {
  const out: Selections = {};
  for (const o of manifest.options) {
    if (isColour(o) || isChoice(o)) out[o.id] = o.default;
    else if (o.type === 'text') out[o.id] = '';
  }
  return out;
}

/**
 * Follow `@optionId` links until a concrete value appears.
 *
 * A default of `"@sleeve-colour"` means "start matched to the sleeves and keep
 * following them" — how the "Tap to Connect" text behaves today. The link
 * breaks the moment the customer picks something explicit for that option.
 */
export function resolveValue(manifest: Manifest, selections: Selections, optionId: string, depth = 0): string {
  const value = selections[optionId];
  if (value == null) return '';
  if (!value.startsWith('@')) return value;
  // Manifest validation rejects link cycles; this guard covers manifests that
  // reached the runtime without passing through it.
  if (depth > manifest.options.length) return '';
  return resolveValue(manifest, selections, value.slice(1), depth + 1);
}

export interface ResolvedColour {
  hex: Hex;
  /** Swatch name, or the hex itself for a custom colour — goes on the order. */
  name: string;
  custom: boolean;
}

export function resolveColour(manifest: Manifest, selections: Selections, option: ColourOption): ResolvedColour | undefined {
  const value = resolveValue(manifest, selections, option.id);
  if (!value) return undefined;
  if (isCustomColour(value)) return { hex: value.toUpperCase(), name: value.toUpperCase(), custom: true };

  // A `source: 'used'` option picks from colours already on the product, so
  // its value is still a swatch id — every palette is searched, not just its own.
  for (const palette of manifest.palettes ?? []) {
    const swatch = palette.swatches.find((s) => s.id === value);
    if (swatch) return { hex: swatch.hex, name: swatch.name, custom: false };
  }
  return undefined;
}

/** partId → hex, for every part a colour option paints. */
export function partColours(manifest: Manifest, selections: Selections): Map<string, ResolvedColour> {
  const out = new Map<string, ResolvedColour>();
  for (const o of manifest.options) {
    if (!isColour(o)) continue;
    const colour = resolveColour(manifest, selections, o);
    if (colour) for (const partId of o.parts) out.set(partId, colour);
  }
  for (const part of manifest.parts) {
    const fixed = part.material?.fixedColour;
    if (fixed && !out.has(part.id)) out.set(part.id, { hex: fixed, name: fixed, custom: false });
  }
  return out;
}

/** Which parts render, given the current choices. */
export function visibleParts(manifest: Manifest, selections: Selections): Set<string> {
  const out = new Set<string>();
  for (const part of manifest.parts) {
    const rule = part.visibleWhen;
    if (!rule || rule.equals.includes(resolveValue(manifest, selections, rule.option))) out.add(part.id);
  }
  return out;
}

/**
 * The distinct colours currently on the product — the choices a `source:
 * 'used'` option offers. Deduped by hex so picking the same white for body
 * and tiles doesn't show it twice.
 */
export function coloursInUse(manifest: Manifest, selections: Selections): Array<{ id: string; name: string; hex: Hex }> {
  const seen = new Map<string, { id: string; name: string; hex: Hex }>();
  for (const o of manifest.options) {
    if (!isColour(o) || o.source === 'used') continue;
    const value = resolveValue(manifest, selections, o.id);
    const colour = resolveColour(manifest, selections, o);
    if (!colour || seen.has(colour.hex)) continue;
    seen.set(colour.hex, { id: value, name: colour.name, hex: colour.hex });
  }
  return [...seen.values()];
}

export interface PriceDelta {
  optionId: string;
  label: string;
  amount: number;
}

/**
 * Every surcharge the current selection accrues.
 *
 * Custom colours are charged per *distinct* colour, not per part: painting the
 * body and the tiles the same bespoke navy is one filament change, so charging
 * twice would overcharge. Two different bespoke colours are two changes.
 */
export function priceDeltas(manifest: Manifest, selections: Selections): PriceDelta[] {
  const deltas: PriceDelta[] = [];
  const customByHex = new Map<string, { optionIds: string[]; amount: number; labels: string[] }>();

  for (const o of manifest.options) {
    if (isColour(o)) {
      const colour = resolveColour(manifest, selections, o);
      if (!colour) continue;
      if (colour.custom) {
        if (!o.custom?.allowed) continue;
        const entry = customByHex.get(colour.hex) ?? { optionIds: [], amount: 0, labels: [] };
        entry.optionIds.push(o.id);
        entry.labels.push(o.label);
        // Options can price custom colours differently; the dearest wins so a
        // cheap surface can't be used to buy a bespoke colour for an expensive one.
        entry.amount = Math.max(entry.amount, o.custom.priceDelta ?? 0);
        customByHex.set(colour.hex, entry);
        continue;
      }
      const value = resolveValue(manifest, selections, o.id);
      for (const palette of manifest.palettes ?? []) {
        const swatch = palette.swatches.find((s) => s.id === value);
        if (swatch?.priceDelta) deltas.push({ optionId: o.id, label: `${o.label}: ${swatch.name}`, amount: swatch.priceDelta });
      }
    } else if (isChoice(o)) {
      const choice = o.choices.find((c) => c.id === resolveValue(manifest, selections, o.id));
      if (choice?.priceDelta) deltas.push({ optionId: o.id, label: `${o.label}: ${choice.label}`, amount: choice.priceDelta });
    } else if (o.type === 'text') {
      if (o.priceDelta && (selections[o.id] ?? '').trim()) {
        deltas.push({ optionId: o.id, label: o.label, amount: o.priceDelta });
      }
    } else if (o.type === 'upload') {
      if (o.priceDelta && selections[o.id]) deltas.push({ optionId: o.id, label: o.label, amount: o.priceDelta });
    }
  }

  for (const [hex, entry] of customByHex) {
    if (!entry.amount) continue;
    deltas.push({
      optionId: entry.optionIds.join('+'),
      label: `Custom colour ${hex} (${entry.labels.join(', ')})`,
      amount: entry.amount,
    });
  }
  return deltas;
}

export function buildPayload(manifest: Manifest, selections: Selections): SelectionPayload {
  const deltas = priceDeltas(manifest, selections);
  const colourNames: Record<string, string> = {};
  const resolved: Selections = {};

  for (const o of manifest.options) {
    resolved[o.id] = resolveValue(manifest, selections, o.id);
    if (isColour(o)) {
      const colour = resolveColour(manifest, selections, o);
      if (colour) colourNames[o.id] = colour.name;
    }
  }

  return {
    type: 'configurator:change',
    productId: manifest.id,
    manifestVersion: manifest.version,
    selections: resolved,
    colourNames,
    priceDeltas: deltas,
    deltaTotal: Math.round(deltas.reduce((s, d) => s + d.amount, 0) * 100) / 100,
    currency: manifest.pricing.currency,
  };
}
