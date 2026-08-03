/**
 * Soho Shred — bootstrap.
 *
 * Constructs the engine, builds every system in dependency order, and exposes
 * the deterministic capture harness on `window.__SOHO`.
 */

import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { CONFIG, applyOverrides } from './core/config.js';
import { SHOTS, SHOT_NAMES, getShot } from './core/shots.js';

import { Terrain } from './world/terrain.js';
import { Sky } from './world/sky.js';
import { Props } from './world/props.js';
import { BoardPhysics } from './player/physics.js';
import { Rider } from './player/rider.js';
import { Input } from './player/controls.js';
import { ChaseCamera } from './player/camera.js';
import { TrickSystem } from './player/tricks.js';
import { ParticleFX } from './fx/particles.js';
import { TrailSystem } from './fx/trails.js';
import { createComposer, updatePost } from './fx/postprocess.js';
import { HUD } from './ui/hud.js';
import { AudioSystem } from './audio/audio.js';

/** Read boot overrides from the query string, e.g. ?seed=foo&tod=15.5 */
function queryOverrides() {
  const q = new URLSearchParams(location.search);
  const o = {};
  if (q.has('seed')) o.seed = q.get('seed');
  if (q.has('tod')) o.world = { ...(o.world || {}), timeOfDay: parseFloat(q.get('tod')) };
  if (q.has('weather')) o.world = { ...(o.world || {}), weather: q.get('weather') };
  if (q.has('nopost')) o.post = { bloom: { enabled: false }, dof: { enabled: false }, motionBlur: { enabled: false }, ssao: { enabled: false } };
  if (q.has('exposure')) o.render = { ...(o.render || {}), exposure: parseFloat(q.get('exposure')) };
  // Escape hatch for tuning passes: ?cfg={"sky":{"aerialStrength":0.5}} is
  // deep-merged into CONFIG before any system is constructed, so it reaches
  // values that are only read at build time.
  if (q.has('cfg')) {
    try {
      const extra = JSON.parse(q.get('cfg'));
      if (extra && typeof extra === 'object') applyOverrides(extra);
    } catch (e) {
      console.warn('[soho] ignoring malformed ?cfg=', e.message);
    }
  }
  return o;
}

async function boot() {
  applyOverrides(queryOverrides());

  const container = document.getElementById('app');
  const engine = new Engine(container);
  const ctx = engine.ctx;

  // --- Order matters: each system may depend on the ones above it. ---------
  const sky = new Sky(ctx);
  ctx.sky = sky;
  engine.add(sky);

  const terrain = new Terrain(ctx);
  ctx.terrain = terrain;
  engine.add(terrain);

  const props = new Props(ctx);
  engine.add(props);

  const trails = new TrailSystem(ctx);
  ctx.trails = trails;
  engine.add(trails);

  const physics = new BoardPhysics(ctx);
  ctx.physics = physics;
  engine.add(physics);

  const input = new Input(ctx);
  ctx.input = input;
  engine.add(input);

  const rider = new Rider(ctx);
  ctx.rider = rider;
  engine.add(rider);

  const tricks = new TrickSystem(ctx);
  ctx.tricks = tricks;
  engine.add(tricks);

  const chaseCam = new ChaseCamera(ctx);
  ctx.chaseCamera = chaseCam;
  ctx.player = { camera: chaseCam, rider, physics, tricks };
  engine.add(chaseCam);

  const fx = new ParticleFX(ctx);
  ctx.fx = fx;
  engine.add(fx);

  const hud = new HUD(ctx);
  ctx.hud = hud;
  engine.add(hud);

  const audio = new AudioSystem(ctx);
  ctx.audio = audio;
  engine.add(audio);

  // --- Build phase ---------------------------------------------------------
  await sky.build?.();
  await terrain.build?.();
  await props.build?.();
  await trails.build?.();
  await rider.build?.();
  await fx.build?.();
  await hud.build?.();
  await audio.build?.();

  // Place the rider on the mountain now that terrain exists.
  const spawn = terrain.getSpawn();
  physics.reset(spawn.position, spawn.heading);
  chaseCam.snapToTarget?.();

  // Post-processing last — it needs the final scene + camera.
  createComposer(ctx);

  engine._onResize();
  engine.start();

  // --- Capture harness -----------------------------------------------------
  let readyResolve;
  const readyPromise = new Promise((r) => (readyResolve = r));

  window.__SOHO = {
    THREE,
    engine,
    ctx,
    ready: readyPromise,
    isReady: false,
    presets: SHOT_NAMES,

    setSize(w, h) { engine.setSize(w, h); },

    setManual(on) { engine.manualTime = !!on; },

    step(dt = 1 / 60) { engine.tick(dt); },

    /**
     * Advance `seconds` of simulation in fixed increments.
     *
     * Only the final frames are actually drawn. On the SwiftShader software
     * rasteriser a composed frame costs ~1.5 s, so rendering all ~450 warm-up
     * frames of a 7.5 s settle would take nine minutes per shot for imagery
     * that is thrown away. Simulation still runs at full fidelity every step,
     * so the resulting state — and therefore the captured frame — is identical.
     *
     * The last two frames *are* drawn: the motion-blur pass reprojects against
     * the previous frame, so it needs one real rendered predecessor or every
     * shot would be treated as a hard cut.
     */
    settle(seconds, dt = 1 / 60, renderAll = false) {
      const n = Math.max(1, Math.round(seconds / dt));
      for (let i = 0; i < n; i++) engine.tick(dt, renderAll || i >= n - 2);
    },

    /**
     * Pose the world for a named shot. Returns the preset metadata.
     * The caller is responsible for calling settle() first if it wants motion.
     */
    shot(name) {
      const preset = getShot(name);
      if (!preset) throw new Error(`unknown shot preset: ${name}`);
      engine.manualTime = true;
      // `prepare` chooses the rider's start state; it has to run before the
      // settle, because the settle is what turns that state into a run.
      preset.prepare?.(ctx);

      // A preset may script the controls across the settle via `tick`.
      //
      // It needs to, because a *constant* input is not a neutral choice: hold
      // a fixed steering angle and the sidecut carves a circle, so at 16 m/s
      // on a 6 m radius a six-second settle spins the rider through two and a
      // half full turns and leaves them pointing in an arbitrary direction.
      // Presets that want a carve therefore run straight to build speed and
      // roll onto the edge only in the last fraction of a second, which is
      // also exactly how a rider actually initiates one.
      const secs = preset.settle ?? 0;
      if (typeof preset.tick === 'function') {
        const dt = 1 / 60;
        const n = Math.max(1, Math.round(secs / dt));
        for (let i = 0; i < n; i++) {
          preset.tick(ctx, i * dt, dt, secs);
          // Same rule as settle(): only the last two frames are drawn, because
          // motion blur reprojects against its predecessor.
          engine.tick(dt, i >= n - 2);
        }
      } else {
        this.settle(secs);
      }
      preset.apply(ctx);

      // Per-shot exposure compensation. A cinematographer meters each setup
      // rather than shooting a whole reel at one stop, and two of these
      // presets are framed almost entirely on sunlit snow with no sky and no
      // shadow in frame — their histogram *is* the snow, so no global stop can
      // place them. CONFIG.render.shotExposure documents the values; this is
      // the hook it is documented against.
      //
      // It has to be applied here rather than in engine.js because it is a
      // property of the setup, not of the renderer, and it must be restored
      // afterwards so an interactive session is never left mis-metered.
      const base = engine.renderer.toneMappingExposure;
      const comp = CONFIG.render.shotExposure?.[preset.name];
      if (comp) engine.renderer.toneMappingExposure = CONFIG.render.exposure * comp;

      // Render TWO frames at the new camera pose. `apply` teleports the
      // camera, and the motion-blur pass reprojects against the previous
      // frame's matrices — one rendered frame after a teleport therefore
      // carries a full-frame velocity smear. The first tick establishes the
      // new pose in the history; the second is the clean frame that gets
      // captured. Every still in rounds 1–3 was shipped with that smear,
      // which is where the "milky foreground" and the smudged mid-field
      // partly came from.
      engine.tick(1 / 60);
      engine.tick(1 / 60);

      engine.renderer.toneMappingExposure = base;
      return { name: preset.name, description: preset.description };
    },

    setConfig(overrides) { applyOverrides(overrides); },

    stats() {
      const i = engine.renderer.info;
      return {
        drawCalls: i.render.calls,
        triangles: i.render.triangles,
        programs: i.programs?.length ?? 0,
        textures: i.memory.textures,
        geometries: i.memory.geometries,
        frame: engine.frame,
      };
    },
  };

  // One warm frame so shaders compile before anyone screenshots.
  engine.tick(1 / 60);
  window.__SOHO.isReady = true;
  readyResolve();
  document.documentElement.setAttribute('data-soho-ready', '1');
}

boot().catch((err) => {
  console.error('[soho] boot failed', err);
  document.documentElement.setAttribute('data-soho-error', String(err && err.stack || err));
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:0;padding:24px;color:#ff6b6b;background:#0b0e14;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;z-index:9999;overflow:auto';
  pre.textContent = 'Soho Shred failed to boot:\n\n' + (err && err.stack || err);
  document.body.appendChild(pre);
});
