-- The service's whole shape, in one file.
--
-- Two rules run through it. Every row that belongs to a merchant hangs off
-- `orgs` by a cascade, so deleting an account really deletes the account.
-- And anything a customer's ORDER will one day point at is immutable —
-- `publications` and `assets` are written once and never updated, because a
-- product edited in March must not silently change what someone bought in
-- February.

create table if not exists users (
  id            text primary key,
  email         text not null unique,   -- stored lowercased; the login identity
  name          text,
  created_at    timestamptz not null,
  last_seen_at  timestamptz
);

create table if not exists orgs (
  id          text primary key,
  name        text not null,
  created_at  timestamptz not null
);

-- Who may touch an org, and how much. owner: everything, including members
-- and deletion. editor: author and publish. viewer: read only — the role a
-- client or a contractor gets.
create table if not exists memberships (
  org_id      text not null references orgs(id) on delete cascade,
  user_id     text not null references users(id) on delete cascade,
  role        text not null check (role in ('owner', 'editor', 'viewer')),
  created_at  timestamptz not null,
  primary key (org_id, user_id)
);

-- Magic-link sign-in. Only the HASH of the emailed token is stored, so a
-- database leak cannot be replayed into someone's account, and `used_at`
-- makes a link single-use even inside its 15-minute window.
create table if not exists login_tokens (
  id          text primary key,
  token_hash  text not null unique,
  email       text not null,
  invite_org  text references orgs(id) on delete cascade,  -- set when the link was an invitation
  invite_role text,
  created_at  timestamptz not null,
  expires_at  timestamptz not null,
  used_at     timestamptz
);

-- Sessions are opaque bearer tokens; same reasoning as above, only the hash
-- lives here. Deleting the row logs the browser out immediately.
create table if not exists sessions (
  id            text primary key,
  token_hash    text not null unique,
  user_id       text not null references users(id) on delete cascade,
  created_at    timestamptz not null,
  expires_at    timestamptz not null,
  last_seen_at  timestamptz
);

-- Content-addressed blobs: source models, published GLBs, customer artwork.
-- Keyed by (org, sha256) rather than sha256 alone — deduping ACROSS tenants
-- would turn "does this file exist" into a question one merchant could ask
-- about another's uploads.
create table if not exists assets (
  id            text primary key,
  org_id        text not null references orgs(id) on delete cascade,
  sha256        text not null,
  kind          text not null check (kind in ('model', 'image')),
  content_type  text not null,
  bytes         bigint not null,
  storage_key   text not null,
  created_at    timestamptz not null,
  unique (org_id, sha256)
);

-- The merchant's working document. `manifest` is the live draft the Studio
-- autosaves; `revision` is the optimistic-concurrency counter that stops two
-- open tabs from silently overwriting one another. `model_asset_id` is the
-- uncompressed workspace GLB — without it a reopened project would be a
-- manifest describing geometry nobody has.
create table if not exists projects (
  id                   text primary key,
  org_id               text not null references orgs(id) on delete cascade,
  name                 text not null,
  manifest             jsonb not null,
  -- Losing the workspace model does not lose the project: the manifest still
  -- describes the product, and the merchant can re-import the geometry.
  model_asset_id       text references assets(id) on delete set null,
  live_publication_id  text,             -- FK added after publications exists
  revision             integer not null default 1,
  valid                boolean not null default false,
  created_at           timestamptz not null,
  updated_at           timestamptz not null,
  archived_at          timestamptz
);

create index if not exists projects_org_idx on projects (org_id, archived_at, updated_at desc);

-- Autosave history. Not undo — the Studio owns that in memory — but the
-- answer to "it was fine yesterday", and the reason an autosave can never be
-- the last word on a merchant's work.
create table if not exists project_revisions (
  id          text primary key,
  project_id  text not null references projects(id) on delete cascade,
  revision    integer not null,
  manifest    jsonb not null,
  author_id   text references users(id) on delete set null,
  created_at  timestamptz not null,
  unique (project_id, revision)
);

-- A published version: frozen manifest, frozen model, forever. Orders pin
-- one of these, which is the whole point of copying the manifest in rather
-- than pointing at the project.
create table if not exists publications (
  id            text primary key,
  project_id    text not null references projects(id) on delete cascade,
  version       integer not null,
  manifest      jsonb not null,
  -- Cascade, not restrict: a publication whose model has been deleted cannot
  -- render, so it must not outlive it. This is also what makes deleting an
  -- org terminate — assets and publications both hang off the org, and
  -- without a rule here the two cascades fight over which goes first.
  glb_asset_id  text not null references assets(id) on delete cascade,
  published_by  text references users(id) on delete set null,
  published_at  timestamptz not null,
  unique (project_id, version)
);

alter table projects drop constraint if exists projects_live_publication_fk;
alter table projects add constraint projects_live_publication_fk
  foreign key (live_publication_id) references publications(id) on delete set null;

-- Where this product's configurator may be embedded. Empty = anywhere, which
-- is how a project starts so that nobody's first integration fails on a
-- setting they have not met yet.
create table if not exists project_origins (
  project_id  text not null references projects(id) on delete cascade,
  origin      text not null,
  created_at  timestamptz not null,
  primary key (project_id, origin)
);

-- Customer artwork, uploaded from the merchant's storefront. It lands here
-- FIRST and travels through the cart as an id, because the alternative — the
-- image itself, base64'd, in a line-item property — is a megabyte of data in
-- a field most carts cap at 255 characters.
--
-- `claimed_at` is null until an order references the upload; the janitor
-- deletes unclaimed strays, so an abandoned basket does not become storage
-- the merchant pays for forever.
create table if not exists uploads (
  id              text primary key,
  publication_id  text not null references publications(id) on delete cascade,
  option_id       text not null,
  asset_id        text not null references assets(id) on delete cascade,
  created_at      timestamptz not null,
  claimed_at      timestamptz
);

create index if not exists uploads_unclaimed_idx on uploads (claimed_at, created_at);

-- The dashboard thumbnail: a small square render the Studio captures after
-- saves. A column added after release, so it arrives as its own idempotent
-- statement rather than a rewrite of the projects table.
alter table projects add column if not exists thumb_asset_id text references assets(id) on delete set null;

-- Sharing ONE project with ONE person, without inviting them into the org.
-- A share never outranks a membership: access checks take the better of the
-- two, so sharing a viewer role with someone who is already an org editor
-- changes nothing. 'editor' may author; 'viewer' may open and configure.
create table if not exists project_shares (
  project_id  text not null references projects(id) on delete cascade,
  user_id     text not null references users(id) on delete cascade,
  role        text not null check (role in ('editor', 'viewer')),
  created_by  text references users(id) on delete set null,
  created_at  timestamptz not null,
  primary key (project_id, user_id)
);

create index if not exists project_shares_user_idx on project_shares (user_id);

-- A freely shareable customiser preview: anyone holding the token may load
-- the project's CURRENT draft, read-only, with no account. Minted lazily the
-- first time someone asks for the link; unguessable (256-bit), and clearing
-- the column is how a leaked link gets cut off.
alter table projects add column if not exists preview_token text;
create unique index if not exists projects_preview_token_idx
  on projects (preview_token) where preview_token is not null;
