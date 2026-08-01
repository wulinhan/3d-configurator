# @allin/embed

The embeddable, manifest-driven product configurator — the self-serve version
of the eleven hand-written `visualisation/*-configurator.html` pages in the
taptiles-site repository — plus the model pipeline that feeds it.

## Why it exists

Each shipped configurator is a single HTML file with geometry baked in as JSON
literals, a per-product axis remap hardcoded in the mesh builder, and part
names, palettes and placement rules written by hand. It works, but every new
product is a copy-paste, and a merchant can't author one at all.

The replacement splits that into three pieces:

- a **manifest** describing a product — parts, placement, palettes, options,
  price deltas, camera, branding;
- a **runtime** that renders any valid manifest;
- a **Studio** where a merchant produces the manifest without writing code.

## What's here now

```
src/manifest/types.ts      the contract — every field, and why it exists
src/manifest/validate.ts   resolves every reference; errors block, warnings don't
src/runtime/layout.ts      anchored placement → concrete transforms (pure)
src/runtime/state.ts       selections, colour links, surcharges, payload (pure)
src/runtime/viewer.ts      three.js glue — the only part that needs eyes on it
src/embed.ts               mounts the panel, posts changes to the host page
tools/glb.mjs              minimal glTF 2.0 / GLB writer and reader
tools/extract-geo.mjs      pulls the baked GEO literal out of a shipped configurator
tools/orient.mjs           normalises to canonical space (mm, Y-up, ground-centred)
tools/compress.mjs         weld + quantise + meshopt
tools/verify.mjs           order-independent geometry diff, mm-accurate
tools/build-model.mjs      extract → orient → compress → verify, in one command
tools/check-manifest.ts    validate a manifest and cross-check it against its GLB
tools/bundle-demo.mjs      inline everything into one self-contained HTML file
test/                      unit tests, plus a browser smoke test of the demo
```

The demo storefront the tests drive lives in `apps/demo/` at the repo root —
a hand-authored manifest, its model, and a mock cart.

Rendering uses filmic (ACES) tone mapping with the ambient share pulled well
below the key light: at the old balance the ambient term alone clipped every
face of a white part to the same flat 255, so white products rendered as
silhouettes. A soft contact shadow under the model does the other half of the
job — a lit white top face sits within a few units of the pale page
background, and the shadow is what keeps the silhouette readable.

## Canonical space

Everything downstream assumes **millimetres, Y-up, X/Z centred on the model,
Y = 0 at the ground plane**. Whatever convention the source used is resolved
once at import (`tools/orient.mjs`) and baked into the GLB.

That single rule is what makes the rest of the manifest expressible in a GUI:
"2 mm above the ground" means the same thing for every product, so placement
can be anchored (`{ align: 'min', to: 'body:min', offset: 2 }`) rather than
absolute. Absolute coordinates break the moment a merchant re-uploads a
slightly taller model; anchors don't.

The Tap Bars are `y,z,x` — matching the `THREE.x = 3MF.y - CX` remap the
shipped configurators do by hand.

## Model pipeline

```
node tools/build-model.mjs <taptiles-site>/visualisation/tap-bar-3-configurator.html \
     ../../apps/demo/models/tap-bar-3.glb --axes y,z,x
```

Measured on Tap Bar 3 (5 parts, 17,087 vertices):

| stage | size | gzipped |
| --- | --- | --- |
| source HTML (geometry baked in) | 894 KB | 239 KB |
| GLB, uncompressed | 601 KB | 227 KB |
| Draco (edgebreaker) | 58 KB | 51 KB |
| **quantise-14 + meshopt** | **106 KB** | **46 KB** |

Draco is 5 KB smaller gzipped but ships a ~200 KB decoder against meshopt's
~5 KB, which dominates on a first visit. Meshopt it is — 5.2× less on the wire
than the page we serve today.

Compression is lossy, so the build verifies it. `tools/verify.mjs` compares the
compressed model against the uncompressed one with an order-independent diff
(welding reorders vertices, so a positional comparison can't assume indices
line up): bounding box, surface area, and the farthest any original vertex sits
from the nearest vertex in the output.

```
worst bbox drift   0.0038 mm
worst vertex drift 0.0076 mm
worst area change  0.081%
```

Tolerance is 0.05 mm — a quarter of a printer layer line. The build exits
non-zero if geometry moves further than that, so nothing ships unchecked.

## Manifest

`src/manifest/types.ts` is the reference; `demo/tap-bar-3.manifest.json` is a
worked example. Three decisions worth stating up front:

**Placement is anchored.** Each axis reads as "put *my* edge at *that* edge,
plus an offset in mm". The demo's text part reproduces exactly what the shipped
overlay computes at runtime:

```json
"x": { "align": "center", "to": "body:center", "offset": 0 },
"y": { "align": "min",    "to": "body:min",    "offset": 2 },
"z": { "align": "max",    "to": "body:max",    "offset": 1 }
```

**Scale is stored as a multiplier, shown as millimetres.** The Studio displays
real W/H/D (bbox × scale) with a lock-aspect toggle, but the manifest keeps the
ratio, so re-uploading a revised model preserves the intent instead of
stretching new geometry onto old numbers.

**The configurator never states a price.** It reports itemised deltas and lets
the host's cart own base price, currency, tax and discounts. A merchant's store
is the authority on money; a second copy here would go stale.

Two structural notions sit on top of parts. `groups` marks a set of parts the
Studio treats as one — an *assembly*: moved together, one shared colour
option. The runtime ignores it beyond validation, because by the time a
manifest ships, the merge has already happened in the options. A `choice`
option with `role: "variant"` is a *variant set*: its parts are mutually
exclusive, each carries `visibleWhen` on that option, so customers pick which
part they get and exactly one renders. `role` is advisory (the Studio's
construction note); visibility itself flows through the same `visibleWhen`
machinery add-ons use. Clicking a part whose visibility hangs on a choice
opens that choice in the panel. A variant set is either-or *everywhere*:
an option whose painted parts are all hidden is inert — no panel tab, no
summary row, and crucially no surcharge (`isOptionActive` in
`runtime/state.ts`; switching the set away from a part drops that part's
colour pricing). The choice option itself always stays live — it is how the
customer switches back. In the panel, a variant set and its members' colours
render as ONE tab named "Set (Member)" — colour options that only paint
members fold into it, so which part and what colour are a single decision.

## Trying it

From the repository root:

```
npm install
npm run build      # bundle the runtime into apps/demo/
npm run serve      # http://localhost:4321
```

Drag to orbit, click a part on the model to jump to it, and open *What the
configurator posted to this page* to watch the payload the cart is pricing
from. The cart is the mock merchant's, not the configurator's.

`npm run build:standalone` (run inside `packages/embed`) inlines the runtime,
styles, manifest and models into `apps/demo/standalone.html` — one file, no external requests, opens from
`file://`. That's the version to send someone.

## Checks

```
npm test                # unit + browser
npm run test:unit       # validator, layout, pricing — 55 tests
npm run test:browser    # drives the demo in Chromium — 14 assertions
npm run check:manifest    # validates apps/demo/tap-bar-3.manifest.json
```

`check:manifest` goes past the schema and confirms every `mesh` a part names is
actually present in the GLB — a manifest can be internally consistent and still
reference a mesh that doesn't exist.

`test:browser` needs a Chromium binary; it looks at `CHROMIUM_PATH` and falls
back to `/opt/pw-browsers/chromium`. It exists because two real defects passed
every unit test:

- **Quantised geometry.** Compressed models keep their de-quantisation scale on
  the GLB *node*. Reading the geometry alone rendered a 140 mm bar about 2 mm
  wide — correct colours, correct prices, invisible product. Hence the
  `coverage` assertion, which fails if the model stops filling a sane share of
  the frame.
- **Lighting.** three.js r155 moved to physical light units; carrying the
  shipped r128 intensities across left a Jade White body rendering at 150/255.
  The fix was measured against the live page rather than eyeballed — same model,
  same camera, r128 gives 255/240 and the corrected r185 gives 255/249.

Both were only visible on screen, which is the argument for the browser test
existing at all.
