// Take the model out of the Studio, from the topbar where Preview used to
// live: pick a format, get the file. Geometry comes baked from the live
// viewer scene, so what downloads is exactly what the stage shows —
// layout applied, engraving cut, repeat copies placed, hidden parts
// skipped, millimetres throughout.

import { useEffect, useState } from 'react';
import type { Manifest } from '../../../embed/src/manifest/types.ts';
import { exportModel, EXPORT_FORMATS, type ExportFormat, type ExportMesh } from '../lib/export-model.ts';
import { Select } from './controls.tsx';

export function ExportDialog(props: { manifest: Manifest; onClose: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('stl');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = () => {
    try {
      const viewer = (window as { __studioViewer?: { exportMeshes?: () => ExportMesh[] } }).__studioViewer;
      const meshes = viewer?.exportMeshes?.();
      if (!meshes) throw new Error('the 3D view is still loading');
      const spec = EXPORT_FORMATS.find((f) => f.id === format)!;
      const bytes = exportModel(meshes, format, props.manifest.name);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: spec.mime }));
      a.download = `${props.manifest.id}.${spec.ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      setError(null);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="dialog-card shape-dialog" role="dialog" aria-modal="true" aria-label="Export the model" data-testid="export-dialog">
        <h3>Export the model</h3>
        <div className="dialog-body">
          <p>
            The model exactly as laid out on the stage — repeat copies included,
            hidden parts left out — in millimetres. Customer text and images are
            not part of the model.
          </p>
        </div>
        <div className="dialog-fields">
          <Select
            value={format} ariaLabel="Export format" testId="export-format"
            options={EXPORT_FORMATS.map((f) => ({ value: f.id, label: f.label }))}
            onChange={(id) => setFormat(id as ExportFormat)}
          />
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="ghost" onClick={props.onClose}>Cancel</button>
          <button className="cta" data-testid="export-download" disabled={!props.manifest.parts.length} onClick={save}>
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
