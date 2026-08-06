/**
 * Does the snow's surface detail fade with distance?
 *
 * ART_DIRECTION lists as tells: "16. Detail that does not fade with distance —
 * sastrugi at 800 m subtends 0.02°, it must be gone", "15. Over-texturing",
 * and "14. A visible tiling period — the wallpaper effect". In `chase-carve`,
 * which is the view a player actually spends the run looking at, the snow
 * fills most of the frame with wind-scour streaks that LOOK like they run at
 * one density from the board to the horizon. That is an impression; this
 * turns it into a number.
 *
 * Method: cut the frame into horizontal bands, measure local RMS contrast in
 * each, and ray-march the heightfield to say how far away each band's ground
 * actually is.
 *
 * WHAT IT FOUND, and it is a negative result: in `chase-carve` the visible
 * heightfield spans only 5 m to 22 m. The impression that the streaks "run at
 * one density from the board to the horizon" was wrong about the geometry —
 * most of what looked like the horizon is twenty metres away, and detail is
 * not supposed to fade appreciably over a 4x change in distance that close.
 * Contrast peaks at 14.6 around 7 m, falls to 8.8 in the nearest band (motion
 * blur, which is intentional) and to 10.3 in the first band beyond the
 * heightfield.
 *
 * KNOWN LIMIT: bands past ~22 m report "sky" because `terrain.sample` returns
 * nothing beyond the heightfield's bounds — that ground is the backdrop
 * ranges, a separate asset with its own detail rules. So this tool cannot yet
 * speak to checklist 16 over the 22 m - 800 m range, which is exactly where
 * that tell actually bites.
 *
 *   node tools/detail-falloff.mjs [shot]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const shot = process.argv[2] || 'chase-carve';
const server = await createServer({ root: process.cwd(), server: { port: 6427 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerr]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:6427/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });

const out = await page.evaluate(async (shotName) => {
  const S = window.__SOHO;
  const W = 1280, H = 720;
  const cv = S.engine.renderer.domElement;
  const sc = document.createElement('canvas');
  sc.width = W; sc.height = H;
  const g2 = sc.getContext('2d', { willReadFrequently: true });

  const r = S.ctx.terrain?.getSpawn?.();
  if (r) S.ctx.physics?.reset?.(r.position, r.heading);
  S.shot(shotName);
  S.engine.tick(0);
  g2.drawImage(cv, 0, 0);
  const d = g2.getImageData(0, 0, W, H).data;
  const luma = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

  // Ground distance per band, by ray-marching the heightfield.
  //
  // The first version of this asserted in its own docstring that screen
  // height is a proxy for distance and then reported bands in PIXELS, which
  // makes any conclusion about "detail per metre" unfalsifiable — the whole
  // question is how fast detail decays with distance, and pixels are not
  // distance. Marching the actual terrain is the difference between a chart
  // and an argument.
  const cam = S.ctx.camera;
  const terr = S.ctx.terrain;
  const groundDistAt = (ndcY) => {
    if (typeof terr.sample !== 'function') return null;
    const v = new (cam.position.constructor)(0, ndcY, 0.5);
    v.unproject(cam);
    v.sub(cam.position).normalize();
    if (v.y >= -1e-4) return null;                 // ray never meets the ground
    let t = 1, prev = cam.position.y - 0;
    for (let i = 0; i < 400; i++) {
      const x = cam.position.x + v.x * t;
      const y = cam.position.y + v.y * t;
      const z = cam.position.z + v.z * t;
      const st = terr.sample(x, z);
      const h = st && Number.isFinite(st.height) ? st.height : null;
      if (h == null) return null;
      if (y <= h) return +t.toFixed(0);
      t *= 1.06;                                    // geometric march
      if (t > 20000) return null;
    }
    return null;
  };
  const bands = [];
  const N = 9;
  const bandH = Math.floor(H / N);
  const WIN = 8;      // local window for RMS contrast
  for (let b = 0; b < N; b++) {
    const y0 = b * bandH, y1 = y0 + bandH;
    let sum = 0, n = 0, meanSum = 0, meanN = 0;
    for (let y = y0; y + WIN < y1; y += WIN) {
      for (let x = 0; x + WIN < W; x += WIN) {
        let s = 0, s2 = 0;
        for (let j = 0; j < WIN; j++) {
          for (let i = 0; i < WIN; i++) {
            const v = luma(((y + j) * W + (x + i)) * 4);
            s += v; s2 += v * v;
          }
        }
        const cnt = WIN * WIN;
        const mean = s / cnt;
        const varc = Math.max(0, s2 / cnt - mean * mean);
        // Skip windows that are mostly sky: they have no surface detail and
        // would drag the far bands to zero for the wrong reason.
        if (mean > 60) { sum += Math.sqrt(varc); n++; }
        meanSum += mean; meanN++;
      }
    }
    const ndcY = 1 - 2 * ((y0 + bandH * 0.5) / H);
    bands.push({
      band: b,
      yTop: y0,
      groundMetres: groundDistAt(ndcY),
      localRMS: n ? +(sum / n).toFixed(2) : null,
      meanLuma: +(meanSum / Math.max(1, meanN)).toFixed(1),
      windows: n,
    });
  }
  return { shot: shotName, camY: +cam.position.y.toFixed(1), bands };
}, shot);

console.log(`shot ${out.shot}`);
console.log('band  yTop  ground_m  localRMS  meanLuma');
for (const b of out.bands) {
  const bar = b.localRMS == null ? '' : '#'.repeat(Math.round(b.localRMS));
  console.log(`  ${b.band}  ${String(b.yTop).padStart(4)}  ${String(b.groundMetres ?? 'sky').padStart(8)}  ${String(b.localRMS).padStart(7)}  ${String(b.meanLuma).padStart(7)}  ${bar}`);
}
await browser.close(); await server.close();
