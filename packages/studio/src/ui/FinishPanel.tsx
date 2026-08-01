// Surface finish per part: the material knobs the manifest already carries
// (roughness, metalness, faceted vs smooth shading), surfaced as sliders.
// Everything applies live — the viewer re-reads part.material on every
// setManifest — and publishes with the manifest, so the storefront renders
// the same finish the merchant tuned.

import type { Manifest } from '../../../embed/src/manifest/types.ts';
import { setPartMaterial } from '../lib/manifest-edit.ts';
import type { Project, SetManifestOptions } from '../App.tsx';

const DEFAULT_ROUGHNESS = 0.55; // the viewer's dull-gloss plastic default
const round2 = (n: number) => Math.round(n * 100) / 100;

export function FinishPanel(props: {
  project: Project;
  onChange: (m: Manifest, opts?: SetManifestOptions) => void;
}) {
  const { manifest } = props.project;
  return (
    <div className="panel-body">
      <p className="hint">
        How each part's surface catches light. Finish ships with the manifest —
        customers see exactly this.
      </p>
      {manifest.parts.map((p) => {
        const roughness = p.material?.roughness ?? DEFAULT_ROUGHNESS;
        const metalness = p.material?.metalness ?? 0;
        const flat = p.material?.flatShading ?? true;
        return (
          <section className="finish-row" key={p.id} data-testid={`finish-${p.id}`}>
            <h4>{p.label}</h4>
            <label className="slider-row">
              <span className="field-label">Gloss</span>
              <input
                type="range" min={0} max={1} step={0.05}
                // The slider reads as "more gloss to the right"; roughness is its inverse.
                value={round2(1 - roughness)} data-testid={`gloss-${p.id}`}
                onChange={(e) => props.onChange(setPartMaterial(manifest, p.id, { roughness: round2(1 - Number(e.target.value)) }))}
              />
              <span className="slider-value">{Math.round((1 - roughness) * 100)}%</span>
            </label>
            <label className="slider-row">
              <span className="field-label">Metal</span>
              <input
                type="range" min={0} max={1} step={0.05}
                value={round2(metalness)} data-testid={`metal-${p.id}`}
                onChange={(e) => props.onChange(setPartMaterial(manifest, p.id, { metalness: Number(e.target.value) }))}
              />
              <span className="slider-value">{Math.round(metalness * 100)}%</span>
            </label>
            <label className="lock">
              <input
                type="checkbox" checked={!flat} data-testid={`smooth-${p.id}`}
                onChange={(e) => props.onChange(setPartMaterial(manifest, p.id, { flatShading: !e.target.checked }))}
              />
              Smooth shading (off keeps print-style facets)
            </label>
          </section>
        );
      })}
    </div>
  );
}
