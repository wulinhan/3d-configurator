// The properties editors — one for a part, one for an assembly. They render
// inside the floating panel that slides in from the right when something is
// selected (see App.tsx); the explorer stays in the left panel. Every control
// calls a tested edit op; these components only render and route.

import { useState, type ReactNode } from 'react';
import type { Manifest, AnchorEdge, ColourOption, ChoiceOption, TextOption, UploadOption, TextFont, Part } from '../../../embed/src/manifest/types.ts';
import { FONT_CHOICES } from '../../../embed/src/runtime/fonts.ts';
import {
  sizeMm, withSizeMm, withAnchor, withRotation,
  makePartOptional, makePartRequired, setChoicePrice,
  setDefaultSwatch, setCustomColour,
  ungroup, renameGroup, nudgeGroup, partToOrigin, groupToOrigin,
  matchPose, partCentreMm, setPartCentre, isPartAtOrigin, setLockAspect,
  nudgeVariant, variantToOrigin, renameVariantSet, dissolveVariantChoice,
  setTextSlot, removeTextSlot, setTextPath, type TextSlotPatch,
  setImageZone, nudgeImageZone, removeImageZone, type ImageZonePatch,
  entrySizeMm, withEntrySizeMm,
  addRepeat, setRepeat, removeRepeat,
  AXIS_NAMES, type Axis,
} from '../lib/manifest-edit.ts';
import type { Project, SetManifestOptions } from '../App.tsx';
import { NumberField } from './fields.tsx';
import { Select } from './controls.tsx';
import { Section } from './section.tsx';

const AXIS_LABELS = ['W', 'H', 'D'] as const; // x, y, z in canonical space
const EDGES: AnchorEdge[] = ['min', 'center', 'max'];

// The Studio speaks Z-up: X and Y are the flat plane, Z is height. The
// internal space (manifest, renderer) stays Y-up — this table is purely how
// axes are named and ordered on screen.
export const UI_AXES: Array<{ label: 'X' | 'Y' | 'Z'; axis: Axis }> = [
  { label: 'X', axis: 0 }, // internal x — width
  { label: 'Y', axis: 2 }, // internal z — depth
  { label: 'Z', axis: 1 }, // internal y — height
];

// The viewport's axis colours (X red, Y green, Z blue — Studio Z-up terms),
// repeated wherever an axis is named so the panel and the gizmo speak the
// same language.
export const AXIS_COLOURS: Record<'X' | 'Y' | 'Z', string> = {
  X: '#d44a3a', Y: '#4a9a44', Z: '#3a6fd4',
};
const axisTint = (label: 'X' | 'Y' | 'Z') => (
  <span style={{ color: AXIS_COLOURS[label], fontWeight: 700 }}>{label}</span>
);

export type RepeatOpts = { count: number; mode: 'line' | 'circle'; axis?: Axis; gapMm?: number };

// Size fields for a whole assembly / variant set — the same W/H/D-with-lock
// interaction a single part has, scaling members and their spacing rigidly
// about the set's centre.
function EntrySizeSection(props: {
  entryId: string;
  project: Project;
  act: (fn: () => Manifest, opts?: SetManifestOptions) => void;
}) {
  const [lock, setLock] = useState(true);
  let size: [number, number, number];
  try {
    size = entrySizeMm(props.project.manifest, props.entryId, props.project.raw);
  } catch {
    return null;
  }
  return (
    <Section
      title="Size" icon="size" testId="section-set-size"
      aside={(
        <label className="lock">
          <input
            type="checkbox" checked={lock} data-testid="set-lock-aspect"
            onChange={(e) => setLock(e.target.checked)}
          />
          Lock proportions
        </label>
      )}
    >
      <div className="field-row">
        {AXIS_LABELS.map((label, axis) => (
          <NumberField
            key={label} label={label} value={size[axis]} suffix="mm"
            testId={`set-size-${label.toLowerCase()}`}
            onCommit={(mm, o) => props.act(() =>
              withEntrySizeMm(props.project.manifest, props.entryId, axis as Axis, mm, props.project.raw, lock), o)}
          />
        ))}
      </div>
    </Section>
  );
}

// The pattern tool: stamp copies of a part / assembly / variant set along an
// axis or around the origin. Merchant-only — the copies land as ordinary
// parts; customers never see this control.
function RepeatSection(props: {
  entryId: string;
  /** "part" | "assembly" | "set" — only used in the hint copy. */
  what: string;
  onRepeat: (entryId: string, opts: RepeatOpts) => void;
}) {
  const [mode, setMode] = useState<'line' | 'circle'>('line');
  const [count, setCount] = useState(3);
  const [axis, setAxis] = useState<Axis>(0);
  const [gap, setGap] = useState(5);
  const [error, setError] = useState<string | null>(null);

  return (
    <Section title="Repeat" icon="repeat" testId="section-repeat">
      <p className="hint">
        {mode === 'line'
          ? `Stamps copies of this ${props.what} in a row, spaced edge-to-edge by the gap.`
          : `Stamps copies of this ${props.what} in a ring around the origin at its current distance — move it off-centre first.`}
      </p>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Pattern</span>
          <Select
            ariaLabel="Repeat pattern" testId="repeat-mode" compact
            value={mode}
            options={[{ value: 'line', label: 'Linear' }, { value: 'circle', label: 'Circular' }]}
            onChange={(v) => setMode(v as 'line' | 'circle')}
          />
        </label>
        <NumberField
          label="Total" value={count} step={1} testId="repeat-count"
          onCommit={(v) => setCount(Math.round(v))}
        />
      </div>
      {mode === 'line' && (
        <div className="field-row">
          <label className="field">
            <span className="field-label">Axis</span>
            <Select
              ariaLabel="Repeat axis" testId="repeat-axis" compact
              value={String(axis)}
              options={UI_AXES.map(({ label, axis: a }) => ({ value: String(a), label, tint: AXIS_COLOURS[label] }))}
              onChange={(v) => setAxis(Number(v) as Axis)}
            />
          </label>
          <NumberField
            label="Gap" value={gap} suffix="mm" testId="repeat-gap"
            onCommit={setGap}
          />
        </div>
      )}
      <div className="match-row">
        <button
          className="mini" data-testid="repeat-apply"
          title="Each copy is a real part — recolour or delete any of them afterwards"
          onClick={() => {
            try {
              props.onRepeat(props.entryId, mode === 'line' ? { count, mode, axis, gapMm: gap } : { count, mode });
              setError(null);
            } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
          }}
        >Apply repeat</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </Section>
  );
}

export function GroupEditor(props: {
  project: Project;
  groupId: string;
  onChange: (m: Manifest, opts?: SetManifestOptions) => void;
  onDuplicate: (entryId: string) => void;
  onRepeat: (entryId: string, opts: RepeatOpts) => void;
  onClose: () => void;
}) {
  const { manifest } = props.project;
  const group = manifest.groups?.find((g) => g.id === props.groupId);
  const [error, setError] = useState<string | null>(null);
  // Remount the nudge fields after each move so they read 0 again — they are
  // deltas, not positions.
  const [nudgeTick, setNudgeTick] = useState(0);
  if (!group) return null;

  // `opts` rides through so a field scrub (many steps, one gesture) lands as
  // a single history entry instead of one per step.
  const act = (fn: () => Manifest, opts?: SetManifestOptions) => {
    try { props.onChange(fn(), opts); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div className="part-editor" data-testid={`group-editor-${group.id}`}>
      <h3>{group.label} <span className="tag">assembly</span></h3>
      <p className="hint">Rename by double-clicking its name in the explorer.</p>
      <EntrySizeSection entryId={group.id} project={props.project} act={act} />
      <Section title="Move together" icon="position" testId="section-group-move">
        <p className="hint">Shifts every part in the assembly by the given distance. Parts anchored to each other keep their joints.</p>
        <div className="match-row">
          <button
            className="mini" data-testid="group-to-origin"
            title="Centre the whole assembly on X/Y, sit it on the ground at Z 0"
            onClick={() => act(() => groupToOrigin(manifest, group.id, props.project.raw))}
          >Bring assembly to origin</button>
        </div>
        <div className="field-row" key={nudgeTick}>
          {UI_AXES.map(({ label, axis }) => (
            <NumberField
              key={label} label={axisTint(label)} value={0} suffix="mm"
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
      </Section>
      <Section title="Assembly" icon="assembly" testId="section-assembly">
        <p className="hint">
          Parts in an assembly move as one thing but keep their own colours.
          Splitting it up keeps every part exactly where it is.
        </p>
        <div className="publish-actions">
          <button
            className="ghost" data-testid="duplicate-entry"
            title="Copy every part, joint and colour; the copy lands beside the original"
            onClick={() => { try { props.onDuplicate(group.id); setError(null); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } }}
          >Duplicate</button>
          <button className="ghost" onClick={() => { props.onClose(); act(() => ungroup(manifest, group.id)); }}>Split up</button>
        </div>
      </Section>
      <RepeatSection entryId={group.id} what="assembly" onRepeat={props.onRepeat} />
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

export function VariantEditor(props: {
  project: Project;
  optionId: string;
  onChange: (m: Manifest, opts?: SetManifestOptions) => void;
  onDuplicate: (entryId: string) => void;
  onRepeat: (entryId: string, opts: RepeatOpts) => void;
  onClose: () => void;
}) {
  const { manifest } = props.project;
  const option = manifest.options.find((o): o is ChoiceOption => o.id === props.optionId && o.type === 'choice');
  const [error, setError] = useState<string | null>(null);
  const [nudgeTick, setNudgeTick] = useState(0);
  if (!option || option.role !== 'variant') return null;

  // `opts` rides through so a field scrub (many steps, one gesture) lands as
  // a single history entry instead of one per step.
  const act = (fn: () => Manifest, opts?: SetManifestOptions) => {
    try { props.onChange(fn(), opts); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div className="part-editor" data-testid={`variant-editor-${option.id}`}>
      <h3>{option.label} <span className="tag">variants</span></h3>
      <p className="hint">Rename by double-clicking its name in the explorer.</p>
      <EntrySizeSection entryId={option.id} project={props.project} act={act} />
      <Section title="Move together" icon="position" testId="section-group-move">
        <p className="hint">Shifts every variant by the given distance — they usually share one spot, so they travel as one.</p>
        <div className="match-row">
          <button
            className="mini" data-testid="variant-to-origin"
            title="Centre the whole set on X/Y, sit it on the ground at Z 0"
            onClick={() => act(() => variantToOrigin(manifest, option.id, props.project.raw))}
          >Bring set to origin</button>
        </div>
        <div className="field-row" key={nudgeTick}>
          {UI_AXES.map(({ label, axis }) => (
            <NumberField
              key={label} label={axisTint(label)} value={0} suffix="mm"
              testId={`vnudge-${label.toLowerCase()}`}
              onCommit={(mm) => {
                if (!mm) return;
                const deltas: [number, number, number] = [0, 0, 0];
                deltas[axis] = mm;
                act(() => nudgeVariant(manifest, option.id, deltas));
                setNudgeTick((t) => t + 1);
              }}
            />
          ))}
        </div>
      </Section>
      <Section title="Variant set" icon="variant" testId="section-variant-set">
        <p className="hint">
          Customers pick exactly one of these parts; its colour carries over
          when they switch. Dissolving keeps every part, always included.
        </p>
        <div className="publish-actions">
          <button
            className="ghost" data-testid="duplicate-entry"
            title="Copy the whole set — parts, joints, colours, exclusivity"
            onClick={() => { try { props.onDuplicate(option.id); setError(null); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } }}
          >Duplicate</button>
          <button className="ghost" onClick={() => { props.onClose(); act(() => dissolveVariantChoice(manifest, option.id)); }}>Dissolve</button>
        </div>
      </Section>
      <RepeatSection entryId={option.id} what="set" onRepeat={props.onRepeat} />
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

export function PartEditor(props: {
  project: Project;
  partId: string;
  onChange: (m: Manifest, opts?: SetManifestOptions) => void;
  onRepeat: (entryId: string, opts: RepeatOpts) => void;
  /** Arm "click a face" text placement for this part in the viewport. */
  onPlaceText: (partId: string) => void;
  /** Arm "click a face" image-zone placement for this part in the viewport. */
  onPlaceImage: (partId: string) => void;
  /** Arm (id) or disarm (null) baseline-curve shaping in the viewport. */
  onShapeText: (optionId: string | null) => void;
  /** The slot whose baseline is being shaped right now, if any. */
  shapingText: string | null;
}) {
  const { manifest, raw } = props.project;
  const part = manifest.parts.find((p) => p.id === props.partId);
  const bounds = part && raw.get(part.id);
  const [lock, setLock] = useState(part?.placement?.lockAspect ?? true);
  const [matchFrom, setMatchFrom] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Which axis's anchor editor is expanded — one at a time; the rest show a
  // one-line summary. Most axes are "as modelled" most of the time, and nine
  // permanently-visible dropdowns truncated into "agai… my c… thei…".
  const [openAxis, setOpenAxis] = useState<Axis | null>(null);

  if (!part) return null;
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
  // Repeating a bundled part would tear it out of its set — repeat the whole
  // assembly / variant set from ITS editor instead.
  const inGroup = manifest.groups?.some((g) => g.parts.includes(part.id)) ?? false;
  // Controls that need something to act on: matching wants a second part,
  // and moving to the origin wants the part to not already be there.
  const hasOtherParts = manifest.parts.length > 1;
  const atOrigin = isPartAtOrigin(manifest, part.id, raw);

  // `opts` rides through so a field scrub (many steps, one gesture) lands as
  // a single history entry instead of one per step.
  const act = (fn: () => Manifest, opts?: SetManifestOptions) => {
    try { props.onChange(fn(), opts); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div className="part-editor" data-testid={`editor-${part.id}`}>
      <h3>{part.label}</h3>

      <Section
        title="Size" icon="size" testId="section-size"
        aside={(
          <label className="lock">
            <input
              type="checkbox" checked={lock} data-testid="lock-aspect"
              // Persisted, not just local: the viewport's scale gizmo reads
              // it too, so dragging a handle keeps proportions when this is on.
              onChange={(e) => { setLock(e.target.checked); act(() => setLockAspect(manifest, part.id, e.target.checked)); }}
            />
            Lock proportions
          </label>
        )}
      >
        <div className="field-row">
          {AXIS_LABELS.map((label, axis) => (
            <NumberField
              key={label} label={label} value={size[axis]} suffix="mm"
              testId={`size-${label.toLowerCase()}`}
              onCommit={(mm, o) => props.onChange(withSizeMm(manifest, part.id, axis as Axis, mm, bounds, lock), o)}
            />
          ))}
        </div>
      </Section>

      <Section title="Position" icon="position" testId="section-position">
        {UI_AXES.map(({ label, axis }) => (
          <AxisAnchorRow
            key={label} axis={axis} uiLabel={label} {...props}
            open={openAxis === axis}
            onToggle={() => setOpenAxis(openAxis === axis ? null : axis)}
          />
        ))}
        <div className="match-row">
          <Select
            ariaLabel="Match position and rotation of" testId="match-select"
            value={matchFrom} placeholder="Match another part…"
            // Nothing to match against when this is the only part in the scene.
            disabled={!hasOtherParts}
            options={manifest.parts.filter((p) => p.id !== part.id).map((p) => ({ value: p.id, label: p.label }))}
            onChange={setMatchFrom}
          />
          <button
            className="mini" data-testid="match-apply" disabled={!matchFrom || !hasOtherParts}
            title={hasOtherParts
              ? 'Land centre-on-centre with the same rotation; follows if that part later moves'
              : 'Add a second part to match against'}
            onClick={() => { act(() => matchPose(manifest, matchFrom, part.id)); setMatchFrom(''); }}
          >Apply</button>
          <button
            className="mini" data-testid="to-origin" disabled={atOrigin}
            title={atOrigin ? 'Already at the origin' : 'Centre on X/Y, sit on the ground at Z 0 — anchors survive'}
            onClick={() => act(() => partToOrigin(manifest, part.id, raw))}
          >To origin</button>
        </div>
      </Section>

      <Section title="Rotation" icon="rotation" testId="section-rotation">
        <div className="field-row">
          {UI_AXES.map(({ label, axis }) => (
            <NumberField
              key={label} label={axisTint(label)} value={rotation[axis]} suffix="°" step={5}
              testId={`rot-${label.toLowerCase()}`}
              onCommit={(deg, o) => {
                const next = [...rotation] as [number, number, number];
                next[axis] = deg;
                props.onChange(withRotation(manifest, part.id, next), o);
              }}
            />
          ))}
        </div>
      </Section>

      {colourOption && palette && (
        <Section title="Colour" icon="colour" testId="section-colour">
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
              onCommit={(v, o) => props.onChange(setCustomColour(manifest, colourOption.id, { allowed: true, priceDelta: v }), o)}
            />
          )}
        </Section>
      )}

      {variantOf ? (
        <Section title="Variant set" icon="variant" testId="section-variant">
          <p className="hint">
            This part is one of the “{variantOf.label}” choices — customers pick
            which one they get. Set a surcharge for picking this part:
          </p>
          <NumberField
            label="Extra when chosen" value={variantOf.choices.find((c) => c.id === part.id)?.priceDelta ?? 0}
            suffix={manifest.pricing.currency} step={1}
            testId="variant-price"
            onCommit={(price, o) => props.onChange(setChoicePrice(manifest, variantOf.id, part.id, price || undefined), o)}
          />
        </Section>
      ) : (
        <Section
          title="Add-on" icon="addon" testId="section-addon"
          aside={(
            <label className="lock">
              <input
                type="checkbox" checked={!!part.visibleWhen} data-testid="addon-toggle"
                onChange={(e) => props.onChange(e.target.checked
                  ? makePartOptional(manifest, part.id, 0)
                  : makePartRequired(manifest, part.id))}
              />
              Customer selects this part
            </label>
          )}
        >
          {addon && (
            <NumberField
              label="Extra when selected" value={addonPrice} suffix={manifest.pricing.currency} step={1}
              testId="addon-price"
              onCommit={(price, o) => props.onChange(setChoicePrice(manifest, addon.id, 'yes', price || undefined), o)}
            />
          )}
        </Section>
      )}
      <Section title="3D text" icon="text" testId="section-text">
        <p className="hint">
          Customers type; their words extrude from a flat face of this part.
          Place the sketch plane by clicking a face, then set the typeface,
          size and depth — sink the plane to engrave instead of emboss.
        </p>
        {manifest.options.filter((o): o is TextOption => o.type === 'text' && o.part === part.id).map((slot, i, all) => (
          <TextSlotEditor
            key={slot.id} slot={slot} manifest={manifest} onChange={props.onChange} act={act}
            onShapeText={props.onShapeText} shaping={props.shapingText === slot.id}
            first={i === 0} last={i === all.length - 1}
          />
        ))}
        <div className="match-row">
          <button
            className="mini" data-testid="place-text"
            title="Click a flat face on this part in the viewport to set where the text sits"
            onClick={() => props.onPlaceText(part.id)}
          >＋ Place text on a face</button>
        </div>
      </Section>
      <Section title="Image zone" icon="image" testId="section-image">
        <p className="hint">
          Customers upload an image; it is projected onto this part inside the
          zone — flat or curved, the surface takes it. Click a face to place
          the zone, then set its size in millimetres.
        </p>
        {manifest.options.filter((o): o is UploadOption => o.type === 'upload' && o.part === part.id).map((zone, i, all) => (
          <ImageZoneEditor
            key={zone.id} zone={zone} manifest={manifest} act={act}
            first={i === 0} last={i === all.length - 1}
          />
        ))}
        <div className="match-row">
          <button
            className="mini" data-testid="place-image"
            title="Click a face on this part in the viewport to set where customer images land"
            onClick={() => props.onPlaceImage(part.id)}
          >＋ Place image zone on a face</button>
        </div>
      </Section>
      {!inGroup && !variantOf && (
        <PartRepeatSection part={part} manifest={manifest} act={act} />
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

// A part's LIVE patterns: each one is a parameter of the part, retunable
// after the fact, and several stack into a grid. (Assemblies and variant
// sets still use the stamping RepeatSection above — copying a whole set is
// a different job from patterning one part.)
function PartRepeatSection(props: {
  part: Part;
  manifest: Manifest;
  act: (fn: () => Manifest, opts?: SetManifestOptions) => void;
}) {
  const { part, manifest, act } = props;
  const repeats = part.repeats ?? [];
  const total = repeats.reduce((n, r) => n * Math.max(1, r.count), 1);
  return (
    <Section
      title="Repeat" icon="repeat" testId="section-repeat"
      aside={repeats.length ? <span className="hint">{total} in total</span> : undefined}
    >
      <p className="hint">
        Patterns this part. Every copy is the part itself — recolour, resize
        or retexture it and they all follow. Stack patterns to build a grid.
      </p>
      {repeats.map((spec) => (
        <div key={spec.id} className="text-slot" data-testid={`repeat-${spec.id}`}>
          <div className="field-row">
            <label className="field">
              <span className="field-label">Pattern</span>
              <Select
                ariaLabel="Repeat pattern" testId={`repeat-mode-${spec.id}`} compact
                value={spec.mode}
                options={[{ value: 'line', label: 'Linear' }, { value: 'circle', label: 'Circular' }]}
                onChange={(v) => act(() => setRepeat(manifest, part.id, spec.id, { mode: v as 'line' | 'circle' }))}
              />
            </label>
            <NumberField
              label="Total" value={spec.count} step={1} testId={`repeat-count-${spec.id}`}
              onCommit={(v, o) => act(() => setRepeat(manifest, part.id, spec.id, { count: v }), o)}
            />
          </div>
          {spec.mode === 'line' ? (
            <div className="field-row">
              <label className="field">
                <span className="field-label">Axis</span>
                <Select
                  ariaLabel="Repeat axis" testId={`repeat-axis-${spec.id}`} compact
                  value={String(spec.axis ?? 0)}
                  options={UI_AXES.map(({ label, axis }) => ({ value: String(axis), label, tint: AXIS_COLOURS[label] }))}
                  onChange={(v) => act(() => setRepeat(manifest, part.id, spec.id, { axis: Number(v) as Axis }))}
                />
              </label>
              <NumberField
                label="Gap" value={spec.gapMm ?? 5} suffix="mm" testId={`repeat-gap-${spec.id}`}
                onCommit={(v, o) => act(() => setRepeat(manifest, part.id, spec.id, { gapMm: v }), o)}
              />
            </div>
          ) : (
            <NumberField
              label="Step" value={spec.stepDeg ?? Math.round(360 / Math.max(2, spec.count))}
              suffix="°" step={5} testId={`repeat-step-${spec.id}`}
              onCommit={(v, o) => act(() => setRepeat(manifest, part.id, spec.id, { stepDeg: v }), o)}
            />
          )}
          <div className="match-row">
            <button
              className="mini" data-testid={`repeat-remove-${spec.id}`}
              onClick={() => act(() => removeRepeat(manifest, part.id, spec.id))}
            >Remove pattern</button>
          </div>
        </div>
      ))}
      <div className="match-row">
        <button
          className="mini" data-testid="repeat-add"
          title="Copies spawn live — tweak the numbers and the row re-forms"
          onClick={() => act(() => addRepeat(manifest, part.id))}
        >＋ Add pattern</button>
      </div>
    </Section>
  );
}


// The frame every text slot and image zone sits in: a collapsible card with
// the option's NAME in the header — the same string the customiser shows as
// the tab label, which is why it is editable here and not buried below —
// and up/down arrows that reorder it among its siblings (customiser tab
// order follows).
function SlotCard(props: {
  id: string;
  testId: string;
  label: string;
  namePlaceholder: string;
  first: boolean;
  last: boolean;
  onRename: (name: string) => void;
  onMove: (direction: -1 | 1) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="text-slot slot-card" data-testid={props.testId}>
      <div className="slot-head">
        <button
          className="slot-chevron" data-testid={`slot-toggle-${props.id}`}
          aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'}
          onClick={() => setOpen(!open)}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
        <input
          className="slot-name" data-testid={`slot-name-${props.id}`}
          value={props.label} placeholder={props.namePlaceholder}
          aria-label="Name — customers see it"
          title="Customers see this name in the customiser"
          onChange={(e) => props.onRename(e.target.value)}
        />
        <button
          className="slot-move" data-testid={`slot-up-${props.id}`} aria-label="Move up"
          disabled={props.first} onClick={() => props.onMove(-1)}
        >▲</button>
        <button
          className="slot-move" data-testid={`slot-down-${props.id}`} aria-label="Move down"
          disabled={props.last} onClick={() => props.onMove(1)}
        >▼</button>
      </div>
      {open && <div className="slot-body">{props.children}</div>}
    </div>
  );
}

// One text slot's controls. Every commit routes through setTextSlot, so an
// out-of-range value surfaces the edit layer's message instead of saving.
function TextSlotEditor(props: {
  slot: TextOption;
  manifest: Manifest;
  onChange: (m: Manifest, opts?: SetManifestOptions) => void;
  act: (fn: () => Manifest, opts?: SetManifestOptions) => void;
  onShapeText: (optionId: string | null) => void;
  shaping: boolean;
  first: boolean;
  last: boolean;
}) {
  const { slot, manifest, act } = props;
  const patch = (p: TextSlotPatch, o?: SetManifestOptions) => act(() => setTextSlot(manifest, slot.id, p), o);
  const swatches = manifest.palettes?.flatMap((p) => p.swatches) ?? [];
  return (
    <SlotCard
      id={slot.id} testId={`text-slot-${slot.id}`}
      label={slot.label} namePlaceholder="Name — customers see it"
      first={props.first} last={props.last}
      onRename={(name) => patch({ label: name })}
      onMove={(direction) => act(() => moveOption(manifest, slot.id, direction))}
    >
      <label className="field wide">
        <span className="field-label">Typeface</span>
        <Select
          ariaLabel="Typeface" testId={`text-font-${slot.id}`}
          value={slot.font ?? 'sans-bold'}
          options={FONT_CHOICES.map((f) => ({ value: f.id, label: f.label }))}
          onChange={(v) => patch({ font: v as TextFont })}
        />
      </label>
      {/* Style and size get a row to themselves; the depth knobs get the
        * next one. Four fields side by side squeezed all of them illegible. */}
      <div className="field-row">
        <label className="field">
          <span className="field-label">Style</span>
          <Select
            ariaLabel="Text style" testId={`text-style-${slot.id}`} compact
            value={slot.style ?? 'emboss'}
            options={[{ value: 'emboss', label: 'Embossed' }, { value: 'deboss', label: 'Engraved' }]}
            onChange={(v) => patch({ style: v as 'emboss' | 'deboss' })}
          />
        </label>
        <NumberField
          label="Size" value={slot.sizeMm} suffix="mm" testId={`text-size-${slot.id}`}
          onCommit={(v, o) => patch({ sizeMm: v }, o)}
        />
      </div>
      <div className="field-row">
        <NumberField
          label={(slot.style ?? 'emboss') === 'emboss' ? 'Depth' : 'Engrave depth'}
          value={slot.depthMm} suffix="mm" testId={`text-depth-${slot.id}`}
          onCommit={(v, o) => patch({ depthMm: v }, o)}
        />
        {(slot.style ?? 'emboss') === 'emboss' && (
          <NumberField
            label="Sink" value={slot.sinkMm ?? 0} suffix="mm" testId={`text-sink-${slot.id}`}
            onCommit={(v, o) => patch({ sinkMm: v }, o)}
          />
        )}
      </div>
      <div className="field-row">
        <NumberField
          label="Rotate" value={slot.rotationDeg ?? 0} suffix="°" step={5} testId={`text-spin-${slot.id}`}
          onCommit={(v, o) => patch({ rotationDeg: v }, o)}
        />
        {!slot.perChar && (
          // The arc the whole run bends through: + arches up, − smiles.
          // Hidden for per-letter spawning — pieces pattern themselves.
          // Turning the dial straightens away any drawn baseline curve.
          <NumberField
            label="Bend" value={slot.bendDeg ?? 0} suffix="°" step={15} testId={`text-bend-${slot.id}`}
            onCommit={(v, o) => patch({ bendDeg: v }, o)}
          />
        )}
        <NumberField
          label="Max letters" value={slot.maxLength ?? 20} step={1} testId={`text-max-${slot.id}`}
          onCommit={(v, o) => patch({ maxLength: Math.round(v) }, o)}
        />
      </div>
      {!slot.perChar && (
        // Follow the geometry instead of the flat sketch plane — what puts
        // a name around a barrel or over a dome.
        <>
          <label className="lock">
            <input
              type="checkbox" checked={!!slot.wrapSurface} data-testid={`text-wrap-${slot.id}`}
              onChange={(e) => patch({ wrapSurface: e.target.checked || null })}
            />
            Wrap onto the surface
          </label>
          {slot.wrapSurface && (
            <>
              <p className="hint" data-testid={`text-wrap-hint-${slot.id}`}>
                {(slot.style ?? 'emboss') === 'deboss'
                  ? 'The cut follows the surface — the pocket curves with the letters.'
                  : 'This face is curved — the letters follow it instead of the flat plane.'}
              </p>
              <div className="field-row">
                <NumberField
                  label="Float above" value={slot.liftMm ?? 0} suffix="mm" testId={`text-lift-${slot.id}`}
                  onCommit={(v, o) => patch({ liftMm: v }, o)}
                />
              </div>
            </>
          )}
        </>
      )}
      {!slot.perChar && (
        // Freeform baseline: the letters walk a curve drawn on the surface.
        <div className="match-row">
          {props.shaping ? (
            <button
              className="mini is-active" data-testid={`text-curve-done-${slot.id}`}
              onClick={() => props.onShapeText(null)}
            >Done shaping</button>
          ) : (
            <button
              className="mini" data-testid={`text-curve-${slot.id}`}
              title="Drag anchor dots on the surface — the letters follow the curve through them"
              onClick={() => props.onShapeText(slot.id)}
            >{slot.path ? 'Edit baseline curve' : 'Curve the baseline'}</button>
          )}
          {slot.path && (
            <button
              className="mini" data-testid={`text-curve-off-${slot.id}`}
              onClick={() => { props.onShapeText(null); act(() => setTextPath(manifest, slot.id, null)); }}
            >Straighten</button>
          )}
        </div>
      )}
      {/* The merchant's own colour, always available: unset it follows the
        * part, set it is what the text renders in — whether or not
        * customers are allowed to repaint it. */}
      <label className="field wide">
        <span className="field-label">Text colour</span>
        <Select
          ariaLabel="Text colour" testId={`text-colour-${slot.id}`}
          value={slot.colourHex ?? ''}
          placeholder="Same as the part"
          options={[
            { value: '', label: 'Same as the part' },
            ...swatches.map((s) => ({ value: s.hex, label: s.name, chip: s.hex })),
          ]}
          onChange={(v) => patch({ colourHex: v === '' ? null : (v as `#${string}`) })}
        />
      </label>
      <label className="lock">
        <input
          type="checkbox" checked={!!slot.customerColour} data-testid={`text-colour-choice-${slot.id}`}
          onChange={(e) => patch({ customerColour: e.target.checked || null })}
        />
        Customers can choose the text colour
      </label>
      {slot.customerColour && (
        // Which swatches they get. None ticked = the whole palette.
        <div className="swatch-picks" data-testid={`text-colour-picks-${slot.id}`}>
          <span className="field-label">Customers may pick</span>
          <div className="swatch-pick-row">
            {swatches.map((sw) => {
              const chosen = slot.colourChoices?.some((h) => h.toUpperCase() === sw.hex.toUpperCase()) ?? false;
              return (
                <label key={sw.id} className="swatch-pick" title={sw.name}>
                  <input
                    type="checkbox" checked={chosen}
                    data-testid={`text-colour-pick-${slot.id}-${sw.id}`}
                    onChange={(e) => {
                      const kept = (slot.colourChoices ?? []).filter((h) => h.toUpperCase() !== sw.hex.toUpperCase());
                      patch({ colourChoices: e.target.checked ? [...kept, sw.hex as `#${string}`] : kept });
                    }}
                  />
                  <span className="chip small" style={{ background: sw.hex }} />
                </label>
              );
            })}
          </div>
          <span className="hint">
            {slot.colourChoices?.length ? `${slot.colourChoices.length} offered` : 'None ticked — the whole palette is offered'}
          </span>
        </div>
      )}
      <label className="field wide">
        <span className="field-label">Example text (customers see it as a hint)</span>
        <input
          className="structure-name" data-testid={`text-placeholder-${slot.id}`}
          value={slot.placeholder ?? ''}
          onChange={(e) => patch({ placeholder: e.target.value })}
        />
      </label>
      <div className="field-row">
        <NumberField
          label="Extra when used" value={slot.priceDelta ?? 0} suffix={manifest.pricing.currency} step={1}
          testId={`text-price-${slot.id}`}
          onCommit={(v, o) => patch({ priceDelta: v }, o)}
        />
        <NumberField
          label="Per letter" value={slot.pricePerChar ?? 0} suffix={manifest.pricing.currency} step={0.5}
          testId={`text-perchar-${slot.id}`}
          onCommit={(v, o) => patch({ pricePerChar: v }, o)}
        />
      </div>
      <label className="lock">
        <input
          type="checkbox" checked={!!slot.perChar} data-testid={`text-spawn-${slot.id}`}
          onChange={(e) => patch({ perChar: e.target.checked ? {} : null })}
        />
        One piece per letter — each typed character spawns its own copy of this
        part (or its whole assembly)
      </label>
      {slot.perChar && (
        <div className="field-row">
          <label className="field">
            <span className="field-label">Pattern</span>
            <Select
              ariaLabel="Spawn pattern" testId={`text-spawn-mode-${slot.id}`} compact
              value={slot.perChar.mode ?? 'line'}
              options={[{ value: 'line', label: 'Linear' }, { value: 'circle', label: 'Circular' }]}
              onChange={(v) => patch({ perChar: { ...slot.perChar, mode: v as 'line' | 'circle' } })}
            />
          </label>
          {(slot.perChar.mode ?? 'line') === 'line' ? (
            <>
              <label className="field">
                <span className="field-label">Row axis</span>
                <Select
                  ariaLabel="Row axis" testId={`text-spawn-axis-${slot.id}`} compact
                  value={String(slot.perChar.axis ?? 0)}
                  options={UI_AXES.map(({ label, axis }) => ({ value: String(axis), label, tint: AXIS_COLOURS[label] }))}
                  onChange={(v) => patch({ perChar: { ...slot.perChar, axis: Number(v) as Axis } })}
                />
              </label>
              <NumberField
                label="Gap" value={slot.perChar.gapMm ?? 5} suffix="mm" testId={`text-spawn-gap-${slot.id}`}
                onCommit={(v) => patch({ perChar: { ...slot.perChar, gapMm: v } })}
              />
            </>
          ) : (
            <NumberField
              label="Step" value={slot.perChar.stepDeg ?? 30} suffix="°" step={5} testId={`text-spawn-step-${slot.id}`}
              onCommit={(v) => patch({ perChar: { ...slot.perChar, stepDeg: v } })}
            />
          )}
        </div>
      )}
      {/* The sketch plane's origin, typed instead of picked — the same
        * Z-up axis naming every other position field uses. The plane's
        * facing stays as picked; these slide the text along the part. */}
      <div className="field-row">
        {UI_AXES.map(({ label, axis }) => (
          <NumberField
            key={label} label={axisTint(label)} value={slot.origin[axis]} suffix="mm"
            testId={`text-origin-${label.toLowerCase()}-${slot.id}`}
            onCommit={(v, o) => {
              const origin = [...slot.origin] as [number, number, number];
              origin[axis] = v;
              patch({ origin }, o);
            }}
          />
        ))}
      </div>
      <p className="hint">Position on the part, in its own millimetres.</p>
      <div className="match-row">
        <button
          className="mini danger" data-testid={`text-remove-${slot.id}`}
          onClick={() => act(() => removeTextSlot(manifest, slot.id))}
        >Remove text</button>
      </div>
    </SlotCard>
  );
}

// One image zone's controls. Every commit routes through setImageZone /
// nudgeImageZone, so an out-of-range value surfaces the edit layer's message.
function ImageZoneEditor(props: {
  zone: UploadOption;
  manifest: Manifest;
  act: (fn: () => Manifest, opts?: SetManifestOptions) => void;
  first: boolean;
  last: boolean;
}) {
  const { zone, manifest, act } = props;
  // The slide fields are delta inputs: commit moves the zone, then the field
  // snaps back to 0 (the key tick remounts them) ready for the next step.
  const [tick, setTick] = useState(0);
  const patch = (p: ImageZonePatch, o?: SetManifestOptions) => act(() => setImageZone(manifest, zone.id, p), o);
  const slide = (du: number, dv: number) => {
    act(() => nudgeImageZone(manifest, zone.id, du, dv));
    setTick((t) => t + 1);
  };
  return (
    <SlotCard
      id={zone.id} testId={`image-zone-${zone.id}`}
      label={zone.label} namePlaceholder="Name — customers see it"
      first={props.first} last={props.last}
      onRename={(name) => patch({ label: name })}
      onMove={(direction) => act(() => moveOption(manifest, zone.id, direction))}
    >
      <div className="field-row">
        <NumberField
          label="Width" value={zone.widthMm} suffix="mm" testId={`image-width-${zone.id}`}
          onCommit={(v, o) => patch({ widthMm: v }, o)}
        />
        <NumberField
          label="Height" value={zone.heightMm} suffix="mm" testId={`image-height-${zone.id}`}
          onCommit={(v, o) => patch({ heightMm: v }, o)}
        />
        <NumberField
          label="Rotate" value={zone.rotationDeg ?? 0} suffix="°" step={5} testId={`image-spin-${zone.id}`}
          onCommit={(v, o) => patch({ rotationDeg: v }, o)}
        />
      </div>
      <div className="field-row">
        <NumberField
          key={`u-${tick}`} label="Slide ↔" value={0} suffix="mm" testId={`image-slide-u-${zone.id}`}
          onCommit={(v) => { if (v) slide(v, 0); }}
        />
        <NumberField
          key={`v-${tick}`} label="Slide ↕" value={0} suffix="mm" testId={`image-slide-v-${zone.id}`}
          onCommit={(v) => { if (v) slide(0, v); }}
        />
      </div>
      <p className="hint">
        Slide moves the zone across its surface.
      </p>
      <label className="field wide">
        <span className="field-label">Empty-zone wording (customers see it on the part)</span>
        <input
          className="structure-name" data-testid={`image-placeholder-${zone.id}`}
          value={zone.placeholder ?? 'Image here'}
          onChange={(e) => patch({ placeholder: e.target.value })}
        />
      </label>
      <p className="hint">
        Leave it blank for a bare zone with no words on it.
      </p>
      <div className="field-row">
        <NumberField
          label="Extra when used" value={zone.priceDelta ?? 0} suffix={manifest.pricing.currency} step={1}
          testId={`image-price-${zone.id}`}
          onCommit={(v, o) => patch({ priceDelta: v }, o)}
        />
      </div>
      <div className="match-row">
        <button
          className="mini danger" data-testid={`image-remove-${zone.id}`}
          onClick={() => act(() => removeImageZone(manifest, zone.id))}
        >Remove image zone</button>
      </div>
    </SlotCard>
  );
}

// Alignment glyphs for the edge triads: a reference line with a block sat at
// its min / centre / max — the text-align-buttons pattern, axis-agnostic.
const EDGE_ICON: Record<AnchorEdge, ReactNode> = {
  min: (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
      <rect x="1" y="1" width="1.6" height="11" rx=".8" fill="currentColor" />
      <rect x="3.6" y="3.5" width="7" height="6" rx="1.2" fill="currentColor" opacity=".5" />
    </svg>
  ),
  center: (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
      <rect x="5.7" y="1" width="1.6" height="11" rx=".8" fill="currentColor" />
      <rect x="3" y="3.5" width="7" height="6" rx="1.2" fill="currentColor" opacity=".5" />
    </svg>
  ),
  max: (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
      <rect x="10.4" y="1" width="1.6" height="11" rx=".8" fill="currentColor" />
      <rect x="2.4" y="3.5" width="7" height="6" rx="1.2" fill="currentColor" opacity=".5" />
    </svg>
  ),
};
const edgeName = (e: AnchorEdge) => (e === 'center' ? 'centre' : e);

function EdgeTriad(props: {
  label: string;
  value: AnchorEdge;
  testPrefix: string;
  onPick: (e: AnchorEdge) => void;
}) {
  return (
    <div className="edge-triad-row">
      <span className="field-label">{props.label}</span>
      <span className="edge-triad" role="group" aria-label={props.label}>
        {EDGES.map((ed) => (
          <button
            key={ed} type="button" title={edgeName(ed)}
            data-testid={`${props.testPrefix}-${ed}`}
            className={props.value === ed ? 'is-active' : ''}
            aria-pressed={props.value === ed}
            onClick={() => props.onPick(ed)}
          >{EDGE_ICON[ed]}</button>
        ))}
      </span>
    </div>
  );
}

function AxisAnchorRow(props: {
  project: Project;
  partId: string;
  axis: Axis;
  uiLabel: string;
  open: boolean;
  onToggle: () => void;
  onChange: (m: Manifest, opts?: SetManifestOptions) => void;
}) {
  const { manifest } = props.project;
  const part = manifest.parts.find((p) => p.id === props.partId)!;
  const placement = part.placement?.[AXIS_NAMES[props.axis]];
  const anchored = placement?.to && placement.to !== 'origin';
  const [ref, edge] = anchored ? placement!.to!.split(':') : ['', 'min'];
  const align = (placement?.align ?? 'center') as AnchorEdge;
  const others = manifest.parts.filter((p) => p.id !== part.id);
  const targetLabel = manifest.parts.find((p) => p.id === ref)?.label ?? ref;

  const commit = (next: { align: AnchorEdge; to: string; edge: AnchorEdge; offset: number } | { origin: true; offset?: number }) =>
    props.onChange(withAnchor(manifest, part.id, props.axis, next));

  const axisName = AXIS_NAMES[props.axis];
  return (
    <div className="anchor-block">
      <div className="anchor-row" data-testid={`anchor-${axisName}`}>
        <span className="axis-name" style={{ color: AXIS_COLOURS[props.uiLabel as 'X' | 'Y' | 'Z'] ?? undefined }}>{props.uiLabel}</span>
        <button
          type="button"
          className={`anchor-summary${anchored ? ' is-anchored' : ''}${props.open ? ' is-open' : ''}`}
          data-testid={`anchor-summary-${axisName}`}
          aria-expanded={props.open}
          title="Edit how this axis is placed"
          onClick={props.onToggle}
        >
          {anchored ? `${edgeName(align)} → ${targetLabel} ${edgeName(edge as AnchorEdge)}` : 'as modelled'}
        </button>
        <NumberField
          label="" value={partCentreMm(manifest, part.id, props.project.raw)[props.axis]} suffix="mm"
          testId={`pos-${axisName}`}
          onCommit={(v, o) => props.onChange(setPartCentre(manifest, part.id, props.axis, v, props.project.raw), o)}
        />
      </div>
      {props.open && (
        <div className="anchor-editor" data-testid={`anchor-editor-${axisName}`}>
          <Select
            ariaLabel="anchor mode" testId={`anchor-mode-${axisName}`}
            value={anchored ? ref : 'origin'}
            options={[
              { value: 'origin', label: 'as modelled — free on this axis' },
              ...others.map((p) => ({ value: p.id, label: `against ${p.label}` })),
            ]}
            onChange={(to) => commit(to === 'origin'
              ? { origin: true, offset: 0 }
              : { align: (placement?.align ?? 'min') as AnchorEdge, to, edge: edge as AnchorEdge, offset: placement?.offset ?? 0 })}
          />
          {anchored && (
            <div className="edge-triads">
              <EdgeTriad
                label="My edge" value={(placement!.align ?? 'center') as AnchorEdge}
                testPrefix={`anchor-my-${axisName}`}
                onPick={(v) => commit({ align: v, to: ref, edge: edge as AnchorEdge, offset: placement?.offset ?? 0 })}
              />
              <EdgeTriad
                label={`${targetLabel}'s edge`} value={edge as AnchorEdge}
                testPrefix={`anchor-their-${axisName}`}
                onPick={(v) => commit({ align: (placement!.align ?? 'center') as AnchorEdge, to: ref, edge: v, offset: placement?.offset ?? 0 })}
              />
            </div>
          )}
          <NumberField
            label={anchored ? 'Offset from the anchor' : 'Offset from the modelled position'}
            value={placement?.offset ?? 0} suffix="mm"
            testId={`offset-${axisName}`}
            onCommit={(offset) => commit(anchored
              ? { align: (placement!.align ?? 'center') as AnchorEdge, to: ref, edge: edge as AnchorEdge, offset }
              : { origin: true, offset })}
          />
        </div>
      )}
    </div>
  );
}
