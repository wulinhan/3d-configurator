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

    // three draws the rings as half-tori facing the camera, which reads as
    // "decoration" rather than "handle". Swap the visuals for complete rings
    // (the invisible pickers were full tori all along) and put a grab sphere
    // at 45° on each — the affordance that says "drag me". The sphere shares
    // the ring's material, so hover-highlighting covers both.
    rotate.getHelper().traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !['X', 'Y', 'Z'].includes(mesh.name)) return;
      const geometry = mesh.geometry as THREE.TorusGeometry;
      if (geometry.type !== 'TorusGeometry') return;
      const { radius, arc } = geometry.parameters;
      const material = mesh.material as THREE.Material & { visible: boolean };
      if (material.visible === false) return; // picker — already a full ring
      if (arc < Math.PI * 1.9) {
        mesh.geometry = new THREE.TorusGeometry(radius, 0.012, 6, 96);
        geometry.dispose();
      }
      const grip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), material);
      grip.position.set(radius * Math.SQRT1_2, radius * Math.SQRT1_2, 0);
      mesh.add(grip);
    });

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
