// The setup journey's completeness model: every tick is DETECTED from the
// manifest — in the customer's order — so the checklist tells the truth
// without anyone maintaining it. These pin each detector and the "what
// next" pointer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Manifest } from '../../embed/src/manifest/types.ts';
import { emptyManifest, initManifest } from '../src/lib/manifest-init.ts';
import { setupSteps, nextStep } from '../src/lib/setup-guide.ts';

const tri = () => ({
  name: 'body',
  positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]),
  indices: Uint32Array.from([0, 1, 2]),
});
const withParts = (): Manifest =>
  initManifest([tri()], { name: 'Stand', bounds: { min: [0, 0, 0], max: [10, 10, 1] } });

const byId = (m: Manifest, progress = {}) =>
  Object.fromEntries(setupSteps(m, progress).map((s) => [s.id, s.done]));

test('an empty project has every step ahead of it, starting with parts', () => {
  const steps = setupSteps(emptyManifest(), {});
  assert.equal(steps.length, 6);
  assert.ok(steps.every((s) => !s.done));
  assert.equal(nextStep(steps)?.id, 'parts');
});

test('steps tick as the manifest earns them, in the customer\'s order', () => {
  const m = withParts();
  let done = byId(m);
  assert.equal(done.parts, true);
  assert.equal(done.colours, false, 'the starter palette is not "set the colours"');
  assert.equal(nextStep(setupSteps(m, {}))?.id, 'colours');

  // touch the palette: re-hex one swatch
  m.palettes![0].swatches[0].hex = '#ABCDEF';
  done = byId(m);
  assert.equal(done.colours, true);
  assert.equal(nextStep(setupSteps(m, {}))?.id, 'personalise');

  // a text option is personalisation
  (m.options as unknown[]).push({ id: 't', type: 'text', label: 'Name', part: 'body', sizeMm: 8, maxChars: 12 });
  done = byId(m);
  assert.equal(done.personalise, true);
  assert.equal(done.pricing, false);

  // a surcharge anywhere is pricing
  (m.options.find((o) => o.type === 'text') as { priceDelta?: number }).priceDelta = 5;
  done = byId(m);
  assert.equal(done.pricing, true);

  // the last two are remembered flags, not manifest facts
  assert.deepEqual([done.preview, done.publish], [false, false]);
  const withFlags = byId(m, { previewed: true, published: true });
  assert.deepEqual([withFlags.preview, withFlags.publish], [true, true]);
  assert.equal(nextStep(setupSteps(m, { previewed: true, published: true })), null, 'all done — nothing next');
});

test('other roads into each step also count', () => {
  // custom colours opened up = colours are "set"
  const a = withParts();
  const colourOpt = a.options.find((o) => o.type === 'colour') as { custom?: { allowed: boolean } };
  colourOpt.custom = { allowed: true };
  assert.equal(byId(a).colours, true);

  // a gradient swatch = colours are "set"
  const b = withParts();
  (b.palettes![0].swatches[0] as { hex2?: string }).hex2 = '#123456';
  assert.equal(byId(b).colours, true);

  // a swatch surcharge = priced
  const c = withParts();
  (c.palettes![0].swatches[0] as { priceDelta?: number }).priceDelta = 3;
  assert.equal(byId(c).pricing, true);

  // a base price = priced
  const d = withParts();
  d.pricing.basePrice = 49;
  assert.equal(byId(d).pricing, true);
});
