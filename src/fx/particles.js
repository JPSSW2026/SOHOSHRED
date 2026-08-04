/**
 * Particle FX.
 *
 * Two GPU-resident point systems, both drawn in one call each:
 *
 *   · DYNAMIC — everything the rider causes. Edge spray, the powder plume off
 *     a buried nose, impact bursts on landing, and the fine contrail that
 *     hangs off the tail at speed. Emitted from a CPU ring buffer, simulated
 *     on the GPU from launch parameters so the CPU only writes a particle
 *     once, at birth.
 *   · AMBIENT — falling snow and wind-blown surface drift, recycled inside a
 *     box that follows the camera so the field is always populated and never
 *     costs more than its fixed budget.
 *
 * The lighting is the part that matters. Suspended snow crystals are not
 * white blobs: they are strongly *forward*-scattering, so a plume between the
 * camera and a low sun lights up several times brighter than the same plume
 * with the sun behind the camera. That single term is the difference between
 * spray that looks like smoke and spray that looks like snow, and it is why
 * the reference frames have that luminous halo around a rider throwing a
 * turn into the light. It costs one dot product.
 *
 * Everything is seeded — no Math.random — so a replayed frame produces an
 * identical spray.
 */

import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { makeRng, seedFromString, clamp, clamp01, lerp, smoothstep } from '../core/rng.js';

const MAX_DYNAMIC = 4200;
const MAX_AMBIENT = 1800;
/** Half-extent of the box ambient snow is recycled within, metres. */
const AMBIENT_BOX = 34;

/* ------------------------------------------------------------------ *
 * Shaders
 * ------------------------------------------------------------------ */

/**
 * Both systems share this. Each point carries its launch state and the shader
 * integrates the trajectory from `age`, so a particle costs one buffer write
 * at birth and nothing thereafter.
 */
const VERT = /* glsl */`
  uniform float uTime;
  uniform float uPixelScale;
  uniform vec3  uGravity;
  uniform vec3  uWind;

  attribute vec3  aVelocity;
  attribute vec4  aParams;   // x: birth, y: life, z: size, w: drag
  attribute vec4  aStyle;    // x: kind, y: seed, z: brightness, w: spin

  varying float vAlpha;
  varying float vFade;
  varying vec2  vSeed;
  varying float vKind;
  varying float vBright;
  varying vec3  vWorld;
  varying vec2  vStretchDir;   // screen-space motion direction
  varying float vStretch;      // major/minor axis ratio, 1 = round

  void main() {
    float age = uTime - aParams.x;
    float life = max(aParams.y, 0.0001);
    float t = age / life;

    if (age < 0.0 || t > 1.0) {
      // Dead: collapse to a degenerate point behind the camera rather than
      // branching in the fragment shader.
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vAlpha = 0.0;
      return;
    }

    // Ballistic with linear drag, integrated analytically:
    //   v(t) = v0·e^(-kt) + v_term(1 - e^(-kt))
    // so a crystal sheds its launch speed fast and then simply falls with the
    // wind, which is exactly how spray behaves.
    float k = max(aParams.w, 0.001);
    float e = exp(-k * age);
    vec3 vTerm = uGravity / k + uWind;
    vec3 pos = position
             + (aVelocity - vTerm) * (1.0 - e) / k
             + vTerm * age;

    vWorld = pos;
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);

    // Size: crystals disperse as the cloud expands, so points grow with age.
    float grow = 1.0 + t * 2.2;
    float size = aParams.z * grow;

    // Alpha: quick fade in so nothing pops, long fade out. Squared so the
    // tail of the cloud thins rather than vanishing as a hard edge.
    float fadeIn  = smoothstep(0.0, 0.06, t);
    float fadeOut = 1.0 - smoothstep(0.35, 1.0, t);
    vAlpha = fadeIn * fadeOut * fadeOut;

    // Near-camera fade: a particle a few centimetres from the lens is a
    // full-screen white blob otherwise, and it happens constantly on a
    // close chase camera.
    float dist = -mv.z;
    vFade = smoothstep(0.25, 1.4, dist);

    vSeed = vec2(aStyle.y, aStyle.y * 1.7 + t * aStyle.w);
    vKind = aStyle.x;
    vBright = aStyle.z;

    gl_Position = projectionMatrix * mv;

    // Motion stretch (round 6, all critics: "no motion stretch" is the
    // default-particle tell). The instantaneous velocity from the same
    // analytic integral, projected to screen space; the point square is
    // enlarged along it and the fragment draws an ellipse inside. Fast
    // fresh spray becomes streaks; old drifting crystals relax to round.
    vec3 vel = aVelocity * e + vTerm * (1.0 - e);
    vec4 mv2 = modelViewMatrix * vec4(pos + vel * 0.04, 1.0);
    vec2 sd = (mv2.xy / max(-mv2.z, 0.05)) - (mv.xy / max(dist, 0.05));
    float sl = length(sd);
    vStretch = 1.0 + clamp(sl * 55.0, 0.0, 2.6) * (1.0 - t * 0.7);
    // Ambient snowfall (kind 3) must NOT stretch: a flake drifting on the
    // wind is a dot to the eye, and stretching the whole falling field
    // reads as rain across the frame (demo v8 regression). Stretch belongs
    // to thrown spray only.
    vStretch = mix(vStretch, 1.0, step(2.5, aStyle.x));
    vStretchDir = sl > 1e-6 ? sd / sl : vec2(1.0, 0.0);

    gl_PointSize = max(size * uPixelScale / max(dist, 0.05), 1.0) * vStretch;
  }
`;

const FRAG = /* glsl */`
  precision highp float;

  uniform vec3  uSunDir;      // toward the sun
  uniform vec3  uSunColor;
  uniform vec3  uSkyColor;
  uniform vec3  uCameraPos;

  varying float vAlpha;
  varying float vFade;
  varying vec2  vSeed;
  varying float vKind;
  varying float vBright;
  varying vec3  vWorld;
  varying vec2  vStretchDir;
  varying float vStretch;

  // Cheap hash for per-particle crystal variation.
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    // Ellipse inside the stretch-enlarged square: full length along the
    // motion axis, original width across it.
    float um = dot(uv, vStretchDir);
    float vm = dot(uv, vec2(-vStretchDir.y, vStretchDir.x)) * vStretch;
    float r2 = um * um + vm * vm;
    if (r2 > 1.0) discard;

    // Soft particle profile. Not a hard disc and not a Gaussian: snow spray
    // has a dense core and a diffuse skirt.
    float core = 1.0 - r2;
    float shape = core * core * (0.55 + 0.45 * core);

    // Break up the disc so a cloud reads as many crystals rather than as a
    // field of identical dots.
    float grain = 0.82 + 0.18 * hash(vSeed + floor(uv * 3.0));
    shape *= grain;

    // ---- Forward scattering ------------------------------------------
    // Ice crystals scatter overwhelmingly forward. Looking toward the sun
    // through a plume, the plume glows; with the sun behind, it is merely
    // lit. Henyey-Greenstein with g ≈ 0.6, cheaply.
    vec3 viewDir = normalize(vWorld - uCameraPos);
    float cosT = dot(viewDir, uSunDir);
    float g = 0.6;
    float denom = 1.0 + g * g - 2.0 * g * cosT;
    float phase = (1.0 - g * g) / (4.0 * 3.14159 * pow(max(denom, 0.0001), 1.5));

    // Direct sun through the crystal, plus ambient sky fill. The sky term is
    // what keeps spray from going black on the shadowed side of a turn.
    vec3 lit = uSunColor * (0.55 + phase * 5.5) + uSkyColor * 0.85;
    lit *= vBright;

    // Airborne snow is not pure white — it is sky-tinted where the sun does
    // not reach it, which is the same physics that makes snow shadows blue.
    float sunAmount = clamp(0.35 + phase * 2.4, 0.0, 1.0);
    vec3 col = mix(uSkyColor * 1.15, lit, sunAmount);

    float a = vAlpha * vFade * shape;
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }
`;

/* ------------------------------------------------------------------ *
 * A pooled point system
 * ------------------------------------------------------------------ */
class PointPool {
  constructor(max, material) {
    this.max = max;
    this.cursor = 0;

    const geo = new THREE.BufferGeometry();
    this.position = new Float32Array(max * 3);
    this.velocity = new Float32Array(max * 3);
    this.params = new Float32Array(max * 4);
    this.style = new Float32Array(max * 4);

    // Everything starts dead: birth time far in the past, zero life.
    for (let i = 0; i < max; i++) this.params[i * 4 + 1] = 0;

    this.aPos = new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.BufferAttribute(this.velocity, 3).setUsage(THREE.DynamicDrawUsage);
    this.aPar = new THREE.BufferAttribute(this.params, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSty = new THREE.BufferAttribute(this.style, 4).setUsage(THREE.DynamicDrawUsage);

    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aVelocity', this.aVel);
    geo.setAttribute('aParams', this.aPar);
    geo.setAttribute('aStyle', this.aSty);
    // The bounding sphere would have to be recomputed every frame to be
    // correct, and a wrong one culls the whole system. Frustum culling off.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.geometry = geo;
    this.points = new THREE.Points(geo, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 12;

    this._dirtyLo = max;
    this._dirtyHi = 0;
  }

  /** Write one particle into the ring. */
  spawn(px, py, pz, vx, vy, vz, birth, life, size, drag, kind, seed, bright, spin) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.max;

    const i3 = i * 3, i4 = i * 4;
    this.position[i3] = px; this.position[i3 + 1] = py; this.position[i3 + 2] = pz;
    this.velocity[i3] = vx; this.velocity[i3 + 1] = vy; this.velocity[i3 + 2] = vz;
    this.params[i4] = birth; this.params[i4 + 1] = life;
    this.params[i4 + 2] = size; this.params[i4 + 3] = drag;
    this.style[i4] = kind; this.style[i4 + 1] = seed;
    this.style[i4 + 2] = bright; this.style[i4 + 3] = spin;

    if (i < this._dirtyLo) this._dirtyLo = i;
    if (i > this._dirtyHi) this._dirtyHi = i;
  }

  /**
   * Upload only the slice that changed. A full 2 600-point re-upload every
   * frame is pure waste when a hard carve births maybe forty.
   */
  flush() {
    if (this._dirtyLo > this._dirtyHi) return;
    const lo = this._dirtyLo, count = this._dirtyHi - lo + 1;
    for (const [attr, itemSize] of [[this.aPos, 3], [this.aVel, 3], [this.aPar, 4], [this.aSty, 4]]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(lo * itemSize, count * itemSize);
      attr.needsUpdate = true;
    }
    this._dirtyLo = this.max;
    this._dirtyHi = 0;
  }

  dispose() {
    this.geometry.dispose();
  }
}

/* ------------------------------------------------------------------ *
 * ParticleFX
 * ------------------------------------------------------------------ */
export class ParticleFX {
  constructor(ctx) {
    this.ctx = ctx;
    this.object3D = new THREE.Object3D();
    this.object3D.name = 'particles';

    this._rng = makeRng(seedFromString(CONFIG.seed + ':particles'));
    this._time = 0;
    this._sprayDebt = 0;
    this._plumeDebt = 0;
    this._ambientSeeded = false;

    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
  }

  build() {
    const uniforms = {
      uTime: { value: 0 },
      uPixelScale: { value: 260 },
      uGravity: { value: new THREE.Vector3(0, -CONFIG.physics.gravity * 0.42, 0) },
      uWind: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.97, 0.92) },
      uSkyColor: { value: new THREE.Color(0.45, 0.60, 0.85) },
      uCameraPos: { value: new THREE.Vector3() },
    };
    this.uniforms = uniforms;

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Normal alpha blending, not additive. Snow is a dense scatterer that
      // *occludes* what is behind it; additive spray glows like fire and is
      // one of the most common tells of a hobby-grade particle system.
      blending: THREE.NormalBlending,
    });
    this.material = material;

    this.dynamic = new PointPool(MAX_DYNAMIC, material);
    this.ambient = new PointPool(MAX_AMBIENT, material);
    this.object3D.add(this.dynamic.points);
    this.object3D.add(this.ambient.points);
    this.ctx.scene.add(this.object3D);

    // Wind, from the configured meteorological direction (the direction it
    // blows *from*, as weather is always quoted).
    const wd = THREE.MathUtils.degToRad(CONFIG.world.windDirection);
    this._wind = new THREE.Vector3(-Math.sin(wd), 0, -Math.cos(wd))
      .multiplyScalar(CONFIG.world.windSpeed);
    uniforms.uWind.value.copy(this._wind).multiplyScalar(0.35);
  }

  /* ---------------------------------------------------------------- *
   * Emission
   * ---------------------------------------------------------------- */

  /**
   * Edge spray. `direction` is the board's travel; the sheet leaves the edge
   * roughly perpendicular to it and slightly upward.
   */
  emitSpray(position, direction, intensity) {
    if (!this.dynamic || intensity <= 0.001) return;
    const rng = this._rng;
    const n = Math.min(Math.floor(intensity * 60), 96);
    const t = this._time;

    this._fwd.copy(direction).setY(0);
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, 1);
    this._fwd.normalize();
    this._right.set(-this._fwd.z, 0, this._fwd.x);

    for (let i = 0; i < n; i++) {
      // Launch from a line along the effective edge rather than from a point,
      // so the spray is a sheet — this is what makes it read as thrown snow
      // rather than as an explosion at the rider's feet.
      const along = (rng() - 0.5) * 1.1;
      const px = position.x + this._fwd.x * along + this._right.x * (rng() - 0.5) * 0.12;
      const py = position.y + 0.02 + rng() * 0.06;
      const pz = position.z + this._fwd.z * along + this._right.z * (rng() - 0.5) * 0.12;

      // Sideways and up, with a strong spread. Faster particles live longer
      // and end up at the top of the plume, which gives the cloud its shape.
      const side = (0.55 + rng() * 0.75) * intensity * 7.5;
      const up = (0.7 + rng() * 1.5) * intensity * 4.2;
      const back = -(0.1 + rng() * 0.5) * intensity * 2.4;
      const sign = intensity > 0 ? 1 : -1;

      // Small and many reads as thrown snow mist; the previous 2–6.5 cm
      // sprites at low counts read as individual white balls.
      this.dynamic.spawn(
        px, py, pz,
        this._right.x * side * sign + this._fwd.x * back + (rng() - 0.5) * 1.2,
        up,
        this._right.z * side * sign + this._fwd.z * back + (rng() - 0.5) * 1.2,
        t,
        0.55 + rng() * 1.15 * intensity,
        0.014 + rng() * 0.028,
        1.4 + rng() * 1.4,
        0, rng() * 100, 0.9 + rng() * 0.35, (rng() - 0.5) * 4,
      );
    }

    // The wall itself. Individual crystals never aggregate into the opaque
    // sheet the reference footage shows — that sheet is unresolved mist, and
    // it has to be drawn as what it is: a handful of large, slow, soft puffs
    // underneath the bright chunks. High drag so they hang and billow.
    const nPuff = Math.min(Math.ceil(n * 0.3), 18);
    for (let i = 0; i < nPuff; i++) {
      const along = (rng() - 0.5) * 1.0;
      this.dynamic.spawn(
        position.x + this._fwd.x * along + this._right.x * (rng() - 0.2) * 0.3,
        position.y + 0.05 + rng() * 0.15,
        position.z + this._fwd.z * along + this._right.z * (rng() - 0.2) * 0.3,
        this._right.x * (0.4 + rng() * 0.5) * intensity * 5.0 + (rng() - 0.5) * 0.8,
        (0.5 + rng() * 0.9) * intensity * 3.2,
        this._right.z * (0.4 + rng() * 0.5) * intensity * 5.0 + (rng() - 0.5) * 0.8,
        t,
        0.7 + rng() * 1.1 * intensity,
        0.16 + rng() * 0.26,
        3.2 + rng() * 2.0,
        2, rng() * 100, 0.72 + rng() * 0.2, (rng() - 0.5) * 2,
      );
    }
  }

  /** The plume a buried nose throws forward and up in deep snow. */
  emitPlume(position, direction, intensity) {
    if (!this.dynamic || intensity <= 0.001) return;
    const rng = this._rng;
    const n = Math.min(Math.floor(intensity * 14), 22);
    const t = this._time;
    for (let i = 0; i < n; i++) {
      const spread = 1.5;
      this.dynamic.spawn(
        position.x + (rng() - 0.5) * spread,
        position.y + 0.15 + rng() * 0.5,
        position.z + (rng() - 0.5) * spread,
        direction.x * (1.5 + rng() * 3.0) + (rng() - 0.5) * 2.2,
        1.4 + rng() * 3.4 * intensity,
        direction.z * (1.5 + rng() * 3.0) + (rng() - 0.5) * 2.2,
        t,
        1.1 + rng() * 1.9,
        0.030 + rng() * 0.050,
        0.85 + rng() * 0.7,
        1, rng() * 100, 0.95 + rng() * 0.3, (rng() - 0.5) * 3,
      );
    }
  }

  /** Landing / crash burst — a ring of snow driven outward and up. */
  emitImpact(position, intensity) {
    if (!this.dynamic || intensity <= 0.001) return;
    const rng = this._rng;
    const n = Math.min(Math.floor(20 + intensity * 90), 130);
    const t = this._time;
    for (let i = 0; i < n; i++) {
      // Even angular distribution so the burst is a ring, not a blob.
      const a = (i / n) * Math.PI * 2 + rng() * 0.4;
      const sp = (1.4 + rng() * 4.6) * (0.35 + intensity);
      this.dynamic.spawn(
        position.x + Math.cos(a) * 0.16,
        position.y + 0.04 + rng() * 0.1,
        position.z + Math.sin(a) * 0.16,
        Math.cos(a) * sp,
        (1.2 + rng() * 3.6) * (0.4 + intensity),
        Math.sin(a) * sp,
        t,
        0.7 + rng() * 1.5,
        0.028 + rng() * 0.06,
        1.1 + rng() * 1.1,
        2, rng() * 100, 1.0 + rng() * 0.25, (rng() - 0.5) * 5,
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * Per-frame
   * ---------------------------------------------------------------- */
  update(dt, ctx) {
    if (!this.dynamic) return;
    this._time += dt;
    const u = this.uniforms;
    u.uTime.value = this._time;

    const cam = ctx.camera;
    u.uCameraPos.value.copy(cam.position);
    // Point size is in pixels and must track the vertical resolution and the
    // FOV, or spray is the wrong size the moment either changes.
    const h = ctx.renderer?.domElement?.height || 1080;
    u.uPixelScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5));

    // Lighting from the sky system, so spray is lit by the same sun as the
    // snow it came off. sky.js keeps these as live members and mutates them
    // in place as the solar position updates, so reading them each frame
    // costs nothing and never goes stale.
    const sky = ctx.sky;
    if (sky) {
      if (sky.sunDirection) u.uSunDir.value.copy(sky.sunDirection).normalize();
      if (sky.sunColor) u.uSunColor.value.copy(sky.sunColor);
      if (sky.ambientColor) u.uSkyColor.value.copy(sky.ambientColor);
    }

    const s = ctx.physics?.state;
    if (s) this._rideEmission(dt, s);

    this._updateAmbient(dt, cam);

    this.dynamic.flush();
    this.ambient.flush();
  }

  /**
   * Convert the rider's state into emission. Rates are fractional and carried
   * as debt between frames, so a low rate still produces an even trickle
   * instead of nothing at all.
   */
  _rideEmission(dt, s) {
    if (!s.grounded || s.speed < 1.2) return;

    this._fwd.set(Math.sin(s.heading), 0, Math.cos(s.heading));

    // Edge spray scales with how hard the edge is working and how fast the
    // board is moving sideways through the snow.
    const spray = clamp01(s.sprayIntensity || 0);
    if (spray > 0.02) {
      // 46/s at full intensity was a trickle: a spray wall needs hundreds of
      // sprites in the air at once against a 2600 pool with ~2 s lifetimes.
      this._sprayDebt += spray * 340 * dt;
      if (this._sprayDebt >= 1) {
        const count = Math.floor(this._sprayDebt);
        this._sprayDebt -= count;
        // Spray leaves from the uphill edge, i.e. opposite the lateral slip.
        const sign = (s.lateralSpeed || 0) >= 0 ? -1 : 1;
        this._v.copy(s.position);
        this._v2.copy(this._fwd).multiplyScalar(sign);
        this.emitSpray(this._v, this._v2, spray * clamp01(count / 3));
      }
    }

    // Deep snow throws a plume off the nose regardless of edge angle.
    const sink = (s.sinkDepth || 0) / Math.max(CONFIG.physics.powderDepth, 1e-3);
    const plume = clamp01(sink * smoothstep(5, 18, s.speed));
    if (plume > 0.05) {
      this._plumeDebt += plume * 16 * dt;
      if (this._plumeDebt >= 1) {
        const count = Math.floor(this._plumeDebt);
        this._plumeDebt -= count;
        this._v.copy(s.position).addScaledVector(this._fwd, 0.6);
        this.emitPlume(this._v, this._fwd, plume * clamp01(count / 2));
      }
    }
  }

  /**
   * Ambient snow and surface drift, recycled in a box around the camera. In
   * bluebird weather this is not falling snow — it is the fine spindrift the
   * wind lifts off the pack, which is present on every clear cold day in the
   * Southern Alps and is most of what gives the air texture in the reference.
   */
  _updateAmbient(dt, cam) {
    const rng = this._rng;
    const weather = CONFIG.world.weather;
    const falling = weather === 'snowing' || weather === 'storm';
    const budget = falling ? MAX_AMBIENT : Math.floor(MAX_AMBIENT * 0.45);

    if (!this._ambientSeeded) {
      // Fill the box once, spread over the particle lifetime so the field is
      // not a synchronised curtain that all recycles on the same frame.
      for (let i = 0; i < budget; i++) this._spawnAmbient(cam, rng, -rng() * 6.0, falling);
      this._ambientSeeded = true;
      return;
    }

    // Steady-state replacement: with lifetime L and budget N, spawn N/L per
    // second to hold the population constant.
    const life = falling ? 6.0 : 4.5;
    this._ambientDebt = (this._ambientDebt || 0) + (budget / life) * dt;
    const n = Math.floor(this._ambientDebt);
    if (n > 0) {
      this._ambientDebt -= n;
      for (let i = 0; i < Math.min(n, 60); i++) this._spawnAmbient(cam, rng, 0, falling);
    }
  }

  _spawnAmbient(cam, rng, ageOffset, falling) {
    const box = AMBIENT_BOX;
    const px = cam.position.x + (rng() - 0.5) * 2 * box;
    const pz = cam.position.z + (rng() - 0.5) * 2 * box;
    const ground = this.ctx.terrain?.getHeight?.(px, pz) ?? cam.position.y - 10;

    let py, vy, size, life, bright;
    if (falling) {
      py = cam.position.y + box * 0.5 + rng() * box * 0.4;
      vy = -(0.7 + rng() * 0.9);
      size = 0.014 + rng() * 0.022;
      life = 6.0;
      bright = 0.9 + rng() * 0.3;
    } else {
      // Spindrift hugs the surface: it lives in the first couple of metres
      // above the pack and streams downwind, not down.
      py = ground + 0.05 + rng() * rng() * 2.4;
      vy = (rng() - 0.35) * 0.5;
      size = 0.008 + rng() * 0.014;
      life = 4.5;
      bright = 0.85 + rng() * 0.35;
    }

    const gust = 0.75 + rng() * 0.7;
    this.ambient.spawn(
      px, py, pz,
      this._wind.x * gust + (rng() - 0.5) * 1.4,
      vy,
      this._wind.z * gust + (rng() - 0.5) * 1.4,
      this._time + ageOffset,
      life,
      size,
      0.35 + rng() * 0.5,
      3, rng() * 100, bright, (rng() - 0.5) * 2,
    );
  }

  dispose() {
    this.dynamic?.dispose();
    this.ambient?.dispose();
    this.material?.dispose();
    this.ctx.scene.remove(this.object3D);
  }
}
