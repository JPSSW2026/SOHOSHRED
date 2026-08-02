/**
 * Named camera/state presets used by the screenshot harness and the in-game
 * photo mode. Each preset warms the world up for a given number of seconds,
 * then poses the camera. Presets must be deterministic.
 *
 * A preset is:
 *   { name, settle, apply(ctx) }
 * `apply` may move ctx.camera directly, or set a camera mode and let the
 * ChaseCamera resolve it.
 */

import * as THREE from 'three';

const v = (x, y, z) => new THREE.Vector3(x, y, z);

export const SHOTS = [
  {
    name: 'hero-basin',
    description: 'Wide establishing shot of the Soho Basin headwall at low sun.',
    settle: 1.0,
    apply(ctx) {
      const t = ctx.terrain;
      const p = t ? t.getSpawn().position : v(0, 60, 0);
      const cam = ctx.camera;
      cam.fov = 46;
      cam.position.set(p.x + 120, (t ? t.getHeight(p.x + 120, p.z + 210) : 0) + 78, p.z + 210);
      cam.lookAt(p.x - 40, (t ? t.getHeight(p.x - 40, p.z - 260) : 0) + 30, p.z - 260);
      cam.updateProjectionMatrix();
    },
  },
  {
    name: 'chase-carve',
    description: 'Gameplay chase camera mid-carve — the money shot.',
    settle: 6.0,
    apply(ctx) {
      ctx.player?.camera?.setMode?.('chase');
    },
  },
  {
    name: 'close-spray',
    description: 'Low, close on the board throwing a spray wall.',
    settle: 7.5,
    apply(ctx) {
      const st = ctx.physics?.state;
      const cam = ctx.camera;
      if (!st) return;
      cam.fov = 38;
      const back = new THREE.Vector3(Math.sin(st.heading), 0, Math.cos(st.heading)).multiplyScalar(-4.2);
      cam.position.copy(st.position).add(back).add(v(2.2, 0.75, 0));
      cam.lookAt(st.position.x, st.position.y + 0.55, st.position.z);
      cam.updateProjectionMatrix();
    },
  },
  {
    name: 'air-trick',
    description: 'Rider mid-air off a natural rollover, backlit.',
    settle: 9.0,
    apply(ctx) {
      ctx.player?.camera?.setMode?.('cinematic');
    },
  },
  {
    name: 'snow-detail',
    description: 'Macro on untracked snow — tests sparkle, sastrugi, SSS.',
    settle: 0.5,
    apply(ctx) {
      const t = ctx.terrain;
      const p = t ? t.getSpawn().position : v(0, 0, 0);
      const cam = ctx.camera;
      cam.fov = 28;
      const gx = p.x + 18, gz = p.z - 26;
      const gy = t ? t.getHeight(gx, gz) : 0;
      cam.position.set(gx, gy + 1.15, gz + 2.4);
      cam.lookAt(gx, gy, gz - 1.5);
      cam.updateProjectionMatrix();
    },
  },
  {
    name: 'ridge-backlight',
    description: 'Looking into the sun over the ridge — atmosphere, glare, aerial perspective.',
    settle: 1.0,
    apply(ctx) {
      const t = ctx.terrain;
      const sun = ctx.sky?.sunDirection ?? v(0.4, 0.35, -0.85);
      const p = t ? t.getSpawn().position : v(0, 60, 0);
      const cam = ctx.camera;
      cam.fov = 52;
      cam.position.set(p.x - 60, (t ? t.getHeight(p.x - 60, p.z + 120) : 0) + 26, p.z + 120);
      const look = cam.position.clone().add(new THREE.Vector3(sun.x, sun.y * 0.35, sun.z).multiplyScalar(300));
      cam.lookAt(look);
      cam.updateProjectionMatrix();
    },
  },
  {
    name: 'rider-portrait',
    description: 'Three-quarter on the rider — tests character model + materials.',
    settle: 5.0,
    apply(ctx) {
      const st = ctx.physics?.state;
      const cam = ctx.camera;
      if (!st) return;
      cam.fov = 34;
      const fwd = new THREE.Vector3(Math.sin(st.heading), 0, Math.cos(st.heading));
      const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
      cam.position.copy(st.position)
        .add(fwd.clone().multiplyScalar(3.1))
        .add(right.multiplyScalar(2.6))
        .add(v(0, 1.15, 0));
      cam.lookAt(st.position.x, st.position.y + 0.95, st.position.z);
      cam.updateProjectionMatrix();
    },
  },
  {
    name: 'valley-vista',
    description: 'Down-valley toward the Cardrona basin and distant ranges.',
    settle: 1.0,
    apply(ctx) {
      const t = ctx.terrain;
      const cam = ctx.camera;
      const p = t ? t.getSpawn().position : v(0, 60, 0);
      cam.fov = 55;
      cam.position.set(p.x, (t ? t.getHeight(p.x, p.z) : 0) + 14, p.z);
      cam.lookAt(p.x + 20, (t ? t.getHeight(p.x, p.z) : 0) - 120, p.z - 900);
      cam.updateProjectionMatrix();
    },
  },
];

export const SHOT_NAMES = SHOTS.map((s) => s.name);
export const getShot = (name) => SHOTS.find((s) => s.name === name);
