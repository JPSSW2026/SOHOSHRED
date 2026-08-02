/** PLACEHOLDER — replaced by the props/set-dressing workstream. */
import * as THREE from 'three';

export class Props {
  constructor(ctx) {
    this.ctx = ctx;
    this.object3D = new THREE.Object3D();
  }
  async build() { this.ctx.scene.add(this.object3D); }
  update() {}
  getColliders() { return []; }
}
