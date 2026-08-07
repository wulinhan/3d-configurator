# Shopify, step by step

This guide takes a published product from the Studio and puts it on a
Shopify product page — configurator on the page, the customer's choices on
the order, and the surcharges in the cart total. Every step is copy-paste;
nothing needs an app, a developer account, or a theme rebuild.

Time: about 20 minutes. You will need: your Studio's **Publish** window open
in one tab, and your Shopify admin in another.

> How the money works, in one paragraph: Shopify never lets a script on the
> page invent a price — which is right, because a script on the page is
> editable by the customer. So the configurator's surcharges enter the cart
> as a hidden **"Customisation" product priced at $1**, added with quantity
> = the surcharge total. A $24 stand and $6 engraving become "Customisation
> × 30". The customer sees one clean fee line; you see the itemised breakdown
> on the order. Because of this trick, **price your options in whole dollars
> in the Studio** — $5, not $4.50. (Cents are possible — the note at the end
> shows how — but whole dollars keep the cart tidy.)

---

## Step 1 — Tell the configurator your shop's address

The Studio's Publish window has a section called **Where it may be
embedded**. A published product only answers to addresses on that list, so
add both of your shop's addresses — the `.myshopify.com` one and your real
domain:

```
https://your-store.myshopify.com
https://www.your-store.com
```

Press **Save addresses**. (Leave the list empty and the product answers
anywhere, which is fine for testing but not what you want live.)

## Step 2 — Put the configurator on the product page

1. In Shopify admin: **Online Store → Themes → Customize**.
2. Top-centre dropdown → **Products → Default product**.
3. In the left sidebar, inside the *Product information* section, click
   **⊕ Add block → Custom Liquid**.
4. Paste the **embed snippet** from the Studio's Publish window. It looks
   like this (yours has your real addresses in it):

```html
<link rel="stylesheet" href="https://api.your-studio.com/embed.css">
<div data-configurator="https://api.your-studio.com/e/YOUR-PRODUCT-ID/manifest.json"></div>
<script type="module" src="https://api.your-studio.com/embed.js"></script>
```

5. Drag the block where you want the configurator to sit, and **Save**.

Open the product page: the configurator should load and spin. (If the
viewer stays empty, the address from Step 1 doesn't match the page you're
on — check for `www.` vs no-`www.`.)

If only some products are configurators, make a second product template
(**Products → ⊕ Create template**) with the block, and assign it to those
products on each product's admin page.

## Step 3 — Create the hidden "Customisation" fee product

1. **Products → Add product**.
2. Title: `Customisation`. Price: **1.00**. Untick **Charge tax** if your
   surcharges shouldn't be taxed differently from the product.
3. Untick **Track quantity** (Inventory section) — it must never sell out.
4. On the right, under **Publishing**, leave only *Online Store* ticked.
5. **Save.**
6. Still on that product page, look at your browser's address bar and open
   the variant: click the product's default variant, or simply add
   `.json` to the product URL — easier: click **More actions → View** is NOT
   needed. The simplest reliable way:

   Visit `https://your-store.myshopify.com/products/customisation.js` in a
   browser tab. You'll see a wall of text; near the start is
   `"variants":[{"id":` followed by a long number, like `44561234567890`.
   **Copy that number** — it's the fee variant id, and Step 4 needs it.

7. Keep it out of sight: **Online Store → Navigation → remove it from any
   menus/collections** it landed in, and in the theme's search settings it
   won't matter — customers can only reach it by URL, and even then it just
   says "Customisation, $1".

## Step 4 — Paste the bridge script

This is the one piece of code. It watches the configurator, and when the
customer clicks **Add to cart** it (a) writes their choices onto the order
line as properties your team will read, and (b) adds the fee product with
the right quantity.

In the same theme editor as Step 2, add a **second Custom Liquid block**
(or paste below the snippet in the same block), with ALL of the following —
then replace the one number on the first line with your variant id from
Step 3:

```html
<script>
(function () {
  var FEE_VARIANT_ID = 44561234567890; // ← replace with YOUR number from Step 3
  var latest = null;

  // The configurator announces every change on the page.
  document.addEventListener('configurator:change', function (e) {
    latest = e.detail;
  });

  // Catch the add-to-cart before the theme does.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.action || form.action.indexOf('/cart/add') === -1) return;
    if (!latest) return; // configurator untouched (or not on this page) — let Shopify be Shopify

    e.preventDefault();
    e.stopPropagation();

    // Human-readable properties — these appear on the cart, the checkout,
    // the order confirmation, and the packing slip.
    var props = {};
    Object.keys(latest.colourNames).forEach(function (k) {
      props[label(k)] = latest.colourNames[k];
    });
    Object.keys(latest.selections).forEach(function (k) {
      var v = latest.selections[k];
      if (!v || latest.colourNames[k] || v.charAt(0) === '{') return;
      props[label(k)] = v;
    });
    latest.priceDeltas.forEach(function (d) {
      props[d.label] = latest.currency + ' ' + d.amount;
    });
    if (latest.uploads) {
      Object.keys(latest.uploads).forEach(function (k) {
        props['Artwork (' + label(k) + ')'] = latest.uploads[k].url;
      });
    }
    // The full record, hidden from the customer (the underscore does that)
    // but visible to you on the order — this is what production builds from.
    props['_configuration'] = JSON.stringify(latest.selections);

    var qty = parseInt((form.querySelector('[name="quantity"]') || {}).value, 10) || 1;
    var items = [{
      id: parseInt(form.querySelector('[name="id"]').value, 10),
      quantity: qty,
      properties: props
    }];
    var fee = Math.round(latest.deltaTotal) * qty;
    if (fee > 0 && FEE_VARIANT_ID) {
      items.push({
        id: FEE_VARIANT_ID,
        quantity: fee,
        properties: { 'For': document.title.split('–')[0].trim() }
      });
    }

    fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items })
    }).then(function (r) {
      if (!r.ok) throw new Error('cart');
      window.location.href = '/cart';
    }).catch(function () {
      alert('Could not add to cart — please try again.');
    });
  }, true);

  // "body-text" → "Body text": ids are readable enough to become labels.
  function label(id) {
    var s = id.replace(/-/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
})();
</script>
```

**Save**, and that's the wiring done.

## Step 5 — Try it as a customer

1. Open the product page, change a colour, type some text, add a paid
   option.
2. **Add to cart.** The cart should show your product with the choices
   listed under it, plus one `Customisation` line whose quantity equals the
   surcharge total.
3. Place a test order (Shopify admin → **Settings → Payments → test mode**,
   or just use a 100% discount code).
4. Open the order in admin: every choice is on the line item, the
   `_configuration` property holds the exact record, and any uploaded
   artwork is a link you can click and download at full resolution.

That order line is what your workshop prints from. Nothing else to install.

---

## Questions you may have

**The customer can see "Customisation $1 × 30". Is that okay?**
Yes — and it's honest: their receipt shows exactly what the personalisation
cost. If you'd rather it read differently, rename the fee product ("Made to
order", "Personalisation").

**What if my surcharges have cents?**
Price the fee product at **0.01** and change one line in the script:
`var fee = Math.round(latest.deltaTotal * 100) * qty;`. The cart will show
"Customisation × 3050" for $30.50 — uglier, which is why whole dollars are
the default advice.

**Can a clever customer edit the fee out?**
They can try — the cart is theirs. The order still carries the full
`_configuration` record, so a mismatch is visible: the choices say "oak
stand, engraved" and the fee line says zero. Spot-check personalised orders
before making them, and cancel the ones that don't add up. When volume makes
hand-checking silly, that's the moment for the server-side route: a small
endpoint reprices the payload against the published manifest and builds the
checkout itself — see "Trust" in `docs/integrations.md`, and ask us; it's a
day of work, not a rewrite.

**Do bundles/quantity work?**
Yes — the script multiplies the fee by the quantity in the form, and the
properties ride on every unit of that line.

**Something doesn't add to cart.**
Open the browser console (F12). `cart` errors from `/cart/add.js` are
almost always the fee product: its variant id is wrong, it's not published
to *Online Store*, or inventory tracking is still on and it's "sold out".

**I changed prices in the Studio — do I need to touch Shopify?**
Only republish. The embed always loads the live manifest, so the new
surcharges apply to the next add-to-cart. The fee product never changes;
it's a $1 counter.
