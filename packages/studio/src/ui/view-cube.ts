// The view cube: a small always-upright navigation cube that mirrors the
// main camera's orientation. Named faces and the eight corners are quick
// views — click one and the main camera swings there, keeping its distance.
//
// Rendered in its own tiny canvas with an orthographic camera; a second
// renderer this size costs nothing and keeps the overlay out of the product
// scene entirely.

import * as THREE from 'three';
import type { Viewer } from '../../../embed/src/runtime/viewer.ts';

export interface CubeTarget {
  name: string;
  dir: [number, number, number];
}

export const FACES: CubeTarget[] = [
  { name: 'Front', dir: [0, 0, 1] },
  { name: 'Back', dir: [0, 0, -1] },
  { name: 'Left', dir: [-1, 0, 0] },
  { name: 'Right', dir: [1, 0, 0] },
  { name: 'Top', dir: [0, 1, 0] },
  { name: 'Bottom', dir: [0, -1, 0] },
];

/** The eight corner directions, unit length — the unnamed quick views. */
export const CORNERS: CubeTarget[] = (() => {
  const out: CubeTarget[] = [];
  const k = 1 / Math.sqrt(3);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    out.push({ name: `corner${sx > 0 ? '+' : '-'}x${sy > 0 ? '+' : '-'}y${sz > 0 ? '+' : '-'}z`, dir: [sx * k, sy * k, sz * k] });
  }
  return out;
})();

function faceTexture(label: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f4f2ed';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = '#d5d2cb';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, 124, 124);
  ctx.fillStyle = '#55524b';
  ctx.font = '600 26px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class ViewCube {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly cube: THREE.Mesh;
  private readonly corners: THREE.Mesh[] = [];
  private readonly viewer: Viewer;
  private rafId = 0;

  constructor(viewer: Viewer, canvas: HTMLCanvasElement) {
    this.viewer = viewer;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    this.renderer.setSize(canvas.clientWidth || 92, canvas.clientHeight || 92, false);

    this.camera = new THREE.OrthographicCamera(-1.05, 1.05, 1.05, -1.05, 0.1, 10);

    // BoxGeometry's material order is +x, −x, +y, −y, +z, −z.
    const order = ['Right', 'Left', 'Top', 'Bottom', 'Front', 'Back'];
    this.cube = new THREE.Mesh(
      new THREE.BoxGeometry(1.06, 1.06, 1.06),
      order.map((label) => new THREE.MeshBasicMaterial({ map: faceTexture(label) })),
    );
    this.scene.add(this.cube);

    for (const corner of CORNERS) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xc9c5bd }),
      );
      dot.position.set(corner.dir[0], corner.dir[1], corner.dir[2]).multiplyScalar(0.53 * Math.sqrt(3));
      dot.userData.dir = corner.dir;
      this.corners.push(dot);
      this.scene.add(dot);
    }

    canvas.addEventListener('pointerup', (e) => {
      const dir = this.pick(e);
      if (dir) this.viewer.lookFrom(dir);
    });
    canvas.addEventListener('pointermove', (e) => {
      canvas.style.cursor = this.pick(e) ? 'pointer' : 'default';
    });

    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      // Mirror the main camera: look at the cube from the same direction the
      // main camera looks at its target.
      const view = this.viewer.cameraView();
      const dir = new THREE.Vector3(
        view.position[0] - view.target[0],
        view.position[1] - view.target[1],
        view.position[2] - view.target[2],
      );
      if (!dir.lengthSq()) return;
      this.camera.position.copy(dir.normalize().multiplyScalar(3));
      this.camera.lookAt(0, 0, 0);
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  /** Screen point → quick-view direction, or null when off the cube. */
  private pick(e: PointerEvent): [number, number, number] | null {
    const canvas = this.renderer.domElement;
    const r = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    // Corners sit proud of the cube, so they win where they overlap a face.
    const corner = raycaster.intersectObjects(this.corners)[0];
    if (corner) return corner.object.userData.dir as [number, number, number];
    const hit = raycaster.intersectObject(this.cube)[0];
    if (hit?.face) {
      const n = hit.face.normal;
      return [n.x, n.y, n.z];
    }
    return null;
  }

  /** Programmatic quick view, by face name or corner name — also the test hook. */
  go(name: string): boolean {
    const target = [...FACES, ...CORNERS].find((t) => t.name === name);
    if (!target) return false;
    this.viewer.lookFrom(target.dir);
    return true;
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
