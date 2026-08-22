/**
 * Assemble dist/ into ONE self-contained HTML file.
 *
 * Written for hosts that serve a single page and nothing beside it (the
 * Claude Artifact viewer, a pasted file:// URL, an email attachment): every
 * sibling request dist/ would make -- the module chunk, two GLBs, two MP3s,
 * the sting -- is folded into the document as a data: URI.
 *
 * The asset paths are rewritten by plain string substitution rather than by
 * a fetch/XHR shim. `new Audio(src)` and `<video src=...>` inside an
 * innerHTML string both set the src *attribute*, which no property-setter
 * patch and no MutationObserver sees in time; substituting the literal is
 * the only rewrite that catches all five call sites. Base64 is quote-free
 * and backtick-free, so it drops into a template literal or an HTML
 * attribute without escaping.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const DIST = 'dist';
const OUT = process.argv[2] || 'soho-shred.html';

const MIME = { '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' };
const ASSETS = [
  'models/backdrop-ranges.glb',
  'models/base-station.glb',
  'audio/soho-valley-tonight.mp3',
  'audio/snowboard-chill.mp3',
  'video/sting.mp4',
];

const jsName = (await readdir(path.join(DIST, 'assets'))).find((f) => f.endsWith('.js'));
let js = await readFile(path.join(DIST, 'assets', jsName), 'utf8');

for (const rel of ASSETS) {
  const buf = await readFile(path.join(DIST, rel));
  const uri = `data:${MIME[path.extname(rel)]};base64,${buf.toString('base64')}`;
  if (!js.includes(rel)) throw new Error(`asset path not found in bundle: ${rel}`);
  js = js.split(rel).join(uri);
  console.log(`inlined ${rel.padEnd(30)} ${(buf.length / 1048576).toFixed(2)} MB -> ${(uri.length / 1048576).toFixed(2)} MB b64`);
}

// The document skeleton is supplied by the host, so ship only what goes
// inside <body> -- plus the <title> and <style>, which the host hoists.
const html = await readFile(path.join(DIST, 'index.html'), 'utf8');
const head = html.match(/<title>[\s\S]*?<\/style>/)[0];
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];

const out = `${head}\n${body}\n<script type="module">\n${js}\n</script>\n`;
await writeFile(OUT, out);
console.log(`\n${OUT}  ${(Buffer.byteLength(out) / 1048576).toFixed(2)} MB`);
