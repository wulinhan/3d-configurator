// Selection state: what the customer has chosen, what colour each part ends
// up, what it costs on top, and what gets posted to the host page.
//
// Pure functions over a manifest — no DOM, no three.js — because this is the
// logic the merchant's cart trusts. If the surcharge arithmetic is wrong the
// customer is undercharged, and that is not a bug you want to find in
// production.

import type {
  Manifest, Option, ColourOption, ChoiceOption, UploadOption, SelectionPayload, Hex,
} from '../manifest/types.ts';

export type Selections = Record<string, string>;

const isColour = (o: Option): o is ColourOption => o.type === 'colour';
const isChoice = (o: Option): o is ChoiceOption => o.type === 'choice';
const HEX = /^#[0-9a-fA-F]{6}$/;

export const isCustomColour = (value: string): boolean => HEX.test(value);

/**
 * Where a text slot's CUSTOMER-chosen colour lives in the selections map.
 * The slot already owns its id (the typed string), so its colour rides a
 * derived key. An empty value means "follow the carrier part" — what every
 * slot does until the merchant opens the choice up.
 */
export const textColourKey = (optionId: string): string => `${optionId}:colour`;

/** Every #RRGGBB the merchant put in a palette — the allowlist a customer's
 * text colour must land in, so a hand-edited payload cannot paint the model
 * a colour the product does not sell. */
function paletteHexes(manifest: Manifest): Set<string> {
  const out = new Set<string>();
  for (const p of manifest.palettes ?? []) {
    for (const s of p.swatches) if (s.available !== false) out.add(s.hex.toUpperCase());
  }
  return out;
}

/** The swatches a text slot offers its customers: the merchant's chosen
 * subset, or the whole palette when they didn't narrow it. Always a subset
 * of the palette — a stale hex in `colourChoices` offers nothing. */
export function textColourChoices(manifest: Manifest, option: Option): string[] {
  if (option.type !== 'text') return [];
  const palette = paletteHexes(manifest);
  const wanted = option.colourChoices?.map((h) => h.toUpperCase()).filter((h) => palette.has(h));
  return wanted?.length ? wanted : [...palette];
}

/** The colour a text slot renders in: the customer's pick when the slot
 * opens that choice, otherwise the merchant's pinned colour — and when
 * neither, undefined, meaning the text shares the carrier part's material. */
export function textColour(manifest: Manifest, selections: Selections, option: Option): Hex | undefined {
  if (option.type !== 'text') return undefined;
  // The merchant's colour is the slot's colour, full stop — opening the
  // choice up only lets a customer paint OVER it.
  if (!option.customerColour) return option.colourHex;
  const picked = (selections[textColourKey(option.id)] ?? '').toUpperCase();
  if (picked && textColourChoices(manifest, option).includes(picked)) return picked as Hex;
  return option.colourHex;
}

/** Every option's starting value, before the customer touches anything. */
export function defaultSelections(manifest: Manifest): Selections {
  const out: Selections = {};
  for (const o of manifest.options) {
    if (isColour(o) || isChoice(o)) out[o.id] = o.default;
    else if (o.type === 'text' || o.type === 'upload') {
      out[o.id] = '';
      // A slot whose colour customers choose opens on the merchant's pick;
      // empty means it follows the part, like a locked slot always does.
      if (o.type === 'text' && o.customerColour) out[textColourKey(o.id)] = o.colourHex ?? '';
    }
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
 * Whether an option currently does anything. A colour option whose every
 * painted part is hidden — the un-picked side of a pick-one set — is inert:
 * showing it invites the customer to configure a part they are not getting,
 * and pricing it would charge them for it. Text and upload options follow
 * their carrier part the same way. Choice options are always live (the
 * pick-one choice itself must stay visible to switch).
 */
export function isOptionActive(
  manifest: Manifest,
  selections: Selections,
  option: Option,
  visible: Set<string> = visibleParts(manifest, selections),
): boolean {
  if (isColour(option)) return option.parts.some((p) => visible.has(p));
  if (option.type === 'text' || option.type === 'upload') return visible.has(option.part);
  return true;
}

/** A customer's image-zone state, decoded from its selections JSON. */
export interface UploadState {
  /**
   * What the viewer draws: an inline data: URL when the configurator runs
   * with no server behind it, or an https: URL on the upload service when
   * there is one. The renderer does not care which.
   */
  img: string;
  /** The upload's id on the service, when the picture lives there — this is
   * what the cart carries and what the workshop later resolves. */
  up?: string;
  /** Offset within the zone, mm. */
  u: number;
  v: number;
  /** Uniform size percent, 10-500. 100 = largest fit inside the zone;
   * beyond 100 the image outgrows the zone and crops to it. */
  s: number;
}

/**
 * What an empty image zone says — one answer for the veil in the viewport
 * and the hint under the panel's button, so the two can never disagree.
 * Absent falls back to "Image here"; an empty (or blank) string is the
 * merchant asking for silence.
 */
export function zonePlaceholder(option: UploadOption): string {
  return option.placeholder === undefined ? 'Image here' : option.placeholder.trim();
}

/** The host this product's artwork is allowed to come from, or '' when the
 * manifest names no upload service and only inline images are legal. */
export function uploadHost(manifest: Manifest): string {
  if (!manifest.uploads?.url) return '';
  try { return new URL(manifest.uploads.url).host; } catch { return ''; }
}

/**
 * Parse an upload selection value; empty/garbage decodes to null.
 *
 * Two shapes are legal, because one runtime serves both deployments: a
 * merchant hosting two files themselves (the image inline, as a data: URL)
 * and a merchant on the service (an https: URL and an id). Nothing else
 * passes — an http: or javascript: value in a selection is not a picture,
 * it is an attempt.
 *
 * `host` narrows the https case to the product's OWN upload service. Callers
 * that have the manifest pass it; the renderer, reading a value that already
 * came through `applySelection`, does not need to.
 */
export function parseUploadState(value: string | undefined, host?: string): UploadState | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as Partial<UploadState>;
    if (typeof raw.img !== 'string') return null;
    if (!raw.img.startsWith('data:image/')) {
      if (!raw.img.startsWith('https://')) return null;
      if (host !== undefined && (!host || new URL(raw.img).host !== host)) return null;
    }
    return {
      img: raw.img,
      ...(typeof raw.up === 'string' && raw.up ? { up: raw.up } : {}),
      u: Number.isFinite(raw.u) ? (raw.u as number) : 0,
      v: Number.isFinite(raw.v) ? (raw.v as number) : 0,
      s: Math.min(500, Math.max(10, Number.isFinite(raw.s) ? (raw.s as number) : 100)),
    };
  } catch {
    return null;
  }
}

/**
 * What a text option can actually render: the bundled fonts carry printable
 * ASCII only, so anything else is dropped rather than rendered as tofu, and
 * the length is clamped to the merchant's limit.
 */
export function sanitiseText(value: string, maxLength: number): string {
  let out = '';
  for (const ch of value) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c <= 126) out += ch;
    if (out.length >= maxLength) break;
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

/**
 * Apply a customer's change to the selections. Switching a variant set
 * carries the set's current colour to the incoming member: the customer
 * picked "red tile", not "red LinkedIn tile" — swapping which tile it is
 * should not silently un-pick the colour.
 */
export function applySelection(manifest: Manifest, selections: Selections, optionId: string, value: string): void {
  // A text slot's colour rides a derived key; only palette colours (or
  // "follow the part") are accepted, whatever a host page posts in.
  if (optionId.endsWith(':colour')) {
    const slot = manifest.options.find(
      (o) => o.type === 'text' && o.customerColour && textColourKey(o.id) === optionId);
    if (slot) {
      const offered = textColourChoices(manifest, slot);
      selections[optionId] = offered.includes(value.toUpperCase()) ? value.toUpperCase() : '';
      return;
    }
  }
  const option = manifest.options.find((o) => o.id === optionId);
  if (option?.type === 'text') {
    selections[optionId] = sanitiseText(value, option.maxLength ?? 20);
    return;
  }
  if (option?.type === 'upload') {
    // A remote image may only come from THIS product's own upload service.
    // Without that, any https URL in a selection would be drawn onto the
    // part and carried into the order, and the picture the workshop prints
    // would be one the merchant never received.
    const state = parseUploadState(value, uploadHost(manifest));
    if (!state) { selections[optionId] = ''; return; }
    // The zone is the law: the image's centre may roam but never abandon
    // it (an oversized image pans within its overflow — the renderer
    // clamps exactly; this is the payload's sanity bound).
    selections[optionId] = JSON.stringify({
      img: state.img,
      ...(state.up ? { up: state.up } : {}),
      u: Math.min(option.widthMm * 2, Math.max(-option.widthMm * 2, state.u)),
      v: Math.min(option.heightMm * 2, Math.max(-option.heightMm * 2, state.v)),
      s: state.s,
    });
    return;
  }
  const memberColour = (): ColourOption | undefined => {
    if (!option || !isChoice(option) || option.role !== 'variant') return undefined;
    // The set's member parts are the ones whose visibility hangs on it — not
    // the choice ids, which only coincide with part ids in the simple case.
    const memberIds = new Set(manifest.parts.filter((p) => p.visibleWhen?.option === option.id).map((p) => p.id));
    const visible = visibleParts(manifest, selections);
    return manifest.options.find((o): o is ColourOption =>
      isColour(o) && o.parts.length > 0
      && o.parts.every((p) => memberIds.has(p)) && o.parts.some((p) => visible.has(p)));
  };

  const before = memberColour();
  const carried = before ? resolveValue(manifest, selections, before.id) : '';
  selections[optionId] = value;
  const after = memberColour();
  if (!before || !after || before.id === after.id || !carried) return;

  if (isCustomColour(carried)) {
    if (after.custom?.allowed) selections[after.id] = carried;
    return;
  }
  const palette = manifest.palettes?.find((p) => p.id === after.palette);
  if (palette?.swatches.some((s) => s.id === carried && s.available !== false)) {
    selections[after.id] = carried;
  }
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
  const visible = visibleParts(manifest, selections);

  for (const o of manifest.options) {
    // An inert option (see isOptionActive) never charges: switching a
    // pick-one set away from a part must drop that part's colour surcharges.
    if (!isOptionActive(manifest, selections, o, visible)) continue;
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
      const text = (selections[o.id] ?? '').trim();
      if (!text) continue;
      const amount = (o.priceDelta ?? 0) + (o.pricePerChar ?? 0) * text.length;
      if (amount) deltas.push({ optionId: o.id, label: `${o.label}: “${text}”`, amount });
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
  const uploads: Record<string, { id: string; url: string }> = {};

  for (const o of manifest.options) {
    resolved[o.id] = resolveValue(manifest, selections, o.id);
    // Artwork that lives on the service is surfaced on its own, so a cart
    // integration never has to parse a selection value to find the picture.
    if (o.type === 'upload') {
      const state = parseUploadState(resolved[o.id]);
      if (state?.up) uploads[o.id] = { id: state.up, url: state.img };
    }
    if (isColour(o)) {
      const colour = resolveColour(manifest, selections, o);
      if (colour) colourNames[o.id] = colour.name;
    }
    // A customer-chosen text colour is part of the order, so it travels
    // with the typed string — named, so the workshop reads a colour not a hex.
    if (o.type === 'text' && o.customerColour) {
      const key = textColourKey(o.id);
      const hex = selections[key] ?? '';
      resolved[key] = hex;
      const swatch = (manifest.palettes ?? [])
        .flatMap((p) => p.swatches).find((s) => s.hex.toUpperCase() === hex.toUpperCase());
      if (swatch) colourNames[key] = swatch.name;
    }
  }

  return {
    type: 'configurator:change',
    productId: manifest.id,
    manifestVersion: manifest.version,
    ...(manifest.uploads?.publication ? { publicationId: manifest.uploads.publication } : {}),
    selections: resolved,
    colourNames,
    priceDeltas: deltas,
    deltaTotal: Math.round(deltas.reduce((s, d) => s + d.amount, 0) * 100) / 100,
    currency: manifest.pricing.currency,
    ...(Object.keys(uploads).length ? { uploads } : {}),
  };
}
