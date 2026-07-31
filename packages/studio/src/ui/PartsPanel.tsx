// The parts explorer and per-part editing. The explorer renders the manifest
// as ENTRIES — a loose part, a group (parts treated as one), or a variant
// choice (customer picks one, mutually exclusive) — in the order customers
// will meet them; ▲▼ reorders whole entries. Multi-selecting loose parts
// grows an action bar that turns them into a group or a choice. Every
// control calls a tested edit op; this file only renders and routes.

import { useState } from 'react';
import type { Manifest, AnchorEdge, ColourOption, ChoiceOption } from '../../../embed/src/manifest/types.ts';
import type { Selections } from '../../../embed/src/runtime/state.ts';
import {
  sizeMm, withSizeMm, withAnchor, withRotation,
  makePartOptional, makePartRequired, setChoicePrice,
  renamePart, removePart, setDefaultSwatch, copyPlacement, setCustomColour,
  entriesOf, moveEntry, makeGroup, makeVariantChoice,
  ungroup, renameGroup, nudgeGroup, dissolveVariantChoice,
  AXIS_NAMES, type Axis, type ExplorerEntry,
} from '../lib/manifest-edit.ts';
import type { Project, SetManifestOptions } from '../App.tsx';
import { NumberField } from './fields.tsx';

const AXIS_LABELS = ['W', 'H', 'D'] as const; // x, y, z in canonical space
const EDGES: AnchorEdge[] = ['min', 'center', 'max'];

// The Studio speaks Z-up: X and Y are the flat plane, Z is height. The
// internal space (manifest, renderer) stays Y-up — this table is purely how
// axes are named and ordered on screen.
const UI_AXES: Array<{ label: string; axis: Axis }> = [
  { label: 'X', axis: 0 }, // internal x — width
  { label: 'Y', axis: 2 }, // internal z — depth
  { label: 'Z', axis: 1 }, // internal y — height
];

const EYE = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>;
const EYE_OFF = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>;

export function PartsPanel(props: {
  project: Project;
  selectedPart: string | null;
  hiddenParts: Set<string>;
  solo: string | null;
  /** What the viewer currently shows — tells variant rows which member is live. */
  selections: Selections;
  onSelectPart: (id: string | null) => void;
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
  // Which group's editor is open; outranks the part editor while set.
  const [editingGroup, setEditingGroup] = useState<string | null>(null);

  const entries = entriesOf(manifest);
  const group = editingGroup ? manifest.groups?.find((g) => g.id === editingGroup) : undefined;
  const part = manifest.parts.find((p) => p.id === props.selectedPart) ?? manifest.parts[0];
  if (!part) return <p className="empty">No parts in this model.</p>;

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

  const confirmStructure = () => {
    const ids = manifest.parts.map((p) => p.id).filter((id) => checked.has(id));
    act(() => (pending === 'group'
      ? makeGroup(manifest, ids, structureLabel)
      : makeVariantChoice(manifest, ids, structureLabel)));
    setChecked(new Set());
    setPending(null);
    setStructureLabel('');
  };

  const partRow = (p: { id: string; label: string }, opts: { member?: boolean; live?: boolean; pickable?: boolean } = {}) => {
    const hidden = isHidden(p.id);
    const active = !editingGroup && p.id === part.id;
    return (
      <div key={p.id} className={`part-row${opts.member ? ' is-member' : ''}${active ? ' is-active' : ''}${hidden ? ' is-hidden' : ''}`}>
        {opts.pickable && (
          <input
            type="checkbox" className="pick" data-testid={`pick-${p.id}`}
            checked={checked.has(p.id)} onChange={() => toggleChecked(p.id)}
            aria-label={`Select ${p.label} for grouping`}
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
            onClick={() => { setEditingGroup(null); props.onSelectPart(p.id); }}
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
        >🗑</button>
      </div>
    );
  };

  const moveButtons = (entry: ExplorerEntry, index: number) => (
    <span className="entry-move">
      <button
        className="mini icon" data-testid={`move-up-${entry.id}`} aria-label="Move up"
        disabled={index === 0} onClick={() => act(() => moveEntry(manifest, entry.id, -1))}
      >▲</button>
      <button
        className="mini icon" data-testid={`move-down-${entry.id}`} aria-label="Move down"
        disabled={index === entries.length - 1} onClick={() => act(() => moveEntry(manifest, entry.id, 1))}
      >▼</button>
    </span>
  );

  const bundleRow = (entry: ExplorerEntry & { kind: 'group' | 'variant' }, index: number) => {
    const open = !collapsed.has(entry.id);
    const allHidden = entry.parts.every((id) => props.hiddenParts.has(id));
    const partsById = new Map(manifest.parts.map((p) => [p.id, p]));
    const option = entry.kind === 'variant'
      ? manifest.options.find((o): o is ChoiceOption => o.id === entry.id && o.type === 'choice')
      : undefined;
    return (
      <div key={entry.id} className="entry">
        <div className={`part-row is-bundle${entry.kind === 'group' && editingGroup === entry.id ? ' is-active' : ''}`}>
          {moveButtons(entry, index)}
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
              if (entry.kind === 'group') { props.onSelectPart(null); setEditingGroup(entry.id); }
              else setCollapsed((old) => { const next = new Set(old); next.delete(entry.id); return next; });
            }}
          >
            {entry.label}
            <span className="tag">{entry.kind === 'group' ? 'group' : 'choice'}</span>
          </button>
          {entry.kind === 'group' ? (
            <button
              className="mini" data-testid={`ungroup-${entry.id}`} title="Dissolve the group; parts stay put"
              onClick={() => { setEditingGroup(null); act(() => ungroup(manifest, entry.id)); }}
            >Ungroup</button>
          ) : (
            <button
              className="mini" data-testid={`dissolve-${entry.id}`} title="Remove the choice; all parts always included"
              onClick={() => act(() => dissolveVariantChoice(manifest, entry.id))}
            >Dissolve</button>
          )}
        </div>
        {open && (
          <div className="entry-members">
            {entry.parts.map((id) => {
              const p = partsById.get(id);
              if (!p) return null;
              return partRow(p, {
                member: true,
                live: option ? props.selections[option.id] === id : undefined,
              });
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="panel-body">
      <div className="part-list-head">
        <span className="hint">Parts</span>
        <span className="spacer" />
        <button className="mini" data-testid="show-all" onClick={() => { props.onHideAll(false); props.onSolo(null); }}>Show all</button>
        <button className="mini" data-testid="hide-all" onClick={() => props.onHideAll(true)}>Hide all</button>
      </div>
      <div className="part-rows" role="listbox" aria-label="Parts">
        {entries.map((entry, index) => {
          if (entry.kind !== 'part') return bundleRow(entry, index);
          const p = manifest.parts.find((x) => x.id === entry.id)!;
          return (
            <div key={entry.id} className="entry">
              <div className="entry-line">
                {moveButtons(entry, index)}
                {partRow(p, { pickable: true })}
              </div>
            </div>
          );
        })}
      </div>

      {checked.size >= 2 && (
        <div className="structure-bar" data-testid="structure-bar">
          {pending === null ? (
            <>
              <span className="hint">{checked.size} parts selected —</span>
              <button className="mini" data-testid="make-group" onClick={() => setPending('group')}>Group as one</button>
              <button className="mini" data-testid="make-variant" onClick={() => setPending('variant')}>Customer choice</button>
            </>
          ) : (
            <>
              <input
                className="structure-name" autoFocus data-testid="structure-label"
                placeholder={pending === 'group' ? 'Group name (e.g. Shell)' : 'Choice name — customers see it (e.g. Lid style)'}
                value={structureLabel} onChange={(e) => setStructureLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmStructure(); if (e.key === 'Escape') setPending(null); }}
              />
              <button className="mini" data-testid="structure-confirm" onClick={confirmStructure}>
                {pending === 'group' ? 'Group' : 'Create choice'}
              </button>
              <button className="mini" onClick={() => { setPending(null); setStructureLabel(''); }}>✕</button>
            </>
          )}
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      {group ? (
        <GroupEditor
          key={group.id} project={props.project} groupId={group.id}
          onChange={props.onChange} onClose={() => setEditingGroup(null)}
        />
      ) : (
        <PartEditor key={part.id} project={props.project} partId={part.id} onChange={props.onChange} />
      )}
    </div>
  );
}

function GroupEditor(props: {
  project: Project;
  groupId: string;
  onChange: (m: Manifest, opts?: SetManifestOptions) => void;
  onClose: () => void;
}) {
  const { manifest } = props.project;
  const group = manifest.groups?.find((g) => g.id === props.groupId);
  const [error, setError] = useState<string | null>(null);
  // Remount the nudge fields after each move so they read 0 again — they are
  // deltas, not positions.
  const [nudgeTick, setNudgeTick] = useState(0);
  if (!group) return null;

  const act = (fn: () => Manifest) => {
    try { props.onChange(fn()); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div className="part-editor" data-testid={`group-editor-${group.id}`}>
      <h3>{group.label} <span className="tag">group</span></h3>
      <section>
        <h4>Name</h4>
        <label className="field wide">
          <input
            defaultValue={group.label} data-testid="group-name"
            onBlur={(e) => { if (e.target.value.trim() && e.target.value !== group.label) act(() => renameGroup(manifest, group.id, e.target.value)); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
        </label>
      </section>
      <section>
        <h4>Move together</h4>
        <p className="hint">Shifts every part in the group by the given distance. Parts anchored to each other keep their joints.</p>
        <div className="field-row" key={nudgeTick}>
          {UI_AXES.map(({ label, axis }) => (
            <NumberField
              key={label} label={label} value={0} suffix="mm"
              testId={`nudge-${label.toLowerCase()}`}
              onCommit={(mm) => {
                if (!mm) return;
                const deltas: [number, number, number] = [0, 0, 0];
                deltas[axis] = mm;
                act(() => nudgeGroup(manifest, group.id, deltas));
                setNudgeTick((t) => t + 1);
              }}
            />
          ))}
        </div>
      </section>
      <section>
        <h4>Group</h4>
        <p className="hint">
          Members share one colour control in the configurator. Ungrouping keeps
          their positions and the shared colour option.
        </p>
        <div className="publish-actions">
          <button className="ghost" onClick={() => { props.onClose(); act(() => ungroup(manifest, group.id)); }}>Ungroup</button>
        </div>
      </section>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function PartEditor(props: {
  project: Project;
  partId: string;
  onChange: (m: Manifest, opts?: SetManifestOptions) => void;
}) {
  const { manifest, raw } = props.project;
  const part = manifest.parts.find((p) => p.id === props.partId)!;
  const bounds = raw.get(part.id);
  const [lock, setLock] = useState(part.placement?.lockAspect ?? true);
  const [matchFrom, setMatchFrom] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!bounds) return <p className="empty">No geometry for this part.</p>;
  const size = sizeMm(manifest, part.id, bounds);
  const rotation = part.placement?.rotation ?? [0, 0, 0];

  const colourOption = manifest.options.find(
    (o): o is ColourOption => o.type === 'colour' && o.source !== 'used' && o.parts.includes(part.id));
  const palette = manifest.palettes?.find((p) => p.id === colourOption?.palette);

  const visibleOption = part.visibleWhen ? manifest.options.find((o) => o.id === part.visibleWhen!.option) : undefined;
  // A variant member's visibility belongs to its choice option — the add-on
  // toggle must not touch it, or unchecking would orphan the choice.
  const variantOf = visibleOption?.type === 'choice' && (visibleOption as ChoiceOption).role === 'variant'
    ? (visibleOption as ChoiceOption) : undefined;
  const addon = !variantOf ? visibleOption : undefined;
  const addonPrice = addon?.type === 'choice'
    ? addon.choices.find((c) => c.id === 'yes')?.priceDelta ?? 0
    : 0;

  const act = (fn: () => Manifest) => {
    try { props.onChange(fn()); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div className="part-editor" data-testid={`editor-${part.id}`}>
      <h3>{part.label}</h3>

      <section>
        <div className="section-head">
          <h4>Size</h4>
          <label className="lock">
            <input
              type="checkbox" checked={lock} data-testid="lock-aspect"
              onChange={(e) => setLock(e.target.checked)}
            />
            Lock proportions
          </label>
        </div>
        <div className="field-row">
          {AXIS_LABELS.map((label, axis) => (
            <NumberField
              key={label} label={label} value={size[axis]} suffix="mm"
              testId={`size-${label.toLowerCase()}`}
              onCommit={(mm) => props.onChange(withSizeMm(manifest, part.id, axis as Axis, mm, bounds, lock))}
            />
          ))}
        </div>
      </section>

      <section>
        <h4>Position</h4>
        {UI_AXES.map(({ label, axis }) => (
          <AxisAnchorRow key={label} axis={axis} uiLabel={label} {...props} />
        ))}
        <div className="match-row">
          <select
            aria-label="Match position of" value={matchFrom} data-testid="match-select"
            onChange={(e) => setMatchFrom(e.target.value)}
          >
            <option value="">Match position of…</option>
            {manifest.parts.filter((p) => p.id !== part.id).map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <button
            className="mini" data-testid="match-apply" disabled={!matchFrom}
            onClick={() => { act(() => copyPlacement(manifest, matchFrom, part.id)); setMatchFrom(''); }}
          >Apply</button>
        </div>
      </section>

      <section>
        <h4>Rotation</h4>
        <div className="field-row">
          {UI_AXES.map(({ label, axis }) => (
            <NumberField
              key={label} label={label} value={rotation[axis]} suffix="°" step={15}
              testId={`rot-${label.toLowerCase()}`}
              onCommit={(deg) => {
                const next = [...rotation] as [number, number, number];
                next[axis] = deg;
                props.onChange(withRotation(manifest, part.id, next));
              }}
            />
          ))}
        </div>
      </section>

      {colourOption && palette && (
        <section>
          <h4>Colour</h4>
          <label className="field wide">
            <span className="field-label">Customers open with</span>
            <span className="default-colour-row">
              <span
                className="chip"
                style={{ background: palette.swatches.find((s) => s.id === colourOption.default)?.hex ?? '#ccc' }}
              />
              <select
                aria-label="Default colour" data-testid="default-colour"
                value={colourOption.default.startsWith('@') ? '' : colourOption.default}
                onChange={(e) => { if (e.target.value) act(() => setDefaultSwatch(manifest, colourOption.id, e.target.value)); }}
              >
                {colourOption.default.startsWith('@') && <option value="">(follows another part)</option>}
                {palette.swatches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </span>
          </label>
          <label className="lock">
            <input
              type="checkbox" checked={colourOption.custom?.allowed ?? false}
              data-testid={`custom-toggle-${colourOption.id}`}
              onChange={(e) => act(() => setCustomColour(manifest, colourOption.id, {
                allowed: e.target.checked,
                priceDelta: e.target.checked ? colourOption.custom?.priceDelta ?? 0 : undefined,
              }))}
            />
            Allow custom colour (any hex)
          </label>
          {(colourOption.custom?.allowed ?? false) && (
            <NumberField
              label="Custom colour surcharge" value={colourOption.custom?.priceDelta ?? 0}
              suffix={manifest.pricing.currency} step={1}
              testId={`custom-price-${colourOption.id}`}
              onCommit={(v) => props.onChange(setCustomColour(manifest, colourOption.id, { allowed: true, priceDelta: v }))}
            />
          )}
        </section>
      )}

      {variantOf ? (
        <section>
          <h4>Customer choice</h4>
          <p className="hint">
            This part is one of the “{variantOf.label}” choices — customers pick
            which one they get. Set a surcharge for picking this part:
          </p>
          <NumberField
            label="Extra when chosen" value={variantOf.choices.find((c) => c.id === part.id)?.priceDelta ?? 0}
            suffix={manifest.pricing.currency} step={1}
            testId="variant-price"
            onCommit={(price) => props.onChange(setChoicePrice(manifest, variantOf.id, part.id, price || undefined))}
          />
        </section>
      ) : (
        <section>
          <div className="section-head">
            <h4>Optional add-on</h4>
            <label className="lock">
              <input
                type="checkbox" checked={!!part.visibleWhen} data-testid="addon-toggle"
                onChange={(e) => props.onChange(e.target.checked
                  ? makePartOptional(manifest, part.id, 0)
                  : makePartRequired(manifest, part.id))}
              />
              Customer selects this part
            </label>
          </div>
          {addon && (
            <NumberField
              label="Extra when selected" value={addonPrice} suffix={manifest.pricing.currency} step={1}
              testId="addon-price"
              onCommit={(price) => props.onChange(setChoicePrice(manifest, addon.id, 'yes', price || undefined))}
            />
          )}
        </section>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function AxisAnchorRow(props: {
  project: Project;
  partId: string;
  axis: Axis;
  uiLabel: string;
  onChange: (m: Manifest, opts?: SetManifestOptions) => void;
}) {
  const { manifest } = props.project;
  const part = manifest.parts.find((p) => p.id === props.partId)!;
  const placement = part.placement?.[AXIS_NAMES[props.axis]];
  const anchored = placement?.to && placement.to !== 'origin';
  const [ref, edge] = anchored ? placement!.to!.split(':') : ['', 'min'];
  const others = manifest.parts.filter((p) => p.id !== part.id);

  const commit = (next: { align: AnchorEdge; to: string; edge: AnchorEdge; offset: number } | { origin: true; offset?: number }) =>
    props.onChange(withAnchor(manifest, part.id, props.axis, next));

  return (
    <div className="anchor-row" data-testid={`anchor-${AXIS_NAMES[props.axis]}`}>
      <span className="axis-name">{props.uiLabel}</span>
      <select
        aria-label="anchor mode" value={anchored ? ref : 'origin'}
        onChange={(e) => {
          const to = e.target.value;
          commit(to === 'origin'
            ? { origin: true, offset: 0 }
            : { align: (placement?.align ?? 'min') as AnchorEdge, to, edge: edge as AnchorEdge, offset: placement?.offset ?? 0 });
        }}
      >
        <option value="origin">as modelled</option>
        {others.map((p) => <option key={p.id} value={p.id}>against {p.label}</option>)}
      </select>
      {anchored && (
        <>
          <select
            aria-label="my edge" value={placement!.align ?? 'center'}
            onChange={(e) => commit({ align: e.target.value as AnchorEdge, to: ref, edge: edge as AnchorEdge, offset: placement?.offset ?? 0 })}
          >
            {EDGES.map((ed) => <option key={ed} value={ed}>my {ed}</option>)}
          </select>
          <select
            aria-label="their edge" value={edge}
            onChange={(e) => commit({ align: (placement!.align ?? 'center') as AnchorEdge, to: ref, edge: e.target.value as AnchorEdge, offset: placement?.offset ?? 0 })}
          >
            {EDGES.map((ed) => <option key={ed} value={ed}>their {ed}</option>)}
          </select>
        </>
      )}
      <NumberField
        label="" value={placement?.offset ?? 0} suffix="mm"
        testId={`offset-${AXIS_NAMES[props.axis]}`}
        onCommit={(offset) => commit(anchored
          ? { align: (placement!.align ?? 'center') as AnchorEdge, to: ref, edge: edge as AnchorEdge, offset }
          : { origin: true, offset })}
      />
    </div>
  );
}
