// What the customer's browser touches, on the merchant's storefront: the
// published manifest and model, and the artwork they upload.
//
// Nothing here is authenticated — these are the URLs in a public product
// page. What stands in for auth is that publications are immutable, uploads
// are checked against the very manifest they claim to belong to, and the
// merchant's origin allowlist decides who may read.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Route, Ctx } from '../http.ts';
import { readBody, readJson, Raw, Redirect, allowedOrigin, rateLimiter, clientIp } from '../http.ts';
import { type Deps, addHeaders } from '../app.ts';
import { ApiError, badRequest, notFound, forbidden, tooLarge, tooMany, unprocessable } from '../errors.ts';
import { sha256 } from '../ids.ts';
import { assetKey } from '../storage.ts';
import {
  getPublication, livePublication, getAsset, putAsset, createUpload, getUpload,
  originsForPublication, listOrigins, projectByPreviewToken,
} from '../store.ts';
import type { Manifest, UploadOption } from '../../../embed/src/manifest/types.ts';
import { defaultSelections, applySelection, priceDeltas } from '../../../embed/src/runtime/state.ts';

/** A year. Everything under /p/ is frozen, so the edge may keep it forever;
 * the live pointer gets a minute, because moving it is the point. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
const LIVE = 'public, max-age=60, stale-while-revalidate=600';

/**
 * Reader for the built embed bundle on disk.
 *
 * Each file is read once and held — these are the hottest things the
 * service serves (every storefront page load) and they cannot change under
 * a running process. Built per app rather than per module so the directory
 * is resolved when the app is, and so one test's fixture directory cannot
 * leak into the next.
 *
 * EMBED_DIR exists so a deployment that would rather serve the bundle from
 * a CDN can point this elsewhere, or at nothing: a missing directory just
 * means these paths 404, exactly as they did before.
 */
function embedReader(): (file: string) => Promise<Uint8Array | null> {
  const dir = process.env.EMBED_DIR
    ?? fileURLToPath(new URL('../../../embed/dist/', import.meta.url));
  const cache = new Map<string, Uint8Array | null>();
  return async (file) => {
    const hit = cache.get(file);
    if (hit !== undefined) return hit;
    let bytes: Uint8Array | null = null;
    try {
      bytes = await readFile(join(dir, file));
    } catch { bytes = null; }
    cache.set(file, bytes);
    return bytes;
  };
}

/**
 * What the bytes actually are.
 *
 * The browser's declared Content-Type is a claim by whoever is calling, and
 * an image endpoint that believes it will eventually serve something that is
 * not an image. SVG is refused outright rather than sniffed: it is a
 * document that can carry script, and we serve these back to customers.
 */
export function sniffImage(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  const ascii = (at: number, text: string) =>
    [...text].every((ch, i) => b[at + i] === ch.charCodeAt(0));
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return null;
}

/**
 * The two things the service adds as it hands a manifest out. The STORED
 * manifest is never touched — a publication is frozen, and these depend on
 * deployment rather than on what the merchant authored.
 *
 * `models[0].url`: the stored manifest says `model.glb`, relative, which
 * resolves correctly because the model sits beside the manifest. With a CDN
 * configured it is rewritten to the edge URL instead, so the biggest file in
 * the product never passes through this process.
 *
 * `uploads`: where customer artwork goes. Its presence is what switches the
 * embed from inlining a data: URL to posting the image and carrying an id —
 * which is why a self-hosted manifest.json, which has no such block, still
 * works with no server at all.
 */
export function serveable(
  manifest: Manifest, modelUrl: string | null, uploads: { url: string; publication: string },
): Manifest {
  const models = modelUrl && manifest.models?.length
    ? manifest.models.map((m, i) => (i === 0 && !/^https?:/i.test(m.url) ? { ...m, url: modelUrl } : m))
    : manifest.models;
  return { ...manifest, models, uploads };
}

export function publicRoutes(deps: Deps): Route[] {
  const { sql, clock, config } = deps;
  // Customers upload once or twice; a script uploading two hundred times is
  // not a customer.
  const uploadLimit = rateLimiter(30, 10 * 60_000);
  // Pricing is called once per add-to-cart from a merchant's server, so the
  // bucket is per-STORE rather than per-shopper and can be generous.
  const priceLimit = rateLimiter(600, 60_000);
  const embedAsset = embedReader();

  /** Serve a frozen publication's two files, or the live pointer's. */
  async function serve(ctx: Ctx, publicationId: string, what: 'manifest' | 'model', cache: string) {
    const pub = await getPublication(sql, publicationId);
    if (!pub) throw notFound('publication');
    const allowed = await originsForPublication(sql, pub.id);
    if (!allowedOrigin(ctx.origin, allowed)) throw forbidden('this configurator is not enabled for that site');

    const asset = await getAsset(sql, pub.glb_asset_id);
    if (!asset) throw notFound('model');
    addHeaders(ctx, { 'cache-control': cache });

    if (what === 'model') {
      // With a CDN in front of the bucket the model never passes through
      // this process at all — the customer is sent straight to the edge.
      const direct = deps.store.publicUrl(asset.storage_key);
      if (direct) return new Redirect(direct);
      const object = await deps.store.get(asset.storage_key);
      if (!object) throw notFound('model');
      return new Raw(object.bytes, 'model/gltf-binary');
    }
    const manifest = serveable(
      pub.manifest as Manifest,
      deps.store.publicUrl(asset.storage_key),
      { url: `${config.publicBase}/v1/uploads`, publication: pub.id });
    return new Raw(new TextEncoder().encode(JSON.stringify(manifest)), 'application/json; charset=utf-8');
  }

  // Preview links are shared in chats and scanned by link unfurlers; a
  // modest bucket keeps a scripted crawl from turning drafts into load.
  const previewLimit = rateLimiter(300, 60_000);

  /** The living draft a preview token names, or 404 — one door for all
   * three /pv routes so archived projects and junk tokens fail the same. */
  async function draftFor(ctx: Ctx) {
    if (!previewLimit(clientIp(ctx.req))) {
      throw new ApiError(429, 'rate_limited', 'too many preview requests — slow down');
    }
    const row = await projectByPreviewToken(sql, ctx.params.token);
    if (!row) throw notFound('preview');
    return row;
  }

  return [
    // ── the freely shareable customiser preview ───────────────────────────
    //
    // /pv/<token> is a page ANYONE can open: the customiser running the
    // project's CURRENT draft. No session, no origin allowlist — the token
    // is the whole credential. The manifest is never cached (the draft moves
    // under it); the model may be, briefly, keyed by its own asset id.
    {
      method: 'GET',
      pattern: '/pv/:token',
      async handler(ctx) {
        const row = await draftFor(ctx);
        const name = String((row.manifest as Manifest).name ?? 'Product preview');
        const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        addHeaders(ctx, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
        const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#ffffff">
<title>${esc(name)} — preview</title>
<link rel="stylesheet" href="${config.publicBase}/embed.css">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #fff;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-text-size-adjust: 100%;
    overflow-x: hidden; /* a stray pixel must not give a phone a sideways page */
  }
  main {
    max-width: 1100px; margin: 0 auto;
    padding: clamp(10px, 3vw, 20px);
    padding-left: max(clamp(10px, 3vw, 20px), env(safe-area-inset-left));
    padding-right: max(clamp(10px, 3vw, 20px), env(safe-area-inset-right));
    padding-bottom: max(48px, env(safe-area-inset-bottom));
  }
  h1 { font-size: clamp(17px, 4.5vw, 20px); margin: 6px 0 14px; color: #1a1a1a; }
  .pv-note { font-size: 12px; color: #9c9480; margin: 16px 0 0; }
</style>
</head><body>
<main>
  <h1>${esc(name)}</h1>
  <div data-configurator="${config.publicBase}/pv/${ctx.params.token}/manifest.json"></div>
  <p class="pv-note">A live preview — what you configure here is not an order.</p>
</main>
<script type="module" src="${config.publicBase}/embed.js"></script>
</body></html>`;
        return new Raw(new TextEncoder().encode(html), 'text/html; charset=utf-8');
      },
    },
    {
      method: 'GET',
      pattern: '/pv/:token/manifest.json',
      async handler(ctx) {
        const row = await draftFor(ctx);
        addHeaders(ctx, { 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
        // No uploads block: a preview has no publication to file artwork
        // under, so the embed inlines images — exactly the self-hosted path.
        const manifest = row.manifest as Manifest;
        const models = row.model_asset_id && manifest.models?.length
          ? manifest.models.map((m, i) => (i === 0 ? { ...m, url: 'model.glb' } : m))
          : manifest.models;
        return new Raw(new TextEncoder().encode(JSON.stringify({ ...manifest, models })),
          'application/json; charset=utf-8');
      },
    },
    {
      method: 'GET',
      pattern: '/pv/:token/model.glb',
      async handler(ctx) {
        const row = await draftFor(ctx);
        if (!row.model_asset_id) throw notFound('model');
        const asset = await getAsset(sql, row.model_asset_id);
        if (!asset) throw notFound('model');
        // Re-uploads mint a new asset id, so a short cache can never serve a
        // STALE model for long — and the ETag is exact.
        addHeaders(ctx, {
          'cache-control': 'max-age=300',
          etag: `"${asset.id}"`,
          'access-control-allow-origin': '*',
        });
        const direct = deps.store.publicUrl(asset.storage_key);
        if (direct) return new Redirect(direct);
        const object = await deps.store.get(asset.storage_key);
        if (!object) throw notFound('model');
        return new Raw(object.bytes, 'model/gltf-binary');
      },
    },

    // ── is this instance actually serving? ────────────────────────────────
    //
    // The platform's health check, so it has to answer the question the
    // platform is really asking: can this machine do its job. A process that
    // is up but cannot reach Postgres serves 500s to every merchant, and a
    // health check that only proves the event loop is running would keep it
    // in the load balancer while it did.
    {
      method: 'GET',
      pattern: '/health',
      async handler(ctx) {
        addHeaders(ctx, { 'cache-control': 'no-store' });
        try {
          await sql.query('select 1');
        } catch (err) {
          throw new ApiError(503, 'unhealthy', 'the database is not reachable',
            err instanceof Error ? err.message : undefined);
        }
        return { ok: true, at: clock.now().toISOString() };
      },
    },

    // ── a frozen version: the URL an order pins ───────────────────────────
    {
      method: 'GET',
      pattern: '/p/:pub/manifest.json',
      handler: (ctx) => serve(ctx, ctx.params.pub, 'manifest', IMMUTABLE),
    },
    {
      method: 'GET',
      pattern: '/p/:pub/model.glb',
      handler: (ctx) => serve(ctx, ctx.params.pub, 'model', IMMUTABLE),
    },

    // ── what it actually costs ────────────────────────────────────────────
    //
    // The cart's answer to "never bill the client's numbers".
    //
    // `deltaTotal` in the payload is computed in the customer's browser, so
    // it is a quote. This re-runs the SAME pricing function against the SAME
    // frozen manifest, server-side, and the merchant's backend charges what
    // comes back. One manifest, one pricing function, verified twice — which
    // until now was only possible for backends that happened to be Node.
    //
    // Deliberately NOT origin-checked: the callers are merchants' servers —
    // WooCommerce's PHP, a Velo backend function — which send no Origin at
    // all, so the check would reject precisely the traffic this exists for.
    // Nothing here is a secret either: every number is derived from a
    // manifest anyone can already fetch. Rate-limited instead.
    {
      method: 'POST',
      pattern: '/p/:pub/price',
      async handler(ctx) {
        if (!priceLimit(clientIp(ctx.req, config.trustProxy), clock.now().getTime())) throw tooMany();
        const pub = await getPublication(sql, ctx.params.pub);
        if (!pub) throw notFound('publication');

        const body = await readJson<{ selections?: unknown }>(ctx.req, 64 * 1024);
        const sent = body.selections;
        if (!sent || typeof sent !== 'object' || Array.isArray(sent)) {
          throw badRequest('selections must be an object of optionId → value');
        }

        // Start from the product's own defaults and apply what was sent
        // through applySelection — the same funnel the browser uses. A value
        // the manifest does not offer never lands, so a caller cannot invent
        // a cheaper swatch by naming one that does not exist.
        const manifest = pub.manifest as Manifest;
        const selections = defaultSelections(manifest);
        for (const [optionId, value] of Object.entries(sent as Record<string, unknown>)) {
          if (typeof value !== 'string') continue;
          applySelection(manifest, selections, optionId, value);
        }
        const deltas = priceDeltas(manifest, selections);
        addHeaders(ctx, { 'cache-control': 'no-store' });
        return {
          publicationId: pub.id,
          version: pub.version,
          currency: manifest.pricing.currency,
          priceDeltas: deltas,
          deltaTotal: Math.round(deltas.reduce((sum, d) => sum + d.amount, 0) * 100) / 100,
          // What the service made of the submission, so a mismatch with what
          // the browser sent is visible rather than merely priced away.
          selections,
        };
      },
    },

    // ── the live pointer: the URL a merchant pastes into their store ──────
    //
    // Two URLs on purpose. If storefronts embedded the version id, every
    // publish would mean re-pasting a snippet; if orders recorded the live
    // URL, last month's order would silently become this month's product.
    {
      method: 'GET',
      pattern: '/e/:project/manifest.json',
      async handler(ctx) {
        const pub = await livePublication(sql, ctx.params.project);
        if (!pub) throw notFound('this product has not been published yet');
        return serve(ctx, pub.id, 'manifest', LIVE);
      },
    },
    {
      method: 'GET',
      pattern: '/e/:project/model.glb',
      async handler(ctx) {
        const pub = await livePublication(sql, ctx.params.project);
        if (!pub) throw notFound('this product has not been published yet');
        return serve(ctx, pub.id, 'model', LIVE);
      },
    },
    {
      /** Which publication the live pointer resolves to — so an order can
       * record the frozen id even though the page fetched the live URL. */
      method: 'GET',
      pattern: '/e/:project/live.json',
      async handler(ctx) {
        const pub = await livePublication(sql, ctx.params.project);
        if (!pub) throw notFound('this product has not been published yet');
        if (!allowedOrigin(ctx.origin, await listOrigins(sql, ctx.params.project))) {
          throw forbidden('this configurator is not enabled for that site');
        }
        addHeaders(ctx, { 'cache-control': LIVE });
        return {
          publicationId: pub.id,
          version: pub.version,
          manifestUrl: `${config.publicBase}/p/${pub.id}/manifest.json`,
        };
      },
    },

    // ── customer artwork ──────────────────────────────────────────────────
    //
    // The image lands HERE and travels through the cart as an id. The
    // alternative — the picture itself, base64'd, inside a line-item
    // property — is a megabyte of data in a field most carts cap at 255
    // characters, which is how this breaks on the first real order.
    {
      method: 'POST',
      pattern: '/v1/uploads',
      async handler(ctx) {
        if (!uploadLimit(clientIp(ctx.req, config.trustProxy), clock.now().getTime())) throw tooMany();

        const publicationId = ctx.query.get('publication') ?? '';
        const optionId = ctx.query.get('option') ?? '';
        const pub = await getPublication(sql, publicationId);
        if (!pub) throw notFound('publication');
        if (!allowedOrigin(ctx.origin, await originsForPublication(sql, pub.id))) {
          throw forbidden('this configurator is not enabled for that site');
        }

        // The zone's own rules come from the manifest the customer is
        // actually looking at, not from a global setting: a merchant who
        // allowed 3 MB of artwork on one product gets 3 MB there and nowhere
        // else.
        const manifest = pub.manifest as Manifest;
        const option = manifest.options?.find((o) => o.id === optionId);
        if (!option || option.type !== 'upload') throw notFound('image zone');
        const zone = option as UploadOption;
        const limit = Math.min(zone.maxBytes ?? 1_500_000, config.maxImageBytes);

        const bytes = await readBody(ctx.req, limit);
        if (!bytes.length) throw badRequest('empty upload');
        const sniffed = sniffImage(bytes);
        if (!sniffed) throw unprocessable('that file is not a PNG, JPEG, GIF or WebP image');
        const accept = zone.accept ?? ['image/png', 'image/jpeg'];
        if (!accept.includes(sniffed)) {
          throw unprocessable(`this zone takes ${accept.join(' or ')}; that file is ${sniffed}`);
        }
        if (bytes.length > limit) throw tooLarge(`images here must be under ${limit} bytes`);

        const { rows } = await sql.query<{ org_id: string }>(
          'select org_id from projects where id = $1', [pub.project_id]);
        const orgId = rows[0]?.org_id;
        if (!orgId) throw notFound('publication');

        const digest = sha256(bytes);
        const key = assetKey(orgId, digest);
        await deps.store.put(key, bytes, sniffed);
        const asset = await putAsset(sql, orgId,
          { sha256: digest, kind: 'image', contentType: sniffed, bytes: bytes.length, storageKey: key },
          clock.now());
        const upload = await createUpload(sql, pub.id, optionId, asset.id, clock.now());
        return { id: upload.id, url: `${config.publicBase}/u/${upload.id}`, bytes: bytes.length, contentType: sniffed };
      },
    },
    {
      /**
       * The embed bundle, at PUBLIC_BASE.
       *
       * The snippet a merchant pastes references `embed.js` and `embed.css`
       * HERE — `embedBase` in the Studio is the service's own address — so
       * if nothing serves them the snippet is a 404 on every storefront
       * that has ever pasted it. Serving them from the service is what
       * makes the published snippet true by construction, with no upload
       * step anyone can forget.
       *
       * Registered last, and narrow: only `embed*.js|css` is served, so
       * every other unmatched path still 404s as it always did.
       *
       * The module script and its lazy chunks are fetched CROSS-ORIGIN by
       * the merchant's page, which for `type="module"` means CORS applies —
       * the wildcard header the app already sets on non-/v1 paths is what
       * makes that work.
       */
      method: 'GET',
      pattern: '/:file',
      async handler(ctx) {
        const file = ctx.params.file;
        if (!/^embed[\w.-]*\.(js|css)$/.test(file) || file.includes('..')) throw notFound('not found');
        const body = await embedAsset(file);
        if (!body) throw notFound('not found');
        addHeaders(ctx, {
          // A hashed chunk name changes whenever its contents do, so it can
          // be kept forever. `embed.js` and `embed.css` are stable names
          // whose contents change on deploy — an hour, so a merchant's
          // customers pick up a fix the same day without re-pasting.
          'cache-control': /-[A-Z0-9]{8}\.js$/.test(file) ? IMMUTABLE : 'public, max-age=3600',
        });
        return new Raw(body, file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
      },
    },
    {
      /**
       * Serve a customer's artwork back — to the configurator that is
       * drawing it, and later to the workshop that is printing it.
       *
       * Locked down hard: the sniffed type rather than the claimed one,
       * `nosniff` so the browser does not second-guess us, and a CSP that
       * makes the response inert even if something ever did slip past the
       * sniffer.
       */
      method: 'GET',
      pattern: '/u/:upload',
      async handler(ctx) {
        const upload = await getUpload(sql, ctx.params.upload);
        if (!upload) throw notFound('upload');
        const asset = await getAsset(sql, upload.asset_id);
        const object = asset && await deps.store.get(asset.storage_key);
        if (!object || !asset) throw notFound('upload');
        addHeaders(ctx, {
          'cache-control': IMMUTABLE,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'content-disposition': 'inline',
        });
        return new Raw(object.bytes, asset.content_type);
      },
    },
  ];
}
