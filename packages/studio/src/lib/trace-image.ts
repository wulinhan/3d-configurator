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
  /** The MOST colours to detect (1 forces line-art mode). */
  maxColours: number;
  /** Loose pieces of one colour become their own parts, so a stray speck
   * can be deleted afterwards. Dense patterns (a QR code) stay whole. */
  splitParts: boolean;
}

export const TEMPLATE_DEFAULTS: TemplateOpts = {
  widthMm: 100, withBase: true, baseMm: 3, baseGrowMm: 0, ridgeMm: 1.5, widenMm: 0,
  maxColours: 6, splitParts: true,
};

/** Above this many loose pieces a colour is a PATTERN, not stray solids —
 * splitting a QR code into hundreds of parts helps nobody. */
export const SPLIT_LIMIT = 24;

/** RGBA pixels — what ctx.getImageData returns, but structural so tests can
 * synthesise it without a DOM. */
export interface Raster { data: Uint8ClampedArray; width: number; height: number }

// ─────────────────────────────────────────────────── pixels → colour groups ──

/* sRGB → Lab in OpenCV's uint8 scaling (L·2.55, a+128, b+128) — the same
   scaling the marketing site's pipeline tuned its thresholds in, so those
   thresholds (background tolerance 24, merge distance 18) carry over. */
const rgb2lab = (r: number, g: number, b: number): [number, number, number] => {
  const f = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const R = f(r), G = f(g), B = f(b);
  let X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  let Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  let Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const t = (v: number) => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  X = t(X); Y = t(Y); Z = t(Z);
  return [(116 * Y - 16) * 2.55, 500 * (X - Y) + 128, 200 * (Y - Z) + 128];
};

const labDist = (a: [number, number, number], b: [number, number, number]): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Lab distance between two hex colours — the palette-mapping yardstick. */
export const hexDistance = (h1: string, h2: string): number => {
  const rgb = (h: string): [number, number, number] => {
    const v = parseInt(h.replace('#', ''), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  const [r1, g1, b1] = rgb(h1), [r2, g2, b2] = rgb(h2);
  return labDist(rgb2lab(r1, g1, b1), rgb2lab(r2, g2, b2));
};

/** The page background: the median border colour — unless the border is
 * mostly transparent, in which case alpha IS the background. */
const detectBackground = (d: Uint8ClampedArray, w: number, h: number): [number, number, number] | null => {
  const samp: Array<[number, number, number]> = [];
  let trans = 0, n = 0;
  const px = (x: number, y: number) => {
    const p = (y * w + x) * 4;
    samp.push([d[p], d[p + 1], d[p + 2]]);
    if (d[p + 3] < 128) trans++;
    n++;
  };
  for (let x = 0; x < w; x++) { px(x, 0); px(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { px(0, y); px(w - 1, y); }
  if (trans / n > 0.5) return null;
  const med = (i: 0 | 1 | 2) => samp.map((s) => s[i]).sort((a, b) => a - b)[samp.length >> 1];
  return [med(0), med(1), med(2)];
};

/* deterministic LCG so colour clustering is reproducible run to run */
const lcg = (seed: number) => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; };

const kmeans = (points: Array<[number, number, number]>, k: number, iters = 25): Array<[number, number, number]> => {
  const rand = lcg(42);
  const centres: Array<[number, number, number]> = [points[(rand() * points.length) | 0].slice() as [number, number, number]];
  while (centres.length < k) { // kmeans++ seeding
    const d2 = points.map((p) => Math.min(...centres.map((c) => labDist(p, c) ** 2)));
    const total = d2.reduce((a, b) => a + b, 0);
    if (!total) break;
    let r = rand() * total, idx = 0;
    while (r > d2[idx] && idx < d2.length - 1) r -= d2[idx++];
    centres.push(points[idx].slice() as [number, number, number]);
  }
  const assign = new Int32Array(points.length);
  for (let it = 0; it < iters; it++) {
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const dist = labDist(points[i], centres[c]);
        if (dist < bd) { bd = dist; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; changed = true; }
    }
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < points.length; i++) {
      const s = sums[assign[i]];
      const p = points[i];
      s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    }
    for (let c = 0; c < centres.length; c++) {
      if (sums[c][3]) centres[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
    }
    if (!changed) break;
  }
  return centres;
};

const toHex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0').toUpperCase()).join('');

/** A plain-words name for a colour, for part labels and swatch names. */
export const colourName = (hex: string): string => {
  const v = parseInt(hex.replace('#', ''), 16);
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx - mn < 24) return l < 50 ? 'black' : l < 130 ? 'grey' : l < 225 ? 'silver' : 'white';
  const d = mx - mn;
  let hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 15) return 'red';
  if (hue < 40) return l < 100 ? 'brown' : 'orange';
  if (hue < 70) return 'yellow';
  if (hue < 160) return 'green';
  if (hue < 200) return 'teal';
  if (hue < 250) return 'blue';
  if (hue < 290) return 'purple';
  if (hue < 335) return 'pink';
  return 'red';
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

/** Split a mask into its connected pieces (4-neighbour), largest first —
 * how one colour's stray solids become their own deletable parts. */
export const components = (mask: Uint8Array, w: number, h: number): Uint8Array[] => {
  const seen = new Uint8Array(w * h);
  const out: Array<{ mask: Uint8Array; area: number }> = [];
  const queue: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const piece = new Uint8Array(w * h);
    let area = 0;
    queue.length = 0;
    queue.push(start);
    seen[start] = 1;
    while (queue.length) {
      const i = queue.pop()!;
      piece[i] = 1;
      area++;
      const x = i % w, y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && mask[j] && !seen[j]) { seen[j] = 1; queue.push(j); }
      }
    }
    out.push({ mask: piece, area });
  }
  return out.sort((a, b) => b.area - a.area).map((p) => p.mask);
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

export interface TemplatePreview { width: number; height: number; silhouette: Uint8Array; groups: ColourGroup[] }

export interface MaskOpts {
  widthMm: number;
  widenMm: number;
  /** Grow the plate outward along its outline, in mm past the artwork. */
  baseGrowMm: number;
  /** The most colours to detect; 1 forces everything into line-art mode. */
  maxColours?: number;
}

/** One detected artwork colour and the pixels that wear it. */
export interface ColourGroup { hex: string; coverage: number; ink: Uint8Array }

/**
 * The masks — cheap enough to re-run on every dialog keystroke, and
 * exactly what the dialog previews: what is filled here is what prints.
 *
 * Colour detection is the marketing site's logo pipeline: find the page
 * background from the border, keep everything that isn't it, cluster the
 * rest in Lab (k-means, capped at six), merge centres closer than a
 * just-noticeable distance, drop dust, and assign every content pixel to
 * its nearest surviving colour — the groups PARTITION the artwork, so
 * parts never overlap. Plain black line art comes out as exactly one
 * group, which is the old behaviour.
 */
export function templateMasks(img: Raster, opts: MaskOpts): TemplatePreview {
  const { width: w, height: h } = img;
  const n = w * h;
  const d = img.data;
  const MERGE_DE = 18, MIN_FRAC = 0.005;
  const MAX_COLOURS = Math.max(1, Math.min(8, Math.round(opts.maxColours ?? 6)));

  // composite onto white (transparent art must read as white background),
  // Lab per pixel, and the content mask in one pass
  const bg = detectBackground(d, w, h);
  const bgLab = bg ? rgb2lab(bg[0], bg[1], bg[2]) : null;
  const rgb = new Uint8ClampedArray(n * 3);
  const labs = new Float32Array(n * 3);
  const content = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = d[p + 3] / 255;
    const r = d[p] * a + 255 * (1 - a), g = d[p + 1] * a + 255 * (1 - a), b = d[p + 2] * a + 255 * (1 - a);
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
    const lab = rgb2lab(r, g, b);
    labs[i * 3] = lab[0]; labs[i * 3 + 1] = lab[1]; labs[i * 3 + 2] = lab[2];
    content[i] = bgLab
      ? (labDist(lab, bgLab) > 24 ? 1 : 0)
      : (d[p + 3] >= 128 ? 1 : 0);
  }

  const contentIdx: number[] = [];
  for (let i = 0; i < n; i++) if (content[i]) contentIdx.push(i);

  let groups: ColourGroup[] = [];
  if (contentIdx.length) {
    // cluster a sample, then assign every pixel
    const step = Math.max(1, Math.floor(contentIdx.length / 20_000));
    const points: Array<[number, number, number]> = [];
    for (let s = 0; s < contentIdx.length; s += step) {
      const i = contentIdx[s];
      points.push([labs[i * 3], labs[i * 3 + 1], labs[i * 3 + 2]]);
    }
    let centres = kmeans(points, Math.min(MAX_COLOURS, points.length));
    // merge centres too close to tell apart on a print
    const merged: typeof centres = [];
    for (const c of centres) {
      if (!merged.some((m) => labDist(m, c) < MERGE_DE)) merged.push(c);
    }
    centres = merged;

    const assignAll = (cs: typeof centres) => {
      const masks = cs.map(() => new Uint8Array(n));
      const sums = cs.map(() => [0, 0, 0, 0]);
      for (const i of contentIdx) {
        const lab: [number, number, number] = [labs[i * 3], labs[i * 3 + 1], labs[i * 3 + 2]];
        let best = 0, bd = Infinity;
        for (let c = 0; c < cs.length; c++) {
          const dist = labDist(lab, cs[c]);
          if (dist < bd) { bd = dist; best = c; }
        }
        masks[best][i] = 1;
        const s = sums[best];
        s[0] += rgb[i * 3]; s[1] += rgb[i * 3 + 1]; s[2] += rgb[i * 3 + 2]; s[3]++;
      }
      return { masks, sums };
    };

    let { masks, sums } = assignAll(centres);
    // dust colours dissolve into their nearest survivor
    const keep = centres.filter((_, c) => sums[c][3] >= contentIdx.length * MIN_FRAC);
    if (keep.length && keep.length < centres.length) ({ masks, sums } = assignAll(centres = keep));

    const minArea = Math.max(4, Math.round(n / 50_000));
    groups = centres.map((_, c) => ({
      hex: toHex(sums[c][0] / (sums[c][3] || 1), sums[c][1] / (sums[c][3] || 1), sums[c][2] / (sums[c][3] || 1)),
      coverage: sums[c][3] / contentIdx.length,
      ink: despeckle(masks[c], w, h, minArea),
    }))
      .filter((g) => g.ink.some((v) => v))
      .sort((a, b) => b.coverage - a.coverage);
  }

  const mmPerPx = opts.widthMm / w;
  // thickening is a LINE-art affordance: with several colour groups the
  // regions tile the artwork edge to edge, and dilating them would overlap
  const widenPx = Math.round((opts.widenMm / 2) / mmPerPx);
  if (widenPx > 0 && groups.length === 1) {
    groups[0] = { ...groups[0], ink: dilate(groups[0].ink, w, h, widenPx) };
  }

  const union = new Uint8Array(n);
  for (const g of groups) for (let i = 0; i < n; i++) if (g.ink[i]) union[i] = 1;

  const growPx = Math.round(opts.baseGrowMm / mmPerPx);
  if (growPx <= 0) {
    return { width: w, height: h, groups, silhouette: fillEnclosed(union, w, h) };
  }
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
    groups: groups.map((g) => ({ ...g, ink: pad(g.ink) })),
    silhouette: dilate(pad(fillEnclosed(union, w, h)), pw, ph, growPx),
  };
}

export interface TemplateResult {
  parts: ImportedPart[];
  /** Aligned with `parts`: the artwork colour behind each one; null for
   * the base plate, which has no artwork colour of its own. */
  hexes: (string | null)[];
}

export async function templateFromRaster(img: Raster, opts: TemplateOpts): Promise<TemplateResult> {
  const { width: w } = img;
  if (opts.widthMm <= 0 || opts.ridgeMm <= 0 || (opts.withBase && opts.baseMm <= 0)) {
    throw new Error('width, base and line height must all be positive');
  }
  const masks = templateMasks(img, opts);
  const { groups, silhouette } = masks;
  if (!groups.length) throw new Error('no lines found — the image looks blank or too faint');

  // scale is anchored to the ARTWORK's width: growing the base makes the
  // plate larger than widthMm rather than shrinking the art inside it.
  const scale = opts.widthMm / w;
  const eps = Math.max(1, w / 800); // simplify harder as resolution grows
  const trace = (mask: Uint8Array) => traceLoops(mask, masks.width, masks.height).map((r) => simplifyRing(r, eps));

  // Without a base the lines ARE the part, sat straight on the ground.
  // One colour keeps the classic name; several get named for their colour.
  // With splitting on, a colour's loose pieces land as separate parts
  // (largest first) so a stray solid can simply be deleted — unless the
  // colour is a dense pattern, which stays whole.
  const lift = opts.withBase ? opts.baseMm : 0;
  const usedNames = new Set<string>();
  const parts: ImportedPart[] = [];
  const hexes: (string | null)[] = [];
  if (opts.withBase) {
    parts.push(await extrudeRings('base', trace(silhouette), scale, opts.baseMm, 0));
    hexes.push(null);
  }
  for (const group of groups) {
    const base = groups.length === 1 ? 'outlines' : colourName(group.hex);
    const pieces = opts.splitParts ? components(group.ink, masks.width, masks.height) : [group.ink];
    const masksToBuild = pieces.length > 1 && pieces.length <= SPLIT_LIMIT ? pieces : [group.ink];
    for (const mask of masksToBuild) {
      let name = base;
      for (let k = 2; usedNames.has(name); k++) name = `${base}-${k}`;
      usedNames.add(name);
      parts.push(await extrudeRings(name, trace(mask), scale, opts.ridgeMm, lift));
      hexes.push(group.hex);
    }
  }

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
  return { parts, hexes };
}
