// Inline the whole demo — runtime, styles, manifest and models — into one
// HTML file with no external requests.
//
// Useful for sending someone a configurator to click without standing up a
// server, and for embedding somewhere with a restrictive Content-Security-
// Policy. That second case drives two decisions here:
//
//  - Models are inlined as data: URIs and decoded in-page rather than fetched,
//    because `connect-src` policies don't list `data:` and a data-URI fetch is
//    still a fetch.
//  - Meshopt compression is stripped by default. Its decoder is WebAssembly,
//    which a policy without `wasm-unsafe-eval` refuses to compile. Dropping it
//    costs ~300 KB of base64 and buys a file that opens anywhere. Pass
//    `--keep-compression` to keep the small version when you control the CSP.
//
//   node configurator/tools/bundle-demo.mjs out.html [--fragment] [--keep-compression]
//
// `--fragment` emits only the body content (styles, markup, script) for hosts
// that supply their own document shell.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { quantize, weld } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { QUANTIZE_POSITION } from './compress.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const DEMO = join(PKG, 'demo');

const argv = process.argv.slice(2);
const fragment = argv.includes('--fragment');
const keepCompression = argv.includes('--keep-compression');
const [out] = argv.filter((a) => !a.startsWith('--'));
if (!out) { console.error('usage: bundle-demo.mjs <out.html> [--fragment] [--keep-compression]'); process.exit(1); }

/**
 * Re-encode a meshopt GLB as plain quantised buffers. Decoding happens here,
 * at build time, so the page never needs the WASM decoder. Quantisation is
 * kept — it's just integers in buffers, no decoder involved — which holds the
 * size to ~334 KB instead of the raw 601 KB.
 */
async function stripMeshopt(buf) {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.readBinary(new Uint8Array(buf));
  // Reading through the decoder already inflated the buffers. Drop the
  // extension marker — otherwise the writer re-encodes on the way out — then
  // re-weld and re-quantise so the file stays integer-packed.
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'EXT_meshopt_compression') ext.dispose();
  }
  await doc.transform(weld(), quantize({ quantizePosition: QUANTIZE_POSITION }));
  return Buffer.from(await io.writeBinary(doc));
}

// IIFE rather than ESM: an inline module script can't be imported, and a
// global is the simplest way for the page's own script to reach mount().
const bundle = execFileSync('npx', [
  'esbuild', join(PKG, 'src/embed.ts'),
  '--bundle', '--format=iife', '--global-name=Configurator',
  '--target=es2022', '--minify',
], { cwd: PKG, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const css = readFileSync(join(PKG, 'src/embed.css'), 'utf8');
const manifest = JSON.parse(readFileSync(join(DEMO, 'tap-bar-3.manifest.json'), 'utf8'));

let modelBytes = 0;
for (const source of manifest.models) {
  let buf = readFileSync(resolve(DEMO, source.url));
  if (!keepCompression) buf = await stripMeshopt(buf);
  modelBytes += buf.length;
  source.url = `data:model/gltf-binary;base64,${buf.toString('base64')}`;
}

const BASE = manifest.pricing.basePrice ?? 0;

const shopCss = `
  :root { --shop-ink: #1d1d1f; --shop-line: #e3e1dc; }
  .shop *, .shop *::before, .shop *::after { box-sizing: border-box; }
  .shop {
    max-width: 1180px; margin: 0 auto; padding: 32px 24px 64px;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--shop-ink); background: #fff; -webkit-font-smoothing: antialiased;
  }
  .shop-head { display: flex; align-items: baseline; gap: 12px; }
  .shop-brand { font-weight: 700; letter-spacing: -.02em; font-size: 15px; }
  .shop-crumb { font-size: 12px; color: #8b8880; }
  .shop h1 { margin: 6px 0 2px; font-size: 30px; letter-spacing: -.02em; }
  .shop-sub { margin: 0 0 24px; color: #6f6c65; font-size: 14px; max-width: 60ch; }
  .shop-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 28px; align-items: start; }
  @media (max-width: 940px) { .shop-layout { grid-template-columns: minmax(0, 1fr); } }
  .cart { position: sticky; top: 24px; border: 1px solid var(--shop-line); border-radius: 12px; padding: 18px; background: #fff; }
  .cart h2 { margin: 0 0 14px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #8b8880; }
  .cart-line { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; font-size: 13px; }
  .cart-line span:last-child { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .cart-line.muted { color: #6f6c65; }
  .cart-total { display: flex; justify-content: space-between; gap: 12px; margin-top: 12px; padding-top: 12px;
                border-top: 1px solid var(--shop-line); font-size: 17px; font-weight: 700; }
  .cart-total span:last-child { font-variant-numeric: tabular-nums; }
  .cart-btn { width: 100%; margin-top: 14px; padding: 12px; border: 0; border-radius: 8px;
              background: var(--shop-ink); color: #fff; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
  .cart-note { margin: 10px 0 0; font-size: 11px; line-height: 1.5; color: #8b8880; }
  .shop details { margin-top: 22px; }
  .shop summary { cursor: pointer; font-size: 12px; color: #6f6c65; }
  .shop pre { margin: 10px 0 0; padding: 14px; overflow: auto; max-height: 320px; background: #1d1d1f;
              color: #e8e6e1; border-radius: 10px; font-size: 11px; line-height: 1.5; }
`;

const body = `
<style>${css}</style>
<style>${shopCss}</style>

<div class="shop">
  <div class="shop-head">
    <span class="shop-brand">NORTHSEND</span>
    <span class="shop-crumb">Shop / Desk / Connect Bar</span>
  </div>
  <h1>${manifest.name}</h1>
  <p class="shop-sub">
    Three tappable tiles on a solid desk bar. Configure the finish below — the price updates as you go.
    Drag to orbit; click a part on the model to jump to it.
  </p>

  <div class="shop-layout">
    <div id="configurator"></div>
    <aside class="cart">
      <h2>Your order</h2>
      <div class="cart-line"><span>${manifest.name}</span><span id="base"></span></div>
      <div id="extras"></div>
      <div class="cart-total"><span>Total</span><span id="total"></span></div>
      <button class="cart-btn" id="add">Add to cart</button>
      <p class="cart-note">
        The store owns this price. The configurator only reports what the customer
        changed and what each change costs.
      </p>
    </aside>
  </div>

  <details>
    <summary>What the configurator posted to this page</summary>
    <pre id="payload">waiting…</pre>
  </details>
</div>

<script>${bundle}</script>
<script>
(function () {
  var BASE = ${BASE};
  var MANIFEST = ${JSON.stringify(manifest)};
  var money = function (n) {
    return new Intl.NumberFormat('en-SG', { style: 'currency', currency: '${manifest.pricing.currency}' })
      .format(n).replace(/^\\$/, 'S$');
  };
  var extras = document.getElementById('extras');
  var payloadEl = document.getElementById('payload');
  document.getElementById('base').textContent = money(BASE);

  function apply(p) {
    if (!p || p.type !== 'configurator:change') return;
    extras.replaceChildren();
    p.priceDeltas.forEach(function (d) {
      var row = document.createElement('div');
      row.className = 'cart-line muted';
      var name = document.createElement('span');
      name.textContent = d.label;
      var amt = document.createElement('span');
      amt.textContent = '+' + money(d.amount);
      row.append(name, amt);
      extras.append(row);
    });
    document.getElementById('total').textContent = money(BASE + p.deltaTotal);
    payloadEl.textContent = JSON.stringify(p, null, 2);
  }

  document.addEventListener('configurator:change', function (e) { apply(e.detail); });
  document.getElementById('add').addEventListener('click', function () {
    var p = JSON.parse(payloadEl.textContent);
    alert('Added to cart — ' + money(BASE + p.deltaTotal) + '\\n\\n' +
      Object.keys(p.colourNames).map(function (k) { return k + ': ' + p.colourNames[k]; }).join('\\n'));
  });

  Configurator.mount({ root: document.getElementById('configurator'), manifest: MANIFEST, target: window })
    .catch(function (err) { payloadEl.textContent = String(err); });
})();
</script>`;

const html = fragment ? body : `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${manifest.name} — configurator demo</title>
<link rel="icon" href="data:,">
<style>body { margin: 0; }</style>
</head>
<body>${body}</body>
</html>`;

mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(out, html);

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`${out}  ${kb(Buffer.byteLength(html))}` +
  `  (runtime ${kb(bundle.length)} + models ${kb(modelBytes)} raw → ${kb(modelBytes * 4 / 3)} base64)`);
