/**
 * Deterministic pseudo-random + coherent noise toolkit.
 *
 * Every procedural system in Soho Shred (terrain, textures, props, particles)
 * draws from this module so that a given seed always reproduces the exact same
 * mountain. Determinism is a hard requirement: the screenshot regression harness
 * compares frames across runs, so nothing may depend on Math.random().
 *
 * Implementations are dependency-free and allocation-light — the noise
 * functions are called millions of times during terrain build.
 */

/* ------------------------------------------------------------------ *
 * Hashing / PRNG
 * ------------------------------------------------------------------ */

/** Robert Jenkins' 32 bit integer hash — fast, good avalanche. */
export function hash32(x) {
  x = x | 0;
  x = (x + 0x7ed55d16 + (x << 12)) | 0;
  x = (x ^ 0xc761c23c ^ (x >>> 19)) | 0;
  x = (x + 0x165667b1 + (x << 5)) | 0;
  x = ((x + 0xd3a2646c) ^ (x << 9)) | 0;
  x = (x + 0xfd7046c5 + (x << 3)) | 0;
  x = (x ^ 0xb55a4f09 ^ (x >>> 16)) | 0;
  return x >>> 0;
}

/** Convert an arbitrary string to a 32-bit seed (FNV-1a). */
export function seedFromString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32 — small, fast, statistically solid PRNG.
 * Returns a function producing floats in [0,1).
 */
export function makeRng(seed = 1) {
  let a = (typeof seed === 'string' ? seedFromString(seed) : seed) >>> 0;
  const fn = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  fn.range = (lo, hi) => lo + fn() * (hi - lo);
  fn.int = (lo, hi) => Math.floor(lo + fn() * (hi - lo + 1));
  fn.pick = (arr) => arr[Math.floor(fn() * arr.length) % arr.length];
  fn.sign = () => (fn() < 0.5 ? -1 : 1);
  /** Box-Muller normal deviate. */
  fn.normal = (mean = 0, sd = 1) => {
    let u = 0, v = 0;
    while (u === 0) u = fn();
    while (v === 0) v = fn();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  /** Uniform point inside unit disc. */
  fn.disc = () => {
    const r = Math.sqrt(fn());
    const t = fn() * Math.PI * 2;
    return [r * Math.cos(t), r * Math.sin(t)];
  };
  return fn;
}

/* ------------------------------------------------------------------ *
 * Value / gradient noise primitives
 * ------------------------------------------------------------------ */

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

/**
 * Simplex noise (2D + 3D) with a seeded permutation table.
 * Returns values in roughly [-1, 1].
 */
export class Simplex {
  constructor(seed = 0) {
    const rng = makeRng(seed >>> 0 || 1);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // Fisher-Yates with the seeded rng
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  noise2D(xin, yin) {
    const perm = this.perm, permMod12 = this.permMod12;
    let n0 = 0, n1 = 0, n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const gi0 = permMod12[ii + perm[jj]] * 3;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD3[gi0] * x0 + GRAD3[gi0 + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const gi1 = permMod12[ii + i1 + perm[jj + j1]] * 3;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD3[gi1] * x1 + GRAD3[gi1 + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const gi2 = permMod12[ii + 1 + perm[jj + 1]] * 3;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD3[gi2] * x2 + GRAD3[gi2 + 1] * y2);
    }
    return 70 * (n0 + n1 + n2);
  }

  noise3D(xin, yin, zin) {
    const perm = this.perm, permMod12 = this.permMod12;
    let n0 = 0, n1 = 0, n2 = 0, n3 = 0;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 >= 0) {
      const gi0 = permMod12[ii + perm[jj + perm[kk]]] * 3;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD3[gi0] * x0 + GRAD3[gi0 + 1] * y0 + GRAD3[gi0 + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 >= 0) {
      const gi1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD3[gi1] * x1 + GRAD3[gi1 + 1] * y1 + GRAD3[gi1 + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 >= 0) {
      const gi2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD3[gi2] * x2 + GRAD3[gi2 + 1] * y2 + GRAD3[gi2 + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 >= 0) {
      const gi3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      t3 *= t3;
      n3 = t3 * t3 * (GRAD3[gi3] * x3 + GRAD3[gi3 + 1] * y3 + GRAD3[gi3 + 2] * z3);
    }
    return 32 * (n0 + n1 + n2 + n3);
  }
}

/* ------------------------------------------------------------------ *
 * Fractal combinators
 * ------------------------------------------------------------------ */

/**
 * Classic fractal Brownian motion. `opts.octaves` layers of simplex at
 * geometrically increasing frequency and decreasing amplitude.
 * Result is normalised to approximately [-1, 1].
 */
export function fbm2(simplex, x, y, opts = {}) {
  const octaves = opts.octaves ?? 6;
  const lacunarity = opts.lacunarity ?? 2.0;
  const gain = opts.gain ?? 0.5;
  let freq = opts.frequency ?? 1;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * simplex.noise2D(x * freq, y * freq);
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / (norm || 1);
}

/**
 * Ridged multifractal — the workhorse for alpine ridgelines and spurs.
 * Sharp crests, smooth valleys. Returns approximately [0, 1].
 */
export function ridged2(simplex, x, y, opts = {}) {
  const octaves = opts.octaves ?? 6;
  const lacunarity = opts.lacunarity ?? 2.0;
  const gain = opts.gain ?? 0.5;
  const sharpness = opts.sharpness ?? 1.0;
  let freq = opts.frequency ?? 1;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let weight = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(simplex.noise2D(x * freq, y * freq));
    n = Math.pow(n, sharpness);
    n *= weight;
    // Feed this octave's value forward so crests stay coherent across scales.
    weight = Math.min(1, Math.max(0, n * 2));
    sum += amp * n;
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / (norm || 1);
}

/**
 * Billowy noise — rounded lobes, good for wind-drifted snow pillows.
 * Returns approximately [0, 1].
 */
export function billow2(simplex, x, y, opts = {}) {
  const octaves = opts.octaves ?? 5;
  const lacunarity = opts.lacunarity ?? 2.0;
  const gain = opts.gain ?? 0.5;
  let freq = opts.frequency ?? 1;
  let amp = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * Math.abs(simplex.noise2D(x * freq, y * freq));
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / (norm || 1);
}

/**
 * Domain-warped fbm. Warping breaks the "obviously procedural" grid signature
 * and produces the swirling, geologically plausible forms real terrain has.
 */
export function warpedFbm2(simplex, x, y, opts = {}) {
  const warp = opts.warp ?? 0.35;
  const wf = opts.warpFrequency ?? 0.5;
  const qx = fbm2(simplex, x * wf + 11.3, y * wf + 7.1, opts);
  const qy = fbm2(simplex, x * wf - 5.7, y * wf + 19.4, opts);
  return fbm2(simplex, x + warp * qx, y + warp * qy, opts);
}

/**
 * Worley / cellular noise (F1 and F2 distances) on a unit grid.
 * Used for rock cracking, sastrugi cells and crystal facets.
 * Returns { f1, f2, id } — distances are in cell units.
 */
export function worley2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  let f1 = 1e9, f2 = 1e9, id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const h = hash32(cx * 374761393 + cy * 668265263 + seed * 1442695040);
      const px = i + ((h & 0xffff) / 65535) - xf;
      const py = j + (((h >>> 16) & 0xffff) / 65535) - yf;
      const d = Math.sqrt(px * px + py * py);
      if (d < f1) { f2 = f1; f1 = d; id = h; }
      else if (d < f2) { f2 = d; }
    }
  }
  return { f1, f2, id };
}

/* ------------------------------------------------------------------ *
 * Small math helpers shared across systems
 * ------------------------------------------------------------------ */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
};
export const smootherstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
/** Frame-rate independent exponential smoothing toward a target. */
export const damp = (current, target, lambda, dt) =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));
export const mod = (n, m) => ((n % m) + m) % m;
/** Shortest signed angular difference, result in (-PI, PI]. */
export const angleDelta = (a, b) => mod(b - a + Math.PI, Math.PI * 2) - Math.PI;
