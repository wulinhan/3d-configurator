// The preview IS the embed: same Viewer class, same GLB bytes a customer's
// browser would load. Edits arrive as new manifests and are applied with
// setManifest (transform-only relayout) — the WebGL context is created once
// per model, because browsers cap live contexts and rebuild-per-keystroke
// exhausts them in about a minute.
//
// On top ride the authoring tools: the combined gizmo (throttled live commits
// during a drag, final commit on release), the view cube, the face-snap tool,
// and camera focus easing — select a part and the orbit centre glides to it,
// deselect and it returns to the model over the origin.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Manifest } from '../../../embed/src/manifest/types.ts';
import type { Selections } from '../../../embed/src/runtime/state.ts';
import { Viewer, type SurfaceHit } from '../../../embed/src/runtime/viewer.ts';
import type { TextOption } from '../../../embed/src/manifest/types.ts';
import { openCurveSegments, curvePoint, type Pt } from '../../../embed/src/runtime/text-path.ts';
import { applyGizmoPose, setCameraView, setTextPath, snapFaces, nudgeEntry, rotateEntry, scaleEntryBy, type GizmoPose } from '../lib/manifest-edit.ts';
import { Gizmo, type GizmoMode, type CommitPhase } from './gizmo.ts';
import { ViewCube } from './view-cube.ts';
import type { Project, SetManifestOptions } from '../App.tsx';

// Orbit is not a tool — it is what the viewport does when no tool is armed.
// The bar only carries the tools themselves; deselecting (clicking empty
// space) drops back to orbiting automatically.

export function ViewerPane(props: {
  project: Project;
  selections: Selections;
  selectedPart: string | null;
  hiddenParts: Set<string>;
  /** An open assembly / variant set editor: its parts move as one via a
   * translate gizmo parked at the set's centre of mass. */
  editingEntity: { kind: 'group' | 'variant' | 'part'; id: string; parts: string[] } | null;
  /** Non-null arms surface placement: the next click on a face of THIS part
   * becomes a text slot's or image zone's sketch plane. */
  surfacePick: { kind: 'text' | 'image'; partId: string } | null;
  onSurfacePick: (partId: string, place: {
    origin: [number, number, number];
    normal: [number, number, number];
    /** Face-hugging rectangle, when the pick could measure one — an image
     * zone conforms to it (centre, edge alignment, extents). */
    zone?: { centre: [number, number, number]; angleDeg: number; widthMm: number; heightMm: number };
    /** The pick landed on a curve (a barrel, a dome), not a flat face — a
     * text slot placed here wraps by default. */
    curved?: boolean;
  }) => void;
  onSurfaceCancel: () => void;
  /** Non-null puts the viewport in baseline-shaping mode for that text
   * slot: draggable anchor dots pinned to its sketch plane. */
  shapeText: string | null;
  onShapeTextDone: () => void;
  onSelectPart: (id: string | null) => void;
  onChange: (m: Manifest, opts?: SetManifestOptions) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cubeRef = useRef<HTMLCanvasElement>(null);
  const [viewSaved, setViewSaved] = useState(false);
  const viewerRef = useRef<Viewer | null>(null);
  const gizmoRef = useRef<Gizmo | null>(null);
  const axesRef = useRef<THREE.AxesHelper | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const [mode, setMode] = useState<GizmoMode>('off');
  // No parts, no tools: with nothing to transform or snap, the bar is inert.
  const hasParts = props.project.manifest.parts.length > 0;
  const gridRef = useRef<THREE.GridHelper | null>(null);
  // Face-snap: null = off; 'first' = waiting for the surface that moves;
  // a SurfaceHit = that surface is chosen (and stays highlighted) while the
  // merchant picks the one it should meet.
  const [snapArm, setSnapArm] = useState<null | 'first' | SurfaceHit>(null);
  const [snapError, setSnapError] = useState<string | null>(null);
  // Span of the model when last framed — the baseline the refit compares to.
  // Set when load() resolves: initialising it lazily in the edit effect
  // swallowed the first big resize, because the viewer loads asynchronously
  // and the first edit was already the enlarged model.
  const spanRef = useRef(0);
  const onSelectRef = useRef(props.onSelectPart);
  onSelectRef.current = props.onSelectPart;
  const snapRef = useRef(snapArm);
  snapRef.current = snapArm;
  const surfacePickRef = useRef(props.surfacePick);
  surfacePickRef.current = props.surfacePick;

  // The ground grid tracks the model's reach across the ground plane —
  // measured from the origin, since that is where the grid is centred. A
  // repeat row marching off along X grows the desk under it; the grid
  // shrinks back at rest but never below the hand-scale opening size.
  const fitGrid = (b: { min: number[]; max: number[] }) => {
    const grid = gridRef.current;
    const axes = axesRef.current;
    if (!grid || !axes) return;
    const reach = Number.isFinite(b.min[0])
      ? Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]), Math.abs(b.min[2]), Math.abs(b.max[2]), 60)
      : 60;
    const size = reach * 2 * 1.6;
    // Mid-drag the grid only grows — shrinking under a live gesture flickers.
    if (gizmoRef.current?.dragging && size <= grid.scale.x) return;
    grid.scale.setScalar(size);
    axes.scale.setScalar(size * 0.22);
    // Grid slightly below ground, axes slightly above: exactly coplanar
    // lines fight in the depth buffer and shimmer as the camera moves.
    grid.position.y = -size * 0.0025;
    axes.position.y = size * 0.0025;
  };

  // A drag commits against whatever the manifest is at release time, not at
  // gizmo construction — refs keep the callback current without rebuilding.
  const commitCtx = useRef({ project: props.project, selectedPart: props.selectedPart, editingEntity: props.editingEntity, onChange: props.onChange });
  commitCtx.current = { project: props.project, selectedPart: props.selectedPart, editingEntity: props.editingEntity, onChange: props.onChange };
  const proxyRef = useRef<THREE.Object3D | null>(null);
  const proxyBaseRef = useRef<{
    position: [number, number, number];
    rotationDeg: [number, number, number];
    scale: [number, number, number];
  } | null>(null);

  // One viewer + gizmo per loaded model (keyed by the blob URL).
  useEffect(() => {
    const canvas = canvasRef.current!;
    const stage = stageRef.current!;
    const viewer = new Viewer({
      canvas,
      // Authoring wants the full orbit sphere — a merchant checking the
      // underside shouldn't fight the storefront's polar clamp. Only the
      // construction-time camera reads this; the real manifest is untouched.
      manifest: {
        ...props.project.manifest,
        camera: { ...props.project.manifest.camera, maxPolarAngle: 180 },
      },
      resolveUrl: () => props.project.modelUrl,
      onSelectPart: (id) => {
        // Neither a snap pick, a surface placement, nor a click that landed
        // on a gizmo handle is a selection gesture.
        if (snapRef.current !== null || surfacePickRef.current) return;
        if (gizmoRef.current?.hovering) return;
        onSelectRef.current(id);
      },
    });
    viewer.setPanEnabled(true); // right-drag / two-finger pan while authoring
    viewerRef.current = viewer;
    (window as any).__studioViewer = viewer; // test hook
    let disposed = false;

    // A whole drag is ONE undo step: the first commit of a gesture records
    // history, every later live commit (and the release) replaces in place.
    let midDrag = false;
    const gizmo = new Gizmo(viewer, canvas, (pose: GizmoPose, phase: CommitPhase) => {
      const { project, selectedPart, editingEntity, onChange } = commitCtx.current;
      const transient = midDrag;
      midDrag = phase !== 'end';
      try {
        if (editingEntity) {
          // The proxy started at identity, so its pose reads as deltas from
          // the last commit: travel becomes a whole-set nudge, turn becomes
          // a rigid rotateEntry about the proxy (the centre of mass the
          // handles sit on), a scale handle becomes a uniform scaleEntryBy.
          const base = proxyBaseRef.current;
          if (!base) return;
          const move: [number, number, number] = [
            pose.position[0] - base.position[0],
            pose.position[1] - base.position[1],
            pose.position[2] - base.position[2],
          ];
          const turn: [number, number, number] = [
            pose.rotationDeg[0] - base.rotationDeg[0],
            pose.rotationDeg[1] - base.rotationDeg[1],
            pose.rotationDeg[2] - base.rotationDeg[2],
          ];
          // The handle that moved furthest from its base sets the ratio —
          // an assembly always scales uniformly (see scaleEntryBy).
          const factor = pose.scale
            .map((v, a) => v / (base.scale[a] || 1))
            .reduce((best, r) => (r > 0 && Math.abs(Math.log(r)) > Math.abs(Math.log(best)) ? r : best), 1);
          const pivot = base.position;
          proxyBaseRef.current = {
            position: [...pose.position], rotationDeg: [...pose.rotationDeg], scale: [...pose.scale],
          };

          let m = project.manifest;
          if (turn.some((d) => Math.abs(d) > 1e-6)) m = rotateEntry(m, editingEntity.id, turn, project.raw, pivot);
          if (Math.abs(factor - 1) > 1e-6) m = scaleEntryBy(m, editingEntity.id, factor, project.raw, pivot);
          if (move.some((d) => Math.abs(d) > 1e-9)) m = nudgeEntry(m, editingEntity.id, move);
          if (m !== project.manifest) onChange(m, { transient });
          return;
        }
        if (!selectedPart) return;
        onChange(applyGizmoPose(project.manifest, selectedPart, project.raw, pose), { transient });
      } catch {
        // A pose the edit layer refuses (degenerate scale, detached part):
        // snap the mesh back to the authored state rather than leaving the
        // preview lying about what the manifest says.
        viewer.setManifest(project.manifest);
      }
    });
    gizmoRef.current = gizmo;

    const proxy = new THREE.Object3D();
    viewer.scene.add(proxy);
    proxyRef.current = proxy;

    const viewCube = new ViewCube(viewer, cubeRef.current!);
    (window as any).__studioViewCube = viewCube; // test hook

    const fit = () => viewer.resize(stage.clientWidth, stage.clientHeight);
    const observer = new ResizeObserver(fit);
    observer.observe(stage);

    // Origin + ground plane: the fixed 0,0,0 the whole layout is authored
    // against. Studio-only — never part of the published scene.
    const grid = new THREE.GridHelper(2, 20, 0xc9c5bd, 0xe7e4de);
    const axes = new THREE.AxesHelper(1);
    // Studio speaks Z-up: vertical (internal y) wears Z's blue, depth
    // (internal z) wears Y's green. Axes depth-test like everything else —
    // drawing them through the model made the parts read as transparent.
    axes.setColors(new THREE.Color(0xd44a3a), new THREE.Color(0x3a6fd4), new THREE.Color(0x4a9a44));
    viewer.scene.add(grid, axes);
    axesRef.current = axes;
    gridRef.current = grid;
    (window as any).__studioAxes = axes; // test hook
    (window as any).__studioGrid = grid; // test hook

    viewer.load().then(() => {
      if (disposed) return;
      viewer.apply(props.selections);
      fit();
      viewer.start();
      const b = viewer.layoutBounds();
      // An empty project has no geometry to measure — size the grid for a
      // hand-scale work area (~120mm) so the viewport opens looking like a
      // desk, not a void. The first added file replaces the whole pane.
      const span = Number.isFinite(b.min[0])
        ? Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])
        : 120;
      spanRef.current = span;
      fitGrid(b);
      (window as any).__studioViewerReady = true;
    });

    return () => {
      disposed = true;
      (window as any).__studioViewerReady = false;
      observer.disconnect();
      viewCube.dispose();
      (window as any).__studioViewCube = null;
      gizmo.dispose();
      gizmoRef.current = null;
      axesRef.current = null;
      proxy.removeFromParent();
      proxyRef.current = null;
      gridRef.current = null;
      grid.geometry.dispose();
      viewer.dispose();
      viewerRef.current = null;
      spanRef.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.project.modelUrl]);

  // Edits: relayout + repaint, no reload — and refit the camera when the
  // model has outgrown (or shrunk out of) the current view. The 25% band
  // keeps ordinary nudges from stealing the merchant's framing; a live gizmo
  // drag never refits mid-gesture.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.setManifest(props.project.manifest);
    viewer.apply(props.selections);
    const b = viewer.layoutBounds();
    fitGrid(b);
    if (Number.isFinite(b.min[0]) && spanRef.current > 0 && !gizmoRef.current?.dragging) {
      const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      if (span > spanRef.current * 1.25 || span < spanRef.current * 0.6) {
        viewer.frame();
        spanRef.current = span;
      }
    }
  }, [props.project.manifest, props.selections]);

  useEffect(() => {
    viewerRef.current?.setHiddenParts(props.hiddenParts);
  }, [props.hiddenParts, props.project.manifest]);

  // Selection: highlight + gizmo + ease the orbit centre onto the part
  // (or back over the origin on deselect).
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.highlight(props.selectedPart);
    // the rest of the model steps back: everything unselected goes ghost,
    // the selected part wears a thin white rim
    viewer.setSelectionEmphasis(props.selectedPart);
    gizmoRef.current?.attach(props.selectedPart);
    const bounds = viewer.layoutBounds();
    if (!Number.isFinite(bounds.min[0])) return;
    if (props.selectedPart) {
      // frame the whole family — repeats and per-letter pieces included —
      // centred on its middle, zoomed out far enough to hold all of it
      const box = viewer.partFamilyBox(props.selectedPart);
      if (box) {
        const centre = [0, 1, 2].map((a) => (box.min[a] + box.max[a]) / 2) as [number, number, number];
        const span = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
        viewer.focusOn(centre, { distance: Math.max(span * 2.8, spanRef.current * 0.7) });
      }
    } else {
      // Back to the model as a whole, orbiting over the origin axis.
      const centreY = (bounds.min[1] + bounds.max[1]) / 2;
      viewer.focusOn([0, centreY, 0], { distance: spanRef.current * 2.1 });
    }
  }, [props.selectedPart, props.project.modelUrl]);

  useEffect(() => {
    gizmoRef.current?.setMode(mode);
    gizmoRef.current?.attach(props.selectedPart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Opening an assembly / variant set editor eases the camera onto it — the
  // same treatment a selected part gets, but centred on the set's centre of
  // mass so orbiting pivots where the material is. Keyed on the entity's id,
  // not the object: each edit rebuilds the object and mid-edit refocusing
  // would fight the merchant's own orbiting.
  useEffect(() => {
    const viewer = viewerRef.current;
    const entity = props.editingEntity;
    if (!viewer || !entity) return;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const partId of entity.parts) {
      const box = viewer.partBox(partId);
      if (!box) continue;
      for (const a of [0, 1, 2]) {
        min[a] = Math.min(min[a], box.min[a]);
        max[a] = Math.max(max[a], box.max[a]);
      }
    }
    if (!Number.isFinite(min[0])) return;
    const com = viewer.centreOfMassOf(entity.parts);
    const centre = com
      ? [com.x, com.y, com.z] as [number, number, number]
      : [0, 1, 2].map((a) => (min[a] + max[a]) / 2) as [number, number, number];
    const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    viewer.focusOn(centre, { distance: Math.max(span * 2.4, spanRef.current * 0.7) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.editingEntity?.id]);

  // Clicking away from a part IS the switch back to orbiting: with nothing
  // selected and no set editor open, Transform has no target, so it disarms
  // itself instead of lying in wait for the next selection.
  useEffect(() => {
    if (!props.selectedPart && !props.editingEntity) setMode('off');
  }, [props.selectedPart, props.editingEntity]);

  // The origin axes and the gizmo's coloured axes say the same thing in the
  // same colours — both visible at once reads as flicker. While the gizmo is
  // attached, it IS the axes; the origin ones step aside.
  useEffect(() => {
    const axes = axesRef.current;
    if (axes) axes.visible = !((props.selectedPart || props.editingEntity) && mode === 'transform');
  }, [props.selectedPart, props.editingEntity, mode, props.project.modelUrl]);

  // An open assembly / variant set editor + Transform mode = the FULL gizmo
  // at the set's centre of mass, transforming all members as one rigid
  // thing. The proxy re-seats at identity after every committed step, so
  // its pose is always a delta.
  useEffect(() => {
    const viewer = viewerRef.current;
    const gizmo = gizmoRef.current;
    const proxy = proxyRef.current;
    if (!viewer || !gizmo || !proxy) return;
    if (gizmo.dragging) return; // never re-seat the proxy under a live drag
    const entity = props.editingEntity;
    if (!entity || mode !== 'transform') {
      if (!props.selectedPart) gizmo.attach(null);
      return;
    }
    // Centre of MASS, not of bounding box: the handles sit where the
    // material is, and rotation pivots about the same point.
    let centre = viewer.centreOfMassOf(entity.parts);
    if (!centre) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (const partId of entity.parts) {
        const box = viewer.partBox(partId);
        if (!box) continue;
        for (const a of [0, 1, 2]) {
          min[a] = Math.min(min[a], box.min[a]);
          max[a] = Math.max(max[a], box.max[a]);
        }
      }
      if (!Number.isFinite(min[0])) return;
      centre = new THREE.Vector3(...[0, 1, 2].map((a) => (min[a] + max[a]) / 2) as [number, number, number]);
    }
    proxy.position.copy(centre);
    proxy.rotation.set(0, 0, 0);
    proxy.scale.set(1, 1, 1);
    proxyBaseRef.current = {
      position: [centre.x, centre.y, centre.z], rotationDeg: [0, 0, 0], scale: [1, 1, 1],
    };
    gizmo.attachObject(proxy);
  }, [props.editingEntity, mode, props.project.manifest, props.selectedPart]);

  // The dark pill glides onto the armed tool (the framer-motion layoutId tab
  // pattern, done with a measured absolute span) and collapses away when no
  // tool is armed — orbiting has no button to sit on.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const pill = pillRef.current;
    if (!bar || !pill) return;
    const activeId = snapArm !== null ? 'snap-tool' : mode === 'transform' ? 'gizmo-transform' : null;
    const btn = activeId && bar.querySelector<HTMLButtonElement>(`[data-testid="${activeId}"]`);
    if (!btn) {
      pill.style.width = '0px';
      return;
    }
    pill.style.left = `${btn.offsetLeft}px`;
    pill.style.width = `${btn.offsetWidth}px`;
  }, [mode, snapArm]);

  // Face snapping: two picks, first names the mover. The whole flat surface
  // under the pointer glows as a preview; the first pick keeps its glow (in
  // the accent colour) while the second is chosen.
  useEffect(() => {
    if (snapArm === null) {
      viewerRef.current?.clearSurfaceHighlights();
      return;
    }
    const canvas = canvasRef.current!;
    let lastHover = 0;
    const onMove = (e: PointerEvent) => {
      const now = performance.now();
      if (now - lastHover < 40) return;
      lastHover = now;
      viewerRef.current?.showSurfaceHighlight('hover', viewerRef.current.surfaceAt(e.clientX, e.clientY));
    };
    const onClick = (e: PointerEvent) => {
      if (e.button !== 0) return; // right-drag pans, it never picks
      const viewer = viewerRef.current;
      const hit = viewer?.surfaceAt(e.clientX, e.clientY);
      if (!hit || !viewer) return;
      if (snapRef.current === 'first') {
        viewer.showSurfaceHighlight('first', hit);
        setSnapArm(hit);
        return;
      }
      if (snapRef.current && snapRef.current !== 'first') {
        try {
          props.onChange(snapFaces(commitCtx.current.project.manifest, snapRef.current, hit));
          setSnapError(null);
        } catch (err) {
          setSnapError(err instanceof Error ? err.message : String(err));
        }
        viewer.clearSurfaceHighlights();
        setSnapArm(null);
      }
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onClick);
    return () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapArm]);

  // Text/image placement: same surface-glow interaction as Snap, but one
  // pick on one named part — the clicked face's centroid and normal (already
  // in the part's local space, thanks to surfaceAt) become the sketch plane.
  const pickCtx = useRef({ surfacePick: props.surfacePick, onSurfacePick: props.onSurfacePick });
  pickCtx.current = { surfacePick: props.surfacePick, onSurfacePick: props.onSurfacePick };
  useEffect(() => {
    if (!props.surfacePick) return;
    setSnapArm(null); // one surface tool at a time
    const canvas = canvasRef.current!;
    let lastHover = 0;
    let down = { x: 0, y: 0 };
    const hitOnTarget = (e: PointerEvent) => {
      const hit = viewerRef.current?.surfaceAt(e.clientX, e.clientY);
      return hit && hit.partId === pickCtx.current.surfacePick?.partId ? hit : null;
    };
    const onMove = (e: PointerEvent) => {
      const now = performance.now();
      if (now - lastHover < 40) return;
      lastHover = now;
      viewerRef.current?.showSurfaceHighlight('hover', hitOnTarget(e));
    };
    const onDown = (e: PointerEvent) => { if (e.button === 0) down = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      // Right/middle buttons belong to the camera; an orbit drag that ends
      // on the part isn't a pick either.
      if (e.button !== 0) return;
      if (Math.abs(e.clientX - down.x) > 4 || Math.abs(e.clientY - down.y) > 4) return;
      const hit = hitOnTarget(e);
      if (!hit) return;
      viewerRef.current?.clearSurfaceHighlights();
      pickCtx.current.onSurfacePick(hit.partId, {
        origin: hit.localCentre, normal: hit.localNormal, zone: hit.zone ?? undefined, curved: hit.curved,
      });
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onSurfaceCancel(); };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      viewerRef.current?.clearSurfaceHighlights();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.surfacePick]);

  // Baseline shaping: the slot's path anchors render as draggable dots,
  // projected from sketch (u,v) through the carrier's transform every frame
  // (so orbiting keeps them pinned to the surface). Dragging raycasts the
  // cursor back onto the sketch plane; smaller dots at each segment
  // midpoint insert a new anchor, double-clicking removes one (two
  // minimum). The glyph mesh re-renders on every commit, so the letters
  // walk the curve live under the drag.
  useEffect(() => {
    const optionId = props.shapeText;
    if (!optionId) return;
    setSnapArm(null);
    setMode('off');
    const stage = stageRef.current!;
    const canvas = canvasRef.current!;
    const overlay = document.createElement('div');
    overlay.className = 'shape-overlay';
    overlay.setAttribute('data-testid', 'shape-overlay');
    stage.append(overlay);

    interface Basis {
      option: TextOption; viewer: Viewer; carrier: THREE.Mesh;
      origin: THREE.Vector3; x: THREE.Vector3; y: THREE.Vector3; n: THREE.Vector3;
    }
    const basisOf = (): Basis | null => {
      const option = commitCtx.current.project.manifest.options.find(
        (o): o is TextOption => o.id === optionId && o.type === 'text');
      const viewer = viewerRef.current;
      const carrier = option && (viewer?.meshOf(option.part) as THREE.Mesh | undefined);
      if (!option || !viewer || !carrier) return null;
      // The same sketch basis placeGlyph poses the run with — the dots sit
      // exactly where the letters land.
      const n = new THREE.Vector3(...option.normal).normalize();
      const upRef = Math.abs(n.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1);
      const x = new THREE.Vector3().crossVectors(upRef, n).normalize();
      const y = new THREE.Vector3().crossVectors(n, x).normalize();
      if (option.rotationDeg) {
        const spin = new THREE.Quaternion().setFromAxisAngle(n, option.rotationDeg * Math.PI / 180);
        x.applyQuaternion(spin);
        y.applyQuaternion(spin);
      }
      return { option, viewer, carrier, origin: new THREE.Vector3(...option.origin), x, y, n };
    };
    const toWorld = (b: Basis, u: number, v: number) =>
      b.carrier.localToWorld(b.origin.clone().addScaledVector(b.x, u).addScaledVector(b.y, v));
    const toScreen = (b: Basis, world: THREE.Vector3) => {
      const p = world.clone().project(b.viewer.camera);
      const r = canvas.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      return { left: (p.x + 1) / 2 * r.width + (r.left - s.left), top: (1 - p.y) / 2 * r.height + (r.top - s.top) };
    };
    const raycaster = new THREE.Raycaster();
    const toSketch = (b: Basis, clientX: number, clientY: number): Pt | null => {
      const r = canvas.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(
        ((clientX - r.left) / r.width) * 2 - 1,
        -((clientY - r.top) / r.height) * 2 + 1,
      ), b.viewer.camera);
      const worldN = b.n.clone().transformDirection(b.carrier.matrixWorld);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(worldN, toWorld(b, 0, 0));
      const hit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(plane, hit)) return null;
      const local = b.carrier.worldToLocal(hit).sub(b.origin);
      return [local.dot(b.x), local.dot(b.y)];
    };

    const commit = (path: Pt[], transient: boolean) => {
      const { project, onChange } = commitCtx.current;
      try {
        onChange(setTextPath(project.manifest, optionId, path as Array<[number, number]>), { transient });
      } catch { /* a refused path never reaches the manifest */ }
    };

    let anchors: HTMLButtonElement[] = [];
    let mids: HTMLButtonElement[] = [];
    let dragging = -1;
    let dragMoved = false;

    const startDrag = (index: number) => (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = index;
      dragMoved = false;
      anchors[index]?.setPointerCapture?.(e.pointerId);
    };
    const onDragMove = (e: PointerEvent) => {
      if (dragging < 0) return;
      const b = basisOf();
      if (!b) return;
      const uv = toSketch(b, e.clientX, e.clientY);
      if (!uv) return;
      const clamp = (v: number) => Math.max(-1000, Math.min(1000, v));
      const next = (b.option.path ?? []).map((p, i) => (i === dragging
        ? [clamp(uv[0]), clamp(uv[1])] as Pt
        : p as Pt));
      // First move of a gesture records the undo step; the rest ride it.
      commit(next, dragMoved);
      dragMoved = true;
    };
    const endDrag = () => { dragging = -1; };

    const removeAnchor = (index: number) => {
      const b = basisOf();
      if (!b || (b.option.path ?? []).length <= 2) return;
      commit((b.option.path ?? []).filter((_, i) => i !== index) as Pt[], false);
    };
    const insertAnchor = (index: number) => (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const b = basisOf();
      if (!b) return;
      const path = (b.option.path ?? []) as Pt[];
      const segs = openCurveSegments(path);
      if (!segs[index]) return;
      const mid = curvePoint(segs[index], 0.5);
      commit([...path.slice(0, index + 1), mid, ...path.slice(index + 1)], false);
    };

    const ensureHandles = (anchorCount: number, midCount: number) => {
      while (anchors.length < anchorCount) {
        const i = anchors.length;
        const dot = document.createElement('button');
        dot.className = 'shape-anchor';
        dot.setAttribute('data-testid', `shape-anchor-${i}`);
        dot.title = 'Drag to reshape — double-click to remove';
        dot.addEventListener('pointerdown', startDrag(i));
        dot.addEventListener('dblclick', () => removeAnchor(i));
        overlay.append(dot);
        anchors.push(dot);
      }
      while (anchors.length > anchorCount) anchors.pop()!.remove();
      while (mids.length < midCount) {
        const i = mids.length;
        const dot = document.createElement('button');
        dot.className = 'shape-mid';
        dot.setAttribute('data-testid', `shape-mid-${i}`);
        dot.title = 'Add a point here';
        dot.addEventListener('pointerdown', insertAnchor(i));
        overlay.append(dot);
        mids.push(dot);
      }
      while (mids.length > midCount) mids.pop()!.remove();
    };

    let raf = 0;
    const layout = () => {
      const b = basisOf();
      if (!b || !b.option.path?.length) { props.onShapeTextDone(); return; }
      const path = b.option.path as Pt[];
      const segs = openCurveSegments(path); // open: one fewer than anchors
      ensureHandles(path.length, segs.length);
      path.forEach((p, i) => {
        const s = toScreen(b, toWorld(b, p[0], p[1]));
        anchors[i].style.left = `${s.left}px`;
        anchors[i].style.top = `${s.top}px`;
      });
      segs.forEach((seg, i) => {
        const [mu, mv] = curvePoint(seg, 0.5);
        const s = toScreen(b, toWorld(b, mu, mv));
        mids[i].style.left = `${s.left}px`;
        mids[i].style.top = `${s.top}px`;
      });
      raf = requestAnimationFrame(layout);
    };
    raf = requestAnimationFrame(layout);

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onShapeTextDone(); };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.shapeText]);

  const saveView = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const view = viewer.cameraView();
    props.onChange(setCameraView(props.project.manifest, view));
    setViewSaved(true);
    setTimeout(() => setViewSaved(false), 1600);
  };

  return (
    <div className="stage" ref={stageRef}>
      <canvas ref={canvasRef} />
      <canvas ref={cubeRef} className="viewcube" width={92} height={92} data-testid="view-cube" />
      <div className="gizmo-bar" role="toolbar" aria-label="Viewport tools" ref={barRef}>
        <span className="mode-pill" ref={pillRef} aria-hidden="true" />
        <button
          data-testid="gizmo-transform" disabled={!hasParts}
          className={snapArm === null && mode === 'transform' ? 'is-active' : ''}
          title="Move, rotate and scale the selected part — click again (or click empty space) to go back to orbiting"
          onClick={() => { setMode(mode === 'transform' ? 'off' : 'transform'); setSnapArm(null); }}
        >Transform</button>
        <button
          data-testid="snap-tool" disabled={!hasParts}
          className={snapArm !== null ? 'is-active' : ''}
          onClick={() => { setSnapArm(snapArm === null ? 'first' : null); setSnapError(null); }}
          title="Click a face on the part to move, then the face it should sit against"
        >Snap</button>
        <span className="gizmo-sep" />
        <button data-testid="save-view" disabled={!hasParts} onClick={saveView} title="Customers will open the configurator from this angle">
          {viewSaved ? 'Saved ✓' : 'Save view'}
        </button>
      </div>
      {snapArm !== null && (
        <div className="snap-hint" data-testid="snap-hint">
          {snapArm === 'first'
            ? 'Snap: click the face of the part that should MOVE.'
            : 'Snap: now click the face it should sit against.'}
        </div>
      )}
      {snapError && <div className="snap-hint error" role="alert">{snapError}</div>}
      {props.surfacePick && (
        <div className="snap-hint" data-testid="text-pick-hint">
          {props.surfacePick.kind === 'image' ? 'Image zone' : 'Text'}: click a face on “
          {props.project.manifest.parts.find((p) => p.id === props.surfacePick!.partId)?.label ?? props.surfacePick.partId}”
          to place {props.surfacePick.kind === 'image' ? 'the zone' : 'the text'}. Esc cancels.
        </div>
      )}
    </div>
  );
}
