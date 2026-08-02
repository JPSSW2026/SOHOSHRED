/** PLACEHOLDER — replaced by the physics workstream. */
import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { clamp, damp } from '../core/rng.js';

export class BoardPhysics {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      heading: Math.PI,
      pitch: 0, roll: 0, edgeAngle: 0,
      grounded: true, airTime: 0,
      speed: 0, gForce: 1,
      surface: 'powder', sinkDepth: 0,
      carving: false, sliding: false, crashed: false,
    };
    this._n = new THREE.Vector3();
  }

  reset(position, heading) {
    this.state.position.copy(position);
    this.state.velocity.set(0, 0, 0);
    this.state.heading = heading ?? Math.PI;
    this.state.crashed = false;
  }

  fixedUpdate(h, ctx) {
    const s = this.state;
    const input = ctx.input?.state || { steer: 0, crouch: 0 };
    const terrain = ctx.terrain;
    if (!terrain) return;

    s.heading += input.steer * 1.6 * h;

    const fwd = new THREE.Vector3(Math.sin(s.heading), 0, Math.cos(s.heading));
    const n = terrain.getNormal(s.position.x, s.position.z, this._n);
    // Project gravity onto the slope.
    const g = CONFIG.physics.gravity;
    const along = fwd.dot(new THREE.Vector3(-n.x, 0, -n.z)) * g * (1 - n.y);
    const accel = along * 6.0 - CONFIG.physics.baseFriction * g;

    s.speed = clamp(s.speed + accel * h, 0, CONFIG.physics.maxSpeed);
    s.velocity.copy(fwd).multiplyScalar(s.speed);
    s.position.addScaledVector(s.velocity, h);

    const ground = terrain.getHeight(s.position.x, s.position.z);
    s.position.y = damp(s.position.y, ground, 22, h);
    s.grounded = true;
    s.edgeAngle = input.steer * 0.6;
    s.roll = damp(s.roll, -input.steer * 0.5, 8, h);
    s.carving = Math.abs(input.steer) > 0.25 && s.speed > 4;
  }
}
