// Per-part editing: visibility eyeballs and solo, rename and delete, real
// millimetres with lock-aspect, anchored positioning, rotation, the default
// customer colour, custom-colour pricing (merged here from the old Options
// tab — it is a property of the part's surface), match-position, and the
// optional-add-on price. Every control calls a tested edit op; this file
// only renders and routes.

import { useState } from 'react';
import type { Manifest, AnchorEdge, ColourOption } from '../../../embed/src/manifest/types.ts';
import {
  sizeMm, withSizeMm, withAnchor, withRotation,
  makePartOptional, makePartRequired, setChoicePrice,
  renamePart, removePart, setDefaultSwatch, copyPlacement, setCustomColour,
  AXIS_NAMES, type Axis,
} from '../lib/manifest-edit.ts';
import type { Project } from '../App.tsx';
import { NumberField } from './fields.tsx';

const AXIS_LABELS = ['W', 'H', 'D'] as const; // x, y, z in canonical space
const EDGES: AnchorEdge[] = ['min', 'center', 'max'];

const EYE = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>;
const EYE_OFF = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>;

export function PartsPanel(props: {
  project: Project;
  selectedPart: string | null;
  hiddenParts: Set<string>;
  solo: string | null;
  onSelectPart: (id: string | null) => void;
  onToggleHidden: (id: string) => void;
  onSolo: (id: string | null) => void;
  onHideAll: (hide: boolean) => void;
  onChange: (m: Manifest) => void;
}) {
  const { manifest } = props.project;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const part = manifest.parts.find((p) => p.id === props.selectedPart) ?? manifest.parts[0];
  if (!part) return <p className="empty">No parts in this model.</p>;

  const act = (fn: () => Manifest) => {
    try { props.onChange(fn()); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
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
        {manifest.parts.map((p) => {
          const hidden = props.solo ? props.solo !== p.id : props.hiddenParts.has(p.id);
          return (
            <div key={p.id} className={`part-row${p.id === part.id ? ' is-active' : ''}${hidden ? ' is-hidden' : ''}`}>
              <button
                className="mini icon" data-testid={`eye-${p.id}`} aria-label={hidden ? `Show ${p.label}` : `Hide ${p.label}`}
                onClick={() => props.onToggleHidden(p.id)}
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
                  className="part-name" role="option" aria-selected={p.id === part.id}
                  onClick={() => props.onSelectPart(p.id)}
                  onDoubleClick={() => setRenaming(p.id)}
                >
                  {p.label}
                  {p.visibleWhen && <span className="tag">add-on</span>}
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
        })}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <PartEditor key={part.id} project={props.project} partId={part.id} onChange={props.onChange} />
    </div>
  );
}

function PartEditor(props: {
  project: Project;
  partId: string;
  onChange: (m: Manifest) => void;
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

  const addon = part.visibleWhen ? manifest.options.find((o) => o.id === part.visibleWhen!.option) : undefined;
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
        {AXIS_NAMES.map((name, axis) => (
          <AxisAnchorRow key={name} axis={axis as Axis} {...props} />
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
          {['X', 'Y', 'Z'].map((label, axis) => (
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
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function AxisAnchorRow(props: {
  project: Project;
  partId: string;
  axis: Axis;
  onChange: (m: Manifest) => void;
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
      <span className="axis-name">{AXIS_LABELS_BY_AXIS[props.axis]}</span>
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

const AXIS_LABELS_BY_AXIS = ['X', 'Y', 'Z'];
