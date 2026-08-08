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

/** The bundled procedural finishes (see runtime/textures.ts). */
export const TEXTURE_TYPES = ['leather', 'leather-coarse', 'fabric', 'canvas', 'wood', 'layers'] as const;
export type TextureType = typeof TEXTURE_TYPES[number];

export interface PartMaterial {
  roughness?: number;  // default 0.9
  metalness?: number;  // default 0
  /** Configurator meshes are low-poly and read better faceted. Default true. */
  flatShading?: boolean;
  /** Non-colourable parts (chrome, glass) pin a colour and drop out of options. */
  fixedColour?: Hex;
  /**
   * A procedural surface finish, generated at runtime as a tileable normal
   * map — leathers, weaves, wood grain, 3D-print layer lines. `scaleMm` is
   * the feature size (default 8), `strength` the bump intensity (0–3,
   * default 1).
   */
  texture?: { type: TextureType; scaleMm?: number; strength?: number };
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

/**
 * A live pattern on a part: the renderer spawns `count - 1` extra copies
 * of it, so the pattern stays a PARAMETER of the part rather than a pile
 * of stamped duplicates. Copies share the original's geometry, material
 * and colour option — recolouring or hiding the part carries all of them.
 *
 * `line` marches copies along a canonical axis at the part's laid-out
 * size plus `gapMm` (negative overlaps on purpose). `circle` turns each
 * copy `stepDeg`° further around the vertical axis through the world
 * origin, the original taken as facing the tangent — the same rigid turn
 * the stamping tool uses, so a part off-centre rings around the middle.
 *
 * Several repeats STACK: each one repeats everything the ones before it
 * produced, so ×3 along X then ×2 along Y is a 3×2 grid of six.
 */
export interface RepeatSpec {
  id: string;
  mode: 'line' | 'circle';
  /** Total instances including the original. 2–64. */
  count: number;
  /** line: which canonical axis the row marches along. Default 0 (x). */
  axis?: 0 | 1 | 2;
  /** line: edge-to-edge spacing. Default 5. */
  gapMm?: Millimetres;
  /** circle: degrees between copies. Default 360 / count. */
  stepDeg?: number;
}

export interface Part {
  id: string;
  label: string;
  /** `"<modelSourceId>#<meshName>"`. */
  mesh: string;
  placement?: Placement;
  material?: PartMaterial;
  /** Live patterns applied to this part, in order — see RepeatSpec. */
  repeats?: RepeatSpec[];
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

/**
 * Customer-supplied artwork laid onto a part's surface.
 *
 * The merchant picks the surface in the Studio; `origin`/`normal` record the
 * zone plane in the part's local mesh space (exactly like a text slot), and
 * `widthMm`/`heightMm` bound the ZONE the image must stay within. Rendering
 * is a zone-sized overlay plane hovering fractionally off the surface,
 * carrying a canvas the image is drawn into — the storefront configurators'
 * proven logo approach: repositioning repaints a canvas, no geometry churn.
 *
 * The customer's value in `selections` is a JSON string:
 * `{ "img": <data URL>, "u": mm, "v": mm, "s": percent }` — offset within
 * the zone and uniform size (10–500, where 100 = largest fit inside the
 * zone and more crop-zooms within it). Empty string = no image.
 */
export interface UploadOption {
  id: string;
  type: 'upload';
  label: string;
  /** Part whose surface receives the artwork. */
  part: string;
  /** Projection-plane origin on the surface, part-local mm. */
  origin: [number, number, number];
  /** Outward surface normal in the same space — the projection direction. */
  normal: [number, number, number];
  /** Extra rotation about the normal, degrees. Default 0. */
  rotationDeg?: number;
  /** Zone bounds on the surface, mm — the image's framing rectangle. The
   * VISIBLE shape is the picked face itself: the renderer re-welds the
   * surface at `origin`/`normal` and builds the overlay from its exact
   * triangles, so the face's own rim does the masking. */
  widthMm: number;
  heightMm: number;
  /**
   * What the empty zone says before the customer uploads anything: the
   * label on the translucent veil, and the hint under the panel's upload
   * button. Absent falls back to "Image here"; an EMPTY string is a
   * deliberate silence, for merchants who want the bare shape.
   */
  placeholder?: string;
  accept?: string[];        // default ['image/png', 'image/jpeg']
  /** Cap on the stored image, after client-side downscaling. Default ~1.5MB. */
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
  /**
   * Curve the run: the angle (degrees) the whole text subtends along a
   * circular arc in the sketch plane. Positive arches up (the ends drop
   * away — badge-top text), negative arches down (a smile); ±360 closes a
   * full circle. Each glyph sits rigidly at its station on the arc, turned
   * to the local tangent, so spacing is preserved along the curve and the
   * engrave cut follows it exactly. 0/absent = straight. Ignored by
   * one-piece-per-letter spawning (pieces have their own line/circle
   * patterns).
   */
  bendDeg?: number;
  /**
   * Freeform baseline: 2–64 anchor points in the sketch plane (mm,
   * relative to origin; +u runs with the text, +v is the glyph up). The
   * baseline is the open Catmull-Rom curve through them — the letters walk
   * it at their real advances, centred on its arc-length middle, and a run
   * longer than the curve overruns STRAIGHT past the ends. The glyphs sit
   * exactly ON the drawn curve (no recentring), so what the merchant drags
   * is what renders. Takes precedence over bendDeg. Ignored by
   * one-piece-per-letter spawning.
   */
  path?: Array<[number, number]>;
  /**
   * Follow the part's SURFACE instead of the flat sketch plane: each glyph
   * is dropped onto the geometry under it and turned to the surface's own
   * normal, with spacing measured along the surface rather than across its
   * flat shadow. This is what puts a name around a cylinder or over a dome
   * — a curve in the sketch plane (`bendDeg`, `path`) still shapes the
   * baseline, and the wrap lays that baseline onto the geometry. Letters
   * that run off the end of the surface fall back to flat placement.
   * Engraved slots wrap too: the boolean cutter follows the surface, so
   * the pocket, its walls and its coloured floor curve with the letters.
   */
  wrapSurface?: boolean;
  /** With `wrapSurface`, how far the run floats off the surface before it
   * extrudes, mm. Default 0. */
  liftMm?: Millimetres;
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
   * The text's own colour. Unset — the default — the text shares the
   * carrier part's material and colours with it. Set, it renders in this
   * fixed finish (and, with `customerColour`, that is the colour the
   * panel opens on).
   */
  colourHex?: Hex;
  /**
   * Let CUSTOMERS pick the text's colour too. The panel shows the swatches
   * `colourChoices` allows (the whole palette when unset) under the text
   * box, and their pick is stored alongside the typed string (selection
   * key `<id>:colour`; empty = the merchant's own colour above). Unset,
   * `colourHex` is simply what the text renders in — the merchant's choice
   * stands on its own and does not depend on this flag.
   */
  customerColour?: boolean;
  /**
   * With `customerColour`, the subset of palette swatches customers may
   * pick from — hexes, matched against the product's palettes. Unset means
   * the whole palette. A pick outside the list is refused, so a tampered
   * payload cannot order a finish the merchant never offered.
   */
  colourChoices?: Hex[];
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
  /**
   * Where customer artwork goes, INJECTED by the hosting service as it
   * serves a published manifest — never authored in the Studio, which is
   * why it is not part of what a merchant edits.
   *
   * Present: the embed posts each uploaded image to `url` and the selection
   * carries the returned id, so a cart line item is a pointer rather than a
   * megabyte of base64. Absent (a self-hosted manifest.json): the image
   * stays a data: URL, exactly as before, and everything still works with
   * no server at all.
   */
  uploads?: { url: string; publication: string };
}

/** What the embed posts to the host page on every change. */
export interface SelectionPayload {
  type: 'configurator:change';
  productId: string;
  manifestVersion?: string;
  /**
   * Which FROZEN version the customer is looking at — present whenever the
   * manifest came from the service.
   *
   * An order must pin this rather than the project: the storefront fetches
   * the live URL, so a republish five minutes later would otherwise re-price
   * and re-render an order that was placed against the old product. It is
   * also what a merchant's backend posts to `/p/<id>/price` to have the
   * total checked by the same code that computed it.
   */
  publicationId?: string;
  /** optionId → chosen value (swatch id, choice id, hex, or free text). */
  selections: Record<string, string>;
  /** Human-readable colour per option, for order notes and pick lists. */
  colourNames: Record<string, string>;
  /** Every surcharge the customer accrued, itemised for the cart to show. */
  priceDeltas: Array<{ optionId: string; label: string; amount: number }>;
  /** Sum of `priceDeltas` — a convenience, not a price. */
  deltaTotal: number;
  currency: string;
  /**
   * Artwork the customer uploaded, surfaced separately so a cart
   * integration never has to parse a selection value to find the picture.
   * Only present for zones whose image went to an upload service.
   */
  uploads?: Record<string, { id: string; url: string }>;
}
