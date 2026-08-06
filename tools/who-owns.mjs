/**
 * Which mesh owns a region of the frame?
 *
 * Raycasting answers this for a single pixel but misses instanced and skinned
 * geometry, and reading the image only tells you what a thing looks like. This
 * hides each mesh in the rider in turn, re-renders, and reports how much the
 * given screen rectangle changed — so the object responsible for a visible
 * feature is identified by its absence.
 *
 * Reads the canvas back inside the page in the same task as the draw, because
 * page.screenshot() after a mutation returns a stale frame in this harness.
 *
 *   node tools/who-owns.mjs <shot> <x0,y0,x1,y1>
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const shot = process.argv[2] || 'rider-portrait';
const rect = (process.argv[3] || '682,272,750,362').split(',').map(Number);

const server = await createServer({ root: process.cwd(), server: { port: 6403 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerr]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:6403/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });
await page.evaluate(() => window.__SOHO_WORLD_MODELS);

const out = await page.evaluate(async ({ shotName, rect }) => {
  const S = window.__SOHO;
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0, h = y1 - y0;
  const cv = S.engine.renderer.domElement;
  const scratch = document.createElement('canvas');
  scratch.width = w; scratch.height = h;
  const g2 = scratch.getContext('2d', { willReadFrequently: true });
  const grab = () => {
    g2.clearRect(0, 0, w, h);
    g2.drawImage(cv, x0, y0, w, h, 0, 0, w, h);
    return g2.getImageData(0, 0, w, h).data;
  };

  const r = S.ctx.terrain?.getSpawn?.();
  if (r) S.ctx.physics?.reset?.(r.position, r.heading);
  S.shot(shotName);
  // Render with dt = 0 from here on. Every tick(1/60) advances the SIMULATION,
  // so between the base grab and each test grab the rider moves -- with ~30
  // meshes that drift swamps the signal entirely and every mesh reports 100%
  // of the rect changed at saturation. dt = 0 re-renders the same instant.
  S.engine.tick(0);
  const base = grab();

  const meshes = [];
  S.ctx.player.rider.object3D.traverse((o) => {
    if (o.isMesh && o.visible) meshes.push(o);
  });

  const rows = [];
  for (const m of meshes) {
    m.visible = false;
    S.engine.tick(0);
    const g = grab();
    m.visible = true;
    let changed = 0, sum = 0;
    for (let i = 0; i < base.length; i += 4) {
      const d = Math.abs(base[i] - g[i]) + Math.abs(base[i + 1] - g[i + 1]) + Math.abs(base[i + 2] - g[i + 2]);
      if (d > 12) changed++;
      sum += d;
    }
    rows.push({
      name: m.name || `${m.geometry?.type}#${m.id}`,
      skinned: !!m.isSkinnedMesh,
      pctOfRect: +(100 * changed / (w * h)).toFixed(1),
      meanDelta: +(sum / (w * h)).toFixed(1),
    });
  }
  // Re-render clean so nothing is left hidden.
  S.engine.tick(0);
  rows.sort((a, b) => b.pctOfRect - a.pctOfRect);
  return { shot: shotName, rect, meshCount: meshes.length, top: rows.slice(0, 8) };
}, { shotName: shot, rect });
console.log(JSON.stringify(out, null, 1));
await browser.close(); await server.close();
