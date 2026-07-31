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

One combined gizmo (toolbar: Orbit / Transform / Snap): translate arrows
outermost, axis-aligned quarter-arc rotation rings joining the positive axes
with a 45° grab sphere each (three's own rings billboard to the camera; the
Studio re-pins them to their world planes every frame), per-axis scale cubes
on the shafts — the cubes are what makes non-uniform scaling draggable; the
centre handle scales uniformly. Rotation stays grabbable all the way round
via the full invisible pickers.

The Studio speaks Z-up — X and Y are the flat plane, Z is height, and the
vertical handles wear blue. The internal space (manifest, embed, glTF) stays
Y-up; the mapping is purely presentational, in `UI_AXES` and the gizmo
colour swap. Commits stream during the drag (throttled), so the panel's mm and
degrees update live under the merchant's hand. Clicking a handle never
changes the selection; clicking empty space deselects and hides the gizmo.
three.js only ships single-mode TransformControls, so three instances share
the mesh with a capture-phase pointerdown arbitrating who owns the drag
(scale → translate → rotate, since the handles nest). The rotate gizmo's
screen-space free-rotate handles are removed — their pick radius overlaps
the translate arrow tips.

Snapping is 0.1 mm and 5° (panel rotation steps 5° too — fine work first,
big sweeps by typing). During a drag only the mesh moves; on release
the pose is committed through `applyGizmoPose`, which turns it back into
manifest placement: a translate on an anchored axis slides the offset and
keeps the anchor, rotation lands as degrees, scale as multipliers. The
committed manifest lays the mesh out exactly where it was dropped, so the
hand-off from dragging to authored state is invisible.

## Parts management

The explorer renders ENTRIES, not raw parts: a loose part, an **assembly**
(several parts treated as one), or a **pick-one set** (alternatives the
customer chooses between). Every row carries a six-dot handle — drag it
between rows to reorder (the explorer order is the manifest's part order and
the option order customers meet), drop a loose part onto an assembly or
pick-one set to add it, drag a member out to set it loose. Drops commit
through the tested edit ops, so an illegal drop is refused by the edit
layer, not by fragile UI guards. Multi-selecting two or more loose parts
offers both structures as buttons:

- **Assembly** records `manifest.groups` and merges the members' solo colour
  options into a single option (one colour control for the customer — that's
  what "treated as one part" means at the storefront). Its editor renames,
  nudges every member together (members anchored to each other move once,
  not twice — the anchor already carries them), and splits the assembly up;
  splitting keeps the merged colour option, and a departing member gets its
  own colour option back.
- **Pick-one set** builds a `choice` option with `role: 'variant'` and
  points each member's `visibleWhen` at it — mutual exclusivity by
  construction, no runtime special-casing. A part that was an optional
  add-on is absorbed rather than refused (the refusal was invisible in
  practice and left merchants with no choice to preview). In the Studio
  exactly one member is visible; clicking a hidden member (hollow dot) swaps
  the preview to it so it can be edited. A member's editor prices the choice
  instead of showing the add-on toggle, which would otherwise orphan the
  option. In the embed, clicking a visible member opens its choice.

Each part row keeps uniform square controls: an eyeball (hide/show — an
assembly's eyeball hides every member), a solo toggle, and ✕ delete; rename
is double-click on the name. Deleting asks with the Studio's own dialog
(never the browser prompt), and checking rows in the explorer offers a mass
delete — one confirm, one undo step. Delete repairs every reference: parts
anchored to the deleted one keep their world position, its options are
pruned, dangling colour links re-point, and a pick-one set sheds the
deleted member (dissolving entirely below two). Hide/solo are authoring
aids only — never part of the manifest. Selecting a part slides a floating
properties panel in from the stage's right edge (size, position anchors,
rotation, colour, pricing, match-position, and **To origin** — centre on the flat axes, sit on the
ground, implemented as offset slides so anchors survive; assemblies have
the same button and move as one rigid thing); deselecting slides it away.
The tool row (Orbit / Transform / Snap / Save view) sits directly above
that panel at the same width, with a dark pill that glides between modes
(the framer-motion layoutId tab pattern, done with a measured span); the
view cube keeps the top-left corner. The
explorer panel itself resizes by dragging the divider, and the divider's
pill collapses/expands it. An origin grid and axes mark 0,0,0 — the grid
sits a hair below ground and the axes a hair above (exactly coplanar lines
shimmer in the depth buffer), the camera's near plane is 1 mm not 0.1 (a
50 000:1 far/near ratio starved depth precision into visible flicker), and
the origin axes step aside while the gizmo is attached, since both say the
same thing in the same colours. Selecting a part eases the orbit centre
onto it, deselecting eases back over the origin. While dragging explorer
rows, a card copy of the row rides the cursor (the dnd-kit DragOverlay
pattern) and the row dims in place.

## Snapping surfaces

The Snap tool works on SURFACES, not invisible triangles: hovering grows
the hit triangle across shared edges while they stay coplanar and glows the
whole flat face; the first pick keeps its glow (accent colour) while the
second is chosen. The commit mates the two faces flush along the clicked
axis AND centres the moving part onto the target in the face plane — a snap
that only shared a plane left the part hanging in empty air beside its
target, which read as "it just moved up". All three axes land as live
anchors, so the joint holds when the target moves and the merchant can
slide the offsets afterwards.

## Controls

`ui/controls.tsx` replaces the browser-default widgets whose popups can't
be styled: `Select` follows the react-aria ListBox pattern (21st.dev
reference) — combobox/listbox roles, arrow-key navigation, typeahead,
swatch chips for colour options — and `ConfirmDialog` follows the shadcn
Alert Dialog pattern: backdrop, focus lands on Cancel, destructive action
loudest. Both are dependency-free and match the Studio's design language.

## Undo / redo

Global, Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (topbar buttons too). Because every
edit op returns a fresh validated manifest, history is just a stack of past
manifests — no command objects, no inverse operations, nothing to get out of
sync. Gizmo drags stream `transient` commits that replace instead of push, so
a whole drag is one undo step; keystrokes inside text fields are left to the
field's own undo.

## Customer preview

The **Preview** button opens the storefront embed itself — `mount()` from
`@allin/embed`, panel, pricing and all — over the manifest as authored and
the same GLB blob the Studio previews. It cannot drift from what customers
will see because it is not a simulation of the embed; it is the embed.

## View cube & saved views

A view cube (top-right) mirrors the camera; its six named faces and eight
corner dots are quick views — the camera swings there over ~320 ms, keeping
its distance and orbit feel. The Studio orbits the full sphere (the
storefront's polar clamp only applies to customers). Top and Bottom carry a
fixed 2° tilt toward the front: exactly at the pole the orbit azimuth is
degenerate, so the landing orientation used to depend on where the camera
came from — the tilt makes both poles land the same way up, every time,
without the flip.

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
test/structure.test.ts 19 — assemblies merge colours without double-painting,
                      pick-one sets are exclusive by construction (and absorb
                      add-on parts), drag-style add/remove membership repairs
                      colours both ways, group nudges never move an anchored
                      member twice, reordering drags the option order along,
                      deletes repair both structures
test/studio.smoke.mjs 95 browser assertions — the full merchant journey
                      against the production build, including a real pointer
                      drag on the combined gizmo (and that one Ctrl+Z rewinds
                      the whole drag), view-cube navigation, the saved view
                      surviving publish, a mesh-vs-layout divergence check,
                      drag-handle reordering and drag-out-of-assembly, the
                      customer preview mounting the real embed and switching
                      a pick-one set, the resizable/collapsible explorer,
                      surface-glow snapping (hover, sticky first pick, flush
                      + centred landing), the Studio's own dialogs and
                      listboxes, and the compressed download
```

The browser test exists because two real defects passed every unit test: the
camera-refit baseline was initialised after the first oversized edit (so the
refit never fired), and the `frame()` method was silently shadowed by an
instance field of the same name — `hasFrame: 'number'`. Both were only
visible with pixels on screen.
