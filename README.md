# 3d-configurator

Configurator-as-a-Service: an embeddable 3D product configurator that renders
from a **product manifest** rather than per-product code, plus the model
pipeline that feeds it. Grown out of the eleven hand-written configurators on
[allin-studio.com](https://allin-studio.com), rebuilt so that a merchant can
set one up without us writing anything.

## Layout

```
packages/embed/   the runtime — manifest schema, layout, pricing, renderer —
                  and the model pipeline tools. See its README for the details.
packages/studio/  the merchant-facing authoring app — import 3MF/STL/GLB files,
                  position parts in real millimetres, set palettes, custom-colour
                  rules and price deltas, publish a manifest the embed renders.
apps/demo/        a mock merchant storefront hosting the embed: the reference
                  for what an integration looks like, and the browser-test target.
```

The manifest is the contract between all three: the Studio writes it, the embed
renders it, and the host page's cart prices from the deltas the embed reports.
The configurator never states a price — the merchant's store stays the
authority on money.

## Quick start

```
npm install
npm run build       # embed bundle into apps/demo/ + Studio production build
npm run serve       # the demo storefront — http://localhost:4321
npm run dev:studio  # the Studio — http://localhost:5173
```

## Checks

```
npm test            # unit + browser
npm run test:unit   # validator, layout, pricing
npm run test:browser
npm run check:manifest
```

The browser test drives the demo in Chromium (`CHROMIUM_PATH` overrides the
binary; defaults to `/opt/pw-browsers/chromium`) and exists because rendering
defects — wrong scale, wrong lighting — have passed every unit test while
being obvious on screen. `packages/embed/README.md` records the specifics.
