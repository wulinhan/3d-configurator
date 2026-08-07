// Selection resolution and surcharge arithmetic.
//
// This is what the merchant's cart charges against, so the custom-colour
// rules get the most attention: charging per part instead of per colour
// overcharges a customer who picks the same bespoke shade twice, and missing
// a link means the wrong colour reaches the print queue.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  defaultSelections, resolveValue, resolveColour, partColours, visibleParts,
  coloursInUse, priceDeltas, buildPayload, isCustomColour, isOptionActive,
  applySelection, parseUploadState,
} from '../src/runtime/state.ts';
import type { Manifest, ColourOption } from '../src/manifest/types.ts';

const DEMO = new URL('../../../apps/demo/tap-bar-3.manifest.json', import.meta.url);
const load = (): Manifest => JSON.parse(readFileSync(DEMO, 'utf8'));
const colourOption = (m: Manifest, id: string) => m.options.find((o) => o.id === id) as ColourOption;

test('defaults come straight from the manifest', () => {
  const m = load();
  const s = defaultSelections(m);
  assert.equal(s['body-colour'], 'jade-white');
  assert.equal(s['sleeve-colour'], 'black');
  assert.equal(s['text-colour'], '@sleeve-colour');
  assert.equal(s['stand'], 'none');
});

test('a linked option follows the option it points at', () => {
  const m = load();
  const s = defaultSelections(m);
  assert.equal(resolveValue(m, s, 'text-colour'), 'black');

  s['sleeve-colour'] = 'teal';
  assert.equal(resolveValue(m, s, 'text-colour'), 'teal', 'text should still be following the sleeves');
});

test('picking a value explicitly breaks the link', () => {
  const m = load();
  const s = defaultSelections(m);
  s['text-colour'] = 'red';
  s['sleeve-colour'] = 'teal';
  assert.equal(resolveValue(m, s, 'text-colour'), 'red');
});

test('a swatch id resolves to hex and its name', () => {
  const m = load();
  const c = resolveColour(m, defaultSelections(m), colourOption(m, 'sleeve-colour'))!;
  assert.equal(c.hex, '#1A1A1A');
  assert.equal(c.name, 'Black');
  assert.equal(c.custom, false);
});

test('a hex value is treated as a custom colour and normalised to upper case', () => {
  const m = load();
  const s = defaultSelections(m);
  s['body-colour'] = '#ff5733';
  const c = resolveColour(m, s, colourOption(m, 'body-colour'))!;
  assert.equal(c.hex, '#FF5733');
  assert.equal(c.custom, true);
  assert.ok(isCustomColour('#FF5733'));
  assert.ok(!isCustomColour('jade-white'));
});

test('every part a colour option names gets painted', () => {
  const m = load();
  const colours = partColours(m, defaultSelections(m));
  assert.equal(colours.get('body')!.hex, '#FEFEFE');
  assert.equal(colours.get('sleeves')!.hex, '#1A1A1A');
  assert.equal(colours.get('text')!.hex, '#1A1A1A', 'text follows the sleeves');
  assert.equal(colours.size, m.parts.length);
});

test('a fixedColour part is painted without any option', () => {
  const m = load();
  (m.parts as any[]).push({ id: 'trim', label: 'Trim', mesh: 'bar#body', material: { fixedColour: '#C0C0C0' } });
  assert.equal(partColours(m, defaultSelections(m)).get('trim')!.hex, '#C0C0C0');
});

test('colours in use are deduped and exclude the "used" option itself', () => {
  const m = load();
  const s = defaultSelections(m);
  // body and tiles both default to Jade White, icons and sleeves both to Black
  const used = coloursInUse(m, s);
  assert.deepEqual(used.map((c) => c.hex).sort(), ['#1A1A1A', '#FEFEFE']);

  s['tile-colour'] = 'teal';
  assert.equal(coloursInUse(m, s).length, 3);
});

test('no surcharge for a stock configuration', () => {
  const m = load();
  assert.deepEqual(priceDeltas(m, defaultSelections(m)), []);
});

test('a choice add-on adds its delta', () => {
  const m = load();
  const s = defaultSelections(m);
  s['stand'] = 'oak';
  const d = priceDeltas(m, s);
  assert.equal(d.length, 1);
  assert.equal(d[0].amount, 24);
  assert.match(d[0].label, /Oak stand/);
});

test('a custom colour is charged once', () => {
  const m = load();
  const s = defaultSelections(m);
  s['body-colour'] = '#FF5733';
  const d = priceDeltas(m, s);
  assert.equal(d.length, 1);
  assert.equal(d[0].amount, 35);
});

test('the same custom colour on two parts is one filament change, not two', () => {
  const m = load();
  const s = defaultSelections(m);
  s['body-colour'] = '#FF5733';
  s['tile-colour'] = '#ff5733';   // same colour, different case
  const d = priceDeltas(m, s);
  assert.equal(d.length, 1, JSON.stringify(d));
  assert.equal(d[0].amount, 35);
  assert.match(d[0].label, /Body/);
  assert.match(d[0].label, /Tiles/);
});

test('two different custom colours are charged twice', () => {
  const m = load();
  const s = defaultSelections(m);
  s['body-colour'] = '#FF5733';
  s['tile-colour'] = '#00A0B0';
  const d = priceDeltas(m, s);
  assert.equal(d.length, 2);
  assert.equal(d.reduce((n, x) => n + x.amount, 0), 70);
});

test('a custom colour on an option that forbids it is not charged', () => {
  const m = load();
  const s = defaultSelections(m);
  s['text-colour'] = '#FF5733';   // text-colour has custom.allowed === false
  assert.deepEqual(priceDeltas(m, s), []);
});

test('when options price custom colours differently, the dearest wins', () => {
  const m = load();
  colourOption(m, 'tile-colour').custom!.priceDelta = 12;
  const s = defaultSelections(m);
  s['body-colour'] = '#FF5733';
  s['tile-colour'] = '#FF5733';
  const d = priceDeltas(m, s);
  assert.equal(d.length, 1);
  assert.equal(d[0].amount, 35, 'the cheap surface must not buy a bespoke colour for the dear one');
});

test('a swatch-level surcharge is picked up', () => {
  const m = load();
  m.palettes![0].swatches.find((sw) => sw.id === 'teal')!.priceDelta = 6;
  const s = defaultSelections(m);
  s['body-colour'] = 'teal';
  assert.equal(priceDeltas(m, s)[0].amount, 6);
});

test('visibleWhen gates a part on a choice', () => {
  const m = load();
  (m.parts as any[]).push({
    id: 'stand-mesh', label: 'Stand', mesh: 'bar#body',
    visibleWhen: { option: 'stand', equals: ['oak', 'steel'] },
  });
  const s = defaultSelections(m);
  assert.ok(!visibleParts(m, s).has('stand-mesh'));
  s['stand'] = 'steel';
  assert.ok(visibleParts(m, s).has('stand-mesh'));
});

test('an option whose parts are all hidden is inert — no panel slot, no charge', () => {
  // The un-picked side of a pick-one set must be either-or EVERYWHERE:
  // its colour option disappears from the panel and its surcharges drop.
  const m = load();
  const bodyOpt = colourOption(m, 'body-colour');
  m.options.push({
    id: 'style', type: 'choice', role: 'variant', label: 'Style',
    choices: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], default: 'no',
  });
  for (const part of m.parts) {
    if (bodyOpt.parts.includes(part.id)) part.visibleWhen = { option: 'style', equals: ['yes'] };
  }
  const s = defaultSelections(m);
  s['body-colour'] = '#FF5733'; // a paid custom colour on the hidden side

  const visible = visibleParts(m, s);
  assert.equal(isOptionActive(m, s, bodyOpt, visible), false, 'hidden side is inert');
  assert.equal(isOptionActive(m, s, colourOption(m, 'sleeve-colour'), visible), true);
  assert.equal(isOptionActive(m, s, m.options.find((o) => o.id === 'style')!, visible), true,
    'the choice itself stays live — it is how you switch');
  assert.ok(!priceDeltas(m, s).some((d) => d.optionId.includes('body-colour')),
    'the hidden side never charges');

  s['style'] = 'yes';
  assert.equal(isOptionActive(m, s, bodyOpt), true);
  assert.ok(priceDeltas(m, s).some((d) => d.optionId.includes('body-colour')),
    'and charges again once picked');
});

test('switching a variant set carries the chosen colour to the incoming member', () => {
  const m = load();
  // body and sleeves become a two-member variant set, each with its own
  // colour option (they already have body-colour / sleeve-colour).
  const bodyParts = colourOption(m, 'body-colour').parts;
  const sleeveParts = colourOption(m, 'sleeve-colour').parts;
  m.options.push({
    id: 'style', type: 'choice', role: 'variant', label: 'Style',
    choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], default: 'a',
  });
  for (const part of m.parts) {
    if (bodyParts.includes(part.id)) part.visibleWhen = { option: 'style', equals: ['a'] };
    if (sleeveParts.includes(part.id)) part.visibleWhen = { option: 'style', equals: ['b'] };
  }
  const s = defaultSelections(m);
  applySelection(m, s, 'body-colour', 'red');
  applySelection(m, s, 'style', 'b');
  assert.equal(s['sleeve-colour'], 'red', 'the colour followed the switch');
  applySelection(m, s, 'sleeve-colour', 'teal');
  applySelection(m, s, 'style', 'a');
  assert.equal(s['body-colour'], 'teal', 'and follows back the other way');
});

test('the payload carries resolved values, names and an itemised total', () => {
  const m = load();
  const s = defaultSelections(m);
  s['sleeve-colour'] = 'teal';
  s['body-colour'] = '#FF5733';
  s['stand'] = 'oak';

  const p = buildPayload(m, s);
  assert.equal(p.type, 'configurator:change');
  assert.equal(p.productId, m.id);
  assert.equal(p.currency, 'SGD');
  assert.equal(p.selections['text-colour'], 'teal', 'links are resolved, not passed through');
  assert.equal(p.colourNames['sleeve-colour'], 'Teal');
  assert.equal(p.colourNames['body-colour'], '#FF5733');
  assert.equal(p.deltaTotal, 59);
  assert.equal(p.priceDeltas.reduce((n, d) => n + d.amount, 0), p.deltaTotal);
});

test('deltaTotal does not accumulate floating-point dust', () => {
  const m = load();
  const stand = m.options.find((o) => o.id === 'stand') as any;
  stand.choices[1].priceDelta = 0.1;
  stand.choices[2].priceDelta = 0.2;
  colourOption(m, 'body-colour').custom!.priceDelta = 0.2;
  const s = defaultSelections(m);
  s['stand'] = 'oak';
  s['body-colour'] = '#FF5733';
  assert.equal(buildPayload(m, s).deltaTotal, 0.3);
});

test('a link cycle resolves to empty instead of recursing forever', () => {
  const m = load();
  const s = defaultSelections(m);
  s['body-colour'] = '@tile-colour';
  s['tile-colour'] = '@body-colour';
  assert.equal(resolveValue(m, s, 'body-colour'), '');
  assert.doesNotThrow(() => buildPayload(m, s));
});

test('parseUploadState decodes only real artwork, clamping size', () => {
  assert.equal(parseUploadState(''), null);
  assert.equal(parseUploadState(undefined), null);
  assert.equal(parseUploadState('not json'), null);
  assert.equal(parseUploadState(JSON.stringify({ img: 'javascript:alert(1)' })), null);
  assert.equal(parseUploadState(JSON.stringify({ img: 'http://api.example.com/u/x' })), null,
    'http would be a picture fetched in the clear');

  // A remote image is legal only from the product's OWN upload service, so
  // callers holding the manifest pass its host: a stranger's URL is refused,
  // and with no service configured no remote image is legal at all.
  const hosted = JSON.stringify({ img: 'https://api.example.com/u/upl_1', up: 'upl_1' });
  assert.equal(parseUploadState(hosted, 'api.example.com')!.up, 'upl_1');
  assert.equal(parseUploadState(hosted, 'evil.example'), null);
  assert.equal(parseUploadState(hosted, ''), null);

  const state = parseUploadState(JSON.stringify({ img: 'data:image/png;base64,AAAA', u: 2, v: -3, s: 400 }))!;
  assert.equal(state.u, 2);
  assert.equal(state.v, -3);
  assert.equal(state.s, 400, 'crop-zoom beyond 100% is allowed');
  const huge = parseUploadState(JSON.stringify({ img: 'data:image/png;base64,AAAA', s: 900 }))!;
  assert.equal(huge.s, 500, 'size clamps to 500%');
  const tiny = parseUploadState(JSON.stringify({ img: 'data:image/jpeg;base64,AAAA', s: 1 }))!;
  assert.equal(tiny.s, 10, 'size clamps to 10%');
  assert.equal(tiny.u, 0, 'missing offsets default to centre');
});

test('applySelection clamps an upload offset to the zone bounds', () => {
  const m = load();
  (m.options as any[]).push({
    id: 'body-image', type: 'upload', label: 'Body image', part: 'body',
    origin: [0, 0, 0], normal: [0, 0, 1], widthMm: 40, heightMm: 30, priceDelta: 8,
  });
  const s = defaultSelections(m);
  assert.equal(s['body-image'], '');

  // Sanity bound is ±2× the zone dimensions — room for crop-zoom panning;
  // the renderer clamps to the exact slack.
  applySelection(m, s, 'body-image', JSON.stringify({ img: 'data:image/png;base64,AAAA', u: 100, v: -100, s: 50 }));
  const state = parseUploadState(s['body-image'])!;
  assert.equal(state.u, 80);
  assert.equal(state.v, -60);
  assert.equal(state.s, 50);
  const d = priceDeltas(m, s).filter((x) => x.optionId === 'body-image');
  assert.equal(d.length, 1);
  assert.equal(d[0].amount, 8);

  applySelection(m, s, 'body-image', 'garbage');
  assert.equal(s['body-image'], '', 'garbage clears the selection');
});
