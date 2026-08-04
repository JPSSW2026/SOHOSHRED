/**
 * Soho Shred — snow and rock surface shading.
 *
 * Snow is ~90% of every frame, so this module is the single most load-bearing
 * visual system in the game. It is built on `THREE.MeshPhysicalMaterial` and
 * patched through `onBeforeCompile`, which buys us the engine's lights, shadow
 * cascades, IBL, fog and tone mapping for free while letting us replace the
 * parts of the BRDF that make snow look like snow rather than white plastic.
 *
 * What is implemented here, and why (see docs/ART_DIRECTION.md §3):
 *
 *   (a) Wrapped multiple-scatter diffuse.  Photons enter a snow bump on the lit
 *       side and leave on the dark side, so the terminator is soft and wide.
 *       `saturate((N·L + w)/(1 + w))`, w varying 0.50 (powder) → 0.10 (ice).
 *   (b) Forward-scatter lobe.  Ice grains are 600–14,000 wavelengths across, so
 *       scattering is geometric-optics dominated with an asymmetry parameter
 *       g ≈ 0.85.  A slope viewed *toward* a low sun is 3–5× brighter than the
 *       same slope with the sun behind you.  Henyey–Greenstein with an
 *       effective g ≈ 0.62 (lower than physical because we approximate many
 *       scattering events, not one).
 *   (c) Transport blue.  Ice absorbs ~30× more at 700 nm than at 450 nm, so
 *       light that travels far inside the pack comes back cyan-blue.  Gated on
 *       local concavity and on the shadowed hemisphere only — never applied to
 *       the base albedo, which must stay neutral (ART_DIRECTION LAW 1).
 *   (d) Broad GGX sheen from the packed surface (ior 1.40 → F0 ≈ 0.028).
 *   (e) Sparse, intense, world-anchored crystal glints with a tight lobe, a
 *       sub-pixel size cull and a hard distance cutoff at ~40 m.
 *
 * All texture data is generated at runtime from the deterministic noise toolkit
 * in `core/rng.js` into `THREE.DataTexture`s — there are no external assets and
 * no calls to `Math.random()` anywhere in this file.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT WITH `terrain.js` / `props.js`
 * ---------------------------------------------------------------------------
 * See `SNOW_VERTEX_ATTRIBUTES` below.  The single attribute the shader reads is
 * `aSurface` (vec4).  Its WebGL generic default is (0,0,0,1), which this module
 * deliberately interprets as "deep powder, fully snow covered" — so geometry
 * that does not supply the attribute still renders correctly.  Use
 * `surfaceClassWeights()` to convert `terrain.sample().surface` strings into
 * the packed vec4.
 */

import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import {
  hash32,
  makeRng,
  seedFromString,
  Simplex,
  clamp,
  clamp01,
  lerp,
  smoothstep,
} from '../core/rng.js';

/* ==========================================================================
 * 0.  PUBLIC CONTRACT
 * ======================================================================== */

/**
 * Vertex attributes this material reads.  Everything is optional: the shader
 * falls back to the documented default via `material.defaultAttributeValues`,
 * so a geometry that supplies none of these still shades as clean powder.
 *
 * `aSurface` packs the five surface classes from `terrain.sample().surface`
 * into four channels:
 *
 *   x — groomed weight   [0..1]
 *   y — windpack weight  [0..1]
 *   z — ice weight       [0..1]
 *   w — snow cover       [0..1]   (1 = snow, 0 = bare rock)
 *
 * powder = clamp(1 − x − y − z, 0, 1).  Rock is `1 − w`, *not* a fifth weight,
 * precisely so that the WebGL default (0,0,0,1) means "powder, fully covered".
 *
 * Float32BufferAttribute is the obvious encoding, but a *normalized*
 * Uint8BufferAttribute works identically and is 4× smaller — recommended for
 * the big LOD rings.
 */
export const SNOW_VERTEX_ATTRIBUTES = Object.freeze({
  surface: Object.freeze({
    name: 'aSurface',
    itemSize: 4,
    channels: Object.freeze(['groomed', 'windpack', 'ice', 'snowCover']),
    default: Object.freeze([0, 0, 0, 1]),
    normalizedUint8Ok: true,
  }),
});

/**
 * Channel layout the snow shader expects from `ctx.trails.getTrackTexture()`.
 * Every channel is optional — a trails system that writes a single grey splat
 * into RGB with alpha 1 still produces a believable trench, it just also gets a
 * lip and a compaction term of the same shape.
 *
 *   R — trench depth      [0..1]  → cut down, darken, tint blue, kill glints
 *   G — displaced lip     [0..1]  → raise, brighten slightly
 *   B — compaction        [0..1]  → lower roughness (slick, polished base line)
 *   A — overall amount    [0..1]  → multiplies all three (age / fade)
 *
 * The world → uv mapping is `(worldXZ − region.xy) * region.zw`.  A trails
 * system may publish it as `trails.getTrackRegion() -> {minX, minZ, size}` or
 * as `trails.trackRegion`; if neither exists the material falls back to
 * `ctx.terrain.bounds`.
 */
export const SNOW_TRACK_TEXTURE_CHANNELS = Object.freeze({
  r: 'trenchDepth',
  g: 'displacedLip',
  b: 'compaction',
  a: 'amount',
});

/** True-north bearing of game −Z (docs/TERRAIN_BRIEF.md §2.1). */
export const TRUE_NORTH_BEARING_OF_MINUS_Z = 225;

const SURFACE_WEIGHTS = {
  powder: [0, 0, 0, 1],
  groomed: [1, 0, 0, 1],
  windpack: [0, 1, 0, 1],
  ice: [0, 0, 1, 1],
  rock: [0, 0, 0, 0],
};

/**
 * Convert a `terrain.sample()` result into the packed `aSurface` vec4.
 *
 * @param {string} surface  one of powder|groomed|ice|rock|windpack
 * @param {number} [snowDepth]  metres of settled snow; below ~0.10 m the
 *        surface reads as rock regardless of class, and between 0.10 and 0.45 m
 *        the cover fades so the snow/rock edge is a gradient, never a razor.
 * @param {number[]} [out]  optional 4-element destination
 * @returns {number[]} [groomed, windpack, ice, snowCover]
 */
export function surfaceClassWeights(surface, snowDepth = 1.5, out = [0, 0, 0, 1]) {
  const base = SURFACE_WEIGHTS[surface] || SURFACE_WEIGHTS.powder;
  out[0] = base[0];
  out[1] = base[1];
  out[2] = base[2];
  // Cover ramps 0 → 1 across 0.06 m → 0.45 m of settled depth.  Terrain's own
  // rock classification (depth < 0.10) therefore lands mid-ramp, which is what
  // produces the drift-shaped snow-on-rock edge rather than a hard boundary.
  const cover = base[3] * clamp01(smoothstep(0.06, 0.45, snowDepth));
  out[3] = surface === 'rock' ? Math.min(cover, 0.25) : cover;
  return out;
}

/* ==========================================================================
 * 1.  DETERMINISTIC, TILEABLE NOISE
 *
 * `core/rng.js` owns the general-purpose toolkit, but a *seamlessly tiling*
 * field needs a lattice that wraps, which simplex cannot give us in 2D.  These
 * helpers build periodic gradient- and cellular-noise on top of the shared
 * `hash32`, so every texel is still a pure function of `CONFIG.seed`.
 * ======================================================================== */

const TAU = Math.PI * 2;

/** 256 unit gradient directions — avoids two trig calls per lattice corner. */
const GRAD_TABLE = new Float32Array(512);
for (let i = 0; i < 256; i++) {
  const a = (i * TAU) / 256;
  GRAD_TABLE[i * 2] = Math.cos(a);
  GRAD_TABLE[i * 2 + 1] = Math.sin(a);
}

function latticeHash(ix, iy, px, py, seed) {
  const x = ((ix % px) + px) % px;
  const y = ((iy % py) + py) % py;
  return hash32(
    Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed | 0, 1442695041),
  );
}

/** Gradient dot product at a wrapped lattice corner. */
function gdot(ix, iy, px, py, seed, dx, dy) {
  const gi = (latticeHash(ix, iy, px, py, seed) & 255) << 1;
  return GRAD_TABLE[gi] * dx + GRAD_TABLE[gi + 1] * dy;
}

/**
 * Perlin gradient noise on a lattice that wraps every (px, py) units.
 * Anisotropic periods are supported so wind-elongated fields can tile.
 * Result is approximately [-1, 1].
 */
function tileNoise(x, y, px, py, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const n00 = gdot(ix, iy, px, py, seed, fx, fy);
  const n10 = gdot(ix + 1, iy, px, py, seed, fx - 1, fy);
  const n01 = gdot(ix, iy + 1, px, py, seed, fx, fy - 1);
  const n11 = gdot(ix + 1, iy + 1, px, py, seed, fx - 1, fy - 1);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.4142;
}

/**
 * Nyquist guard.  Each baker sets this to the texture resolution; any octave
 * whose lattice would land finer than two texels per cell is skipped, because
 * such an octave cannot survive mip generation — it only costs bake time and
 * adds aliasing energy to the top mip.  Set to `Infinity` it is a no-op.
 */
let _maxLatticePeriod = Infinity;

/** Tiling fBm with independent x/y periods.  Returns roughly [-1, 1]. */
function tileFbm(x, y, px, py, octaves, seed, gain = 0.5, lacunarity = 2) {
  let f = 1;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const ox = Math.round(px * f);
    const oy = Math.round(py * f);
    if (o > 0 && Math.max(ox, oy) > _maxLatticePeriod) break;
    sum += amp * tileNoise(x * f, y * f, ox, oy, seed + o * 131);
    norm += amp;
    f *= lacunarity;
    amp *= gain;
  }
  return sum / (norm || 1);
}

/** Tiling ridged noise — sharp crests, used for crystal facets and rock. */
function tileRidged(x, y, px, py, octaves, seed) {
  let f = 1;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const ox = Math.round(px * f);
    const oy = Math.round(py * f);
    if (o > 0 && Math.max(ox, oy) > _maxLatticePeriod) break;
    const n = 1 - Math.abs(tileNoise(x * f, y * f, ox, oy, seed + o * 71));
    sum += amp * n * n;
    norm += amp;
    f *= 2;
    amp *= 0.5;
  }
  return sum / (norm || 1);
}

const _wl = { f1: 0, f2: 0, id: 0 };

/** Tiling Worley (cellular) noise.  Distances are in cell units. */
function tileWorley(x, y, px, py, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  // Squared distances throughout; two sqrt at the end instead of nine.
  let f1 = 1e9;
  let f2 = 1e9;
  let id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const h = latticeHash(xi + i, yi + j, px, py, seed);
      const ox = i + (h & 0xffff) / 65535 - fx;
      const oy = j + ((h >>> 16) & 0xffff) / 65535 - fy;
      const d = ox * ox + oy * oy;
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = h;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  _wl.f1 = Math.sqrt(f1);
  _wl.f2 = Math.sqrt(f2);
  _wl.id = id;
  return _wl;
}

const frac = (v) => v - Math.floor(v);

/* ==========================================================================
 * 2.  PROCEDURAL TEXTURE BAKERY
 *
 * Five packed RGBA maps, all tiling, all mip-mapped.  Every one is cached at
 * module scope keyed on (seed, size) so the LOD rings, the props and the
 * backdrop shell all share exactly one set of GPU textures.
 * ======================================================================== */

const _textureCache = new Map();

function makeDataTexture(data, size, { srgb = false, anisotropy = 4 } = {}) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  // RGB of the rock albedo is authored in sRGB so the 8-bit quantisation lands
  // where the eye is sensitive; the packed data maps stay linear.
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Encode a wrapped height field as a two-channel derivative map.
 *
 * We store the *height gradient* (as −dh/du, −dh/dv) rather than a unit normal.
 * That is what makes multi-scale blending correct: gradients from independent
 * octaves simply add, whereas unit normals have to be re-normalised and lose
 * amplitude.  The shader reconstructs the perturbed normal with Mikkelsen's
 * surface-gradient formulation, which also handles the sloped ground correctly.
 */
function encodeGradient(height, size, headroom, data, rOff) {
  const n = size * size;
  const gu = new Float32Array(n);
  const gv = new Float32Array(n);
  // Pass 1 — raw central differences, and the magnitude histogram we normalise
  // against.  A texel-space derivative is tiny in absolute terms and depends on
  // the field's amplitude *and* its feature size, so a hand-tuned constant
  // scale is always wrong for at least one of the five maps.  Normalising to a
  // high percentile makes the 8-bit range fully used and turns `uDetailAmp`
  // into a genuine physical knob: the peak surface gradient of that layer.
  const mags = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1) + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = ((x - 1) + size) % size;
      const xp = (x + 1) % size;
      const i = y * size + x;
      const a = (height[y * size + xp] - height[y * size + xm]) * 0.5;
      const b = (height[yp * size + x] - height[ym * size + x]) * 0.5;
      gu[i] = a;
      gv[i] = b;
      mags[i] = Math.max(Math.abs(a), Math.abs(b));
    }
  }
  // 99th percentile via a 256-bucket histogram (cheap, and exact enough).
  let peak = 0;
  for (let i = 0; i < n; i++) if (mags[i] > peak) peak = mags[i];
  if (peak <= 1e-9) peak = 1;
  const hist = new Int32Array(256);
  for (let i = 0; i < n; i++) hist[Math.min(255, (mags[i] / peak * 255) | 0)]++;
  let acc = 0;
  let bucket = 255;
  const target = n * 0.99;
  for (let b = 0; b < 256; b++) {
    acc += hist[b];
    if (acc >= target) { bucket = b; break; }
  }
  const p99 = Math.max((bucket + 1) / 256 * peak, 1e-6);
  // `headroom` < 1 leaves room for the top percentile to clip gracefully.
  const scale = headroom / p99;
  for (let i = 0; i < n; i++) {
    const o = i * 4 + rOff;
    data[o] = Math.round(clamp01(0.5 - gu[i] * scale * 0.5) * 255);
    data[o + 1] = Math.round(clamp01(0.5 - gv[i] * scale * 0.5) * 255);
  }
}

const byte = (v) => Math.round(clamp01(v) * 255);
/** Linear → sRGB transfer, for the one texture the GPU decodes on sample. */
const toSrgbByte = (v) => {
  const c = clamp01(v);
  return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
};

/**
 * GRAIN — the macro-shot map.  One tile covers 0.37 m of ground, so a texel is
 * ~0.7 mm: this is the layer that survives a close-up of the board sinking in.
 *
 *   R,G — height gradient (fine crystalline granulation)
 *   B   — cavity / self-occlusion, for a very slight albedo darkening
 *   A   — crystal-cluster density, drives where glints are allowed to live
 */
function bakeSnowGrain(size, seed) {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const P = 8; // lattice units across the tile
  _maxLatticePeriod = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x / size) * P;
      const v = (y / size) * P;
      // Rounded, packed ice grains: inverted Worley F1 gives convex lobes.
      const w = tileWorley(u * 6, v * 6, P * 6, P * 6, seed + 11);
      const grain = 1 - Math.min(1, w.f1 * 1.55);
      const grainEdge = clamp01((w.f2 - w.f1) * 2.2); // inter-grain interstices
      // Broad settling undulation + faceted crystal relief.
      const soft = tileFbm(u * 2, v * 2, P * 2, P * 2, 5, seed + 3) * 0.5 + 0.5;
      const facet = tileRidged(u * 11, v * 11, P * 11, P * 11, 3, seed + 47);
      const hv = 0.34 * grain + 0.12 * grainEdge + 0.34 * soft + 0.20 * facet;
      h[i] = hv;
      const o = i * 4;
      data[o + 2] = byte(1 - Math.min(1, hv * 1.25));
      // Coarse-grain clusters: old, metamorphosed snow has bigger facets and
      // therefore far more glint than fresh dendritic snow 30 cm away.
      const cluster = tileFbm(u * 1.5, v * 1.5, Math.round(P * 1.5), Math.round(P * 1.5), 3, seed + 21);
      data[o + 3] = byte(0.30 + 0.85 * (cluster * 0.5 + 0.5) * (0.45 + 0.90 * facet));
    }
  }
  encodeGradient(h, size, 0.85, data, 0);
  return data;
}

/**
 * DRIFT — the wind map.  Baked in a frame whose +U axis is the direction the
 * wind travels, so the shader only has to rotate the lookup by the current
 * `CONFIG.world.windDirection`.  One tile covers 11 m.
 *
 * Sastrugi are asymmetric: the upwind face is a near-vertical scarp (~70°) and
 * the downwind tail is gentle (~10–12°).  A symmetric sine gives corduroy, not
 * sastrugi, so the profile here is a descending sawtooth with a softened riser.
 * Features are stretched 4:1 along the wind, per docs/TERRAIN_BRIEF.md §2.8.
 *
 *   R,G — height gradient (sastrugi + wind pillows)
 *   B   — sastrugi crest mask (crests are scoured and harder)
 *   A   — drift/pillow height, 0 = trough (lee, deep, soft), 1 = crest
 */
function bakeSnowDrift(size, seed) {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const P = 8; // 11 m tile / 8 = 1.375 m per lattice unit
  _maxLatticePeriod = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x / size) * P;
      const v = (y / size) * P;

      // Meander the ridge lines so they are not dead-straight combs — but
      // gently. The old warp varied at ~0.7 m ACROSS wind with +/-0.75 m of
      // displacement, so every crest zigzagged through its own wavelength and
      // the whole field read as pen scribbles rather than as wind forms. Real
      // sastrugi crests wander over metres, by a fraction of their spacing.
      const warp = tileFbm(u * 0.5, v * 0.6, 4, 5, 3, seed + 31) * 0.26
        // Slow phase drift, half a wavelength over ~4 m: without it every
        // crest sits at exactly n x 1.375 m, and once the meander was tamed
        // the field organised into ladder rungs - rows of dashes on a strict
        // grid. Real spacing varies bed to bed.
        + tileFbm(u * 0.25, v * 0.5, 2, 4, 2, seed + 77) * 0.55;
      // Sastrugi occur in patches, elongated 4:1 downwind.
      const patch = clamp01(tileFbm(u * 0.5, v * 2, 4, 16, 4, seed + 13) * 1.3 + 0.42);
      // Ridge segments have finite length: an anisotropic cellular field breaks
      // each comb into 3–8 m long individual sastrugi.
      const seg = tileWorley(u * 0.75, v * 3, 6, 24, seed + 53);
      const segMask = clamp01(1.25 - seg.f1 * 1.1);

      // Wavelength ≈ 1.375 m (spec: 0.35–2.2 m).
      const t = frac(u + warp);
      // Riser widened 0.06 -> 0.16 of the wavelength. At 6% the scarp is an
      // 8 cm hairline whose entire height gradient lands in ~4 texels: under
      // raking light that is a thin dark STROKE, which is most of why the
      // macro frame read as scribbles. 16% is still a distinct steep face
      // (~40 deg) but its gradient is a shaded form, not a line.
      const riser = smoothstep(0, 0.16, t);
      const tail = Math.pow(1 - t, 1.25);
      const saw = riser * tail;

      // Wind pillows / dunes: rounded lobes at 3–8 m, also downwind-elongated.
      const dune = Math.abs(tileFbm(u * 0.75, v * 1.5, 6, 12, 4, seed + 41));
      const dune2 = tileFbm(u * 0.35, v * 0.9, 3, 7, 3, seed + 67) * 0.5 + 0.5;

      const sastrugi = saw * patch * segMask;
      const drift = 0.62 * dune2 + 0.38 * (1 - dune);
      h[i] = sastrugi * 0.55 + drift * 0.45;

      const o = i * 4;
      data[o + 2] = byte(clamp01(sastrugi * 1.05));
      data[o + 3] = byte(clamp01(drift * 0.72 + sastrugi * 0.42));
    }
  }
  // 0.90 -> 0.50: REFERENCE_ANALYSIS's headline is that the shipped game's
  // snow is deliberately smooth and that surface texture is a distant fifth
  // in what sells the frame - over-texturing is itself a tell. The forms stay;
  // they whisper instead of drawing on the snow.
  encodeGradient(h, size, 0.50, data, 0);
  return data;
}

/**
 * MACRO — the "history and weathering" map at a 34 m tile (≈6.6 cm per texel).
 * Carries sun-cupping, broad albedo breakup, and old ski/board track scars.
 * Art direction §9.3: untouched snow across a whole frame reads as a raw
 * heightfield, so *something* must show that people have been here.
 *
 *   R,G — height gradient (cups + scars + broad settling)
 *   B   — albedo breakup, 0.5 neutral
 *   A   — scar / compaction mask
 */
function bakeSnowMacro(size, seed) {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const scar = new Float32Array(size * size);
  const P = 8; // 34 m / 8 = 4.25 m per lattice unit
  _maxLatticePeriod = size * 0.5;

  // --- old tracks -------------------------------------------------------
  // Stamped rather than distance-field-tested: marching a soft groove along the
  // polyline is O(length) instead of O(pixels × segments), and wrapping the
  // stamp indices keeps the tile seamless.
  const rng = makeRng(seed ^ 0x51ed270b);
  const simplex = new Simplex(seed + 5);
  const stampTrack = (x0, y0, dirX, dirY, length, radius, depth, wobble) => {
    const steps = Math.max(8, Math.round(length * 2));
    let px = x0;
    let py = y0;
    const base = Math.atan2(dirY, dirX);
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      // Absolute deviation from the base heading, not an accumulated one: a
      // random walk over ~1000 steps produces corkscrews, and a snowboard track
      // is a long, shallow arc.
      const ang = base + simplex.noise2D(t * 2.2, x0 * 0.017 + y0 * 0.011) * wobble;
      px += Math.cos(ang) * (length / steps);
      py += Math.sin(ang) * (length / steps);
      const r = Math.ceil(radius) + 1;
      const cx = Math.round(px);
      const cy = Math.round(py);
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          const d = Math.hypot(i + (px - cx), j + (py - cy));
          if (d > radius) continue;
          const fall = 1 - smoothstep(radius * 0.35, radius, d);
          const ix = ((cx + i) % size + size) % size;
          const iy = ((cy + j) % size + size) % size;
          const k = iy * size + ix;
          scar[k] = Math.max(scar[k], fall * depth);
        }
      }
    }
  };

  // Zero, per the user: "powder runs are meant to be untracked, only
  // leaving yours - that's the fantasy Soho Shred should depict." The
  // live trail system carries the player's own line; nothing is pre-baked.
  const trackCount = 0;
  for (let n = 0; n < trackCount; n++) {
    const x0 = rng() * size;
    const y0 = rng() * size;
    // Board/ski tracks run broadly down the fall line (game −Z, i.e. −V in the
    // tile) with a wide spread; a couple of skin tracks cut across it.
    const crossing = n >= trackCount - 2;
    const base = crossing ? Math.PI * (0.5 + rng.range(-0.18, 0.18)) : Math.PI * rng.range(0.82, 1.18);
    const len = size * rng.range(0.8, 1.6);
    // 6.6 cm/texel → a 0.28 m board track is ~4 texels wide.
    const radius = crossing ? 2.4 : rng.range(3.0, 4.6);
    const depth = crossing ? 0.45 : rng.range(0.55, 0.95);
    stampTrack(x0, y0, Math.cos(base), Math.sin(base), len, radius, depth, 0.22);
    if (!crossing && rng() < 0.6) {
      // A second, parallel line 0.6–1.4 m away: the pair reads as one rider.
      const off = rng.range(9, 21);
      stampTrack(
        x0 + Math.cos(base + Math.PI / 2) * off,
        y0 + Math.sin(base + Math.PI / 2) * off,
        Math.cos(base), Math.sin(base), len, radius * 0.9, depth * 0.85, 0.22,
      );
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x / size) * P;
      const v = (y / size) * P;
      // Sun cupping: shallow dishes 0.4–1.5 m across on the ablation surface.
      const cup = tileWorley(u * 7, v * 7, P * 7, P * 7, seed + 91);
      const cupH = -0.55 * (1 - Math.min(1, cup.f1 * 1.9)) * (1 - Math.min(1, cup.f1 * 1.9));
      // Broad settling and old wind events.
      const broad = tileFbm(u, v, P, P, 5, seed + 17);
      const hv = broad * 0.55 + cupH * 0.45 - scar[i] * 1.15;
      h[i] = hv;
      const o = i * 4;
      data[o + 2] = byte(0.5 + broad * 0.5);
      data[o + 3] = byte(clamp01(scar[i]));
    }
  }
  encodeGradient(h, size, 0.80, data, 0);
  return data;
}

/**
 * ROCK ALBEDO — Otago (Haast) schist.  Greenschist facies, ~200 Ma, strongly
 * foliated.  The *directional* part of the look — foliation banding, quartz
 * segregation veins and the platy fracture steps — is computed analytically in
 * the shader from a single global foliation plane, because every exposure in
 * the basin shares one strike and dip and randomly-oriented rock reads as fake
 * instantly.  This texture therefore carries only the isotropic part:
 * granularity, blocky micro-fracture, oxidation blotches, and a lichen mask.
 *
 *   RGB — albedo (sRGB encoded, hardware-decoded on sample)
 *   A   — lichen mask
 */
function bakeRockPack(size, seed) {
  const data = new Uint8Array(size * size * 4);
  const P = 8; // 2.4 m tile → 4.7 mm per texel
  _maxLatticePeriod = size * 0.5;
  // Linear-light reference colours from docs/TERRAIN_BRIEF.md §2.13.
  const baseCol = [0.200, 0.208, 0.176]; // #6E7269 grey-green
  const quartz = [0.372, 0.396, 0.362]; // #9AA096 quartz segregation
  const oxide = [0.235, 0.170, 0.098]; // #7A6A52 weathered / oxidised rind
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x / size) * P;
      const v = (y / size) * P;

      const grit = tileFbm(u * 24, v * 24, P * 24, P * 24, 3, seed + 71) * 0.5 + 0.5;
      // Schist parts ALONG the foliation, so the fracture seams must be long and
      // parallel, not an isotropic cobble mosaic.  Stretching the cell lattice
      // 7:1 along U (the strike axis, which the shader orients) turns crazy
      // paving into layered plates.
      const blocky = tileWorley(u * 0.7, v * 5, Math.max(1, Math.round(P * 0.7)), P * 5, seed + 83);
      const crack = 1 - smoothstep(0.03, 0.22, blocky.f2 - blocky.f1);
      const weather = clamp01(tileFbm(u * 1.5, v * 1.5, Math.round(P * 1.5), Math.round(P * 1.5), 4, seed + 97) * 1.1 + 0.5);
      // Quartz segregation lenses: strongly elongated, because they lie IN the
      // foliation.  The tile's U axis is the strike direction (the shader
      // orients the projection), so stretch 9:1 along U.
      const vein = clamp01(tileRidged(u * 0.9, v * 8, Math.round(P * 0.9) || 1, P * 8, 3, seed + 103) * 1.7 - 0.62);

      let r = lerp(baseCol[0], quartz[0], vein) * (0.82 + 0.36 * grit);
      let g = lerp(baseCol[1], quartz[1], vein) * (0.82 + 0.36 * grit);
      let b = lerp(baseCol[2], quartz[2], vein) * (0.82 + 0.36 * grit);
      // Oxidised, rust-brown weathering rind on the exposed bands only.
      const ox = clamp01((weather - 0.68) * 2.6);
      r = lerp(r, oxide[0], ox * 0.62);
      g = lerp(g, oxide[1], ox * 0.62);
      b = lerp(b, oxide[2], ox * 0.62);
      // Seams go dark; the plate faces stay flat and even.
      const edge = 1.0 - 0.42 * crack;
      r *= edge; g *= edge; b *= edge;

      const o = i * 4;
      data[o] = toSrgbByte(r);
      data[o + 1] = toSrgbByte(g);
      data[o + 2] = toSrgbByte(b);

      // Lichen: 0.05–0.4 m blotches.  Coverage is biased in the shader toward
      // sun-facing rock, so this is only the shape, not the placement.
      const lich = tileWorley(u * 5, v * 5, P * 5, P * 5, seed + 113);
      const lichShape = clamp01(1.35 - lich.f1 * 2.5) * (0.5 + 0.5 * grit);
      const lichBreak = tileFbm(u * 9, v * 9, P * 9, P * 9, 3, seed + 127) * 0.5 + 0.5;
      data[o + 3] = byte(clamp01(lichShape * lichBreak * 1.4 - 0.18));
    }
  }
  return data;
}

/**
 * ROCK NORMAL / CAVITY.
 *   R,G — height gradient (blocky fracture + grit)
 *   B   — cavity occlusion
 *   A   — height, used to decide where snow lodges
 */
function bakeRockNormal(size, seed) {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const P = 8;
  _maxLatticePeriod = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x / size) * P;
      const v = (y / size) * P;
      // Schist splits into PLATES, so the relief must be terraced: flat facets
      // separated by sharp risers.  A smooth Worley blob field reads as cobble
      // or popcorn, which is exactly the wrong rock.  Quantising a smooth field
      // into steps and keeping the crack seams thin gives the platy break.
      // Same anisotropic parting as the albedo map, so seams and relief agree.
      const blocky = tileWorley(u * 0.7, v * 5, Math.max(1, Math.round(P * 0.7)), P * 5, seed + 83);
      const crack = 1 - smoothstep(0.03, 0.22, blocky.f2 - blocky.f1);
      // The plate levels step along V (across the layering), never across U.
      const chunk = tileFbm(u * 0.8, v * 4, Math.max(1, Math.round(P * 0.8)), P * 4, 4, seed + 139) * 0.5 + 0.5;
      // 7 discrete slab levels with a slightly soft riser.
      const levels = 7;
      const q = chunk * levels;
      const step = Math.floor(q);
      const terrace = (step + smoothstep(0.72, 0.94, q - step)) / levels;
      const grit = tileFbm(u * 20, v * 20, P * 20, P * 20, 3, seed + 71) * 0.5 + 0.5;
      const hv = 0.70 * terrace + 0.16 * grit - 0.30 * crack;
      h[i] = hv;
      const o = i * 4;
      data[o + 2] = byte(clamp01(0.45 + 0.55 * (1 - crack) * (0.5 + 0.5 * terrace)));
      data[o + 3] = byte(clamp01(hv * 1.15 + 0.1));
    }
  }
  encodeGradient(h, size, 0.88, data, 0);
  return data;
}

/** Build (or fetch from cache) the whole texture set. */
function getTextures(opts) {
  const seed = seedFromString(String(opts.seed ?? CONFIG.seed ?? 'soho')) >>> 0;
  const size = opts.textureSize | 0;
  const aniso = opts.anisotropy | 0;
  const key = `${seed}:${size}:${aniso}`;
  let set = _textureCache.get(key);
  if (set) return set;

  // Snow is 90% of the frame and gets the full resolution; the rock maps carry
  // only the isotropic half of the schist look (the foliation is analytic) so
  // they run at three-quarter and half scale respectively.  This keeps the
  // whole bake comfortably under a second even on a cold JIT.
  const big = size;
  const mid = Math.max(128, Math.round(size * 0.75));
  const small = Math.max(128, size >> 1);
  set = {
    grain: makeDataTexture(bakeSnowGrain(big, seed + 1), big, { anisotropy: aniso }),
    drift: makeDataTexture(bakeSnowDrift(big, seed + 2), big, { anisotropy: aniso }),
    macro: makeDataTexture(bakeSnowMacro(big, seed + 3), big, { anisotropy: aniso }),
    rock: makeDataTexture(bakeRockPack(mid, seed + 4), mid, { srgb: true, anisotropy: aniso }),
    rockNormal: makeDataTexture(bakeRockNormal(small, seed + 5), small, { anisotropy: aniso }),
  };
  _textureCache.set(key, set);
  return set;
}

/** Release every cached GPU texture (engine teardown / hot reload). */
export function disposeSnowTextures() {
  for (const set of _textureCache.values()) {
    for (const tex of Object.values(set)) tex.dispose?.();
  }
  _textureCache.clear();
}

/* ==========================================================================
 * 3.  GLSL
 * ======================================================================== */

/**
 * Vertex: publish world position (batching/instancing aware) and the packed
 * surface class.  Injected in place of `<project_vertex>` so `transformed` is
 * already through morph/skin/displacement but not yet through the view matrix.
 */
const VERTEX_PARS = /* glsl */ `
attribute vec4 aSurface;
varying vec4 vSnowSurface;
varying vec3 vSnowWorldPos;
`;

const VERTEX_MAIN = /* glsl */ `
vec4 sohoWorld4 = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	sohoWorld4 = batchingMatrix * sohoWorld4;
#endif
#ifdef USE_INSTANCING
	sohoWorld4 = instanceMatrix * sohoWorld4;
#endif
vSnowWorldPos = ( modelMatrix * sohoWorld4 ).xyz;
vSnowSurface = aSurface;
#include <project_vertex>
`;

/**
 * Fragment declarations shared by the snow and the rock material.  Appended
 * after `<common>` so `saturate`, `PI` and `RECIPROCAL_PI` are already defined
 * and so the globals below are visible inside `RE_Direct_Physical`.
 */
const FRAGMENT_PARS = /* glsl */ `
#define SOHO_SNOW

uniform sampler2D uSnowGrain;
uniform sampler2D uSnowDrift;
uniform sampler2D uSnowMacro;
uniform sampler2D uRockPack;
uniform sampler2D uRockNormal;

// Kicker dye lines: xy = station in world XZ, zw = unit run direction.
// One entry per lip, count in uDyeCount (0 disables the whole block).
#define SOHO_MAX_DYE 6
uniform vec4  uDye[ SOHO_MAX_DYE ];
uniform float uDyeCount;

uniform vec4  uDetailScale;      // metres per tile: grainFine, grainMid, drift, macro
uniform vec4  uDetailAmp;        // gradient amplitude per layer
uniform vec2  uDetailFade;       // start / end distance for the fine grain layers
uniform float uRockScale;        // metres per rock tile
uniform vec3  uRockTint;
uniform float uRockRough;
uniform vec4  uSurfRough;        // powder, windpack, groomed, ice
uniform vec4  uSurfWrap;         // diffuse wrap width per class
uniform vec3  uSssColor;         // transport tint, raw
uniform vec3  uSssTint;          // transport tint, max-channel normalised
uniform vec3  uSkyFillTint;      // 15,000 K sky illuminant (ART_DIRECTION §4.2)
uniform float uSssStrength;
uniform vec2  uWindDir;          // unit, world XZ, direction the wind TRAVELS
uniform float uSparkleTime;
uniform vec4  uGlint;            // density (cells/m), sharpness, strength, coverage
uniform vec2  uGlintRange;       // full strength / zero distance in metres
uniform float uForwardStrength;
uniform vec3  uSunDirWorld;
uniform float uNormalStrength;
uniform float uCorduroySpacing;
uniform vec3  uFoliationN;       // unit normal of the schist foliation planes
uniform float uFoliationSpacing;
uniform float uAlbedoScale;
uniform float uSnowOnRock;
uniform float uTrackStrength;

#ifdef USE_TRACK_MAP
	uniform sampler2D uTrackMap;
	uniform vec4 uTrackRegion;   // xy = min corner (x,z), zw = 1 / extent
#endif

varying vec4 vSnowSurface;
varying vec3 vSnowWorldPos;

// A rotation used to decorrelate the second detail octave from the first, so
// the two layers never share a tiling period (ART_DIRECTION §11.14).
const mat2 SOHO_ROT2 = mat2( 0.80902, -0.58779, 0.58779, 0.80902 );

// Written by the surface block, consumed by RE_Direct_Physical and by the
// indirect tint after <lights_fragment_end>.
float sohoWrap;
float sohoSSSAmount;
float sohoGlintMul;
float sohoForwardMul;
float sohoFootprint;
// How much of this fragment is snow rather than schist.  The shadowed-fill
// transport tint is a *snow* phenomenon, so it must not bleed onto bare rock.
float sohoSnowness;
vec3  sohoNormalW;
vec3  sohoTanW;
vec3  sohoBitW;

/** Hash without sin() — stable, cheap, exact for integer lattice coords. */
vec3 sohoHash33( vec3 p ) {
	p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
	p += dot( p, p.yxz + 33.33 );
	return fract( ( p.xxy + p.yxx ) * p.zyx );
}

/** Henyey-Greenstein phase function. */
float sohoHG( float cosT, float g ) {
	float g2 = g * g;
	float d = max( 1.0 + g2 - 2.0 * g * cosT, 1.0e-3 );
	return ( 1.0 - g2 ) / ( 4.0 * PI * d * sqrt( d ) );
}

/**
 * One lattice of crystal facets.
 *
 * The facet normals are a pure function of a quantised *world* position, so the
 * glints are nailed to the snow: they do not crawl when the camera moves, which
 * is the difference between "diamond dust" and "animated static".  A glint
 * lights only when the world-space half vector falls inside a very tight cone
 * about its facet, so the firing set is naturally densest near the sun's
 * specular direction and migrates as the camera swings.
 */
float sohoGlintLayer( vec3 wp, vec3 wN, vec3 Hw, float density, float sharp, float coverage, float seed ) {
	vec2 gp = wp.xz * density + seed;
	vec2 cell = floor( gp );
	vec3 r = sohoHash33( vec3( cell, seed ) );
	float alive = step( 1.0 - coverage, r.z );

	// ---- shape -----------------------------------------------------------
	// A glint is ONE ice facet a fraction of a millimetre across.  Lighting the
	// whole lattice cell is what produced the axis-aligned white rectangles
	// (tell #12, checklist 25): the cell is 3-8 cm of ground, so at 2 m it is a
	// 3-5 px square with flat sides and square corners, and shrinking the cell
	// just moves the same square closer to the camera.
	//
	// So the cell is a *placement* lattice, not the mark.  Each live cell owns a
	// single jittered point, drawn with a radius pinned to the PIXEL footprint —
	// which makes the mark ~2 px across at every distance, round because the
	// falloff is radial, and sub-cell because the radius is clamped well inside
	// the cell.  The jitter is confined to the middle 40% of the cell so a point
	// never clips against its own cell boundary and reads as a half-moon.
	vec3 j = sohoHash33( vec3( cell, seed + 19.0 ) );
	float cellW = 1.0 / max( density, 1.0e-4 );                 // metres per cell
	// No lower clamp: 0.75 x the footprint is already ~1.5 px across by
	// construction, and any floor expressed in metres becomes a fat lozenge
	// again the moment the camera gets close enough.
	float radW = min( 0.75 * sohoFootprint, 0.28 * cellW );
	float dW = length( fract( gp ) - ( j.xy * 0.4 + 0.3 ) ) * cellW;
	float spot = 1.0 - smoothstep( radW * 0.45, radW, dW );

	// ---- lobe ------------------------------------------------------------
	// Slow per-facet breathing: real twinkle comes from motion, but a little
	// life keeps a static frame from looking printed.  Never fast enough to read
	// as noise.
	// The facet distribution has to be able to REACH the half vector or the term
	// is arithmetically dead.  Our sun sits at 10.6 deg elevation and the camera
	// looks down at the snow, so Hw lands ~45 deg off the surface normal.  At the
	// old 0.58 spread the steepest facet in the lattice was ~30 deg, the best
	// achievable dot( facet, Hw ) was cos(15 deg) = 0.966, and with sharp = 620
	// that is exp2(-21) = 5e-7: zero glints in every frame, ever.  1.35 is a
	// ~54 deg peak tilt, which is also the honest number for faceted surface hoar
	// and fresh stellar crystals lying at random attitudes on the pack.
	float spread = 1.35 + 0.22 * sin( uSparkleTime * 0.85 + r.z * 6.2831853 );
	vec3 facet = normalize( wN + ( r.x * 2.0 - 1.0 ) * spread * sohoTanW + ( r.y * 2.0 - 1.0 ) * spread * sohoBitW );
	float lobe = exp2( - ( 1.0 - saturate( dot( facet, Hw ) ) ) * sharp );
	// Projected-area weight.  A facet tipped hard away from the surface normal
	// exists, but presents proportionally less area to the camera, so the fired
	// set still clusters about the specular direction instead of spraying evenly
	// over the slope (checklist 25 wants sparse and intense, not a uniform field).
	lobe *= saturate( dot( facet, wN ) );
	// Kill a lattice once its cells drop under ~1.4 px.  Below that there is more
	// than one cell per fragment, only one of them is ever evaluated, and the
	// field turns into shimmer.  0.72 (was 0.95) is the honest limit now that the
	// mark is a point inside the cell rather than the cell itself.
	float sizeFade = 1.0 - smoothstep( 0.28, 0.72, sohoFootprint * density );
	return lobe * spot * alive * sizeFade;
}

/** Mikkelsen bump-from-screen-derivatives (as used by three's bumpmap chunk). */
vec3 sohoPerturb( vec3 N, vec3 dpdx, vec3 dpdy, float dhdx, float dhdy ) {
	vec3 r1 = cross( dpdy, N );
	vec3 r2 = cross( N, dpdx );
	float det = dot( dpdx, r1 );
	vec3 grad = sign( det ) * ( dhdx * r1 + dhdy * r2 );
	return normalize( abs( det ) * N - grad );
}
`;

/**
 * Replacement tail for `RE_Direct_Physical`.  Everything above it in the stock
 * function (clearcoat, sheen, the GGX specular) is left untouched; we only
 * swap the Lambert diffuse for the five-term snow response.
 */
const RE_DIRECT_SNOW = /* glsl */ `
#ifdef SOHO_SNOW

	{
		vec3 sL = directLight.direction;
		vec3 sV = geometryViewDir;
		vec3 sN = geometryNormal;
		float ndl = dot( sN, sL );

		// (a) Wrapped multiple-scatter diffuse.  Photons enter on the lit side
		//     of a bump and leave on the dark side, so the terminator spreads an
		//     extra ~24 deg at w = 0.40.  Normalised by (1 + w) to hold albedo.
		float w = sohoWrap;
		float wrapped = saturate( ( ndl + w ) / ( 1.0 + w ) );
		reflectedLight.directDiffuse += directLight.color * wrapped * BRDF_Lambert( material.diffuseContribution );

		// (b) Forward-scatter lobe.  cos of the scattering angle between the
		//     photon's incoming direction (-L) and its outgoing direction (V):
		//     it peaks when you look *toward* the sun across a slope, which is
		//     the blinding-when-you-skin-up-and-dull-when-you-turn-around effect.
		float cosPhase = - dot( sL, sV );
		float grazing = 1.0 - saturate( dot( sN, sV ) );
		float fw = sohoHG( cosPhase, 0.62 ) * uForwardStrength * sohoForwardMul * ( 0.65 + 1.05 * grazing );
		reflectedLight.directDiffuse += directLight.color * ( fw * saturate( ndl + 0.25 ) ) * material.diffuseContribution * RECIPROCAL_PI;

		// (c) Transport blue emerging just past the terminator.  Ice absorbs
		//     ~30x more at 700 nm than at 450 nm, so a long path returns cyan.
		float trans = smoothstep( 0.30, -0.35, ndl ) * sohoSSSAmount;
		reflectedLight.directDiffuse += directLight.color * ( trans * 0.85 ) * uSssColor * material.diffuseContribution * RECIPROCAL_PI;

		// (e) Crystal glints — two non-harmonic world lattices.  The second one
		//     used to run at 3.87x the density and 0.7x the coverage, i.e. ~4000
		//     live cells per square metre, which is where most of the uniform dim
		//     glitter field came from.  2.13x / 0.40x keeps the near-field
		//     richness without the carpet.
		vec3 Hw = normalize( ( vec4( normalize( sL + sV ), 0.0 ) * viewMatrix ).xyz );
		float gl = sohoGlintLayer( vSnowWorldPos, sohoNormalW, Hw, uGlint.x, uGlint.y, uGlint.w, 0.0 );
		gl += 0.45 * sohoGlintLayer( vSnowWorldPos, sohoNormalW, Hw, uGlint.x * 2.13, uGlint.y * 0.75, uGlint.w * 0.40, 17.0 );
		reflectedLight.directSpecular += directLight.color * ( gl * uGlint.z * sohoGlintMul * saturate( ndl * 5.0 ) );
	}

#else

	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );

#endif
`;

/**
 * Indirect side.  The direct sun term must stay neutral or LAW 1 breaks, so the
 * transport tint is applied to the sky/bounce term only — which is also where
 * it physically belongs: an occluded pocket sees less sky and proportionally
 * more of the pack's own red-depleted multiply-scattered light.
 *
 * The concavity gate (`sohoSSSAmount`) is correct for the *direct* transport
 * term but is approximately zero on an open planar slope, which is most of every
 * frame — so gating the indirect tint on it too made the whole thing a no-op
 * exactly where LAW 2 is measured.  Shadowed snow therefore came out grey
 * (B/R 1.01–1.12 against a ≥ 1.20 requirement) on seven of nine frames.
 *
 * So the indirect tint gets a floor driven by *being in shadow*, which is the
 * physical condition the blue actually depends on: a shadowed patch is by
 * definition lit by a 12–18 kK sky and by red-depleted snow-bounce rather than
 * by the beam.  Two independent shadow signals, because either alone misses
 * half the cases:
 *
 *   `sunAway`  — the surface is turned away from the sun (self-shadowed).
 *                Zero the instant N·L rises past 0.125 — which under a 10.6 deg
 *                sun is already below flat ground — so every sun-facing surface
 *                keeps its neutral off-white and LAW 1 is untouched.
 *   `sunOccl`  — the surface faces the sun but something is between it and the
 *                sun.  Recovered from the ratio of accumulated direct to
 *                indirect diffuse, both of which are live at this point in the
 *                shader: in the beam that ratio is ~1–4 (LAW 3 puts the fill at
 *                0.22–0.55 of sunlit), inside a cast shadow it is ~0.  No extra
 *                shadow-map fetch, no dependency on another module's chunk
 *                patch, and it tracks the PCF kernel exactly.
 *
 * Two corrections over the round-1 form of this block, both of which are about
 * *which* physical quantity the tint stands for rather than about its size:
 *
 *  1. **It is an illuminant, not a transport tint.**  The colour used here was
 *     `uSssTint` — `CONFIG.snow.sssColor` max-normalised.  §3.2 is explicit
 *     that `sssColor` is Blue #2, the *transport* tint, and that collapsing the
 *     two mechanisms into one is the classic failure.  The shadow fill is
 *     Blue #1: a 15,000 K sky, i.e. §4.2's (0.63, 0.76, 1.00).  The two happen
 *     to be within 4% of each other in B/R, so this is a semantics fix that
 *     deliberately does not move the measured number — but it means a future
 *     change to `sssColor` (a trench-wall property) no longer silently rotates
 *     every shadow in the game.  The transport tint is still mixed in where the
 *     concavity gate says the pocket is deep enough to earn it.
 *
 *  2. **It must not steal fill luminance.**  §4.4's last bullet: shadow colour
 *     comes from the fill, "not from multiplying to black".  A raw
 *     `mix(1, tint, a)` is a multiply by a vector whose every component is <= 1,
 *     so it darkened the shadowed fill by 13% — a *level* change smuggled in
 *     under a *hue* change, and level is exactly the quantity LAW 3 measures.
 *     Renormalising to unit luminance makes this a pure chromaticity rotation:
 *     the fill keeps its level and only its colour moves, which is the honest
 *     stand-in for "in shadow you keep the blue sky and lose the neutral snow
 *     bounce" that `sky.js` delivers structurally.
 *
 * Sizing, held deliberately still.  Measured over `shots/r6`, shadow B/R lands
 * at 1.204 / 1.264 / 1.368 / 1.417 on the four frames that contain a real cast
 * shadow — that is LAW 2 satisfied, and the six "failures" are frames whose
 * 10th-percentile snow pixel is not in shadow at all (see the fill-ratio work
 * in SNOW_SURFACE).  So the ceiling moves 0.55 -> 0.52 purely to cancel the
 * +4% B/R that the sky illuminant carries over the transport tint, holding the
 * fill's B/R multiplier at 1.238 (was 1.236).  Nothing here is re-tuned; the
 * frames that pass must keep passing.
 */
const INDIRECT_TINT = /* glsl */ `
#ifdef SOHO_SNOW
	{
		// 8.0, not 4.0: the sun is only 10.6 deg up, so flat ground sits at
		// N·L = 0.184 and a gentler ramp would call the whole sunlit basin floor
		// "turned away" and tint its fill.  This zeroes past N·L = 0.125.
		float sunAway = 1.0 - saturate( dot( sohoNormalW, uSunDirWorld ) * 8.0 );
		float beamLum = dot( reflectedLight.directDiffuse, vec3( 0.2126, 0.7152, 0.0722 ) );
		float fillLum = dot( reflectedLight.indirectDiffuse, vec3( 0.2126, 0.7152, 0.0722 ) );
		// Beam-to-fill ratio: >= 0.32 anywhere the beam actually lands (LAW 3
		// caps the fill at 0.55 of sunlit, i.e. a ratio of 0.8), ~0 inside a cast
		// shadow.  The knee sits low so penumbra ramps rather than steps.
		float sunOccl = 1.0 - smoothstep( 0.04, 0.32, beamLum / max( fillLum, 1.0e-5 ) );
		float concav = saturate( sohoSSSAmount );
		float shadowTint = max( concav, 0.52 * max( sunAway, sunOccl ) * sohoSnowness );
		// Chromaticity of the light that survives into shadow: the 15,000 K sky
		// (§4.2), pulled toward the pack's own red-depleted transport colour only
		// where the concavity gate says the photons took a long path (§3.2).
		vec3 fillCol = mix( uSkyFillTint, uSssTint, concav );
		vec3 tint = mix( vec3( 1.0 ), fillCol, shadowTint );
		// Pure hue rotation: unit luminance, so LAW 3's ratio is untouched.
		tint /= max( dot( tint, vec3( 0.2126, 0.7152, 0.0722 ) ), 1.0e-4 );
		reflectedLight.indirectDiffuse *= tint;
	}
#endif
`;

/**
 * The snow surface block.  Injected after `<normal_fragment_begin>`, which is
 * the one point in the physical shader where `diffuseColor`, `roughnessFactor`,
 * `normal` and `nonPerturbedNormal` are all live and nothing downstream has
 * consumed them yet.
 */
const SNOW_SURFACE = /* glsl */ `
	/* ---------------- SOHO SNOW SURFACE ---------------- */
	vec3 sohoWP = vSnowWorldPos;
	float sohoDist = length( vViewPosition );
	// World-space size of one pixel on this surface.  Everything fades against
	// this rather than against raw distance, so detail disappears at exactly the
	// point where it stops being resolvable instead of at an arbitrary radius.
	sohoFootprint = max( 1.0e-4, length( fwidth( sohoWP.xz ) ) );
	vec3 sohoWN = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );

	// ---- surface class (see SNOW_VERTEX_ATTRIBUTES) ----
	float sfGroom = clamp( vSnowSurface.x, 0.0, 1.0 );
	float sfWind  = clamp( vSnowSurface.y, 0.0, 1.0 );
	float sfIce   = clamp( vSnowSurface.z, 0.0, 1.0 );
	float sfCover = clamp( vSnowSurface.w, 0.0, 1.0 );
	float sfPow   = clamp( 1.0 - sfGroom - sfWind - sfIce, 0.0, 1.0 );
	float sfNorm  = 1.0 / max( sfPow + sfGroom + sfWind + sfIce, 1.0e-3 );
	sfPow *= sfNorm; sfGroom *= sfNorm; sfWind *= sfNorm; sfIce *= sfNorm;

	// Snow does not hold above ~55 deg and is gone by ~68 deg, whatever the
	// heightfield claims (ART_DIRECTION §11.21).
	float steep = 1.0 - saturate( sohoWN.y );
	float rockMask = max( 1.0 - sfCover, smoothstep( 0.40, 0.63, steep ) );

	// ---- detail lookups ----
	mat2 windM = mat2( uWindDir.x, -uWindDir.y, uWindDir.y, uWindDir.x );
	vec2 uvG1 = sohoWP.xz / uDetailScale.x;
	vec2 uvG2 = ( SOHO_ROT2 * sohoWP.xz ) / uDetailScale.y + vec2( 0.31, 0.77 );
	vec2 uvDr = ( windM * sohoWP.xz ) / uDetailScale.z;
	vec2 uvMc = sohoWP.xz / uDetailScale.w;

	vec4 tG1 = texture2D( uSnowGrain, uvG1 );
	vec4 tDr = texture2D( uSnowDrift, uvDr );
	vec4 tMc = texture2D( uSnowMacro, uvMc );
	#if SOHO_QUALITY > 1
		vec4 tG2 = texture2D( uSnowGrain, uvG2 );
	#else
		vec4 tG2 = vec4( 0.5, 0.5, 0.0, 0.5 );
	#endif

	// ---- detail fades ----
	// Two independent guards per band, and BOTH are needed:
	//
	//   * a footprint guard, which deletes a layer once its features stop being
	//     resolvable (a Nyquist argument), and
	//   * a distance guard, which deletes it once physics has deleted the
	//     contrast whether or not the pixels could still resolve it — §5.3
	//     item 1: "fade detail-normal amplitude to zero over 40 -> 250 m.  Most
	//     of the missing far-field contrast reduction is an LOD bug, not a fog
	//     bug."
	//
	// Band 3 (the drift/sastrugi map) previously had ONLY the footprint guard,
	// and that guard was written against the 11 m *tile* rather than the 1.375 m
	// *ripple* the tile carries.  On a facing slope across the basin a pixel
	// covers ~0.8 m at 300 m, so the guard was still passing 60% amplitude at
	// 150 m and did not reach zero until ~280 m.  The result was a regular 6-8 px
	// corrugation running unbroken over hundreds of metres of mid-slope, which
	// put more local contrast in the FAR field than in the near one and inverted
	// the near/far sigma ratio (checklist 17 / 27, measured 0.18-1.92 against a
	// >= 4.0 gate).  It now carries the same 40 -> 250 m fade the grain layers do.
	float fadeFar = 1.0 - smoothstep( uDetailFade.x, uDetailFade.y, sohoDist );
	// The macro band is 4.25 m features, an order of magnitude coarser, so it is
	// allowed to survive much further out — it is what carries the old tracks and
	// the broad settling into the mid field (checklist 28) — but it too has to end.
	float fadeMacro = 1.0 - smoothstep( uDetailFade.x * 3.5, uDetailFade.y * 2.6, sohoDist );
	// The grain layer's guard used a 24x multiplier, which drove f1 to zero once
	// the pixel footprint passed ~1.7 cm — i.e. at 3-10 m, exactly the range the
	// near-field grain is supposed to be carrying.  A 0.37 m tile is only
	// genuinely sub-pixel around 7 cm/px, so 6.0 is the Nyquist-honest number and
	// 24.0 was simply deleting the near field (checklist 4 / 27).
	float f1 = ( 1.0 - smoothstep( 0.30, 1.10, sohoFootprint * 6.0 / uDetailScale.x ) ) * fadeFar;
	float f2 = ( 1.0 - smoothstep( 0.30, 1.10, sohoFootprint * 24.0 / uDetailScale.y ) ) * fadeFar;
	// 1.375 m sastrugi wavelength inside an 11 m tile (bakeSnowDrift: P = 8 over
	// uDetailScale.z), so the footprint guard has to be written against the
	// RIPPLE, not the tile: half amplitude by a quarter wavelength per pixel,
	// gone by half a wavelength per pixel.
	float sastLambda = uDetailScale.z / 8.0;
	float f3 = ( 1.0 - smoothstep( 0.25 * sastLambda, 0.50 * sastLambda, sohoFootprint ) ) * fadeFar;
	float f4 = ( 1.0 - smoothstep( 0.30, 1.10, sohoFootprint * 20.0 / uDetailScale.w ) ) * fadeMacro;

	// ---- snow-on-rock: never a razor edge ----
	// Accumulation is biased by aspect (up-facing ledges hold), by the drift
	// field (so the boundary is drift-shaped) and by the macro cavity field (so
	// snow lodges in crevices).  ART_DIRECTION §6.1 / §11.22.
	// The blend band is deliberately wide (0.18 -> 0.78) and is pushed around at
	// three scales: 34 m lobes so the snow line wanders across the rib, 11 m
	// drift lobes so it is scalloped, and grain-scale grit so the last centimetre
	// is ragged.  A one-quad-wide ramp straight off the vertex attribute is the
	// razor edge the art direction calls the most damning tell in the document.
	//
	// Both noise biases are gated on rockMask and faded with their own
	// footprint.  Ungated they summed to a +-0.535 swing applied to *every*
	// fragment, so an 11 m drift lobe alone could push a fully snow-covered
	// 25 deg rollover under the 0.18 floor and scour a whole near slope back to
	// bare schist in wind-aligned smears (the "brown mud" near field).  A face
	// with rockMask = 0 has no rock within reach of the surface, so noise must
	// not be able to invent any; where rock genuinely is near the surface the
	// boundary is still drift-shaped, which is the only place the art direction
	// asks for it.  f3/f4 stop the same terms manufacturing an 11 m-period snow
	// line at 800 m, which is far-field contrast physics already deleted
	// (checklist 27).
	float accum = saturate(
		( 1.0 - rockMask ) * 1.25
		+ ( tMc.z - 0.5 ) * 0.45 * f4 * rockMask
		+ ( tDr.w - 0.5 ) * 0.62 * f3 * rockMask
		+ ( tG1.z - 0.5 ) * 0.18 * f1
		+ ( sohoWN.y - 0.55 ) * 0.70 * uSnowOnRock
	);
	float snowAmt = smoothstep( 0.18, 0.78, accum );
	// Wind moat: rock re-radiates absorbed sun and melts the pack back 10-40 cm,
	// leaving a narrow shadowed gap right at the boundary.
	float moat = ( 1.0 - snowAmt ) * smoothstep( 0.02, 0.20, accum );
	// ...and a bright lip of drifted snow on the other side of it.
	float snowLip = smoothstep( 0.20, 0.40, accum ) * ( 1.0 - smoothstep( 0.40, 0.62, accum ) );
	float rockF = 1.0 - snowAmt;

	// ---- track / carve splat (ctx.trails) ----
	// Channels are documented on SNOW_TRACK_TEXTURE_CHANNELS.  A board cannot cut
	// a trench into schist, so everything here is gated on snow cover.
	float trkTrench = 0.0;
	float trkTrenchRel = 0.0;
	float trkLipRel = 0.0;
	float trkLip = 0.0;
	float trkComp = 0.0;
	#ifdef USE_TRACK_MAP
		vec2 tuv = ( sohoWP.xz - uTrackRegion.xy ) * uTrackRegion.zw;
		// Smooth-bilinear for the RELIEF only: bilinear is C0, so the relief
		// pass's screen derivatives jump at every 15.6 cm texel boundary and
		// light each texel as a flat facet - the stair-stepped block trail of
		// rounds 5-6. The warp snaps toward texel centres, which is exactly
		// wrong for the ALBEDO of a texel-wide track line (it beads into a
		// dotted chain), so the colour terms keep the raw bilinear lookup and
		// the relief pays one extra fetch at the warped coordinate.

		vec2 tin = step( vec2( 0.0 ), tuv ) * step( tuv, vec2( 1.0 ) );
		vec4 tk = texture2D( uTrackMap, clamp( tuv, 0.0, 1.0 ) ) * ( tin.x * tin.y * ( 1.0 - rockF ) );
		trkTrench = saturate( tk.r * tk.a ) * uTrackStrength;
		trkLip    = saturate( tk.g * tk.a ) * uTrackStrength;
		trkComp   = saturate( tk.b * tk.a );
		// Relief needs a C1 field: bilinear's derivative jumps at every texel
		// boundary and lights each one as a flat facet (the block-trail of
		// rounds 5-6), while snapping the sample toward texel centres beads a
		// texel-wide line into a dotted chain (round 7). Bicubic B-spline via
		// the 4-bilinear-fetch trick is genuinely smooth in both value and
		// derivative, at every range, with no snapping.
		{
			vec2 tsz = vec2( textureSize( uTrackMap, 0 ) );
			vec2 st = tuv * tsz - 0.5;
			vec2 ip = floor( st );
			vec2 f = st - ip;
			vec2 f2 = f * f, f3 = f2 * f;
			vec2 w0 = ( 1.0 - 3.0 * f + 3.0 * f2 - f3 ) / 6.0;
			vec2 w1 = ( 4.0 - 6.0 * f2 + 3.0 * f3 ) / 6.0;
			vec2 w2 = ( 1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3 ) / 6.0;
			vec2 w3 = f3 / 6.0;
			vec2 g0 = w0 + w1, g1 = w2 + w3;
			vec2 h0 = ( ip + 0.5 + w1 / g0 - 1.0 ) / tsz;
			vec2 h1 = ( ip + 0.5 + w3 / g1 + 1.0 ) / tsz;
			vec4 tA = texture2D( uTrackMap, clamp( vec2( h0.x, h0.y ), 0.0, 1.0 ) );
			vec4 tB = texture2D( uTrackMap, clamp( vec2( h1.x, h0.y ), 0.0, 1.0 ) );
			vec4 tC = texture2D( uTrackMap, clamp( vec2( h0.x, h1.y ), 0.0, 1.0 ) );
			vec4 tD = texture2D( uTrackMap, clamp( vec2( h1.x, h1.y ), 0.0, 1.0 ) );
			vec4 tkR = ( mix( mix( tB, tA, g0.x ), mix( tD, tC, g0.x ), g1.y ) )
				* ( tin.x * tin.y * ( 1.0 - rockF ) );
			trkTrenchRel = saturate( tkR.r * tkR.a ) * uTrackStrength;
			trkLipRel    = saturate( tkR.g * tkR.a ) * uTrackStrength;
		}
	#endif

	// TERRAIN_BRIEF §2.8 is categorical: "Sastrugi (only where surface ∈
	// {'windpack','ice'})".  The old weight ran the band at 0.30 on powder,
	// which painted a wind-carved 1.375 m ripple field across the 52% of the
	// basin that is deep, smooth, lee-side powder — i.e. across the entire
	// shadowed mid-slope, which is exactly where the corrugation was reported.
	//
	// But the drift map is a superposition of TWO phenomena (bakeSnowDrift):
	// the sastrugi sawtooth, and 3-8 m wind pillows and dunes.  Only the first
	// is windpack-exclusive; the dunes are lee deposition and are the reason
	// powder is not a flat plane.  Zeroing the whole band on powder would throw
	// the dunes away with the sastrugi and leave half the mountain plastic.
	// tDr.z is the bake's own sastrugi crest mask, so the two separate
	// per-fragment: wind-worked snow gets the whole map, everything else keeps
	// the map away from the crests and loses it on them.  Groomed corridors are
	// tilled flat and keep almost none of it — the corduroy term below is their
	// surface structure.
	float windWorked = saturate( sfWind + 0.55 * sfIce );
	float sastrugiW = mix( 1.0 - tDr.z, 1.0, windWorked ) * ( 1.0 - 0.80 * sfGroom );

	// (f) Surface-state variation WITHIN a class.  terrain.sample() classifies on
	// a ~4 m post spacing, but the pack varies at 1-10 m: crests are scoured,
	// wind-hardened and smoother; troughs hold softer, deeper, rougher snow.
	// Without this the frame has exactly as many snow types as the classifier
	// has classes and reads as a single material (checklist 18).  Driven off the
	// drift height and the macro breakup, and carried by the same two fades as
	// the geometry they describe so it never manufactures far-field contrast.
	float packVar = ( tDr.w - 0.5 ) * 1.20 * f3 + ( tMc.z - 0.5 ) * 0.70 * f4;

	// ---- height gradients, summed across scales ----
	// (chain rule: a lookup at uv = A * p has world gradient A^T * g, which in
	//  GLSL is written g * A)
	vec2 grad = vec2( 0.0 );
	grad += ( tG1.xy * 2.0 - 1.0 ) * ( uDetailAmp.x * f1 * ( 1.0 - 0.70 * sfGroom ) );
	grad += ( ( tG2.xy * 2.0 - 1.0 ) * SOHO_ROT2 ) * ( uDetailAmp.y * f2 * ( 1.0 - 0.60 * sfGroom ) );
	grad += ( ( tDr.xy * 2.0 - 1.0 ) * windM ) * ( uDetailAmp.z * f3 * sastrugiW );
	grad += ( tMc.xy * 2.0 - 1.0 ) * ( uDetailAmp.w * f4 );

	// Corduroy: tiller ribs run across the fall line (game -Z), analytic so it
	// stays perfectly straight against the noisy hillside.
	float cordFade = 1.0 - smoothstep( 0.22, 0.85, sohoFootprint / uCorduroySpacing );
	float cordPhase = sohoWP.z * ( 6.2831853 / uCorduroySpacing );
	float cordAmp = sfGroom * cordFade * ( 1.0 - rockF );
	grad.y += sin( cordPhase ) * 0.20 * cordAmp;

	// Refrozen ice is a near-slab: flatten almost everything.
	grad *= ( 1.0 - 0.85 * sfIce );
	// Rock reads through its own analytic foliation, not the snow detail.
	grad *= ( 1.0 - 0.85 * rockF );

	// ---- perturb the normal (Mikkelsen surface gradient) ----
	vec3 sgX = vec3( 1.0, 0.0, 0.0 ) - sohoWN * sohoWN.x;
	vec3 sgZ = vec3( 0.0, 0.0, 1.0 ) - sohoWN * sohoWN.z;
	vec3 nW = normalize( sohoWN + ( grad.x * sgX + grad.y * sgZ ) * uNormalStrength );

	// Schist foliation: one strike and one dip for the whole basin, so every
	// exposure agrees.  Fine banding plus a coarse platy step.
	float folC = dot( sohoWP, uFoliationN );
	float folA = sin( folC * ( 6.2831853 / uFoliationSpacing ) );
	float folB = sin( folC * ( 6.2831853 / ( uFoliationSpacing * 7.3 ) ) + 1.7 );
	vec3 folT = uFoliationN - nW * dot( nW, uFoliationN );
	// Nyquist-honest fades. These are sines of fixed WORLD period: once the
	// pixel footprint passes half that period the sample points cannot carry
	// the wave, and what comes out is not "faint banding", it is a MOIRE - a
	// beat between the sine and the pixel grid at a much longer wavelength.
	// The old fade (0.22 -> 0.85 of the period) still passed ~50% amplitude at
	// 0.53 periods per pixel, i.e. it faded the band out through a regime
	// where every remaining percent was pure alias. Because the band's phase
	// is dot(P, foliationN), the moire's crests run along the bedding strike
	// on every slope - which is contour-parallel - and that is exactly the
	// corduroy that survived nine geometry-side ablations (FINDINGS_R3).
	// Amplitude must reach zero BEFORE footprint = period/2, with margin for
	// the rasteriser's 2x2 derivative quads: gone by 0.4 periods per pixel.
	float folFade = 1.0 - smoothstep( 0.12, 0.40, sohoFootprint / uFoliationSpacing );
	float folFadeB = 1.0 - smoothstep( 0.12, 0.40, sohoFootprint / ( uFoliationSpacing * 7.3 ) );
	folB *= folFadeB;
	// Bedding shows on INTACT outcrop, not on scree: broken rock has no shared
	// foliation phase, so a coherent band across a 30-degree talus slope is a
	// geological impossibility (and reads as corduroy). The shader cannot see
	// the surface classification, but steepness is an honest proxy - schist
	// only stands as outcrop above its talus angle, so full banding below
	// nY 0.57 (55 deg, the bluff faces) fading to none by nY 0.72 (44 deg).
	float folSteep = smoothstep( 0.72, 0.57, sohoWN.y );
	nW = normalize( nW + folT * ( ( folA * 0.18 * folFade + folB * 0.24 ) * rockF * folSteep ) );

	#ifdef USE_TRACK_MAP
		// The trench is a real depression: 16 cm down, with a 6 cm displaced lip.
		//
		// Same Nyquist rule as the foliation: the relief comes from screen
		// derivatives of a 15.6 cm-texel map, and once the pixel footprint
		// approaches the texel size each texel boundary fires its own
		// derivative spike — the track turns into a dotted line of beads
		// (round-4 RT probe: the stamped texture itself is perfectly
		// continuous). Fade the relief out by footprint; the albedo and
		// compaction terms are plain bilinear lookups and carry the track at
		// distance on their own.
		float trkFade = 1.0 - smoothstep( 0.10, 0.38, sohoFootprint / 0.156 );
		float trkH = ( trkLipRel * 0.06 - trkTrenchRel * 0.16 ) * trkFade;
		nW = sohoPerturb( nW, dFdx( sohoWP ), dFdy( sohoWP ), dFdx( trkH ), dFdy( trkH ) );
	#endif

	sohoNormalW = nW;
	normal = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );

	vec3 upRef = abs( nW.y ) < 0.9 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
	sohoTanW = normalize( cross( upRef, nW ) );
	sohoBitW = cross( nW, sohoTanW );

	// ---- albedo ----
	// LAW 1: sunlit snow is a NEUTRAL off-white.  The blue lives in the light
	// and in the transport term, never in the base colour.
	vec3 albedo =
		  vec3( 0.860, 0.862, 0.868 ) * sfPow
		+ vec3( 0.795, 0.800, 0.811 ) * sfWind
		+ vec3( 0.772, 0.776, 0.788 ) * sfGroom
		+ vec3( 0.470, 0.535, 0.615 ) * sfIce;
	albedo *= uAlbedoScale;
	// Every planar-projected albedo modulation fades with the same footprint
	// envelope as the detail normals. Left unfaded, these XZ textures stretch
	// into vertical curtain streaks on every steep far face - the persistent
	// smear bands on the range wall. (Computed here because the detail
	// section's rockFade is declared later in the shader.)
	float texFade = 1.0 - smoothstep( 0.30, 1.10, sohoFootprint * 20.0 / uRockScale );
	albedo *= 1.0 + ( tMc.z - 0.5 ) * 0.10 * f4 * texFade;       // broad breakup
	albedo *= 1.0 - tG1.z * 0.045 * f1 * texFade;                // micro cavity
	albedo *= 1.0 + ( tDr.z - 0.5 ) * 0.07 * sastrugiW * f3 * texFade; // scoured crests
	albedo *= 1.0 + sin( cordPhase ) * 0.038 * cordAmp * texFade; // corduroy +-4%
	// Old-scar streaks removed entirely (playtest: they read as OTHER
	// RIDERS' tracks, and the fantasy is untouched snow - only the live
	// trail may mark the pack).
	// albedo *= 1.0 - tMc.w * 0.06 * f4 * texFade * smoothstep( 0.30, 0.70, tDr.w );
	// ---- kicker dye ----
	// A wind lip is white snow on a white slope, so the takeoff edge has no
	// silhouette to read on approach. Parks solve it with blue dye and so
	// does Shredders: a bar across the lip, rails down the corridor feeding
	// it. The rails carry the cue at distance — converging in perspective,
	// they point at the lip from far enough out to set up for it, which a
	// single transverse line cannot do.
	//
	// Painted here rather than as draped geometry on purpose: a decal mesh
	// z-fights the clipmap (the LOD ring under it carries a different
	// height than the one the ribbon was built from) and breaks into
	// dashes exactly at the crest, which is worse than no marking at all.
	// Evaluated against world XZ, it lands on the surface at every LOD.
	float dye = 0.0;
	if ( uDyeCount > 0.5 ) {
		// One pixel's worth of softness, floored so a near-flat grazing
		// view still antialiases instead of crawling.
		// Clamped: at a grazing angle one pixel legitimately covers metres of
		// ground, and an unclamped footprint turns the softening band — and
		// the minimum width below — into a several-metre smear.
		float dyeAA = clamp( sohoFootprint, 0.06, 0.45 );
		// Minimum apparent width. A 60 cm rail seen down the fall line is
		// sub-pixel well before 30 m, and a sub-pixel line does not read as
		// a faint line — antialiasing dissolves it into a wash, which is
		// how the first pass lost exactly the far-approach cue the rails
		// exist to give. Widen in world space to hold roughly a pixel and
		// the line keeps its colour all the way out.
		// Capped at roughly twice nominal for the same reason.
		float railHW = clamp( sohoFootprint * 0.5, 0.55, 1.15 );
		float barHW  = clamp( sohoFootprint * 0.5, 1.30, 2.10 );
		for ( int i = 0; i < SOHO_MAX_DYE; i++ ) {
			if ( float( i ) >= uDyeCount ) break;
			vec4 K = uDye[ i ];
			vec2 r = sohoWP.xz - K.xy;
			float s = dot( r, K.zw );                  // along the run
			float t = r.y * K.z - r.x * K.w;           // across it
			// Bar just below the crest: on the ramp face where the rider
			// sees it, not over the lee where the lip hides it.
			float bar = ( 1.0 - smoothstep( barHW - dyeAA, barHW + dyeAA, abs( s + 1.3 ) ) )
			          * ( 1.0 - smoothstep( 10.5 - dyeAA, 10.5 + dyeAA, abs( t ) ) );
			// Corridor rails, 30 m of run-in — the distance a lip needs to
			// be legible from to be rideable.
			float rail = ( 1.0 - smoothstep( railHW - dyeAA, railHW + dyeAA, abs( abs( t ) - 10.5 ) ) )
			           * ( 1.0 - smoothstep( 0.0, dyeAA + 0.5, -( s + 30.0 ) ) )
			           * ( 1.0 - smoothstep( 0.0, dyeAA + 0.5, s + 1.3 ) );
			dye = max( dye, max( bar, rail ) );
		}
		// Dye soaks snow, not schist.
		dye *= 1.0 - rockF;
	}
	// Multiplicative, so the line is *dyed snow*: it takes the sun, the
	// terrain shadow and the aerial the surface under it already has,
	// instead of reading as a decal pasted over the top.
	albedo *= mix( vec3( 1.0 ), vec3( 0.30, 0.56, 0.94 ), dye );

	albedo *= 1.0 - trkTrench * 0.15;
	albedo *= 1.0 + trkLip * 0.05;
	albedo *= 1.0 + snowLip * 0.05;                              // drift lip at the rock edge

	// ---- rock, blended in on the steep and the scoured ----
	vec2 rockUvA = sohoWP.xz / uRockScale;
	vec3 hDir = normalize( vec3( sohoWN.x, 1.0e-4, sohoWN.z ) );
	vec2 rockUvB = vec2( dot( sohoWP.xz, vec2( -hDir.z, hDir.x ) ), sohoWP.y ) / uRockScale;
	vec3 rockA = texture2D( uRockPack, rockUvA ).rgb;
	#if SOHO_QUALITY > 1
		vec3 rockB = texture2D( uRockPack, rockUvB ).rgb;
		vec3 rockAlb = mix( rockA, rockB, smoothstep( 0.22, 0.72, steep ) );
	#else
		vec3 rockAlb = rockA;
	#endif
	// Same rule for the rock pack itself: at wall distance a stretched texel
	// column is a streak; flatten to the pack's mean and let N.L + aerial
	// carry the form.
	rockAlb = mix( rockAlb, vec3( 0.52, 0.50, 0.47 ), 1.0 - texFade );
	rockAlb *= uRockTint;
	rockAlb *= 1.0 + folA * 0.16 * folFade + folB * 0.10;
	rockAlb = mix( rockAlb, rockAlb * vec3( 1.20, 1.00, 0.76 ), saturate( folB * 0.6 + 0.35 ) * 0.30 );
	rockAlb *= 1.0 - moat * 0.24;

	// Sub-resolution snow dusting. Past a couple hundred metres a "rock"
	// pixel is a mixed pixel — bare schist, lichen, spindrift and clinging
	// snow the geometry cannot resolve — and real distant scree reads as
	// grey-on-white, not ink-on-white. The round-4 ablation (props hidden,
	// sun shadows off, blobs unchanged) pinned the wide-shot "floating dark
	// smudges" on exactly this un-dusted classify albedo.
	float rockDust = smoothstep( 220.0, 750.0, sohoDist ) * 0.52;
	rockAlb = mix( rockAlb, albedo, rockDust );

	diffuseColor.rgb *= mix( albedo, rockAlb, rockF );

	// ---- roughness ----
	float rough = uSurfRough.x * sfPow + uSurfRough.y * sfWind + uSurfRough.z * sfGroom + uSurfRough.w * sfIce;
	rough *= 0.90 + 0.18 * tG1.w;
	// Crests are wind-hardened and slightly smoother, troughs softer and rougher
	// (§3.4f, §3.1's albedo/roughness-by-state table).  +-13% is a state change,
	// not a texture: it is visible as the slope changing character across a
	// drift, which is what stops one snow reading everywhere.
	rough *= 1.0 - 0.13 * packVar;
	rough = mix( rough, rough * 0.80, trkComp );
	rough = mix( rough, rough * 0.86, tMc.w * 0.6 );
	rough = mix( rough, uRockRough, rockF );
	// Sub-pixel normal variance becomes roughness once detail stops resolving.
	// Without this the far field turns into a shimmering specular fizz.
	rough += 0.10 * smoothstep( 60.0, 420.0, sohoDist ) * ( 1.0 - rockF );
	roughnessFactor = clamp( rough, 0.05, 1.0 );

	// ---- shading-model scalars ----
	sohoWrap = uSurfWrap.x * sfPow + uSurfWrap.y * sfWind + uSurfWrap.z * sfGroom + uSurfWrap.w * sfIce;
	// Same state axis as the roughness above: a wind-hardened crest transports
	// less and has a crisper terminator than the loose snow in the trough beside
	// it (§3.4a, "fresh loose powder w = 0.50, windpack 0.35").
	sohoWrap *= 1.0 - 0.16 * packVar;
	sohoWrap = mix( sohoWrap, 0.05, rockF );

	// Concavity gates the transport blue: trench interiors, drift undercuts,
	// cup bottoms and the lee of every pillow.  Everywhere else it must be zero
	// or the whole frame goes blue and LAW 1 fails.
	float concav = saturate( tMc.w * 0.45 + ( 1.0 - tDr.w ) * 0.32 + trkTrench * 1.30 + snowLip * 0.35 );
	sohoSSSAmount = uSssStrength * concav * ( 1.0 - rockF ) * ( 1.0 - 0.6 * sfIce );

	float glintFade = 1.0 - smoothstep( uGlintRange.x, uGlintRange.y, sohoDist );
	sohoGlintMul = glintFade * ( 1.0 - rockF )
		* ( sfPow + 0.75 * sfWind + 0.22 * sfGroom + 0.10 * sfIce )
		* ( 0.50 + 1.10 * tG1.w )
		* ( 1.0 - 0.70 * trkComp );

	sohoForwardMul = ( 1.0 - rockF ) * ( sfPow + 0.88 * sfWind + 0.72 * sfGroom + 0.25 * sfIce );
	sohoSnowness = ( 1.0 - rockF ) * ( 1.0 - 0.5 * sfIce );
	/* -------------- end SOHO SNOW SURFACE -------------- */
`;

/**
 * The rock surface block — NZ Otago schist, triplanar, with snow on every
 * up-facing ledge.  Shares the direct-lighting patch with the snow material so
 * that the snow which settles on a boulder gets the same wrap, forward scatter
 * and glints as the ground around it.
 */
const ROCK_SURFACE = /* glsl */ `
	/* ---------------- SOHO SCHIST SURFACE ---------------- */
	vec3 sohoWP = vSnowWorldPos;
	float sohoDist = length( vViewPosition );
	sohoFootprint = max( 1.0e-4, length( fwidth( sohoWP ) ) );
	vec3 sohoWN = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );

	// Triplanar weights, sharpened so the blend bands stay narrow.
	vec3 tw = pow( abs( sohoWN ), vec3( 4.0 ) );
	tw /= max( tw.x + tw.y + tw.z, 1.0e-4 );

	vec2 uvX = sohoWP.zy / uRockScale;
	vec2 uvY = sohoWP.xz / uRockScale;
	vec2 uvZ = sohoWP.xy / uRockScale;

	vec4 pX = texture2D( uRockPack, uvX );
	vec4 pY = texture2D( uRockPack, uvY );
	vec4 pZ = texture2D( uRockPack, uvZ );
	vec4 rp = pX * tw.x + pY * tw.y + pZ * tw.z;

	vec4 nX = texture2D( uRockNormal, uvX );
	vec4 nY = texture2D( uRockNormal, uvY );
	vec4 nZ = texture2D( uRockNormal, uvZ );
	vec4 rn = nX * tw.x + nY * tw.y + nZ * tw.z;

	float rockFade = 1.0 - smoothstep( 0.30, 1.10, sohoFootprint * 20.0 / uRockScale );

	vec3 axX = vec3( 1.0, 0.0, 0.0 ) - sohoWN * sohoWN.x;
	vec3 axY = vec3( 0.0, 1.0, 0.0 ) - sohoWN * sohoWN.y;
	vec3 axZ = vec3( 0.0, 0.0, 1.0 ) - sohoWN * sohoWN.z;

	vec2 gX = ( nX.xy * 2.0 - 1.0 );
	vec2 gY = ( nY.xy * 2.0 - 1.0 );
	vec2 gZ = ( nZ.xy * 2.0 - 1.0 );
	vec3 sg = vec3( 0.0 );
	sg += tw.x * ( gX.x * axZ + gX.y * axY );
	sg += tw.y * ( gY.x * axX + gY.y * axZ );
	sg += tw.z * ( gZ.x * axX + gZ.y * axY );
	// 0.55 keeps the plate relief believable at a 2.4 m tile; the map itself is
	// normalised to a 0.88 peak gradient, which is a 41 deg facet and far too
	// aggressive for a schist face seen from 3 m.
	vec3 nW = normalize( sohoWN + sg * ( uNormalStrength * rockFade * 0.55 ) );

	// One foliation plane for the whole basin: strike +38 deg from +X, dip 32.
	// Real foliation is a consistent *orientation*, not a consistent *spacing*.
	// Jittering the phase with the plate-height field turns a mechanical comb
	// into irregular layering while keeping the strike and dip globally exact.
	float folC = dot( sohoWP, uFoliationN ) + ( rn.w - 0.5 ) * uFoliationSpacing * 3.2;
	float folA = sin( folC * ( 6.2831853 / uFoliationSpacing ) ) * ( 0.35 + 1.05 * rn.z );
	float folB = sin( folC * ( 6.2831853 / ( uFoliationSpacing * 7.3 ) ) + 1.7 );
	float folFade = 1.0 - smoothstep( 0.22, 0.85, sohoFootprint / uFoliationSpacing );
	// Same Nyquist guard as the snow material's rock blend: the coarse band is
	// sub-pixel by ~200 m and aliases without it.
	float folFadeB = 1.0 - smoothstep( 0.22, 0.85, sohoFootprint / ( uFoliationSpacing * 7.3 ) );
	folB *= folFadeB;
	vec3 folT = uFoliationN - nW * dot( nW, uFoliationN );
	nW = normalize( nW + folT * ( folA * 0.20 * folFade + folB * 0.26 ) );

	// ---- albedo ----
	vec3 rockAlb = rp.rgb * uRockTint;
	rockAlb *= 1.0 + folA * 0.18 * folFade + folB * 0.11;
	// Quartz segregation veins sit parallel to foliation and are markedly paler.
	rockAlb = mix( rockAlb, rockAlb * vec3( 1.55, 1.58, 1.52 ), saturate( folA * 0.9 - 0.45 ) * 0.55 * folFade );
	// Oxidised rind on the weathered bands.
	rockAlb = mix( rockAlb, rockAlb * vec3( 1.22, 0.98, 0.72 ), saturate( folB * 0.6 + 0.30 ) * 0.30 );

	// Lichen colonises sun-exposed faces.  In the southern hemisphere that is
	// the northern aspect, so drive it off the actual sun vector.
	float sunFace = saturate( dot( nW, normalize( uSunDirWorld + vec3( 0.0, 0.35, 0.0 ) ) ) );
	float lichen = rp.a * smoothstep( 0.15, 0.75, sunFace ) * ( 1.0 - smoothstep( 0.55, 0.95, nW.y ) );
	vec3 lichenCol = mix( vec3( 0.470, 0.302, 0.028 ), vec3( 0.262, 0.318, 0.202 ), fract( rp.a * 7.31 ) );
	rockAlb = mix( rockAlb, lichenCol, lichen * 0.55 );
	// A few near-black crustose patches keep it from reading as one flat hue.
	rockAlb = mix( rockAlb, vec3( 0.022, 0.022, 0.019 ), saturate( lichen * 1.6 - 1.05 ) * 0.6 );

	// ---- snow on every ledge ----
	mat2 windM = mat2( uWindDir.x, -uWindDir.y, uWindDir.y, uWindDir.x );
	vec4 sG = texture2D( uSnowGrain, sohoWP.xz / uDetailScale.x );
	vec4 sD = texture2D( uSnowDrift, ( windM * sohoWP.xz ) / uDetailScale.z );
	// Snow catches on every ledge — note this uses the *perturbed* normal, so the
	// plate faces of the fracture relief hold it too.  The boundary is pushed
	// around by the drift field with a wide blend band, because a hard geometric
	// intersection between a white mesh and a grey one is the single most
	// damning tell in the document (ART_DIRECTION 6.1, 11.22).
	float ledge = saturate( ( nW.y - 0.28 ) * 1.30 );
	float cavity = 1.0 - rn.z;
	float driftBias = ( sD.w - 0.5 ) * 1.05 + ( sG.z - 0.5 ) * 0.35;
	float accum = saturate(
		ledge * 1.05
		+ cavity * 0.35
		+ driftBias
		+ clamp( vSnowSurface.w, 0.0, 1.0 ) * 0.55
		- 0.16
	) * uSnowOnRock;
	float snowAmt = smoothstep( 0.24, 0.72, accum );
	// A brighter, rounded lip of displaced snow just inside the boundary.
	float driftLip = smoothstep( 0.26, 0.44, accum ) * ( 1.0 - smoothstep( 0.44, 0.64, accum ) );
	// Rime dusting on the windward side, even where snow cannot lie.
	float windward = saturate( dot( normalize( vec3( nW.x, 0.0, nW.z ) + 1.0e-4 ).xz, -uWindDir ) );
	float rime = ( 1.0 - snowAmt ) * windward * 0.30 * smoothstep( 0.10, 0.45, accum );
	float moat = ( 1.0 - snowAmt ) * smoothstep( 0.08, 0.30, accum );
	rockAlb *= 1.0 - moat * 0.30;

	vec3 snowAlb = vec3( 0.845, 0.848, 0.856 ) * uAlbedoScale;
	snowAlb *= 1.0 - sG.z * 0.05;
	snowAlb *= 1.0 + driftLip * 0.06;
	diffuseColor.rgb *= mix( rockAlb, snowAlb, saturate( snowAmt + rime ) );

	// Snow that has settled on rock is soft and drifted: perturb with the snow
	// detail, weighted by how much of it there is.
	vec3 sgX = vec3( 1.0, 0.0, 0.0 ) - nW * nW.x;
	vec3 sgZ = vec3( 0.0, 0.0, 1.0 ) - nW * nW.z;
	// Both the grain (0.37 m) and the drift (11 m) layers, so the cap still has
	// shape at 30 m where the grain has long since mipped away.
	vec2 sgrad = ( sG.xy * 2.0 - 1.0 ) * ( uDetailAmp.x * rockFade )
		+ ( ( sD.xy * 2.0 - 1.0 ) * windM ) * ( uDetailAmp.z * 0.75 );
	nW = normalize( mix( nW, normalize( sohoWN + ( sgrad.x * sgX + sgrad.y * sgZ ) * uNormalStrength ), snowAmt * 0.85 ) );

	sohoNormalW = nW;
	normal = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );
	vec3 upRef = abs( nW.y ) < 0.9 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
	sohoTanW = normalize( cross( upRef, nW ) );
	sohoBitW = cross( nW, sohoTanW );

	// ---- response ----
	roughnessFactor = clamp( mix( uRockRough * ( 0.85 + 0.30 * rp.a ), uSurfRough.x, snowAmt ), 0.05, 1.0 );
	sohoWrap = mix( 0.06, uSurfWrap.x, snowAmt );
	sohoSSSAmount = uSssStrength * saturate( cavity * 0.5 + ( 1.0 - sD.w ) * 0.3 ) * snowAmt;
	sohoGlintMul = snowAmt * ( 1.0 - smoothstep( uGlintRange.x, uGlintRange.y, sohoDist ) ) * ( 0.5 + 1.1 * sG.w );
	sohoForwardMul = snowAmt;
	sohoSnowness = saturate( snowAmt + rime * 0.6 );
	/* -------------- end SOHO SCHIST SURFACE -------------- */
`;

/* ==========================================================================
 * 4.  MATERIAL CONSTRUCTION
 * ======================================================================== */

const DEG = Math.PI / 180;

/**
 * Direction the wind *travels*, in game-space XZ.
 * `CONFIG.world.windDirection` is meteorological (the bearing it blows FROM),
 * and game −Z is true bearing 225 (docs/TERRAIN_BRIEF.md §2.1).  At the shipped
 * 292 deg NW flow this yields (−0.921, +0.391), matching the terrain brief.
 */
function windDirectionGame(out = new THREE.Vector2()) {
  const fromDeg = Number.isFinite(CONFIG.world?.windDirection) ? CONFIG.world.windDirection : 292;
  const t = (fromDeg + 180 - TRUE_NORTH_BEARING_OF_MINUS_Z) * DEG;
  return out.set(Math.sin(t), -Math.cos(t)).normalize();
}

/**
 * Foliation plane normal for Otago schist: plan strike +38 deg from +X,
 * dip 32 deg.  n = (−sin38·sin32, cos32, cos38·sin32).
 */
function foliationNormal() {
  const strike = 38 * DEG;
  const dip = 32 * DEG;
  return new THREE.Vector3(
    -Math.sin(strike) * Math.sin(dip),
    Math.cos(dip),
    Math.cos(strike) * Math.sin(dip),
  ).normalize();
}

/** Pick a quality tier.  Software raster gets one fewer detail octave. */
function resolveQuality(ctx, requested) {
  if (requested === 'high') return 2;
  if (requested === 'medium') return 1;
  if (requested === 'low') return 0;
  // auto
  try {
    const gl = ctx?.renderer?.getContext?.();
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = String(
        (ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '',
      ).toLowerCase();
      if (name.includes('swiftshader') || name.includes('llvmpipe') || name.includes('softwarerasterizer')) {
        return 1;
      }
    }
  } catch (e) { /* capability probing must never break boot */ }
  return 2;
}

function buildUniforms(ctx, opts) {
  const snow = CONFIG.snow || {};
  const sss = Array.isArray(snow.sssColor) ? snow.sssColor : [0.62, 0.74, 0.95];
  const sssMax = Math.max(sss[0], sss[1], sss[2]) || 1;
  const sparkleDensity = clamp(snow.sparkleDensity ?? 1400, 80, 40000);
  const sparkleStrength = snow.sparkleStrength ?? 0.9;
  const sastrugi = snow.sastrugiStrength ?? 0.55;
  const albedo = snow.albedo ?? 0.86;
  const tex = getTextures(opts);

  return {
    uSnowGrain: { value: tex.grain },
    uSnowDrift: { value: tex.drift },
    uSnowMacro: { value: tex.macro },
    uRockPack: { value: tex.rock },
    uRockNormal: { value: tex.rockNormal },

    // Non-harmonic world tile sizes (metres).  ART_DIRECTION §11.14 asks for at
    // least three octaves at non-harmonic scales plus a low-frequency breakup.
    uDetailScale: { value: new THREE.Vector4(0.37, 1.9, 11.0, 34.0) },
    // Peak surface gradient contributed by each layer (the maps are normalised
    // at bake time, so these are the real numbers): 0.38 is a 21 deg facet.
    //
    // The two grain layers carry the near field and nothing else — f1 is gone by
    // ~7 cm/px and f2 by ~9 cm/px — and at 0.30/0.20 the macro framing rendered
    // as a smooth slab between the drift scribbles, with a 32 px-tile sigma of
    // 7.9 and a mean frame saturation of 0.074 on `snow-detail`.  That is the
    // "no material at the closest possible framing" blocker.  0.38/0.25 is a
    // 27% lift on a layer that is *only* ever seen inside ~10 m, so it cannot
    // touch the far field or re-open tell #15 (over-texturing at distance).
    uDetailAmp: {
      value: new THREE.Vector4(0.38, 0.25, 0.62 * (sastrugi / 0.55), 0.13),
    },
    uDetailFade: { value: new THREE.Vector2(40, 250) },

    uRockScale: { value: opts.rockScale ?? 2.4 },
    uRockTint: { value: new THREE.Color(1, 1, 1) },
    uRockRough: { value: opts.rockRoughness ?? 0.68 },

    //                              powder windpack groomed  ice
    uSurfRough: { value: new THREE.Vector4(0.58, 0.42, 0.36, 0.09) },
    // Diffuse wrap width, §3.4(a).  The doc's band is 0.35–0.50 and its own
    // worked example ("at w = 0.40 the falloff spreads an extra 23.6 deg") sits
    // at 0.40, which is where powder now is.
    //
    // Why it moved off the top of the band: at a 10.6 deg sun every surface in
    // the basin is near the terminator — flat ground is at N·L = 0.184 — so the
    // wrap is not a small correction here, it is the dominant term.  At w = 0.50
    // `saturate((N·L + w)/(1 + w))` lifts flat ground from 0.184 to 0.456 and a
    // face turned 10 deg away from 0.0 to 0.227, i.e. it manufactures fill out
    // of the sun term and flattens the snow histogram until the 10th-percentile
    // "shadow" sample is not a shadow at all.  Measured over `shots/r6`: the
    // four frames with a real cast shadow land LAW 2 at B/R 1.204–1.417, and the
    // six that fail it all have linear fill ratios of 0.57–0.68 — above the
    // 0.22–0.55 band — because their darkest snow is merely turned away, not
    // shadowed.  Narrowing the wrap deepens exactly those pixels and leaves cast
    // shadows (where `directLight.color` is already zero) completely untouched,
    // so the four passing frames cannot be pushed out of band by this.
    uSurfWrap: { value: new THREE.Vector4(0.40, 0.33, 0.27, 0.09) },

    uSssColor: { value: new THREE.Color(sss[0], sss[1], sss[2]) },
    uSssTint: { value: new THREE.Color(sss[0] / sssMax, sss[1] / sssMax, sss[2] / sssMax) },
    // 15,000 K clear high-altitude sky, ART_DIRECTION §4.2.  This is Blue #1 —
    // the illuminant that lights shadowed snow — and it is deliberately a
    // different constant from `sssColor`, which is Blue #2, the transport tint.
    uSkyFillTint: { value: new THREE.Color(0.63, 0.76, 1.0) },
    uSssStrength: { value: snow.sssStrength ?? 0.62 },

    uWindDir: { value: windDirectionGame() },
    uSparkleTime: { value: 0 },
    // density (lattice cells per metre), lobe sharpness, intensity, coverage
    //
    // The three numbers below are the whole of §3.4(e)'s "sparse and intense,
    // never a uniform overlay", and the previous set was the exact inverse of
    // it: 34 cells/m at 0.34 coverage is a 2.9 cm lattice firing 34% of its
    // cells, i.e. ~390 live cells per square metre before the second layer adds
    // another ~4000.  Measured in `shots/r6`: 133 discrete blobs over 1.11% of
    // `snow-detail` at 1.18x the local background, against a < 0.5%-of-snow-area
    // cap and a 3-20x intensity floor — over budget on area and under it on
    // intensity simultaneously, which is tell #12 verbatim.
    //
    //   density  34 -> 12 cells/m.  An 8.3 cm cell instead of a 2.9 cm one, so
    //            the placement lattice stays several pixels wide out to the
    //            distance limit and the point drawn inside it is genuinely
    //            sub-cell rather than the cell itself.
    //   coverage 0.34 -> 0.16.  ~23 live cells/m2 rather than ~390.
    //   sharp    190 -> 340.  A 3.9 deg half-power cone (dot(H, facet) > 0.998
    //            reads at 0.56 of peak, 8 deg off at 0.05), so the fired set
    //            collapses toward the sun's specular direction instead of
    //            spraying evenly over the slope.  620 remains unreachable.
    //   strength 9.0 -> 16.0.  Not a big lift, on purpose: a well-aligned glint
    //            already clipped at 9.0 and the dim majority was the actual
    //            defect.  1.8x compensates for the mark now being ~2 px of a
    //            multisampled pixel rather than a filled cell, which is where
    //            the survivors get their 3-20x back.
    uGlint: {
      value: new THREE.Vector4(
        12 * Math.sqrt(sparkleDensity / 1400),
        340,
        16.0 * sparkleStrength,
        0.16,
      ),
    },
    uGlintRange: { value: new THREE.Vector2(25, 40) },
    uForwardStrength: { value: opts.forwardScatter ?? 0.55 },
    uSunDirWorld: { value: new THREE.Vector3(0.02, 0.18, 0.98).normalize() },
    uNormalStrength: { value: opts.normalStrength ?? 1.0 },
    uCorduroySpacing: { value: opts.corduroySpacing ?? 0.11 },
    uFoliationN: { value: foliationNormal() },
    uFoliationSpacing: { value: opts.foliationSpacing ?? 0.085 },
    uAlbedoScale: { value: albedo / 0.86 },
    uSnowOnRock: { value: opts.snowOnRock ?? 1.0 },
    uTrackStrength: { value: opts.trackStrength ?? 1.0 },

    uDye: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
    uDyeCount: { value: 0 },

    uTrackMap: { value: null },
    uTrackRegion: { value: new THREE.Vector4(-1024, -1024, 1 / 2048, 1 / 2048) },
  };
}

const DIRECT_NEEDLES = [
  'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );',
  'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );',
];

let _warnedDirect = false;

/** Splice the snow direct-lighting response into the physical light chunk. */
function patchLightingChunk(shader) {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  for (const needle of DIRECT_NEEDLES) {
    if (chunk.indexOf(needle) !== -1) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_physical_pars_fragment>',
        chunk.replace(needle, RE_DIRECT_SNOW),
      );
      return true;
    }
  }
  if (!_warnedDirect) {
    _warnedDirect = true;
    console.warn(
      '[snowMaterial] could not locate the Lambert diffuse line in ' +
      'lights_physical_pars_fragment; falling back to the stock direct BRDF. ' +
      'Wrapped diffuse, forward scatter and glints are disabled.',
    );
  }
  return false;
}

function installShader(material, surfaceBlock, cacheKey) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, material.userData.snowUniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <project_vertex>', VERTEX_MAIN);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\n${surfaceBlock}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${INDIRECT_TINT}`);

    patchLightingChunk(shader);
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () =>
    `${cacheKey}|q${material.defines.SOHO_QUALITY}|t${material.defines.USE_TRACK_MAP !== undefined ? 1 : 0}`;
}

/**
 * The snow material.  Consumed by `terrain.js` for every LOD ring and by
 * `props.js` for anything that should shade as ground snow.
 *
 * @param {object} ctx    shared engine context (may be partially populated)
 * @param {object} [opts] snow options plus any MeshPhysicalMaterial parameter
 * @returns {THREE.MeshPhysicalMaterial}
 */
export function createSnowMaterial(ctx, opts = {}) {
  const {
    quality = 'auto',
    textureSize,
    anisotropy,
    seed,
    rockScale, rockRoughness, rockTint,
    normalStrength, forwardScatter, corduroySpacing, foliationSpacing,
    snowOnRock, trackStrength, trackTexture, trackRegion,
    ...three
  } = opts;

  const texOpts = {
    seed: seed ?? CONFIG.seed,
    textureSize: textureSize ?? 512,
    anisotropy: Math.max(1, Math.min(anisotropy ?? 4, ctx?.maxAnisotropy ?? 4)),
    rockScale, rockRoughness, normalStrength, forwardScatter,
    corduroySpacing, foliationSpacing, snowOnRock, trackStrength,
  };

  const material = new THREE.MeshPhysicalMaterial({
    // `color` is a global tint on top of the shader's per-class albedo; leave
    // it white unless a shot deliberately wants to push the whole snowfield.
    color: 0xffffff,
    roughness: 0.58,
    metalness: 0.0,
    // Ice n = 1.31 gives F0 = 0.018 for a slab; we are shading an aggregate of
    // facets, so the effective F0 is a little higher.  1.40 -> F0 = 0.028.
    ior: 1.40,
    specularIntensity: 1.0,
    envMapIntensity: opts.envMapIntensity ?? 1.0,
    dithering: true,
    ...three,
  });

  material.userData.snowUniforms = buildUniforms(ctx, texOpts);
  material.userData.isSohoSnow = true;
  material.defines = { ...(material.defines || {}), SOHO_QUALITY: resolveQuality(ctx, quality) };
  // The generic vertex-attribute default: deep powder, fully snow covered.
  material.defaultAttributeValues = { aSurface: SNOW_VERTEX_ATTRIBUTES.surface.default.slice() };

  if (rockTint) material.userData.snowUniforms.uRockTint.value.set(rockTint);
  installShader(material, SNOW_SURFACE, 'soho-snow');
  if (trackTexture) setTrackTexture(material, trackTexture, trackRegion);
  return material;
}

/**
 * NZ Otago schist for `props.js` — rock outcrops, tors, bluff bands, boulders.
 *
 * Triplanar, with one globally consistent foliation plane (strike +38 deg from
 * +X, dip 32 deg) driving the banding, the quartz veins and the platy fracture
 * relief; lichen biased to sun-exposed faces; and snow accumulating on every
 * up-facing ledge with a wind moat rather than a razor edge at the boundary.
 *
 * @param {object} ctx
 * @param {object} [opts]
 * @returns {THREE.MeshPhysicalMaterial}
 */
export function createRockMaterial(ctx, opts = {}) {
  const {
    quality = 'auto',
    textureSize,
    anisotropy,
    seed,
    rockScale, rockRoughness, rockTint,
    normalStrength, forwardScatter, corduroySpacing, foliationSpacing,
    snowOnRock, trackStrength, trackTexture, trackRegion,
    ...three
  } = opts;

  const texOpts = {
    seed: seed ?? CONFIG.seed,
    textureSize: textureSize ?? 512,
    anisotropy: Math.max(1, Math.min(anisotropy ?? 4, ctx?.maxAnisotropy ?? 4)),
    rockScale: rockScale ?? 2.4,
    rockRoughness: rockRoughness ?? 0.68,
    normalStrength, forwardScatter, corduroySpacing,
    foliationSpacing: foliationSpacing ?? 0.16,
    snowOnRock, trackStrength,
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.68,
    metalness: 0.0,
    ior: 1.5,
    envMapIntensity: opts.envMapIntensity ?? 1.0,
    dithering: true,
    ...three,
  });

  material.userData.snowUniforms = buildUniforms(ctx, texOpts);
  material.userData.isSohoSnow = true;
  material.userData.isSohoRock = true;
  material.defines = { ...(material.defines || {}), SOHO_QUALITY: resolveQuality(ctx, quality) };
  // Rock geometry that does not tag itself gets no extra snow bias.
  material.defaultAttributeValues = { aSurface: [0, 0, 0, 0] };

  if (rockTint) material.userData.snowUniforms.uRockTint.value.set(rockTint);
  installShader(material, ROCK_SURFACE, 'soho-rock');
  if (trackTexture) setTrackTexture(material, trackTexture, trackRegion);
  return material;
}

/* ==========================================================================
 * 5.  PER-FRAME UPDATE
 * ======================================================================== */

const _v2 = new THREE.Vector2();

/**
 * Attach (or detach) the carve-track splat map.
 *
 * @param {THREE.Material} material
 * @param {THREE.Texture|null} texture
 * @param {{minX:number,minZ:number,size:number}|{minX,maxX,minZ,maxZ}|null} [region]
 */
/**
 * Publish the kicker dye stations to a snow material.
 *
 * `terrain.js` calls this once its lips are placed; anything else using the
 * snow material leaves the count at zero and pays only a dead branch.
 *
 * @param {THREE.Material} material  a material from `createSnowMaterial`
 * @param {Array<{x:number,z:number,dx:number,dz:number}>} kickers
 */
export function setKickerDye(material, kickers) {
  const u = material?.userData?.snowUniforms;
  if (!u?.uDye) return;
  const list = kickers || [];
  const n = Math.min(list.length, u.uDye.value.length);
  for (let i = 0; i < n; i++) u.uDye.value[i].set(list[i].x, list[i].z, list[i].dx, list[i].dz);
  u.uDyeCount.value = n;
}

export function setTrackTexture(material, texture, region) {
  const u = material?.userData?.snowUniforms;
  if (!u) return;
  const had = material.defines.USE_TRACK_MAP !== undefined;
  const want = !!texture;
  u.uTrackMap.value = texture || null;
  if (region) {
    const minX = region.minX ?? -1024;
    const minZ = region.minZ ?? -1024;
    const sizeX = region.size ?? ((region.maxX ?? 1024) - minX) ?? 2048;
    const sizeZ = region.size ?? ((region.maxZ ?? 1024) - minZ) ?? 2048;
    u.uTrackRegion.value.set(minX, minZ, 1 / (sizeX || 1), 1 / (sizeZ || 1));
  }
  if (had !== want) {
    if (want) material.defines.USE_TRACK_MAP = '';
    else delete material.defines.USE_TRACK_MAP;
    material.needsUpdate = true;
  }
}

function updateOne(material, dt, ctx) {
  const u = material?.userData?.snowUniforms;
  if (!u) return;

  // Deterministic clock: prefer the engine's accumulated time (the capture
  // harness steps it in exact increments) and fall back to integrating dt.
  u.uSparkleTime.value = Number.isFinite(ctx?.elapsed)
    ? ctx.elapsed
    : u.uSparkleTime.value + (Number.isFinite(dt) ? dt : 0);

  const sun = ctx?.sky?.sunDirection;
  if (sun && Number.isFinite(sun.x)) {
    u.uSunDirWorld.value.copy(sun).normalize();
    // The forward-scatter lobe is at its most spectacular under a low sun and
    // is barely visible near the zenith; ramp it with solar elevation so a
    // time-of-day change does not need a manual re-tune.
    const elev = Math.max(0, Math.min(1, sun.y));
    u.uForwardStrength.value = lerp(0.72, 0.30, Math.sqrt(elev));
  }

  // Cheap, and it lets the harness re-roll wind without a rebuild.
  windDirectionGame(_v2);
  u.uWindDir.value.copy(_v2);

  const trails = ctx?.trails;
  if (trails && typeof trails.getTrackTexture === 'function') {
    const tex = trails.getTrackTexture();
    const region =
      (typeof trails.getTrackRegion === 'function' ? trails.getTrackRegion() : null) ||
      trails.trackRegion ||
      ctx?.terrain?.bounds ||
      null;
    if (tex !== u.uTrackMap.value || region) setTrackTexture(material, tex, region);
  }
}

/**
 * Per-frame animation for a snow or rock material.  Safe to call before
 * `ctx.sky`, `ctx.trails` or `ctx.terrain` exist.
 *
 * @param {THREE.Material|THREE.Material[]} material
 * @param {number} dt
 * @param {object} ctx
 */
export function updateSnowMaterial(material, dt, ctx) {
  if (!material) return;
  if (Array.isArray(material)) {
    for (const m of material) updateOne(m, dt, ctx);
  } else {
    updateOne(material, dt, ctx);
  }
}
