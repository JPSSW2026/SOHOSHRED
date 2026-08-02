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

    /** Advance `seconds` of simulation in fixed increments and render each. */
    settle(seconds, dt = 1 / 60) {
      const n = Math.max(1, Math.round(seconds / dt));
      for (let i = 0; i < n; i++) engine.tick(dt);
    },

    /**
     * Pose the world for a named shot. Returns the preset metadata.
     * The caller is responsible for calling settle() first if it wants motion.
     */
    shot(name) {
      const preset = getShot(name);
      if (!preset) throw new Error(`unknown shot preset: ${name}`);
      engine.manualTime = true;
      this.settle(preset.settle ?? 0);
      preset.apply(ctx);
      // Render one more frame so the new camera pose is what gets captured.
      engine.tick(1 / 60);
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
