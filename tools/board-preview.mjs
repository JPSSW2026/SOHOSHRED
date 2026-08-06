/**
 * Board preview: underside, side, three-quarter-below and top.
 * The base of the board is never visible in gameplay framings, so defects
 * there survive indefinitely unless something looks at it deliberately.
 *   node tools/board-preview.mjs [--out DIR]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'shots/board';
await mkdir(OUT, { recursive: true });
const server = await createServer({ root: process.cwd(), server: { port: 6391 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1240, height: 380 } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerr]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:6391/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });
const info = await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const S = window.__SOHO;
  const cv = document.createElement('canvas');
  cv.width = 1240; cv.height = 380;
  cv.style.cssText = 'position:fixed;left:0;top:0;z-index:99999';
  document.body.appendChild(cv);
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
  r.setClearColor(0x9aa7b6, 1);
  r.outputColorSpace = THREE.SRGBColorSpace;
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xffffff, 0x707880, 2.2));
  const k = new THREE.DirectionalLight(0xffffff, 2.0); k.position.set(1, -2, 2); sc.add(k);
  const k2 = new THREE.DirectionalLight(0xffffff, 1.4); k2.position.set(-2, 3, -1); sc.add(k2);

  const rider = S.ctx.player.rider;
  const board = rider.boardObject;
  const home = board.parent;
  const xf = { p: board.position.clone(), q: board.quaternion.clone() };
  sc.add(board);
  board.position.set(0, 0, 0); board.quaternion.identity();
  board.updateMatrixWorld(true);

  // Below the base plane, and OUTSIDE the board's own width.
  //
  // Measured per VERTEX, not per bounding box. The first pass of this probe
  // took each geometry's local AABB and transformed it, which for a torus
  // rotated on two axes inflates the extent enormously -- it reported the
  // ankle strap 3.3 cm outside the deck when the strap's real vertices are
  // nowhere near the edge. An AABB of a transformed AABB is a bound, not a
  // measurement, and acting on it would have shrunk working hardware.
  const _v = new THREE.Vector3();
  const extents = (o) => {
    const pos = o.geometry.attributes.position;
    let minY = 1e9, maxAbsX = 0;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (_v.y < minY) minY = _v.y;
      if (Math.abs(_v.x) > maxAbsX) maxAbsX = Math.abs(_v.x);
    }
    return { minY, maxAbsX };
  };
  let lowest = 1e9, lowestName = '';
  let deckHalfX = 0;
  board.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const e = extents(o);
    if (e.minY < lowest) { lowest = e.minY; lowestName = o.name || o.geometry.type; }
    if ((o.name || '') === 'deck') deckHalfX = e.maxAbsX;
  });
  // Only the BINDING subtrees. boardObject is the pivot that parents the whole
  // rider, so an unrestricted walk reports arms and head as "overhang".
  const overhang = [];
  const bindingRoots = [rider.bones.bindingFront, rider.bones.bindingBack].filter(Boolean);
  const inBinding = (o) => {
    for (let n = o; n; n = n.parent) if (bindingRoots.includes(n)) return true;
    return false;
  };
  board.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position || (o.name || '') === 'deck') return;
    if (!inBinding(o)) return;
    const e = extents(o);
    const c = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
    const sc = new THREE.Vector3().setFromMatrixScale(o.matrixWorld);
    overhang.push({ part: o.name || o.geometry.type, ext: +e.maxAbsX.toFixed(4),
                    over: +(e.maxAbsX - deckHalfX).toFixed(4),
                    belowBase: +e.minY.toFixed(4),
                    cx: +c.x.toFixed(4), cz: +c.z.toFixed(4),
                    scale: [+sc.x.toFixed(3), +sc.y.toFixed(3), +sc.z.toFixed(3)] });
  });
  overhang.sort((a, b) => b.over - a.over);

  const cam = new THREE.PerspectiveCamera(34, 310 / 380, 0.01, 30);
  const views = [
    ['under',    [0, -2.9, 0.001]],
    ['under-3q', [1.5, -2.2, 1.5]],
    ['side',     [0, 0.05, 3.1]],
    ['top',      [0, 2.9, 0.001]],
  ];
  views.forEach(([, p], i) => {
    r.setViewport(i * 310, 0, 310, 380);
    r.setScissor(i * 310, 0, 310, 380);
    r.setScissorTest(true);
    cam.position.set(p[0], p[1], p[2]);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);
    r.render(sc, cam);
  });
  board.position.copy(xf.p); board.quaternion.copy(xf.q);
  home.add(board); board.updateMatrixWorld(true);
  return { lowestY: +lowest.toFixed(4), lowestPart: lowestName,
           deckHalfWidth: +deckHalfX.toFixed(4), overhang: overhang.slice(0, 8) };
});
console.log(JSON.stringify(info));
await page.screenshot({ path: path.join(OUT, 'board-views.png') });
console.log('[board-preview] under | under-3q | side | top');
await browser.close(); await server.close();
