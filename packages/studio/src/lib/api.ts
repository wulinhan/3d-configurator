// The Studio's side of the service.
//
// One rule shapes this file: the Studio must keep working with NO service at
// all. `apiBase()` empty means local mode — the merchant imports a model,
// authors it and downloads two files, exactly as before accounts existed.
// Everything cloud-shaped is behind `if (api)`, so the offline Studio is not
// a degraded version of the online one; it is the same app with a shorter
// menu.

export interface Me {
  user: { id: string; email: string; name: string | null };
  orgs: Array<{ id: string; name: string; role: Role }>;
}

export type Role = 'owner' | 'editor' | 'viewer';

export interface ProjectSummary {
  id: string;
  name: string;
  revision: number;
  valid: boolean;
  updatedAt: string;
  hasModel: boolean;
  hasThumb: boolean;
  live: string | null;
  /** Someone else has been given access to this project. */
  shared?: boolean;
  /** The first few people it is shared with, for the card's avatar stack. */
  sharedWith?: Array<{ email: string; name: string | null }>;
  shareCount?: number;
}

export interface ProjectDetail {
  id: string;
  orgId: string;
  name: string;
  revision: number;
  valid: boolean;
  manifest: unknown;
  hasModel: boolean;
  live: string | null;
  updatedAt: string;
  /** The caller's standing on THIS project — membership or share, whichever
   * grants more. 'viewer' means the editor opens read-only. */
  role: Role;
}

export interface SharedProject {
  id: string;
  name: string;
  updatedAt: string;
  hasThumb: boolean;
  live: string | null;
  role: 'editor' | 'viewer';
  /** Whose workshop it lives in — the card says where it came from. */
  from: string;
}

export interface Share {
  id: string;
  email: string;
  name: string | null;
  role: 'editor' | 'viewer';
}

export interface PublicationSummary {
  id: string;
  version: number;
  publishedAt: string;
  publishedBy: string | null;
  manifestUrl: string;
  modelUrl: string;
}

export interface Member {
  id: string;
  email: string;
  name: string | null;
  role: Role;
}

/**
 * An error with the service's own words in it.
 *
 * `status` matters to callers: 409 means the project moved under you and the
 * fix is to re-read, not to retry; 401 means the session is gone and the fix
 * is to sign in again. Anything else is shown to the merchant as-is, because
 * the service's messages are written to be read.
 */
export class ApiError extends Error {
  status: number;
  code: string;
  detail: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** Where the service lives, or '' when the Studio is running on its own.
 * Read from the build's env so a self-hosted Studio needs no code change. */
export function apiBase(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return (env?.VITE_API_BASE ?? '').replace(/\/$/, '');
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    // The session is an HttpOnly cookie: it cannot be read by script, which
    // is the point, so it has to be sent by the browser rather than by us.
    credentials: 'include',
    headers: { ...init.headers },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null) as
    { error?: string; message?: string; detail?: unknown } | null;
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? 'error', body?.message ?? res.statusText, body?.detail);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  /** Who is signed in, or null. The only call that treats 401 as an answer
   * rather than a failure — everywhere else it means the session lapsed. */
  async me(): Promise<Me | null> {
    try {
      return await request<Me>('/v1/me');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },

  /** Which sign-in extras this deployment has switched on. Both values are
   * public keys that end up in the page anyway; failure means "neither",
   * so an old service without the route degrades to plain magic links. */
  authConfig: async (): Promise<{ googleClientId: string | null; turnstileSiteKey: string | null }> => {
    try {
      return await request('/v1/auth/config');
    } catch {
      return { googleClientId: null, turnstileSiteKey: null };
    }
  },

  requestLink: (email: string, turnstile?: string) =>
    request<void>('/v1/auth/request', { method: 'POST', ...json({ email, ...(turnstile ? { turnstile } : {}) }) }),
  consumeLink: (token: string) => request<Me>('/v1/auth/consume', { method: 'POST', ...json({ token }) }),
  googleSignIn: (credential: string) =>
    request<Me>('/v1/auth/google', { method: 'POST', ...json({ credential }) }),
  signOut: () => request<void>('/v1/auth/logout', { method: 'POST' }),

  listProjects: (orgId: string) =>
    request<{ projects: ProjectSummary[] }>(`/v1/orgs/${orgId}/projects`).then((r) => r.projects),
  createProject: (orgId: string, name: string, manifest: unknown) =>
    request<{ project: { id: string; name: string; revision: number } }>(
      `/v1/orgs/${orgId}/projects`, { method: 'POST', ...json({ name, manifest }) }).then((r) => r.project),
  getProject: (id: string) => request<{ project: ProjectDetail }>(`/v1/projects/${id}`).then((r) => r.project),
  saveProject: (id: string, patch: { manifest: unknown; baseRevision: number; name?: string }) =>
    request<{ revision: number; valid: boolean; errors: unknown[]; warnings: unknown[] }>(
      `/v1/projects/${id}`, { method: 'PUT', ...json(patch) }),
  archiveProject: (id: string) => request<void>(`/v1/projects/${id}`, { method: 'DELETE' }),
  renameProject: (id: string, name: string) =>
    request<{ name: string; revision: number }>(`/v1/projects/${id}/rename`, { method: 'POST', ...json({ name }) }),

  /** The freely shareable customiser link for a project's CURRENT draft —
   * anyone holding it can open the preview, no account needed. */
  previewLink: (id: string) =>
    request<{ url: string }>(`/v1/projects/${id}/preview-link`, { method: 'POST' }).then((r) => r.url),

  sharedWithMe: () => request<{ projects: SharedProject[] }>('/v1/me/shared').then((r) => r.projects),
  listShares: (id: string) => request<{ shares: Share[] }>(`/v1/projects/${id}/shares`).then((r) => r.shares),
  share: (id: string, email: string, role: 'editor' | 'viewer') =>
    request<{ shares: Share[] }>(`/v1/projects/${id}/shares`, { method: 'PUT', ...json({ email, role }) })
      .then((r) => r.shares),
  unshare: (id: string, userId: string) =>
    request<{ shares: Share[] }>(`/v1/projects/${id}/shares/${userId}`, { method: 'DELETE' })
      .then((r) => r.shares),

  putModel: (id: string, glb: Uint8Array) =>
    request<{ assetId: string; sha256: string; bytes: number }>(`/v1/projects/${id}/model`, {
      method: 'POST', headers: { 'content-type': 'model/gltf-binary' }, body: glb as BodyInit,
    }),
  getModel: async (id: string): Promise<Uint8Array> => {
    const res = await fetch(`${apiBase()}/v1/projects/${id}/model`, { credentials: 'include' });
    if (!res.ok) throw new ApiError(res.status, 'error', 'could not load the saved model');
    return new Uint8Array(await res.arrayBuffer());
  },

  putThumb: (id: string, png: Uint8Array) =>
    request<{ assetId: string }>(`/v1/projects/${id}/thumbnail`, {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: png as BodyInit,
    }),
  // The <img src> for a card. The session cookie rides along because the
  // Studio and the service are same-site — no token in the URL.
  thumbUrl: (id: string) => `${apiBase()}/v1/projects/${id}/thumbnail`,

  publish: (id: string, glb: Uint8Array) =>
    request<{
      publication: PublicationSummary; liveManifestUrl: string; warnings: unknown[];
    }>(`/v1/projects/${id}/publications`, {
      method: 'POST', headers: { 'content-type': 'model/gltf-binary' }, body: glb as BodyInit,
    }),
  listPublications: (id: string) =>
    request<{ live: string | null; publications: PublicationSummary[]; liveManifestUrl: string }>(
      `/v1/projects/${id}/publications`),
  setLive: (id: string, publicationId: string) =>
    request<{ live: string }>(`/v1/projects/${id}/live`, { method: 'POST', ...json({ publicationId }) }),

  listOrigins: (id: string) => request<{ origins: string[] }>(`/v1/projects/${id}/origins`).then((r) => r.origins),
  setOrigins: (id: string, origins: string[]) =>
    request<{ origins: string[] }>(`/v1/projects/${id}/origins`, { method: 'PUT', ...json({ origins }) })
      .then((r) => r.origins),

  listMembers: (orgId: string) =>
    request<{ members: Member[] }>(`/v1/orgs/${orgId}/members`).then((r) => r.members),
  invite: (orgId: string, email: string, role: Role) =>
    request<{ invited: boolean }>(`/v1/orgs/${orgId}/members`, { method: 'POST', ...json({ email, role }) }),
  removeMember: (orgId: string, userId: string) =>
    request<void>(`/v1/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }),
};

// ── routing ───────────────────────────────────────────────────────────────

export type Route =
  | { name: 'editor'; projectId: string | null }
  | { name: 'projects' }
  | { name: 'signin'; token: string | null };

/**
 * Where we are, from the URL.
 *
 * Deliberately three routes and a `startsWith` — a router dependency would
 * be larger than the thing it routed. The sign-in token arrives in the
 * FRAGMENT rather than the query string: a fragment is never sent to a
 * server, so it stays out of access logs and out of the Referer header.
 */
export function routeOf(pathname: string, hash: string, cloud: boolean): Route {
  if (!cloud) return { name: 'editor', projectId: null };
  if (pathname === '/signin' || pathname.startsWith('/signin/')) {
    return { name: 'signin', token: hash.replace(/^#/, '') || null };
  }
  const project = /^\/p\/([\w-]+)\/?$/.exec(pathname);
  if (project) return { name: 'editor', projectId: project[1] };
  return { name: 'projects' };
}

/** Navigate without a page load, and tell the app to re-read the URL. */
export function go(path: string): void {
  history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}

/** The snippet a merchant pastes into their storefront. One line of markup
 * and one script — the live URL, so publishing again does not mean pasting
 * again. */
export function embedSnippet(manifestUrl: string, embedBase: string): string {
  const base = embedBase.replace(/\/$/, '');
  return `<link rel="stylesheet" href="${base}/embed.css">
<div data-configurator="${manifestUrl}"></div>
<script type="module" src="${base}/embed.js"></script>`;
}
