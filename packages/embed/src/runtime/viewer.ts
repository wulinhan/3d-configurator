// three.js glue: load a manifest's models, lay the parts out, paint them.
//
// Everything decision-shaped (where a part goes, what colour it is, what it
// costs) lives in layout.ts and state.ts and is unit-tested. This file only
// turns those answers into a picture, which is why it's the one part that
// can't be checked without eyes on it.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

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
  private manifest: Manifest;
  private readonly onSelectPart?: (partId: string | null) => void;
  private readonly resolveUrl: (url: string) => string;
  private highlighted: string | null = null;
  private rafId = 0;
  private viewTween = 0;
  private hiddenParts = new Set<string>();
  private lastSelections: Selections = {};
  /** Untransformed per-part bounds, kept so setManifest can re-run layout. */
  private rawBoxes = new Map<string, Box>();
  /** Each part's untransformed centre — the pivot every transform is about. */
  private centres = new Map<string, [number, number, number]>();
  private layout: ReturnType<typeof resolveLayout> = new Map();

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
    this.controls.addEventListener('start', () => cancelAnimationFrame(this.viewTween));

    this.scene.add(this.group);
    this.addLights();
    // A soft studio environment gives painted plastic its dull gloss — pure
    // analytic lights leave MeshStandardMaterial looking flat and, with
    // stray-wound faces, oddly translucent.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    pmrem.dispose();
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
    this.rawBoxes = boxes;

    const layout = resolveLayout(this.manifest, boxes);
    this.layout = layout;

    for (const part of this.manifest.parts) {
      const geo = geometries.get(part.mesh);
      const t = layout.get(part.id);
      const box = boxes.get(part.id);
      if (!geo || !t || !box) continue;

      // Layout maths (transformBox) scales and rotates about the part's
      // centre. Mesh transforms act about the mesh's local origin — so move
      // the origin to the centre, or a scaled part renders somewhere the
      // anchor solver didn't put it. Position then carries the centre back.
      const centre: [number, number, number] =
        [0, 1, 2].map((a) => (box.min[a] + box.max[a]) / 2) as [number, number, number];
      geo.translate(-centre[0], -centre[1], -centre[2]);
      this.centres.set(part.id, centre);

      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color('#CCCCCC'),
        // 0.55 + the room environment reads as painted plastic with a dull
        // gloss; manifests can push it matte (0.9) or shinier per part.
        roughness: part.material?.roughness ?? 0.55,
        metalness: part.material?.metalness ?? 0,
        flatShading: part.material?.flatShading ?? true,
        // Merchant meshes arrive with whatever winding their tool produced;
        // single-sided rendering turns any stray face into a see-through
        // hole. Solid plastic has no inside to save fill rate on.
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.part = part.id;
      mesh.scale.set(...t.scale);
      mesh.rotation.set(...(t.rotation.map((d) => d * Math.PI / 180) as [number, number, number]));
      mesh.position.set(centre[0] + t.translate[0], centre[1] + t.translate[1], centre[2] + t.translate[2]);

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

  /**
   * Swap in an edited manifest and re-run layout on the already-loaded meshes.
   *
   * Placement, scale and rotation are mesh transforms — the geometry never
   * changed — so the Studio can drag a slider without tearing down the WebGL
   * context (browsers cap live contexts at ~16, so rebuild-per-edit dies
   * within a minute of real use). Parts must be unchanged: geometry is bound
   * at load, so adding or removing parts still needs a fresh load().
   */
  setManifest(manifest: Manifest): void {
    this.manifest = manifest;
    const layout = resolveLayout(manifest, this.rawBoxes);
    this.layout = layout;
    for (const part of manifest.parts) {
      const mesh = this.meshes.get(part.id);
      const t = layout.get(part.id);
      const centre = this.centres.get(part.id) ?? [0, 0, 0];
      if (!mesh || !t) continue;
      mesh.scale.set(...t.scale);
      mesh.rotation.set(...(t.rotation.map((d) => d * Math.PI / 180) as [number, number, number]));
      mesh.position.set(centre[0] + t.translate[0], centre[1] + t.translate[1], centre[2] + t.translate[2]);
      const material = this.materials.get(part.id);
      if (material) {
        material.roughness = part.material?.roughness ?? 0.55;
        material.metalness = part.material?.metalness ?? 0;
      }
    }
  }

  /** Where the laid-out model currently sits, in mm. */
  layoutBounds(): Box {
    return modelBounds(this.layout);
  }

  /**
   * Refit the camera to the current layout, keeping the user's orbit angle.
   *
   * The Studio resizes parts by orders of magnitude; a camera framed for the
   * original model ends up inside the resized one. Only the distance and
   * target move — the direction the merchant chose is theirs.
   */
  frame(): void {
    const b = this.layoutBounds();
    if (!Number.isFinite(b.min[0])) return;
    const centre = new THREE.Vector3(...[0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2) as [number, number, number]);
    const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 1);
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    if (!direction.lengthSq()) direction.set(0, 0.35, 1).normalize();
    const distance = span * 2.1;
    this.controls.target.copy(centre);
    this.camera.position.copy(centre).addScaledVector(direction, distance);
    this.controls.minDistance = span * 0.4;
    this.controls.maxDistance = span * 8;
    this.camera.near = Math.max(distance / 100, 0.1);
    this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /** The current camera pose — what "save this view" persists. */
  cameraView(): { position: [number, number, number]; target: [number, number, number]; fov: number } {
    const p = this.camera.position, t = this.controls.target;
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z], fov: this.camera.fov };
  }

  /**
   * Tween the camera to a new orbit: direction and/or target and/or distance.
   *
   * Two things made the naive version janky, both fixed here: OrbitControls'
   * damping kept applying leftover orbit momentum underneath the animation
   * (so the camera drifted while tweening), and a linear vector lerp sweeps
   * an arc at uneven angular speed. Damping is paused for the duration, the
   * direction change is a quaternion slerp (constant angular velocity), and
   * the whole thing runs under an ease-in-out. A pointerdown cancels the
   * tween — the user always outranks the animation.
   */
  private tweenCamera(
    to: { direction?: THREE.Vector3; target?: THREE.Vector3; distance?: number },
    duration = 480,
  ): void {
    cancelAnimationFrame(this.viewTween);
    const fromTarget = this.controls.target.clone();
    const toTarget = to.target ?? fromTarget.clone();
    const fromOffset = this.camera.position.clone().sub(fromTarget);
    const fromDistance = Math.max(fromOffset.length(), 1e-6);
    const fromDir = fromOffset.clone().normalize();
    const toDir = (to.direction ?? fromDir).clone().normalize();
    const toDistance = THREE.MathUtils.clamp(
      to.distance ?? fromDistance, this.controls.minDistance, this.controls.maxDistance);

    const arc = new THREE.Quaternion().setFromUnitVectors(fromDir, toDir);
    const identity = new THREE.Quaternion();
    const wasDamped = this.controls.enableDamping;
    this.controls.enableDamping = false; // stop leftover momentum drifting under the tween

    const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    const start = performance.now();
    const q = new THREE.Quaternion();
    const dir = new THREE.Vector3();
    const step = () => {
      const t = Math.min((performance.now() - start) / duration, 1);
      const e = easeInOut(t);
      q.copy(identity).slerp(arc, e);
      dir.copy(fromDir).applyQuaternion(q);
      this.controls.target.lerpVectors(fromTarget, toTarget, e);
      this.camera.position.copy(this.controls.target)
        .addScaledVector(dir, THREE.MathUtils.lerp(fromDistance, toDistance, e));
      this.controls.update();
      if (t < 1) {
        this.viewTween = requestAnimationFrame(step);
      } else {
        this.controls.enableDamping = wasDamped;
      }
    };
    step();
  }

  /**
   * Swing the camera to look at the target from a direction, keeping the
   * current distance. What a view-cube click calls.
   */
  lookFrom(direction: [number, number, number], opts: { animate?: boolean } = {}): void {
    const dir = new THREE.Vector3(...direction);
    if (!dir.lengthSq()) return;
    dir.normalize();
    if (opts.animate === false) {
      const target = this.controls.target;
      const distance = this.camera.position.distanceTo(target);
      this.camera.position.copy(target).addScaledVector(dir, distance);
      this.controls.update();
      return;
    }
    // Antipodal directions have no unique arc; bow through a side point.
    const fromDir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (fromDir.dot(dir) < -0.999) {
      const side = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      this.tweenCamera({ direction: side.cross(dir).normalize() }, 200);
      setTimeout(() => this.tweenCamera({ direction: dir }, 280), 200);
      return;
    }
    this.tweenCamera({ direction: dir });
  }

  /**
   * Ease the orbit centre (and viewing distance) somewhere new — selecting a
   * part orbits around that part; deselecting returns to the model.
   */
  focusOn(target: [number, number, number], opts: { distance?: number } = {}): void {
    this.tweenCamera({ target: new THREE.Vector3(...target), distance: opts.distance });
  }

  /**
   * What part and which face is under a client-space point — the Studio's
   * face-snapping tool asks. Normal comes back in world space, unit length.
   */
  pickFaceAt(clientX: number, clientY: number): { partId: string; normal: [number, number, number] } | null {
    const canvas = this.renderer.domElement;
    const r = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    const hit = raycaster.intersectObjects([...this.meshes.values()].filter((m) => m.visible))[0];
    if (!hit?.face) return null;
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
    // Rendering is double-sided, so the nearest face may be wound inward.
    // The caller asked "which way does the surface I clicked face" — that is
    // toward the viewer, whatever the triangle's winding says.
    if (normal.dot(raycaster.ray.direction) > 0) normal.negate();
    return { partId: hit.object.userData.part as string, normal: [normal.x, normal.y, normal.z] };
  }

  /** The mesh rendering a part — the object a Studio gizmo attaches to. */
  meshOf(partId: string): THREE.Object3D | undefined {
    return this.meshes.get(partId);
  }

  /** Let a gizmo pause orbiting while it owns the pointer. */
  setOrbitEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
  }

  /** Release the WebGL context. The instance is dead after this. */
  dispose(): void {
    this.stop();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /** Repaint and re-hide parts for a new set of selections. */
  apply(selections: Selections): void {
    this.lastSelections = selections;
    const colours = partColours(this.manifest, selections);
    const visible = visibleParts(this.manifest, selections);
    for (const [partId, material] of this.materials) {
      const colour = colours.get(partId);
      if (colour) material.color.set(colour.hex);
      const mesh = this.meshes.get(partId);
      if (mesh) mesh.visible = visible.has(partId) && !this.hiddenParts.has(partId);
    }
    this.highlight(this.highlighted);
  }

  /**
   * Authoring-side visibility overlay (eyeballs, solo) — intersects with,
   * never overrides, what the manifest says is visible. Not persisted.
   */
  setHiddenParts(hidden: Set<string>): void {
    this.hiddenParts = hidden;
    this.apply(this.lastSelections);
  }

  /** Studio panning: right-drag / two-finger drag. Off in the embed. */
  setPanEnabled(enabled: boolean): void {
    this.controls.enablePan = enabled;
  }

  /** World-space box of one laid-out part, or null before load. */
  partBox(partId: string): Box | null {
    return this.layout.get(partId)?.box ?? null;
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
      // null on empty space: hosts that care (the Studio) deselect; the embed
      // panel ignores it.
      this.onSelectPart?.(pick(e));
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
      this.rafId = requestAnimationFrame(tick);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
  }
}
