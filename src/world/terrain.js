/**
 * Soho Basin terrain — the single source of truth for ground geometry.
 *
 * The mountain is built in eight ordered phases (see `build()`):
 *
 *   A. Analytic basin form   — a monotone-cubic centreline profile whose
 *      argument is warped outward from the fall line, which turns a ramp into
 *      a glacially-scoured cirque with rising flanks. NOT noise: a noise-only
 *      bowl reads as generic terrain.
 *   B. Structural noise      — ridged multifractal for spur/rib structure,
 *      domain-warped fBm for mid-scale gullies and rollovers.
 *   C. Landform features     — headwall ribs and couloirs, spurs, the main
 *      gully (head of Soho Creek), spine field, rollovers.
 *   D. EROSION               — a droplet-based hydraulic pass followed by a
 *      thermal (talus-angle) pass. This is what converts "procedural noise
 *      blob" into "real mountain": dendritic drainage, concave valley floors,
 *      consistent slope limits, alluvial run-outs.
 *   E. Post-erosion features — cornice, bergschrund moat, bluff bands,
 *      avalanche debris fans, solifluction terraces, creek braid, benched
 *      cat tracks, groomed corridors, the lift corridor, containment ramps.
 *   F. Snow depth field      — elevation base + lee deposition + curvature
 *      collection − wind scour − sluff shedding.
 *   G. Drift detail          — wind-drift and pillow bands, amplitude driven
 *      by the depth field so snow only piles where snow can lie.
 *   H. Classification        — powder / groomed / ice / rock / windpack from
 *      slope, aspect relative to the NW wind, curvature, depth and elevation.
 *
 * The result is cached in Float32Arrays at `CONFIG.terrain.heightfieldRes`
 * (2 m posts). `getHeight()` bilinearly interpolates that cache — it never
 * re-evaluates noise — so it is cheap enough for the ~1000 queries/frame the
 * physics makes, and it matches the rendered mesh by construction.
 *
 * Rendering is a geometry clipmap: nine camera-centred square rings at
 * doubling extents. Crack-free seams come from two cooperating mechanisms:
 * each ring's outer boundary carries a vertical skirt, and each coarse ring's
 * inner border is "tucked" below whatever finer ring overlaps it, so the finer
 * surface always wins the depth test without z-fighting. Beyond the clipmap a
 * polar backdrop shell carries the Otago skyline out to
 * `CONFIG.terrain.backdropRadius`.
 *
 * Art direction: docs/TERRAIN_BRIEF.md (binding) and docs/ART_DIRECTION.md.
 * Contract: docs/ARCHITECTURE.md.
 */

import * as THREE from 'three';
import {
  Simplex, makeRng, seedFromString,
  fbm2, ridged2, billow2, warpedFbm2,
  clamp, clamp01, lerp, smoothstep,
} from '../core/rng.js';
import { CONFIG } from '../core/config.js';
import { createSnowMaterial, createRockMaterial, updateSnowMaterial } from './snowMaterial.js';

/* ================================================================== *
 * Shared constants — exported so sky.js / props.js can agree with us.
 * ================================================================== */

const DEG = Math.PI / 180;

/** Game −Z is true bearing 225° (SW): the basin's real aspect. */
export const TRUE_NORTH_BEARING_OF_MINUS_Z = 225;

/** Unit horizontal direction in game space for a true compass bearing. */
export function dirFromBearing(bearingDeg, out) {
  const t = (bearingDeg - TRUE_NORTH_BEARING_OF_MINUS_Z) * DEG;
  return (out || new THREE.Vector3()).set(Math.sin(t), 0, -Math.cos(t));
}

/** Surface ids, index-aligned with the strings the contract requires. */
export const SURFACE_NAMES = ['powder', 'groomed', 'ice', 'rock', 'windpack'];
const S_POWDER = 0, S_GROOMED = 1, S_ICE = 2, S_ROCK = 3, S_WINDPACK = 4;

/** Cirque focus — every radial feature (crest arc, headwall base) is about this. */
const FOCUS_X = 0, FOCUS_Z = 240;
const CREST_R = 640;   // headwall crest arc radius about the focus
const BASE_R = 460;    // headwall base arc radius

/**
 * Flank lift: how far "up the profile" an off-centreline sample is pushed.
 * This is what turns a ramp into a cirque. 560 m of forward offset at the map
 * edge gives ~145 m of rim relief above the centreline at x = ±800 — a real
 * bowl wall at ~28°, rather than the ~35° wall a larger value produces (which
 * dumps a tenth of the map into the "unrideable" slope band).
 */
const FLANK_LIFT = 560;
const FLANK_POW = 1.6;

/**
 * Prevailing wind. CONFIG.world.windDirection = 292 means *from* 292° true,
 * i.e. blowing *toward* 112° true. In game space that is cross-slope toward
 * −X with a slight up-slope bias — a NW gale on a SW-facing basin.
 */
const WIND_TOWARD = dirFromBearing(CONFIG.world.windDirection - 180);
const WIND_FROM = WIND_TOWARD.clone().negate();

/**
 * LOD clipmap levels. `n` = quads per side, `s` = post spacing (m).
 * Extent (n*s) must double every level so a level's hole is exactly the
 * footprint of the level inside it.
 *   L0  0.5 m  ±16 m     L5   16 m  ±512 m
 *   L1  1.0 m  ±32 m     L6   32 m  ±1024 m
 *   L2  2.0 m  ±64 m     L7   64 m  ±2048 m
 *   L3  4.0 m  ±128 m    L8  128 m  ±4096 m
 *   L4  8.0 m  ±256 m
 * Below 2 m the heightfield itself is the limit, so the inner rings buy only
 * the capped sub-post detail (MICRO_CAP) — which is why they stop at 0.5 m.
 */
const LOD_LEVELS = [
  { n: 64, s: 0.5 }, { n: 64, s: 1 }, { n: 64, s: 2 }, { n: 64, s: 4 },
  { n: 64, s: 8 }, { n: 64, s: 16 }, { n: 64, s: 32 }, { n: 64, s: 64 },
  { n: 64, s: 128 },
];
/** Levels that write into the shadow map. Far rings would blow the budget. */
const SHADOW_LEVELS = 5;
/** Levels that carry sub-4 m displacement (capped, see MICRO_CAP). */
const MICRO_LEVELS = 3;
/**
 * Hard cap on displacement whose wavelength is below the 2 m heightfield
 * post spacing. `getHeight()` cannot reproduce it, so it must stay under the
 * "matches the mesh to within a few centimetres" contract.
 */
const MICRO_CAP = 0.045;

/** Where the backdrop shell begins, and how far the box-edge blend runs. */
const BACKDROP_INNER = 2400;
const FAR_BLEND = 280;
/** Sink the backdrop slightly so the clipmap always wins in the overlap band. */
const BACKDROP_SINK = 6;
/** Mean earth radius doubled — distant ground genuinely falls away. */
const EARTH_2R = 12.742e6;

/* ================================================================== *
 * Small math helpers (kept local; core/rng.js is not ours to extend)
 * ================================================================== */

/** C1 soft ceiling: identical to `v` until `lim-k`, asymptotic to `lim`. */
function softMax(v, lim, k) {
  if (v <= lim - k) return v;
  return lim - k * Math.exp(-(v - (lim - k)) / k);
}
/** C1 soft floor. */
function softMin(v, lim, k) {
  if (v >= lim + k) return v;
  return lim + k * Math.exp(-((lim + k) - v) / k);
}

/** Squared distance from (px,pz) to segment (ax,az)-(bx,bz); also returns t. */
function segClosest(px, pz, ax, az, bx, bz, out) {
  const vx = bx - ax, vz = bz - az;
  const len2 = vx * vx + vz * vz;
  let t = len2 > 1e-9 ? ((px - ax) * vx + (pz - az) * vz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + vx * t, cz = az + vz * t;
  out.x = cx; out.z = cz; out.t = t;
  out.d2 = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
  return out;
}

/**
 * Closest point on a polyline. Returns distance, the arc length at the
 * closest point, and the tangent there — everything a bench/gully/corridor
 * rasteriser needs.
 */
function polyClosest(pts, cum, px, pz, out) {
  let best = Infinity, bs = 0, bx = 0, bz = 0, bi = 0, bt = 0;
  const tmp = { x: 0, z: 0, t: 0, d2: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    segClosest(px, pz, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], tmp);
    if (tmp.d2 < best) {
      best = tmp.d2; bx = tmp.x; bz = tmp.z; bi = i; bt = tmp.t;
      bs = cum[i] + (cum[i + 1] - cum[i]) * tmp.t;
    }
  }
  out.d = Math.sqrt(best);
  out.s = bs;
  out.x = bx; out.z = bz;
  const dx = pts[bi + 1][0] - pts[bi][0], dz = pts[bi + 1][1] - pts[bi][1];
  const L = Math.hypot(dx, dz) || 1;
  out.tx = dx / L; out.tz = dz / L;
  out.t = bt;
  return out;
}

/** Cumulative arc length of a polyline, plus its plan bounding box. */
function polyMeta(pts) {
  const cum = [0];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    minX = Math.min(minX, pts[i][0]); maxX = Math.max(maxX, pts[i][0]);
    minZ = Math.min(minZ, pts[i][1]); maxZ = Math.max(maxZ, pts[i][1]);
  }
  return { cum, minX, maxX, minZ, maxZ, length: cum[cum.length - 1] };
}

/**
 * Monotone cubic (Fritsch–Carlson PCHIP). Catmull-Rom overshoots at the
 * crest-plateau/headwall break and invents a phantom cliff plus a phantom
 * bench; PCHIP cannot.
 */
function makePchip(xs, ys) {
  const n = xs.length;
  const h = new Float64Array(n - 1), d = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) { h[i] = xs[i + 1] - xs[i]; d[i] = (ys[i + 1] - ys[i]) / h[i]; }
  const m = new Float64Array(n);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) { m[i] = 0; continue; }
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let k = 0;
    while (k < n - 2 && xs[k + 1] < x) k++;
    const t = (x - xs[k]) / h[k], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[k]
      + (t3 - 2 * t2 + t) * h[k] * m[k]
      + (-2 * t3 + 3 * t2) * ys[k + 1]
      + (t3 - t2) * h[k] * m[k + 1];
  };
}

/* ================================================================== *
 * Terrain
 * ================================================================== */

export class Terrain {
  constructor(ctx) {
    this.ctx = ctx;
    const T = CONFIG.terrain;

    this.size = T.size;
    this.res = T.heightfieldRes;
    this.n = this.res + 1;                 // posts per axis (1025 by default)
    this.cell = T.size / T.heightfieldRes;  // 2.0 m posts
    this.invCell = 1 / this.cell;
    this.minX = -T.size / 2; this.maxX = T.size / 2;
    this.minZ = -T.size / 2; this.maxZ = T.size / 2;
    this.bounds = { minX: this.minX, maxX: this.maxX, minZ: this.minZ, maxZ: this.maxZ };

    this.object3D = new THREE.Object3D();
    this.object3D.name = 'Terrain';

    this.seedBase = seedFromString(String(CONFIG.seed));
    this.built = false;

    // --- Noise generators, one per band so a designer can re-roll a band ---
    this.simRidge = new Simplex(this._seed('band.ridge'));
    this.simMid = new Simplex(this._seed('band.mid'));
    this.simDrift = new Simplex(this._seed('band.drift'));
    this.simFine = new Simplex(this._seed('band.fine'));
    this.simDepth = new Simplex(this._seed('depth.variation'));
    this.simFar = new Simplex(this._seed('farfield'));
    this.simMicro = new Simplex(this._seed('sastrugi'));

    // --- Analytic centreline profile (§2.3), sampled into a 1 m LUT --------
    // §2.3's control points, plus a back-slope beyond the crest. The brief
    // says to clamp the argument at +1024 so PCHIP cannot extrapolate past
    // maxAltitude — but the flank warp drives the argument to ~1600 in the
    // upper corners, and a hard clamp turns a fifth of the map into a dead
    // flat plateau. Extending the curve monotonically downward past the crest
    // gives the same protection and produces the correct Otago whaleback:
    // a broad, gently back-tilted summit surface rather than a table top.
    const pchip = makePchip(
      [-1024, -420, -120, 380, 700, 880, 1024, 1250, 1600, 2200],
      [1410, 1428, 1480, 1620, 1725, 1852, 1865, 1857, 1828, 1772],
    );
    this._profMin = -1024; this._profMax = 2200;
    this._profLUT = new Float32Array(this._profMax - this._profMin + 1);
    for (let i = 0; i < this._profLUT.length; i++) {
      this._profLUT[i] = pchip(i + this._profMin);
    }

    this.features = this._buildFeatures();
    this.spawns = this.features.spawns;

    // Scratch objects — getHeight/sample must not allocate.
    this._v0 = new THREE.Vector3();
    this._poly = { d: 0, s: 0, x: 0, z: 0, tx: 0, tz: 0, t: 0 };
    this._sampleOut = {};

    ctx.terrain = this;
  }

  _seed(name) { return (seedFromString('soho.terrain.' + name) ^ this.seedBase) >>> 0; }

  /** Centreline elevation profile; argument is clamped, never extrapolated. */
  _profile(z) {
    const last = this._profLUT.length - 1;
    const t = clamp(z, this._profMin, this._profMax) - this._profMin;
    const i = t | 0;
    if (i >= last) return this._profLUT[last];
    return this._profLUT[i] + (this._profLUT[i + 1] - this._profLUT[i]) * (t - i);
  }

  /* ================================================================ *
   * Feature register (§2.5) — deterministic, available before build()
   * ================================================================ */

  _buildFeatures() {
    const f = {};

    /* -- Spawns ---------------------------------------------------------- */
    // heading = π faces −Z under the engine's fwd = (sin h, 0, cos h).
    f.spawns = {
      // Above the T1 bench on the scoured crest plateau, at the head of the
      // rib between `broadway` and `soho-chute` — the cornice is gapped there
      // (rib heads are scoured), which is the natural walk-in. Cornice
      // segments sit 30 m either side, in profile, for the hero frame. The
      // fall line from here is clean to the run-out at ≤48°.
      'broadway-gate': { x: 140, z: 960, heading: Math.PI },
      'bowl-entry': { x: -180, z: 560, heading: Math.PI },
      'mid-traverse': { x: 430, z: 120, heading: Math.PI - 0.35 },
      'runout': { x: -60, z: -700, heading: Math.PI },
    };
    f.defaultSpawn = 'broadway-gate';

    /* -- Headwall ribs and couloirs -------------------------------------- */
    // φ is the crest-arc parameter, measured from +Z rotating toward +X.
    const ribRng = makeRng(this._seed('headwall.ribs'));
    f.ribs = [-38, -25, -12, 12, 33].map((phi) => ({
      phi: phi * DEG,
      length: ribRng.range(120, 200),
      sigma: ribRng.range(14, 22),
      relief: ribRng.range(8, 20),
    }));
    const gulRng = makeRng(this._seed('headwall.gullies'));
    f.gullies = [
      { name: 'organ-pipes-w', phi: -31.5 * DEG, topW: 15, botW: 30, depth: 13 },
      { name: 'organ-pipes-e', phi: -18.5 * DEG, topW: 13, botW: 26, depth: 12 },
      { name: 'broadway', phi: 1.5 * DEG, topW: 22, botW: 44, depth: 9 },
      { name: 'soho-chute', phi: 22.5 * DEG, topW: 9, botW: 24, depth: 15 },
    ].map((g) => ({ ...g, jitter: gulRng.range(-0.03, 0.03) }));

    /* -- Cornice segments along the crest arc ---------------------------- */
    const corRng = makeRng(this._seed('cornice'));
    f.cornice = [];
    {
      // Walk the arc, laying 40–110 m segments with gaps at the rib heads.
      const ribPhis = f.ribs.map((r) => r.phi);
      let phi = -46 * DEG;
      while (phi < 44 * DEG) {
        const segLen = corRng.range(40, 110);
        const dPhi = segLen / CREST_R;
        const mid = phi + dPhi * 0.5;
        const nearRib = ribPhis.some((p) => Math.abs(p - mid) < 0.055);
        if (!nearRib && corRng() < 0.78) {
          f.cornice.push({ phi0: phi, phi1: phi + dPhi, lip: corRng.range(1.5, 3.5) });
        }
        phi += dPhi + corRng.range(8, 34) / CREST_R;
      }
    }

    /* -- Spurs ------------------------------------------------------------ */
    f.spurs = [
      { name: 'soho-spur', pts: [[-560, 560], [-640, 210], [-720, -180], [-790, -450], [-820, -700]], width: 105, relief: 22 },
      { name: 'captains-shoulder', pts: [[600, 640], [660, 300], [740, -40], [830, -360], [880, -620]], width: 120, relief: 19 },
    ].map((s) => ({ ...s, ...polyMeta(s.pts) }));

    /* -- Drainage --------------------------------------------------------- */
    f.mainGully = {
      name: 'soho-creek-head',
      pts: [[-120, 420], [-150, 250], [-120, 60], [-180, -140], [-240, -330], [-260, -520]],
      depth0: 2, depth1: 14, width0: 12, width1: 45,
    };
    Object.assign(f.mainGully, polyMeta(f.mainGully.pts));
    f.tributaries = [
      { pts: [[180, 150], [90, 40], [-30, -60], [-150, -130]], depth0: 1.5, depth1: 7, width0: 8, width1: 26 },
      { pts: [[-480, -60], [-400, -120], [-320, -180], [-235, -260]], depth0: 1.5, depth1: 6, width0: 8, width1: 22 },
    ].map((t) => ({ ...t, ...polyMeta(t.pts) }));
    f.creek = {
      pts: [[-260, -520], [-330, -640], [-390, -760], [-470, -890], [-540, -1024]],
      depth: 2.2, width: 26,
    };
    Object.assign(f.creek, polyMeta(f.creek.pts));

    /* -- Spine field (the playground) ------------------------------------- */
    const spineRng = makeRng(this._seed('spines'));
    f.spines = [];
    {
      let x = 95;
      for (let i = 0; i < 7; i++) {
        const zTop = spineRng.range(300, 400);
        const len = spineRng.range(180, 320);
        const drift = spineRng.range(-45, 45);
        f.spines.push({
          pts: [[x, zTop], [x + drift * 0.45, zTop - len * 0.5], [x + drift, zTop - len]],
          relief: spineRng.range(4, 9),
          width: spineRng.range(19, 30),
        });
        x += spineRng.range(45, 70) + 22;
      }
      for (const s of f.spines) Object.assign(s, polyMeta(s.pts));
    }

    /* -- Rollovers (natural jumps) ---------------------------------------- */
    const rollRng = makeRng(this._seed('rollovers'));
    f.rollovers = [];
    for (let attempt = 0; attempt < 4000 && f.rollovers.length < 15; attempt++) {
      const x = rollRng.range(-780, 780);
      const z = rollRng.range(-110, 660);
      let ok = true;
      for (const r of f.rollovers) {
        if ((r.x - x) * (r.x - x) + (r.z - z) * (r.z - z) < 85 * 85) { ok = false; break; }
      }
      if (!ok) continue;
      f.rollovers.push({
        x, z,
        sigma: rollRng.range(25, 70),
        lip: rollRng.range(1.5, 4.0),
      });
    }

    /* -- Bluff bands ------------------------------------------------------- */
    const bluffRng = makeRng(this._seed('bluffs'));
    // Gaps at x −300…−140 and −20…+300 are the snow-ramp through-routes; the
    // broadway corridor and the fall line below the spawn both use the wide
    // centre gap, so a straight glide is never cliffed out.
    f.bluffs = [[-560, -300], [-140, -20], [300, 520]].map(([x0, x1]) => {
      const pts = [];
      const steps = Math.max(3, Math.round((x1 - x0) / 60));
      for (let i = 0; i <= steps; i++) {
        const x = lerp(x0, x1, i / steps);
        pts.push([x, -140 - 80 * (0.5 + 0.5 * Math.sin(i * 1.7 + bluffRng() * 6)) + bluffRng.range(-14, 14)]);
      }
      return {
        pts,
        height: bluffRng.range(9, 22),
        faceAngle: bluffRng.range(58, 78) * DEG,
        ...polyMeta(pts),
      };
    });

    /* -- Benched traverses (cut/fill cat tracks) --------------------------- */
    f.tracks = [
      { name: 'crest-traverse', pts: [[-700, 900], [0, 908], [700, 900]], halfWidth: 2.5, grade: -0.8 },
      { name: 'mid-traverse', pts: [[880, 40], [420, 120], [-60, 190], [-460, 235], [-760, 260]], halfWidth: 3.0, grade: -1.6 },
      { name: 'home-track', pts: [[-820, -480], [-380, -560], [80, -650], [420, -720], [700, -760]], halfWidth: 3.0, grade: -1.1 },
    ].map((t) => ({ ...t, ...polyMeta(t.pts) }));

    /* -- Groomed corridors -------------------------------------------------- */
    f.corridors = [
      { name: 'broadway', halfWidth: 21, pts: [[240, 680], [180, 420], [60, 120], [140, -180], [280, -520], [330, -700]] },
      { name: 'main-street', halfWidth: 24, pts: [[-100, 560], [-260, 200], [-340, -120], [-480, -430], [-300, -700], [-140, -860]] },
      { name: 'east-side', halfWidth: 18, pts: [[520, 560], [620, 200], [560, -200], [400, -520], [420, -700]] },
      { name: 'lower-link', halfWidth: 20, pts: [[-520, -560], [-220, -640], [60, -700], [340, -740]] },
    ].map((c) => ({ ...c, ...polyMeta(c.pts) }));

    /* -- Lift corridor (terrain reserves it, props.js builds it) ------------ */
    f.lift = {
      base: { x: 320, z: -560 },
      top: { x: 240, z: 700 },
      towers: 14,
      corridorHalfWidth: 20,
      padHalf: { x: 30, z: 20 },
    };
    Object.assign(f.lift, polyMeta([[f.lift.base.x, f.lift.base.z], [f.lift.top.x, f.lift.top.z]]));
    f.lift.pts = [[f.lift.base.x, f.lift.base.z], [f.lift.top.x, f.lift.top.z]];

    return f;
  }

  /* ================================================================ *
   * Far field — everything outside the playable box.
   * ================================================================ */

  /**
   * Skyline table (§1.6) reduced to game space. Peaks beyond the backdrop
   * radius are projected inward at an angularly-equivalent height so the
   * silhouette stays truthful from the basin.
   */
  _skyline() {
    const EYE = 1800, RMAX = 24000;
    const raw = [
      // name,             summit, θ(deg from −Z toward +X), dist,  width, elongation, strike
      ['mt-cardrona', 1936, -160, 2400, 1500, 1.8, 30],
      ['pisa', 1963, -149, 15000, 5200, 2.6, 40],
      ['criffel', 1626, 171, 14000, 4200, 2.8, 15],
      ['mt-soho', 1752, 18, 6500, 1900, 1.5, -25],
      ['coronet', 1649, 26, 16000, 2600, 1.2, 0],
      ['remarkables', 2319, -17, 22000, 5000, 2.2, -10],
      ['hector', 1900, -34, 42000, 6000, 3.0, -10],
      ['richardson', 2100, 47, 32000, 5200, 2.2, 25],
      ['harris', 2400, 112, 42000, 6500, 2.0, 45],
      ['treble-cone', 2339, 127, 28000, 4000, 1.6, 20],
      ['aspiring', 3033, 119, 57000, 3000, 1.0, 0],
    ];
    return raw.map(([name, h, theta, dist, w, elong, strike]) => {
      let d = dist, hh = h, ww = w;
      if (dist > RMAX) { const k = RMAX / dist; d = RMAX; hh = EYE + (h - EYE) / k; ww = w * k; }
      const t = theta * DEG;
      return {
        name,
        x: Math.sin(t) * d, z: -Math.cos(t) * d,
        h: Math.min(hh, 3200), w: ww, elong,
        cs: Math.cos(strike * DEG), sn: Math.sin(strike * DEG),
      };
    });
  }

  /**
   * Analytic far-field height. Continues the spurs out of the box, drops into
   * the Soho Creek valley to the SW, rises over the Mt Cardrona massif to the
   * NE, and raises the §1.6 skyline. Flat-topped Otago block-range profile
   * (exponent 2.4, not 2) — these are warped peneplain remnants, not arêtes.
   */
  /**
   * Far-field height, cached. The analytic form costs ~15 noise evaluations
   * plus an 11-entry skyline loop; the outer clipmap rings need ~30k of them
   * whenever they re-snap, which is a 200 ms hitch. The field's finest
   * feature is ~375 m across, so a 40 m table with bilinear taps is
   * indistinguishable and ~20× cheaper.
   */
  _buildFarLUT() {
    const step = 40, R = 7040;
    const m = (R * 2) / step + 1;
    const lut = new Float32Array(m * m);
    for (let j = 0; j < m; j++) {
      const z = -R + j * step;
      for (let i = 0; i < m; i++) lut[j * m + i] = this._farHeightRaw(-R + i * step, z);
    }
    this._farLUT = lut; this._farLUTm = m; this._farLUTstep = step; this._farLUTR = R;
  }

  _farHeight(x, z) {
    const lut = this._farLUT;
    if (lut) {
      const R = this._farLUTR, m = this._farLUTm, st = this._farLUTstep;
      if (x > -R && x < R - st && z > -R && z < R - st) {
        const fx = (x + R) / st, fz = (z + R) / st;
        const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
        const k = j * m + i;
        const a = lut[k] + (lut[k + 1] - lut[k]) * tx;
        const b = lut[k + m] + (lut[k + m + 1] - lut[k + m]) * tx;
        return a + (b - a) * tz;
      }
    }
    return this._farHeightRaw(x, z);
  }

  _farHeightRaw(x, z) {
    if (!this._sky) this._sky = this._skyline();
    const r = Math.hypot(x, z);

    // Regional base: high near the massif, falling away to the valley systems.
    let h = lerp(1520, 800, smoothstep(1300, 12000, r));

    // Soho Creek valley, running SW down the fall line and deepening outward.
    const vt = 6 * DEG;
    const ax = Math.sin(vt), az = -Math.cos(vt);
    const perp = Math.abs(-x * az + z * ax);
    h -= 300 * Math.exp(-((perp / 1100) ** 2)) * smoothstep(1300, 4600, r);

    // Range-scale ridged structure, faded in so it never disturbs the seam.
    const nAmp = 260 * smoothstep(1200, 4200, r);
    h += (ridged2(this.simFar, x / 3800, z / 3800, { octaves: 4, sharpness: 1.25 }) - 0.42) * nAmp;
    h += fbm2(this.simFar, x / 1500, z / 1500, { octaves: 3 }) * 40 * smoothstep(1100, 2600, r);

    // Named skyline elements. max(), not sum() — mountains do not add.
    for (const p of this._sky) {
      const dx = x - p.x, dz = z - p.z;
      const u = (dx * p.cs + dz * p.sn) / p.elong;
      const v = -dx * p.sn + dz * p.cs;
      const d = Math.hypot(u, v) / p.w;
      if (d > 2.6) continue;
      const g = Math.exp(-Math.pow(d, 2.4));
      const ph = lerp(h, p.h, g);
      if (ph > h) h = ph;
    }

    // Earth curvature: 53 m of drop at 26 km is the difference between a
    // horizon and a wall.
    h -= (r * r) / EARTH_2R;
    return h;
  }

  /* ================================================================ *
   * Public query API
   * ================================================================ */

  /** Bilinear lookup of the cached heightfield, clamped at the box edge. */
  _field(x, z) {
    const H = this.height, n = this.n;
    let fx = (x - this.minX) * this.invCell;
    let fz = (z - this.minZ) * this.invCell;
    fx = fx < 0 ? 0 : fx > n - 1.0001 ? n - 1.0001 : fx;
    fz = fz < 0 ? 0 : fz > n - 1.0001 ? n - 1.0001 : fz;
    const i = fx | 0, j = fz | 0;
    const tx = fx - i, tz = fz - j;
    const k = j * n + i;
    const h0 = H[k] + (H[k + 1] - H[k]) * tx;
    const h1 = H[k + n] + (H[k + n + 1] - H[k + n]) * tx;
    return h0 + (h1 - h0) * tz;
  }

  /** Nearest-post lookup into any of the derived Uint8/Int16 fields. */
  _fieldNearest(arr, x, z) {
    const n = this.n;
    let i = Math.round((x - this.minX) * this.invCell);
    let j = Math.round((z - this.minZ) * this.invCell);
    i = i < 0 ? 0 : i > n - 1 ? n - 1 : i;
    j = j < 0 ? 0 : j > n - 1 ? n - 1 : j;
    return arr[j * n + i];
  }

  /** Bilinear lookup into a Float32 derived field. */
  _fieldLerp(arr, x, z) {
    const n = this.n;
    let fx = (x - this.minX) * this.invCell;
    let fz = (z - this.minZ) * this.invCell;
    fx = fx < 0 ? 0 : fx > n - 1.0001 ? n - 1.0001 : fx;
    fz = fz < 0 ? 0 : fz > n - 1.0001 ? n - 1.0001 : fz;
    const i = fx | 0, j = fz | 0;
    const tx = fx - i, tz = fz - j;
    const k = j * n + i;
    const a = arr[k] + (arr[k + 1] - arr[k]) * tx;
    const b = arr[k + n] + (arr[k + n + 1] - arr[k + n]) * tx;
    return a + (b - a) * tz;
  }

  /** Height anywhere in the world: cached inside the box, analytic outside. */
  _heightAt(x, z) {
    if (!this.height) return this._baseHeight(x, z);
    const inX = x >= this.minX && x <= this.maxX;
    const inZ = z >= this.minZ && z <= this.maxZ;
    if (inX && inZ) return this._field(x, z);
    const dx = Math.max(this.minX - x, 0, x - this.maxX);
    const dz = Math.max(this.minZ - z, 0, z - this.maxZ);
    const d = Math.hypot(dx, dz);
    const edge = this._field(clamp(x, this.minX, this.maxX), clamp(z, this.minZ, this.maxZ));
    return lerp(edge, this._farHeight(x, z), smoothstep(0, FAR_BLEND, d));
  }

  /**
   * Surface height in metres. Hot path: one bilinear tap, no allocation, no
   * noise evaluation. Matches the rendered mesh by construction.
   */
  getHeight(x, z) {
    if (!this.height) return this._baseHeight(x, z);
    if (x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ) {
      return this._field(x, z);
    }
    return this._heightAt(x, z);
  }

  /** Unit surface normal from central differences on the cached field. */
  getNormal(x, z, out = new THREE.Vector3()) {
    const e = this.cell;
    const hx = (this.getHeight(x + e, z) - this.getHeight(x - e, z)) / (2 * e);
    const hz = (this.getHeight(x, z + e) - this.getHeight(x, z - e)) / (2 * e);
    return out.set(-hx, 1, -hz).normalize();
  }

  /** Slope from horizontal, radians. */
  getSlope(x, z) {
    const e = this.cell;
    const hx = (this.getHeight(x + e, z) - this.getHeight(x - e, z)) / (2 * e);
    const hz = (this.getHeight(x, z + e) - this.getHeight(x, z - e)) / (2 * e);
    return Math.atan(Math.hypot(hx, hz));
  }

  /** Convex-positive normalised curvature (crests > 0, gullies < 0). */
  getCurvature(x, z) {
    if (!this.curv) return 0;
    return this._fieldLerp(this.curv, x, z);
  }

  /** Settled snow depth in metres. */
  getSnowDepth(x, z) {
    if (!this.depth) return 1.0;
    return this._fieldLerp(this.depth, x, z);
  }

  /** Wind exposure / scour index, 0 (sheltered) … 1 (fully scoured). */
  getExposure(x, z) {
    if (!this.expo) return 0;
    return this._fieldNearest(this.expo, x, z) / 255;
  }

  /** Surface classification string — the CPU-side query the contract needs. */
  getSurface(x, z) {
    if (!this.surf) return 'powder';
    return SURFACE_NAMES[this._fieldNearest(this.surf, x, z)] || 'powder';
  }

  /** One-shot combined query. `out` is reused; nothing allocates per call. */
  sample(x, z, out = this._sampleOut) {
    out.height = this.getHeight(x, z);
    out.normal = this.getNormal(x, z, out.normal || new THREE.Vector3());
    out.slope = Math.acos(clamp(out.normal.y, -1, 1));
    if (this.surf) {
      const id = this._fieldNearest(this.surf, x, z);
      out.surface = SURFACE_NAMES[id];
      out.roughness = this._fieldNearest(this.rough, x, z) / 255;
      out.depth = this._fieldLerp(this.depth, x, z);
      out.curvature = this._fieldLerp(this.curv, x, z);
      out.exposure = this._fieldNearest(this.expo, x, z) / 255;
    } else {
      out.surface = 'powder';
      out.roughness = 0.3;
      out.depth = 1.0;
      out.curvature = 0;
      out.exposure = 0;
    }
    // What the board can actually sink into.
    out.sinkDepth = Math.min(out.depth, CONFIG.physics.powderDepth);
    return out;
  }

  /** Default (or named) spawn. Heading π faces −Z, the fall line. */
  getSpawn(name) {
    const s = this.spawns[name || this.features.defaultSpawn] || this.spawns['broadway-gate'];
    return {
      position: new THREE.Vector3(s.x, this.getHeight(s.x, s.z), s.z),
      heading: s.heading,
    };
  }

  /** Feature register, for props.js / physics.js / HUD minimap. */
  getFeatures() { return this.features; }

  /** Raw heightfield description, for anything that wants direct access. */
  getHeightfield() {
    return {
      data: this.height, depth: this.depth, surface: this.surf,
      res: this.n, cell: this.cell,
      originX: this.minX, originZ: this.minZ,
    };
  }

  /* ================================================================ *
   * PHASE A — analytic basin form (§2.3, §2.4)
   * ================================================================ */

  /**
   * The cirque, before any noise. The trick is to warp the *argument* of the
   * centreline profile outward from the fall line rather than adding a
   * cross-slope term: adding a term produces a visible parabolic gutter,
   * warping produces a bowl that is concave in plan and in section, with the
   * curvature out at the rim and a genuinely flat floor down the middle.
   */
  _baseHeight(x, z) {
    const A = FLANK_LIFT * smoothstep(-600, 500, z) + 60;
    const curl = A * Math.pow(Math.abs(x) / 1024, FLANK_POW);
    return this._profile(z + curl);
  }

  /* ================================================================ *
   * build()
   * ================================================================ */

  async build() {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const mark = (label) => {
      const t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this._timings.push([label, Math.round(t - this._tPrev)]);
      this._tPrev = t;
    };
    this._timings = []; this._tPrev = t0;

    const n = this.n, N = n * n;
    const H = this.height = new Float32Array(N);
    const yieldToHost = () => new Promise((r) => setTimeout(r, 0));

    this._phaseBase(H);                       mark('base+noise');
    this._phaseLandforms(H);                  mark('landforms');
    await yieldToHost();
    this._hydraulicErosion(H);                mark('hydraulic');
    await yieldToHost();
    this._thermalErosion(H);                  mark('thermal');
    await yieldToHost();
    this._phaseSurfaceFeatures(H);            mark('features');
    this._phaseDepth(H);                      mark('depth');
    this._phaseDrift(H);                      mark('drift');
    this._phaseClassify(H);                   mark('classify');
    this._placeTors();                        mark('tors');
    this._buildFarLUT();                      mark('far-lut');
    await yieldToHost();

    this._buildMeshes();                      mark('meshes');

    // Release build-only scratch (a few MB of Float32 we never read again).
    this._blurTmp = null;

    this.built = true;
    this._stats = this._acceptance();

    const total = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
    );
    if (typeof console !== 'undefined') {
      console.info(
        `[terrain] Soho Basin built in ${total} ms `
        + `(${this._timings.map(([k, v]) => `${k} ${v}ms`).join(', ')})`,
      );
      console.info('[terrain]', this._stats.summary);
      for (const w of this._stats.warnings) console.warn('[terrain] ' + w);
    }
    return this;
  }

  /* ---------------------------------------------------------------- *
   * PHASE A+B: analytic base + structural noise bands
   * ---------------------------------------------------------------- */

  _phaseBase(H) {
    const n = this.n, cell = this.cell, minX = this.minX, minZ = this.minZ;

    // |x|^1.6 and the flank-lift amplitude are separable — precompute both.
    const powX = new Float32Array(n);
    for (let i = 0; i < n; i++) powX[i] = Math.pow(Math.abs(minX + i * cell) / 1024, 1.6);

    const simR = this.simRidge, simM = this.simMid;

    for (let j = 0; j < n; j++) {
      const z = minZ + j * cell;
      const A = FLANK_LIFT * smoothstep(-600, 500, z) + 60;
      // Zone masks (cheap, z-only parts hoisted out of the inner loop).
      const upper = smoothstep(120, 560, z);
      const runout = smoothstep(-380, -720, z);
      const row = j * n;

      for (let i = 0; i < n; i++) {
        const x = minX + i * cell;

        // --- Band 0: analytic cirque -----------------------------------
        let h = this._profile(z + A * powX[i]);

        // --- Band 1: ridged multifractal — spurs and rib structure ------
        // Masked to the flanks and the upper basin: the bowl floor is
        // deliberately clean so the analytic form reads.
        const flank = smoothstep(280, 760, Math.abs(x));
        const ridgeMask = (0.24 + 0.76 * Math.max(flank, upper * 0.85)) * (1 - 0.42 * runout);
        const rg = ridged2(simR, x / 340, z / 340, { octaves: 3, sharpness: 1.35 });
        h += (rg - 0.5) * 24 * ridgeMask;

        // --- Band 2: domain-warped fBm — gullies, rollovers, spine field -
        // The warp is what kills the grid signature of raw fBm.
        h += warpedFbm2(simM, x / 96, z / 96, {
          octaves: 4, warp: 0.4, warpFrequency: 0.6, frequency: 1,
        }) * 5.0;

        // --- Run-out roll: the basin floor is 1.7° in section, which would
        // leave a third of the map dead flat. Real cirque floors are
        // hummocky — moraine, debris fans and braided outwash — so add a
        // broad low roll there and nowhere else.
        if (runout > 0) {
          h += billow2(simM, x / 130 + 31.7, z / 130 - 12.3, { octaves: 2 }) * 4.6 * runout;
        }

        H[row + i] = h;
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * PHASE C: landform features (rasterised over their bounding boxes)
   * ---------------------------------------------------------------- */

  /** Iterate the posts inside a plan bbox, with a margin. */
  _forBox(minX, maxX, minZ, maxZ, margin, cb) {
    const n = this.n, cell = this.cell;
    const i0 = Math.max(0, Math.floor((minX - margin - this.minX) / cell));
    const i1 = Math.min(n - 1, Math.ceil((maxX + margin - this.minX) / cell));
    const j0 = Math.max(0, Math.floor((minZ - margin - this.minZ) / cell));
    const j1 = Math.min(n - 1, Math.ceil((maxZ + margin - this.minZ) / cell));
    for (let j = j0; j <= j1; j++) {
      const z = this.minZ + j * cell, row = j * n;
      for (let i = i0; i <= i1; i++) cb(row + i, this.minX + i * cell, z);
    }
  }

  _phaseLandforms(H) {
    const F = this.features;
    const P = this._poly;

    /* -- Spurs: broad ridges that contain the basin ---------------------- */
    for (const s of F.spurs) {
      this._forBox(s.minX, s.maxX, s.minZ, s.maxZ, s.width * 2.2, (k, x, z) => {
        polyClosest(s.pts, s.cum, x, z, P);
        const g = Math.exp(-Math.pow(P.d / s.width, 1.8));
        // Taper the relief in from the head so the spur grows out of the rim.
        const taper = smoothstep(0, 140, P.s) * (1 - smoothstep(s.length - 180, s.length, P.s) * 0.55);
        H[k] += s.relief * g * taper;
      });
    }

    /* -- Headwall ribs: radiate down-slope from the crest arc ------------ */
    for (const r of F.ribs) {
      const sx = FOCUS_X + Math.sin(r.phi) * CREST_R;
      const sz = FOCUS_Z + Math.cos(r.phi) * CREST_R;
      const ex = FOCUS_X + Math.sin(r.phi) * (CREST_R - r.length);
      const ez = FOCUS_Z + Math.cos(r.phi) * (CREST_R - r.length);
      const meta = polyMeta([[sx, sz], [ex, ez]]);
      const pts = [[sx, sz], [ex, ez]];
      this._forBox(meta.minX, meta.maxX, meta.minZ, meta.maxZ, r.sigma * 3.2, (k, x, z) => {
        polyClosest(pts, meta.cum, x, z, P);
        const g = Math.exp(-((P.d / r.sigma) ** 2));
        const along = 1 - smoothstep(r.length * 0.55, r.length, P.s);
        H[k] += r.relief * g * (0.35 + 0.65 * along);
      });
    }

    /* -- Couloirs between the ribs --------------------------------------- */
    for (const g of F.gullies) {
      const phi = g.phi + g.jitter;
      const pts = [];
      for (let i = 0; i <= 8; i++) {
        // Fan the gully out as it descends toward the apron.
        const rr = CREST_R + 20 - (i / 8) * 330;
        const p = phi + Math.sin(i * 0.9) * 0.012;
        pts.push([FOCUS_X + Math.sin(p) * rr, FOCUS_Z + Math.cos(p) * rr]);
      }
      const meta = polyMeta(pts);
      const maxW = g.botW * 2.4;
      this._forBox(meta.minX, meta.maxX, meta.minZ, meta.maxZ, maxW + 30, (k, x, z) => {
        polyClosest(pts, meta.cum, x, z, P);
        const u = clamp01(P.s / meta.length);
        const w = lerp(g.topW, g.botW, u);
        const dep = g.depth * (0.55 + 0.45 * Math.sin(u * Math.PI));
        // Parabolic cross-section with soft shoulders.
        const t = clamp01(P.d / w);
        H[k] -= dep * (1 - t * t) * (1 - smoothstep(0.86, 1.0, u));
      });
    }

    /* -- Main gully (head of Soho Creek) and tributaries ------------------ */
    const cutGully = (gy) => {
      const maxW = Math.max(gy.width0, gy.width1) * 2.6;
      this._forBox(gy.minX, gy.maxX, gy.minZ, gy.maxZ, maxW + 40, (k, x, z) => {
        polyClosest(gy.pts, gy.cum, x, z, P);
        const u = clamp01(P.s / gy.length);
        const w = lerp(gy.width0, gy.width1, u);
        const dep = lerp(gy.depth0, gy.depth1, u);
        const t = clamp01(P.d / w);
        // Parabolic floor, walls easing out over another half-width.
        const prof = t < 1 ? (1 - t * t) : 0;
        const shoulder = (1 - smoothstep(1, 2.1, P.d / w)) * 0.22;
        H[k] -= dep * (prof + shoulder * (1 - prof));
      });
    };
    cutGully(F.mainGully);
    for (const t of F.tributaries) cutGully(t);

    /* -- Spine field: convex ribs down the fall line, rider's right ------- */
    for (const s of F.spines) {
      this._forBox(s.minX, s.maxX, s.minZ, s.maxZ, s.width * 3, (k, x, z) => {
        polyClosest(s.pts, s.cum, x, z, P);
        const g = Math.exp(-Math.pow(P.d / s.width, 1.7));
        const along = smoothstep(0, 45, P.s) * (1 - smoothstep(s.length - 70, s.length, P.s));
        // A spine is a crest with a trough either side — that is what makes
        // the flanks 25–35° and the line readable.
        const trough = Math.exp(-Math.pow((P.d - s.width * 1.9) / (s.width * 0.9), 2));
        H[k] += (s.relief * g - s.relief * 0.4 * trough) * along;
      });
    }

    /* -- Rollovers: convex lip + scooped landing = a natural jump --------- */
    for (const r of F.rollovers) {
      const R = r.sigma * 3.4;
      this._forBox(r.x - R, r.x + R, r.z - R * 1.6, r.z + R, 0, (k, x, z) => {
        const dx = x - r.x, dz = z - r.z;
        const bulge = Math.exp(-(dx * dx + dz * dz) / (r.sigma * r.sigma));
        // Landing scoop sits downhill (−Z) of the lip.
        const lz = dz + r.sigma * 1.55;
        const scoop = Math.exp(-(dx * dx + lz * lz) / (r.sigma * r.sigma * 1.6));
        H[k] += r.lip * bulge - r.lip * 0.5 * scoop;
      });
    }
  }

  /* ================================================================ *
   * PHASE D — EROSION
   *
   * This is the single biggest step from "procedural noise" to "mountain".
   * Hydraulic droplets carve dendritic drainage and deposit concave,
   * out-flaring run-outs; the thermal pass then enforces a believable talus
   * angle so nothing holds material it physically could not.
   * ================================================================ */

  _hydraulicErosion(H) {
    const n = this.n;
    const rng = makeRng(this._seed('erosion.hydraulic'));

    const DROPLETS = 165000;
    const LIFETIME = 40;
    const INERTIA = 0.055;
    const CAPACITY = 2.1;
    const MIN_SLOPE = 0.012;
    const ERODE = 0.24;
    const DEPOSIT = 0.30;
    const EVAPORATE = 0.016;
    const GRAVITY = 4.0;
    const RADIUS = 2;

    // Erosion brush: a radial falloff kernel normalised to unit mass, so a
    // droplet removes a smooth dish rather than a single-cell pit.
    const bdx = [], bdz = [], bw = [];
    let wsum = 0;
    for (let dz = -RADIUS; dz <= RADIUS; dz++) {
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > RADIUS * RADIUS) continue;
        const w = 1 - Math.sqrt(d2) / (RADIUS + 0.6);
        bdx.push(dx); bdz.push(dz); bw.push(w); wsum += w;
      }
    }
    for (let b = 0; b < bw.length; b++) bw[b] /= wsum;
    const BN = bw.length;

    // Work on a copy so the delta can be masked and clamped afterwards.
    const W = new Float32Array(H);

    for (let d = 0; d < DROPLETS; d++) {
      let px = 2 + rng() * (n - 5);
      let pz = 2 + rng() * (n - 5);
      let dx = 0, dz = 0, speed = 1, water = 1, sed = 0;

      for (let life = 0; life < LIFETIME; life++) {
        const ix = px | 0, iz = pz | 0;
        const fx = px - ix, fz = pz - iz;
        const k = iz * n + ix;
        const h00 = W[k], h10 = W[k + 1], h01 = W[k + n], h11 = W[k + n + 1];

        // Bilinear gradient (height per cell) and height at the current point.
        const gx = (h10 - h00) * (1 - fz) + (h11 - h01) * fz;
        const gz = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
        const hOld = h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz)
          + h01 * (1 - fx) * fz + h11 * fx * fz;

        dx = dx * INERTIA - gx * (1 - INERTIA);
        dz = dz * INERTIA - gz * (1 - INERTIA);
        const len = Math.hypot(dx, dz);
        if (len < 1e-7) break;
        dx /= len; dz /= len;
        px += dx; pz += dz;
        if (px < 1.5 || px > n - 2.5 || pz < 1.5 || pz > n - 2.5) break;

        // Height at the new position.
        const jx = px | 0, jz = pz | 0;
        const ux = px - jx, uz = pz - jz;
        const m = jz * n + jx;
        const hNew = W[m] * (1 - ux) * (1 - uz) + W[m + 1] * ux * (1 - uz)
          + W[m + n] * (1 - ux) * uz + W[m + n + 1] * ux * uz;
        const dh = hNew - hOld;

        const capacity = Math.max(-dh, MIN_SLOPE) * speed * water * CAPACITY;

        if (sed > capacity || dh > 0) {
          // Uphill or over-loaded: drop sediment where it is, filling pits and
          // building the concave alluvial run-out at the basin floor.
          const dep = dh > 0 ? Math.min(dh, sed) : (sed - capacity) * DEPOSIT;
          sed -= dep;
          W[k] += dep * (1 - fx) * (1 - fz);
          W[k + 1] += dep * fx * (1 - fz);
          W[k + n] += dep * (1 - fx) * fz;
          W[k + n + 1] += dep * fx * fz;
        } else {
          // Under-loaded on a descending step: cut, but never more than the
          // step itself — that self-limit is what keeps channels plausible.
          const ero = Math.min((capacity - sed) * ERODE, -dh);
          for (let b = 0; b < BN; b++) {
            const bi = ix + bdx[b], bj = iz + bdz[b];
            if (bi < 0 || bi >= n || bj < 0 || bj >= n) continue;
            const amt = ero * bw[b];
            W[bj * n + bi] -= amt;
            sed += amt;
          }
        }

        speed = Math.sqrt(Math.max(0, speed * speed + (-dh) * GRAVITY));
        water *= (1 - EVAPORATE);
        if (water < 0.02) break;
      }
    }

    // Fold the delta back in: clamped, and faded out at the box edge so the
    // containment rim and the far-field seam stay clean.
    const cell = this.cell;
    for (let j = 0; j < n; j++) {
      const z = this.minZ + j * cell;
      const edgeZ = Math.min(z - this.minZ, this.maxZ - z);
      const row = j * n;
      for (let i = 0; i < n; i++) {
        const x = this.minX + i * cell;
        const edge = Math.min(edgeZ, x - this.minX, this.maxX - x);
        const fade = smoothstep(0, 110, edge);
        const k = row + i;
        H[k] += clamp(W[k] - H[k], -11, 11) * fade;
      }
    }
  }

  /**
   * Thermal / talus relaxation. The limiting angle is elevation-dependent:
   * cold rocky headwall ground stands steeper than the depositional lower
   * face, which is exactly the profile a real cirque shows.
   */
  _thermalErosion(H) {
    const n = this.n, cell = this.cell;
    const PASSES = 12, RATE = 0.45;
    const delta = new Float32Array(H.length);
    const NX = [-1, 1, 0, 0, -1, 1, -1, 1];
    const NZ = [0, 0, -1, 1, -1, -1, 1, 1];
    const ND = [cell, cell, cell, cell, cell * 1.41421, cell * 1.41421, cell * 1.41421, cell * 1.41421];
    const ex = new Float64Array(8);

    for (let pass = 0; pass < PASSES; pass++) {
      delta.fill(0);
      for (let j = 1; j < n - 1; j++) {
        const row = j * n;
        for (let i = 1; i < n - 1; i++) {
          const k = row + i;
          const hc = H[k];
          // 33° in the depositional lower basin, 43° on the rocky headwall —
          // the real angle of repose for scree, and the limit for consolidated
          // snow-covered schist respectively.
          const tal = Math.tan(lerp(33, 43, smoothstep(1550, 1740, hc)) * DEG);
          let total = 0, maxE = 0;
          for (let q = 0; q < 8; q++) {
            const dn = hc - H[k + NZ[q] * n + NX[q]] - tal * ND[q];
            if (dn > 0) { ex[q] = dn; total += dn; if (dn > maxE) maxE = dn; }
            else ex[q] = 0;
          }
          if (total <= 0) continue;
          const move = RATE * maxE * 0.5;
          delta[k] -= move;
          const inv = move / total;
          for (let q = 0; q < 8; q++) {
            if (ex[q] > 0) delta[k + NZ[q] * n + NX[q]] += ex[q] * inv;
          }
        }
      }
      for (let k = 0; k < H.length; k++) H[k] += delta[k];
    }
  }

  /** Separable box blur into `dst`; used for grooming and curvature. */
  _blur(src, dst, radius) {
    const n = this.n;
    const tmp = this._blurTmp || (this._blurTmp = new Float32Array(src.length));
    const w = radius * 2 + 1;
    for (let j = 0; j < n; j++) {
      const row = j * n;
      let acc = 0;
      for (let i = -radius; i <= radius; i++) acc += src[row + clamp(i, 0, n - 1)];
      for (let i = 0; i < n; i++) {
        tmp[row + i] = acc / w;
        acc += src[row + clamp(i + radius + 1, 0, n - 1)] - src[row + clamp(i - radius, 0, n - 1)];
      }
    }
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = -radius; j <= radius; j++) acc += tmp[clamp(j, 0, n - 1) * n + i];
      for (let j = 0; j < n; j++) {
        dst[j * n + i] = acc / w;
        acc += tmp[clamp(j + radius + 1, 0, n - 1) * n + i] - tmp[clamp(j - radius, 0, n - 1) * n + i];
      }
    }
    return dst;
  }

  /* ================================================================ *
   * PHASE E — post-erosion features
   * Anything sharp, anything human, anything that erosion would have
   * destroyed: cornices, bluffs, benched traverses, groomed corridors.
   * ================================================================ */

  _phaseSurfaceFeatures(H) {
    const n = this.n, cell = this.cell, F = this.features, P = this._poly;
    const groom = this.groom = new Uint8Array(n * n);
    const bluffMask = this.bluffMask = new Uint8Array(n * n);

    /* -- Cornice: a signed-distance bulge on the lee lip of the crest ----- */
    // Height fields cannot overhang, so we build the lip and the steepened
    // drop; props.js adds a thin overhanging shell for the silhouette.
    for (const c of F.cornice) {
      const pm = (c.phi0 + c.phi1) * 0.5;
      const half = (c.phi1 - c.phi0) * 0.5;
      const bx = FOCUS_X + Math.sin(pm) * CREST_R, bz = FOCUS_Z + Math.cos(pm) * CREST_R;
      const R = CREST_R * half + 40;
      this._forBox(bx - R, bx + R, bz - R, bz + R, 30, (k, x, z) => {
        const dxf = x - FOCUS_X, dzf = z - FOCUS_Z;
        const r = Math.hypot(dxf, dzf);
        const phi = Math.atan2(dxf, dzf);
        let dphi = phi - pm;
        while (dphi > Math.PI) dphi -= Math.PI * 2;
        while (dphi < -Math.PI) dphi += Math.PI * 2;
        const along = 1 - smoothstep(half * 0.55, half, Math.abs(dphi));
        if (along <= 0) return;
        // Radial profile: a lip just uphill of the arc, a scoured shelf below.
        const dr = r - CREST_R;
        const lip = Math.exp(-Math.pow((dr - 4) / 11, 2));
        const scour = Math.exp(-Math.pow((dr + 26) / 20, 2));
        H[k] += along * (c.lip * lip - c.lip * 0.42 * scour);
      });
    }

    /* -- Bergschrund-analogue moat where the headwall meets the apron ----- */
    {
      const moatRng = makeRng(this._seed('moat'));
      const segs = [];
      for (let phi = -46 * DEG; phi < 44 * DEG; phi += 0.06) {
        if (moatRng() < 0.42) segs.push([phi, phi + moatRng.range(0.05, 0.14), moatRng.range(1.2, 2.2), moatRng.range(9, 16)]);
      }
      for (const [p0, p1, dep, wid] of segs) {
        const pm = (p0 + p1) * 0.5, half = (p1 - p0) * 0.5;
        const bx = FOCUS_X + Math.sin(pm) * BASE_R, bz = FOCUS_Z + Math.cos(pm) * BASE_R;
        const R = BASE_R * half + wid * 3;
        this._forBox(bx - R, bx + R, bz - R, bz + R, 20, (k, x, z) => {
          const dxf = x - FOCUS_X, dzf = z - FOCUS_Z;
          const r = Math.hypot(dxf, dzf);
          let dphi = Math.atan2(dxf, dzf) - pm;
          while (dphi > Math.PI) dphi -= Math.PI * 2;
          while (dphi < -Math.PI) dphi += Math.PI * 2;
          const along = 1 - smoothstep(half * 0.5, half, Math.abs(dphi));
          if (along <= 0) return;
          H[k] -= dep * along * Math.exp(-Math.pow((r - BASE_R) / wid, 2));
        });
      }
    }

    /* -- Bluff bands: the map's "air it or go around" feature -------------- */
    for (const b of F.bluffs) {
      const faceW = b.height / Math.tan(b.faceAngle);
      const R = faceW + 40;
      this._forBox(b.minX, b.maxX, b.minZ, b.maxZ, R + 30, (k, x, z) => {
        polyClosest(b.pts, b.cum, x, z, P);
        // Die out into a snow ramp at both ends.
        const along = smoothstep(0, 55, P.s) * (1 - smoothstep(b.length - 55, b.length, P.s));
        if (along <= 0.001) return;
        // Signed cross-slope offset: downhill of the line is −Z-ish.
        const side = (x - P.x) * -P.tz + (z - P.z) * P.tx;
        const t = clamp01((side + faceW * 0.5) / faceW);
        const drop = b.height * along * (1 - t);
        H[k] -= drop;
        if (Math.abs(side) < faceW * 0.75) {
          const m = Math.round(255 * along * (1 - smoothstep(faceW * 0.4, faceW * 0.75, Math.abs(side))));
          if (m > bluffMask[k]) bluffMask[k] = m;
        }
      });
    }

    /* -- Avalanche debris fans below each couloir mouth -------------------- */
    {
      const sim = this.simDrift;
      for (const g of F.gullies) {
        const mx = FOCUS_X + Math.sin(g.phi) * BASE_R;
        const mz = FOCUS_Z + Math.cos(g.phi) * BASE_R;
        const len = 130, spread = 70;
        this._forBox(mx - spread * 2.2, mx + spread * 2.2, mz - len * 1.3, mz + 30, 0, (k, x, z) => {
          const dz = mz - z;                       // positive downhill
          if (dz < 0 || dz > len) return;
          const u = dz / len;
          const w = lerp(20, spread, u);
          const cone = Math.exp(-Math.pow((x - mx) / w, 2)) * (1 - smoothstep(0.55, 1, u));
          if (cone < 0.01) return;
          const lump = billow2(sim, x / 22, z / 22, { octaves: 3 });
          H[k] += (lump - 0.42) * 2.6 * cone;
        });
      }
    }

    /* -- Solifluction terraces across the basin floor ---------------------- */
    {
      const sim = this.simDrift;
      for (let j = 0; j < n; j++) {
        const z = this.minZ + j * cell, row = j * n;
        for (let i = 0; i < n; i++) {
          const k = row + i;
          const h = H[k];
          if (h > 1452) continue;
          const x = this.minX + i * cell;
          const mask = (1 - smoothstep(1436, 1452, h));
          const tread = 13 + 6 * fbm2(sim, x / 220, z / 220, { octaves: 2 });
          const s = (h / tread) % 1;
          H[k] += 0.55 * mask * (smoothstep(0.62, 0.95, s < 0 ? s + 1 : s) - 0.5);
        }
      }
    }

    /* -- Braided creek line ------------------------------------------------ */
    {
      const c = F.creek;
      this._forBox(c.minX, c.maxX, c.minZ, c.maxZ, c.width * 3, (k, x, z) => {
        polyClosest(c.pts, c.cum, x, z, P);
        const w = c.width * (0.6 + 0.7 * (P.s / c.length));
        const t = clamp01(P.d / w);
        H[k] -= c.depth * (1 - t * t);
      });
    }

    /* -- Crest blockfield: flat-lying schist plates, displacement only ----- */
    {
      const sim = this.simFine;
      for (let j = 0; j < n; j++) {
        const z = this.minZ + j * cell, row = j * n;
        for (let i = 0; i < n; i++) {
          const k = row + i;
          if (H[k] < 1832) continue;
          const x = this.minX + i * cell;
          H[k] += fbm2(sim, x / 3.1, z / 3.1, { octaves: 2 }) * 0.10
            * smoothstep(1832, 1846, H[k]);
        }
      }
    }

    // A smoothed copy drives grooming and the benched running surfaces.
    const hSmooth = new Float32Array(H.length);
    this._blur(H, hSmooth, 4);

    /* -- Benched traverses: cut bank uphill, fill berm downhill ------------ */
    // A cat track is dead straight *in profile* against a noisy hillside —
    // that is the realism cue. But it also has to follow the hillside, or the
    // cut/fill becomes a 40 m quarry scar. So: sample the ground along the
    // centreline, smooth it hard, limit the grade, then bound the cut and
    // fill to a couple of metres.
    for (const t of F.tracks) {
      const ds = 4;
      const M = Math.max(4, Math.ceil(t.length / ds));
      const ground = new Float64Array(M + 1);
      for (let m = 0; m <= M; m++) {
        const s = (m / M) * t.length;
        let seg = 0;
        while (seg < t.cum.length - 2 && t.cum[seg + 1] < s) seg++;
        const u = (s - t.cum[seg]) / Math.max(1e-6, t.cum[seg + 1] - t.cum[seg]);
        ground[m] = this._field(
          lerp(t.pts[seg][0], t.pts[seg + 1][0], u),
          lerp(t.pts[seg][1], t.pts[seg + 1][1], u),
        );
      }
      const R = Math.max(2, Math.round(90 / ds));
      const prof = new Float64Array(M + 1);
      for (let m = 0; m <= M; m++) {
        let acc = 0, c = 0;
        for (let q = -R; q <= R; q++) { acc += ground[clamp(m + q, 0, M)]; c++; }
        prof[m] = acc / c;
      }
      // Descending grade, with only the gentlest permitted rise.
      const step = t.length / M;
      const maxFall = Math.tan(3.4 * DEG) * step, maxRise = Math.tan(0.35 * DEG) * step;
      for (let m = 1; m <= M; m++) {
        prof[m] = clamp(prof[m], prof[m - 1] - maxFall, prof[m - 1] + maxRise);
      }
      const hw = t.halfWidth;
      this._forBox(t.minX, t.maxX, t.minZ, t.maxZ, hw + 26, (k, x, z) => {
        polyClosest(t.pts, t.cum, x, z, P);
        const fm = clamp01(P.s / t.length) * M;
        const m0 = Math.min(M, fm | 0), m1 = Math.min(M, m0 + 1);
        const bench = lerp(prof[m0], prof[m1], fm - m0);
        const gm = lerp(ground[m0], ground[m1], fm - m0);
        // Bound the cut bank and the fill so the bench never becomes a scar.
        const target = clamp(bench, gm - 3.2, gm + 2.2);
        const w = 1 - smoothstep(hw, hw + 9, P.d);
        if (w > 0) H[k] = lerp(H[k], target, w * 0.94);
        // Fill berm on the downhill side only — a natural side-hit the whole way.
        // perp = (−tz, tx); it points downhill (−Z) when its z-component tx < 0.
        const side = (x - P.x) * -P.tz + (z - P.z) * P.tx;
        const downhill = P.tx < 0 ? side : -side;
        if (downhill > 0) {
          H[k] += 0.8 * Math.exp(-Math.pow((P.d - hw - 2.5) / 3.0, 2));
        }
        const gw = (1 - smoothstep(hw - 1, hw + 6, P.d)) * 255;
        if (gw > groom[k]) groom[k] = gw | 0;
      });
    }

    /* -- Groomed corridors -------------------------------------------------- */
    for (const c of F.corridors) {
      const hw = c.halfWidth;
      this._forBox(c.minX, c.maxX, c.minZ, c.maxZ, hw + 24, (k, x, z) => {
        polyClosest(c.pts, c.cum, x, z, P);
        const w = 1 - smoothstep(hw - 5, hw + 6, P.d);
        if (w <= 0) return;
        // Grooming removes everything below ~8 m wavelength and flattens the
        // cross-slope camber; corduroy itself is snowMaterial.js's job.
        H[k] = lerp(H[k], hSmooth[k], 0.72 * w);
        const gw = w * 255;
        if (gw > groom[k]) groom[k] = gw | 0;
      });
    }

    /* -- Lift corridor: no bluffs, nothing over 34°, level terminal pads --- */
    {
      const L = F.lift;
      const pts = L.pts;
      const hw = L.corridorHalfWidth;
      this._forBox(L.minX, L.maxX, L.minZ, L.maxZ, hw + 40, (k, x, z) => {
        polyClosest(pts, L.cum, x, z, P);
        const w = 1 - smoothstep(hw, hw + 20, P.d);
        if (w > 0) H[k] = lerp(H[k], hSmooth[k], 0.75 * w);
      });
      for (const term of [L.base, L.top]) {
        const px = L.padHalf.x, pz = L.padHalf.z;
        const padH = this._field(term.x, term.z);
        this._forBox(term.x - px, term.x + px, term.z - pz, term.z + pz, 26, (k, x, z) => {
          const w = (1 - smoothstep(px, px + 22, Math.abs(x - term.x)))
            * (1 - smoothstep(pz, pz + 22, Math.abs(z - term.z)));
          if (w > 0) {
            H[k] = lerp(H[k], padH, w * 0.95);
            const gw = w * 255;
            if (gw > groom[k]) groom[k] = gw | 0;
          }
        });
      }
    }

    /* -- Containment: a rising basin wall, never an invisible box ---------- */
    // 48 m over the final 130 m reads as a rising cirque rim at ~20°, which
    // the player accepts as terrain. A steeper ramp reads as a wall.
    const ramped = this.rampMask = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) {
      const z = this.minZ + j * cell, row = j * n;
      const rampZ = smoothstep(-894, -1024, z);
      const zoneZ = smoothstep(-380, -470, z);
      for (let i = 0; i < n; i++) {
        const ax = Math.abs(this.minX + i * cell);
        const rampX = smoothstep(894, 1024, ax);
        const ramp = Math.max(rampX, rampZ);
        if (ramp <= 0) continue;
        const k = row + i;
        // Only lift ground that is *low*; the upper corners are already at
        // the crest and need no rim. Every gate here is a smoothstep, not a
        // threshold — a hard `if (h < 1700)` puts a 40 m cliff along an
        // elevation contour, which is exactly the kind of seam getNormal()
        // and the LOD skirts cannot hide.
        const allow = Math.max(zoneZ, (1 - smoothstep(1620, 1730, H[k])) * smoothstep(880, 916, ax));
        if (allow <= 0.001) continue;
        if (ramp * allow > 0.35) ramped[k] = 255;
        H[k] = softMax(H[k] + ramp * allow * 48, 1865, 14);
      }
    }

    // Global soft limits — C1, so getNormal() stays continuous at the caps.
    for (let k = 0; k < H.length; k++) {
      H[k] = softMin(softMax(H[k], 1866, 12), 1409, 6);
    }
  }

  /* ================================================================ *
   * PHASE F — snow depth (§2.7)
   *
   * Carrying a depth field is what makes the mountain read as *snow on rock*
   * rather than as white terrain. Everything downstream — rock exposure,
   * surface class, drift amplitude, sink depth — is derived from it.
   * ================================================================ */

  _phaseDepth(H) {
    const n = this.n, cell = this.cell, N = n * n;
    const depth = this.depth = new Float32Array(N);
    const expo = this.expo = new Uint8Array(N);
    const curv = this.curv = new Float32Array(N);

    // Curvature from a 12 m Laplacian stencil on a lightly smoothed field:
    // raw 2 m curvature is dominated by drift noise and is useless here.
    const hs = new Float32Array(N);
    this._blur(H, hs, 3);
    const D = 6;                        // stencil radius in posts (12 m)
    const invD2 = 1 / ((D * cell) * (D * cell));
    for (let j = 0; j < n; j++) {
      const jm = clamp(j - D, 0, n - 1) * n, jp = clamp(j + D, 0, n - 1) * n;
      const row = j * n;
      for (let i = 0; i < n; i++) {
        const im = clamp(i - D, 0, n - 1), ip = clamp(i + D, 0, n - 1);
        const k = row + i;
        // Concave-positive Laplacian; stored convex-positive for the API.
        const lap = (hs[row + im] + hs[row + ip] + hs[jm + i] + hs[jp + i]) * 0.25 - hs[k];
        curv[k] = clamp(-lap * invD2 * 60, -1.6, 1.6);
      }
    }

    // Wind shelter index. Sampling *upwind* at eight ranges captures both the
    // local convexity and the big crest barrier in one number.
    const ux = WIND_FROM.x, uz = WIND_FROM.z;
    const RANGES = [20, 40, 70, 110, 160, 220, 300, 400];
    const simD = this.simDepth;

    for (let j = 0; j < n; j++) {
      const z = this.minZ + j * cell, row = j * n;
      for (let i = 0; i < n; i++) {
        const x = this.minX + i * cell, k = row + i;
        const h = H[k];

        // -- elevation base: 0.9 m at the valley, 1.8 m at the crest -------
        let d = 0.9 + clamp01((h - 1410) / 455) * 0.9;

        // -- natural variation, λ ≈ 120 m ----------------------------------
        d += 0.35 * fbm2(simD, x / 120, z / 120, { octaves: 3 });

        // -- lee deposition below the crest arc -----------------------------
        const rf = Math.hypot(x - FOCUS_X, z - FOCUS_Z);
        const below = CREST_R - rf;
        if (z > 90 && below > -30 && below < 420) {
          d += 2.4 * Math.exp(-Math.pow((below - 55) / 70, 2));
        }

        // -- curvature: concave collects, convex sheds ----------------------
        d += clamp(-curv[k], -0.6, 1.6);

        const hx = (H[row + (i < n - 1 ? i + 1 : i)] - H[row + (i > 0 ? i - 1 : i)]) / (2 * cell);
        const hz = (H[(j < n - 1 ? j + 1 : j) * n + i] - H[(j > 0 ? j - 1 : j) * n + i]) / (2 * cell);
        const slopeDeg = Math.atan(Math.hypot(hx, hz)) / DEG;

        // -- wind scour ------------------------------------------------------
        let E = -Infinity;
        for (let r = 0; r < 8; r++) {
          const dr = RANGES[r];
          let ii = Math.round((x + ux * dr - this.minX) * this.invCell);
          let jj = Math.round((z + uz * dr - this.minZ) * this.invCell);
          ii = ii < 0 ? 0 : ii > n - 1 ? n - 1 : ii;
          jj = jj < 0 ? 0 : jj > n - 1 ? n - 1 : jj;
          const e = (H[jj * n + ii] - h) / dr;
          if (e > E) E = e;
        }
        // The crest plateau is stripped by the nor'wester whatever the local
        // shelter index says — above 1820 m the pack is discontinuous and the
        // blockfield shows through (§1.4).
        // …but only on plateau-like ground: crest tops and spur shoulders,
        // not the steep rim faces, which the shelter index already handles.
        const crest = smoothstep(1826, 1854, h) * 0.62 * (1 - smoothstep(10, 20, slopeDeg));
        const scour = Math.max(clamp01(-E * 6), crest);
        expo[k] = (scour * 255) | 0;
        d -= 1.4 * scour;

        // -- sluffing on steep ground ---------------------------------------
        d -= clamp01((slopeDeg - 38) / 14) * 1.2;

        // Left unclamped below zero on purpose: the bare-ground balance pass
        // needs to know *how* bare a cell is, not just that it hit the floor.
        depth[k] = Math.min(d, 3.5);
      }
    }

    // Rock coverage is the single best one-number check that the mountain is
    // neither a quarry nor a meringue. Nudge the whole field if it has drifted
    // out of the 5–12% band (deterministic, and it never changes the shape).
    // Bare-ground fraction is bisected onto 5.5%; slope-shed and bluff faces
    // then take total rock coverage to roughly 8%, inside the 5–12% band.
    let lo = -1.5, hi = 1.5;
    const stride = 7;
    const ramp = this.rampMask;
    let samples = 0;
    for (let k = 0; k < N; k += stride) if (!ramp[k]) samples++;
    for (let it = 0; it < 26; it++) {
      const mid = (lo + hi) * 0.5;
      let c = 0;
      for (let k = 0; k < N; k += stride) if (!ramp[k] && depth[k] + mid < 0.10) c++;
      if (c / samples > 0.055) lo = mid; else hi = mid;
    }
    const off = (lo + hi) * 0.5;
    for (let k = 0; k < N; k++) depth[k] = clamp(depth[k] + off, 0, 3.5);
    this._depthOffset = off;
  }

  /* ================================================================ *
   * PHASE G — wind drift and pillow detail (bands 3 and 4)
   * Amplitude is driven by the depth field, so snow only piles where snow
   * can lie: bare rib crests stay sharp, lee gullies go soft and rounded.
   * ================================================================ */

  _phaseDrift(H) {
    const n = this.n, cell = this.cell;
    const simD = this.simDrift, simF = this.simFine;
    const depth = this.depth, groom = this.groom;

    // Drift is laid on the pre-drift surface, so read the slope from a copy.
    const src = new Float32Array(H);

    for (let j = 0; j < n; j++) {
      const z = this.minZ + j * cell, row = j * n;
      const jm = (j > 0 ? j - 1 : j) * n, jp = (j < n - 1 ? j + 1 : j) * n;
      for (let i = 0; i < n; i++) {
        const k = row + i;
        const combed = groom[k] / 255;        // groomers are combed flat
        if (combed > 0.985) continue;
        const x = this.minX + i * cell;
        const dScale = clamp01(depth[k] / 1.5) * (1 - combed);
        if (dScale < 0.02) continue;

        // Steep ground sheds: drift only builds where it can sit. Without
        // this the drift bands add ~10° of local slope *everywhere*, which
        // pushes the whole slope histogram up and puts snow on faces that
        // could never hold it.
        const im = i > 0 ? i - 1 : i, ip = i < n - 1 ? i + 1 : i;
        const gx = (src[row + ip] - src[row + im]) / (2 * cell);
        const gz = (src[jp + i] - src[jm + i]) / (2 * cell);
        const sDeg = Math.atan(Math.hypot(gx, gz)) / DEG;
        const shed = 1 - smoothstep(24, 42, sDeg);
        if (shed < 0.02) continue;
        const amp = dScale * shed;

        // Band 3 — mogul-scale drift, λ 8–30 m.
        const b3 = (billow2(simD, x / 17, z / 17, { octaves: 3 }) - 0.45) * 0.95 * amp;
        // Band 4 — drift lobes and pillows over buried rock, λ 4–8 m.
        const b4 = fbm2(simF, x / 6.2, z / 6.2, { octaves: 2 }) * 0.26 * amp;

        H[k] += b3 + b4;
      }
    }

    // A single light pass keeps 2 m posts free of aliasing spikes without
    // dulling the landform (the blur radius is one post).
    const tmp = new Float32Array(H.length);
    this._blur(H, tmp, 1);
    for (let k = 0; k < H.length; k++) H[k] = lerp(H[k], tmp[k], 0.12);

    // Despike. Droplet erosion occasionally leaves a single-post deposit, and
    // at 2 m spacing a 1 m spike is a 27° jolt the physics feels and the eye
    // reads as noise. Clamp each post to its neighbours' mean plus a slack
    // that scales with the local relief, so genuine slopes and rollovers are
    // untouched and only isolated posts move. Bluff faces are exempt — they
    // are meant to be sharp.
    const bluff = this.bluffMask;
    const src2 = new Float32Array(H);
    for (let j = 1; j < n - 1; j++) {
      const row = j * n;
      for (let i = 1; i < n - 1; i++) {
        const k = row + i;
        if (bluff[k] > 100) continue;
        const a = src2[k - 1], b = src2[k + 1], c = src2[k - n], d = src2[k + n];
        const mean = (a + b + c + d) * 0.25;
        const relief = Math.max(a, b, c, d) - Math.min(a, b, c, d);
        const slack = Math.max(0.40, relief * 0.13);
        H[k] = clamp(H[k], mean - slack, mean + slack);
      }
    }

    for (let k = 0; k < H.length; k++) {
      H[k] = softMin(softMax(H[k], 1866, 12), 1409, 6);
    }
  }

  /* ================================================================ *
   * PHASE H — surface classification (§2.9)
   * Priority order, first match wins: rock, groomed, ice, windpack, powder.
   * ================================================================ */

  _phaseClassify(H) {
    const n = this.n, cell = this.cell, N = n * n;
    const surf = this.surf = new Uint8Array(N);
    const rough = this.rough = new Uint8Array(N);
    const rockBlend = this.rockBlend = new Uint8Array(N);
    const depth = this.depth, expo = this.expo, curv = this.curv;
    const groom = this.groom, bluff = this.bluffMask;

    const Wx = WIND_TOWARD.x, Wz = WIND_TOWARD.z;
    const sast = CONFIG.snow.sastrugiStrength;
    const hist = new Float64Array(7);
    let histTotal = 0;

    for (let j = 0; j < n; j++) {
      const jm = (j > 0 ? j - 1 : j) * n, jp = (j < n - 1 ? j + 1 : j) * n;
      const row = j * n;
      for (let i = 0; i < n; i++) {
        const k = row + i;
        const im = i > 0 ? i - 1 : i, ip = i < n - 1 ? i + 1 : i;
        const hx = (H[row + ip] - H[row + im]) / (2 * cell);
        const hz = (H[jp + i] - H[jm + i]) / (2 * cell);
        const g = Math.hypot(hx, hz);
        const slopeDeg = Math.atan(g) / DEG;

        // Surface-projected wind: W minus its component along the normal.
        // Inside the bowl this flows cross-slope toward −X with a slight
        // up-slope bias — correct for a NW gale on a SW-facing basin.
        const inv = 1 / Math.sqrt(1 + g * g);
        const nx = -hx * inv, ny = inv, nz = -hz * inv;
        const wn = Wx * nx + Wz * nz;
        let wsx = Wx - wn * nx, wsz = Wz - wn * nz;
        const wl = Math.hypot(wsx, wsz) || 1;
        wsx /= wl; wsz /= wl;
        // Downhill direction in plan.
        const dl = g > 1e-6 ? g : 1;
        const dhx = -hx / dl, dhz = -hz / dl;
        const windward = (wsx * dhx + wsz * dhz) < -0.25;

        const d = depth[k];
        const e = expo[k] / 255;
        const c = curv[k];

        let id;
        if (d < 0.10 || slopeDeg > 50 || bluff[k] > 128) id = S_ROCK;
        else if (groom[k] > 128) id = S_GROOMED;
        else if (slopeDeg > 32 && windward && c > 0) id = S_ICE;
        else if (e > 0.5 || (c > 0.15 && d < 1.0)) id = S_WINDPACK;
        else id = S_POWDER;
        surf[k] = id;

        // Sastrugi amplitude only exists on wind-worked surfaces.
        const amp = (id === S_WINDPACK || id === S_ICE) ? (0.04 + 0.31 * e) * sast : 0;
        let r;
        switch (id) {
          case S_ROCK: r = 1.0; break;
          case S_ICE: r = 0.05; break;
          case S_GROOMED: r = 0.15; break;
          case S_WINDPACK: r = clamp01(0.55 + amp * 1.2); break;
          default: r = 0.30;
        }
        rough[k] = (r * 255) | 0;

        // Soft rock blend — a razor-edged snow/rock boundary is one of the
        // most damning tells there is, so the transition is 25 cm of depth.
        let rb = 1 - smoothstep(0.06, 0.30, d);
        rb = Math.max(rb, smoothstep(46, 56, slopeDeg));
        rb = Math.max(rb, bluff[k] / 255);
        rockBlend[k] = (clamp01(rb) * 255) | 0;

        // §2.10 measures the histogram over the playable box *excluding* the
        // containment ramps, which are deliberately steep boundary treatment.
        if (!this.rampMask[k]) {
          const b = slopeDeg < 5 ? 0 : slopeDeg < 12 ? 1 : slopeDeg < 20 ? 2
            : slopeDeg < 28 ? 3 : slopeDeg < 35 ? 4 : slopeDeg < 45 ? 5 : 6;
          hist[b]++;
          histTotal++;
        }
      }
    }
    this._slopeHist = Array.from(hist, (v) => v / Math.max(1, histTotal));
  }

  /**
   * Schist tor placement list (§2.5). Terrain owns *where* and *how oriented*;
   * props.js owns the meshes. Every tor in the basin shares one foliation
   * strike and dip — randomly-oriented boulders read instantly as fake.
   */
  _placeTors() {
    const rng = makeRng(this._seed('tors'));
    const STRIKE = 38 * DEG, DIP = 32 * DEG;
    const clusters = [];

    // Candidate ground: the wind-scoured crest plateau and both spur crests.
    const onCrest = (x, z) => {
      const h = this.getHeight(x, z);
      if (h < 1690) return false;
      const slope = this.getSlope(x, z) / DEG;
      if (slope > 26) return false;
      return this.getExposure(x, z) > 0.32 || h > 1826;
    };

    for (let attempt = 0; attempt < 6000 && clusters.length < 36; attempt++) {
      let x, z;
      const pick = rng();
      if (pick < 0.55) {                       // crest plateau
        x = rng.range(-900, 900); z = rng.range(830, 1010);
      } else if (pick < 0.78) {                // Soho Spur
        const t = rng();
        x = lerp(-560, -820, t) + rng.range(-45, 45);
        z = lerp(560, -700, t) + rng.range(-45, 45);
      } else {                                 // Captain's Shoulder
        const t = rng();
        x = lerp(600, 880, t) + rng.range(-45, 45);
        z = lerp(640, -620, t) + rng.range(-45, 45);
      }
      if (!onCrest(x, z)) continue;
      let ok = true;
      for (const c of clusters) {
        if ((c.x - x) ** 2 + (c.z - z) ** 2 < 95 * 95) { ok = false; break; }
      }
      if (!ok) continue;

      const count = rng.int(2, 9);
      const tors = [];
      for (let t = 0; t < count; t++) {
        // Tors in a cluster string out along the foliation strike.
        const along = rng.range(-1, 1) * (20 + count * 9);
        const across = rng.range(-1, 1) * 22;
        const tx = x + Math.cos(STRIKE) * along - Math.sin(STRIKE) * across;
        const tz = z + Math.sin(STRIKE) * along + Math.cos(STRIKE) * across;
        if (Math.abs(tx) > 1010 || Math.abs(tz) > 1010) continue;
        tors.push({
          x: tx, z: tz, y: this.getHeight(tx, tz),
          height: rng.range(1.5, 8), length: rng.range(3, 15), width: rng.range(1.5, 6),
          yaw: STRIKE + rng.range(-0.08, 0.08),
          dip: DIP,
        });
      }
      if (tors.length) clusters.push({ x, z, y: this.getHeight(x, z), tors });
    }
    this.features.torClusters = clusters;
    this.features.foliation = { strike: STRIKE, dip: DIP };
  }

  /* ================================================================ *
   * Geometry — clipmap LOD, backdrop shell, bluff faces
   * ================================================================ */

  _buildMeshes() {
    const ctx = this.ctx;

    this.material = createSnowMaterial(ctx, { vertexColors: true });
    // Harmless on a ShaderMaterial, essential on a MeshStandardMaterial.
    this.material.vertexColors = true;
    this.material.needsUpdate = true;
    this.rockMaterial = createRockMaterial(ctx, {});
    this.rockMaterial.polygonOffset = true;
    this.rockMaterial.polygonOffsetFactor = -2;
    this.rockMaterial.polygonOffsetUnits = -4;

    this._levels = [];
    for (let li = 0; li < LOD_LEVELS.length; li++) this._levels.push(this._makeLevel(li));

    this._backdrop = this._makeBackdrop();
    this.object3D.add(this._backdrop);

    const bluffs = this._makeBluffFaces();
    if (bluffs) { this._bluffMesh = bluffs; this.object3D.add(bluffs); }

    // Position every ring for the camera's current pose.
    this._updateLod(true);

    if (ctx.scene) ctx.scene.add(this.object3D);
  }

  /** Allocate one clipmap level: geometry, index buffer, skirt, mesh. */
  _makeLevel(li) {
    const cfg = LOD_LEVELS[li];
    const N = cfg.n, s = cfg.s, vpr = N + 1;
    const gridV = vpr * vpr;
    const skirtV = 4 * N;
    const total = gridV + skirtV;

    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const col = new Float32Array(total * 3);
    const aSurface = new Float32Array(total);
    const aDepth = new Float32Array(total);
    const aRoughness = new Float32Array(total);
    const aExposure = new Float32Array(total);
    const aCurvature = new Float32Array(total);
    const aRock = new Float32Array(total);

    // --- index buffer: ring quads + skirt strip ---------------------------
    const h0 = li > 0 ? (N >> 2) + 2 : -1;
    const h1 = li > 0 ? N - (N >> 2) - 2 : -1;
    const idx = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (li > 0 && i >= h0 && i < h1 && j >= h0 && j < h1) continue;
        const a = j * vpr + i, b = a + 1, c = a + vpr, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    // Perimeter cycle, wound so the skirt faces outward.
    const perim = [];
    for (let i = 0; i < N; i++) perim.push(0 * vpr + i);
    for (let j = 0; j < N; j++) perim.push(j * vpr + N);
    for (let i = N; i > 0; i--) perim.push(N * vpr + i);
    for (let j = N; j > 0; j--) perim.push(j * vpr + 0);
    for (let k = 0; k < perim.length; k++) {
      const p0 = perim[k], p1 = perim[(k + 1) % perim.length];
      const s0 = gridV + k, s1 = gridV + ((k + 1) % perim.length);
      idx.push(p0, p1, s0, p1, s1, s0);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSurface', new THREE.BufferAttribute(aSurface, 1));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(aDepth, 1));
    geo.setAttribute('aRoughness', new THREE.BufferAttribute(aRoughness, 1));
    geo.setAttribute('aExposure', new THREE.BufferAttribute(aExposure, 1));
    geo.setAttribute('aCurvature', new THREE.BufferAttribute(aCurvature, 1));
    geo.setAttribute('aRock', new THREE.BufferAttribute(aRock, 1));
    geo.setIndex(idx.length > 65535
      ? new THREE.BufferAttribute(new Uint32Array(idx), 1)
      : new THREE.BufferAttribute(new Uint16Array(idx), 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = `terrain-lod${li}`;
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    mesh.castShadow = li < SHADOW_LEVELS;
    mesh.renderOrder = -10 + li;
    this.object3D.add(mesh);

    return {
      li, N, s, vpr, gridV, perim, geo, mesh,
      half: N * s * 0.5,
      cx: NaN, cz: NaN,
      dirty: true,
      attrs: { pos, nor, uv, col, aSurface, aDepth, aRoughness, aExposure, aCurvature, aRock },
    };
  }

  /**
   * Rewrite one level's vertices for a new snapped centre.
   *
   * Two seam mechanisms cooperate here. (1) Every ring carries a vertical
   * skirt on its outer boundary, so an interpolation gap against the coarser
   * ring shows terrain, never sky. (2) Wherever this ring overlaps the finer
   * ring inside it, its vertices are *tucked* below the finer surface, which
   * guarantees the finer mesh wins the depth test without any z-fighting and
   * without needing seam-matched indices.
   */
  _rebuildLevel(lv) {
    const { N, s, vpr, gridV, perim, attrs } = lv;
    const { pos, nor, uv, col, aSurface, aDepth, aRoughness, aExposure, aCurvature, aRock } = attrs;
    const half = lv.half, cx = lv.cx, cz = lv.cz;
    const li = lv.li;

    const finer = li > 0 ? this._levels[li - 1] : null;
    const tuckDepth = 1.6 * s;
    const eps = Math.max(this.cell, s * 0.5);
    const invSize = 1 / this.size;
    const h0 = li > 0 ? (N >> 2) + 2 : -1;
    const h1 = li > 0 ? N - (N >> 2) - 2 : -1;
    const micro = li < MICRO_LEVELS;
    const microFade = half * 0.82;

    let minY = Infinity, maxY = -Infinity;
    // Untucked heights, kept so the normal pass is not poisoned by the tuck
    // ramp (which is hidden geometry and must not tilt the visible seam).
    const raw = lv.raw || (lv.raw = new Float32Array(vpr * vpr));
    const filled = (i, j) => !(li > 0 && i > h0 && i < h1 && j > h0 && j < h1);

    for (let j = 0; j <= N; j++) {
      const z = cz + (j - N * 0.5) * s;
      for (let i = 0; i <= N; i++) {
        if (!filled(i, j)) continue;                                    // unreferenced
        const x = cx + (i - N * 0.5) * s;
        const vi = j * vpr + i;

        let y = this._heightAt(x, z);

        // Sub-post detail, capped so getHeight() still matches the mesh.
        if (micro) {
          const cheb = Math.max(Math.abs(x - cx), Math.abs(z - cz));
          const fade = 1 - smoothstep(microFade * 0.55, microFade, cheb);
          if (fade > 0) y += this._micro(x, z) * fade;
        }
        raw[vi] = y;

        // Tuck under the finer ring.
        if (finer) {
          const d = Math.min(
            finer.half - Math.abs(x - finer.cx),
            finer.half - Math.abs(z - finer.cz),
          );
          if (d > 0) y -= tuckDepth * smoothstep(0, s, d);
        }

        const p = vi * 3;
        pos[p] = x; pos[p + 1] = y; pos[p + 2] = z;
        uv[vi * 2] = (x - this.minX) * invSize;
        uv[vi * 2 + 1] = (z - this.minZ) * invSize;

        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    // Normals. Rings at or above the heightfield's own 2 m spacing take their
    // gradient from the grid they already built (four array reads); the two
    // sub-post rings sample the field at 2 m so their shading matches
    // getNormal() exactly instead of faceting on the bilinear cells.
    const fromGrid = s >= this.cell;
    for (let j = 0; j <= N; j++) {
      const z = cz + (j - N * 0.5) * s;
      for (let i = 0; i <= N; i++) {
        if (!filled(i, j)) continue;
        const vi = j * vpr + i, p = vi * 3;
        let hx, hz;
        if (fromGrid) {
          const iL = i > 0 && filled(i - 1, j) ? i - 1 : i;
          const iR = i < N && filled(i + 1, j) ? i + 1 : i;
          const jD = j > 0 && filled(i, j - 1) ? j - 1 : j;
          const jU = j < N && filled(i, j + 1) ? j + 1 : j;
          hx = (raw[j * vpr + iR] - raw[j * vpr + iL]) / Math.max(1e-6, (iR - iL) * s);
          hz = (raw[jU * vpr + i] - raw[jD * vpr + i]) / Math.max(1e-6, (jU - jD) * s);
        } else {
          const x = cx + (i - N * 0.5) * s;
          hx = (this._heightAt(x + eps, z) - this._heightAt(x - eps, z)) / (2 * eps);
          hz = (this._heightAt(x, z + eps) - this._heightAt(x, z - eps)) / (2 * eps);
        }
        const inv = 1 / Math.sqrt(hx * hx + hz * hz + 1);
        nor[p] = -hx * inv; nor[p + 1] = inv; nor[p + 2] = -hz * inv;
        this._writeVertexAttrs(vi, cx + (i - N * 0.5) * s, z, attrs, Math.hypot(hx, hz));
      }
    }

    // Skirt ring: duplicate the perimeter, dropped.
    const drop = Math.max(0.6, 1.2 * s);
    for (let k = 0; k < perim.length; k++) {
      const src = perim[k], dst = gridV + k;
      const ps = src * 3, pd = dst * 3;
      pos[pd] = pos[ps]; pos[pd + 1] = pos[ps + 1] - drop; pos[pd + 2] = pos[ps + 2];
      nor[pd] = nor[ps]; nor[pd + 1] = nor[ps + 1]; nor[pd + 2] = nor[ps + 2];
      uv[dst * 2] = uv[src * 2]; uv[dst * 2 + 1] = uv[src * 2 + 1];
      col[pd] = col[ps]; col[pd + 1] = col[ps + 1]; col[pd + 2] = col[ps + 2];
      aSurface[dst] = aSurface[src]; aDepth[dst] = aDepth[src];
      aRoughness[dst] = aRoughness[src]; aExposure[dst] = aExposure[src];
      aCurvature[dst] = aCurvature[src]; aRock[dst] = aRock[src];
    }

    for (const name of ['position', 'normal', 'uv', 'color', 'aSurface', 'aDepth',
      'aRoughness', 'aExposure', 'aCurvature', 'aRock']) {
      lv.geo.getAttribute(name).needsUpdate = true;
    }
    const bs = lv.geo.boundingSphere;
    bs.center.set(cx, (minY + maxY) * 0.5, cz);
    bs.radius = Math.hypot(half, half) + (maxY - minY) * 0.5 + tuckDepth + drop + 4;
    lv.dirty = false;
  }

  /**
   * Per-vertex surface state handed to snowMaterial.js. Also bakes a vertex
   * colour so rock, windpack and the tussock-margin ground read correctly
   * even before the shading workstream lands.
   */
  _writeVertexAttrs(vi, x, z, attrs, gradMag) {
    const inBox = x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ;
    let id = S_POWDER, d = 1.2, r = 0.30, e = 0, c = 0, rb = 0;
    if (inBox && this.surf) {
      id = this._fieldNearest(this.surf, x, z);
      d = this._fieldLerp(this.depth, x, z);
      r = this._fieldNearest(this.rough, x, z) / 255;
      e = this._fieldNearest(this.expo, x, z) / 255;
      c = this._fieldLerp(this.curv, x, z);
      rb = this._fieldNearest(this.rockBlend, x, z) / 255;
    } else if (!inBox) {
      // Far field: bare, wind-scoured ground on the steep bits.
      e = 0.5;
      const sDeg = Math.atan(gradMag !== undefined ? gradMag : Math.tan(this.getSlope(x, z))) / DEG;
      rb = clamp01((sDeg - 40) / 14);
      id = rb > 0.5 ? S_ROCK : S_WINDPACK;
    }

    attrs.aSurface[vi] = id;
    attrs.aDepth[vi] = d;
    attrs.aRoughness[vi] = r;
    attrs.aExposure[vi] = e;
    attrs.aCurvature[vi] = c;
    attrs.aRock[vi] = rb;

    let cr = 1, cg = 1, cb = 1;
    if (id === S_WINDPACK) { cr = 0.985; cg = 0.99; cb = 1.0; }
    else if (id === S_ICE) { cr = 0.94; cg = 0.965; cb = 1.0; }
    if (rb > 0) {
      // Otago schist: grey-green, weathering rust-brown on the exposed faces.
      const w = clamp01(e * 0.7);
      const rr = lerp(0.245, 0.290, w), rg = lerp(0.204, 0.196, w), rbl = lerp(0.153, 0.132, w);
      cr = lerp(cr, rr, rb); cg = lerp(cg, rg, rb); cb = lerp(cb, rbl, rb);
    }
    // Snow tussock ground, the one natural colour accent on a white field.
    if (inBox && d < 0.25) {
      const y = this.getHeight(x, z);
      const sDeg = Math.atan(gradMag !== undefined ? gradMag : Math.tan(this.getSlope(x, z))) / DEG;
      const tus = (1 - smoothstep(0.12, 0.25, d))
        * (1 - smoothstep(1500, 1570, y))
        * (1 - smoothstep(20, 26, sDeg));
      if (tus > 0) {
        const t = tus * 0.55;
        cr = lerp(cr, 0.58, t); cg = lerp(cg, 0.44, t); cb = lerp(cb, 0.23, t);
      }
    }
    const p = vi * 3;
    attrs.col[p] = cr; attrs.col[p + 1] = cg; attrs.col[p + 2] = cb;
  }

  /**
   * Sastrugi micro-relief, capped at MICRO_CAP. 4:1 elongated along the
   * surface wind with a steep undercut upwind face and a gentle downwind
   * tail — a symmetric ripple reads as corduroy, not as sastrugi.
   */
  _micro(x, z) {
    const inBox = x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ;
    if (!inBox || !this.surf) return 0;
    const id = this._fieldNearest(this.surf, x, z);
    if (id === S_ROCK || id === S_GROOMED) return 0;
    const e = this._fieldNearest(this.expo, x, z) / 255;

    const wx = WIND_TOWARD.x, wz = WIND_TOWARD.z;
    const u = x * wx + z * wz;          // along wind
    const v = -x * wz + z * wx;         // across wind
    const jitter = this.simMicro.noise2D(u * 0.22, v * 1.1);

    if (id === S_WINDPACK || id === S_ICE) {
      const p = u / 1.35 + jitter * 0.55;
      let s = p - Math.floor(p);
      // Steep rise (upwind face), long gentle tail.
      const prof = s < 0.14 ? (s / 0.14) : 1 - (s - 0.14) / 0.86;
      const amp = Math.min(MICRO_CAP, (0.05 + 0.30 * e) * CONFIG.snow.sastrugiStrength * 0.5);
      return (prof - 0.5) * 2 * amp;
    }
    // Powder / drifted ground: soft ripple only.
    return this.simMicro.noise2D(u * 0.5, v * 0.32) * MICRO_CAP * 0.35;
  }

  /**
   * Distant backdrop shell: a polar annulus from the edge of the clipmap out
   * to CONFIG.terrain.backdropRadius, carrying the real Otago skyline. The
   * playable box must never end in a visible cliff at the horizon.
   */
  _makeBackdrop() {
    const R0 = BACKDROP_INNER, R1 = CONFIG.terrain.backdropRadius;
    const AN = 192, RN = 40;
    const rings = RN + 2;                       // +1 outer, +1 skirt
    const total = rings * (AN + 1);

    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const col = new Float32Array(total * 3);
    const aSurface = new Float32Array(total);
    const aDepth = new Float32Array(total);
    const aRoughness = new Float32Array(total);
    const aExposure = new Float32Array(total);
    const aCurvature = new Float32Array(total);
    const aRock = new Float32Array(total);
    const attrs = { pos, nor, uv, col, aSurface, aDepth, aRoughness, aExposure, aCurvature, aRock };

    const growth = Math.pow(R1 / R0, 1 / RN);
    const radii = [];
    for (let k = 0; k <= RN; k++) radii.push(R0 * Math.pow(growth, k));
    radii.push(R1);                              // duplicated for the skirt

    const invSize = 1 / this.size;
    for (let k = 0; k < rings; k++) {
      const r = radii[k];
      const skirt = k === rings - 1;
      for (let a = 0; a <= AN; a++) {
        const t = (a / AN) * Math.PI * 2;
        const x = Math.cos(t) * r, z = Math.sin(t) * r;
        const vi = k * (AN + 1) + a;
        let y = this._heightAt(x, z) - BACKDROP_SINK;
        if (skirt) y -= 1500;                    // drop the rim below the horizon
        const eps = Math.max(60, r * 0.01);
        const hx = (this._heightAt(x + eps, z) - this._heightAt(x - eps, z)) / (2 * eps);
        const hz = (this._heightAt(x, z + eps) - this._heightAt(x, z - eps)) / (2 * eps);
        const inv = 1 / Math.sqrt(hx * hx + hz * hz + 1);
        const p = vi * 3;
        pos[p] = x; pos[p + 1] = y; pos[p + 2] = z;
        nor[p] = -hx * inv; nor[p + 1] = inv; nor[p + 2] = -hz * inv;
        uv[vi * 2] = (x - this.minX) * invSize;
        uv[vi * 2 + 1] = (z - this.minZ) * invSize;
        this._writeVertexAttrs(vi, x, z, attrs, Math.hypot(hx, hz));
      }
    }

    const idx = [];
    for (let k = 0; k < rings - 1; k++) {
      for (let a = 0; a < AN; a++) {
        const A = k * (AN + 1) + a, B = A + 1;
        const C = A + (AN + 1), D = C + 1;
        idx.push(A, C, B, B, C, D);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSurface', new THREE.BufferAttribute(aSurface, 1));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(aDepth, 1));
    geo.setAttribute('aRoughness', new THREE.BufferAttribute(aRoughness, 1));
    geo.setAttribute('aExposure', new THREE.BufferAttribute(aExposure, 1));
    geo.setAttribute('aCurvature', new THREE.BufferAttribute(aCurvature, 1));
    geo.setAttribute('aRock', new THREE.BufferAttribute(aRock, 1));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'terrain-backdrop';
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.renderOrder = -20;
    return mesh;
  }

  /**
   * Bluff faces as explicit rock geometry. The heightfield already carries the
   * step, but a 55–80° face smoothed across 2 m posts reads as a white ramp;
   * a thin proud strip in the rock material reads as a schist bluff.
   */
  _makeBluffFaces() {
    const verts = [], norms = [], uvs = [], idx = [];
    const rng = makeRng(this._seed('bluff.faces'));
    let base = 0;

    for (const b of this.features.bluffs) {
      const faceW = b.height / Math.tan(b.faceAngle);
      const step = 3;
      const cols = Math.max(2, Math.round(b.length / step));
      const strip = [];
      for (let c = 0; c <= cols; c++) {
        const sArc = (c / cols) * b.length;
        // Walk the polyline to the arc position.
        let seg = 0;
        while (seg < b.cum.length - 2 && b.cum[seg + 1] < sArc) seg++;
        const t = (sArc - b.cum[seg]) / Math.max(1e-6, b.cum[seg + 1] - b.cum[seg]);
        const px = lerp(b.pts[seg][0], b.pts[seg + 1][0], t);
        const pz = lerp(b.pts[seg][1], b.pts[seg + 1][1], t);
        const dx = b.pts[seg + 1][0] - b.pts[seg][0], dz = b.pts[seg + 1][1] - b.pts[seg][1];
        const L = Math.hypot(dx, dz) || 1;
        const tx = dx / L, tz = dz / L;
        const perpX = -tz, perpZ = tx;          // points uphill for these segments
        const along = smoothstep(0, 55, sArc) * (1 - smoothstep(b.length - 55, b.length, sArc));
        if (along < 0.12) { strip.push(null); continue; }

        const wob = rng.range(-0.6, 0.9);
        const topX = px + perpX * (faceW * 0.5 + 0.6), topZ = pz + perpZ * (faceW * 0.5 + 0.6);
        const botX = px - perpX * (faceW * 0.5 + 1.4 + wob), botZ = pz - perpZ * (faceW * 0.5 + 1.4 + wob);
        strip.push({
          tx: topX, tz: topZ, ty: this.getHeight(topX, topZ) + 0.25,
          bx: botX, bz: botZ, by: this.getHeight(botX, botZ) - 0.35,
          nx: -perpX, nz: -perpZ,
        });
      }
      for (let c = 0; c < strip.length - 1; c++) {
        const a = strip[c], d = strip[c + 1];
        if (!a || !d) continue;
        const i0 = base + verts.length / 3;
        verts.push(a.tx, a.ty, a.tz, a.bx, a.by, a.bz, d.tx, d.ty, d.tz, d.bx, d.by, d.bz);
        for (let q = 0; q < 4; q++) norms.push(a.nx, 0.16, a.nz);
        uvs.push(0, 1, 0, 0, 1, 1, 1, 0);
        idx.push(i0, i0 + 1, i0 + 2, i0 + 2, i0 + 1, i0 + 3);
      }
    }
    if (!idx.length) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(norms), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(idx);
    geo.normalizeNormals?.();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.rockMaterial);
    mesh.name = 'terrain-bluffs';
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /* ================================================================ *
   * LOD streaming
   * ================================================================ */

  _updateLod(force) {
    const cam = this.ctx.camera;
    const px = cam ? cam.position.x : 0;
    const pz = cam ? cam.position.z : 0;

    for (const lv of this._levels) {
      const snap = lv.s * 2;
      const cx = Math.round(px / snap) * snap;
      const cz = Math.round(pz / snap) * snap;
      if (force || cx !== lv.cx || cz !== lv.cz) {
        lv.cx = cx; lv.cz = cz; lv.dirty = true;
        // The next coarser ring tucks against this one, so it must follow.
        const coarser = this._levels[lv.li + 1];
        if (coarser) coarser.dirty = true;
      }
    }
    for (const lv of this._levels) if (lv.dirty) this._rebuildLevel(lv);
  }

  update(dt, ctx) {
    if (!this.built) return;
    this._updateLod(false);
    if (typeof updateSnowMaterial === 'function') {
      updateSnowMaterial(this.material, dt, ctx);
      updateSnowMaterial(this.rockMaterial, dt, ctx);
    }
  }

  /* ================================================================ *
   * Build-time acceptance checks (§2.14)
   * ================================================================ */

  _acceptance() {
    const n = this.n, N = n * n, H = this.height;
    const warnings = [];
    let minH = Infinity, maxH = -Infinity, bad = 0, steep = 0;

    for (let k = 0; k < N; k++) {
      const h = H[k];
      if (!Number.isFinite(h)) { bad++; continue; }
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    for (let j = 0; j < n; j++) {
      const row = j * n;
      for (let i = 0; i < n - 1; i++) {
        const g = Math.abs(H[row + i + 1] - H[row + i]) / this.cell;
        if (g > 3.0 && this.bluffMask[row + i] < 100) steep++;
      }
    }
    if (bad) warnings.push(`${bad} non-finite posts`);
    if (minH < 1408) warnings.push(`min elevation ${minH.toFixed(1)} < 1408`);
    if (maxH > 1867) warnings.push(`max elevation ${maxH.toFixed(1)} > 1867`);

    let rock = 0, groomed = 0, ice = 0, wind = 0, powder = 0, tot = 0;
    for (let k = 0; k < N; k++) {
      if (this.rampMask[k]) continue;
      tot++;
      switch (this.surf[k]) {
        case S_ROCK: rock++; break;
        case S_GROOMED: groomed++; break;
        case S_ICE: ice++; break;
        case S_WINDPACK: wind++; break;
        default: powder++;
      }
    }
    const pct = (v) => (100 * v / Math.max(1, tot));
    if (pct(rock) < 5 || pct(rock) > 12) warnings.push(`rock coverage ${pct(rock).toFixed(1)}% outside 5–12%`);
    if (pct(groomed) < 5 || pct(groomed) > 16) warnings.push(`groomed coverage ${pct(groomed).toFixed(1)}% outside 5–16%`);

    // Spawn sanity + a straight glide down the fall line.
    const sp = this.getSpawn();
    const spInfo = this.sample(sp.position.x, sp.position.z, {});
    let worst = 0, jump = 0, prevDh = null;
    for (let z = sp.position.z; z > -600; z -= 2) {
      const s = this.getSlope(sp.position.x, z) / DEG;
      if (s > worst) worst = s;
      // A steep *pitch* is fine; what must not exist is a step the
      // neighbouring posts do not predict, i.e. a jump in the gradient.
      const dh = this.getHeight(sp.position.x, z) - this.getHeight(sp.position.x, z + 2);
      if (prevDh !== null) jump = Math.max(jump, Math.abs(dh - prevDh));
      prevDh = dh;
    }
    if (worst > 50) warnings.push(`fall-line glide hits ${worst.toFixed(0)}°`);
    if (jump > 1.5) warnings.push(`fall-line gradient jump ${jump.toFixed(2)} m over 2 m`);
    const spSlope = spInfo.slope / DEG;
    if (spSlope < 5 || spSlope > 11) warnings.push(`spawn slope ${spSlope.toFixed(1)}° outside 5–11°`);
    if (spInfo.surface !== 'windpack') warnings.push(`spawn surface is ${spInfo.surface}, expected windpack`);

    // Mesh/physics agreement over the near rings.
    const rng = makeRng(this._seed('acceptance'));
    let maxErr = 0;
    for (let t = 0; t < 2000; t++) {
      const x = rng.range(this.minX + 8, this.maxX - 8);
      const z = rng.range(this.minZ + 8, this.maxZ - 8);
      const err = Math.abs((this._heightAt(x, z) + this._micro(x, z)) - this.getHeight(x, z));
      if (err > maxErr) maxErr = err;
    }
    if (maxErr > 0.05) warnings.push(`mesh/physics disagreement ${maxErr.toFixed(3)} m`);

    const bands = ['0-5', '5-12', '12-20', '20-28', '28-35', '35-45', '45+'];
    const hist = this._slopeHist.map((v, i) => `${bands[i]}:${(v * 100).toFixed(0)}%`).join(' ');

    return {
      minH, maxH, maxMeshError: maxErr,
      coverage: { rock: pct(rock), groomed: pct(groomed), ice: pct(ice), windpack: pct(wind), powder: pct(powder) },
      slopeHist: this._slopeHist,
      spawn: { slopeDeg: spInfo.slope / DEG, surface: spInfo.surface },
      steepPosts: steep,
      warnings,
      summary: `elev ${minH.toFixed(0)}–${maxH.toFixed(0)} m | `
        + `rock ${pct(rock).toFixed(1)}% groomed ${pct(groomed).toFixed(1)}% ice ${pct(ice).toFixed(1)}% `
        + `windpack ${pct(wind).toFixed(1)}% powder ${pct(powder).toFixed(1)}% | slope ${hist} | `
        + `mesh err ${maxErr.toFixed(3)} m`,
    };
  }

  getStats() { return this._stats; }

  dispose() {
    for (const lv of this._levels || []) lv.geo.dispose();
    this._backdrop?.geometry.dispose();
    this._bluffMesh?.geometry.dispose();
    this.material?.dispose();
    this.rockMaterial?.dispose();
    this.object3D.parent?.remove(this.object3D);
  }
}
