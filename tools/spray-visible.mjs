/**
 * Do the spray particles actually reach the rendered frame?
 *
 * Everything measurable on the CPU says they should: at the moment
 * close-spray composes there are ~1900 live sprites, ~445 on screen at a
 * median 5.6 m, 107 of them 16-42 cm puffs, mean alpha 0.70. The captured PNG
 * shows a handful of specks. Either the render drops them or the capture does.
 *
 * This settles it WITHOUT page.screenshot(), which is already known to return
 * a stale frame in this harness. It renders the shot, reads the canvas back
 * inside the page in the same task as the draw (so the drawing buffer is
 * still valid), hides fx.dynamic.points, renders again, reads again, and
 * diffs. Particles that reach the frame must change pixels when removed.
 *
 *   node tools/spray-visible.mjs [shot]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const shot = process.argv[2] || 'close-spray';
const server = await createServer({ root: process.cwd(), server: { port: 6401 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerr]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:6401/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });
await page.evaluate(() => window.__SOHO_WORLD_MODELS);

const out = await page.evaluate(async (shotName) => {
  const S = window.__SOHO;
  const fx = S.ctx.fx;
  const cv = S.engine.renderer.domElement;

  // Read the WebGL canvas back through a 2D canvas. Must happen in the same
  // task as the draw call: with preserveDrawingBuffer false the buffer is
  // valid until the compositor runs, and an await here would lose it.
  const scratch = document.createElement('canvas');
  scratch.width = 320; scratch.height = 180;
  const g2 = scratch.getContext('2d', { willReadFrequently: true });
  const grab = () => {
    g2.clearRect(0, 0, 320, 180);
    g2.drawImage(cv, 0, 0, 320, 180);
    return g2.getImageData(0, 0, 320, 180).data;
  };

  const r = S.ctx.terrain?.getSpawn?.();
  if (r) S.ctx.physics?.reset?.(r.position, r.heading);
  S.shot(shotName);

  const live = (() => {
    const p = fx.dynamic, P = p.params, now = fx._time;
    let n = 0;
    for (let i = 0; i < p.max; i++) if (P[i * 4 + 1] > 0 && P[i * 4] + P[i * 4 + 1] > now) n++;
    return n;
  })();

  // WITH particles: draw one frame and read it straight back.
  S.engine.tick(1 / 60);
  const a = grab();

  // WITHOUT: same camera, same sim step size, dynamic pool hidden.
  fx.dynamic.points.visible = false;
  S.engine.tick(1 / 60);
  const b = grab();
  fx.dynamic.points.visible = true;

  // And a control: hide the RIDER instead. If removing an object that is
  // unquestionably in frame also changes nothing, the readback is what is
  // broken, not the particles -- so this distinguishes the two.
  const rider = S.ctx.player.rider.object3D;
  rider.visible = false;
  S.engine.tick(1 / 60);
  const c = grab();
  rider.visible = true;

  const diff = (x, y) => {
    let changed = 0, sum = 0;
    for (let i = 0; i < x.length; i += 4) {
      const d = Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]);
      if (d > 12) changed++;
      sum += d;
    }
    const px = x.length / 4;
    return { pctChanged: +(100 * changed / px).toFixed(2), meanDelta: +(sum / px).toFixed(2) };
  };

  // Save both frames at full size so the spray's actual contribution can be
  // LOOKED at, not just measured. Readback again at full resolution, in the
  // same task as each draw.
  const big = document.createElement('canvas');
  big.width = 1280; big.height = 720;
  const gb = big.getContext('2d');
  const shotPng = () => { gb.clearRect(0, 0, 1280, 720); gb.drawImage(cv, 0, 0); return big.toDataURL('image/png'); };
  S.engine.tick(1 / 60);
  const pngWith = shotPng();
  fx.dynamic.points.visible = false;
  S.engine.tick(1 / 60);
  const pngWithout = shotPng();
  fx.dynamic.points.visible = true;

  return {
    pngWith, pngWithout,
    shot: shotName,
    liveParticlesAtCapture: live,
    removingSpray: diff(a, b),
    removingRider_control: diff(a, c),
  };
}, shot);
import { writeFile, mkdir } from 'node:fs/promises';
await mkdir('shots/spray', { recursive: true });
for (const [k, f] of [['pngWith', 'with-spray.png'], ['pngWithout', 'without-spray.png']]) {
  await writeFile('shots/spray/' + f, Buffer.from(out[k].split(',')[1], 'base64'));
  delete out[k];
}
console.log(JSON.stringify(out, null, 1));
await browser.close(); await server.close();
