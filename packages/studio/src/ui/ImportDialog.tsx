// Importing a model file, as a proper dialog: a dropzone that lights up
// while a file is dragged over it, a click-to-browse fallback, and the
// import orientation choice right where it matters — next to the drop,
// not buried in the panel.

import { useEffect, useState, type DragEvent as ReactDragEvent } from 'react';
import { AXIS_PRESETS } from '../lib/import-model.ts';
import { Select } from './controls.tsx';

export function ImportDialog(props: {
  axes: string;
  onAxesChange: (axes: string) => void;
  /** A file dropped straight onto the zone. */
  onFile: (file: File) => void;
  /** The click-to-browse path — opens the panel's file input. */
  onBrowse: () => void;
  onClose: () => void;
}) {
  const [over, setOver] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const drop = (e: ReactDragEvent) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) props.onFile(file);
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="dialog-card shape-dialog" role="dialog" aria-modal="true" aria-label="Import parts" data-testid="import-dialog">
        <h3>Import parts</h3>
        <div className="dialog-body">
          <p>
            Parts arrive as separate pieces from 3MF and GLB; STL imports as a
            single part. Everything lands centred, sitting on the ground.
          </p>
        </div>
        <div
          className={`dropzone${over ? ' is-over' : ''}`} data-testid="import-dropzone"
          role="button" tabIndex={0} aria-label="Drop a model file, or click to browse"
          onClick={props.onBrowse}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onBrowse(); } }}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={drop}
        >
          <strong>{over ? 'Drop it here' : 'Drop a 3MF / STL / GLB here'}</strong>
          <span>or click to browse</span>
        </div>
        <div className="dialog-fields">
          <label className="field wide">
            <span className="field-label">Which way is the file up?</span>
            <Select
              value={props.axes} ariaLabel="Import orientation" testId="axes-preset"
              options={AXIS_PRESETS.map((p) => ({ value: p.axes, label: p.label }))}
              onChange={props.onAxesChange}
            />
          </label>
        </div>
        <div className="dialog-actions">
          <button className="ghost" onClick={props.onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
