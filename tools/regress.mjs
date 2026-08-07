/**
 * Exact regression check: which shots did this change touch?
 *
 * Now that `shoot.mjs --no-particles` renders byte-identically across separate
 * processes (R24), a rendered frame is a fingerprint. That turns a question
 * that used to need judgement — "did my rider tweak also move the terrain, or
 * the sky, or a prop?" — into an exact one.
 *
 * The manifest stores a SHA-256 per shot, not the images. Storing PNGs would
 * put megabytes into git for every baseline update, and this project has just
 * spent a round taking 41 MB back out of the shipped build. A hash answers
 * "did it change"; when the answer is yes, the fresh frames are on disk to
 * look at.
 *
 *   node tools/regress.mjs            # compare against the manifest
 *   node tools/regress.mjs --update   # accept current output as the baseline
 *
 * PARTICLES ARE OFF for every shot here, deliberately: they are the one thing
 * that is not reproducible across processes, so leaving them on would make
 * every shot report as changed and the tool would be worthless. It follows
 * that this cannot catch a regression whose only effect is on the spray —
 * `close-spray` still has to be looked at.
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const UPDATE = process.argv.includes('--update');
const MANIFEST = 'docs/regression-manifest.json';
const OUT = 'shots/regress';
const SHOTS = [
  'hero-basin', 'valley-vista', 'west-spur',
  'chase-carve', 'rider-portrait', 'air-trick', 'snow-detail', 'ridge-backlight',
];

await mkdir(OUT, { recursive: true });

const run = (args) => new Promise((res, rej) => {
  const p = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (c) => (c === 0 ? res(out) : rej(new Error(`exit ${c}\n${out}`))));
});

console.log(`[regress] shooting ${SHOTS.length} shots with particles off…`);
await run(['tools/shoot.mjs', '--no-build', '--no-particles', '--out', OUT, '--shots', SHOTS.join(',')]);

const hashes = {};
for (const f of (await readdir(OUT)).filter((f) => f.endsWith('.png')).sort()) {
  hashes[path.basename(f, '.png')] = createHash('sha256')
    .update(await readFile(path.join(OUT, f))).digest('hex').slice(0, 16);
}

if (UPDATE) {
  await writeFile(MANIFEST, `${JSON.stringify({ shots: hashes }, null, 2)}\n`);
  console.log(`[regress] baseline written: ${Object.keys(hashes).length} shots -> ${MANIFEST}`);
  process.exit(0);
}

if (!existsSync(MANIFEST)) {
  console.error(`[regress] no manifest at ${MANIFEST}; run with --update first`);
  process.exit(2);
}
const prev = JSON.parse(await readFile(MANIFEST, 'utf8')).shots;

const changed = [], same = [], missing = [], added = [];
for (const [k, v] of Object.entries(hashes)) {
  if (!(k in prev)) added.push(k);
  else if (prev[k] !== v) changed.push(k);
  else same.push(k);
}
for (const k of Object.keys(prev)) if (!(k in hashes)) missing.push(k);

console.log(`\nunchanged (${same.length}): ${same.join(', ') || '-'}`);
if (added.length) console.log(`new       (${added.length}): ${added.join(', ')}`);
if (missing.length) console.log(`missing   (${missing.length}): ${missing.join(', ')}`);
if (changed.length) {
  console.log(`\nCHANGED   (${changed.length}):`);
  for (const k of changed) console.log(`  ${k.padEnd(18)} ${prev[k]} -> ${hashes[k]}   ${path.join(OUT, k)}.png`);
  console.log('\nA change is not automatically a fault — it is the exact set of frames');
  console.log('this edit moved. Look at them, then --update if they are intended.');
}
process.exit(changed.length || missing.length ? 1 : 0);
