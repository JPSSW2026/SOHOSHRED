/**
 * Steer AT each kicker; does a deliberate lip hit reach the bail thresholds?
 *
 * This is the measurement R42 asked for and R43 failed to achieve. R43 rode the
 * fall line with zero input on the assumption that kickers stamped along the
 * gradient would be passed over; they were missed by 35-82 m, because a rider
 * carries momentum and edge and does not track a gradient walk.
 *
 * The steer sign convention is not documented, so this DETERMINES it rather
 * than guessing: it runs the identical policy at +1 and -1 and reports both.
 *
 * WHAT IT FOUND (R44):
 *
 *   steer +1   closest approach 0 / 0 / 0 m    landing 12.15 m/s   >10.08: yes
 *   steer -1   closest approach 163/237/317 m  no landings
 *
 * So the lips ARE hittable — dead centre on all three — and a deliberate hit
 * lands at 12.15 m/s, clearing marginalDrop (10.08). The impact tier fires when
 * the course is ridden as designed. R43's "the kickers are missed" was a
 * property of not steering, not of their placement, which is fine.
 *
 * Full picture across three policies, none of which alone characterises it:
 *
 *   lazy S-turn (playtest)   82 landings   max  9.01   no impact tier fires
 *   straight fall line       2  landings   max 16.62   marginalDrop cleared
 *   aimed at the kickers     1  landing    max 12.15   marginalDrop cleared
 *
 * CRASH_LANDING (17.5) remains unreached, though 16.62 came within 5%.
 *
 *   node tools/kicker-aim.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), server: { port: 6465 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.setDefaultTimeout(900000);
await page.goto('http://127.0.0.1:6465/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });
const out = await page.evaluate(async () => {
  const S = window.__SOHO, dt = 1/60, T = S.ctx.terrain, ph = S.ctx.physics;
  const kickers = (T.kickers || []).map(k => ({ x: k.x, z: k.z }));
  const inp = S.ctx.input || S.ctx.controls;
  const wrap = (a) => { while (a > Math.PI) a -= 2*Math.PI; while (a < -Math.PI) a += 2*Math.PI; return a; };

  // The steer sign convention is not documented here, so DETERMINE it: run the
  // same policy with +1 and -1 and keep whichever actually closes the distance.
  const trial = async (sign, gain) => {
    const impacts = [];
    const orig = ph.postRender.bind(ph);
    ph.postRender = (...a) => { const li = ph.state.landingImpact || 0; if (li > 0) impacts.push(+li.toFixed(2)); return orig(...a); };
    const sp = T.getSpawn(); ph.reset(sp.position, sp.heading);
    S.engine.manualTime = true;
    const nearest = kickers.map(() => 1e9);
    let target = 0, maxAir = 0;
    for (let i = 0; i < 60 * 150; i++) {
      const s = ph.state;
      while (target < kickers.length - 1 && s.position.z < kickers[target].z) target++;
      const k = kickers[target];
      const desired = Math.atan2(k.x - s.position.x, k.z - s.position.z);
      const err = wrap(desired - (s.heading || 0));
      ph.applyInput({ steer: Math.max(-1, Math.min(1, sign * err * gain)), lean: 0, crouch: 0.15,
        pop: false, spin: 0, flip: 0, grab: null, tuck: false, brake: 0, reset: false });
      if (inp) inp.enabled = false;
      S.engine.tick(dt, false);
      if ((s.airTime||0) > maxAir) maxAir = s.airTime;
      kickers.forEach((kk, j) => { const d = Math.hypot(s.position.x - kk.x, s.position.z - kk.z); if (d < nearest[j]) nearest[j] = d; });
    }
    ph.postRender = orig;
    impacts.sort((a,b)=>a-b);
    const q = (f) => impacts.length ? impacts[Math.floor(f*(impacts.length-1))] : null;
    return { sign, nearest: nearest.map(d=>+d.toFixed(0)), landings: impacts.length,
      median: q(0.5), max: q(1), over10: impacts.filter(x=>x>10.08).length,
      over175: impacts.filter(x=>x>17.5).length, maxAirTime: +maxAir.toFixed(2) };
  };
  const a = await trial(1, 1.6), b = await trial(-1, 1.6);
  return { kickers: kickers.map(k=>({x:+k.x.toFixed(0),z:+k.z.toFixed(0)})), trials: [a, b] };
});
console.log(`kickers: ${out.kickers.map(k=>`(${k.x},${k.z})`).join(' ')}`);
for (const t of out.trials) {
  console.log(`\nsteer sign ${t.sign > 0 ? '+' : '-'}1:  closest approach ${t.nearest.join(' / ')} m`);
  console.log(`  landings ${t.landings}  median ${t.median}  max ${t.max}  >10.08 ${t.over10}  >17.5 ${t.over175}  maxAir ${t.maxAirTime}s`);
}
await browser.close(); await server.close();
