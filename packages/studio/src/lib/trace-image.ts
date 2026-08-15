// Artwork in, colouring template out: the drawn lines become raised ridges
// and the artwork's own outer shape becomes the plate they stand on — the
// paint-by-numbers blank next to the finished piece.
//
// The raster pipeline (background detection, morphology, crack-following
// boundary tracer, Douglas-Peucker simplification) is ported from the
// image-to-3MF tool on the marketing site, where it has been squaring up
// QR codes and logos for a print farm's worth of uploads. SVG input goes
// through the same path: the caller rasterises it (crisply, at working
// resolution) and hands the pixels over, so vector and bitmap art cannot
// drift apart in behaviour.
//
// Both output parts are generated straight into canonical space (mm, Y-up,
// grounded, centred on X/Z) and merge through mergeModel like any import.
//
// Solids are built by Manifold, not by a rendering triangulator: traced
// rings become an even-odd CrossSection, get a 5-micron inset so regions
// that touch only at a corner (every other cell of a QR code) separate
// into their own solids instead of sharing a non-manifold edge, and
// extrude into meshes that are watertight by construction — nothing for a
// slicer's auto-repair to "fix".

import type { ImportedPart } from './types.ts';
import { manifold } from './manifold.ts';

export interface TemplateOpts {
  /** Overall plate width (the artwork's X span). */
  widthMm: number;
  /** Whether the lines get a plate under them at all — off leaves just the
   * connected line-art relief. */
  withBase: boolean;
  /** Base plate thickness. */
  baseMm: number;
  /** Expand the plate outward along its own outline, beyond the artwork —
   * a border for the template. */
  baseGrowMm: number;
  /** How far the ridges stand PROUD of the base. */
  ridgeMm: number;
  /** Extra thickness added to every line (0 = as drawn). */
  widenMm: number;
}

export const TEMPLATE_DEFAULTS: TemplateOpts = {
  widthMm: 100, withBase: true, baseMm: 3, baseGrowMm: 0, ridgeMm: 1.5, widenMm: 0,
};

/** RGBA pixels — what ctx.getImageData returns, but structural so tests can
 * synthesise it without a DOM. */
export interface Raster { data: Uint8ClampedArray; width: number; height: number }

// ────────────────────────────────────────────────── pixels → binary masks ──

const toGray = (d: Uint8ClampedArray, n: number): Float32Array => {
  const g = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    // composite onto white first — transparent line art must read as
    // "white background", not "black everywhere".
    const a = d[p + 3] / 255;
    g[i] = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) * a + 255 * (1 - a);
  }
  return g;
};

const otsu = (gray: Float32Array): number => {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[Math.max(0, Math.min(255, gray[i] | 0))]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thresh = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = gray.length - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thresh = t; }
  }
  return thresh;
};

/* summed-area table over a 0/1 mask, for O(1) box sums */
const sat = (ink: Uint8Array, w: number, h: number): Int32Array => {
  const W = w + 1, S = new Int32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += ink[y * w + x];
      S[(y + 1) * W + x + 1] = S[y * W + x + 1] + row;
    }
  }
  return S;
};
const boxSum = (S: Int32Array, w: number, x0: number, y0: number, x1: number, y1: number): number => {
  const W = w + 1;
  return S[y1 * W + x1] - S[y0 * W + x1] - S[y1 * W + x0] + S[y0 * W + x0];
};

/** dilation with a (2r+1) square — how lines are thickened */
export const dilate = (ink: Uint8Array, w: number, h: number, r: number): Uint8Array => {
  const S = sat(ink, w, h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y * w + x] = boxSum(S, w, x0, y0, x1, y1) > 0 ? 1 : 0;
    }
  }
  return out;
};

/** Drop connected ink components below `minArea` px. A majority filter
 * would also erase genuine hairline strokes — line art is full of them —
 * where an area test keeps any line long enough to matter and still kills
 * JPEG speckle. */
const despeckle = (ink: Uint8Array, w: number, h: number, minArea: number): Uint8Array => {
  const out = ink.slice();
  const seen = new Uint8Array(w * h);
  const queue: number[] = [];
  for (let start = 0; start < out.length; start++) {
    if (!out[start] || seen[start]) continue;
    queue.length = 0;
    queue.push(start);
    seen[start] = 1;
    const members: number[] = [];
    while (queue.length) {
      const i = queue.pop()!;
      members.push(i);
      const x = i % w, y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && out[j] && !seen[j]) { seen[j] = 1; queue.push(j); }
      }
    }
    if (members.length < minArea) for (const i of members) out[i] = 0;
  }
  return out;
};

/** Everything NOT reachable from the border without crossing ink: the ink
 * itself plus every region it encloses. This is what makes the butterfly's
 * body part of the plate rather than a hole through it. */
export const fillEnclosed = (ink: Uint8Array, w: number, h: number): Uint8Array => {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => { if (!outside[i] && !ink[i]) { outside[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  const sil = new Uint8Array(w * h);
  for (let i = 0; i < sil.length; i++) sil[i] = outside[i] ? 0 : 1;
  return sil;
};

// ───────────────────────────────────────────────── masks → boundary rings ──

export type Ring = Array<[number, number]>;

/* Trace every black/white boundary loop (crack following on the pixel
   lattice, ink kept on the left, left-turn preference so corner-touching
   regions stay separate loops). */
export const traceLoops = (ink: Uint8Array, w: number, h: number): Ring[] => {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : ink[y * w + x];
  const C = w + 1;
  const exists = (x: number, y: number, d: number): boolean => {
    switch (d) {
      case 0: return !!at(x, y - 1) && !at(x, y);
      case 1: return !!at(x, y) && !at(x - 1, y);
      case 2: return !!at(x - 1, y) && !at(x - 1, y - 1);
      default: return !!at(x - 1, y - 1) && !at(x, y - 1);
    }
  };
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const LEFT = (d: number) => (d + 3) & 3, RIGHT = (d: number) => (d + 1) & 3;
  const visited = [
    new Uint8Array(C * (h + 1)), new Uint8Array(C * (h + 1)),
    new Uint8Array(C * (h + 1)), new Uint8Array(C * (h + 1)),
  ];
  const rings: Ring[] = [];
  for (let sy = 0; sy <= h; sy++) {
    for (let sx = 0; sx <= w; sx++) {
      if (visited[0][sy * C + sx] || !exists(sx, sy, 0)) continue;
      const ring: Array<[number, number, number]> = [];
      let x = sx, y = sy, d = 0;
      do {
        visited[d][y * C + x] = 1;
        if (ring.length === 0 || ring[ring.length - 1][2] !== d) ring.push([x, y, d]);
        x += DX[d]; y += DY[d];
        const tryD = [LEFT(d), d, RIGHT(d)];
        d = -1;
        for (const nd of tryD) if (exists(x, y, nd)) { d = nd; break; }
        if (d < 0) break;
      } while (!(x === sx && y === sy && d === 0 && visited[0][y * C + x]));
      if (ring.length >= 4) rings.push(ring.map((p) => [p[0], p[1]]));
    }
  }
  return rings;
};

/* Douglas-Peucker simplification of a closed ring */
export const simplifyRing = (ring: Ring, eps: number): Ring => {
  if (eps <= 0 || ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  const half = ring.length >> 1;
  keep[0] = keep[half] = 1;
  const stack: Array<[number, number]> = [[0, half], [half, ring.length]];
  const pt = (i: number) => ring[i % ring.length];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pt(a), [bx, by] = pt(b);
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1, wd = eps;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pt(i);
      const dist = Math.abs(dx * (py - ay) - dy * (px - ax)) / len;
      if (dist > wd) { wd = dist; worst = i; }
    }
    if (worst >= 0) { keep[worst % ring.length] = 1; stack.push([a, worst], [worst, b]); }
  }
  const out: Ring = [];
  for (let i = 0; i < ring.length; i++) if (keep[i]) out.push(ring[i]);
  return out.length >= 3 ? out : ring;
};

// ─────────────────────────────────────────────────── rings → solid meshes ──

/**
 * Extrude rings (px, y-down) into a canonical-space part: lying flat,
 * grounded at `liftMm`, `scale` px→mm, centred later by the caller.
 *
 * Manifold does the geometric heavy lifting: the rings form an even-odd
 * CrossSection (Clipper2 underneath, so orientation and self-intersections
 * from simplification are resolved exactly), then a 5-micron inset pulls
 * corner-touching regions apart — without it, every other cell of a QR
 * code shares a single lattice corner with its neighbour and the extruded
 * pair shares an EDGE, which is the non-manifold contact a slicer's
 * auto-repair mangles. The extrusion is watertight by construction.
 */
const extrudeRings = async (name: string, rings: Ring[], scale: number, thickMm: number, liftMm: number): Promise<ImportedPart> => {
  const wasm = await manifold();
  const polys = rings.map((r) => r.map(([x, y]) => [x * scale, -y * scale] as [number, number]));
  const section = new wasm.CrossSection(polys, 'EvenOdd');
  const inset = section.offset(-5e-3, 'Miter');
  const solid = inset.extrude(thickMm);
  try {
    if (solid.isEmpty()) throw new Error('the traced shape vanished — the lines may be too thin to print');
    const mesh = solid.getMesh();
    // Manifold extrudes along +Z from the XY plane (image y already
    // flipped); canonical space lies flat with +Y up: (x, y, z) → (x, z, −y).
    const vp = mesh.vertProperties;
    const positions = new Float32Array(vp.length);
    for (let i = 0; i < vp.length; i += 3) {
      positions[i] = vp[i];
      positions[i + 1] = vp[i + 2] + liftMm;
      positions[i + 2] = -vp[i + 1];
    }
    return { name, positions, indices: Uint32Array.from(mesh.triVerts) };
  } finally {
    section.delete();
    inset.delete();
    solid.delete();
  }
};

// ───────────────────────────────────────────────────────────── the recipe ──

export interface TemplatePreview { width: number; height: number; silhouette: Uint8Array; ink: Uint8Array }

export interface MaskOpts {
  widthMm: number;
  widenMm: number;
  /** Grow the plate outward along its outline, in mm past the artwork. */
  baseGrowMm: number;
}

/** The masks alone — cheap enough to re-run on every dialog keystroke, and
 * exactly what the dialog previews: what is filled here is what prints. */
export function templateMasks(img: Raster, opts: MaskOpts): TemplatePreview {
  const { width: w, height: h } = img;
  const n = w * h;
  const gray = toGray(img.data, n);
  // Line art is dark strokes on a light ground; Otsu finds the split. The
  // cap at 200 stops a nearly-all-white image from calling faint grey
  // JPEG noise "line".
  // <= not <: on perfectly bimodal art (pure black on pure white) Otsu's
  // maximum sits at t=0, and a strict compare would call the whole image
  // blank.
  const thresh = Math.min(otsu(gray), 200);
  let ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) ink[i] = gray[i] <= thresh ? 1 : 0;
  ink = despeckle(ink, w, h, Math.max(4, Math.round(n / 50_000)));
  const mmPerPx = opts.widthMm / w;
  const widenPx = Math.round((opts.widenMm / 2) / mmPerPx);
  if (widenPx > 0) ink = dilate(ink, w, h, widenPx);
  const growPx = Math.round(opts.baseGrowMm / mmPerPx);
  if (growPx <= 0) return { width: w, height: h, ink, silhouette: fillEnclosed(ink, w, h) };
  // The border grows OUTWARD, so pad the canvas by the growth radius first —
  // otherwise artwork near the edge would have its border clipped flat.
  const pw = w + growPx * 2, ph = h + growPx * 2;
  const pad = (src: Uint8Array): Uint8Array => {
    const out = new Uint8Array(pw * ph);
    for (let y = 0; y < h; y++) out.set(src.subarray(y * w, y * w + w), (y + growPx) * pw + growPx);
    return out;
  };
  return {
    width: pw, height: ph,
    ink: pad(ink),
    silhouette: dilate(pad(fillEnclosed(ink, w, h)), pw, ph, growPx),
  };
}

export async function templateFromRaster(img: Raster, opts: TemplateOpts): Promise<ImportedPart[]> {
  const { width: w } = img;
  if (opts.widthMm <= 0 || opts.ridgeMm <= 0 || (opts.withBase && opts.baseMm <= 0)) {
    throw new Error('width, base and line height must all be positive');
  }
  const masks = templateMasks(img, opts);
  const { ink, silhouette } = masks;
  if (!ink.some((v) => v)) throw new Error('no lines found — the image looks blank or too faint');

  // scale is anchored to the ARTWORK's width: growing the base makes the
  // plate larger than widthMm rather than shrinking the art inside it.
  const scale = opts.widthMm / w;
  const eps = Math.max(1, w / 800); // simplify harder as resolution grows
  const trace = (mask: Uint8Array) => traceLoops(mask, masks.width, masks.height).map((r) => simplifyRing(r, eps));

  // Without a base the lines ARE the part, sat straight on the ground.
  const lift = opts.withBase ? opts.baseMm : 0;
  const ridges = await extrudeRings('outlines', trace(ink), scale, opts.ridgeMm, lift);
  const parts = opts.withBase
    ? [await extrudeRings('base', trace(silhouette), scale, opts.baseMm, 0), ridges]
    : [ridges];

  // one shared offset so ridges stay registered on their plate: centre on
  // X/Z from the LARGEST footprint (the base when there is one) — parts
  // are already grounded at y=0 by construction
  const anchor = parts[0];
  const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
  for (let i = 0; i < anchor.positions.length; i += 3) {
    for (const [k, axis] of [[0, 0], [1, 2]] as const) {
      const v = anchor.positions[i + axis];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const cx = (min[0] + max[0]) / 2, cz = (min[1] + max[1]) / 2;
  for (const part of parts) {
    for (let i = 0; i < part.positions.length; i += 3) {
      part.positions[i] -= cx;
      part.positions[i + 2] -= cz;
    }
  }
  return parts;
}
