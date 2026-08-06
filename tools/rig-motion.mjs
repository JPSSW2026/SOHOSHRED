/**
 * How much does each bone actually MOVE during a run?
 *
 * "The arms are rigid" is a claim about animation, not geometry, and no tool
 * here measured animation. This drives the course the way playtest.mjs does
 * and records every rig bone's local rotation over the run, reporting the
 * angular RANGE each joint sweeps. A joint whose range is a couple of degrees
 * is decoration; a limb whose joints are all near zero is a stick.
 *
 *   node tools/rig-motion.mjs [seconds]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const SECONDS = Number(process.argv[2] || 30);

const server = await createServer({ root: process.cwd(), server: { port: 6407 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerr]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:6407/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });

const out = await page.evaluate(async (SECONDS) => {
  const S = window.__SOHO;
  const dt = 1 / 60;
  const rider = S.ctx.player.rider;
  const B = rider.bones;
  const spawn = S.ctx.terrain?.getSpawn?.();
  if (spawn) S.ctx.physics?.reset?.(spawn.position, spawn.heading);
  S.engine.manualTime = true;
  if (S.ctx.input) S.ctx.input.enabled = false;

  const names = Object.keys(B).filter((k) => B[k] && B[k].isObject3D);
  const acc = {};
  for (const n of names) acc[n] = { x: [], y: [], z: [] };

  let phase = 0;
  const n = Math.round(SECONDS / dt);
  for (let i = 0; i < n; i++) {
    phase += dt;
    S.ctx.physics.applyInput({
      steer: Math.sin(phase * 0.55) * 0.75,
      lean: Math.sin(phase * 0.31) * 0.5,
      crouch: 0.35 + 0.25 * Math.sin(phase * 1.1),
      pop: (i % 240) === 0 && i > 0,
      spin: 0, flip: 0, grab: null, tuck: false, brake: 0, reset: false,
    });
    S.engine.tick(dt, false);
    for (const nm of names) {
      const r = B[nm].rotation;
      acc[nm].x.push(r.x); acc[nm].y.push(r.y); acc[nm].z.push(r.z);
    }
  }

  const deg = (v) => v * 180 / Math.PI;
  const rows = [];
  for (const nm of names) {
    const a = acc[nm];
    const rng = (arr) => deg(Math.max(...arr) - Math.min(...arr));
    const sweep = Math.max(rng(a.x), rng(a.y), rng(a.z));
    rows.push({
      bone: nm,
      sweepDeg: +sweep.toFixed(1),
      xDeg: +rng(a.x).toFixed(1), yDeg: +rng(a.y).toFixed(1), zDeg: +rng(a.z).toFixed(1),
    });
  }
  rows.sort((p, q) => q.sweepDeg - p.sweepDeg);
  return { frames: n, bones: rows };
}, SECONDS);

const arm = /shoulder|upperArm|foreArm|hand/i;
console.log('ARM CHAIN');
for (const r of out.bones.filter((b) => arm.test(b.bone))) {
  console.log(`  ${r.bone.padEnd(14)} sweep ${String(r.sweepDeg).padStart(6)}째   x ${r.xDeg}  y ${r.yDeg}  z ${r.zDeg}`);
}
console.log('\nEVERYTHING ELSE, most-moving first');
for (const r of out.bones.filter((b) => !arm.test(b.bone)).slice(0, 12)) {
  console.log(`  ${r.bone.padEnd(14)} sweep ${String(r.sweepDeg).padStart(6)}째`);
}
await browser.close(); await server.close();
