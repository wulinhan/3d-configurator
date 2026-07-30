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

export interface TextOption {
  id: string;
  type: 'text';
  label: string;
  part: string;
  maxLength?: number;
  priceDelta?: number;
  placeholder?: string;
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

export interface Manifest {
  /** Bumped only on a breaking change; the runtime refuses what it can't read. */
  schema: 1;
  id: string;
  name: string;
  /** Merchant's own revision, surfaced in the cart payload for support. */
  version?: string;
  units: 'mm';
  brand?: Branding;
  models: ModelSource[];
  parts: Part[];
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
