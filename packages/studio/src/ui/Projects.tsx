// The dashboard: every product this merchant has, and the way into one.
//
// A card grid rather than a table. These are physical things — a plate, a
// bracelet, a bottle — and the row a merchant is looking for is the one they
// touched most recently, which is what the ordering and the timestamps are
// for. The status pill is the only piece of jargon on the page, and it says
// the one thing that matters: is this live yet.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, go, type Me, type Member, type ProjectSummary, type Role } from '../lib/api.ts';
import { relativeTime } from '../lib/format.ts';
import { emptyManifest } from '../lib/manifest-init.ts';

const PLUS = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
);
const ARROW = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h13" /><path d="m12 5 7 7-7 7" />
  </svg>
);
const CUBE = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5 12 12l8-4.5M12 12v9" />
  </svg>
);

export function Projects(props: { me: Me; onSignedOut: () => void }) {
  const { me, onSignedOut } = props;
  const [orgId, setOrgId] = useState(me.orgs[0]?.id ?? '');
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState(false);
  const org = me.orgs.find((o) => o.id === orgId);
  const canEdit = org?.role === 'owner' || org?.role === 'editor';

  const reload = useCallback(async () => {
    if (!orgId) return;
    try {
      setProjects(await api.listProjects(orgId));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not load your products');
    }
  }, [orgId]);

  useEffect(() => { void reload(); }, [reload]);

  const create = async () => {
    setBusy(true);
    try {
      // Seeded with a real empty manifest: the Studio owns what "empty"
      // means, and the service should not have a second opinion.
      const made = await api.createProject(orgId, 'Untitled product', emptyManifest('Untitled product'));
      go(`/p/${made.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not create a product');
      setBusy(false);
    }
  };

  const now = Date.now();

  return (
    <div className="dash">
      <header className="dash-top">
        <span className="brand">Studio</span>
        {me.orgs.length > 1 ? (
          <select
            className="dash-org" data-testid="org-picker"
            value={orgId} onChange={(e) => { setOrgId(e.target.value); setProjects(null); }}
          >
            {me.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        ) : (
          <span className="dash-org-name" data-testid="org-name">{org?.name}</span>
        )}
        <span className="spacer" />
        {org?.role === 'owner' && (
          <button className="ghost" data-testid="people-open" onClick={() => setPeople(true)}>People</button>
        )}
        <span className="dash-who" title={me.user.email}>{me.user.email}</span>
        <button
          className="ghost" data-testid="sign-out"
          onClick={async () => { await api.signOut().catch(() => {}); onSignedOut(); }}
        >Sign out</button>
      </header>

      <main className="dash-body">
        <div className="dash-head">
          <h1>Products</h1>
          {canEdit && (
            <button className="cta" data-testid="new-product" onClick={create} disabled={busy}>
              {PLUS}<span>New product</span>
            </button>
          )}
        </div>

        {error && <p className="error" role="alert" data-testid="dash-error">{error}</p>}

        {projects === null && !error && <p className="dash-note">Loading…</p>}

        {projects?.length === 0 && (
          <div className="dash-empty" data-testid="dash-empty">
            <span aria-hidden="true">{CUBE}</span>
            <h2>Nothing here yet</h2>
            <p>
              A product starts with a 3D file — a 3MF, STL or GLB straight out of your CAD or
              slicer. Import it, choose what customers may change, and publish.
            </p>
            {canEdit && <button className="cta" onClick={create} disabled={busy}>{PLUS}<span>New product</span></button>}
          </div>
        )}

        {!!projects?.length && (
          <ul className="dash-grid" data-testid="project-grid">
            {projects.map((p) => (
              <li key={p.id}>
                <a
                  className="dash-card" href={`/p/${p.id}`} data-testid={`project-${p.id}`}
                  onClick={(e) => { e.preventDefault(); go(`/p/${p.id}`); }}
                >
                  <span className="dash-card-icon" aria-hidden="true">{CUBE}</span>
                  <span className="dash-card-name">{p.name}</span>
                  <span className={`dash-pill${p.live ? ' is-live' : ''}`}>
                    {p.live ? 'Published' : 'Draft'}
                  </span>
                  <span className="dash-card-meta">
                    Edited {relativeTime(p.updatedAt, now)}
                    {!p.hasModel && ' · no model yet'}
                  </span>
                  <span className="dash-card-go" aria-hidden="true">{ARROW}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>

      {people && org && <People orgId={org.id} meId={me.user.id} onClose={() => setPeople(false)} />}
    </div>
  );
}

/** Who else may work on these products. Owners only — the button that opens
 * it is not rendered for anyone else, and the service refuses regardless. */
function People(props: { orgId: string; meId: string; onClose: () => void }) {
  const { orgId, meId, onClose } = props;
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try { setMembers(await api.listMembers(orgId)); } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not load the team');
    }
  }, [orgId]);
  useEffect(() => { void reload(); }, [reload]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const out = await api.invite(orgId, email.trim(), role);
      setNote(out.invited ? `Invitation sent to ${email.trim()}.` : `${email.trim()} was added.`);
      setEmail('');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not send that invitation');
    }
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="publish-modal" role="dialog" aria-modal="true" aria-label="People">
        <div className="publish-modal-head">
          <h3>People</h3>
          <button className="ghost" data-testid="people-close" onClick={onClose}>Close</button>
        </div>
        <div className="panel-body">
          <ul className="people-list">
            {members?.map((m) => (
              <li key={m.id}>
                <span className="people-email">{m.email}</span>
                <span className="dash-pill">{m.role}</span>
                {m.id !== meId && (
                  <button
                    className="ghost danger" data-testid={`remove-${m.id}`}
                    onClick={async () => {
                      try { await api.removeMember(orgId, m.id); await reload(); } catch (err) {
                        setError(err instanceof ApiError ? err.message : 'could not remove them');
                      }
                    }}
                  >Remove</button>
                )}
              </li>
            ))}
          </ul>
          <form className="people-invite" onSubmit={invite}>
            <input
              type="email" required placeholder="name@theirshop.com" data-testid="invite-email"
              value={email} onChange={(e) => setEmail(e.target.value)}
            />
            <select value={role} data-testid="invite-role" onChange={(e) => setRole(e.target.value as Role)}>
              <option value="editor">Editor — can author and publish</option>
              <option value="viewer">Viewer — can look, not touch</option>
              <option value="owner">Owner — can also manage people</option>
            </select>
            <button className="cta" type="submit" data-testid="invite-send">Invite</button>
          </form>
          {note && <p className="hint" role="status">{note}</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </div>
    </div>
  );
}
