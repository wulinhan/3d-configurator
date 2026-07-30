// Normalise imported geometry into the one space everything downstream assumes:
// millimetres, Y-up, X/Z centred on the model, Y = 0 at the ground plane.
//
// Every CAD package disagrees about which axis is up, and today each
// configurator carries its own hand-written remap (`THREE.x = 3MF.y - CX`,
// with per-product CX/CY/CZ constants). Resolving it once at import means a
// manifest can say "2 mm above the ground" and have that mean the same thing
// for every product a merchant uploads.

/**
 * Parse an axis map like `"y,z,x"` — read as "output X comes from input Y,
 * output Y from input Z, output Z from input X". A leading `-` flips an axis.
 * The default `"x,y,z"` is a no-op.
 */
export function parseAxisMap(spec = 'x,y,z') {
  const parts = String(spec).split(',').map((s) => s.trim().toLowerCase());
  if (parts.length !== 3) throw new Error(`axis map needs 3 components, got "${spec}"`);
  const map = parts.map((p) => {
    const sign = p.startsWith('-') ? -1 : 1;
    const axis = 'xyz'.indexOf(p.replace(/^[-+]/, ''));
    if (axis === -1) throw new Error(`axis map component "${p}" is not x, y or z`);
    return { axis, sign };
  });
  if (new Set(map.map((m) => m.axis)).size !== 3) throw new Error(`axis map "${spec}" repeats an axis`);
  return map;
}

/** Combined bounding box across every part, in whatever space they're in. */
export function boundsOf(parts) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const p = part.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (p[i + a] < min[a]) min[a] = p[i + a];
        if (p[i + a] > max[a]) max[a] = p[i + a];
      }
    }
  }
  return { min, max };
}

/**
 * Remap axes, then translate so the model is centred on X/Z and rests on
 * Y = 0. Returns new parts plus the bounds it settled on, which the manifest
 * author needs for the camera.
 *
 * @param {Array<{name: string, positions: Float32Array, indices: Uint32Array}>} parts
 * @param {object} [opts]
 * @param {string} [opts.axes] axis map, see parseAxisMap
 * @param {number} [opts.scaleToMm] multiply positions (e.g. 1000 for metres)
 * @param {boolean} [opts.ground] put Y=0 at the lowest point (default true)
 * @param {boolean} [opts.center] centre X/Z on the bbox (default true)
 */
export function orientParts(parts, opts = {}) {
  const { axes = 'x,y,z', scaleToMm = 1, ground = true, center = true } = opts;
  const map = parseAxisMap(axes);

  const remapped = parts.map((part) => {
    const src = part.positions;
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const { axis, sign } = map[a];
        out[i + a] = src[i + axis] * sign * scaleToMm;
      }
    }
    return { ...part, positions: out };
  });

  // A flipped axis reverses triangle winding, which would leave the model
  // inside-out under back-face culling. Undo it by swapping two corners.
  const flips = map.filter((m) => m.sign < 0).length;
  if (flips % 2 === 1) {
    for (const part of remapped) {
      const idx = part.indices;
      for (let t = 0; t < idx.length; t += 3) {
        const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp;
      }
    }
  }

  const b = boundsOf(remapped);
  const shift = [
    center ? -(b.min[0] + b.max[0]) / 2 : 0,
    ground ? -b.min[1] : 0,
    center ? -(b.min[2] + b.max[2]) / 2 : 0,
  ];
  if (shift.some((v) => v !== 0)) {
    for (const part of remapped) {
      const p = part.positions;
      for (let i = 0; i < p.length; i += 3) {
        for (let a = 0; a < 3; a++) p[i + a] += shift[a];
      }
    }
  }

  return { parts: remapped, bounds: boundsOf(remapped), shift, axes };
}
