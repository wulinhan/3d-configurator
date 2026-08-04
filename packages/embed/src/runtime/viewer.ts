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

import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { cullHiddenFromProjector } from './decal.ts';
import type { Manifest, Part, TextOption, UploadOption } from '../manifest/types.ts';
import { resolveLayout, modelBounds, type Box } from './layout.ts';
import { partColours, visibleParts, parseUploadState, type Selections } from './state.ts';
import { loadFont, DEFAULT_FONT } from './fonts.ts';
import {
  proceduralNormalMap, applyBoxUvs, zoneFrameTexture, boundaryFrameTexture, boundaryMaskTexture, BASE_TILE_MM,
} from './textures.ts';
import { buildTextGeometry, placeGlyph, cutTextGeometry, pocketFloor } from './engrave.ts';

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
  /** Area-weighted centroid of the region, in the part's local mesh space. */
  localCentre: [number, number, number];
  /** Outward face normal in the same local space — a text slot's extrusion direction. */
  localNormal: [number, number, number];
  /** World-space normal of the clicked face, flipped toward the viewer. */
  normal: [number, number, number];
  /** Triangle indices of the coplanar region, for highlighting. */
  faces: number[];
}

/** One per-letter run's live state (see Viewer.syncPerChar). */
interface PerCharEntry {
  key: string;
  part: string;
  members: string[];
  pieces: Array<Map<string, THREE.Mesh>>;
  glyphs: THREE.Mesh[];
  customMat?: THREE.MeshStandardMaterial;
  /** Eased centring shift of the whole run along the row axis. */
  offset?: { axis: number; current: number; target: number };
  /** Geometries this entry created (deboss cuts) — disposed with it. */
  ownGeometries?: THREE.BufferGeometry[];
  debossedCarrier?: boolean;
}

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  manifest: Manifest;
  /** Resolves a manifest-relative model url. Defaults to the document base. */
  resolveUrl?: (url: string) => string;
  onSelectPart?: (partId: string | null) => void;
  /**
   * Customiser mode: a linear per-letter run keeps its centre of mass on the
   * origin, easing there as the text grows or shrinks. Off in the Studio,
   * where the merchant authors against fixed positions.
   */
  centreTextRuns?: boolean;
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
  /** optionId → its extruded text mesh; `mesh` empty while the font loads. */
  private textMeshes = new Map<string, { mesh?: THREE.Mesh; key: string; customMat?: THREE.MeshStandardMaterial }>();
  /** optionId → per-letter template pieces + their glyphs (see syncPerChar).
   * pieces[k-1] maps template member part id → its clone for piece k. */
  private perCharText = new Map<string, PerCharEntry>();
  private readonly centreTextRuns: boolean;
  private lastTick = 0;
  /** partId → pristine geometry, captured before the first deboss cut. */
  private debossBase = new Map<string, THREE.BufferGeometry>();
  /** partId → signature of the single-slot deboss cuts currently applied. */
  private debossSig = new Map<string, string>();
  /** partId → the evaluated geometry currently on the mesh (disposable). */
  private debossGeo = new Map<string, THREE.BufferGeometry>();
  private csgModule?: Promise<typeof import('three-bvh-csg')>;
  /** partId → its cloned normal-map texture (own repeat per part). */
  private partTextures = new Map<string, THREE.Texture>();
  /** optionId → the engraved pocket's floor mesh (single-slot mode) — the
   * flat face that carries the slot's text colour. */
  private debossFloors = new Map<string, { mesh: THREE.Mesh; key: string; customMat?: THREE.MeshStandardMaterial }>();
  /** optionId → the image zone's decal + dashed boundary frame. */
  private imageDecals = new Map<string, {
    key: string;
    decal?: THREE.Mesh;
    frame?: THREE.Mesh;
    texture?: THREE.Texture;
    /** Per-shape textures (custom boundary outline / clip mask) — unlike the
     * shared dashed-rectangle frame, these are owned and disposed here. */
    frameTexture?: THREE.Texture;
    maskTexture?: THREE.Texture;
  }>();
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
    this.centreTextRuns = opts.centreTextRuns ?? false;

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

    // Each PART gets its own copy of its geometry: two parts may share one
    // mesh (a duplicated variant set), and the re-centring below mutates the
    // buffer — sharing would re-centre it once per part.
    const partGeometry = new Map<string, THREE.BufferGeometry>();
    for (const part of this.manifest.parts) {
      const source = geometries.get(part.mesh);
      if (source) partGeometry.set(part.id, source.clone());
    }

    const boxes = new Map<string, Box>();
    for (const part of this.manifest.parts) {
      const geo = partGeometry.get(part.id);
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
      const geo = partGeometry.get(part.id);
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
      // Merchant meshes ship without UVs; box-projected ones let the
      // procedural finishes (normal maps) tile at real millimetre scales.
      applyBoxUvs(geo);

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
      this.syncPartTexture(part, material);
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
    this.applyScene();

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
        const flat = part.material?.flatShading ?? true;
        if (material.flatShading !== flat) {
          material.flatShading = flat;
          material.needsUpdate = true; // shading model changes recompile the shader
        }
        this.syncPartTexture(part, material);
      }
    }
    this.fitShadowCatcher();
    this.applyScene();
  }

  /** Manifest scene knobs → renderer state. Safe to call any time. */
  private applyScene(): void {
    const s = this.manifest.scene ?? {};
    this.renderer.toneMappingExposure = s.exposure ?? 1.25;
    this.scene.environmentIntensity = s.environmentIntensity ?? 0.5;
    if (this.shadowCatcher) {
      (this.shadowCatcher.material as THREE.ShadowMaterial).opacity = s.shadowOpacity ?? 0.2;
    }
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
    // Edges are keyed by QUANTISED VERTEX POSITIONS, not indices: flat-shaded
    // exports split vertices along hard edges, so index-based adjacency sees
    // every triangle as an island and the "surface" collapses to one triangle
    // — the standard mesh-tool approach is positional welding plus
    // normal-angle region growing, which is what this implements.
    let adjacency = this.surfaceAdjacency.get(geo);
    if (!adjacency) {
      const posKey = (i: number) =>
        `${Math.round(pos.getX(i) * 1000)}_${Math.round(pos.getY(i) * 1000)}_${Math.round(pos.getZ(i) * 1000)}`;
      const byEdge = new Map<string, number[]>();
      for (let f = 0; f < triCount; f++) {
        for (let c = 0; c < 3; c++) {
          const a = posKey(tri(f, c)), b = posKey(tri(f, (c + 1) % 3));
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
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

    // Area-weighted centroid of the region in the part's LOCAL space — where
    // a text slot binds, so it must be in the same space the text mesh will
    // be parented into. The local normal is the world pick normal carried
    // back through the mesh's rotation, keeping its outward orientation.
    const centroid = new THREE.Vector3();
    let area = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c3 = new THREE.Vector3();
    for (const f of faces) {
      a.fromBufferAttribute(pos, tri(f, 0));
      b.fromBufferAttribute(pos, tri(f, 1));
      c3.fromBufferAttribute(pos, tri(f, 2));
      const triArea = e1.copy(b).sub(a).cross(e2.copy(c3).sub(a)).length() / 2;
      centroid.addScaledVector(a.add(b).add(c3).divideScalar(3), triArea);
      area += triArea;
    }
    if (area > 0) centroid.divideScalar(area);
    const worldQuat = hit.mesh.getWorldQuaternion(new THREE.Quaternion());
    const outwardLocal = new THREE.Vector3(...hit.normal).applyQuaternion(worldQuat.invert()).normalize();

    return {
      partId: hit.partId,
      normal: hit.normal,
      faces,
      localCentre: [centroid.x, centroid.y, centroid.z],
      localNormal: [outwardLocal.x, outwardLocal.y, outwardLocal.z],
    };
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
    this.syncText(selections);
    this.syncImages(selections);
    this.highlight(this.highlighted);
  }

  /**
   * Customer images land as DECALS: the image is projected through a box
   * onto whatever geometry sits inside the zone, so flat, curved and
   * double-curved surfaces all take it — no UV unwrapping involved. The
   * dashed frame decal shows the zone while no image is uploaded. Decals
   * are generated in world space, so they rebuild whenever the carrier's
   * transform, the zone, or the customer's image/position/size changes.
   */
  private syncImages(selections: Selections): void {
    const wanted = new Set<string>();
    for (const option of this.manifest.options) {
      if (option.type !== 'upload') continue;
      wanted.add(option.id);
      const carrier = this.meshes.get(option.part);
      const entry = this.imageDecals.get(option.id) ?? { key: '' };
      this.imageDecals.set(option.id, entry);
      if (!carrier) { this.dropImage(option.id); continue; }
      carrier.updateMatrixWorld();
      const state = parseUploadState(selections[option.id]);
      const key = JSON.stringify([
        option.origin, option.normal, option.rotationDeg, option.widthMm, option.heightMm,
        option.wrapMm, option.part, option.boundary,
        state ? [state.img.length, state.img.slice(-48), state.u, state.v, state.s] : null,
        carrier.matrixWorld.elements.map((e) => Math.round(e * 1000)),
      ]);
      if (entry.key === key) {
        if (entry.decal) entry.decal.visible = carrier.visible;
        if (entry.frame) entry.frame.visible = carrier.visible && !state;
        continue;
      }
      this.dropImage(option.id);
      const fresh: NonNullable<ReturnType<typeof this.imageDecals.get>> = { key };
      this.imageDecals.set(option.id, fresh);

      // The zone frame — always built; hidden while an image is showing. A
      // reshaped zone draws its curve; a plain one the shared dashed rect.
      const frameTex = option.boundary
        ? boundaryFrameTexture(option.boundary, option.widthMm, option.heightMm)
        : zoneFrameTexture();
      if (option.boundary) fresh.frameTexture = frameTex;
      const frame = this.buildDecal(carrier, option, 0, 0, option.widthMm, option.heightMm, frameTex);
      if (frame) {
        frame.name = `image-frame-${option.id}`;
        frame.visible = carrier.visible && !state;
        this.group.add(frame);
        fresh.frame = frame;
      }
      if (!state) continue;

      const spec = { ...option };
      new THREE.TextureLoader().load(state.img, (texture) => {
        if (this.imageDecals.get(option.id) !== fresh) { texture.dispose(); return; } // superseded
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        const img = texture.image as { width: number; height: number };
        const aspect = img.width / Math.max(1, img.height);
        // 100% = the largest fit inside the zone, aspect preserved.
        let w = Math.min(spec.widthMm, spec.heightMm * aspect);
        let h = w / aspect;
        w *= state.s / 100; h *= state.s / 100;
        // The image stays inside the zone whatever the stored offset says.
        const u = Math.max(-(spec.widthMm - w) / 2, Math.min((spec.widthMm - w) / 2, state.u));
        const v = Math.max(-(spec.heightMm - h) / 2, Math.min((spec.heightMm - h) / 2, state.v));
        const target = this.meshes.get(spec.part);
        if (!target) { texture.dispose(); return; }
        // A reshaped boundary clips the image: the mask covers the decal's
        // own rectangle, so only the part of the image inside the curve shows.
        let mask: THREE.Texture | undefined;
        if (spec.boundary) {
          mask = boundaryMaskTexture(spec.boundary, { cx: u, cy: v, w, h });
          fresh.maskTexture = mask;
        }
        const decal = this.buildDecal(target, spec, u, v, w, h, texture, mask);
        if (!decal) { texture.dispose(); mask?.dispose(); return; }
        decal.name = `image-${spec.id}`;
        decal.visible = target.visible;
        this.group.add(decal);
        fresh.decal = decal;
        fresh.texture = texture;
        if (fresh.frame) fresh.frame.visible = false;
      });
    }
    for (const id of [...this.imageDecals.keys()]) {
      if (!wanted.has(id)) this.dropImage(id);
    }
  }

  /** One projected decal over the zone's surface, offset (u,v) mm from its
   * centre in the zone plane, sized w×h mm. */
  private buildDecal(
    carrier: THREE.Mesh, option: UploadOption,
    u: number, v: number, w: number, h: number, texture: THREE.Texture,
    alphaMap?: THREE.Texture,
  ): THREE.Mesh | null {
    try {
      // Zone basis in the carrier's local space — same convention as glyphs.
      const n = new THREE.Vector3(...option.normal).normalize();
      const upRef = Math.abs(n.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1);
      const xAxis = new THREE.Vector3().crossVectors(upRef, n).normalize();
      const yAxis = new THREE.Vector3().crossVectors(n, xAxis).normalize();
      const localQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, n));
      if (option.rotationDeg) {
        localQuat.premultiply(new THREE.Quaternion().setFromAxisAngle(n, option.rotationDeg * Math.PI / 180));
      }
      const rot = new THREE.Vector3().copy(xAxis).multiplyScalar(u).addScaledVector(yAxis, v);
      const localPos = new THREE.Vector3(...option.origin).add(
        rot.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(n, (option.rotationDeg ?? 0) * Math.PI / 180)));
      const worldPos = carrier.localToWorld(localPos.clone());
      const worldQuat = carrier.getWorldQuaternion(new THREE.Quaternion()).multiply(localQuat);
      const euler = new THREE.Euler().setFromQuaternion(worldQuat);
      const wrap = option.wrapMm ?? Math.max(option.widthMm, option.heightMm);
      const raw = new DecalGeometry(carrier, worldPos, euler, new THREE.Vector3(w, h, wrap));
      // The projection box reaches THROUGH the part; without this, walls and
      // the underside inside the box would take the image too (a QR stamped
      // on the top face bleeding out of every edge). Keep only what the
      // projector can actually see.
      const geometry = cullHiddenFromProjector(raw, new THREE.Vector3(0, 0, 1).applyEuler(euler), carrier);
      raw.dispose();
      if (!geometry || !geometry.attributes.position || geometry.attributes.position.count === 0) {
        geometry?.dispose();
        return null;
      }
      const material = new THREE.MeshStandardMaterial({
        map: texture,
        alphaMap: alphaMap ?? null,
        transparent: true,
        roughness: 0.8,
        metalness: 0,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.raycast = () => {};
      mesh.renderOrder = 2;
      return mesh;
    } catch {
      return null;
    }
  }

  private dropImage(optionId: string): void {
    const entry = this.imageDecals.get(optionId);
    if (!entry) return;
    for (const mesh of [entry.decal, entry.frame]) {
      if (!mesh) continue;
      mesh.removeFromParent();
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    entry.texture?.dispose();
    entry.frameTexture?.dispose();
    entry.maskTexture?.dispose();
    this.imageDecals.delete(optionId);
  }

  /** The rendered image decal of an upload option — a test hook. */
  imageDecalOf(optionId: string): THREE.Mesh | undefined {
    return this.imageDecals.get(optionId)?.decal;
  }

  /**
   * Build/refresh the extruded text of every text option (see TextOption).
   *
   * The text mesh is a CHILD of its carrier part's mesh, in the part's local
   * space — every later move, rotation, anchor or hide of the part carries
   * the text for free. It shares the part's material, so colour changes
   * apply to both. Fonts load lazily; a stale async build is dropped when a
   * newer key has been recorded in the meantime.
   */
  private syncText(selections: Selections): void {
    const wanted = new Set<string>();
    const debossJobs = new Map<string, Array<{ spec: TextOption; text: string }>>();
    for (const option of this.manifest.options) {
      if (option.type !== 'text') continue;
      wanted.add(option.id);
      const carrier = this.meshes.get(option.part);
      // Nothing typed yet renders the placeholder — customers see where their
      // text will land (and merchants preview the slot); only typed text is
      // ever priced or put on the order.
      const text = (selections[option.id] ?? '').trim() || (option.placeholder ?? '').trim();
      if (!carrier || !text) {
        this.dropTextMesh(option.id);
        this.dropPerChar(option.id);
        this.dropDebossFloor(option.id);
        continue;
      }
      if (option.perChar) {
        this.dropTextMesh(option.id); // the slot may have just been switched over
        this.dropDebossFloor(option.id);
        this.syncPerChar(option, carrier, text);
      } else if ((option.style ?? 'emboss') === 'deboss') {
        // Engraved: no glyph mesh — the part's own geometry is cut, and the
        // pocket floor rides as its own mesh in the slot's text colour.
        // Gathered per part so several slots compose one subtraction chain.
        this.dropTextMesh(option.id);
        this.dropPerChar(option.id);
        const jobs = debossJobs.get(option.part) ?? [];
        jobs.push({ spec: { ...option }, text });
        debossJobs.set(option.part, jobs);
      } else {
        this.dropPerChar(option.id);
        this.dropDebossFloor(option.id);
        this.syncSingle(option, carrier, text);
      }
    }

    for (const id of [...this.textMeshes.keys()]) {
      if (!wanted.has(id)) this.dropTextMesh(id);
    }
    for (const id of [...this.perCharText.keys()]) {
      if (!wanted.has(id)) this.dropPerChar(id);
    }
    for (const id of [...this.debossFloors.keys()]) {
      if (!wanted.has(id)) this.dropDebossFloor(id);
    }
    this.syncDebossParts(debossJobs);
  }

  private loadCsg() {
    return this.csgModule ??= import('three-bvh-csg');
  }

  /** Apply (or clear) the single-slot engraved cuts, one chain per part. */
  private syncDebossParts(jobs: Map<string, Array<{ spec: TextOption; text: string }>>): void {
    for (const partId of [...this.debossSig.keys()]) {
      if (jobs.has(partId)) continue;
      this.debossSig.delete(partId);
      const base = this.debossBase.get(partId);
      const mesh = this.meshes.get(partId);
      if (base && mesh) {
        mesh.geometry = base.clone();
        this.debossGeo.get(partId)?.dispose();
        this.debossGeo.set(partId, mesh.geometry);
      }
    }
    for (const [partId, list] of jobs) {
      const sig = JSON.stringify(list.map((j) => [
        j.spec.id, j.text, j.spec.font, j.spec.sizeMm, j.spec.depthMm,
        j.spec.rotationDeg, j.spec.origin, j.spec.normal,
      ]));
      if (this.debossSig.get(partId) === sig) continue;
      this.debossSig.set(partId, sig);
      const mesh = this.meshes.get(partId);
      if (!mesh) continue;
      if (!this.debossBase.has(partId)) {
        this.debossBase.set(partId, (mesh.geometry as THREE.BufferGeometry).clone());
      }
      Promise.all([this.loadCsg(), ...list.map((j) => loadFont(j.spec.font ?? DEFAULT_FONT))]).then(([csg, ...fonts]) => {
        if (this.debossSig.get(partId) !== sig) return; // superseded meanwhile
        const base = this.debossBase.get(partId)!;
        let geo: THREE.BufferGeometry = base;
        list.forEach((j, i) => {
          const next = cutTextGeometry(geo, j.text, fonts[i], j.spec, csg);
          applyBoxUvs(next); // procedural finishes keep tiling on the cut part
          if (geo !== base) geo.dispose();
          geo = next;
        });
        const target = this.meshes.get(partId);
        if (!target) { if (geo !== base) geo.dispose(); return; }
        target.geometry = geo === base ? base.clone() : geo;
        this.debossGeo.get(partId)?.dispose();
        this.debossGeo.set(partId, target.geometry);

        // The pocket floor — the flat face, not the walls — carries the
        // slot's text colour, as its own mesh riding the carrier.
        list.forEach((j, i) => {
          const floorKey = JSON.stringify([
            j.text, j.spec.font, j.spec.sizeMm, j.spec.depthMm,
            j.spec.rotationDeg, j.spec.origin, j.spec.normal, j.spec.colourHex,
          ]);
          let entry = this.debossFloors.get(j.spec.id);
          if (entry?.key === floorKey && entry.mesh.parent === target) return;
          if (entry) { entry.mesh.removeFromParent(); entry.mesh.geometry.dispose(); }
          const holder = { customMat: entry?.customMat };
          const mesh = new THREE.Mesh(pocketFloor(j.text, fonts[i], j.spec), undefined as unknown as THREE.Material);
          mesh.material = this.textMaterial(j.spec, holder) ?? mesh.material;
          mesh.castShadow = mesh.receiveShadow = true;
          mesh.raycast = () => {};
          mesh.name = `text-${j.spec.id}`;
          target.add(mesh); // pre-posed in carrier-local space
          this.debossFloors.set(j.spec.id, { mesh, key: floorKey, customMat: holder.customMat });
        });
      });
    }
  }

  /**
   * What a glyph renders in: the carrier part's own material (so text
   * colours with the part), or — when the slot pins `colourHex` — a
   * dedicated material in that fixed finish, kept per option and disposed
   * with it.
   */
  private textMaterial(
    spec: TextOption,
    entry: { customMat?: THREE.MeshStandardMaterial },
  ): THREE.Material | undefined {
    if (!spec.colourHex) {
      entry.customMat?.dispose();
      entry.customMat = undefined;
      return this.materials.get(spec.part);
    }
    if (!entry.customMat) {
      const base = this.materials.get(spec.part);
      entry.customMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(spec.colourHex),
        roughness: base?.roughness ?? 0.55,
        metalness: base?.metalness ?? 0,
        flatShading: base?.flatShading ?? true,
        side: THREE.DoubleSide,
      });
    } else {
      entry.customMat.color.set(spec.colourHex);
    }
    return entry.customMat;
  }

  /** Apply (or clear) a part's procedural finish — its normal map. Each
   * part clones the cached map so it can carry its own repeat scale. */
  private syncPartTexture(part: Part, material: THREE.MeshStandardMaterial): void {
    const spec = part.material?.texture;
    if (!spec) {
      if (material.normalMap) {
        material.normalMap = null;
        material.needsUpdate = true;
      }
      this.partTextures.get(part.id)?.dispose();
      this.partTextures.delete(part.id);
      return;
    }
    let texture = this.partTextures.get(part.id);
    if (!texture || texture.userData.type !== spec.type) {
      texture?.dispose();
      texture = proceduralNormalMap(spec.type).clone();
      texture.userData.type = spec.type;
      texture.needsUpdate = true;
      this.partTextures.set(part.id, texture);
    }
    if (material.normalMap !== texture) {
      material.normalMap = texture;
      material.needsUpdate = true;
    }
    const repeat = BASE_TILE_MM / (spec.scaleMm ?? 8);
    texture.repeat.set(repeat, repeat);
    const s = spec.strength ?? 1;
    material.normalScale.set(s, s);
  }

  private syncSingle(option: TextOption, carrier: THREE.Mesh, text: string): void {
    const existing = this.textMeshes.get(option.id);
    const key = JSON.stringify([
      text, option.font, option.sizeMm, option.depthMm, option.sinkMm,
      option.rotationDeg, option.origin, option.normal, option.part, option.colourHex, option.style,
    ]);
    if (existing?.key === key) return;
    this.textMeshes.set(option.id, { mesh: existing?.mesh, key, customMat: existing?.customMat });

    const spec = { ...option };
    loadFont(option.font ?? DEFAULT_FONT).then((font) => {
      const current = this.textMeshes.get(option.id);
      if (current?.key !== key) return; // superseded while the font loaded
      const geo = buildTextGeometry(text, font, spec);
      let mesh = current.mesh;
      if (!mesh) {
        mesh = new THREE.Mesh(geo, this.textMaterial(spec, current));
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.name = `text-${spec.id}`;
        // Children of part meshes are seen by the recursive raycasts; text
        // must never intercept a part pick or a snap-surface probe.
        mesh.raycast = () => {};
        const parent = this.meshes.get(spec.part);
        if (!parent) { geo.dispose(); return; }
        parent.add(mesh);
        current.mesh = mesh;
      } else {
        mesh.geometry.dispose();
        mesh.geometry = geo;
        mesh.material = this.textMaterial(spec, current) ?? mesh.material;
        const parent = this.meshes.get(spec.part);
        if (parent && mesh.parent !== parent) parent.add(mesh);
      }
      placeGlyph(mesh, spec);
    });
  }

  /** A per-char template: the carrier's whole assembly, or just the carrier. */
  private templateMembers(partId: string): string[] {
    const group = this.manifest.groups?.find((g) => g.parts.includes(partId));
    return group ? [...group.parts] : [partId];
  }

  /**
   * One piece per letter: the carrier — or, when it belongs to an assembly,
   * the WHOLE assembly — is a TEMPLATE. Every character of the text gets
   * its own piece: clones of each member mesh (sharing geometry and
   * material), with that character's glyph on the clone of the carrier.
   * The original meshes are piece #1. Line mode marches pieces along a
   * canonical axis at the template's laid-out size plus the gap; circle
   * mode turns each piece stepDeg° further round the vertical axis through
   * the origin (the original faces the tangent), the same rigid turn the
   * repeat tool stamps. Pieces re-track the source meshes' transforms and
   * visibility on every apply, so edits, variant switches and hides carry
   * the whole run; a space spawns a blank piece.
   */
  private syncPerChar(option: TextOption, carrier: THREE.Mesh, text: string): void {
    const mode = option.perChar?.mode ?? 'line';
    const axis = option.perChar?.axis ?? 0;
    const gap = option.perChar?.gapMm ?? 5;
    const stepDeg = option.perChar?.stepDeg ?? 30;
    const deboss = (option.style ?? 'emboss') === 'deboss';
    const members = this.templateMembers(option.part);
    const chars = [...text];

    const key = JSON.stringify([
      text, option.font, option.sizeMm, option.depthMm, option.sinkMm,
      option.rotationDeg, option.origin, option.normal, option.part,
      option.colourHex, option.style, members, mode, axis, gap, stepDeg,
    ]);
    let entry = this.perCharText.get(option.id);
    if (!entry || entry.key !== key) {
      // The centring glide survives a rebuild — a keystroke should slide the
      // run, not snap it.
      const prevOffset = entry?.offset;
      this.dropPerChar(option.id);
      entry = { key, part: option.part, members, pieces: [], glyphs: [] };
      if (prevOffset) entry.offset = prevOffset;
      this.perCharText.set(option.id, entry);
      for (let k = 1; k < chars.length; k++) {
        const clones = new Map<string, THREE.Mesh>();
        for (const memberId of members) {
          const src = this.meshes.get(memberId);
          if (!src) continue;
          const copy = new THREE.Mesh(src.geometry, src.material);
          copy.castShadow = copy.receiveShadow = true;
          copy.raycast = () => {};
          copy.name = memberId === option.part
            ? `percopy-${option.id}-${k}`
            : `percopy-${option.id}-${k}-${memberId}`;
          this.group.add(copy);
          clones.set(memberId, copy);
        }
        entry.pieces.push(clones);
      }
      const current = entry;
      const spec = { ...option };
      if (deboss) {
        // Engraved: each piece's carrier gets its own base-minus-letter
        // geometry — a real boolean difference, so the pocket has walls.
        if (!this.debossBase.has(spec.part)) {
          this.debossBase.set(spec.part, (carrier.geometry as THREE.BufferGeometry).clone());
        }
        Promise.all([loadFont(option.font ?? DEFAULT_FONT), this.loadCsg()]).then(([font, csg]) => {
          if (this.perCharText.get(option.id) !== current) return; // superseded
          const base = this.debossBase.get(spec.part)!;
          current.ownGeometries = [];
          const floorMaterial = this.textMaterial(spec, current);
          chars.forEach((ch, k) => {
            const target = k === 0 ? carrier : current.pieces[k - 1]?.get(spec.part);
            if (!target) return;
            const geo = ch === ' ' ? base.clone() : cutTextGeometry(base, ch, font, spec, csg);
            if (ch !== ' ') applyBoxUvs(geo);
            target.geometry = geo;
            current.ownGeometries!.push(geo);
            if (ch !== ' ') {
              // Each piece's pocket floor carries the text colour.
              const floor = new THREE.Mesh(pocketFloor(ch, font, spec), floorMaterial);
              floor.castShadow = floor.receiveShadow = true;
              floor.raycast = () => {};
              floor.name = `text-${spec.id}-${k}`;
              target.add(floor); // pre-posed in carrier-local space
              current.glyphs.push(floor);
            }
          });
          current.debossedCarrier = true;
        });
      } else {
        loadFont(option.font ?? DEFAULT_FONT).then((font) => {
          if (this.perCharText.get(option.id) !== current) return; // superseded
          const material = this.textMaterial(spec, current);
          chars.forEach((ch, k) => {
            if (ch === ' ') return; // a space is a blank piece
            const parent = k === 0 ? carrier : current.pieces[k - 1]?.get(spec.part);
            if (!parent) return;
            const glyph = new THREE.Mesh(buildTextGeometry(ch, font, spec), material);
            glyph.castShadow = glyph.receiveShadow = true;
            glyph.raycast = () => {};
            glyph.name = `text-${spec.id}-${k}`;
            placeGlyph(glyph, spec);
            parent.add(glyph);
            current.glyphs.push(glyph);
          });
        });
      }
    }

    // Centring: the run's centre of mass belongs ON THE WORLD ORIGIN in the
    // customiser — piece k sits at centre + k·pitch, so the shift that puts
    // the run's mean at zero is −(centre + pitch·(N−1)/2). The target moves
    // with the piece count; the glide toward it happens frame by frame in
    // updateTextRuns.
    if (this.centreTextRuns && mode === 'line') {
      const span = this.perCharSpan(members, axis, gap);
      const target = -(span.centre + span.pitch * (chars.length - 1) / 2);
      if (!entry.offset) entry.offset = { axis, current: 0, target };
      else { entry.offset.axis = axis; entry.offset.target = target; }
    } else {
      entry.offset = undefined;
    }

    this.placePerCharPieces(option, entry);
  }

  /** The template's union extent along the row axis: piece pitch + centre. */
  private perCharSpan(members: string[], axis: number, gap: number): { pitch: number; centre: number } {
    let lo = Infinity, hi = -Infinity;
    for (const memberId of members) {
      const box = this.layout.get(memberId)?.box;
      if (!box) continue;
      lo = Math.min(lo, box.min[axis]);
      hi = Math.max(hi, box.max[axis]);
    }
    if (!Number.isFinite(lo)) return { pitch: gap, centre: 0 };
    return { pitch: hi - lo + gap, centre: (lo + hi) / 2 };
  }

  /** The authored (layout) position of a part — what setManifest writes. */
  private layoutPosition(partId: string, out: THREE.Vector3): boolean {
    const t = this.layout.get(partId);
    const centre = this.centres.get(partId);
    if (!t || !centre) return false;
    out.set(centre[0] + t.translate[0], centre[1] + t.translate[1], centre[2] + t.translate[2]);
    return true;
  }

  /** Position every piece of a per-letter run — called on apply and per
   * animation frame while the centring offset glides. */
  private placePerCharPieces(option: TextOption, entry: PerCharEntry): void {
    const mode = option.perChar?.mode ?? 'line';
    const axis = option.perChar?.axis ?? 0;
    const gap = option.perChar?.gapMm ?? 5;
    const stepDeg = option.perChar?.stepDeg ?? 30;
    const members = entry.members;

    // The originals shift by the eased offset (customiser only) — their
    // authored position comes from the layout, so the shift never compounds.
    const off = entry.offset?.current ?? 0;
    if (this.centreTextRuns && mode === 'line') {
      const base = new THREE.Vector3();
      for (const memberId of members) {
        const mesh = this.meshes.get(memberId);
        if (!mesh || !this.layoutPosition(memberId, base)) continue;
        mesh.position.setComponent(axis, base.getComponent(axis) + off);
      }
    }

    if (mode === 'line') {
      const pitch = this.perCharSpan(members, axis, gap).pitch;
      entry.pieces.forEach((clones, i) => {
        for (const [memberId, copy] of clones) {
          const src = this.meshes.get(memberId);
          if (!src) continue;
          copy.position.copy(src.position);
          copy.position.setComponent(axis, copy.position.getComponent(axis) + pitch * (i + 1));
          copy.quaternion.copy(src.quaternion);
          copy.scale.copy(src.scale);
          copy.visible = src.visible;
        }
      });
    } else {
      const Y = new THREE.Vector3(0, 1, 0);
      entry.pieces.forEach((clones, i) => {
        // Same convention as the repeat tool's circle: piece k sits k·step
        // further round the ring; three's −angle Y-rotation advances the
        // ground-plane angle by +angle, and body spin matches the orbit.
        const q = new THREE.Quaternion().setFromAxisAngle(Y, -((i + 1) * stepDeg) * Math.PI / 180);
        for (const [memberId, copy] of clones) {
          const src = this.meshes.get(memberId);
          if (!src) continue;
          copy.position.copy(src.position).applyQuaternion(q);
          copy.quaternion.copy(q).multiply(src.quaternion);
          copy.scale.copy(src.scale);
          copy.visible = src.visible;
        }
      });
    }
  }

  private dropTextMesh(optionId: string): void {
    const entry = this.textMeshes.get(optionId);
    if (!entry) return;
    entry.mesh?.removeFromParent();
    entry.mesh?.geometry.dispose();
    entry.customMat?.dispose();
    this.textMeshes.delete(optionId);
  }

  private dropDebossFloor(optionId: string): void {
    const entry = this.debossFloors.get(optionId);
    if (!entry) return;
    entry.mesh.removeFromParent();
    entry.mesh.geometry.dispose();
    entry.customMat?.dispose();
    this.debossFloors.delete(optionId);
  }

  private dropPerChar(optionId: string): void {
    const entry = this.perCharText.get(optionId);
    if (!entry) return;
    for (const glyph of entry.glyphs) { glyph.removeFromParent(); glyph.geometry.dispose(); }
    for (const clones of entry.pieces) for (const copy of clones.values()) copy.removeFromParent();
    // An engraved carrier goes back to its pristine geometry…
    if (entry.debossedCarrier) {
      const base = this.debossBase.get(entry.part);
      const mesh = this.meshes.get(entry.part);
      if (base && mesh) mesh.geometry = base.clone();
    }
    for (const g of entry.ownGeometries ?? []) g.dispose();
    // …and a centred run puts its members back where the layout says.
    if (entry.offset && this.centreTextRuns) {
      const base = new THREE.Vector3();
      for (const memberId of entry.members) {
        const mesh = this.meshes.get(memberId);
        if (mesh && this.layoutPosition(memberId, base)) mesh.position.copy(base);
      }
    }
    entry.customMat?.dispose();
    this.perCharText.delete(optionId);
  }

  /** The rendered text mesh of a text option, or undefined — a test hook. */
  textMeshOf(optionId: string): THREE.Mesh | undefined {
    return this.textMeshes.get(optionId)?.mesh;
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
      this.updateTextRuns(performance.now());
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  /** Ease each centred per-letter run toward its target shift (see
   * centreTextRuns) — an exponential glide, frame-rate independent. */
  private updateTextRuns(now: number): void {
    const dt = Math.min((now - this.lastTick) / 1000, 0.1);
    this.lastTick = now;
    if (!this.centreTextRuns) return;
    for (const [id, entry] of this.perCharText) {
      const off = entry.offset;
      if (!off || Math.abs(off.current - off.target) < 0.005) continue;
      off.current += (off.target - off.current) * Math.min(1, dt * 9);
      if (Math.abs(off.current - off.target) < 0.005) off.current = off.target;
      const option = this.manifest.options.find((o) => o.id === id);
      if (option?.type !== 'text') continue;
      this.placePerCharPieces(option, entry);
    }
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
  }
}
