/**
 * Does the game RUN?
 *
 * Every instrument in this directory drives the engine through `S.shot()` and
 * `engine.tick()` with `manualTime` on — a mode no player is ever in. Nothing
 * has ever checked the thing a player actually does: load the page, let
 * requestAnimationFrame drive it, hold the controls down for a while.
 *
 * That leaves a whole class of defect unobserved — console errors that only
 * fire on the rAF path, NaN leaking into physics state, listeners or pools
 * growing without bound, a frame budget blown by one system. None of those
 * would show up in a still, and all of them matter more to "playability" than
 * any pixel statistic.
 *
 * WHAT IS AND IS NOT TRANSFERABLE. This runs on SwiftShader, a software
 * rasteriser, so absolute frame times say nothing about real hardware and are
 * NOT reported as if they did. What does transfer:
 *
 *   · errors and unhandled rejections           — real, hardware-independent
 *   · NaN / non-finite in simulation state      — real
 *   · unbounded growth in object or JS heap     — real
 *   · the SHARE of CPU time each system takes   — roughly real, since it is
 *     JS-side work, not rasterisation
 *
 *   node tools/playability.mjs [seconds]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const SECONDS = Number(process.argv[2] || 25);
// Viewport. This harness needs FRAMES, not pixels: at 1280x720 a 45 s run
// stepped 22 frames -- enough to say "no errors", nowhere near enough to say
// "no leak".
//
// Cutting to 400x225, a TENTH of the pixels, bought 35 frames instead of 22.
// So frame cost here is NOT dominated by rasterisation, and resolution is not
// the lever it looks like -- worth knowing before anyone else tries to make
// one of these harnesses faster the same way. Whatever the real cost is
// (fixed-size post buffers, shadow passes, scene traversal) it is close to
// resolution-independent.
const VW = Number(process.argv[3] || 400);
const VH = Math.round(VW * 9 / 16);

const server = await createServer({ root: process.cwd(), server: { port: 6433 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: VW, height: VH } });
page.setDefaultTimeout(900000);

const errors = [];
page.on('pageerror', (e) => errors.push({ kind: 'pageerror', text: String(e).slice(0, 300) }));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push({ kind: 'console.error', text: m.text().slice(0, 300) });
});

await page.goto('http://127.0.0.1:6433/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });

// Hand control back to requestAnimationFrame. The harness leaves manualTime
// set; a player never has it set.
await page.evaluate(() => { window.__SOHO.engine.manualTime = false; });

const before = await page.evaluate(() => ({
  objects: (() => { let n = 0; window.__SOHO.ctx.scene.traverse(() => n++); return n; })(),
  heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
  geometries: window.__SOHO.engine.renderer.info.memory.geometries,
  textures: window.__SOHO.engine.renderer.info.memory.textures,
}));

// Hold real controls down, the way a player does — through the keyboard, not
// by writing to physics. Whether the input path itself works is part of what
// is being tested.
await page.evaluate(() => { window.__SOHO.ctx.flow?.skip?.(); });
const keys = ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'Space'];
const t0 = Date.now();
let k = 0;
// SAMPLE THE TREND, not just the endpoints.
//
// Two samples cannot tell lazy initialisation from a leak: both show "it went
// up". A series can — lazy init is asymptotic, a leak is linear in frames.
const series = [];
const sample = async () => {
  const s = await page.evaluate(() => {
    let objects = 0;
    window.__SOHO.ctx.scene.traverse(() => objects++);
    return {
      t: +((Date.now() - window.__SOHO_T0) / 1000).toFixed(1),
      frame: window.__SOHO.ctx.frame,
      objects,
      geometries: window.__SOHO.engine.renderer.info.memory.geometries,
      textures: window.__SOHO.engine.renderer.info.memory.textures,
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    };
  });
  series.push(s);
};
await page.evaluate(() => { window.__SOHO_T0 = Date.now(); });
await sample();
let nextSample = 5000;
while (Date.now() - t0 < SECONDS * 1000) {
  const key = keys[k++ % keys.length];
  await page.keyboard.down(key);
  await page.waitForTimeout(700);
  await page.keyboard.up(key);
  await page.waitForTimeout(200);
  if (Date.now() - t0 > nextSample) { await sample(); nextSample += 5000; }
}
await sample();

const after = await page.evaluate(({ }) => {
  const S = window.__SOHO;
  const st = S.ctx.physics?.state || {};
  const bad = [];
  const check = (path, v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) bad.push(path);
    else if (v && typeof v === 'object' && 'x' in v) {
      for (const c of ['x', 'y', 'z']) if (!Number.isFinite(v[c])) bad.push(`${path}.${c}`);
    }
  };
  for (const key of Object.keys(st)) check(`physics.${key}`, st[key]);
  const rider = S.ctx.player?.rider;
  if (rider?.bones) {
    for (const [n, b] of Object.entries(rider.bones)) {
      if (b?.position) check(`bone.${n}.position`, b.position);
      if (b?.rotation) for (const c of ['x', 'y', 'z']) {
        if (!Number.isFinite(b.rotation[c])) bad.push(`bone.${n}.rotation.${c}`);
      }
    }
  }
  let objects = 0;
  S.ctx.scene.traverse(() => objects++);
  return {
    nonFinite: bad.slice(0, 20),
    nonFiniteCount: bad.length,
    objects,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    geometries: S.engine.renderer.info.memory.geometries,
    textures: S.engine.renderer.info.memory.textures,
    drawCalls: S.engine.renderer.info.render.calls,
    triangles: S.engine.renderer.info.render.triangles,
    frame: S.ctx.frame,
    elapsed: +(S.ctx.elapsed ?? 0).toFixed(1),
    speed: +((S.ctx.physics?.state?.speed) ?? 0).toFixed(2),
    // Props keeps its own per-phase timings; anything else exposing one is
    // reported too rather than assumed absent.
    propTimings: S.ctx.props?._timings ?? null,
  };
}, {});

const fps = after.frame && after.elapsed ? +(after.frame / after.elapsed).toFixed(1) : null;
console.log(JSON.stringify({
  seconds: SECONDS,
  viewport: `${VW}x${VH}`,
  ranUnderRAF: true,
  errors: errors.slice(0, 12),
  errorCount: errors.length,
  simulation: {
    framesStepped: after.frame,
    simSecondsElapsed: after.elapsed,
    meanStepsPerSimSecond: fps,
    finalSpeed: after.speed,
    nonFiniteCount: after.nonFiniteCount,
    nonFinite: after.nonFinite,
  },
  growth: {
    objects: `${before.objects} -> ${after.objects}`,
    geometries: `${before.geometries} -> ${after.geometries}`,
    textures: `${before.textures} -> ${after.textures}`,
    heapMB: before.heapMB == null ? 'unavailable' : `${before.heapMB} -> ${after.heapMB}`,
  },
  lastFrame: { drawCalls: after.drawCalls, triangles: after.triangles },
  series,
}, null, 1));
await browser.close(); await server.close();
