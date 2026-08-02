// The product manifest — the single contract between the Studio (where a
// merchant sets a product up), the embed runtime (what their customer sees),
// and the host page (the cart that has to price the result).
//
// Design rules that shaped this:
//
//  1. Everything is millimetres, Y-up, origin at the model's ground-plane
//     centre. Whatever axis convention a merchant's CAD used is resolved once
//     at import and baked into the GLB, so nothing downstream carries a
//     per-product coordinate quirk. (Today's configurators each hardcode a
//     `THREE.x = 3MF.y - CX` remap; that is exactly the thing this removes.)
//
//  2. Placement is anchored, not absolute. "2 mm above the body's underside"
//     survives the merchant swapping in a taller body; "y = -27.5" does not.
//     This mirrors how the hand-written Tap-to-Connect overlay already places
//     itself against the bar's ground plane and front face.
//
//  3. The configurator never states a price. It reports deltas and lets the
//     host's cart own base price, currency, tax and discounts — a merchant's
//     store is the authority on money, and duplicating it here would go stale.
//
//  4. Unknown fields are preserved, not rejected. A manifest written by a
//     newer Studio must still render in an older embed.

export type Millimetres = number;
export type Hex = string; // "#RRGGBB"

/** Which end of a span an anchor refers to. */
export type AnchorEdge = 'min' | 'center' | 'max';

/**
 * One axis of a part's placement.
 *
 * `align` picks the edge of *this* part; `to` picks the reference. So
 * `{ align: 'min', to: 'body:min', offset: 2 }` reads as "put my underside
 * 2 mm above the body's underside".
 *
 * `to: 'origin'` keeps the coordinate the model shipped with, which is what
 * you want for parts that were modelled in place.
 */
export interface AxisPlacement {
  align?: AnchorEdge;                       // default 'center'
  to?: `${string}:${AnchorEdge}` | 'origin'; // default 'origin'
  offset?: Millimetres;                     // default 0
}

export interface Placement {
  x?: AxisPlacement;
  y?: AxisPlacement;
  z?: AxisPlacement;
  /** Degrees, applied about the part's own centre before anchoring. */
  rotation?: [number, number, number];
  /**
   * Multipliers, not millimetres. The Studio shows the merchant real mm
   * (bbox × scale) but stores the ratio, so re-uploading a revised model
   * keeps the intent instead of stretching the new geometry to old numbers.
   */
  scale?: [number, number, number];
  /** Studio hint: the merchant locked uniform scaling. Round-trips only. */
  lockAspect?: boolean;
}

export interface ModelSource {
  id: string;
  /** Relative to the manifest, or absolute. GLB, meshopt-compressed. */
  url: string;
  /** Per-source override; the pipeline normalises to mm so this is rarely set. */
  scaleToMm?: number;
}

export interface PartMaterial {
  roughness?: number;  // default 0.9
  metalness?: number;  // default 0
  /** Configurator meshes are low-poly and read better faceted. Default true. */
  flatShading?: boolean;
  /** Non-colourable parts (chrome, glass) pin a colour and drop out of options. */
  fixedColour?: Hex;
}

/**
 * Scene-wide rendering knobs, tuned in the Studio's Finish tab and honoured
 * by every viewer of the manifest — the storefront lights the product the
 * way the merchant staged it.
 */
export interface SceneSettings {
  /** Tone-mapping exposure, 0.25–3. Default 1.25. */
  exposure?: number;
  /** Studio-environment (image-based light) intensity, 0–2. Default 0.5. */
  environmentIntensity?: number;
  /** Contact-shadow opacity under the model, 0–1. Default 0.2. */
  shadowOpacity?: number;
}

export interface Part {
  id: string;
  label: string;
  /** `"<modelSourceId>#<meshName>"`. */
  mesh: string;
  placement?: Placement;
  material?: PartMaterial;
  /**
   * Only rendered when this option's current value is in the list — the
   * mechanism behind swappable model variants and optional add-ons.
   */
  visibleWhen?: { option: string; equals: string[] };
}

export interface Swatch {
  id: string;
  name: string;
  hex: Hex;
  /** Surcharge when chosen. Rarely used — most palettes are same-price. */
  priceDelta?: number;
  /** Out of stock: shown struck through rather than silently disappearing. */
  available?: boolean;
}

export interface Palette {
  id: string;
  label: string;
  swatches: Swatch[];
}

export interface CustomColourRule {
  allowed: boolean;
  /** Charged once per distinct custom colour across the whole product. */
  priceDelta?: number;
  priceLabel?: string;
  /** Restrict to colours the merchant can actually source. */
  requireHex?: boolean;
}

/** A colourable surface the customer picks a finish for. */
export interface ColourOption {
  id: string;
  type: 'colour';
  label: string;
  /** Every part painted together by this one control. */
  parts: string[];
  palette?: string;
  /**
   * `'used'` replaces the palette with the colours already chosen elsewhere
   * on this product — how the "Tap to Connect" text is restricted to matching
   * an existing finish rather than inventing a sixth colour.
   */
  source?: 'palette' | 'used';
  /** Swatch id, or `"@<optionId>"` to start matched to another option. */
  default: string;
  /** Keeps following `@<optionId>` until the customer picks explicitly. */
  linkedTo?: string;
  custom?: CustomColourRule;
}

/** A discrete choice between variants — sizes, add-ons, swapped geometry. */
export interface ChoiceOption {
  id: string;
  type: 'choice';
  label: string;
  /**
   * What the Studio built this choice as: an optional add-on part, or a set
   * of mutually exclusive variant parts. Purely structural metadata — the
   * runtime treats every choice the same.
   */
  role?: 'addon' | 'variant';
  choices: Array<{
    id: string;
    label: string;
    priceDelta?: number;
    /** Shown in the picker; generated by the Studio from a turntable render. */
    thumbnail?: string;
    available?: boolean;
  }>;
  default: string;
}

/** Customer-supplied artwork applied to a part. */
export interface UploadOption {
  id: string;
  type: 'upload';
  label: string;
  /** Part whose surface receives the artwork. */
  part: string;
  accept?: string[];        // default ['image/png', 'image/jpeg', 'image/svg+xml']
  maxBytes?: number;
  priceDelta?: number;
  /** Print-ready template the merchant offers as a download. */
  templateUrl?: string;
}

/** Typefaces bundled with the runtime (see src/fonts/README.md). */
export const TEXT_FONTS = ['sans', 'sans-bold', 'droid-sans-bold', 'serif', 'serif-bold'] as const;
export type TextFont = typeof TEXT_FONTS[number];

/**
 * Customer-typed text extruded onto a flat surface of a part.
 *
 * The merchant picks the surface in the Studio; `origin`/`normal` record the
 * sketch plane in the part's local mesh space, so the text rides along with
 * every later move, rotation or anchor of the part. `sinkMm` lowers the
 * sketch plane into the part (a Fusion-style construction plane): the
 * visible relief is `depthMm − sinkMm`, so the same slot does proud
 * embossing, flush inlay, or engraved-looking text without any CSG.
 */
export interface TextOption {
  id: string;
  type: 'text';
  label: string;
  /** Part whose surface carries the text. */
  part: string;
  /** Sketch-plane origin on the surface, part-local mm. */
  origin: [number, number, number];
  /** Face normal in the same space — the extrusion direction. */
  normal: [number, number, number];
  /** Extra rotation about the normal, degrees. Default 0. */
  rotationDeg?: number;
  /** One of TEXT_FONTS. Default 'sans-bold' — bold survives extrusion best. */
  font?: TextFont;
  /** Glyph height, mm. */
  sizeMm: number;
  /** Extrusion depth from the sketch plane, mm. */
  depthMm: number;
  /** How far the sketch plane sinks into the part (emboss only). Default 0. */
  sinkMm?: number;
  /**
   * 'emboss' (default): the text extrudes proud of the surface.
   * 'deboss': a real boolean DIFFERENCE — the glyph volume is subtracted
   * from the part to `depthMm`, cutting an engraved pocket with visible
   * walls. Computed at runtime (lazily loaded CSG), so it follows the
   * customer's text live.
   */
  style?: 'emboss' | 'deboss';
  /** Default 20. */
  maxLength?: number;
  /** Ghost text in the input; also what the Studio previews on the model. */
  placeholder?: string;
  /**
   * The text's own colour. Unset, the text shares the carrier part's
   * material and colours with it; set, it renders in this fixed finish.
   */
  colourHex?: Hex;
  /**
   * One piece per letter: the carrier part — or, if it belongs to an
   * assembly, the WHOLE assembly — becomes a TEMPLATE, and every character
   * of the customer's text spawns its own copy of it, copy k carrying
   * character k on its face. `mode: 'line'` (default) marches copies along
   * `axis` (canonical 0=x 1=y 2=z, default x) at the template's size plus
   * `gapMm` (default 5); `mode: 'circle'` turns each copy `stepDeg`°
   * (default 30) further round the vertical axis through the world origin,
   * the original taken as facing the tangent. A space spawns a blank
   * piece. Combined with `pricePerChar`, this is a complete "type your
   * name, get one keychain tile per letter" product.
   */
  perChar?: { mode?: 'line' | 'circle'; axis?: 0 | 1 | 2; gapMm?: number; stepDeg?: number };
  /** Flat surcharge when any text is entered. */
  priceDelta?: number;
  /** Additional surcharge per character. */
  pricePerChar?: number;
}

export type Option = ColourOption | ChoiceOption | UploadOption | TextOption;

export interface CameraSetup {
  fov?: number;                                   // default 38
  /** Millimetres, in the same space as the model. */
  position?: [number, number, number];
  target?: [number, number, number];
  minDistance?: Millimetres;
  maxDistance?: Millimetres;
  /** Stops the customer orbiting under the floor. Degrees, default 162. */
  maxPolarAngle?: number;
  autoRotate?: boolean;
  background?: Hex;
  /**
   * Set when the merchant explicitly saved this view in the Studio. Publish
   * then keeps it verbatim instead of auto-framing from the model bounds.
   */
  userSet?: boolean;
}

export interface Branding {
  accent?: Hex;
  surface?: Hex;
  ink?: Hex;
  radius?: number;
  fontFamily?: string;
  logoUrl?: string;
}

export interface Pricing {
  /**
   * Reported for display only. The host cart converts, taxes and discounts —
   * the configurator is not the source of truth for money.
   */
  currency: string;
  /** Optional, purely so the embed can show "from $X" before any choice. */
  basePrice?: number;
}

/** Parts authored and presented as one thing — a Studio structuring aid. */
export interface PartGroup {
  id: string;
  label: string;
  parts: string[];
}

export interface Manifest {
  /** Bumped only on a breaking change; the runtime refuses what it can't read. */
  schema: 1;
  id: string;
  name: string;
  /** Merchant's own revision, surfaced in the cart payload for support. */
  version?: string;
  units: 'mm';
  brand?: Branding;
  scene?: SceneSettings;
  models: ModelSource[];
  parts: Part[];
  groups?: PartGroup[];
  palettes?: Palette[];
  options: Option[];
  camera?: CameraSetup;
  pricing: Pricing;
}

/** What the embed posts to the host page on every change. */
export interface SelectionPayload {
  type: 'configurator:change';
  productId: string;
  manifestVersion?: string;
  /** optionId → chosen value (swatch id, choice id, hex, or free text). */
  selections: Record<string, string>;
  /** Human-readable colour per option, for order notes and pick lists. */
  colourNames: Record<string, string>;
  /** Every surcharge the customer accrued, itemised for the cart to show. */
  priceDeltas: Array<{ optionId: string; label: string; amount: number }>;
  /** Sum of `priceDeltas` — a convenience, not a price. */
  deltaTotal: number;
  currency: string;
}
