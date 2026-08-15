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

import type { Manifest, Part, TextOption, UploadOption } from '../manifest/types.ts';
import { resolveLayout, modelBounds, attachTargetParts, type Box } from './layout.ts';
import {
  partColours, visibleParts, parseUploadState, textColour, zonePlaceholder,
  type UploadState, type Selections, type ResolvedColour,
} from './state.ts';
import { repeatInstances } from './repeat.ts';
import { loadFont, DEFAULT_FONT } from './fonts.ts';
import type { Font } from 'three/examples/jsm/loaders/FontLoader.js';
import { proceduralNormalMap, applyBoxUvs, BASE_TILE_MM } from './textures.ts';
import { fitZoneToRegion, type ZoneFit } from './zone-fit.ts';
import {
  buildTextGeometry, placeGlyph, cutTextGeometry, pocketFloor,
  wrappedTextGeometry, cutWrappedTextGeometry, wrappedPocketFloor,
} from './engrave.ts';
import type { SurfaceProbe } from './wrap.ts';

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
  /** The rectangle hugging the region — how an image zone conforms to the
   * picked face: its centre, edge alignment and true extents. */
  zone: ZoneFit | null;
  /**
   * The smallest angle (degrees) between this face and the neighbours the
   * weld rejected. A gentle break is a curve carrying on — a tessellated
   * barrel or dome; a hard one is a real edge. `curved` applies the
   * threshold, and is what turns surface wrapping on for a placed slot.
   */
  breakDeg: number;
  curved: boolean;
}

/** Below this, a rejected neighbour is the same surface continuing round a
 * curve rather than a genuine edge. A 24-facet barrel breaks at 15°, a
 * cube at 90°. */
export const CURVE_BREAK_DEG = 30;

/**
 * Paint a two-stop gradient into a geometry's vertex colours, along one of
 * the part's OWN axes — the on-screen stand-in for colour-shift filament.
 * Vertex colours ride the geometry, so per-letter pieces and repeat copies
 * (which share it) blend identically, exactly like pieces off one spool.
 * new THREE.Color(hex) converts sRGB to the working space, the same road
 * material.color takes, so a gradient's ends match their solid swatches.
 */
function paintGradient(geom: THREE.BufferGeometry, hexA: string, hexB: string, axis: number): void {
  const pos = geom.getAttribute('position');
  if (!pos) return;
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  if (!bb) return;
  const min = axis === 0 ? bb.min.x : axis === 1 ? bb.min.y : bb.min.z;
  const max = axis === 0 ? bb.max.x : axis === 1 ? bb.max.y : bb.max.z;
  const span = Math.max(max - min, 1e-6);
  const a = new THREE.Color(hexA);
  const b = new THREE.Color(hexB);
  const out = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const v = axis === 0 ? pos.getX(i) : axis === 1 ? pos.getY(i) : pos.getZ(i);
    c.copy(a).lerp(b, Math.min(1, Math.max(0, (v - min) / span)));
    out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(out, 3));
}

/** A canonical axis as a unit vector, turned by q — the direction a
 * per-letter run marches once its template wears a rotation. */
function axisDir(axis: number, q: THREE.Quaternion): THREE.Vector3 {
  return new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0).applyQuaternion(q);
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
  /**
   * Customiser mode: park the whole product's centre on the world origin so
   * it orbits around itself and opens fully in frame — whatever coordinates
   * the merchant authored it at. Off in the Studio, where the merchant works
   * against fixed positions, and skipped when the manifest carries a view
   * the merchant saved deliberately.
   */
  centreOnOrigin?: boolean;
}

/** ~1.5% inflation about the part's own centre — the rim's thickness. */
const _outlineScale = new THREE.Matrix4().makeScale(1.015, 1.015, 1.015);

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
  private keyLight?: THREE.DirectionalLight;
  /** partId → painted gradient signature, so vertex colours rebuild only
   * when the swatch or the geometry actually changed. */
  private gradientSig = new Map<string, string>();
  private surfaceOverlays = new Map<'hover' | 'first', THREE.Mesh>();
  /** optionId → its extruded text mesh; `mesh` empty while the font loads. */
  private textMeshes = new Map<string, { mesh?: THREE.Mesh; key: string; customMat?: THREE.MeshStandardMaterial }>();
  /** optionId → per-letter template pieces + their glyphs (see syncPerChar).
   * pieces[k-1] maps template member part id → its clone for piece k. */
  private perCharText = new Map<string, PerCharEntry>();
  private readonly centreTextRuns: boolean;
  private readonly centreOnOrigin: boolean;
  /** How far the group is pushed to bring the product to the origin — added
   * back wherever a WORLD position is computed from layout (mm) space. */
  private readonly centreOffset = new THREE.Vector3();
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
  /** optionId → the image zone's overlay plane and its paint state. */
  private imageZones = new Map<string, {
    /** Pose signature — zone geometry + carrier transform. */
    key: string;
    /** Paint signature — image, offset, size, boundary. */
    paint: string;
    mesh?: THREE.Mesh;
    canvas?: HTMLCanvasElement;
    texture?: THREE.CanvasTexture;
    imgEl?: HTMLImageElement;
    imgSrc?: string;
    hasImage?: boolean;
  }>();
  private surfaceAdjacency = new WeakMap<THREE.BufferGeometry, number[][]>();
  private lastSelections: Selections = {};
  /** Untransformed per-part bounds, kept so setManifest can re-run layout. */
  private rawBoxes = new Map<string, Box>();
  /** Each part's untransformed centre — the pivot every transform is about. */
  private centres = new Map<string, [number, number, number]>();
  private layout: ReturnType<typeof resolveLayout> = new Map();
  /** partId → the live repeat copies riding alongside its own mesh, and the
   * signature (pattern + geometry + children) they were built from. */
  private repeatCopies = new Map<string, { meshes: THREE.Object3D[]; sig: string }>();
  /** Studio selection emphasis: the part everything else dims for. */
  private emphasis: string | null = null;
  private outlineMesh?: THREE.Mesh;
  private outlineMat?: THREE.MeshBasicMaterial;

  constructor(opts: ViewerOptions) {
    this.manifest = opts.manifest;
    this.onSelectPart = opts.onSelectPart;
    this.resolveUrl = opts.resolveUrl ?? ((u) => u);
    this.centreTextRuns = opts.centreTextRuns ?? false;
    this.centreOnOrigin = (opts.centreOnOrigin ?? false) && !opts.manifest.camera?.userSet;

    const cam = opts.manifest.camera ?? {};
    this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    this.renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap is deprecated (r180+ warns and falls back to PCF).
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
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
    this.scene.add(key.target); // the target moves with the model (fitShadowCamera)
    this.keyLight = key;

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
    //
    // GLTFLoader sanitises node names for animation paths (spaces become
    // underscores; [ ] . : / are stripped) while the manifest cites the mesh
    // name as authored — so a part named "Front Panel" would never bind.
    // Look the raw reference up first, then its sanitised form.
    const sanitised = (ref: string) => {
      const at = ref.indexOf('#');
      return `${ref.slice(0, at)}#${ref.slice(at + 1).replace(/\s/g, '_').replace(/[[\].:/]/g, '')}`;
    };
    const partGeometry = new Map<string, THREE.BufferGeometry>();
    for (const part of this.manifest.parts) {
      const source = geometries.get(part.mesh) ?? geometries.get(sanitised(part.mesh));
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
    this.syncRepeats();
    this.recentreGroup();
    this.fitShadowCatcher();
    this.applyScene();

    // Only frame the model automatically when the manifest didn't say where to
    // look — a merchant's chosen angle must survive.
    if (!this.manifest.camera?.target || this.centreOnOrigin) {
      const b = modelBounds(layout);
      const centre = new THREE.Vector3(...[0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2) as [number, number, number])
        .add(this.centreOffset);
      this.controls.target.copy(centre);
      this.controls.update();
    }
    // No saved view: open on the whole product, centred, from a 45° three-
    // quarter angle, far enough out that all of it is in frame.
    if (this.centreOnOrigin) this.frameFromDefaultAngle();
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
    this.syncRepeats();
    this.recentreGroup();
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

  /** Keep the contact shadow under the model as edits move and resize it.
   * FULL bounds — repeat copies and per-letter pieces included — or the
   * plane (and with it every shadow) ends mid-run: a long clicker's later
   * letters used to cast onto nothing. */
  private fitShadowCatcher(): void {
    const catcher = this.shadowCatcher;
    if (!catcher) return;
    const b = this.layoutBounds();
    if (!Number.isFinite(b.min[0])) { catcher.visible = false; return; }
    const span = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2], 1);
    catcher.visible = true;
    catcher.scale.setScalar(span * 1.4);
    // A hair below the ground plane so coplanar bottom faces don't z-fight.
    catcher.position.set(
      (b.min[0] + b.max[0]) / 2 + this.centreOffset.x,
      Math.min(b.min[1], 0) + this.centreOffset.y - 0.05,
      (b.min[2] + b.max[2]) / 2 + this.centreOffset.z,
    );
    this.fitShadowCamera(b);
  }

  /** The key light's orthographic shadow box tracks the model too — its old
   * fixed ±160mm meant anything past that simply cast no shadow. The light
   * keeps its direction; its target walks to the model's centre and the
   * frustum grows to hold the whole bounds (never shrinking below the
   * original ±160, so small products keep their crisp shadow resolution). */
  private fitShadowCamera(b: Box): void {
    const key = this.keyLight;
    if (!key || !Number.isFinite(b.min[0])) return;
    const cx = (b.min[0] + b.max[0]) / 2 + this.centreOffset.x;
    const cy = (b.min[1] + b.max[1]) / 2 + this.centreOffset.y;
    const cz = (b.min[2] + b.max[2]) / 2 + this.centreOffset.z;
    key.target.position.set(cx, cy, cz);
    key.position.set(cx + 80, cy + 140, cz + 120);
    const reach = Math.hypot(
      (b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2);
    const half = Math.max(160, reach * 1.15);
    const cam = key.shadow.camera;
    if (Math.abs(cam.right - half) > 0.5) {
      cam.left = cam.bottom = -half;
      cam.right = cam.top = half;
      cam.far = Math.max(800, half * 4);
      cam.updateProjectionMatrix();
    }
    key.target.updateMatrixWorld();
  }

  /** The scale layout gives a part — text divides by it so lettering keeps
   * its authored millimetres however the part is resized. */
  private partScale(partId: string): [number, number, number] {
    const t = this.layout.get(partId);
    return t ? ([...t.scale] as [number, number, number]) : [1, 1, 1];
  }

  /**
   * A ray-casting surface probe for a text slot, in WORLD space: sketch
   * (u, v) → wherever the part's geometry is under it. Rays start well
   * clear of the model and come in along the slot's normal, so a curved
   * face reports the point and normal the letter should sit on. Working in
   * world space means a scaled or rotated part needs no special case — the
   * caller bakes the result back into local space with the inverse matrix.
   */
  private surfaceProbe(spec: TextOption, geometry?: THREE.BufferGeometry): SurfaceProbe | null {
    const carrier = this.meshes.get(spec.part);
    if (!carrier) return null;
    carrier.updateMatrixWorld();
    // Engraving probes the PRISTINE geometry: by the time a re-cut runs, the
    // carrier may still be wearing the previous pass's pockets, and sampling
    // those would sink the new cut into the old one.
    // DoubleSide matters: part meshes render double-sided because merchant
    // meshes arrive with whatever winding their tool produced, and a
    // front-side scratch mesh lets the ray sail through the NEAR wall and
    // report the far one — which put engraved pockets on the wrong side of
    // a barrel.
    const target = geometry
      ? Object.assign(
        new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })),
        { matrixWorld: carrier.matrixWorld },
      )
      : carrier;
    // The sketch basis, matching placeGlyph, carried into world space.
    const n = new THREE.Vector3(...spec.normal).normalize();
    const upRef = Math.abs(n.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1);
    const x = new THREE.Vector3().crossVectors(upRef, n).normalize();
    const y = new THREE.Vector3().crossVectors(n, x).normalize();
    if (spec.rotationDeg) {
      const spin = new THREE.Quaternion().setFromAxisAngle(n, spec.rotationDeg * Math.PI / 180);
      x.applyQuaternion(spin);
      y.applyQuaternion(spin);
    }
    const origin = new THREE.Vector3(...spec.origin);
    const worldOrigin = carrier.localToWorld(origin.clone());
    const worldX = x.clone().transformDirection(carrier.matrixWorld).normalize();
    const worldY = y.clone().transformDirection(carrier.matrixWorld).normalize();
    const worldN = n.clone().transformDirection(carrier.matrixWorld).normalize();
    // Start outside the part: its own diagonal is always far enough.
    const box = this.laidOut(spec.part);
    const standoff = box ? Math.max(...box.size) + 10 : 100;

    const raycaster = new THREE.Raycaster();
    const from = new THREE.Vector3();
    return (u, v) => {
      from.copy(worldOrigin)
        .addScaledVector(worldX, u)
        .addScaledVector(worldY, v)
        .addScaledVector(worldN, standoff);
      raycaster.set(from, worldN.clone().negate());
      // `false` — the part's own children are text and zone overlays, not
      // surface. (They also carry no-op raycasts, but this is cheaper.)
      const hit = raycaster.intersectObject(target, false)[0];
      if (!hit?.face) return null;
      const normal = hit.face.normal.clone()
        .transformDirection(carrier.matrixWorld).normalize();
      // A back-facing hit means the ray came in through the far side; flip
      // so the extrusion always leaves the material.
      if (normal.dot(worldN) < 0) normal.negate();
      return {
        point: [hit.point.x, hit.point.y, hit.point.z],
        normal: [normal.x, normal.y, normal.z],
      };
    };
  }

  /** A part's laid-out centre and extent, mm — what a repeat patterns. */
  private laidOut(partId: string): { centre: [number, number, number]; size: [number, number, number] } | null {
    const t = this.layout.get(partId);
    if (!t) return null;
    return {
      centre: [0, 1, 2].map((a) => (t.box.min[a] + t.box.max[a]) / 2) as [number, number, number],
      size: [0, 1, 2].map((a) => t.box.max[a] - t.box.min[a]) as [number, number, number],
    };
  }

  /**
   * Live repeat copies: a part's `repeats` spawn clones of its mesh — the
   * whole mesh, children included, so engraved geometry, extruded text and
   * image zones all come along. Copies carry the part's id, so clicking one
   * selects the part; they share geometry and material, so recolouring or
   * hiding the part takes every copy with it. Rebuilt only when the pattern,
   * the geometry or the child set actually changes; otherwise just re-posed.
   */
  private syncRepeats(): void {
    for (const part of this.manifest.parts) {
      const mesh = this.meshes.get(part.id);
      const laid = this.laidOut(part.id);
      if (!mesh || !laid) continue;
      const instances = repeatInstances(part.repeats, laid.centre, laid.size).slice(1);
      const sig = JSON.stringify([
        part.repeats ?? null, instances.length, mesh.geometry.uuid,
        mesh.children.map((c) => c.name),
      ]);
      let entry = this.repeatCopies.get(part.id);
      if (!entry || entry.sig !== sig) {
        for (const old of entry?.meshes ?? []) old.removeFromParent();
        const meshes = instances.map(() => {
          const copy = mesh.clone(true);
          // A copy is the part, not a new one: same id for picking, and its
          // cloned children (text, zone overlays) stay transparent to rays
          // exactly like the originals they came from.
          copy.userData.part = part.id;
          copy.traverse((o) => { if (o !== copy) o.raycast = () => {}; });
          this.group.add(copy);
          return copy;
        });
        entry = { meshes, sig };
        this.repeatCopies.set(part.id, entry);
      }
      instances.forEach((inst, i) => {
        const copy = entry!.meshes[i];
        if (!copy) return;
        copy.scale.copy(mesh.scale);
        copy.quaternion.copy(mesh.quaternion);
        if (inst.spinDeg) {
          // Circle mode: the copy's centre swings about the origin and the
          // body turns with it — one rigid turn, so it faces the tangent.
          copy.quaternion.premultiply(
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), inst.spinDeg * Math.PI / 180));
        }
        copy.position.set(inst.centre[0], inst.centre[1], inst.centre[2]);
        copy.visible = mesh.visible;
      });
    }
    // Parts that lost their repeats (or the part itself) leave nothing behind.
    for (const [partId, entry] of this.repeatCopies) {
      if (this.manifest.parts.some((p) => p.id === partId)) continue;
      for (const old of entry.meshes) old.removeFromParent();
      this.repeatCopies.delete(partId);
    }
  }

  /** Where the laid-out model currently sits, in mm — repeat copies AND
   * per-letter run pieces included, so framing, the grid, the shadow plane
   * and the shadow camera cover the whole row, however long it grows. */
  layoutBounds(): Box {
    const b = modelBounds(this.layout);
    for (const part of this.manifest.parts) {
      if (!part.repeats?.length) continue;
      const laid = this.laidOut(part.id);
      if (!laid) continue;
      // A turned copy's box is not axis-aligned; its bounding sphere is.
      const reach = Math.max(...laid.size) / 2;
      for (const inst of repeatInstances(part.repeats, laid.centre, laid.size)) {
        for (const a of [0, 1, 2]) {
          const half = inst.spinDeg ? reach : laid.size[a] / 2;
          b.min[a] = Math.min(b.min[a], inst.centre[a] - half);
          b.max[a] = Math.max(b.max[a], inst.centre[a] + half);
        }
      }
    }
    // Per-letter pieces live as meshes, not layout entries: each copy is its
    // member's laid-out box carried to where the piece actually sits (line
    // pieces keep the member's orientation, so the translated box is exact;
    // a ring piece is turned, so its bounding sphere stands in).
    for (const entry of this.perCharText.values()) {
      for (const clones of entry.pieces) {
        for (const [memberId, copy] of clones) {
          const src = this.meshes.get(memberId);
          const laid = this.laidOut(memberId);
          if (!src || !laid || !copy.visible) continue;
          const turned = !copy.quaternion.equals(src.quaternion);
          const reach = Math.max(...laid.size) / 2;
          for (const a of [0, 1, 2]) {
            const centre = laid.centre[a]
              + copy.position.getComponent(a) - src.position.getComponent(a);
            const half = turned ? reach : laid.size[a] / 2;
            b.min[a] = Math.min(b.min[a], centre - half);
            b.max[a] = Math.max(b.max[a], centre + half);
          }
        }
      }
    }
    return b;
  }

  /**
   * Bring the whole product to the world origin (customiser only): the
   * group is pushed by minus its own centre, so the model orbits around
   * itself and opens centred however the merchant laid it out. Everything
   * that turns layout mm into a WORLD position adds this offset back.
   */
  private recentreGroup(): void {
    if (!this.centreOnOrigin) return;
    const b = this.layoutBounds();
    if (!Number.isFinite(b.min[0])) return;
    this.centreOffset.set(
      -(b.min[0] + b.max[0]) / 2,
      -(b.min[1] + b.max[1]) / 2,
      -(b.min[2] + b.max[2]) / 2,
    );
    this.group.position.copy(this.centreOffset);
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
    const centre = new THREE.Vector3(...[0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2) as [number, number, number])
      .add(this.centreOffset);
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

  /**
   * The customiser's opening shot when the merchant saved no view: looking
   * down the 45° diagonal at the centred product, pulled back until the
   * whole of it fits — measured off the model's own footprint (the span the
   * ground grid covers) rather than a fixed distance, so a keyring and a
   * tabletop both open filling the same amount of frame.
   */
  private frameFromDefaultAngle(): void {
    const b = this.layoutBounds();
    if (!Number.isFinite(b.min[0])) return;
    const centre = new THREE.Vector3(...[0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2) as [number, number, number])
      .add(this.centreOffset);
    // The bounding SPHERE is what has to fit, so a product turned on the
    // grid can't poke out of frame at some other orbit angle.
    const radius = Math.max(
      0.5 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]),
      1,
    );
    const fov = (this.camera.fov * Math.PI) / 180;
    // Fit vertically AND horizontally, then leave a 12% margin.
    const fitV = radius / Math.sin(fov / 2);
    const fitH = radius / Math.sin(Math.atan(Math.tan(fov / 2) * this.camera.aspect));
    const distance = Math.max(fitV, fitH) * 1.12;
    // Looking DOWN at 45°, turned 45° round: the three-quarter view that
    // shows a top face, a front face and a side at once. (A normalised
    // (1,1,1) would only be 35° above the ground — the height has to be
    // sin 45° with the remaining cos 45° split across the two ground axes.)
    const up = Math.SQRT1_2;          // sin 45°
    const flat = Math.SQRT1_2 * up;   // cos 45°, split evenly over x and z
    const dir = new THREE.Vector3(flat, up, flat).normalize();
    this.controls.target.copy(centre);
    this.camera.position.copy(centre).addScaledVector(dir, distance);
    this.controls.minDistance = radius * 0.6;
    this.controls.maxDistance = radius * 12;
    this.camera.near = Math.max(distance / 100, 0.1);
    this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /**
   * Where the product's material actually is — the area-weighted centroid of
   * every visible triangle, in world space.
   *
   * The bounding-box centre is the wrong "middle" for a thumbnail: one tall
   * antenna drags the box up and the product ends up in the bottom third of
   * the frame. Mass follows surface, not extremes. Heavy meshes are sampled
   * with a stride so a million-triangle import doesn't stall the save path.
   */
  private centreOfMass(): THREE.Vector3 | null {
    return this.centreOfMassOf(null);
  }

  /**
   * Centre of mass restricted to SOME parts — what an assembly's gizmo and
   * camera centre on. `null` means the whole product. Traversal starts at
   * each part's root so glyphs and decals parented under it count too.
   */
  centreOfMassOf(partIds: string[] | null): THREE.Vector3 | null {
    const roots: THREE.Object3D[] = partIds
      ? partIds.map((id) => this.meshes.get(id)).filter((m): m is THREE.Mesh => !!m)
      : [this.group];
    if (partIds) {
      // The part's material does not stop at its source mesh: live repeat
      // copies and per-letter run pieces are the same body continued, so the
      // centre of mass — and the gizmo parked on it — sits mid-row, not on
      // the first instance.
      for (const id of partIds) {
        const rep = this.repeatCopies.get(id);
        if (rep) roots.push(...rep.meshes);
        for (const entry of this.perCharText.values()) {
          if (!entry.members.includes(id)) continue;
          for (const clones of entry.pieces) {
            const copy = clones.get(id);
            if (copy) roots.push(copy);
          }
        }
      }
    }
    const acc = new THREE.Vector3();
    let total = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3();
    this.group.updateWorldMatrix(true, true);
    for (const root of roots) root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh || !mesh.visible) return;
      const geom = mesh.geometry as THREE.BufferGeometry;
      const pos = geom.getAttribute('position');
      if (!pos) return;
      const index = geom.getIndex();
      const count = index ? index.count : pos.count;
      const at = (k: number, out: THREE.Vector3) =>
        out.fromBufferAttribute(pos, index ? index.getX(k) : k).applyMatrix4(mesh.matrixWorld);
      // At most ~20k triangles per mesh feed the estimate.
      const stride = 3 * Math.max(1, Math.floor(count / 3 / 20000));
      for (let i = 0; i + 2 < count; i += stride) {
        at(i, a); at(i + 1, b); at(i + 2, c);
        const area = ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
        if (!Number.isFinite(area) || area === 0) continue;
        acc.addScaledVector(a.add(b).add(c).divideScalar(3), area);
        total += area;
      }
    });
    return total > 0 ? acc.divideScalar(total) : null;
  }

  /**
   * A 16:9, whole-product still — the dashboard thumbnail.
   *
   * Framed from the same 45° three-quarter angle the customiser opens on,
   * but CENTRED ON THE CENTRE OF MASS rather than the bounding box's middle,
   * so the product sits where the eye expects it however lopsided its
   * extremes. The radius is the farthest bounding-box corner from that
   * centre, which is what keeps the whole object in frame even when the
   * centre is off-middle. Everything that is not the product or a light is
   * hidden for the shot (the Studio's grid, axes and gizmos live in the
   * scene but are not the product), then camera, canvas and visibility are
   * restored and a normal frame is rendered so the merchant never sees the
   * detour.
   */
  snapshot(widthPx = 640, heightPx = Math.round(widthPx * 9 / 16)): string {
    const cam = this.camera;
    const ctl = this.controls;
    const keep = {
      pos: cam.position.clone(), near: cam.near, far: cam.far, aspect: cam.aspect,
      target: ctl.target.clone(), min: ctl.minDistance, max: ctl.maxDistance,
    };
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    const hidden: THREE.Object3D[] = [];
    for (const child of this.scene.children) {
      if (child === this.group || (child as THREE.Light).isLight || !child.visible) continue;
      child.visible = false;
      hidden.push(child);
    }
    try {
      this.renderer.setSize(widthPx, heightPx, false);
      cam.aspect = widthPx / heightPx;
      cam.updateProjectionMatrix();

      const bounds = this.layoutBounds();
      if (Number.isFinite(bounds.min[0])) {
        const centre = this.centreOfMass()
          ?? new THREE.Vector3(
            ...[0, 1, 2].map((axis) => (bounds.min[axis] + bounds.max[axis]) / 2) as [number, number, number],
          ).add(this.centreOffset);
        let radius = 1;
        for (const x of [bounds.min[0], bounds.max[0]]) {
          for (const y of [bounds.min[1], bounds.max[1]]) {
            for (const z of [bounds.min[2], bounds.max[2]]) {
              radius = Math.max(radius,
                centre.distanceTo(new THREE.Vector3(x, y, z).add(this.centreOffset)));
            }
          }
        }
        const fov = (cam.fov * Math.PI) / 180;
        const fitV = radius / Math.sin(fov / 2);
        const fitH = radius / Math.sin(Math.atan(Math.tan(fov / 2) * cam.aspect));
        const distance = Math.max(fitV, fitH) * 1.08;
        const up = Math.SQRT1_2;
        const flat = Math.SQRT1_2 * up;
        const dir = new THREE.Vector3(flat, up, flat).normalize();
        ctl.target.copy(centre);
        cam.position.copy(centre).addScaledVector(dir, distance);
        cam.near = Math.max(distance / 100, 0.1);
        cam.far = distance * 20;
        cam.updateProjectionMatrix();
        ctl.update();
      }
      this.renderer.render(this.scene, cam);
      return this.renderer.domElement.toDataURL('image/png');
    } finally {
      for (const child of hidden) child.visible = true;
      this.renderer.setSize(size.x, size.y, false);
      cam.aspect = keep.aspect;
      cam.near = keep.near;
      cam.far = keep.far;
      cam.position.copy(keep.pos);
      ctl.target.copy(keep.target);
      ctl.minDistance = keep.min;
      ctl.maxDistance = keep.max;
      cam.updateProjectionMatrix();
      ctl.update();
      this.renderer.render(this.scene, cam);
    }
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
    return this.surfaceFromCast(hit);
  }

  /**
   * The same weld, seeded from a stored zone plane instead of a click —
   * how "Reset shape" re-finds the face a zone was placed on. `localPoint`
   * and `localNormal` are in the part's local mesh space, exactly as an
   * upload option stores them.
   */
  surfaceAtLocal(
    partId: string,
    localPoint: [number, number, number],
    localNormal: [number, number, number],
  ): SurfaceHit | null {
    const mesh = this.meshes.get(partId);
    if (!mesh) return null;
    mesh.updateMatrixWorld();
    const worldN = new THREE.Vector3(...localNormal).transformDirection(mesh.matrixWorld).normalize();
    const worldP = mesh.localToWorld(new THREE.Vector3(...localPoint));
    const raycaster = new THREE.Raycaster();
    raycaster.set(worldP.clone().addScaledVector(worldN, 5), worldN.clone().negate());
    const hit = raycaster.intersectObject(mesh, false)[0];
    if (!hit?.face || hit.faceIndex == null) return null;
    return this.surfaceFromCast({
      partId, normal: [worldN.x, worldN.y, worldN.z], mesh, faceIndex: hit.faceIndex,
    });
  }

  private surfaceFromCast(hit: {
    partId: string; normal: [number, number, number]; mesh: THREE.Mesh; faceIndex: number;
  }): SurfaceHit | null {
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

    // Is the picked face part of a CURVE, or a genuine flat face?
    //
    // The weld stops at the first bend, so on a tessellated cylinder the
    // region is one narrow facet strip whose neighbours lean a few degrees
    // away, while on a box the neighbours are a hard 90° off. The smallest
    // angle to a rejected neighbour tells the two apart: a gentle break is
    // curvature carrying on, a sharp one is a real edge. Reported in
    // degrees so callers can pick their own threshold.
    let breakDeg = 180;
    for (const f of faces) {
      for (const next of adjacency[f]) {
        if (seen.has(next) && faces.includes(next)) continue;
        const cos = Math.min(1, Math.abs(localNormal(next, n).dot(seedNormal)));
        breakDeg = Math.min(breakDeg, Math.acos(cos) * 180 / Math.PI);
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

    // The rectangle hugging the region, for zones that conform to the face.
    const triangles = faces.map((f) => ([0, 1, 2] as const).map((c) => {
      const p = new THREE.Vector3().fromBufferAttribute(pos, tri(f, c));
      return [p.x, p.y, p.z] as [number, number, number];
    }));
    const zone = fitZoneToRegion(triangles, [outwardLocal.x, outwardLocal.y, outwardLocal.z]);
    if (zone) {
      // The fit measured LOCAL millimetres; zones are WORLD millimetres
      // (that is what the overlay plane renders in), so a resized part's
      // face must report its resized extents. Measure the fitted axes
      // through the carrier's transform.
      const th = zone.angleDeg * Math.PI / 180;
      const nL = outwardLocal;
      const upRef = Math.abs(nL.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1);
      const xL = new THREE.Vector3().crossVectors(upRef, nL).normalize();
      const yL = new THREE.Vector3().crossVectors(nL, xL).normalize();
      const aL = xL.clone().multiplyScalar(Math.cos(th)).addScaledVector(yL, Math.sin(th));
      const bL = yL.clone().multiplyScalar(Math.cos(th)).addScaledVector(xL, -Math.sin(th));
      const c = new THREE.Vector3(...zone.centre);
      const spanAlong = (axis: THREE.Vector3) =>
        hit.mesh.localToWorld(c.clone().addScaledVector(axis, 0.5))
          .distanceTo(hit.mesh.localToWorld(c.clone().addScaledVector(axis, -0.5)));
      const localW = zone.widthMm, localH = zone.heightMm;
      zone.widthMm = Math.min(500, Math.max(1, Math.round(localW * spanAlong(aL) * 10) / 10));
      zone.heightMm = Math.min(500, Math.max(1, Math.round(localH * spanAlong(bL) * 10) / 10));
      if (zone.outline) {
        const su = zone.widthMm / localW, sv = zone.heightMm / localH;
        zone.outline = zone.outline.map(([u, v]): [number, number] =>
          [Math.round(u * su * 10) / 10, Math.round(v * sv * 10) / 10]);
      }
    }

    return {
      partId: hit.partId,
      normal: hit.normal,
      faces,
      localCentre: [centroid.x, centroid.y, centroid.z],
      localNormal: [outwardLocal.x, outwardLocal.y, outwardLocal.z],
      zone,
      breakDeg,
      curved: breakDeg < CURVE_BREAK_DEG,
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

  /**
   * Every visible part and live repeat copy, geometry baked into world
   * millimetres — what an exporter writes to disk. This walks the SCENE, so
   * whatever is true on screen is true in the file: layout transforms,
   * engraving cuts, repeat placement. Hidden parts are skipped (export what
   * you see); text runs, image zones and other customer-side previews stay
   * out — they belong to a customer's order, not the merchant's model.
   */
  exportMeshes(partIds?: string[]): Array<{ name: string; positions: Float32Array; indices: Uint32Array }> {
    this.scene.updateMatrixWorld(true);
    const wanted = partIds ? new Set(partIds) : null;
    // Everything relative to the model group, so the customiser's
    // centre-on-origin shift never leaks into exported coordinates.
    const inverse = this.group.matrixWorld.clone().invert();
    const out: Array<{ name: string; positions: Float32Array; indices: Uint32Array }> = [];
    const bake = (obj: THREE.Object3D, name: string) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      const pos = mesh.geometry.getAttribute('position');
      if (!pos || pos.count === 0) return;
      const m = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
      const v = new THREE.Vector3();
      const positions = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(m);
        positions[i * 3] = v.x; positions[i * 3 + 1] = v.y; positions[i * 3 + 2] = v.z;
      }
      const idx = mesh.geometry.getIndex();
      const indices = idx
        ? Uint32Array.from(idx.array as ArrayLike<number>)
        : Uint32Array.from({ length: pos.count }, (_, i) => i);
      out.push({ name, positions, indices });
    };
    for (const [partId, mesh] of this.meshes) {
      if (!wanted || wanted.has(partId)) bake(mesh, partId);
    }
    for (const [partId, entry] of this.repeatCopies) {
      if (wanted && !wanted.has(partId)) continue;
      entry.meshes.forEach((copy, i) => {
        const target = (copy as THREE.Mesh).isMesh
          ? copy
          : copy.children.find((c) => (c as THREE.Mesh).isMesh);
        if (target) bake(target, `${partId}-copy-${i + 1}`);
      });
    }
    return out;
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
    // After the text and zones settle: copies mirror whatever the part
    // ended up being — cut geometry, extruded glyphs, painted zones.
    this.syncRepeats();
    // Gradients LAST: engraving may just have swapped a part's geometry, and
    // the vertex colours live on the geometry.
    this.syncGradients(colours);
    // apply() just repainted every material with its TRUE colour — drop the
    // emphasis stashes (they are stale) and re-dim from the fresh paint.
    for (const material of this.materials.values()) {
      delete (material.userData as { trueColour?: THREE.Color }).trueColour;
    }
    this.syncEmphasisColours();
    // A typed word may have grown or shrunk a per-letter run just now — the
    // shadow plane and shadow camera must cover wherever it ends today.
    this.fitShadowCatcher();
    this.highlight(this.highlighted);
  }

  /** Gradient swatches → vertex colours; solid swatches → plain material
   * colour (and any stale gradient attribute cleaned away). */
  private syncGradients(colours: Map<string, ResolvedColour>): void {
    const AXIS = { x: 0, y: 1, z: 2 } as const;
    for (const part of this.manifest.parts) {
      const mesh = this.meshes.get(part.id);
      const material = this.materials.get(part.id);
      if (!mesh || !material) continue;
      const geom = mesh.geometry as THREE.BufferGeometry;
      const colour = colours.get(part.id);
      if (colour?.hex2) {
        const axis = AXIS[colour.gradientAxis ?? 'y'];
        const sig = `${colour.hex}>${colour.hex2}@${axis}#${geom.uuid}`;
        if (this.gradientSig.get(part.id) !== sig) {
          paintGradient(geom, colour.hex, colour.hex2, axis);
          this.gradientSig.set(part.id, sig);
        }
        if (!material.vertexColors) { material.vertexColors = true; material.needsUpdate = true; }
        // The blend carries ALL the colour; a tinted base would double-dye it.
        material.color.set('#FFFFFF');
      } else if (this.gradientSig.has(part.id)) {
        this.gradientSig.delete(part.id);
        geom.deleteAttribute('color');
        material.vertexColors = false;
        material.needsUpdate = true;
        if (colour) material.color.set(colour.hex);
      }
    }
  }

  /**
   * Customer images render on the PICKED SURFACE ITSELF: the zone overlay
   * is built from the exact triangles of the welded face region — the same
   * geometry the Studio's blue highlight shows — lifted 0.15 mm along the
   * face normal and UV-mapped across the zone rectangle. The face's own
   * rim IS the mask: rounded corners, chamfers, holes, anything — nothing
   * is approximated by a curve, so nothing can protrude past an edge.
   * The image is DRAWN into a canvas texture at its offset/size, so
   * repositioning and resizing repaint a canvas instead of rebuilding
   * geometry. While no image is uploaded the same canvas shows the
   * translucent veil in the merchant's own wording, shaped by the region like everything
   * else. The overlay is the carrier's CHILD, so every move, rotation and
   * resize of the part carries it for free; it rebuilds only when the
   * zone or the carrier's own geometry (a deboss cut) changes.
   */
  private syncImages(selections: Selections): void {
    const wanted = new Set<string>();
    for (const option of this.manifest.options) {
      if (option.type !== 'upload') continue;
      wanted.add(option.id);
      const carrier = this.meshes.get(option.part);
      if (!carrier) { this.dropImage(option.id); continue; }
      const state = parseUploadState(selections[option.id]);
      let entry = this.imageZones.get(option.id);
      if (!entry) {
        entry = { key: '', paint: '' };
        this.imageZones.set(option.id, entry);
      }

      const key = JSON.stringify([
        option.origin, option.normal, option.rotationDeg, option.widthMm, option.heightMm, option.part,
        (carrier.geometry as THREE.BufferGeometry).uuid,
      ]);
      if (entry.key !== key) {
        entry.mesh?.removeFromParent();
        entry.mesh?.geometry.dispose();
        (entry.mesh?.material as THREE.Material | undefined)?.dispose();
        entry.texture?.dispose();
        entry.mesh = undefined;
        entry.key = key;
        entry.paint = '';

        const region = this.surfaceAtLocal(option.part, option.origin, option.normal);
        const built = region ? this.buildZoneOverlay(carrier, option, region) : null;
        if (built) {
          entry.mesh = built.mesh;
          entry.canvas = built.canvas;
          entry.texture = built.texture;
          carrier.add(built.mesh);
        }
      }
      if (!entry.mesh) continue;

      // Paint key: image, offset, size and the merchant's empty-zone wording
      // only repaint the canvas.
      const paint = JSON.stringify([
        option.widthMm, option.heightMm, zonePlaceholder(option),
        state ? [state.img.length, state.img.slice(-48), state.u, state.v, state.s] : null,
      ]);
      if (entry.paint === paint) continue;
      entry.paint = paint;
      if (!state) {
        delete entry.imgEl;
        delete entry.imgSrc;
        this.paintZone(option, entry, null);
        continue;
      }
      if (entry.imgSrc === state.img && entry.imgEl) {
        this.paintZone(option, entry, state);
      } else {
        // New image: show the frame while it decodes, then paint.
        this.paintZone(option, entry, null);
        const img = new Image();
        // Artwork served from the upload service is cross-origin, and a
        // canvas that draws a cross-origin image without this is TAINTED —
        // WebGL then refuses it as a texture and the zone renders blank.
        // Harmless on a data: URL, so it is set unconditionally.
        img.crossOrigin = 'anonymous';
        entry.imgSrc = state.img;
        img.onload = () => {
          const now = this.imageZones.get(option.id);
          if (now !== entry || entry.imgSrc !== state.img) return; // superseded
          entry.imgEl = img;
          this.paintZone(option, entry, parseUploadState(this.lastSelections[option.id]));
        };
        img.src = state.img;
      }
    }
    for (const id of [...this.imageZones.keys()]) {
      if (!wanted.has(id)) this.dropImage(id);
    }
  }

  /**
   * The zone overlay itself: the welded region's triangles, in the
   * carrier's local space, lifted 0.15 mm along the zone normal and
   * UV-mapped across the zone rectangle. The region IS the mask.
   */
  private buildZoneOverlay(
    carrier: THREE.Mesh, option: UploadOption, region: SurfaceHit,
  ): { mesh: THREE.Mesh; canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } | null {
    const src = carrier.geometry as THREE.BufferGeometry;
    const srcPos = src.attributes.position as THREE.BufferAttribute;
    const index = src.index;
    const corner = (f: number, c: number) => (index ? index.getX(f * 3 + c) : f * 3 + c);

    // Zone basis in the carrier's local space — same convention as glyphs.
    const n = new THREE.Vector3(...option.normal).normalize();
    const upRef = Math.abs(n.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1);
    const a = new THREE.Vector3().crossVectors(upRef, n).normalize();
    const b = new THREE.Vector3().crossVectors(n, a).normalize();
    if (option.rotationDeg) {
      const spin = new THREE.Quaternion().setFromAxisAngle(n, option.rotationDeg * Math.PI / 180);
      a.applyQuaternion(spin);
      b.applyQuaternion(spin);
    }
    const origin = new THREE.Vector3(...option.origin);

    const count = region.faces.length * 3;
    if (!count) return null;
    const positions = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const p = new THREE.Vector3();
    let at = 0;
    for (const f of region.faces) {
      for (let c = 0; c < 3; c++) {
        p.fromBufferAttribute(srcPos, corner(f, c)).addScaledVector(n, 0.15); // hover off the surface
        positions[at * 3] = p.x;
        positions[at * 3 + 1] = p.y;
        positions[at * 3 + 2] = p.z;
        p.sub(origin);
        uv[at * 2] = p.dot(a) / option.widthMm + 0.5;
        uv[at * 2 + 1] = p.dot(b) / option.heightMm + 0.5;
        at++;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

    // Canvas matched to the zone's aspect so nothing distorts.
    const canvas = document.createElement('canvas');
    const aspect = option.widthMm / option.heightMm;
    canvas.width = aspect >= 1 ? 1024 : Math.max(64, Math.round(1024 * aspect));
    canvas.height = aspect >= 1 ? Math.max(64, Math.round(1024 / aspect)) : 1024;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;

    // Unlit, like the storefront's logo overlay — the customer's artwork
    // keeps its true colours regardless of scene lighting. DoubleSide keeps
    // the overlay honest on flipped-winding merchant meshes.
    const material = new THREE.MeshBasicMaterial({
      map: texture, transparent: true, depthWrite: false, alphaTest: 0.005,
      polygonOffset: true, polygonOffsetFactor: -4, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `image-zone-${option.id}`;
    mesh.renderOrder = 2;
    mesh.raycast = () => {};
    return { mesh, canvas, texture };
  }

  /** Draw the zone's current face: the customer's image at its offset and
   * size — or the translucent veil, labelled in the merchant's own words,
   * when there is no image yet. The region geometry shapes whatever is
   * painted here. */
  private paintZone(
    option: UploadOption,
    entry: { canvas?: HTMLCanvasElement; texture?: THREE.CanvasTexture; imgEl?: HTMLImageElement; hasImage?: boolean },
    state: UploadState | null,
  ): void {
    const canvas = entry.canvas;
    const texture = entry.texture;
    if (!canvas || !texture) return;
    const ctx = canvas.getContext('2d')!;
    const cw = canvas.width, ch = canvas.height;
    const map = ([u, v]: [number, number]): [number, number] =>
      [(u / option.widthMm + 0.5) * cw, (0.5 - v / option.heightMm) * ch];
    ctx.clearRect(0, 0, cw, ch);

    if (state && entry.imgEl) {
      const img = entry.imgEl;
      const aspect = img.naturalWidth / Math.max(1, img.naturalHeight);
      // 100% = the largest fit inside the zone, aspect preserved; beyond
      // 100 the image outgrows the zone and crops to it.
      let w = Math.min(option.widthMm, option.heightMm * aspect);
      let h = w / aspect;
      w *= state.s / 100;
      h *= state.s / 100;
      // The offset may roam the slack: inside the zone while the image is
      // smaller, across the overflow once it is bigger — either way the
      // image never abandons the zone.
      const uLim = Math.abs(option.widthMm - w) / 2;
      const vLim = Math.abs(option.heightMm - h) / 2;
      const u = Math.max(-uLim, Math.min(uLim, state.u));
      const v = Math.max(-vLim, Math.min(vLim, state.v));
      const [dx, dy] = map([u - w / 2, v + h / 2]);
      ctx.drawImage(img, dx, dy, (w / option.widthMm) * cw, (h / option.heightMm) * ch);
      entry.hasImage = true;
    } else {
      // An empty zone reads as a soft sticker area: a translucent veil
      // (white so it lightens dark parts, with a whisper of grey so it
      // still reads on white ones), quietly labelled in the middle. The
      // region geometry cuts it to the face's exact shape.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.fillRect(0, 0, cw, ch);
      ctx.fillStyle = 'rgba(60, 60, 60, 0.08)';
      ctx.fillRect(0, 0, cw, ch);
      const label = zonePlaceholder(option);
      if (label) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        // The merchant writes the wording, so the label shrinks to stay
        // inside the zone rather than running off its own veil.
        const face = (px: number) => `500 ${px}px system-ui, -apple-system, sans-serif`;
        let labelPx = Math.max(13, Math.round(Math.min(cw, ch) * 0.09));
        ctx.font = face(labelPx);
        const room = cw * 0.86;
        const width = ctx.measureText(label).width;
        if (width > room) {
          labelPx = Math.max(8, Math.floor(labelPx * (room / width)));
          ctx.font = face(labelPx);
        }
        ctx.fillText(label, cw / 2, ch / 2);
      }
      entry.hasImage = false;
    }
    texture.needsUpdate = true;
  }

  private dropImage(optionId: string): void {
    const entry = this.imageZones.get(optionId);
    if (!entry) return;
    entry.mesh?.removeFromParent();
    entry.mesh?.geometry.dispose();
    (entry.mesh?.material as THREE.Material | undefined)?.dispose();
    entry.texture?.dispose();
    this.imageZones.delete(optionId);
  }

  /** The zone's plane while a customer image is showing — a test hook. */
  imageDecalOf(optionId: string): THREE.Mesh | undefined {
    const entry = this.imageZones.get(optionId);
    return entry?.hasImage ? entry.mesh : undefined;
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
      // The slot's colour: the customer's pick when the merchant opened that
      // choice, else the pinned colour, else undefined (follows the part).
      const spec: TextOption = { ...option, colourHex: textColour(this.manifest, selections, option) };
      if (option.perChar) {
        this.dropTextMesh(option.id); // the slot may have just been switched over
        this.dropDebossFloor(option.id);
        this.syncPerChar(spec, carrier, text);
      } else if ((option.style ?? 'emboss') === 'deboss') {
        // Engraved: no glyph mesh — the part's own geometry is cut, and the
        // pocket floor rides as its own mesh in the slot's text colour.
        // Gathered per part so several slots compose one subtraction chain.
        this.dropTextMesh(option.id);
        this.dropPerChar(option.id);
        const jobs = debossJobs.get(option.part) ?? [];
        jobs.push({ spec, text });
        debossJobs.set(option.part, jobs);
      } else {
        this.dropPerChar(option.id);
        this.dropDebossFloor(option.id);
        this.syncSingle(spec, carrier, text);
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
        j.spec.rotationDeg, j.spec.bendDeg, j.spec.path, j.spec.origin, j.spec.normal,
        j.spec.wrapSurface, j.spec.liftMm,
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
        const scale = this.partScale(partId);
        const carrierMesh = this.meshes.get(partId);
        const toLocal = carrierMesh
          ? new THREE.Matrix4().copy(carrierMesh.matrixWorld).invert()
          : new THREE.Matrix4();
        // Wrapped cuts follow the surface, so they probe the PRISTINE base
        // rather than whatever the chain has already carved.
        const probeFor = (spec: TextOption) => (spec.wrapSurface
          ? this.surfaceProbe(spec, base)
          : null);
        list.forEach((j, i) => {
          const probe = probeFor(j.spec);
          const next = probe
            ? cutWrappedTextGeometry(geo, j.text, fonts[i], j.spec, csg, probe, toLocal)
            : cutTextGeometry(geo, j.text, fonts[i], j.spec, csg, scale);
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
            j.spec.rotationDeg, j.spec.bendDeg, j.spec.path, j.spec.origin, j.spec.normal,
            j.spec.colourHex, scale, j.spec.wrapSurface, j.spec.liftMm,
          ]);
          let entry = this.debossFloors.get(j.spec.id);
          if (entry?.key === floorKey && entry.mesh.parent === target) return;
          if (entry) { entry.mesh.removeFromParent(); entry.mesh.geometry.dispose(); }
          const holder = { customMat: entry?.customMat };
          const wrapProbe = probeFor(j.spec);
          const floorGeo = (wrapProbe && wrappedPocketFloor(j.text, fonts[i], j.spec, wrapProbe, toLocal))
            || pocketFloor(j.text, fonts[i], j.spec, scale);
          const mesh = new THREE.Mesh(floorGeo, undefined as unknown as THREE.Material);
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
      option.rotationDeg, option.bendDeg, option.path, option.origin, option.normal, option.part,
      option.colourHex, option.style, this.partScale(option.part),
      option.wrapSurface, option.liftMm, carrier.geometry.uuid,
    ]);
    if (existing?.key === key) return;
    this.textMeshes.set(option.id, { mesh: existing?.mesh, key, customMat: existing?.customMat });

    const spec = { ...option };
    loadFont(option.font ?? DEFAULT_FONT).then((font) => {
      const current = this.textMeshes.get(option.id);
      if (current?.key !== key) return; // superseded while the font loaded
      // Wrapped slots follow the geometry: the run is laid ON the surface
      // and baked into the carrier's local space, so the mesh itself needs
      // no pose. Engraved slots keep the flat cut for now, and a run that
      // finds no surface falls back to the flat plane rather than vanishing.
      const wrapped = spec.wrapSurface && (spec.style ?? 'emboss') === 'emboss'
        ? this.wrapText(text, font, spec)
        : null;
      const geo = wrapped?.geometry ?? buildTextGeometry(text, font, spec);
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
      if (wrapped) {
        // Already posed, in the carrier's own space.
        mesh.position.set(0, 0, 0);
        mesh.quaternion.identity();
        mesh.scale.set(1, 1, 1);
      } else {
        placeGlyph(mesh, spec, this.partScale(spec.part));
      }
    });
  }

  /** The run laid on the part's surface, baked into the carrier's local
   * space. Null when there is no geometry under the slot at all. */
  private wrapText(text: string, font: Font, spec: TextOption, geometry?: THREE.BufferGeometry) {
    const carrier = this.meshes.get(spec.part);
    const probe = this.surfaceProbe(spec, geometry);
    if (!carrier || !probe) return null;
    carrier.updateMatrixWorld();
    const toLocal = new THREE.Matrix4().copy(carrier.matrixWorld).invert();
    const out = wrappedTextGeometry(text, font, spec, probe, toLocal);
    if (out?.missed.length) {
      console.warn(`[configurator] "${spec.id}": ${out.missed.length} character(s) ran off the surface`);
    }
    return out;
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
      // Spawned pieces carry ONE character each on the template's face —
      // the run-level baselines (Bend arc, drawn path) don't apply, and a
      // path would drag every glyph to the curve's midpoint. Strip both.
      const spec = { ...option, bendDeg: undefined, path: undefined };
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
            const geo = ch === ' ' ? base.clone() : cutTextGeometry(base, ch, font, spec, csg, this.partScale(spec.part));
            if (ch !== ' ') applyBoxUvs(geo);
            target.geometry = geo;
            current.ownGeometries!.push(geo);
            if (ch !== ' ') {
              // Each piece's pocket floor carries the text colour.
              const floor = new THREE.Mesh(pocketFloor(ch, font, spec, this.partScale(spec.part)), floorMaterial);
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
            placeGlyph(glyph, spec, this.partScale(spec.part));
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
    // updateTextRuns. A turned template marches off the canonical axis, so
    // only the step's component ALONG that axis joins the target.
    if (this.centreTextRuns && mode === 'line') {
      const span = this.perCharSpan(members, axis, gap);
      const carrierQ = this.meshes.get(option.part)?.quaternion ?? new THREE.Quaternion();
      const pitch = this.perCharPitch(members, axis, gap, carrierQ);
      const along = axisDir(axis, carrierQ).getComponent(axis);
      const target = -(span.centre + pitch * along * (chars.length - 1) / 2);
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

  /**
   * The template's extent along its OWN row axis, plus the gap — measured in
   * the carrier's frame, where the world box of a turned template would be
   * inflated by the turn. Rotation-invariant by construction: turn the
   * assembly and the letters keep exactly their spacing.
   */
  private perCharPitch(members: string[], axis: number, gap: number, carrierQ: THREE.Quaternion): number {
    const inv = carrierQ.clone().invert();
    const corner = new THREE.Vector3();
    let lo = Infinity, hi = -Infinity;
    for (const memberId of members) {
      const mesh = this.meshes.get(memberId);
      if (!mesh) continue;
      const geo = mesh.geometry as THREE.BufferGeometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (!bb) continue;
      for (let c = 0; c < 8; c++) {
        corner
          .set(c & 1 ? bb.max.x : bb.min.x, c & 2 ? bb.max.y : bb.min.y, c & 4 ? bb.max.z : bb.min.z)
          .multiply(mesh.scale).applyQuaternion(mesh.quaternion).add(mesh.position)
          .applyQuaternion(inv);
        const s = corner.getComponent(axis);
        lo = Math.min(lo, s);
        hi = Math.max(hi, s);
      }
    }
    return Number.isFinite(lo) ? hi - lo + gap : gap;
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

    // The pattern belongs to the TEMPLATE, not the world: pieces march along
    // the carrier's axis (line) or ring its vertical (circle), so turning or
    // scaling the whole assembly carries the entire run rigidly with it —
    // spin AND orbit — instead of leaving copies strung along a world axis
    // while each one twirls in place.
    const carrierQ = this.meshes.get(entry.part)?.quaternion ?? new THREE.Quaternion();
    if (mode === 'line') {
      const pitch = this.perCharPitch(members, axis, gap, carrierQ);
      const dir = axisDir(axis, carrierQ);
      entry.pieces.forEach((clones, i) => {
        for (const [memberId, copy] of clones) {
          const src = this.meshes.get(memberId);
          if (!src) continue;
          copy.position.copy(src.position).addScaledVector(dir, pitch * (i + 1));
          copy.quaternion.copy(src.quaternion);
          copy.scale.copy(src.scale);
          copy.visible = src.visible;
        }
      });
    } else {
      const Y = new THREE.Vector3(0, 1, 0);
      const invQ = carrierQ.clone().invert();
      entry.pieces.forEach((clones, i) => {
        // Same convention as the repeat tool's circle: piece k sits k·step
        // further round the ring; three's −angle Y-rotation advances the
        // ground-plane angle by +angle, and body spin matches the orbit.
        // Conjugating by the carrier's rotation tilts the ring's axis with
        // the template; with no turn it reduces to the plain world-Y ring.
        const q = new THREE.Quaternion().setFromAxisAngle(Y, -((i + 1) * stepDeg) * Math.PI / 180)
          .premultiply(carrierQ).multiply(invQ);
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

    // Parts ATTACHED to this run follow its LAST piece: the static layout
    // glued them against the template (piece #1), so a charm on the end of a
    // clicker walks outward one pitch per typed letter — and walks back in
    // as letters are deleted.
    this.placeRunFollowers(option, entry, mode, axis, gap, stepDeg);
  }

  /** Move every part attached to this run's template so it hangs off the
   * run's last piece rather than its first. Base pose comes from the layout
   * each time, so the shift never compounds. */
  private placeRunFollowers(
    option: TextOption, entry: PerCharEntry,
    mode: 'line' | 'circle', axis: number, gap: number, stepDeg: number,
  ): void {
    const count = entry.pieces.length;
    const base = new THREE.Vector3();
    for (const part of this.manifest.parts) {
      if (!part.attach) continue;
      const targets = attachTargetParts(this.manifest, part.attach.to);
      if (!targets.some((id) => entry.members.includes(id))) continue;
      const mesh = this.meshes.get(part.id);
      if (!mesh || !this.layoutPosition(part.id, base)) continue;
      const authored = this.layout.get(part.id);
      mesh.position.copy(base);
      if (authored) {
        mesh.rotation.set(
          authored.rotation[0] * Math.PI / 180,
          authored.rotation[1] * Math.PI / 180,
          authored.rotation[2] * Math.PI / 180);
      }
      if (mode === 'line') {
        const carrierQ = this.meshes.get(entry.part)?.quaternion ?? new THREE.Quaternion();
        // The same centring shift the members wear (customiser), then the
        // whole run's length along its own marching direction.
        if (this.centreTextRuns && entry.offset) {
          mesh.position.setComponent(axis, mesh.position.getComponent(axis) + entry.offset.current);
        }
        if (count > 0) {
          mesh.position.addScaledVector(axisDir(axis, carrierQ), this.perCharPitch(entry.members, axis, gap, carrierQ) * count);
        }
      } else if (count > 0) {
        // Ring: ride round to the last piece exactly as the pieces did.
        const carrierQ = this.meshes.get(entry.part)?.quaternion ?? new THREE.Quaternion();
        const q = new THREE.Quaternion()
          .setFromAxisAngle(new THREE.Vector3(0, 1, 0), -(count * stepDeg) * Math.PI / 180)
          .premultiply(carrierQ).multiply(carrierQ.clone().invert());
        mesh.position.applyQuaternion(q);
        mesh.quaternion.premultiply(q);
      }
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
    // A follower glued to this run returns to its authored seat (the next
    // apply() will not reposition it if the run is gone for good).
    {
      const base = new THREE.Vector3();
      for (const part of this.manifest.parts) {
        if (!part.attach) continue;
        const targets = attachTargetParts(this.manifest, part.attach.to);
        if (!targets.some((id) => entry.members.includes(id))) continue;
        const mesh = this.meshes.get(part.id);
        if (!mesh || !this.layoutPosition(part.id, base)) continue;
        mesh.position.copy(base);
        const authored = this.layout.get(part.id);
        if (authored) {
          mesh.rotation.set(
            authored.rotation[0] * Math.PI / 180,
            authored.rotation[1] * Math.PI / 180,
            authored.rotation[2] * Math.PI / 180);
        }
      }
    }
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

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerup', (e) => {
      // Only the LEFT button selects (or deselects). Right/middle belong to
      // the camera — a right-click pan must never drop the selection and
      // yank the orbit centre back to the origin under the merchant.
      if (e.button !== 0) return;
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
      this.trackEmphasisOutline();
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  /**
   * Studio selection emphasis: every OTHER part fades to a ghost and the
   * selected one wears a thin white rim (its own geometry re-rendered
   * slightly inflated, back faces only — the classic silhouette outline,
   * no post-processing). The embed never calls this.
   *
   * The fade is a COLOUR blend toward the page background, not opacity:
   * transparency on double-sided meshes renders back faces through front
   * faces in draw order and the whole part shimmers — opaque paint cannot
   * flicker.
   */
  setSelectionEmphasis(partId: string | null): void {
    this.emphasis = partId;
    this.syncEmphasisColours();
    if (this.outlineMesh) {
      this.scene.remove(this.outlineMesh);
      this.outlineMesh = undefined;
    }
    const target = partId ? this.meshes.get(partId) : undefined;
    if (target) {
      this.outlineMat ??= new THREE.MeshBasicMaterial({
        color: 0xffffff, side: THREE.BackSide, toneMapped: false,
      });
      const hull = new THREE.Mesh(target.geometry, this.outlineMat);
      hull.matrixAutoUpdate = false;
      hull.raycast = () => {}; // never intercept picking
      this.outlineMesh = hull;
      this.scene.add(hull);
    }
  }

  /** Paint unselected parts toward the background; restore on deselect.
   * The TRUE colour is stashed per material so apply() and this stay out
   * of each other's way — apply() clears the stash after it repaints. */
  private syncEmphasisColours(): void {
    const active = this.emphasis && this.meshes.get(this.emphasis) ? this.emphasis : null;
    const bg = new THREE.Color();
    this.renderer.getClearColor(bg);
    for (const [id, material] of this.materials) {
      const store = material.userData as { trueColour?: THREE.Color };
      if (active && id !== active) {
        store.trueColour ??= material.color.clone();
        material.color.copy(store.trueColour).lerp(bg, 0.82);
      } else if (store.trueColour) {
        material.color.copy(store.trueColour);
        delete store.trueColour;
      }
    }
  }

  /** The rim follows its part live — gizmo drags, layout moves, geometry
   * swaps (engraving) — by copying the mesh's world matrix every frame. */
  private trackEmphasisOutline(): void {
    const hull = this.outlineMesh;
    const mesh = this.emphasis ? this.meshes.get(this.emphasis) : undefined;
    if (!hull || !mesh) return;
    if (hull.geometry !== mesh.geometry) hull.geometry = mesh.geometry;
    hull.visible = mesh.visible;
    hull.matrix.copy(mesh.matrixWorld).multiply(_outlineScale);
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
