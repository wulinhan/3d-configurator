// The dashboard: every product this merchant has, and the way into one.
//
// A card grid rather than a table. These are physical things — a plate, a
// bracelet, a bottle — and the row a merchant is looking for is the one they
// touched most recently, which is what the ordering and the timestamps are
// for. Each card carries its own quiet menu (rename, share, delete) so the
// list is also where a product's life is managed, not just entered.
//
// The header is one identity, once: brand on the left, the workshop beside
// it, and a single avatar menu on the right holding everything about "me".

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api, ApiError, go,
  type Me, type Member, type ProjectSummary, type Role, type Share, type SharedProject,
} from '../lib/api.ts';
import { relativeTime } from '../lib/format.ts';
import { emptyManifest } from '../lib/manifest-init.ts';

const PLUS = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
);
const CUBE = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5 12 12l8-4.5M12 12v9" />
  </svg>
);
const DOTS = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
  </svg>
);

/** Two letters that stand for a person — email is the identity here. */
const initials = (email: string): string => {
  const name = email.split('@')[0].replace(/[^a-zA-Z0-9]+/g, ' ').trim();
  const words = name.split(' ').filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? name[1] ?? '')).toUpperCase();
};

/** Close-on-outside-click for the little popover menus. */
function useDismiss(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = () => close();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    // Deferred a tick so the click that OPENED the menu doesn't also close it.
    const t = setTimeout(() => {
      addEventListener('pointerdown', onDown);
      addEventListener('keydown', onKey);
    });
    return () => {
      clearTimeout(t);
      removeEventListener('pointerdown', onDown);
      removeEventListener('keydown', onKey);
    };
  }, [open, close]);
}

export function Projects(props: { me: Me; onSignedOut: () => void }) {
  const { me, onSignedOut } = props;
  const [orgId, setOrgId] = useState(me.orgs[0]?.id ?? '');
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [shared, setShared] = useState<SharedProject[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState(false);
  const [sharing, setSharing] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const org = me.orgs.find((o) => o.id === orgId);
  const canEdit = org?.role === 'owner' || org?.role === 'editor';

  const reload = useCallback(async () => {
    try {
      const [mine, theirs] = await Promise.all([
        orgId ? api.listProjects(orgId) : Promise.resolve([]),
        api.sharedWithMe().catch(() => []),
      ]);
      setProjects(mine);
      setShared(theirs);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not load your products');
    }
  }, [orgId]);

  useEffect(() => { void reload(); }, [reload]);

  // Duplicate = the same two artefacts a project IS (manifest + model),
  // copied through the endpoints that already own them — nothing new for
  // the service to learn. The copy opens from the card like any project.
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const duplicate = async (p: ProjectSummary) => {
    if (!org || duplicating) return;
    setDuplicating(p.id);
    setError(null);
    try {
      const detail = await api.getProject(p.id);
      const copyName = `Copy of ${p.name}`.slice(0, 120);
      const manifest = detail.manifest && typeof detail.manifest === 'object'
        ? { ...(detail.manifest as Record<string, unknown>), name: copyName }
        : detail.manifest;
      const made = await api.createProject(org.id, copyName, manifest);
      if (detail.hasModel) {
        const glb = await api.getModel(p.id);
        await api.putModel(made.id, glb);
      }
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not duplicate that product');
    } finally {
      setDuplicating(null);
    }
  };

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
        <span className="dash-sep" aria-hidden="true">/</span>
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
        <AccountMenu me={me} isOwner={org?.role === 'owner'} onPeople={() => setPeople(true)} onSignedOut={onSignedOut} />
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

        {projects?.length === 0 && !shared.length && (
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
              <ProjectCard
                key={p.id} project={p} now={now} canEdit={canEdit}
                onShare={() => setSharing({ id: p.id, name: p.name })}
                onDelete={() => setDeleting({ id: p.id, name: p.name })}
                onRenamed={reload}
                onDuplicate={() => void duplicate(p)}
                duplicating={duplicating === p.id}
              />
            ))}
          </ul>
        )}

        {!!shared.length && (
          <>
            <div className="dash-head dash-head-shared"><h1>Shared with you</h1></div>
            <ul className="dash-grid" data-testid="shared-grid">
              {shared.map((p) => (
                <li key={p.id}>
                  <a
                    className={`dash-card${p.hasThumb ? ' has-thumb' : ''}`}
                    href={`/p/${p.id}`} data-testid={`shared-${p.id}`}
                    onClick={(e) => { e.preventDefault(); go(`/p/${p.id}`); }}
                  >
                    {p.hasThumb ? (
                      <span className="dash-thumb">
                        <img src={api.thumbUrl(p.id)} alt="" loading="lazy" />
                        <span className="dash-tag">{p.role === 'editor' ? 'Can edit' : 'View only'}</span>
                      </span>
                    ) : (
                      <span className="dash-card-icon" aria-hidden="true">{CUBE}</span>
                    )}
                    <span className="dash-card-name">{p.name}</span>
                    {!p.hasThumb && (
                      <span className="dash-tag">{p.role === 'editor' ? 'Can edit' : 'View only'}</span>
                    )}
                    <span className="dash-card-meta">From {p.from} · edited {relativeTime(p.updatedAt, now)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>

      {people && org && <People orgId={org.id} meId={me.user.id} onClose={() => setPeople(false)} />}
      {sharing && <ShareDialog project={sharing} onClose={() => { setSharing(null); void reload(); }} />}
      {deleting && (
        <DeleteDialog
          project={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setDeleting(null); void reload(); }}
        />
      )}
    </div>
  );
}

/** The whole of "me", in one place on the right: avatar in, menu out. */
function AccountMenu(props: { me: Me; isOwner: boolean; onPeople: () => void; onSignedOut: () => void }) {
  const { me, isOwner, onPeople, onSignedOut } = props;
  const [open, setOpen] = useState(false);
  useDismiss(open, useCallback(() => setOpen(false), []));

  return (
    <div className="account" onPointerDown={(e) => e.stopPropagation()}>
      <button
        className="account-btn" data-testid="account-menu" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="avatar">{initials(me.user.email)}</span>
      </button>
      {open && (
        <div className="menu account-pop" role="menu">
          <div className="menu-id">
            <span className="avatar">{initials(me.user.email)}</span>
            <div className="menu-id-text">
              {me.user.name && <strong>{me.user.name}</strong>}
              <span>{me.user.email}</span>
            </div>
          </div>
          <div className="menu-sep" />
          {isOwner && (
            <button className="menu-item" data-testid="people-open" role="menuitem"
              onClick={() => { setOpen(false); onPeople(); }}>People &amp; roles</button>
          )}
          <button className="menu-item" data-testid="sign-out" role="menuitem"
            onClick={async () => { await api.signOut().catch(() => {}); onSignedOut(); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function ProjectCard(props: {
  project: ProjectSummary; now: number; canEdit: boolean;
  onShare: () => void; onDelete: () => void; onRenamed: () => void;
  onDuplicate: () => void; duplicating: boolean;
}) {
  const { project: p, now, canEdit, onShare, onDelete, onRenamed } = props;
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(p.name);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useDismiss(menu, useCallback(() => setMenu(false), []));

  const commitRename = async () => {
    setRenaming(false);
    const next = name.trim();
    if (!next || next === p.name) { setName(p.name); return; }
    try {
      await api.renameProject(p.id, next);
      onRenamed();
    } catch {
      setName(p.name);
    }
  };

  const tag = <span className={`dash-tag${p.live ? ' is-live' : ''}`}>{p.live ? 'Published' : 'Draft'}</span>;

  return (
    <li>
      <a
        className={`dash-card${p.hasThumb ? ' has-thumb' : ''}`}
        href={`/p/${p.id}`} data-testid={`project-${p.id}`}
        onClick={(e) => { if (renaming) { e.preventDefault(); return; } e.preventDefault(); go(`/p/${p.id}`); }}
      >
        {p.hasThumb ? (
          <span className="dash-thumb" data-testid={`thumb-${p.id}`}>
            <img src={api.thumbUrl(p.id)} alt="" loading="lazy" />
            {tag}
          </span>
        ) : (
          <span className="dash-card-icon" aria-hidden="true">{CUBE}</span>
        )}
        {renaming ? (
          <input
            ref={inputRef} className="dash-rename" data-testid={`rename-${p.id}`}
            value={name} autoFocus
            onChange={(e) => setName(e.target.value)}
            onClick={(e) => e.preventDefault()}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') { setName(p.name); setRenaming(false); }
            }}
          />
        ) : (
          <span className="dash-card-name">{p.name}</span>
        )}
        {!p.hasThumb && tag}
        <span className="dash-card-meta">
          Edited {relativeTime(p.updatedAt, now)}
          {!p.hasModel && ' · no model yet'}
        </span>
        {canEdit && (
          <span
            className="dash-actions"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          >
            <button
              className="dash-dots" data-testid={`menu-${p.id}`} aria-haspopup="menu" aria-expanded={menu}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenu((v) => !v); }}
            >{DOTS}</button>
            {menu && (
              <span className="menu card-pop" role="menu">
                <button className="menu-item" role="menuitem" onClick={(e) => {
                  e.preventDefault(); setMenu(false); setRenaming(true); setName(p.name);
                }}>Rename</button>
                <button className="menu-item" role="menuitem" onClick={(e) => {
                  e.preventDefault(); setMenu(false); onShare();
                }}>Share…</button>
                <button
                  className="menu-item" role="menuitem" data-testid={`duplicate-${p.id}`}
                  disabled={props.duplicating}
                  onClick={(e) => { e.preventDefault(); setMenu(false); props.onDuplicate(); }}
                >{props.duplicating ? 'Duplicating…' : 'Duplicate'}</button>
                <span className="menu-sep" />
                <button className="menu-item danger" role="menuitem" onClick={(e) => {
                  e.preventDefault(); setMenu(false); onDelete();
                }}>Delete…</button>
              </span>
            )}
          </span>
        )}
      </a>
    </li>
  );
}

/**
 * Deleting takes typing the word. A confirm button is muscle memory within a
 * week; typing "Delete" never becomes muscle memory, which is the point for
 * the one action here that cannot be taken back from the dashboard.
 */
function DeleteDialog(props: { project: { id: string; name: string }; onClose: () => void; onDeleted: () => void }) {
  const { project, onClose, onDeleted } = props;
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = typed.trim() === 'Delete';

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog-card" role="dialog" aria-modal="true" aria-label="Delete product">
        <h3>Delete “{project.name}”?</h3>
        <p className="hint">
          The product, its model and its history are removed from the dashboard. Anything already
          published stays live for customers until you unpublish it. Type <strong>Delete</strong> to confirm.
        </p>
        <input
          data-testid="delete-confirm-input" autoFocus placeholder="Delete"
          value={typed} onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialog-row">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button
            className="cta danger-cta" data-testid="delete-confirm" disabled={!armed || busy}
            onClick={async () => {
              setBusy(true);
              try { await api.archiveProject(project.id); onDeleted(); } catch (err) {
                setError(err instanceof ApiError ? err.message : 'could not delete it');
                setBusy(false);
              }
            }}
          >Delete product</button>
        </div>
      </div>
    </div>
  );
}

/** Share ONE product with one person at a time — never the whole workshop. */
function ShareDialog(props: { project: { id: string; name: string }; onClose: () => void }) {
  const { project, onClose } = props;
  const [shares, setShares] = useState<Share[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('viewer');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api.listShares(project.id)
      .then((s) => { if (live) setShares(s); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'could not load shares'); });
    return () => { live = false; };
  }, [project.id]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setNote(null);
    try {
      setShares(await api.share(project.id, email.trim(), role));
      setNote(`${email.trim()} was emailed a link.`);
      setEmail('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not share it');
    } finally { setBusy(false); }
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog-card" role="dialog" aria-modal="true" aria-label="Share product">
        <div className="dialog-head">
          <h3>Share “{project.name}”</h3>
          <button className="ghost" data-testid="share-close" onClick={onClose}>Done</button>
        </div>
        <form className="share-add" onSubmit={add}>
          <input
            type="email" required placeholder="name@theirshop.com" data-testid="share-email"
            value={email} onChange={(e) => setEmail(e.target.value)}
          />
          <select value={role} data-testid="share-role" onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}>
            <option value="viewer">Can view</option>
            <option value="editor">Can edit</option>
          </select>
          <button className="cta" type="submit" data-testid="share-send" disabled={busy}>Share</button>
        </form>
        <p className="hint">
          They sign in with that email address and find it under “Shared with you”. Viewers can
          open and try the product; editors can change it. Your workshop stays yours.
        </p>
        {shares === null && !error && <p className="dash-note">Loading…</p>}
        {!!shares?.length && (
          <ul className="people-list">
            {shares.map((s) => (
              <li key={s.id}>
                <span className="avatar avatar-sm">{initials(s.email)}</span>
                <span className="people-email">{s.email}</span>
                <select
                  className="people-role" value={s.role} data-testid={`share-role-${s.id}`}
                  onChange={async (e) => {
                    try { setShares(await api.share(project.id, s.email, e.target.value as 'editor' | 'viewer')); }
                    catch (err) { setError(err instanceof ApiError ? err.message : 'could not change that'); }
                  }}
                >
                  <option value="viewer">Can view</option>
                  <option value="editor">Can edit</option>
                </select>
                <button
                  className="ghost danger" data-testid={`unshare-${s.id}`}
                  onClick={async () => {
                    try { setShares(await api.unshare(project.id, s.id)); } catch (err) {
                      setError(err instanceof ApiError ? err.message : 'could not remove them');
                    }
                  }}
                >Remove</button>
              </li>
            ))}
          </ul>
        )}
        {shares?.length === 0 && <p className="dash-note">Not shared with anyone yet.</p>}
        {note && <p className="hint" role="status">{note}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
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

  const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog-card" role="dialog" aria-modal="true" aria-label="People">
        <div className="dialog-head">
          <h3>People &amp; roles</h3>
          <button className="ghost" data-testid="people-close" onClick={onClose}>Done</button>
        </div>
        <form className="share-add" onSubmit={invite}>
          <input
            type="email" required placeholder="name@theirshop.com" data-testid="invite-email"
            value={email} onChange={(e) => setEmail(e.target.value)}
          />
          <select value={role} data-testid="invite-role" onChange={(e) => setRole(e.target.value as Role)}>
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
            <option value="owner">Owner</option>
          </select>
          <button className="cta" type="submit" data-testid="invite-send">Invite</button>
        </form>
        <p className="hint">
          Owners manage people and can delete products. Editors author and publish.
          Viewers look without touching. Everyone here sees <strong>every</strong> product in the
          workshop — to open just one product to someone, use <strong>Share</strong> on its card instead.
        </p>
        {members === null && !error && <p className="dash-note">Loading…</p>}
        <ul className="people-list">
          {members?.map((m) => (
            <li key={m.id}>
              <span className="avatar avatar-sm">{initials(m.email)}</span>
              <span className="people-email">
                {m.email}
                {m.id === meId && <em className="people-you"> · you</em>}
              </span>
              <span className="people-role-pill">{ROLE_LABEL[m.role]}</span>
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
        {note && <p className="hint" role="status">{note}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
