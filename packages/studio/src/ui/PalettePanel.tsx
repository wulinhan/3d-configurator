// Palette editing: the finishes a customer can pick, each with an optional
// surcharge. Removing a swatch that some option defaults to retargets that
// option — the edit op reports which, and the panel says so.

import { useState } from 'react';
import type { Manifest, Swatch } from '../../../embed/src/manifest/types.ts';
import { addSwatch, removeSwatch, setSwatchPrice, setSwatchGradient } from '../lib/manifest-edit.ts';
import type { Project } from '../App.tsx';
import { NumberField } from './fields.tsx';
import { Select } from './controls.tsx';

// The chip previews the blend the way the part will wear it: across for a
// width gradient, upward for a height one, diagonally for depth (the screen
// has no third axis to offer).
export function swatchCss(s: Pick<Swatch, 'hex' | 'hex2' | 'gradientAxis'>): string {
  if (!s.hex2) return s.hex;
  const dir = { x: 'to right', y: 'to top', z: '135deg' }[s.gradientAxis ?? 'y'];
  return `linear-gradient(${dir}, ${s.hex}, ${s.hex2})`;
}

// The panel speaks Studio Z-up: X across, Y deep, Z tall — mapped onto the
// manifest's internal axes ('x' width, 'z' depth, 'y' height).
const GRAD_DIRS = [
  { value: 'x', label: 'X' },
  { value: 'z', label: 'Y' },
  { value: 'y', label: 'Z' },
];

export function PalettePanel(props: { project: Project; onChange: (m: Manifest) => void }) {
  const { manifest } = props.project;
  const palette = manifest.palettes?.[0];
  const [name, setName] = useState('');
  const [hex, setHex] = useState('#4A90D9');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!palette) return <p className="empty">This manifest has no palette.</p>;

  return (
    <div className="panel-body">
      <p className="hint">Finishes the customer can pick. A surcharge on a swatch is added when it's chosen.</p>

      <div className="swatch-list">
        {palette.swatches.map((s) => (
          <div className="swatch-row" key={s.id} data-testid={`swatch-${s.id}`}>
            <span className="chip" style={{ background: swatchCss(s) }} />
            <span className="swatch-name">{s.name}</span>
            <code>{s.hex}{s.hex2 ? `→${s.hex2}` : ''}</code>
            {s.hex2 ? (
              <span className="grad-controls">
                <input
                  type="color" value={s.hex2} aria-label={`${s.name} gradient end`}
                  data-testid={`swatch-grad-hex-${s.id}`}
                  onChange={(e) => props.onChange(setSwatchGradient(manifest, palette.id, s.id,
                    { hex2: e.target.value.toUpperCase(), axis: s.gradientAxis ?? 'y' }))}
                />
                <Select
                  ariaLabel={`${s.name} gradient direction`} testId={`swatch-grad-axis-${s.id}`} compact
                  value={s.gradientAxis ?? 'y'}
                  options={GRAD_DIRS}
                  onChange={(v) => props.onChange(setSwatchGradient(manifest, palette.id, s.id,
                    { hex2: s.hex2!, axis: v as 'x' | 'y' | 'z' }))}
                />
                <button
                  className="mini" data-testid={`swatch-grad-off-${s.id}`}
                  title="Back to a solid colour"
                  onClick={() => props.onChange(setSwatchGradient(manifest, palette.id, s.id, undefined))}
                >Solid</button>
              </span>
            ) : (
              <button
                className="mini" data-testid={`swatch-grad-${s.id}`}
                title="Blend this colour into a second one across the part — the stand-in for colour-shift filament"
                onClick={() => props.onChange(setSwatchGradient(manifest, palette.id, s.id,
                  { hex2: s.hex.toUpperCase() === '#FFFFFF' || s.hex.toUpperCase() === '#FEFEFE' ? '#1A1A1A' : '#FFFFFF' }))}
              >Gradient</button>
            )}
            <NumberField
              label="" value={s.priceDelta ?? 0} suffix={`+${manifest.pricing.currency}`} step={1}
              testId={`swatch-price-${s.id}`}
              onCommit={(v) => props.onChange(setSwatchPrice(manifest, palette.id, s.id, v || undefined))}
            />
            <button
              className="ghost danger" aria-label={`Remove ${s.name}`}
              onClick={() => {
                try {
                  const { manifest: next, retargeted } = removeSwatch(manifest, palette.id, s.id);
                  props.onChange(next);
                  setNote(retargeted.length
                    ? `Removed ${s.name}; ${retargeted.length} option default${retargeted.length > 1 ? 's' : ''} moved to ${next.palettes![0].swatches[0].name}.`
                    : null);
                  setError(null);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            >✕</button>
          </div>
        ))}
      </div>

      <div className="add-swatch" data-testid="add-swatch">
        <input
          type="color" value={hex} aria-label="New colour"
          onChange={(e) => setHex(e.target.value.toUpperCase())}
        />
        <input
          placeholder="Colour name" value={name} aria-label="New colour name"
          onChange={(e) => setName(e.target.value)}
        />
        <button
          onClick={() => {
            try {
              props.onChange(addSwatch(manifest, palette.id, name, hex));
              setName('');
              setError(null);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        >Add colour</button>
      </div>

      {note && <p className="hint" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
