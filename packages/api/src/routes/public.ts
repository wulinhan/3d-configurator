// What the customer's browser touches, on the merchant's storefront: the
// published manifest and model, and the artwork they upload.
//
// Nothing here is authenticated — these are the URLs in a public product
// page. What stands in for auth is that publications are immutable, uploads
// are checked against the very manifest they claim to belong to, and the
// merchant's origin allowlist decides who may read.

import type { Route, Ctx } from '../http.ts';
import { readBody, Raw, Redirect, allowedOrigin, rateLimiter, clientIp } from '../http.ts';
import { type Deps, addHeaders } from '../app.ts';
import { badRequest, notFound, forbidden, tooLarge, tooMany, unprocessable } from '../errors.ts';
import { sha256 } from '../ids.ts';
import { assetKey } from '../storage.ts';
import {
  getPublication, livePublication, getAsset, putAsset, createUpload, getUpload,
  originsForPublication, listOrigins,
} from '../store.ts';
import type { Manifest, UploadOption } from '../../../embed/src/manifest/types.ts';

/** A year. Everything under /p/ is frozen, so the edge may keep it forever;
 * the live pointer gets a minute, because moving it is the point. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
const LIVE = 'public, max-age=60, stale-while-revalidate=600';

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

  return [
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
