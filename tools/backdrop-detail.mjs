/**
 * How much fine detail does the BACKDROP itself carry?
 *
 * R19 found `rms8` 2.95 in the band whose centre ray hits the backdrop at
 * 6800 m — against a 0.67 noise floor, and more than the heightfield carries
 * at 2057 m. That is a checklist-31 lead ("distant mountains with the same
 * contrast and texture frequency as near").
 *
 * But a BAND is not an OBJECT. The band whose centre hits the backdrop also
 * contains sky, near ridge and props, and three times this session a
 * measurement taken over an assumed region turned out to be measuring
 * something else. This isolates the backdrop by removal — hide it, diff, keep
 * the pixels that changed — and measures only those, so the number belongs to
 * the asset rather than to a stripe of the frame.
 *
 * Reports the same statistic for the heightfield, so the two are comparable
 * on one scale.
 *
 * WHAT IT FOUND — the lead is dead. On `valley-vista`, grain off, against a
 * 0.67 noise floor:
 *
 *   backdrop   16.9% of frame   rms8 1.73   rms32 3.67   fine/wide 0.471
 *   heightfield 66.5% of frame  rms8 7.28   rms32 16.42  fine/wide 0.443
 *
 * The backdrop carries 4.2x LESS fine detail than the near terrain, not more.
 * The band-level 2.95 that raised the lead was a stripe containing near ridge
 * as well as backdrop; attributing a whole band to whatever its centre ray
 * happened to hit is what produced it. Checklist 31 does not fail, and the
 * blur I would have added would have fought the "majestic backdrop" goal for
 * no reason.
 *
 *   node tools/backdrop-detail.mjs [shot] [--no-grain]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const shot = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'valley-vista';
const NOGRAIN = process.argv.includes('--no-grain');

const server = await createServer({ root: process.cwd(), server: { port: 6431 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerr]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:6431/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });

const out = await page.evaluate(async ({ shotName, noGrain }) => {
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
  if (noGrain) {
    const cfg = S.ctx.config;
    if (!cfg?.post?.grain) throw new Error('no post.grain in config');
    cfg.post.grain.enabled = false;   // the uniform is re-derived every tick
  }
  S.engine.tick(0);
  const base = grab();

  // Find the two subjects by name and isolate each by removal.
  const find = (re) => {
    const out = [];
    S.ctx.scene.traverse((o) => { if (o.isMesh && re.test(o.name || '')) out.push(o); });
    return out;
  };
  const groups = {
    backdrop: find(/backdrop/i),
    terrain: find(/^terrain-lod/i),
  };

  const maskOf = (meshes) => {
    if (!meshes.length) return null;
    const vis = meshes.map((m) => m.visible);
    meshes.forEach((m) => { m.visible = false; });
    S.engine.tick(0);
    const off = grab();
    meshes.forEach((m, i) => { m.visible = vis[i]; });
    S.engine.tick(0);
    const mask = new Uint8Array(W * H);
    let n = 0;
    for (let p = 0; p < W * H; p++) {
      const i = p * 4;
      const d = Math.abs(base[i] - off[i]) + Math.abs(base[i + 1] - off[i + 1]) + Math.abs(base[i + 2] - off[i + 2]);
      if (d > 10) { mask[p] = 1; n++; }
    }
    return { mask, n };
  };

  // RMS over WINxWIN windows, but only windows FULLY inside the mask, so a
  // window straddling the silhouette does not contribute the edge itself as
  // if it were surface texture.
  const rmsIn = (mask, win) => {
    let sum = 0, cnt = 0;
    for (let y = 0; y + win < H; y += win) {
      for (let x = 0; x + win < W; x += win) {
        let all = true;
        for (let j = 0; j < win && all; j++) {
          for (let i = 0; i < win; i++) if (!mask[(y + j) * W + (x + i)]) { all = false; break; }
        }
        if (!all) continue;
        let s = 0, s2 = 0;
        for (let j = 0; j < win; j++) {
          for (let i = 0; i < win; i++) {
            const v = luma(base, ((y + j) * W + (x + i)) * 4);
            s += v; s2 += v * v;
          }
        }
        const c = win * win;
        const mean = s / c;
        sum += Math.sqrt(Math.max(0, s2 / c - mean * mean));
        cnt++;
      }
    }
    return { rms: cnt ? +(sum / cnt).toFixed(2) : null, windows: cnt };
  };

  const res = {};
  for (const [name, meshes] of Object.entries(groups)) {
    const m = maskOf(meshes);
    if (!m) { res[name] = { meshes: 0 }; continue; }
    const f = rmsIn(m.mask, 8);
    const w = rmsIn(m.mask, 32);
    res[name] = {
      meshes: meshes.length,
      pixels: m.n,
      pctOfFrame: +(100 * m.n / (W * H)).toFixed(1),
      rms8: f.rms, windows8: f.windows,
      rms32: w.rms,
      fineRatio: (f.rms && w.rms) ? +(f.rms / w.rms).toFixed(3) : null,
    };
  }
  return { shot: shotName, grain: !noGrain, res };
}, { shotName: shot, noGrain: NOGRAIN });

console.log(JSON.stringify(out, null, 1));
await browser.close(); await server.close();
