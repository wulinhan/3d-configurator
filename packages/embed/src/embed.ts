// The embed: a manifest in, a configurator out.
//
// Everything the panel shows is derived from the manifest — there is no
// per-product code here, which is the whole point. Selections are posted to
// the host page on every change so the merchant's cart can price them.

import type { Manifest, ColourOption, ChoiceOption, TextOption, UploadOption, Option } from './manifest/types.ts';
import { validateManifest } from './manifest/validate.ts';
import { Viewer } from './runtime/viewer.ts';
import {
  defaultSelections, resolveValue, resolveColour, coloursInUse, buildPayload,
  visibleParts, isOptionActive, applySelection, parseUploadState, textColourKey, textColourChoices,
  zonePlaceholder,
  type Selections,
} from './runtime/state.ts';

/**
 * Shrink a customer's file to something a product page can carry: downscaled
 * to ≤1024 px, PNG kept for transparency, anything over budget re-encoded as
 * JPEG at falling quality.
 *
 * Returns a data: URL because that is what the no-backend deployment stores.
 * When the manifest names an upload service, `sendUploadImage` posts these
 * bytes instead and the selection carries an id — see below.
 */
async function encodeUploadImage(file: File, maxBytes: number): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('unreadable image'));
      i.src = url;
    });
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1024 / Math.max(img.width, img.height, 1));
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    let out = file.type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85);
    // base64 carries ~3/4 byte per character.
    for (let q = 0.8; out.length * 0.75 > maxBytes && q >= 0.35; q -= 0.15) {
      out = canvas.toDataURL('image/jpeg', q);
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A data: URL back to the bytes it encodes, so the same downscaling serves
 * both deployments. */
function bytesOfDataUrl(dataUrl: string): { bytes: Uint8Array; type: string } {
  const comma = dataUrl.indexOf(',');
  const type = dataUrl.slice(5, dataUrl.indexOf(';'));
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, type };
}

/**
 * Hand the artwork to the service and keep only its id.
 *
 * This is the difference between a cart line item of a few dozen characters
 * and one of a megabyte: a data: URL cannot survive a checkout — most carts
 * cap a line-item property at 255 characters — so wherever an upload service
 * is configured, the image goes there and the order carries a pointer.
 */
async function sendUploadImage(
  service: { url: string; publication: string }, optionId: string, dataUrl: string,
): Promise<{ id: string; url: string }> {
  const { bytes, type } = bytesOfDataUrl(dataUrl);
  const endpoint = `${service.url}?publication=${encodeURIComponent(service.publication)}`
    + `&option=${encodeURIComponent(optionId)}`;
  const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': type }, body: bytes });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error((detail as { message?: string }).message ?? 'upload failed');
  }
  return await res.json() as { id: string; url: string };
}

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
  // Present when the manifest came from the hosted service, absent when the
  // merchant is serving the two files themselves. It is what decides whether
  // artwork travels as an id or as a data: URL — see sendUploadImage.
  const uploads = manifest.uploads;

  opts.root.classList.add('cfg');
  opts.root.style.setProperty('--cfg-accent', brand.accent ?? '#1A1A1A');
  opts.root.style.setProperty('--cfg-surface', brand.surface ?? '#FFFFFF');
  opts.root.style.setProperty('--cfg-ink', brand.ink ?? '#333333');
  opts.root.style.setProperty('--cfg-radius', `${brand.radius ?? 8}px`);
  if (brand.fontFamily) opts.root.style.setProperty('--cfg-font', brand.fontFamily);

  const stage = el('div', 'cfg-stage');
  const canvas = document.createElement('canvas');
  stage.append(canvas);
  // The marketing-site shape: viewport on top; below it one bordered box
  // with the PART LIST down the left and the active part's controls on the
  // right; the running summary as pills across the bottom.
  const panel = el('aside', 'cfg-panel');
  const config = el('div', 'cfg-config');
  const rail = el('div', 'cfg-rail');
  const editor = el('div', 'cfg-editor');
  opts.root.append(stage, panel);

  const viewer = new Viewer({
    canvas,
    manifest,
    // A growing per-letter run keeps its centre of mass on the origin,
    // easing there — the customer's product grows outward from the middle.
    centreTextRuns: true,
    // Unless the merchant saved a view, the product opens centred on the
    // origin and fully in frame, whatever coordinates it was authored at.
    centreOnOrigin: true,
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
  const editorLabel = el('div', 'cfg-editor-label');
  rail.append(el('div', 'cfg-rail-label', 'Select part'), tabs);
  editor.append(editorLabel, body);
  config.append(rail, editor);
  panel.append(config, summary);

  const select = (optionId: string) => { active = optionId; render(); };

  const change = (optionId: string, value: string) => {
    // applySelection also carries a variant set's colour to the incoming
    // member; a linked option follows until the customer picks directly.
    applySelection(manifest, selections, optionId, value);
    viewer.apply(selections);
    render();
    post();
  };

  const post = () => {
    const payload = buildPayload(manifest, selections);
    (opts.target ?? window.parent)?.postMessage(payload, '*');
    opts.root.dispatchEvent(new CustomEvent('configurator:change', { detail: payload, bubbles: true }));
  };

  function swatchButton(hex: string, label: string, selected: boolean, onClick: () => void, caption?: string) {
    const b = el('button', `cfg-swatch${selected ? ' is-selected' : ''}`);
    b.type = 'button';
    b.style.background = hex;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    // The name sits under the circle — a colour called "Rosewood" should not
    // make the customer hover to find that out.
    const cell = el('span', 'cfg-swatch-cell');
    cell.append(b, el('span', 'cfg-swatch-name', caption ?? label));
    return cell;
  }

  /** What a swatch paints on screen: its colour, or its blend. */
  function swatchCss(sw: { hex: string; hex2?: string; gradientAxis?: string }): string {
    if (!sw.hex2) return sw.hex;
    const dir = { x: 'to right', y: 'to top', z: '135deg' }[sw.gradientAxis ?? 'y'] ?? 'to top';
    return `linear-gradient(${dir}, ${sw.hex}, ${sw.hex2})`;
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
      grid.append(swatchButton(swatchCss(s), label, !resolved?.custom && current === s.id,
        () => change(option.id, s.id), label));
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

  function renderText(option: TextOption) {
    const max = option.maxLength ?? 20;
    const wrap = el('div', 'cfg-text');

    if (option.perChar) wrap.append(el('p', 'cfg-note', 'Each letter becomes its own piece.'));
    const priceBits: string[] = [];
    if (option.priceDelta) priceBits.push(`+${money(option.priceDelta)}`);
    if (option.pricePerChar) priceBits.push(`+${money(option.pricePerChar)} per ${option.perChar ? 'piece' : 'character'}`);
    if (priceBits.length) wrap.append(el('p', 'cfg-note', priceBits.join(', ')));

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cfg-text-input';
    input.maxLength = max;
    input.placeholder = option.placeholder ?? 'Your text';
    input.value = selections[option.id] ?? '';
    input.setAttribute('aria-label', option.label);

    const count = el('span', 'cfg-text-count', `${input.value.length}/${max}`);

    // Typing must not rebuild the panel — a re-render would replace the input
    // mid-word and drop the keyboard focus. The model, the summary and the
    // host payload update; the input stays the customer's.
    input.addEventListener('input', () => {
      applySelection(manifest, selections, option.id, input.value);
      if (input.value !== selections[option.id]) input.value = selections[option.id];
      count.textContent = `${input.value.length}/${max}`;
      viewer.apply(selections);
      renderSummary();
      post();
    });

    const row = el('div', 'cfg-text-row');
    row.append(input, count);
    wrap.append(row);

    // When the merchant opened the colour up, the customer picks the text's
    // finish from the product's palette. The first, swatch-less button hands
    // it back to the carrier part — what a locked slot always does.
    if (option.customerColour) {
      const key = textColourKey(option.id);
      const chosen = selections[key] ?? '';
      const grid = el('div', 'cfg-grid');
      const pickColour = (value: string) => {
        applySelection(manifest, selections, key, value);
        viewer.apply(selections);
        render();
        post();
      };
      // The merchant's own colour is the slot's default; the first button
      // hands the text back to it.
      const asAuthored = option.colourHex ?? '';
      const match = el('button', `cfg-swatch${asAuthored ? '' : ' cfg-swatch-match'}${chosen ? '' : ' is-selected'}`);
      match.type = 'button';
      if (asAuthored) match.style.background = asAuthored;
      match.title = asAuthored ? 'As designed' : 'Same as the part';
      match.setAttribute('aria-label', match.title);
      match.addEventListener('click', () => pickColour(''));
      const matchCell = el('span', 'cfg-swatch-cell');
      matchCell.append(match, el('span', 'cfg-swatch-name', match.title));
      grid.append(matchCell);
      const offered = textColourChoices(manifest, option);
      for (const sw of manifest.palettes?.flatMap((p) => p.swatches) ?? []) {
        if (sw.available === false || !offered.includes(sw.hex.toUpperCase())) continue;
        grid.append(swatchButton(sw.hex, sw.name, chosen.toUpperCase() === sw.hex.toUpperCase(), () => pickColour(sw.hex)));
      }
      wrap.append(el('p', 'cfg-note', 'Text colour'), grid);
    }
    body.append(wrap);
  }

  function renderUpload(option: UploadOption) {
    const state = parseUploadState(selections[option.id]);
    const wrap = el('div', 'cfg-upload');

    if (option.priceDelta) wrap.append(el('p', 'cfg-note', `+${money(option.priceDelta)} when an image is added`));

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = option.accept ?? 'image/*';
    input.className = 'cfg-upload-input';
    input.hidden = true;
    input.setAttribute('aria-label', option.label);
    const failure = el('p', 'cfg-error');
    failure.hidden = true;
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      failure.hidden = true;
      pick.disabled = true;
      try {
        const encoded = await encodeUploadImage(file, option.maxBytes ?? 1_500_000);
        if (uploads) {
          // The service holds the picture; the order carries its id.
          const stored = await sendUploadImage(uploads, option.id, encoded);
          change(option.id, JSON.stringify({ img: stored.url, up: stored.id, u: 0, v: 0, s: 100 }));
        } else {
          change(option.id, JSON.stringify({ img: encoded, u: 0, v: 0, s: 100 }));
        }
      } catch (err) {
        // A rejected upload has to say so: silence here reads as a broken
        // button, and the customer tries the same file again.
        failure.textContent = err instanceof Error ? err.message : 'that image could not be uploaded';
        failure.hidden = false;
      } finally {
        pick.disabled = false;
      }
    });

    const pick = el('button', 'cfg-upload-btn', state ? 'Replace image' : 'Upload image');
    pick.type = 'button';
    pick.addEventListener('click', () => input.click());
    wrap.append(pick, input, failure);

    // The merchant's own words for the empty zone, shown where the customer
    // is deciding what to upload — the same string the veil carries.
    const hint = state ? '' : zonePlaceholder(option);
    if (hint) wrap.append(el('p', 'cfg-note', hint));

    if (option.templateUrl) {
      const a = document.createElement('a');
      a.className = 'cfg-upload-template';
      a.href = opts.baseUrl ? new URL(option.templateUrl, opts.baseUrl).href : option.templateUrl;
      a.download = '';
      a.textContent = `Download design template (${option.widthMm} × ${option.heightMm} mm)`;
      wrap.append(a);
    }

    if (state) {
      const update = (patch: Partial<typeof state>) =>
        change(option.id, JSON.stringify({ ...state, ...patch }));
      // One arrow press moves a tenth of the zone — ten taps cross it.
      const stepU = option.widthMm / 10;
      const stepV = option.heightMm / 10;

      const arrowBtn = (cls: string, glyph: string, label: string, onClick: () => void) => {
        const b = el('button', `cfg-arrow ${cls}`, glyph);
        b.type = 'button';
        b.setAttribute('aria-label', label);
        b.addEventListener('click', onClick);
        return b;
      };
      wrap.append(el('p', 'cfg-upload-heading', 'Position'));
      const pad = el('div', 'cfg-arrows');
      pad.append(
        arrowBtn('cfg-arrow-up', '↑', 'Move image up', () => update({ v: state.v + stepV })),
        arrowBtn('cfg-arrow-left', '←', 'Move image left', () => update({ u: state.u - stepU })),
        arrowBtn('cfg-arrow-centre', '⊙', 'Centre image', () => update({ u: 0, v: 0 })),
        arrowBtn('cfg-arrow-right', '→', 'Move image right', () => update({ u: state.u + stepU })),
        arrowBtn('cfg-arrow-down', '↓', 'Move image down', () => update({ v: state.v - stepV })),
      );
      wrap.append(pad);

      wrap.append(el('p', 'cfg-upload-heading', 'Size'));
      const sizeRow = el('div', 'cfg-size');
      const clampPct = (v: number) => Math.min(500, Math.max(10, Math.round(v)));
      const pct = document.createElement('input');
      pct.type = 'number';
      pct.className = 'cfg-size-value';
      pct.min = '10';
      pct.max = '500';
      pct.step = '1';
      pct.value = String(Math.round(state.s));
      pct.setAttribute('aria-label', 'Image size, percent (100 = fills the area)');
      pct.addEventListener('change', () => update({ s: clampPct(Number(pct.value) || 100) }));
      const sizeBtn = (cls: string, glyph: string, label: string, ds: number) => {
        const b = el('button', `cfg-size-btn ${cls}`, glyph);
        b.type = 'button';
        b.setAttribute('aria-label', label);
        b.addEventListener('click', () => update({ s: clampPct(state.s + ds) }));
        return b;
      };
      sizeRow.append(
        sizeBtn('cfg-size-minus', '−', 'Smaller (1%)', -1),
        pct,
        el('span', 'cfg-size-unit', '%'),
        sizeBtn('cfg-size-plus', '＋', 'Larger (1%)', 1),
      );
      wrap.append(sizeRow);

      const remove = el('button', 'cfg-upload-remove', 'Remove image');
      remove.type = 'button';
      remove.addEventListener('click', () => { input.value = ''; change(option.id, ''); });
      wrap.append(remove);
    }
    body.append(wrap);
  }

  // render() must not run inside itself. Tearing the panel down blurs
  // whatever field the customer was in, and a dirty number input fires its
  // native `change` ON that blur — whose handler calls change() → render()
  // while the outer replaceChildren is still mid-removal, which throws
  // NotFoundError on a node the inner pass already took. Defer the inner
  // call: the outer pass finishes cleanly, then one more render applies the
  // final state.
  let rendering = false;
  function render() {
    if (rendering) { queueMicrotask(render); return; }
    rendering = true;
    try { renderNow(); } finally { rendering = false; }
  }

  function renderNow() {
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
      const memberIds = new Set(manifest.parts.filter((p) => p.visibleWhen?.option === v.id).map((p) => p.id));
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
      if (option.id === active) tab.append(el('span', 'cfg-tick', '✓'));
      tab.addEventListener('click', () => select(option.id));
      tabs.append(tab);
    }

    const option = manifest.options.find((o) => o.id === active);
    // The editing pane announces what it edits — colour panes all read the
    // same way; everything else is named after its option.
    editorLabel.textContent = !option ? ''
      : isColour(option) || (isChoice(option) && folds.get(option.id)?.colour) ? 'Finish colour'
        : option.type === 'text' ? 'Your text'
          : option.type === 'upload' ? 'Your image'
            : option.label;
    if (option && isColour(option)) renderColour(option);
    else if (option && isChoice(option)) {
      renderChoice(option);
      const fold = folds.get(option.id);
      if (fold?.colour) renderColour(fold.colour);
    } else if (option?.type === 'text') renderText(option);
    else if (option?.type === 'upload') renderUpload(option);

    viewer.highlight(option && isColour(option) ? option.parts[0] : null);
    renderSummary();
  }

  // Summary — the same lines that end up on the order. Its own function so a
  // text keystroke can refresh it without rebuilding (and re-focusing) the
  // panel body. Folded colours are named after their set and member:
  // "Tile (Mail)".
  function renderSummary() {
    summary.replaceChildren();
    const visible = visibleParts(manifest, selections);
    const activeOptions = manifest.options.filter((o) => isOptionActive(manifest, selections, o, visible));
    const foldedColours = new Set<string>();
    const folds = new Map<string, { colour?: ColourOption; memberLabel: string }>();
    for (const v of manifest.options) {
      if (!isChoice(v) || v.role !== 'variant') continue;
      const memberIds = new Set(manifest.parts.filter((p) => p.visibleWhen?.option === v.id).map((p) => p.id));
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

    const payload = buildPayload(manifest, selections);
    for (const o of activeOptions) {
      if (o.type === 'text') {
        const text = payload.selections[o.id];
        if (!text) continue;
        const row = el('div', 'cfg-summary-row');
        row.append(el('span', 'cfg-summary-part', o.label), el('span', 'cfg-summary-value', `“${text}”`));
        summary.append(row);
        continue;
      }
      if (o.type === 'upload') {
        if (!selections[o.id]) continue;
        const row = el('div', 'cfg-summary-row');
        row.append(el('span', 'cfg-summary-part', o.label), el('span', 'cfg-summary-value', 'Custom image'));
        summary.append(row);
        continue;
      }
      if (!isColour(o)) continue;
      let label = o.label;
      if (foldedColours.has(o.id)) {
        const owner = [...folds.entries()].find(([, f]) => f.colour?.id === o.id);
        if (owner) label = `${manifest.options.find((x) => x.id === owner[0])?.label} (${owner[1].memberLabel})`;
      }
      const row = el('div', 'cfg-summary-row');
      const dot = el('span', 'cfg-dot');
      const resolved = resolveColour(manifest, selections, o);
      dot.style.background = resolved ? swatchCss(resolved) : '#CCC';
      const name = payload.colourNames[o.id] ?? '—';
      // "Jade White (#FEFEFE)" — unless the name IS the hex (custom colours).
      const value = resolved && name.toUpperCase() !== resolved.hex.toUpperCase()
        ? `${name} (${resolved.hex.toUpperCase()})` : name;
      row.append(dot, el('span', 'cfg-summary-part', label),
        el('span', 'cfg-summary-value', value));
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

/** Auto-mount when the page carries `<div data-configurator="…manifest.json">`.
 *
 * Idempotent: the element is marked once claimed, so the self-invocation
 * below and an explicit call from a host page cannot mount twice over each
 * other. */
export async function autoMount() {
  const host = document.querySelector<HTMLElement>('[data-configurator]');
  if (!host || host.dataset.configuratorMounted) return;
  host.dataset.configuratorMounted = '1';
  const url = host.dataset.configurator!;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`the product could not be loaded (${res.status})`);
    const manifest: Manifest = await res.json();
    return await mount({ root: host, manifest, baseUrl: new URL(url, location.href).href });
  } catch (err) {
    // A merchant's storefront must not be left with a silent empty box, and
    // the person who can fix it is reading the console, not the page.
    console.error('[configurator] could not start:', err);
    host.append(el('div', 'cfg-error', 'This product could not be loaded.'));
    host.dataset.configuratorMounted = '';
    throw err;
  }
}

/**
 * Start on our own.
 *
 * The snippet a merchant pastes is a stylesheet, a `<div>` and this script
 * — there is nobody to call `autoMount` for them. Exporting it and waiting
 * to be invoked meant the pasted snippet loaded a module that defined
 * everything and did nothing; the demo page happened to call it by hand, so
 * every test passed while every real storefront showed an empty box.
 *
 * Module scripts are deferred, so the element normally exists by now; the
 * readyState branch covers a page that injects the script some other way.
 * Hosts that mount by hand are unaffected — the guard above makes whichever
 * call arrives second a no-op.
 */
if (typeof document !== 'undefined') {
  const start = () => { void autoMount().catch(() => { /* already reported */ }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
