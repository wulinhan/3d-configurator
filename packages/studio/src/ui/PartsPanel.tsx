// Per-part editing: real millimetres with a lock-aspect toggle, anchored
// positioning per axis, rotation, and the optional-add-on price. Every
// control calls a tested edit op; this file only renders and routes.

import { useState } from 'react';
import type { Manifest, AnchorEdge } from '../../../embed/src/manifest/types.ts';
import {
  sizeMm, withSizeMm, withAnchor, withRotation,
  makePartOptional, makePartRequired, setChoicePrice,
  AXIS_NAMES, type Axis,
} from '../lib/manifest-edit.ts';
import type { Project } from '../App.tsx';
import { NumberField } from './fields.tsx';

const AXIS_LABELS = ['W', 'H', 'D'] as const; // x, y, z in canonical space
const EDGES: AnchorEdge[] = ['min', 'center', 'max'];

export function PartsPanel(props: {
  project: Project;
  selectedPart: string | null;
  onSelectPart: (id: string) => void;
  onChange: (m: Manifest) => void;
}) {
  const { manifest } = props.project;
  const part = manifest.parts.find((p) => p.id === props.selectedPart) ?? manifest.parts[0];
  if (!part) return <p className="empty">No parts in this model.</p>;

  return (
    <div className="panel-body">
      <div className="part-list" role="listbox" aria-label="Parts">
        {manifest.parts.map((p) => (
          <button
            key={p.id} role="option" aria-selected={p.id === part.id}
            className={p.id === part.id ? 'is-active' : ''}
            onClick={() => props.onSelectPart(p.id)}
          >
            {p.label}
            {p.visibleWhen && <span className="tag">add-on</span>}
          </button>
        ))}
      </div>
      <PartEditor key={part.id} {...props} partId={part.id} />
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

  if (!bounds) return <p className="empty">No geometry for this part.</p>;
  const size = sizeMm(manifest, part.id, bounds);
  const rotation = part.placement?.rotation ?? [0, 0, 0];

  const addon = part.visibleWhen ? manifest.options.find((o) => o.id === part.visibleWhen!.option) : undefined;
  const addonPrice = addon?.type === 'choice'
    ? addon.choices.find((c) => c.id === 'yes')?.priceDelta ?? 0
    : 0;

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
