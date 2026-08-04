/**
 * Board physics.
 *
 * The model is a single rigid contact point (the board's running surface)
 * carrying a rider mass, integrated at a fixed 120 Hz step. It is not a full
 * rigid-body sim — a snowboard does not need one — but every force in it is a
 * real force with a real coefficient, because the *feel* of a snowboard comes
 * from the ratio between them and fudged ratios feel wrong no matter how much
 * you tune the numbers on top.
 *
 * The forces, in the order they matter:
 *
 *   1. Gravity projected onto the slope tangent plane. This is the engine.
 *   2. Edge grip — a lateral acceleration budget that holds the board on its
 *      arc. Exceed it and the board washes out into a skid, which is what
 *      makes speed control possible and what makes a blown turn feel blown.
 *   3. Sidecut steering. A carving board turns because it is bent into an arc
 *      by the rider's inclination, not because it is being yawed. Turn radius
 *      falls as edge angle rises: R = R_sidecut · cos(edge).
 *   4. Base friction against snow. Waxed P-tex on cold dry snow is ~0.045;
 *      wet spring snow is three times that. Surface class drives it.
 *   5. Powder displacement drag — quadratic in speed, linear in sink depth.
 *      This is the force that makes deep snow feel deep.
 *   6. Air drag, tucked vs upright, which is what sets terminal velocity.
 *
 * Everything is deterministic: no Math.random, no wall-clock reads. Two runs
 * with the same inputs produce bit-identical state, which the screenshot
 * harness depends on.
 */

import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { clamp, clamp01, lerp, smoothstep, damp, angleDelta } from '../core/rng.js';

/** Sidecut radius of a 156 cm all-mountain deck, metres. */
const SIDECUT_RADIUS = 8.4;
/** Tightest arc the board can be bent into before the tail lets go. */
const MIN_TURN_RADIUS = 2.4;
/** Maximum inclination the rider can hold, radians (~62°). */
const MAX_EDGE = 1.08;
/** Effective edge length in contact, metres — used for the pivot/skid model. */
const EDGE_LENGTH = 1.18;
/** Gap above the surface before the board is considered airborne. */
const AIRBORNE_GAP = 0.11;
/**
 * Deepest the board is ever *drawn* below the snow surface, metres.
 * Must stay under the deck's own thickness (13 mm) or the topsheet vanishes
 * beneath the heightfield and the rider reads as boots with no board.
 */
const VISUAL_SINK_CAP = 0.010;
/** Closing speed into the snow, m/s, above which a landing hurts. */
const HARD_LANDING = 9.0;
/** Closing speed above which the rider cannot absorb it at all. */
const CRASH_LANDING = 17.5;
/** Slip angle beyond which a landing is a catch-edge rather than a landing. */
const CRASH_SLIP_ANGLE = 1.02;

/**
 * Per-surface response. `friction` is the base coefficient, `grip` scales the
 * lateral budget, `drag` scales powder displacement, `spray` is how much snow
 * an edge throws (particles.js reads it through the state).
 */
const SURFACES = {
  powder:    { friction: 0.052, grip: 0.86, drag: 1.00, spray: 1.00, sink: 1.00 },
  windpack:  { friction: 0.041, grip: 1.04, drag: 0.34, spray: 0.55, sink: 0.42 },
  sastrugi:  { friction: 0.058, grip: 0.92, drag: 0.46, spray: 0.62, sink: 0.50 },
  crust:     { friction: 0.038, grip: 0.78, drag: 0.22, spray: 0.34, sink: 0.24 },
  ice:       { friction: 0.022, grip: 0.44, drag: 0.05, spray: 0.12, sink: 0.05 },
  groomed:   { friction: 0.034, grip: 1.18, drag: 0.18, spray: 0.48, sink: 0.28 },
  slush:     { friction: 0.098, grip: 0.94, drag: 0.72, spray: 0.80, sink: 0.66 },
  rock:      { friction: 0.240, grip: 0.30, drag: 0.02, spray: 0.00, sink: 0.02 },
  scree:     { friction: 0.210, grip: 0.34, drag: 0.04, spray: 0.02, sink: 0.04 },
  tussock:   { friction: 0.160, grip: 0.52, drag: 0.10, spray: 0.04, sink: 0.10 },
};
const DEFAULT_SURFACE = SURFACES.powder;

const NEUTRAL_INPUT = {
  steer: 0, lean: 0, crouch: 0, pop: false, spin: 0, flip: 0,
  grab: null, tuck: false, brake: 0, reset: false,
};

export class BoardPhysics {
  constructor(ctx) {
    this.ctx = ctx;

    this.state = {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      /** Yaw of the board's nose, radians. π faces −Z, the fall line. */
      heading: Math.PI,
      /** Board attitude in its own frame, radians. */
      pitch: 0,
      roll: 0,
      /** Signed edge angle, −1 (heelside) … +1 (toeside), of MAX_EDGE. */
      edgeAngle: 0,

      grounded: true,
      airTime: 0,
      /** Height of the board above the surface it left, metres. */
      airHeight: 0,

      speed: 0,
      /** Signed speed along the board's nose; negative means riding switch. */
      forwardSpeed: 0,
      /** Across the board — the number that decides carve versus skid. */
      lateralSpeed: 0,
      /** Angle between travel and the board's nose, radians. */
      slipAngle: 0,
      gForce: 1,

      surface: 'powder',
      sinkDepth: 0,
      /** Ground normal under the board. */
      normal: new THREE.Vector3(0, 1, 0),
      slope: 0,

      carving: false,
      sliding: false,
      crashed: false,
      /** 0…1, how hard the edge is working against its grip budget. */
      edgeLoad: 0,
      /** 0…1 board flex from pop charge + landing compression. */
      flex: 0,
      /** Impact of the most recent landing, m/s. Zeroed after one frame. */
      landingImpact: 0,
      /** Set for one frame when the board leaves the ground under power. */
      popped: false,
      /** Spray intensity 0…1 for the FX layer. */
      sprayIntensity: 0,
      /** Seconds since the last crash — drives the recovery lockout. */
      crashTime: 0,
      /** Distance travelled this run, metres. */
      distance: 0,
      airRotation: 0,
    };

    this.input = { ...NEUTRAL_INPUT };

    // Scratch vectors. Physics runs 120 times a second; it allocates nothing.
    this._n = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._accel = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._prevVel = new THREE.Vector3();

    this._popCharge = 0;
    this._popLatch = false;
    this._launchNormal = new THREE.Vector3(0, 1, 0);
    this._sample = null;
  }

  /** Called by controls.js each frame; physics reads it at the fixed step. */
  applyInput(input) {
    if (!input) return;
    Object.assign(this.input, input);
  }

  reset(position, heading) {
    const s = this.state;
    s.position.copy(position);
    s.heading = heading ?? Math.PI;
    // Drop-in glide: a rider skates into the fall line, they don't
    // materialise at rest - and the first human playtest found the spawn
    // plateau flat enough to strand a stationary board. 4.5 m/s along the
    // heading self-starts every spawn; capture scripts that want an exact
    // speed overwrite velocity right after reset, unaffected.
    s.velocity.set(Math.sin(s.heading), 0, Math.cos(s.heading)).multiplyScalar(4.5);
    s.pitch = 0;
    s.flipRot = 0;
    s.roll = 0;
    s.edgeAngle = 0;
    s.grounded = true;
    s.airTime = 0;
    s.airHeight = 0;
    s.speed = 0;
    s.forwardSpeed = 0;
    s.lateralSpeed = 0;
    s.slipAngle = 0;
    s.gForce = 1;
    s.sinkDepth = 0;
    s.carving = false;
    s.sliding = false;
    s.crashed = false;
    s.crashTime = 0;
    s.edgeLoad = 0;
    s.flex = 0;
    s.landingImpact = 0;
    s.popped = false;
    s.sprayIntensity = 0;
    s.distance = 0;
    s.airRotation = 0;
    s.normal.set(0, 1, 0);
    this._popCharge = 0;
    this._popLatch = false;

    // Settle onto the surface immediately rather than dropping into it.
    const t = this.ctx.terrain;
    if (t) {
      t.getNormal(s.position.x, s.position.z, s.normal);
      s.slope = Math.acos(clamp(s.normal.y, -1, 1));
      s.position.y = t.getHeight(s.position.x, s.position.z);
    }
  }

  /** Surface response table lookup, tolerant of unknown class names. */
  _surfaceProps(name) {
    return SURFACES[name] || DEFAULT_SURFACE;
  }

  fixedUpdate(h, ctx) {
    const s = this.state;
    const terrain = ctx.terrain;
    if (!terrain) return;

    const input = this.input;
    this._prevVel.copy(s.velocity);

    if (input.reset) {
      const spawn = terrain.getSpawn();
      this.reset(spawn.position, spawn.heading);
      return;
    }

    // ---- Surface query -------------------------------------------------
    // One combined sample per step. Everything below reads from it.
    const smp = terrain.sample
      ? terrain.sample(s.position.x, s.position.z)
      : null;
    const ground = smp ? smp.height : terrain.getHeight(s.position.x, s.position.z);
    const n = smp && smp.normal
      ? this._n.copy(smp.normal)
      : terrain.getNormal(s.position.x, s.position.z, this._n);
    const surfName = smp ? smp.surface : (terrain.getSurface?.(s.position.x, s.position.z) || 'powder');
    const props = this._surfaceProps(surfName);
    s.surface = surfName;

    const g = CONFIG.physics.gravity;
    const P = CONFIG.physics;

    // ---- Crash lockout -------------------------------------------------
    // A crashed rider still slides: gravity and friction keep acting, but no
    // steering, no edge, no pop. It clears when they slow down — or after a
    // couple of seconds regardless: on a steep pitch a slider never drops
    // under the speed gate (gravity beats friction), and the old rule left
    // the player tobogganing the whole headwall with no control (playtest:
    // "BAILED and stuck"). Riders get back up moving; so do we.
    if (s.crashed) {
      s.crashTime += h;
      if ((s.speed < 1.4 && s.crashTime > 1.2) || s.crashTime > 2.2) {
        s.crashed = false;
        s.crashTime = 0;
        s.heading = Math.atan2(s.velocity.x, s.velocity.z) || s.heading;
      }
    }

    const locked = s.crashed;

    // ---- Board frame ---------------------------------------------------
    // The nose direction lives in the tangent plane, not the horizontal
    // plane: on a 30° pitch those differ by half a metre per stride and the
    // board would otherwise carve as though the hill were flat.
    this._fwd.set(Math.sin(s.heading), 0, Math.cos(s.heading));
    this._fwd.addScaledVector(n, -this._fwd.dot(n));
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(Math.sin(s.heading), 0, Math.cos(s.heading));
    this._fwd.normalize();
    this._right.crossVectors(this._fwd, n).normalize();

    // ---- Edge input ----------------------------------------------------
    // The edge cannot snap to angle: rolling a board from heel to toe is a
    // hip movement and takes ~0.18 s. Damping the edge is what makes fast
    // steering input produce a rhythmic turn rather than a square wave.
    const steerTarget = locked ? 0 : clamp(input.steer + input.lean * 0.35, -1, 1);
    const edgeRate = s.grounded ? 11.0 : 6.0;
    s.edgeAngle = damp(s.edgeAngle, steerTarget, edgeRate, h);
    const incl = s.edgeAngle * MAX_EDGE;
    const absIncl = Math.abs(incl);

    // ---- Integrate -----------------------------------------------------
    this._accel.set(0, -g, 0);

    if (s.grounded) {
      this._groundStep(h, s, n, props, incl, absIncl, input, locked, g, P);
      // Whatever rotation a flip left, normalise to the nearest upright and
      // settle. Runs unconditionally (crashed too — a crash mid-flip froze
      // the rider crooked otherwise), and on the DEDICATED flip channel:
      // s.pitch is the surface-following board attitude with its own writer
      // below, and damping it to zero here made the two fight (playtest:
      // rider tilted with the slope, bindings under the deck).
      if (Math.abs(s.flipRot || 0) > 1e-4) {
        s.flipRot = ((s.flipRot + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        s.flipRot = damp(s.flipRot, 0, locked ? 5 : 8, h);
      }
    } else {
      this._airStep(h, s, input, locked, P);
    }

    s.velocity.addScaledVector(this._accel, h);
    s.position.addScaledVector(s.velocity, h);
    s.distance += s.velocity.length() * h;

    // ---- Ground contact ------------------------------------------------
    const newGround = terrain.getHeight(s.position.x, s.position.z);
    const sinkTarget = smp
      ? Math.min(smp.sinkDepth ?? 0, P.powderDepth) * props.sink
      : 0;
    // The board floats on the pack rather than resting on the ground plane:
    // it planes up out of the snow with speed, exactly like a water ski, so
    // sink is deepest at low speed and shallows as the rider gets going.
    const planing = 1 - 0.55 * smoothstep(3, 16, s.speed);
    s.sinkDepth = damp(s.sinkDepth, sinkTarget * planing, 6, h);
    // How far the board rides *below* the undisturbed snow surface.
    //
    // Physically the whole deck disappears in bottomless powder — that is what
    // deep snow is — but the renderer cannot displace the snowpack around it,
    // so an honest sink depth simply buries the board inside the heightfield
    // and the rider reads as two boots floating on a white plane with no board
    // at all. The snow that should have been pushed aside is still drawn.
    //
    // So the drag model keeps the true sink (it is what makes deep snow feel
    // deep) and only the *visual* burial is capped, at just under the board's
    // own thickness plus a little. The trench in trails.js and the plume in
    // particles.js carry the impression of depth instead, which is how the
    // reference does it too: in Shredders you always see the topsheet.
    const contactY = newGround - Math.min(s.sinkDepth * 0.62, VISUAL_SINK_CAP);

    if (s.position.y <= contactY + 1e-4) {
      if (!s.grounded) this._land(s, n, contactY, g, h);
      s.position.y = contactY;
      // Kill the into-surface component only; the along-surface component is
      // the rider's speed and must survive contact untouched.
      const into = s.velocity.dot(n);
      if (into < 0) s.velocity.addScaledVector(n, -into);
      s.grounded = true;
      s.airTime = 0;
      s.airHeight = 0;
      s.airRotation = 0;
    } else if (s.position.y > contactY + AIRBORNE_GAP) {
      if (s.grounded) {
        s.grounded = false;
        this._launchNormal.copy(n);
        s.airTime = 0;
      }
      s.airTime += h;
      s.airHeight = s.position.y - contactY;
    } else {
      // Inside the tolerance band: stay stuck to the surface. Without this a
      // rider crossing a sastrugi field spends half the run 3 cm airborne and
      // the whole ride chatters. A rider *descending into* the band after a
      // real air is still landing, though — skipping _land here silently
      // swallowed every soft touchdown (no trick scored, no chime, no
      // impact puff), which is why grabs "weren't wired up" in playtest.
      if (!s.grounded) this._land(s, n, contactY, g, h);
      s.position.y = contactY;
      const into = s.velocity.dot(n);
      if (into < 0) s.velocity.addScaledVector(n, -into);
      s.grounded = true;
      s.airTime = 0;
    }

    s.normal.copy(n);
    s.slope = Math.acos(clamp(n.y, -1, 1));

    // ---- Derived state -------------------------------------------------
    s.speed = s.velocity.length();
    s.forwardSpeed = s.velocity.dot(this._fwd);
    s.lateralSpeed = s.velocity.dot(this._right);
    const planar = Math.hypot(s.forwardSpeed, s.lateralSpeed);
    s.slipAngle = planar > 0.35 ? Math.atan2(s.lateralSpeed, Math.abs(s.forwardSpeed)) : 0;

    // g-force is what the rider's legs actually feel: the acceleration the
    // ground applied this step, minus gravity, in units of g. A hard carve
    // reads 2–3 g and that is what drives the absorption pose.
    this._tmp.subVectors(s.velocity, this._prevVel).multiplyScalar(1 / Math.max(h, 1e-6));
    this._tmp.y += g;
    s.gForce = s.grounded ? clamp(this._tmp.length() / g, 0, 6) : 0;

    // Board attitude follows the surface when grounded and the rider's own
    // axis in the air.
    if (s.grounded && !locked) {
      const targetRoll = -incl * (0.72 + 0.28 * smoothstep(4, 18, s.speed));
      s.roll = damp(s.roll, targetRoll, 12, h);
      const targetPitch = clamp(-Math.asin(clamp(this._fwd.y, -1, 1)), -0.7, 0.7);
      s.pitch = damp(s.pitch, targetPitch, 9, h);
    }

    // A hard clean carve throws the biggest wall of the lot — the edge is
    // shearing snow along the whole contact length — so edge load dominates
    // and saturates early: at 10 m/s with the edge at 90% of its grip budget
    // the old weights produced 0.24 and thirteen alive particles, which is a
    // dusting, not a spray shot.
    s.sprayIntensity = clamp01(
      props.spray * (
        Math.abs(s.lateralSpeed) * 0.14 +
        s.edgeLoad * smoothstep(3, 9, s.speed) * 1.10 +
        (s.sinkDepth / Math.max(P.powderDepth, 1e-3)) * smoothstep(4, 20, s.speed) * 0.45
      ),
    );

    s.carving = s.grounded && !s.sliding && absIncl > 0.16 && s.speed > 4.5;
    s.flex = damp(s.flex, this._popCharge * 0.7 + clamp01(s.gForce - 1) * 0.4, 10, h);
    s.landingImpact *= 0.0; // one-frame event; consumers read it the frame it fires
    s.popped = false;
  }

  /* ------------------------------------------------------------------ *
   * Grounded step
   * ------------------------------------------------------------------ */
  _groundStep(h, s, n, props, incl, absIncl, input, locked, g, P) {
    const a = this._accel;
    const speed = s.speed;

    // Gravity component in the tangent plane — the whole reason the rider
    // moves. `a` currently holds (0,−g,0); remove its normal component.
    a.addScaledVector(n, g * n.y);

    const vLat = s.velocity.dot(this._right);
    const vFwd = s.velocity.dot(this._fwd);
    const absLat = Math.abs(vLat);

    // ---- Edge engagement ----------------------------------------------
    // A flat board has no edge in the snow at all. Engagement ramps in over
    // the first ~12° of inclination, which is why a rider can run flat and
    // straight without fighting the sim.
    const engage = smoothstep(0.03, 0.30, absIncl / MAX_EDGE);

    // ---- Sidecut steering ---------------------------------------------
    // R = R_sidecut · cos(edge): a board bent harder describes a tighter arc.
    // The board only steers if it is actually moving — a stationary board
    // pointed downhill does not yaw.
    if (!locked && engage > 0.001) {
      const radius = Math.max(SIDECUT_RADIUS * Math.cos(absIncl), MIN_TURN_RADIUS);
      const carveRate = (vFwd / radius) * engage;

      // Grip budget. The edge can hold `edgeGrip` g of lateral acceleration,
      // scaled by surface, by how much edge is actually buried, and by the
      // normal load (a rider unweighting mid-turn loses the edge).
      const load = clamp01(0.35 + 0.65 * n.y);
      const gripAccel = P.edgeGrip * g * props.grip * (0.25 + 0.75 * engage) * load;
      // What the arc demands: v²/R.
      const demand = Math.abs(vFwd) * Math.abs(carveRate);
      const ratio = demand / Math.max(gripAccel, 0.001);
      s.edgeLoad = clamp01(ratio);

      // Past the budget the tail washes out. The turn still happens, just
      // wider, and the difference is dumped into a skid that scrubs speed.
      const hold = ratio > 1 ? 1 / ratio : 1;
      s.sliding = ratio > 1.06 || absLat > 2.6;
      // The dug edge chooses the turn: positive inclination digs the +X rail
      // and arcs the board toward it (+yaw), negative digs the toe rail and
      // arcs the other way. `carveRate` alone is unsigned in edge, so without
      // this factor both edges would turn the same direction — with the body
      // leaning the wrong way half the time.
      s.heading += carveRate * hold * h * Math.sign(incl);

      // Lateral grip: the edge drives sideways velocity out of the board.
      // This is what makes a carve track instead of drift.
      const shed = Math.min(gripAccel * hold * h, absLat);
      if (absLat > 1e-5) s.velocity.addScaledVector(this._right, -Math.sign(vLat) * shed);

      // Skidding sheds energy — the snow being thrown sideways takes it.
      if (s.sliding) {
        const scrub = Math.min(absLat * 0.9, 14) * props.friction * 6.5;
        a.addScaledVector(this._tmp.copy(s.velocity).normalize(), -scrub);
      }
    } else {
      s.edgeLoad = 0;
      s.sliding = absLat > 2.2;
      // Even a flat base resists sideways travel a little.
      const shed = Math.min(g * 0.35 * props.grip * h, absLat);
      if (absLat > 1e-5) s.velocity.addScaledVector(this._right, -Math.sign(vLat) * shed);
    }

    // ---- Braking (heelside slide to a stop) ----------------------------
    if (input.boost && s.grounded && !locked && speed < 24) {
      // Power boost (playtest: "make flat ground more fun") - a firm push
      // along the direction of travel, capped well under terminal carve
      // speed so it aids flats without trivialising the steeps.
      if (speed > 0.5) a.addScaledVector(this._tmp.copy(s.velocity).normalize(), 9);
      else a.addScaledVector(this._tmp.set(Math.sin(s.heading), 0, Math.cos(s.heading)), 9);
    }
    if (!locked && input.brake > 0.01 && speed > 0.2) {
      const brakeAccel = input.brake * g * 1.35 * props.grip;
      a.addScaledVector(this._tmp.copy(s.velocity).normalize(), -brakeAccel);
      s.sliding = true;
      s.edgeLoad = Math.max(s.edgeLoad, input.brake);
    }

    // ---- Base friction -------------------------------------------------
    // μ·g·cosθ, opposing travel. Edge angle increases it: a board on edge
    // presents less base to the snow but drags a steel edge through it.
    if (speed > 0.05) {
      const mu = props.friction * (1 + 0.55 * engage);
      a.addScaledVector(this._tmp.copy(s.velocity).normalize(), -mu * g * n.y);
    }

    // ---- Powder displacement -------------------------------------------
    // Quadratic in speed, linear in how much board is buried. This is what
    // stops a rider from reaching terminal velocity in bottomless snow.
    const sinkFrac = s.sinkDepth / Math.max(P.powderDepth, 1e-3);
    if (sinkFrac > 0.01 && speed > 0.2) {
      const pow = props.drag * sinkFrac * speed * speed * 0.0085;
      a.addScaledVector(this._tmp.copy(s.velocity).normalize(), -pow);
    }

    // ---- Air drag ------------------------------------------------------
    this._applyAirDrag(a, s, input, P);

    // ---- Pop / ollie ---------------------------------------------------
    // Charge while crouched, release along the surface normal. Real pop is
    // the board's camber unloading, so it scales with how long the rider
    // has been loading it and with the flex the deck has left.
    if (!locked) {
      if (input.pop) {
        this._popCharge = clamp01(this._popCharge + h * 3.4);
        this._popLatch = true;
      } else if (this._popLatch) {
        const chargePop = 2.6 + 3.6 * this._popCharge;
        s.velocity.addScaledVector(n, chargePop);
        s.grounded = false;
        s.popped = true;
        s.position.addScaledVector(n, AIRBORNE_GAP * 1.3);
        this._popLatch = false;
        this._popCharge = 0;
      } else {
        this._popCharge = damp(this._popCharge, input.crouch * 0.4, 5, h);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Airborne step
   * ------------------------------------------------------------------ */
  _airStep(h, s, input, locked, P) {
    // Gravity is already in `_accel`. Add drag and let the rider steer the
    // rotation — in the air the board turns because the rider counter-rotates
    // against their own mass, so it is rate-controlled, not torque-controlled.
    this._applyAirDrag(this._accel, s, input, P);

    if (!locked) {
      const spin = input.spin !== 0 ? input.spin : input.steer * 0.55;
      const rate = spin * 6.6 * (0.55 + 0.45 * smoothstep(0.1, 0.9, s.airTime));
      s.heading += rate * h;
      s.airRotation += rate * h;
      s.roll = damp(s.roll, input.lean * 0.55, 5, h);
      // REAL flips (playtest: they were a 0.9 rad tilt, not a rotation):
      // ~400 deg/s of authority — a full back/frontflip inside 0.9 s,
      // which is what the kicker airs actually give (measured 0.9–1.7 s).
      // At 5.2 rad/s a one-second air came down 60° short, every time.
      // (The landed unwind lives in update()'s grounded branch.)
      s.flipRot = (s.flipRot || 0) + input.flip * 7.0 * h;
    }
    s.edgeLoad = 0;
    s.sliding = false;
    s.carving = false;
  }

  _applyAirDrag(a, s, input, P) {
    const speed = s.speed;
    if (speed < 0.2) return;
    const cd = lerp(P.dragUpright, P.dragTucked, input.tuck ? 1 : clamp01(input.crouch));
    const drag = cd * speed * speed / P.riderMass;
    a.addScaledVector(this._tmp.copy(s.velocity).normalize(), -drag);
  }

  /* ------------------------------------------------------------------ *
   * Landing
   * ------------------------------------------------------------------ */
  _land(s, n, contactY, g, h) {
    // Closing speed into the surface is what the legs have to absorb. Landing
    // on a slope that matches the trajectory is nearly free; landing flat off
    // the same jump is what breaks ankles.
    const closing = Math.max(-s.velocity.dot(n), 0);
    s.landingImpact = closing;

    // Slip angle at touchdown decides whether this is a landing or a catch.
    const fwdFlat = this._tmp.set(Math.sin(s.heading), 0, Math.cos(s.heading));
    const travel = this._tmp2.copy(s.velocity);
    travel.y = 0;
    const travelLen = travel.length();
    const slip = travelLen > 1.2 ? Math.abs(angleDelta(Math.atan2(travel.x, travel.z), Math.atan2(fwdFlat.x, fwdFlat.z))) : 0;

    // Rotation has to be finished. Coming down 40° into a 360 is a crash no
    // matter how gently you touch the snow.
    const spinResidue = Math.abs(((s.airRotation % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
    const spinClean = s.airTime < 0.25 || spinResidue > Math.PI - 0.55 || spinResidue < 0.55;

    // Same rule for flips: coming down 60°+ through a rotation about the
    // lateral axis is landing on your head or your heels, not your board.
    const flipResidue = Math.abs((((s.flipRot || 0) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
    const flipClean = s.airTime < 0.35 || flipResidue < 1.05;

    const tooHard = closing > CRASH_LANDING;
    const caughtEdge = slip > CRASH_SLIP_ANGLE && s.speed > 7;
    const spunOut = (!spinClean || !flipClean) && s.airTime > 0.45 && s.speed > 6;

    if (tooHard || caughtEdge || spunOut) {
      s.crashed = true;
      s.crashTime = 0;
      // A crash dumps most of the speed instantly and the rest to friction.
      s.velocity.multiplyScalar(0.34);
      this.ctx.tricks?.onLanded?.('crash');
    } else if (closing > HARD_LANDING) {
      // Absorbed but expensive: the legs compress and the landing costs speed.
      s.velocity.multiplyScalar(lerp(1.0, 0.86, smoothstep(HARD_LANDING, CRASH_LANDING, closing)));
      this.ctx.tricks?.onLanded?.('sketchy');
    } else if (s.airTime > 0.2) {
      this.ctx.tricks?.onLanded?.(closing < 4.2 ? 'perfect' : 'clean');
    }

    // main.js registers the particle system as ctx.fx; ARCHITECTURE.md calls
    // it ctx.particles. Accept either rather than silently emitting nothing.
    const fx = this.ctx.particles || this.ctx.fx;
    fx?.emitImpact?.(s.position, clamp01(closing / CRASH_LANDING));
    s.flex = clamp01(closing / HARD_LANDING);
  }
}
