// The Studio shell. All product logic lives in src/lib (tested); this file
// owns state and wiring: one manifest, one set of oriented parts, a viewer
// that re-lays-out on every edit.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Manifest } from '../../embed/src/manifest/types.ts';
import { defaultSelections } from '../../embed/src/runtime/state.ts';
import { importModel, AXIS_PRESETS, type OrientedModel } from './lib/import-model.ts';
import { writeGlb } from './lib/write-glb.ts';
import { initManifest, boundsOf, boundsByPartId, type PartBounds } from './lib/manifest-init.ts';
import { ImportError } from './lib/types.ts';
import { ViewerPane } from './ui/ViewerPane.tsx';
import { PartsPanel } from './ui/PartsPanel.tsx';
import { PalettePanel } from './ui/PalettePanel.tsx';
import { PublishPanel } from './ui/PublishPanel.tsx';

export interface Project {
  model: OrientedModel;
  manifest: Manifest;
  /** Untransformed part bounds by manifest part id — what mm maths run on. */
  raw: Map<string, PartBounds>;
  /** Blob URL of the (uncompressed) GLB the preview loads. */
  modelUrl: string;
}

const TABS = ['Parts', 'Palette', 'Publish'] as const;
type Tab = typeof TABS[number];

export function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('Parts');
  const [selectedPart, setSelectedPart] = useState<string | null>(null);
  const [hiddenParts, setHiddenParts] = useState<Set<string>>(new Set());
  const [solo, setSolo] = useState<string | null>(null);
  const [axes, setAxes] = useState<string>(AXIS_PRESETS[1].axes); // 3D-print files dominate
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (file: File) => {
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const model = importModel(bytes, { axes });
      const manifest = initManifest(model.parts, {
        name: file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') || 'New Product',
        bounds: model.bounds as PartBounds,
      });
      const raw = boundsByPartId(manifest, boundsOf(model.parts));
      const modelUrl = URL.createObjectURL(new Blob([writeGlb(model.parts)], { type: 'model/gltf-binary' }));
      setProject((old) => {
        if (old) URL.revokeObjectURL(old.modelUrl);
        return { model, manifest, raw, modelUrl };
      });
      setSelectedPart(manifest.parts[0]?.id ?? null);
      setHiddenParts(new Set());
      setSolo(null);
      setTab('Parts');
    } catch (err) {
      setError(err instanceof ImportError ? err.message : `import failed: ${err}`);
    }
  }, [axes]);

  const setManifest = useCallback((manifest: Manifest) => {
    setProject((old) => (old ? { ...old, manifest } : old));
  }, []);

  const selections = useMemo(() => {
    if (!project) return {};
    const s = defaultSelections(project.manifest);
    // Authoring preview: optional add-on parts stay visible. A customer's
    // default is "not selected", and honouring that in the Studio made a part
    // vanish the moment it was marked optional — technically faithful,
    // practically maddening.
    for (const part of project.manifest.parts) {
      if (part.visibleWhen?.equals?.length) s[part.visibleWhen.option] = part.visibleWhen.equals[0];
    }
    return s;
  }, [project?.manifest]);

  // Solo outranks the eyeballs: only the soloed part shows.
  const effectiveHidden = useMemo(() => {
    if (!project) return new Set<string>();
    if (solo) return new Set(project.manifest.parts.filter((p) => p.id !== solo).map((p) => p.id));
    return hiddenParts;
  }, [project?.manifest, hiddenParts, solo]);

  // The browser test reads and drives the app through this handle; it costs
  // nothing in production and makes "did the feature actually work" checkable.
  useEffect(() => {
    (window as any).__studio = project ? {
      manifest: project.manifest,
      raw: project.raw,
      setManifest,
    } : null;
  }, [project, setManifest]);

  if (!project) {
    return (
      <div className="upload-screen">
        <div
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) load(f); }}
          onClick={() => fileRef.current?.click()}
        >
          <h1>Configurator Studio</h1>
          <p>Drop a model to start — <strong>3MF</strong>, <strong>STL</strong> or <strong>GLB</strong>.</p>
          <p className="hint">Parts arrive as separate pieces from 3MF and GLB; STL imports as a single part.</p>
          <label className="axes-row" onClick={(e) => e.stopPropagation()}>
            Model orientation
            <select value={axes} onChange={(e) => setAxes(e.target.value)}>
              {AXIS_PRESETS.map((p) => <option key={p.id} value={p.axes}>{p.label}</option>)}
            </select>
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <input
            ref={fileRef} type="file" hidden data-testid="file-input"
            accept=".3mf,.stl,.glb,model/gltf-binary"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); e.target.value = ''; }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="studio">
      <header className="topbar">
        <span className="brand">Studio</span>
        <input
      className="product-name" value={project.manifest.name} aria-label="Product name"
          onChange={(e) => {
            // Renames go through the edit op on blur; live typing just previews.
            const draft = structuredClone(project.manifest);
            draft.name = e.target.value;
            setManifest(draft);
          }}
        />
        <span className="spacer" />
        <button className="ghost" onClick={() => { URL.revokeObjectURL(project.modelUrl); setProject(null); }}>
          New model
        </button>
      </header>

      <div className="workspace">
        <aside className="panel">
          <nav className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </nav>
          {tab === 'Parts' && (
            <PartsPanel
              project={project} selectedPart={selectedPart}
              hiddenParts={hiddenParts} solo={solo}
              onSelectPart={setSelectedPart}
              onToggleHidden={(id) => setHiddenParts((old) => {
                const next = new Set(old);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
              })}
              onSolo={setSolo}
              onHideAll={(hide) => { setSolo(null); setHiddenParts(hide ? new Set(project.manifest.parts.map((p) => p.id)) : new Set()); }}
              onChange={setManifest}
            />
          )}
          {tab === 'Palette' && <PalettePanel project={project} onChange={setManifest} />}
          {tab === 'Publish' && <PublishPanel project={project} onChange={setManifest} />}
        </aside>

        <ViewerPane
          project={project} selections={selections} selectedPart={selectedPart}
          hiddenParts={effectiveHidden}
          onSelectPart={(id) => { setSelectedPart(id); if (id) setTab('Parts'); }}
          onChange={setManifest}
        />
      </div>
    </div>
  );
}
