# @allin/studio

The merchant-facing authoring app. A merchant drops in a model, positions and
sizes its parts in real millimetres, decides which surfaces take which
colours and what costs extra, and publishes the two files their product page
needs: `manifest.json` and `model.glb`. No code on their side.

```
npm run dev       # Vite dev server
npm run build     # production build into dist/
npm test          # unit tests, then the browser test against dist/
```

## Shape

All product logic lives in `src/lib` as pure functions and is unit-tested;
the React layer (`src/ui`) renders state and routes events. The split is
deliberate: the UI is the least testable layer, so it is kept too thin to
hide bugs in.

```
src/lib/import-stl.ts     binary + ASCII STL, welds the triangle soup
src/lib/import-3mf.ts     zip + model XML: objects, components, build items,
                          composed 3×4 transforms, unit conversion
src/lib/import-glb.ts     standard GLBs: node TRS/matrix hierarchies baked in,
                          compressed/quantised inputs refused with advice
src/lib/import-model.ts   content sniffing, name normalisation, orientation
                          into canonical space (mm, Y-up, ground-centred)
src/lib/write-glb.ts      browser-portable GLB writer — publish output and
                          preview input are the same bytes
src/lib/manifest-init.ts  first manifest from an imported model
src/lib/manifest-edit.ts  every edit the UI can make. Each op either returns
                          a manifest that passes validateManifest, or throws.
src/lib/compress-glb.ts   meshopt compression for publish — the pipeline's
                          verified recipe (weld → quantise-14 → meshopt),
                          run in the browser via WebIO
src/ui/gizmo.ts           TransformControls wrapper; interpretation happens
                          in applyGizmoPose, which is tested
```

That last invariant is the point of the file: the Studio structurally cannot
hand a merchant a broken manifest, because nothing invalid ever leaves the
edit layer. `test/edit.test.ts` re-validates the result of every operation.

## The preview is the embed

`src/ui/ViewerPane.tsx` renders with the embed's own `Viewer` class, fed by a
blob URL of the same GLB bytes `Publish` downloads. What the merchant sees in
the Studio is byte-for-byte what their customers will render — the two can't
drift, because they are one code path.

Edits re-run layout on the loaded meshes (`Viewer.setManifest`) instead of
recreating the viewer: placement and scale are mesh transforms, and browsers
cap live WebGL contexts, so rebuild-per-keystroke dies within a minute of
real use. When an edit moves the model outside the current view by more than
a 25% band, the camera refits while keeping the merchant's orbit angle.

## Gizmos

One combined gizmo (toolbar: Orbit / Transform): translate arrows outermost,
rotation rings between, per-axis scale cubes on the shafts — the cubes are
what makes non-uniform scaling draggable; the centre handle scales uniformly.
three.js only ships single-mode TransformControls, so three instances share
the mesh with a capture-phase pointerdown arbitrating who owns the drag
(scale → translate → rotate, since the handles nest). The rotate gizmo's
screen-space free-rotate handles are removed — their pick radius overlaps
the translate arrow tips.

Snapping is 0.5 mm and 15°. During a drag only the mesh moves; on release
the pose is committed through `applyGizmoPose`, which turns it back into
manifest placement: a translate on an anchored axis slides the offset and
keeps the anchor, rotation lands as degrees, scale as multipliers. The
committed manifest lays the mesh out exactly where it was dropped, so the
hand-off from dragging to authored state is invisible.

## View cube & saved views

A view cube (top-right) mirrors the camera; its six named faces and eight
corner dots are quick views — the camera swings there over ~320 ms, keeping
its distance and orbit feel. The Studio orbits the full sphere (the
storefront's polar clamp only applies to customers).

**Save view** persists the current camera into `manifest.camera` and marks it
`userSet`; publish then keeps that view verbatim instead of auto-framing, so
customers open the configurator from exactly the angle the merchant chose.

This is also why mesh transforms pivot on the part's centre (geometry is
re-centred at load): the layout engine scales and rotates about part centres,
and the smoke test asserts rendered meshes sit exactly where the layout
engine says — the divergence check that catches pivot mismatches.

## Publish compression

`Download model.glb` compresses in the browser with the same recipe the
pipeline verified — on the reference product that meant 46 KB gzipped from a
227 KB raw GLB, with worst-case geometric drift two orders of magnitude under
a printer layer line. `test/compress.test.ts` re-verifies fidelity on every
run (order-independent, since welding reorders vertices), and the embed loads
the result through its lazy meshopt decoder.

## Sizing semantics

The panel shows real mm (raw bounds × scale); the manifest stores multipliers.
With **Lock proportions** on, setting one axis multiplies every axis by the
same ratio — preserving the part's current proportions, including a stretch
made earlier while unlocked. Unlocked, only the named axis moves. `scale` is
applied about the part's own centre (see the schema), so anchors, not scale,
decide where a part sits.

## Tests

```
test/import.test.ts   18 — every fixture generated in the test file, each
                      encoding a real-world quirk (binary STL claiming to be
                      "solid", 3MF component transform chains, GLB quaternion
                      node hierarchies, metre-unit exports)
test/edit.test.ts     32 — sizing arithmetic, anchor/cycle rejection, palette
                      ops, custom-colour and add-on pricing, camera framing,
                      immutability, and the everything-chained validity check
test/gizmo.test.ts    11 — pose→manifest commits: anchored drags slide their
                      offsets, rotation changes the AABB the delta is measured
                      against, round-trips land exactly
test/compress.test.ts  3 — meshopt output is tagged, smaller, and within
                      0.05 mm of the input
test/camera.test.ts    5 — saved views round and mark userSet; the cube's 14
                      quick views are unit-length and cover every octant
test/studio.smoke.mjs 35 browser assertions — the full merchant journey
                      against the production build, including a real pointer
                      drag on the combined gizmo, view-cube navigation, the
                      saved view surviving publish, a mesh-vs-layout
                      divergence check, and the compressed download
```

The browser test exists because two real defects passed every unit test: the
camera-refit baseline was initialised after the first oversized edit (so the
refit never fired), and the `frame()` method was silently shadowed by an
instance field of the same name — `hasFrame: 'number'`. Both were only
visible with pixels on screen.
