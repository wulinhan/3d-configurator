// The Studio shell. All product logic lives in src/lib (tested); this file
// owns state and wiring: one manifest, one set of oriented parts, a viewer
// that re-lays-out on every edit.
//
// Undo/redo lives here and nowhere else. Every edit op returns a fresh
// validated manifest, so history is just a stack of past manifests — no
// command objects, no inverse operations. Gizmo drags stream transient
// commits (which replace instead of push), so a whole drag is one undo step.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Manifest, ChoiceOption } from '../../embed/src/manifest/types.ts';
import { defaultSelections } from '../../embed/src/runtime/state.ts';
import { importModel, AXIS_PRESETS, type OrientedModel } from './lib/import-model.ts';
import { writeGlb } from './lib/write-glb.ts';
import { initManifest, boundsOf, boundsByPartId, type PartBounds } from './lib/manifest-init.ts';
import { ImportError } from './lib/types.ts';
import { ViewerPane } from './ui/ViewerPane.tsx';
import { PartsPanel } from './ui/PartsPanel.tsx';
import { PalettePanel } from './ui/PalettePanel.tsx';
import { PublishPanel } from './ui/PublishPanel.tsx';
import { PreviewOverlay } from './ui/PreviewOverlay.tsx';

export interface Project {
  model: OrientedModel;
  manifest: Manifest;
  /** Untransformed part bounds by manifest part id — what mm maths run on. */
  raw: Map<string, PartBounds>;
  /** Blob URL of the (uncompressed) GLB the preview loads. */
  modelUrl: string;
}

export interface SetManifestOptions {
  /** Replace the current manifest without recording an undo step — used by
   * live gizmo commits so a drag lands as a single history entry. */
  transient?: boolean;
}

const TABS = ['Parts', 'Palette', 'Publish'] as const;
type Tab = typeof TABS[number];
const HISTORY_LIMIT = 100;

const isVariantOption = (m: Manifest, optionId: string): boolean => {
  const o = m.options.find((x) => x.id === optionId);
  return o?.type === 'choice' && (o as ChoiceOption).role === 'variant';
};

export function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('Parts');
  const [selectedPart, setSelectedPart] = useState<string | null>(null);
  const [hiddenParts, setHiddenParts] = useState<Set<string>>(new Set());
  const [solo, setSolo] = useState<string | null>(null);
  const [axes, setAxes] = useState<string>(AXIS_PRESETS[1].axes); // 3D-print files dominate
  const [previewing, setPreviewing] = useState(false);
  // Which choice each variant option shows while authoring — the merchant's
  // temporary pick, never written to the manifest.
  const [variantPreview, setVariantPreview] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  // History as refs: pushes happen inside event handlers, and every push is
  // paired with a setProject that re-renders, so render-time reads are never
  // stale. Keeping them out of state avoids re-render loops on cap trimming.
  const projectRef = useRef<Project | null>(null);
  projectRef.current = project;
  const pastRef = useRef<Manifest[]>([]);
  const futureRef = useRef<Manifest[]>([]);

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
      pastRef.current = [];
      futureRef.current = [];
      setSelectedPart(manifest.parts[0]?.id ?? null);
      setHiddenParts(new Set());
      setSolo(null);
      setVariantPreview({});
      setPreviewing(false);
      setTab('Parts');
    } catch (err) {
      setError(err instanceof ImportError ? err.message : `import failed: ${err}`);
    }
  }, [axes]);

  const setManifest = useCallback((manifest: Manifest, opts?: SetManifestOptions) => {
    const old = projectRef.current;
    if (!old) return;
    if (!opts?.transient && manifest !== old.manifest
      && JSON.stringify(manifest) !== JSON.stringify(old.manifest)) {
      pastRef.current.push(old.manifest);
      if (pastRef.current.length > HISTORY_LIMIT) pastRef.current.shift();
      futureRef.current = [];
    }
    setProject({ ...old, manifest });
  }, []);

  const undo = useCallback(() => {
    const old = projectRef.current;
    const prev = pastRef.current.pop();
    if (!old || !prev) return;
    futureRef.current.push(old.manifest);
    setProject({ ...old, manifest: prev });
  }, []);

  const redo = useCallback(() => {
    const old = projectRef.current;
    const next = futureRef.current.pop();
    if (!old || !next) return;
    pastRef.current.push(old.manifest);
    setProject({ ...old, manifest: next });
  }, []);

  // Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y), everywhere except while
  // typing — a text field's own undo must stay a text-field undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      if (key === 'y' || e.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // Selecting a hidden variant switches the preview to it — "only one can be
  // visible and edited at once" means clicking the other one shows it.
  const selectPart = useCallback((id: string | null) => {
    setSelectedPart(id);
    if (!id) return;
    const m = projectRef.current?.manifest;
    const rule = m?.parts.find((p) => p.id === id)?.visibleWhen;
    if (m && rule?.equals?.length && isVariantOption(m, rule.option)) {
      const choice = rule.equals[0];
      setVariantPreview((v) => (v[rule.option] === choice ? v : { ...v, [rule.option]: choice }));
    }
  }, []);

  const selections = useMemo(() => {
    if (!project) return {};
    const m = project.manifest;
    const s = defaultSelections(m);
    for (const part of m.parts) {
      const rule = part.visibleWhen;
      if (!rule?.equals?.length) continue;
      // Variants keep their exclusivity — that's the point of them. Optional
      // add-ons are forced visible while authoring: a customer's default is
      // "not selected", and honouring that made a part vanish the moment it
      // was marked optional.
      if (!isVariantOption(m, rule.option)) s[rule.option] = rule.equals[0];
    }
    for (const [optionId, choiceId] of Object.entries(variantPreview)) {
      const o = m.options.find((x) => x.id === optionId);
      if (o?.type === 'choice' && (o as ChoiceOption).role === 'variant'
        && (o as ChoiceOption).choices.some((c) => c.id === choiceId)) {
        s[optionId] = choiceId;
      }
    }
    return s;
  }, [project?.manifest, variantPreview]);

  // Solo outranks the eyeballs: only the soloed part shows.
  const effectiveHidden = useMemo(() => {
    if (!project) return new Set<string>();
    if (solo) return new Set(project.manifest.parts.filter((p) => p.id !== solo).map((p) => p.id));
    return hiddenParts;
  }, [project?.manifest, hiddenParts, solo]);

  const setHidden = useCallback((ids: string[], hidden: boolean) => {
    setHiddenParts((old) => {
      const next = new Set(old);
      for (const id of ids) { if (hidden) next.add(id); else next.delete(id); }
      return next;
    });
  }, []);

  // The browser test reads and drives the app through this handle; it costs
  // nothing in production and makes "did the feature actually work" checkable.
  useEffect(() => {
    (window as any).__studio = project ? {
      manifest: project.manifest,
      raw: project.raw,
      setManifest,
      undo,
      redo,
      historyDepth: () => ({ past: pastRef.current.length, future: futureRef.current.length }),
    } : null;
  }, [project, setManifest, undo, redo]);

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
        <button
          className="ghost" data-testid="undo" title="Undo (Ctrl+Z)"
          disabled={pastRef.current.length === 0} onClick={undo}
        >↩ Undo</button>
        <button
          className="ghost" data-testid="redo" title="Redo (Ctrl+Shift+Z)"
          disabled={futureRef.current.length === 0} onClick={redo}
        >↪ Redo</button>
        <button className="ghost preview-btn" data-testid="preview-open" onClick={() => setPreviewing(true)}>
          Preview
        </button>
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
              selections={selections}
              onSelectPart={selectPart}
              onSetHidden={setHidden}
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
          onSelectPart={(id) => { selectPart(id); if (id) setTab('Parts'); }}
          onChange={setManifest}
        />
      </div>
      {previewing && <PreviewOverlay project={project} onClose={() => setPreviewing(false)} />}
    </div>
  );
}
