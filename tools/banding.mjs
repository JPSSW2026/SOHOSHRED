// Local high-frequency energy, measured 2D so it does not care which way the
// bands run, and normalised by local contrast so a bright region does not
// score high just for being bright.
import { decodePNG } from '/home/user/SOHOSHRED/tools/png.mjs';
const [file, x0, y0, x1, y1] = [process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], +process.argv[6]];
const { width: w, data } = decodePNG(file);
const L = (x, y) => { const i = (y * w + x) * 3; return 0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2]; };
// Laplacian: responds to a comb, ignores a smooth gradient of any orientation.
let lap = 0, n = 0, vals = [];
for (let y = y0 + 1; y < y1 - 1; y++) for (let x = x0 + 1; x < x1 - 1; x++) {
  const v = 4*L(x,y) - L(x-1,y) - L(x+1,y) - L(x,y-1) - L(x,y+1);
  lap += v*v; n++; vals.push(L(x,y));
}
const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
const sd = Math.sqrt(vals.reduce((a,v)=>a+(v-mean)**2,0)/vals.length);
console.log(`${file.split('/').slice(-2).join('/')}  lapRMS=${Math.sqrt(lap/n).toFixed(2)}  localSD=${sd.toFixed(1)}  ratio=${(Math.sqrt(lap/n)/sd).toFixed(3)}`);
