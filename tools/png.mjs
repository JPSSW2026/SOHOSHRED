import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

export function decodePNG(path) {
  const buf = readFileSync(path);
  let p = 8;
  let w = 0, h = 0, bitDepth = 8, colorType = 6;
  const idat = [];
  let plte = null, trns = null;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced not supported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('bitDepth ' + bitDepth);
  const chan = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * chan;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= chan ? cur[x - chan] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= chan) ? prev[x - chan] : 0;
      let v = line[x];
      switch (ft) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); break;
        }
      }
      cur[x] = v & 255;
    }
  }
  // expand to RGB
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    if (colorType === 6 || colorType === 2) {
      rgb[i * 3] = out[i * chan]; rgb[i * 3 + 1] = out[i * chan + 1]; rgb[i * 3 + 2] = out[i * chan + 2];
    } else if (colorType === 3) {
      const ix = out[i] * 3; rgb[i * 3] = plte[ix]; rgb[i * 3 + 1] = plte[ix + 1]; rgb[i * 3 + 2] = plte[ix + 2];
    } else {
      rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = out[i * chan];
    }
  }
  return { width: w, height: h, data: rgb };
}
