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
 * The intensities below started as the shipped r128 configurators' values
 * scaled back up to match (LIGHT_SCALE), then the ambient share was pulled
 * down: at the legacy balance the ambient term alone exceeded 1.0, so every
 * face of a white part clipped to the same flat 255 and the model read as a
 * silhouette. Filmic tone mapping plus a smaller ambient keeps whites bright
 * (~235) while letting the key light and environment carve visible form.
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

/** A flat continuous surface on a part — what the snap tool picks and paints. */
export interface SurfaceHit {
  partId: string;
  /** World-space normal of the clicked face, flipped toward the viewer. */
  normal: [number, number, number];
  /** Triangle indices of the coplanar region, for highlighting. */
  faces: number[];
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
  private shadowCatcher?: THREE.Mesh;
  private surfaceOverlays = new Map<'hover' | 'first', THREE.Mesh>();
  private surfaceAdjacency = new WeakMap<THREE.BufferGeometry, number[][]>();
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
    // Highlight rolloff instead of hard clipping — the reason white parts
    // show their chamfers and logos rather than rendering as a flat sheet.
    // The clear colour bypasses tone mapping, so the background is unchanged.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.renderer.setClearColor(new THREE.Color(cam.background ?? '#F8F6F1'));

    // Near at 1 mm, not 0.1: a 50 000:1 far/near ratio starves the depth
    // buffer and coplanar-ish lines (origin axes over the grid, part edges
    // on the ground) shimmer. minDistance is 50 mm, so nothing legitimate
    // ever gets within 1 mm of the lens.
    this.camera = new THREE.PerspectiveCamera(cam.fov ?? 38, 1, 1, 5000);
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
    this.scene.environmentIntensity = 0.5;
    pmrem.dispose();
    this.bindPicking(opts.canvas);
  }

  private addLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.2 * LIGHT_SCALE));

    const key = new THREE.DirectionalLight(0xffffff, 0.7 * LIGHT_SCALE);
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

    // A contact shadow under the model. Without it a white product's lit top
    // faces sit within a few units of the pale page background and the
    // silhouette dissolves — the shadow is what separates white-on-white.
    // ShadowMaterial renders nothing but the received shadow, and the plane
    // is not in `meshes`, so picking and layout maths never see it.
    const catcher = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.ShadowMaterial({ opacity: 0.2 }),
    );
    catcher.rotation.x = -Math.PI / 2;
    catcher.receiveShadow = true;
    this.scene.add(catcher);
    this.shadowCatcher = catcher;
    this.fitShadowCatcher();

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
    this.fitShadowCatcher();
  }

  /** Keep the contact shadow under the model as edits move and resize it. */
  private fitShadowCatcher(): void {
    const catcher = this.shadowCatcher;
    if (!catcher) return;
    const b = modelBounds(this.layout);
    if (!Number.isFinite(b.min[0])) { catcher.visible = false; return; }
    const span = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2], 1);
    catcher.visible = true;
    catcher.scale.setScalar(span * 1.4);
    // A hair below the ground plane so coplanar bottom faces don't z-fight.
    catcher.position.set((b.min[0] + b.max[0]) / 2, Math.min(b.min[1], 0) - 0.05, (b.min[2] + b.max[2]) / 2);
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
    const hit = this.castAt(clientX, clientY);
    if (!hit) return null;
    return { partId: hit.partId, normal: hit.normal };
  }

  private castAt(clientX: number, clientY: number): {
    partId: string; normal: [number, number, number]; mesh: THREE.Mesh; faceIndex: number;
  } | null {
    const canvas = this.renderer.domElement;
    const r = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    const hit = raycaster.intersectObjects([...this.meshes.values()].filter((m) => m.visible))[0];
    if (!hit?.face || hit.faceIndex == null) return null;
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
    // Rendering is double-sided, so the nearest face may be wound inward.
    // The caller asked "which way does the surface I clicked face" — that is
    // toward the viewer, whatever the triangle's winding says.
    if (normal.dot(raycaster.ray.direction) > 0) normal.negate();
    return {
      partId: hit.object.userData.part as string,
      normal: [normal.x, normal.y, normal.z],
      mesh: hit.object as THREE.Mesh,
      faceIndex: hit.faceIndex,
    };
  }

  /**
   * The flat continuous surface under a point: the hit triangle grown across
   * shared edges while the triangles stay coplanar. What the snap tool
   * highlights, so the merchant sees the whole face they are about to mate,
   * not an invisible single triangle.
   */
  surfaceAt(clientX: number, clientY: number): SurfaceHit | null {
    const hit = this.castAt(clientX, clientY);
    if (!hit) return null;
    const geo = hit.mesh.geometry as THREE.BufferGeometry;
    const index = geo.index;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const tri = (f: number, corner: number) => (index ? index.getX(f * 3 + corner) : f * 3 + corner);
    const triCount = (index ? index.count : pos.count) / 3;

    // Adjacency over shared edges, built once per geometry and cached.
    let adjacency = this.surfaceAdjacency.get(geo);
    if (!adjacency) {
      const byEdge = new Map<string, number[]>();
      for (let f = 0; f < triCount; f++) {
        for (let c = 0; c < 3; c++) {
          const a = tri(f, c), b = tri(f, (c + 1) % 3);
          const key = a < b ? `${a}_${b}` : `${b}_${a}`;
          let list = byEdge.get(key);
          if (!list) byEdge.set(key, list = []);
          list.push(f);
        }
      }
      adjacency = Array.from({ length: triCount }, () => [] as number[]);
      for (const faces of byEdge.values()) {
        for (const a of faces) for (const b of faces) if (a !== b) adjacency[a].push(b);
      }
      this.surfaceAdjacency.set(geo, adjacency);
    }

    const v = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const localNormal = (f: number, out: THREE.Vector3) => {
      out.fromBufferAttribute(pos, tri(f, 0));
      e1.fromBufferAttribute(pos, tri(f, 1)).sub(out);
      e2.fromBufferAttribute(pos, tri(f, 2)).sub(out);
      return out.copy(e1.cross(e2)).normalize();
    };

    const seedNormal = localNormal(hit.faceIndex, new THREE.Vector3());
    const seedPoint = v.fromBufferAttribute(pos, tri(hit.faceIndex, 0)).clone();
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const span = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z, 1);
    const planeTolerance = span * 1e-3 + 1e-3;

    // Grow the region: same plane (|normal·seed| ≈ 1 — winding may flip on
    // welded double-sided meshes — and vertices on the seed plane).
    const faces: number[] = [];
    const seen = new Set<number>([hit.faceIndex]);
    const queue = [hit.faceIndex];
    const n = new THREE.Vector3();
    while (queue.length) {
      const f = queue.pop()!;
      faces.push(f);
      for (const next of adjacency[f]) {
        if (seen.has(next)) continue;
        seen.add(next);
        if (Math.abs(localNormal(next, n).dot(seedNormal)) < 0.995) continue;
        let coplanar = true;
        for (let c = 0; c < 3 && coplanar; c++) {
          v.fromBufferAttribute(pos, tri(next, c)).sub(seedPoint);
          if (Math.abs(v.dot(seedNormal)) > planeTolerance) coplanar = false;
        }
        if (coplanar) queue.push(next);
      }
    }
    return { partId: hit.partId, normal: hit.normal, faces };
  }

  /**
   * Paint (or clear, with null) a picked surface. 'hover' tracks the pointer;
   * 'first' persists on the already-chosen face while the second is picked.
   * Overlays are parented to the part's mesh so they ride its transforms, and
   * they never participate in raycasts.
   */
  showSurfaceHighlight(slot: 'hover' | 'first', surface: SurfaceHit | null): void {
    const existing = this.surfaceOverlays.get(slot);
    if (existing) {
      existing.removeFromParent();
      existing.geometry.dispose();
      (existing.material as THREE.Material).dispose();
      this.surfaceOverlays.delete(slot);
    }
    if (!surface) return;
    const source = this.meshes.get(surface.partId);
    if (!source) return;
    const geo = source.geometry as THREE.BufferGeometry;
    const index = geo.index;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const positions = new Float32Array(surface.faces.length * 9);
    let o = 0;
    for (const f of surface.faces) {
      for (let c = 0; c < 3; c++) {
        const i = index ? index.getX(f * 3 + c) : f * 3 + c;
        positions[o++] = pos.getX(i);
        positions[o++] = pos.getY(i);
        positions[o++] = pos.getZ(i);
      }
    }
    const sub = new THREE.BufferGeometry();
    sub.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const overlay = new THREE.Mesh(sub, new THREE.MeshBasicMaterial({
      color: slot === 'first' ? 0xd97a2b : 0x3a6fd4,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }));
    overlay.name = `surface-highlight-${slot}`;
    overlay.raycast = () => {};
    source.add(overlay);
    this.surfaceOverlays.set(slot, overlay);
  }

  clearSurfaceHighlights(): void {
    this.showSurfaceHighlight('hover', null);
    this.showSurfaceHighlight('first', null);
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
