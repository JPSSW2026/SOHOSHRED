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
 *
 * WHAT IS ACTUALLY KNOWN ABOUT DETERMINISM (R32 supersedes R27):
 *
 *   · same source + SAME SHOT LIST, repeated  -> byte-identical. Verified
 *     twice, single-shot and two-shot.
 *   · same shot in a DIFFERENT-LENGTH list    -> different bytes. Shots render
 *     sequentially in one browser process and a frame depends on what preceded
 *     it, so hashes are only comparable against the same list.
 *   · across containers                       -> UNKNOWN. R27 claimed this
 *     differs and told you to re-baseline every session. That conclusion came
 *     from a control that stashed a source file and re-ran with `--no-build`,
 *     which rendered a dist built from the *unstashed* source. The control
 *     tested nothing. The question is open; do not assume either answer.
 *
 * Also worth knowing before reading a result: a rider GEOMETRY change can
 * legitimately move landscape frames, because the rider sits in the shadow
 * cascade and its silhouette alters the depth map terrain is lit against. A
 * rider COLOUR change cannot. "Only the rider shots moved" is therefore not a
 * general property of this tool — it was a property of that one colour edit.
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

// IT BUILDS. This used to pass `--no-build`, and `shoot.mjs` serves `dist/` —
// so the "regression check" compared build artifacts and never saw a source
// edit at all. Demonstrated: tinting a rider material and re-shooting without
// a rebuild changed 0 pixels; the same edit with a rebuild changed 183.
//
// A regression tool that reports "unchanged" for every uncommitted edit is
// worse than no tool, because it is trusted. It also voids R27's control run,
// which stashed a source file and concluded things about cross-session
// determinism while rendering a dist built from the unstashed source.
console.log(`[regress] building, then shooting ${SHOTS.length} shots with particles off…`);
await run(['tools/shoot.mjs', '--no-particles', '--out', OUT, '--shots', SHOTS.join(',')]);

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
