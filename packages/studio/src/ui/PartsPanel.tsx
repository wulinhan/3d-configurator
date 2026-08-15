// The parts explorer. The manifest renders as ENTRIES — a loose part, an
// assembly (parts treated as one), or a variant set (customers choose one,
// mutually exclusive) — in the order customers will meet them.
//
// Structure is rearranged by DRAGGING the six-dot handle: drop a row between
// rows to reorder, drop a loose part onto an assembly or variant set to add
// it, drag a member out to set it loose. The drag is plain pointer maths
// (no HTML5 DnD — its ghost images and enter/leave churn fight custom drop
// zones); every drop commits through a tested edit op, so an illegal drop is
// refused by the edit layer, not by fragile UI guards.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Manifest, ChoiceOption } from '../../../embed/src/manifest/types.ts';
import type { Selections } from '../../../embed/src/runtime/state.ts';
import {
  renamePart, removePart, renameGroup, renameVariantSet,
  entriesOf, moveEntryTo, makeGroup, makeVariantChoice,
  ungroup, dissolveVariantChoice,
  addPartToGroup, removePartFromGroup, addPartToChoice, removePartFromChoice,
  type ExplorerEntry,
} from '../lib/manifest-edit.ts';
import type { PartColour, Project, SetManifestOptions } from '../App.tsx';
import { ConfirmDialog } from './controls.tsx';
import { PrimitiveDialog, ImageTemplateDialog } from './AddShapeDialog.tsx';
import { ImportDialog } from './ImportDialog.tsx';
import type { ImportedPart } from '../lib/types.ts';

const EYE = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>;
const EYE_OFF = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>;
const DOTS = (
  <svg width="8" height="14" viewBox="0 0 8 14" aria-hidden="true">
    {[2, 7, 12].flatMap((cy) => [2, 6].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.3" fill="currentColor" />))}
  </svg>
);
// Copy: two overlapping squares (the Lucide "copy" glyph).
const DUP = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
// Dissolve/split: two squares moving apart (the Lucide "ungroup" glyph).
const UNGROUP = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="8" height="8" rx="1.5" />
    <rect x="13" y="12" width="8" height="8" rx="1.5" />
  </svg>
);
// The three ways parts arrive, each with its glyph (Lucide outlines, like
// the rest of the panel): a file coming up into the project, the primitive
// shapes, and a picture.
const ICO_IMPORT = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);
const ICO_SHAPES = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <circle cx="17.5" cy="17.5" r="3.5" />
  </svg>
);
const ICO_IMAGE = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
  </svg>
);
// Tick everything: a checked box (the Lucide "check-square" glyph).
const ICO_SELECT_ALL = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="9 11 12 14 22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
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
  /** What the viewer currently shows — tells variant rows which member is live. */
  selections: Selections;
  editingGroup: string | null;
  editingVariant: string | null;
  onSelectPart: (id: string | null) => void;
  onEditGroup: (id: string | null) => void;
  onEditVariant: (id: string | null) => void;
  onAddModel: (file: File) => Promise<void>;
  /** Parts the Studio generated (primitives, traced templates) — already in
   * canonical space, so they skip importModel's re-orientation. Colours ride
   * along for traced artwork. */
  onAddParts: (parts: ImportedPart[], colours?: (PartColour | null)[]) => void;
  /** Which way imported files are up — applies to the NEXT file added. */
  axes: string;
  onAxesChange: (axes: string) => void;
  onSetHidden: (ids: string[], hidden: boolean) => void;
  /** The ☑-ticked parts — owned by the App (Ctrl+A, Delete, Export). */
  checked: string[];
  onCheckedChange: (ids: string[]) => void;
  onSolo: (id: string | null) => void;
  onHideAll: (hide: boolean) => void;
  onDuplicate: (entryId: string) => void;
  onChange: (m: Manifest, opts?: SetManifestOptions) => void;
}) {
  const { manifest } = props.project;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<null | 'group' | 'variant'>(null);
  const [structureLabel, setStructureLabel] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<DragSource | null>(null);
  const [dragXY, setDragXY] = useState<{ x: number; y: number } | null>(null);
  const [drop, setDrop] = useState<DropTarget>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [shapeDialog, setShapeDialog] = useState(false);
  const [importDialog, setImportDialog] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);

  const entries = entriesOf(manifest);

  // The tick-set lives in the App (Ctrl+A and the Delete key act on it from
  // anywhere, Export exports it); this panel renders and edits it.
  const checked = new Set(props.checked);
  const setChecked = (next: Set<string>) => props.onCheckedChange([...next]);

  const act = (fn: () => Manifest) => {
    try { props.onChange(fn()); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const isHidden = (id: string) => (props.solo ? props.solo !== id : props.hiddenParts.has(id));
  const toggleChecked = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setChecked(next);
  };

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
      setDragXY({ x: ev.clientX, y: ev.clientY });
      setDrop(resolveDrop(source, ev.clientX, ev.clientY));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      setDragXY(null);
      setDrop(null);
      if (moved) commitDrop(source, resolveDrop(source, ev.clientX, ev.clientY));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const handle = (source: DragSource, id: string) => (
    <button
      className="drag-dots" data-testid={`drag-${id}`}
      aria-label="Drag to reorder, or drop onto an assembly / variant set"
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
            size={Math.max(p.label.length + 2, 8)}
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
        <span className="spacer" />
        {!opts.member && (
          <button
            className="mini icon" data-testid={`duplicate-${p.id}`} aria-label={`Duplicate ${p.label}`}
            title="Duplicate this part"
            onClick={() => { try { props.onDuplicate(p.id); setError(null); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } }}
          >{DUP}</button>
        )}
        <button
          className="mini icon danger" data-testid={`delete-${p.id}`} aria-label={`Delete ${p.label}`}
          onClick={() => setConfirmDelete([p.id])}
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
          className={`part-row is-bundle${(entry.kind === 'group' ? props.editingGroup : props.editingVariant) === entry.id ? ' is-active' : ''}${dragging ? ' is-dragging' : ''}`}
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
          >
            <svg className={`chev${open ? ' is-open' : ''}`} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5.5 3.5 11 8 5.5 12.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            className="mini icon" data-testid={`eye-${entry.id}`}
            aria-label={allHidden ? `Show ${entry.label}` : `Hide ${entry.label}`}
            onClick={() => props.onSetHidden(entry.parts, !allHidden)}
          >{allHidden ? EYE_OFF : EYE}</button>
          {renaming === entry.id ? (
            <input
              className="rename-input" autoFocus defaultValue={entry.label} data-testid={`rename-input-${entry.id}`}
              size={Math.max(entry.label.length + 2, 8)}
              onBlur={(e) => {
                setRenaming(null);
                if (e.target.value.trim() && e.target.value !== entry.label) {
                  act(() => (entry.kind === 'group'
                    ? renameGroup(manifest, entry.id, e.target.value)
                    : renameVariantSet(manifest, entry.id, e.target.value)));
                }
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }}
            />
          ) : (
            <button
              className="part-name"
              onClick={() => {
                props.onSelectPart(null);
                if (entry.kind === 'group') props.onEditGroup(entry.id);
                else props.onEditVariant(entry.id);
              }}
              onDoubleClick={() => setRenaming(entry.id)}
            >
              {entry.label}
              <span className="tag">{entry.kind === 'group' ? 'assembly' : 'variants'}</span>
            </button>
          )}
          <span className="spacer" />
          <button
            className="mini icon" data-testid={`duplicate-${entry.id}`}
            aria-label={`Duplicate ${entry.label}`} title="Duplicate the whole set"
            onClick={() => { try { props.onDuplicate(entry.id); setError(null); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } }}
          >{DUP}</button>
          {entry.kind === 'group' ? (
            <button
              className="mini icon" data-testid={`ungroup-${entry.id}`}
              aria-label={`Split ${entry.label} up`} title="Split the assembly up; parts stay put"
              onClick={() => { props.onEditGroup(null); act(() => ungroup(manifest, entry.id)); }}
            >{UNGROUP}</button>
          ) : (
            <button
              className="mini icon" data-testid={`dissolve-${entry.id}`}
              aria-label={`Dissolve ${entry.label}`} title="Remove the choice; all parts always included"
              onClick={() => { props.onEditVariant(null); act(() => dissolveVariantChoice(manifest, entry.id)); }}
            >{UNGROUP}</button>
          )}
          <button
            className="mini icon danger" data-testid={`delete-${entry.id}`}
            aria-label={`Delete ${entry.label} and its parts`}
            title={entry.kind === 'group' ? 'Delete the assembly AND every part in it' : 'Delete the set AND every part in it'}
            onClick={() => setConfirmDelete([...entry.parts])}
          >✕</button>
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

  const addFromFile = (file: File) => {
    props.onAddModel(file)
      .then(() => setError(null))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div
      className="panel-body" data-drop-root=""
      // Dropping a model FILE adds its parts; the row-drag machinery above is
      // pointer-based, so the two drags never collide.
      onDragOver={(e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); }}
      onDrop={(e) => {
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        e.preventDefault();
        addFromFile(file);
      }}
    >
      <div className="part-list-head">
        <span className="hint">Parts</span>
        <span className="spacer" />
        <button
          className="mini ico-label" data-testid="add-model"
          title="Add parts from another 3MF / STL / GLB — or drop the file anywhere on this panel"
          onClick={() => setImportDialog(true)}
        >{ICO_IMPORT} Import</button>
        <button
          className="mini ico-label" data-testid="new-shape"
          title="A ready-made solid: cuboid, cylinder, n-sided prism or torus"
          onClick={() => setShapeDialog(true)}
        >{ICO_SHAPES} Shape</button>
        <button
          className="mini ico-label" data-testid="new-from-image"
          title="Trace an SVG / PNG / JPG into a colouring template: raised lines on a plate shaped like the artwork"
          onClick={() => imageInputRef.current?.click()}
        >{ICO_IMAGE} Image</button>
        <span className="head-sep" aria-hidden="true" />
        <button
          className={`mini icon${checked.size && checked.size === manifest.parts.length ? ' is-active' : ''}`}
          data-testid="select-all" disabled={!manifest.parts.length}
          title={checked.size === manifest.parts.length && checked.size
            ? 'Unselect all parts'
            : 'Select all parts (Ctrl+A) — then Delete, or Export'}
          aria-label="Select or unselect all parts"
          onClick={() => setChecked(checked.size === manifest.parts.length
            ? new Set()
            : new Set(manifest.parts.map((p) => p.id)))}
        >{ICO_SELECT_ALL}</button>
        <button
          className="mini icon" data-testid="show-all" title="Show all parts" aria-label="Show all parts"
          onClick={() => { props.onHideAll(false); props.onSolo(null); }}
        >{EYE}</button>
        <button
          className="mini icon" data-testid="hide-all" title="Hide all parts" aria-label="Hide all parts"
          onClick={() => props.onHideAll(true)}
        >{EYE_OFF}</button>
        <input
          ref={addInputRef} type="file" hidden data-testid="add-model-input"
          accept=".3mf,.stl,.glb,model/gltf-binary"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) addFromFile(f); setImportDialog(false); e.target.value = ''; }}
        />
        <input
          ref={imageInputRef} type="file" hidden data-testid="image-template-input"
          accept=".svg,.png,.jpg,.jpeg,.webp"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) setImageFile(f); e.target.value = ''; }}
        />
      </div>
      {!manifest.parts.length && (
        <div className="start-cards" data-testid="empty-parts">
          <button className="start-card" data-testid="start-import" onClick={() => setImportDialog(true)}>
            <span className="start-ico">{ICO_IMPORT}</span>
            <span>
              <strong>Import a model</strong>
              <small>3MF, STL or GLB — or drop the file anywhere on this panel</small>
            </span>
          </button>
          <button className="start-card" data-testid="start-shape" onClick={() => setShapeDialog(true)}>
            <span className="start-ico">{ICO_SHAPES}</span>
            <span>
              <strong>Start from a shape</strong>
              <small>Cuboid, cylinder, n-sided prism or torus, sized in millimetres</small>
            </span>
          </button>
          <button className="start-card" data-testid="start-image" onClick={() => imageInputRef.current?.click()}>
            <span className="start-ico">{ICO_IMAGE}</span>
            <span>
              <strong>Trace an image</strong>
              <small>SVG, PNG or JPG — colours become parts, lines become raised ridges</small>
            </span>
          </button>
        </div>
      )}
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
      {manifest.parts.length > 0 && <div className="structure-new">
        <button
          className="mini" data-testid="new-variant" disabled={checked.size < 2}
          title={checked.size < 2
            ? 'Tick the ☐ boxes on two or more parts first'
            : 'Customers pick exactly one of the chosen parts'}
          onClick={() => setPending('variant')}
        >＋ Variant set</button>
        <button
          className="mini" data-testid="new-group" disabled={checked.size < 2}
          title={checked.size < 2
            ? 'Tick the ☐ boxes on two or more parts first'
            : 'The chosen parts move and colour as one'}
          onClick={() => setPending('group')}
        >＋ Assembly</button>
      </div>}

      {(pending !== null || checked.size >= 1) && (
        <div className="structure-bar" data-testid="structure-bar">
          {pending === null ? (
            <>
              <span className="hint">{checked.size} selected —</span>
              {checked.size >= 2 && (
                <>
                  <button className="mini" data-testid="make-group" title="Move and colour as one part" onClick={() => setPending('group')}>Assembly</button>
                  <button className="mini" data-testid="make-variant" title="Customers pick which one they get" onClick={() => setPending('variant')}>Variant set</button>
                </>
              )}
              <button
                className="mini danger" data-testid="delete-selected"
                onClick={() => setConfirmDelete(manifest.parts.map((p) => p.id).filter((id) => checked.has(id)))}
              >Delete</button>
            </>
          ) : (
            <>
              {checked.size < 2 && (
                <span className="hint" data-testid="structure-guide">
                  Tick the ☐ boxes on at least two parts to include them, then name the {pending === 'group' ? 'assembly' : 'set'}:
                </span>
              )}
              <input
                className="structure-name" autoFocus data-testid="structure-label"
                placeholder={pending === 'group' ? 'Assembly name (e.g. Shell)' : 'Choice name — customers see it (e.g. Lid style)'}
                value={structureLabel} onChange={(e) => setStructureLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmStructure(); if (e.key === 'Escape') setPending(null); }}
              />
              <button
                className="mini" data-testid="structure-confirm"
                disabled={checked.size < 2}
                onClick={confirmStructure}
              >
                {pending === 'group' ? 'Create assembly' : 'Create variant set'}
              </button>
              <button className="mini" onClick={() => { setPending(null); setStructureLabel(''); }}>✕</button>
            </>
          )}
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      {drag && dragXY && (() => {
        // The card riding the cursor — the dnd-kit DragOverlay pattern: the
        // row itself dims in place, a copy travels with the pointer.
        const entry = drag.kind === 'entry' ? entries.find((e) => e.id === drag.id) : undefined;
        const label = drag.kind === 'member'
          ? manifest.parts.find((p) => p.id === drag.partId)?.label ?? drag.partId
          : entry && entry.kind !== 'part'
            ? entry.label
            : manifest.parts.find((p) => p.id === drag.id)?.label ?? drag.id;
        return (
          <div className="drag-ghost" style={{ left: dragXY.x + 14, top: dragXY.y + 10 }}>
            {DOTS}
            <span>{label}</span>
            {entry && entry.kind !== 'part' && (
              <span className="tag">{entry.kind === 'group' ? 'assembly' : 'variants'}</span>
            )}
          </div>
        );
      })()}

      {confirmDelete && (
        <ConfirmDialog
          testId="confirm-delete"
          title={confirmDelete.length === 1
            ? `Delete ${manifest.parts.find((p) => p.id === confirmDelete[0])?.label ?? confirmDelete[0]}?`
            : `Delete ${confirmDelete.length} parts?`}
          body={<p>Parts anchored to deleted ones keep their position. Colour options and pricing tied to them are removed. This can be undone with Ctrl+Z.</p>}
          confirmLabel={confirmDelete.length === 1 ? 'Delete part' : `Delete ${confirmDelete.length} parts`}
          confirmKeys={['Delete', 'Backspace']}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const ids = confirmDelete;
            setConfirmDelete(null);
            act(() => ids.reduce((mm, id) => removePart(mm, id, props.project.raw), manifest));
            setChecked(new Set([...checked].filter((id) => !ids.includes(id))));
            if (props.selectedPart && ids.includes(props.selectedPart)) props.onSelectPart(null);
          }}
        />
      )}

      {importDialog && (
        <ImportDialog
          axes={props.axes}
          onAxesChange={props.onAxesChange}
          onFile={(file) => { addFromFile(file); setImportDialog(false); }}
          onBrowse={() => addInputRef.current?.click()}
          onClose={() => setImportDialog(false)}
        />
      )}
      {shapeDialog && (
        <PrimitiveDialog
          onAdd={(parts) => props.onAddParts(parts)}
          onClose={() => setShapeDialog(false)}
        />
      )}
      {imageFile && (
        <ImageTemplateDialog
          file={imageFile}
          palette={manifest.palettes?.[0]?.swatches ?? []}
          onAdd={(parts, colours) => props.onAddParts(parts, colours)}
          onClose={() => setImageFile(null)}
        />
      )}
    </div>
  );
}
