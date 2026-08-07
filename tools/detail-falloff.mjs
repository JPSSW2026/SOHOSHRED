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
// --no-grain zeroes the film grain before measuring. Grain doubles as the
// 8-bit dither in this pipeline, so it is a floor under every rms8 reading;
// without knowing that floor a small number cannot be told from no signal.
const NOGRAIN = process.argv.includes('--no-grain');
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

const out = await page.evaluate(async ({ shotName, noGrain }) => {
  const S = window.__SOHO;
  const W = 1280, H = 720;
  const cv = S.engine.renderer.domElement;
  const sc = document.createElement('canvas');
  sc.width = W; sc.height = H;
  const g2 = sc.getContext('2d', { willReadFrequently: true });

  const r = S.ctx.terrain?.getSpawn?.();
  if (r) S.ctx.physics?.reset?.(r.position, r.heading);
  S.shot(shotName);
  if (noGrain) {
    // The grain uniform lives on a composer PASS, not on ctx.fx -- ctx.fx is
    // the particle system. The first version of this switch set nothing at
    // all, and the two runs came back identical to 0.02, which read as
    // "grain is free" when it actually meant "the switch missed".
    // Set the CONFIG, not the uniform.
    //
    // Writing p.uniforms.uGrain = 0 directly changed nothing, twice, because
    // the postprocess update re-derives that uniform from config on every
    // tick and the render that matters happens after it. Same shape as the
    // input-vs-physics bug earlier in this project: write a value, the
    // system's own update overwrites it before the frame you measure.
    const cfg = S.ctx.config || S.ctx.CONFIG;
    if (!cfg?.post?.grain) throw new Error('no post.grain in config');
    cfg.post.grain.enabled = false;
  }
  S.engine.tick(0);
  g2.drawImage(cv, 0, 0);
  const d = g2.getImageData(0, 0, W, H).data;
  const luma = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

  // Ground distance per band, by raycasting the WHOLE SCENE.
  //
  // This marched the heightfield at first, which meant it went blind past
  // ~22 m: `terrain.sample` returns nothing beyond the heightfield's bounds,
  // and everything further away is the backdrop ranges, a separate asset. So
  // the tool could not speak to checklist 16 over 22 m - 800 m, which is
  // exactly the range where "detail that does not fade with distance" bites.
  //
  // A Raycaster against the scene handles heightfield, backdrop and props
  // uniformly. The sky dome, clouds and the particle systems have to be
  // skipped or the first hit is always the inside of the sky at its own
  // radius.
  const cam = S.ctx.camera;
  // The rider has to be skipped too: this is a CHASE camera, so for the
  // bottom third of the frame the first thing on the ray is the board and the
  // figure. Without it the near bands reported 1 m, which is the rider's back,
  // not the ground.
  const SKIP = /sky|cloud|atmo|plume|spray|rider|board|deck/i;
  const riderRoot = S.ctx.player?.rider?.object3D;
  const ray = new (await import('/node_modules/three/build/three.module.js')).Raycaster();
  ray.far = 30000;
  const V2 = { x: 0, y: 0 };
  const groundDistAt = (ndcY) => {
    V2.x = 0; V2.y = ndcY;
    ray.setFromCamera(V2, cam);
    const hits = ray.intersectObject(S.ctx.scene, true);
    for (const h of hits) {
      // GROUND IS A MESH. Filtering by name alone was not enough: the first
      // hit on every band came back as `Points`, which is the ambient
      // snowfall pool drifting a metre in front of the lens. Points and
      // Sprites are never the surface we are measuring, so require a Mesh
      // before anything else — that is a property of what the thing IS,
      // rather than of what someone remembered to name it.
      if (!h.object.isMesh) continue;
      let o = h.object, skip = false;
      // Walk up: a mesh's own name is often generic, the group's is not.
      while (o) {
        if (SKIP.test(o.name || '') || o === riderRoot) { skip = true; break; }
        o = o.parent;
      }
      if (!skip && h.distance > 0.5) {
        return { m: +h.distance.toFixed(0), hit: h.object.name || h.object.type };
      }
    }
    return null;
  };
  const bands = [];
  const N = 9;
  const bandH = Math.floor(H / N);
  // TWO SCALES, because one is not interpretable.
  //
  // RMS over a single small window measures everything in the band, not just
  // surface texture: at 250-770 m a basin shot's bands are full of
  // ridgelines, shadowed gullies and the lift line, which are large-scale
  // structure and entirely desirable. Measured that way, contrast RISES with
  // distance in both wide shots, which looks like checklist 16 failing and
  // is really just silhouette structure being counted as texture.
  //
  // Fine texture contributes to the SMALL window and not much to the large
  // one; a ridgeline contributes to both. So the ratio separates them: high
  // means fine-grained detail, near 1 means the band's contrast is all
  // large-scale form.
  const WIN = 8;
  const WIDE = 32;
  for (let b = 0; b < N; b++) {
    const y0 = b * bandH, y1 = y0 + bandH;
    const rmsOver = (win) => {
      let sum = 0, n = 0;
      for (let y = y0; y + win < y1; y += win) {
        for (let x = 0; x + win < W; x += win) {
          let s = 0, s2 = 0;
          for (let j = 0; j < win; j++) {
            for (let i = 0; i < win; i++) {
              const v = luma(((y + j) * W + (x + i)) * 4);
              s += v; s2 += v * v;
            }
          }
          const cnt = win * win;
          const mean = s / cnt;
          const varc = Math.max(0, s2 / cnt - mean * mean);
          // Skip windows that are mostly sky: no surface detail there, and
          // they would drag the far bands down for the wrong reason.
          if (mean > 60) { sum += Math.sqrt(varc); n++; }
        }
      }
      return n ? sum / n : null;
    };
    let meanSum = 0, meanN = 0;
    for (let y = y0; y < y1; y += 4) {
      for (let x = 0; x < W; x += 4) { meanSum += luma((y * W + x) * 4); meanN++; }
    }
    const rmsFine = rmsOver(WIN);
    const rmsWide = rmsOver(WIDE);
    const sum = rmsFine, n = rmsFine == null ? 0 : 1;
    const ndcY = 1 - 2 * ((y0 + bandH * 0.5) / H);
    bands.push({
      band: b,
      yTop: y0,
      ground: groundDistAt(ndcY),
      rmsFine: rmsFine == null ? null : +rmsFine.toFixed(2),
      rmsWide: rmsWide == null ? null : +rmsWide.toFixed(2),
      fineRatio: (rmsFine && rmsWide) ? +(rmsFine / rmsWide).toFixed(3) : null,
      meanLuma: +(meanSum / Math.max(1, meanN)).toFixed(1),
    });
  }
  return { shot: shotName, camY: +cam.position.y.toFixed(1), bands };
}, { shotName: shot, noGrain: NOGRAIN });

console.log(`shot ${out.shot}${NOGRAIN ? '  [grain OFF]' : ''}`);
console.log('band  ground_m  rms8   rms32  fine/wide  first hit');
for (const b of out.bands) {
  const m = b.ground ? b.ground.m : 'none';
  const hit = b.ground ? b.ground.hit : '-';
  const bar = b.fineRatio == null ? '' : '#'.repeat(Math.round(b.fineRatio * 20));
  console.log(`  ${b.band}  ${String(m).padStart(8)}  ${String(b.rmsFine).padStart(5)}  ${String(b.rmsWide).padStart(5)}  ${String(b.fineRatio).padStart(9)}  ${String(hit).padEnd(14)} ${bar}`);
}
await browser.close(); await server.close();
