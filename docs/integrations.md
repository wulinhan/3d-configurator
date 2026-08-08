# Putting the configurator on a real store

The embed is a plain script + one `<div>` — it has no framework and no
server, so it drops into anything that lets you add HTML. What varies per
platform is only **how the customer's configuration and its surcharges reach
the order**. This document covers both halves.

**If you are wiring up an actual store, start with its own guide** — each is
a copy-paste walkthrough written for the merchant rather than for a
developer:

| | Guide | Effort | Pricing |
| --- | --- | --- | --- |
| WooCommerce | [`woocommerce.md`](./woocommerce.md) | one PHP file | the real line price |
| Shopify | [`shopify.md`](./shopify.md) | three pasted things | $1 fee product |
| Wix | [`wix.md`](./wix.md) | Dev Mode + page code | $1 fee product |

This page is the reference behind all three.

## 1. Embedding

Host the two published files (`manifest.json`, `model.glb`) anywhere — your
own domain, the platform's file storage, or a CDN — plus the embed bundle:
`embed.js`, `embed.css`, and the `embed-*.js` chunks beside them. The chunks
are lazy pieces (typeface data for 3D text, the engraving engine, the mesh
decompressor) that
`embed.js` fetches relative to its own URL only when a product needs them —
keep the whole set in one folder and everything resolves. Then, on the
product page:

```html
<link rel="stylesheet" href="https://cdn.example.com/embed.css">
<div data-configurator="https://cdn.example.com/products/tap-bar/manifest.json"></div>
<script type="module" src="https://cdn.example.com/embed.js"></script>
```

- **Plain HTML site**: exactly the snippet above.
- **WordPress / WooCommerce**: paste the snippet into a Custom HTML block on
  the product page (or a theme template / shortcode). WP's asset pipeline is
  irrelevant to it.
- **Shopify**: add it to the product template as a section or an HTML block
  (Dawn: a Custom Liquid block). Host the files in Shopify's Files area or
  externally — both work.
- **Anything that only allows iframes** (site builders, Notion-style pages):
  wrap the snippet in a tiny page and iframe it; the embed already
  `postMessage`s to `window.parent` precisely for this case.

## 2. What the embed reports

On every change the embed does two things:

- dispatches a DOM `CustomEvent` `configurator:change` on its root element
  (same-page listeners), and
- `postMessage`s the same payload to the parent window (iframe hosts).

The payload (`SelectionPayload` in `types.ts`) already carries everything an
order needs — **including the money**:

```json
{
  "type": "configurator:change",
  "productId": "tap-bar-3",
  "manifestVersion": "0.1.0",
  "selections": { "body-colour": "jade-white", "tile-style": "mail", "stand": "oak", "body-text": "MIA" },
  "colourNames": { "body-colour": "Jade White" },
  "priceDeltas": [
    { "optionId": "stand", "label": "Desk stand: Oak stand", "amount": 24 },
    { "optionId": "body-colour", "label": "Custom colour #FF5733 (Body)", "amount": 35 },
    { "optionId": "body-text", "label": "Body text: “MIA”", "amount": 6 }
  ],
  "deltaTotal": 65,
  "currency": "SGD"
}
```

So yes — it is the same manifest method end to end: the manifest defines the
options and the deltas, the embed computes them, and the payload hands the
itemised result to whatever cart is listening. The configurator itself never
states a total price; the base price stays the store's.

**Image uploads.** An image-zone (`upload`) selection is a JSON string:
`{"img": "data:image/…", "u": 0, "v": 0, "s": 100}` — the customer's image
as a data URL (downscaled client-side to ≤1024 px and re-encoded under the
zone's `maxBytes`, default 1.5 MB), its offset within the zone in
millimetres, and its size percent. That makes the payload for such orders
hundreds of KB to ~2 MB — fine for a POST body, too big for a URL or some
line-item-property limits. Persist the image server-side on order creation
(decode the data URL, store the file, keep `{u,v,s}` plus your file
reference as the order meta) rather than parking the raw data URL in a
platform field. Validate server-side like everything else: decode, check
the MIME/type sniff, re-clamp `u`/`v`/`s` against the zone.

## 3. Getting it onto the order, per platform

**WooCommerce (cleanest fit).** A complete drop-in plugin file lives in
[`docs/woocommerce.md`](./woocommerce.md). The mechanics: write the payload
into a hidden field inside the add-to-cart form, read it in
`woocommerce_add_cart_item_data`, verify the total against the endpoint
above, `set_price()` in `woocommerce_before_calculate_totals`, and persist
the choices in `woocommerce_checkout_create_order_line_item`. It is the only
one of the three where the configured product costs what it costs, on one
line, with no fee-product trick.

**Wix.** [`docs/wix.md`](./wix.md). Needs a Premium plan, Wix Stores and Dev
Mode; the embed is a sandboxed iframe that `postMessage`s up to Velo page
code, choices land in a pre-defined product text field, and surcharges use
the same $1 fee-product trick as Shopify.

**Shopify.** A complete copy-paste walkthrough lives in
[`docs/shopify.md`](./shopify.md) — start there. The mechanics, for
reference:
- *Configuration → order*: add the payload as **line item properties** on the
  AJAX `/cart/add.js` call (`properties: { Configuration: JSON.stringify(payload.selections), … }`).
  They show on the order for fulfilment. This part is easy and app-free.
- *Money*: Shopify does not let client JS invent a price. The three honest
  options, in increasing effort:
  1. **Variant mapping** — if the priced choices are few (stand yes/no,
     custom colour yes/no), create variants for the price combinations and
     have the embed's payload pick the variant id to add.
  2. **A "surcharge" product** — add a hidden $1 product to the cart with
     quantity = `deltaTotal`. Crude but common.
  3. **Draft Orders / a small app or Shopify Function** — the proper way for
     arbitrary deltas; a serverless endpoint receives the payload, re-prices
     it, and creates the checkout.

**Anything else** (custom backend, headless): POST the payload to your order
endpoint together with the cart line. It is deliberately plain JSON.

## 4. Trust: never bill the client's numbers

The payload's `deltaTotal` is computed in the customer's browser, so treat it
as a *quote*, not an invoice. Post the **selections** — never the prices — to
the service and charge what it returns:

```
POST https://api.your-studio.com/p/<publicationId>/price
Content-Type: application/json

{ "selections": { "body-colour": "#FF5733", "stand": "yes", "body-text": "MIA" } }
```

```json
{
  "publicationId": "pub_…", "version": 4, "currency": "SGD",
  "priceDeltas": [ { "optionId": "stand", "label": "Desk stand: Oak stand", "amount": 24 } ],
  "deltaTotal": 59,
  "selections": { "body-colour": "#FF5733", "stand": "yes", "body-text": "MIA" }
}
```

`publicationId` comes with every payload the embed emits, so you are always
pricing the exact frozen version the customer saw — not whatever is live by
the time the order lands.

This runs the same `priceDeltas` from `runtime/state.ts` that drew the
numbers on screen, against the same frozen manifest, so there is one pricing
function rather than a second implementation to drift. It needs no key: it
is arithmetic over a manifest anyone can already fetch, and it is meant to be
called from a merchant's server, which sends no Origin header. It ignores
any prices in the request and re-derives them, so the worst a tampered
request achieves is a different valid configuration at its correct price.
The echoed `selections` are what the service actually used — compare them
with what you sent if something looks odd.

If your backend happens to be Node you can skip the call and import
`priceDeltas` directly; everyone else (WooCommerce's PHP, a Velo backend)
uses the endpoint.

## 5. Order of work when wiring a store

1. Publish from the Studio → `manifest.json` + `model.glb`.
2. Host them + the embed bundle; drop the snippet on the product page.
3. Listen for `configurator:change`; stash the latest payload.
4. On add-to-cart, attach `selections` (+ human-readable `colourNames`) as
   item properties/meta, and apply `priceDeltas` via the platform's pricing
   mechanism above.
5. Server-side, recompute the deltas from the manifest before charging.
