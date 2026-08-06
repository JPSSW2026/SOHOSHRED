/**
 * Is the snow-gun plume actually in the scene, and where?
 *
 * A plume is not an InstancedMesh, so prop-preview cannot find it and a still
 * that shows no plume cannot distinguish "not built", "built empty", "shader
 * failed" and "this particular gun is not one of the firing ones". This
 * reports the mesh, its puff count, the nearest firing nozzle to the spawn,
 * and then frames THAT nozzle.
 *
 *   node tools/plume-check.mjs [--out DIR]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'shots/plume';
await mkdir(OUT, { recursive: true });

const server = await createServer({ root: process.cwd(), server: { port: 6409 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerr]', String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 300)); });
await page.goto('http://127.0.0.1:6409/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });

const info = await page.evaluate(async () => {
  const S = window.__SOHO;
  const pl = S.ctx.props?.plumes;
  const mesh = pl?.mesh;
  const out = {
    hasSystem: !!pl,
    hasMesh: !!mesh,
    inScene: !!mesh && !!mesh.parent,
    quads: mesh ? mesh.geometry.index.count / 6 : 0,
    life: pl?.uniforms?.uLife?.value,
    programOk: null,
  };
  if (!mesh) return out;

  // Nozzles: every quad of a gun shares its nozzle position, so the distinct
  // `position` values are the firing nozzles.
  const p = mesh.geometry.attributes.position.array;
  const seen = new Map();
  for (let i = 0; i < p.length; i += 3) {
    const k = `${p[i].toFixed(1)},${p[i + 2].toFixed(1)}`;
    if (!seen.has(k)) seen.set(k, [p[i], p[i + 1], p[i + 2]]);
  }
  const nozzles = [...seen.values()];
  out.nozzles = nozzles.length;

  const sp = S.ctx.terrain.getSpawn().position;
  nozzles.sort((a, b) => ((a[0] - sp.x) ** 2 + (a[2] - sp.z) ** 2) - ((b[0] - sp.x) ** 2 + (b[2] - sp.z) ** 2));
  const t = nozzles[0];
  out.nearest = { x: +t[0].toFixed(1), y: +t[1].toFixed(1), z: +t[2].toFixed(1) };
  out.distFromSpawn = Math.round(Math.hypot(t[0] - sp.x, t[2] - sp.z));

  const cam = S.ctx.camera;
  S.ctx.flow?.skip?.();
  S.ctx.player?.camera?.setMode?.('free');
  S.engine.manualTime = true;
  window.__AIM = (d, hy, up, dy) => {
    cam.position.set(t[0] + d * Math.cos(hy), t[1] + up, t[2] + d * Math.sin(hy));
    cam.lookAt(t[0], t[1] + dy, t[2]);
    cam.updateProjectionMatrix();
    S.engine.tick(1 / 60);
    S.engine.tick(1 / 60);
  };
  // Did the shader compile? A failed program leaves the mesh drawing nothing.
  const gl = S.engine.renderer.getContext();
  const props = S.engine.renderer.properties.get(mesh.material);
  out.programOk = !!props?.currentProgram || 'not-yet-rendered';
  out.glError = gl.getError();
  return out;
});
console.log(JSON.stringify(info, null, 1));

if (info.hasMesh) {
  // Framings that match where the RUN actually passes a gun: eye height on
  // the piste, 25-90 m out. A camera below the nozzle sits under the terrain
  // and shows backfaces, which is a probe artefact, not a defect.
  const views = [
    ['pass25', 25, 0.7, -5.5, 1.5],
    ['pass45', 45, 2.4, -6.5, 2.0],
    ['pass90', 90, 1.9, -7.5, 3.0],
  ];
  for (const [tag, d, hy, up, dy] of views) {
    await page.evaluate(([d, hy, up, dy]) => window.__AIM(d, hy, up, dy), [d, hy, up, dy]);
    await page.screenshot({ path: path.join(OUT, `plume-${tag}.png`), timeout: 600000 });
    console.log('[plume-check]', tag);
  }
}
await browser.close(); await server.close();
