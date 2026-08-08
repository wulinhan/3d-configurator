// Everything the Studio calls: signing in, the org and its people, projects
// and their autosave, and publishing.

import type { Route, Ctx } from '../http.ts';
import {
  readJson, readBody, cookies, cookieHeader, rateLimiter, clientIp, NO_CONTENT, Raw,
} from '../http.ts';
import { type Deps, SESSION_COOKIE, requireUser, requireStudioOrigin, addHeaders } from '../app.ts';
import { badRequest, forbidden, notFound, unprocessable, tooMany } from '../errors.ts';
import { newToken, sha256 } from '../ids.ts';
import { assetKey } from '../storage.ts';
import { signInEmail } from '../mail.ts';
import {
  type Role, roleAtLeast, findUserByEmail, createUser, createOrg, addMember, removeMember,
  membershipsOf, membersOf, roleIn, createLoginToken, consumeLoginToken, createSession,
  deleteSession, putAsset, getAsset, createProject, projectFor, listProjects, saveProject,
  pruneRevisions, setProjectModel, setProjectThumb, renameProject, archiveProject, createPublication,
  listPublications, setLivePublication, listOrigins, setOrigins, normaliseEmail,
} from '../store.ts';
import { validateManifest } from '../../../embed/src/manifest/validate.ts';

const ROLES: Role[] = ['owner', 'editor', 'viewer'];
const isRole = (v: unknown): v is Role => typeof v === 'string' && ROLES.includes(v as Role);

/** A published product must be shown to a customer, so an origin has to be a
 * real web origin — scheme and host, nothing else. */
function cleanOrigin(value: unknown): string {
  if (typeof value !== 'string') throw badRequest('each origin must be a string');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw badRequest(`"${value}" is not a URL`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest(`"${value}" must be http or https`);
  return url.origin.toLowerCase();
}

export function studioRoutes(deps: Deps): Route[] {
  const { sql, clock, config } = deps;
  // Sign-in endpoints are unauthenticated writes, so they are the things
  // worth limiting by address before anything else.
  const loginLimit = rateLimiter(10, 15 * 60_000);
  // …and, for the link-sender, by TARGET INBOX as well. The per-IP limit
  // means nothing to a botnet, and the harm of the flood lands on the person
  // whose address was typed — five an hour is plenty for a human retrying a
  // typo and useless for making someone's phone buzz all afternoon.
  const emailLimit = rateLimiter(5, 60 * 60_000);

  /** Issue a session and set its cookie — the tail of every sign-in path. */
  async function establishSession(ctx: Ctx, userId: string): Promise<void> {
    const token = newToken();
    await createSession(sql, userId, token, clock.now(), config.sessionTtlMs);
    addHeaders(ctx, {
      'set-cookie': cookieHeader(SESSION_COOKIE, token, {
        secure: config.cookieSecure, sameSite: config.cookieSameSite,
        maxAgeSeconds: Math.floor(config.sessionTtlMs / 1000),
      }),
    });
  }

  /** The project, plus the caller's role in it — or a 404 that reveals
   * nothing about whether the id exists. */
  async function project(ctx: Ctx, need: Role) {
    const user = await requireUser(deps, ctx);
    requireStudioOrigin(deps, ctx);
    const row = await projectFor(sql, ctx.params.id, user.id);
    if (!row) throw notFound('project');
    if (!roleAtLeast(row.role, need)) throw forbidden(`this needs ${need} access`);
    return { user, project: row };
  }

  async function org(ctx: Ctx, need: Role) {
    const user = await requireUser(deps, ctx);
    requireStudioOrigin(deps, ctx);
    const role = await roleIn(sql, ctx.params.org, user.id);
    if (!role) throw notFound('org');
    if (!roleAtLeast(role, need)) throw forbidden(`this needs ${need} access`);
    return { user, role };
  }

  const me = async (userId: string) => ({
    orgs: (await membershipsOf(sql, userId)).map((m) => ({ id: m.org.id, name: m.org.name, role: m.role })),
  });

  return [
    // ── signing in ────────────────────────────────────────────────────────
    {
      /** Which sign-in extras this deployment has switched on. Public: both
       * values end up in the page anyway, and the Studio uses this to decide
       * what to render — so turning a feature on is a Fly secret, never a
       * rebuild. */
      method: 'GET',
      pattern: '/v1/auth/config',
      handler: async () => ({
        googleClientId: config.googleClientId ?? null,
        turnstileSiteKey: config.turnstileSiteKey ?? null,
      }),
    },
    {
      method: 'POST',
      pattern: '/v1/auth/request',
      async handler(ctx) {
        const ip = clientIp(ctx.req, config.trustProxy);
        if (!loginLimit(ip, clock.now().getTime())) throw tooMany();
        const body = await readJson<{ email?: string; turnstile?: string }>(ctx.req, 8192);
        const email = normaliseEmail(body.email ?? '');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('a valid email is required');
        if (!emailLimit(email, clock.now().getTime())) throw tooMany();

        // The human check, when this deployment has one. It guards the ONE
        // thing a bot gets out of this endpoint — email sent to an address
        // of its choosing, on our reputation and our quota.
        if (deps.verifyTurnstile) {
          const token = String(body.turnstile ?? '');
          if (!token || !(await deps.verifyTurnstile(token, ip))) {
            throw forbidden('the human check did not pass — reload the page and try again');
          }
        }

        const token = newToken();
        await createLoginToken(sql, email, token, clock.now(), config.loginTtlMs);
        const link = `${config.appBase.replace(/\/$/, '')}/signin#${token}`;
        await deps.mail.send({ to: email, ...signInEmail(link) });
        // Always 204, whether or not the address has an account. The
        // alternative tells a stranger who our customers are.
        return NO_CONTENT;
      },
    },
    {
      method: 'POST',
      pattern: '/v1/auth/consume',
      async handler(ctx) {
        const body = await readJson<{ token?: string }>(ctx.req, 4096);
        if (!body.token) throw badRequest('token required');
        const spent = await consumeLoginToken(sql, body.token, clock.now());
        if (!spent) throw badRequest('that link has expired or has already been used');

        let user = await findUserByEmail(sql, spent.email);
        if (!user) {
          user = await createUser(sql, spent.email, clock.now());
          // Signing up gives you somewhere to work. An invited user joins the
          // inviting org instead of getting an empty one of their own.
          if (!spent.invite) {
            const workshop = await createOrg(sql, `${spent.email.split('@')[0]}'s workshop`, clock.now());
            await addMember(sql, workshop.id, user.id, 'owner', clock.now());
          }
        }
        if (spent.invite) await addMember(sql, spent.invite.orgId, user.id, spent.invite.role, clock.now());

        await establishSession(ctx, user.id);
        return { user, ...(await me(user.id)) };
      },
    },
    {
      /**
       * "Sign in with Google": the button's ID token in, a session out.
       *
       * The email inside a VERIFIED token is the same identity a magic link
       * proves — Google checked the inbox so we don't have to — so it lands
       * in the same account a link sign-in would, and a first-timer gets a
       * workshop exactly as if they had clicked one. What it cannot do is
       * accept an invitation: those ride the link itself, and still work
       * later regardless of how the account signs in.
       */
      method: 'POST',
      pattern: '/v1/auth/google',
      async handler(ctx) {
        if (!deps.verifyGoogleToken) throw notFound('Google sign-in is not enabled here');
        if (!loginLimit(clientIp(ctx.req, config.trustProxy), clock.now().getTime())) throw tooMany();
        const body = await readJson<{ credential?: string }>(ctx.req, 16 * 1024);
        if (!body.credential) throw badRequest('credential required');

        // One uniform refusal whichever check inside failed — the response
        // must not teach a forger which part of their token was wrong.
        const identity = await deps.verifyGoogleToken(body.credential);
        if (!identity) throw badRequest('that Google sign-in could not be verified — please try again');

        const email = normaliseEmail(identity.email);
        let user = await findUserByEmail(sql, email);
        if (!user) {
          user = await createUser(sql, email, clock.now(), identity.name);
          const workshop = await createOrg(sql, `${email.split('@')[0]}'s workshop`, clock.now());
          await addMember(sql, workshop.id, user.id, 'owner', clock.now());
        }
        await establishSession(ctx, user.id);
        return { user, ...(await me(user.id)) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/auth/logout',
      async handler(ctx) {
        const token = cookies(ctx.req)[SESSION_COOKIE];
        if (token) await deleteSession(sql, token);
        addHeaders(ctx, {
          'set-cookie': cookieHeader(SESSION_COOKIE, '', {
            secure: config.cookieSecure, sameSite: config.cookieSameSite, maxAgeSeconds: 0,
          }),
        });
        return NO_CONTENT;
      },
    },
    {
      method: 'GET',
      pattern: '/v1/me',
      async handler(ctx) {
        const user = await requireUser(deps, ctx);
        return { user, ...(await me(user.id)) };
      },
    },

    // ── people ────────────────────────────────────────────────────────────
    {
      method: 'GET',
      pattern: '/v1/orgs/:org/members',
      async handler(ctx) {
        await org(ctx, 'viewer');
        return { members: await membersOf(sql, ctx.params.org) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/orgs/:org/members',
      async handler(ctx) {
        await org(ctx, 'owner');
        const body = await readJson<{ email?: string; role?: string }>(ctx.req, 4096);
        const email = normaliseEmail(body.email ?? '');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('a valid email is required');
        if (!isRole(body.role)) throw badRequest(`role must be one of ${ROLES.join(', ')}`);

        const existing = await findUserByEmail(sql, email);
        if (existing) {
          // Already has an account: add them and let them find it. No link
          // needed, and no way for an invitation to become a login.
          await addMember(sql, ctx.params.org, existing.id, body.role, clock.now());
          return { invited: false, member: { ...existing, role: body.role } };
        }
        const token = newToken();
        await createLoginToken(sql, email, token, clock.now(), config.loginTtlMs,
          { orgId: ctx.params.org, role: body.role });
        const orgs = await membershipsOf(sql, (await requireUser(deps, ctx)).id);
        const name = orgs.find((m) => m.org.id === ctx.params.org)?.org.name;
        await deps.mail.send({
          to: email,
          ...signInEmail(`${config.appBase.replace(/\/$/, '')}/signin#${token}`, name),
        });
        return { invited: true };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/orgs/:org/members/:user',
      async handler(ctx) {
        await org(ctx, 'owner');
        await removeMember(sql, ctx.params.org, ctx.params.user);
        return NO_CONTENT;
      },
    },

    // ── projects ──────────────────────────────────────────────────────────
    {
      method: 'GET',
      pattern: '/v1/orgs/:org/projects',
      async handler(ctx) {
        await org(ctx, 'viewer');
        const rows = await listProjects(sql, ctx.params.org, (await requireUser(deps, ctx)).id);
        return {
          projects: rows.map((p) => ({
            id: p.id, name: p.name, revision: p.revision, valid: p.valid,
            updatedAt: p.updated_at, hasModel: !!p.model_asset_id,
            hasThumb: !!p.thumb_asset_id, live: p.live_publication_id,
          })),
        };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/orgs/:org/projects',
      async handler(ctx) {
        await org(ctx, 'editor');
        const body = await readJson<{ name?: string; manifest?: unknown }>(ctx.req);
        const name = (body.name ?? '').trim() || 'Untitled product';
        const manifest = body.manifest ?? {};
        const row = await createProject(sql, ctx.params.org, name, manifest, clock.now());
        return { project: { id: row.id, name: row.name, revision: row.revision } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/projects/:id',
      async handler(ctx) {
        const { project: p } = await project(ctx, 'viewer');
        return {
          project: {
            id: p.id, orgId: p.org_id, name: p.name, revision: p.revision, valid: p.valid,
            manifest: p.manifest, hasModel: !!p.model_asset_id,
            live: p.live_publication_id, updatedAt: p.updated_at,
          },
        };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/projects/:id',
      async handler(ctx) {
        const { user, project: p } = await project(ctx, 'editor');
        const body = await readJson<{ manifest?: unknown; baseRevision?: number; name?: string }>(ctx.req);
        if (typeof body.baseRevision !== 'number') throw badRequest('baseRevision required');
        if (!body.manifest || typeof body.manifest !== 'object') throw badRequest('manifest must be an object');

        // Autosave stores whatever the merchant has, valid or not. A draft
        // mid-edit is often incomplete, and refusing to save it is how an
        // afternoon's work is lost to a rule that only matters at publish.
        const report = validateManifest(body.manifest);
        const saved = await saveProject(sql, p.id,
          { manifest: body.manifest, valid: report.ok, baseRevision: body.baseRevision, authorId: user.id },
          clock.now());
        if (body.name?.trim()) await renameProject(sql, p.id, body.name.trim(), clock.now());
        if (saved.revision % 20 === 0) await pruneRevisions(sql, p.id, config.revisionsKept);
        return { revision: saved.revision, valid: saved.valid, errors: report.errors, warnings: report.warnings };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/projects/:id',
      async handler(ctx) {
        const { project: p } = await project(ctx, 'owner');
        await archiveProject(sql, p.id, clock.now());
        return NO_CONTENT;
      },
    },

    // ── the workspace model ───────────────────────────────────────────────
    //
    // Without this a reopened project would be a manifest describing geometry
    // nobody has. The Studio sends the uncompressed parts GLB whenever the
    // model changes; content addressing means an unchanged model costs one
    // request and no new storage.
    {
      method: 'POST',
      pattern: '/v1/projects/:id/model',
      async handler(ctx) {
        const { project: p } = await project(ctx, 'editor');
        const bytes = await readBody(ctx.req, config.maxModelBytes);
        if (!bytes.length) throw badRequest('empty model');
        const digest = sha256(bytes);
        const key = assetKey(p.org_id, digest);
        await deps.store.put(key, bytes, 'model/gltf-binary');
        const asset = await putAsset(sql, p.org_id,
          { sha256: digest, kind: 'model', contentType: 'model/gltf-binary', bytes: bytes.length, storageKey: key },
          clock.now());
        await setProjectModel(sql, p.id, asset.id, clock.now());
        return { assetId: asset.id, sha256: digest, bytes: bytes.length };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/projects/:id/model',
      async handler(ctx) {
        const { project: p } = await project(ctx, 'viewer');
        if (!p.model_asset_id) throw notFound('this project has no model yet');
        const asset = await getAsset(sql, p.model_asset_id);
        const object = asset && await deps.store.get(asset.storage_key);
        if (!object) throw notFound('model');
        return new Raw(object.bytes, object.contentType, { 'cache-control': 'private, max-age=60' });
      },
    },

    // ── the dashboard thumbnail ───────────────────────────────────────────
    //
    // A small square render the Studio captures after saves. Best-effort by
    // design: a missing thumbnail is a placeholder icon, never an error, and
    // a stale one is corrected by the next save.
    {
      method: 'POST',
      pattern: '/v1/projects/:id/thumbnail',
      async handler(ctx) {
        const { project: p } = await project(ctx, 'editor');
        const bytes = await readBody(ctx.req, config.maxImageBytes);
        if (!bytes.length) throw badRequest('empty image');
        const digest = sha256(bytes);
        const key = assetKey(p.org_id, digest);
        await deps.store.put(key, bytes, 'image/png');
        const asset = await putAsset(sql, p.org_id,
          { sha256: digest, kind: 'image', contentType: 'image/png', bytes: bytes.length, storageKey: key },
          clock.now());
        await setProjectThumb(sql, p.id, asset.id);
        return { assetId: asset.id };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/projects/:id/thumbnail',
      async handler(ctx) {
        const { project: p } = await project(ctx, 'viewer');
        if (!p.thumb_asset_id) throw notFound('this project has no thumbnail yet');
        const asset = await getAsset(sql, p.thumb_asset_id);
        const object = asset && await deps.store.get(asset.storage_key);
        if (!object) throw notFound('thumbnail');
        return new Raw(object.bytes, object.contentType, { 'cache-control': 'private, max-age=60' });
      },
    },

    // ── where it may be embedded ──────────────────────────────────────────
    {
      method: 'GET',
      pattern: '/v1/projects/:id/origins',
      async handler(ctx) {
        const { project: p } = await project(ctx, 'viewer');
        return { origins: await listOrigins(sql, p.id) };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/projects/:id/origins',
      async handler(ctx) {
        const { project: p } = await project(ctx, 'editor');
        const body = await readJson<{ origins?: unknown }>(ctx.req);
        if (!Array.isArray(body.origins)) throw badRequest('origins must be an array');
        if (body.origins.length > 50) throw badRequest('at most 50 origins');
        const cleaned = [...new Set(body.origins.map(cleanOrigin))];
        await setOrigins(sql, p.id, cleaned, clock.now());
        return { origins: cleaned };
      },
    },

    // ── publishing ────────────────────────────────────────────────────────
    {
      method: 'GET',
      pattern: '/v1/projects/:id/publications',
      async handler(ctx) {
        const { project: p } = await project(ctx, 'viewer');
        const rows = await listPublications(sql, p.id);
        return {
          live: p.live_publication_id,
          publications: rows.map((r) => ({
            id: r.id, version: r.version, publishedAt: r.published_at, publishedBy: r.published_by,
            manifestUrl: `${config.publicBase}/p/${r.id}/manifest.json`,
            modelUrl: `${config.publicBase}/p/${r.id}/model.glb`,
          })),
          liveManifestUrl: `${config.publicBase}/e/${p.id}/manifest.json`,
        };
      },
    },
    {
      /**
       * Publish: the compressed GLB is the request body, and the manifest is
       * whatever the project holds right now. Both are COPIED — the
       * publication does not point at the draft, because a product edited in
       * March must not change what someone bought in February.
       */
      method: 'POST',
      pattern: '/v1/projects/:id/publications',
      async handler(ctx) {
        const { user, project: p } = await project(ctx, 'editor');
        const report = validateManifest(p.manifest);
        if (!report.ok) throw unprocessable('this product does not validate yet', report.errors);

        const bytes = await readBody(ctx.req, config.maxModelBytes);
        if (!bytes.length) throw badRequest('the compressed model must be sent as the body');
        const digest = sha256(bytes);
        const key = assetKey(p.org_id, digest);
        await deps.store.put(key, bytes, 'model/gltf-binary');
        const asset = await putAsset(sql, p.org_id,
          { sha256: digest, kind: 'model', contentType: 'model/gltf-binary', bytes: bytes.length, storageKey: key },
          clock.now());

        const pub = await createPublication(sql, p.id, p.manifest, asset.id, user.id, clock.now());
        return {
          publication: {
            id: pub.id, version: pub.version, publishedAt: pub.published_at,
            manifestUrl: `${config.publicBase}/p/${pub.id}/manifest.json`,
            modelUrl: `${config.publicBase}/p/${pub.id}/model.glb`,
          },
          liveManifestUrl: `${config.publicBase}/e/${p.id}/manifest.json`,
          warnings: report.warnings,
        };
      },
    },
    {
      /** Roll back, or forward, without republishing: the same frozen bytes
       * pointed at again. */
      method: 'POST',
      pattern: '/v1/projects/:id/live',
      async handler(ctx) {
        const { project: p } = await project(ctx, 'editor');
        const body = await readJson<{ publicationId?: string }>(ctx.req);
        if (!body.publicationId) throw badRequest('publicationId required');
        await setLivePublication(sql, p.id, body.publicationId, clock.now());
        return { live: body.publicationId };
      },
    },
  ];
}
