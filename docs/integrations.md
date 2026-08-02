# Putting the configurator on a real store

The embed is a plain script + one `<div>` — it has no framework and no
server, so it drops into anything that lets you add HTML. What varies per
platform is only **how the customer's configuration and its surcharges reach
the order**. This document covers both halves.

## 1. Embedding

Host the two published files (`manifest.json`, `model.glb`) anywhere — your
own domain, the platform's file storage, or a CDN — plus the embed bundle
(`embed.js`, `embed.css`). Then, on the product page:

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
  "selections": { "body-colour": "jade-white", "tile-style": "mail", "stand": "oak" },
  "colourNames": { "body-colour": "Jade White" },
  "priceDeltas": [
    { "optionId": "stand", "label": "Desk stand: Oak stand", "amount": 24 },
    { "optionId": "body-colour", "label": "Custom colour #FF5733 (Body)", "amount": 35 }
  ],
  "deltaTotal": 59,
  "currency": "SGD"
}
```

So yes — it is the same manifest method end to end: the manifest defines the
options and the deltas, the embed computes them, and the payload hands the
itemised result to whatever cart is listening. The configurator itself never
states a total price; the base price stays the store's.

## 3. Getting it onto the order, per platform

**WooCommerce (cleanest fit).** Listen for the event, write the payload into
a hidden field inside the add-to-cart form, then on the server read it in
`woocommerce_add_cart_item_data` and add the surcharge with
`WC()->cart->add_fee()` (or per-item price adjustment) in
`woocommerce_before_calculate_totals`. The selections become order item meta
your production team sees on every order.

**Shopify.** Two mechanisms:
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
as a *quote*, not an invoice. The pricing logic (`priceDeltas` in
`runtime/state.ts`) is pure and dependency-free — run the same function
server-side (Node) against the same published manifest and the submitted
`selections`, and charge THAT result. If the recomputed total disagrees with
the submitted one, someone edited the request. One manifest, one pricing
function, verified twice.

## 5. Order of work when wiring a store

1. Publish from the Studio → `manifest.json` + `model.glb`.
2. Host them + the embed bundle; drop the snippet on the product page.
3. Listen for `configurator:change`; stash the latest payload.
4. On add-to-cart, attach `selections` (+ human-readable `colourNames`) as
   item properties/meta, and apply `priceDeltas` via the platform's pricing
   mechanism above.
5. Server-side, recompute the deltas from the manifest before charging.
