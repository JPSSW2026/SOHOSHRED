/**
 * Gameplay telemetry for a full descent.
 *
 * Every tool in this directory measures a still: geometry, colour, silhouette,
 * particles. None of them answers whether the game PLAYS. This drives the
 * course with a simple carving policy and records the run — speed profile,
 * distance, airtime, trick callouts, and bail events broken out by tier — so
 * questions like "does the rider ever reach the base station", "how often does
 * a run end in FAILED", and "is the three-tier bail system actually three
 * tiers" have numbers instead of impressions.
 *
 * The policy is deliberately plain: hold a lazy S-turn and pop occasionally.
 * It is not trying to play well, it is trying to be a repeatable probe of what
 * the systems do to an ordinary run.
 *
 *   node tools/playtest.mjs [seconds] [runs]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const SECONDS = Number(process.argv[2] || 90);
const RUNS = Number(process.argv[3] || 3);

const server = await createServer({ root: process.cwd(), server: { port: 6404 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerr]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:6404/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });

const out = await page.evaluate(async ({ SECONDS, RUNS }) => {
  const S = window.__SOHO;
  const dt = 1 / 60;
  const runs = [];

  for (let r = 0; r < RUNS; r++) {
    const spawn = S.ctx.terrain?.getSpawn?.();
    if (spawn) S.ctx.physics?.reset?.(spawn.position, spawn.heading);
    S.engine.manualTime = true;

    const inp = S.ctx.input || S.ctx.controls;
    const tricks = S.ctx.tricks;
    const st = () => S.ctx.physics?.state || {};

    // Watch the trick system's callout rather than trying to infer landings:
    // physics reports quality through onLanded and tricks turns it into the
    // on-screen text, which is exactly the player-visible outcome.
    const events = [];
    let lastCallout = null;

    // VARY THE POLICY PER RUN.
    //
    // Every run used to drive the identical S-turn, so N runs were one
    // trajectory measured N times and the bail RATE could not be estimated at
    // all -- worse, because the sim is chaotic, any physics tweak re-rolled
    // that single trajectory and the rate jumped around for reasons that had
    // nothing to do with the change. (Raising the spin threshold once sent
    // BAILED from 28.6% to 50%, which was the dice, not the tuning.) Each run
    // now gets its own turn rate, amplitude, phase and pop cadence, so the
    // mean over several runs is an actual estimate.
    const pol = {
      turnHz: 0.38 + 0.13 * ((r * 7) % 5),
      amp: 0.55 + 0.09 * ((r * 3) % 4),
      phase: (r * 1.7) % 6.28,
      popEvery: 150 + 40 * (r % 4),
      crouchHz: 0.8 + 0.25 * (r % 3),
    };

    // COUNT `popped` BEFORE postRender CLEARS IT.
    //
    // `s.popped` is a one-shot edge event: physics sets it in fixedUpdate and
    // clears it in postRender(), deliberately, so that every consumer gets a
    // chance to see it first (physics.js documents an earlier bug where
    // clearing it sooner silently killed the pop whoosh, the landing thump and
    // the camera punch). engine.tick() runs postRender internally — so reading
    // `s.popped` after the tick, which is what this probe did, ALWAYS sees
    // false.
    //
    // It reported poppedFrames 0 against 86 pop requests across three runs and
    // read as "the ollie is dead". It is not: maxPopCharge ~0.29 shows the
    // block runs, latchFrames tracks the requests, and airPct 20-31% with
    // maxAirTime up to 2.2 s is not a rider who never leaves the ground.
    // Wrapping postRender samples the flag at the last instant it is still
    // true, which is the only correct place to observe an edge event.
    const _ph = S.ctx.physics;
    if (!_ph.__popProbe) {
      _ph.__popProbe = true;
      const _orig = _ph.postRender.bind(_ph);
      // Same trick for landingImpact, and for the same reason: it is a
      // one-shot set at touchdown and cleared here, so nothing that reads it
      // after the tick can see it. Recording the DISTRIBUTION matters because
      // three bail tiers key off this value (HARD_LANDING 9.0, marginalDrop
      // 10.08, CRASH_LANDING 17.5) and none of them ever fired in 270 s of
      // play -- so the question "are those thresholds reachable on this
      // mountain at all" needs the actual numbers, not an argument.
      _ph.postRender = (...a) => {
        if (_ph.state.popped) window.__POPPED++;
        const li = _ph.state.landingImpact || 0;
        if (li > 0) window.__IMPACTS.push(+li.toFixed(2));
        return _orig(...a);
      };
    }
    window.__POPPED = 0;
    window.__IMPACTS = [];

    const start = st().position ? { x: st().position.x, z: st().position.z } : { x: 0, z: 0 };
    let peakSpeed = 0, airFrames = 0, groundFrames = 0, stoppedFrames = 0;
    let popped = 0, maxAirTime = 0, wipeouts = 0, crashes = 0, stumbleFrames = 0;
    let maxCharge = 0, latchFrames = 0, lockedFrames = 0, popsRequested = 0;
    const speeds = [];
    let phase = 0;

    const n = Math.round(SECONDS / dt);
    for (let i = 0; i < n; i++) {
      // Lazy S-turn, plus a pop every ~4 s. Held inputs are re-applied every
      // frame because Input.update() clears one-shot flags each tick.
      phase += dt;
      // Drive physics.applyInput DIRECTLY, not ctx.input.state.
      //
      // Physics never reads the Input object: Input.update() pushes its state
      // through physics.applyInput(), and input is registered AFTER physics in
      // the engine, so it recomputes from the keyboard (i.e. zeros) and
      // overwrites anything written to ctx.input.state before the tick. The
      // first version of this probe did exactly that and measured a rider
      // coasting downhill with no input at all -- which then looked like "pop
      // does nothing" and "no tricks ever fire". Both were the probe.
      const pop = (i % pol.popEvery) === 0 && i > 0;
      if (pop) popsRequested++;
      S.ctx.physics.applyInput({
        steer: Math.sin(phase * pol.turnHz + pol.phase) * pol.amp,
        lean: 0,
        crouch: 0.35 + 0.25 * Math.sin(phase * pol.crouchHz),
        pop,
        spin: 0, flip: 0, grab: null, tuck: false, brake: 0, reset: false,
      });
      if (inp) inp.enabled = false;   // keep the real Input from stamping over it
      S.engine.tick(dt, false);

      const s = st();
      const sp = s.speed || 0;
      speeds.push(sp);
      if (sp > peakSpeed) peakSpeed = sp;
      if (sp < 1.0) stoppedFrames++;
      if (s.grounded) groundFrames++; else airFrames++;

      // Distinguish "the pop never fires" from "it fires and the grounded
      // flag never clears". s.popped is set by the release branch itself, so
      // counting it separates the mechanic from the measurement.
      if (s.popped) popped++;
      if ((s.airTime || 0) > maxAirTime) maxAirTime = s.airTime;
      if (s.wipeout) wipeouts++;
      if (s.crashed) crashes++;
      if ((s.stumble || 0) > 0) stumbleFrames++;

      // Which branch is the pop block taking? _popCharge only moves if the
      // block runs at all, so a flat zero means it is gated off.
      const ph = S.ctx.physics;
      if ((ph._popCharge || 0) > maxCharge) maxCharge = ph._popCharge;
      if (ph._popLatch) latchFrames++;
      if (s.crashed) lockedFrames++;

      const c = tricks?.callout;
      const tag = c ? `${c.text}:${c.score}` : null;
      if (tag && tag !== lastCallout) {
        events.push({ t: +(i * dt).toFixed(1), text: c.text, score: c.score,
                      quality: c.quality, reason: s.crashReason || null });
      }
      lastCallout = tag;
    }

    const s = st();
    const end = s.position ? { x: s.position.x, z: s.position.z } : start;
    const dist = Math.hypot(end.x - start.x, end.z - start.z);
    const sorted = [...speeds].sort((a, b) => a - b);
    const q = (f) => +sorted[Math.floor(sorted.length * f)].toFixed(1);
    const byQ = {};
    for (const e of events) byQ[e.quality || e.text] = (byQ[e.quality || e.text] || 0) + 1;
    const byReason = {};
    for (const e of events) if (e.reason) byReason[e.reason] = (byReason[e.reason] || 0) + 1;
    const bailPct = +(100 * (byQ.crash || 0) / Math.max(1, events.length)).toFixed(1);

    runs.push({
      seconds: SECONDS, policy: pol,
      distanceM: Math.round(dist),
      endZ: Math.round(end.z),
      speedMedian: q(0.5), speedP10: q(0.1), speedP90: q(0.9),
      peakSpeedKmh: +(peakSpeed * 3.6).toFixed(1),
      airPct: +(100 * airFrames / (airFrames + groundFrames)).toFixed(1),
      stoppedPct: +(100 * stoppedFrames / speeds.length).toFixed(1),
      popsRequested, maxPopCharge: +maxCharge.toFixed(3), latchFrames, lockedFrames,
      poppedFrames: popped, poppedObserved: window.__POPPED || 0,
      impacts: (() => { const v=(window.__IMPACTS||[]).slice().sort((x,y)=>x-y); const q=f=>v.length?v[Math.floor(f*(v.length-1))]:null; return { n: v.length, max: q(1), p90: q(0.9), median: q(0.5), overHard9: v.filter(x=>x>9).length, overCrash175: v.filter(x=>x>17.5).length }; })(), maxAirTime: +maxAirTime.toFixed(2),
      wipeoutFrames: wipeouts, crashFrames: crashes, stumbleFrames,
      calloutCount: events.length,
      bailPct, byQuality: byQ, byReason,
      firstEvents: events.slice(0, 10),
    });
  }
  return { runs };
}, { SECONDS, RUNS });
console.log(JSON.stringify(out, null, 1));
await browser.close(); await server.close();
