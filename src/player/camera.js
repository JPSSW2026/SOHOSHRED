/**
 * Chase camera.
 *
 * A riding camera has one job that is harder than it looks: stay behind the
 * rider without ever telling the player what it is doing. Every rule here
 * exists because its absence is visible.
 *
 *   · It follows the *velocity*, not the heading. A board points across its
 *     own arc mid-carve, and a camera locked to the nose swings through 60°
 *     twice a turn and makes people ill.
 *   · The follow is a critically-damped spring, integrated properly, not an
 *     exponential lerp per axis. Lerping each axis independently makes the
 *     camera cut corners on a diagonal and slide sideways out of a turn.
 *   · It never enters the hill. A convex rollover between camera and rider
 *     will swallow the camera on any real terrain, so the rig sweeps the line
 *     back to the rider and pulls in to the first clear station.
 *   · FOV widens with speed, but on a slow lag, so acceleration reads as a
 *     stretch rather than as a zoom.
 *   · Shake is band-limited noise scaled by speed and by the surface, and it
 *     is driven by simulation time through a seeded Simplex field — never by
 *     Math.random, because the screenshot harness has to reproduce a frame
 *     exactly.
 *
 * Modes: 'chase' (default gameplay), 'cinematic' (wider, slower, leads the
 * rider), 'orbit' (slow circle, for menus and photo mode), 'firstPerson', and
 * 'free' — the harness's opt-out, where this class does nothing at all and
 * something else owns the camera.
 */

import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { Simplex, seedFromString, clamp, clamp01, smoothstep, damp } from '../core/rng.js';

/** Clearance the camera keeps above any surface, metres. */
const GROUND_CLEARANCE = 0.85;
/** How many samples the occlusion sweep takes between rider and camera. */
const SWEEP_STEPS = 10;

export class ChaseCamera {
  constructor(ctx) {
    this.ctx = ctx;
    this.mode = 'chase';

    this._noise = new Simplex(seedFromString(CONFIG.seed + ':camera'));
    this._time = 0;

    // Spring state. Position is integrated; the target is recomputed each
    // frame and the spring chases it.
    this._pos = new THREE.Vector3();
    this._vel = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._lookSmooth = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._primed = false;

    this._fov = CONFIG.camera.fov;
    this._roll = 0;
    this._shake = new THREE.Vector3();

    // Scratch.
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._flat = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    // Re-prime on the way back into an automatic mode so the camera does not
    // spring across the basin from wherever a manual preset left it.
    if (mode !== 'free') this._primed = false;
  }

  /** Deterministic pose for the capture harness. */
  frame(preset) {
    if (!preset) return;
    const cam = this.ctx.camera;
    if (preset.position) cam.position.copy(preset.position);
    if (preset.lookAt) cam.lookAt(preset.lookAt);
    if (preset.fov) { cam.fov = preset.fov; cam.updateProjectionMatrix(); }
    this._pos.copy(cam.position);
    this._vel.set(0, 0, 0);
    this._primed = true;
  }

  /** Jump straight to the ideal station — used after a reset or a mode change. */
  snapToTarget() {
    const s = this.ctx.physics?.state;
    if (!s) return;
    this._computeDesired(s, 1 / 60);
    this._pos.copy(this._desired);
    this._vel.set(0, 0, 0);
    this._lookSmooth.copy(this._look);
    this._primed = true;
    const cam = this.ctx.camera;
    cam.position.copy(this._pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(this._lookSmooth);
  }

  update(dt, ctx) {
    if (this.mode === 'free') return;
    const s = ctx.physics?.state;
    if (!s) return;
    this._time += dt;

    if (this.mode === 'orbit') { this._orbit(dt, s); return; }
    if (this.mode === 'firstPerson') { this._firstPerson(dt, s); return; }

    this._computeDesired(s, dt);
    if (!this._primed) {
      this._pos.copy(this._desired);
      this._lookSmooth.copy(this._look);
      this._primed = true;
    }

    // ---- Critically-damped spring -----------------------------------
    // x'' = -2ζω x' - ω²(x - target), integrated semi-implicitly. ζ = 1 so
    // the camera arrives without overshoot; overshoot on a chase camera reads
    // as the world wobbling, not as the camera being lively.
    const omega = CONFIG.camera.stiffness * (this.mode === 'cinematic' ? 0.55 : 1.0);
    const zeta = CONFIG.camera.damping;
    this._v.subVectors(this._pos, this._desired);
    this._vel.addScaledVector(this._v, -omega * omega * dt);
    this._vel.addScaledVector(this._vel, -2 * zeta * omega * dt);
    this._pos.addScaledVector(this._vel, dt);

    // ---- Keep it out of the hill ------------------------------------
    this._avoidTerrain(s);

    // ---- Look target -------------------------------------------------
    // Lead the rider: look where they are going, further ahead the faster
    // they go. The look point is smoothed harder than the position, because
    // rotational judder is far more visible than positional judder.
    this._lookSmooth.lerp(this._look, clamp01(dt * (this.mode === 'cinematic' ? 3.2 : 7.0)));

    // ---- Shake --------------------------------------------------------
    this._computeShake(dt, s);

    // ---- Commit ------------------------------------------------------
    const cam = ctx.camera;
    cam.position.copy(this._pos).add(this._shake);

    // Roll into the carve. A few degrees only — enough to feel the turn, far
    // short of the horizon actually tilting, which looks like a bug.
    const rollTarget = clamp(-(s.edgeAngle || 0) * 0.09 * smoothstep(4, 20, s.speed), -0.11, 0.11);
    this._roll = damp(this._roll, rollTarget, 4.5, dt);
    cam.up.set(Math.sin(this._roll), Math.cos(this._roll), 0)
      .applyAxisAngle(this._up, s.heading);
    cam.lookAt(this._lookSmooth);

    // ---- FOV ----------------------------------------------------------
    const C = CONFIG.camera;
    const base = this.mode === 'cinematic' ? C.fov - 12 : C.fov;
    const target = Math.min(base + s.speed * C.fovSpeedGain, C.fovMax);
    // Asymmetric: widen quickly under acceleration, recover slowly. Speed
    // should feel earned on the way in and linger on the way out.
    const rate = target > this._fov ? 2.6 : 1.1;
    this._fov = damp(this._fov, target, rate, dt);
    if (Math.abs(cam.fov - this._fov) > 0.01) {
      cam.fov = this._fov;
      cam.updateProjectionMatrix();
    }
  }

  /* ------------------------------------------------------------------ *
   * Station
   * ------------------------------------------------------------------ */
  _computeDesired(s, dt) {
    const C = CONFIG.camera;
    const terrain = this.ctx.terrain;

    // Follow direction: velocity when moving, heading when nearly stopped.
    // Blending between them rather than switching avoids a snap as the rider
    // comes to rest.
    this._flat.set(s.velocity.x, 0, s.velocity.z);
    const planarSpeed = this._flat.length();
    this._dir.set(Math.sin(s.heading), 0, Math.cos(s.heading));
    if (planarSpeed > 0.6) {
      this._flat.multiplyScalar(1 / planarSpeed);
      this._dir.lerp(this._flat, clamp01(smoothstep(0.6, 5.0, planarSpeed) * 0.85)).normalize();
    }

    // Distance and height grow with speed and with air time — pulling back in
    // the air is what makes a jump read as big.
    const speedT = smoothstep(0, 26, s.speed);
    const airT = clamp01((s.airHeight || 0) / 6);
    const wide = this.mode === 'cinematic' ? 1.45 : 1.0;
    const dist = C.followDistance * wide * (1 + speedT * 0.42 + airT * 0.55);
    const height = C.followHeight * (1 + speedT * 0.18 + airT * 0.75);

    this._desired.copy(s.position)
      .addScaledVector(this._dir, -dist)
      .addScaledVector(this._up, height);

    // On a steep pitch the camera has to sit further *down* the hill or it
    // ends up staring at the back of the rider's helmet with no run in frame.
    if (s.normal) {
      const pitchLean = clamp01(s.slope / 0.9);
      this._desired.addScaledVector(this._up, -pitchLean * dist * 0.22);
    }

    // Look point: ahead of the rider along the direction of travel, lifted to
    // chest height, dropping as they get airborne so the landing stays framed.
    const lead = 5.0 + speedT * 7.0;
    this._look.copy(s.position)
      .addScaledVector(this._dir, lead)
      .addScaledVector(this._up, 1.15 - airT * 0.5);

    // In the air, aim at where they will actually come down.
    if (!s.grounded && terrain && s.velocity.y < 0) {
      const g = CONFIG.physics.gravity;
      // Time to fall back to the height they left at — good enough to frame.
      const tFall = clamp((-s.velocity.y + Math.sqrt(Math.max(s.velocity.y * s.velocity.y + 2 * g * (s.airHeight || 0), 0))) / g, 0, 2.2);
      this._v2.copy(s.position).addScaledVector(s.velocity, tFall);
      this._v2.y = terrain.getHeight(this._v2.x, this._v2.z) + 1.0;
      this._look.lerp(this._v2, clamp01(airT * 0.7));
    }
  }

  /* ------------------------------------------------------------------ *
   * Terrain avoidance
   * ------------------------------------------------------------------ */
  _avoidTerrain(s) {
    const terrain = this.ctx.terrain;
    if (!terrain) return;

    // 1. Never below the surface under the camera itself.
    const ground = terrain.getHeight(this._pos.x, this._pos.z);
    if (this._pos.y < ground + GROUND_CLEARANCE) {
      this._pos.y = ground + GROUND_CLEARANCE;
      if (this._vel.y < 0) this._vel.y = 0;
    }

    // 2. Nothing between the camera and the rider. March the line back from
    //    the rider and stop at the first sample the hill intrudes on — a
    //    convex rollover on a real slope will otherwise eat the camera whole.
    this._v.subVectors(this._pos, s.position);
    const len = this._v.length();
    if (len < 0.5) return;
    this._v.multiplyScalar(1 / len);

    let clear = len;
    for (let i = 1; i <= SWEEP_STEPS; i++) {
      const d = (i / SWEEP_STEPS) * len;
      this._v2.copy(s.position).addScaledVector(this._v, d);
      const h = terrain.getHeight(this._v2.x, this._v2.z) + GROUND_CLEARANCE * 0.75;
      if (this._v2.y < h) { clear = (i - 1) / SWEEP_STEPS * len; break; }
    }
    if (clear < len - 0.01) {
      // Pull in, but keep a minimum so the camera never ends up inside the
      // rider's own head. The floor is generous: at 1.9 m the rider filled a
      // third of the frame every time a convex roll nudged the sweep, which
      // read as the camera panicking. Better to let the hill clip the bottom
      // of frame for a beat than to ride the rider's shoulder.
      const d = Math.max(clear, 4.2);
      this._pos.copy(s.position).addScaledVector(this._v, d);
      const g2 = terrain.getHeight(this._pos.x, this._pos.z);
      if (this._pos.y < g2 + GROUND_CLEARANCE) this._pos.y = g2 + GROUND_CLEARANCE;
      this._vel.multiplyScalar(0.4);
    }
  }

  /* ------------------------------------------------------------------ *
   * Shake
   * ------------------------------------------------------------------ */
  _computeShake(dt, s) {
    const C = CONFIG.camera;
    // Rough surfaces and high speed shake; smooth groomers and low speed do
    // not. Landing impact spikes it. All of it from a seeded noise field
    // sampled by simulation time, so a replayed frame shakes identically.
    const rough = s.surface === 'sastrugi' || s.surface === 'crust' ? 1.0
      : s.surface === 'scree' || s.surface === 'rock' ? 1.35
        : s.surface === 'powder' ? 0.25 : 0.6;
    const speedT = smoothstep(6, 30, s.speed);
    const impact = clamp01((s.landingImpact || 0) / 10);
    const amp = C.shakeAtSpeed * (speedT * rough + impact * 2.4) * (s.grounded ? 1 : 0.25);

    if (amp < 1e-4) { this._shake.multiplyScalar(0.8); return; }
    const t = this._time * 9.0;
    this._shake.set(
      this._noise.noise2D(t, 11.3) * amp * 0.09,
      this._noise.noise2D(t, 47.9) * amp * 0.11,
      this._noise.noise2D(t, 83.1) * amp * 0.07,
    );
  }

  /* ------------------------------------------------------------------ *
   * Alternate modes
   * ------------------------------------------------------------------ */
  _orbit(dt, s) {
    const cam = this.ctx.camera;
    const r = 11.0;
    const a = this._time * 0.16;
    this._pos.set(
      s.position.x + Math.sin(a) * r,
      s.position.y + 4.2,
      s.position.z + Math.cos(a) * r,
    );
    const terrain = this.ctx.terrain;
    if (terrain) {
      const g = terrain.getHeight(this._pos.x, this._pos.z);
      if (this._pos.y < g + 1.6) this._pos.y = g + 1.6;
    }
    cam.position.copy(this._pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(s.position.x, s.position.y + 1.0, s.position.z);
    if (cam.fov !== CONFIG.camera.fov - 14) {
      cam.fov = CONFIG.camera.fov - 14;
      cam.updateProjectionMatrix();
    }
  }

  _firstPerson(dt, s) {
    const cam = this.ctx.camera;
    const rider = this.ctx.rider;
    const head = rider?.getBoneWorldPosition?.('head', this._v);
    this._pos.copy(head || this._v.copy(s.position).add(this._up.clone().multiplyScalar(1.55)));
    this._pos.y += 0.12;
    this._computeShake(dt, s);
    cam.position.copy(this._pos).add(this._shake);
    this._dir.set(Math.sin(s.heading), 0, Math.cos(s.heading));
    this._look.copy(this._pos).addScaledVector(this._dir, 12).addScaledVector(this._up, -1.5);
    this._lookSmooth.lerp(this._look, clamp01(dt * 9));
    cam.up.set(0, 1, 0);
    cam.lookAt(this._lookSmooth);
    const target = Math.min(CONFIG.camera.fov + 6 + s.speed * CONFIG.camera.fovSpeedGain, CONFIG.camera.fovMax);
    this._fov = damp(this._fov, target, 2.2, dt);
    cam.fov = this._fov;
    cam.updateProjectionMatrix();
  }
}
