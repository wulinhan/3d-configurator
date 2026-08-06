# @allin/studio

The merchant-facing authoring app. The Studio opens straight into an empty
3D viewport — a merchant imports one or more model files, positions and
sizes the parts in real millimetres, decides which surfaces take which
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

The CUSTOMISER (not the Studio, where merchants author against fixed
coordinates) parks the product's centre on the world origin and frames the
whole of it on open, unless the merchant saved a view — so a model
authored off in a corner still opens centred and orbits around itself
rather than swinging around empty space. The opening shot looks DOWN the
45° diagonal (turned 45° round, so a top, a front and a side all read at
once), pulled back off the product's own bounding sphere — the span the
ground grid covers — rather than a fixed distance, so a keyring and a
tabletop open filling the same share of the frame.

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
(several parts treated as one), or a **variant set** (alternatives the
customer chooses between). Every row carries a six-dot handle — drag it
between rows to reorder (the explorer order is the manifest's part order and
the option order customers meet), drop a loose part onto an assembly or
variant set to add it, drag a member out to set it loose. Drops commit
through the tested edit ops, so an illegal drop is refused by the edit
layer, not by fragile UI guards. Multi-selecting two or more loose parts
offers both structures as buttons:

- **Assembly** records `manifest.groups` — the members move, duplicate and
  repeat as one thing, but every part KEEPS its own colour option (a
  clicker's base and button are one object with two finishes). Its editor
  renames, RESIZES the whole set (the same W/H/D-with-lock fields a part
  has — members and their spacing scale rigidly about the set's centre,
  anchors surviving via offset slides), nudges every member together
  (members anchored to each other move once, not twice — the anchor
  already carries them), and splits the assembly up; splitting touches
  nothing but the grouping. Variant sets get the same size fields.
- **Variant set** builds a `choice` option with `role: 'variant'` and
  points each member's `visibleWhen` at it — mutual exclusivity by
  construction, no runtime special-casing. A part that was an optional
  add-on is absorbed rather than refused (the refusal was invisible in
  practice and left merchants with no choice to preview). In the Studio
  exactly one member is visible; clicking a hidden member (hollow dot) swaps
  the preview to it so it can be edited. A member's editor prices the choice
  instead of showing the add-on toggle, which would otherwise orphan the
  option. In the embed, clicking a visible member opens its choice, and the
  set renders as ONE tab named "Set (Member)" where the member and its
  colour are picked together; renaming a part renames its entry in the set.

Each row keeps uniform square icon controls: an eyeball (hide/show — an
assembly's eyeball hides every member), a solo toggle (soloing a hidden
variant member also selects it, switching the preview — otherwise solo
would show nothing), a duplicate button (two overlapping squares; loose
parts, assemblies and variant sets alike), and on bundles a split/dissolve
button (two squares apart) AND a ✕ that deletes the whole assembly or set
with every part in it (one confirm, one undo step); parts carry their own
✕ delete. Renaming — parts,
assemblies and variant sets — is double-click on the name, with the input
sized to its content; name pills hug their text. With a set's editor open,
Transform parks a translate-only gizmo at the set's centre of mass, so the
whole thing drags as one (the same nudge op the panel fields use — one
undo step per drag). Deleting asks with the Studio's own dialog
(never the browser prompt), and checking rows in the explorer offers a mass
delete — one confirm, one undo step. Delete repairs every reference: parts
anchored to the deleted one keep their world position, its options are
pruned, dangling colour links re-point, and a variant set sheds the
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

## Finish & staging

A Finish tab (after Palette) surfaces the material knobs the manifest
already carries per part — gloss (inverse roughness), metalness,
faceted-vs-smooth shading, and a **texture library**: six procedural
finishes (fine/coarse leather, woven fabric, canvas, wood grain, 3D-print
layer lines) generated at runtime as tileable normal maps — no image
assets — with sliders for grain size (real millimetres) and bump depth.
Parts ship without UVs, so the viewer box-projects them at load (and again
after every engrave cut); the finish ships in the manifest and renders
identically in the storefront — plus a **Scene & lighting** section: exposure,
studio-environment reflection intensity, and contact-shadow strength
(`manifest.scene`, range-validated). Everything applies live in the viewer
and ships with the published manifest, so the storefront lights and
finishes the product exactly as staged. Publish itself is the topbar's
primary CTA.

## Duplicating and growing a project

Assemblies and variant sets have a **Duplicate** button in their editors:
every part, internal joint, colour option and (for sets) the exclusive
choice is cloned, with anchors between members remapped to the cloned
members and anchors to outside parts left pointing outside — the copy lands
beside the original and moves as one thing. Variant sets get the same
editor an assembly has (rename, move together, bring to origin), opened by
clicking the set's header.

**＋ Add parts** (or dropping a 3MF/STL/GLB anywhere on the explorer) is
also how a project STARTS — there is no upload gate; the Studio opens into
the empty viewport and the first file in names the product (from the
filename), frames the camera and selects the first part. Every later file
merges into the project: names dedupe, the incoming parts get colour
options on the existing palette, one GLB is rebuilt from the union, and —
because every import is normalised — the new parts land centred on the
flat axes, sitting on the ground. The orientation preset (which way the
file is up) sits in the explorer and applies to the next file added.
**New project** in the topbar returns to the empty viewport.

**Repeat** on a PART is a live pattern, not a stamp: it is stored on the
part (`repeats`), the renderer spawns the copies, and every parameter
stays editable afterwards — change the count or the gap and the row
re-forms under the cursor. Patterns STACK, each one repeating everything
the ones before it produced, so ×5 along X plus ×3 along Y is a 5×3 grid
of fifteen (a new pattern defaults to the first axis the existing ones
aren't using, so stacking builds a grid rather than a longer line). Every
copy IS the part: it shares the geometry, material and colour option, so
recolouring, resizing, engraving or hiding the part carries all of them,
clicking a copy selects the part, and the explorer still lists one entry
(the header shows "15 in total"). Copies clone the part's children too,
so extruded text and image zones come along.

**Repeat** on an assembly or variant set (hidden from customers) still
stamps copies along an axis — pitched at the entry's own size
plus a gap (negative gaps overlap pieces, for interlocking chains) — or in a ring: a RIGID turn about the vertical
axis through the world origin, where the original is taken as facing the
tangent and every copy (parts and whole assemblies alike) both orbits and
spins by its share of the circle, keeping its face to the ring. Anchors on
circle copies collapse to absolute offsets — a rotated copy cannot keep
axis-aligned joints. Stamped copies are ordinary parts with their own
colour options (labels count up: "Base 2", "Base 3"), so any of them can
be recoloured, moved or deleted afterwards; the whole stamp is one undo
step. Copying a whole SET is a different job from patterning one part,
which is why the two tools stayed separate.

Publish lives in a floating modal off the topbar CTA (validation report,
manifest and compressed-GLB downloads); the left panel keeps only Parts,
Palette and Finish. See `docs/integrations.md` for wiring the published
files into Shopify, WooCommerce or a plain HTML page, and for why the
payload's totals must be recomputed server-side before charging.

## 3D text on a surface

A part's editor carries a **3D text** section: *Place text on a face* arms
the same surface-glow picker Snap uses, and the clicked flat face's centroid
and normal become the slot's **sketch plane** — stored in the part's local
space, so the text rides every later move, rotation and anchor of the part.
Customers type in the configurator; their words are extruded (three.js
TextGeometry) straight out of the surface.

Per slot the merchant sets: the **text colour** (match the carrier part —
the default, text recolours with it — or pin any palette finish of its
own), the **typeface** (a dropdown of five bundled
faces — Helvetiker regular/bold, Droid Sans bold, Gentilis regular/bold,
trimmed to printable ASCII at 25–63 KB each and lazy-loaded only when a
manifest uses text), the **style** — *Embossed* extrudes the glyphs proud
of the surface (with a Fusion-style **sink** that lowers the sketch plane,
relief = depth − sink), while *Engraved* is a REAL boolean difference: the
glyph volume is subtracted from the part with three-bvh-csg (lazy-loaded,
~115 KB only when a manifest engraves), and the pocket is then CLOSED with
an exact lining — walls and floor built from the glyph prism itself — so
engraving stays occluded and solid even on merchant meshes with open
shells or flipped winding, where raw CSG loses its inside/outside bearings
and leaves see-through pockets. The pocket FLOOR — the flat face, not the
walls — renders as its own mesh in the slot's text colour, so engraved
letters read in colour at the bottom of the cut while the walls stay the
part's material. Text is authored in REAL millimetres and stays there: the glyph carries the
inverse of its carrier's scale, so growing a part to make room for a longer
name leaves the lettering exactly the size it was set to (the engrave cutter
shrinks the same way, so an engraved name keeps its true depth and size
too). Follows the customer's text live — glyph **size**, extrusion **depth**, a
spin about the normal, a length limit, example text (rendered as
the model's preview and the input's ghost), and pricing — flat and/or
per-character, recomputed server-side like every other delta. **Text colour** is the merchant's to set at any time: left alone the text
shares the carrier part's material and colours with it, or pick a swatch
and the text renders in that — no permission needed from anything else.
Ticking **Customers can choose the text colour** ADDS a picker on top:
tick the swatches customers may choose from (none ticked offers the whole
palette), and the customer panel shows them under the text box with the
merchant's own colour as the first button. Their pick rides the order
payload named, not as a hex, and is checked against the offered subset, so
a hand-edited payload cannot order a finish the merchant never listed.
Closing the choice again keeps the colour and drops only the offer. The
payload carries the typed string on the order. Deleting or renaming the carrier part
deletes or renames the slot with it.

**Bend** curves the run along a circular arc: the number is the angle the
whole text subtends — positive arches up (badge-top text), negative smiles,
±360° closes a full circle. Each letter is laid at its own station on the
arc, turned to the local tangent, advancing by its real font metrics, so
spacing along the curve matches the straight run and follows the customer's
text live. The bend happens inside the glyph-run geometry itself, so
everything downstream gets it for free: embossing, the engrave cutter, and
the pocket's walls and floor all follow the arc exactly. (Hidden while
one-piece-per-letter is on — spawned pieces have their own line/circle
patterns.)

**Wrap onto the surface** takes the run off the flat sketch plane and lays
it on the geometry itself: each glyph is dropped onto the surface under it
and turned to that surface's own normal, so a name rides a bottle, a
bracelet or a dome instead of flying off it at the ends. Spacing is
measured ALONG the surface — the baseline is sampled in small steps, each
projected onto the geometry, and the real 3D distance accumulated — so
letters don't bunch where the surface curves away, which is what a
"project straight down" scheme does. It composes with the two flat
baselines: Bend or a drawn curve shapes the run in the sketch plane, and
the wrap lays THAT curve onto the geometry. **Float above** lifts the run
off the surface along its own normal. Letters are rigid, so a glyph chords
a fraction of a millimetre on a tight radius; any that run off the end of
the surface fall back to flat placement rather than vanishing.

The box ticks ITSELF when you place a slot on a curve. The click that
drops a slot already knows the face it landed on: the face is grown by
welding neighbouring triangles that share its plane, and the smallest
angle to the neighbours that weld REJECTED is the face's break angle — a
flat panel breaks hard at its edges (90° on a box), a barrel's facets
break by a couple of degrees. Under 30° the surface is a curve rather than
a face, so the slot arrives wrapped and the panel says why instead of
leaving a checkbox for the merchant to find. Untick it and the run
returns to the flat sketch plane; nothing is forced.

Engraving wraps too. The cutter is the same wrapped run, sunk by the
engrave depth along each glyph's own surface normal and overshot slightly,
so the pocket it subtracts curves with the letters — walls square to the
surface, floor parallel to it at depth, all the way round a bottle. The
pocket lining and floor are lifted from that same wrapped prism, so the
engraved look is the embossed geometry's exact negative and the two can't
drift apart.

**Curve the baseline** goes freeform: draggable anchor dots appear pinned
to the slot's face (seeded as a straight three-dot run), and the letters
walk the open Catmull-Rom curve through them — drag a dot to bow the
baseline live, click a segment's smaller midpoint dot to add an anchor,
double-click an anchor to remove it (two minimum), Esc or *Done shaping*
to finish. The run centres on the curve's arc-length middle; text longer
than the drawn curve overruns straight past the ends, and the glyphs sit
exactly ON the curve — what you drag is what renders, engraving included,
because the path feeds the same per-glyph station engine as Bend. Bend and
the drawn curve are alternative baselines: setting one clears the other
(*Straighten* clears the curve explicitly). Anchors are stored in the
slot's sketch plane, so the curve rides part moves, rotation and Slide.

**One piece per letter** turns the carrier part — or, when it belongs to
an assembly, the WHOLE assembly — into a TEMPLATE: every character the
customer types spawns its own copy, copy k carrying character k. Line
mode marches pieces along a chosen axis at the template's size plus a
gap, exactly like the repeat tool; circle mode turns each piece a set
step° further round the vertical axis through the origin (the original
faces the tangent), the same rigid turn the repeat tool stamps. A space
spawns a blank piece, the length limit caps the piece count, and
per-character pricing makes each piece pay its way. In the customiser a
linear run keeps its CENTRE OF MASS on the world origin, easing there as
the text grows or shrinks — the product grows outward from the middle
instead of marching off to one side (the Studio viewport keeps authored
positions, so merchants author against fixed coordinates). The spawning
happens in the viewer (the manifest stays static; selections drive the
copies),
so the same manifest renders one tile or twenty depending on what the
customer types — the "type your name, get one clicker per letter" product
is this toggle plus a text slot on the clicker assembly.

## Image zones: customer images projected onto a surface

A part's editor also carries an **Image zone** section: *Place image zone on
a face* arms the same surface picker, and the zone CONFORMS to the clicked
face — centred on it, rotated to run with the face's own edges (whatever
the part's or the geometry's orientation), and opened to the face's
measured extents. Width/height/rotation stay editable afterwards as a
framing rectangle, and **Slide** nudges the zone across its surface plane.
The customiser shows the zone as a translucent “Image here” veil until an
image arrives.

The zone IS the picked surface. At render time the viewer re-welds the
face region at the zone's origin/normal — the exact same weld the blue
placement highlight shows — and builds the overlay mesh from that region's
own triangles, lifted 0.15 mm along the face normal and parented to the
carrier mesh so it rides every transform, rotation, and scale for free.
The face's real rim is the mask by construction: rounded corners, chamfers,
circles, and freeform outlines all clip the image exactly, like a die-cut
sticker, with no curve approximation anywhere that could wobble, contract,
or grow tails. The zone rectangle only frames the IMAGE: an unlit canvas
texture in the zone's aspect is UV-mapped across that rectangle on the
region mesh, and the customer's image is DRAWN into the canvas at its
offset and size — repositioning and resizing repaint pixels instead of
rebuilding geometry, so there are no projection artefacts and nothing can
bleed past the face's own edges. Unlit means the artwork keeps its true
colours regardless of scene lighting, like a printed sticker.

Customers get the storefront upload pattern: an *Upload image* button
(downscaled client-side to ≤1024 px and re-encoded under the zone's byte
budget before it ever leaves the browser), a POSITION arrow pad (a tap moves
a tenth of the zone; ⊙ recentres), a SIZE row — a typed percent field with
− / ＋ stepping 1 %, running 10–500 % (100 % = the largest aspect-preserved
fit inside the zone; beyond that the image crop-zooms within the zone,
panning across the overflow; resizing is uniform) — and *Remove
image*. Offsets are clamped so the image never abandons the zone — in the
panel and again in the pricing layer, which treats the selection value (a
JSON string carrying the data-URL image, offset and size) as untrusted.
Deleting or renaming the carrier part deletes or renames the zone with it.

## Panel chrome

Every properties section folds behind an icon header (caret, a
Lucide-geometry glyph drawn inline — no icon dependency — and the title).
Controls that belong on the header row, like *Lock proportions* or
*Customer selects this part*, stay reachable while the body is folded, and
folded titles are remembered for the session so switching parts doesn't
reopen what the merchant just tidied away.

Every number box is also a SCRUBBER: press and drag sideways to walk the
value in that field's own step (0.1 mm, 5°, 1 letter). A press that never
moves still focuses for typing, so the two gestures don't fight, and a
whole scrub lands as ONE history entry — the first step records it, the
rest ride it — so it rewinds in a single Ctrl+Z. *Lock proportions* is
persisted on the part, so a scale-gizmo drag with it on takes every axis
with it; unlocked, each axis is its own.

Controls with nothing to act on grey out instead of failing: **Match
another part** until a second part exists, **To origin** when the part is
already centred and on the ground.

## Anchors: summary first, controls on demand

Each Position axis is a single readable line — `as modelled`, or
`min → Base max` — plus a number field in ABSOLUTE millimetres (the part's
laid-out centre). Typing a new coordinate slides the offset under whatever
anchor the axis has, so joints hold; the raw anchor offset lives in the
expanded editor for fine-tuning. Clicking the summary expands that axis
(one at a time) into a full-width anchor dropdown and two min/centre/max
icon triads (the text-align-buttons pattern). The old layout kept nine
dropdowns permanently on screen, truncated to "agai… my c… thei…"; most
axes are "as modelled" most of the time, so the controls now only exist
while they're being used.

**Match** puts a part at exactly another part's location and rotation:
centre lands on centre (the only reading of "same place" that holds when
the parts are different sizes) as live centre→centre anchors, so the pair
keeps coinciding when the source later moves. Scale is untouched, and
anchor cycles are refused by the edit layer.

## Snapping surfaces

The Snap tool works on SURFACES, not invisible triangles: hovering grows
the hit triangle across shared edges while they stay coplanar and glows the
whole flat face; the first pick keeps its glow (accent colour) while the
second is chosen. Adjacency is computed over POSITIONS, not vertex indices
(quantised to a thousandth of a mm) — real meshes split their vertices at
every hard edge for normals, so index-based adjacency sees each triangle
as an island; welding by position finds the flat face the way CAD region
selection does. The commit mates the two faces flush along the clicked
axis AND centres the moving part onto the target in the face plane — a snap
that only shared a plane left the part hanging in empty air beside its
target, which read as "it just moved up". All three axes land as live
anchors, so the joint holds when the target moves and the merchant can
slide the offsets afterwards.

Number fields across the panels carry small ▲▼ stepper triangles at their
right edge — one click is one step from the last committed value, so quick
tweaks need neither typing nor the gizmo. Errors surface inline exactly as
typed commits do.

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
test/wrap (embed)     14 — surface-wrapped text against ANALYTIC surfaces, so
                      every assertion is exact maths: a flat probe
                      reproduces the flat layout, a cylinder puts every
                      glyph on the barrel facing straight out, spacing is
                      the arc between letters (the chord trailing it
                      proves the walk measures the surface, not the flat
                      shadow), a dome carries text too (doubly curved, so
                      no unrolling scheme could), Bend composes with the
                      wrap, lift pushes out along the local normal,
                      overruns and empty probes report rather than
                      vanish, the baked geometry hugs the barrel in
                      the caller's target space, and the wrapped ENGRAVE
                      pieces line up: the cutter sinks below the surface
                      by the engrave depth, the pocket floor rides the
                      barrel at that depth, and the lining walls stand
                      square to the surface rather than to the sketch
                      plane
test/repeat (embed)    8 — live part patterns: a linear row marches at
                      size + gap (negative overlaps), a ring turns each
                      copy with its swing so it faces the tangent, an
                      explicit step fans instead of rings, patterns STACK
                      into a grid (each repeating what came before), and
                      nonsense counts are skipped rather than rendered
test/parts.test.ts    18 — rename ripples (colour, add-on, variant entries),
                      delete repair, match-pose, absolute positioning, snap
test/structure.test.ts 36 — assemblies merge colours without double-painting,
                      variant sets are exclusive by construction (and absorb
                      add-on parts), drag-style add/remove membership repairs
                      colours both ways, group nudges never move an anchored
                      member twice, reordering drags the option order along,
                      deletes repair both structures, repeat patterns pitch
                      line copies at size+gap and turn ring copies rigidly
                      about the origin — assemblies orbit AND spin together
test/text-bend (embed) 14 — curved text: bend stations lie on the arc with
                      tangent-turned glyphs (arch up / smile down / full
                      circle / spaces advance silently), the bent run's
                      merged prism arches and stays centred at the same
                      extrusion depth, and the engraved pocket's walls and
                      floor follow the arc; freeform paths reproduce the
                      straight run on a straight curve, march letters up a
                      vertical one, arch through a raised anchor, overrun
                      straight past short curves, beat bendDeg when both
                      are set, keep the baseline ON the drawn curve (no
                      recentring), and carry the engrave pocket along —
                      all against a real bundled font, the same geometry
                      the viewer renders
test/text.test.ts     15 — text slots bind valid, tune through validation,
                      sanitise + clamp customer text, price flat + per
                      character, follow their carrier part (hidden = inert,
                      deleted = gone, renamed = renamed), per-letter
                      spawning toggles on/off through validation in both
                      line and circle modes, negative gaps overlap on
                      purpose, engraved style skips the emboss sink rule,
                      the slot's own colour pins and releases, Bend
                      validates ±360° with 0 clearing back to straight,
                      and the drawn baseline path rounds, validates, and
                      displaces Bend (and vice versa); a slot dropped on a
                      curved face arrives wrapped while a flat pick does
                      not, and wrapping otherwise sets, tunes and clears
                      like any other slot field
test/image.test.ts     8 — image zones bind valid with defaults, tune and
                      nudge through validation (the nudge slides in the
                      zone's own surface plane, both face orientations),
                      follow their carrier part (deleted = gone, renamed =
                      renamed), clamp customer offsets to the zone, price
                      when used, and reject garbage/non-image selections
test/engrave (embed)   3 — the boolean cut comes back CLOSED: surface,
                      walls and floor — even on an open-shell mesh where
                      raw CSG loses its bearings (the see-through-pocket
                      regression, asserted headless)
test/studio.smoke.mjs browser assertions — the full merchant journey
                      against the production build, from the empty viewport
                      through the first import (name adoption, camera framing),
                      including a real pointer drag on the combined gizmo (and
                      that one Ctrl+Z rewinds the whole drag), view-cube
                      navigation, the saved view surviving publish, a
                      mesh-vs-layout divergence check, drag-handle reordering
                      and drag-out-of-assembly, the customer preview mounting
                      the real embed and switching a variant set, the
                      resizable/collapsible explorer, surface-glow snapping
                      (hover, sticky first pick, flush + centred landing), the
                      Studio's own dialogs and listboxes, live repeat
                      patterns (copies spawn without adding parts, retuning
                      count and gap re-forms the row, a second pattern
                      stacks into a grid, removal returns the part to one), the compressed
                      download, New project resetting to the empty stage,
                      3D text end to end (face pick → slot → typeface
                      dropdown reshaping the extrusion → Bend arching the
                      run and 0 straightening it → baseline shaping with
                      seeded dots, a real drag bowing the curve, Esc and
                      Straighten → one-piece-per-letter
                      spawning a pitched row of template copies → customer
                      typing priced per character in the real embed → removal
                      clearing slot, extrusion and spawned pieces), and image
                      zones end to end (face pick → the zone veil rendered
                      on the picked face's own triangles, riding the part →
                      customer upload painting onto that region surface →
                      arrow-pad repositioning and stepped resizing → removal
                      restoring the veil, then the zone itself), plus the
                      viewport chrome rules: no Orbit tab (Transform toggles,
                      deselect disarms it, tools disabled with no parts) and
                      the ground grid growing to cover a repeated row
```

The browser test exists because two real defects passed every unit test: the
camera-refit baseline was initialised after the first oversized edit (so the
refit never fired), and the `frame()` method was silently shadowed by an
instance field of the same name — `hasFrame: 'number'`. Both were only
visible with pixels on screen.
