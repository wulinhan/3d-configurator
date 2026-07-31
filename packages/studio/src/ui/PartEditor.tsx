// The properties editors — one for a part, one for an assembly. They render
// inside the floating panel that slides in from the right when something is
// selected (see App.tsx); the explorer stays in the left panel. Every control
// calls a tested edit op; these components only render and route.

import { useState } from 'react';
import type { Manifest, AnchorEdge, ColourOption, ChoiceOption } from '../../../embed/src/manifest/types.ts';
import {
  sizeMm, withSizeMm, withAnchor, withRotation,
  makePartOptional, makePartRequired, setChoicePrice,
  setDefaultSwatch, copyPlacement, setCustomColour,
  ungroup, renameGroup, nudgeGroup,
  AXIS_NAMES, type Axis,
} from '../lib/manifest-edit.ts';
import type { Project, SetManifestOptions } from '../App.tsx';
import { NumberField } from './fields.tsx';
import { Select } from './controls.tsx';

const AXIS_LABELS = ['W', 'H', 'D'] as const; // x, y, z in canonical space
const EDGES: AnchorEdge[] = ['min', 'center', 'max'];

// The Studio speaks Z-up: X and Y are the flat plane, Z is height. The
// internal space (manifest, renderer) stays Y-up — this table is purely how
// axes are named and ordered on screen.
export const UI_AXES: Array<{ label: string; axis: Axis }> = [
  { label: 'X', axis: 0 }, // internal x — width
  { label: 'Y', axis: 2 }, // internal z — depth
  { label: 'Z', axis: 1 }, // internal y — height
];

export function GroupEditor(props: {
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
      <h3>{group.label} <span className="tag">assembly</span></h3>
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
        <p className="hint">Shifts every part in the assembly by the given distance. Parts anchored to each other keep their joints.</p>
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
        <h4>Assembly</h4>
        <p className="hint">
          Parts in an assembly share one colour control in the configurator.
          Splitting it up keeps their positions and the shared colour option.
        </p>
        <div className="publish-actions">
          <button className="ghost" onClick={() => { props.onClose(); act(() => ungroup(manifest, group.id)); }}>Split up</button>
        </div>
      </section>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

export function PartEditor(props: {
  project: Project;
  partId: string;
  onChange: (m: Manifest, opts?: SetManifestOptions) => void;
}) {
  const { manifest, raw } = props.project;
  const part = manifest.parts.find((p) => p.id === props.partId);
  const bounds = part && raw.get(part.id);
  const [lock, setLock] = useState(part?.placement?.lockAspect ?? true);
  const [matchFrom, setMatchFrom] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!part) return null;
  if (!bounds) return <p className="empty">No geometry for this part.</p>;
  const size = sizeMm(manifest, part.id, bounds);
  const rotation = part.placement?.rotation ?? [0, 0, 0];

  const colourOption = manifest.options.find(
    (o): o is ColourOption => o.type === 'colour' && o.source !== 'used' && o.parts.includes(part.id));
  const palette = manifest.palettes?.find((p) => p.id === colourOption?.palette);

  const visibleOption = part.visibleWhen ? manifest.options.find((o) => o.id === part.visibleWhen!.option) : undefined;
  // A pick-one member's visibility belongs to its choice option — the add-on
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
          <Select
            ariaLabel="Match position of" testId="match-select"
            value={matchFrom} placeholder="Match position of…"
            options={manifest.parts.filter((p) => p.id !== part.id).map((p) => ({ value: p.id, label: p.label }))}
            onChange={setMatchFrom}
          />
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
            <Select
              ariaLabel="Default colour" testId="default-colour"
              value={colourOption.default.startsWith('@') ? '' : colourOption.default}
              placeholder="(follows another part)"
              options={palette.swatches.map((s) => ({ value: s.id, label: s.name, chip: s.hex }))}
              onChange={(v) => act(() => setDefaultSwatch(manifest, colourOption.id, v))}
            />
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
          <h4>Pick-one set</h4>
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

  const axisName = AXIS_NAMES[props.axis];
  return (
    <div className="anchor-row" data-testid={`anchor-${axisName}`}>
      <span className="axis-name">{props.uiLabel}</span>
      <Select
        ariaLabel="anchor mode" testId={`anchor-mode-${axisName}`} compact
        value={anchored ? ref : 'origin'}
        options={[
          { value: 'origin', label: 'as modelled' },
          ...others.map((p) => ({ value: p.id, label: `against ${p.label}` })),
        ]}
        onChange={(to) => commit(to === 'origin'
          ? { origin: true, offset: 0 }
          : { align: (placement?.align ?? 'min') as AnchorEdge, to, edge: edge as AnchorEdge, offset: placement?.offset ?? 0 })}
      />
      {anchored && (
        <>
          <Select
            ariaLabel="my edge" testId={`anchor-my-${axisName}`} compact
            value={placement!.align ?? 'center'}
            options={EDGES.map((ed) => ({ value: ed, label: `my ${ed}` }))}
            onChange={(v) => commit({ align: v as AnchorEdge, to: ref, edge: edge as AnchorEdge, offset: placement?.offset ?? 0 })}
          />
          <Select
            ariaLabel="their edge" testId={`anchor-their-${axisName}`} compact
            value={edge}
            options={EDGES.map((ed) => ({ value: ed, label: `their ${ed}` }))}
            onChange={(v) => commit({ align: (placement!.align ?? 'center') as AnchorEdge, to: ref, edge: v as AnchorEdge, offset: placement?.offset ?? 0 })}
          />
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
