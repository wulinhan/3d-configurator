// Combined transform gizmo: translate arrows, rotation rings and per-axis
// scale cubes shown together, like the classic DCC gizmo. three.js only
// ships single-mode TransformControls, so three instances share the mesh,
// sized so the handles nest — arrows outermost, rings between, scale cubes
// inner. Per-axis cubes are what makes non-uniform scaling draggable; the
// centre handle scales uniformly.
//
// The instances share one canvas, so a capture-phase pointerdown arbitrates:
// whichever control is hovering a handle wins, priority scale → rotate →
// translate (the scale cubes sit on the translate shafts and would otherwise
// be unreachable). All interpretation of the resulting pose happens in
// applyGizmoPose, which is tested; this class only ferries three.js events.

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { Viewer } from '../../../embed/src/runtime/viewer.ts';
import type { GizmoPose } from '../lib/manifest-edit.ts';

export type GizmoMode = 'transform' | 'off';

export class Gizmo {
  private readonly all: TransformControls[];
  private readonly helpers: THREE.Object3D[];
  private readonly viewer: Viewer;
  private readonly canvas: HTMLCanvasElement;
  private readonly arbitrate: (e: PointerEvent) => void;
  private readonly release: () => void;
  private mode: GizmoMode = 'off';

  constructor(viewer: Viewer, canvas: HTMLCanvasElement, onCommit: (pose: GizmoPose) => void) {
    this.viewer = viewer;
    this.canvas = canvas;

    const make = (mode: 'translate' | 'rotate' | 'scale', size: number) => {
      const controls = new TransformControls(viewer.camera, canvas);
      controls.setMode(mode);
      controls.setSize(size);
      return controls;
    };
    const translate = make('translate', 1.15);
    const rotate = make('rotate', 0.9);
    const scale = make('scale', 0.62);
    translate.setTranslationSnap(0.5);
    rotate.setRotationSnap(THREE.MathUtils.degToRad(15));
    this.all = [translate, rotate, scale];

    // Drop the rotate gizmo's screen-space free-rotate handles ('E' outer
    // ring, 'XYZE' trackball). Their pick radius overlaps the translate
    // arrow tips, and the reference gizmo is three rings only — per-axis
    // rotation stays. Pickers are invisible but raycastable, so they must be
    // removed, not hidden.
    const doomed: THREE.Object3D[] = [];
    rotate.getHelper().traverse((o) => {
      if (o.name === 'E' || o.name === 'XYZE') doomed.push(o);
    });
    for (const o of doomed) o.removeFromParent();

    // Rotation visuals: axis-aligned quarter arcs joining the positive axes
    // (the classic corner gizmo), each with a grab sphere at its 45°
    // midpoint. Two fights with three.js here:
    //  - its rings are half-tori, so swap the geometry for a quarter arc;
    //  - its gizmo re-orients every ring to face the camera each frame, so
    //    the arcs are re-pinned to their world planes after each update.
    // The pickers stay full (invisible) tori, so rotation is grabbable all
    // the way round even where no arc is drawn.
    const ARC_POSES: Record<string, THREE.Quaternion> = {
      // ring about Z: arc spans +X→+Y in the XY plane (torus's home pose)
      Z: new THREE.Quaternion(),
      // ring about X: arc spans +Y→+Z in the YZ plane
      X: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
        new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0))),
      // ring about Y: arc spans +Z→+X in the XZ plane
      Y: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
        new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0))),
    };
    // Address the VISUAL group directly — visibility guards don't work here,
    // because three keeps non-current-mode groups hidden at construction and
    // the picker groups hidden always.
    const arcHandles: THREE.Mesh[] = [];
    const rotateGizmo = rotate.getHelper().children.find(
      (c) => 'picker' in c && 'gizmo' in c) as (THREE.Object3D & {
        gizmo: Record<string, THREE.Object3D>;
      }) | undefined;
    for (const node of rotateGizmo?.gizmo['rotate']?.children ?? []) {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh || !['X', 'Y', 'Z'].includes(mesh.name)) continue;
      const geometry = mesh.geometry as THREE.TorusGeometry;
      if (geometry.type !== 'TorusGeometry') continue;
      const { radius } = geometry.parameters;
      mesh.geometry = new THREE.TorusGeometry(radius, 0.014, 6, 32, Math.PI / 2);
      geometry.dispose();
      const grip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), mesh.material as THREE.Material);
      grip.position.set(radius * Math.SQRT1_2, radius * Math.SQRT1_2, 0);
      mesh.add(grip);
      arcHandles.push(mesh);
    }

    // Re-pin after three's own realignment runs each frame.
    if (rotateGizmo) {
      const original = rotateGizmo.updateMatrixWorld.bind(rotateGizmo);
      rotateGizmo.updateMatrixWorld = (force?: boolean) => {
        original(force);
        let repinned = false;
        for (const mesh of arcHandles) {
          const pose = ARC_POSES[mesh.name];
          if (pose && !mesh.quaternion.equals(pose)) {
            mesh.quaternion.copy(pose);
            repinned = true;
          }
        }
        if (repinned) THREE.Object3D.prototype.updateMatrixWorld.call(rotateGizmo, true);
      };
    }

    // The Studio speaks Z-up (X/Y flat, Z is height) while the scene is
    // three.js Y-up — so the VERTICAL handles must wear Z's blue and the
    // depth handles Y's green, or the colours argue with the panel labels.
    // Materials stash their base colour in _color and re-copy it every
    // frame, so both must change.
    const swapAxisColours = (root: THREE.Object3D) => {
      const seen = new Set<THREE.Material>();
      const mats = { Y: [] as THREE.Material[], Z: [] as THREE.Material[] };
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        const key = mesh.name as 'Y' | 'Z';
        if (!mesh.isMesh && !(o as THREE.Line).isLine) return;
        if (key !== 'Y' && key !== 'Z') return;
        const material = mesh.material as THREE.Material;
        if (material && !seen.has(material)) { seen.add(material); mats[key].push(material); }
      });
      type Tinted = THREE.Material & { color: THREE.Color; _color?: THREE.Color };
      const yColour = (mats.Y[0] as Tinted)?.color.clone();
      const zColour = (mats.Z[0] as Tinted)?.color.clone();
      if (!yColour || !zColour) return;
      for (const m of mats.Y as Tinted[]) { m.color.copy(zColour); m._color?.copy(zColour); }
      for (const m of mats.Z as Tinted[]) { m.color.copy(yColour); m._color?.copy(yColour); }
    };
    for (const c of this.all) swapAxisColours(c.getHelper());

    this.helpers = this.all.map((c) => c.getHelper());
    for (const helper of this.helpers) {
      helper.visible = false;
      viewer.scene.add(helper);
    }
    (window as unknown as Record<string, unknown>).__studioGizmo = { translate, rotate, scale }; // test hook

    const poseOf = (target: THREE.Object3D): GizmoPose => ({
      position: [target.position.x, target.position.y, target.position.z],
      rotationDeg: [target.rotation.x, target.rotation.y, target.rotation.z]
        .map(THREE.MathUtils.radToDeg) as [number, number, number],
      scale: [target.scale.x, target.scale.y, target.scale.z],
    });

    let lastLive = 0;
    for (const controls of this.all) {
      controls.addEventListener('dragging-changed', (e: { value?: unknown }) => {
        const dragging = !!e.value;
        viewer.setOrbitEnabled(!dragging);
        const target = controls.object;
        if (!dragging && target) onCommit(poseOf(target));
      });
      // Throttled commits DURING the drag keep the panel's mm and degrees
      // live under the merchant's hand, not just on release.
      controls.addEventListener('objectChange', () => {
        const target = controls.object;
        if (!target || !(controls as unknown as { dragging: boolean }).dragging) return;
        const now = performance.now();
        if (now - lastLive < 120) return;
        lastLive = now;
        onCommit(poseOf(target));
      });
    }

    // Arbitration. Each control tracks the handle under the pointer in its
    // `axis` field; on pointerdown exactly one hovering control keeps its
    // pointer events, capture-phase so it runs before the controls' own
    // listeners. Everything re-enables on release. Scale first (its cubes
    // sit on the translate shafts), then translate (arrow tips graze ring
    // pick zones at some view angles), rings last.
    const priority = [scale, translate, rotate];
    this.arbitrate = () => {
      if (this.mode === 'off') return;
      const winner = priority.find((c) => (c as unknown as { axis: string | null }).axis);
      if (!winner) return;
      for (const c of this.all) c.enabled = c === winner;
    };
    this.release = () => {
      if (this.all.some((c) => (c as unknown as { dragging: boolean }).dragging)) return;
      for (const c of this.all) c.enabled = true;
    };
    canvas.addEventListener('pointerdown', this.arbitrate, true);
    canvas.addEventListener('pointerup', this.release);
  }

  /** True while any layer owns a pointer drag. */
  get dragging(): boolean {
    return this.all.some((c) => (c as unknown as { dragging: boolean }).dragging);
  }

  /** True while the pointer rests on any handle — clicks there are the gizmo's. */
  get hovering(): boolean {
    return this.mode !== 'off' && this.all.some((c) => (c as unknown as { axis: string | null }).axis);
  }

  setMode(mode: GizmoMode): void {
    this.mode = mode;
    if (mode === 'off') {
      for (const c of this.all) c.detach();
      for (const h of this.helpers) h.visible = false;
    }
  }

  attach(partId: string | null): void {
    const mesh = partId ? this.viewer.meshOf(partId) : undefined;
    if (!mesh || this.mode === 'off') {
      for (const c of this.all) c.detach();
      for (const h of this.helpers) h.visible = false;
      return;
    }
    for (const c of this.all) c.attach(mesh);
    for (const h of this.helpers) h.visible = true;
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.arbitrate, true);
    this.canvas.removeEventListener('pointerup', this.release);
    for (const c of this.all) { c.detach(); c.dispose(); }
    for (const h of this.helpers) h.removeFromParent();
  }
}
