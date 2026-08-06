/**
 * The whole rider, six ways round, on one card.
 *
 * Every judgement made about this figure so far has come from one camera —
 * `rider-portrait`, a 3/4 rear. That view hides the entire chest and toe
 * side, and two defects that lived there for rounds (the sleeve cuff ending
 * as an open bell, the pant hem as a lampshade) were only ever caught because
 * they happened to be visible from behind as well. A single angle cannot tell
 * you what a figure looks like.
 *
 * Renders the live rider subtree into a private scene under a neutral rig, so
 * skinning, materials and the current pose are all the real ones — the same
 * borrow-the-bone trick head-preview.mjs uses, extended to the root.
 *
 *   node tools/rider-turnaround.mjs [--out DIR] [--pose free|grab]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'shots/turn';
await mkdir(OUT, { recursive: true });

const W = 2400, H = 620, N = 6;
const server = await createServer({ root: process.cwd(), server: { port: 6421 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerr]', String(e).slice(0, 300)));
await page.goto('http://127.0.0.1:6421/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });

const info = await page.evaluate(async ({ W, H, N }) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const S = window.__SOHO;

  // Settle the rig into a real riding pose first: an un-updated rider stands
  // in its bind pose, which is not a pose anyone ever sees.
  const spawn = S.ctx.terrain?.getSpawn?.();
  if (spawn) S.ctx.physics?.reset?.(spawn.position, spawn.heading);
  S.engine.manualTime = true;
  if (S.ctx.input) S.ctx.input.enabled = false;
  for (let i = 0; i < 90; i++) {
    S.ctx.physics.applyInput({
      steer: Math.sin(i / 60 * 0.9) * 0.6, lean: 0,
      crouch: 0.38, pop: false, spin: 0, flip: 0,
      grab: null, tuck: false, brake: 0, reset: false,
    });
    S.engine.tick(1 / 60, false);
  }

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.style.cssText = 'position:fixed;left:0;top:0;z-index:99999';
  document.body.appendChild(cv);
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
  r.setClearColor(0x8d9cb0, 1);
  r.outputColorSpace = THREE.SRGBColorSpace;
  // Neutral studio rig. Deliberately NOT the game's sun: a low raking key
  // hides form on the shadowed side, and the point here is to read shape.
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xdfefff, 0x59606b, 1.7));
  const key = new THREE.DirectionalLight(0xfff4e6, 2.4); key.position.set(2, 3.2, 4); sc.add(key);
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.9); fill.position.set(-3, 1.4, -2); sc.add(fill);

  // Borrow the whole rider, not a copy: skinned garments follow their own
  // skeleton, and a clone would need the bones cloned with it.
  const root = S.ctx.player.rider.object3D;
  const home = root.parent;
  const xf = { p: root.position.clone(), q: root.quaternion.clone() };
  sc.add(root);
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.updateMatrixWorld(true);

  // Frame from the figure's own bounds so the card does not depend on any
  // hand-tuned distance surviving a change to the rig.
  const box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  const sz = box.getSize(new THREE.Vector3());
  const radius = Math.max(sz.x, sz.y, sz.z) * 0.5;

  const cw = W / N;
  const cam = new THREE.PerspectiveCamera(30, cw / H, 0.05, 60);
  // Fit the bounding SPHERE on whichever axis is tighter. Fitting the
  // vertical FOV alone put the figure half out of frame, because a cell of
  // this card is much narrower than it is tall and horizontal is the
  // limiting axis every time.
  const vHalf = (30 * Math.PI / 180) * 0.5;
  const hHalf = Math.atan(Math.tan(vHalf) * (cw / H));
  const dist = radius / Math.sin(Math.min(vHalf, hHalf)) * 1.08;
  const tags = [];
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2;
    tags.push(`${Math.round(ang * 180 / Math.PI)}deg`);
    r.setViewport(i * cw, 0, cw, H);
    r.setScissor(i * cw, 0, cw, H);
    r.setScissorTest(true);
    cam.position.set(c.x + Math.sin(ang) * dist, c.y + radius * 0.18, c.z + Math.cos(ang) * dist);
    cam.lookAt(c.x, c.y, c.z);
    r.render(sc, cam);
  }

  root.position.copy(xf.p); root.quaternion.copy(xf.q);
  home.add(root); root.updateMatrixWorld(true);
  return { tags, size: sz.toArray().map(v => +v.toFixed(3)), radius: +radius.toFixed(3) };
}, { W, H, N });
console.log(JSON.stringify(info));

await page.screenshot({ path: path.join(OUT, 'turnaround.png'), clip: { x: 0, y: 0, width: W, height: H }, timeout: 600000 });
console.log('[turnaround]', path.join(OUT, 'turnaround.png'));
await browser.close(); await server.close();
