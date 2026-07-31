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
import { applyGizmoPose, setCameraView, snapFaces, type GizmoPose } from '../lib/manifest-edit.ts';
import { Gizmo, type GizmoMode, type CommitPhase } from './gizmo.ts';
import { ViewCube } from './view-cube.ts';
import type { Project, SetManifestOptions } from '../App.tsx';

const MODES: Array<{ id: GizmoMode; label: string }> = [
  { id: 'off', label: 'Orbit' },
  { id: 'transform', label: 'Transform' },
];

export function ViewerPane(props: {
  project: Project;
  selections: Selections;
  selectedPart: string | null;
  hiddenParts: Set<string>;
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

  // A drag commits against whatever the manifest is at release time, not at
  // gizmo construction — refs keep the callback current without rebuilding.
  const commitCtx = useRef({ project: props.project, selectedPart: props.selectedPart, onChange: props.onChange });
  commitCtx.current = { project: props.project, selectedPart: props.selectedPart, onChange: props.onChange };

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
        // Neither a snap pick nor a click that landed on a gizmo handle is a
        // selection gesture.
        if (snapRef.current !== null) return;
        if (gizmoRef.current?.hovering) return;
        onSelectRef.current(id);
      },
    });
    viewer.setPanEnabled(true); // right-drag / two-finger pan while authoring
    viewerRef.current = viewer;
    (window as any).__studioViewer = viewer; // test hook, same as __studio
    let disposed = false;

    // A whole drag is ONE undo step: the first commit of a gesture records
    // history, every later live commit (and the release) replaces in place.
    let midDrag = false;
    const gizmo = new Gizmo(viewer, canvas, (pose: GizmoPose, phase: CommitPhase) => {
      const { project, selectedPart, onChange } = commitCtx.current;
      if (!selectedPart) return;
      const transient = midDrag;
      midDrag = phase !== 'end';
      try {
        onChange(applyGizmoPose(project.manifest, selectedPart, project.raw, pose), { transient });
      } catch {
        // A pose the edit layer refuses (degenerate scale, detached part):
        // snap the mesh back to the authored state rather than leaving the
        // preview lying about what the manifest says.
        viewer.setManifest(project.manifest);
      }
    });
    gizmoRef.current = gizmo;

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
    (window as any).__studioAxes = axes; // test hook

    viewer.load().then(() => {
      if (disposed) return;
      viewer.apply(props.selections);
      fit();
      viewer.start();
      const b = viewer.layoutBounds();
      if (Number.isFinite(b.min[0])) {
        const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
        spanRef.current = span;
        grid.scale.setScalar(span * 1.6);
        axes.scale.setScalar(span * 0.35);
        // Grid slightly below ground, axes slightly above: exactly coplanar
        // lines fight in the depth buffer and shimmer as the camera moves.
        grid.position.y = -span * 0.004;
        axes.position.y = span * 0.004;
      }
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
    gizmoRef.current?.attach(props.selectedPart);
    const bounds = viewer.layoutBounds();
    if (!Number.isFinite(bounds.min[0])) return;
    if (props.selectedPart) {
      const box = viewer.partBox(props.selectedPart);
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

  // The origin axes and the gizmo's coloured axes say the same thing in the
  // same colours — both visible at once reads as flicker. While the gizmo is
  // attached, it IS the axes; the origin ones step aside.
  useEffect(() => {
    const axes = axesRef.current;
    if (axes) axes.visible = !(props.selectedPart && mode === 'transform');
  }, [props.selectedPart, mode, props.project.modelUrl]);

  // The dark pill glides between Orbit / Transform / Snap (the framer-motion
  // layoutId tab pattern, done with a measured absolute span).
  useLayoutEffect(() => {
    const bar = barRef.current;
    const pill = pillRef.current;
    if (!bar || !pill) return;
    const activeId = snapArm !== null ? 'snap-tool' : mode === 'off' ? 'gizmo-off' : 'gizmo-transform';
    const btn = bar.querySelector<HTMLButtonElement>(`[data-testid="${activeId}"]`);
    if (!btn) return;
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
      <div className="gizmo-bar" role="toolbar" aria-label="Transform mode" ref={barRef}>
        <span className="mode-pill" ref={pillRef} aria-hidden="true" />
        {MODES.map((m) => (
          <button
            key={m.id} data-testid={`gizmo-${m.id}`}
            className={snapArm === null && mode === m.id ? 'is-active' : ''}
            onClick={() => { setMode(m.id); setSnapArm(null); }}
          >{m.label}</button>
        ))}
        <button
          data-testid="snap-tool"
          className={snapArm !== null ? 'is-active' : ''}
          onClick={() => { setSnapArm(snapArm === null ? 'first' : null); setSnapError(null); }}
          title="Click a face on the part to move, then the face it should sit against"
        >Snap</button>
        <span className="gizmo-sep" />
        <button data-testid="save-view" onClick={saveView} title="Customers will open the configurator from this angle">
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
    </div>
  );
}
