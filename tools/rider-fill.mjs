/**
 * Does snow bounce reach the rider's undersides?
 *
 * ART_DIRECTION checklist 3 lists "black undersides — no snow bounce onto the
 * rider's chin, the board base, or under the nose/tail" as a definitive tell,
 * and LAW 3 puts shadowed snow at 0.22–0.56 of sunlit rather than 0.05–0.15.
 * Neither has ever been measured ON THE RIDER: every check so far has been of
 * the terrain's shadows.
 *
 * Snow at 0.86 albedo is a giant reflector, so a figure standing on it should
 * have a bright underside — that is most of what separates a rider composited
 * into a snowfield from one lit by it.
 *
 * Method: isolate the rider's own pixels by hiding it and diffing (the same
 * removal trick who-owns.mjs uses), then report the distribution of luma
 * within that set as a fraction of sunlit snow. A figure lit only from above
 * shows a long black tail; a figure sitting in bounce does not.
 *
 *   node tools/rider-fill.mjs [shot]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const shot = process.argv[2] || 'rider-portrait';
const server = await createServer({ root: process.cwd(), server: { port: 6423 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerr]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:6423/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });

const out = await page.evaluate(async (shotName) => {
  const S = window.__SOHO;
  const W = 1280, H = 720;
  const cv = S.engine.renderer.domElement;
  const sc = document.createElement('canvas');
  sc.width = W; sc.height = H;
  const g2 = sc.getContext('2d', { willReadFrequently: true });
  const grab = () => { g2.clearRect(0, 0, W, H); g2.drawImage(cv, 0, 0); return g2.getImageData(0, 0, W, H).data; };
  const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

  const r = S.ctx.terrain?.getSpawn?.();
  if (r) S.ctx.physics?.reset?.(r.position, r.heading);
  S.shot(shotName);
  // dt = 0 for both grabs: a real step advances the sim between them and the
  // drift swamps the isolation entirely.
  S.engine.tick(0);
  const withRider = grab();

  const root = S.ctx.player.rider.object3D;
  root.visible = false;
  S.engine.tick(0);
  const without = grab();
  root.visible = true;

  // A third frame with the rider visible but casting NO shadow.
  //
  // Hiding the figure removes its cast shadow along with it, so a plain
  // two-frame diff labels the shadow on the snow as "rider" -- and shadowed
  // snow sits squarely inside LAW 3's 0.22-0.56 band, which would drag the
  // distribution into a pass no matter how black the figure itself was. On
  // the first run that contamination was most of the set: 101716 pixels, 11%
  // of the frame, for a figure covering about 4%.
  const casters = [];
  root.traverse((o) => { if (o.isMesh && o.castShadow) { casters.push(o); o.castShadow = false; } });
  S.engine.tick(0);
  const noShadow = grab();
  for (const o of casters) o.castShadow = true;
  S.engine.tick(0);

  // The rider's own pixels: where removing it changed the frame.
  const lum = [];
  let shadowPixels = 0;
  for (let i = 0; i < withRider.length; i += 4) {
    const dAll = Math.abs(withRider[i] - without[i])
               + Math.abs(withRider[i + 1] - without[i + 1])
               + Math.abs(withRider[i + 2] - without[i + 2]);
    if (dAll <= 24) continue;
    // Pixels that ALSO change when only the shadow is removed are shadow, not
    // figure. The figure itself is identical between those two frames.
    const dShade = Math.abs(withRider[i] - noShadow[i])
                 + Math.abs(withRider[i + 1] - noShadow[i + 1])
                 + Math.abs(withRider[i + 2] - noShadow[i + 2]);
    if (dShade > 12) { shadowPixels++; continue; }
    lum.push(luma(withRider, i));
  }
  // Sunlit snow reference: the brightest decile of everything that is NOT the
  // rider, which on this shot is the piste.
  const bg = [];
  for (let i = 0; i < without.length; i += 4) bg.push(luma(without, i));
  bg.sort((a, b) => a - b);
  const sunlit = bg[Math.floor(bg.length * 0.90)];

  lum.sort((a, b) => a - b);
  const q = (f) => +lum[Math.floor(lum.length * f)].toFixed(1);
  const frac = (f) => +(q(f) / sunlit).toFixed(3);
  return {
    shot: shotName,
    riderPixels: lum.length,
    shadowPixelsExcluded: shadowPixels,
    sunlitSnowLuma: +sunlit.toFixed(1),
    riderLuma: { p05: q(0.05), p25: q(0.25), p50: q(0.50), p75: q(0.75) },
    asFractionOfSunlitSnow: { p05: frac(0.05), p25: frac(0.25), p50: frac(0.50) },
    // How much of the figure is effectively black — the checklist's tell.
    pctUnder10ofSunlit: +(100 * lum.filter((v) => v < sunlit * 0.10).length / lum.length).toFixed(1),
    pctUnder20ofSunlit: +(100 * lum.filter((v) => v < sunlit * 0.20).length / lum.length).toFixed(1),
  };
}, shot);
console.log(JSON.stringify(out, null, 1));
await browser.close(); await server.close();
