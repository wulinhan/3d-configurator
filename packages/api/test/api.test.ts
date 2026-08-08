// The service through its own front door.
//
// These boot the real router on a real socket and talk to it with fetch, so
// cookies, CORS, Origin checks, status codes and binary bodies are all
// exercised as they will be in production. The database underneath is real
// Postgres (see harness.ts). What is faked is the world outside: mail goes
// to an array, bytes go to a Map, and the clock is one the test moves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, type Harness } from './harness.ts';
import { createApp, type Config } from '../src/app.ts';
import { consoleMailer } from '../src/mail.ts';

const STUDIO = 'http://studio.test';
const SHOP = 'https://shop.example.com';

const CONFIG: Config = {
  studioOrigins: [STUDIO],
  appBase: STUDIO,
  publicBase: 'http://api.test',
  sessionTtlMs: 30 * 24 * 3600_000,
  loginTtlMs: 15 * 60_000,
  maxModelBytes: 4 * 1024 * 1024,
  maxImageBytes: 1024 * 1024,
  cookieSecure: false,
  cookieSameSite: 'lax',
  trustProxy: false,
  revisionsKept: 10,
};

/** A real 1×1 PNG — the sniffer reads magic bytes, and a hand-rolled buffer
 * would prove only that it agrees with the test's own idea of a header. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
/** Not a GLB in any real sense — the service stores model bytes without
 * parsing them, which is the point: parsing is the Studio's job. */
const GLB = Buffer.from('glTF fixture bytes, compressed by the Studio');

const MANIFEST = {
  schema: 1, id: 'plate', name: 'Plate', units: 'mm',
  models: [{ id: 'main', url: 'model.glb' }],
  parts: [{ id: 'body', label: 'Body', mesh: 'main#body' }],
  options: [{
    id: 'body-image', type: 'upload', label: 'Body image', part: 'body',
    origin: [0, 0, 5], normal: [0, 0, 1], widthMm: 40, heightMm: 30,
    accept: ['image/png'], maxBytes: 400_000,
  }],
  pricing: { currency: 'SGD' },
};

/** A product with money on it, for the price endpoint: a palette whose
 * bronze swatch costs 4, a custom-colour rule at 35, a priced add-on, and
 * per-character engraving. */
const PRICED = {
  schema: 1, id: 'plate', name: 'Plate', units: 'mm',
  models: [{ id: 'main', url: 'model.glb' }],
  parts: [
    { id: 'body', label: 'Body', mesh: 'main#body' },
    { id: 'stand', label: 'Stand', mesh: 'main#stand', visibleWhen: { option: 'stand', equals: ['yes'] } },
  ],
  palettes: [{
    id: 'std',
    label: 'Standard',
    swatches: [
      { id: 'white', name: 'White', hex: '#FFFFFF' },
      { id: 'bronze', name: 'Bronze', hex: '#8C6239', priceDelta: 4 },
    ],
  }],
  options: [
    {
      id: 'body-colour', type: 'colour', label: 'Body', parts: ['body'],
      palette: 'std', default: 'white', custom: { allowed: true, priceDelta: 35 },
    },
    {
      id: 'stand', type: 'choice', label: 'Stand', role: 'addon',
      choices: [{ id: 'no', label: 'None' }, { id: 'yes', label: 'Add stand', priceDelta: 24 }],
      default: 'no',
    },
    {
      id: 'body-text', type: 'text', label: 'Engraving', part: 'body',
      origin: [0, 0, 5], normal: [0, 0, 1], font: 'sans-bold',
      sizeMm: 8, depthMm: 2, maxLength: 20, pricePerChar: 2,
    },
  ],
  pricing: { currency: 'SGD' },
};

interface Client {
  fetch(path: string, init?: RequestInit & { origin?: string | null }): Promise<Response>;
  json<T>(path: string, init?: RequestInit & { origin?: string | null }): Promise<T>;
  cookie: string;
}

interface Rig extends Harness {
  base: string;
  mail: ReturnType<typeof consoleMailer>;
  server: Server;
  client(): Client;
  stop(): Promise<void>;
}

async function rig(config: Partial<Config> = {}, extra: Partial<Parameters<typeof createApp>[0]> = {}): Promise<Rig> {
  const h = await harness();
  const mail = consoleMailer(() => {});
  const app = createApp({
    sql: h.sql, store: h.store, clock: h.clock, mail,
    config: { ...CONFIG, ...config },
    log: () => {},
    ...extra,
  });
  const server = createServer((req, res) => { void app.handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  return {
    ...h, base, mail, server,
    client(): Client {
      const self: Client = {
        cookie: '',
        async fetch(path, init = {}) {
          const { origin, ...rest } = init;
          const headers = new Headers(rest.headers);
          if (origin !== null) headers.set('origin', origin ?? STUDIO);
          if (self.cookie) headers.set('cookie', self.cookie);
          const res = await fetch(`${base}${path}`, { ...rest, headers, redirect: 'manual' });
          const set = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
          if (set) self.cookie = set.split(';')[0];
          return res;
        },
        async json<T>(path: string, init?: RequestInit & { origin?: string | null }) {
          const res = await self.fetch(path, init);
          return await res.json() as T;
        },
      };
      return self;
    },
    async stop() {
      await new Promise<void>((r) => server.close(() => r()));
      await h.close();
    },
  };
}

/** Sign a browser in and return it, cookie in hand. */
async function signedIn(r: Rig, email = 'ada@example.com'): Promise<Client> {
  const client = r.client();
  const asked = await client.fetch('/v1/auth/request', {
    method: 'POST', body: JSON.stringify({ email }), headers: { 'content-type': 'application/json' },
  });
  assert.equal(asked.status, 204);
  const token = r.mail.sent.at(-1)!.text.match(/#([\w-]+)/)![1];
  const res = await client.fetch('/v1/auth/consume', {
    method: 'POST', body: JSON.stringify({ token }), headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  return client;
}

const orgOf = async (client: Client) =>
  (await client.json<{ orgs: Array<{ id: string; role: string }> }>('/v1/me')).orgs[0];

async function newProject(client: Client, orgId: string, manifest: unknown = MANIFEST) {
  const made = await client.json<{ project: { id: string; revision: number } }>(
    `/v1/orgs/${orgId}/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Plate' }),
    });
  const saved = await client.json<{ revision: number }>(`/v1/projects/${made.project.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest, baseRevision: made.project.revision }),
  });
  return { id: made.project.id, revision: saved.revision };
}

test('the health check answers what the platform is really asking', async () => {
  const r = await rig();
  const ok = await r.client().fetch('/health', { origin: null });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as { ok: boolean }).ok, true);
  // Never cached: a stale 200 would keep a dead machine in the load balancer.
  assert.equal(ok.headers.get('cache-control'), 'no-store');

  // A process that is up but cannot reach Postgres serves 500s to every
  // merchant. It has to fail the check, or the platform keeps sending it
  // traffic.
  const broken = await rig();
  broken.sql.query = async () => { throw new Error('connection refused'); };
  const sick = await broken.client().fetch('/health', { origin: null });
  assert.equal(sick.status, 503);
  await r.stop();
  await broken.stop();
});

// ── signing in ────────────────────────────────────────────────────────────

test('a magic link signs you in, once, and gives you somewhere to work', async () => {
  const r = await rig();
  const client = await signedIn(r);
  const me = await client.json<{ user: { email: string }; orgs: Array<{ role: string; name: string }> }>('/v1/me');
  assert.equal(me.user.email, 'ada@example.com');
  assert.equal(me.orgs.length, 1, 'signing up gives you a workshop of your own');
  assert.equal(me.orgs[0].role, 'owner');

  // The same link again is dead — a forwarded email is not a second session.
  const token = r.mail.sent.at(-1)!.text.match(/#([\w-]+)/)![1];
  const replay = await r.client().fetch('/v1/auth/consume', {
    method: 'POST', body: JSON.stringify({ token }), headers: { 'content-type': 'application/json' },
  });
  assert.equal(replay.status, 400);
  await r.stop();
});

test('an unknown address is answered exactly like a known one', async () => {
  const r = await rig();
  const known = await r.client().fetch('/v1/auth/request', {
    method: 'POST', body: JSON.stringify({ email: 'ada@example.com' }), headers: { 'content-type': 'application/json' },
  });
  const stranger = await r.client().fetch('/v1/auth/request', {
    method: 'POST', body: JSON.stringify({ email: 'nobody@example.com' }), headers: { 'content-type': 'application/json' },
  });
  // Same status, same empty body: the endpoint is not a directory of who
  // our customers are.
  assert.equal(known.status, 204);
  assert.equal(stranger.status, 204);
  await r.stop();
});

test('no cookie, no service; logging out is immediate', async () => {
  const r = await rig();
  assert.equal((await r.client().fetch('/v1/me')).status, 401);
  const client = await signedIn(r);
  assert.equal((await client.fetch('/v1/me')).status, 200);
  await client.fetch('/v1/auth/logout', { method: 'POST' });
  assert.equal((await client.fetch('/v1/me')).status, 401);
  await r.stop();
});

test('a cookie is not enough: writes must come from the Studio', async () => {
  const r = await rig();
  const client = await signedIn(r);
  const org = await orgOf(client);
  // The browser will happily attach the cookie to a form post from
  // anywhere; SameSite=Lax blocks most of it and this closes the rest.
  const forged = await client.fetch(`/v1/orgs/${org.id}/projects`, {
    method: 'POST', origin: 'https://evil.example', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Theirs' }),
  });
  assert.equal(forged.status, 403);
  // Reads are unaffected — there is nothing to forge.
  assert.equal((await client.fetch('/v1/me', { origin: 'https://evil.example' })).status, 200);
  await r.stop();
});

test('Google sign-in lands in the same account a magic link would', async () => {
  const r = await rig({ googleClientId: 'cid.apps.googleusercontent.com' }, {
    // The fake stands where Google's signature check stands; everything the
    // route does around it is real.
    verifyGoogleToken: async (cred) =>
      cred === 'tok-ada' ? { email: 'Ada@Example.com', name: 'Ada' } : null,
  });
  const google = (client: ReturnType<Rig['client']>, credential: string) =>
    client.fetch('/v1/auth/google', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });

  // The Studio discovers the button exists from config, not from a build.
  const cfg = await r.client().json<{ googleClientId: string | null }>('/v1/auth/config');
  assert.equal(cfg.googleClientId, 'cid.apps.googleusercontent.com');

  // A token the verifier rejects gets one uniform refusal.
  assert.equal((await google(r.client(), 'forged')).status, 400);

  // A verified token signs in: account, workshop, working session cookie.
  const ada = r.client();
  const signedUp = await google(ada, 'tok-ada');
  assert.equal(signedUp.status, 200);
  const body = await signedUp.json() as { user: { email: string }; orgs: Array<{ role: string }> };
  assert.equal(body.user.email, 'ada@example.com', 'normalised like every other email');
  assert.equal(body.orgs[0].role, 'owner');
  assert.equal((await ada.fetch('/v1/me')).status, 200);

  // Signing in again — or having first signed up by LINK — is the same
  // account: the verified email IS the identity, however it was proven.
  const again = r.client();
  await google(again, 'tok-ada');
  const one = await orgOf(ada);
  const two = await orgOf(again);
  assert.equal(one.id, two.id, 'one person, one workshop, not one per method');
  await r.stop();
});

test('without configuration, Google sign-in is a closed door', async () => {
  const r = await rig();
  const cfg = await r.client().json<{ googleClientId: string | null; turnstileSiteKey: string | null }>('/v1/auth/config');
  assert.equal(cfg.googleClientId, null);
  assert.equal(cfg.turnstileSiteKey, null);
  assert.equal((await r.client().fetch('/v1/auth/google', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'anything' }),
  })).status, 404);
  await r.stop();
});

test('the human check gates the link-sender when configured', async () => {
  const r = await rig({ turnstileSiteKey: 'site-key' }, {
    verifyTurnstile: async (token) => token === 'passed-the-check',
  });
  const ask = (payload: Record<string, string>) => r.client().fetch('/v1/auth/request', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  // No token, or a bad one → refused, and no email leaves.
  assert.equal((await ask({ email: 'ada@example.com' })).status, 403);
  assert.equal((await ask({ email: 'ada@example.com', turnstile: 'made-up' })).status, 403);
  assert.equal(r.mail.sent.length, 0);

  const ok = await ask({ email: 'ada@example.com', turnstile: 'passed-the-check' });
  assert.equal(ok.status, 204);
  assert.equal(r.mail.sent.length, 1);
  await r.stop();
});

test('one inbox cannot be flooded, whatever the check says', async () => {
  const r = await rig();
  const ask = (email: string) => r.client().fetch('/v1/auth/request', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  // Five links an hour per ADDRESS — plenty for a human retrying a typo,
  // useless for making a victim's phone buzz all afternoon. Another address
  // is unaffected, so the cap reveals nothing across inboxes.
  for (let i = 0; i < 5; i++) assert.equal((await ask('victim@example.com')).status, 204);
  assert.equal((await ask('victim@example.com')).status, 429);
  assert.equal((await ask('someone-else@example.com')).status, 204);
  assert.equal(r.mail.sent.filter((m) => m.to === 'victim@example.com').length, 5);
  await r.stop();
});

// ── projects and autosave ─────────────────────────────────────────────────

test('a project autosaves, and refuses to lose the newer copy', async () => {
  const r = await rig();
  const client = await signedIn(r);
  const org = await orgOf(client);
  const project = await newProject(client, org.id);

  const listed = await client.json<{ projects: Array<{ id: string; valid: boolean }> }>(
    `/v1/orgs/${org.id}/projects`);
  assert.equal(listed.projects.length, 1);
  assert.equal(listed.projects[0].valid, true, 'a complete manifest is publishable');

  // A second tab, still holding the revision it loaded, is told to re-read
  // rather than quietly winning.
  const stale = await client.fetch(`/v1/projects/${project.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: { ...MANIFEST, name: 'Stale' }, baseRevision: 1 }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { detail: { revision: number } }).detail.revision, project.revision);

  // An incomplete draft still saves — it is simply not publishable yet.
  const draft = await client.json<{ valid: boolean; errors: unknown[] }>(`/v1/projects/${project.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: { ...MANIFEST, units: 'inches' }, baseRevision: project.revision }),
  });
  assert.equal(draft.valid, false);
  assert.ok(draft.errors.length, 'and the merchant is told why');
  await r.stop();
});

test('a project belongs to its org and to nobody else', async () => {
  const r = await rig();
  const ada = await signedIn(r, 'ada@example.com');
  const project = await newProject(ada, (await orgOf(ada)).id);

  const eve = await signedIn(r, 'eve@example.com');
  // 404, not 403: a stranger must not be able to learn that the id is real.
  assert.equal((await eve.fetch(`/v1/projects/${project.id}`)).status, 404);
  assert.equal((await eve.fetch(`/v1/projects/${project.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: MANIFEST, baseRevision: 1 }),
  })).status, 404);
  await r.stop();
});

test('a viewer may read the product but not change it', async () => {
  const r = await rig();
  const ada = await signedIn(r, 'ada@example.com');
  const org = await orgOf(ada);
  const project = await newProject(ada, org.id);

  const bo = await signedIn(r, 'bo@example.com');
  await ada.fetch(`/v1/orgs/${org.id}/members`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'bo@example.com', role: 'viewer' }),
  });

  assert.equal((await bo.fetch(`/v1/projects/${project.id}`)).status, 200);
  const denied = await bo.fetch(`/v1/projects/${project.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: MANIFEST, baseRevision: project.revision }),
  });
  assert.equal(denied.status, 403);
  assert.equal((await bo.fetch(`/v1/projects/${project.id}/publications`, { method: 'POST', body: GLB })).status, 403);
  await r.stop();
});

test('the workspace model round-trips, and the same bytes cost one asset', async () => {
  const r = await rig();
  const client = await signedIn(r);
  const project = await newProject(client, (await orgOf(client)).id);

  const first = await client.json<{ assetId: string; sha256: string }>(
    `/v1/projects/${project.id}/model`, { method: 'POST', body: GLB });
  const again = await client.json<{ assetId: string }>(
    `/v1/projects/${project.id}/model`, { method: 'POST', body: GLB });
  assert.equal(again.assetId, first.assetId, 'autosaving an untouched model does not multiply storage');
  assert.equal(r.store.size(), 1);

  const back = await client.fetch(`/v1/projects/${project.id}/model`);
  assert.equal(back.status, 200);
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), new Uint8Array(GLB));
  await r.stop();
});

test('the dashboard thumbnail round-trips; strangers see nothing, viewers cannot write', async () => {
  const r = await rig();
  const ada = await signedIn(r, 'ada@example.com');
  const org = await orgOf(ada);
  const project = await newProject(ada, org.id);
  const projects = () => ada.json<{ projects: Array<{ hasThumb: boolean }> }>(`/v1/orgs/${org.id}/projects`);

  // Before a capture: the list says so, and the GET is an honest 404.
  assert.equal((await projects()).projects[0].hasThumb, false);
  assert.equal((await ada.fetch(`/v1/projects/${project.id}/thumbnail`)).status, 404);

  await ada.json(`/v1/projects/${project.id}/thumbnail`, { method: 'POST', body: PNG });
  assert.equal((await projects()).projects[0].hasThumb, true);
  const back = await ada.fetch(`/v1/projects/${project.id}/thumbnail`);
  assert.equal(back.status, 200);
  assert.equal(back.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), new Uint8Array(PNG));

  // A newer capture replaces the old picture on the very next read.
  const png2 = Buffer.concat([PNG, Buffer.from('v2')]);
  await ada.json(`/v1/projects/${project.id}/thumbnail`, { method: 'POST', body: png2 });
  const fresh = await ada.fetch(`/v1/projects/${project.id}/thumbnail`);
  assert.deepEqual(new Uint8Array(await fresh.arrayBuffer()), new Uint8Array(png2));

  // A viewer may look at the card like anyone else on the team, but a
  // thumbnail is still a write. A stranger learns nothing either way.
  const bo = await signedIn(r, 'bo@example.com');
  await ada.fetch(`/v1/orgs/${org.id}/members`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'bo@example.com', role: 'viewer' }),
  });
  assert.equal((await bo.fetch(`/v1/projects/${project.id}/thumbnail`)).status, 200);
  assert.equal((await bo.fetch(`/v1/projects/${project.id}/thumbnail`, { method: 'POST', body: PNG })).status, 403);
  const eve = await signedIn(r, 'eve@example.com');
  assert.equal((await eve.fetch(`/v1/projects/${project.id}/thumbnail`)).status, 404);
  assert.equal((await eve.fetch(`/v1/projects/${project.id}/thumbnail`, { method: 'POST', body: PNG })).status, 404);
  await r.stop();
});

test('the embed bundle is served where the pasted snippet says it is', async () => {
  // The Studio builds its snippet against the SERVICE's address, so these
  // paths are load-bearing on every storefront that ever pasted one. They
  // were 404 in production for weeks without a single test noticing, which
  // is the argument for this one.
  const dir = await mkdtemp(join(tmpdir(), 'embed-'));
  await writeFile(join(dir, 'embed.js'), 'export const mount = () => {};');
  await writeFile(join(dir, 'embed.css'), '.cfg { display: grid }');
  await writeFile(join(dir, 'embed-sans-TKQQJVUI.js'), 'export default 1;');
  process.env.EMBED_DIR = dir;

  const r = await rig();
  const shop = { origin: SHOP };

  const js = await r.client().fetch('/embed.js', shop);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /javascript/);
  // A module script is fetched cross-origin by the merchant's page, so CORS
  // applies to it — without this header the storefront gets nothing.
  assert.equal(js.headers.get('access-control-allow-origin'), '*');
  // A stable name whose contents change on deploy must not be immutable.
  assert.doesNotMatch(js.headers.get('cache-control') ?? '', /immutable/);

  const css = await r.client().fetch('/embed.css', shop);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/);

  // A hashed lazy chunk changes name whenever it changes, so it keeps.
  const chunk = await r.client().fetch('/embed-sans-TKQQJVUI.js', shop);
  assert.equal(chunk.status, 200);
  assert.match(chunk.headers.get('cache-control') ?? '', /immutable/);

  // Narrow on purpose: this route must not become a way to read the disk.
  assert.equal((await r.client().fetch('/embed.js.map', shop)).status, 404);
  assert.equal((await r.client().fetch('/main.ts', shop)).status, 404);
  assert.equal((await r.client().fetch('/health', { origin: null })).status, 200, 'and it shadows nothing');

  delete process.env.EMBED_DIR;
  await r.stop();
  await rm(dir, { recursive: true, force: true });
});

// ── publishing ────────────────────────────────────────────────────────────

test('publishing freezes the product; editing the draft afterwards does not reach it', async () => {
  const r = await rig();
  const client = await signedIn(r);
  const project = await newProject(client, (await orgOf(client)).id);

  const published = await client.json<{ publication: { id: string; version: number }; liveManifestUrl: string }>(
    `/v1/projects/${project.id}/publications`, { method: 'POST', body: GLB });
  assert.equal(published.publication.version, 1);

  // Frozen: the customer's URL keeps serving what was published, whatever
  // the merchant does to the draft next.
  const served = await (await r.client().fetch(
    `/p/${published.publication.id}/manifest.json`, { origin: SHOP })).json() as { name: string };
  assert.equal(served.name, 'Plate');

  const bumped = await client.json<{ revision: number }>(`/v1/projects/${project.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: { ...MANIFEST, name: 'Renamed mid-season' }, baseRevision: project.revision }),
  });
  const again = await (await r.client().fetch(
    `/p/${published.publication.id}/manifest.json`, { origin: SHOP })).json() as { name: string };
  assert.equal(again.name, 'Plate', 'February\'s order still renders February\'s product');

  // The live pointer, on the other hand, is exactly what moving means.
  const v2 = await client.json<{ publication: { id: string; version: number } }>(
    `/v1/projects/${project.id}/publications`, { method: 'POST', body: GLB });
  assert.equal(v2.publication.version, 2);
  assert.equal(bumped.revision, 3);
  const live = await (await r.client().fetch(
    `/e/${project.id}/manifest.json`, { origin: SHOP })).json() as { name: string };
  assert.equal(live.name, 'Renamed mid-season');

  // Rolling back re-points at bytes that already exist; nothing is rebuilt.
  await client.fetch(`/v1/projects/${project.id}/live`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicationId: published.publication.id }),
  });
  const rolled = await (await r.client().fetch(
    `/e/${project.id}/manifest.json`, { origin: SHOP })).json() as { name: string };
  assert.equal(rolled.name, 'Plate');
  await r.stop();
});

test('the cart can have its total checked against the frozen product', async () => {
  const r = await rig();
  const client = await signedIn(r);
  const project = await newProject(client, (await orgOf(client)).id, PRICED);
  const { publication } = await client.json<{ publication: { id: string } }>(
    `/v1/projects/${project.id}/publications`, { method: 'POST', body: GLB });

  // A merchant's SERVER calls this: no cookie, no Origin header at all.
  const price = async (selections: Record<string, string>, origin: string | null = null) =>
    r.client().fetch(`/p/${publication.id}/price`, {
      method: 'POST', origin, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selections }),
    });

  const empty = await (await price({})).json() as { deltaTotal: number; currency: string };
  assert.equal(empty.deltaTotal, 0, 'the default configuration is the base price');
  assert.equal(empty.currency, 'SGD');

  const full = await (await price({
    'body-colour': '#FF5733', stand: 'yes', 'body-text': 'MIA',
  })).json() as { deltaTotal: number; priceDeltas: Array<{ optionId: string; amount: number }>; version: number };
  assert.equal(full.deltaTotal, 35 + 24 + 3 * 2, 'custom colour + stand + three characters');
  assert.equal(full.version, 1);

  // The whole point: a shopper who edits the numbers on the way to the cart
  // gets the service's arithmetic, not their own. Prices are never READ from
  // the request — only option ids and values are.
  const forged = await (await price({ stand: 'yes', priceDeltas: '0', deltaTotal: '0' } as never))
    .json() as { deltaTotal: number };
  assert.equal(forged.deltaTotal, 24);

  // A swatch the palette does not offer resolves to no colour, so it charges
  // nothing and — the point — cannot stand in for one that does cost money.
  const bronze = await (await price({ 'body-colour': 'bronze' })).json() as
    { deltaTotal: number; priceDeltas: unknown[] };
  assert.equal(bronze.deltaTotal, 4);
  const invented = await (await price({ 'body-colour': 'free-gold' })).json() as
    { deltaTotal: number; priceDeltas: unknown[]; selections: Record<string, string> };
  assert.equal(invented.deltaTotal, 0);
  assert.deepEqual(invented.priceDeltas, [], 'an id nobody offers buys nothing');
  // Echoed rather than silently swapped for a real swatch: the merchant sees
  // what the service made of the submission and can spot the nonsense.
  assert.equal(invented.selections['body-colour'], 'free-gold');

  // Bad input is refused rather than priced as zero, and an unknown
  // publication is a 404 like every other id.
  assert.equal((await r.client().fetch(`/p/${publication.id}/price`, {
    method: 'POST', origin: null, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selections: 'all of them' }),
  })).status, 400);
  assert.equal((await price({}, SHOP)).status, 200, 'a browser may ask too — nothing here is secret');
  assert.equal((await r.client().fetch('/p/pub_nope/price', {
    method: 'POST', origin: null, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selections: {} }),
  })).status, 404);
  await r.stop();
});

test('a published manifest names its own frozen version, so an order can pin it', async () => {
  const r = await rig();
  const client = await signedIn(r);
  const project = await newProject(client, (await orgOf(client)).id, PRICED);
  const { publication } = await client.json<{ publication: { id: string } }>(
    `/v1/projects/${project.id}/publications`, { method: 'POST', body: GLB });

  // The embed reads `uploads.publication` and puts it in every payload; it is
  // what the merchant's backend posts to /price.
  const served = await (await r.client().fetch(
    `/e/${project.id}/manifest.json`, { origin: SHOP })).json() as
    { uploads: { publication: string } };
  assert.equal(served.uploads.publication, publication.id);
  await r.stop();
});

test('a product that does not validate cannot be published', async () => {
  const r = await rig();
  const client = await signedIn(r);
  const project = await newProject(client, (await orgOf(client)).id, { ...MANIFEST, units: 'inches' });
  const res = await client.fetch(`/v1/projects/${project.id}/publications`, { method: 'POST', body: GLB });
  assert.equal(res.status, 422);
  assert.ok((await res.json() as { detail: unknown[] }).detail.length, 'and is told what is wrong');
  // Unpublished, so the storefront URL has nothing to serve.
  assert.equal((await r.client().fetch(`/e/${project.id}/manifest.json`, { origin: SHOP })).status, 404);
  await r.stop();
});

test('the model is served beside its manifest, so a relative url resolves', async () => {
  const r = await rig();
  const client = await signedIn(r);
  const project = await newProject(client, (await orgOf(client)).id);
  const published = await client.json<{ publication: { id: string } }>(
    `/v1/projects/${project.id}/publications`, { method: 'POST', body: GLB });

  const manifest = await (await r.client().fetch(
    `/p/${published.publication.id}/manifest.json`, { origin: SHOP })).json() as {
      models: Array<{ url: string }>; uploads: { url: string; publication: string };
    };
  assert.equal(manifest.models[0].url, 'model.glb', 'no CDN configured, so the relative url stands');
  // The served copy also names the upload endpoint. Its presence is what
  // tells the embed to post artwork rather than inline it — and it is
  // injected here, not stored, so the frozen publication stays frozen.
  assert.equal(manifest.uploads.publication, published.publication.id);
  assert.equal(manifest.uploads.url, 'http://api.test/v1/uploads');
  const model = await r.client().fetch(`/p/${published.publication.id}/model.glb`, { origin: SHOP });
  assert.equal(model.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(new Uint8Array(await model.arrayBuffer()), new Uint8Array(GLB));
  await r.stop();
});

test('the origin allowlist decides which storefronts may embed the product', async () => {
  const r = await rig();
  const client = await signedIn(r);
  const project = await newProject(client, (await orgOf(client)).id);
  const published = await client.json<{ publication: { id: string } }>(
    `/v1/projects/${project.id}/publications`, { method: 'POST', body: GLB });
  const url = `/p/${published.publication.id}/manifest.json`;

  // A new project is open: nobody's first integration should fail on a
  // setting they have not been told about.
  assert.equal((await r.client().fetch(url, { origin: 'https://anyone.example' })).status, 200);

  await client.fetch(`/v1/projects/${project.id}/origins`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ origins: ['https://shop.example.com/products/plate'] }),
  });
  const stored = await client.json<{ origins: string[] }>(`/v1/projects/${project.id}/origins`);
  assert.deepEqual(stored.origins, [SHOP], 'a pasted page URL is kept as its origin');

  const allowed = await r.client().fetch(url, { origin: SHOP });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), '*');
  assert.equal((await r.client().fetch(url, { origin: 'https://copycat.example' })).status, 403);
  await r.stop();
});

// ── customer artwork ──────────────────────────────────────────────────────

test('artwork goes to the service and comes back as an id, not a data URL', async () => {
  const r = await rig();
  const client = await signedIn(r);
  const project = await newProject(client, (await orgOf(client)).id);
  const published = await client.json<{ publication: { id: string } }>(
    `/v1/projects/${project.id}/publications`, { method: 'POST', body: GLB });
  const pub = published.publication.id;

  const shopper = r.client();
  const up = await shopper.json<{ id: string; url: string; contentType: string }>(
    `/v1/uploads?publication=${pub}&option=body-image`,
    { method: 'POST', body: PNG, origin: SHOP });
  assert.match(up.id, /^upl_/);
  assert.equal(up.contentType, 'image/png');
  // Short enough for a cart line-item property, which the image itself
  // could never be.
  assert.ok(up.url.length < 120, up.url);

  const back = await r.client().fetch(`/u/${up.id}`, { origin: SHOP });
  assert.equal(back.status, 200);
  assert.equal(back.headers.get('content-type'), 'image/png');
  // Locked down: the browser must not second-guess the type, and the
  // response is inert even if something ever did slip past the sniffer.
  assert.equal(back.headers.get('x-content-type-options'), 'nosniff');
  assert.match(back.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), new Uint8Array(PNG));
  await r.stop();
});

test('an upload is checked against the very product it claims to belong to', async () => {
  const r = await rig();
  const client = await signedIn(r);
  const project = await newProject(client, (await orgOf(client)).id);
  const published = await client.json<{ publication: { id: string } }>(
    `/v1/projects/${project.id}/publications`, { method: 'POST', body: GLB });
  const pub = published.publication.id;
  const post = (query: string, body: Buffer, origin: string = SHOP) =>
    r.client().fetch(`/v1/uploads?${query}`, { method: 'POST', body, origin });

  // The declared type is a claim by the caller; the bytes are the fact.
  const lying = await post(`publication=${pub}&option=body-image`, Buffer.from('<svg onload=alert(1)>-------'));
  assert.equal(lying.status, 422);

  // This zone takes PNG only, and says so.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20)]);
  const wrongType = await post(`publication=${pub}&option=body-image`, jpeg);
  assert.equal(wrongType.status, 422);
  assert.match((await wrongType.json() as { message: string }).message, /image\/png/);

  assert.equal((await post(`publication=${pub}&option=nope`, PNG)).status, 404);
  assert.equal((await post('publication=pub_nothing&option=body-image', PNG)).status, 404);

  // The merchant's allowlist governs uploads too, not just reads.
  await client.fetch(`/v1/projects/${project.id}/origins`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ origins: [SHOP] }),
  });
  assert.equal((await post(`publication=${pub}&option=body-image`, PNG, 'https://copycat.example')).status, 403);
  await r.stop();
});

test('a zone that allows 400 kB does not allow a megabyte', async () => {
  const r = await rig();
  const client = await signedIn(r);
  const project = await newProject(client, (await orgOf(client)).id);
  const published = await client.json<{ publication: { id: string } }>(
    `/v1/projects/${project.id}/publications`, { method: 'POST', body: GLB });

  // The limit is the ZONE's, read from the manifest the customer is looking
  // at — not one global number for every merchant on the platform.
  const huge = Buffer.concat([PNG, Buffer.alloc(500_000)]);
  const res = await r.client().fetch(
    `/v1/uploads?publication=${published.publication.id}&option=body-image`,
    { method: 'POST', body: huge, origin: SHOP });
  assert.equal(res.status, 413);
  await r.stop();
});
