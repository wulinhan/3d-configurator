// Every query the service makes, in one place.
//
// The important convention: anything scoped to a merchant takes the acting
// USER and joins `memberships` in SQL rather than checking ownership in a
// handler afterwards. A forgotten `if (project.orgId !== ...)` is the classic
// way a multi-tenant service leaks; here there is no such line to forget,
// because a non-member's query simply returns no rows.

import type { Sql } from './sql.ts';
import { newId, hashToken } from './ids.ts';
import { conflict, notFound } from './errors.ts';

export type Role = 'owner' | 'editor' | 'viewer';

/** Ranked so a check can ask for "editor or better" without a lookup table. */
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
export const roleAtLeast = (have: Role | null | undefined, need: Role): boolean =>
  !!have && RANK[have] >= RANK[need];

export interface User { id: string; email: string; name: string | null }
export interface Org { id: string; name: string }
export interface Membership { org: Org; role: Role }

// ── users, orgs, membership ───────────────────────────────────────────────

/** Emails are matched lowercased and trimmed; "Ada@Example.com " and
 * "ada@example.com" are one account, not two. */
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

export async function findUserByEmail(sql: Sql, email: string): Promise<User | null> {
  const { rows } = await sql.query<User>(
    'select id, email, name from users where email = $1', [normaliseEmail(email)]);
  return rows[0] ?? null;
}

export async function createUser(sql: Sql, email: string, now: Date, name?: string): Promise<User> {
  const id = newId('usr');
  const { rows } = await sql.query<User>(
    `insert into users (id, email, name, created_at, last_seen_at)
     values ($1, $2, $3, $4, $4) returning id, email, name`,
    [id, normaliseEmail(email), name ?? null, now]);
  return rows[0];
}

export async function createOrg(sql: Sql, name: string, now: Date): Promise<Org> {
  const id = newId('org');
  const { rows } = await sql.query<Org>(
    'insert into orgs (id, name, created_at) values ($1, $2, $3) returning id, name', [id, name, now]);
  return rows[0];
}

export async function addMember(sql: Sql, orgId: string, userId: string, role: Role, now: Date): Promise<void> {
  await sql.query(
    `insert into memberships (org_id, user_id, role, created_at) values ($1, $2, $3, $4)
     on conflict (org_id, user_id) do update set role = excluded.role`,
    [orgId, userId, role, now]);
}

export async function removeMember(sql: Sql, orgId: string, userId: string): Promise<void> {
  // An org without an owner is an org nobody can administer, so the last one
  // cannot be removed — the caller must hand the role over first.
  const { rows } = await sql.query<{ owners: string }>(
    `select count(*) as owners from memberships where org_id = $1 and role = 'owner'`, [orgId]);
  const { rows: mine } = await sql.query<{ role: Role }>(
    'select role from memberships where org_id = $1 and user_id = $2', [orgId, userId]);
  if (mine[0]?.role === 'owner' && Number(rows[0].owners) <= 1) {
    throw conflict('the last owner cannot be removed — make someone else an owner first');
  }
  await sql.query('delete from memberships where org_id = $1 and user_id = $2', [orgId, userId]);
}

export async function membershipsOf(sql: Sql, userId: string): Promise<Membership[]> {
  const { rows } = await sql.query<{ id: string; name: string; role: Role }>(
    `select o.id, o.name, m.role from memberships m
     join orgs o on o.id = m.org_id where m.user_id = $1 order by o.name`, [userId]);
  return rows.map((r) => ({ org: { id: r.id, name: r.name }, role: r.role }));
}

export async function roleIn(sql: Sql, orgId: string, userId: string): Promise<Role | null> {
  const { rows } = await sql.query<{ role: Role }>(
    'select role from memberships where org_id = $1 and user_id = $2', [orgId, userId]);
  return rows[0]?.role ?? null;
}

export async function membersOf(sql: Sql, orgId: string): Promise<Array<User & { role: Role }>> {
  const { rows } = await sql.query<User & { role: Role }>(
    `select u.id, u.email, u.name, m.role from memberships m
     join users u on u.id = m.user_id where m.org_id = $1 order by u.email`, [orgId]);
  return rows;
}

// ── sign-in ───────────────────────────────────────────────────────────────

export interface LoginInvite { orgId: string; role: Role }

export async function createLoginToken(
  sql: Sql, email: string, token: string, now: Date, ttlMs: number, invite?: LoginInvite,
): Promise<void> {
  await sql.query(
    `insert into login_tokens (id, token_hash, email, invite_org, invite_role, created_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [newId('lgn'), hashToken(token), normaliseEmail(email), invite?.orgId ?? null, invite?.role ?? null,
      now, new Date(now.getTime() + ttlMs)]);
}

/**
 * Spend a magic link.
 *
 * Single-use by construction: the update only matches rows that are unused
 * and unexpired, so two browsers racing the same link produce one winner and
 * one 401 — no read-then-write window to lose.
 */
export async function consumeLoginToken(
  sql: Sql, token: string, now: Date,
): Promise<{ email: string; invite: LoginInvite | null } | null> {
  const { rows } = await sql.query<{ email: string; invite_org: string | null; invite_role: Role | null }>(
    `update login_tokens set used_at = $2
     where token_hash = $1 and used_at is null and expires_at > $2
     returning email, invite_org, invite_role`,
    [hashToken(token), now]);
  const row = rows[0];
  if (!row) return null;
  return {
    email: row.email,
    invite: row.invite_org && row.invite_role ? { orgId: row.invite_org, role: row.invite_role } : null,
  };
}

export async function createSession(sql: Sql, userId: string, token: string, now: Date, ttlMs: number): Promise<string> {
  const id = newId('ses');
  await sql.query(
    `insert into sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at)
     values ($1, $2, $3, $4, $5, $4)`,
    [id, hashToken(token), userId, now, new Date(now.getTime() + ttlMs)]);
  return id;
}

/** Resolve a session cookie to its user, refreshing `last_seen_at`. Expired
 * sessions resolve to null without being deleted — the janitor sweeps them,
 * so a clock skew cannot destroy a live session. */
export async function userForSession(sql: Sql, token: string, now: Date): Promise<User | null> {
  const { rows } = await sql.query<User>(
    `update sessions set last_seen_at = $2 where token_hash = $1 and expires_at > $2
     returning (select id from users where users.id = sessions.user_id) as id,
               (select email from users where users.id = sessions.user_id) as email,
               (select name from users where users.id = sessions.user_id) as name`,
    [hashToken(token), now]);
  return rows[0] ?? null;
}

export async function deleteSession(sql: Sql, token: string): Promise<void> {
  await sql.query('delete from sessions where token_hash = $1', [hashToken(token)]);
}

// ── assets ────────────────────────────────────────────────────────────────

export interface Asset {
  id: string; org_id: string; sha256: string; kind: 'model' | 'image';
  content_type: string; bytes: string | number; storage_key: string;
}

/**
 * Record a blob, or return the one already recorded.
 *
 * The same model saved twice is one row and one object — content addressing
 * means a merchant who autosaves fifty times without touching the geometry
 * pays for one GLB, not fifty.
 */
export async function putAsset(
  sql: Sql, org: string, a: { sha256: string; kind: 'model' | 'image'; contentType: string; bytes: number; storageKey: string },
  now: Date,
): Promise<Asset> {
  await sql.query(
    `insert into assets (id, org_id, sha256, kind, content_type, bytes, storage_key, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (org_id, sha256) do nothing`,
    [newId('ast'), org, a.sha256, a.kind, a.contentType, a.bytes, a.storageKey, now]);
  const { rows } = await sql.query<Asset>(
    'select * from assets where org_id = $1 and sha256 = $2', [org, a.sha256]);
  return rows[0];
}

export async function getAsset(sql: Sql, id: string): Promise<Asset | null> {
  const { rows } = await sql.query<Asset>('select * from assets where id = $1', [id]);
  return rows[0] ?? null;
}

// ── projects ──────────────────────────────────────────────────────────────

export interface ProjectRow {
  id: string; org_id: string; name: string; manifest: unknown;
  model_asset_id: string | null; live_publication_id: string | null;
  thumb_asset_id: string | null;
  revision: number; valid: boolean;
  created_at: Date; updated_at: Date; archived_at: Date | null;
}

export async function createProject(
  sql: Sql, orgId: string, name: string, manifest: unknown, now: Date,
): Promise<ProjectRow> {
  const { rows } = await sql.query<ProjectRow>(
    `insert into projects (id, org_id, name, manifest, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $5) returning *`,
    [newId('prj'), orgId, name, JSON.stringify(manifest), now]);
  return rows[0];
}

/**
 * A project the user may see, or null; the joins ARE the permission check
 * (see the note at the top of this file).
 *
 * Two doors in: an org membership, or a per-project share. Whichever grants
 * MORE wins, so sharing "viewer" with your own org's editor demotes nobody,
 * and an org viewer handed an editor share genuinely gets to edit that one
 * project. A user with neither simply gets no rows.
 */
export async function projectFor(sql: Sql, projectId: string, userId: string): Promise<(ProjectRow & { role: Role }) | null> {
  const { rows } = await sql.query<ProjectRow & { role: Role }>(
    `select p.*,
       (case when m.role = 'owner' then 'owner'
             when 'editor' in (m.role, s.role) then 'editor'
             else coalesce(m.role, s.role) end)::text as role
     from projects p
     left join memberships m on m.org_id = p.org_id and m.user_id = $2
     left join project_shares s on s.project_id = p.id and s.user_id = $2
     where p.id = $1 and (m.user_id is not null or s.user_id is not null)`,
    [projectId, userId]);
  return rows[0] ?? null;
}

export async function listProjects(sql: Sql, orgId: string, userId: string): Promise<ProjectRow[]> {
  const { rows } = await sql.query<ProjectRow>(
    `select p.* from projects p
     join memberships m on m.org_id = p.org_id and m.user_id = $2
     where p.org_id = $1 and p.archived_at is null
     order by p.updated_at desc`, [orgId, userId]);
  return rows;
}

/**
 * Autosave.
 *
 * `baseRevision` is what the caller last read. If the row has moved on, the
 * write is refused rather than applied — two tabs open on one project is a
 * normal accident, and silently keeping the slower tab's copy is how a
 * morning's work disappears. The caller re-reads and merges.
 */
export async function saveProject(
  sql: Sql, projectId: string, patch: { manifest: unknown; valid: boolean; baseRevision: number; authorId: string },
  now: Date,
): Promise<ProjectRow> {
  const { rows } = await sql.query<ProjectRow>(
    `update projects set manifest = $3, valid = $4, revision = revision + 1, updated_at = $5
     where id = $1 and revision = $2 returning *`,
    [projectId, patch.baseRevision, JSON.stringify(patch.manifest), patch.valid, now]);
  if (!rows[0]) {
    const { rows: current } = await sql.query<{ revision: number }>(
      'select revision from projects where id = $1', [projectId]);
    if (!current[0]) throw notFound('project');
    throw conflict('the project changed since you loaded it', { revision: current[0].revision });
  }
  await sql.query(
    `insert into project_revisions (id, project_id, revision, manifest, author_id, created_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [newId('rev'), projectId, rows[0].revision, JSON.stringify(patch.manifest), patch.authorId, now]);
  return rows[0];
}

/** Keep the history bounded. Autosave is frequent; a merchant needs
 * yesterday, not every keystroke of the last six months. */
export async function pruneRevisions(sql: Sql, projectId: string, keep: number): Promise<number> {
  const { rowCount } = await sql.query(
    `delete from project_revisions where project_id = $1 and revision <= (
       select coalesce(max(revision), 0) - $2 from project_revisions where project_id = $1)`,
    [projectId, keep]);
  return rowCount;
}

export async function setProjectModel(sql: Sql, projectId: string, assetId: string, now: Date): Promise<void> {
  await sql.query('update projects set model_asset_id = $2, updated_at = $3 where id = $1',
    [projectId, assetId, now]);
}

/** The dashboard thumbnail. Deliberately NOT `updated_at`-touching: a
 * screenshot arriving after a save must not make "edited 2 minutes ago"
 * read "edited just now". */
export async function setProjectThumb(sql: Sql, projectId: string, assetId: string): Promise<void> {
  await sql.query('update projects set thumb_asset_id = $2 where id = $1', [projectId, assetId]);
}

export async function renameProject(sql: Sql, projectId: string, name: string, now: Date): Promise<void> {
  await sql.query('update projects set name = $2, updated_at = $3 where id = $1', [projectId, name, now]);
}

/**
 * Rename from the DASHBOARD, where there is no open editor holding the
 * manifest.
 *
 * The stored manifest's own `name` has to move with the row: autosave sends
 * `manifest.name` on every write, so a row-only rename would be quietly
 * reverted the next time the project was opened and touched. The revision
 * bump is what makes the change stick the other way round too — an editor
 * tab already open goes into its normal conflict path instead of silently
 * overwriting the new name with the old one.
 */
export async function renameProjectEverywhere(sql: Sql, projectId: string, name: string, now: Date): Promise<number> {
  const { rows } = await sql.query<{ revision: number }>(
    `update projects set
       name = $2,
       manifest = jsonb_set(manifest, '{name}', to_jsonb($2::text)),
       revision = revision + 1,
       updated_at = $3
     where id = $1 returning revision`, [projectId, name, now]);
  if (!rows[0]) throw notFound('project');
  return rows[0].revision;
}

// ── per-project shares ────────────────────────────────────────────────────

export type ShareRole = 'editor' | 'viewer';

export async function setShare(
  sql: Sql, projectId: string, userId: string, role: ShareRole, byUserId: string, now: Date,
): Promise<void> {
  await sql.query(
    `insert into project_shares (project_id, user_id, role, created_by, created_at)
     values ($1, $2, $3, $4, $5)
     on conflict (project_id, user_id) do update set role = excluded.role`,
    [projectId, userId, role, byUserId, now]);
}

export async function removeShare(sql: Sql, projectId: string, userId: string): Promise<void> {
  await sql.query('delete from project_shares where project_id = $1 and user_id = $2', [projectId, userId]);
}

export async function listShares(sql: Sql, projectId: string): Promise<Array<User & { role: ShareRole }>> {
  const { rows } = await sql.query<User & { role: ShareRole }>(
    `select u.id, u.email, u.name, s.role from project_shares s
     join users u on u.id = s.user_id where s.project_id = $1 order by u.email`, [projectId]);
  return rows;
}

/** What lands in the dashboard's "Shared with you" section. */
export async function sharedProjectsFor(sql: Sql, userId: string): Promise<Array<ProjectRow & { share_role: ShareRole; owner_org: string }>> {
  const { rows } = await sql.query<ProjectRow & { share_role: ShareRole; owner_org: string }>(
    `select p.*, s.role as share_role, o.name as owner_org
     from project_shares s
     join projects p on p.id = s.project_id
     join orgs o on o.id = p.org_id
     where s.user_id = $1 and p.archived_at is null
     order by p.updated_at desc`, [userId]);
  return rows;
}

export async function archiveProject(sql: Sql, projectId: string, now: Date): Promise<void> {
  await sql.query('update projects set archived_at = $2, updated_at = $2 where id = $1', [projectId, now]);
}

// ── publications ──────────────────────────────────────────────────────────

export interface PublicationRow {
  id: string; project_id: string; version: number; manifest: unknown;
  glb_asset_id: string; published_by: string | null; published_at: Date;
}

/**
 * Freeze a version.
 *
 * The version number is claimed by the INSERT itself — `select max + 1` in
 * the same statement — rather than by reading and then writing. Two
 * simultaneous publishes therefore get 4 and 5, or one loses to the unique
 * index and retries; what cannot happen is two publications quietly sharing
 * a version number, which is the one thing an order pinned to "v4" cannot
 * survive. No transaction is needed, so this works the same on a pooled
 * connection as on a dedicated one.
 *
 * Publishing also moves the live pointer, which is what a merchant means by
 * the word.
 */
export async function createPublication(
  sql: Sql, projectId: string, manifest: unknown, glbAssetId: string, userId: string, now: Date,
): Promise<PublicationRow> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { rows } = await sql.query<PublicationRow>(
        `insert into publications (id, project_id, version, manifest, glb_asset_id, published_by, published_at)
         select $1, $2, coalesce(max(version), 0) + 1, $3, $4, $5, $6
         from publications where project_id = $2
         returning *`,
        [newId('pub'), projectId, JSON.stringify(manifest), glbAssetId, userId, now]);
      await sql.query('update projects set live_publication_id = $2, updated_at = $3 where id = $1',
        [projectId, rows[0].id, now]);
      return rows[0];
    } catch (err) {
      last = err;
      if ((err as { code?: string }).code !== '23505') throw err;   // not a version race
    }
  }
  throw last;
}

export async function getPublication(sql: Sql, id: string): Promise<PublicationRow | null> {
  const { rows } = await sql.query<PublicationRow>('select * from publications where id = $1', [id]);
  return rows[0] ?? null;
}

/** What `/e/:projectId` serves: whatever the merchant last pointed at, which
 * is the latest publish unless they rolled back. */
export async function livePublication(sql: Sql, projectId: string): Promise<PublicationRow | null> {
  const { rows } = await sql.query<PublicationRow>(
    `select pub.* from projects p join publications pub on pub.id = p.live_publication_id
     where p.id = $1 and p.archived_at is null`, [projectId]);
  return rows[0] ?? null;
}

export async function listPublications(sql: Sql, projectId: string): Promise<PublicationRow[]> {
  const { rows } = await sql.query<PublicationRow>(
    'select * from publications where project_id = $1 order by version desc', [projectId]);
  return rows;
}

/** Roll back (or forward) without republishing — the same frozen bytes, just
 * pointed at again. */
export async function setLivePublication(sql: Sql, projectId: string, publicationId: string, now: Date): Promise<void> {
  const { rowCount } = await sql.query(
    `update projects set live_publication_id = $2, updated_at = $3
     where id = $1 and exists (select 1 from publications where id = $2 and project_id = $1)`,
    [projectId, publicationId, now]);
  if (!rowCount) throw notFound('publication');
}

// ── embed origins ─────────────────────────────────────────────────────────

export async function listOrigins(sql: Sql, projectId: string): Promise<string[]> {
  const { rows } = await sql.query<{ origin: string }>(
    'select origin from project_origins where project_id = $1 order by origin', [projectId]);
  return rows.map((r) => r.origin);
}

export async function setOrigins(sql: Sql, projectId: string, origins: string[], now: Date): Promise<void> {
  await sql.query('delete from project_origins where project_id = $1', [projectId]);
  for (const origin of origins) {
    await sql.query(
      `insert into project_origins (project_id, origin, created_at) values ($1, $2, $3)
       on conflict do nothing`, [projectId, origin, now]);
  }
}

/** The allowlist for a PUBLICATION, which is the project's — the setting
 * belongs to the product, not to one frozen version of it. */
export async function originsForPublication(sql: Sql, publicationId: string): Promise<string[]> {
  const { rows } = await sql.query<{ origin: string }>(
    `select o.origin from project_origins o
     join publications p on p.project_id = o.project_id where p.id = $1`, [publicationId]);
  return rows.map((r) => r.origin);
}

// ── customer uploads ──────────────────────────────────────────────────────

export interface UploadRow {
  id: string; publication_id: string; option_id: string; asset_id: string;
  created_at: Date; claimed_at: Date | null;
}

export async function createUpload(
  sql: Sql, publicationId: string, optionId: string, assetId: string, now: Date,
): Promise<UploadRow> {
  const { rows } = await sql.query<UploadRow>(
    `insert into uploads (id, publication_id, option_id, asset_id, created_at)
     values ($1, $2, $3, $4, $5) returning *`,
    [newId('upl'), publicationId, optionId, assetId, now]);
  return rows[0];
}

export async function getUpload(sql: Sql, id: string): Promise<UploadRow | null> {
  const { rows } = await sql.query<UploadRow>('select * from uploads where id = $1', [id]);
  return rows[0] ?? null;
}

/** An order took responsibility for these; the janitor must leave them
 * alone from now on. */
export async function claimUploads(sql: Sql, ids: string[], now: Date): Promise<number> {
  if (!ids.length) return 0;
  const { rowCount } = await sql.query(
    'update uploads set claimed_at = $2 where claimed_at is null and id = any($1)', [ids, now]);
  return rowCount;
}

/** Abandoned baskets, swept. Returns the storage keys so the caller can
 * delete the bytes too — a row without its object is a leak that only shows
 * up on the invoice. */
export async function pruneUnclaimedUploads(sql: Sql, before: Date): Promise<string[]> {
  const { rows } = await sql.query<{ storage_key: string }>(
    `delete from uploads u using assets a
     where u.asset_id = a.id and u.claimed_at is null and u.created_at < $1
     returning a.storage_key`, [before]);
  return rows.map((r) => r.storage_key);
}

export async function pruneExpiredSessions(sql: Sql, now: Date): Promise<number> {
  const { rowCount } = await sql.query('delete from sessions where expires_at < $1', [now]);
  return rowCount;
}
