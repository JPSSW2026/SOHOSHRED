#!/usr/bin/env node
/**
 * Blind A/B comparison rig.
 *
 * Composites one of our rendered frames beside a real Shredders reference frame
 * into a single image, in a randomised but *reproducible* left/right order, and
 * writes the answer key to a separate file the critic is not shown.
 *
 * This is what makes the "which one is the shipped AAA game?" test honest: the
 * critic agent is handed `pair-XX.png` with panels labelled only A and B, makes
 * a call, and only afterwards is the key revealed.
 *
 * Compositing is done in headless Chromium (canvas 2D) so no image library is
 * needed. Both panels are letterboxed to identical dimensions and rendered with
 * identical smoothing so that resolution or scaling artefacts cannot be used as
 * a tell — the comparison must be about the image, not the pipeline.
 *
 * Usage:
 *   node tools/compare.mjs --ours shots/r1 --refs reference/shredders --out compare/r1
 *   node tools/compare.mjs --ours shots/r1 --pairs hero-basin:ref_19,close-spray:ref_12
 */

import { chromium } from 'playwright';
import { readdir, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRngFromString } from './_rng.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

function parseArgs(argv) {
  const a = { ours: 'shots/r1', refs: 'reference/shredders', out: 'compare/r1', pairs: null, seed: 'blind', panel: 900 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], next = () => argv[++i];
    if (k === '--ours') a.ours = next();
    else if (k === '--refs') a.refs = next();
    else if (k === '--out') a.out = next();
    else if (k === '--pairs') a.pairs = next();
    else if (k === '--seed') a.seed = next();
    else if (k === '--panel') a.panel = +next();
  }
  return a;
}
const ARGS = parseArgs(process.argv);

/**
 * Which reference frame each of our shot presets should be judged against.
 * Matching the *kind* of shot matters: judging a macro snow close-up against a
 * wide vista would test composition rather than craft.
 */
const DEFAULT_PAIRING = {
  'hero-basin': 'ref_19.jpg',
  'ridge-backlight': 'ref_19.jpg',
  'valley-vista': 'ref_05.jpg',
  'chase-carve': 'ref_05.jpg',
  'close-spray': 'ref_12.jpg',
  'rider-portrait': 'ref_12.jpg',
  'air-trick': 'ref_02.jpg',
  'snow-detail': 'ref_12.jpg',
};

async function main() {
  const oursDir = path.resolve(ROOT, ARGS.ours);
  const refsDir = path.resolve(ROOT, ARGS.refs);
  const outDir = path.resolve(ROOT, ARGS.out);
  await mkdir(outDir, { recursive: true });

  const ourFiles = (await readdir(oursDir)).filter((f) => f.endsWith('.png') && !f.startsWith('_'));
  const refFiles = (await readdir(refsDir)).filter((f) => /\.(jpg|png)$/i.test(f));

  let pairs;
  if (ARGS.pairs) {
    pairs = ARGS.pairs.split(',').map((p) => {
      const [ours, ref] = p.split(':');
      return { ours: ours.endsWith('.png') ? ours : ours + '.png', ref: ref.endsWith('.jpg') ? ref : ref + '.jpg' };
    });
  } else {
    pairs = ourFiles.map((f) => {
      const stem = f.replace(/\.png$/, '');
      const ref = DEFAULT_PAIRING[stem] || refFiles[0];
      return { ours: f, ref };
    });
  }

  const rng = makeRngFromString(ARGS.seed);
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb', '--hide-scrollbars'],
  });

  const PANEL_W = ARGS.panel;
  const PANEL_H = Math.round((PANEL_W * 9) / 16);
  const GAP = 24;
  const LABEL = 46;
  const page = await browser.newPage({
    viewport: { width: PANEL_W * 2 + GAP * 3, height: PANEL_H + LABEL + GAP * 2 },
    deviceScaleFactor: 1,
  });

  const key = [];
  let idx = 0;

  for (const p of pairs) {
    idx++;
    const oursB64 = (await readFile(path.join(oursDir, p.ours))).toString('base64');
    const refB64 = (await readFile(path.join(refsDir, p.ref))).toString('base64');
    // Reproducible coin flip: does our frame go on the left or the right?
    const oursLeft = rng() < 0.5;

    const html = `<!doctype html><html><head><style>
      html,body{margin:0;padding:0;background:#14171c;}
      .wrap{display:flex;gap:${GAP}px;padding:${GAP}px;align-items:flex-start;}
      .panel{width:${PANEL_W}px;}
      .lbl{height:${LABEL}px;line-height:${LABEL}px;text-align:center;color:#e8ecf2;
           font:600 26px/${LABEL}px ui-sans-serif,system-ui,sans-serif;letter-spacing:.24em;}
      canvas{display:block;width:${PANEL_W}px;height:${PANEL_H}px;background:#000;
             border:1px solid #2a2f38;}
    </style></head><body>
      <div class="wrap">
        <div class="panel"><div class="lbl">A</div><canvas id="a" width="${PANEL_W}" height="${PANEL_H}"></canvas></div>
        <div class="panel"><div class="lbl">B</div><canvas id="b" width="${PANEL_W}" height="${PANEL_H}"></canvas></div>
      </div>
    </body></html>`;

    await page.setContent(html, { waitUntil: 'load' });

    await page.evaluate(async ({ leftB64, rightB64, w, h }) => {
      // Draw both panels through the identical path: same smoothing quality,
      // same letterbox maths. Any difference the critic sees is in the source
      // image, never in how we composited it.
      const draw = (id, b64) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.getElementById(id);
          const g = c.getContext('2d');
          g.imageSmoothingEnabled = true;
          g.imageSmoothingQuality = 'high';
          g.fillStyle = '#000';
          g.fillRect(0, 0, w, h);
          const s = Math.min(w / img.width, h / img.height);
          const dw = img.width * s, dh = img.height * s;
          g.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
          resolve();
        };
        img.src = 'data:image/*;base64,' + b64;
      });
      await draw('a', leftB64);
      await draw('b', rightB64);
    }, {
      leftB64: oursLeft ? oursB64 : refB64,
      rightB64: oursLeft ? refB64 : oursB64,
      w: PANEL_W, h: PANEL_H,
    });

    const name = `pair-${String(idx).padStart(2, '0')}-${p.ours.replace(/\.png$/, '')}.png`;
    await page.screenshot({ path: path.join(outDir, name), type: 'png' });

    key.push({
      pair: name,
      A: oursLeft ? `OURS (${p.ours})` : `SHREDDERS (${p.ref})`,
      B: oursLeft ? `SHREDDERS (${p.ref})` : `OURS (${p.ours})`,
      oursPanel: oursLeft ? 'A' : 'B',
    });
    console.log(`[compare] ${name}  ours=${oursLeft ? 'A' : 'B'}`);
  }

  await writeFile(path.join(outDir, 'ANSWER_KEY.json'), JSON.stringify(key, null, 2));
  await writeFile(path.join(outDir, 'README.txt'),
    'Each pair-*.png shows two frames labelled A and B.\n' +
    'One is Soho Shred, one is the shipped game Shredders.\n' +
    'ANSWER_KEY.json reveals which is which — do not read it before judging.\n');
  await browser.close();
  console.log(`[compare] ${key.length} blind pairs -> ${outDir}`);
}

main().catch((e) => { console.error('[compare]', e); process.exit(1); });
