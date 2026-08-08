# WooCommerce, step by step

WooCommerce is the easiest of the three platforms to wire up properly,
because PHP is allowed to set a line item's price. There is no fee-product
trick here: a configured product costs what it costs, on one clean line.

**The whole integration is one file.** You paste it into
`wp-content/mu-plugins/`, change two lines at the top, and you are done —
the configurator appears on the product page, the customer's choices ride
onto the order, and the surcharges are added to the price after being
**re-checked by the service** so the browser's numbers are never the ones
you bill.

Time: about 15 minutes. You need FTP/SFTP or the file manager in your host's
control panel, and your Studio's Publish window open in another tab.

---

## Step 1 — Tell the configurator your shop's address

In the Studio's Publish window, under **Where it may be embedded**, add your
shop's address and press **Save addresses**:

```
https://www.your-shop.com
```

Add the `www.`-less version too if your site answers on both. (An empty list
means "anywhere", which is fine while you are testing.)

While you are there, copy two things from the Publish window — you need them
in Step 2:

- the **manifest URL**, which looks like
  `https://api.your-studio.com/e/prj_XXXX/manifest.json`
- the **base address** of the embed files, the part before `/embed.js` in
  the snippet

## Step 2 — Create the plugin file

Make a file called `allin-configurator.php` with the contents below, then
upload it to `wp-content/mu-plugins/` (create that folder if it does not
exist). Files in `mu-plugins` load automatically — there is nothing to
activate, and a theme update cannot remove it.

Change only the two marked lines: `ALLIN_BASE` (your service's address) and
the `ALLIN_PRODUCTS` map, which says **which WooCommerce product gets which
configurator**. The number on the left is the WooCommerce product ID — you
can see it in the URL when you edit a product in WordPress
(`post=123&action=edit` → the ID is `123`).

```php
<?php
/**
 * Plugin Name: Allin Configurator for WooCommerce
 * Description: 3D product configurator with verified per-configuration pricing.
 */

if ( ! defined( 'ABSPATH' ) ) { exit; }

// ─── the two lines to change ──────────────────────────────────────────────
define( 'ALLIN_BASE', 'https://api.your-studio.com' );   // your service
$GLOBALS['ALLIN_PRODUCTS'] = array(
	123 => 'prj_XXXXXXXXXXXX',   // WooCommerce product ID => Studio project id
	// 456 => 'prj_YYYYYYYYYYYY',
);
// ──────────────────────────────────────────────────────────────────────────

/** Refuse to add to cart if the price cannot be verified. Set to false only
 * if you would rather take the order and check it by hand later. */
define( 'ALLIN_REQUIRE_VERIFY', true );

function allin_project_for( $product_id ) {
	$map = isset( $GLOBALS['ALLIN_PRODUCTS'] ) ? $GLOBALS['ALLIN_PRODUCTS'] : array();
	return isset( $map[ $product_id ] ) ? $map[ $product_id ] : null;
}

/**
 * The configurator itself, printed INSIDE the add-to-cart form.
 *
 * Inside matters: the hidden field has to be part of the form for its value
 * to arrive with the POST. A Custom HTML block placed in the page editor
 * usually lands outside the form, which is why this is a hook and not a
 * block.
 */
add_action( 'woocommerce_before_add_to_cart_button', function () {
	global $product;
	$project = allin_project_for( $product->get_id() );
	if ( ! $project ) { return; }

	$manifest = ALLIN_BASE . '/e/' . $project . '/manifest.json';
	?>
	<link rel="stylesheet" href="<?php echo esc_url( ALLIN_BASE ); ?>/embed.css">
	<div data-configurator="<?php echo esc_url( $manifest ); ?>"></div>
	<script type="module" src="<?php echo esc_url( ALLIN_BASE ); ?>/embed.js"></script>
	<input type="hidden" name="allin_configuration" value="">
	<script>
	(function () {
		var field = document.currentScript.previousElementSibling;
		document.addEventListener('configurator:change', function (e) {
			field.value = JSON.stringify(e.detail);
		});
	})();
	</script>
	<?php
} );

/**
 * Ask the service what this configuration actually costs.
 *
 * The payload the browser sends carries a deltaTotal, but it was computed in
 * the customer's browser and the customer owns that browser. This posts the
 * SELECTIONS — never the prices — to the frozen publication the customer was
 * looking at, and the service re-runs the same pricing function that drew
 * the numbers on screen. What comes back is what we charge.
 */
function allin_verify( $payload ) {
	if ( empty( $payload['publicationId'] ) ) { return null; }

	$response = wp_remote_post(
		ALLIN_BASE . '/p/' . rawurlencode( $payload['publicationId'] ) . '/price',
		array(
			'timeout' => 10,
			'headers' => array( 'Content-Type' => 'application/json' ),
			'body'    => wp_json_encode( array( 'selections' => $payload['selections'] ) ),
		)
	);
	if ( is_wp_error( $response ) || 200 !== wp_remote_retrieve_response_code( $response ) ) {
		return null;
	}
	$body = json_decode( wp_remote_retrieve_body( $response ), true );
	return isset( $body['deltaTotal'] ) ? $body : null;
}

/** Attach the configuration to the cart line. */
add_filter( 'woocommerce_add_cart_item_data', function ( $data, $product_id ) {
	if ( ! allin_project_for( $product_id ) || empty( $_POST['allin_configuration'] ) ) {
		return $data;
	}
	$payload = json_decode( wp_unslash( $_POST['allin_configuration'] ), true );
	if ( ! is_array( $payload ) || empty( $payload['selections'] ) ) { return $data; }

	$verified = allin_verify( $payload );
	if ( null === $verified ) {
		if ( ALLIN_REQUIRE_VERIFY ) {
			throw new Exception( __( 'Sorry — we could not confirm the price of that configuration. Please try again.', 'allin' ) );
		}
		$verified = array(
			'deltaTotal'  => 0,
			'priceDeltas' => array(),
			'selections'  => $payload['selections'],
		);
	}

	$product = wc_get_product( $product_id );
	$data['allin'] = array(
		'publication' => isset( $payload['publicationId'] ) ? $payload['publicationId'] : '',
		'base'        => (float) $product->get_price(),
		'delta'       => (float) $verified['deltaTotal'],
		'deltas'      => $verified['priceDeltas'],
		'selections'  => $verified['selections'],
		'colours'     => isset( $payload['colourNames'] ) ? $payload['colourNames'] : array(),
		'uploads'     => isset( $payload['uploads'] ) ? $payload['uploads'] : array(),
	);
	// Two different configurations of one product are two cart lines, not one
	// line of quantity two — otherwise the second customisation overwrites
	// the first and someone receives the wrong thing.
	$data['allin_key'] = md5( wp_json_encode( $data['allin'] ) );
	return $data;
}, 10, 2 );

/**
 * Apply the surcharge.
 *
 * Priced from the STORED base rather than from the line's current price:
 * this hook runs more than once per request, and `get_price() + delta` would
 * add the surcharge again on every pass.
 */
add_action( 'woocommerce_before_calculate_totals', function ( $cart ) {
	if ( is_admin() && ! defined( 'DOING_AJAX' ) ) { return; }
	if ( did_action( 'woocommerce_before_calculate_totals' ) >= 2 ) { return; }

	foreach ( $cart->get_cart() as $item ) {
		if ( empty( $item['allin'] ) ) { continue; }
		$item['data']->set_price( $item['allin']['base'] + $item['allin']['delta'] );
	}
} );

/** Show the choices under the line in the cart and at checkout. */
add_filter( 'woocommerce_get_item_data', function ( $item_data, $cart_item ) {
	if ( empty( $cart_item['allin'] ) ) { return $item_data; }
	$allin = $cart_item['allin'];

	foreach ( $allin['colours'] as $option_id => $name ) {
		$item_data[] = array( 'key' => allin_label( $option_id ), 'value' => $name );
	}
	foreach ( $allin['selections'] as $option_id => $value ) {
		if ( '' === $value || isset( $allin['colours'][ $option_id ] ) ) { continue; }
		if ( '{' === substr( $value, 0, 1 ) ) { continue; }   // an uploaded image, shown below
		$item_data[] = array( 'key' => allin_label( $option_id ), 'value' => $value );
	}
	foreach ( $allin['deltas'] as $delta ) {
		$item_data[] = array( 'key' => $delta['label'], 'value' => wc_price( $delta['amount'] ) );
	}
	foreach ( $allin['uploads'] as $option_id => $upload ) {
		$item_data[] = array(
			'key'   => allin_label( $option_id ),
			'value' => '<a href="' . esc_url( $upload['url'] ) . '" target="_blank">' . __( 'view artwork', 'allin' ) . '</a>',
		);
	}
	return $item_data;
}, 10, 2 );

/** Persist it onto the order, which is what the workshop reads. */
add_action( 'woocommerce_checkout_create_order_line_item', function ( $item, $key, $values ) {
	if ( empty( $values['allin'] ) ) { return; }
	$allin = $values['allin'];

	foreach ( $allin['colours'] as $option_id => $name ) {
		$item->add_meta_data( allin_label( $option_id ), $name );
	}
	foreach ( $allin['selections'] as $option_id => $value ) {
		if ( '' === $value || isset( $allin['colours'][ $option_id ] ) ) { continue; }
		if ( '{' === substr( $value, 0, 1 ) ) { continue; }
		$item->add_meta_data( allin_label( $option_id ), $value );
	}
	foreach ( $allin['uploads'] as $option_id => $upload ) {
		$item->add_meta_data( allin_label( $option_id ) . ' (artwork)', $upload['url'] );
	}
	// Underscore-prefixed meta is hidden from the customer but kept on the
	// order: the exact record, and the frozen version it was priced against.
	$item->add_meta_data( '_allin_publication', $allin['publication'] );
	$item->add_meta_data( '_allin_configuration', wp_json_encode( $allin['selections'] ) );
}, 10, 3 );

/** "body-text" → "Body text". Option ids are readable enough to be labels. */
function allin_label( $option_id ) {
	return ucfirst( str_replace( '-', ' ', $option_id ) );
}
```

## Step 3 — Try it as a customer

1. Open the product page. The configurator should appear just above the
   **Add to cart** button.
2. Change a colour, type some engraving, tick a paid option.
3. **Add to cart.** The cart line should list every choice, each surcharge
   as its own line, and the **price should already include them**.
4. Place a test order and open it in **WooCommerce → Orders**: the choices
   are order item meta, uploaded artwork is a link you can download at full
   resolution, and `_allin_publication` records exactly which published
   version was priced.

That order line is what your workshop prints from.

---

## Questions you may have

**Do I need a plugin from the WordPress directory?**
No. This is your own site's code, in your own `mu-plugins` folder. Nothing
is submitted anywhere and nothing is reviewed. (Publishing it *to* the
WordPress plugin directory would involve review — but that is only if you
wanted to distribute it to other people's shops.)

**Where does the price actually come from?**
The product's normal WooCommerce price, plus the surcharges the service
confirms. Your base price, tax rules, coupons, shipping and currency all
keep working exactly as they do now — the only thing this changes is the
line's unit price.

**Can a customer fake a cheaper price?**
Not through the browser. The hidden field carries option *ids*, not money;
PHP throws away any prices in it and asks the service what those options
cost against the frozen manifest the customer was actually looking at. The
worst a tampered field achieves is a different valid configuration at its
correct price.

**What if your service is down when someone adds to cart?**
With `ALLIN_REQUIRE_VERIFY` set to `true` the add-to-cart is refused with a
polite message, which is the safe default — better a retry than an order at
the wrong price. Set it to `false` and the order goes through with no
surcharge applied, for you to correct by hand; only do that if you would
rather have the order than the accuracy.

**Two of the same product, configured differently?**
They stay two separate cart lines, each with its own choices — that is what
the `allin_key` is doing.

**Variable products?**
Works as-is: the configurator's surcharge is added on top of whichever
variation the customer picked, because the base is read from the product at
the moment it goes in the cart.

**I changed prices in the Studio — do I need to touch WordPress?**
No. Republish and the next add-to-cart prices itself against the new
version. The PHP file never contains a price.

**Nothing appears on the product page.**
The product ID in `ALLIN_PRODUCTS` does not match the product you are
looking at, or your theme has replaced the standard add-to-cart template and
dropped the `woocommerce_before_add_to_cart_button` hook. Block-based themes
using the newer product blocks sometimes do; switching that product to the
classic template is the quickest fix.
