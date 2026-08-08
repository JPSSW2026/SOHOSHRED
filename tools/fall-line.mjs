/**
 * Zero input, straight down the fall line — does the rider STALL, or run?
 *
 * `playtest.mjs` drives a deliberately lazy S-turn, which scrubs speed by
 * design. So when it reports `stoppedPct` 5.5-11.7% and a median of 4.5-5.5 m/s
 * there is no way to tell a physics stall from the policy doing its job. This
 * removes the policy: neutral input, no steering, no pops, just gravity and the
 * terrain, so anything that goes wrong belongs to the physics.
 *
 * WHAT IT FOUND (R41): nothing wrong. Over 120 s from the default spawn —
 * stopped 0%, crashed 0%, peak 79.7 km/h, settling to 25-50. The low numbers in
 * playtest are the S-turn, as intended, and the stall hypothesis is dead.
 *
 * Two things it did establish, both design facts rather than defects:
 *   · a straight-line descent covers 950 m in 120 s and is STILL 350 m from the
 *     finish at z=-560, so a full run is ~2.5 min at minimum and longer for
 *     anyone actually carving
 *   · there is a slow section around z=-160 where speed dips to ~10 km/h before
 *     recovering — the only place on the mountain that comes close to stalling
 *
 *   node tools/fall-line.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), server: { port: 6461 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.setDefaultTimeout(900000);
await page.goto('http://127.0.0.1:6461/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });
const out = await page.evaluate(async () => {
  const S = window.__SOHO, dt = 1/60;
  const sp = S.ctx.terrain.getSpawn();
  S.ctx.physics.reset(sp.position, sp.heading);
  S.engine.manualTime = true;
  const inp = S.ctx.input || S.ctx.controls;
  const st = () => S.ctx.physics.state;
  const samples = [], NEUTRAL = { steer:0, lean:0, crouch:0.2, pop:false, spin:0, flip:0, grab:null, tuck:false, brake:0, reset:false };
  let stopped = 0, crashed = 0;
  for (let i = 0; i < 60 * 120; i++) {
    S.ctx.physics.applyInput(NEUTRAL);
    if (inp) inp.enabled = false;
    S.engine.tick(dt, false);
    const s = st();
    if ((s.speed||0) < 1.0) stopped++;
    if (s.crashed) crashed++;
    if (i % 300 === 0) samples.push({ t: +(i*dt).toFixed(0), z: +s.position.z.toFixed(0),
      kmh: +((s.speed||0)*3.6).toFixed(1), grounded: !!s.grounded, crashed: !!s.crashed });
  }
  const s = st();
  return { samples, stoppedPct: +(100*stopped/(60*120)).toFixed(1),
    crashedPct: +(100*crashed/(60*120)).toFixed(1), endZ: +s.position.z.toFixed(0),
    finishZ: -560, distanceToFinish: +(s.position.z - (-560)).toFixed(0) };
});
console.log(`stopped ${out.stoppedPct}%  crashed ${out.crashedPct}%  endZ ${out.endZ}  (finish z=-560, ${out.distanceToFinish} m to go)`);
console.log('  t(s)    z    km/h  grounded crashed');
for (const s of out.samples) console.log(`  ${String(s.t).padStart(4)} ${String(s.z).padStart(5)} ${String(s.kmh).padStart(7)}  ${s.grounded?'  y':'  n'}    ${s.crashed?'Y':'.'}`);
await browser.close(); await server.close();
