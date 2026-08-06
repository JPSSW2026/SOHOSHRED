/**
 * The physics and pose state AT THE MOMENT A SHOT IS CAPTURED.
 *
 * Two earlier probes measured a bare `engine.tick` loop and were worthless for
 * this: with no steering input the rider runs dead straight, so roll, edgeLoad
 * and every lean term read exactly 0, which says nothing about a frame the
 * shot preset composed by carving. `S.shot(name)` is what shoot.mjs calls, so
 * calling it and sampling immediately after reproduces the captured frame.
 *
 * Pose is resolved into the BOARD's frame: +X heel edge, -X toe edge, +Z nose.
 * Lean is reported on BOTH axes, because "back seat" on a snowboard is weight
 * toward the TAIL (Z) while heel/toe lean is across the deck (X), and an
 * earlier probe measured only X and reported a flat 0.
 *
 *   node tools/shot-state.mjs [shot ...]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const shots = process.argv.slice(2);
if (!shots.length) shots.push('rider-portrait', 'close-spray', 'chase-carve');

const server = await createServer({ root: process.cwd(), server: { port: 6399 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerr]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:6399/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });
await page.evaluate(() => window.__SOHO_WORLD_MODELS);

const out = await page.evaluate(async (names) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const S = window.__SOHO;
  const rider = S.ctx.player.rider;
  const board = rider.boardObject;
  const B = rider.bones;
  const fx = S.ctx.fx;
  const HALF_W = 0.1396;

  const res = {};
  for (const name of names) {
    const r = S.ctx.terrain?.getSpawn?.();
    if (r) S.ctx.physics?.reset?.(r.position, r.heading);
    S.shot(name);

    const s = S.ctx.player.state || S.ctx.player.s || S.ctx.physics?.state || {};
    board.updateMatrixWorld(true);
    rider.object3D.updateWorldMatrix(false, true);
    const inv = new THREE.Matrix4().copy(board.matrixWorld).invert();
    const p = (b) => new THREE.Vector3().setFromMatrixPosition(B[b].matrixWorld).applyMatrix4(inv);
    const hips = p('hips'), neck = p('neck'), head = p('head');
    const torso = neck.clone().sub(hips);

    // Live particles. PointPool stores birth in params[i*4] and life in
    // params[i*4+1], so a particle is alive while birth + life > now.
    let live = -1, everSpawned = -1, cursor = -1;
    const pool = fx?.dynamic;
    if (pool) {
      const P = pool.params, now = fx._time;
      live = 0; everSpawned = 0;
      for (let i = 0; i < pool.max; i++) {
        const b = P[i * 4], L = P[i * 4 + 1];
        if (L > 0) everSpawned++;
        if (L > 0 && b + L > now) live++;
      }
      cursor = pool.cursor;
    }

    // ON SCREEN, or merely alive? 1945 live particles and an empty frame have
    // two very different explanations, and projecting them through the shot's
    // own camera is what tells them apart.
    let onScreen = -1, inFront = -1, medDist = -1, byKind = null, alphaSum = 0, puffOnScreen = 0, buried = 0;
    if (pool) {
      const cam = S.ctx.camera;
      cam.updateMatrixWorld(true);
      const v = new THREE.Vector3();
      const P = pool.params, POS = pool.position, VEL = pool.velocity, now = fx._time;
      const mu = fx.dynamic.points.material.uniforms || {};
      const G = mu.uGravity?.value || { x: 0, y: -9.81, z: 0 };
      const W = mu.uWind?.value || { x: 0, y: 0, z: 0 };
      const dists = [];
      onScreen = 0; inFront = 0;
      const STY0 = pool.style;
      for (let i = 0; i < pool.max; i++) {
        const b = P[i * 4], L = P[i * 4 + 1];
        if (!(L > 0 && b + L > now)) continue;
        // The DRAWN position, not the spawn point. The vertex shader
        // integrates ballistics with linear drag over the particle's age:
        //   pos = p0 + (v0 - vTerm)*(1 - e^(-k*age))/k + vTerm*age
        // Projecting p0 instead answers "where was it born", which for a
        // plume whose particles leave at up to 9 m/s is a different question
        // and gave a misleading 473-on-screen.
        const age0 = now - b, k = Math.max(P[i * 4 + 3], 0.001);
        const e0 = Math.exp(-k * age0);
        const tx = G.x / k + W.x, ty = G.y / k + W.y, tz = G.z / k + W.z;
        const f = (1 - e0) / k;
        v.set(
          POS[i * 3]     + (VEL[i * 3]     - tx) * f + tx * age0,
          POS[i * 3 + 1] + (VEL[i * 3 + 1] - ty) * f + ty * age0,
          POS[i * 3 + 2] + (VEL[i * 3 + 2] - tz) * f + tz * age0,
        );
        const v0x = v.x, v0y = v.y, v0z = v.z;
        dists.push(v.distanceTo(cam.position));
        v.project(cam);
        if (v.z < 1) inFront++;
        if (v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1) {
          onScreen++;
          // The vertex shader's own alpha, evaluated on the CPU:
          //   fadeIn  = smoothstep(0, 0.06, t)
          //   fadeOut = 1 - smoothstep(0.35, 1, t)
          //   vAlpha  = fadeIn * fadeOut * fadeOut
          // A plume of 484 on-screen sprites that renders as a few specks has
          // to be losing them somewhere, and alpha is the first suspect.
          const age = now - b, tt = Math.min(1, Math.max(0, age / L));
          const ss = (e0, e1, x) => { const u2 = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return u2 * u2 * (3 - 2 * u2); };
          const fo = 1 - ss(0.35, 1, tt);
          alphaSum += ss(0, 0.06, tt) * fo * fo;
          if (STY0[i * 4] === 2) puffOnScreen++;
          // BURIED? The emitter spawns at the physics contact point, and the
          // board is sunk into powder, so a particle can be below the snow
          // mesh and simply depth-tested away. 449 on-screen sprites at 0.69
          // alpha against a frame showing a handful of specks needs an
          // occluder, and the snow surface is the obvious candidate.
          const gh = S.ctx.terrain?.getHeight?.(v0x, v0z);
          if (gh != null && v0y < gh) buried++;
        }
      }
      dists.sort((a, b2) => a - b2);
      // By KIND. emitSpray writes crystals as kind 0 and the big soft puffs
      // -- the thing that is supposed to read as the spray WALL -- as kind 2.
      // A plume that is all crystals and no puffs is a handful of specks.
      byKind = {};
      const STY = pool.style;
      for (let i = 0; i < pool.max; i++) {
        const b = P[i * 4], L = P[i * 4 + 1];
        if (!(L > 0 && b + L > now)) continue;
        const k = STY[i * 4];
        byKind[k] = (byKind[k] || 0) + 1;
      }
      medDist = dists.length ? +dists[dists.length >> 1].toFixed(1) : -1;
    }

    res[name] = {
      speed: +(s.speed || 0).toFixed(2),
      roll: +((s.roll || 0) * 180 / Math.PI).toFixed(1),
      edgeLoad: +(s.edgeLoad || 0).toFixed(3),
      lateral: +(s.lateralSpeed || 0).toFixed(2),
      carving: !!s.carving, sliding: !!s.sliding, grounded: !!s.grounded,
      sprayIntensity: +(s.sprayIntensity || 0).toFixed(3),
      sinkDepth: +(s.sinkDepth || 0).toFixed(3),
      // Lean across the deck (heel +, toe -) and fore/aft (nose +, tail -).
      leanHeelDeg: +(Math.atan2(torso.x, torso.y) * 180 / Math.PI).toFixed(1),
      leanNoseDeg: +(Math.atan2(torso.z, torso.y) * 180 / Math.PI).toFixed(1),
      headOverX: +(head.x / HALF_W).toFixed(2),
      headOverZ: +(head.z).toFixed(3),
      hipsZ: +(hips.z).toFixed(3),
      liveParticles: live, particlesOnScreen: onScreen, particlesInFront: inFront,
      medianParticleDist: medDist, liveByKind: byKind,
      meanAlphaOnScreen: onScreen > 0 ? +(alphaSum / onScreen).toFixed(3) : -1,
      puffsOnScreen: puffOnScreen, buriedUnderSnow: buried, poolCursor: cursor,
      fxTime: +(fx?._time ?? -1).toFixed(2), sprayDebt: +(fx?._sprayDebt ?? -1).toFixed(2),
    };
  }
  return res;
}, shots);
console.log(JSON.stringify(out, null, 1));
await browser.close(); await server.close();
