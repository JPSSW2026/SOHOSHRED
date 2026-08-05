#!/usr/bin/env node
/**
 * Deterministic screenshot harness for Soho Shred.
 *
 * Builds the game, serves `dist/`, drives it in headless Chromium with the
 * simulation clock under manual control, and writes one PNG per shot preset.
 * Because the sim is stepped by hand rather than by requestAnimationFrame, the
 * output is reproducible frame-for-frame regardless of how slow the software
 * rasteriser is.
 *
 * Usage:
 *   node tools/shoot.mjs                        # all presets, 1280x720
 *   node tools/shoot.mjs --shots hero-basin,close-spray
 *   node tools/shoot.mjs --width 1600 --height 900 --out shots/round3
 *   node tools/shoot.mjs --query "tod=15.2&weather=storm"
 *   node tools/shoot.mjs --no-build             # reuse existing dist/
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/* ---------------------------------------------------------------- args --- */
function parseArgs(argv) {
  const a = { width: 1280, height: 720, out: 'shots', shots: null, build: true, query: '', timeout: 900000, settleScale: 1, shotTimeout: 600000 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--width') a.width = +next();
    else if (k === '--height') a.height = +next();
    else if (k === '--out') a.out = next();
    else if (k === '--shots') a.shots = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--query') a.query = next();
    else if (k === '--no-build') a.build = false;
    else if (k === '--timeout') a.timeout = +next();
    else if (k === '--settle-scale') a.settleScale = +next();
    else if (k === '--shot-timeout') a.shotTimeout = +next();
  }
  return a;
}
const ARGS = parseArgs(process.argv);

/* --------------------------------------------------------------- build --- */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on('error', reject);
  });
}

/* -------------------------------------------------------- static server --- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ktx2': 'image/ktx2',
  '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
};

function serve(dir, port) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p === '/' || p.endsWith('/')) p += 'index.html';
        const file = path.join(dir, p);
        if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
        const buf = await readFile(file);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
          // Enables high-resolution timers / SAB if we ever need them.
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
        });
        res.end(buf);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/* ----------------------------------------------------------------- main --- */
async function main() {
  if (ARGS.build) {
    console.log('[shoot] building…');
    await run('npx', ['vite', 'build', '--logLevel', 'warn']);
  }
  const distDir = path.join(ROOT, 'dist');
  if (!existsSync(distDir)) throw new Error('dist/ missing — run without --no-build');

  const port = 5000 + Math.floor(process.pid % 1000);
  const server = await serve(distDir, port);
  const outDir = path.resolve(ROOT, ARGS.out);
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-lcd-text',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      '--mute-audio',
      // SwiftShader is CPU-bound; give it every core.
      '--renderer-process-limit=1',
    ],
  });

  const page = await browser.newPage({
    viewport: { width: ARGS.width, height: ARGS.height },
    deviceScaleFactor: 1,
  });

  const logs = [];
  const errors = [];
  page.on('console', (m) => {
    const t = `${m.type()}: ${m.text()}`;
    logs.push(t);
    if (m.type() === 'error') errors.push(t);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack || ''}`));

  const url = `http://127.0.0.1:${port}/index.html${ARGS.query ? '?' + ARGS.query : ''}`;
  console.log('[shoot] loading', url);
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });

  // Wait for the world to finish building.
  try {
    await page.waitForFunction(() => window.__SOHO && window.__SOHO.isReady === true, null, {
      timeout: ARGS.timeout, polling: 500,
    });
  } catch (e) {
    const err = await page.evaluate(() => document.documentElement.getAttribute('data-soho-error'));
    await writeFile(path.join(outDir, '_ERROR.txt'),
      `boot timeout after ${Date.now() - t0}ms\n\npage error attr:\n${err}\n\nconsole:\n${logs.join('\n')}\n\nerrors:\n${errors.join('\n')}\n`);
    await page.screenshot({ path: path.join(outDir, '_boot-failure.png') });
    await browser.close(); server.close();
    throw new Error('game failed to reach ready state — see shots/_ERROR.txt');
  }
  console.log(`[shoot] ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Wait for the streamed world models. isReady deliberately does not block on
  // them -- a player should not wait on a 15 MB range wall -- but a capture
  // must, or it photographs a world with no mountains in it.
  const tM = Date.now();
  await page.evaluate(() => window.__SOHO_WORLD_MODELS || Promise.resolve());
  console.log(`[shoot] world models in ${((Date.now() - tM) / 1000).toFixed(1)}s`);

  await page.evaluate(([w, h]) => {
    window.__SOHO.setManual(true);
    window.__SOHO.setSize(w, h);
  }, [ARGS.width, ARGS.height]);

  const presets = ARGS.shots ?? (await page.evaluate(() => window.__SOHO.presets));
  const report = { width: ARGS.width, height: ARGS.height, query: ARGS.query, shots: [], errors };

  for (const name of presets) {
    const ts = Date.now();
    let meta;
    try {
      meta = await page.evaluate(async ([n, scale]) => {
        const S = window.__SOHO;
        const preset = S.presets.includes(n) ? n : null;
        if (!preset) throw new Error('no preset ' + n);
        // Re-seed deterministically: reset the rider then settle.
        const r = S.ctx.terrain?.getSpawn?.();
        if (r) S.ctx.physics?.reset?.(r.position, r.heading);
        const info = S.shot(n);
        return { ...info, stats: S.stats() };
      }, [name, ARGS.settleScale]);
    } catch (e) {
      console.error(`[shoot] ${name} FAILED: ${e.message}`);
      report.shots.push({ name, error: e.message });
      continue;
    }
    const file = path.join(outDir, `${name}.png`);
    // The software rasteriser can take minutes to compose a frame with the full
    // post chain, far beyond Playwright's 30s screenshot default. Reading the
    // drawing buffer is the single slowest step in the whole harness.
    await page.screenshot({ path: file, type: 'png', timeout: ARGS.shotTimeout, animations: 'disabled' });
    const secs = ((Date.now() - ts) / 1000).toFixed(1);
    console.log(`[shoot] ${name.padEnd(18)} ${secs}s  draws=${meta.stats.drawCalls} tris=${meta.stats.triangles}`);
    report.shots.push({ name, file: path.relative(ROOT, file), description: meta.description, stats: meta.stats, seconds: +secs });
  }

  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  if (errors.length) {
    await writeFile(path.join(outDir, '_console-errors.txt'), errors.join('\n\n'));
    console.warn(`[shoot] ${errors.length} console error(s) — see _console-errors.txt`);
  }

  await browser.close();
  server.close();
  console.log(`[shoot] wrote ${report.shots.filter((s) => !s.error).length} shots to ${outDir}`);
  if (report.shots.some((s) => s.error)) process.exitCode = 1;
}

main().catch((e) => { console.error('[shoot]', e); process.exit(1); });
