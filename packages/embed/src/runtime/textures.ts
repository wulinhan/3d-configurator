// Procedural surface textures — a small library of product finishes
// (leathers, weaves, wood grain, print layers) generated as tileable normal
// maps on a canvas at runtime. No image assets, no network: every pattern is
// a seeded height field turned into a normal map once per page and cached.
//
// Geometry ships without UVs, so parts get box-projected UVs at load
// (applyBoxUvs) authored at BASE_TILE_MM per tile; a merchant's scale
// slider adjusts texture.repeat instead of regenerating anything.

import * as THREE from 'three';
import type { TextureType } from '../manifest/types.ts';

export const TEXTURE_CHOICES: Array<{ id: TextureType; label: string }> = [
  { id: 'leather', label: 'Fine leather' },
  { id: 'leather-coarse', label: 'Coarse leather' },
  { id: 'fabric', label: 'Woven fabric' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'wood', label: 'Wood grain' },
  { id: 'layers', label: 'Print layers' },
];

/** UVs are authored at this many millimetres per tile; the scale slider
 * rescales via texture.repeat. */
export const BASE_TILE_MM = 10;

const SIZE = 256;

// Deterministic PRNG so every page renders identical grain.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise: bilinear over a seeded, wrapped lattice. */
function makeNoise(seed: number, cells: number) {
  const rand = mulberry32(seed);
  const lattice = Float32Array.from({ length: cells * cells }, () => rand());
  const at = (ix: number, iy: number) =>
    lattice[((iy % cells + cells) % cells) * cells + ((ix % cells + cells) % cells)];
  return (x: number, y: number) => {
    const gx = x * cells, gy = y * cells;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    const fx = gx - ix, fy = gy - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

/** Tileable Worley (cellular) distances — F1 and F2, for leather cells. */
function makeWorley(seed: number, points: number) {
  const rand = mulberry32(seed);
  const px = Float32Array.from({ length: points }, () => rand());
  const py = Float32Array.from({ length: points }, () => rand());
  return (x: number, y: number) => {
    let f1 = Infinity, f2 = Infinity;
    for (let i = 0; i < points; i++) {
      // wrapped distance on the unit torus keeps the tile seamless
      let dx = Math.abs(x - px[i]); if (dx > 0.5) dx = 1 - dx;
      let dy = Math.abs(y - py[i]); if (dy > 0.5) dy = 1 - dy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return { f1, f2 };
  };
}

const tri = (t: number) => Math.abs(((t % 1) + 1) % 1 - 0.5) * 2; // 0..1 triangle wave

/** Height field per pattern, x/y in [0,1), output roughly 0..1, tileable. */
function heightField(type: TextureType): (x: number, y: number) => number {
  switch (type) {
    case 'leather': {
      const worley = makeWorley(7, 48);
      const noise = makeNoise(11, 16);
      return (x, y) => {
        const { f1, f2 } = worley(x, y);
        // plateau cells with grooves at the borders, plus a soft pebble dome
        return Math.min(1, (f2 - f1) * 9) * 0.8 + noise(x, y) * 0.2;
      };
    }
    case 'leather-coarse': {
      const worley = makeWorley(19, 14);
      const noise = makeNoise(23, 8);
      return (x, y) => Math.min(1, (worley(x, y).f2 - worley(x, y).f1) * 5) * 0.75 + noise(x, y) * 0.25;
    }
    case 'fabric': {
      const n = 6; // threads per tile
      return (x, y) => {
        const over = (Math.floor(x * n) + Math.floor(y * n)) % 2 === 0;
        const wx = Math.abs(Math.sin(Math.PI * x * n));
        const wy = Math.abs(Math.sin(Math.PI * y * n));
        return over ? wx * 0.7 + wy * 0.3 : wy * 0.7 + wx * 0.3;
      };
    }
    case 'canvas': {
      const n = 14;
      const noise = makeNoise(31, 32);
      return (x, y) => {
        const over = (Math.floor(x * n) + Math.floor(y * n)) % 2 === 0;
        const wx = Math.abs(Math.sin(Math.PI * x * n));
        const wy = Math.abs(Math.sin(Math.PI * y * n));
        return (over ? wx : wy) * 0.6 + noise(x, y) * 0.4;
      };
    }
    case 'wood': {
      const noise = makeNoise(43, 8);
      const streak = makeNoise(47, 64);
      return (x, y) =>
        // grain lines flowing along x, wobbled by low-frequency noise,
        // with fine streaks riding on top
        tri(y * 5 + noise(x, y) * 1.6) * 0.7 + streak(x * 4, y) * 0.3;
    }
    case 'layers':
      // fused-filament layer lines: straight sharp ridges
      return (_x, y) => tri(y * 24);
  }
}

const cache = new Map<TextureType, THREE.CanvasTexture>();

/** The pattern's tileable normal map — one canvas per type, ever. */
export function proceduralNormalMap(type: TextureType): THREE.CanvasTexture {
  let texture = cache.get(type);
  if (texture) return texture;

  const h = heightField(type);
  const field = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) field[y * SIZE + x] = h(x / SIZE, y / SIZE);
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(SIZE, SIZE);
  const wrap = (v: number) => (v + SIZE) % SIZE;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Sobel-ish central differences, wrapped so the tile stays seamless.
      const dx = field[y * SIZE + wrap(x + 1)] - field[y * SIZE + wrap(x - 1)];
      const dy = field[wrap(y + 1) * SIZE + x] - field[wrap(y - 1) * SIZE + x];
      const n = new THREE.Vector3(-dx * 6, -dy * 6, 1).normalize();
      const at = (y * SIZE + x) * 4;
      image.data[at] = (n.x * 0.5 + 0.5) * 255;
      image.data[at + 1] = (n.y * 0.5 + 0.5) * 255;
      image.data[at + 2] = (n.z * 0.5 + 0.5) * 255;
      image.data[at + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  cache.set(type, texture);
  return texture;
}

let frameTexture: THREE.CanvasTexture | undefined;

/**
 * The dashed rectangular border shown over an image zone while nothing is
 * uploaded — a transparent canvas with a dashed outline, projected as a
 * decal the exact size of the zone. Cached: one canvas per page, ever.
 */
export function zoneFrameTexture(): THREE.CanvasTexture {
  if (frameTexture) return frameTexture;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.strokeStyle = 'rgba(30, 41, 59, 0.9)';
  ctx.lineWidth = 4;
  ctx.setLineDash([12, 8]);
  ctx.strokeRect(4, 4, SIZE - 8, SIZE - 8);
  frameTexture = new THREE.CanvasTexture(canvas);
  return frameTexture;
}

/**
 * Box-projected UVs for geometry that shipped without any: each vertex is
 * projected along the dominant axis of its normal, at BASE_TILE_MM per tile.
 * Crude next to a real unwrap, but bump-scale patterns hide the seams at the
 * hard edges where the projection axis flips.
 */
export function applyBoxUvs(geometry: THREE.BufferGeometry): void {
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const pos = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(normal.getX(i)), ny = Math.abs(normal.getY(i)), nz = Math.abs(normal.getZ(i));
    let a: number, b: number;
    if (nx >= ny && nx >= nz) { a = pos.getZ(i); b = pos.getY(i); }
    else if (ny >= nz) { a = pos.getX(i); b = pos.getZ(i); }
    else { a = pos.getX(i); b = pos.getY(i); }
    uv[i * 2] = a / BASE_TILE_MM;
    uv[i * 2 + 1] = b / BASE_TILE_MM;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
