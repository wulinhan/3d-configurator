// Take the model out of the Studio, from the topbar where Preview used to
// live. The dialog lists every part the way the explorer does — assemblies
// and variant sets with their members indented — each with a tick box, so
// WHAT gets exported is chosen right here (opening pre-ticks whatever the
// explorer had ticked). Geometry comes baked from the live viewer scene,
// so what downloads is exactly what the stage shows — layout applied,
// engraving cut, repeat copies placed, hidden parts skipped. Print formats
// leave Z-up for the slicer; web and DCC formats stay Y-up.

import { useEffect, useMemo, useState } from 'react';
import type { Manifest } from '../../../embed/src/manifest/types.ts';
import { exportModel, EXPORT_FORMATS, type ExportFormat, type ExportMesh } from '../lib/export-model.ts';
import { entriesOf } from '../lib/manifest-edit.ts';
import { slug } from '../lib/manifest-init.ts';
import { Select } from './controls.tsx';

export function ExportDialog(props: {
  manifest: Manifest;
  /** The explorer's current ☑ set — the dialog opens with these ticked. */
  initialChecked: string[];
  onClose: () => void;
}) {
  const { manifest } = props;
  const [format, setFormat] = useState<ExportFormat>('stl');
  const [name, setName] = useState(manifest.name);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(
    props.initialChecked.length ? props.initialChecked : manifest.parts.map((p) => p.id)));
  const [error, setError] = useState<string | null>(null);

  const entries = useMemo(() => entriesOf(manifest), [manifest]);
  const labelOf = (id: string) => manifest.parts.find((p) => p.id === id)?.label ?? id;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (ids: string[], on: boolean) => {
    setChecked((old) => {
      const next = new Set(old);
      for (const id of ids) { if (on) next.add(id); else next.delete(id); }
      return next;
    });
  };

  const save = async () => {
    try {
      const ids = [...checked];
      if (!ids.length) throw new Error('tick at least one part');
      const viewer = (window as { __studioViewer?: { exportMeshes?: (ids?: string[]) => ExportMesh[] } }).__studioViewer;
      const meshes = viewer?.exportMeshes?.(ids) ?? [];
      if (!meshes.length) throw new Error('nothing visible to export — the ticked parts are hidden');
      const spec = EXPORT_FORMATS.find((f) => f.id === format)!;
      const bytes = await exportModel(meshes, format, name.trim() || manifest.name);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: spec.mime }));
      a.download = `${slug(name.trim() || manifest.name)}.${spec.ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      setError(null);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const row = (id: string, indent: boolean) => (
    <label key={id} className={`export-row${indent ? ' is-member' : ''}`} data-testid={`export-tick-${id}`}>
      <input
        type="checkbox" checked={checked.has(id)}
        onChange={(e) => toggle([id], e.target.checked)}
      />
      <span>{labelOf(id)}</span>
    </label>
  );

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="dialog-card shape-dialog export-dialog" role="dialog" aria-modal="true" aria-label="Export the model" data-testid="export-dialog">
        <h3>Export</h3>
        <div className="dialog-fields">
          <div className="export-parts" data-testid="export-parts">
            {!manifest.parts.length && <p className="hint">Nothing to export yet — add a part first.</p>}
            {entries.map((entry) => entry.kind === 'part' ? row(entry.id, false) : (
              <div key={entry.id} className="export-entry">
                <label className="export-row is-head" data-testid={`export-tick-${entry.id}`}>
                  <input
                    type="checkbox"
                    checked={entry.parts.every((p) => checked.has(p))}
                    onChange={(e) => toggle(entry.parts, e.target.checked)}
                  />
                  <span>{entry.label} <span className="tag">{entry.kind === 'group' ? 'assembly' : 'variants'}</span></span>
                </label>
                {entry.parts.map((p) => row(p, true))}
              </div>
            ))}
          </div>
          <label className="field wide">
            <span className="field-label">File name</span>
            <input
              value={name} data-testid="export-name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
            />
          </label>
          <Select
            value={format} ariaLabel="Export format" testId="export-format"
            options={EXPORT_FORMATS.map((f) => ({ value: f.id, label: f.label }))}
            onChange={(id) => setFormat(id as ExportFormat)}
          />
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="ghost" onClick={props.onClose}>Cancel</button>
          <button className="cta" data-testid="export-download" disabled={!checked.size} onClick={save}>
            {checked.size ? `Export ${checked.size} part${checked.size === 1 ? '' : 's'}` : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
