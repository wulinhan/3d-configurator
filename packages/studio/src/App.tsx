// The Studio shell. All product logic lives in src/lib (tested); this file
// owns state and wiring: one manifest, one set of oriented parts, a viewer
// that re-lays-out on every edit.
//
// Undo/redo lives here and nowhere else. Every edit op returns a fresh
// validated manifest, so history is just a stack of past manifests — no
// command objects, no inverse operations. Gizmo drags stream transient
// commits (which replace instead of push), so a whole drag is one undo step.
//
// Layout: a resizable explorer on the left (drag the divider; click its pill
// to collapse), the stage in the middle, and a floating properties panel
// that slides in over the stage's right edge whenever a part or assembly is
// selected — the stage keeps its full width, the properties come to you.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import type { Manifest, ChoiceOption } from '../../embed/src/manifest/types.ts';
import { defaultSelections } from '../../embed/src/runtime/state.ts';
import { importModel, AXIS_PRESETS, type OrientedModel } from './lib/import-model.ts';
import { writeGlb } from './lib/write-glb.ts';
import { initManifest, boundsOf, boundsByPartId, mergeModel, type PartBounds } from './lib/manifest-init.ts';
import { duplicateEntry, repeatEntry, frameCamera, withProductName, addTextSlot, type Axis } from './lib/manifest-edit.ts';
import { ViewerPane } from './ui/ViewerPane.tsx';
import { PartsPanel } from './ui/PartsPanel.tsx';
import { PartEditor, GroupEditor, VariantEditor } from './ui/PartEditor.tsx';
import { PalettePanel } from './ui/PalettePanel.tsx';
import { FinishPanel } from './ui/FinishPanel.tsx';
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

const TABS = ['Parts', 'Palette', 'Finish'] as const;
type Tab = typeof TABS[number];
const HISTORY_LIMIT = 100;
const PANEL_MIN = 280;
const PANEL_MAX = 560;

const isVariantOption = (m: Manifest, optionId: string): boolean => {
  const o = m.options.find((x) => x.id === optionId);
  return o?.type === 'choice' && (o as ChoiceOption).role === 'variant';
};

// The Studio opens straight into the 3D viewport with nothing in it — the
// first imported file brings the geometry, the product name, and the camera.
// The placeholder bounds only size the empty grid; no model is ever fetched
// (models stays [] until a file arrives).
const EMPTY_BOUNDS: PartBounds = { min: [-60, 0, -60], max: [60, 80, 60] };

function emptyProject(): Project {
  const model: OrientedModel = { parts: [], bounds: EMPTY_BOUNDS, format: 'none', unitToMm: 1 };
  const manifest = initManifest([], { name: 'New Product', bounds: EMPTY_BOUNDS });
  manifest.models = [];
  const modelUrl = URL.createObjectURL(new Blob([writeGlb([])], { type: 'model/gltf-binary' }));
  return { model, manifest, raw: new Map(), modelUrl };
}

const UNDO_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.5 9.5A 8.5 8.5 0 1 1 3.5 15" />
    <polyline points="4.5 4.5 4.5 9.5 9.5 9.5" />
  </svg>
);
const REDO_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M19.5 9.5A 8.5 8.5 0 1 0 20.5 15" />
    <polyline points="19.5 4.5 19.5 9.5 14.5 9.5" />
  </svg>
);

export function App() {
  const [project, setProject] = useState<Project>(emptyProject);
  const [tab, setTab] = useState<Tab>('Parts');
  const [selectedPart, setSelectedPart] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editingVariant, setEditingVariant] = useState<string | null>(null);
  const [hiddenParts, setHiddenParts] = useState<Set<string>>(new Set());
  const [solo, setSolo] = useState<string | null>(null);
  const [axes, setAxes] = useState<string>(AXIS_PRESETS[1].axes); // 3D-print files dominate
  const [previewing, setPreviewing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // Part id while "click a face to place text" is armed in the viewport.
  const [placingText, setPlacingText] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(380);
  const [panelOpen, setPanelOpen] = useState(true);
  // Which choice each pick-one option shows while authoring — the merchant's
  // temporary pick, never written to the manifest.
  const [variantPreview, setVariantPreview] = useState<Record<string, string>>({});

  // History as refs: pushes happen inside event handlers, and every push is
  // paired with a setProject that re-renders, so render-time reads are never
  // stale. Keeping them out of state avoids re-render loops on cap trimming.
  const projectRef = useRef<Project>(project);
  projectRef.current = project;
  const pastRef = useRef<Manifest[]>([]);
  const futureRef = useRef<Manifest[]>([]);

  const newProject = useCallback(() => {
    URL.revokeObjectURL(projectRef.current.modelUrl);
    setProject(emptyProject());
    pastRef.current = [];
    futureRef.current = [];
    setSelectedPart(null);
    setEditingGroup(null);
    setEditingVariant(null);
    setHiddenParts(new Set());
    setSolo(null);
    setVariantPreview({});
    setPreviewing(false);
    setPublishing(false);
    setPlacingText(null);
    setTab('Parts');
  }, []);

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

  // Selecting a hidden pick-one member switches the preview to it — "only one
  // can be visible and edited at once" means clicking the other one shows it.
  const selectPart = useCallback((id: string | null) => {
    setSelectedPart(id);
    if (id) { setEditingGroup(null); setEditingVariant(null); }
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
      // Pick-one sets keep their exclusivity — that's the point of them.
      // Optional add-ons are forced visible while authoring: a customer's
      // default is "not selected", and honouring that made a part vanish the
      // moment it was marked optional.
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

  // Soloing a hidden variant member would show NOTHING (its visibleWhen still
  // hides it) — so solo also selects it, which switches the preview to it.
  const soloPart = useCallback((id: string | null) => {
    setSolo(id);
    if (id) selectPart(id);
  }, [selectPart]);

  const setHidden = useCallback((ids: string[], hidden: boolean) => {
    setHiddenParts((old) => {
      const next = new Set(old);
      for (const id of ids) { if (hidden) next.add(id); else next.delete(id); }
      return next;
    });
  }, []);

  // Duplicating an entry adds PARTS, and new parts need meshes — the viewer
  // binds geometry at load, so the model URL is re-minted (same GLB bytes)
  // to remount the viewer, and raw bounds re-derive through the shared mesh.
  const duplicateEntryInApp = useCallback((entryId: string) => {
    const old = projectRef.current;
    if (!old) return;
    const manifest = duplicateEntry(old.manifest, entryId, old.raw);
    pastRef.current.push(old.manifest);
    if (pastRef.current.length > HISTORY_LIMIT) pastRef.current.shift();
    futureRef.current = [];
    URL.revokeObjectURL(old.modelUrl);
    const modelUrl = URL.createObjectURL(new Blob([writeGlb(old.model.parts)], { type: 'model/gltf-binary' }));
    const raw = boundsByPartId(manifest, boundsOf(old.model.parts));
    setProject({ ...old, manifest, raw, modelUrl });
  }, []);

  // Add a model file to the project: parts renamed clear of clashes, manifest
  // extended, one GLB rebuilt from the union. The incoming file is normalised
  // like any import — centred on the flat axes, sat on the ground. The FIRST
  // file into an empty project also brings the product name (from the
  // filename) and frames the camera, since the empty project's placeholder
  // camera was sized for nothing in particular.
  const addModelParts = useCallback(async (file: File) => {
    const old = projectRef.current;
    const firstAdd = old.manifest.parts.length === 0;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const incoming = importModel(bytes, { axes });
    const merged = mergeModel({ parts: old.model.parts, manifest: old.manifest }, incoming.parts);
    const bounds = firstAdd
      ? { min: [...incoming.bounds.min], max: [...incoming.bounds.max] }
      : {
        min: old.model.bounds.min.map((v, i) => Math.min(v, incoming.bounds.min[i])),
        max: old.model.bounds.max.map((v, i) => Math.max(v, incoming.bounds.max[i])),
      };
    const model = { ...old.model, parts: merged.parts, bounds, format: incoming.format, unitToMm: incoming.unitToMm };
    const raw = boundsByPartId(merged.manifest, boundsOf(merged.parts));
    let manifest = merged.manifest;
    if (firstAdd) {
      const name = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
      if (name) manifest = withProductName(manifest, name);
      manifest = frameCamera(manifest, raw);
    }
    pastRef.current.push(old.manifest);
    if (pastRef.current.length > HISTORY_LIMIT) pastRef.current.shift();
    futureRef.current = [];
    URL.revokeObjectURL(old.modelUrl);
    const modelUrl = URL.createObjectURL(new Blob([writeGlb(merged.parts)], { type: 'model/gltf-binary' }));
    setProject({ ...old, model, manifest, raw, modelUrl });
    if (firstAdd) setSelectedPart(manifest.parts[0]?.id ?? null);
  }, [axes]);

  // A text-placement click in the viewport lands here: the picked face's
  // sketch plane becomes a text slot via the tested edit op. setManifest
  // records the history step; nothing needs a viewer remount (no new parts).
  const placeTextInApp = useCallback((partId: string, place: { origin: [number, number, number]; normal: [number, number, number] }) => {
    const old = projectRef.current;
    try {
      setManifest(addTextSlot(old.manifest, partId, place));
      setSelectedPart(partId); // keep the slot's editor on screen
    } finally {
      setPlacingText(null);
    }
  }, [setManifest]);

  // Repeat = duplicate × N with placement maths; same viewer-remount dance.
  // Throws EditError (bad count, part at the origin for a circle) BEFORE any
  // state changes, so callers surface the message and nothing is half-done.
  const repeatEntryInApp = useCallback((entryId: string, opts: { count: number; mode: 'line' | 'circle'; axis?: Axis; gapMm?: number }) => {
    const old = projectRef.current;
    const manifest = repeatEntry(old.manifest, entryId, old.raw, opts);
    pastRef.current.push(old.manifest);
    if (pastRef.current.length > HISTORY_LIMIT) pastRef.current.shift();
    futureRef.current = [];
    URL.revokeObjectURL(old.modelUrl);
    const modelUrl = URL.createObjectURL(new Blob([writeGlb(old.model.parts)], { type: 'model/gltf-binary' }));
    const raw = boundsByPartId(manifest, boundsOf(old.model.parts));
    setProject({ ...old, manifest, raw, modelUrl });
  }, []);

  // Divider: drag resizes the explorer, a click (no meaningful movement)
  // collapses/expands it.
  const onDividerDown = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidth;
    const wasOpen = panelOpen;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 4) return;
      moved = true;
      if (!wasOpen) setPanelOpen(true);
      setPanelWidth(Math.min(PANEL_MAX, Math.max(PANEL_MIN, (wasOpen ? startWidth : 0) + dx)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) setPanelOpen((o) => !o);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [panelWidth, panelOpen]);

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

  // The set an open editor is working on — ViewerPane parks a translate
  // gizmo at its centre of mass so the whole thing moves as one.
  const editingEntity = useMemo(() => {
    if (!project) return null;
    if (editingGroup) {
      const g = project.manifest.groups?.find((x) => x.id === editingGroup);
      return g ? { kind: 'group' as const, id: g.id, parts: g.parts } : null;
    }
    if (editingVariant) {
      const parts = project.manifest.parts.filter((p) => p.visibleWhen?.option === editingVariant).map((p) => p.id);
      return parts.length ? { kind: 'variant' as const, id: editingVariant, parts } : null;
    }
    return null;
  }, [project?.manifest, editingGroup, editingVariant]);

  // The floating properties panel: slides in when something is selected,
  // slides out (keeping its last content while it goes) when nothing is.
  const floatContent = project && tab === 'Parts'
    ? (editingVariant
      ? <VariantEditor key={editingVariant} project={project} optionId={editingVariant} onChange={setManifest} onDuplicate={duplicateEntryInApp} onRepeat={repeatEntryInApp} onClose={() => setEditingVariant(null)} />
      : editingGroup
        ? <GroupEditor key={editingGroup} project={project} groupId={editingGroup} onChange={setManifest} onDuplicate={duplicateEntryInApp} onRepeat={repeatEntryInApp} onClose={() => setEditingGroup(null)} />
        : selectedPart
          ? <PartEditor key={selectedPart} project={project} partId={selectedPart} onChange={setManifest} onRepeat={repeatEntryInApp} onPlaceText={setPlacingText} />
          : null)
    : null;
  const lastFloatRef = useRef<ReactNode>(null);
  if (floatContent) lastFloatRef.current = floatContent;

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
          className="ghost icon-btn" data-testid="undo" title="Undo (Ctrl+Z)" aria-label="Undo"
          disabled={pastRef.current.length === 0} onClick={undo}
        >{UNDO_ICON}</button>
        <button
          className="ghost icon-btn" data-testid="redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo"
          disabled={futureRef.current.length === 0} onClick={redo}
        >{REDO_ICON}</button>
        <button className="ghost" data-testid="new-project" onClick={newProject}>
          New project
        </button>
        <button className="ghost preview-btn" data-testid="preview-open" onClick={() => setPreviewing(true)}>
          Preview
        </button>
        <button className="cta" data-testid="publish-cta" onClick={() => setPublishing(true)}>
          Publish
        </button>
      </header>

      <div className="workspace">
        <aside className="panel" style={{ width: panelOpen ? panelWidth : 0 }} aria-hidden={!panelOpen}>
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
              editingGroup={editingGroup}
              editingVariant={editingVariant}
              onSelectPart={selectPart}
              onEditGroup={(id) => { setEditingGroup(id); if (id) setEditingVariant(null); }}
              onEditVariant={(id) => { setEditingVariant(id); if (id) { setEditingGroup(null); setSelectedPart(null); } }}
              onAddModel={addModelParts}
              axes={axes}
              onAxesChange={setAxes}
              onSetHidden={setHidden}
              onSolo={soloPart}
              onHideAll={(hide) => { setSolo(null); setHiddenParts(hide ? new Set(project.manifest.parts.map((p) => p.id)) : new Set()); }}
              onDuplicate={duplicateEntryInApp}
              onChange={setManifest}
            />
          )}
          {tab === 'Palette' && <PalettePanel project={project} onChange={setManifest} />}
          {tab === 'Finish' && <FinishPanel project={project} onChange={setManifest} />}
        </aside>

        <div
          className="panel-divider" data-testid="panel-divider" role="separator"
          aria-label={panelOpen ? 'Drag to resize the explorer; click to collapse' : 'Click to expand the explorer'}
          onPointerDown={onDividerDown}
        >
          <span className="divider-pill" data-testid="panel-toggle">{panelOpen ? '◂' : '▸'}</span>
        </div>

        <div className="stage-wrap">
          <ViewerPane
            // Keyed by model: a rebuilt model needs a FRESH canvas. Dispose
            // force-loses the old canvas's WebGL context, and a reused DOM
            // node hands the new renderer that same dead context back.
            key={project.modelUrl}
            project={project} selections={selections} selectedPart={selectedPart}
            hiddenParts={effectiveHidden}
            editingEntity={editingEntity}
            textPick={placingText}
            onTextPick={placeTextInApp}
            onTextCancel={() => setPlacingText(null)}
            onSelectPart={(id) => { selectPart(id); if (id) setTab('Parts'); }}
            onChange={setManifest}
          />
          <div className={`props-float${floatContent ? ' is-open' : ''}`} data-testid="props-float" aria-hidden={!floatContent}>
            {floatContent ?? lastFloatRef.current}
          </div>
        </div>
      </div>
      {previewing && <PreviewOverlay project={project} onClose={() => setPreviewing(false)} />}
      {publishing && (
        <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) setPublishing(false); }}>
          <div className="publish-modal" role="dialog" aria-modal="true" aria-label="Publish">
            <div className="publish-modal-head">
              <h3>Publish</h3>
              <button className="ghost" data-testid="publish-close" onClick={() => setPublishing(false)}>Close</button>
            </div>
            <PublishPanel project={project} onChange={setManifest} />
          </div>
        </div>
      )}
    </div>
  );
}
