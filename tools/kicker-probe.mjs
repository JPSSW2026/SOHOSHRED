/**
 * Do the course's kickers get HIT, and do they reach the bail thresholds?
 *
 * R42 measured 82 landings under playtest's lazy S-turn, found a maximum
 * closing speed of 9.01 m/s against thresholds of 10.08 / 17.5, and concluded
 * the impact tiers were "nearly 2x out of reach". That conclusion was scoped to
 * one policy and should not have been stated generally — see below.
 *
 * WHAT IT FOUND (R43), two things:
 *
 * 1. THE KICKERS ARE MISSED. Closest approach 35 m, 66 m, 82 m to the three
 *    lips. They are stamped by walking the GRADIENT of the built surface, but a
 *    rider carries momentum and edge and does not follow a gradient walk, so
 *    "the rider rides over them by construction" is false. Whether a deliberate
 *    lip hit reaches the thresholds is STILL untested; it needs a policy that
 *    steers at a station rather than one that trusts the fall line.
 *
 * 2. R42's HEADLINE WAS TOO STRONG. This run peaked at 16.62 m/s — within 5% of
 *    CRASH_LANDING (17.5) and comfortably past marginalDrop (10.08), which it
 *    cleared once. So the impact tiers are near-reachable, not out of reach.
 *    What is true is narrower: they essentially never fire during ordinary
 *    turning play, because turning scrubs the speed that makes a hard landing.
 *
 * The two probes measure different regimes and both are needed: playtest gets
 * many landings at low energy, this gets few landings at high energy.
 *
 *   node tools/kicker-probe.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), server: { port: 6463 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.setDefaultTimeout(900000);
await page.goto('http://127.0.0.1:6463/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });
const out = await page.evaluate(async () => {
  const S = window.__SOHO, dt = 1/60, T = S.ctx.terrain, ph = S.ctx.physics;
  const kickers = (T.kickers || []).map(k => ({ x: +k.x.toFixed(0), z: +k.z.toFixed(0) }));
  const impacts = [], airs = [];
  const orig = ph.postRender.bind(ph);
  ph.postRender = (...a) => {
    const li = ph.state.landingImpact || 0;
    if (li > 0) impacts.push(+li.toFixed(2));
    return orig(...a);
  };
  const sp = T.getSpawn(); ph.reset(sp.position, sp.heading);
  S.engine.manualTime = true;
  const inp = S.ctx.input || S.ctx.controls;
  const NEUTRAL = { steer:0, lean:0, crouch:0.2, pop:false, spin:0, flip:0, grab:null, tuck:false, brake:0, reset:false };
  let prevAir = 0, maxAir = 0, nearest = kickers.map(() => 1e9);
  for (let i = 0; i < 60 * 150; i++) {
    ph.applyInput(NEUTRAL);
    if (inp) inp.enabled = false;
    S.engine.tick(dt, false);
    const s = ph.state;
    const at = s.airTime || 0;
    if (at > maxAir) maxAir = at;
    if (prevAir > 0.25 && at === 0) airs.push(+prevAir.toFixed(2));
    prevAir = at;
    kickers.forEach((k, j) => {
      const d = Math.hypot(s.position.x - k.x, s.position.z - k.z);
      if (d < nearest[j]) nearest[j] = d;
    });
  }
  impacts.sort((a,b)=>a-b); airs.sort((a,b)=>a-b);
  const q = (v,f) => v.length ? v[Math.floor(f*(v.length-1))] : null;
  return { kickers, nearest: nearest.map(d => +d.toFixed(0)),
    landings: impacts.length, median: q(impacts,0.5), p90: q(impacts,0.9), max: q(impacts,1),
    over9: impacts.filter(x=>x>9).length, over10: impacts.filter(x=>x>10.08).length,
    over175: impacts.filter(x=>x>17.5).length,
    airCount: airs.length, maxAirTime: +maxAir.toFixed(2), longestAirs: airs.slice(-5) };
});
console.log(`kickers on the fall line: ${out.kickers.length}`);
out.kickers.forEach((k,i)=>console.log(`  #${i} at (${k.x},${k.z})  closest approach ${out.nearest[i]} m`));
console.log(`\nlandings ${out.landings}  median ${out.median}  p90 ${out.p90}  max ${out.max}`);
console.log(`  >9.0 ${out.over9}   >10.08 (marginalDrop) ${out.over10}   >17.5 (CRASH) ${out.over175}`);
console.log(`airs >0.25s: ${out.airCount}, maxAirTime ${out.maxAirTime}s, longest ${out.longestAirs.join(', ')}`);
await browser.close(); await server.close();
