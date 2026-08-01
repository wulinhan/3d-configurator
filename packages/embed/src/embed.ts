// The embed: a manifest in, a configurator out.
//
// Everything the panel shows is derived from the manifest — there is no
// per-product code here, which is the whole point. Selections are posted to
// the host page on every change so the merchant's cart can price them.

import type { Manifest, ColourOption, ChoiceOption, Option } from './manifest/types.ts';
import { validateManifest } from './manifest/validate.ts';
import { Viewer } from './runtime/viewer.ts';
import {
  defaultSelections, resolveValue, resolveColour, coloursInUse, buildPayload,
  visibleParts, isOptionActive,
  type Selections,
} from './runtime/state.ts';

const isColour = (o: Option): o is ColourOption => o.type === 'colour';
const isChoice = (o: Option): o is ChoiceOption => o.type === 'choice';
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

export interface MountOptions {
  root: HTMLElement;
  manifest: Manifest;
  baseUrl?: string;
  /** Where selection changes are posted. Defaults to the parent frame. */
  target?: Window;
}

export async function mount(opts: MountOptions) {
  const { ok, errors, warnings } = validateManifest(opts.manifest);
  for (const w of warnings) console.warn(`[configurator] ${w.path}: ${w.message}`);
  if (!ok) {
    opts.root.append(el('div', 'cfg-error',
      `This product can't be configured: ${errors.map((e) => `${e.path} ${e.message}`).join('; ')}`));
    throw new Error('invalid manifest');
  }

  const manifest = opts.manifest;
  const selections: Selections = defaultSelections(manifest);
  const brand = manifest.brand ?? {};

  opts.root.classList.add('cfg');
  opts.root.style.setProperty('--cfg-accent', brand.accent ?? '#1A1A1A');
  opts.root.style.setProperty('--cfg-surface', brand.surface ?? '#F8F6F1');
  opts.root.style.setProperty('--cfg-ink', brand.ink ?? '#333333');
  opts.root.style.setProperty('--cfg-radius', `${brand.radius ?? 8}px`);
  if (brand.fontFamily) opts.root.style.setProperty('--cfg-font', brand.fontFamily);

  const stage = el('div', 'cfg-stage');
  const canvas = document.createElement('canvas');
  stage.append(canvas);
  const panel = el('aside', 'cfg-panel');
  opts.root.append(stage, panel);

  const viewer = new Viewer({
    canvas,
    manifest,
    resolveUrl: (u) => (opts.baseUrl ? new URL(u, opts.baseUrl).href : u),
    onSelectPart: (partId) => {
      // A part whose visibility hangs on a choice (a variant, an add-on) opens
      // that choice — clicking the thing you might swap shows the swap. Any
      // other part selects whichever option paints it.
      const part = manifest.parts.find((p) => p.id === partId);
      const gate = part?.visibleWhen
        && manifest.options.find((o) => o.id === part.visibleWhen!.option && isChoice(o));
      if (gate) { select(gate.id); return; }
      const option = manifest.options.find((o) => isColour(o) && o.parts.includes(partId!));
      if (option) select(option.id);
    },
  });

  const loading = el('div', 'cfg-loading', 'Loading…');
  stage.append(loading);
  await viewer.load();
  loading.remove();

  const fit = () => viewer.resize(stage.clientWidth, stage.clientHeight);
  new ResizeObserver(fit).observe(stage);
  fit();
  viewer.start();

  // ── panel ─────────────────────────────────────────────────────────────────
  let active = manifest.options.find(isColour)?.id ?? manifest.options[0]?.id ?? '';

  const tabs = el('div', 'cfg-tabs');
  const body = el('div', 'cfg-body');
  const summary = el('div', 'cfg-summary');
  panel.append(tabs, body, summary);

  const select = (optionId: string) => { active = optionId; render(); };

  const change = (optionId: string, value: string) => {
    selections[optionId] = value;
    // A linked option follows until the customer picks for it directly, so
    // changing the target refreshes the follower for free.
    viewer.apply(selections);
    render();
    post();
  };

  const post = () => {
    const payload = buildPayload(manifest, selections);
    (opts.target ?? window.parent)?.postMessage(payload, '*');
    opts.root.dispatchEvent(new CustomEvent('configurator:change', { detail: payload, bubbles: true }));
  };

  function swatchButton(hex: string, label: string, selected: boolean, onClick: () => void) {
    const b = el('button', `cfg-swatch${selected ? ' is-selected' : ''}`);
    b.type = 'button';
    b.style.background = hex;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }

  function renderColour(option: ColourOption) {
    const current = resolveValue(manifest, selections, option.id);
    const resolved = resolveColour(manifest, selections, option);

    if (option.source === 'used') {
      body.append(el('p', 'cfg-note',
        `${option.label} matches a colour already on your product — pick which one.`));
      const grid = el('div', 'cfg-grid');
      for (const c of coloursInUse(manifest, selections)) {
        grid.append(swatchButton(c.hex, c.name, resolved?.hex === c.hex, () => change(option.id, c.id)));
      }
      body.append(grid);
      return;
    }

    const palette = manifest.palettes?.find((p) => p.id === option.palette);
    const grid = el('div', 'cfg-grid');
    for (const s of palette?.swatches ?? []) {
      if (s.available === false) continue;
      const label = s.priceDelta ? `${s.name} (+${money(s.priceDelta)})` : s.name;
      grid.append(swatchButton(s.hex, label, !resolved?.custom && current === s.id, () => change(option.id, s.id)));
    }
    body.append(grid);

    if (!option.custom?.allowed) return;

    const wrap = el('div', 'cfg-custom');
    const toggle = el('button', `cfg-custom-btn${resolved?.custom ? ' is-open' : ''}`);
    toggle.type = 'button';
    toggle.append(
      el('span', undefined, resolved?.custom ? '− Custom Colour' : '+ Custom Colour'),
      el('span', 'cfg-custom-price', option.custom.priceLabel
        ?? (option.custom.priceDelta ? `+${money(option.custom.priceDelta)} per custom colour` : '')),
    );

    const fields = el('div', 'cfg-custom-fields');
    fields.hidden = !resolved?.custom;

    const hex = document.createElement('input');
    hex.type = 'text';
    hex.className = 'cfg-hex';
    hex.maxLength = 6;
    hex.placeholder = 'e.g. FF5733';
    hex.value = (resolved?.custom ? resolved.hex : resolved?.hex ?? '#FFFFFF').replace('#', '');

    const native = document.createElement('input');
    native.type = 'color';
    native.className = 'cfg-native';
    native.value = resolved?.hex ?? '#FFFFFF';

    hex.addEventListener('input', () => {
      const v = hex.value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
      hex.value = v;
      if (v.length === 6) change(option.id, `#${v}`);
    });
    native.addEventListener('input', () => change(option.id, native.value.toUpperCase()));

    toggle.addEventListener('click', () => {
      if (resolved?.custom) {
        // Closing reverts to the manifest default rather than leaving the
        // customer on a colour the panel is no longer showing.
        change(option.id, option.default);
      } else {
        fields.hidden = false;
        toggle.classList.add('is-open');
        hex.focus();
      }
    });

    const row = el('div', 'cfg-hex-row');
    const hash = el('span', 'cfg-hash', '#');
    row.append(hash, hex, native);
    fields.append(row);
    wrap.append(toggle, fields);
    body.append(wrap);
  }

  function renderChoice(option: ChoiceOption) {
    const current = resolveValue(manifest, selections, option.id);
    const list = el('div', 'cfg-choices');
    for (const c of option.choices) {
      if (c.available === false) continue;
      const b = el('button', `cfg-choice${current === c.id ? ' is-selected' : ''}`);
      b.type = 'button';
      b.append(el('span', undefined, c.label));
      if (c.priceDelta) b.append(el('span', 'cfg-choice-price', `+${money(c.priceDelta)}`));
      b.addEventListener('click', () => change(option.id, c.id));
      list.append(b);
    }
    body.append(list);
  }

  const money = (n: number) =>
    new Intl.NumberFormat('en-SG', { style: 'currency', currency: manifest.pricing.currency, minimumFractionDigits: 0 })
      .format(n);

  function render() {
    tabs.replaceChildren();
    body.replaceChildren();
    summary.replaceChildren();

    // Only options that currently do something get a tab: the un-picked side
    // of a variant set is either-or everywhere, panel included.
    const visible = visibleParts(manifest, selections);
    const activeOptions = manifest.options.filter((o) => isOptionActive(manifest, selections, o, visible));

    // A variant set and its members' colours are ONE decision — "which tile,
    // and in what colour" — so colour options that only paint members fold
    // into the set's tab, which reads "Tile (Mail)". Picking a member and
    // its colour happens in the same place.
    const foldedColours = new Set<string>();
    const folds = new Map<string, { colour?: ColourOption; memberLabel: string }>();
    for (const v of manifest.options) {
      if (!isChoice(v) || v.role !== 'variant') continue;
      const memberIds = new Set(v.choices.map((c) => c.id));
      const current = resolveValue(manifest, selections, v.id);
      const memberLabel = v.choices.find((c) => c.id === current)?.label ?? '';
      let colour: ColourOption | undefined;
      for (const o of manifest.options) {
        if (!isColour(o) || !o.parts.length || !o.parts.every((p) => memberIds.has(p))) continue;
        foldedColours.add(o.id);
        if (o.parts.some((p) => visible.has(p))) colour = o;
      }
      folds.set(v.id, { colour, memberLabel });
    }

    const tabbed = activeOptions.filter((o) => !foldedColours.has(o.id));
    if (!tabbed.some((o) => o.id === active) && !foldedColours.has(active)) {
      active = tabbed.find(isColour)?.id ?? tabbed[0]?.id ?? '';
    } else if (foldedColours.has(active)) {
      // The colour the customer was on folded into its set's tab — follow it.
      active = [...folds.entries()].find(([, f]) => f.colour?.id === active)?.[0] ?? tabbed[0]?.id ?? '';
    }

    for (const option of tabbed) {
      const tab = el('button', `cfg-tab${option.id === active ? ' is-active' : ''}`);
      tab.type = 'button';
      const fold = folds.get(option.id);
      const dotColour = fold?.colour
        ? resolveColour(manifest, selections, fold.colour)?.hex
        : isColour(option) ? resolveColour(manifest, selections, option)?.hex : undefined;
      if (dotColour !== undefined) {
        const dot = el('span', 'cfg-dot');
        dot.style.background = dotColour ?? '#CCC';
        tab.append(dot);
      }
      tab.append(el('span', undefined, fold?.memberLabel ? `${option.label} (${fold.memberLabel})` : option.label));
      tab.addEventListener('click', () => select(option.id));
      tabs.append(tab);
    }

    const option = manifest.options.find((o) => o.id === active);
    if (option && isColour(option)) renderColour(option);
    else if (option && isChoice(option)) {
      renderChoice(option);
      const fold = folds.get(option.id);
      if (fold?.colour) renderColour(fold.colour);
    }

    viewer.highlight(option && isColour(option) ? option.parts[0] : null);

    // Summary — the same lines that end up on the order. Folded colours are
    // named after their set and member: "Tile (Mail)".
    const payload = buildPayload(manifest, selections);
    summary.append(el('div', 'cfg-summary-label', 'Your configuration'));
    for (const o of activeOptions) {
      if (!isColour(o)) continue;
      let label = o.label;
      if (foldedColours.has(o.id)) {
        const owner = [...folds.entries()].find(([, f]) => f.colour?.id === o.id);
        if (owner) label = `${manifest.options.find((x) => x.id === owner[0])?.label} (${owner[1].memberLabel})`;
      }
      const row = el('div', 'cfg-summary-row');
      const dot = el('span', 'cfg-dot');
      dot.style.background = resolveColour(manifest, selections, o)?.hex ?? '#CCC';
      row.append(dot, el('span', 'cfg-summary-part', label),
        el('span', 'cfg-summary-value', payload.colourNames[o.id] ?? '—'));
      summary.append(row);
    }
    for (const d of payload.priceDeltas) {
      const row = el('div', 'cfg-summary-row cfg-summary-delta');
      row.append(el('span', 'cfg-summary-part', d.label), el('span', 'cfg-summary-value', `+${money(d.amount)}`));
      summary.append(row);
    }
  }

  viewer.apply(selections);
  render();
  post();

  return { viewer, selections, manifest, post };
}

/** Auto-mount when the page carries `<div data-configurator="…manifest.json">`. */
export async function autoMount() {
  const host = document.querySelector<HTMLElement>('[data-configurator]');
  if (!host) return;
  const url = host.dataset.configurator!;
  const manifest: Manifest = await fetch(url).then((r) => r.json());
  return mount({ root: host, manifest, baseUrl: new URL(url, location.href).href });
}
