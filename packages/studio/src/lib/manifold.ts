// One Manifold instance for the whole Studio. Manifold is the
// fabrication-grade geometry kernel (the one OpenSCAD adopted): every
// operation — extrude a cross-section, boolean union, offset — returns a
// watertight, consistently-oriented mesh by construction, which is what
// the 3MF spec demands and what keeps a slicer's auto-repair from ever
// touching (and mangling) our output. Its CrossSection wraps Clipper2,
// so self-intersecting traced rings are cleaned for free.

import ManifoldModule from 'manifold-3d';

type Wasm = Awaited<ReturnType<typeof ManifoldModule>>;

let ready: Promise<Wasm> | undefined;

/** The initialised WASM module — first call loads it, later calls share. */
export const manifold = (): Promise<Wasm> => {
  ready ??= ManifoldModule().then((wasm) => {
    wasm.setup();
    return wasm;
  });
  return ready;
};
