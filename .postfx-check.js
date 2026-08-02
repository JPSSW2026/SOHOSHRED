/* TEMPORARY validation harness for src/fx/postprocess.js. Deleted after use. */
import * as THREE from 'three';
import { createComposer, updatePost } from './src/fx/postprocess.js';
import { CONFIG } from './src/core/config.js';

const out = { ok: false, steps: [], errors: [], info: null, stats: {}, images: {} };
window.__RESULT = out;

const origError = console.error;
console.error = (...a) => { out.errors.push(a.map(String).join(' ')); origError.apply(console, a); };

const W = 640, H = 360;
const shot = (k) => { out.images[k] = document.querySelector('canvas').toDataURL('image/png'); };

function stats(gl, w, h) {
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const lum = [];
  let white = 0, sum = 0, satSum = 0;
  for (let i = 0; i < w * h; i++) {
    const r = buf[i * 4], g = buf[i * 4 + 1], b = buf[i * 4 + 2];
    if (r >= 254 && g >= 254 && b >= 254) white++;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum.push(l); sum += l;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    satSum += mx > 0 ? (mx - mn) / mx : 0;
  }
  lum.sort((a, b) => a - b);
  const p = (q) => lum[Math.min(lum.length - 1, Math.floor(q * lum.length))];
  return {
    mean: +(sum / lum.length).toFixed(1),
    p50: +p(0.5).toFixed(1),
    p999: +p(0.999).toFixed(1),
    max: +lum[lum.length - 1].toFixed(1),
    whitePct: +((white / lum.length) * 100).toFixed(3),
    meanSat: +(satSum / lum.length).toFixed(3),
  };
}

try {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, stencil: false, depth: true, preserveDrawingBuffer: true, alpha: false,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = CONFIG.render.exposure;
  renderer.shadowMap.enabled = true;
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(new THREE.Color(0.55, 0.66, 0.82), 2.4e-5);
  const camera = new THREE.PerspectiveCamera(62, W / H, 0.12, 40000);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0xdddde6, roughness: 0.6 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 1.2, 1.2),
      new THREE.MeshStandardMaterial({ color: 0x8a8478, roughness: 0.7 }),
    );
    m.position.set(-6 + i * 1.8, 0.6, -2 - i * 3);
    scene.add(m);
  }
  // Stand-in sky dome, same setup as sky.js: depth-test off, drawn first.
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x2a64a6, side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false }),
  );
  dome.frustumCulled = false;
  dome.renderOrder = -10000;
  dome.scale.setScalar(30000);
  scene.add(dome);

  const sunDirection = new THREE.Vector3(0.72, 0.184, -0.67).normalize();
  const dir = new THREE.DirectionalLight(0xffd1ae, 3.4);
  dir.position.copy(sunDirection).multiplyScalar(500);
  scene.add(dir);
  scene.add(new THREE.HemisphereLight(0xa0c0ff, 0xe8e9ec, 1.4));

  const engine = { systems: [] };
  const ctx = {
    engine, renderer, scene, camera, config: CONFIG, elapsed: 0, frame: 0, dt: 1 / 60,
    terrain: {
      bounds: { minX: -1024, maxX: 1024, minZ: -1024, maxZ: 1024 },
      getHeight: (x, z) => Math.sin(x * 0.05) * 0.4 + Math.cos(z * 0.04) * 0.3,
      getSpawn: () => ({ position: new THREE.Vector3(0, 0, 0), heading: 0 }),
    },
    sky: { sunDirection, sunColor: new THREE.Color(1.0, 0.82, 0.68) },
    physics: { state: { position: new THREE.Vector3(0, 0.9, 0), heading: 0, speed: 18 } },
    player: { camera: { mode: 'chase' } },
    composer: null,
  };
  engine.ctx = ctx;

  const placeChase = () => {
    camera.fov = 62;
    camera.position.set(0, 6, 12);
    camera.lookAt(0, 0.8, -6);
    camera.updateProjectionMatrix();
  };
  const placeSun = () => {
    camera.fov = 52;
    camera.position.set(-20, 8, 30);
    camera.lookAt(camera.position.x + sunDirection.x * 300, camera.position.y + sunDirection.y * 120, camera.position.z + sunDirection.z * 300);
    camera.updateProjectionMatrix();
  };

  const gl = renderer.getContext();

  // ---- reference: direct render (tone map in-material) --------------------
  placeChase();
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
  out.stats.directChase = stats(gl, W, H); shot('01-direct-chase');
  placeSun();
  renderer.render(scene, camera);
  out.stats.directSun = stats(gl, W, H); shot('02-direct-sun');
  out.steps.push('direct-ok');

  // ---- composed -----------------------------------------------------------
  const composer = createComposer(ctx);
  if (!composer) throw new Error('createComposer returned null');
  out.steps.push('composer-created systems=' + engine.systems.length);

  const tick = (dt, move) => {
    ctx.frame++; ctx.elapsed += dt; ctx.dt = dt;
    if (move) {
      camera.position.x += dt * 4.0;
      camera.position.z -= dt * 9.0;
      camera.lookAt(camera.position.x - 1, 0.6, camera.position.z - 20);
    }
    for (const s of engine.systems) s.update?.(dt, ctx);
    renderer.info.reset();
    composer.render(dt);
    for (const s of engine.systems) s.postRender?.(dt, ctx);
    const e = gl.getError();
    if (e !== 0) out.errors.push('glError ' + e + ' frame ' + ctx.frame);
  };

  placeChase();
  for (let i = 0; i < 5; i++) tick(1 / 60, true);
  out.stats.postChase = stats(gl, W, H); shot('03-post-chase');
  out.stats.chaseInfo = { focus: +ctx.post.info().focus.toFixed(2) };

  placeSun();
  for (let i = 0; i < 4; i++) tick(1 / 60, false);
  out.stats.postSun = stats(gl, W, H); shot('04-post-sun');
  out.stats.sunVis = +ctx.post.info().sunVisibility.toFixed(3);
  out.stats.drawCalls = renderer.info.render.calls;
  out.steps.push('post-ok');

  // Sun occluded by geometry behind us -> glare must vanish.
  camera.lookAt(camera.position.x - sunDirection.x * 300, 0, camera.position.z - sunDirection.z * 300);
  camera.updateProjectionMatrix();
  for (let i = 0; i < 3; i++) tick(1 / 60, false);
  out.stats.sunVisAway = +ctx.post.info().sunVisibility.toFixed(3);

  // Camera cut: no smear, focus snaps.
  camera.fov = 28;
  camera.position.set(60, 30, 80);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  tick(1 / 60, false);
  out.steps.push('cut-ok');

  updatePost(1 / 60, ctx);
  out.steps.push('updatePost-idempotent');

  renderer.setSize(400, 240, false);
  camera.aspect = 400 / 240; camera.updateProjectionMatrix();
  for (const s of engine.systems) s.resize?.(400, 240, 400, 240);
  for (let i = 0; i < 3; i++) tick(1 / 60, true);
  out.steps.push('resize-ok');

  CONFIG.post.ssao.enabled = false; CONFIG.post.motionBlur.enabled = false;
  CONFIG.post.dof.enabled = false; CONFIG.post.bloom.enabled = false;
  tick(1 / 60, false);
  CONFIG.post.ssao.enabled = true; CONFIG.post.motionBlur.enabled = true;
  CONFIG.post.dof.enabled = true; CONFIG.post.bloom.enabled = true;
  CONFIG.post.bloom.streak = 0.05;
  tick(1 / 60, false); tick(1 / 60, false);
  out.steps.push('flags-ok');

  out.info = ctx.post.info();
  ctx.post.dispose();
  out.steps.push('dispose-ok');
  out.ok = out.errors.length === 0;
} catch (err) {
  out.errors.push('EXCEPTION: ' + (err && err.stack || err));
}
document.documentElement.setAttribute('data-check-done', '1');
