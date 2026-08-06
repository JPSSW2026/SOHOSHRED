/**
 * Head/helmet preview: front, three-quarter, side and back in one image.
 * Working on a head from a single 3/4 rear game frame is guesswork.
 *   node tools/head-preview.mjs [--out DIR]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'shots/head';
await mkdir(OUT, { recursive: true });
const server = await createServer({ root: process.cwd(), server: { port: 6381 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 340 } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerr]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:6381/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });
await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const S = window.__SOHO;
  const cv = document.createElement('canvas');
  cv.width = 1200; cv.height = 340;
  cv.style.cssText = 'position:fixed;left:0;top:0;z-index:99999';
  document.body.appendChild(cv);
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
  r.setClearColor(0x93a4b8, 1);
  r.outputColorSpace = THREE.SRGBColorSpace;
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xdfefff, 0x59606b, 1.9));
  const key = new THREE.DirectionalLight(0xfff4e6, 2.3); key.position.set(2, 3, 4); sc.add(key);

  // Borrow the live head bone subtree (keeps skinning + real materials).
  const rider = S.ctx.player.rider;
  const head = rider.bones.head;
  const home = head.parent;
  const xf = { p: head.position.clone(), q: head.quaternion.clone() };
  sc.add(head);
  head.position.set(0, 0, 0); head.quaternion.identity();
  head.updateMatrixWorld(true);

  const cam = new THREE.PerspectiveCamera(26, 300 / 340, 0.01, 20);
  const R = 0.92;
  const views = [
    ['front', 0], ['three-quarter', Math.PI * 0.25], ['side', Math.PI * 0.5], ['back', Math.PI],
  ];
  views.forEach(([, ang], i) => {
    r.setViewport(i * 300, 0, 300, 340);
    r.setScissor(i * 300, 0, 300, 340);
    r.setScissorTest(true);
    cam.position.set(Math.sin(ang) * R, 0.12, Math.cos(ang) * R);
    cam.lookAt(0, 0.10, 0);
    r.render(sc, cam);
  });
  head.position.copy(xf.p); head.quaternion.copy(xf.q);
  home.add(head); head.updateMatrixWorld(true);
});
await page.screenshot({ path: path.join(OUT, 'head-views.png') });
console.log('[head-preview] front | three-quarter | side | back');
await browser.close(); await server.close();
