// The preview IS the embed: same Viewer class, same GLB bytes a customer's
// browser would load. Edits arrive as new manifests and are applied with
// setManifest (transform-only relayout) — the WebGL context is created once
// per model, because browsers cap live contexts and rebuild-per-keystroke
// exhausts them in about a minute.
//
// The gizmo rides on top: TransformControls attached to the selected part's
// mesh. During a drag only the mesh moves (free preview); on release the
// pose is committed through applyGizmoPose, and the resulting manifest lays
// the mesh out in exactly the dropped position — so the hand-off from
// "dragging" to "authored" is invisible.

import { useEffect, useRef, useState } from 'react';
import type { Manifest } from '../../../embed/src/manifest/types.ts';
import type { Selections } from '../../../embed/src/runtime/state.ts';
import { Viewer } from '../../../embed/src/runtime/viewer.ts';
import { applyGizmoPose, type GizmoPose } from '../lib/manifest-edit.ts';
import { Gizmo, type GizmoMode } from './gizmo.ts';
import type { Project } from '../App.tsx';

const MODES: Array<{ id: GizmoMode; label: string }> = [
  { id: 'off', label: 'Orbit' },
  { id: 'translate', label: 'Move' },
  { id: 'rotate', label: 'Rotate' },
  { id: 'scale', label: 'Scale' },
];

export function ViewerPane(props: {
  project: Project;
  selections: Selections;
  selectedPart: string | null;
  onSelectPart: (id: string) => void;
  onChange: (m: Manifest) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const gizmoRef = useRef<Gizmo | null>(null);
  const [mode, setMode] = useState<GizmoMode>('off');
  // Span of the model when last framed — the baseline the refit compares to.
  // Set when load() resolves: initialising it lazily in the edit effect
  // swallowed the first big resize, because the viewer loads asynchronously
  // and the first edit was already the enlarged model.
  const spanRef = useRef(0);
  const onSelectRef = useRef(props.onSelectPart);
  onSelectRef.current = props.onSelectPart;

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
      manifest: props.project.manifest,
      resolveUrl: () => props.project.modelUrl,
      onSelectPart: (id) => { if (id) onSelectRef.current(id); },
    });
    viewerRef.current = viewer;
    (window as any).__studioViewer = viewer; // test hook, same as __studio
    let disposed = false;

    const gizmo = new Gizmo(viewer, canvas, (pose: GizmoPose) => {
      const { project, selectedPart, onChange } = commitCtx.current;
      if (!selectedPart) return;
      try {
        onChange(applyGizmoPose(project.manifest, selectedPart, project.raw, pose));
      } catch {
        // A pose the edit layer refuses (degenerate scale, detached part):
        // snap the mesh back to the authored state rather than leaving the
        // preview lying about what the manifest says.
        viewer.setManifest(project.manifest);
      }
    });
    gizmoRef.current = gizmo;

    const fit = () => viewer.resize(stage.clientWidth, stage.clientHeight);
    const observer = new ResizeObserver(fit);
    observer.observe(stage);

    viewer.load().then(() => {
      if (disposed) return;
      viewer.apply(props.selections);
      fit();
      viewer.start();
      const b = viewer.layoutBounds();
      spanRef.current = Number.isFinite(b.min[0])
        ? Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])
        : 0;
      (window as any).__studioViewerReady = true;
    });

    return () => {
      disposed = true;
      (window as any).__studioViewerReady = false;
      observer.disconnect();
      gizmo.dispose();
      gizmoRef.current = null;
      viewer.dispose();
      viewerRef.current = null;
      spanRef.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.project.modelUrl]);

  // Edits: relayout + repaint, no reload — and refit the camera when the
  // model has outgrown (or shrunk out of) the current view. The 25% band
  // keeps ordinary nudges from stealing the merchant's framing.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.setManifest(props.project.manifest);
    viewer.apply(props.selections);
    const b = viewer.layoutBounds();
    if (Number.isFinite(b.min[0]) && spanRef.current > 0) {
      const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      if (span > spanRef.current * 1.25 || span < spanRef.current * 0.6) {
        viewer.frame();
        spanRef.current = span;
      }
    }
  }, [props.project.manifest, props.selections]);

  useEffect(() => {
    viewerRef.current?.highlight(props.selectedPart);
    gizmoRef.current?.attach(props.selectedPart);
  }, [props.selectedPart, props.project.modelUrl]);

  useEffect(() => {
    gizmoRef.current?.setMode(mode);
    gizmoRef.current?.attach(props.selectedPart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return (
    <div className="stage" ref={stageRef}>
      <canvas ref={canvasRef} />
      <div className="gizmo-bar" role="toolbar" aria-label="Transform mode">
        {MODES.map((m) => (
          <button
            key={m.id} data-testid={`gizmo-${m.id}`}
            className={mode === m.id ? 'is-active' : ''}
            onClick={() => setMode(m.id)}
          >{m.label}</button>
        ))}
      </div>
    </div>
  );
}
