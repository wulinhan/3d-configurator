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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Manifest, ChoiceOption } from '../../embed/src/manifest/types.ts';
import { defaultSelections } from '../../embed/src/runtime/state.ts';
import { importModel, AXIS_PRESETS, type OrientedModel } from './lib/import-model.ts';
import type { ImportedPart } from './lib/types.ts';
import { writeGlb } from './lib/write-glb.ts';
import { chamferEdges, type EdgeOpts } from './lib/chamfer.ts';
import { featureEdges, similarChains, type EdgeChain } from './lib/edges.ts';
import {
  boundsOf, boundsByPartId, mergeModel, emptyManifest, slug, EMPTY_BOUNDS, type PartBounds,
} from './lib/manifest-init.ts';
import {
  duplicateEntry, repeatEntry, frameCamera, withProductName, addTextSlot, addImageZone, refitImageZone, setTextPath, removePart, type Axis,
} from './lib/manifest-edit.ts';
import { ViewerPane } from './ui/ViewerPane.tsx';
import { PartsPanel } from './ui/PartsPanel.tsx';
import { PartEditor, GroupEditor, VariantEditor, partSections, entrySections } from './ui/PartEditor.tsx';
import { PalettePanel } from './ui/PalettePanel.tsx';
import { FinishPanel } from './ui/FinishPanel.tsx';
import { PublishPanel } from './ui/PublishPanel.tsx';
import { CloudPublish } from './ui/CloudPublish.tsx';
import { PreviewOverlay } from './ui/PreviewOverlay.tsx';
import { SetupGuide } from './ui/SetupGuide.tsx';
import { setupSteps, nextStep, type GuideProgress, type SetupStep } from './lib/setup-guide.ts';
import { ExportDialog } from './ui/ExportDialog.tsx';
import { ConfirmDialog } from './ui/controls.tsx';
import { SignIn } from './ui/SignIn.tsx';
import { Projects } from './ui/Projects.tsx';
import { api, apiBase, go, routeOf, type Me, type Route } from './lib/api.ts';
import { Autosave, saveLabel, type SaveState } from './lib/autosave.ts';
import { reopenModel } from './lib/import-model.ts';

export interface Project {
  model: OrientedModel;
  manifest: Manifest;
  /** Untransformed part bounds by manifest part id — what mm maths run on. */
  raw: Map<string, PartBounds>;
  /** Blob URL of the (uncompressed) GLB the preview loads. */
  modelUrl: string;
}

/** How a generated part wants to be coloured on arrival: an existing
 * palette swatch by id, or the artwork's own hex (added to the palette). */
export interface PartColour {
  hex?: string;
  swatchId?: string;
  label?: string;
}

/** One edge amendment: a chamfer or round-over the merchant applied,
 * revisitable from the Edges section. Edges are remembered by centroid and
 * length so the list can replay from the original mesh. */
export interface EdgeOp {
  id: string;
  style: 'chamfer' | 'round';
  sizeMm: number;
  picks: Array<{ centroid: [number, number, number]; lengthMm: number }>;
  /** How many edges the last replay actually matched. */
  count: number;
}

export interface SetManifestOptions {
  /** Replace the current manifest without recording an undo step — used by
   * live gizmo commits so a drag lands as a single history entry. */
  transient?: boolean;
}

const TABS = ['Parts', 'Palette', 'Finish'] as const;
type Tab = typeof TABS[number];
const HISTORY_LIMIT = 100;
const PANEL_WIDTH = 400;

const isVariantOption = (m: Manifest, optionId: string): boolean => {
  const o = m.options.find((x) => x.id === optionId);
  return o?.type === 'choice' && (o as ChoiceOption).role === 'variant';
};

// The Studio opens straight into the 3D viewport with nothing in it — the
// first imported file brings the geometry, the product name, and the camera.
function emptyProject(): Project {
  const model: OrientedModel = { parts: [], bounds: EMPTY_BOUNDS, format: 'none', unitToMm: 1 };
  const modelUrl = URL.createObjectURL(new Blob([writeGlb([])], { type: 'model/gltf-binary' }));
  return { model, manifest: emptyManifest(), raw: new Map(), modelUrl };
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

/**
 * Which screen we are on.
 *
 * With no service configured there is exactly one — the editor — so the
 * standalone Studio is not a routed app pretending to be one. That also
 * means every existing browser check still opens `/` and gets the editor,
 * which is the honest test that offline mode did not become second-class.
 */
function useRoute(cloud: boolean): Route {
  const [route, setRoute] = useState<Route>(() => routeOf(location.pathname, location.hash, cloud));
  useEffect(() => {
    if (!cloud) return;
    const read = () => setRoute(routeOf(location.pathname, location.hash, cloud));
    addEventListener('popstate', read);
    return () => removeEventListener('popstate', read);
  }, [cloud]);
  return route;
}

export function App() {
  const cloud = !!apiBase();
  const route = useRoute(cloud);
  const [me, setMe] = useState<Me | null>(null);
  const [session, setSession] = useState<'unknown' | 'ready'>(cloud ? 'unknown' : 'ready');

  // One call decides the whole shape of the app: signed in or not.
  useEffect(() => {
    if (!cloud) return;
    let live = true;
    void api.me().then((who) => { if (live) { setMe(who); setSession('ready'); } })
      .catch(() => { if (live) setSession('ready'); });
    return () => { live = false; };
  }, [cloud]);

  if (cloud && session === 'unknown') return <div className="auth-page" />;
  if (cloud && route.name === 'signin') {
    return <SignIn token={route.token} onSignedIn={(who) => { setMe(who); go('/'); }} />;
  }
  if (cloud && !me) {
    return <SignIn token={null} onSignedIn={(who) => { setMe(who); go('/'); }} />;
  }
  if (cloud && route.name === 'projects' && me) {
    return <Projects me={me} onSignedOut={() => { setMe(null); go('/signin'); }} />;
  }
  return (
    <Editor
      key={route.name === 'editor' ? route.projectId ?? 'local' : 'local'}
      cloudProjectId={route.name === 'editor' ? route.projectId : null}
      signedIn={!!me}
    />
  );
}

function Editor(props: { cloudProjectId: string | null; signedIn: boolean }) {
  const { cloudProjectId } = props;
  const [project, setProject] = useState<Project>(emptyProject);
  const [tab, setTab] = useState<Tab>('Parts');
  const [selectedPart, setSelectedPart] = useState<string | null>(null);
  /** Which property section's panel is open — driven by the viewport's
   * icon rail; null keeps the stage clean. */
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editingVariant, setEditingVariant] = useState<string | null>(null);
  const [hiddenParts, setHiddenParts] = useState<Set<string>>(new Set());
  const [solo, setSolo] = useState<string | null>(null);
  const [axes, setAxes] = useState<string>(AXIS_PRESETS[1].axes); // 3D-print files dominate
  const [previewing, setPreviewing] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** The explorer's ☑-ticked part ids, mirrored up — Export's exact scope. */
  const [checkedParts, setCheckedParts] = useState<string[]>([]);
  /** Part ids the Delete key is asking about — pressing it again confirms. */
  const [deleteAsk, setDeleteAsk] = useState<string[] | null>(null);
  /** Steps the manifest can't see (previewed, published), per project. */
  const [guideProgress, setGuideProgress] = useState<GuideProgress>({});
  const [guideCollapsed, setGuideCollapsed] = useState(() => {
    try { return localStorage.getItem('studio.guide.collapsed') === '1'; } catch { return false; }
  });
  const [publishing, setPublishing] = useState(false);
  // Armed "click a face to place …" tool: what lands there and on which part.
  const [placing, setPlacing] = useState<{ kind: 'text' | 'image'; partId: string } | null>(null);
  // The text slot whose baseline curve is being shaped in the viewport.
  const [shapingText, setShapingText] = useState<string | null>(null);
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

  // ── the saved copy ──────────────────────────────────────────────────────
  //
  // Only when a project id is in the URL. Everything below is inert in the
  // standalone Studio, which is why it can stay in this file rather than
  // forking the editor in two.
  const [loading, setLoading] = useState(!!cloudProjectId);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('clean');
  const [saveNote, setSaveNote] = useState<string | null>(null);
  // A viewer share opens the project read-only: nothing is autosaved, so
  // they can play with it freely and the owner's copy never moves.
  const [readOnly, setReadOnly] = useState(false);
  const saverRef = useRef<Autosave<Manifest> | null>(null);
  /** The manifest as the service last knew it. Guards the first render from
   * writing back exactly what it just read. */
  const syncedRef = useRef<Manifest | null>(null);
  /** The parts array whose GLB the service already has. Compared by
   * IDENTITY: the model is rebuilt as a new array whenever it really
   * changes, and hashing megabytes on every keystroke would not be free. */
  const syncedPartsRef = useRef<unknown>(null);

  useEffect(() => {
    if (!cloudProjectId) return;
    let live = true;
    void (async () => {
      try {
        const detail = await api.getProject(cloudProjectId);
        const model = detail.hasModel
          ? reopenModel(await api.getModel(cloudProjectId))
          : { parts: [], bounds: EMPTY_BOUNDS, format: 'none', unitToMm: 1 };
        if (!live) return;
        // A manifest the editor cannot open is an empty project, not a
        // crash: the service stores whatever autosave sends it, and a
        // project created by anything other than this Studio may not have
        // the shape the viewer walks.
        const stored = detail.manifest as Manifest | null;
        const manifest = Array.isArray(stored?.parts) && Array.isArray(stored?.options)
          ? stored : emptyManifest(detail.name);
        const raw = boundsByPartId(manifest, boundsOf(model.parts));
        const modelUrl = URL.createObjectURL(new Blob([writeGlb(model.parts)], { type: 'model/gltf-binary' }));
        syncedRef.current = manifest;
        syncedPartsRef.current = model.parts;
        if (detail.role === 'viewer') {
          setReadOnly(true);
        } else {
          saverRef.current = new Autosave<Manifest>({
            revision: detail.revision,
            save: async (m, baseRevision) => api.saveProject(cloudProjectId, { manifest: m, baseRevision, name: m.name }),
            onState: (state, extra) => { setSaveState(state); setSaveNote(extra?.message ?? null); },
          });
        }
        setProject({ model, manifest, raw, modelUrl });
        setSelectedPart(manifest.parts[0]?.id ?? null);
        setLoading(false);
      } catch (err) {
        if (live) { setLoadError(err instanceof Error ? err.message : String(err)); setLoading(false); }
      }
    })();
    return () => { live = false; saverRef.current?.dispose(); };
  }, [cloudProjectId]);

  // Every edit is a save. The FIRST manifest after a load is not — it is
  // what we just read, and writing it back would burn a revision and make
  // every other tab's next save a conflict for no reason.
  useEffect(() => {
    const saver = saverRef.current;
    if (!saver || loading) return;
    if (syncedRef.current === project.manifest) return;
    syncedRef.current = project.manifest;
    saver.push(project.manifest);
  }, [project.manifest, loading]);

  // The geometry is saved separately, and only when it actually changes: a
  // model is megabytes and a rename is not a reason to re-send it.
  useEffect(() => {
    if (!cloudProjectId || loading || !saverRef.current) return;
    if (syncedPartsRef.current === project.model.parts) return;
    syncedPartsRef.current = project.model.parts;
    if (!project.model.parts.length) return;
    void api.putModel(cloudProjectId, writeGlb(project.model.parts)).catch(() => {
      // The manifest still saves; the merchant is told at publish, which is
      // the moment the model actually has to be there.
      setSaveNote('The 3D model could not be saved yet — it will retry on your next edit.');
      syncedPartsRef.current = null;
    });
  }, [project.model.parts, cloudProjectId, loading]);

  const flushSave = useCallback(async () => { await saverRef.current?.flush(); }, []);

  // The dashboard card's picture: a square snapshot of the whole product,
  // captured once the work is safely written. Throttled hard and allowed to
  // fail silently — a thumbnail is a courtesy, never a reason an edit hurts.
  const lastThumbAtRef = useRef(0);
  useEffect(() => {
    if (!cloudProjectId || saveState !== 'saved' || !project.model.parts.length) return;
    const since = Date.now() - lastThumbAtRef.current;
    const timer = setTimeout(() => {
      const viewer = (window as { __studioViewer?: { snapshot?: (px?: number) => string } }).__studioViewer;
      if (!viewer?.snapshot) return;
      try {
        const dataUrl = viewer.snapshot(640, 360);
        const bytes = Uint8Array.from(atob(dataUrl.split(',')[1] ?? ''), (c) => c.charCodeAt(0));
        if (!bytes.length) return;
        lastThumbAtRef.current = Date.now();
        void api.putThumb(cloudProjectId, bytes).catch(() => {});
      } catch { /* WebGL context lost, viewer mid-teardown — skip this one */ }
    }, Math.max(1500, 30_000 - since));
    return () => clearTimeout(timer);
  }, [saveState, cloudProjectId, project.model.parts]);

  // A closing tab gets one last chance to write.
  useEffect(() => {
    if (!cloudProjectId) return;
    const onLeave = () => { void saverRef.current?.flush(); };
    addEventListener('beforeunload', onLeave);
    return () => removeEventListener('beforeunload', onLeave);
  }, [cloudProjectId]);

  const newProject = useCallback(() => {
    URL.revokeObjectURL(projectRef.current.modelUrl);
    setProject(emptyProject());
    pastRef.current = [];
    futureRef.current = [];
    edgeOriginalsRef.current.clear();
    setEdgeOps(new Map());
    previewSeqRef.current++;
    setEdgeMode(null);
    setEdgePreview(null);
    setSelectedPart(null);
    setEditingGroup(null);
    setEditingVariant(null);
    setHiddenParts(new Set());
    setSolo(null);
    setVariantPreview({});
    setPreviewing(false);
    setPublishing(false);
    setPlacing(null);
    setShapingText(null);
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
    setOpenSection(null);
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

  // Edge treatments (Edges section in the part editor) are GEOMETRY edits,
  // which the manifest-only history cannot undo — so the FIRST treatment
  // stashes the untouched mesh per part and the editor offers "Restore".
  // Treatments stack (chamfer one edge, then another) exactly like Fusion;
  // Restore rewinds the lot.
  const edgeOriginalsRef = useRef<Map<string, ImportedPart>>(new Map());

  // The Fusion-style picker: which part is in edge-select mode, its detected
  // sharp-edge chains, and the chains clicked so far.
  const [edgeMode, setEdgeMode] = useState<{ partId: string; chains: EdgeChain[]; selected: string[] } | null>(null);
  /** Live, uncommitted chamfer preview shown by the viewer. */
  const [edgePreview, setEdgePreview] = useState<{ partId: string; positions: Float32Array; indices: Uint32Array } | null>(null);
  /** Guards stale async previews: only the latest request may land. */
  const previewSeqRef = useRef(0);

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  const meshOfPart = useCallback((partId: string): { meshName: string; sourceId: string; mesh: ImportedPart } | null => {
    const project = projectRef.current;
    const partDef = project.manifest.parts.find((p) => p.id === partId);
    if (!partDef) return null;
    const [sourceId, meshName] = partDef.mesh.split('#');
    const mesh = project.model.parts.find((m) => m.name === meshName);
    return mesh ? { meshName, sourceId, mesh } : null;
  }, []);

  const startEdgeMode = useCallback((partId: string) => {
    const found = meshOfPart(partId);
    if (!found) return;
    const chains = featureEdges(found.mesh.positions, found.mesh.indices);
    if (!chains.length) {
      showToast('No sharp edges found on this part — smooth shapes have nothing to chamfer.');
      return;
    }
    setEdgeMode({ partId, chains, selected: [] });
  }, [meshOfPart, showToast]);

  const endEdgeMode = useCallback(() => {
    previewSeqRef.current++;
    setEdgeMode(null);
    setEdgePreview(null);
  }, []);

  const toggleEdge = useCallback((chainId: string, gesture: 'toggle' | 'similar' = 'toggle') => {
    setEdgeMode((mode) => {
      if (!mode) return mode;
      // Double-click = grab the family: every parallel edge of the same
      // kind (all eight verticals of an octagon), or the matching rings.
      if (gesture === 'similar') {
        const family = similarChains(mode.chains, chainId);
        return { ...mode, selected: [...new Set([...mode.selected, ...family])] };
      }
      const selected = mode.selected.includes(chainId)
        ? mode.selected.filter((id) => id !== chainId)
        : [...mode.selected, chainId];
      return { ...mode, selected };
    });
  }, []);

  const clearEdgeSelection = useCallback(() => {
    previewSeqRef.current++;
    setEdgePreview(null);
    setEdgeMode((mode) => (mode ? { ...mode, selected: [] } : mode));
  }, []);

  // The live preview: recompute on every knob change, debounced by the
  // caller (PartEditor). A failure clears the preview and says why.
  const previewEdgesInApp = useCallback(async (partId: string, opts: EdgeOpts | null) => {
    const seq = ++previewSeqRef.current;
    const mode = edgeModeRef.current;
    if (!opts || !mode || mode.partId !== partId || !mode.selected.length) {
      setEdgePreview(null);
      return;
    }
    const found = meshOfPart(partId);
    if (!found) return;
    try {
      const treated = await chamferEdges(found.mesh, mode.chains, mode.selected, opts);
      if (previewSeqRef.current !== seq) return; // a newer request superseded this one
      setEdgePreview({ partId, positions: treated.positions, indices: treated.indices });
    } catch (err) {
      if (previewSeqRef.current !== seq) return;
      setEdgePreview(null);
      showToast(err instanceof Error ? err.message : String(err));
    }
  }, [meshOfPart, showToast]);

  // Commit the treatment: same as the preview, then swap the mesh into the
  // model for real. Duplicates sharing this mesh get their own copy under a
  // fresh name so only THIS part's edges change.
  /**
   * Every edge treatment on a part is an AMENDMENT the merchant can revisit
   * — listed in the Edges section like text slots, its size and style
   * editable after the fact. Editing any amendment replays the whole list
   * from the stashed original mesh, so changes never compound. An
   * amendment refinds its edges by centroid+length after earlier
   * amendments reshaped the mesh; one that no longer matches is dropped
   * with a toast instead of cutting the wrong thing.
   */
  const [edgeOps, setEdgeOps] = useState<Map<string, EdgeOp[]>>(new Map());
  const opSeq = useRef(0);

  const resolvePicks = (chains: EdgeChain[], op: EdgeOp): string[] => {
    const ids = new Set<string>();
    for (const pick of op.picks) {
      let best: { id: string; d: number } | null = null;
      for (const c of chains) {
        const d = Math.hypot(c.centroid[0] - pick.centroid[0], c.centroid[1] - pick.centroid[1], c.centroid[2] - pick.centroid[2]);
        const lengthOk = c.lengthMm > pick.lengthMm * 0.6 && c.lengthMm < pick.lengthMm * 1.66;
        if (lengthOk && (!best || d < best.d)) best = { id: c.id, d };
      }
      if (best && best.d < Math.max(3, op.sizeMm * 2.5)) ids.add(best.id);
    }
    return [...ids];
  };

  /** Commit a treated mesh into the model — shared-mesh cloning included. */
  const commitTreatedMesh = useCallback((partId: string, treated: ImportedPart) => {
    const old = projectRef.current;
    const partDef = old.manifest.parts.find((p) => p.id === partId);
    if (!partDef) return;
    const [sourceId, meshName] = partDef.mesh.split('#');
    let manifest = old.manifest;
    let name = meshName;
    const shared = old.manifest.parts.some((p) => p.id !== partId && p.mesh.split('#')[1] === meshName);
    if (shared) {
      // Duplicates share one mesh; only THIS part's edges change, so it
      // gets its own copy of the geometry under a fresh name.
      name = `${meshName}-edges`;
      for (let k = 2; old.model.parts.some((m) => m.name === name); k++) name = `${meshName}-edges-${k}`;
      manifest = structuredClone(old.manifest);
      manifest.parts.find((p) => p.id === partId)!.mesh = `${sourceId}#${name}`;
      pastRef.current.push(old.manifest);
      if (pastRef.current.length > HISTORY_LIMIT) pastRef.current.shift();
      futureRef.current = [];
    }
    const replaced = { name, positions: treated.positions, indices: treated.indices };
    const parts = shared
      ? [...old.model.parts, replaced]
      : old.model.parts.map((m) => (m.name === meshName ? replaced : m));
    const raw = boundsByPartId(manifest, boundsOf(parts));
    URL.revokeObjectURL(old.modelUrl);
    const modelUrl = URL.createObjectURL(new Blob([writeGlb(parts)], { type: 'model/gltf-binary' }));
    // The mesh just changed under the picker: drop the preview and re-detect
    // chains on the new geometry (the treated edges are new edges now).
    previewSeqRef.current++;
    setEdgePreview(null);
    setProject({ ...old, model: { ...old.model, parts }, manifest, raw, modelUrl });
    const chains = featureEdges(treated.positions, treated.indices);
    setEdgeMode((mode) => (mode?.partId === partId
      ? (chains.length ? { partId, chains, selected: [] } : null) : mode));
  }, []);

  /** Replay a part's amendment list from its original mesh and commit. */
  const rebuildEdgeOps = useCallback(async (partId: string, ops: EdgeOp[]) => {
    const found = meshOfPart(partId);
    if (!found) throw new Error('No geometry for this part.');
    const original = edgeOriginalsRef.current.get(partId) ?? found.mesh;
    let mesh = original;
    const kept: EdgeOp[] = [];
    for (const op of ops) {
      const chains = featureEdges(mesh.positions, mesh.indices);
      const ids = resolvePicks(chains, op);
      if (!ids.length) {
        showToast('One amendment no longer finds its edges after the change, so it was removed.');
        continue;
      }
      mesh = await chamferEdges(mesh, chains, ids, { style: op.style, sizeMm: op.sizeMm });
      kept.push({ ...op, count: ids.length });
    }
    if (!projectRef.current.manifest.parts.some((p) => p.id === partId)) return;
    if (!kept.length) {
      // Nothing left — the part returns to its untouched self.
      edgeOriginalsRef.current.delete(partId);
      setEdgeOps((m) => { const next = new Map(m); next.delete(partId); return next; });
      commitTreatedMesh(partId, original);
      return;
    }
    if (!edgeOriginalsRef.current.has(partId)) edgeOriginalsRef.current.set(partId, original);
    setEdgeOps((m) => new Map(m).set(partId, kept));
    commitTreatedMesh(partId, mesh);
  }, [meshOfPart, commitTreatedMesh, showToast]);

  /** Apply = append an amendment built from the current edge selection. */
  const chamferPartInApp = useCallback(async (partId: string, opts: EdgeOpts) => {
    try {
      const mode = edgeModeRef.current;
      if (!mode || mode.partId !== partId || !mode.selected.length) {
        throw new Error('Select at least one edge first.');
      }
      const picks = mode.chains
        .filter((c) => mode.selected.includes(c.id))
        .map((c) => ({ centroid: c.centroid, lengthMm: c.lengthMm }));
      const op: EdgeOp = { id: `op${++opSeq.current}`, style: opts.style, sizeMm: opts.sizeMm, picks, count: picks.length };
      await rebuildEdgeOps(partId, [...(edgeOpsRef.current.get(partId) ?? []), op]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, [rebuildEdgeOps, showToast]);

  /** Retune or drop one amendment — the list replays from the original. */
  const editEdgeOp = useCallback(async (partId: string, opId: string, patch: Partial<Pick<EdgeOp, 'style' | 'sizeMm'>> | null) => {
    const ops = edgeOpsRef.current.get(partId) ?? [];
    const next = patch === null
      ? ops.filter((o) => o.id !== opId)
      : ops.map((o) => (o.id === opId ? { ...o, ...patch } : o));
    try {
      await rebuildEdgeOps(partId, next);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  }, [rebuildEdgeOps, showToast]);

  const restoreEdgesInApp = useCallback((partId: string) => {
    const original = edgeOriginalsRef.current.get(partId);
    if (!original) return;
    edgeOriginalsRef.current.delete(partId);
    setEdgeOps((m) => { const next = new Map(m); next.delete(partId); return next; });
    commitTreatedMesh(partId, original);
  }, [commitTreatedMesh]);

  const edgeOpsRef = useRef(edgeOps);
  edgeOpsRef.current = edgeOps;

  // Handlers above read the mode through a ref so their identities stay
  // stable while selection changes re-render.
  const edgeModeRef = useRef(edgeMode);
  edgeModeRef.current = edgeMode;

  // Leaving the part (or losing it) leaves the tool.
  useEffect(() => {
    if (edgeMode && selectedPart !== edgeMode.partId) endEdgeMode();
  }, [selectedPart, edgeMode, endEdgeMode]);

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

  // Parts the Studio GENERATED — a primitive, a traced template — join the
  // project through the same merge as an uploaded file, minus importModel:
  // they are born in canonical space, and re-orienting them would be wrong.
  // A part may arrive with a COLOUR: either an existing palette swatch, or
  // the artwork's own colour (which joins the palette as a new swatch).
  const addGeneratedParts = useCallback((incoming: ImportedPart[], colours?: (PartColour | null)[]) => {
    const old = projectRef.current;
    if (!old || !incoming.length) return;
    const firstAdd = old.manifest.parts.length === 0;
    const merged = mergeModel({ parts: old.model.parts, manifest: old.manifest }, incoming);
    if (colours) {
      const palette = merged.manifest.palettes?.[0];
      const appended = merged.manifest.parts.slice(-incoming.length);
      appended.forEach((part, i) => {
        const colour = colours[i];
        if (!colour || !palette) return;
        let swatchId = colour.swatchId;
        if (!swatchId && colour.hex) {
          const hex = colour.hex.toUpperCase();
          let swatch = palette.swatches.find((s) => s.hex.toUpperCase() === hex && !s.hex2);
          if (!swatch) {
            let id = slug(colour.label ?? `art-${hex.slice(1)}`);
            for (let k = 2; palette.swatches.some((s) => s.id === id); k++) id = `${slug(colour.label ?? `art-${hex.slice(1)}`)}-${k}`;
            swatch = { id, name: colour.label ?? hex, hex };
            palette.swatches.push(swatch);
          }
          swatchId = swatch.id;
        }
        const option = merged.manifest.options.find((o) => o.type === 'colour' && o.parts.includes(part.id));
        if (option && swatchId) option.default = swatchId;
      });
    }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const part of incoming) {
      for (let i = 0; i < part.positions.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          const v = part.positions[i + a];
          if (v < min[a]) min[a] = v;
          if (v > max[a]) max[a] = v;
        }
      }
    }
    const bounds = firstAdd ? { min, max } : {
      min: old.model.bounds.min.map((v, i) => Math.min(v, min[i])),
      max: old.model.bounds.max.map((v, i) => Math.max(v, max[i])),
    };
    const model = { ...old.model, parts: merged.parts, bounds };
    const raw = boundsByPartId(merged.manifest, boundsOf(merged.parts));
    let manifest = merged.manifest;
    if (firstAdd) manifest = frameCamera(manifest, raw);
    pastRef.current.push(old.manifest);
    if (pastRef.current.length > HISTORY_LIMIT) pastRef.current.shift();
    futureRef.current = [];
    URL.revokeObjectURL(old.modelUrl);
    const modelUrl = URL.createObjectURL(new Blob([writeGlb(merged.parts)], { type: 'model/gltf-binary' }));
    setProject({ ...old, model, manifest, raw, modelUrl });
    setSelectedPart(manifest.parts[manifest.parts.length - incoming.length]?.id ?? null);
  }, []);

  // Delete / Backspace: the ☑-ticked parts if any, else the selected part —
  // the first press opens the confirm dialog, the same key pressed again
  // confirms it (the dialog handles that itself). Ctrl+A ticks every part,
  // so select-all → Delete clears a whole project in three keystrokes.
  // Typing fields, open dialogs and the customer preview are left alone.
  const confirmDeleteAsk = useCallback((ids: string[]) => {
    const old = projectRef.current;
    setDeleteAsk(null);
    if (!old) return;
    try {
      setManifest(ids.reduce((m, id) => removePart(m, id, old.raw), old.manifest));
      setSelectedPart(null);
      setCheckedParts((c) => c.filter((id) => !ids.includes(id)));
    } catch { /* removal refused by the edit layer — nothing changes */ }
  }, [setManifest]);

  /** Ctrl/Cmd+C's stash: the part (or assembly) a later Ctrl/Cmd+V copies. */
  const copyRef = useRef<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (previewing || document.querySelector('.dialog-backdrop')) return;
      if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
        const all = projectRef.current?.manifest.parts.map((p) => p.id) ?? [];
        if (all.length) { e.preventDefault(); setCheckedParts(all); }
        return;
      }
      if ((e.key === 'c' || e.key === 'C') && (e.ctrlKey || e.metaKey)) {
        // real text selections keep their native copy
        if (window.getSelection()?.toString()) return;
        const id = selectedPart ?? editingGroup;
        if (id) copyRef.current = id;
        return;
      }
      if ((e.key === 'v' || e.key === 'V') && (e.ctrlKey || e.metaKey)) {
        const id = copyRef.current;
        const m = projectRef.current?.manifest;
        const alive = !!id && !!m
          && (m.parts.some((p) => p.id === id) || (m.groups ?? []).some((g) => g.id === id));
        if (alive) { e.preventDefault(); duplicateEntryInApp(id!); }
        return;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const ids = checkedParts.length ? checkedParts : selectedPart ? [selectedPart] : [];
      if (ids.length) { e.preventDefault(); setDeleteAsk(ids); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [checkedParts, selectedPart, editingGroup, previewing, duplicateEntryInApp]);

  // Ticks must never outlive their parts (deletes, new project, undo).
  useEffect(() => {
    if (!project) return;
    const alive = new Set(project.manifest.parts.map((p) => p.id));
    setCheckedParts((c) => (c.every((id) => alive.has(id)) ? c : c.filter((id) => alive.has(id))));
  }, [project?.manifest]);

  // A placement click in the viewport lands here: the picked face's sketch
  // plane becomes a text slot or image zone via the tested edit op.
  // setManifest records the history step; nothing needs a viewer remount.
  const placeSurfaceInApp = useCallback((partId: string, place: {
    origin: [number, number, number];
    normal: [number, number, number];
    zone?: { centre: [number, number, number]; angleDeg: number; widthMm: number; heightMm: number };
    curved?: boolean;
  }) => {
    const old = projectRef.current;
    const kind = placing?.kind ?? 'text';
    try {
      // An image zone CONFORMS to the picked face: centred on it, aligned
      // with its edges, opened to its true extents. The renderer re-welds
      // the face and shows the image on its exact triangles, so the rim
      // needs no description here.
      setManifest(kind === 'image'
        ? addImageZone(old.manifest, partId, {
          origin: place.zone?.centre ?? place.origin,
          normal: place.normal,
          widthMm: place.zone?.widthMm,
          heightMm: place.zone?.heightMm,
          rotationDeg: place.zone?.angleDeg,
        })
        // A slot placed on a curve wraps from the start — merchants should
        // not have to know whether their face is flat before it looks right.
        : addTextSlot(old.manifest, partId, place));
      setSelectedPart(partId); // keep the slot's editor on screen
    } finally {
      setPlacing(null);
    }
  }, [setManifest, placing]);

  // Arm (or disarm, with null) baseline-curve shaping for a text slot. A
  // slot with no drawn curve yet is seeded with a straight three-anchor
  // baseline roughly the run's length, so there is something to grab the
  // moment the dots appear — that seed is the undo step.
  const shapeTextInApp = useCallback((optionId: string | null) => {
    if (!optionId) { setShapingText(null); return; }
    const old = projectRef.current;
    const slot = old.manifest.options.find((o) => o.id === optionId);
    if (slot && slot.type === 'text' && !slot.path?.length) {
      const run = Math.max(24, (slot.placeholder ?? 'Text').length * slot.sizeMm * 0.62);
      setManifest(setTextPath(old.manifest, optionId, [[-run / 2, 0], [0, 0], [run / 2, 0]]));
    }
    setShapingText(optionId);
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

  // The explorer is FIXED-width — wide enough for every header icon —
  // and the divider pill only collapses/expands it. Drag-to-resize kept
  // eating clicks and cutting off the show/hide buttons at narrow widths.

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
      // the browser test drives the edge picker through these — clicking
      // 1-px overlay lines with a synthetic pointer is not a fair test
      edgeMode: () => edgeModeRef.current,
      toggleEdge,
    } : null;
  }, [project, setManifest, undo, redo, toggleEdge]);

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
    // A part with a LIVE RUN (repeat pattern or per-letter spawning) is a row
    // on screen, not one piece: it rides the same proxy path an assembly does,
    // so its gizmo parks at the ROW's centre of mass and drags move the whole
    // row rigidly instead of anchoring everything to the first instance.
    if (selectedPart) {
      const part = project.manifest.parts.find((p) => p.id === selectedPart);
      const hasRun = !!part?.repeats?.length
        || project.manifest.options.some((o) => o.type === 'text' && !!o.perChar && o.part === selectedPart);
      if (hasRun) return { kind: 'part' as const, id: selectedPart, parts: [selectedPart] };
    }
    return null;
  }, [project?.manifest, editingGroup, editingVariant, selectedPart]);

  // What Export would export: exactly the ☑-TICKED parts in the explorer.
  // Nothing ticked, nothing to export; the topbar button greys out.
  // The setup journey — detected from the manifest, in the customer's
  // order; the two flags it can't detect are remembered per project.
  const guideKey = `studio.guide.${cloudProjectId ?? project?.manifest.id ?? 'local'}`;
  useEffect(() => {
    try { setGuideProgress(JSON.parse(localStorage.getItem(guideKey) ?? '{}')); }
    catch { setGuideProgress({}); }
  }, [guideKey]);
  const markGuide = useCallback((flag: keyof GuideProgress) => {
    setGuideProgress((old) => {
      if (old[flag]) return old;
      const next = { ...old, [flag]: true };
      try { localStorage.setItem(guideKey, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, [guideKey]);
  const guide = useMemo(
    () => (project ? setupSteps(project.manifest, guideProgress) : []),
    [project?.manifest, guideProgress],
  );
  const guideNext = nextStep(guide);
  const toggleGuide = useCallback(() => {
    setGuideCollapsed((c) => {
      try { localStorage.setItem('studio.guide.collapsed', c ? '0' : '1'); } catch { /* private mode */ }
      return !c;
    });
  }, []);
  const goToStep = useCallback((step: SetupStep) => {
    if (step.id === 'preview') { setPreviewing(true); markGuide('previewed'); return; }
    if (step.id === 'publish') { setPublishing(true); return; }
    if (step.tab) setTab(step.tab);
  }, [markGuide]);

  // The floating properties panel: slides in when something is selected,
  // slides out (keeping its last content while it goes) when nothing is.
  // The rail's sections for whatever is selected — and the single open
  // panel it drives. No open section, no floating panel: the stage stays
  // clean until an icon asks for its controls.
  const railSections = useMemo(() => {
    if (!project || tab !== 'Parts') return [];
    if (editingVariant || editingGroup) return entrySections();
    if (selectedPart) return partSections(project, selectedPart);
    return [];
  }, [project, tab, editingVariant, editingGroup, selectedPart]);

  const floatContent = project && tab === 'Parts' && openSection
    ? (editingVariant
      ? <VariantEditor key={editingVariant} project={project} optionId={editingVariant} onChange={setManifest} onRepeat={repeatEntryInApp} onShapeText={shapeTextInApp} shapingText={shapingText} only={openSection} />
      : editingGroup
        ? <GroupEditor key={editingGroup} project={project} groupId={editingGroup} onChange={setManifest} onRepeat={repeatEntryInApp} onShapeText={shapeTextInApp} shapingText={shapingText} only={openSection} />
        : selectedPart
          ? <PartEditor
              key={selectedPart} project={project} partId={selectedPart} onChange={setManifest} onRepeat={repeatEntryInApp}
              only={openSection}
              onPlaceText={(id) => setPlacing({ kind: 'text', partId: id })}
              onPlaceImage={(id) => setPlacing({ kind: 'image', partId: id })}
              onShapeText={shapeTextInApp}
              shapingText={shapingText}
              onChamfer={chamferPartInApp}
              onRestoreEdges={restoreEdgesInApp}
              edgeOps={edgeOps.get(selectedPart) ?? []}
              onEditEdgeOp={editEdgeOp}
              edgeMode={edgeMode?.partId === selectedPart ? edgeMode : null}
              onEdgeModeStart={startEdgeMode}
              onEdgeModeEnd={endEdgeMode}
              onEdgeClear={clearEdgeSelection}
              onPreviewEdges={previewEdgesInApp}
            />
          : null)
    : null;
  const lastFloatRef = useRef<ReactNode>(null);
  if (floatContent) lastFloatRef.current = floatContent;

  if (loading) {
    return <div className="auth-page"><p className="dash-note">Opening…</p></div>;
  }
  if (loadError) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>That product would not open</h1>
          <p className="auth-sub" data-testid="open-error">{loadError}</p>
          <button className="cta auth-wide" onClick={() => go('/')}>Back to products</button>
        </div>
      </div>
    );
  }

  return (
    <div className="studio">
      <header className="topbar">
        {cloudProjectId
          ? (
            <button className="brand brand-back" data-testid="back-to-products" onClick={() => go('/')}>
              <span className="back-chip" aria-hidden="true">‹</span> Studio
            </button>
          )
          : <span className="brand">Studio</span>}
        <input
          className="product-name" value={project.manifest.name} aria-label="Product name"
          onChange={(e) => {
            // Renames go through the edit op on blur; live typing just previews.
            const draft = structuredClone(project.manifest);
            draft.name = e.target.value;
            setManifest(draft);
          }}
        />
        {/* Nothing to say = nothing shown: before the first edit the state is
          * 'clean' and an empty pill would just look broken. */}
        {cloudProjectId && (readOnly || saveState !== 'clean') && (
          <span
            className={`save-state is-${readOnly ? 'clean' : saveState}`} data-testid="save-state"
            role="status" title={readOnly ? 'Shared with you to view — changes stay in this tab' : saveNote ?? undefined}
          >{readOnly ? 'View only' : saveLabel(saveState)}</span>
        )}
        <span className="spacer" />
        {saveState === 'conflict' && (
          <button className="ghost danger" data-testid="save-reload" onClick={() => location.reload()}>
            Reload
          </button>
        )}
        <button
          className="ghost icon-btn" data-testid="undo" title="Undo (Ctrl+Z)" aria-label="Undo"
          disabled={pastRef.current.length === 0} onClick={undo}
        >{UNDO_ICON}</button>
        <button
          className="ghost icon-btn" data-testid="redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo"
          disabled={futureRef.current.length === 0} onClick={redo}
        >{REDO_ICON}</button>
        {!cloudProjectId && (
          <button className="ghost" data-testid="new-project" onClick={newProject}>
            New project
          </button>
        )}
        {guideNext && (
          <button
            className="ghost next-cta" data-testid="next-step" title={guideNext.hint}
            onClick={() => goToStep(guideNext)}
          >
            Next: {guideNext.label}
          </button>
        )}
        <button
          className="ghost preview-btn" data-testid="export-open"
          title="Choose parts and a format, get the file"
          onClick={() => setExporting(true)}
        >
          Export
        </button>
        <button className="cta" data-testid="publish-cta" onClick={() => setPublishing(true)}>
          Publish
        </button>
      </header>

      <div className="workspace">
        <aside className="panel" style={{ width: panelOpen ? PANEL_WIDTH : 0 }} aria-hidden={!panelOpen}>
          <nav className="tabs" role="tablist">
            {TABS.map((t, i) => {
              // tabs wear the journey's numbers; a tick once their step is met
              const stepId = t === 'Parts' ? 'parts' : t === 'Palette' ? 'colours' : null;
              const done = !!stepId && guide.some((s) => s.id === stepId && s.done);
              return (
                <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)}>
                  <span className={`tab-num${done ? ' is-done' : ''}`} aria-hidden="true">{done ? '✓' : i + 1}</span>
                  {t}
                </button>
              );
            })}
          </nav>
          {tab === 'Parts' && (
            <PartsPanel
              project={project} selectedPart={selectedPart}
              hiddenParts={hiddenParts} solo={solo}
              selections={selections}
              editingGroup={editingGroup}
              editingVariant={editingVariant}
              onSelectPart={selectPart}
              onEditGroup={(id) => { setEditingGroup(id); setOpenSection(null); if (id) setEditingVariant(null); }}
              onEditVariant={(id) => { setEditingVariant(id); setOpenSection(null); if (id) { setEditingGroup(null); setSelectedPart(null); } }}
              onAddModel={addModelParts}
              onAddParts={addGeneratedParts}
              axes={axes}
              onAxesChange={setAxes}
              onSetHidden={setHidden}
              checked={checkedParts}
              onCheckedChange={setCheckedParts}
              onSolo={soloPart}
              onHideAll={(hide) => { setSolo(null); setHiddenParts(hide ? new Set(project.manifest.parts.map((p) => p.id)) : new Set()); }}
              onDuplicate={duplicateEntryInApp}
              onChange={setManifest}
            />
          )}
          {tab === 'Palette' && <PalettePanel project={project} onChange={setManifest} />}
          {tab === 'Finish' && <FinishPanel project={project} onChange={setManifest} />}
          {guide.length > 0 && (
            <SetupGuide steps={guide} collapsed={guideCollapsed} onToggle={toggleGuide} onGo={goToStep} />
          )}
        </aside>

        <div
          className="panel-divider" data-testid="panel-divider" role="separator"
          aria-label={panelOpen ? 'Collapse the explorer' : 'Expand the explorer'}
          onClick={() => setPanelOpen((o) => !o)}
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
            surfacePick={placing}
            onSurfacePick={placeSurfaceInApp}
            onSurfaceCancel={() => setPlacing(null)}
            shapeText={shapingText}
            onShapeTextDone={() => setShapingText(null)}
            onSelectPart={(id) => { selectPart(id); if (id) setTab('Parts'); }}
            onChange={setManifest}
            edgeMode={edgeMode && tab === 'Parts' ? {
              partId: edgeMode.partId,
              chains: edgeMode.chains.map((c) => ({ id: c.id, points: c.displayPoints })),
              selected: edgeMode.selected,
            } : null}
            onEdgeToggle={toggleEdge}
            previewGeometry={edgePreview}
            railSections={railSections}
            railActive={openSection}
            onRailPick={setOpenSection}
          />
          {toast && <div className="toast" role="status" data-testid="studio-toast">{toast}</div>}
          <div className={`props-float${floatContent ? ' is-open' : ''}`} data-testid="props-float" aria-hidden={!floatContent}>
            {floatContent ?? lastFloatRef.current}
          </div>
        </div>
      </div>
      {previewing && <PreviewOverlay project={project} cloudProjectId={cloudProjectId} onClose={() => setPreviewing(false)} />}
      {exporting && (
        <ExportDialog manifest={project.manifest} initialChecked={checkedParts} onClose={() => setExporting(false)} />
      )}
      {deleteAsk && (() => {
        const parts = project.manifest.parts.filter((p) => deleteAsk.includes(p.id));
        if (!parts.length) return null;
        return (
          <ConfirmDialog
            testId="confirm-delete-key"
            title={parts.length === 1 ? `Delete ${parts[0].label}?` : `Delete ${parts.length} parts?`}
            body={<p>Press Delete again to confirm. Colour options and pricing tied to {parts.length === 1 ? 'this part' : 'these parts'} are removed; Ctrl+Z brings everything back.</p>}
            confirmLabel={parts.length === 1 ? 'Delete part' : `Delete ${parts.length} parts`}
            confirmKeys={['Delete', 'Backspace']}
            onCancel={() => setDeleteAsk(null)}
            onConfirm={() => confirmDeleteAsk(deleteAsk)}
          />
        );
      })()}
      {publishing && (
        <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) setPublishing(false); }}>
          <div className="publish-modal" role="dialog" aria-modal="true" aria-label="Publish">
            <div className="publish-modal-head">
              <h3>Publish</h3>
              <button
                className="ghost" data-testid="preview-open"
                onClick={() => { setPublishing(false); setPreviewing(true); markGuide('previewed'); }}
              >Preview</button>
              <button className="ghost" data-testid="publish-close" onClick={() => setPublishing(false)}>Close</button>
            </div>
            {cloudProjectId
              ? (
                <CloudPublish
                  project={project} projectId={cloudProjectId} flush={flushSave}
                  onChange={setManifest} embedBase={apiBase()}
                  onPublished={() => markGuide('published')}
                />
              )
              : <PublishPanel project={project} onChange={setManifest} onPublished={() => markGuide('published')} />}
          </div>
        </div>
      )}
    </div>
  );
}
