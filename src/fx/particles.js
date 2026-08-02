/** PLACEHOLDER — replaced by the particle-FX workstream. */
import * as THREE from 'three';

export class ParticleFX {
  constructor(ctx) {
    this.ctx = ctx;
    this.object3D = new THREE.Object3D();
  }
  build() { this.ctx.scene.add(this.object3D); }
  update() {}
  emitSpray() {}
  emitImpact() {}
}
