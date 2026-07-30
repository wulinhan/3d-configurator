// Palette editing: the finishes a customer can pick, each with an optional
// surcharge. Removing a swatch that some option defaults to retargets that
// option — the edit op reports which, and the panel says so.

import { useState } from 'react';
import type { Manifest } from '../../../embed/src/manifest/types.ts';
import { addSwatch, removeSwatch, setSwatchPrice } from '../lib/manifest-edit.ts';
import type { Project } from '../App.tsx';
import { NumberField } from './fields.tsx';

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
            <span className="chip" style={{ background: s.hex }} />
            <span className="swatch-name">{s.name}</span>
            <code>{s.hex}</code>
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
