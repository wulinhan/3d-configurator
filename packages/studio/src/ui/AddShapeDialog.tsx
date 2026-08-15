// The two ways a part is born WITHOUT a file from a CAD package: a
// parametric primitive (plinth, spacer, ring, tile) and a colouring
// template traced from artwork — the drawn lines raised into ridges on a
// plate shaped like the artwork itself.
//
// Both dialogs collect numbers, build canonical-space meshes through the
// tested libs, and hand the parts to the App's generated-parts path; they
// own no geometry logic of their own.

import { useEffect, useRef, useState } from 'react';
import type { ImportedPart } from '../lib/types.ts';
import { primitivePart, PRIMITIVE_DEFAULTS, type PrimitiveSpec, type PrimitiveKind } from '../lib/primitives.ts';
import { templateFromRaster, templateMasks, TEMPLATE_DEFAULTS, type Raster } from '../lib/trace-image.ts';
import { Select } from './controls.tsx';
import { NumberField } from './fields.tsx';

const KINDS: Array<{ value: PrimitiveKind; label: string }> = [
  { value: 'cuboid', label: 'Cuboid' },
  { value: 'cylinder', label: 'Cylinder' },
  { value: 'prism', label: 'N-sided prism' },
  { value: 'torus', label: 'Torus (ring)' },
];

export function PrimitiveDialog(props: {
  onAdd: (parts: ImportedPart[]) => void;
  onClose: () => void;
}) {
  const [spec, setSpec] = useState<PrimitiveSpec>(PRIMITIVE_DEFAULTS);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<PrimitiveSpec>) => setSpec((s) => ({ ...s, ...patch }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = () => {
    try {
      props.onAdd([primitivePart(spec)]);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const round = spec.kind !== 'cuboid';
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="dialog-card shape-dialog" role="dialog" aria-modal="true" aria-label="New shape" data-testid="shape-dialog">
        <h3>New shape</h3>
        <div className="dialog-body"><p>A ready-made solid, in millimetres — it lands as an ordinary part.</p></div>
        <div className="dialog-fields">
          <Select
            value={spec.kind} ariaLabel="Shape" testId="shape-kind"
            options={KINDS}
            onChange={(kind) => set({ kind: kind as PrimitiveKind })}
          />
          <div className="field-row">
            <NumberField
              label={round ? 'Diameter' : 'Width'} value={spec.widthMm} suffix="mm" step={1}
              testId="shape-width" onCommit={(v) => set({ widthMm: v })}
            />
            {spec.kind === 'cuboid' && (
              <NumberField
                label="Depth" value={spec.depthMm} suffix="mm" step={1}
                testId="shape-depth" onCommit={(v) => set({ depthMm: v })}
              />
            )}
            {spec.kind === 'torus' ? (
              <NumberField
                label="Tube" value={spec.tubeMm} suffix="mm" step={1}
                testId="shape-tube" onCommit={(v) => set({ tubeMm: v })}
              />
            ) : (
              <NumberField
                label="Height" value={spec.heightMm} suffix="mm" step={1}
                testId="shape-height" onCommit={(v) => set({ heightMm: v })}
              />
            )}
            {spec.kind === 'prism' && (
              <NumberField
                label="Sides" value={spec.sides} step={1}
                testId="shape-sides" onCommit={(v) => set({ sides: Math.max(3, Math.min(64, Math.round(v))) })}
              />
            )}
          </div>
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="ghost" onClick={props.onClose}>Cancel</button>
          <button className="cta" data-testid="shape-add" onClick={add}>Add shape</button>
        </div>
      </div>
    </div>
  );
}

/** Rasterise any browser-readable image — SVG included, which arrives as
 * crisp as the working resolution — onto white at a long side of 1000px. */
async function rasterize(file: File): Promise<Raster> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('That file could not be read as an image.'));
      img.src = url;
    });
    const iw = img.naturalWidth || 1000, ih = img.naturalHeight || 1000;
    const s = 1000 / Math.max(iw, ih);
    const w = Math.max(2, Math.round(iw * s)), h = Math.max(2, Math.round(ih * s));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('No 2D canvas available.');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function ImageTemplateDialog(props: {
  file: File;
  onAdd: (parts: ImportedPart[]) => void;
  onClose: () => void;
}) {
  const [opts, setOpts] = useState(TEMPLATE_DEFAULTS);
  const [raster, setRaster] = useState<Raster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const set = (patch: Partial<typeof opts>) => setOpts((o) => ({ ...o, ...patch }));

  useEffect(() => {
    let dead = false;
    rasterize(props.file)
      .then((r) => { if (!dead) setRaster(r); })
      .catch((err) => { if (!dead) setError(err instanceof Error ? err.message : String(err)); });
    return () => { dead = true; };
  }, [props.file]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The preview IS the two masks: plate in warm grey (with the grown border
  // when one is asked for), ridges in ink. What you see filled is what gets
  // printed — no base means lines on bare page.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !raster) return;
    const masks = templateMasks(raster, {
      widthMm: opts.widthMm,
      widenMm: opts.widenMm,
      baseGrowMm: opts.withBase ? opts.baseGrowMm : 0,
    });
    const { width: w, height: h } = masks;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const out = ctx.createImageData(w, h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const [r, g, b] = masks.ink[i] ? [45, 45, 45]
        : opts.withBase && masks.silhouette[i] ? [229, 222, 208]
          : [248, 246, 241];
      out.data[p] = r; out.data[p + 1] = g; out.data[p + 2] = b; out.data[p + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
  }, [raster, opts.widenMm, opts.widthMm, opts.baseGrowMm, opts.withBase]);

  const add = () => {
    if (!raster) return;
    setBusy(true);
    // let the button repaint to "Tracing…" before the heavy work
    setTimeout(async () => {
      try {
        // Slug, not prose: mesh names travel through GLB, and GLTFLoader
        // sanitises spaced node names — hyphens survive everything.
        const stem = props.file.name.replace(/\.[^.]+$/, '').toLowerCase()
          .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'template';
        const parts = (await templateFromRaster(raster, opts)).map((p) => ({ ...p, name: `${stem}-${p.name}` }));
        props.onAdd(parts);
        props.onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    }, 30);
  };

  const artHeightMm = raster ? Math.round(opts.widthMm * (raster.height / raster.width)) : null;
  const grow = opts.withBase ? opts.baseGrowMm : 0;
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="dialog-card shape-dialog" role="dialog" aria-modal="true" aria-label="Colouring template from image" data-testid="image-template-dialog">
        <h3>Template from image</h3>
        <div className="dialog-body">
          <p>
            The drawn lines become raised ridges; with a base plate on, the
            artwork's outer shape becomes the plate they stand on and each part
            arrives with its own colour.
          </p>
        </div>
        <canvas ref={canvasRef} className="trace-preview" data-testid="trace-preview" aria-label="Traced template preview" />
        {!raster && !error && <p className="trace-note">Reading the image…</p>}
        {raster && artHeightMm !== null && (
          <p className="trace-note">
            {opts.withBase
              ? `Plate: ${opts.widthMm + 2 * grow} × ${artHeightMm + 2 * grow} mm`
              : `Artwork: ${opts.widthMm} × ${artHeightMm} mm — lines only, no base`}
          </p>
        )}
        <div className="dialog-fields">
          <div className="field-row">
            <NumberField
              label="Width" value={opts.widthMm} suffix="mm" step={5}
              testId="template-width" onCommit={(v) => set({ widthMm: v })}
            />
            <NumberField
              label="Line height" value={opts.ridgeMm} suffix="mm" step={0.25}
              testId="template-ridge" onCommit={(v) => set({ ridgeMm: v })}
            />
            <NumberField
              label="Thicken lines" value={opts.widenMm} suffix="mm" step={0.2}
              testId="template-widen" onCommit={(v) => set({ widenMm: Math.max(0, v) })}
            />
          </div>
          <label className="lock">
            <input
              type="checkbox" checked={opts.withBase} data-testid="template-with-base"
              onChange={(e) => set({ withBase: e.target.checked })}
            />
            Base plate under the lines (the artwork's silhouette)
          </label>
          {opts.withBase && (
            <div className="field-row">
              <NumberField
                label="Base" value={opts.baseMm} suffix="mm" step={0.5}
                testId="template-base" onCommit={(v) => set({ baseMm: v })}
              />
              <NumberField
                label="Grow base" value={opts.baseGrowMm} suffix="mm" step={0.5}
                testId="template-grow" onCommit={(v) => set({ baseGrowMm: Math.max(0, v) })}
              />
            </div>
          )}
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="ghost" onClick={props.onClose}>Cancel</button>
          <button className="cta" data-testid="template-add" disabled={!raster || busy} onClick={add}>
            {busy ? 'Tracing…' : 'Add template'}
          </button>
        </div>
      </div>
    </div>
  );
}
