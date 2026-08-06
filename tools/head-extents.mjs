/**
 * Which part of the head breaks the skull's silhouette?
 *
 * Rendering four views and guessing which primitive is the grey bar cost three
 * iterations and got it wrong twice. Every mesh under the head bone, measured
 * per vertex against the skull's own ellipsoid at the same height, answers it
 * in one run.
 *
 *   node tools/head-extents.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 6394 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.setDefaultTimeout(900000);
await page.goto('http://127.0.0.1:6394/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });

const out = await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const head = window.__SOHO.ctx.player.rider.bones.head;
  head.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(head.matrixWorld).invert();
  const v = new THREE.Vector3();

  // Everything in HEAD-LOCAL space, so the numbers are directly comparable to
  // the scale factors in the source.
  const parts = [];
  head.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    let maxX = 0, xAtY = 0, maxZ = -1e9, minZ = 1e9, lo = 1e9, hi = -1e9;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).applyMatrix4(inv);
      if (Math.abs(v.x) > maxX) { maxX = Math.abs(v.x); xAtY = v.y; }
      if (v.z > maxZ) maxZ = v.z;
      if (v.z < minZ) minZ = v.z;
      if (v.y < lo) lo = v.y;
      if (v.y > hi) hi = v.y;
    }
    parts.push({ type: o.geometry.type, id: o.id,
                 maxX: +maxX.toFixed(4), yOfMaxX: +xAtY.toFixed(4),
                 maxZ: +maxZ.toFixed(4), minZ: +minZ.toFixed(4),
                 yLo: +lo.toFixed(4), yHi: +hi.toFixed(4) });
  });

  // The skull is the reference silhouette. Its half-width at any height y is
  // sx*R*sqrt(1-((y-cy)/(sy*R))^2) -- so "sticks out" means wider than THAT,
  // not wider than the skull's equator.
  const R = 0.115, cy = R * 0.85, sx = 0.96, sy = 1.02;
  for (const p of parts) {
    const t = (p.yOfMaxX - cy) / (sy * R);
    p.skullHalfWidthHere = +(Math.abs(t) >= 1 ? 0 : sx * R * Math.sqrt(1 - t * t)).toFixed(4);
    p.proud = +(p.maxX - p.skullHalfWidthHere).toFixed(4);
  }
  parts.sort((a, b) => b.proud - a.proud);
  return parts;
});
console.log(JSON.stringify(out, null, 1));
await browser.close(); await server.close();
