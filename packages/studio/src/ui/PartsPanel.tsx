// The parts explorer. The manifest renders as ENTRIES — a loose part, an
// assembly (parts treated as one), or a pick-one set (customers choose one,
// mutually exclusive) — in the order customers will meet them.
//
// Structure is rearranged by DRAGGING the six-dot handle: drop a row between
// rows to reorder, drop a loose part onto an assembly or pick-one set to add
// it, drag a member out to set it loose. The drag is plain pointer maths
// (no HTML5 DnD — its ghost images and enter/leave churn fight custom drop
// zones); every drop commits through a tested edit op, so an illegal drop is
// refused by the edit layer, not by fragile UI guards.

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Manifest, ChoiceOption } from '../../../embed/src/manifest/types.ts';
import type { Selections } from '../../../embed/src/runtime/state.ts';
import {
  renamePart, removePart,
  entriesOf, moveEntryTo, makeGroup, makeVariantChoice,
  ungroup, dissolveVariantChoice,
  addPartToGroup, removePartFromGroup, addPartToChoice, removePartFromChoice,
  type ExplorerEntry,
} from '../lib/manifest-edit.ts';
import type { Project, SetManifestOptions } from '../App.tsx';

const EYE = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>;
const EYE_OFF = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>;
const DOTS = (
  <svg width="8" height="14" viewBox="0 0 8 14" aria-hidden="true">
    {[2, 7, 12].flatMap((cy) => [2, 6].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.3" fill="currentColor" />))}
  </svg>
);

type DragSource =
  | { kind: 'entry'; id: string }
  | { kind: 'member'; partId: string; parent: { kind: 'group' | 'variant'; id: string } };
type DropTarget =
  | { kind: 'reorder'; index: number }
  | { kind: 'into'; entryId: string; entryKind: 'group' | 'variant' }
  | { kind: 'out' }
  | null;

export function PartsPanel(props: {
  project: Project;
  selectedPart: string | null;
  hiddenParts: Set<string>;
  solo: string | null;
  /** What the viewer currently shows — tells pick-one rows which member is live. */
  selections: Selections;
  editingGroup: string | null;
  onSelectPart: (id: string | null) => void;
  onEditGroup: (id: string | null) => void;
  onSetHidden: (ids: string[], hidden: boolean) => void;
  onSolo: (id: string | null) => void;
  onHideAll: (hide: boolean) => void;
  onChange: (m: Manifest, opts?: SetManifestOptions) => void;
}) {
  const { manifest } = props.project;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<null | 'group' | 'variant'>(null);
  const [structureLabel, setStructureLabel] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<DragSource | null>(null);
  const [drop, setDrop] = useState<DropTarget>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const entries = entriesOf(manifest);
  if (!manifest.parts.length) return <p className="empty">No parts in this model.</p>;

  const act = (fn: () => Manifest) => {
    try { props.onChange(fn()); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const isHidden = (id: string) => (props.solo ? props.solo !== id : props.hiddenParts.has(id));
  const toggleChecked = (id: string) => setChecked((old) => {
    const next = new Set(old);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // ── drag machinery ─────────────────────────────────────────────────────────

  const resolveDrop = (source: DragSource, x: number, y: number): DropTarget => {
    for (const el of document.elementsFromPoint(x, y)) {
      const d = (el as HTMLElement).dataset ?? {};
      if (d.dropInto !== undefined) {
        const entry = entries.find((en) => en.id === d.dropInto);
        if (!entry || entry.kind === 'part') continue;
        // Hovering a member over its own bundle means nothing — not "out".
        if (source.kind === 'member' && source.parent.id === entry.id) return null;
        const joinable = source.kind === 'entry'
          ? entries.find((en) => en.id === source.id)?.kind === 'part' && source.id !== entry.id
          : true;
        // A bundle header doubles as a reorder row: its middle band means
        // "into", its edges mean "before/after".
        if (d.dropIndex !== undefined) {
          const r = (el as HTMLElement).getBoundingClientRect();
          const band = (y - r.top) / r.height;
          if (!joinable || band < 0.25 || band > 0.75) {
            if (source.kind === 'member') return { kind: 'out' };
            return { kind: 'reorder', index: band < 0.5 ? Number(d.dropIndex) : Number(d.dropIndex) + 1 };
          }
        }
        if (joinable) return { kind: 'into', entryId: entry.id, entryKind: entry.kind };
        continue;
      }
      if (d.dropIndex !== undefined) {
        if (source.kind === 'member') return { kind: 'out' };
        const r = (el as HTMLElement).getBoundingClientRect();
        const before = y < r.top + r.height / 2;
        const idx = Number(d.dropIndex);
        return { kind: 'reorder', index: before ? idx : idx + 1 };
      }
      if (d.dropRoot !== undefined) return source.kind === 'member' ? { kind: 'out' } : null;
    }
    return null;
  };

  const commitDrop = (source: DragSource, target: DropTarget) => {
    if (!target) return;
    if (source.kind === 'entry') {
      if (target.kind === 'reorder') {
        const at = entries.findIndex((e) => e.id === source.id);
        let to = target.index;
        if (at < to) to -= 1;
        if (to !== at) act(() => moveEntryTo(manifest, source.id, to));
      } else if (target.kind === 'into') {
        act(() => (target.entryKind === 'group'
          ? addPartToGroup(manifest, target.entryId, source.id)
          : addPartToChoice(manifest, target.entryId, source.id)));
      }
      return;
    }
    const pullOut = (m: Manifest) => (source.parent.kind === 'group'
      ? removePartFromGroup(m, source.parent.id, source.partId)
      : removePartFromChoice(m, source.parent.id, source.partId));
    if (target.kind === 'into' && target.entryId !== source.parent.id) {
      // Moving between bundles is one edit (and one undo step).
      act(() => (target.entryKind === 'group'
        ? addPartToGroup(pullOut(manifest), target.entryId, source.partId)
        : addPartToChoice(pullOut(manifest), target.entryId, source.partId)));
    } else if (target.kind === 'out' || target.kind === 'reorder') {
      act(() => pullOut(manifest));
    }
  };

  const beginDrag = (source: DragSource) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      moved = true;
      setDrag(source);
      setDrop(resolveDrop(source, ev.clientX, ev.clientY));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      setDrop(null);
      if (moved) commitDrop(source, resolveDrop(source, ev.clientX, ev.clientY));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const handle = (source: DragSource, id: string) => (
    <button
      className="drag-dots" data-testid={`drag-${id}`}
      aria-label="Drag to reorder, or drop onto an assembly / pick-one set"
      onPointerDown={beginDrag(source)}
    >{DOTS}</button>
  );

  const dropClass = (index: number, entryId?: string) => {
    let cls = '';
    if (drop?.kind === 'reorder') {
      if (drop.index === index) cls += ' is-drop-before';
      if (index === entries.length - 1 && drop.index === entries.length) cls += ' is-drop-after';
    }
    if (drop?.kind === 'into' && entryId && drop.entryId === entryId) cls += ' is-drop-into';
    return cls;
  };

  // ── rows ───────────────────────────────────────────────────────────────────

  const confirmStructure = () => {
    const ids = manifest.parts.map((p) => p.id).filter((id) => checked.has(id));
    act(() => (pending === 'group'
      ? makeGroup(manifest, ids, structureLabel)
      : makeVariantChoice(manifest, ids, structureLabel)));
    setChecked(new Set());
    setPending(null);
    setStructureLabel('');
  };

  const partRow = (
    p: { id: string; label: string },
    opts: { member?: boolean; live?: boolean; pickable?: boolean; source?: DragSource } = {},
  ) => {
    const hidden = isHidden(p.id);
    const active = !props.editingGroup && p.id === props.selectedPart;
    const dragging = drag?.kind === 'member' && drag.partId === p.id;
    return (
      <div key={p.id} className={`part-row${opts.member ? ' is-member' : ''}${active ? ' is-active' : ''}${hidden ? ' is-hidden' : ''}${dragging ? ' is-dragging' : ''}`}>
        {opts.source && handle(opts.source, p.id)}
        {opts.pickable && (
          <input
            type="checkbox" className="pick" data-testid={`pick-${p.id}`}
            checked={checked.has(p.id)} onChange={() => toggleChecked(p.id)}
            aria-label={`Select ${p.label} for combining`}
          />
        )}
        <button
          className="mini icon" data-testid={`eye-${p.id}`} aria-label={hidden ? `Show ${p.label}` : `Hide ${p.label}`}
          onClick={() => props.onSetHidden([p.id], !props.hiddenParts.has(p.id))}
        >{hidden ? EYE_OFF : EYE}</button>
        <button
          className={`mini icon${props.solo === p.id ? ' is-active' : ''}`}
          data-testid={`solo-${p.id}`} title="Show only this part"
          onClick={() => props.onSolo(props.solo === p.id ? null : p.id)}
        >◎</button>
        {renaming === p.id ? (
          <input
            className="rename-input" autoFocus defaultValue={p.label} data-testid={`rename-input-${p.id}`}
            onBlur={(e) => { setRenaming(null); if (e.target.value.trim() && e.target.value !== p.label) act(() => renamePart(manifest, p.id, e.target.value)); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }}
          />
        ) : (
          <button
            className="part-name" role="option" aria-selected={active}
            onClick={() => { props.onEditGroup(null); props.onSelectPart(p.id); }}
            onDoubleClick={() => setRenaming(p.id)}
          >
            {opts.live !== undefined && <span className={`live-dot${opts.live ? ' is-live' : ''}`} title={opts.live ? 'Currently shown' : 'Hidden — click to show'} />}
            {p.label}
          </button>
        )}
        <button className="mini icon" data-testid={`rename-${p.id}`} aria-label={`Rename ${p.label}`} onClick={() => setRenaming(p.id)}>✎</button>
        <button
          className="mini icon danger" data-testid={`delete-${p.id}`} aria-label={`Delete ${p.label}`}
          onClick={() => {
            if (!confirm(`Delete ${p.label}? Parts anchored to it keep their position.`)) return;
            act(() => removePart(manifest, p.id, props.project.raw));
            if (props.selectedPart === p.id) props.onSelectPart(null);
          }}
        >✕</button>
      </div>
    );
  };

  const bundleRow = (entry: ExplorerEntry & { kind: 'group' | 'variant' }, index: number) => {
    const open = !collapsed.has(entry.id);
    const allHidden = entry.parts.every((id) => props.hiddenParts.has(id));
    const partsById = new Map(manifest.parts.map((p) => [p.id, p]));
    const option = entry.kind === 'variant'
      ? manifest.options.find((o): o is ChoiceOption => o.id === entry.id && o.type === 'choice')
      : undefined;
    const dragging = drag?.kind === 'entry' && drag.id === entry.id;
    return (
      <div key={entry.id} className={`entry${dropClass(index, entry.id)}`}>
        <div
          className={`part-row is-bundle${entry.kind === 'group' && props.editingGroup === entry.id ? ' is-active' : ''}${dragging ? ' is-dragging' : ''}`}
          data-drop-into={entry.id} data-drop-index={index}
        >
          {handle({ kind: 'entry', id: entry.id }, entry.id)}
          <button
            className="mini icon" aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open}
            onClick={() => setCollapsed((old) => {
              const next = new Set(old);
              if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
              return next;
            })}
          >{open ? '▾' : '▸'}</button>
          <button
            className="mini icon" data-testid={`eye-${entry.id}`}
            aria-label={allHidden ? `Show ${entry.label}` : `Hide ${entry.label}`}
            onClick={() => props.onSetHidden(entry.parts, !allHidden)}
          >{allHidden ? EYE_OFF : EYE}</button>
          <button
            className="part-name"
            onClick={() => {
              if (entry.kind === 'group') { props.onSelectPart(null); props.onEditGroup(entry.id); }
              else setCollapsed((old) => { const next = new Set(old); next.delete(entry.id); return next; });
            }}
          >
            {entry.label}
            <span className="tag">{entry.kind === 'group' ? 'assembly' : 'pick one'}</span>
          </button>
          {entry.kind === 'group' ? (
            <button
              className="mini" data-testid={`ungroup-${entry.id}`} title="Split the assembly up; parts stay put"
              onClick={() => { props.onEditGroup(null); act(() => ungroup(manifest, entry.id)); }}
            >Split</button>
          ) : (
            <button
              className="mini" data-testid={`dissolve-${entry.id}`} title="Remove the choice; all parts always included"
              onClick={() => act(() => dissolveVariantChoice(manifest, entry.id))}
            >Dissolve</button>
          )}
        </div>
        {open && (
          <div className="entry-members" data-drop-into={entry.id}>
            {entry.parts.map((id) => {
              const p = partsById.get(id);
              if (!p) return null;
              return partRow(p, {
                member: true,
                live: option ? props.selections[option.id] === id : undefined,
                source: { kind: 'member', partId: id, parent: { kind: entry.kind, id: entry.id } },
              });
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="panel-body" data-drop-root="">
      <div className="part-list-head">
        <span className="hint">Parts</span>
        <span className="spacer" />
        <button className="mini" data-testid="show-all" onClick={() => { props.onHideAll(false); props.onSolo(null); }}>Show all</button>
        <button className="mini" data-testid="hide-all" onClick={() => props.onHideAll(true)}>Hide all</button>
      </div>
      <div
        className={`part-rows${drag ? ' is-drag-live' : ''}`} role="listbox" aria-label="Parts"
        ref={listRef} data-drop-root=""
      >
        {entries.map((entry, index) => {
          if (entry.kind !== 'part') return bundleRow(entry, index);
          const p = manifest.parts.find((x) => x.id === entry.id)!;
          const dragging = drag?.kind === 'entry' && drag.id === entry.id;
          return (
            <div key={entry.id} className={`entry${dropClass(index)}`}>
              <div className={`entry-line${dragging ? ' is-dragging' : ''}`} data-drop-index={index}>
                {partRow(p, { pickable: true, source: { kind: 'entry', id: entry.id } })}
              </div>
            </div>
          );
        })}
      </div>
      <p className="hint">
        Drag the ⣿ handle to reorder. Drop a part onto an <strong>assembly</strong> or
        <strong> pick-one set</strong> to add it; drag a part out to set it loose.
      </p>

      {checked.size >= 2 && (
        <div className="structure-bar" data-testid="structure-bar">
          {pending === null ? (
            <>
              <span className="hint">{checked.size} parts selected —</span>
              <button className="mini" data-testid="make-group" title="Move and colour as one part" onClick={() => setPending('group')}>Assembly</button>
              <button className="mini" data-testid="make-variant" title="Customers pick which one they get" onClick={() => setPending('variant')}>Pick-one set</button>
            </>
          ) : (
            <>
              <input
                className="structure-name" autoFocus data-testid="structure-label"
                placeholder={pending === 'group' ? 'Assembly name (e.g. Shell)' : 'Choice name — customers see it (e.g. Lid style)'}
                value={structureLabel} onChange={(e) => setStructureLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmStructure(); if (e.key === 'Escape') setPending(null); }}
              />
              <button className="mini" data-testid="structure-confirm" onClick={confirmStructure}>
                {pending === 'group' ? 'Create assembly' : 'Create pick-one set'}
              </button>
              <button className="mini" onClick={() => { setPending(null); setStructureLabel(''); }}>✕</button>
            </>
          )}
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
