// TransformControls wrapper: attach to a part's mesh, and on drag end hand
// the resulting pose back as plain numbers. All interpretation — offsets vs
// anchors, degrees, multipliers — happens in applyGizmoPose (tested); this
// class only ferries three.js events.

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { Viewer } from '../../../embed/src/runtime/viewer.ts';
import type { GizmoPose } from '../lib/manifest-edit.ts';

export type GizmoMode = 'translate' | 'rotate' | 'scale' | 'off';

export class Gizmo {
  private readonly controls: TransformControls;
  private readonly helper: THREE.Object3D;
  private readonly viewer: Viewer;
  private mode: GizmoMode = 'off';

  constructor(viewer: Viewer, canvas: HTMLCanvasElement, onCommit: (pose: GizmoPose) => void) {
    this.viewer = viewer;
    this.controls = new TransformControls(viewer.camera, canvas);
    // Snaps keep hand-dragged values presentable: half-millimetres and 15°.
    this.controls.setTranslationSnap(0.5);
    this.controls.setRotationSnap(THREE.MathUtils.degToRad(15));
    this.helper = this.controls.getHelper();
    this.helper.visible = false;
    viewer.scene.add(this.helper);
    (window as unknown as Record<string, unknown>).__studioGizmo = this.controls; // test hook

    this.controls.addEventListener('dragging-changed', (e: { value?: unknown }) => {
      const dragging = !!e.value;
      // The gizmo and OrbitControls share the canvas; only one may own a drag.
      viewer.setOrbitEnabled(!dragging);
      const target = this.controls.object;
      if (!dragging && target) {
        onCommit({
          position: [target.position.x, target.position.y, target.position.z],
          rotationDeg: [target.rotation.x, target.rotation.y, target.rotation.z]
            .map(THREE.MathUtils.radToDeg) as [number, number, number],
          scale: [target.scale.x, target.scale.y, target.scale.z],
        });
      }
    });
  }

  setMode(mode: GizmoMode): void {
    this.mode = mode;
    if (mode === 'off') {
      this.controls.detach();
      this.helper.visible = false;
      return;
    }
    this.controls.setMode(mode);
    this.helper.visible = !!this.controls.object;
  }

  attach(partId: string | null): void {
    const mesh = partId ? this.viewer.meshOf(partId) : undefined;
    if (!mesh || this.mode === 'off') {
      this.controls.detach();
      this.helper.visible = false;
      return;
    }
    this.controls.attach(mesh);
    this.helper.visible = true;
  }

  dispose(): void {
    this.controls.detach();
    this.helper.removeFromParent();
    this.controls.dispose();
  }
}
