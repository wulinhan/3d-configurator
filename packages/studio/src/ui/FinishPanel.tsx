// Surface finish per part: the material knobs the manifest already carries
// (roughness, metalness, faceted vs smooth shading), surfaced as sliders.
// Everything applies live — the viewer re-reads part.material on every
// setManifest — and publishes with the manifest, so the storefront renders
// the same finish the merchant tuned.

import type { Manifest, TextureType } from '../../../embed/src/manifest/types.ts';
import { TEXTURE_CHOICES } from '../../../embed/src/runtime/textures.ts';
import { DEFAULT_EXPOSURE, MAX_EXPOSURE, MAX_ENV, highlightsFlatten } from '../../../embed/src/runtime/viewer.ts';
import { setPartMaterial, setScene } from '../lib/manifest-edit.ts';
import type { Project, SetManifestOptions } from '../App.tsx';
import { Select } from './controls.tsx';

const DEFAULT_ROUGHNESS = 0.55; // the viewer's dull-gloss plastic default
const round2 = (n: number) => Math.round(n * 100) / 100;

export function FinishPanel(props: {
  project: Project;
  onChange: (m: Manifest, opts?: SetManifestOptions) => void;
}) {
  const { manifest } = props.project;
  const scene = manifest.scene ?? {};
  const sceneSlider = (
    label: string, key: 'exposure' | 'environmentIntensity' | 'shadowOpacity',
    value: number, min: number, max: number, testId: string,
  ) => (
    <label className="slider-row">
      <span className="field-label">{label}</span>
      <input
        type="range" min={min} max={max} step={0.05} value={value} data-testid={testId}
        onChange={(e) => props.onChange(setScene(manifest, { [key]: Number(e.target.value) }))}
      />
      <span className="slider-value">{value.toFixed(2)}</span>
    </label>
  );
  return (
    <div className="panel-body">
      <section className="finish-row">
        <h4>Scene &amp; lighting</h4>
        <p className="hint">
          Staging for the whole product — brightness, the studio environment's
          reflections, and how strongly it sits on its shadow. Ships with the
          manifest; the storefront lights it exactly this way.
        </p>
        {sceneSlider('Light', 'exposure', scene.exposure ?? DEFAULT_EXPOSURE, 0.2, MAX_EXPOSURE, 'scene-exposure')}
        {sceneSlider('Reflect', 'environmentIntensity', scene.environmentIntensity ?? 0.5, 0, MAX_ENV, 'scene-env')}
        {sceneSlider('Shadow', 'shadowOpacity', scene.shadowOpacity ?? 0.2, 0, 1, 'scene-shadow')}
        {highlightsFlatten(scene.exposure, scene.environmentIntensity) && (
          <p className="hint warn" data-testid="scene-flat-warning">
            Light and Reflect together are washing the highlights out — pale
            finishes will start looking like each other. Ease one of them back.
          </p>
        )}
      </section>
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
            <label className="field wide">
              <span className="field-label">Texture</span>
              <Select
                ariaLabel="Surface texture" testId={`texture-${p.id}`}
                value={p.material?.texture?.type ?? ''}
                options={[
                  { value: '', label: 'None (smooth)' },
                  ...TEXTURE_CHOICES.map((t) => ({ value: t.id, label: t.label })),
                ]}
                onChange={(v) => props.onChange(setPartMaterial(manifest, p.id,
                  { texture: v === '' ? null : { ...p.material?.texture, type: v as TextureType } }))}
              />
            </label>
            {p.material?.texture && (
              <>
                <label className="slider-row">
                  <span className="field-label">Grain size</span>
                  <input
                    type="range" min={1} max={40} step={0.5}
                    value={p.material.texture.scaleMm ?? 8} data-testid={`texscale-${p.id}`}
                    onChange={(e) => props.onChange(setPartMaterial(manifest, p.id,
                      { texture: { ...p.material!.texture!, scaleMm: Number(e.target.value) } }))}
                  />
                  <span className="slider-value">{(p.material.texture.scaleMm ?? 8).toFixed(1)}mm</span>
                </label>
                <label className="slider-row">
                  <span className="field-label">Depth</span>
                  <input
                    type="range" min={0} max={3} step={0.05}
                    value={p.material.texture.strength ?? 1} data-testid={`texstrength-${p.id}`}
                    onChange={(e) => props.onChange(setPartMaterial(manifest, p.id,
                      { texture: { ...p.material!.texture!, strength: Number(e.target.value) } }))}
                  />
                  <span className="slider-value">{(p.material.texture.strength ?? 1).toFixed(2)}</span>
                </label>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
