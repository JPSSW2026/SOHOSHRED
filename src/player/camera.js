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

/**
 * Closest the camera may ever sit to the rider, metres.
 *
 * Enforced whether or not the avoidance sweep fired: the follow spring
 * overshoots inward on hard direction changes, and inside this the rider
 * stops being a figure in a landscape and becomes a wall of jacket.
 */
const MIN_CHASE = 4.2;

/**
 * Hard bound on how far behind the rider the camera may ever be, metres.
 *
 * The follow spring is stable on paper, but it chases a target derived from
 * terrain samples and a LOD rebuild can hand it a wild height for a frame.
 * The old avoidance clamp fired EVERY frame and multiplied the spring's
 * velocity by 0.4 as a side effect, which silently masked that; with the
 * clamp now firing only when something is genuinely in the way, the brake is
 * gone and a transient can run away (caught once in four probe runs, camera
 * at 1e28 m). A chase camera 30 m back is broken by definition, so bound it.
 */
const MAX_CHASE = 30;

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
    this._off = new THREE.Vector3();
    this._sp1 = new THREE.Vector3();
    this._sp2 = new THREE.Vector3();
    this._offPrev = null;   // null until the first station is computed
    this._dir = new THREE.Vector3();
    this._flat = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    // Slope-relative offset basis (see the station block in _station).
    this._camUp = new THREE.Vector3(0, 1, 0);
    this._camDir = new THREE.Vector3(0, 0, 1);
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
    // Drop the smoothed speed so a snap adopts the new state immediately
    // rather than easing over from wherever the camera was before.
    this._speedLP = null;
    this._offPrev = null;
    this._chaseLen = null;
    this._clearLP = null;
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

    // Analytic critically-damped spring, not semi-implicit Euler.
    //
    // Two faults compounded here. The comment above claimed zeta = 1 "so the
    // camera arrives without overshoot", but the config ships damping 0.86 --
    // under-damped, so it always overshot and rang. And explicit integration
    // of a spring injects energy, which makes that ringing grow rather than
    // decay. The result was a station accelerating at a p99 of ~900 m/s^2 and
    // momentarily travelling at 66-86 m/s while the rider held 12: the camera
    // was manufacturing the judder itself, not inheriting it. It got worse
    // with speed because a faster target drives the spring harder.
    //
    // The closed-form critically damped solution is exact for any dt and
    // cannot ring or diverge, so the chase stays smooth at any frame rate and
    // any speed.
    const e = Math.exp(-omega * dt);
    this._sp1.subVectors(this._pos, this._desired);                 // change
    this._sp2.copy(this._vel).addScaledVector(this._sp1, omega).multiplyScalar(dt);
    this._pos.copy(this._desired).addScaledVector(this._sp1.add(this._sp2), e);
    this._vel.addScaledVector(this._sp2, -omega).multiplyScalar(e);

    // ---- Range lock --------------------------------------------------
    // Hold the DISTANCE, let the ANGLE lag.
    //
    // As the rider turns, _dir swings and the desired station orbits around
    // them. A position spring cannot tell "behind by 20 degrees" from "too far
    // away": it chases along a chord, and a chord is shorter than the arc it
    // is cutting, so the camera dives in through every turn and drifts back
    // out after it. Measured over linked turns that was 6.67 m peak-to-peak
    // against a nominal 8.6 m follow -- the camera visibly pumping in and out
    // once per turn.
    //
    // The radius is the part a viewer reads as pumping, so it is corrected
    // stiffly; the angular catch-up is left to the soft spring above, which is
    // what gives the chase its lazy, filmed quality. Splitting them keeps that
    // feel without the surge.
    if (this._desiredRange != null) {
      this._v.subVectors(this._pos, s.position);
      const r = this._v.length();
      if (r > 1e-3) {
        const kR = 1 - Math.exp(-dt * 26);
        const want = r + (this._desiredRange - r) * kR;
        this._pos.copy(s.position).addScaledVector(this._v, want / r);
        // Correct the VELOCITY by the same amount, or the spring integrates
        // momentum that the position correction has already spent. That is an
        // energy source: each frame the lock pulled the station in, the spring
        // still carried the old outward velocity, and the pair wound each
        // other up -- the station reached 92 m/s while the rider held 18, and
        // it got worse with speed because a faster turn drives the lock
        // harder. Damp the radial component at the lock's own rate; the
        // tangential component, which is the angular catch-up, is untouched.
        this._sp1.copy(this._v).multiplyScalar(1 / r);
        this._vel.addScaledVector(this._sp1, -this._vel.dot(this._sp1) * kR);
      }
    }

    // Divergence guard — see MAX_CHASE.
    this._v.subVectors(this._pos, s.position);
    const chase = this._v.length();
    if (chase > MAX_CHASE) {
      this._pos.copy(s.position).addScaledVector(this._v, MAX_CHASE / chase);
      this._vel.multiplyScalar(0.2);
    }

    // ---- Keep it out of the hill ------------------------------------
    this._avoidTerrain(s, dt);

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
    // Framing speed is LOW-PASSED, and this matters more than it sounds.
    //
    // A carve scrubs speed against the edge and wins it back down the fall
    // line, so instantaneous speed ripples every single turn. speedT feeds
    // three things at once -- the follow distance (0.42 of 8.6 m, so ~3.6 m of
    // travel), the height, and a 7 m look-point lead -- so that ripple became
    // the camera visibly pulling in and out of the rider once per turn, with
    // the aim point surging at the same time. The framing should track how
    // fast the rider *is going*, not the within-turn ripple.
    //
    // ~1.2 s follow: fast enough that dropping into a steep pitch still opens
    // the shot out, slow enough that a turn cannot pump it. Exponential so it
    // is frame-rate independent.
    if (this._speedLP == null) this._speedLP = s.speed;   // no ramp-in on the first frame
    this._speedLP += (s.speed - this._speedLP) * (dt > 0 ? 1 - Math.exp(-dt / 1.2) : 1);
    const speedT = smoothstep(0, 26, this._speedLP);
    const airT = clamp01((s.airHeight || 0) / 6);
    const wide = this.mode === 'cinematic' ? 1.45 : 1.0;
    const dist = C.followDistance * wide * (1 + speedT * 0.42 + airT * 0.55);
    const height = C.followHeight * (1 + speedT * 0.18 + airT * 0.75);

    // THE STATION IS SLOPE-RELATIVE, not world-vertical.
    //
    // Both offsets used to be built on world up: `height` straight up, `dist`
    // straight back along a horizontal heading. On a pitch that is wrong in a
    // way that compounds — the ground `dist` behind the rider is uphill, so at
    // 34 deg and 10 m back it sits ~6.7 m ABOVE them. A station 2.7 m above
    // world-vertical is then metres inside the hill, the terrain-clearance
    // guard downstream shoves it out, and what the player gets is a view down
    // onto their own helmet across a foreground roll — with the spray plume
    // sitting exactly on the sightline to the board.
    //
    // Measured, rider chest in NDC (0 centre, +1 top) while carving:
    //
    //   slope     ndcY mean   p10..p90 spread   cam above rider
    //    0- 9°      -0.11          0.13             1.60 m
    //   10-19°      -0.17          0.17             1.74 m
    //   20-29°      -0.16          0.64             1.90 m
    //   30-39°      +1.37          0.76             2.34 m   <- off the top
    //   40-49°      +0.33          0.40             2.64 m
    //
    // Flat is steady and well placed, which is the framing worth keeping. By
    // 30 deg the spread is 6x wider and the mean is off-screen.
    //
    // The fix is to stop measuring the offset against the world and measure it
    // against the slope: blend the offset basis toward the surface normal as
    // the pitch steepens, and take the follow direction in that same plane. On
    // flat ground the normal IS world up, so nothing changes and the carve
    // flow is untouched by construction. On a pitch the camera sits square
    // behind and above the RUN, which is where the run is visible from and
    // where the spray blows clear of the lens rather than across it.
    const slopeT = clamp01((s.slope || 0) / 0.85);
    this._camUp.copy(this._up);
    if (s.normal && slopeT > 0) {
      this._camUp.lerp(s.normal, slopeT * 0.80);
      if (this._camUp.lengthSq() > 1e-6) this._camUp.normalize(); else this._camUp.copy(this._up);
    }
    // Follow direction, re-squared into the slope plane so `dist` is measured
    // along the run rather than along the horizon.
    this._camDir.copy(this._dir)
      .addScaledVector(this._camUp, -this._dir.dot(this._camUp));
    if (this._camDir.lengthSq() > 1e-6) this._camDir.normalize(); else this._camDir.copy(this._dir);

    this._desired.copy(s.position)
      .addScaledVector(this._camDir, -dist)
      .addScaledVector(this._camUp, height);
    // Range the station actually wants, recorded for the range lock in
    // update(). Taken after every offset below has been applied.
    this._desiredRange = null;

    // A little extra drop on the very steepest ground. Much smaller than the
    // 0.22 this replaces: that number was compensating for a station buried in
    // the hill, and with a slope-relative station there is far less to correct.
    if (s.normal) {
      this._desired.addScaledVector(this._camUp, -slopeT * dist * 0.06);
    }

    // ---- Station slew limit -------------------------------------------
    // Limit how fast the station OFFSET may move -- the offset being where the
    // camera wants to sit relative to the rider, so the rider's own motion
    // passes through untouched and this cannot make the camera lag them.
    //
    // Several terms feeding the station can step discontinuously: the follow
    // direction blends toward the velocity vector, which swings hard when a
    // carve reverses (and flips outright if the board ever tracks backwards),
    // and the pitch-lean offset is scaled by a terrain slope sampled fresh
    // each frame. The spring then converts each of those steps into a spike --
    // measured at a p99 station acceleration of 1000-1700 m/s^2, with the
    // station momentarily travelling faster than 60 m/s while the rider was
    // doing 5-15. That is the judder.
    //
    // A rate limit turns a step into a short slew. 9 m/s is far above anything
    // the framing does deliberately, so normal response is untouched and only
    // the discontinuities are caught.
    this._off.subVectors(this._desired, s.position);
    if (this._offPrev) {
      this._v2.subVectors(this._off, this._offPrev);
      const step = this._v2.length(), maxStep = 9 * dt;
      if (step > maxStep) this._off.copy(this._offPrev).addScaledVector(this._v2, maxStep / step);
      this._desired.copy(s.position).add(this._off);
    } else {
      this._offPrev = new THREE.Vector3();
    }
    this._offPrev.copy(this._off);

    this._desiredRange = this._desired.distanceTo(s.position);

    // Look point: ahead of the rider along the direction of travel, lifted to
    // chest height, dropping as they get airborne so the landing stays framed.
    const lead = 5.0 + speedT * 7.0;
    this._look.copy(s.position)
      .addScaledVector(this._dir, lead)
      .addScaledVector(this._up, 1.15 - airT * 0.5);
    // Put the aim point ON the slope ahead, not on the rider's horizontal
    // plane. _dir is horizontal by construction, so the look point used to
    // float above the snow by however much the hill dropped over the lead
    // distance -- at 22 m/s on a 34 deg pitch that is 7.8 m of float, which
    // aimed the lens ~30 deg above the fall line (measured) with a half-FOV
    // of only 34.7. The whole run ahead compressed into the bottom sliver of
    // frame and the top half was sky.
    if (terrain && s.grounded) {
      const ah = terrain.getHeight(this._look.x, this._look.z);
      if (Number.isFinite(ah)) {
        // Blend rather than snap: full tracking on the steeps where it
        // matters, and on the flat the two agree anyway.
        const track = clamp01((s.slope || 0) / 0.45);
        this._look.y += (ah + 1.6 - this._look.y) * track;
      }
    }
    // (A guard used to sit here that claimed to fix the same steep-pitch
    // framing by pulling the look point back UP toward the rider's altitude.
    // It was a no-op and pointed the wrong way: this._look.y is already
    // s.position.y + 1.15, so the correction it computed was -0.15 m, about
    // 0.6 deg. Tracking the slope above is the actual fix.)

    // In the air, aim at where they will actually come down.
    if (!s.grounded && terrain && s.velocity.y < 0) {
      const g = CONFIG.physics.gravity;
      // Time to fall back to the height they left at — good enough to frame.
      // Descending root. Negating velocity.y here took the ASCENDING root of
      // the fall quadratic even though this branch only runs when the rider
      // is already falling, so the predicted touchdown ran 1.4x long at
      // -2 m/s and 9x long at -11 m/s -- pinned to the 2.2 s clamp for the
      // back half of any real air, aiming 40 m past where the rider actually
      // lands, with the aim blended 70% toward it.
      const tFall = clamp((s.velocity.y + Math.sqrt(Math.max(s.velocity.y * s.velocity.y + 2 * g * (s.airHeight || 0), 0))) / g, 0, 2.2);
      this._v2.copy(s.position).addScaledVector(s.velocity, tFall);
      this._v2.y = terrain.getHeight(this._v2.x, this._v2.z) + 1.0;
      this._look.lerp(this._v2, clamp01(airT * 0.7));
    }
  }

  /* ------------------------------------------------------------------ *
   * Terrain avoidance
   * ------------------------------------------------------------------ */
  _avoidTerrain(s, dt) {
    const terrain = this.ctx.terrain;
    if (!terrain) return;

    // 1. Never below the surface under the camera itself.
    const ground = terrain.getHeight(this._pos.x, this._pos.z);
    const minY = ground + GROUND_CLEARANCE;
    if (this._pos.y < minY) {
      // Lifted at a rate, not assigned. The sampled ground under the camera
      // steps as the station sweeps across new terrain -- 0.37 m of it per
      // frame at 22 m/s -- and a hard assignment turns every one of those
      // steps into a shove. 18 is ~55 ms, so the camera is out of the snow
      // faster than the eye tracks, without the step.
      this._pos.y = damp(this._pos.y, minY, 18, dt);
      if (this._vel.y < 0) this._vel.y = 0;
    }

    // 2. Nothing between the camera and the rider. March the line back from
    //    the rider and stop at the first sample the hill intrudes on — a
    //    convex rollover on a real slope will otherwise eat the camera whole.
    // Airborne there is nothing to avoid: the rider is above the snow by
    // construction and the camera is above them, so any hit the sweep reports
    // is spurious. Gating here also kills the toggling — a minimum-charge
    // ollie apexes at ~0.34 m, right on the old engage threshold, so tap
    // ollies and sastrugi chatter flipped the camera between two stations.
    // Airborne: nothing to avoid, but do NOT return. Returning froze the
    // chase length wherever it happened to be and then re-engaged from that
    // stale value on touchdown -- a single-frame jump, and the source of the
    // 27,000 m/s2 outlier in the straight-line-at-speed trace. Relax the leash
    // instead, so landing continues from wherever the relaxation reached.
    if (!s.grounded) {
      if (this._chaseLen != null) {
        this._v.subVectors(this._pos, s.position);
        this._chaseLen = damp(this._chaseLen, Math.max(this._v.length(), MIN_CHASE), 4, dt);
      }
      return;
    }

    this._v.subVectors(this._pos, s.position);
    const len = this._v.length();
    if (len < 0.5) return;
    this._v.multiplyScalar(1 / len);

    let clear = len, prevGap = null;
    for (let i = 1; i <= SWEEP_STEPS; i++) {
      const d = (i / SWEEP_STEPS) * len;
      this._v2.copy(s.position).addScaledVector(this._v, d);
      // Required clearance RAMPS from nothing at the rider to full at the
      // camera. Flat, it was full clearance at every sample including the
      // first — but the ray starts at the board sitting ON the snow, so
      // sample 1 is ~0.1-0.3 m up while the test demanded 0.64 m. It failed
      // on its first sample every frame on every slope, which pinned the
      // chase at the 4.2 m floor forever: the configured 8.6 m follow
      // distance was never once used, and the rider filled a third of the
      // frame instead of the intended eighth.
      const need = GROUND_CLEARANCE * 0.75 * (i / SWEEP_STEPS);
      const h = terrain.getHeight(this._v2.x, this._v2.z) + need;
      const gap = this._v2.y - h;
      if (gap < 0) {
        // Interpolate the crossing; do NOT snap back to the previous sample.
        //
        // This used to report the last CLEAR sample index, which quantises the
        // answer to whole sweep steps: as the camera drifts, the sample that
        // first intrudes flips between i and i+1 and the reported clearance
        // jumps by len/SWEEP_STEPS -- on a 9 m chase, about a metre, in a
        // single frame. That is the ~1.5 m shove behind the judder, and it
        // gets worse with speed because the ray sweeps across more terrain per
        // frame and so flips more often.
        //
        // The gap either side of the crossing gives its position directly, and
        // a linearly interpolated crossing moves continuously as the geometry
        // slides under the ray, so the pull-in target stops stepping.
        const t = prevGap != null && prevGap > 0 ? prevGap / (prevGap - gap) : 0;
        clear = ((i - 1) + t) / SWEEP_STEPS * len;
        break;
      }
      prevGap = gap;
    }
    // ---- Chase length: one continuous state, engaged or not ----------
    //
    // This is the whole of the high-speed judder. Measured straight-lining at
    // 22 m/s, disabling this method took station acceleration from a p99 of
    // 5744 m/s2 to 36 -- a 50x collapse -- while the rider itself sat at 25.
    //
    // The old shape had no state. While the sweep reported an intrusion it
    // damped the camera inward and multiplied velocity by 0.4 EVERY FRAME;
    // the moment the sweep came back clear it did nothing at all and handed
    // the camera straight back to the spring. So engaging was a ramp, releasing
    // was a snap, and the repeated velocity kick fought the spring throughout.
    // At speed the sweep flickers between hit and miss many times a second as
    // rolls pass under the ray, so the camera was being alternately dragged in
    // and released several times a second.
    //
    // A single damped chase length, maintained whether or not anything is in
    // the way, makes both directions the same continuous motion. The spring
    // still owns the station; this only ever shortens the leash.
    // Filter the SWEEP RESULT, not just the response to it.
    //
    // At 22 m/s the ray sweeps 0.37 m of new terrain every frame, so `clear`
    // flips between "nothing in the way" and a hard pull-in many times a
    // second as rolls pass beneath it. Damping the camera's response to a
    // signal that noisy still tracks the noise -- which is why a damped chase
    // length alone only got p99 from 5744 to 2852 against the 36 measured
    // with this method disabled entirely. The instability is in the input.
    //
    // Terrain occlusion is a slow physical event: a hill takes a good fraction
    // of a second to come between camera and rider. Filtering `clear` on that
    // timescale removes the flicker without ever being late for the real
    // thing.
    const rawWant = clear < len - 0.01 ? Math.max(clear, MIN_CHASE) : Math.max(len, MIN_CHASE);
    if (this._clearLP == null) this._clearLP = rawWant;
    this._clearLP = damp(this._clearLP, rawWant, rawWant < this._clearLP ? 7 : 3, dt);
    const want = this._clearLP;
    if (this._chaseLen == null) this._chaseLen = want;
    // Pull in faster than we let out: getting a hill out of the lens is
    // urgent, giving the shot back is not.
    this._chaseLen = damp(this._chaseLen, want, want < this._chaseLen ? 8 : 3, dt);
    if (this._chaseLen < len - 0.01) {
      this._pos.copy(s.position).addScaledVector(this._v, this._chaseLen);
      const g2 = terrain.getHeight(this._pos.x, this._pos.z) + GROUND_CLEARANCE;
      if (this._pos.y < g2) this._pos.y = damp(this._pos.y, g2, 18, dt);
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
