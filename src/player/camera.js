/** PLACEHOLDER — replaced by the camera workstream. */
import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { damp } from '../core/rng.js';

export class ChaseCamera {
  constructor(ctx) {
    this.ctx = ctx;
    this.mode = 'chase';
    this._desired = new THREE.Vector3();
    this._look = new THREE.Vector3();
  }

  setMode(m) { this.mode = m; }
  frame() {}

  snapToTarget() {
    const s = this.ctx.physics?.state;
    if (!s) return;
    this._computeDesired(s);
    this.ctx.camera.position.copy(this._desired);
    this.ctx.camera.lookAt(this._look);
  }

  _computeDesired(s) {
    const c = CONFIG.camera;
    const fwd = new THREE.Vector3(Math.sin(s.heading), 0, Math.cos(s.heading));
    this._desired.copy(s.position)
      .addScaledVector(fwd, -c.followDistance)
      .add(new THREE.Vector3(0, c.followHeight, 0));
    const ground = this.ctx.terrain?.getHeight(this._desired.x, this._desired.z) ?? 0;
    if (this._desired.y < ground + 1.2) this._desired.y = ground + 1.2;
    this._look.copy(s.position).addScaledVector(fwd, 6).add(new THREE.Vector3(0, 1.1, 0));
  }

  update(dt, ctx) {
    const s = ctx.physics?.state;
    if (!s || this.mode === 'free') return;
    this._computeDesired(s);
    const cam = ctx.camera;
    const l = CONFIG.camera.stiffness;
    cam.position.x = damp(cam.position.x, this._desired.x, l, dt);
    cam.position.y = damp(cam.position.y, this._desired.y, l, dt);
    cam.position.z = damp(cam.position.z, this._desired.z, l, dt);
    cam.lookAt(this._look);
    const targetFov = CONFIG.camera.fov + s.speed * CONFIG.camera.fovSpeedGain;
    cam.fov = damp(cam.fov, Math.min(targetFov, CONFIG.camera.fovMax), 3, dt);
    cam.updateProjectionMatrix();
  }
}
