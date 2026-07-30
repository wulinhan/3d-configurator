// three.js glue: load a manifest's models, lay the parts out, paint them.
//
// Everything decision-shaped (where a part goes, what colour it is, what it
// costs) lives in layout.ts and state.ts and is unit-tested. This file only
// turns those answers into a picture, which is why it's the one part that
// can't be checked without eyes on it.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { Manifest } from '../manifest/types.ts';
import { resolveLayout, modelBounds, type Box } from './layout.ts';
import { partColours, visibleParts, type Selections } from './state.ts';

/**
 * three.js r155 switched to physically-based light units: a directional
 * light's contribution is now divided by pi where it previously wasn't.
 * The intensities below are the ones the shipped r128 configurators use, so
 * they're scaled back up to match — measured against the live page, a Jade
 * White body renders at 150/255 without this and 240-255 with it, and
 * customers are looking at the brighter one today.
 */
const LIGHT_SCALE = Math.PI;

/**
 * Meshopt decoder, loaded only if a model actually uses the extension.
 *
 * three's decoder module compiles its WASM at import time, and a strict
 * Content-Security-Policy (no `wasm-unsafe-eval`) rejects that compile the
 * moment the bundle loads — even for pages whose models are uncompressed.
 * GLTFLoader only needs `{ supported, decodeGltfBufferAsync }`, so this shim
 * defers the import until the first compressed buffer view shows up; the
 * bundler wraps dynamically-imported modules in a lazy initialiser, so
 * nothing WASM-shaped runs before then. The real decoder awaits its own
 * `ready` inside decodeGltfBufferAsync, so no separate ready handshake here.
 */
const LazyMeshoptDecoder = {
  supported: true,
  decodeGltfBufferAsync: (count: number, stride: number, source: Uint8Array, mode: string, filter?: string) =>
    import('three/examples/jsm/libs/meshopt_decoder.module.js')
      .then(({ MeshoptDecoder }) => MeshoptDecoder.decodeGltfBufferAsync(count, stride, source, mode, filter)),
};

/**
 * Load a GLB, whether it lives at a URL or is inlined as a data: URI.
 *
 * GLTFLoader's normal path goes through `fetch()`, and a `data:` URL counts as
 * a fetch — which a strict `connect-src` blocks, since no realistic policy
 * lists `data:` as a connect source. Inlined models are therefore decoded
 * here and handed straight to `parse()`, so a self-contained page makes no
 * network requests at all rather than making one that looks local and isn't.
 */
async function loadGltf(loader: GLTFLoader, url: string) {
  if (!url.startsWith('data:')) return loader.loadAsync(url);

  const comma = url.indexOf(',');
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  let bytes: Uint8Array;
  if (meta.endsWith(';base64')) {
    const binary = atob(payload);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }

  return new Promise<Awaited<ReturnType<GLTFLoader['loadAsync']>>>((resolve, reject) => {
    // Empty path: a self-contained GLB has no sibling resources to resolve.
    loader.parse(bytes.buffer as ArrayBuffer, '', resolve, reject);
  });
}

/**
 * Flatten a loaded mesh into plain float32 world-space positions.
 *
 * Two things make this less trivial than `geometry.applyMatrix4`:
 *
 *  - Quantised models keep their de-quantisation scale on the *node*, not the
 *    geometry. Read the geometry alone and a 140 mm bar comes out 2 mm wide.
 *  - Those positions arrive as normalised 16-bit integers, so writing
 *    transformed floats back into the same buffer truncates them. Values are
 *    read through the accessor (which denormalises) into a fresh float array
 *    instead.
 *
 * De-indexing here too: the renderer flat-shades, which needs one normal per
 * triangle rather than per shared vertex.
 */
function bakeGeometry(mesh: THREE.Mesh, scaleToMm: number): THREE.BufferGeometry {
  const src = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
  const attr = src.getAttribute('position');
  const out = new Float32Array(attr.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < attr.count; i++) {
    v.fromBufferAttribute(attr, i).applyMatrix4(mesh.matrixWorld).multiplyScalar(scaleToMm);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
  geo.computeVertexNormals();
  if (src !== mesh.geometry) src.dispose();
  return geo;
}

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  manifest: Manifest;
  /** Resolves a manifest-relative model url. Defaults to the document base. */
  resolveUrl?: (url: string) => string;
  onSelectPart?: (partId: string | null) => void;
}

export class Viewer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly group = new THREE.Group();
  private readonly meshes = new Map<string, THREE.Mesh>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly manifest: Manifest;
  private readonly onSelectPart?: (partId: string | null) => void;
  private readonly resolveUrl: (url: string) => string;
  private highlighted: string | null = null;
  private frame = 0;

  constructor(opts: ViewerOptions) {
    this.manifest = opts.manifest;
    this.onSelectPart = opts.onSelectPart;
    this.resolveUrl = opts.resolveUrl ?? ((u) => u);

    const cam = opts.manifest.camera ?? {};
    this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(new THREE.Color(cam.background ?? '#F8F6F1'));

    this.camera = new THREE.PerspectiveCamera(cam.fov ?? 38, 1, 0.1, 5000);
    this.camera.position.set(...(cam.position ?? [0, 90, 280]));

    this.controls = new OrbitControls(this.camera, opts.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = cam.minDistance ?? 50;
    this.controls.maxDistance = cam.maxDistance ?? 800;
    this.controls.maxPolarAngle = (cam.maxPolarAngle ?? 162) * (Math.PI / 180);
    this.controls.target.set(...(cam.target ?? [0, 0, 0]));
    this.controls.autoRotate = cam.autoRotate ?? false;
    this.controls.update();

    this.scene.add(this.group);
    this.addLights();
    this.bindPicking(opts.canvas);
  }

  private addLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55 * LIGHT_SCALE));

    const key = new THREE.DirectionalLight(0xffffff, 0.65 * LIGHT_SCALE);
    key.position.set(80, 140, 120);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 800;
    key.shadow.camera.left = key.shadow.camera.bottom = -160;
    key.shadow.camera.right = key.shadow.camera.top = 160;
    key.shadow.bias = -0.0005;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xffffff, 0.2 * LIGHT_SCALE);
    fill.position.set(-60, 60, -80);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 0.15 * LIGHT_SCALE);
    rim.position.set(0, -50, -100);
    this.scene.add(rim);
  }

  /** Fetch every model source and build one mesh per manifest part. */
  async load(): Promise<void> {
    const loader = new GLTFLoader().setMeshoptDecoder(LazyMeshoptDecoder);
    const geometries = new Map<string, THREE.BufferGeometry>();

    for (const source of this.manifest.models) {
      const gltf = await loadGltf(loader, this.resolveUrl(source.url));
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        // GLTFLoader names the node; the mesh name is what the manifest cites.
        const name = mesh.name || (mesh.geometry as { name?: string }).name || '';
        geometries.set(`${source.id}#${name}`, bakeGeometry(mesh, source.scaleToMm ?? 1));
      });
    }

    const boxes = new Map<string, Box>();
    for (const part of this.manifest.parts) {
      const geo = geometries.get(part.mesh);
      if (!geo) {
        console.warn(`[configurator] part "${part.id}" references missing mesh ${part.mesh}`);
        continue;
      }
      geo.computeBoundingBox();
      const bb = geo.boundingBox!;
      boxes.set(part.id, { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] });
    }

    const layout = resolveLayout(this.manifest, boxes);

    for (const part of this.manifest.parts) {
      const geo = geometries.get(part.mesh);
      const t = layout.get(part.id);
      if (!geo || !t) continue;

      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color('#CCCCCC'),
        roughness: part.material?.roughness ?? 0.9,
        metalness: part.material?.metalness ?? 0,
        flatShading: part.material?.flatShading ?? true,
      });
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.part = part.id;
      mesh.scale.set(...t.scale);
      mesh.rotation.set(...(t.rotation.map((d) => d * Math.PI / 180) as [number, number, number]));
      mesh.position.set(...t.translate);

      this.meshes.set(part.id, mesh);
      this.materials.set(part.id, material);
      this.group.add(mesh);
    }

    // Only frame the model automatically when the manifest didn't say where to
    // look — a merchant's chosen angle must survive.
    if (!this.manifest.camera?.target) {
      const b = modelBounds(layout);
      const centre = new THREE.Vector3(...[0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2) as [number, number, number]);
      this.controls.target.copy(centre);
      this.controls.update();
    }
  }

  /** Repaint and re-hide parts for a new set of selections. */
  apply(selections: Selections): void {
    const colours = partColours(this.manifest, selections);
    const visible = visibleParts(this.manifest, selections);
    for (const [partId, material] of this.materials) {
      const colour = colours.get(partId);
      if (colour) material.color.set(colour.hex);
      const mesh = this.meshes.get(partId);
      if (mesh) mesh.visible = visible.has(partId);
    }
    this.highlight(this.highlighted);
  }

  /** Glow the part the customer is editing, so the panel and model agree. */
  highlight(partId: string | null): void {
    this.highlighted = partId;
    for (const [id, material] of this.materials) {
      const on = id === partId;
      material.emissive.set(on ? 0x333333 : 0x000000);
      material.emissiveIntensity = on ? 0.25 : 0;
    }
  }

  private bindPicking(canvas: HTMLCanvasElement) {
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down = { x: 0, y: 0 };

    const pick = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(pointer, this.camera);
      const hits = raycaster.intersectObjects([...this.meshes.values()].filter((m) => m.visible));
      return hits.length ? (hits[0].object.userData.part as string) : null;
    };

    canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointerup', (e) => {
      // An orbit drag that happens to end on the model isn't a click.
      if (Math.abs(e.clientX - down.x) > 4 || Math.abs(e.clientY - down.y) > 4) return;
      const part = pick(e);
      if (part) this.onSelectPart?.(part);
    });
    canvas.addEventListener('pointermove', (e) => {
      canvas.style.cursor = pick(e) ? 'pointer' : 'grab';
    });
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  start(): void {
    const tick = () => {
      this.frame = requestAnimationFrame(tick);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
  }
}
