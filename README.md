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
packages/api/     the service behind the Studio — accounts and saved projects,
                  published versions at immutable URLs, and the endpoint that
                  takes customer artwork so a cart carries an id rather than a
                  megabyte of base64. See its README.
apps/demo/        a mock merchant storefront hosting the embed: the reference
                  for what an integration looks like, and the browser-test target.
```

The manifest is the contract between them: the Studio writes it, the embed
renders it, and the host page's cart prices from the deltas the embed reports.
The configurator never states a price — the merchant's store stays the
authority on money.

Wiring it into a real store: [`docs/woocommerce.md`](docs/woocommerce.md),
[`docs/shopify.md`](docs/shopify.md), [`docs/wix.md`](docs/wix.md) are
copy-paste walkthroughs written for merchants;
[`docs/integrations.md`](docs/integrations.md) is the reference behind them,
including the `/p/<id>/price` endpoint a backend uses so it never bills the
browser's arithmetic.

The embed runs with or without the service. Host `manifest.json` and
`model.glb` yourself and everything works with no server at all; put the
Studio on the service and the same runtime gains saved projects, versioned
publishing and hosted artwork uploads.

## Quick start

```
npm install
npm run build       # embed bundle into apps/demo/ + Studio production build
npm run serve       # the demo storefront — http://localhost:4321
npm run dev:studio  # the Studio — http://localhost:5173
npm run dev:api     # the service — http://localhost:4400 (needs DATABASE_URL)
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
