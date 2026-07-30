// Colour-option rules: whether each surface accepts a custom (hex) colour,
// and what that costs. The per-colour charge is per distinct colour across
// the product — the embed's pricing engine already enforces that; this panel
// only sets the rule.

import type { Manifest, ColourOption } from '../../../embed/src/manifest/types.ts';
import { setCustomColour } from '../lib/manifest-edit.ts';
import type { Project } from '../App.tsx';
import { NumberField } from './fields.tsx';

export function OptionsPanel(props: { project: Project; onChange: (m: Manifest) => void }) {
  const { manifest } = props.project;
  const colourOptions = manifest.options.filter((o): o is ColourOption => o.type === 'colour');

  return (
    <div className="panel-body">
      <p className="hint">
        Custom colours let a customer type any hex. The surcharge is charged once per
        distinct colour, even across several surfaces.
      </p>
      {colourOptions.map((option) => {
        const allowed = option.custom?.allowed ?? false;
        return (
          <div className="option-row" key={option.id} data-testid={`option-${option.id}`}>
            <label className="lock">
              <input
                type="checkbox" checked={allowed} data-testid={`custom-toggle-${option.id}`}
                onChange={(e) => props.onChange(setCustomColour(manifest, option.id, {
                  allowed: e.target.checked,
                  priceDelta: e.target.checked ? option.custom?.priceDelta ?? 0 : undefined,
                }))}
              />
              <strong>{option.label}</strong> — allow custom colour
            </label>
            {allowed && (
              <NumberField
                label="Surcharge" value={option.custom?.priceDelta ?? 0}
                suffix={manifest.pricing.currency} step={1}
                testId={`custom-price-${option.id}`}
                onCommit={(v) => props.onChange(setCustomColour(manifest, option.id, { allowed: true, priceDelta: v }))}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
