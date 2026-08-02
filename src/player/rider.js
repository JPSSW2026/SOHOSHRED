/** PLACEHOLDER — replaced by the character workstream. */
import * as THREE from 'three';

export class Rider {
  constructor(ctx) {
    this.ctx = ctx;
    this.object3D = new THREE.Object3D();
  }

  async build() {
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.28, 0.9, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0x24303f, roughness: 0.7 }),
    );
    body.position.y = 0.95;
    body.castShadow = true;
    this.object3D.add(body);

    const board = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.02, 1.55),
      new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.35, metalness: 0.1 }),
    );
    board.position.y = 0.05;
    board.castShadow = true;
    this.boardObject = board;
    this.object3D.add(board);

    this.ctx.scene.add(this.object3D);
  }

  update(dt, ctx) {
    const s = ctx.physics?.state;
    if (!s) return;
    this.object3D.position.copy(s.position);
    this.object3D.rotation.set(0, s.heading, s.roll);
  }

  getBoneWorldPosition(name, out = new THREE.Vector3()) {
    return out.copy(this.object3D.position);
  }
}
