/** PLACEHOLDER — replaced by the sky/atmosphere workstream. */
import * as THREE from 'three';
import { CONFIG } from '../core/config.js';

export class Sky {
  constructor(ctx) {
    this.ctx = ctx;
    this.object3D = new THREE.Object3D();
    this.sunDirection = new THREE.Vector3(0.35, 0.42, -0.84).normalize();
    this.sunColor = new THREE.Color(1.0, 0.95, 0.86);
    this.ambientColor = new THREE.Color(0.42, 0.52, 0.72);
    this.environmentTexture = null;
  }

  build() {
    const ctx = this.ctx;
    ctx.scene.background = new THREE.Color(0.36, 0.55, 0.82);
    ctx.scene.fog = new THREE.FogExp2(new THREE.Color(0.62, 0.72, 0.86), 0.00035);

    this.hemi = new THREE.HemisphereLight(0x9dbdf0, 0xdfe8f5, 1.1);
    this.object3D.add(this.hemi);

    this.sun = new THREE.DirectionalLight(this.sunColor, 3.0);
    this.sun.position.copy(this.sunDirection).multiplyScalar(600);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const c = this.sun.shadow.camera;
    c.left = -160; c.right = 160; c.top = 160; c.bottom = -160; c.near = 1; c.far = 1400;
    this.object3D.add(this.sun);
    this.object3D.add(this.sun.target);

    ctx.scene.add(this.object3D);
  }

  update(dt, ctx) {
    if (this.sun) {
      const p = ctx.camera.position;
      this.sun.position.copy(this.sunDirection).multiplyScalar(400).add(p);
      this.sun.target.position.copy(p);
      this.sun.target.updateMatrixWorld();
    }
  }
}
