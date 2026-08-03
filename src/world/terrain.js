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
/**
 * Fraction of a foliation cycle occupied by the plate's lip. Wide enough that
 * the lip spans three or more rows of the bluff grid: a lip narrower than two
 * samples is a step edge, and a step edge aliases whatever its fundamental
 * wavelength is.
 */
const FOL_LIP = 0.42;

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
    // Braided creek depression (§2.5): 1–3 m deep, 15–40 m wide. Carried as a
    // depth0/1 + width0/1 channel so the drainage rasteriser can treat it as
    // the downstream continuation of the main gully.
    f.creek = {
      pts: [[-260, -520], [-330, -640], [-390, -760], [-470, -890], [-540, -1024]],
      depth0: 1.2, depth1: 3.0, width0: 17, width1: 38,
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
      // 60 m control spacing left the shortest band with FOUR points, and a
      // big-amplitude sine over four points is a perfect triangle — the
      // terrain map renders the three bands as geometric glyphs (a triangle,
      // an M, a bar), and the wide shots read them as engraved scars. A real
      // escarpment meanders at two scales; 24 m posts resolve both.
      const steps = Math.max(6, Math.round((x1 - x0) / 24));
      const phase = bluffRng() * 6.28;
      for (let i = 0; i <= steps; i++) {
        const x = lerp(x0, x1, i / steps);
        const u = i / steps;
        const meander = 0.5
          + 0.33 * Math.sin(u * 8.7 + phase)
          + 0.17 * Math.sin(u * 21.3 + phase * 2.31 + 1.4);
        pts.push([x, -140 - 80 * Math.min(1, Math.max(0, meander)) + bluffRng.range(-6, 6)]);
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
    // `serration` is how sawtoothed the massif's own skyline is. The Otago
    // block ranges (Pisa, Criffel) genuinely are flat-topped warped peneplain
    // remnants and must stay lozenge-like; the schist arêtes across the lake
    // (Remarkables, Richardson, Harris) are sheer serrated walls, and from a
    // 1755 m camera the Remarkables subtend only ~1.4°, so silhouette shape
    // is the *only* thing that peak can contribute.
    const raw = [
      // name,             summit, θ(deg from −Z toward +X), dist,  width, elongation, strike, serration
      ['mt-cardrona', 1936, -160, 2400, 1500, 1.8, 30, 0.45],
      ['pisa', 1963, -149, 15000, 5200, 2.6, 40, 0.15],
      ['criffel', 1626, 171, 14000, 4200, 2.8, 15, 0.15],
      ['mt-soho', 1752, 18, 6500, 1900, 1.5, -25, 0.50],
      ['coronet', 1649, 26, 16000, 2600, 1.2, 0, 0.70],
      ['remarkables', 2319, -17, 22000, 5000, 2.2, -10, 1.00],
      ['hector', 1900, -34, 42000, 6000, 3.0, -10, 0.85],
      ['richardson', 2100, 47, 32000, 5200, 2.2, 25, 1.00],
      ['harris', 2400, 112, 42000, 6500, 2.0, 45, 1.00],
      ['treble-cone', 2339, 127, 28000, 4000, 1.6, 20, 0.85],
      ['aspiring', 3033, 119, 57000, 3000, 1.0, 0, 0.80],
    ];
    return raw.map(([name, h, theta, dist, w, elong, strike, serr]) => {
      let d = dist, hh = h, ww = w;
      if (dist > RMAX) { const k = RMAX / dist; d = RMAX; hh = EYE + (h - EYE) / k; ww = w * k; }
      const t = theta * DEG;
      return {
        name,
        x: Math.sin(t) * d, z: -Math.cos(t) * d,
        h: Math.min(hh, 3200), w: ww, elong, serr,
        // Serration wavelength scales with the massif, but never below the
        // 180 m angular post spacing the backdrop can actually carry.
        sw: Math.max(650, ww * 0.19),
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
    // Datum for the far-field vertical exaggeration below: everything added
    // after this line is "relief".
    const hRegional = h;

    // Range-scale ridged structure, faded in so it never disturbs the seam.
    const nAmp = 260 * smoothstep(1200, 4200, r);
    h += (ridged2(this.simFar, x / 3800, z / 3800, { octaves: 4, sharpness: 1.25 }) - 0.42) * nAmp;
    h += fbm2(this.simFar, x / 1500, z / 1500, { octaves: 3 }) * 40 * smoothstep(1100, 2600, r);

    // The range wall. The user's identity reference is four-to-six stacked
    // rows of serrated, fully snow-clad ranges filling the top third of a
    // mid-slope frame — the named skyline peaks alone leave open plain
    // between them and the horizon reads as a low band. Two extra ridged
    // systems fill the stack: 2.6 km rows (the between-massif ranges) and a
    // 420 m corrugation that gives every far face the avalanche-flute
    // shading the reference wall is textured with.
    const wall = smoothstep(6000, 11000, r);
    // Massif clustering: a continuous ridged field at one amplitude reads as
    // a rampart, not a mountain range. Group the energy into distinct
    // massifs with real cols and gaps between them — the reference horizon
    // is peaks and notches, and the sky showing through the low points is
    // what makes the high points read as majesty rather than wall.
    const massif = 0.30 + 0.85 * clamp01(
      fbm2(this.simFar, x / 9200 + 3.3, z / 9200 - 6.1, { octaves: 2 }) * 0.5 + 0.5,
    );
    h += (ridged2(this.simFar, x / 2600 + 7.7, z / 2600 - 3.1, { octaves: 3, sharpness: 1.4 }) - 0.40)
      * 420 * wall * massif;
    // Flute wavelength must stay resolvable by the backdrop's 100-180 m
    // far posts: 420 m at 105 m amplitude aliased into a picket-fence comb.
    h += (ridged2(this.simFar, x / 900 - 11.3, z / 900 + 5.9, { octaves: 2, sharpness: 1.3 }) - 0.45)
      * 70 * smoothstep(5000, 9000, r);

    // Named skyline elements. max(), not sum() — mountains do not add.
    //
    // A Gaussian cannot be serrated, and a rounded white lozenge on the
    // horizon is the one thing a distant massif must never read as. Each peak
    // therefore carries ridged detail *inside its own mask*: sub-summits,
    // notches and a broken crest line, faded out with the same g that raises
    // the peak so it never leaks onto the surrounding plain.
    for (const p of this._sky) {
      const dx = x - p.x, dz = z - p.z;
      const u = (dx * p.cs + dz * p.sn) / p.elong;
      const v = -dx * p.sn + dz * p.cs;
      const d = Math.hypot(u, v) / p.w;
      if (d > 2.6) continue;
      const g = Math.exp(-Math.pow(d, 2.4));
      let ph = lerp(h, p.h, g);
      if (p.serr > 0 && g > 0.015) {
        const rd = ridged2(this.simFar, dx / p.sw, dz / p.sw, { octaves: 3, sharpness: 1.6 });
        ph += p.h * 0.18 * g * p.serr * (rd - 0.45);
      }
      if (ph > h) h = ph;
    }

    // Cinematic vertical exaggeration of the far field. Geographic truth
    // puts a 2400 m summit at 20 km at ~2° of elevation — a sliver. The
    // reference photography that defines the identity is telephoto-
    // compressed, and matching its FEEL in a wide game lens needs the far
    // relief amplified the way every mountain game amplifies it. Positive
    // relief above the regional base scales up to 2.2× by 13 km; valleys
    // are left alone so the cols and gaps stay low and the sky still shows
    // through between massifs.
    const relief = h - hRegional;
    if (relief > 0) {
      h = hRegional + relief * lerp(1, 1.6, smoothstep(6000, 13000, r));
    }

    // Earth curvature: 53 m of drop at 26 km is the difference between a
    // horizon and a wall.
    h -= (r * r) / EARTH_2R;
    return h;
  }

  /* ================================================================ *
   * Public query API
   * ================================================================ */

  /**
   * Box-filtered mip pyramid of the height field.
   *
   * The coarse clipmap rings point-sample a field that has content well below
   * their Nyquist limit, and an aliased *height* is invisible (sub-texel at
   * those distances) while an aliased *gradient* is not: the sub-Nyquist
   * detail folds into low-frequency N·L stripes that a 10.6° raking sun
   * amplifies into contour-parallel terraces — the round-3 critics' dominant
   * mid-field tell. Normals for those rings therefore have to come from a
   * field low-passed at the ring's own scale, which is exactly what a box
   * mip is. A few MB and a few ms, built once.
   */
  _buildHeightMips() {
    this.heightMips = [{ data: this.height, n: this.n, cell: this.cell }];
    let src = this.height, sn = this.n, cell = this.cell;
    while (sn > 64) {
      const dn = Math.ceil(sn / 2);
      const dst = new Float32Array(dn * dn);
      for (let j = 0; j < dn; j++) {
        const j0 = Math.min(2 * j, sn - 1), j1 = Math.min(2 * j + 1, sn - 1);
        for (let i = 0; i < dn; i++) {
          const i0 = Math.min(2 * i, sn - 1), i1 = Math.min(2 * i + 1, sn - 1);
          dst[j * dn + i] = 0.25 * (src[j0 * sn + i0] + src[j0 * sn + i1]
            + src[j1 * sn + i0] + src[j1 * sn + i1]);
        }
      }
      cell *= 2;
      this.heightMips.push({ data: dst, n: dn, cell });
      src = dst; sn = dn;
    }
  }

  /**
   * Bilinear tap on mip level `lv`. Each 2×2 average sits half a source cell
   * toward +x/+z of its coarse post, so the accumulated offset is
   * (cell_lv − cell_0) / 2 — skipping it would shear every mip by up to half
   * a coarse cell and tilt the far normals downhill.
   */
  _mipField(lv, x, z) {
    const m = this.heightMips[lv];
    const { data, n, cell } = m;
    const off = (cell - this.cell) * 0.5;
    let fx = (x - this.minX - off) / cell;
    let fz = (z - this.minZ - off) / cell;
    fx = fx < 0 ? 0 : fx > n - 1.0001 ? n - 1.0001 : fx;
    fz = fz < 0 ? 0 : fz > n - 1.0001 ? n - 1.0001 : fz;
    const i = fx | 0, j = fz | 0;
    const tx = fx - i, tz = fz - j;
    const k = j * n + i;
    const h0 = data[k] + (data[k + 1] - data[k]) * tx;
    const h1 = data[k + n] + (data[k + n + 1] - data[k + n]) * tx;
    return h0 + (h1 - h0) * tz;
  }

  /**
   * Slope gradient anti-aliased for a mesh of post spacing `spacing`: central
   * difference on the mip whose cell is ≈ spacing/2, with the difference span
   * matched to the posts. `out` = {hx, hz}.
   */
  _mipGradient(x, z, spacing, out) {
    const mips = this.heightMips;
    let lv = 0;
    while (lv + 1 < mips.length && mips[lv + 1].cell <= spacing * 0.5 + 1e-6) lv++;
    const e = Math.max(mips[lv].cell, spacing * 0.75);
    out.hx = (this._mipField(lv, x + e, z) - this._mipField(lv, x - e, z)) / (2 * e);
    out.hz = (this._mipField(lv, x, z + e) - this._mipField(lv, x, z - e)) / (2 * e);
    return out;
  }

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

    this._buildDrainNetwork();                mark('drain-net');
    this._phaseBase(H);                       mark('base+noise');
    this._phaseLandforms(H);                  mark('landforms');
    await yieldToHost();
    this._hydraulicErosion(H);                mark('hydraulic');
    await yieldToHost();
    this._thermalErosion(H);                  mark('thermal');
    await yieldToHost();
    this._phaseDrainage(H);                   mark('drainage');
    this._phaseSurfaceFeatures(H);            mark('features');
    this._phaseDepth(H);                      mark('depth');
    this._phaseDrift(H);                      mark('drift');
    this._phaseClassify(H);                   mark('classify');
    this._placeTors();                        mark('tors');
    this._buildFarLUT();                      mark('far-lut');
    this._buildHeightMips();                  mark('height-mips');
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
   * DRAINAGE NETWORK (§2.5) — rasterised once, consumed three times.
   *
   * `drainCut[k]` is the trench the network wants at that post: the deepest
   * `depth(t) * exp(-(d / (0.6 w(t)))^2)` any channel asks for, evaluated as
   * a signed distance against the polylines (max(), not sum(), so a
   * confluence is one channel rather than two stacked ones).
   *
   * `drainMask[k]` is the corridor influence, and it is the half of this that
   * actually matters. The old ordering cut the gully *before* the ±5 m
   * domain-warped band and the ±4.6 m run-out billow, so a 2 m headwater
   * trench was simply overwritten and even the 14 m lower gorge was reduced
   * to a texture. Now the noise bands stand aside inside the corridor
   * (`1 − 0.75 · mask`) and the trench is subtracted *after* erosion, which
   * is what makes the drainage read from the valley-vista camera.
   * ---------------------------------------------------------------- */

  _buildDrainNetwork() {
    const N = this.n * this.n;
    const cut = this.drainCut = new Float32Array(N);
    const mask = this.drainMask = new Float32Array(N);
    const P = this._poly;
    const F = this.features;

    const rasterise = (ch, maskScale = 1) => {
      const wMax = Math.max(ch.width0, ch.width1);
      this._forBox(ch.minX, ch.maxX, ch.minZ, ch.maxZ, wMax * 2.4 + 40, (k, x, z) => {
        polyClosest(ch.pts, ch.cum, x, z, P);
        const u = clamp01(P.s / ch.length);
        const w = lerp(ch.width0, ch.width1, u);
        const dep = lerp(ch.depth0, ch.depth1, u);
        // Gaussian trench: at d = w the wall is down to 6% of the depth, and
        // the steepest wall lands at 24–26°, which is §2.5's 25–35° band.
        const q = P.d / (w * 0.6);
        const c = dep * Math.exp(-q * q);
        if (c > cut[k]) cut[k] = c;
        const m = smoothstep(w * 1.4, w * 0.5, P.d) * maskScale;
        if (m > mask[k]) mask[k] = m;
      });
    };

    rasterise(F.mainGully);
    for (const t of F.tributaries) rasterise(t);
    rasterise(F.creek);

    // Braid threads: the creek is anastomosing across its own outwash, so lay
    // two shallower offset channels either side of the main thread.
    const braidRng = makeRng(this._seed('creek.braid'));
    for (const sgn of [-1, 1]) {
      const pts = F.creek.pts.map(([x, z], i, a) => {
        const j = Math.min(i, a.length - 2);
        const dx = a[j + 1][0] - a[j][0], dz = a[j + 1][1] - a[j][1];
        const L = Math.hypot(dx, dz) || 1;
        const off = sgn * (10 + braidRng.range(0, 9)) * (0.4 + 0.6 * (i / (a.length - 1)));
        return [x + (-dz / L) * off, z + (dx / L) * off];
      });
      const ch = { pts, depth0: 0.5, depth1: 1.2, width0: 8, width1: 15, ...polyMeta(pts) };
      rasterise(ch, 0.6);
    }

    this.features.drainage = { main: F.mainGully, tributaries: F.tributaries, creek: F.creek };
  }

  /** Subtract the drainage trench. Runs after erosion so nothing refills it. */
  _phaseDrainage(H) {
    const cut = this.drainCut;
    if (!cut) return;
    for (let k = 0; k < H.length; k++) H[k] -= cut[k];
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
    const dmask = this.drainMask;

    for (let j = 0; j < n; j++) {
      const z = minZ + j * cell;
      const A = FLANK_LIFT * smoothstep(-600, 500, z) + 60;
      // Zone masks (cheap, z-only parts hoisted out of the inner loop).
      const upper = smoothstep(120, 560, z);
      const runout = smoothstep(-380, -720, z);
      const row = j * n;

      for (let i = 0; i < n; i++) {
        const x = minX + i * cell;
        // Inside a drainage corridor the structural bands stand aside, or
        // they simply refill the trench that gets cut after erosion.
        const nSup = 1 - 0.75 * (dmask ? dmask[row + i] : 0);

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
        }) * 5.0 * nSup;

        // --- Run-out roll: the basin floor is 1.7° in section, which would
        // leave a third of the map dead flat. Real cirque floors are
        // hummocky — moraine, debris fans and braided outwash — so add a
        // broad low roll there and nowhere else.
        //
        // billow2 is strictly positive with a mean near 0.44, so the raw form
        // was a +2 m *blanket* that faded in exactly across the mid-face /
        // floor break and turned the concave scoop the profile describes into
        // a convex shoulder. Centring it keeps the hummocks and gives the
        // break back its concavity.
        if (runout > 0) {
          h += (billow2(simM, x / 130 + 31.7, z / 130 - 12.3, { octaves: 2 }) - 0.44)
            * 4.6 * runout * (0.35 + 0.65 * nSup);
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

    /* -- Main gully and tributaries: see _phaseDrainage(). The trench is cut
     * after erosion, not here — a pre-erosion carve is refilled by the noise
     * bands, by droplet deposition and by the talus pass. -------------------- */

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
    //
    // Cut and fill are clamped asymmetrically. Droplets arriving on the basin
    // floor dump everything they are carrying, and an 11 m aggradation
    // blanket is precisely what turns the cirque's concave run-out into the
    // smooth convex plane the art critique flagged. Incision still gets its
    // full 11 m — it is the half of erosion that makes drainage readable.
    const cell = this.cell;
    for (let j = 0; j < n; j++) {
      const z = this.minZ + j * cell;
      const edgeZ = Math.min(z - this.minZ, this.maxZ - z);
      const row = j * n;
      const fillCap = lerp(11, 2.5, smoothstep(-250, -620, z));
      for (let i = 0; i < n; i++) {
        const x = this.minX + i * cell;
        const edge = Math.min(edgeZ, x - this.minX, this.maxX - x);
        const fade = smoothstep(0, 110, edge);
        const k = row + i;
        H[k] += clamp(W[k] - H[k], -11, fillCap) * fade;
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
        // The drop must RECOVER to grade past a talus bench, not run to the
        // bounding-box edge: applied unrecovered, every texel downhill of the
        // line inside the box carried the full step, and the box boundary
        // etched a literal rectangle into the field (visible on the terrain
        // map as a frame under each band).
        const below = Math.max(0, -side - faceW * 0.5);
        const recover = 1 - smoothstep(faceW * 1.0 + 8, faceW * 3.0 + 36, below);
        const drop = b.height * along * (1 - t) * recover;
        H[k] -= drop;
        if (Math.abs(side) < faceW * 0.75) {
          const m = Math.round(255 * along * (1 - smoothstep(faceW * 0.4, faceW * 0.75, Math.abs(side))));
          if (m > bluffMask[k]) bluffMask[k] = m;
        }
      });
    }

    /* -- Avalanche debris fans below each couloir mouth and bluff gap ------- */
    // §2.5: hummocky lumps 0.5–2.0 m over fans 60–140 m long. This runs after
    // the erosion passes on purpose — a ±1 m hummock field laid before the
    // ±5 m band-2 octave and then dragged through 165 000 droplets simply
    // does not survive.
    {
      const sim = this.simDrift;
      const mouths = [];
      for (const g of F.gullies) {
        mouths.push({
          x: FOCUS_X + Math.sin(g.phi) * BASE_R,
          z: FOCUS_Z + Math.cos(g.phi) * BASE_R,
          len: 140, spread: 78, amp: 1.0,
        });
      }
      // Debris also piles at the basin floor below the two bluff through-gaps
      // (x −300…−140 and −20…+300), which is where the slide paths converge.
      mouths.push({ x: -220, z: -232, len: 120, spread: 64, amp: 0.82 });
      mouths.push({ x: 140, z: -238, len: 130, spread: 82, amp: 0.9 });

      for (const m of mouths) {
        const { x: mx, z: mz, len, spread } = m;
        this._forBox(mx - spread * 2.4, mx + spread * 2.4, mz - len * 1.3, mz + 30, 0, (k, x, z) => {
          const dz = mz - z;                       // positive downhill
          if (dz < 0 || dz > len) return;
          const u = dz / len;
          const w = lerp(22, spread, u);
          const cone = Math.exp(-Math.pow((x - mx) / w, 2)) * (1 - smoothstep(0.6, 1, u));
          if (cone < 0.01) return;
          // Two lump scales: 26 m lobes and 12 m blocks, together ±1.9 m. Both
          // stop at λ 12 m / 4 posts — the previous 6.5 m and 4.75 m octaves
          // aliased on the 2 m grid and speckled the fans.
          const lobe = billow2(sim, x / 26, z / 26, { octaves: 2 }) - 0.44;
          const block = billow2(sim, x / 12 + 7.1, z / 12 - 3.3, { octaves: 1 }) - 0.45;
          H[k] += (lobe * 3.3 + block * 1.15) * cone * m.amp;
        });
      }
    }

    /* -- Solifluction lobes across the basin floor ------------------------- */
    // The previous form — a 0.75 m riser on `(h / tread) % 1` applied to every
    // post below 1456 m — was corduroy, not solifluction. Contours of constant
    // h are parallel lines across a slope, so a tread that only varies at a
    // 220 m scale draws a perfectly regular parallel band set across the whole
    // floor; a 0.75 m riser is a 4–6 % slope perturbation, which a 10.6° raking
    // sun turns into a 20-luma alternating ripple that survives to the far
    // field. Real solifluction is *patchy and aspect-selective*: a few discrete
    // lobate benches on moderate ground, never a continuous contour set.
    //
    // Four changes, in order of how much each one matters:
    //   1. a low-frequency lobe mask, so terraces occupy ~25 % of the floor;
    //   2. a slope gate (14–28°), because lobes do not form on flats or scarps;
    //   3. a 14/44 m phase offset inside the modulo, so the bands stop being
    //      parallel and no single vertical period survives (§11 tell 14);
    //   4. the riser itself dropped 0.75 → 0.16 m.
    // Deltas are accumulated into a scratch field and applied afterwards so the
    // slope gate reads the *pre-terrace* surface and cannot feed back on itself.
    {
      const sim = this.simDrift;
      const RISER = 0.16;
      const dTer = new Float32Array(n * n);
      for (let j = 1; j < n - 1; j++) {
        const z = this.minZ + j * cell, row = j * n;
        for (let i = 1; i < n - 1; i++) {
          const k = row + i;
          const h = H[k];
          if (h > 1456) continue;      // must match the mask's upper edge
          const band = 1 - smoothstep(1436, 1456, h);
          if (band <= 0.002) continue;
          const x = this.minX + i * cell;

          // 1. Lobate patches, 40–110 m across, covering about a quarter of
          //    the floor. Everything outside a patch stays perfectly smooth.
          const lobe = fbm2(sim, x / 54 + 17.3, z / 54 - 9.1, { octaves: 3 });
          const patch = smoothstep(0.12, 0.30, lobe);
          if (patch <= 0.002) continue;

          // 2. Solifluction needs a slope to creep down and a surface to creep
          //    over: nothing on the flats, nothing on the steep scarps.
          const gx = (H[k + 1] - H[k - 1]) / (2 * cell);
          const gz = (H[k + n] - H[k - n]) / (2 * cell);
          const sDeg = Math.atan(Math.hypot(gx, gz)) / DEG;
          const gate = smoothstep(11, 16, sDeg) * (1 - smoothstep(26, 33, sDeg));
          if (gate <= 0.002) continue;

          // 3. Non-harmonic tread plus a two-scale phase offset. Because the
          //    offset is added to `h` inside the modulo, the risers wander
          //    across the contours instead of tracking them.
          const tread = 11 + 7 * fbm2(sim, x / 137 + 3.7, z / 137 + 8.9, { octaves: 3 });
          const phase = 5.5 * sim.noise2D(x / 44, z / 44)
            + 1.8 * sim.noise2D(x / 14.3 + 6.1, z / 14.3 - 2.4);
          let s = ((h + phase) / tread) % 1;
          if (s < 0) s += 1;
          // 4. A rounded riser spread over 40 % of the tread. On 15° ground the
          //    break then runs ~17 m across the surface — eight 2 m posts, so
          //    the grid carries it without a harmonic tail to alias.
          dTer[k] = RISER * band * patch * gate * (smoothstep(0.55, 0.95, s) - 0.5);
        }
      }
      for (let k = 0; k < dTer.length; k++) H[k] += dTer[k];
    }

    /* -- Braided creek line: cut in _phaseDrainage() with the rest of the
     * network, so the same corridor mask keeps noise out of its floor. ------ */

    /* -- Crest blockfield: flat-lying schist plates, displacement only ----- */
    {
      const sim = this.simFine;
      for (let j = 0; j < n; j++) {
        const z = this.minZ + j * cell, row = j * n;
        for (let i = 0; i < n; i++) {
          const k = row + i;
          if (H[k] < 1832) continue;
          const x = this.minX + i * cell;
          // λ 16 / 8 m. The old λ 3.1 / 1.55 m sat far below the 2 m post
          // Nyquist limit and folded into a post-to-post checkerboard across
          // the whole crest; plate-scale relief belongs to the rock material,
          // not to the heightfield.
          H[k] += fbm2(sim, x / 16, z / 16, { octaves: 2 }) * 0.10
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
    const depth = this.depth, groom = this.groom, drain = this.drainMask;

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
        // Gully floors are lee, smooth and wind-loaded, not mogulled — and a
        // ±1 m drift band across a 12 m headwater trench erases it.
        const amp = dScale * shed * (1 - 0.6 * (drain ? drain[k] : 0));

        // Bands 3 and 4 are band-limited to the 2 m post grid: the finest
        // octave either band may carry is 8 m (4 posts). The old settings ran
        // billow to λ 4.25 m and fbm to λ 3.1 m — both under the 4 m Nyquist
        // limit of a 2 m heightfield — so ~9 cm of displacement folded into a
        // post-to-post ripple across the *entire* snow surface. Under a 10.6°
        // raking sun that is a ±2.5° facet swing on every post pair, which is
        // the corduroy/fingerprint texture; and because the coarse clipmap
        // rings resample the same aliased field, it stayed at full amplitude
        // into the far field instead of fading (§11 tell 16).
        // Amplitudes go up as the wavelengths do, to ±0.55 m and ±0.15 m —
        // both still inside §2.6's ±1.2 m / ±0.35 m, and chosen so the slope
        // histogram lands where it did before the band limit (0–5° 16.6 %
        // against 16.4 %), rather than trading a texture artefact for a
        // flatter mountain.
        // Band 3 — mogul-scale drift, λ 20 / 10 m (§2.6 asks 8–30 m).
        const b3 = (billow2(simD, x / 20, z / 20, { octaves: 2 }) - 0.45) * 1.22 * amp;
        // Band 4 — drift lobes and pillows over buried rock, λ 11 m. The 4–8 m
        // end of this band is below what a 2 m heightfield can carry at all; it
        // lives in the snow material's detail normal, which is filtered.
        const b4 = fbm2(simF, x / 11, z / 11, { octaves: 1 }) * 0.30 * amp;

        H[k] += b3 + b4;
      }
    }

    // A single light pass keeps 2 m posts free of aliasing spikes without
    // dulling the landform (the blur radius is one post). A 3-tap box has a
    // response of −1/3 at the 4 m post-alternating frequency and +0.97 at
    // λ 20 m, so mixing 32 % of it removes 43 % of whatever ripple sits at the
    // grid limit — the band that renders as corduroy — and 4 % of the moguls.
    // Band 3's amplitude is raised alongside it so the slope histogram does
    // not drift: §2.14 test 6 is measured, not assumed (see _acceptance).
    const tmp = new Float32Array(H.length);
    this._blur(H, tmp, 1);
    for (let k = 0; k < H.length; k++) H[k] = lerp(H[k], tmp[k], 0.32);

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
    // vec4, per SNOW_VERTEX_ATTRIBUTES: (groomed, windpack, ice, snowCover).
    const aSurface = new Float32Array(total * 4);
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
    geo.setAttribute('aSurface', new THREE.BufferAttribute(aSurface, 4));
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
   *
   * Neither of those hides the *step*. Each ring samples the same surface at
   * a different quantisation, so where ring L ends and ring L+1 begins the
   * two surfaces disagree by up to the coarser ring's sampling error — which
   * renders as a stack of horizontal terraces marching across every slope
   * face, one per ring boundary, and as an aliased staircase on the ridge
   * silhouette. The cure is geomorphing: over the outer quarter of every
   * ring, blend the vertex height toward the height the *next coarser* post
   * spacing would give, reaching it exactly at the boundary. The rings then
   * agree at the join to the last centimetre and the terrace disappears.
   *
   * Because the rings only rebuild when their snapped centre moves, and the
   * morph weight is a function of position within the ring rather than of
   * camera distance, the blend is done on the CPU here rather than in the
   * vertex shader — same result, no extra attribute, and snowMaterial.js
   * (owned elsewhere) needs no change.
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
    // Sub-post detail is faded out before every ring boundary. It is the one
    // band the coarser ring cannot reproduce (its posts are wider than the
    // sastrugi wavelength), so it has to be gone by the join; what is left is
    // a residual of a few centimetres, well under MICRO_CAP.
    const microFade = half * 0.82;
    // Geomorph target spacing = the next coarser ring's posts. Below the 2 m
    // heightfield the coarse sample reproduces the fine one exactly (both are
    // bilinear taps of the same field), so levels 0 and 1 need no blend.
    const coarseS = s * 2;
    const morphs = coarseS > this.cell && li < this._levels.length - 1;

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
        const cheb = Math.max(Math.abs(x - cx), Math.abs(z - cz));

        // Sub-post detail, capped so getHeight() still matches the mesh.
        if (micro) {
          const fade = 1 - smoothstep(microFade * 0.55, microFade, cheb);
          if (fade > 0) y += this._micro(x, z, s) * fade;
        }

        // Geomorph toward the next coarser post spacing over the outer
        // quarter of the ring, so the ring boundary carries no step.
        if (morphs) {
          const t = smoothstep(0.75, 1.0, cheb / half);
          if (t > 0) y = lerp(y, this._coarseHeightAt(x, z, coarseS), t);
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
    //
    // Rings of 8 m posts and coarser do NOT difference their own samples:
    // point samples of a field with content below the ring's Nyquist give an
    // aliased gradient, and under the 10.6° sun that renders as the contour-
    // parallel terrace bands the round-3 critics measured at 1–3 km. Their
    // gradient comes from the box-mip pyramid instead (see _buildHeightMips).
    const fromGrid = s >= this.cell;
    // Down to the 2×-cell ring: the round-4 sun-height ablation showed the
    // "floating dark smudge" blobs at 200–800 m are the geometric terminator
    // of drift rolls, polygon-edged because the 4–8 m rings' point-sampled
    // normals alias it. The base ring keeps exact-field normals for crisp
    // near-field drift shading.
    const fromMip = s >= this.cell * 2 && this.heightMips;
    const grad = { hx: 0, hz: 0 };
    for (let j = 0; j <= N; j++) {
      const z = cz + (j - N * 0.5) * s;
      for (let i = 0; i <= N; i++) {
        if (!filled(i, j)) continue;
        const vi = j * vpr + i, p = vi * 3;
        let hx, hz;
        if (fromMip) {
          this._mipGradient(cx + (i - N * 0.5) * s, z, s, grad);
          hx = grad.hx; hz = grad.hz;
        } else if (fromGrid) {
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
      const s4 = src * 4, d4 = dst * 4;
      aSurface[d4] = aSurface[s4]; aSurface[d4 + 1] = aSurface[s4 + 1];
      aSurface[d4 + 2] = aSurface[s4 + 2]; aSurface[d4 + 3] = aSurface[s4 + 3];
      aDepth[dst] = aDepth[src];
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
   * The height a clipmap ring of post spacing `cs` renders at (x, z): a
   * bilinear tap on the lattice of multiples of `cs`. Every clipmap centre is
   * snapped to a multiple of 2·s, so a ring of spacing `cs` always has its
   * posts on exactly that lattice regardless of where the camera is — which
   * is what lets the finer ring morph onto the coarser ring's surface without
   * needing to know where the coarser ring currently sits.
   */
  _coarseHeightAt(x, z, cs) {
    const inv = 1 / cs;
    const x0 = Math.floor(x * inv) * cs, z0 = Math.floor(z * inv) * cs;
    const tx = (x - x0) * inv, tz = (z - z0) * inv;
    const ax = tx > 1e-6, az = tz > 1e-6;
    if (!ax && !az) return this._heightAt(x, z);      // already a coarse post
    if (!az) {
      const a = this._heightAt(x0, z), b = this._heightAt(x0 + cs, z);
      return a + (b - a) * tx;
    }
    if (!ax) {
      const a = this._heightAt(x, z0), b = this._heightAt(x, z0 + cs);
      return a + (b - a) * tz;
    }
    // Not bilinear: the coarse ring rasterises triangles, and every quad in
    // _makeLevel is split (a, c, b) / (b, c, d) — i.e. along the b–c
    // anti-diagonal. Matching the split exactly is what makes the morphed
    // boundary agree to the centimetre instead of to the sag of the quad.
    const h10 = this._heightAt(x0 + cs, z0), h01 = this._heightAt(x0, z0 + cs);
    if (tx + tz <= 1) {
      const h00 = this._heightAt(x0, z0);
      return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
    }
    const h11 = this._heightAt(x0 + cs, z0 + cs);
    return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
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
      //
      // The slope MUST NOT come from this ring's own gradient. Out here the
      // rings are 64–128 m and their vertex-to-vertex gradient is noisy, so a
      // threshold on it flips rock/snow between adjacent rows — which renders
      // as horizontal dark stripes banded across every distant ridge (each row
      // is only a few pixels tall at 2 km). Sampling the far-field height LUT
      // at a fixed 24 m scale gives a classification that is a property of the
      // mountain rather than of whichever LOD ring happens to be drawing it.
      e = 0.5;
      const eps = 24;
      const hx = (this._heightAt(x + eps, z) - this._heightAt(x - eps, z)) / (2 * eps);
      const hz = (this._heightAt(x, z + eps) - this._heightAt(x, z - eps)) / (2 * eps);
      const sDeg = Math.atan(Math.hypot(hx, hz)) / DEG;
      // Deep-winter identity: ranges snow-clad to the crests, rock only on
      // unholdable faces. Two thresholds: 44° nearby, easing to 38° on the
      // range wall — partly because real far walls show rock on their steep
      // flutes, and partly practical: the snow textures are XZ-planar and
      // smear into vertical streaks on steep faces, while the rock path uses
      // a wall-friendly projection.
      const r2 = Math.hypot(x, z);
      const thresh = lerp(44, 38, smoothstep(4000, 9000, r2));
      rb = clamp01((sDeg - thresh) / 13);
      id = rb > 0.5 ? S_ROCK : S_WINDPACK;
    }

    // Pack the class index into snowMaterial's documented vec4 layout
    // (groomed, windpack, ice, snowCover). Rock is the *absence* of cover
    // rather than a fifth weight, so the shader's generic default (0,0,0,1)
    // still means "deep powder". Cover fades with settled depth and with the
    // terrain's own rock blend, which is what turns the snow/rock boundary
    // into a drift-shaped gradient instead of a razor edge.
    const so = vi * 4;
    attrs.aSurface[so] = id === S_GROOMED ? 1 : 0;
    attrs.aSurface[so + 1] = id === S_WINDPACK ? 1 : 0;
    attrs.aSurface[so + 2] = id === S_ICE ? 1 : 0;
    const cover = smoothstep(0.06, 0.45, d) * (1 - rb);
    attrs.aSurface[so + 3] = id === S_ROCK ? Math.min(cover, 0.25) : cover;
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
  _micro(x, z, step = 0) {
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
      // The sastrugi carrier is λ 1.9 m. A ring whose posts are wider than
      // λ/4 cannot carry it — it renders it as a post-to-post comb instead —
      // so the carrier is faded out by ring spacing. Past the 1 m ring it is
      // gone, which is also what §11 tell 16 asks for: sastrugi at 800 m
      // subtends 0.02° and must not be manufacturing contrast out there.
      const lim = step > 0 ? clamp01((1.9 / step - 2.6) / 1.4) : 1;
      if (lim <= 0) return 0;
      const p = u / 1.9 + jitter * 0.55;
      const s = p - Math.floor(p);
      // Steep rise (upwind face), long gentle tail — smoothed at both ends so
      // the sawtooth's harmonic tail has nothing left to fold.
      const prof = s < 0.22 ? smoothstep(0, 0.22, s) : 1 - smoothstep(0.22, 1, s);
      const amp = Math.min(MICRO_CAP, (0.05 + 0.30 * e) * CONFIG.snow.sastrugiStrength * 0.5);
      return (prof - 0.5) * 2 * amp * lim;
    }
    // Powder / drifted ground: soft ripple only, λ 6.2 m along wind and 10 m
    // across it, faded the same way once the ring can no longer resolve it.
    const limP = step > 0 ? clamp01((6.2 / step - 2.6) / 1.4) : 1;
    return this.simMicro.noise2D(u * 0.16, v * 0.10) * MICRO_CAP * 0.35 * limP;
  }

  /**
   * Distant backdrop shell: a polar annulus from the edge of the clipmap out
   * to CONFIG.terrain.backdropRadius, carrying the real Otago skyline. The
   * playable box must never end in a visible cliff at the horizon.
   */
  _makeBackdrop() {
    const R0 = BACKDROP_INNER, R1 = CONFIG.terrain.backdropRadius;
    // Angular resolution is the silhouette's resolution. At 192 segments the
    // post spacing at r = 22 km is 720 m — about seven posts across the whole
    // Remarkables massif, which cannot carry a serrated crest no matter what
    // the height function does. The outer band therefore runs at 768 segments;
    // the inner rings do not need it and the two resolutions are stitched with
    // a 1:4 triangle fan.
    //
    // RADIAL spacing is the wall's resolution, and pure log growth is wrong
    // for it: forty log rings put thirty inside 8 km and left 2–4 km radial
    // gaps across the 8–26 km band — the entire range wall was two or three
    // sample rings with kilometres of stretched interpolation between them,
    // which is exactly the "featureless ice curtain" the user called out.
    // Log spacing inside 8 km (the seam band needs it), then fixed 450 m
    // rings across the wall so every ridge row gets real geometry.
    const AN_NEAR = 192, AN_FAR = 768, FAR_R = 8000;
    const WALL_STEP = 450;
    const RN_LOG = 22;
    const radii = [];
    const growth = Math.pow(FAR_R / R0, 1 / RN_LOG);
    for (let k = 0; k <= RN_LOG; k++) radii.push(R0 * Math.pow(growth, k));
    for (let r = FAR_R + WALL_STEP; r < R1; r += WALL_STEP) radii.push(r);
    radii.push(R1);
    const RN = radii.length - 1;
    const rings = RN + 2;                       // +1 outer, +1 skirt
    radii.push(R1);                              // duplicated for the skirt

    const ans = radii.map((r) => (r >= FAR_R ? AN_FAR : AN_NEAR));
    ans[rings - 1] = ans[rings - 2];             // the skirt matches its ring
    const offs = new Int32Array(rings);
    let total = 0;
    for (let k = 0; k < rings; k++) { offs[k] = total; total += ans[k] + 1; }

    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const col = new Float32Array(total * 3);
    const aSurface = new Float32Array(total * 4);
    const aDepth = new Float32Array(total);
    const aRoughness = new Float32Array(total);
    const aExposure = new Float32Array(total);
    const aCurvature = new Float32Array(total);
    const aRock = new Float32Array(total);
    const attrs = { pos, nor, uv, col, aSurface, aDepth, aRoughness, aExposure, aCurvature, aRock };

    const invSize = 1 / this.size;
    for (let k = 0; k < rings; k++) {
      const r = radii[k];
      const skirt = k === rings - 1;
      const AN = ans[k];
      for (let a = 0; a <= AN; a++) {
        const t = (a / AN) * Math.PI * 2;
        const x = Math.cos(t) * r, z = Math.sin(t) * r;
        const vi = offs[k] + a;
        let y = this._heightAt(x, z) - BACKDROP_SINK;
        if (skirt) y -= 1500;                    // drop the rim below the horizon
        // Anti-aliased like the clipmap rings, but analytically: the box-mip
        // pyramid only covers the playable box, and sampling it edge-clamped
        // from 2–22 km out (an earlier revision did) returns the box-border
        // gradient for every backdrop vertex — the whole range wall shaded as
        // one flat streak. Wide central differences of the analytic far field
        // at the ring's own spacing are the correct low-pass out here.
        // eps from the ANGULAR post spacing only: the log-spaced radial gaps
        // reach 2 km at 15 km out, and smoothing gradients over that erases
        // the 900 m avalanche flutes the angular posts can perfectly resolve.
        const spacing = Math.max(8, r * (Math.PI * 2 / AN));
        // Floor at 120 m: sub-post eps turns the amplified far relief into
        // per-post normal jitter that shades as vertical prism columns.
        const eps = Math.max(120, spacing * 0.6);
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
      const a0 = ans[k], a1 = ans[k + 1];
      const o0 = offs[k], o1 = offs[k + 1];
      if (a1 === a0) {
        for (let a = 0; a < a0; a++) {
          const A = o0 + a, B = A + 1;
          const C = o1 + a, D = C + 1;
          idx.push(A, C, B, B, C, D);
        }
      } else {
        // 1 : rep resolution step — fan the coarse inner edge onto the fine
        // outer one. Same winding as the uniform case (outward, then CCW).
        const rep = a1 / a0;
        for (let a = 0; a < a0; a++) {
          const A = o0 + a, B = A + 1;
          const c = o1 + a * rep;
          for (let q = 0; q < rep; q++) idx.push(A, c + q, c + q + 1);
          idx.push(A, c + rep, B);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSurface', new THREE.BufferAttribute(aSurface, 4));
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
   * Signed foliation displacement for a point on a rock face.
   *
   * Every schist surface in the basin shares one foliation plane (§2.13:
   * strike +38° from +X, dip 32°), so the fracture relief must be *banded
   * against that plane*, not isotropic noise. Wavelengths are stacked; the
   * phase of each is jittered along strike so the result is irregular layering
   * rather than a mechanical comb, exactly as the rock material's own normal
   * banding does at texture scale.
   *
   * `minLam` is the shortest wavelength the *consumer's* sample grid can carry.
   * This is not a nicety: displacing a 0.5 m row grid with a λ 0.6 m and a
   * λ 0.15 m band gives 1.2 and 0.3 samples per wavelength, and what comes out
   * is not fine relief, it is an exact row-alternating in/out comb. Every
   * second row then gets an inverted facet normal, `aSurface.w` flips with it,
   * and the face renders as a venetian blind of white and dark-blue stripes.
   * Bands under the limit are faded out here rather than clamped at the call
   * site, so no consumer can reintroduce the artefact by accident.
   *
   * `lam` is metres between plates, `amp` is the peak-to-peak displacement.
   */
  _foliationRelief(x, y, z, minLam = 0) {
    const f = this._folBasis;
    const sim = this.simFine;
    const c0 = x * f.nx + y * f.ny + z * f.nz;      // distance along the normal
    const a0 = x * f.sx + z * f.sz;                 // distance along strike
    let d = 0;
    for (let i = 0; i < f.bands.length; i++) {
      const [lam, amp, ph] = f.bands[i];
      const w = minLam > 0 ? smoothstep(minLam * 0.85, minLam * 1.35, lam) : 1;
      if (w <= 0.001) continue;
      const jit = sim.noise2D(a0 / (lam * 7) + ph, c0 / (lam * 11));

      // Cross-jointing. Schist faces are cut by joint sets roughly normal to
      // the bedding, and the plates *step* across them: a plate does not run
      // unbroken along a 300 m frontage, it is offset every few metres by a
      // fracture. Without this the bands are perfectly parallel and perfectly
      // continuous, which is precisely the venetian-blind read - and it is a
      // read the sampling limit cannot explain, because at 3.8 m the band sits
      // at 7.6 samples per wavelength, well inside the grid. The artefact was
      // never aliasing; the model was simply too regular to be rock.
      const jSeed = Math.floor(a0 / 7.5 + sim.noise2D(a0 / 23, c0 / 31) * 1.6);
      const jOff = sim.noise2D(jSeed * 13.7 + ph, 4.2) * 0.5;

      // Bed thickness is not constant either. Modulating amplitude over ~17 m
      // means some plates stand proud, some are nearly flush, and the eye
      // stops finding a period in them.
      const ampMod = 0.55 + 0.45 * sim.noise2D(a0 / 17 + ph, c0 / 19);

      const s = c0 / lam + jit * 0.5 + jOff;
      const fr = s - Math.floor(s);
      // Sharp lip, sloping back: plates break, they do not undulate. C1 at
      // both ends of the cycle — a raw sawtooth's harmonic tail aliases
      // through the sample grid even when its fundamental does not.
      const tri = fr < FOL_LIP
        ? smoothstep(0, FOL_LIP, fr)
        : 1 - smoothstep(FOL_LIP, 1, fr);
      d += (tri - 0.5) * amp * w * ampMod;
    }
    return d;
  }

  /**
   * Bluff faces as explicit rock geometry (§2.5 mid bluff band: 6–22 m step,
   * 55–80° face, the map's "air it or go around" feature).
   *
   * The heightfield already carries the step, but a 55–80° face smoothed
   * across 2 m posts reads as a white ramp. The previous strip built one quad
   * every 3 m with a single hand-written normal, which is why the frame shows
   * flat straight-sided plates with a stair-stepped upper break, no thickness
   * and no lit face: four vertices of vertical resolution and one constant
   * normal cannot be anything else.
   *
   * So: subdivide to 0.5 m vertically, displace along the face normal with the
   * shared foliation model, derive the normals from the displaced surface, and
   * tag every up-facing micro-facet as snow-holding through `aSurface.w` —
   * which is what produces the "every ledge holds snow" read and breaks the
   * flat-plate silhouette.
   *
   * The displacement is band-limited to what this grid can carry. `MIN_LAM`
   * below is 4× the largest step either grid axis takes *along the foliation
   * normal*, and the frontage axis is the binding one: the foliation normal
   * has a horizontal component of 0.53, so a column step of `c` advances up to
   * 0.53·c of `c0` against 0.5 m per row. At the old 2 m columns that put the
   * limit at 4.2 m; the columns are 1.25 m now, which brings it to 2.65 m and
   * lets the 3.8 m band through with margin. Under the limit the relief does
   * not become fine detail, it becomes the venetian-blind comb — see
   * `_foliationRelief`.
   */
  _makeBluffFaces() {
    // Shared foliation basis (§2.13). Plane normal = strike × dip.
    const STRIKE = 38 * DEG, DIP = 32 * DEG;
    const sx = Math.cos(STRIKE), sz = Math.sin(STRIKE);
    const fnx = -sz * Math.sin(DIP), fny = Math.cos(DIP), fnz = sx * Math.sin(DIP);
    this._folBasis = {
      sx, sz,
      nx: fnx, ny: fny, nz: fnz,
      // λ (m), peak-to-peak displacement (m), phase. Only the first band is
      // above the geometry's sampling limit; the 0.6 m and 0.15 m plate
      // spacings are real, but they belong to the rock material's per-pixel
      // foliation (snowMaterial.createRockMaterial, `uFoliationSpacing`),
      // where they are evaluated at pixel rate and mip-filtered. Left in the
      // table so the model stays complete — `_foliationRelief` fades them.
      bands: [[3.8, 0.30, 0], [0.6, 0.20, 13.7], [0.15, 0.07, 31.1]],
    };

    const COL_STEP = 1.25;    // metres along the bluff frontage
    const ROW_STEP = 0.5;     // metres down the face — the whole point
    // Worst-case advance along the foliation normal per grid step, ×4.
    const nHoriz = Math.hypot(fnx, fnz);
    const MIN_LAM = 4 * Math.max(ROW_STEP, COL_STEP * nHoriz);

    const verts = [], uvs = [], idx = [];
    // Row index / row count / undisplaced face-normal Y, per vertex — needed
    // by the ledge mask below, which must be low-passed down the face.
    const vRow = [], vRows = [], vBaseNy = [];

    for (const b of this.features.bluffs) {
      const faceW0 = b.height / Math.tan(b.faceAngle);
      const cols = Math.max(2, Math.round(b.length / COL_STEP));
      // One row count for the whole segment keeps the grid rectangular; the
      // face length is the true down-dip run, not the vertical drop.
      const rows = clamp(Math.round(Math.hypot(faceW0 + 1.2, b.height + 0.6) / ROW_STEP), 6, 72);
      const colFirst = new Int32Array(cols + 1).fill(-1);

      for (let c = 0; c <= cols; c++) {
        const sArc = (c / cols) * b.length;
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
        if (along < 0.12) continue;
        // The heightfield tapers the step by `along` at both ends, so the face
        // width has to taper with it. Holding faceW fixed while the drop dies
        // away is what turned the last 55 m of every segment into a 40° ramp
        // wearing a rock material.
        const faceW = faceW0 * along;

        // The break line meanders and the buttresses vary in stand-off: a
        // dead-straight top edge sampled on 2 m posts is what stair-steps.
        // Both wobbles are smooth noise at λ ≥ 9 m — i.e. ≥ 7 columns. The old
        // λ 5.5 m term and, worse, the old per-column `rng.range()` on the
        // bottom edge were white noise on the column axis: each column got an
        // independent face width, which tilts each strip differently and
        // stripes the frontage vertically.
        const wobT = this.simFine.noise2D(px / 21 + 4.3, pz / 21 - 8.1) * 0.6
          + this.simFine.noise2D(px / 9.0, pz / 9.0) * 0.25;
        const wobB = 0.1 + this.simFine.noise2D(px / 12.5 + 21.7, pz / 12.5 - 4.2) * 0.4
          + this.simFine.noise2D(px / 17 - 2.7, pz / 17 + 5.9) * 0.9;

        const topX = px + perpX * (faceW * 0.5 + 0.35 + wobT);
        const topZ = pz + perpZ * (faceW * 0.5 + 0.35 + wobT);
        const botX = px - perpX * (faceW * 0.5 + 0.8 + wobB);
        const botZ = pz - perpZ * (faceW * 0.5 + 0.8 + wobB);
        const topY = this.getHeight(topX, topZ) + 0.25;
        const botY = this.getHeight(botX, botZ) - 0.35;

        // Outward (downhill) face normal, used as the displacement direction.
        let ox = -perpX, oy = 0.22, oz = -perpZ;
        const oL = Math.hypot(ox, oy, oz) || 1;
        ox /= oL; oy /= oL; oz /= oL;

        // Undisplaced face normal: its Y is the horizontal fraction of the
        // down-face direction, i.e. cos(face angle as actually built). Every
        // segment has its own face angle (58–78°), so the ledge mask below has
        // to be measured *relative* to this, not against an absolute n.y.
        const runH = Math.hypot(topX - botX, topZ - botZ);
        const runL = Math.hypot(runH, topY - botY) || 1;
        const baseNy = runH / runL;

        colFirst[c] = verts.length / 3;
        for (let r = 0; r <= rows; r++) {
          const v = r / rows;
          const x = lerp(topX, botX, v);
          const y = lerp(topY, botY, v);
          const z = lerp(topZ, botZ, v);
          // Ease the relief off at the very top and bottom so the face still
          // meets the heightfield, and taper it out at the segment ends.
          const edge = Math.min(1, Math.min(v, 1 - v) * rows * 0.25 + 0.35);
          const k = this._foliationRelief(x, y, z, MIN_LAM) * edge * (0.45 + 0.55 * along);
          verts.push(x + ox * k, y + oy * k, z + oz * k);
          uvs.push(sArc * 0.25, 1 - v);
          vRow.push(r); vRows.push(rows); vBaseNy.push(baseNy);
        }
      }

      for (let c = 0; c < cols; c++) {
        const A = colFirst[c], B = colFirst[c + 1];
        if (A < 0 || B < 0) continue;
        for (let r = 0; r < rows; r++) {
          const a = A + r, d = B + r;
          // Wound so the geometric normal points *downhill*, out of the face.
          // The old strip wound the other way, which put the front face into
          // the hillside — back-face culled from every camera that can see the
          // bluff, and lit by a normal aimed away from the sun on top of that.
          idx.push(a, d, a + 1, d, d + 1, a + 1);
        }
      }
    }
    if (!idx.length) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(idx.length > 65535
      ? new THREE.BufferAttribute(new Uint32Array(idx), 1)
      : new THREE.BufferAttribute(new Uint16Array(idx), 1));
    // Normals from the *displaced* surface, not from the heightfield: this is
    // what gives a 70° face its faceting and its lit/unlit sides.
    geo.computeVertexNormals();

    // Ledge-snow mask. The rock shader already holds snow on any facet with a
    // high enough perturbed normal; aSurface.w biases its accumulation, so
    // every up-facing plate ends up capped and the face stops reading as one
    // uniform dark plane.
    //
    // Two rules, both learned the hard way. (1) Measure the *relative* up-tilt
    // against the column's own undisplaced face normal — an absolute threshold
    // caps a 58° segment entirely and a 78° one not at all. (2) Low-pass the
    // normal down the face first. This mask is a hard switch between white
    // snow and dark schist, so any row-to-row wobble in the normal it reads
    // becomes a row-to-row wobble between white and dark — a three-post
    // tremor in the geometry turns into a 120-level swing on screen.
    const nAttr = geo.getAttribute('normal');
    const vCount = nAttr.count;
    const aSurface = new Float32Array(vCount * 4);
    // A 5-tap [1,2,3,2,1] triangle: zero response at the row-alternating
    // frequency and 0.85 at the 9.5-row plate period, so it deletes the comb
    // band outright and leaves the plates alone.
    const TAP = [1, 2, 3, 2, 1];
    for (let i = 0; i < vCount; i++) {
      const r = vRow[i], rr = vRows[i];
      let sum = 0, w = 0;
      for (let q = -2; q <= 2; q++) {
        const rq = r + q;
        if (rq < 0 || rq > rr) continue;
        sum += nAttr.getY(i + q) * TAP[q + 2]; w += TAP[q + 2];
      }
      // Band chosen by measurement, not taste: mean mask 0.13 with a
      // row-alternating component of 0.058 rms. Widening it to a mean of 0.23
      // takes the alternating component to 0.082, i.e. straight back toward
      // the stripes — the mask is a hard white/dark switch, so its high
      // frequencies cost far more than its mean does.
      aSurface[i * 4 + 3] = smoothstep(0.015, 0.19, sum / w - vBaseNy[i]);
    }
    geo.setAttribute('aSurface', new THREE.BufferAttribute(aSurface, 4));

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
