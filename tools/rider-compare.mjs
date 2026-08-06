/**
 * Side-by-side rider comparison harness.
 *
 * Renders the reference GLB and the in-game procedural rider from one camera,
 * height-normalised, on a neutral card -- and measures the silhouette of each
 * so the comparison is numeric, not an impression.
 *
 *   node tools/rider-compare.mjs [--out DIR]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : 'shots/rider-compare';
await mkdir(OUT, { recursive: true });

const server = await createServer({ root: process.cwd(), server: { port: 6371 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerr]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:6371/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });

const result = await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
  const S = window.__SOHO;

  const cv = document.createElement('canvas');
  cv.width = 1100; cv.height = 760;
  cv.style.cssText = 'position:fixed;left:0;top:0;z-index:99999';
  document.body.appendChild(cv);
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
  r.setClearColor(0x8a9bb0, 1);
  r.outputColorSpace = THREE.SRGBColorSpace;

  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xdfefff, 0x59606b, 2.0));
  const key = new THREE.DirectionalLight(0xfff4e6, 2.4);
  key.position.set(2.5, 4, 3); sc.add(key);

  // --- reference -----------------------------------------------------------
  const gltf = await new GLTFLoader().loadAsync('models/rider-style.glb');
  const ref = gltf.scene;
  ref.traverse(o => { if (o.isMesh && o.material) { o.material.metalness = 0; o.material.roughness = 0.85; } });

  // --- ours ----------------------------------------------------------------
  // BORROW the real rider, do not clone it.
  //
  // clone(true) does not rebind a skeleton, so every skinned garment tube --
  // which is most of the figure -- silently vanished and the comparison
  // rendered a floating head, some torus trims and the boots. Reparenting the
  // live object keeps its skeleton binding intact; it goes back afterwards.
  const ours = S.ctx.player.rider.object3D;
  const homeParent = ours.parent;
  const homeXform = {
    p: ours.position.clone(), q: ours.quaternion.clone(), s: ours.scale.clone(),
  };
  ours.position.set(0, 0, 0);
  ours.quaternion.identity();
  ours.scale.set(1, 1, 1);
  ours.updateMatrixWorld(true);

  const fit = (obj) => {
    obj.updateMatrixWorld(true);
    const b = new THREE.Box3();
    // setFromObject trusts every child's matrixWorld; a single stale or
    // non-finite one poisons the whole box (measured 1e48 before this).
    obj.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      if (!bb || !Number.isFinite(bb.min.x) || !Number.isFinite(bb.max.x)) return;
      const t = bb.clone().applyMatrix4(o.matrixWorld);
      if (Number.isFinite(t.min.x) && Number.isFinite(t.max.y)) b.union(t);
    });
    const size = b.getSize(new THREE.Vector3());
    const c = b.getCenter(new THREE.Vector3());
    const k = 1.8 / Math.max(size.y, 1e-6);          // normalise to 1.8 m tall
    obj.scale.multiplyScalar(k);
    obj.position.sub(c.multiplyScalar(k));
    return { h: size.y, w: size.x, d: size.z };
  };
  const refDim = fit(ref);
  const oursDim = fit(ours);
  ref.position.x -= 1.15;
  ours.position.x += 1.15;
  sc.add(ref); sc.add(ours);

  const cam = new THREE.PerspectiveCamera(30, 1100 / 760, 0.05, 60);
  cam.position.set(0, 0.25, 7.2);
  cam.lookAt(0, 0, 0);
  r.render(sc, cam);

  // --- silhouette metrics --------------------------------------------------
  const gl = cv.getContext('webgl2') || cv.getContext('webgl');
  const buf = new Uint8Array(1100 * 760 * 4);
  gl.readPixels(0, 0, 1100, 760, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const isBg = (i) => Math.abs(buf[i] - 138) < 14 && Math.abs(buf[i+1] - 155) < 14 && Math.abs(buf[i+2] - 176) < 14;
  // Width profile in 20 bands top->bottom, per half of the frame.
  const profile = (x0, x1) => {
    const bands = [];
    let top = null, bot = null;
    for (let y = 0; y < 760; y++) {
      let n = 0;
      for (let x = x0; x < x1; x++) { const i = ((759 - y) * 1100 + x) * 4; if (!isBg(i)) n++; }
      bands.push(n);
      if (n > 0) { if (top === null) top = y; bot = y; }
    }
    if (top === null) return null;
    const h = bot - top + 1;
    const out = [];
    for (let k = 0; k < 20; k++) {
      const a = top + Math.floor(h * k / 20), b = top + Math.floor(h * (k + 1) / 20);
      let m = 0; for (let y = a; y < Math.max(b, a + 1); y++) m = Math.max(m, bands[y]);
      out.push(+(m / h).toFixed(3));     // width as a fraction of figure height
    }
    const area = bands.reduce((s, v) => s + v, 0);
    return { widths: out, heightPx: h, areaFrac: +(area / (h * h)).toFixed(3) };
  };
  // Put the rider back exactly where it was before measuring anything else.
  const restore = () => {
    ours.position.copy(homeXform.p);
    ours.quaternion.copy(homeXform.q);
    ours.scale.copy(homeXform.s);
    if (homeParent) homeParent.add(ours);
    ours.updateMatrixWorld(true);
  };

  const metrics = {
    refDim: { h: +refDim.h.toFixed(2), w: +refDim.w.toFixed(2), d: +refDim.d.toFixed(2) },
    oursDim: { h: +oursDim.h.toFixed(2), w: +oursDim.w.toFixed(2), d: +oursDim.d.toFixed(2) },
    ref: profile(0, 550), ours: profile(550, 1100),
  };
  restore();
  return metrics;
});

await page.screenshot({ path: path.join(OUT, 'side-by-side.png') });
await writeFile(path.join(OUT, 'metrics.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result));
await browser.close(); await server.close();
