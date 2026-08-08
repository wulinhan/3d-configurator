# Custom site — what the developer does

For a bespoke storefront (React, Rails, Laravel, headless, anything) there is
no plugin and no platform to work around. This is the shortest integration of
the four, and the only one where nothing is a workaround.

Four things:

1. put the configurator on the page,
2. keep the last payload it emits,
3. send that payload's `selections` with the cart line,
4. **on the server**, re-price it before charging.

Steps 1–3 are front-end and take an afternoon. Step 4 is one HTTP call and is
the only part that is not optional.

---

## 1. Mount it

Two files, both from the address in the Studio's Publish window:

```html
<link rel="stylesheet" href="https://api.your-studio.com/embed.css">
<div data-configurator="https://api.your-studio.com/e/prj_XXXX/manifest.json"></div>
<script type="module" src="https://api.your-studio.com/embed.js"></script>
```

It is an ES module — `type="module"` is required. `embed.js` fetches its lazy
chunks (typeface data, the engraving engine, the mesh decoder) **relative to
its own URL**, so keep `embed-*.js` beside it if you self-host the bundle.

Auto-mount claims the **first** `[data-configurator]` element on the page. For
more than one, or to control when it appears (a modal, a route transition, a
framework lifecycle), import instead:

```js
import { mount } from 'https://api.your-studio.com/embed.js';

const manifestUrl = 'https://api.your-studio.com/e/prj_XXXX/manifest.json';
const cfg = await mount({
  root: document.getElementById('configurator'),   // a real element, already in the DOM
  manifest: await (await fetch(manifestUrl)).json(),
  baseUrl: manifestUrl,        // relative URLs in the manifest resolve against this
});
```

`mount()` resolves to `{ viewer, selections, manifest, post }`:

- `post()` — re-emits the payload on demand
- `viewer` — the three.js wrapper, if you want `snapshot()` or camera control
- `manifest` — the published manifest, already validated
- `selections` — the live **raw** selection state, mutated in place

> **Read the payload, not `selections`.** The handle's object is the raw state,
> which is not the same thing as the payload's `selections`: the payload's are
> *resolved*. A colour that starts linked to another option reads as
> `"@body-colour"` raw and as the actual swatch once resolved, and a
> customer-chosen text colour only appears in the resolved set. Order records
> built from the raw object will be subtly wrong for exactly the products
> whose options are linked. Use the payload from §2 for anything you store.

In a framework, mount in the effect that runs after the node exists, and drop
the returned object on unmount. Don't re-mount on every render.

**Allowlist your origin.** In the Studio's Publish window, under *Where it may
be embedded*, add every origin the page is served from — production, staging,
and `http://localhost:5173` or whatever you develop on. An empty list means
"anywhere", which is fine early on. Get this wrong and the manifest request
returns 403 with a message saying exactly that.

## 2. Listen

The embed reports the same payload two ways. Use whichever suits you:

```js
// Same page — a DOM CustomEvent that bubbles from the root element.
document.addEventListener('configurator:change', (e) => { latest = e.detail; });

// In an iframe — postMessage to the parent frame.
window.addEventListener('message', (e) => {
  if (e.origin !== 'https://your-configurator-host.com') return;   // check it
  if (e.data?.type === 'configurator:change') latest = e.data;
});
```

**A payload is emitted immediately on mount**, before the customer touches
anything, so `latest` is populated with the default configuration from the
start — you never have to handle "they added to cart without interacting".

If you are storing state in a framework, note that `configurator:change` fires
on every keystroke in a text slot. Debounce before writing it anywhere
expensive; the payload itself is cheap to hold.

## 3. What you get

```json
{
  "type": "configurator:change",
  "productId": "tap-bar-3",
  "publicationId": "pub_8fK2…",
  "manifestVersion": "0.1.0",
  "selections": { "body-colour": "jade-white", "stand": "yes", "body-text": "MIA" },
  "colourNames": { "body-colour": "Jade White" },
  "priceDeltas": [
    { "optionId": "stand", "label": "Desk stand: Oak stand", "amount": 24 },
    { "optionId": "body-text", "label": "Body text: “MIA”", "amount": 6 }
  ],
  "deltaTotal": 30,
  "currency": "SGD",
  "uploads": { "body-image": { "id": "upl_…", "url": "https://api.your-studio.com/u/upl_…" } }
}
```

What each is for:

| Field | Use it for |
| --- | --- |
| `selections` | **the order record.** Everything else is derived from it |
| `publicationId` | the frozen version they configured — store it on the order |
| `colourNames` | human-readable colours for the pick list ("Jade White", not `#F2EFE6`) |
| `priceDeltas` | showing an itemised breakdown in your cart |
| `deltaTotal` | showing a live total. **A quote, never an invoice** — see §4 |
| `uploads` | customer artwork, as a URL your workshop can download |

`selections` values are strings. Colour options carry a swatch id or a `#hex`;
choices carry a choice id; text slots carry the typed string; image zones carry
a small JSON string (`{"img":…,"u":0,"v":0,"s":100,"up":"upl_…"}`) — position
and zoom within the zone, plus the upload id. You do not need to parse that
last one: `uploads` gives you the same picture as a plain URL.

**Store `publicationId` and `selections` on the order.** With those two you can
re-render exactly what someone bought, months later, by mounting
`/p/<publicationId>/manifest.json` — the frozen version, unaffected by anything
published since.

## 4. Re-price on the server

`deltaTotal` was computed in the customer's browser, and the customer owns
their browser. Before you charge, post the **selections** — never the prices —
and use what comes back:

```js
const res = await fetch(
  `https://api.your-studio.com/p/${order.publicationId}/price`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selections: order.selections }),
  },
);
if (!res.ok) throw new Error('could not price this configuration');
const { deltaTotal, priceDeltas, currency } = await res.json();

const total = basePrice + deltaTotal;   // charge THIS
```

No API key: it is arithmetic over a manifest anyone can already fetch. No
`Origin` needed — it is built to be called from a server. It runs the same
pricing function that drew the numbers on screen, against the same frozen
manifest, so there is one implementation rather than two that drift.

Prices in the request body are ignored and re-derived, so the worst a tampered
request achieves is a different valid configuration at its correct price. The
response echoes the `selections` it actually used — compare them with what you
sent if a total ever looks wrong.

If your backend is Node you can skip the call and
`import { priceDeltas } from '@allin/embed/runtime/state'` directly against the
manifest JSON. Same function, one less round trip.

**Fail closed.** If the call errors, refuse the order rather than charging the
browser's number. A retry is cheaper than a mispriced personalised product you
have already made.

## 5. Customer artwork

If the manifest came from the service (a `/e/…` or `/p/…` URL), image zones
upload themselves: the picture goes to the service on selection and the payload
carries an id and a URL. Nothing for you to build — just save
`uploads[optionId].url` on the order.

If you self-host `manifest.json` and `model.glb` with no service behind them,
there is nowhere to put the image, so the selection carries the picture inline
as a data URL — hundreds of KB to ~2 MB. That survives a POST body but not a
URL or most line-item fields. Decode it server-side on order creation, store
the file yourself, and keep your file reference plus the `{u,v,s}` values.
Validate it like any upload: sniff the real type, re-clamp the numbers.

## 6. Checklist

- [ ] `embed.css` and `embed.js` (as a module) on the page, chunks beside them
- [ ] every origin allowlisted, including staging and localhost
- [ ] `configurator:change` captured into your cart/session state
- [ ] `publicationId` + `selections` saved on the order
- [ ] `colourNames` and artwork URLs on whatever your workshop reads
- [ ] server re-prices via `/p/<id>/price` before charging, and fails closed
- [ ] a test order end to end, then open `/p/<publicationId>/manifest.json` and
      confirm it renders what was bought

## Notes

**Content Security Policy.** The viewer draws to a canvas and uses object URLs;
artwork may arrive as `data:`. If you run a strict CSP you will need to allow
the service and CDN origins for scripts, styles and `connect-src`, plus
`blob:`/`data:` for images. Start permissive, tighten with the console open —
the failures are explicit.

**Server-side rendering.** The embed is browser-only: it needs a canvas and
WebGL. Mount it client-side, after hydration.

**One page, several products.** Use `mount()` per element rather than
auto-mount, and keep a payload per configurator — the DOM event bubbles, so
read `e.target` (or scope the listener to each root) to know which one changed.
