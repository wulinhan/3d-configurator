# Wix, step by step

Wix is the most restrictive of the three platforms, so read this page first
and decide whether it is worth it before you start clicking.

**What Wix requires before anything here works:**

- a **Premium plan** (a free Wix site cannot take orders at all),
- the **Wix Stores** app added to the site,
- **Dev Mode** turned on, which is Wix's name for Velo, their code panel.

Without Dev Mode you can still *show* the configurator — Step 2 alone works
— but nothing the customer chooses can reach the order. There is no
no-code path on Wix; the platform simply does not expose the cart to
page-level HTML.

**How the money works.** Like Shopify, Wix does not let page code set a
line's price. Surcharges enter the cart as a hidden **$1 "Customisation"
product** added with quantity = the surcharge total, so $30 of options
becomes "Customisation × 30". Price your options in whole units in the
Studio.

**How the choices reach the order.** Unlike Shopify — where you can attach
any property you like — Wix only accepts text into fields you have
**defined on the product in advance**, and the field name in code must match
the one in the dashboard exactly. So instead of a JSON blob, we write a
short human-readable summary into one text box.

Time: about 30 minutes.

---

## Step 1 — Turn on Dev Mode

In the Wix editor, top bar → **Dev Mode** → **Turn on Dev Mode**. A code
panel appears at the bottom of the editor and a `Page Code` tab appears for
the page you are on. Nothing else changes about your site.

## Step 2 — Put the configurator on the product page

1. Open your **Product Page** in the editor.
2. **Add (+) → Embed Code → Embed HTML**. Place and size the box where the
   configurator should sit — give it real height, at least 400 px.
3. Click **Enter Code** and paste the snippet from your Studio's Publish
   window, wrapped so it can talk to the page:

```html
<link rel="stylesheet" href="https://api.your-studio.com/embed.css">
<div data-configurator="https://api.your-studio.com/e/YOUR-PRODUCT-ID/manifest.json"></div>
<script type="module" src="https://api.your-studio.com/embed.js"></script>
<script>
  // Hand every change up to the Wix page code (Step 5).
  document.addEventListener('configurator:change', function (e) {
    window.parent.postMessage(e.detail, '*');
  });
</script>
```

4. **Publish** the site. The Embed HTML box does not run in the editor
   preview — you have to look at the live site.

### The address wrinkle, which will bite you otherwise

A Wix HTML embed is a **sandboxed iframe served from a Wix address**, not
from your domain. So the "Where it may be embedded" list in the Studio's
Publish window never sees `www.your-shop.com` — it sees something like
`https://www-your--shop-com.filesusr.com`.

Two options, and the first is fine:

- **Leave the allowlist empty** (the default). The configurator then answers
  anywhere, which for a Wix site is the practical choice.
- **Find the real address and allowlist that.** Open your live product page,
  press F12 → **Console**. If the address is being refused you will see our
  service say so in plain words. Otherwise look in **Network**, click the
  `manifest.json` request, and read the `Origin` request header. Paste that
  value into the Studio and save.

## Step 3 — Create the hidden "Customisation" product

1. Wix dashboard → **Store Products** → **New Product**.
2. Name it `Customisation`, price **1.00**.
3. Turn OFF **Track Inventory** so it can never sell out.
4. Save, then open it again and copy the **product ID** from the browser
   address bar — the long `xxxxxxxx-xxxx-...` value in the URL. Step 5 needs
   it.
5. Keep it out of the way: do not add it to any category shown in your menus.

## Step 4 — Add a text box to your real product

This is the field the choices land in, and it must exist before code can
write to it.

1. Dashboard → **Store Products** → open the product being configured.
2. Scroll to **Modifiers** → **Add Modifier** → type **Text Box**.
3. Name it exactly `Configuration`.
4. Set **Limit characters** to the maximum Wix allows, and untick
   "required" if that option is offered — the customer never types in it,
   your code fills it.

Repeat for every product that gets a configurator.

## Step 5 — The page code

In the editor, with the Product Page open, paste this into **Page Code**.
Change the two marked constants.

```js
import wixStores from 'wix-stores';

// ─── the two lines to change ──────────────────────────────────────────────
const FEE_PRODUCT_ID = 'PASTE-THE-CUSTOMISATION-PRODUCT-ID';   // Step 3
const TEXT_FIELD = 'Configuration';                            // Step 4, exact match
// ──────────────────────────────────────────────────────────────────────────

let latest = null;

$w.onReady(function () {
  // Whatever the HTML embed posts up arrives here.
  $w('#html1').onMessage((event) => {
    if (event.data && event.data.type === 'configurator:change') latest = event.data;
  });

  $w('#addToCartButton').onClick(async () => {
    if (!latest) return;                    // configurator untouched
    const product = await $w('#productPage1').getProduct();

    const items = [{
      productId: product._id,
      quantity: 1,
      customTextFields: [{ title: TEXT_FIELD, value: summarise(latest) }],
    }];

    const fee = Math.round(latest.deltaTotal);
    if (fee > 0) items.push({ productId: FEE_PRODUCT_ID, quantity: fee });

    await wixStores.cart.addProducts(items);
  });
});

/** One readable line per decision — this is what your workshop reads. */
function summarise(payload) {
  const parts = [];
  Object.keys(payload.colourNames).forEach((k) => parts.push(label(k) + ': ' + payload.colourNames[k]));
  Object.keys(payload.selections).forEach((k) => {
    const v = payload.selections[k];
    if (!v || payload.colourNames[k] || v.charAt(0) === '{') return;
    parts.push(label(k) + ': ' + v);
  });
  if (payload.uploads) {
    Object.keys(payload.uploads).forEach((k) => parts.push('Artwork: ' + payload.uploads[k].url));
  }
  if (payload.publicationId) parts.push('Ref: ' + payload.publicationId);
  return parts.join(' | ');
}

function label(id) {
  const s = id.replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
```

**Three names in that code are yours to check**, because Wix generates
element IDs per site. Click each element in the editor and read its ID from
the Properties panel:

| In the code | What it is |
| --- | --- |
| `#html1` | the Embed HTML box from Step 2 |
| `#productPage1` | the product page element |
| `#addToCartButton` | the Add to Cart button |

> **The one line to verify.** Wix has renamed its cart API more than once,
> and `customTextFields` has appeared as both `{title, value}` and
> `{title, text}` depending on which module and which vintage you are on.
> Run Step 6 once: if the choices do not appear on the cart line, swap
> `value:` for `text:` and try again. Wix's own current reference for this
> exact pattern is their [Adding a Product Configurator to a Wix Stores
> Site](https://dev.wix.com/docs/develop-websites/articles/code-tutorials/wix-e-commerce-stores/adding-a-product-configurator-to-a-wix-stores-site)
> tutorial — check the cart call there against the version your site runs.

## Step 6 — Try it as a customer

1. **Publish** the site and open the live product page (not the preview).
2. Configure something with a surcharge, then **Add to Cart**.
3. The cart should show your product with the `Configuration` line beneath
   it, plus `Customisation × N`.
4. Place a test order and open it in **Dashboard → Orders**: the summary
   travels with the line item, and any artwork is a link you can open.

If the cart line is bare, see the verification note above — that is the
symptom of the field-name mismatch.

---

## Questions you may have

**Can I avoid the "$1 × 30" line?**
Not with page code alone. Wix's proper mechanism is a **Catalog Service
Plugin**, a backend extension that lets you price line items yourself. It is
a real development project rather than a paste — worth it if Wix becomes a
significant channel, overkill for one store.

**The configurator does not appear at all.**
Embed HTML boxes do not render in the editor or in preview. Publish and look
at the live site. If it is still blank there, open the console — a refused
address (see Step 2) says so explicitly.

**Can I use a Custom Element instead of Embed HTML?**
Yes, and it is technically better — a custom element runs in your page's own
origin, so there is no iframe, no `filesusr` address, and no `postMessage`
hop. It needs a small wrapper script that registers the element, which we
have not packaged yet. Ask if you want it.

**Why is the reference code in the summary?**
`Ref:` is the frozen publication the customer actually configured against.
If you republish the product tomorrow, that reference still identifies
exactly what they bought.

**Can a customer remove the fee from their cart?**
Yes — the cart is theirs, on every platform that uses this trick. The
summary still shows what they configured, so a mismatch is visible on the
order. Spot-check personalised orders before making them.

**Is Wix worse than the others?**
For this job, yes. WooCommerce sets the real line price and needs one file;
Shopify needs three pasted things and no code review; Wix needs a paid plan,
Dev Mode, a per-product field, and still shows a fee line. If you are
choosing a platform for a configurator business, that is the order.
