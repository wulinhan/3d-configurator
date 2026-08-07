// The data layer against real Postgres: tenancy, optimistic concurrency,
// single-use links, immutable publications, and the cascades that make
// "delete my account" mean it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanConnectionString } from '../src/sql.ts';
import { harness } from './harness.ts';
import { newToken, hashToken } from '../src/ids.ts';
import { ApiError } from '../src/errors.ts';
import {
  createUser, findUserByEmail, createOrg, addMember, removeMember, membershipsOf, membersOf,
  roleIn, roleAtLeast, normaliseEmail,
  createLoginToken, consumeLoginToken, createSession, userForSession, deleteSession,
  putAsset, createProject, projectFor, listProjects, saveProject, pruneRevisions,
  setProjectModel, archiveProject,
  createPublication, getPublication, livePublication, listPublications, setLivePublication,
  setOrigins, listOrigins, originsForPublication,
  createUpload, claimUploads, pruneUnclaimedUploads, pruneExpiredSessions,
} from '../src/store.ts';

const MANIFEST = { schema: 1, id: 'plate', name: 'Plate', units: 'mm', parts: [], options: [], pricing: { currency: 'SGD' } };

/** A signed-in merchant with an org — the starting point of most tests. */
async function merchant(h: Awaited<ReturnType<typeof harness>>, email = 'ada@example.com') {
  const now = h.clock.now();
  const user = await createUser(h.sql, email, now);
  const org = await createOrg(h.sql, `${email}'s workshop`, now);
  await addMember(h.sql, org.id, user.id, 'owner', now);
  return { user, org };
}

test('the connection string is recovered from whatever was pasted', () => {
  const URL_ = 'postgresql://user:pw@ep-x-pooler.ap-southeast-1.aws.neon.tech/db?sslmode=require';
  // A clean paste passes through untouched and unflagged.
  assert.deepEqual(cleanConnectionString(URL_), { url: URL_, cleaned: false });
  // The three paste accidents a real deploy actually hit: an .env-style
  // prefix, a psql snippet's quotes, and console label text with a newline.
  for (const mangled of [
    `DATABASE_URL=${URL_}`,
    `'${URL_}'`,
    `"${URL_}"\n`,
    `Database\n${URL_}`,
    `psql '${URL_}'`,
    `  ${URL_}  `,
  ]) {
    assert.deepEqual(cleanConnectionString(mangled), { url: URL_, cleaned: true }, JSON.stringify(mangled));
  }
  // The short scheme spelling is a URL too.
  assert.equal(cleanConnectionString('postgres://u:p@h.example.com/db').cleaned, false);
  // No URL inside at all: hand back the trimmed text so the boot diagnostics
  // can name what they actually got.
  assert.deepEqual(cleanConnectionString('  base  '), { url: 'base', cleaned: true });
});

test('an email is one account however it is typed', async () => {
  const h = await harness();
  await createUser(h.sql, '  Ada@Example.COM ', h.clock.now());
  assert.equal(normaliseEmail(' ADA@example.com '), 'ada@example.com');
  const found = await findUserByEmail(h.sql, 'ada@EXAMPLE.com');
  assert.ok(found, 'a differently-cased address finds the same user');
  // The unique index is the real guarantee, not the normaliser.
  await assert.rejects(() => createUser(h.sql, 'ADA@example.com', h.clock.now()));
  await h.close();
});

test('a magic link is single-use and short-lived', async () => {
  const h = await harness();
  const token = newToken();
  await createLoginToken(h.sql, 'ada@example.com', token, h.clock.now(), 15 * 60_000);

  // Only the hash is stored — a database dump cannot be replayed into an
  // account, which is the whole reason for hashing a login token.
  const { rows } = await h.sql.query<{ token_hash: string }>('select token_hash from login_tokens');
  assert.equal(rows[0].token_hash, hashToken(token));
  assert.notEqual(rows[0].token_hash, token);

  const first = await consumeLoginToken(h.sql, token, h.clock.now());
  assert.equal(first?.email, 'ada@example.com');
  // Spent. A forwarded email, or a link-prefetching mail client, gets nothing.
  assert.equal(await consumeLoginToken(h.sql, token, h.clock.now()), null);

  const stale = newToken();
  await createLoginToken(h.sql, 'ada@example.com', stale, h.clock.now(), 15 * 60_000);
  h.clock.advance(16 * 60_000);
  assert.equal(await consumeLoginToken(h.sql, stale, h.clock.now()), null, 'expired');
  await h.close();
});

test('an invitation carries the org and role through the link', async () => {
  const h = await harness();
  const { org } = await merchant(h);
  const token = newToken();
  await createLoginToken(h.sql, 'bo@example.com', token, h.clock.now(), 60_000, { orgId: org.id, role: 'editor' });
  const spent = await consumeLoginToken(h.sql, token, h.clock.now());
  assert.deepEqual(spent?.invite, { orgId: org.id, role: 'editor' });
  await h.close();
});

test('a session resolves to its user until it expires, and logout is immediate', async () => {
  const h = await harness();
  const { user } = await merchant(h);
  const token = newToken();
  await createSession(h.sql, user.id, token, h.clock.now(), 30 * 24 * 3600_000);

  assert.equal((await userForSession(h.sql, token, h.clock.now()))?.email, 'ada@example.com');
  assert.equal(await userForSession(h.sql, newToken(), h.clock.now()), null, 'a made-up token is nobody');

  await deleteSession(h.sql, token);
  assert.equal(await userForSession(h.sql, token, h.clock.now()), null);

  // An expired session stops resolving but is not destroyed on read: only
  // the janitor deletes, so a clock skew cannot log a merchant out for good.
  const other = newToken();
  await createSession(h.sql, user.id, other, h.clock.now(), 1000);
  h.clock.advance(2000);
  assert.equal(await userForSession(h.sql, other, h.clock.now()), null);
  assert.equal(await pruneExpiredSessions(h.sql, h.clock.now()), 1);
  await h.close();
});

test('roles rank, and an org can never be left without an owner', async () => {
  const h = await harness();
  const { user, org } = await merchant(h);
  const bo = await createUser(h.sql, 'bo@example.com', h.clock.now());
  await addMember(h.sql, org.id, bo.id, 'viewer', h.clock.now());

  assert.ok(roleAtLeast('owner', 'editor'));
  assert.ok(roleAtLeast('editor', 'editor'));
  assert.ok(!roleAtLeast('viewer', 'editor'));
  assert.ok(!roleAtLeast(null, 'viewer'));
  assert.equal(await roleIn(h.sql, org.id, bo.id), 'viewer');

  // Re-inviting an existing member changes their role rather than failing.
  await addMember(h.sql, org.id, bo.id, 'editor', h.clock.now());
  assert.equal(await roleIn(h.sql, org.id, bo.id), 'editor');
  assert.equal((await membersOf(h.sql, org.id)).length, 2);

  await assert.rejects(() => removeMember(h.sql, org.id, user.id), (e: ApiError) => e.status === 409);
  await addMember(h.sql, org.id, bo.id, 'owner', h.clock.now());
  await removeMember(h.sql, org.id, user.id);
  assert.equal(await roleIn(h.sql, org.id, user.id), null);
  await h.close();
});

test('a project is invisible to anyone outside its org', async () => {
  const h = await harness();
  const { user, org } = await merchant(h);
  const stranger = await createUser(h.sql, 'eve@example.com', h.clock.now());
  const own = await createOrg(h.sql, 'Eve Ltd', h.clock.now());
  await addMember(h.sql, own.id, stranger.id, 'owner', h.clock.now());

  const project = await createProject(h.sql, org.id, 'Plate', MANIFEST, h.clock.now());
  assert.equal((await projectFor(h.sql, project.id, user.id))?.role, 'owner');
  // Not a 403 — a stranger cannot even learn that the id is real.
  assert.equal(await projectFor(h.sql, project.id, stranger.id), null);
  assert.equal((await listProjects(h.sql, org.id, stranger.id)).length, 0);
  assert.equal((await listProjects(h.sql, org.id, user.id)).length, 1);
  await h.close();
});

test('autosave refuses to overwrite a newer revision', async () => {
  const h = await harness();
  const { user, org } = await merchant(h);
  const project = await createProject(h.sql, org.id, 'Plate', MANIFEST, h.clock.now());
  assert.equal(project.revision, 1);

  const saved = await saveProject(h.sql,
    project.id, { manifest: { ...MANIFEST, name: 'One' }, valid: true, baseRevision: 1, authorId: user.id },
    h.clock.now());
  assert.equal(saved.revision, 2);
  assert.equal(saved.valid, true);

  // A second tab still holding revision 1 is told to re-read rather than
  // quietly winning: this is a morning's work, not a merge conflict.
  await assert.rejects(
    () => saveProject(h.sql, project.id,
      { manifest: { ...MANIFEST, name: 'Stale' }, valid: true, baseRevision: 1, authorId: user.id }, h.clock.now()),
    (e: ApiError) => e.status === 409 && (e.detail as { revision: number }).revision === 2);

  const fresh = await projectFor(h.sql, project.id, user.id);
  assert.equal((fresh!.manifest as { name: string }).name, 'One');
  await h.close();
});

test('history is kept, and kept bounded', async () => {
  const h = await harness();
  const { user, org } = await merchant(h);
  const project = await createProject(h.sql, org.id, 'Plate', MANIFEST, h.clock.now());
  for (let i = 0; i < 12; i++) {
    await saveProject(h.sql, project.id,
      { manifest: { ...MANIFEST, name: `v${i}` }, valid: true, baseRevision: i + 1, authorId: user.id },
      h.clock.now());
  }
  const all = await h.sql.query<{ n: string }>('select count(*) as n from project_revisions');
  assert.equal(Number(all.rows[0].n), 12);
  await pruneRevisions(h.sql, project.id, 5);
  const kept = await h.sql.query<{ revision: number }>(
    'select revision from project_revisions order by revision');
  assert.equal(kept.rows.length, 5);
  assert.equal(kept.rows[kept.rows.length - 1].revision, 13, 'the newest survives');
  await h.close();
});

test('the same bytes saved twice are one asset', async () => {
  const h = await harness();
  const { org } = await merchant(h);
  const spec = { sha256: 'a'.repeat(64), kind: 'model' as const, contentType: 'model/gltf-binary', bytes: 1024, storageKey: 'assets/x' };
  const first = await putAsset(h.sql, org.id, spec, h.clock.now());
  const again = await putAsset(h.sql, org.id, spec, h.clock.now());
  assert.equal(first.id, again.id, 'autosaving an untouched model does not multiply storage');

  // The same file in a DIFFERENT org is a different row: deduping across
  // tenants would let one merchant probe for another merchant's files.
  const other = await createOrg(h.sql, 'Other', h.clock.now());
  const theirs = await putAsset(h.sql, other.id, spec, h.clock.now());
  assert.notEqual(theirs.id, first.id);
  await h.close();
});

test('publishing freezes a version and moves the live pointer', async () => {
  const h = await harness();
  const { user, org } = await merchant(h);
  const project = await createProject(h.sql, org.id, 'Plate', MANIFEST, h.clock.now());
  const glb = await putAsset(h.sql, org.id,
    { sha256: 'b'.repeat(64), kind: 'model', contentType: 'model/gltf-binary', bytes: 900, storageKey: 'k1' }, h.clock.now());

  const v1 = await createPublication(h.sql, project.id, { ...MANIFEST, name: 'First' }, glb.id, user.id, h.clock.now());
  assert.equal(v1.version, 1);
  assert.equal((await livePublication(h.sql, project.id))?.id, v1.id);

  // Editing the draft afterwards must not reach the published copy — an
  // order placed against v1 has to keep rendering v1 forever.
  await saveProject(h.sql, project.id,
    { manifest: { ...MANIFEST, name: 'Draft edits' }, valid: true, baseRevision: 1, authorId: user.id }, h.clock.now());
  assert.equal(((await getPublication(h.sql, v1.id))!.manifest as { name: string }).name, 'First');

  const v2 = await createPublication(h.sql, project.id, { ...MANIFEST, name: 'Second' }, glb.id, user.id, h.clock.now());
  assert.equal(v2.version, 2);
  assert.equal((await livePublication(h.sql, project.id))?.version, 2);
  assert.deepEqual((await listPublications(h.sql, project.id)).map((p) => p.version), [2, 1]);

  // Rollback re-points at bytes that already exist; nothing is rebuilt.
  await setLivePublication(h.sql, project.id, v1.id, h.clock.now());
  assert.equal((await livePublication(h.sql, project.id))?.version, 1);
  await assert.rejects(() => setLivePublication(h.sql, project.id, 'pub_nope', h.clock.now()),
    (e: ApiError) => e.status === 404);

  // An archived project stops serving, without deleting what it published.
  await archiveProject(h.sql, project.id, h.clock.now());
  assert.equal(await livePublication(h.sql, project.id), null);
  assert.ok(await getPublication(h.sql, v1.id));
  await h.close();
});

test('the embed allowlist belongs to the product, not to one version', async () => {
  const h = await harness();
  const { user, org } = await merchant(h);
  const project = await createProject(h.sql, org.id, 'Plate', MANIFEST, h.clock.now());
  const glb = await putAsset(h.sql, org.id,
    { sha256: 'c'.repeat(64), kind: 'model', contentType: 'model/gltf-binary', bytes: 1, storageKey: 'k2' }, h.clock.now());
  const pub = await createPublication(h.sql, project.id, MANIFEST, glb.id, user.id, h.clock.now());

  assert.deepEqual(await listOrigins(h.sql, project.id), [], 'a new project starts open');
  await setOrigins(h.sql, project.id, ['https://shop.example.com', 'https://www.shop.example.com'], h.clock.now());
  assert.equal((await originsForPublication(h.sql, pub.id)).length, 2);
  // Setting replaces rather than appends, so removing a domain removes it.
  await setOrigins(h.sql, project.id, ['https://shop.example.com'], h.clock.now());
  assert.deepEqual(await originsForPublication(h.sql, pub.id), ['https://shop.example.com']);
  await h.close();
});

test('unclaimed uploads are swept; ordered ones are kept', async () => {
  const h = await harness();
  const { user, org } = await merchant(h);
  const project = await createProject(h.sql, org.id, 'Plate', MANIFEST, h.clock.now());
  const glb = await putAsset(h.sql, org.id,
    { sha256: 'd'.repeat(64), kind: 'model', contentType: 'model/gltf-binary', bytes: 1, storageKey: 'k3' }, h.clock.now());
  const pub = await createPublication(h.sql, project.id, MANIFEST, glb.id, user.id, h.clock.now());

  const art = async (n: string) => putAsset(h.sql, org.id,
    { sha256: n.repeat(64), kind: 'image', contentType: 'image/png', bytes: 2048, storageKey: `art/${n}` }, h.clock.now());
  const ordered = await createUpload(h.sql, pub.id, 'body-image', (await art('1')).id, h.clock.now());
  const abandoned = await createUpload(h.sql, pub.id, 'body-image', (await art('2')).id, h.clock.now());

  assert.equal(await claimUploads(h.sql, [ordered.id], h.clock.now()), 1);
  h.clock.advance(25 * 3600_000);
  const swept = await pruneUnclaimedUploads(h.sql, new Date(h.clock.now().getTime() - 24 * 3600_000));
  assert.deepEqual(swept, ['art/2'], 'the janitor hands back the storage keys so the bytes go too');

  const left = await h.sql.query<{ id: string }>('select id from uploads');
  assert.deepEqual(left.rows.map((r) => r.id), [ordered.id]);
  assert.ok(abandoned.id);
  await h.close();
});

test('deleting an org deletes everything it owns', async () => {
  const h = await harness();
  const { user, org } = await merchant(h);
  const project = await createProject(h.sql, org.id, 'Plate', MANIFEST, h.clock.now());
  const glb = await putAsset(h.sql, org.id,
    { sha256: 'e'.repeat(64), kind: 'model', contentType: 'model/gltf-binary', bytes: 1, storageKey: 'k4' }, h.clock.now());
  await setProjectModel(h.sql, project.id, glb.id, h.clock.now());
  const pub = await createPublication(h.sql, project.id, MANIFEST, glb.id, user.id, h.clock.now());
  await createUpload(h.sql, pub.id, 'body-image', glb.id, h.clock.now());
  await setOrigins(h.sql, project.id, ['https://shop.example.com'], h.clock.now());
  await saveProject(h.sql, project.id, { manifest: MANIFEST, valid: true, baseRevision: 1, authorId: user.id }, h.clock.now());

  await h.sql.query('delete from orgs where id = $1', [org.id]);
  for (const table of ['projects', 'publications', 'uploads', 'assets', 'project_origins', 'project_revisions', 'memberships']) {
    const { rows } = await h.sql.query<{ n: string }>(`select count(*) as n from ${table}`);
    assert.equal(Number(rows[0].n), 0, `${table} should be empty after the org goes`);
  }
  // The person survives their workshop; they may belong to others.
  const { rows } = await h.sql.query<{ n: string }>('select count(*) as n from users');
  assert.equal(Number(rows[0].n), 1);
  await h.close();
});
