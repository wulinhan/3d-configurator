// "Preview what end users will see" — by running exactly what end users run.
// This mounts the embed's own mount() (panel, pricing, viewer and all)
// against the manifest as authored and the same GLB blob the Studio previews,
// so the overlay can never drift from the real storefront embed: it IS the
// storefront embed, minus the iframe.

import { useEffect, useRef, useState } from 'react';
import { mount } from '../../../embed/src/embed.ts';
import '../../../embed/src/embed.css';
import type { Manifest, SelectionPayload } from '../../../embed/src/manifest/types.ts';
import { frameCamera } from '../lib/manifest-edit.ts';
import type { Project } from '../App.tsx';

export function PreviewOverlay(props: { project: Project; onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [total, setTotal] = useState<SelectionPayload | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const root = rootRef.current!;
    let disposed = false;
    let viewer: { dispose(): void } | null = null;

    // Same treatment publish applies: the model URL points at the Studio's
    // blob, and the camera auto-frames unless the merchant saved a view.
    const manifest: Manifest = structuredClone(props.project.manifest);
    for (const model of manifest.models) model.url = props.project.modelUrl;
    const framed = manifest.camera?.userSet ? manifest : frameCamera(manifest, props.project.raw);

    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<SelectionPayload>).detail;
      setTotal(detail);
      (window as any).__previewPayload = detail; // test hook
    };
    root.addEventListener('configurator:change', onChange);

    mount({ root, manifest: framed, target: window })
      .then((handle) => {
        if (disposed) { handle.viewer.dispose(); return; }
        viewer = handle.viewer;
        (window as any).__previewViewer = handle.viewer; // test hook
      })
      .catch((err) => { if (!disposed) setFailure(err instanceof Error ? err.message : String(err)); });

    return () => {
      disposed = true;
      root.removeEventListener('configurator:change', onChange);
      viewer?.dispose();
      (window as any).__previewViewer = null;
      root.replaceChildren();
    };
  }, [props.project.manifest, props.project.modelUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);

  const money = (n: number) =>
    new Intl.NumberFormat('en-SG', {
      style: 'currency', currency: props.project.manifest.pricing.currency, minimumFractionDigits: 0,
    }).format(n);

  return (
    <div className="preview-overlay" data-testid="preview-overlay">
      <div className="preview-chrome">
        <span className="preview-title">Customer preview</span>
        <span className="hint">This is the live embed — what your product page will show.</span>
        <span className="spacer" />
        {total && total.deltaTotal > 0 && (
          <span className="preview-total" data-testid="preview-total">+{money(total.deltaTotal)} configured</span>
        )}
        <button className="ghost" data-testid="preview-close" onClick={props.onClose}>Close preview</button>
      </div>
      {failure && <p className="error preview-error" role="alert">Preview failed: {failure}</p>}
      <div className="preview-embed" ref={rootRef} />
    </div>
  );
}
