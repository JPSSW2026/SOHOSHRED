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
 *   |x| ≈ 650. The sun sits low (10.5°) almost due −X, i.e. abeam the fall
 *   line, so a camera looking along ±Z gets cross-light and a camera looking
 *   toward −X is shooting into it.
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

/**
 * Point the camera from one ground-relative station to another.
 * @param {object} ctx
 * @param {number[]} from [x, z, metresAboveGround]
 * @param {number[]} to   [x, z, metresAboveGround]
 * @param {number} fov
 */
function look(ctx, from, to, fov) {
  const cam = ctx.camera;
  cam.fov = fov;
  cam.position.set(from[0], gh(ctx, from[0], from[1]) + from[2], from[1]);
  cam.lookAt(to[0], gh(ctx, to[0], to[1]) + to[2], to[1]);
  cam.updateProjectionMatrix();
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

export const SHOTS = [
  {
    name: 'hero-basin',
    description: 'Wide establishing shot of the Soho Basin headwall at low sun.',
    settle: 1.0,
    prepare(ctx) { freeCam(ctx); },
    apply(ctx) {
      // Stand out on the east flank of the bowl, mid-height, and look up-basin
      // at the headwall. The low −X sun rakes across the ribs and couloirs from
      // camera-left, which is what separates them from a flat white field.
      look(ctx, [480, -180, 100], [-60, 700, 10], 42);
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
      // The mode has to be set before the settle so the follow spring is
      // already tracking the rider by the time the frame is taken.
      gameCam(ctx, 'chase');
    },
    apply() {},
  },
  {
    name: 'close-spray',
    description: 'Low, close on the board throwing a spray wall.',
    settle: 6.0,
    prepare(ctx) { dropIn(ctx, 'bowl-entry', 16); freeCam(ctx); },
    apply(ctx) {
      const st = ctx.physics?.state;
      const cam = ctx.camera;
      if (!st) return;
      cam.fov = 38;
      const back = v(Math.sin(st.heading), 0, Math.cos(st.heading)).multiplyScalar(-4.2);
      cam.position.copy(st.position).add(back).add(v(2.2, 0.75, 0));
      // Never let the camera end up inside the hill on a steep pitch.
      const floor = gh(ctx, cam.position.x, cam.position.z) + 0.5;
      if (cam.position.y < floor) cam.position.y = floor;
      cam.lookAt(st.position.x, st.position.y + 0.55, st.position.z);
      cam.updateProjectionMatrix();
    },
  },
  {
    name: 'air-trick',
    description: 'Rider mid-air off a natural rollover, backlit.',
    settle: 7.0,
    prepare(ctx) { dropIn(ctx, 'bowl-entry', 18); gameCam(ctx, 'cinematic'); },
    apply() {},
  },
  {
    name: 'snow-detail',
    description: 'Macro on untracked snow — tests sparkle, sastrugi, SSS.',
    settle: 0.5,
    prepare(ctx) { freeCam(ctx); },
    apply(ctx) {
      // Untracked powder on the bowl-entry pitch rather than the scoured crest:
      // the crest is windpack and shows none of the material's powder response.
      const t = ctx.terrain;
      const p = t ? t.getSpawn('bowl-entry').position : v(0, 0, 0);
      const gx = p.x + 14, gz = p.z - 22;
      const gy = gh(ctx, gx, gz);
      const cam = ctx.camera;
      cam.fov = 28;
      // Look ACROSS the fall line and steeply down. Aiming down-slope on a 25°
      // pitch from 1.1 m up means the ray never catches the ground — the shot
      // silently becomes a landscape vista instead of a macro. Traversing the
      // slope keeps the ground at a constant range under the lens.
      cam.position.set(gx + 1.9, gy + 1.05, gz);
      cam.lookAt(gx - 0.6, gh(ctx, gx - 0.6, gz - 0.5) + 0.02, gz - 0.5);
      cam.updateProjectionMatrix();
    },
  },
  {
    name: 'ridge-backlight',
    description: 'Looking into the sun over the ridge — atmosphere, glare, aerial perspective.',
    settle: 1.0,
    prepare(ctx) { freeCam(ctx); },
    apply(ctx) {
      // The sun is low and nearly due −X, so shooting west across the bowl at
      // the west rim puts it just above the skyline: aureole, veiling glare and
      // the full depth of the aerial perspective in one frame.
      look(ctx, [520, 240, 25], [-900, 300, 60], 52);
    },
  },
  {
    name: 'rider-portrait',
    description: 'Three-quarter on the rider — tests character model + materials.',
    settle: 4.0,
    prepare(ctx) { dropIn(ctx, 'bowl-entry', 10); freeCam(ctx); },
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
    description: 'Across the bowl from the west spur — schist bluff bands against snow.',
    settle: 1.0,
    prepare(ctx) { freeCam(ctx); },
    apply(ctx) {
      // Sun behind the camera shoulder: this is the frame where the rock reads
      // as Otago schist rather than as a grey hole in the snow.
      look(ctx, [-640, 380, 60], [200, 180, -40], 48);
    },
  },
];

export const SHOT_NAMES = SHOTS.map((s) => s.name);
export const getShot = (name) => SHOTS.find((s) => s.name === name);
