// Take the model out of the Studio, from the topbar where Preview used to
// live: see exactly WHAT is being exported (every visible part, by name),
// name the file, pick a format, get the bytes. Geometry comes baked from
// the live viewer scene, so what downloads is exactly what the stage
// shows — layout applied, engraving cut, repeat copies placed, hidden
// parts skipped. Print formats leave Z-up for the slicer; web and DCC
// formats stay Y-up.

import { useEffect, useState } from 'react';
import type { Manifest } from '../../../embed/src/manifest/types.ts';
import { exportModel, EXPORT_FORMATS, type ExportFormat, type ExportMesh } from '../lib/export-model.ts';
import { slug } from '../lib/manifest-init.ts';
import { Select } from './controls.tsx';

export function ExportDialog(props: {
  manifest: Manifest;
  /** THE SELECTED OBJECT — the only thing this dialog exports. */
  target: { ids: string[]; label: string };
  onClose: () => void;
}) {
  const [format, setFormat] = useState<ExportFormat>('stl');
  const [name, setName] = useState('');
  const [meshes, setMeshes] = useState<ExportMesh[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Bake once, when the dialog opens — the scene cannot change underneath a
  // modal, and the list doubles as the "what am I exporting" answer.
  useEffect(() => {
    const viewer = (window as { __studioViewer?: { exportMeshes?: (ids?: string[]) => ExportMesh[] } }).__studioViewer;
    const baked = viewer?.exportMeshes?.(props.target.ids) ?? null;
    setMeshes(baked);
    if (!baked) return;
    // The selection names the file: a lone part by its own label, an
    // assembly or set by its name.
    setName(props.target.label);
  }, [props.manifest, props.target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    try {
      if (!meshes?.length) throw new Error('nothing visible to export');
      const spec = EXPORT_FORMATS.find((f) => f.id === format)!;
      const bytes = await exportModel(meshes, format, name.trim() || props.manifest.name);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: spec.mime }));
      a.download = `${slug(name.trim() || props.manifest.name)}.${spec.ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      setError(null);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const labels = meshes ? labelsOf(meshes, props.manifest) : [];
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="dialog-card shape-dialog" role="dialog" aria-modal="true" aria-label="Export the model" data-testid="export-dialog">
        <h3>Export the model</h3>
        {meshes && (
          <p className="trace-note" data-testid="export-parts">
            {labels.length
              ? `Exporting ${props.target.label}: ${labels.join(', ')}`
              : `Nothing to export — ${props.target.label} is hidden.`}
          </p>
        )}
        <div className="dialog-fields">
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
          <button className="cta" data-testid="export-download" disabled={!meshes?.length} onClick={save}>
            Export
          </button>
        </div>
      </div>
    </div>
  );
}

/** Human names for the baked meshes: part labels from the manifest, with
 * repeat copies folded into a count instead of listed one by one. */
function labelsOf(meshes: ExportMesh[], manifest: Manifest): string[] {
  const copies = new Map<string, number>();
  const bases: string[] = [];
  for (const mesh of meshes) {
    const copy = mesh.name.match(/^(.+)-copy-\d+$/);
    if (copy) { copies.set(copy[1], (copies.get(copy[1]) ?? 0) + 1); continue; }
    bases.push(mesh.name);
  }
  return bases.map((id) => {
    const label = manifest.parts.find((p) => p.id === id)?.label ?? id;
    const extra = copies.get(id);
    return extra ? `${label} (×${extra + 1})` : label;
  });
}
