/**
 * Named camera/state presets used by the screenshot harness and the in-game
 * photo mode. Each preset warms the world up for a given number of seconds,
 * then poses the camera. Presets must be deterministic.
 *
 * A preset is:
 *   { name, description, settle, prepare?(ctx), apply(ctx) }
 *
 * `prepare` runs *before* the settle and is where a shot chooses where the
 * rider starts and how fast: the harness resets the rider to the default spawn
 * before every shot, and the default spawn (`broadway-gate`) is a wind-scoured
 * 8° crest plateau, which is the right place to drop in but the wrong place to
 * photograph a carve. `apply` runs after the settle and poses the camera.
 *
 * Geometry notes that every preset depends on (from terrain.getStats() and
 * terrain.getSpawn()):
 *   +Z is the crest / headwall (~1860 m), −Z is the run-out (~1420 m), so the
 *   fall line runs toward −Z as ARCHITECTURE.md specifies. The bowl floor is
 *   roughly x ∈ [−400, +400], z ∈ [−200, +700]; both spurs rise to ~1700 m at
 *   |x| ≈ 650. Terrain features worth pointing a lens at: the rib-and-couloir
 *   headwall on the crest arc around z ≈ +700…+900, the three bluff bands at
 *   z ≈ −140…−220 (x ∈ [−560,−300], [−140,−20], [+300,+520]), the soho-spur
 *   down the −X rim and captains-shoulder down the +X rim.
 *
 * Where the sun is, on the other hand, is *not* a geometry note and must never
 * be written down here. The solar vector is a function of
 * CONFIG.world.timeOfDay *and* of the compass mapping sky.js applies, and an
 * earlier revision of these presets was composed around a "low sun almost due
 * −X" that the sky has never actually produced (TERRAIN_BRIEF §2.12 puts the
 * 09:40 sun at (+0.02, 0.18, +0.98) — behind the headwall — and the
 * recommended 15:00 sun at (+0.93, 0.29, +0.22)). Any preset whose whole point
 * is a light-to-lens relationship therefore reads `ctx.sky.sunDirection` in
 * apply() and solves for its own camera azimuth — see `sunComposedLook()`.
 *
 * All camera heights are expressed relative to the ground under them, because
 * the basin spans 450 m of elevation and an absolute Y is meaningless here.
 */

import * as THREE from 'three';

const v = (x, y, z) => new THREE.Vector3(x, y, z);

/** Ground height at (x,z), or 0 when the terrain has not built yet. */
const gh = (ctx, x, z) => (ctx.terrain ? ctx.terrain.getHeight(x, z) : 0);

/**
 * Hand the camera to the preset.
 *
 * `shot()` renders one frame *after* `apply()`, and that frame is a full tick —
 * so every system updates, including the chase camera, which happily re-aims
 * the lens at the rider and undoes the pose. `'free'` is the contract's opt-out
 * (ARCHITECTURE.md, ChaseCamera.setMode) and every manual preset must take it
 * in `prepare`, before the settle, so the chase spring is not fighting the pose
 * on the way in either.
 */
const freeCam = (ctx) => ctx.player?.camera?.setMode?.('free');

/** Hand the camera back to the game for the gameplay presets. */
function gameCam(ctx, mode) {
  const c = ctx.player?.camera;
  if (!c) return;
  c.setMode?.(mode);
  c.snapToTarget?.();
}

/** Pose the camera between two absolute world points. */
function lookAbs(ctx, from, to, fov) {
  const cam = ctx.camera;
  cam.fov = fov;
  cam.position.copy(from);
  cam.lookAt(to.x, to.y, to.z);
  cam.updateProjectionMatrix();
}

/**
 * Point the camera from one ground-relative station to another.
 * @param {object} ctx
 * @param {number[]} from [x, z, metresAboveGround]
 * @param {number[]} to   [x, z, metresAboveGround]
 * @param {number} fov
 */
function look(ctx, from, to, fov) {
  lookAbs(
    ctx,
    v(from[0], gh(ctx, from[0], from[1]) + from[2], from[1]),
    v(to[0], gh(ctx, to[0], to[1]) + to[2], to[1]),
    fov,
  );
}

/* ------------------------------------------------------------------ *
 * Sun-relative composition
 * ------------------------------------------------------------------ */

const DEG = Math.PI / 180;
/** Half-width of the playable box, less a margin: past this the camera is off-map. */
const STATION_LIMIT = 980;

/** Horizontal unit vector for a plan azimuth in degrees, measured from +Z toward +X. */
const dirFromAzimuth = (deg) => v(Math.sin(deg * DEG), 0, Math.cos(deg * DEG));

/** Plan azimuth in degrees of a horizontal vector, same convention. */
const azimuthOf = (x, z) => Math.atan2(x, z) / DEG;

/**
 * The sun as the sky is *actually* solving it right now, or null before the
 * sky exists. Presets must never substitute a hardcoded vector for this: a
 * wrong assumption is exactly the defect this indirection exists to prevent.
 */
function sunVector(ctx) {
  const s = ctx.sky?.sunDirection;
  if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) return null;
  if (s.lengthSq() < 1e-6) return null;
  return s.clone().normalize();
}

/**
 * Build the camera/aim pair for one candidate look azimuth.
 *
 * The composition is anchored on `pivot` and rotates about it: the camera sits
 * `back` metres behind the pivot along the look direction, and the aim point
 * sits `fwd` metres in front of it. `fwd = 0` therefore means "orbit the
 * subject", and `back = 0` means "stand still and pan", which is what the
 * into-the-sun frame wants.
 */
function station(ctx, o, azDeg) {
  const d = dirFromAzimuth(azDeg);
  const cx = o.pivot[0] - d.x * (o.back || 0);
  const cz = o.pivot[1] - d.z * (o.back || 0);
  const from = v(cx, gh(ctx, cx, cz) + o.camHeight, cz);
  let to;
  if (o.pitchDeg != null) {
    // Aim by pitch, not by ground: the backlight frame is composed on the
    // horizon and the far skyline, which is beyond the heightfield entirely.
    const c = Math.cos(o.pitchDeg * DEG);
    to = v(cx + d.x * o.fwd * c, from.y + o.fwd * Math.sin(o.pitchDeg * DEG), cz + d.z * o.fwd * c);
  } else {
    const ax = o.pivot[0] + d.x * (o.fwd || 0);
    const az = o.pivot[1] + d.z * (o.fwd || 0);
    to = v(ax, gh(ctx, ax, az) + (o.aimHeight || 0), az);
  }
  return { from, to };
}

/** Fraction of the sight line that the ground pokes through, 0…1. */
function blockedFraction(ctx, from, to) {
  const N = 14;
  let blocked = 0;
  for (let i = 1; i <= N; i++) {
    const t = i / (N + 1);
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    const y = from.y + (to.y - from.y) * t;
    if (gh(ctx, x, z) > y + 2) blocked++;
  }
  return blocked / N;
}

/**
 * Pose a wide shot against the sun the sky is running, rather than against a
 * sun someone wrote into a comment.
 *
 * `wantDot` is the target for `dot(normalize(aim − camera), sunDirection)`:
 *   −0.3  → the sun is ~107° off the lens axis, over one shoulder. This is the
 *           raking cross-light that turns ribs, spines, gullies and sastrugi
 *           into modelled form instead of a flat white field.
 *   +0.85 → the sun is ~32° off axis, in frame and above the skyline: aureole,
 *           veiling glare, and the full depth of the aerial perspective.
 *
 * The solve is a scan over look azimuth, because the camera height, the aim
 * height and the sight line all depend on the terrain under the candidate and
 * there is no closed form. It is deterministic (fixed step, deterministic
 * tie-break) and costs a few hundred `getHeight()` taps, once, in `apply()`.
 *
 * `spanDeg` bounds the swing and `tolerance` bounds the ambition: at 09:40 the
 * sun is behind the headwall and *no* station in this basin gets cross-light,
 * so rather than saturate at the edge of the arc — an arbitrary vantage picked
 * for a light angle it never reaches — the scan gives up and returns the
 * authored composition. The frame is then honestly backlit, which is a
 * `CONFIG.world.timeOfDay` problem and not something a camera can solve.
 */
function sunComposedLook(ctx, o) {
  const sun = sunVector(ctx);
  // `azimuthDeg` is both the authored composition and the no-sky fallback, so
  // every caller must supply one even when it composes off the sun.
  const centre = (o.sunOffsetDeg != null && sun)
    ? azimuthOf(sun.x, sun.z) + o.sunOffsetDeg
    : (o.azimuthDeg ?? 0);

  let bestAz = centre;
  if (sun) {
    const span = o.spanDeg ?? 40;
    let bestScore = Infinity;
    let bestErr = Infinity;
    for (let k = -span * 2; k <= span * 2; k++) {
      const az = centre + k * 0.5;
      const { from, to } = station(ctx, o, az);
      const view = to.clone().sub(from).normalize();
      const err = Math.abs(view.dot(sun) - o.wantDot);
      let score = err;
      // Stations off the playable box see the backdrop shell edge-on.
      const off = Math.max(0, Math.abs(from.x) - STATION_LIMIT)
                + Math.max(0, Math.abs(from.z) - STATION_LIMIT);
      score += off * 0.01;
      // Do not solve the light by hiding the subject behind a rollover.
      if (o.clearView) score += 0.8 * blockedFraction(ctx, from, to);
      // Deterministic tie-break: nearest to the authored composition wins.
      score += Math.abs(k) * 5e-5;
      if (score < bestScore) { bestScore = score; bestAz = az; bestErr = err; }
    }
    if (bestErr > (o.tolerance ?? 0.2)) bestAz = centre;
  }

  const { from, to } = station(ctx, o, bestAz);
  lookAbs(ctx, from, to, o.fov);
  return bestAz;
}

/**
 * Drop the rider at a named terrain spawn with an initial speed down the fall
 * line, so a short settle produces a rider that is actually riding.
 */
function dropIn(ctx, spawnName, speed = 0) {
  const t = ctx.terrain;
  const p = ctx.physics;
  if (!t || !p) return null;
  const s = t.getSpawn(spawnName);
  p.reset(s.position, s.heading);
  if (speed && p.state) {
    // physics.js exposes `speed` as the scalar along the heading; setting both
    // it and the velocity vector works whether the implementation integrates
    // the scalar or the vector.
    const fwd = v(Math.sin(s.heading), 0, Math.cos(s.heading));
    p.state.speed = speed;
    p.state.velocity.copy(fwd).multiplyScalar(speed);
  }
  return s;
}

/** Neutral controls, so `ride()` always publishes a complete input struct. */
const NEUTRAL_INPUT = {
  steer: 0, lean: 0, crouch: 0, pop: false, spin: 0, flip: 0,
  grab: null, tuck: false, brake: 0, reset: false,
};

/**
 * Take the controls for a preset.
 *
 * A rider with no input travels in a straight line, and a straight line throws
 * no snow: that is why `close-spray` photographed a rider standing still in a
 * white field. Spray is a *consequence* in this build — particles.js reads
 * `state.sprayIntensity`, which physics derives from lateral speed, edge load
 * and sink — so the only way to photograph a spray wall is to actually make
 * the rider carve.
 *
 * Disabling `ctx.input` matters: the Input system publishes every frame, and
 * a live keyboard reader would stamp a zeroed struct over this one tick later.
 */
function ride(ctx, input) {
  if (ctx.input) ctx.input.enabled = false;
  ctx.physics?.applyInput?.({ ...NEUTRAL_INPUT, ...input });
}

/**
 * Put the rider in the air, for the presets whose subject is the trick rather
 * than the take-off.
 *
 * This is set in `apply()` rather than flown to during the settle, because the
 * settle has no per-tick hook to release a pop at the right instant. The state
 * it writes is one the physics genuinely produces — a pop off a rollover — so
 * the rider, camera and FX all pose from it exactly as they would in play.
 */
function launch(ctx, up = 5.4, airTime = 0.62, grab = 'indy') {
  const st = ctx.physics?.state;
  if (!st) return;
  st.velocity.y = up;
  st.position.y += up * airTime * 0.5;
  st.grounded = false;
  st.airTime = airTime;
  st.airHeight = up * airTime * 0.5;
  st.speed = st.velocity.length();
  ride(ctx, { grab, crouch: 0.55 });
  if (ctx.tricks) {
    ctx.tricks.current = {
      name: null, rotation: 0, flip: 0, grab, grabTime: airTime,
      grabSwitches: 0, score: 0, multiplier: 1, airTime, height: st.airHeight, popped: true,
    };
  }
}

export const SHOTS = [
  {
    name: 'hero-basin',
    description: 'Wide establishing shot of the Soho Basin headwall at low sun.',
    settle: 1.0,
    prepare(ctx) { freeCam(ctx); },
    apply(ctx) {
      // Orbit the headwall foot at ~1 km and pick the station where the sun
      // rakes across the ribs and couloirs instead of sitting behind them.
      // Under the 15:00 sun that lands within a few degrees of the flank
      // station this shot has always used (≈ +480, −180); under any other sun
      // it moves, because the ribs only exist in the frame as shadow.
      sunComposedLook(ctx, {
        pivot: [-60, 700], back: 1030, fwd: 0,
        camHeight: 100, aimHeight: 10,
        fov: 42, wantDot: -0.3,
        azimuthDeg: -31.5, spanDeg: 40, clearView: true,
      });
    },
  },
  {
    name: 'chase-carve',
    description: 'Gameplay chase camera mid-carve — the money shot.',
    settle: 5.0,
    prepare(ctx) {
      // `bowl-entry` is the 25° powder pitch below the headwall; the default
      // crest-plateau spawn is 8° and the rider barely moves in five seconds.
      dropIn(ctx, 'bowl-entry', 14);
      ride(ctx, { steer: 0 });
      // The mode has to be set before the settle so the follow spring is
      // already tracking the rider by the time the frame is taken.
      gameCam(ctx, 'chase');
    },
    tick(ctx, t, dt, total) {
      const carving = t > total - 0.8;
      ride(ctx, { steer: carving ? 0.5 : 0, crouch: carving ? 0.35 : 0.1 });
    },
    apply() {},
  },
  {
    name: 'close-spray',
    description: 'Low, close on the board throwing a spray wall.',
    settle: 6.0,
    prepare(ctx) {
      dropIn(ctx, 'bowl-entry', 16);
      ride(ctx, { steer: 0 });
      freeCam(ctx);
    },
    // Straight for five seconds to build speed, then roll hard onto the toe
    // edge for the last half second. Spray is a consequence of lateral speed
    // and edge load, so it needs a real carve — but a held edge describes a
    // circle, and half a second is all it takes to throw a wall of snow
    // without the rider spiralling away from the composition.
    tick(ctx, t, dt, total) {
      const carving = t > total - 0.55;
      ride(ctx, { steer: carving ? 0.72 : 0, crouch: carving ? 0.5 : 0.1 });
    },
    apply(ctx) {
      const st = ctx.physics?.state;
      const cam = ctx.camera;
      if (!st) return;
      cam.fov = 38;
      // Station the camera in the *board's* frame, not the world's. A fixed
      // world-space side offset walks the lens around the rider as they turn
      // — and since this preset exists to photograph a turn, that reliably
      // parked it behind a snow lip with the rider out of frame.
      //
      // Sit outside the arc (the side the snow is thrown toward), low and
      // slightly ahead of square, so the spray wall crosses the lens rather
      // than being hidden behind the rider.
      const fwd = v(Math.sin(st.heading), 0, Math.cos(st.heading));
      const right = v(fwd.z, 0, -fwd.x);
      const side = st.lateralSpeed >= 0 ? -1 : 1;
      cam.position.copy(st.position)
        .addScaledVector(fwd, -2.6)
        .addScaledVector(right, 2.4 * side)
        .add(v(0, 1.15, 0));
      // Never let the camera end up inside the hill on a steep pitch.
      const floor = gh(ctx, cam.position.x, cam.position.z) + 0.6;
      if (cam.position.y < floor) cam.position.y = floor;
      cam.lookAt(st.position.x, st.position.y + 0.7, st.position.z);
      cam.updateProjectionMatrix();
    },
  },
  {
    name: 'air-trick',
    description: 'Rider mid-air off a natural rollover, backlit.',
    settle: 7.0,
    prepare(ctx) { dropIn(ctx, 'bowl-entry', 18); gameCam(ctx, 'cinematic'); },
    apply(ctx) { launch(ctx, 5.8, 0.66, 'melon'); },
  },
  {
    name: 'snow-detail',
    description: 'Macro on untracked snow — tests sparkle, sastrugi, SSS.',
    settle: 0.5,
    prepare(ctx) { freeCam(ctx); },
    apply(ctx) {
      // Wind-scoured crest snow, which is where the sastrugi actually are: the
      // deep-powder pitches below the headwall carry none. `broadway-gate` sits
      // on windpack at 8°, gentle enough that a shallow downhill look still
      // meets the ground instead of grazing off into a landscape vista.
      const t = ctx.terrain;
      const p = t ? t.getSpawn('broadway-gate').position : v(0, 0, 0);
      const gx = p.x + 6, gz = p.z - 10;
      const cam = ctx.camera;
      cam.fov = 30;
      // ~4.5 m of ground across the frame: three sastrugi wavelengths, a whole
      // drift lobe, and still close enough for the crystal glints to survive
      // their 25→40 m distance cutoff.
      cam.position.set(gx, gh(ctx, gx, gz) + 2.05, gz);
      cam.lookAt(gx - 1.2, gh(ctx, gx - 1.2, gz - 5.2) + 0.03, gz - 5.2);
      cam.updateProjectionMatrix();
    },
  },
  {
    name: 'ridge-backlight',
    description: 'Looking into the sun over the ridge — atmosphere, glare, aerial perspective.',
    settle: 1.0,
    prepare(ctx) { freeCam(ctx); },
    apply(ctx) {
      // Stand low on the −X flank and pan until the sun is ~32° off axis: it
      // clears the skyline (which is 4–7° up from here across the whole width
      // of the bowl) and sits high in frame with 1.5 km of terrain stacking up
      // underneath it. `back: 0` keeps the station put and pans in place —
      // there is exactly one low, unobstructed vantage here and orbiting it
      // would only walk the camera into the spur.
      sunComposedLook(ctx, {
        pivot: [-560, 20], back: 0, fwd: 1400,
        camHeight: 14, pitchDeg: 4.5,
        fov: 50, wantDot: 0.85,
        sunOffsetDeg: 30, azimuthDeg: 95, spanDeg: 40, clearView: false,
      });
    },
  },
  {
    name: 'rider-portrait',
    description: 'Three-quarter on the rider — tests character model + materials.',
    settle: 4.0,
    prepare(ctx) { dropIn(ctx, 'bowl-entry', 10); ride(ctx, { steer: 0 }); freeCam(ctx); },
    tick(ctx, t, dt, total) { ride(ctx, { steer: t > total - 0.6 ? 0.34 : 0 }); },
    apply(ctx) {
      const st = ctx.physics?.state;
      const cam = ctx.camera;
      if (!st) return;
      cam.fov = 34;
      const fwd = v(Math.sin(st.heading), 0, Math.cos(st.heading));
      const right = v(fwd.z, 0, -fwd.x);
      cam.position.copy(st.position)
        .add(fwd.clone().multiplyScalar(3.1))
        .add(right.multiplyScalar(2.6))
        .add(v(0, 1.15, 0));
      const floor = gh(ctx, cam.position.x, cam.position.z) + 0.4;
      if (cam.position.y < floor) cam.position.y = floor;
      cam.lookAt(st.position.x, st.position.y + 0.95, st.position.z);
      cam.updateProjectionMatrix();
    },
  },
  {
    name: 'valley-vista',
    description: 'Down-valley toward the Cardrona basin and distant ranges.',
    settle: 1.0,
    prepare(ctx) { freeCam(ctx); },
    apply(ctx) {
      // From just under the headwall, straight down the fall line: the whole
      // 450 m of the basin, the run-out, and the Otago skyline beyond it.
      look(ctx, [120, 700, 30], [40, -900, -30], 55);
    },
  },
  {
    name: 'west-spur',
    description: 'Up at the west bluff band under the Soho spur — schist against snow.',
    settle: 1.0,
    prepare(ctx) { freeCam(ctx); },
    apply(ctx) {
      // The schist is in the bluff band at x ∈ [−560, −300], z ≈ −200, at the
      // foot of the soho-spur — not on the spur crest, which is snow. The old
      // station stood *on* the spur and aimed 400 m up-slope of the rock, so
      // the frame contained no bluff at all. Orbit the band at 320 m (a 9–22 m
      // face reads at that distance; at 620 m it is a dark line) and take the
      // station where the light rakes along it: the wobble in the band's plan
      // line means roughly half the faces catch a cross-sun, which is the
      // difference between Otago schist and a grey hole in the snow.
      sunComposedLook(ctx, {
        pivot: [-470, -190], back: 320, fwd: 0,
        camHeight: 12, aimHeight: 12,
        fov: 40, wantDot: -0.3,
        azimuthDeg: -34, spanDeg: 40, clearView: true,
      });
    },
  },
];

export const SHOT_NAMES = SHOTS.map((s) => s.name);
export const getShot = (name) => SHOTS.find((s) => s.name === name);
