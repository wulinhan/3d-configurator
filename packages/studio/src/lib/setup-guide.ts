// The product-setup journey, in the order a CUSTOMER meets the result:
// parts on the stage, colours to pick, the text or image they type in,
// the price it all adds to, a dry run through their eyes, and publish.
// Authoring in the buyer's sequence is what makes the Studio a
// no-brainer — each step is DETECTED from the manifest, never ticked by
// hand, so the checklist always tells the truth and never nags about
// what is already done.

import type { Manifest } from '../../../embed/src/manifest/types.ts';
import { STARTER_SWATCHES } from './manifest-init.ts';

export type StepId = 'parts' | 'colours' | 'personalise' | 'pricing' | 'preview' | 'publish';

/** The two steps the manifest cannot know about — remembered per project. */
export interface GuideProgress {
  previewed?: boolean;
  published?: boolean;
}

export interface SetupStep {
  id: StepId;
  label: string;
  /** One line of "what do I actually do here", shown as the tooltip. */
  hint: string;
  done: boolean;
  /** The panel tab that step lives in, when it lives in one. */
  tab?: 'Parts' | 'Palette' | 'Finish';
}

export function setupSteps(manifest: Manifest, progress: GuideProgress): SetupStep[] {
  const hasParts = manifest.parts.length > 0;

  // "Set the colours" is done the moment the palette stops being the
  // starter set — a swatch added, dropped, renamed, re-hexed or turned
  // into a gradient — or custom colours are opened up anywhere.
  const starter = new Map(STARTER_SWATCHES.map((s) => [s.id, s.hex]));
  const swatches = manifest.palettes?.[0]?.swatches ?? [];
  const colours = swatches.length !== starter.size
    || swatches.some((s) => starter.get(s.id) !== s.hex || !!s.hex2)
    || manifest.options.some((o) => o.type === 'colour' && !!o.custom?.allowed);

  const personalise = manifest.options.some((o) => o.type === 'text' || o.type === 'upload');

  const priced = (manifest.pricing.basePrice ?? 0) > 0
    || swatches.some((s) => ((s as { priceDelta?: number }).priceDelta ?? 0) > 0)
    || manifest.options.some((o) => {
      if (o.type === 'colour' && (o.custom?.priceDelta ?? 0) > 0) return true;
      if ((o.type === 'text' || o.type === 'upload')
        && ((o as { priceDelta?: number }).priceDelta ?? 0) > 0) return true;
      const choices = (o as { choices?: Array<{ priceDelta?: number }> }).choices ?? [];
      return choices.some((c) => (c.priceDelta ?? 0) > 0);
    });

  return [
    {
      id: 'parts', label: 'Add your parts', done: hasParts, tab: 'Parts',
      hint: 'Import a model, start from a shape, or trace an image.',
    },
    {
      id: 'colours', label: 'Set the colours', done: colours, tab: 'Palette',
      hint: 'Make the palette yours — swatches, gradients, custom colours.',
    },
    {
      id: 'personalise', label: 'Add text or an image', done: personalise, tab: 'Parts',
      hint: 'Select a part, then give customers a text field or an image spot.',
    },
    {
      id: 'pricing', label: 'Price the choices', done: priced, tab: 'Palette',
      hint: 'Surcharges on colours, choices and personalisation.',
    },
    {
      id: 'preview', label: 'Try it as a customer', done: !!progress.previewed,
      hint: 'Open the preview and click through the whole flow once.',
    },
    {
      id: 'publish', label: 'Publish it', done: !!progress.published,
      hint: 'Put it live — or download the two files to host anywhere.',
    },
  ];
}

/** What the header's "Next:" button points at — the first gap in the
 * journey, or nothing once the product is ready. */
export const nextStep = (steps: SetupStep[]): SetupStep | null =>
  steps.find((s) => !s.done) ?? null;
