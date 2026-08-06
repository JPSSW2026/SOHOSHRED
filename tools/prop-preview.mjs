/**
 * Frame one instance of a named prop field.
 *
 * Props are instanced and scattered over kilometres, so a shot preset almost
 * never puts one close enough to judge. This finds the field by name, picks an
 * instance, and points the game camera at it from a few angles — so a new prop
 * can be checked as a MODEL and in its real placement at the same time.
 *
 *   node tools/prop-preview.mjs <field-name> [--out DIR]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const FIELD = process.argv[2] || 'snow-gun';
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'shots/prop';
await mkdir(OUT, { recursive: true });

const server = await createServer({ root: process.cwd(), server: { port: 6406 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerr]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:6406/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });

const info = await page.evaluate(async (fieldName) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const S = window.__SOHO;

  // Find every InstancedMesh whose name carries the field tag, and pull the
  // instance matrices out so we can aim at a real one.
  const hits = [];
  S.ctx.scene.traverse((o) => {
    if (o.isInstancedMesh && (o.name || '').includes(fieldName)) hits.push(o);
  });
  if (!hits.length) return { error: `no instanced mesh matching "${fieldName}"` };

  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const pts = [];
  for (const im of hits) {
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m);
      p.setFromMatrixPosition(m).applyMatrix4(im.matrixWorld);
      pts.push({ x: p.x, y: p.y, z: p.z });
    }
  }
  if (!pts.length) return { error: `"${fieldName}" has no instances`, meshes: hits.length };

  // Aim at the one nearest the spawn, so it is on the actual run.
  const sp = S.ctx.terrain.getSpawn().position;
  pts.sort((a, b) => (
    (a.x - sp.x) ** 2 + (a.z - sp.z) ** 2) - ((b.x - sp.x) ** 2 + (b.z - sp.z) ** 2));
  const t = pts[0];

  const cam = S.ctx.camera;
  S.ctx.flow?.skip?.();
  // Hand the camera to the shot system. Without this the chase camera resets
  // it on every tick and the preview frames the rider, not the prop.
  S.ctx.player?.camera?.setMode?.('free');
  S.engine.manualTime = true;
  window.__PROP_VIEWS = [
    ['near', 14, 0.6, 5],
    ['side', 20, 1.9, 7],
    ['wide', 46, 2.6, 12],
  ].map(([tag, d, hy, up]) => ({ tag, d, hy, up }));
  window.__PROP_TARGET = t;
  window.__PROP_AIM = (v) => {
    const a = v.d;
    cam.position.set(t.x + a * Math.cos(v.hy), t.y + v.up, t.z + a * Math.sin(v.hy));
    cam.lookAt(t.x, t.y + 3.0, t.z);
    cam.updateProjectionMatrix();
    S.engine.tick(1 / 60);
    S.engine.tick(1 / 60);
  };
  return { meshes: hits.length, instances: pts.length, target: t };
}, FIELD);
console.log(JSON.stringify(info));
if (!info.error) {
  const views = await page.evaluate(() => window.__PROP_VIEWS.map(v => v.tag));
  for (let i = 0; i < views.length; i++) {
    await page.evaluate((k) => window.__PROP_AIM(window.__PROP_VIEWS[k]), i);
    await page.screenshot({ path: path.join(OUT, `${FIELD}-${views[i]}.png`), timeout: 600000 });
    console.log('[prop-preview]', views[i]);
  }
}
await browser.close(); await server.close();
