// Publish: name and currency, a validation report, and the two files a
// merchant deploys — manifest.json and model.glb — plus the embed snippet.
// The GLB written here is the same bytes the preview has been rendering.

import { useMemo, useState } from 'react';
import type { Manifest } from '../../../embed/src/manifest/types.ts';
import { validateManifest } from '../../../embed/src/manifest/validate.ts';
import { frameCamera, withProductName, withCurrency } from '../lib/manifest-edit.ts';
import { writeGlb } from '../lib/write-glb.ts';
import type { Project } from '../App.tsx';

export function PublishPanel(props: { project: Project; onChange: (m: Manifest) => void }) {
  const { manifest, model } = props.project;
  const [error, setError] = useState<string | null>(null);
  const report = useMemo(() => validateManifest(manifest), [manifest]);

  const download = (name: string, blob: Blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };

  const snippet = `<div data-configurator="${manifest.id}.manifest.json"></div>
<link rel="stylesheet" href="embed.css">
<script type="module">
  import { autoMount } from './embed.js';
  autoMount();
</script>`;

  return (
    <div className="panel-body">
      <label className="field wide">
        <span className="field-label">Product name</span>
        <input
          defaultValue={manifest.name} data-testid="publish-name"
          onBlur={(e) => {
            try { props.onChange(withProductName(manifest, e.target.value)); setError(null); }
            catch (err) { setError(err instanceof Error ? err.message : String(err)); }
          }}
        />
      </label>
      <label className="field wide">
        <span className="field-label">Currency</span>
        <input
          defaultValue={manifest.pricing.currency} maxLength={3} data-testid="publish-currency"
          onBlur={(e) => {
            try { props.onChange(withCurrency(manifest, e.target.value.toUpperCase())); setError(null); }
            catch (err) { setError(err instanceof Error ? err.message : String(err)); }
          }}
        />
      </label>
      {error && <p className="error" role="alert">{error}</p>}

      <div className={`report ${report.ok ? 'ok' : 'bad'}`} data-testid="validation-report">
        {report.ok
          ? `Valid — ${manifest.parts.length} parts, ${manifest.options.length} options.`
          : `${report.errors.length} error(s): ${report.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`}
        {report.warnings.length > 0 && (
          <ul>{report.warnings.map((w, i) => <li key={i}>{w.path}: {w.message}</li>)}</ul>
        )}
      </div>

      <div className="publish-actions">
        <button
          data-testid="download-manifest" disabled={!report.ok}
          onClick={() => {
            // Refit the camera to the model as finally laid out — the init
            // camera was framed before any resizing or anchoring happened.
            const framed = frameCamera(manifest, props.project.raw);
            download(`${framed.id}.manifest.json`,
              new Blob([JSON.stringify(framed, null, 2)], { type: 'application/json' }));
          }}
        >Download manifest</button>
        <button
          data-testid="download-model" disabled={!report.ok}
          onClick={() => download('model.glb',
            new Blob([writeGlb(model.parts) as BlobPart], { type: 'model/gltf-binary' }))}
        >Download model.glb</button>
      </div>
      <p className="hint">
        Host both files next to your product page. The model is uncompressed here;
        run it through the pipeline's compress step before production traffic.
      </p>

      <h4>Embed snippet</h4>
      <pre className="snippet" data-testid="snippet">{snippet}</pre>
    </div>
  );
}
