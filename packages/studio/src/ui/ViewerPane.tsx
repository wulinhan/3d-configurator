// The preview IS the embed: same Viewer class, same GLB bytes a customer's
// browser would load. Edits arrive as new manifests and are applied with
// setManifest (transform-only relayout) — the WebGL context is created once
// per model, because browsers cap live contexts and rebuild-per-keystroke
// exhausts them in about a minute.

import { useEffect, useRef } from 'react';
import type { Selections } from '../../../embed/src/runtime/state.ts';
import { Viewer } from '../../../embed/src/runtime/viewer.ts';
import type { Project } from '../App.tsx';

export function ViewerPane(props: {
  project: Project;
  selections: Selections;
  selectedPart: string | null;
  onSelectPart: (id: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  // Span of the model when last framed — the baseline the refit compares to.
  // Set when load() resolves: initialising it lazily in the edit effect
  // swallowed the first big resize, because the viewer loads asynchronously
  // and the first edit was already the enlarged model.
  const spanRef = useRef(0);
  const onSelectRef = useRef(props.onSelectPart);
  onSelectRef.current = props.onSelectPart;

  // One viewer per loaded model (keyed by the blob URL).
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
  }, [props.selectedPart]);

  return (
    <div className="stage" ref={stageRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}
