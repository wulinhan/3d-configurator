// The properties editors — one for a part, one for an assembly. They render
// inside the floating panel that slides in from the right when something is
// selected (see App.tsx); the explorer stays in the left panel. Every control
// calls a tested edit op; these components only render and route.

import { useState, type ReactNode } from 'react';
import type { Manifest, AnchorEdge, ColourOption, ChoiceOption, TextOption, UploadOption, TextFont } from '../../../embed/src/manifest/types.ts';
import { FONT_CHOICES } from '../../../embed/src/runtime/fonts.ts';
import { defaultBoundary } from '../../../embed/src/runtime/curve.ts';
import {
  sizeMm, withSizeMm, withAnchor, withRotation,
  makePartOptional, makePartRequired, setChoicePrice,
  setDefaultSwatch, setCustomColour,
  ungroup, renameGroup, nudgeGroup, partToOrigin, groupToOrigin,
  matchPose, partCentreMm, setPartCentre,
  nudgeVariant, variantToOrigin, renameVariantSet, dissolveVariantChoice,
  setTextSlot, removeTextSlot, type TextSlotPatch,
  setImageZone, nudgeImageZone, removeImageZone, setImageZoneBoundary, type ImageZonePatch,
  entrySizeMm, withEntrySizeMm,
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
  act: (fn: () => Manifest) => void;
}) {
  const [lock, setLock] = useState(true);
  let size: [number, number, number];
  try {
    size = entrySizeMm(props.project.manifest, props.entryId, props.project.raw);
  } catch {
    return null;
  }
  return (
    <section>
      <div className="section-head">
        <h4>Size</h4>
        <label className="lock">
          <input
            type="checkbox" checked={lock} data-testid="set-lock-aspect"
            onChange={(e) => setLock(e.target.checked)}
          />
          Lock proportions
        </label>
      </div>
      <div className="field-row">
        {AXIS_LABELS.map((label, axis) => (
          <NumberField
            key={label} label={label} value={size[axis]} suffix="mm"
            testId={`set-size-${label.toLowerCase()}`}
            onCommit={(mm) => props.act(() =>
              withEntrySizeMm(props.project.manifest, props.entryId, axis as Axis, mm, props.project.raw, lock))}
          />
        ))}
      </div>
    </section>
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
    <section>
      <h4>Repeat</h4>
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
    </section>
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

  const act = (fn: () => Manifest) => {
    try { props.onChange(fn()); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div className="part-editor" data-testid={`group-editor-${group.id}`}>
      <h3>{group.label} <span className="tag">assembly</span></h3>
      <p className="hint">Rename by double-clicking its name in the explorer.</p>
      <EntrySizeSection entryId={group.id} project={props.project} act={act} />
      <section>
        <h4>Move together</h4>
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
      </section>
      <section>
        <h4>Assembly</h4>
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
      </section>
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

  const act = (fn: () => Manifest) => {
    try { props.onChange(fn()); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div className="part-editor" data-testid={`variant-editor-${option.id}`}>
      <h3>{option.label} <span className="tag">variants</span></h3>
      <p className="hint">Rename by double-clicking its name in the explorer.</p>
      <EntrySizeSection entryId={option.id} project={props.project} act={act} />
      <section>
        <h4>Move together</h4>
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
      </section>
      <section>
        <h4>Variant set</h4>
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
      </section>
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
  /** Image-zone whose boundary handles are live in the viewport. */
  shapingZone: string | null;
  onEditShape: (optionId: string) => void;
  /** Re-measure the face and re-conform the zone to it (Reset shape). */
  onResetShape: (optionId: string) => void;
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
            options={manifest.parts.filter((p) => p.id !== part.id).map((p) => ({ value: p.id, label: p.label }))}
            onChange={setMatchFrom}
          />
          <button
            className="mini" data-testid="match-apply" disabled={!matchFrom}
            title="Land centre-on-centre with the same rotation; follows if that part later moves"
            onClick={() => { act(() => matchPose(manifest, matchFrom, part.id)); setMatchFrom(''); }}
          >Apply</button>
          <button
            className="mini" data-testid="to-origin" title="Centre on X/Y, sit on the ground at Z 0 — anchors survive"
            onClick={() => act(() => partToOrigin(manifest, part.id, raw))}
          >To origin</button>
        </div>
      </section>

      <section>
        <h4>Rotation</h4>
        <div className="field-row">
          {UI_AXES.map(({ label, axis }) => (
            <NumberField
              key={label} label={axisTint(label)} value={rotation[axis]} suffix="°" step={5}
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
          <h4>Variant set</h4>
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
      <section>
        <h4>3D text</h4>
        <p className="hint">
          Customers type; their words extrude from a flat face of this part.
          Place the sketch plane by clicking a face, then set the typeface,
          size and depth — sink the plane to engrave instead of emboss.
        </p>
        {manifest.options.filter((o): o is TextOption => o.type === 'text' && o.part === part.id).map((slot) => (
          <TextSlotEditor key={slot.id} slot={slot} manifest={manifest} onChange={props.onChange} act={act} />
        ))}
        <div className="match-row">
          <button
            className="mini" data-testid="place-text"
            title="Click a flat face on this part in the viewport to set where the text sits"
            onClick={() => props.onPlaceText(part.id)}
          >＋ Place text on a face</button>
        </div>
      </section>
      <section>
        <h4>Image zone</h4>
        <p className="hint">
          Customers upload an image; it is projected onto this part inside the
          zone — flat or curved, the surface takes it. Click a face to place
          the zone, then set its size in millimetres.
        </p>
        {manifest.options.filter((o): o is UploadOption => o.type === 'upload' && o.part === part.id).map((zone) => (
          <ImageZoneEditor
            key={zone.id} zone={zone} manifest={manifest} act={act}
            shaping={props.shapingZone === zone.id} onEditShape={props.onEditShape}
            onResetShape={props.onResetShape}
          />
        ))}
        <div className="match-row">
          <button
            className="mini" data-testid="place-image"
            title="Click a face on this part in the viewport to set where customer images land"
            onClick={() => props.onPlaceImage(part.id)}
          >＋ Place image zone on a face</button>
        </div>
      </section>
      {!inGroup && !variantOf && <RepeatSection entryId={part.id} what="part" onRepeat={props.onRepeat} />}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

// One text slot's controls. Every commit routes through setTextSlot, so an
// out-of-range value surfaces the edit layer's message instead of saving.
function TextSlotEditor(props: {
  slot: TextOption;
  manifest: Manifest;
  onChange: (m: Manifest, opts?: SetManifestOptions) => void;
  act: (fn: () => Manifest) => void;
}) {
  const { slot, manifest, act } = props;
  const patch = (p: TextSlotPatch) => act(() => setTextSlot(manifest, slot.id, p));
  return (
    <div className="text-slot" data-testid={`text-slot-${slot.id}`}>
      <label className="field wide">
        <span className="field-label">Typeface</span>
        <Select
          ariaLabel="Typeface" testId={`text-font-${slot.id}`}
          value={slot.font ?? 'sans-bold'}
          options={FONT_CHOICES.map((f) => ({ value: f.id, label: f.label }))}
          onChange={(v) => patch({ font: v as TextFont })}
        />
      </label>
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
          onCommit={(v) => patch({ sizeMm: v })}
        />
        <NumberField
          label="Depth" value={slot.depthMm} suffix="mm" testId={`text-depth-${slot.id}`}
          onCommit={(v) => patch({ depthMm: v })}
        />
        {(slot.style ?? 'emboss') === 'emboss' && (
          <NumberField
            label="Sink" value={slot.sinkMm ?? 0} suffix="mm" testId={`text-sink-${slot.id}`}
            onCommit={(v) => patch({ sinkMm: v })}
          />
        )}
      </div>
      <div className="field-row">
        <NumberField
          label="Rotate" value={slot.rotationDeg ?? 0} suffix="°" step={5} testId={`text-spin-${slot.id}`}
          onCommit={(v) => patch({ rotationDeg: v })}
        />
        <NumberField
          label="Max letters" value={slot.maxLength ?? 20} step={1} testId={`text-max-${slot.id}`}
          onCommit={(v) => patch({ maxLength: Math.round(v) })}
        />
      </div>
      <label className="field wide">
        <span className="field-label">Text colour</span>
        <Select
          ariaLabel="Text colour" testId={`text-colour-${slot.id}`}
          value={slot.colourHex ?? ''}
          placeholder="Match the part"
          options={[
            { value: '', label: 'Match the part' },
            ...(manifest.palettes?.[0]?.swatches ?? []).map((s) => ({ value: s.hex, label: s.name, chip: s.hex })),
          ]}
          onChange={(v) => patch({ colourHex: v === '' ? null : (v as `#${string}`) })}
        />
      </label>
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
          onCommit={(v) => patch({ priceDelta: v })}
        />
        <NumberField
          label="Per letter" value={slot.pricePerChar ?? 0} suffix={manifest.pricing.currency} step={0.5}
          testId={`text-perchar-${slot.id}`}
          onCommit={(v) => patch({ pricePerChar: v })}
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
      <div className="match-row">
        <button
          className="mini danger" data-testid={`text-remove-${slot.id}`}
          onClick={() => act(() => removeTextSlot(manifest, slot.id))}
        >Remove text</button>
      </div>
    </div>
  );
}

// One image zone's controls. Every commit routes through setImageZone /
// nudgeImageZone, so an out-of-range value surfaces the edit layer's message.
function ImageZoneEditor(props: {
  zone: UploadOption;
  manifest: Manifest;
  act: (fn: () => Manifest) => void;
  shaping: boolean;
  onEditShape: (optionId: string) => void;
  onResetShape: (optionId: string) => void;
}) {
  const { zone, manifest, act } = props;
  // The slide fields are delta inputs: commit moves the zone, then the field
  // snaps back to 0 (the key tick remounts them) ready for the next step.
  const [tick, setTick] = useState(0);
  const patch = (p: ImageZonePatch) => act(() => setImageZone(manifest, zone.id, p));
  const slide = (du: number, dv: number) => {
    act(() => nudgeImageZone(manifest, zone.id, du, dv));
    setTick((t) => t + 1);
  };
  return (
    <div className="text-slot" data-testid={`image-zone-${zone.id}`}>
      <div className="field-row">
        <NumberField
          label="Width" value={zone.widthMm} suffix="mm" testId={`image-width-${zone.id}`}
          onCommit={(v) => patch({ widthMm: v })}
        />
        <NumberField
          label="Height" value={zone.heightMm} suffix="mm" testId={`image-height-${zone.id}`}
          onCommit={(v) => patch({ heightMm: v })}
        />
        <NumberField
          label="Rotate" value={zone.rotationDeg ?? 0} suffix="°" step={5} testId={`image-spin-${zone.id}`}
          onCommit={(v) => patch({ rotationDeg: v })}
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
      <div className="field-row">
        <NumberField
          label="Extra when used" value={zone.priceDelta ?? 0} suffix={manifest.pricing.currency} step={1}
          testId={`image-price-${zone.id}`}
          onCommit={(v) => patch({ priceDelta: v })}
        />
      </div>
      <div className="match-row">
        <button
          className={`mini${props.shaping ? ' is-active' : ''}`} data-testid={`image-shape-${zone.id}`}
          title="Drag the dots on the model to reshape the zone into any smooth outline"
          onClick={() => {
            if (!zone.boundary && !props.shaping) {
              act(() => setImageZoneBoundary(manifest, zone.id, defaultBoundary(zone.widthMm, zone.heightMm)));
            }
            props.onEditShape(zone.id);
          }}
        >{props.shaping ? 'Done shaping' : 'Edit shape'}</button>
        <button
          className="mini" data-testid={`image-shape-reset-${zone.id}`}
          title="Re-measure the face and conform the zone to it again"
          onClick={() => props.onResetShape(zone.id)}
        >Reset shape</button>
        <button
          className="mini danger" data-testid={`image-remove-${zone.id}`}
          onClick={() => act(() => removeImageZone(manifest, zone.id))}
        >Remove image zone</button>
      </div>
    </div>
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
          onCommit={(v) => props.onChange(setPartCentre(manifest, part.id, props.axis, v, props.project.raw))}
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
