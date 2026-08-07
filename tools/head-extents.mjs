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

// ---------------------------------------------------------------------------
// SURFACE distance, which is a different question from silhouette.
//
// `proud` above is maxX - skullHalfWidthHere: does this part cross the skull's
// X silhouette. That is the right question for a ring meant to girdle the
// helmet, and it answered the brim correctly (-0.0362, genuinely dead).
//
// It is the WRONG question for a vent slot on the crown or a strap round the
// back: both sit on the shell and render perfectly well while scoring
// negative, because neither is supposed to widen the head. Reading that column
// as "buried" cost a retraction (R29) -- six pieces reported dead, one
// actually dead.
//
// So ask the real question. For each vertex, evaluate the skull ellipsoid's
// implicit function; r = sqrt(f) is 1 on the surface, >1 outside. The radial
// distance from the surface is |v-c|*(1 - 1/r), which is exact along the
// radial direction and that is what "proud of the shell" means for shapes
// this smooth.
//
// The ellipsoid is read FROM THE SKULL MESH, not hardcoded. The hardcoded copy
// above carries sx and sy but no sz, so it has been ignoring that the skull is
// 1.10 deep for as long as it has existed.
const surf = await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const head = window.__SOHO.ctx.player.rider.bones.head;
  head.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(head.matrixWorld).invert();

  let skull = null;
  head.traverse((o) => { if (o.isMesh && o.name === 'skull') skull = o; });
  if (!skull) return { error: 'no mesh named "skull" under the head bone' };

  // Sphere radius x per-axis scale, positioned in head-local space.
  skull.geometry.computeBoundingSphere();
  const R0 = skull.geometry.boundingSphere.radius;
  const c = new THREE.Vector3().setFromMatrixPosition(skull.matrixWorld).applyMatrix4(inv);
  const s = new THREE.Vector3().setFromMatrixScale(skull.matrixWorld);
  const a = R0 * s.x, b = R0 * s.y, d = R0 * s.z;

  const v = new THREE.Vector3(), rel = new THREE.Vector3();
  const rows = [];
  head.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    if (o === skull) return;
    const pos = o.geometry.attributes.position;
    let maxOut = -1e9, nOut = 0;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).applyMatrix4(inv);
      rel.subVectors(v, c);
      const f = (rel.x / a) ** 2 + (rel.y / b) ** 2 + (rel.z / d) ** 2;
      const r = Math.sqrt(f);
      if (r > 1) nOut++;
      const dist = rel.length() * (1 - 1 / Math.max(r, 1e-9));
      if (dist > maxOut) maxOut = dist;
    }
    rows.push({
      type: o.geometry.type, id: o.id, verts: pos.count,
      outsideMax: +maxOut.toFixed(4),
      outsidePct: +(100 * nOut / pos.count).toFixed(1),
      visible: nOut > 0,
    });
  });
  rows.sort((x, y) => y.outsideMax - x.outsideMax);
  return { ellipsoid: { c: c.toArray().map(n => +n.toFixed(4)), a: +a.toFixed(4), b: +b.toFixed(4), d: +d.toFixed(4) }, rows };
});

console.log('=== silhouette (proud = maxX - skullHalfWidthHere) ===');
console.log(JSON.stringify(out, null, 1));
console.log('\n=== SURFACE (outsideMax = max radial distance outside the shell) ===');
if (surf.error) {
  console.log(surf.error);
} else {
  console.log(`ellipsoid c=${JSON.stringify(surf.ellipsoid.c)} a=${surf.ellipsoid.a} b=${surf.ellipsoid.b} d=${surf.ellipsoid.d}`);
  console.log(`${'type'.padEnd(18)}${'verts'.padStart(7)}${'outsideMax'.padStart(12)}${'outside%'.padStart(10)}  state`);
  for (const r of surf.rows) {
    console.log(`${r.type.padEnd(18)}${String(r.verts).padStart(7)}${r.outsideMax.toFixed(4).padStart(12)}${r.outsidePct.toFixed(1).padStart(10)}  ${r.visible ? 'on surface' : 'FULLY INSIDE'}`);
  }
}
await browser.close(); await server.close();
