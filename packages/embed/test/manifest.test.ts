// A validator nobody has tried to break is a validator that passes everything.
//
//   node --test configurator/test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateManifest, assertManifest } from '../src/manifest/validate.ts';
import type { Manifest } from '../src/manifest/types.ts';

const DEMO = new URL('../../../apps/demo/tap-bar-3.manifest.json', import.meta.url);
const base = (): Manifest => JSON.parse(readFileSync(DEMO, 'utf8'));

/** Apply a mutation and return the paths that failed. */
const paths = (mutate: (m: any) => void) => {
  const m = base();
  mutate(m);
  return validateManifest(m).errors.map((e) => e.path);
};

test('the demo manifest is valid', () => {
  const { ok, errors } = validateManifest(base());
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('rejects a schema version it cannot read', () => {
  assert.ok(paths((m) => { m.schema = 2; }).includes('schema'));
});

test('rejects units other than mm', () => {
  assert.ok(paths((m) => { m.units = 'in'; }).includes('units'));
});

test('catches a mesh pointing at a model source that does not exist', () => {
  assert.ok(paths((m) => { m.parts[0].mesh = 'nope#body'; }).includes('parts[0].mesh'));
});

test('catches a malformed mesh reference', () => {
  assert.ok(paths((m) => { m.parts[0].mesh = 'body'; }).includes('parts[0].mesh'));
});

test('catches a colour option painting an unknown part', () => {
  assert.ok(paths((m) => { m.options[0].parts = ['nonexistent']; }).includes('options[0].parts[0]'));
});

test('catches a default that is not in the palette', () => {
  assert.ok(paths((m) => { m.options[0].default = 'chartreuse'; }).includes('options[0].default'));
});

test('catches an unknown palette', () => {
  assert.ok(paths((m) => { m.options[0].palette = 'ghost'; }).includes('options[0].palette'));
});

test('catches duplicate ids', () => {
  assert.ok(paths((m) => { m.parts[1].id = m.parts[0].id; }).includes('parts[1].id'));
  assert.ok(paths((m) => { m.palettes[0].swatches[1].id = m.palettes[0].swatches[0].id; })
    .includes('palettes[0].swatches[1].id'));
});

test('catches a bad hex', () => {
  assert.ok(paths((m) => { m.palettes[0].swatches[0].hex = 'FEFEFE'; }).includes('palettes[0].swatches[0].hex'));
});

test('catches a part anchored to itself', () => {
  const p = paths((m) => {
    const text = m.parts.find((x: any) => x.id === 'text');
    text.placement.x.to = 'text:center';
  });
  assert.ok(p.includes('parts[4].placement.x.to'));
});

test('catches a placement anchor cycle', () => {
  const errs = validateManifest((() => {
    const m = base();
    m.parts[0].placement = { y: { align: 'min', to: 'sleeves:max', offset: 0 } };
    m.parts[1].placement = { y: { align: 'min', to: 'body:max', offset: 0 } };
    return m;
  })()).errors;
  assert.ok(errs.some((e) => e.message.includes('cycle')), JSON.stringify(errs));
});

test('catches a colour link cycle', () => {
  const errs = validateManifest((() => {
    const m = base();
    m.options.find((o: any) => o.id === 'sleeve-colour').linkedTo = 'text-colour';
    return m;
  })()).errors;
  assert.ok(errs.some((e) => e.message.includes('cycle')), JSON.stringify(errs));
});

test('catches an anchor edge that is not min/center/max', () => {
  assert.ok(paths((m) => {
    m.parts.find((x: any) => x.id === 'text').placement.y.to = 'body:bottom';
  }).includes('parts[4].placement.y.to'));
});

test('a "used" colour option cannot also allow custom colours', () => {
  // The text can only match a finish already on the product; inventing a
  // sixth colour there would silently add an unpriced filament change.
  assert.ok(paths((m) => {
    m.options.find((o: any) => o.id === 'text-colour').custom = { allowed: true, priceDelta: 35 };
  }).includes('options[4].custom'));
});

test('catches a choice default that is not one of the choices', () => {
  const i = base().options.findIndex((o) => o.id === 'stand');
  assert.ok(paths((m) => { m.options[i].default = 'walnut'; }).includes(`options[${i}].default`));
});

test('catches visibleWhen pointing at an unknown option', () => {
  assert.ok(paths((m) => {
    m.parts[0].visibleWhen = { option: 'ghost', equals: ['x'] };
  }).includes('parts[0].visibleWhen.option'));
});

test('catches a visibleWhen that can never be true', () => {
  assert.ok(paths((m) => {
    m.parts[0].visibleWhen = { option: 'stand', equals: [] };
  }).includes('parts[0].visibleWhen.equals'));
});

test('rejects a non-positive scale', () => {
  assert.ok(paths((m) => {
    m.parts[0].placement = { scale: [1, 0, 1] };
  }).includes('parts[0].placement.scale'));
});

test('warns, but does not fail, on an unknown option type', () => {
  const m = base();
  (m.options as any[]).push({ id: 'engraving', type: 'hologram', label: 'Hologram' });
  const r = validateManifest(m);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.message.includes('hologram')));
});

test('warns about a part nothing can colour', () => {
  const m = base();
  (m.parts as any[]).push({ id: 'trim', label: 'Trim', mesh: 'bar#body' });
  const r = validateManifest(m);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.message.includes('"trim"')));
});

test('a part with fixedColour draws no warning', () => {
  const m = base();
  (m.parts as any[]).push({ id: 'trim', label: 'Trim', mesh: 'bar#body', material: { fixedColour: '#C0C0C0' } });
  assert.ok(!validateManifest(m).warnings.some((w) => w.message.includes('"trim"')));
});

test('assertManifest throws with every error listed', () => {
  const m = base();
  (m as any).id = '';
  (m as any).name = '';
  assert.throws(() => assertManifest(m), (e: Error) => e.message.includes('id') && e.message.includes('name'));
});

test('rejects junk input without throwing', () => {
  for (const junk of [null, undefined, 42, 'manifest', []]) {
    assert.equal(validateManifest(junk).ok, false);
  }
});
