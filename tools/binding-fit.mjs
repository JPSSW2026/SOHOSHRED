/**
 * Does the binding hardware actually sit ON the boot?
 *
 * The portrait shows white boot blocks with no visible strap however the radii
 * and heights are tuned, so this measures the two against each other directly:
 * every binding mesh and the boot it serves, per vertex, in the binding mount's
 * own frame. No ticking, so it returns in seconds.
 *
 *   node tools/binding-fit.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 6395 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.setDefaultTimeout(900000);
await page.goto('http://127.0.0.1:6395/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });

const out = await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const rider = window.__SOHO.ctx.player.rider;
  rider.object3D.updateWorldMatrix(false, true);

  const boxIn = (frameInv, o) => {
    const pos = o.geometry.attributes.position;
    const b = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).applyMatrix4(frameInv);
      b.expandByPoint(v);
    }
    const r = (n) => +n.toFixed(4);
    return { x: [r(b.min.x), r(b.max.x)], y: [r(b.min.y), r(b.max.y)], z: [r(b.min.z), r(b.max.z)] };
  };

  const res = {};
  for (const [side, tag] of [['F', 'Front'], ['B', 'Back']]) {
    const mount = rider.bones[`binding${tag}`];
    const inv = new THREE.Matrix4().copy(mount.matrixWorld).invert();
    const rows = {};
    mount.traverse((o) => {
      if (o.isMesh && o.geometry?.attributes?.position) {
        rows[o.name || `${o.geometry.type}#${o.id}`] = boxIn(inv, o);
      }
    });
    // The boot lives on the LEG chain, so it has to be found separately.
    rider.bones[`boot${side}`].traverse((o) => {
      if (o.isMesh && o.geometry?.attributes?.position) {
        rows[`BOOT:${o.name || o.geometry.type + '#' + o.id}`] = boxIn(inv, o);
      }
    });
    res[tag] = rows;
    if (tag === 'Front') break;   // both bindings are identical by construction
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await browser.close(); await server.close();
