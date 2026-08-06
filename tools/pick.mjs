/**
 * What is at this pixel?
 *
 * Reproduces a named shot's camera, then raycasts through given pixel
 * coordinates and reports the object each ray hits, with its distance and
 * world position. Toggling a suspect object's visibility and re-screenshotting
 * does not work here -- page.screenshot() after shot() returns a stale frame,
 * which is a documented dead end in this repo -- so identification has to come
 * from the scene graph rather than from the image.
 *
 *   node tools/pick.mjs <shot> <x,y> [<x,y> ...]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const shotName = process.argv[2] || 'valley-vista';
const pts = process.argv.slice(3).map((s) => s.split(',').map(Number));
if (!pts.length) pts.push([50, 167]);

const server = await createServer({ root: process.cwd(), server: { port: 6396 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerr]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:6396/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });
await page.evaluate(() => window.__SOHO_WORLD_MODELS);

const out = await page.evaluate(async ({ shotName, pts }) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { SHOTS } = await import('/src/core/shots.js');
  const S = window.__SOHO;
  const shot = SHOTS.find((s) => s.name === shotName);
  if (!shot) return { error: `no shot ${shotName}` };
  shot.prepare?.(S.ctx);
  for (let i = 0; i < 60; i++) S.engine.tick(1 / 60);
  shot.apply(S.ctx);
  const cam = S.ctx.camera;
  cam.updateMatrixWorld(true);

  const rc = new THREE.Raycaster();
  rc.far = 1e6;
  const rows = [];
  for (const [px, py] of pts) {
    // NDC from pixel coords on a 1280x720 frame.
    const ndc = new THREE.Vector2((px / 1280) * 2 - 1, -((py / 720) * 2 - 1));
    rc.setFromCamera(ndc, cam);
    const hits = rc.intersectObject(S.ctx.scene, true).filter((h) => {
      let n = h.object;
      while (n) { if (n.visible === false) return false; n = n.parent; }
      return true;
    });
    rows.push({
      px, py,
      hits: hits.slice(0, 4).map((h) => {
        // Name the nearest NAMED ancestor -- most meshes inside a loaded GLB
        // are anonymous, so the mesh's own name says nothing.
        let named = h.object, guard = 0;
        while (named && !named.name && guard++ < 20) named = named.parent;
        return {
          obj: h.object.name || h.object.type,
          group: named?.name || '(unnamed)',
          dist: Math.round(h.distance),
          y: Math.round(h.point.y),
          mat: h.object.material?.type,
        };
      }),
    });
  }
  return { cam: [cam.position.x, cam.position.y, cam.position.z].map(Math.round), rows };
}, { shotName, pts });
console.log(JSON.stringify(out, null, 1));
await browser.close(); await server.close();
