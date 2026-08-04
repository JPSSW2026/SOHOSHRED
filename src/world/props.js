/**
 * Soho Shred — procedural set dressing.
 *
 * An unbroken white slope has no image in it: a 2 m wind lip and a 200 m ridge
 * are the same shape, so without props the viewer cannot size the mountain and
 * the frame reads as a maquette (docs/ART_DIRECTION.md §9). We also have **no
 * trees** — the Otago block ranges are functionally treeless above 1,050 m —
 * so the entire silhouette budget that a European or North-American reference
 * frame spends on conifers has to be carried here instead.
 *
 * What this module puts on the mountain, and why:
 *
 *   • **Schist tors and outcrops.** The signature Otago landform: residual
 *     knobs of unweathered greenschist left standing when periglacial soil
 *     creep stripped the regolith. Built as stacks of tabular slabs cut by
 *     parallel planes at one globally consistent foliation (plan strike +38°
 *     from +X, dip 32°) — randomly-oriented boulders read as fake instantly.
 *   • **Bluff-band rubble.** Blocky teeth along the crest of each bluff and a
 *     talus apron at its toe, so the terrain's bluff strip does not end in a
 *     clean geometric edge.
 *   • **Snow drifts.** Every rock gets an elongated drift collar on its lee
 *     side and a wind-scoured gap upwind, because an object sitting *on* the
 *     surface like a decal is one of the named tells (§11.23).
 *   • **Cornice lips.** A heightfield cannot overhang, so the crest cornice
 *     and the spur-crest drift lips are thin overhanging ribbons built here —
 *     with a genuine undercut, which is where the transport-blue lives.
 *   • **Bamboo marker poles with orange flags** along the groomed corridors
 *     and the benched traverses. Hugely evocative of a real NZ ski field, and
 *     the single cheapest unambiguous scale reference we have.
 *   • **Rope-and-pole boundary fence** and **orange hazard netting** above the
 *     bluff bands.
 *   • **Snow tussock** (*Chionochloa rigida*) in the wind-scoured run-out
 *     margins, wind-animated in the vertex shader, with a backlit rim — our
 *     only saturated natural colour against the white field.
 *   • **Avalanche debris** below the couloir mouths and the bluff gaps.
 *   • **A chairlift line** — 14 towers, catenary haul rope, moving chairs and
 *     two terminals — modelled on the real Soho Express (379 m rise over
 *     1,318 m of slope length).
 *
 * Everything is placed by querying `ctx.terrain.sample()` for height, slope,
 * curvature, snow depth, wind exposure and surface class, and distributed with
 * a variable-radius Poisson-disc (Bridson) so clusters look geological rather
 * than uniform. Nothing calls `Math.random()`; every roll comes from
 * `makeRng(seedFromString(...))` so two builds of the same seed are identical.
 *
 * Budget (all figures for the shipped tuning):
 *   ~600 rock instances · ~700 poles · ~7k tussock clumps · ~600 debris lumps
 *   14 towers · 33 chairs. Typically 14–22 draw calls on screen, and every
 *   instanced field drops its LOD and then culls on projected angular size, so
 *   the far field costs almost nothing.
 *
 * Contract: docs/ARCHITECTURE.md. Art direction: docs/ART_DIRECTION.md §6, §9.
 * Terrain coordinates and feature register: docs/TERRAIN_BRIEF.md §2.5, §2.13.
 */

import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import {
  makeRng, seedFromString, Simplex,
  clamp, clamp01, lerp, smoothstep,
} from '../core/rng.js';
import {
  createRockMaterial,
  createSnowMaterial,
  updateSnowMaterial,
  TRUE_NORTH_BEARING_OF_MINUS_Z,
} from './snowMaterial.js';

/* ==========================================================================
 * 0.  CONSTANTS — kept in lock-step with terrain.js / TERRAIN_BRIEF §2.4
 * ======================================================================== */

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/** Cirque focus; every radial feature (crest arc, headwall base) is about it. */
const FOCUS_X = 0;
const FOCUS_Z = 240;
/** Headwall crest arc radius, and the headwall base (couloir mouth) arc. */
const CREST_R = 640;
const BASE_R = 460;

/** One foliation plane for the whole basin (TERRAIN_BRIEF §2.5, §2.13). */
const FOLIATION_STRIKE = 38 * DEG;
const FOLIATION_DIP = 32 * DEG;

/** Unit horizontal direction in game space for a true compass bearing. */
function dirFromBearing(bearingDeg, out = new THREE.Vector3()) {
  const t = (bearingDeg - TRUE_NORTH_BEARING_OF_MINUS_Z) * DEG;
  return out.set(Math.sin(t), 0, -Math.cos(t));
}

/**
 * Y rotation that maps the local +X axis onto the world plan direction
 * (dx, dz). Three's R_y(a) sends +X to (cos a, 0, −sin a).
 */
const yawForXAxis = (dx, dz) => Math.atan2(-dz, dx);

/** Default tuning. Overridable via `CONFIG.props` (our own subtree only). */
const DEFAULT_TUNE = {
  enabled: true,
  /** Global multiplier on every instance budget — the harness can thin us. */
  density: 1.0,
  rock: {
    /**
     * Fewer, larger, more legible masses. Round 6 shipped 300 outcrops +
     * 240 plates + 260 talus into a frame where the wide presets stand
     * 300–600 m off, and at that range they all collapse onto the same 2–4 px
     * footprint: the measured read on `shots/r6/west-spur.png` is "dozens of
     * near-identical rectangles confettied across the ridge". A schist tor
     * field is a handful of legible masses with a scatter of shed plates
     * *around* them, not a uniform sprinkle (§6.1, checklist 31/32).
     */
    // The user's Soho chairlift video is categorical: a real crest view
    // carries a HANDFUL of outcrop clusters - low, blocky, wider than
    // tall, heavily snow-draped - not rows of scatter. Dense vertical
    // stubs along the ridges read as TREES in demo v6, and Cardrona is
    // fully alpine: nothing up here may ever read as a tree.
    scatterLimit: 42,    // free-standing outcrops on rock-classed ground
    blockLimit: 34,      // crest blockfield plates
    talusLimit: 48,      // bluff toe apron + bluff crest teeth
    driftCollars: true,
  },
  poles: {
    corridorSpacing: 21, // m between marker poles down a corridor edge
    trackSpacing: 24,    // m between poles along a benched traverse
    limit: 760,
  },
  fence: {
    /** §: posts every 4–6 m. At 5 m and 320 m range they resolve as a comb. */
    postSpacing: 5.0,
    /** Net hangs *below* the post tops so the comb of posts breaks the line. */
    netHeight: 0.95,
    postHeight: 1.85,
    limit: 720,
  },
  tussock: {
    /**
     * §2 names tussock "our single most valuable natural colour accent" and
     * the direct substitute for the reference set's autumn trees, and rounds
     * 1–6 all measured warm high-chroma at 0.00–0.13% against a 1.5–4% target.
     * The cause was never the budget or the cull distance — it was the gate.
     *
     * Two independent rules were each individually fatal:
     *
     *   • `surface === 'rock'` was rejected outright, and `terrain.js`
     *     classifies *every* post with under 10 cm of pack as `rock`
     *     (terrain.js:1874). That is 6.2% of the basin — precisely the
     *     wind-scoured ground §6.2 puts tussock on — and it was the first
     *     thing thrown away.
     *   • `maxElevation 1560` confines the belt to the run-out margins. The
     *     basin runs 1410–1865 m and the wide presets frame 1500–1800 m.
     *
     * Measured on the shipped seed, the old gate passed 1.18% of the basin
     * (0.68% inside the hero-basin framing); the gate below passes 4.35%
     * (2.4% inside hero-basin, 20% inside west-spur's run-out foreground).
     */
    limit: 10000,
    patches: 300,
    chunk: 240,          // m; one InstancedMesh per chunk
    maxElevation: 1580,  // TERRAIN_BRIEF §2.13 — the tussock belt proper
    maxDepth: 0.34,
    maxSlopeDeg: 26,
    /**
     * What "wind-scoured" means, operationally. Any one of these is enough:
     * a thin pack, a high upwind-shelter index, or a convex shoulder. §6.2
     * asks for "convex ridge shoulders and the windward side of outcrops" and
     * these are the three channels `terrain.sample()` gives us to find them.
     */
    scourDepth: 0.30,
    scourExposure: 0.40,
    scourCurvature: 0.10,
    /**
     * Above the tussock belt the vegetation is *Raoulia* cushionfield and
     * *Aciphylla* speargrass (TERRAIN_BRIEF §2.13 item 6), not *Chionochloa* —
     * so this tier exists, but only on scoured ground, shorter, sparser, and
     * pulled a little off gold. It is what puts a warm accent on the spur
     * crests and the crest plateau the wide shots actually point at.
     */
    fellfieldMaxElevation: 1845,
    fellfieldMaxDepth: 0.24,
    fellfieldFrac: 0.55,
    /**
     * A clump is sub-pixel at 700 m but a *patch* of them is not, and the
     * patch is the accent — so the far-field thinning floor is 0.35, not the
     * 0.08 that deleted the accent from exactly the wide frames that needed
     * it, and the cull is past the far side of every preset's framing.
     */
    near: 150, far: 600, cull: 900, minFrac: 0.50,
  },
  debris: { limit: 620 },
  lift: { towers: 14, chairSpacing: 42, chairSpeed: 5.0 },
  /** Camera travel (m) that forces an instanced-LOD reshuffle. */
  lodEpsilon: 16,
  lodMaxFrames: 45,
};

function mergeTune(dst, src) {
  if (!src) return dst;
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof dst[k] === 'object') {
      mergeTune(dst[k], v);
    } else if (v !== undefined) {
      dst[k] = v;
    }
  }
  return dst;
}

/* ==========================================================================
 * 1.  TERRAIN PROBE
 *
 * props.js is constructed after terrain.js and built after it, but the
 * placeholder-tolerance rule in ARCHITECTURE.md means we must survive a
 * `ctx.terrain` that is a stub, half-built, or missing outright. Every query
 * goes through here and every query has a defensible fallback, so a broken
 * terrain costs us set dressing quality, never a boot failure.
 * ======================================================================== */

/** The feature register we fall back to (TERRAIN_BRIEF §2.5 coordinates). */
function fallbackFeatures() {
  const poly = (pts) => ({ pts });
  return {
    spawns: { 'broadway-gate': { x: 140, z: 960, heading: Math.PI } },
    torClusters: [],
    cornice: [
      { phi0: -44 * DEG, phi1: -30 * DEG, lip: 2.6 },
      { phi0: -22 * DEG, phi1: -4 * DEG, lip: 3.1 },
      { phi0: 5 * DEG, phi1: 18 * DEG, lip: 2.2 },
      { phi0: 27 * DEG, phi1: 41 * DEG, lip: 2.8 },
    ],
    gullies: [
      { name: 'organ-pipes-w', phi: -31.5 * DEG },
      { name: 'organ-pipes-e', phi: -18.5 * DEG },
      { name: 'broadway', phi: 1.5 * DEG },
      { name: 'soho-chute', phi: 22.5 * DEG },
    ],
    spurs: [
      poly([[-560, 560], [-640, 210], [-720, -180], [-790, -450], [-820, -700]]),
      poly([[600, 640], [660, 300], [740, -40], [830, -360], [880, -620]]),
    ],
    bluffs: [
      { pts: [[-560, -170], [-430, -200], [-300, -165]], height: 14 },
      { pts: [[-140, -195], [-80, -160], [-20, -185]], height: 11 },
      { pts: [[300, -175], [410, -205], [520, -170]], height: 16 },
    ],
    tracks: [
      { name: 'crest-traverse', pts: [[-700, 900], [0, 908], [700, 900]], halfWidth: 2.5 },
      { name: 'mid-traverse', pts: [[880, 40], [420, 120], [-60, 190], [-460, 235], [-760, 260]], halfWidth: 3.0 },
      { name: 'home-track', pts: [[-820, -480], [-380, -560], [80, -650], [420, -720], [700, -760]], halfWidth: 3.0 },
    ],
    corridors: [
      { name: 'broadway', halfWidth: 21, pts: [[240, 680], [180, 420], [60, 120], [140, -180], [280, -520], [330, -700]] },
      { name: 'main-street', halfWidth: 24, pts: [[-100, 560], [-260, 200], [-340, -120], [-480, -430], [-300, -700], [-140, -860]] },
      { name: 'east-side', halfWidth: 18, pts: [[520, 560], [620, 200], [560, -200], [400, -520], [420, -700]] },
    ],
    lift: {
      base: { x: 320, z: -560 }, top: { x: 240, z: 700 },
      towers: 14, corridorHalfWidth: 20,
    },
  };
}

class TerrainProbe {
  constructor(ctx) {
    this.ctx = ctx;
    const t = ctx && ctx.terrain;
    this.t = (t && typeof t.getHeight === 'function') ? t : null;
    this.hasSample = !!(this.t && typeof this.t.sample === 'function');
    this.bounds = (this.t && this.t.bounds) || { minX: -1024, maxX: 1024, minZ: -1024, maxZ: 1024 };
    this._out = {
      height: 1500, normal: new THREE.Vector3(0, 1, 0), slope: 0,
      surface: 'powder', roughness: 0.3, depth: 1.2, curvature: 0, exposure: 0.2,
    };
    let f = null;
    try { f = this.t && typeof this.t.getFeatures === 'function' ? this.t.getFeatures() : null; } catch (e) { f = null; }
    this.features = f && f.corridors ? f : fallbackFeatures();
    // A stub terrain still needs a plausible ground plane so nothing floats.
    this._fallbackSlope = 18 * DEG;
  }

  /** Metres. Falls back to the brief's mean 18° centreline gradient. */
  height(x, z) {
    if (this.t) {
      const h = this.t.getHeight(x, z);
      if (Number.isFinite(h)) return h;
    }
    return clamp(1640 - z * 0.325, 1400, 1870);
  }

  normal(x, z, out = new THREE.Vector3()) {
    if (this.t && typeof this.t.getNormal === 'function') {
      const n = this.t.getNormal(x, z, out);
      if (n && Number.isFinite(n.y)) return n;
    }
    const e = 2;
    const hx = (this.height(x + e, z) - this.height(x - e, z)) / (2 * e);
    const hz = (this.height(x, z + e) - this.height(x, z - e)) / (2 * e);
    return out.set(-hx, 1, -hz).normalize();
  }

  /**
   * Combined query. The returned object is reused — copy anything you keep.
   * Always complete: missing terrain channels are synthesised from the height
   * field so downstream placement rules never see `undefined`.
   */
  sample(x, z) {
    const o = this._out;
    if (this.hasSample) {
      const s = this.t.sample(x, z);
      o.height = Number.isFinite(s.height) ? s.height : this.height(x, z);
      if (s.normal) o.normal.copy(s.normal); else this.normal(x, z, o.normal);
      o.slope = Number.isFinite(s.slope) ? s.slope : Math.acos(clamp(o.normal.y, -1, 1));
      o.surface = s.surface || 'powder';
      o.roughness = Number.isFinite(s.roughness) ? s.roughness : 0.3;
      o.depth = Number.isFinite(s.depth) ? s.depth : 1.2;
      o.curvature = Number.isFinite(s.curvature) ? s.curvature : 0;
      o.exposure = Number.isFinite(s.exposure) ? s.exposure : 0.2;
      return o;
    }
    o.height = this.height(x, z);
    this.normal(x, z, o.normal);
    o.slope = Math.acos(clamp(o.normal.y, -1, 1));
    o.surface = 'powder';
    o.roughness = 0.3;
    o.depth = 1.2;
    o.curvature = 0;
    o.exposure = 0.2;
    return o;
  }
}

/* ==========================================================================
 * 2.  SCATTER — variable-radius Poisson disc
 *
 * Uniform random scatter reads as noise; a regular grid reads as a plantation.
 * Bridson's dart-throwing gives blue noise (an even *minimum* spacing with an
 * irregular arrangement), and letting the radius vary with a density field
 * turns that into clustering: tors bunch on the scoured crest and thin out
 * across the loaded bowl exactly as they do on the real range.
 *
 * The accept mask is usually disconnected (rock outcrops are islands), so the
 * sampler re-seeds whenever the active front dies rather than stopping — a
 * single-seed Bridson would fill one outcrop and ignore the other thirty.
 * ======================================================================== */

function poissonScatter(rng, opts) {
  const minX = opts.minX, maxX = opts.maxX, minZ = opts.minZ, maxZ = opts.maxZ;
  const rMin = Math.max(0.5, opts.rMin);
  const rMax = Math.max(rMin, opts.rMax ?? rMin);
  const radiusAt = opts.radiusAt || (() => rMin);
  const accept = opts.accept || (() => true);
  const k = opts.k ?? 10;
  const limit = opts.limit ?? 2000;
  const seedBudget = opts.seedBudget ?? 6000;

  const cell = rMin / Math.SQRT2;
  const gw = Math.max(1, Math.ceil((maxX - minX) / cell));
  const gh = Math.max(1, Math.ceil((maxZ - minZ) / cell));
  const grid = new Int32Array(gw * gh).fill(-1);
  const span = Math.ceil(rMax / cell) + 1;

  const px = [], pz = [], pr = [];
  const active = [];

  const fits = (x, z, r) => {
    const gx = ((x - minX) / cell) | 0;
    const gz = ((z - minZ) / cell) | 0;
    if (gx < 0 || gz < 0 || gx >= gw || gz >= gh) return false;
    const j0 = Math.max(0, gz - span), j1 = Math.min(gh - 1, gz + span);
    const i0 = Math.max(0, gx - span), i1 = Math.min(gw - 1, gx + span);
    for (let j = j0; j <= j1; j++) {
      const row = j * gw;
      for (let i = i0; i <= i1; i++) {
        const id = grid[row + i];
        if (id < 0) continue;
        const dx = px[id] - x, dz = pz[id] - z;
        const rr = Math.max(r, pr[id]);
        if (dx * dx + dz * dz < rr * rr) return false;
      }
    }
    return true;
  };

  const push = (x, z, r) => {
    const gx = ((x - minX) / cell) | 0;
    const gz = ((z - minZ) / cell) | 0;
    grid[gz * gw + gx] = px.length;
    px.push(x); pz.push(z); pr.push(r);
    active.push(px.length - 1);
  };

  let seeds = 0;
  while (px.length < limit && seeds < seedBudget) {
    let sx = 0, sz = 0, ok = false;
    for (let t = 0; t < 48 && seeds < seedBudget; t++) {
      seeds++;
      sx = rng.range(minX, maxX);
      sz = rng.range(minZ, maxZ);
      if (!accept(sx, sz)) continue;
      if (!fits(sx, sz, radiusAt(sx, sz))) continue;
      ok = true;
      break;
    }
    if (!ok) continue;
    push(sx, sz, radiusAt(sx, sz));

    while (active.length && px.length < limit) {
      const ai = (rng() * active.length) | 0;
      const id = active[ai];
      let placed = false;
      const r0 = pr[id];
      for (let t = 0; t < k; t++) {
        const ang = rng() * TAU;
        const rad = r0 * (1 + rng());
        const nx = px[id] + Math.cos(ang) * rad;
        const nz = pz[id] + Math.sin(ang) * rad;
        if (nx < minX || nx > maxX || nz < minZ || nz > maxZ) continue;
        if (!accept(nx, nz)) continue;
        const nr = radiusAt(nx, nz);
        if (!fits(nx, nz, nr)) continue;
        push(nx, nz, nr);
        placed = true;
        break;
      }
      if (!placed) {
        active[ai] = active[active.length - 1];
        active.pop();
      }
    }
  }
  return { x: px, z: pz, r: pr, count: px.length };
}

/** Walk a polyline at (approximately) fixed spacing. cb(x, z, tx, tz, s, u). */
function walkPolyline(pts, spacing, cb) {
  if (!pts || pts.length < 2) return;
  let carry = 0;
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  }
  if (total < 1e-3) return;
  let walked = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], az = pts[i][1];
    const bx = pts[i + 1][0], bz = pts[i + 1][1];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;
    const tx = dx / len, tz = dz / len;
    let s = carry;
    while (s < len) {
      cb(ax + tx * s, az + tz * s, tx, tz, walked + s, (walked + s) / total);
      s += spacing;
    }
    carry = s - len;
    walked += len;
  }
}

/* ==========================================================================
 * 3.  GEOMETRY FACTORY
 *
 * Every mesh in this file is code-built from primitives. Rock uses flat
 * (non-indexed) shading because schist fractures into planar facets and smooth
 * normals turn an angular tor into a potato.
 * ======================================================================== */

/** Accumulates flat-shaded triangles and bakes a BufferGeometry. */
class TriBuilder {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.uvs = []; }

  tri(a, b, c, ca, cb, cc) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    if (ca) {
      const B = cb || ca, C = cc || ca;
      this.col.push(ca[0], ca[1], ca[2], B[0], B[1], B[2], C[0], C[1], C[2]);
    }
  }

  quad(a, b, c, d, ca, cb, cc, cd) {
    this.tri(a, b, c, ca, cb, cc);
    this.tri(a, c, d, ca, cc, cd);
  }

  /** Convex fan over an ordered ring; `flip` reverses the winding. */
  fan(ring, flip, col) {
    for (let i = 1; i < ring.length - 1; i++) {
      if (flip) this.tri(ring[0], ring[i + 1], ring[i], col, col, col);
      else this.tri(ring[0], ring[i], ring[i + 1], col, col, col);
    }
  }

  build(name) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    if (this.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    if (name) g.name = name;
    return g;
  }

  get triangles() { return this.pos.length / 9; }
}

/**
 * A schist tor: a vertical prism of irregular plan, sliced by parallel planes
 * at the foliation dip. That single construction produces everything the rock
 * needs to read as Otago schist — tabular slabs, ledges that all tilt the same
 * way, stepped weathered edges, and near-vertical planar faces (local tors
 * "mostly exceed 75°" per the geomorphology literature).
 *
 * Built at unit scale: plan radius 0.5, height 1, base extended to y = −0.5 so
 * an instance can be sunk into the snow without exposing an open bottom.
 * Local +X is the foliation strike (the long axis); local +Z is down-dip.
 */
function buildSlabStack(rng, opt = {}) {
  const slabs = opt.slabs ?? 4;
  const sides = opt.sides ?? 6;
  const taper = opt.taper ?? 0.74;
  const jag = opt.jag ?? 0.26;
  const batter = opt.batter ?? 0.93;   // top polygon vs bottom, per slab
  const step = opt.step ?? 0.09;       // lateral shuffle between slabs
  const flatten = opt.flatten ?? 0.62; // plan aspect: schist is tabular
  const dip = opt.dip ?? FOLIATION_DIP;
  const baseY = opt.baseY ?? -0.5;
  const tanDip = Math.tan(dip);

  // Irregular plan polygon, shared by every slab so the tor reads as one mass.
  const ang = [], rad = [];
  for (let j = 0; j < sides; j++) {
    ang.push((j / sides) * TAU + rng.range(-0.42, 0.42) * (TAU / sides) * 0.5);
    rad.push(0.5 * (1 - jag * rng()));
  }

  const B = new TriBuilder();
  let ox = 0, oz = 0;
  for (let i = 0; i < slabs; i++) {
    const u = slabs > 1 ? i / (slabs - 1) : 0;
    // Non-monotonic width. A strict taper makes every slab concentrically
    // smaller than the one below, so each ledge is a complete ring - and
    // since up-facing ledges load snow, the tor renders as a stack of white
    // annuli: the wedding cake every critique called "cuboids" and "dice".
    // Real schist stacks are not concentric: the variance here is wide enough
    // that a slab is regularly WIDER than its neighbour below, which turns
    // ring-ledges into one-sided ledges and adds undercut shadows.
    const sc = lerp(1, taper, u) * rng.range(0.80, 1.22);
    ox += rng.range(-step, step);
    oz += rng.range(-step, step);
    const yA = i / slabs;
    const yB = (i + 1) / slabs;

    const bot = [], top = [];
    for (let j = 0; j < sides; j++) {
      const cx = Math.cos(ang[j]) * rad[j] * sc;
      const cz = Math.sin(ang[j]) * rad[j] * sc * flatten;
      const x = ox + cx, z = oz + cz;
      // The slab boundary is a plane dipping `dip` toward local +Z.
      const tilt = -z * tanDip;
      bot.push([x, i === 0 ? baseY : yA + tilt, z]);
      const bx = ox + cx * batter, bz = oz + cz * batter;
      top.push([bx, yB - bz * tanDip, bz]);
    }
    // Winding: rings are generated with (cos a → x, sin a → z), so the
    // outward-facing side quad is bottom→top→top→bottom and the up-facing cap
    // is the *flipped* fan. Getting this backwards renders every rock
    // inside-out, which back-face culling turns into a hollow shell.
    for (let j = 0; j < sides; j++) {
      const j2 = (j + 1) % sides;
      B.quad(bot[j], top[j], top[j2], bot[j2]);
    }
    B.fan(top, true);
    B.fan(bot, false);
  }
  return B.build('soho-slab');
}

/**
 * Wind drift collar. Snow piles on the lee side of anything that stands proud,
 * and scours out upwind — so this is deliberately asymmetric: a short steep
 * face upwind, a long tapering tail downwind. Local +X is downwind, unit
 * radius, unit height.
 */
function buildDriftMound(segs = 12, rings = 3, tail = 1.5) {
  const B = new TriBuilder();
  const ringPt = (ri, si) => {
    const th = (si / segs) * TAU;
    const c = Math.cos(th), s = Math.sin(th);
    const rmax = 1 + tail * Math.max(0, c) ** 1.4;
    const t = ri / rings;
    const r = t * rmax;
    // Lee tail sheds height slowly, the upwind face is short and steep.
    const shed = 1 + 0.55 * Math.max(0, c);
    const y = Math.max(0, (1 - t / shed) ** 1.7);
    return [r * c, y, r * s];
  };
  const apex = [0, 1, 0];
  for (let si = 0; si < segs; si++) {
    B.tri(apex, ringPt(1, si + 1), ringPt(1, si));
  }
  for (let ri = 1; ri < rings; ri++) {
    for (let si = 0; si < segs; si++) {
      B.quad(ringPt(ri, si), ringPt(ri, si + 1), ringPt(ri + 1, si + 1), ringPt(ri + 1, si));
    }
  }
  return B.build('soho-drift');
}

/**
 * Bamboo marker pole with a slight bow and a taped orange tip. Colour is baked
 * into a vertex-colour attribute so the whole field is one draw call.
 */
function buildPole(opt = {}) {
  const height = opt.height ?? 2.15;
  const radius = opt.radius ?? 0.022;
  const radial = opt.radial ?? 6;
  const segs = opt.segs ?? 4;
  const bow = opt.bow ?? 0.035;
  const sink = opt.sink ?? 0.28;
  const tipFrac = opt.tipFrac ?? 0.0;
  const body = opt.body || [0.230, 0.196, 0.104];
  const tip = opt.tip || [0.760, 0.086, 0.020];

  const B = new TriBuilder();
  const ringAt = (t) => {
    const y = -sink + (height + sink) * t;
    const r = radius * lerp(1.0, 0.72, t);
    const bx = bow * t * t;
    const pts = [];
    for (let i = 0; i < radial; i++) {
      const a = (i / radial) * TAU;
      pts.push([bx + Math.cos(a) * r, y, Math.sin(a) * r]);
    }
    return pts;
  };
  const colAt = (t) => {
    if (t > 1 - tipFrac) return tip;
    // Bamboo nodes: a darker band every fifth of the pole.
    const n = (t * 5) % 1;
    const k = n < 0.09 ? 0.62 : 1.0;
    return [body[0] * k, body[1] * k, body[2] * k];
  };

  let prev = ringAt(0), prevC = colAt(0);
  for (let s = 1; s <= segs; s++) {
    const t = s / segs;
    const cur = ringAt(t), curC = colAt(t);
    for (let i = 0; i < radial; i++) {
      const j = (i + 1) % radial;
      B.quad(prev[i], cur[i], cur[j], prev[j], prevC, curC, curC, prevC);
    }
    prev = cur; prevC = curC;
  }
  B.fan(prev, true, prevC);
  return B.build('soho-pole');
}

/**
 * Marker flag: a small rectangle cantilevered off the pole top. `aBend` runs
 * 0 at the pole to 1 at the free edge and drives the vertex-shader flutter.
 */
function buildFlag(opt = {}) {
  const w = opt.width ?? 0.34;
  const h = opt.height ?? 0.24;
  const nx = opt.nx ?? 4, ny = opt.ny ?? 2;
  const pos = [], nrm = [], bend = [];
  const push = (i, j) => {
    const u = i / nx, v = j / ny;
    // A little natural droop and curl so a still frame is not a flat card.
    pos.push(u * w, (v - 0.5) * h - u * u * 0.035, Math.sin(u * 2.4) * 0.018);
    nrm.push(0, 0, 1);
    bend.push(u);
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      push(i, j); push(i + 1, j); push(i + 1, j + 1);
      push(i, j); push(i + 1, j + 1); push(i, j + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aBend', new THREE.Float32BufferAttribute(bend, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * A clump of narrow-leaved snow tussock. Blades arc outward and droop; the
 * colour ramps from a shadowed base (#6A5738) to a sun-caught tip (#B99A5E).
 * `aBend` is arc length along the blade — squared in the shader so the base
 * stays planted and only the top two thirds move.
 */
function buildTussock(rng, opt = {}) {
  const blades = opt.blades ?? 6;
  const segs = opt.segs ?? 3;
  const height = opt.height ?? 1.0;
  const pos = [], nrm = [], col = [], bend = [];
  // Linear-light albedo for the two ends of the blade. The tip is the exact
  // §6.2 gold `#B08A4E` scaled a little brighter (that swatch is the *lit*
  // appearance, and this is an albedo that still has to be multiplied by the
  // light); the base is `#6A5738`. The previous tip sat at a linear R:G:B of
  // 1 : 0.69 : 0.25, which encodes to sRGB `#BDA163` — HSV S = 0.48, right on
  // the checklist-33 chroma threshold, so half the population fell out of the
  // measurement the moment any blue skylight landed on it. 1 : 0.62 : 0.18 is
  // #B08A4E's own ratio and clears the threshold with margin.
  const baseCol = [0.148, 0.098, 0.038];
  const tipCol = [0.480, 0.300, 0.086];

  const emit = (p, n, c, b) => {
    pos.push(p[0], p[1], p[2]); nrm.push(n[0], n[1], n[2]);
    col.push(c[0], c[1], c[2]); bend.push(b);
  };

  for (let bl = 0; bl < blades; bl++) {
    const th = (bl / blades) * TAU + rng.range(-0.5, 0.5);
    const ct = Math.cos(th), st = Math.sin(th);
    const lean0 = rng.range(0.10, 0.42);
    const droop = rng.range(0.55, 1.15);
    const len = height * rng.range(0.72, 1.05);
    const w0 = rng.range(0.020, 0.032);
    const r0 = rng.range(0.0, 0.035);

    let px = ct * r0, py = 0, pz = st * r0;
    let prevL = [px - (-st) * w0 * 0.5, py, pz - ct * w0 * 0.5];
    let prevR = [px + (-st) * w0 * 0.5, py, pz + ct * w0 * 0.5];
    let prevC = baseCol;
    for (let s = 1; s <= segs; s++) {
      const u = s / segs;
      const a = lean0 + droop * Math.pow(u, 1.6);
      const stp = len / segs;
      px += Math.sin(a) * ct * stp;
      py += Math.cos(a) * stp;
      pz += Math.sin(a) * st * stp;
      const w = w0 * Math.pow(1 - u, 0.75);
      const L = [px - (-st) * w * 0.5, py, pz - ct * w * 0.5];
      const R = [px + (-st) * w * 0.5, py, pz + ct * w * 0.5];
      const c = [
        lerp(baseCol[0], tipCol[0], u), lerp(baseCol[1], tipCol[1], u), lerp(baseCol[2], tipCol[2], u),
      ];
      // Blade normal points out of the ribbon; double-sided material handles
      // the back face, and the shading normal is deliberately lifted toward
      // vertical so a clump does not flicker light/dark as blades cross.
      const n = [ct * 0.45, 0.86, st * 0.45];
      const b0 = (s - 1) / segs, b1 = u;
      emit(prevL, n, prevC, b0); emit(prevR, n, prevC, b0); emit(R, n, c, b1);
      emit(prevL, n, prevC, b0); emit(R, n, c, b1); emit(L, n, c, b1);
      prevL = L; prevR = R; prevC = c;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aBend', new THREE.Float32BufferAttribute(bend, 1));
  g.computeBoundingSphere();
  return g;
}

/** Axis-aligned box helper into a TriBuilder (cx,cy,cz centre, half extents). */
function pushBox(B, cx, cy, cz, hx, hy, hz, col) {
  const x0 = cx - hx, x1 = cx + hx, y0 = cy - hy, y1 = cy + hy, z0 = cz - hz, z1 = cz + hz;
  const p = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  B.quad(p[4], p[5], p[6], p[7], col, col, col, col); // +Z
  B.quad(p[1], p[0], p[3], p[2], col, col, col, col); // −Z
  B.quad(p[0], p[4], p[7], p[3], col, col, col, col); // −X
  B.quad(p[5], p[1], p[2], p[6], col, col, col, col); // +X
  B.quad(p[3], p[7], p[6], p[2], col, col, col, col); // +Y
  B.quad(p[0], p[1], p[5], p[4], col, col, col, col); // −Y
}

/** Tapered tube along +Y. */
function pushTube(B, cx, cz, y0, y1, r0, r1, radial, col) {
  const ring = (y, r) => {
    const out = [];
    for (let i = 0; i < radial; i++) {
      const a = (i / radial) * TAU;
      out.push([cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]);
    }
    return out;
  };
  const a = ring(y0, r0), b = ring(y1, r1);
  for (let i = 0; i < radial; i++) {
    const j = (i + 1) % radial;
    B.quad(a[i], b[i], b[j], a[j], col, col, col, col);
  }
  B.fan(b, true, col);
}

/**
 * Lift steel. These are deliberately dark.
 *
 * A galvanised tower is a mid grey in the hand, but §9.4 and checklist 32/34
 * ask the lift line to be *the* unambiguous scale cue in a wide frame, and the
 * frame it has to survive is 215-level snow seen through 600 m of in-scatter.
 * At the old 0.415 linear albedo a tower landed at sRGB ~200 — a 15-level
 * separation, i.e. invisible — and the single most valuable object in the shot
 * was aerial-perspectived out of existence. 0.075 linear lands it near sRGB 90
 * before in-scatter and holds it under 110 at 600 m once `steelMat` has its
 * in-scatter weight cut (see `dampenAerialPerspective`).
 */
const STEEL = [0.078, 0.083, 0.092];
const STEEL_DARK = [0.030, 0.032, 0.037];
const CHAIR_RED = [0.470, 0.021, 0.024];

/**
 * Lift tower: tubular shaft, base flange, crossarm and two sheave trains.
 *
 * Member thicknesses are set by the 960×540 capture, not by engineering: at
 * ~0.001 rad per pixel a 0.34 m crossarm is half a pixel at 600 m and
 * antialiases to nothing, taking the lattice with it. Everything structural is
 * therefore at least 0.55 m through, which is one pixel at the far tower.
 */
function buildLiftTower(height, detail = 1) {
  const B = new TriBuilder();
  const radial = detail ? 8 : 4;
  pushTube(B, 0, 0, -1.2, height, 0.62, 0.44, radial, STEEL);
  if (detail) {
    pushBox(B, 0, -0.9, 0, 1.05, 0.36, 1.05, STEEL_DARK);
    pushBox(B, 0, height + 0.24, 0, 3.05, 0.28, 0.28, STEEL);
    for (const s of [-1, 1]) {
      pushBox(B, s * 2.6, height - 0.18, 0, 0.92, 0.30, 0.24, STEEL_DARK);
      pushBox(B, s * 2.6, height + 0.10, 0, 0.30, 0.36, 0.22, STEEL);
      // Diagonal-ish knee brace: two stubby boxes, but they double the ink the
      // head of the tower puts on screen, which is what keeps the silhouette
      // legible once the crossarm itself is down to a pixel.
      pushBox(B, s * 1.5, height - 0.55, 0, 0.85, 0.16, 0.16, STEEL_DARK);
    }
  } else {
    pushBox(B, 0, height + 0.24, 0, 3.05, 0.30, 0.30, STEEL);
  }
  return B.build('soho-tower');
}

/** Six-seat detachable chair, hanging plumb from the haul rope. */
function buildChair() {
  const B = new TriBuilder();
  pushTube(B, 0, 0, -2.35, 0.15, 0.045, 0.055, 4, STEEL_DARK);
  pushBox(B, 0, -2.42, 0.02, 1.45, 0.09, 0.30, CHAIR_RED);   // seat pan
  pushBox(B, 0, -2.10, -0.28, 1.45, 0.40, 0.06, CHAIR_RED);  // back rest
  pushBox(B, 0, -2.86, 0.28, 1.30, 0.05, 0.05, STEEL_DARK);  // footrest bar
  return B.build('soho-chair');
}

/**
 * The Soho Express station, per the user's photo references: a near-black
 * clad hall under a BARREL-VAULT canopy with the resort's red trim stripe
 * running the roof rim, a dark glazing band under the eave, all on a pad.
 * The lettering is a separate canvas-texture mesh added by the caller (a
 * TriBuilder carries vertex colour only).
 */
function pushTerminal(B, x, y, z, yaw, len) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const rot = (lx, ly, lz) => [x + lx * c + lz * s, y + ly, z - lx * s + lz * c];
  const W = 6.0, H = 3.8, L = len;
  const wall = [0.085, 0.090, 0.100];    // near-black cladding
  const glaz = [0.045, 0.055, 0.075];    // glazing band, cool
  const roof = [0.055, 0.060, 0.070];    // canopy
  const trim = [0.620, 0.070, 0.045];    // resort red
  const corners = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) corners.push([sx * L, sz * W]);
  const bot = corners.map(([lx, lz]) => rot(lx, 0, lz));
  const mid = corners.map(([lx, lz]) => rot(lx, H - 1.05, lz));
  const top = corners.map(([lx, lz]) => rot(lx, H, lz));
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    B.quad(bot[i], mid[i], mid[j], bot[j], wall, wall, wall, wall);
    B.quad(mid[i], top[i], top[j], mid[j], glaz, glaz, glaz, glaz);
  }
  // Barrel vault: a circular-arc profile across the width, swept the full
  // length, overhanging both the eaves and the gable ends like the refs.
  const SEG = 8, OV = 1.0, RISE = 2.6;
  let prev = null;
  for (let k = 0; k <= SEG; k++) {
    const t = k / SEG;
    const lz = -(W + OV) + 2 * (W + OV) * t;
    const ly = H + Math.sin(Math.PI * t) * RISE;
    const a = rot(-(L + OV), ly, lz), b = rot(L + OV, ly, lz);
    if (prev) {
      B.quad(prev[0], a, b, prev[1], roof, roof, roof, roof);
      // underside, so looking up into the canopy never shows a hole
      B.quad(prev[1], b, a, prev[0], glaz, glaz, glaz, glaz);
    }
    prev = [a, b];
  }
  // Red trim stripe along both eave rims and around the gable arc edge.
  for (const sz of [-1, 1]) {
    const lz = sz * (W + OV);
    const a = rot(-(L + OV), H - 0.02, lz), b = rot(L + OV, H - 0.02, lz);
    const a2 = rot(-(L + OV), H + 0.15, lz), b2 = rot(L + OV, H + 0.15, lz);
    B.quad(a, a2, b2, b, trim, trim, trim, trim);
    B.quad(b, b2, a2, a, trim, trim, trim, trim);
  }
}

/* ==========================================================================
 * 4.  RIBBON BUILDERS (cornices, ropes, netting)
 * ======================================================================== */

/** How far windward of the crest the ribbon's buried rails run, in metres. */
const CORNICE_ROOT = 3.0;
const CORNICE_MID = 1.2;

/**
 * A cornice / drift lip. Heightfields cannot overhang, so the terrain caps the
 * crest bulge at 0° and this ribbon supplies the silhouette: a rounded crest,
 * an overhanging lip, and — the valuable part — a shadowed undercut, which is
 * the one place in the frame where the transport-blue of §3.2 really shows.
 *
 * **Every rail carries its own ground height**, sampled by `_corniceStation`
 * at that rail's own plan position. The first version of this builder derived
 * all four rails from the crest station's single `ground` sample and offset
 * them vertically — which is only correct on flat ground. The buried root rail
 * sat `CORNICE_ROOT` = 3 m up-slope but only 0.55 m down, so on anything
 * steeper than `atan(0.55 / 3) = 10.4°` the root came out *above* the surface;
 * on a 30° spur crest it floated `3·tan30 − 0.55 = 1.18 m` clear. That is
 * FINDINGS_R1 defect 1: a free hard edge with a dark gap under it and no
 * contact anywhere, on every cornice on the map. It was unconditional
 * arithmetic, not an LOD streaming race, which is why it survived three rounds
 * of shrinking and thinning.
 *
 * `stations` is [{x, z, lx, lz, lip, over, ground, hRoot, hMid, hToe}] walked
 * along the crest, with `null` separating independent runs.
 */
function buildCorniceRibbon(stations) {
  const B = new TriBuilder();
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i], b = stations[i + 1];
    if (!a || !b) continue;
    const pt = (s, back, y) => [s.x + s.lx * back, y, s.z + s.lz * back];
    // Five rails. 0 and 1 are buried in the windward flank, 2 is the built-up
    // crown, 3 is the free lip tip, 4 returns under the lip and back into the
    // snow. Rails 0, 1 and 4 are clamped below both their own local ground and
    // the crest ground, so no rail can ever be left standing in air.
    const y0 = (s) => Math.min(s.hRoot, s.ground) - 0.45;
    const y1 = (s) => Math.min(s.hMid, s.ground) - 0.14;
    const y2 = (s) => s.ground + s.lip;
    const y3 = (s) => s.ground + s.lip * 0.72;
    const y4 = (s) => Math.min(s.hToe, s.ground) - 0.30;

    const a0 = pt(a, -CORNICE_ROOT, y0(a)), b0 = pt(b, -CORNICE_ROOT, y0(b));
    const a1 = pt(a, -CORNICE_MID, y1(a)), b1 = pt(b, -CORNICE_MID, y1(b));
    const a2 = pt(a, 0.35 * a.over, y2(a)), b2 = pt(b, 0.35 * b.over, y2(b));
    const a3 = pt(a, a.over, y3(a)), b3 = pt(b, b.over, y3(b));
    const a4 = pt(a, a.over * 0.55, y4(a)), b4 = pt(b, b.over * 0.55, y4(b));

    // Handedness: the (along-crest, lee) frame flips sign depending on which
    // way the polyline runs, and a flipped ribbon renders inside-out. The 2D
    // cross product tells us which winding puts the top surface facing up.
    const hand = (b.x - a.x) * a.lz - (b.z - a.z) * a.lx;
    const q = hand <= 0
      ? (p0, p1, p2, p3) => B.quad(p0, p1, p2, p3)
      : (p0, p1, p2, p3) => B.quad(p3, p2, p1, p0);
    q(a0, b0, b1, a1);   // buried windward root — never visible, never floats
    q(a1, b1, b2, a2);   // the windward back emerging into the crown
    q(a2, b2, b3, a3);   // the lip itself
    q(a3, b3, b4, a4);   // the undercut, facing down and into shadow
  }
  return B.build('soho-cornice');
}

/**
 * Boundary rope as a triangular prism with catenary sag. A tube is the wrong
 * shape budget here — from any angle a 3-sided prism presents two faces and
 * costs a third of the triangles.
 */
function buildRopeRun(stations, sag, radius, col) {
  const B = new TriBuilder();
  const ring = (x, y, z, tx, tz) => {
    // Frame perpendicular to the run.
    const px = -tz, pz = tx;
    const out = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.5;
      const cy = Math.sin(a) * radius;
      const cp = Math.cos(a) * radius;
      out.push([x + px * cp, y + cy, z + pz * cp]);
    }
    return out;
  };
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i], b = stations[i + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3 || len > 40) continue;
    const tx = dx / len, tz = dz / len;
    const N = 3;   // a shallow catenary over an 8 m span needs no more
    let prev = null;
    for (let s = 0; s <= N; s++) {
      const t = s / N;
      const x = a.x + dx * t, z = a.z + dz * t;
      const y = lerp(a.y, b.y, t) - sag * 4 * t * (1 - t);
      const cur = ring(x, y, z, tx, tz);
      if (prev) {
        for (let k = 0; k < 3; k++) {
          const k2 = (k + 1) % 3;
          B.quad(prev[k], cur[k], cur[k2], prev[k2], col, col, col, col);
        }
      }
      prev = cur;
    }
  }
  return B.build('soho-rope');
}

/**
 * Hazard netting panels between posts, UV'd for the alpha-tested net map.
 *
 * Each span is subdivided so the top edge can carry a real catenary. The old
 * builder emitted one quad per span with the *same* `midSag` subtracted at both
 * ends, which is not a sag at all — it lowered the whole panel by a constant
 * and left the top edge a straight chord from post to post. A netting run whose
 * top edge is a polyline through the post tops with no dip between them is one
 * of the two things that read the fence as a drawn line rather than an object.
 */
function buildNetting(stations, height) {
  const pos = [], nrm = [], uvs = [];
  const SUB = 4;
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i], b = stations[i + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3 || len > 24) continue;
    const nx = -dz / len, nz = dx / len;
    // A slack net between two posts hangs; 4% of the span is a realistic dip
    // for polypropylene mesh strung by hand.
    const sag = Math.min(0.22, len * 0.04);
    const uSpan = len / 2.0;
    const ha = Number.isFinite(a.h) ? a.h : height;
    const hb = Number.isFinite(b.h) ? b.h : height;
    for (let s = 0; s < SUB; s++) {
      const t0 = s / SUB, t1 = (s + 1) / SUB;
      const at = (t) => {
        const x = a.x + dx * t, z = a.z + dz * t;
        // Foot follows the ground line between the two post bases; the top
        // rail is the chord minus the catenary.
        const foot = lerp(a.y, b.y, t) - 0.12;
        const top = lerp(a.y + ha, b.y + hb, t) - sag * 4 * t * (1 - t);
        return { x, z, foot, top };
      };
      const p0 = at(t0), p1 = at(t1);
      const A = [p0.x, p0.foot, p0.z];
      const Bv = [p1.x, p1.foot, p1.z];
      const C = [p1.x, p1.top, p1.z];
      const D = [p0.x, p0.top, p0.z];
      pos.push(...A, ...Bv, ...C, ...A, ...C, ...D);
      for (let q = 0; q < 6; q++) nrm.push(nx, 0, nz);
      const u0 = t0 * uSpan, u1 = t1 * uSpan;
      uvs.push(u0, 0, u1, 0, u1, 1, u0, 0, u1, 1, u0, 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeBoundingSphere();
  return g;
}

/* ==========================================================================
 * 5.  PROCEDURAL TEXTURES  (zero external assets)
 * ======================================================================== */

/**
 * Orange safety netting: a diamond lattice with an alpha-tested cutout, and
 * **coverage-preserving mipmaps**, which is the whole point of this function.
 *
 * A stock box-filtered mip chain over an alpha-tested cutout does not preserve
 * the cutout's coverage: a lattice that is 30% opaque at level 0 has *every*
 * texel sitting near α = 0.3 by level 4, so `alphaTest 0.5` either discards the
 * entire fence or — with anisotropic filtering picking a much sharper mip along
 * the minor axis, which is exactly what a 1 m fence viewed at 300 m does —
 * keeps a nearly solid run of strand texels. That second case is what
 * `shots/r6/west-spur.png` shows: an unbroken 2 px orange stroke across 350 px
 * of frame with no netting structure in it at all, reading as a marker-pen line
 * drawn on the image (tell §11.23).
 *
 * The fix is Castano's: box-filter each level, then rescale that level's alpha
 * so the fraction of texels at or above the alpha-test threshold matches level
 * 0. The netting then thins into a broken, dotted lattice at range instead of
 * collapsing to a solid bar or vanishing, at every mip and every anisotropy.
 */
function makeNetTexture(size = 128, alphaRef = 0.5) {
  // ~42% opaque, i.e. a net that is a bit under 60% open — orange bird-mesh,
  // not a tarpaulin. Coarse cells (three diamonds per tile, ~0.3 m on the
  // ground) because the fence's whole job is to survive at 200–400 m, and a
  // 5 cm mesh is under a pixel there whatever the mip chain does.
  const strand = 0.12;         // fraction of the cell occupied by the strand
  const cells = 3;             // diamonds across the tile
  const level0 = new Uint8Array(size * size * 4);
  const SS = 4;                // supersamples per axis for the level-0 alpha
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Level 0's alpha is a *coverage estimate*, not a binary test. A hard
      // 0/255 lattice box-filters to a handful of identical alpha values on
      // the coarse levels — at 4×4 every texel comes out the same number —
      // and a level whose alphas are all equal can only be scaled to 0% or
      // 100% coverage, so the whole rescaling scheme degenerates exactly
      // where it matters. Seventeen distinct edge values is enough to keep
      // every level's histogram continuous.
      let acc = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size, v = (y + (sy + 0.5) / SS) / size;
          // Two crossed sawtooth families → a diamond mesh.
          const d1 = Math.abs(((u + v) * cells) % 1 - 0.5) * 2;
          const d2 = Math.abs(((u - v) * cells + 8) % 1 - 0.5) * 2;
          if (d1 > 1 - strand * 2 || d2 > 1 - strand * 2) acc++;
        }
      }
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      const i = (y * size + x) * 4;
      // Warm orange with a little shading variation along the strand.
      const k = 0.86 + 0.14 * Math.sin((u + v) * 40);
      level0[i] = Math.round(232 * k);
      level0[i + 1] = Math.round(83 * k);
      level0[i + 2] = Math.round(31 * k);
      level0[i + 3] = Math.round((acc / (SS * SS)) * 255);
    }
  }

  const coverageOf = (buf, scale) => {
    let n = 0;
    for (let i = 3; i < buf.length; i += 4) if ((buf[i] / 255) * scale >= alphaRef) n++;
    return n / (buf.length / 4);
  };
  const target = coverageOf(level0, 1);

  const mipmaps = [{ data: level0, width: size, height: size }];
  // The box filter always reads the *unscaled* chain. Filtering the already-
  // rescaled level and then rescaling again compounds the correction, and the
  // chain collapses to zero coverage two levels from the bottom.
  let raw = level0, w = size, h = size;
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    const next = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
        const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
        const o = (y * nw + x) * 4;
        for (let c = 0; c < 4; c++) {
          next[o + c] = Math.round((
            raw[(y0 * w + x0) * 4 + c] + raw[(y0 * w + x1) * 4 + c]
            + raw[(y1 * w + x0) * 4 + c] + raw[(y1 * w + x1) * 4 + c]
          ) / 4);
        }
      }
    }
    const dst = next.slice();
    // Pick the alpha scale whose resulting coverage is *closest* to level 0's.
    //
    // Coverage is a step function of the scale, so bisection is the wrong
    // tool: every distinct alpha value in the level is one step, and on the
    // coarse levels there are only a handful. Enumerating them is exact, and
    // it is the only way to get the top of the chain right — a 2×2 level can
    // only express 0 / 25 / 50 / 75 / 100% and "smallest scale reaching the
    // target" rounds every one of them up to 100%, which puts the solid
    // orange bar straight back in the frame at the ranges where it was the
    // original complaint. Closest-match takes 50% at 2×2 and 0% at 1×1, so
    // the netting dissolves at extreme range the way sub-pixel coverage of a
    // 42%-open mesh actually should.
    const alphas = new Set([0]);
    for (let i = 3; i < dst.length; i += 4) if (dst[i] > 0) alphas.add(dst[i]);
    let scale = 0, bestErr = Infinity, bestCov = 0;
    for (const a of alphas) {
      // The 1 + 1e-6 matters: without it the candidate that makes alpha `a`
      // land *exactly* on the test threshold rounds the wrong way in binary
      // floating point and the level scores zero coverage instead of its
      // intended half.
      const cand = a > 0 ? ((alphaRef * 255) / a) * (1 + 1e-6) : 0;
      const cov = coverageOf(dst, cand);
      const err = Math.abs(cov - target);
      // Ties go to the candidate that keeps some coverage: a level that
      // erases the netting outright is never the right answer while level 0
      // still has strands in it.
      if (err < bestErr - 1e-9 || (Math.abs(err - bestErr) <= 1e-9 && cov > bestCov)) {
        bestErr = err; bestCov = cov; scale = cand;
      }
    }
    for (let i = 3; i < dst.length; i += 4) dst[i] = Math.min(255, Math.round(dst[i] * scale));
    mipmaps.push({ data: dst, width: nw, height: nh });
    raw = next; w = nw; h = nh;
  }

  const tex = new THREE.DataTexture(level0, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = mipmaps;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ==========================================================================
 * 6.  WIND-ANIMATED MATERIALS
 *
 * Patched onto MeshStandardMaterial rather than written from scratch, so we
 * inherit the engine's cascades, IBL, fog and tone mapping. The displacement
 * is injected *after* the instance matrix (see the project_vertex override) so
 * the wind is a world-space direction regardless of per-instance yaw.
 * ======================================================================== */

const WIND_PARS = /* glsl */ `
attribute float aBend;
uniform float uPropTime;
uniform vec2  uWindXZ;
uniform float uWindGust;
uniform float uSwayAmp;
uniform float uSwayFreq;
varying float vBendAmt;
`;

/**
 * Replacement for `<project_vertex>`. Identical to the stock chunk except the
 * sway is added in post-instance (world-aligned) space, which keeps the motion
 * coherent across a field of randomly-yawed clumps.
 */
const WIND_PROJECT = /* glsl */ `
vec4 sohoPos = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	sohoPos = batchingMatrix * sohoPos;
#endif
#ifdef USE_INSTANCING
	sohoPos = instanceMatrix * sohoPos;
#endif
{
	// Per-clump phase from its world origin: no extra attribute, and stable
	// frame to frame because it is a pure function of position.
	vec2 org = sohoPos.xz;
	#ifdef USE_INSTANCING
		org = vec2( instanceMatrix[ 3 ][ 0 ], instanceMatrix[ 3 ][ 2 ] );
	#endif
	float ph = fract( dot( org, vec2( 0.1031, 0.0973 ) ) ) * 6.2831853;
	float b = aBend * aBend;
	float s = sin( uPropTime * uSwayFreq + ph ) * 0.62
		+ sin( uPropTime * uSwayFreq * 2.37 + ph * 1.7 ) * 0.26;
	float amp = uSwayAmp * ( 0.55 + 0.75 * uWindGust );
	sohoPos.xz += uWindXZ * ( b * amp * s );
	sohoPos.y  -= b * amp * abs( s ) * 0.35;
	vBendAmt = b;
}
vec4 mvPosition = modelViewMatrix * sohoPos;
gl_Position = projectionMatrix * mvPosition;
`;

/**
 * Backlit rim. At a 10.6° sun, tussock and fabric with the sun behind them
 * glow — §6.2 calls it out explicitly and it is the strongest thing tussock
 * does for the frame. Cheap approximation: add radiance when the view ray runs
 * *into* the sun, weighted by how far up the blade we are (tips are thinner).
 */
const BACKLIT_PARS = /* glsl */ `
uniform vec3  uSunViewDir;
uniform vec3  uBacklitColor;
uniform float uBacklitStrength;
`;

const BACKLIT_MAIN = /* glsl */ `
{
	vec3 sohoV = normalize( vViewPosition );
	float sohoBack = saturate( - dot( sohoV, uSunViewDir ) );
	outgoingLight += uBacklitColor * ( uBacklitStrength * pow( sohoBack, 3.5 ) * ( 0.25 + 0.75 * vBendAmt ) );
}
`;

/**
 * Foliage two-sided fix. A double-sided material multiplies the shading normal
 * by `faceDirection`, which is right for a solid shell and wrong for a grass
 * blade: the back of a blade is not the inside of anything, and flipping the
 * normal makes every clump half-black from one side. Multiplying by
 * `faceDirection` a second time cancels it, so both faces use the authored
 * (outward-and-up) normal that `buildTussock` bakes in.
 */
const FOLIAGE_NORMAL = /* glsl */ `
#ifdef DOUBLE_SIDED
	normal *= faceDirection;
	nonPerturbedNormal = normal;
#endif
`;

/**
 * The exact line `sky.js` splices into `opaque_fragment` when it installs the
 * physically-based aerial-perspective term. Matched, not reconstructed, so if
 * that module ever rewrites the line this simply becomes a no-op rather than
 * silently corrupting a shader.
 */
const AP_LINE =
  'gl_FragColor.rgb = sohoAerialPerspective( gl_FragColor.rgb, vSohoWorldPos, cameraPosition );';

/**
 * Cut a material's share of the aerial-perspective in-scatter.
 *
 * §5 of the art direction is about *snow* — a 600 m snowfield genuinely is
 * washed toward the sky colour, and the term is right for it. It is wrong for
 * the handful of small, dark, high-frequency objects that carry the frame's
 * scale and its colour accents: a 0.6 m tower member, a 2 cm marker pole, a
 * tussock seed head. Those occupy a fraction of a pixel of the column the
 * in-scatter is integrated over, so applying the full path radiance to them
 * lifts them into the snow value and deletes them (checklist 32, 33, 34).
 * Physically this is the sub-pixel coverage term we do not have; practically
 * it is the difference between a lift line and a smudge.
 *
 * Implemented by rewriting the chunk rather than the resolved source, because
 * `onBeforeCompile` runs before three resolves `#include` directives.
 */
function dampenAerialPerspective(material, weight, cacheKey) {
  const prev = material.onBeforeCompile;
  const w = Math.max(0, Math.min(1, weight)).toFixed(3);
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    const chunk = THREE.ShaderChunk.opaque_fragment;
    if (!chunk || chunk.indexOf(AP_LINE) === -1) return;   // sky.js not installed
    const patched = chunk.replace(
      AP_LINE,
      'gl_FragColor.rgb = mix( gl_FragColor.rgb,'
      + ' sohoAerialPerspective( gl_FragColor.rgb, vSohoWorldPos, cameraPosition ),'
      + ` ${w} );`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <opaque_fragment>', patched);
  };
  const prevKey = material.customProgramCacheKey;
  material.customProgramCacheKey = function () {
    return `${prevKey ? prevKey.call(this) : material.type}|ap${w}|${cacheKey}`;
  };
}

function installWind(material, uniforms, cacheKey, backlit, foliage) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_PARS}`)
      .replace('#include <project_vertex>', WIND_PROJECT);
    let frag = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\nvarying float vBendAmt;\n${backlit ? BACKLIT_PARS : ''}`,
    );
    if (foliage) {
      frag = frag.replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>\n${FOLIAGE_NORMAL}`,
      );
    }
    if (backlit) {
      frag = frag.replace('#include <opaque_fragment>', `${BACKLIT_MAIN}\n#include <opaque_fragment>`);
    }
    shader.fragmentShader = frag;
  };
  material.customProgramCacheKey = () => cacheKey;
  // Geometry that forgets the attribute still compiles and simply stands still.
  material.defaultAttributeValues = { ...(material.defaultAttributeValues || {}), aBend: [0] };
}

/* ==========================================================================
 * 7.  INSTANCED FIELD — distance LOD + angular-size culling
 *
 * One field owns N geometry levels sharing a material. On refresh each
 * instance picks the level whose quality threshold its *projected angular
 * size* still clears, so a 6 m tor keeps its detail four times further out
 * than a 1.5 m boulder without any hand-authored per-prop distances.
 *
 * Refresh is not per-frame: it runs when the camera has moved further than
 * `lodEpsilon`, or every `lodMaxFrames` frames. Both triggers are pure
 * functions of deterministic state, so the harness still diffs clean.
 * ======================================================================== */

class InstancedField {
  /**
   * @param {string} name
   * @param {THREE.Material} material
   * @param {Array<{geometry:THREE.BufferGeometry, angular:number}>} levels
   *        ordered near → far; `angular` is the minimum radius/distance ratio
   *        at which that level is still used.
   */
  constructor(name, material, levels, opts = {}) {
    this.name = name;
    this.material = material;
    this.levels = levels;
    this.castShadow = opts.castShadow ?? true;
    this.receiveShadow = opts.receiveShadow ?? true;
    this.shadowLevels = opts.shadowLevels ?? 1;   // levels that write shadows
    this.cullAngular = opts.cullAngular ?? 0.0028;
    this.useColor = !!opts.useColor;
    this._m = [];       // flat 16-float matrices
    this._r = [];       // world-space radius per instance
    this._c = [];       // optional per-instance tint
    this.meshes = [];
    this.count = 0;
  }

  /** @param {THREE.Matrix4} matrix @param {number} radius @param {THREE.Color} [color] */
  add(matrix, radius, color) {
    const e = matrix.elements;
    for (let i = 0; i < 16; i++) this._m.push(e[i]);
    this._r.push(radius);
    if (this.useColor) this._c.push(color ? color.r : 1, color ? color.g : 1, color ? color.b : 1);
    this.count++;
    return this.count - 1;
  }

  finalize(parent) {
    if (!this.count) return;
    this.matrices = new Float32Array(this._m);
    this.radii = new Float32Array(this._r);
    this.colors = this.useColor ? new Float32Array(this._c) : null;
    this._m = null; this._c = null; this._r = null;
    // Scratch: each level may in the worst case hold every instance.
    for (let li = 0; li < this.levels.length; li++) {
      const lv = this.levels[li];
      const mesh = new THREE.InstancedMesh(lv.geometry, this.material, this.count);
      mesh.name = `${this.name}-lod${li}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = this.castShadow && li < this.shadowLevels;
      mesh.receiveShadow = this.receiveShadow;
      mesh.count = 0;
      mesh.visible = false;
      if (this.useColor) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.count * 3), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      this.meshes.push(mesh);
      parent.add(mesh);
    }
    this.refresh(new THREE.Vector3(0, 1900, 900));
  }

  refresh(camPos) {
    if (!this.count) return;
    const nl = this.meshes.length;
    const cursor = this._cursor || (this._cursor = new Int32Array(nl));
    cursor.fill(0);
    const M = this.matrices, R = this.radii, C = this.colors;
    const cx = camPos.x, cy = camPos.y, cz = camPos.z;

    for (let i = 0; i < this.count; i++) {
      const o = i * 16;
      const dx = M[o + 12] - cx, dy = M[o + 13] - cy, dz = M[o + 14] - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
      const ang = R[i] / d;
      if (ang < this.cullAngular) continue;
      let li = nl - 1;
      for (let l = 0; l < nl; l++) {
        if (ang >= this.levels[l].angular) { li = l; break; }
      }
      const mesh = this.meshes[li];
      const k = cursor[li]++;
      const dst = mesh.instanceMatrix.array;
      const d0 = k * 16;
      for (let j = 0; j < 16; j++) dst[d0 + j] = M[o + j];
      if (C) {
        const ca = mesh.instanceColor.array;
        ca[k * 3] = C[i * 3]; ca[k * 3 + 1] = C[i * 3 + 1]; ca[k * 3 + 2] = C[i * 3 + 2];
      }
    }

    for (let l = 0; l < nl; l++) {
      const mesh = this.meshes[l];
      mesh.count = cursor[l];
      mesh.visible = cursor[l] > 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // Recomputed from the *visible* set so frustum culling stays tight.
      if (mesh.visible) mesh.computeBoundingSphere();
    }
  }

  dispose() {
    for (const m of this.meshes) {
      m.parent?.remove(m);
      m.dispose?.();
    }
    for (const lv of this.levels) lv.geometry.dispose();
    this.meshes.length = 0;
  }
}

/* ==========================================================================
 * 8.  CHUNKED FIELD — for very large instance counts (tussock)
 *
 * Reordering 5,000 matrices on every LOD refresh is wasted work when the
 * instances are tiny and locally coherent. Instead they are bucketed into
 * fixed chunks at build time in a shuffled order, and thinning is a single
 * `mesh.count = n * f(distance)` — no buffer traffic at all.
 * ======================================================================== */

class ChunkedField {
  constructor(name, geometry, material, opts = {}) {
    this.name = name;
    this.geometry = geometry;
    this.material = material;
    this.size = opts.size ?? 96;
    this.near = opts.near ?? 60;
    this.far = opts.far ?? 220;
    this.cull = opts.cull ?? 320;
    this.minFrac = opts.minFrac ?? 0.2;
    this.castShadow = opts.castShadow ?? false;
    this.receiveShadow = opts.receiveShadow ?? true;
    this.useColor = !!opts.useColor;
    this._buckets = new Map();
    this.chunks = [];
    this.count = 0;
  }

  add(matrix, x, z, color) {
    const key = `${Math.floor(x / this.size)}:${Math.floor(z / this.size)}`;
    let b = this._buckets.get(key);
    if (!b) { b = { m: [], c: [], cx: 0, cz: 0, n: 0 }; this._buckets.set(key, b); }
    const e = matrix.elements;
    for (let i = 0; i < 16; i++) b.m.push(e[i]);
    if (this.useColor) b.c.push(color ? color.r : 1, color ? color.g : 1, color ? color.b : 1);
    b.cx += x; b.cz += z; b.n++;
    this.count++;
  }

  /** Deterministic Fisher-Yates so truncating `count` thins evenly in space. */
  _shuffle(b, rng) {
    for (let i = b.n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      for (let k = 0; k < 16; k++) {
        const a = i * 16 + k, c = j * 16 + k;
        const t = b.m[a]; b.m[a] = b.m[c]; b.m[c] = t;
      }
      if (this.useColor) {
        for (let k = 0; k < 3; k++) {
          const a = i * 3 + k, c = j * 3 + k;
          const t = b.c[a]; b.c[a] = b.c[c]; b.c[c] = t;
        }
      }
    }
  }

  finalize(parent, rng) {
    for (const b of this._buckets.values()) {
      if (!b.n) continue;
      this._shuffle(b, rng);
      const mesh = new THREE.InstancedMesh(this.geometry, this.material, b.n);
      mesh.name = this.name;
      mesh.instanceMatrix.array.set(b.m);
      mesh.instanceMatrix.needsUpdate = true;
      if (this.useColor) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(b.c), 3);
      }
      mesh.castShadow = this.castShadow;
      mesh.receiveShadow = this.receiveShadow;
      mesh.computeBoundingSphere();
      // Off until the first `update()` decides how close the camera is; the
      // engine always updates before it renders, so nothing pops.
      mesh.visible = false;
      parent.add(mesh);
      this.chunks.push({ mesh, total: b.n, cx: b.cx / b.n, cz: b.cz / b.n });
    }
    this._buckets.clear();
  }

  update(camPos) {
    for (const c of this.chunks) {
      const dx = c.cx - camPos.x, dz = c.cz - camPos.z;
      const d = Math.hypot(dx, dz);
      if (d > this.cull + this.size) { c.mesh.visible = false; continue; }
      const f = 1 - (1 - this.minFrac) * smoothstep(this.near, this.far, d);
      const n = d > this.cull ? 0 : Math.max(1, Math.round(c.total * f));
      c.mesh.count = Math.min(c.total, n);
      c.mesh.visible = c.mesh.count > 0;
    }
  }

  dispose() {
    for (const c of this.chunks) { c.mesh.parent?.remove(c.mesh); c.mesh.dispose?.(); }
    this.chunks.length = 0;
    this.geometry.dispose();
  }
}

/* ==========================================================================
 * 9.  PROPS
 * ======================================================================== */

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _col = new THREE.Color();

export class Props {
  constructor(ctx) {
    this.ctx = ctx;
    this.object3D = new THREE.Object3D();
    this.object3D.name = 'Props';
    this.built = false;

    this.tune = mergeTune(JSON.parse(JSON.stringify(DEFAULT_TUNE)), CONFIG.props);
    this.seedBase = seedFromString(String(CONFIG.seed ?? 'soho')) >>> 0;

    this.fields = [];        // InstancedField
    this.chunked = [];       // ChunkedField
    this.statics = [];       // merged Mesh
    this.materials = [];
    this._colliders = [];
    this._chairs = null;
    this._lodCam = new THREE.Vector3(1e9, 1e9, 1e9);
    this._lodFrame = -1e9;
    this._time = 0;
    this._stats = { instances: 0, triangles: 0, objects: 0 };

    // Shared by every wind-animated material so one clock and one wind vector
    // drive the whole field; per-material amplitude/frequency live alongside.
    this._windUniforms = {
      uPropTime: { value: 0 },
      uWindXZ: { value: new THREE.Vector2(-0.921, 0.391) },
      uWindGust: { value: 0.4 },
      uSunViewDir: { value: new THREE.Vector3(0, 0, -1) },
      uBacklitStrength: { value: 0.0 },
    };

    ctx.props = this;
  }

  _seed(name) { return (seedFromString('soho.props.' + name) ^ this.seedBase) >>> 0; }

  /** Set dressing must never block boot; a failed subsystem is logged, not fatal. */
  _safe(label, fn) {
    try {
      fn();
    } catch (err) {
      if (typeof console !== 'undefined') console.warn(`[props] ${label} failed:`, err);
    }
  }

  /* ------------------------------------------------------------------ *
   * build
   * ------------------------------------------------------------------ */

  async build() {
    const ctx = this.ctx;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    this.probe = new TerrainProbe(ctx);
    this.features = this.probe.features;
    this.wind = dirFromBearing((CONFIG.world?.windDirection ?? 292) - 180);
    this._windUniforms.uWindXZ.value.set(this.wind.x, this.wind.z);
    this.windYaw = yawForXAxis(this.wind.x, this.wind.z);
    this.simp = new Simplex(this._seed('breakup'));

    if (this.tune.enabled === false) {
      ctx.scene?.add(this.object3D);
      this.built = true;
      return;
    }

    this._buildMaterials();
    this._buildGeometryLibrary();

    // Placement order matters only in that later systems consult the
    // exclusion list the earlier ones populate (poles do not spear a tor).
    this._safe('rocks', () => this._placeRocks());
    this._safe('bluff-rubble', () => this._placeBluffRubble());
    this._safe('debris', () => this._placeAvalancheDebris());
    this._safe('cornices', () => this._buildCornices());
    this._safe('poles', () => this._placePoles());
    this._safe('fences', () => this._placeFences());
    this._safe('lift', () => this._buildLift());
    this._safe('tussock', () => this._placeTussock());

    // Publish every field to the scene graph.
    for (const f of this.fields) f.finalize(this.object3D);
    const shuffleRng = makeRng(this._seed('chunk.shuffle'));
    for (const c of this.chunked) c.finalize(this.object3D, shuffleRng);
    this._poseChairs(0);

    this._collectStats();
    if (CONFIG.debug?.showColliders) this._buildColliderDebug();

    ctx.scene?.add(this.object3D);
    this.built = true;
    this._refreshLod(true);

    const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    if (typeof console !== 'undefined') {
      console.info(
        `[props] set dressing built in ${ms} ms — ${this._stats.instances} instances, `
        + `${this._stats.objects} objects, ${this._colliders.length} colliders`,
      );
    }
  }

  /* ------------------------------------------------------------------ *
   * materials
   * ------------------------------------------------------------------ */

  _buildMaterials() {
    const ctx = this.ctx;

    // Otago schist — triplanar, one global foliation, snow on every ledge.
    // `snowOnRock` is pulled back from 1.0: the accumulation term is driven by
    // the *perturbed* normal, and once the plate relief has faded out with
    // distance every marginally-up-facing facet snaps to full cover at once,
    // so a 60 m outcrop turns into an untextured white lozenge that is
    // brighter than the shadowed snow around it (§6.1, checklist 23/31). At
    // 0.84 the near-horizontal ledges still load — which the brief requires —
    // but the 45–65° faces stay schist all the way out.
    // …and 0.84 was still too high once the plate relief has faded. The
    // accumulation term is `saturate(ledge*1.05 + cavity*0.35 + drift + …)`
    // scaled by this number, and at 0.84 a 45° facet still comes out ~58%
    // snow — so a distant outcrop is a pale lozenge *brighter than the
    // shadowed snow it stands in*, which is precisely backwards: §6.1 puts
    // shadowed schist at `#3E4453`, well below shadowed snow's `#8897B6`.
    // At 0.64 a flat-lying ledge still loads (accum ≈ 0.61 → 85% snow, which
    // the brief requires) but everything past ~35° stays schist, and the tor
    // field reads as dark geology against white instead of confetti.
    this.rockMat = createRockMaterial(ctx, { snowOnRock: 0.64, rockRoughness: 0.72 });
    this.rockMat.name = 'props-schist';

    // Ground-snow shading for drifts, cornice lips and avalanche blocks, so a
    // drift collar is literally the same material as the slope it sits on.
    this.snowMat = createSnowMaterial(ctx, {});
    this.snowMat.name = 'props-snow';

    this.poleMat = new THREE.MeshStandardMaterial({
      name: 'props-bamboo', vertexColors: true, roughness: 0.74, metalness: 0.0, dithering: true,
    });

    this.steelMat = new THREE.MeshStandardMaterial({
      name: 'props-steel', vertexColors: true, roughness: 0.44, metalness: 0.55, dithering: true,
    });

    this.ropeMat = new THREE.MeshStandardMaterial({
      name: 'props-rope', vertexColors: true, roughness: 0.88, metalness: 0.0,
    });

    this.netTex = makeNetTexture(128, 0.5);
    // Capped at 4. Anisotropy selects the mip from the *minor* derivative, so
    // an alpha-tested cutout viewed edge-on — which is what a 1 m fence at
    // 300 m is — samples a far sharper level than the footprint deserves. The
    // coverage-preserving chain in `makeNetTexture` means that no longer
    // welds the lattice into a solid bar, but there is nothing to gain from
    // pushing it to 16 either.
    this.netTex.anisotropy = Math.max(1, Math.min(4, ctx?.maxAnisotropy ?? 4));
    this.netMat = new THREE.MeshStandardMaterial({
      name: 'props-netting',
      map: this.netTex,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 0.82,
      metalness: 0.0,
    });

    // Flag: light coated nylon. Fluttering fast and shallow, and translucent
    // enough that a low sun behind it lights the fabric through.
    this.flagMat = new THREE.MeshStandardMaterial({
      name: 'props-flag',
      color: new THREE.Color(0.760, 0.086, 0.020),
      roughness: 0.62,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    installWind(this.flagMat, {
      ...this._windUniforms,
      uSwayAmp: { value: 0.055 },
      uSwayFreq: { value: 3.4 },
      uBacklitColor: { value: new THREE.Color(0.95, 0.24, 0.06) },
    }, 'soho-flag', true, true);

    // Snow tussock: double-sided ribbons, slow deep sway, gold backlit rim —
    // §6.2 wants the low sun to blow straight through the seed heads.
    this.tussockMat = new THREE.MeshStandardMaterial({
      name: 'props-tussock',
      vertexColors: true,
      roughness: 0.86,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    installWind(this.tussockMat, {
      ...this._windUniforms,
      uSwayAmp: { value: 0.10 },
      uSwayFreq: { value: 1.25 },
      uBacklitColor: { value: new THREE.Color(0.72, 0.47, 0.15) },
    }, 'soho-tussock', true, true);

    // Small dark silhouettes and the two colour accents are exempted from most
    // of the in-scatter — see `dampenAerialPerspective`. Applied last, because
    // it wraps whatever `onBeforeCompile` / cache key the material already has.
    dampenAerialPerspective(this.steelMat, 0.35, 'steel');
    dampenAerialPerspective(this.poleMat, 0.55, 'bamboo');
    dampenAerialPerspective(this.ropeMat, 0.45, 'rope');
    dampenAerialPerspective(this.netMat, 0.55, 'net');
    dampenAerialPerspective(this.flagMat, 0.50, 'flag');
    dampenAerialPerspective(this.tussockMat, 0.50, 'tussock');

    this.materials.push(
      this.rockMat, this.snowMat, this.poleMat, this.steelMat,
      this.ropeMat, this.netMat, this.flagMat, this.tussockMat,
    );
  }

  /* ------------------------------------------------------------------ *
   * geometry library
   * ------------------------------------------------------------------ */

  _buildGeometryLibrary() {
    /**
     * Three rock archetypes, each at three levels of detail. They are
     * semantically different landforms, not just three random blobs: a tall
     * tor on the crest, a broad low outcrop on rock-classed ground, and an
     * angular block for talus and blockfield.
     */
    /**
     * Three LOD levels per archetype.
     *
     * The far level used to be `{ slabs: 1, sides: 4 }` — which is a *box*. It
     * is also the level every wide preset actually renders: a 4 m outcrop at
     * 400 m subtends 0.009 rad, below the 0.014 threshold, so the entire
     * outcrop, tor and talus population in `hero-basin`, `west-spur`,
     * `ridge-backlight` and `air-trick` was drawn as axis-aligned cuboids with
     * a single flat up-facing cap. That cap loads snow (see `snowOnRock`) and
     * comes out a pale blue-grey square: the "dozens of near-identical
     * rectangular blocks scattered on the snow" read, and it is a geometry
     * bug, not a shading one.
     *
     * Two slabs and six sides is 12 quads instead of 5 — 40 triangles against
     * a 1 px footprint, which is nothing — and it keeps the two things that
     * make schist schist at range: a tabular plan and a top face tilted to the
     * foliation dip rather than flat to the sky.
     */
    const lod = (params) => [
      { geometry: buildSlabStack(makeRng(params.seed), { ...params, slabs: params.slabs, sides: params.sides }), angular: 0.052 },
      { geometry: buildSlabStack(makeRng(params.seed), { ...params, slabs: Math.max(2, params.slabs - 2), sides: Math.max(5, params.sides - 1), batter: 0.95 }), angular: 0.012 },
      { geometry: buildSlabStack(makeRng(params.seed), { ...params, slabs: 2, sides: 6, batter: 0.94, step: (params.step ?? 0.09) * 1.4 }), angular: 0.0 },
    ];

    this.geo = {
      tor: lod({ seed: this._seed('geo.tor'), slabs: 5, sides: 6, taper: 0.70, jag: 0.30, flatten: 0.55, step: 0.20 }),
      outcrop: lod({ seed: this._seed('geo.outcrop'), slabs: 4, sides: 7, taper: 0.84, jag: 0.24, flatten: 0.48, step: 0.24 }),
      block: lod({ seed: this._seed('geo.block'), slabs: 3, sides: 5, taper: 0.76, jag: 0.34, flatten: 0.70, step: 0.16 }),
      drift: [
        { geometry: buildDriftMound(14, 3, 1.6), angular: 0.030 },
        { geometry: buildDriftMound(8, 2, 1.6), angular: 0.0 },
      ],
      snowBlock: [
        { geometry: buildSlabStack(makeRng(this._seed('geo.slabdebris')), { slabs: 2, sides: 5, taper: 0.86, jag: 0.30, flatten: 0.72, dip: 12 * DEG, batter: 0.90 }), angular: 0.030 },
        { geometry: buildSlabStack(makeRng(this._seed('geo.slabdebris')), { slabs: 1, sides: 4, taper: 0.9, jag: 0.30, flatten: 0.72, dip: 12 * DEG }), angular: 0.0 },
      ],
      pole: [
        { geometry: buildPole({ tipFrac: 0.14 }), angular: 0.010 },
        // The far LOD is deliberately fatter: a 2 cm pole at 300 m is well
        // under a pixel and simply vanishes, so it is thickened to hold the
        // dotted line of poles that marks the piste edge into the distance.
        { geometry: buildPole({ radial: 4, segs: 2, radius: 0.038, tipFrac: 0.16 }), angular: 0.0 },
      ],
      /**
       * Fence posts stand `netHeight` + ~0.9 m, i.e. proud of the netting, and
       * they are deliberately fat: a 28 mm post at the 320 m `west-spur`
       * framing is 0.18 px and simply is not there, which is why the fence
       * came back as a bare orange stroke with no structure. A 55 mm post is
       * still a plausible waratah and it is the thing that turns the line into
       * a comb. The far level is fatter again for the same reason the marker
       * poles' far level is.
       */
      fencePost: [
        { geometry: buildPole({ height: 1.0, radius: 0.055, segs: 3, tipFrac: 0.0, body: [0.126, 0.112, 0.078] }), angular: 0.010 },
        { geometry: buildPole({ height: 1.0, radius: 0.085, radial: 4, segs: 2, tipFrac: 0.0, body: [0.126, 0.112, 0.078] }), angular: 0.0 },
      ],
      flag: [{ geometry: buildFlag({}), angular: 0.0 }],
      tower: [
        { geometry: buildLiftTower(9.5, 1), angular: 0.020 },
        { geometry: buildLiftTower(9.5, 0), angular: 0.0 },
      ],
      chair: [{ geometry: buildChair(), angular: 0.0 }],
      tussock: buildTussock(makeRng(this._seed('geo.tussock')), { blades: 6, segs: 3, height: 1.0 }),
    };
  }

  /** Create and register an InstancedField. */
  _field(name, material, levels, opts) {
    const f = new InstancedField(name, material, levels, opts);
    this.fields.push(f);
    return f;
  }

  /* ------------------------------------------------------------------ *
   * exclusion mask — nothing gets planted in a piste or a lift corridor
   * ------------------------------------------------------------------ */

  _buildExclusion() {
    const N = 256;
    const b = this.probe.bounds;
    const w = b.maxX - b.minX, h = b.maxZ - b.minZ;
    const cell = Math.max(w, h) / N;
    const mask = new Uint8Array(N * N);
    const stamp = (x, z, r) => {
      const gx0 = Math.max(0, Math.floor((x - r - b.minX) / cell));
      const gx1 = Math.min(N - 1, Math.ceil((x + r - b.minX) / cell));
      const gz0 = Math.max(0, Math.floor((z - r - b.minZ) / cell));
      const gz1 = Math.min(N - 1, Math.ceil((z + r - b.minZ) / cell));
      const r2 = r * r;
      for (let j = gz0; j <= gz1; j++) {
        const cz = b.minZ + (j + 0.5) * cell;
        for (let i = gx0; i <= gx1; i++) {
          const cx = b.minX + (i + 0.5) * cell;
          if ((cx - x) * (cx - x) + (cz - z) * (cz - z) <= r2) mask[j * N + i] = 1;
        }
      }
    };

    const F = this.features;
    for (const c of F.corridors || []) walkPolyline(c.pts, 8, (x, z) => stamp(x, z, (c.halfWidth ?? 20) + 7));
    for (const t of F.tracks || []) walkPolyline(t.pts, 6, (x, z) => stamp(x, z, (t.halfWidth ?? 3) + 5));
    if (F.lift) {
      walkPolyline(
        [[F.lift.base.x, F.lift.base.z], [F.lift.top.x, F.lift.top.z]], 10,
        (x, z) => stamp(x, z, (F.lift.corridorHalfWidth ?? 20) + 4),
      );
    }
    // The four spawns need clean ground under the rider's board.
    for (const k of Object.keys(F.spawns || {})) {
      const s = F.spawns[k];
      if (s) stamp(s.x, s.z, 14);
    }

    this._ex = { mask, N, cell, minX: b.minX, minZ: b.minZ };
  }

  /** True where props must not be planted (piste, cat track, lift line). */
  _cleared(x, z) {
    const e = this._ex;
    if (!e) return false;
    const i = ((x - e.minX) / e.cell) | 0;
    const j = ((z - e.minZ) / e.cell) | 0;
    if (i < 0 || j < 0 || i >= e.N || j >= e.N) return false;
    return e.mask[j * e.N + i] === 1;
  }

  /* ------------------------------------------------------------------ *
   * rock
   * ------------------------------------------------------------------ */

  /**
   * Plant one schist mass. `strike` is the plan bearing of the long axis; the
   * instance is yawed by −strike so the local +X (which the slab builder used
   * as the strike axis) lands on it and the foliation comes out globally
   * consistent — the single most important cue for "this is Otago schist".
   */
  _addRock(field, opt) {
    const { x, z, length, height, width, strike, rng } = opt;
    const y = opt.y ?? this.probe.height(x, z);
    // Rocks are *in* the snow, not on it: sink by a fraction of their height
    // plus whatever the local pack is, so nothing reads as a decal. The old
    // 0.16 h + 0.5 m cap left the small plates sitting on the surface with a
    // razor snow/rock intersection all round — checklist 31, and named in
    // §11.23 as one of the most damning tells in the document.
    // …and 0.26 h was still not enough at range. `terrain.getHeight()` is a
    // bilinear tap on the 2 m heightfield, but the *rendered* surface is a
    // clipmap whose ring at 300–500 m carries 16 m posts (terrain.js
    // LOD_LEVELS): on a convex shoulder the drawn mesh sits below the sampled
    // height by a good fraction of a metre, and a rock keyed to the sampled
    // height stands clear of it with daylight underneath. Sinking a further
    // 6% of the footprint (capped at 40 cm so nothing small is buried)
    // swallows that reconstruction error without changing how anything reads
    // in the near field, where the two agree to centimetres.
    const lodSink = Math.min(0.40, 0.06 * Math.max(length, width));
    const sink = opt.sink ?? (0.30 * height + lodSink + Math.min(0.70, (opt.depth ?? 0.3) * 1.15));
    _e.set(rng.range(-0.10, 0.10), -strike, rng.range(-0.10, 0.10), 'YXZ');
    _q.setFromEuler(_e);
    _v3.set(x, y - sink, z);
    _v3b.set(length, height + sink, width);
    _m4.compose(_v3, _q, _v3b);
    // Base tint: schist varies from grey-green to a rusty weathered rind. The
    // band is centred just under 1.0 rather than just over it — the previous
    // 0.94–1.25 range brightened the whole population, and a schist outcrop
    // that out-values the snow it sits in fails §12 outright.
    const rust = clamp01(rng() * 0.9 - 0.35);
    _col.setRGB(
      lerp(0.84, 1.04, rust) * rng.range(0.93, 1.05),
      lerp(0.87, 0.92, rust) * rng.range(0.94, 1.04),
      lerp(0.92, 0.78, rust) * rng.range(0.93, 1.04),
    );
    const radius = Math.max(length, width, height + sink) * 0.62;
    field.add(_m4, radius, _col);

    if (height >= 1.15 && this._colliders.length < 1400) {
      this._colliders.push({
        type: 'box',
        position: new THREE.Vector3(x, y - sink + (height + sink) * 0.45, z),
        halfExtents: new THREE.Vector3(length * 0.38, (height + sink) * 0.46, width * 0.38),
        quaternion: _q.clone(),
        tag: 'rock',
      });
    }

    // Lee drift collar. Snow loads downwind of anything standing proud, and
    // the collar is what removes the hard rock/snow intersection at the base.
    //
    // The gate used to be `height > 0.9`, which excluded almost the whole
    // population: an outcrop at the small end of the range is 0.35–0.9 m tall
    // and every blockfield plate and talus block is under 0.5 m, so the frame
    // was full of rock meeting snow at a geometric edge with no collar in
    // sight. 0.34 m is roughly where a drift stops being a lump and starts
    // being a tail, so that is where the gate belongs.
    if (this.driftField && this.tune.rock.driftCollars && height > 0.22) {
      const scale = Math.max(length, width);
      const dx = this.wind.x, dz = this.wind.z;
      // Offset the mound so its steep face hugs the rock and the tail runs off.
      const ox = x + dx * scale * 0.18, oz = z + dz * scale * 0.18;
      const gy = this.probe.height(ox, oz);
      _e.set(0, this.windYaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      // Sunk far enough that the mound's own base ring is under the surface;
      // a collar resting on the snow is the same decal problem one level up.
      _v3.set(ox, gy - 0.30 - 0.10 * scale, oz);
      const rr = scale * rng.range(0.80, 1.20);
      _v3b.set(
        rr,
        Math.min(height * 0.62, 1.6) * rng.range(0.65, 1.05) + 0.34 + 0.10 * scale,
        rr * 0.85,
      );
      _m4.compose(_v3, _q, _v3b);
      this.driftField.add(_m4, rr * 1.6, null);
    }
  }

  _placeRocks() {
    this._buildExclusion();
    const T = this.tune;
    const density = clamp(T.density ?? 1, 0.05, 4);

    // Every level writes to the shadow map. At a 10.6° sun a 3 m outcrop owes
    // a 16 m shadow, and that shadow bar is the only thing in the frame that
    // says the rock is *in* the snow rather than pasted on it (checklist 24,
    // 31). Restricting the shadow pass to the near LOD meant every rock past
    // ~250 m — i.e. all of them, in a wide preset — cast nothing at all.
    this.torField = this._field('tor', this.rockMat, this.geo.tor, {
      useColor: true, shadowLevels: 3, cullAngular: 0.0022,
    });
    // Cull ordering is load-bearing: the drift collars (below) must outlive
    // the rocks they skirt, or every distant rock sheds its collar and reads
    // as a chip sitting ON the snow — the round-3 "talus confetti" tell. The
    // small-rubble angular thresholds are also raised outright: a 6 px pale
    // fleck on a crest at 800 m carries no geology, only noise.
    this.outcropField = this._field('outcrop', this.rockMat, this.geo.outcrop, {
      useColor: true, shadowLevels: 3, cullAngular: 0.0040,
    });
    this.blockField = this._field('block', this.rockMat, this.geo.block, {
      useColor: true, shadowLevels: 2, cullAngular: 0.0060,
    });
    // The collar casts: a 1 m mound under a 10.6° sun lays down a 5 m shadow
    // bar, and that bar is most of what tells the viewer the rock is *in* the
    // snow rather than pasted on it. Only the near LOD writes to the map.
    this.driftField = this._field('rock-drift', this.snowMat, this.geo.drift, {
      castShadow: true, receiveShadow: true, shadowLevels: 1, cullAngular: 0.0034,
    });

    const rng = makeRng(this._seed('rock'));
    const P = this.probe;

    /* -- 1. Terrain's own tor register (crest plateau + both spur crests) -- */
    const clusters = this.features.torClusters || [];
    for (const c of clusters) {
      for (const t of c.tors || []) {
        const s = P.sample(t.x, t.z);
        this._addRock(this.torField, {
          x: t.x, z: t.z, y: Number.isFinite(t.y) ? t.y : s.height,
          length: t.length ?? 6, height: t.height ?? 3, width: t.width ?? 3,
          strike: t.yaw ?? FOLIATION_STRIKE, rng, depth: s.depth,
        });
        // A scatter of frost-shattered plates around the base of each tor:
        // periglacial blockfield is what tors shed, and it kills the "single
        // object dropped on a smooth plane" look.
        const n = rng.int(1, 4);
        for (let i = 0; i < n; i++) {
          const a = rng() * TAU;
          const r = (t.length ?? 6) * rng.range(0.6, 1.9);
          const bx = t.x + Math.cos(a) * r, bz = t.z + Math.sin(a) * r;
          if (Math.abs(bx) > 1010 || Math.abs(bz) > 1010) continue;
          const bs = P.sample(bx, bz);
          if (bs.depth > 0.55) continue;
          const l = rng.range(0.5, 1.6);
          this._addRock(this.blockField, {
            x: bx, z: bz, y: bs.height, length: l, height: l * rng.range(0.18, 0.42),
            width: l * rng.range(0.5, 0.85), strike: FOLIATION_STRIKE + rng.range(-0.25, 0.25),
            rng, depth: bs.depth,
          });
        }
      }
    }

    /* -- 2. Free-standing outcrops wherever the snow cannot hold ---------- */
    // Rock shows on rib crests, bluff faces, tor tops and anything sluffed
    // clean; the density field bunches them where the pack is thinnest so the
    // blue-noise radius does the clustering for us.
    const b = P.bounds;
    const outcrops = poissonScatter(rng, {
      minX: b.minX + 12, maxX: b.maxX - 12, minZ: b.minZ + 12, maxZ: b.maxZ - 12,
      rMin: 13, rMax: 62, k: 9,
      limit: Math.round(T.rock.scatterLimit * density),
      seedBudget: 24000,
      radiusAt: (x, z) => {
        const s = P.sample(x, z);
        // Thin pack and high exposure → tight spacing → a real outcrop field.
        const bare = clamp01(1 - s.depth / 0.6) * 0.6 + clamp01(s.exposure) * 0.4;
        return lerp(62, 13, clamp01(bare));
      },
      accept: (x, z) => {
        if (this._cleared(x, z)) return false;
        const s = P.sample(x, z);
        const slopeDeg = s.slope / DEG;
        if (s.surface === 'groomed') return false;
        const bare = s.surface === 'rock' || s.depth < 0.24 || slopeDeg > 43;
        if (!bare) return false;
        // Nothing free-standing on a face too steep to have a footing.
        return slopeDeg < 62;
      },
    });
    for (let i = 0; i < outcrops.count; i++) {
      const x = outcrops.x[i], z = outcrops.z[i];
      const s = P.sample(x, z);
      // TERRAIN_BRIEF §1.2 item 3 sizes an Otago tor at 1.5–8 m tall and
      // 2–15 m long. Weighting the population toward the top of that band and
      // cutting the head-count in the same breath trades a uniform sprinkle
      // of 2 px specks for a handful of masses with a legible silhouette,
      // which is what checklist 32 is asking for.
      const big = rng() < 0.42;
      const len = big ? rng.range(7, 15) : rng.range(3.0, 7.5);
      this._addRock(this.outcropField, {
        x, z, y: s.height,
        length: len,
        // Taller than it was. A slab stack with a height/length ratio near 0.2
        // presents almost nothing but its up-facing caps, every one of which
        // loads snow — which is exactly why the outcrops came back as pale
        // rounded lozenges with no rock visible in them at all. The literature
        // has Otago tor faces "mostly exceeding 75°"; 0.34–0.85 puts the flank
        // angle where it belongs and gives the schist somewhere to show.
        height: len * rng.range(0.34, 0.85) * (big ? 1.0 : 0.85),
        width: len * rng.range(0.35, 0.70),
        strike: FOLIATION_STRIKE + rng.range(-0.12, 0.12),
        rng, depth: s.depth,
      });
    }

    /* -- 3. Crest blockfield: flat-lying angular plates on the scoured top - */
    const plates = poissonScatter(makeRng(this._seed('blockfield')), {
      minX: -1000, maxX: 1000, minZ: 720, maxZ: 1010,
      rMin: 3.2, rMax: 11, k: 8,
      limit: Math.round(T.rock.blockLimit * density),
      seedBudget: 14000,
      radiusAt: (x, z) => {
        const s = P.sample(x, z);
        return lerp(3.2, 11, clamp01(s.depth / 0.35));
      },
      accept: (x, z) => {
        if (this._cleared(x, z)) return false;
        const s = P.sample(x, z);
        return s.height > 1800 && s.depth < 0.30 && s.slope / DEG < 24;
      },
    });
    for (let i = 0; i < plates.count; i++) {
      const x = plates.x[i], z = plates.z[i];
      const s = P.sample(x, z);
      // Periglacial blockfield plates are metre-scale, not decimetre-scale,
      // and a plate that reads as a sub-pixel speck is noise in the frame
      // rather than geology. The explicit `sink` is kept — a flat-lying plate
      // is not a tor and must not be swallowed — but it now clears the 2 m
      // heightfield's own reconstruction error.
      const l = rng.range(0.7, 2.4);
      this._addRock(this.blockField, {
        x, z, y: s.height, length: l,
        height: l * rng.range(0.16, 0.34), width: l * rng.range(0.55, 0.9),
        strike: FOLIATION_STRIKE + rng.range(-0.35, 0.35),
        rng, depth: s.depth, sink: l * 0.14 + 0.10,
      });
    }
  }

  /**
   * Bluff bands. The terrain already builds the 55–80° face strip; what it
   * cannot do on a 2 m heightfield is the broken edge — so this adds blocky
   * teeth standing proud of the lip and a talus apron at the toe, which is
   * where a real schist bluff sheds its plates.
   */
  _placeBluffRubble() {
    const T = this.tune;
    const rng = makeRng(this._seed('bluff.rubble'));
    const P = this.probe;
    const bluffs = this.features.bluffs || [];
    // Share the budget out so the first band does not eat the lot.
    const perBand = Math.max(
      12,
      Math.floor(T.rock.talusLimit * clamp(T.density ?? 1, 0.05, 4) / Math.max(1, bluffs.length)),
    );

    for (const bl of bluffs) {
      let budget = perBand;
      const height = bl.height ?? 12;
      walkPolyline(bl.pts, 7, (x, z) => {
        if (budget <= 0) return;
        // Downhill direction from the local surface normal (the bluff faces
        // down the fall line, but the ribbon meanders, so measure it).
        const n = P.normal(x, z, _v3);
        let dx = n.x, dz = n.z;
        const l = Math.hypot(dx, dz);
        if (l < 1e-3) { dx = 0; dz = -1; } else { dx /= l; dz /= l; }

        // Teeth on the lip.
        if (rng() < 0.10) {
          const ux = x - dx * rng.range(1.5, 5), uz = z - dz * rng.range(1.5, 5);
          const s = P.sample(ux, uz);
          // Ledges, not teeth: the chairlift reference shows crest rock as
          // blocky clusters wider than they are tall, draped in snow.
          const len = rng.range(2.2, 5.5);
          this._addRock(this.outcropField, {
            x: ux, z: uz, y: s.height, length: len,
            height: len * rng.range(0.18, 0.42), width: len * rng.range(0.65, 1.05),
            strike: FOLIATION_STRIKE + rng.range(-0.15, 0.15), rng, depth: s.depth,
          });
          budget--;
        }
        // Talus apron at the toe: plates get smaller and denser downslope.
        const nBlocks = rng.int(1, 3);
        for (let i = 0; i < nBlocks && budget > 0; i++) {
          const run = height / Math.tan(60 * DEG) + rng.range(2, 26);
          const jitter = rng.range(-6, 6);
          const bx = x + dx * run - dz * jitter;
          const bz = z + dz * run + dx * jitter;
          if (Math.abs(bx) > 1015 || Math.abs(bz) > 1015) continue;
          const s = P.sample(bx, bz);
          const fall = 1 - smoothstep(4, 30, run);
          const len = rng.range(0.4, 2.4) * (0.5 + fall);
          this._addRock(this.blockField, {
            x: bx, z: bz, y: s.height, length: len,
            height: len * rng.range(0.30, 0.70), width: len * rng.range(0.55, 0.9),
            strike: FOLIATION_STRIKE + rng.range(-0.6, 0.6), rng, depth: s.depth,
          });
          budget--;
        }
      });
    }
  }

  /**
   * Avalanche debris. Every couloir mouth on the headwall base arc and every
   * gap in the bluff band runs sluff, and the pile at the bottom is chunky,
   * angular slab — a completely different snow texture from the smooth apron
   * around it, and one of the few things that tells the viewer the slope is
   * steep enough to slide.
   */
  _placeAvalancheDebris() {
    const T = this.tune;
    const rng = makeRng(this._seed('debris'));
    const P = this.probe;

    this.debrisField = this._field('avalanche-debris', this.snowMat, this.geo.snowBlock, {
      castShadow: true, receiveShadow: true, shadowLevels: 1, cullAngular: 0.0028,
    });

    const budgetTotal = Math.round(T.debris.limit * clamp(T.density ?? 1, 0.05, 4));
    const mouths = [];
    for (const g of this.features.gullies || []) {
      mouths.push({
        x: FOCUS_X + Math.sin(g.phi) * BASE_R,
        z: FOCUS_Z + Math.cos(g.phi) * BASE_R,
        len: 135, spread: 62,
      });
    }
    // The two through-routes in the bluff band funnel sluff onto the flats.
    for (const [gx, gz] of [[-190, -185], [230, -190]]) {
      mouths.push({ x: gx, z: gz, len: 90, spread: 42 });
    }
    if (!mouths.length) return;

    const per = Math.max(20, Math.floor(budgetTotal / mouths.length));
    for (const m of mouths) {
      // The fall line at the mouth, taken from the surface normal — correct
      // for the headwall couloirs (which drain toward the cirque focus) and
      // for the bluff gaps (which are below it) alike.
      const n = P.normal(m.x, m.z, _v3);
      let ddx = n.x, ddz = n.z;
      let dl = Math.hypot(ddx, ddz);
      if (dl < 1e-3) {
        // Dead flat: fall back to "inward from the crest".
        ddx = FOCUS_X - m.x; ddz = FOCUS_Z - m.z;
        dl = Math.hypot(ddx, ddz) || 1;
      }
      ddx /= dl; ddz /= dl;

      const pts = poissonScatter(rng, {
        minX: m.x - m.spread * 2.4, maxX: m.x + m.spread * 2.4,
        minZ: m.z - m.len * 1.4, maxZ: m.z + m.len * 0.4,
        rMin: 2.4, rMax: 9, k: 7, limit: per, seedBudget: per * 26,
        radiusAt: () => rng.range(2.4, 6.5),
        accept: (x, z) => {
          const rx = x - m.x, rz = z - m.z;
          const along = rx * ddx + rz * ddz;
          if (along < 2 || along > m.len) return false;
          const across = Math.abs(-rx * ddz + rz * ddx);
          const w = lerp(16, m.spread, along / m.len);
          if (across > w) return false;
          const s = P.sample(x, z);
          // Debris lies where the slope flattens out, not on the face itself.
          return s.slope / DEG < 34 && s.surface !== 'groomed';
        },
      });

      for (let i = 0; i < pts.count; i++) {
        const x = pts.x[i], z = pts.z[i];
        const s = P.sample(x, z);
        const rx = x - m.x, rz = z - m.z;
        const along = clamp01((rx * ddx + rz * ddz) / m.len);
        // Runout: blocks are biggest near the top of the fan and get buried
        // and rounded as the pile thins downslope.
        const size = lerp(2.1, 0.55, along) * rng.range(0.55, 1.35);
        _e.set(rng.range(-0.30, 0.30), rng() * TAU, rng.range(-0.30, 0.30), 'YXZ');
        _q.setFromEuler(_e);
        const hgt = size * rng.range(0.32, 0.72);
        _v3.set(x, s.height - hgt * 0.42, z);
        _v3b.set(size, hgt, size * rng.range(0.6, 0.95));
        _m4.compose(_v3, _q, _v3b);
        this.debrisField.add(_m4, size * 0.7, null);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * cornices and wind-drift lips
   * ------------------------------------------------------------------ */

  /** Register a merged static mesh. */
  _static(geometry, material, name, opts = {}) {
    if (!geometry || !geometry.attributes.position || geometry.attributes.position.count === 0) {
      geometry?.dispose?.();
      return null;
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = opts.castShadow ?? true;
    mesh.receiveShadow = opts.receiveShadow ?? true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.object3D.add(mesh);
    this.statics.push(mesh);
    return mesh;
  }

  /**
   * The crest cornice and the spur-crest drift lips.
   *
   * The terrain caps the cornice at 0° because a heightfield cannot overhang
   * (TERRAIN_BRIEF §2.5 hands this to us explicitly). The silhouette of an
   * overhanging lip against the sky, and the deep-blue undercut beneath it,
   * are two of the highest-value things on the whole crest — this is what the
   * hero shot is looking at from the `broadway-gate` spawn.
   */
  /**
   * Slide a station sideways onto the crest the finished heightfield actually
   * has, searching ±`reach` along (ax, az).
   *
   * The spur polylines in the feature register are the *generators* of the
   * landform, not its crest: `terrain._phaseLandforms` lays a Gaussian ridge
   * over them and then five more bands — ridged multifractal, ribs, rollovers,
   * scour — move the local high point by tens of metres. A ribbon left on the
   * generator line runs across the flank instead of capping the ridge, which
   * is the "ridge resolving into stacked horizontal shelves" read in
   * `shots/r3/west-spur.png`.
   */
  _snapToCrest(x, z, ax, az, reach, steps, prevOff, maxDelta) {
    const P = this.probe;
    const lo = Number.isFinite(prevOff) ? prevOff - maxDelta : -reach;
    const hi = Number.isFinite(prevOff) ? prevOff + maxDelta : reach;
    let bestOff = clamp(Number.isFinite(prevOff) ? prevOff : 0, lo, hi);
    let best = P.height(x + ax * bestOff, z + az * bestOff);
    for (let i = -steps; i <= steps; i++) {
      // The offset is clamped to a window around the previous station's, so
      // the ribbon walks the crest continuously instead of teleporting to
      // whichever local bump happens to win a ±26 m search.
      const off = clamp((i / steps) * reach, lo, hi);
      const h = P.height(x + ax * off, z + az * off);
      if (h > best) { best = h; bestOff = off; }
    }
    return { x: x + ax * bestOff, z: z + az * bestOff, h: best, off: bestOff };
  }

  /**
   * Build one cornice station, sampling the terrain separately under every
   * rail the ribbon will emit, and rejecting ground that cannot carry a
   * cornice at all.
   *
   * The acceptance test is a **convexity test over a 10 m baseline**, not a
   * gradient test over the overhang length. A cornice crown sits a couple of
   * metres lee of the topographic maximum, and the ground immediately either
   * side of a broad spur crest is close to level — measuring the drop across
   * 1–3 m rejects every real crest on the map (measured: 244 of 313 stations)
   * while still accepting a bench on a planar face, which is the shape we
   * actually need to keep out.
   */
  _corniceStation(x, z, lx, lz, lip, over) {
    const P = this.probe;
    // Sit the crown just into the lee, where snow genuinely accumulates.
    const cx = x + lx * 1.5, cz = z + lz * 1.5;
    const ground = P.height(cx, cz);
    // Lee must fall away, windward must not tower over us. The windward
    // tolerance is generous because the headwall cornice has the crest plateau
    // behind it, which genuinely does keep rising for a while.
    if (ground - P.height(cx + lx * 10, cz + lz * 10) < 0.55) return null;
    if (ground - P.height(cx - lx * 10, cz - lz * 10) < -1.6) return null;
    return {
      x: cx, z: cz, lx, lz, lip, over, ground,
      hRoot: P.height(cx - lx * CORNICE_ROOT, cz - lz * CORNICE_ROOT),
      hMid: P.height(cx - lx * CORNICE_MID, cz - lz * CORNICE_MID),
      hToe: P.height(cx + lx * over * 0.55, cz + lz * over * 0.55),
    };
  }

  _buildCornices() {
    const rng = makeRng(this._seed('cornice'));
    const P = this.probe;
    const stations = [];

    /**
     * Close a run. Both ends fade their lip and overhang to almost nothing,
     * because a run that simply stops leaves a full-height cross-section
     * hanging in the air — a hard-edged wedge plate with a dark gap under it,
     * which is precisely the residue the round-3 critique still measured on
     * the spur crest at x 690–820.
     */
    const pushRun = (run) => {
      const n = run.length;
      if (n < 4) { run.length = 0; return; }
      const fade = Math.min(3, (n - 1) / 2);
      for (let i = 0; i < n; i++) {
        const k = smoothstep(0, fade, Math.min(i, n - 1 - i));
        run[i].lip *= 0.10 + 0.90 * k;
        run[i].over *= 0.08 + 0.92 * k;
      }
      stations.push(...run, null);
      run.length = 0;
    };

    /* -- Crest arc (headwall lip) ----------------------------------------- */
    for (const seg of this.features.cornice || []) {
      const arcLen = Math.abs(seg.phi1 - seg.phi0) * CREST_R;
      if (arcLen < 12) continue;
      const steps = Math.max(4, Math.round(arcLen / 5));
      const run = [];
      let off = NaN;
      // A single rejected station is bridged rather than ending the run: at
      // 5 m spacing one bad sample on an otherwise good crest would otherwise
      // shatter a 200 m cornice into stubs, and stubs are what read as
      // detached plates.
      let miss = 0;
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const phi = lerp(seg.phi0, seg.phi1, u);
        const cx = FOCUS_X + Math.sin(phi) * CREST_R;
        const cz = FOCUS_Z + Math.cos(phi) * CREST_R;
        if (Math.abs(cx) > 1010 || Math.abs(cz) > 1010) { pushRun(run); off = NaN; miss = 0; continue; }
        // Downhill on the headwall is radially inward, toward the focus.
        const lx = -Math.sin(phi), lz = -Math.cos(phi);
        // The rim sits within a few metres of the nominal arc; find it.
        const c = this._snapToCrest(cx, cz, lx, lz, 14, 8, off, 2.5);
        off = c.off;
        // Taper both ends to nothing so a segment never terminates in a wall.
        const taper = Math.sin(Math.PI * clamp01(u)) ** 0.55;
        const lip = (seg.lip ?? 2.4) * taper * rng.range(0.88, 1.12);
        const st = lip < 0.15
          ? null
          : this._corniceStation(c.x, c.z, lx, lz, lip, lip * rng.range(1.15, 1.75));
        if (st) { run.push(st); miss = 0; } else if (++miss >= 2) { pushRun(run); off = NaN; }
      }
      pushRun(run);
    }

    /* -- Spur crests: lee-side wind pillows and small cornices ------------ */
    // Wind from 292° loads the −X flank of every spur and rib. The lip there
    // is smaller than the crest cornice but there is a lot of it, and it is
    // what makes the same slope read differently 40 m apart.
    for (const spur of this.features.spurs || []) {
      const run = [];
      const carry = rng.range(0, 60);
      let off = NaN;
      let miss = 0;
      walkPolyline(spur.pts, 6, (x, z, tx, tz, s) => {
        // Present over ~55% of the crest in 40–110 m segments.
        if (((s + carry) % 150) >= 82) { pushRun(run); off = NaN; miss = 0; return; }
        if (Math.abs(x) > 1000 || Math.abs(z) > 1000) { pushRun(run); off = NaN; miss = 0; return; }
        // Search across the run for the real crest before anything else. 3 m
        // of lateral movement per 6 m of travel keeps the ribbon smooth.
        const c = this._snapToCrest(x, z, -tz, tx, 26, 13, off, 3.0);
        off = c.off;
        // Lee side = whichever perpendicular runs downwind.
        let lx = -tz, lz = tx;
        if (lx * this.wind.x + lz * this.wind.z < 0) { lx = -lx; lz = -lz; }
        const lip = rng.range(0.45, 1.35);
        const st = this._corniceStation(c.x, c.z, lx, lz, lip, lip * rng.range(1.3, 2.1));
        if (st) { run.push(st); miss = 0; } else if (++miss >= 2) { pushRun(run); off = NaN; }
      });
      pushRun(run);
    }

    if (stations.length) {
      this._static(buildCorniceRibbon(stations), this.snowMat, 'props-cornice', {
        castShadow: true, receiveShadow: true,
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * marker poles and flags
   * ------------------------------------------------------------------ */

  /**
   * Bamboo marker poles. On a real NZ ski field the piste edges and every
   * benched traverse are poled at ~20 m, and because a pole is a known height
   * it is the cheapest unambiguous scale cue in the frame (§9.4). At a 10.6°
   * sun each one also lays down an 11 m shadow bar across the fall line, which
   * is worth as much again for reading the terrain's shape.
   */
  _placePoles() {
    const T = this.tune;
    const rng = makeRng(this._seed('poles'));
    const P = this.probe;

    this.poleField = this._field('marker-pole', this.poleMat, this.geo.pole, {
      castShadow: true, receiveShadow: true, shadowLevels: 2, cullAngular: 0.0038,
    });
    // The flags are one of the three sanctioned high-chroma accents (§9.2) and
    // they were being culled at ~210 m, which is inside every wide preset's
    // near field. A 0.34 m flag is sub-pixel by 400 m, but a poled corridor
    // running away from camera is a dotted orange line, and that line is worth
    // more to the frame than the individual quads are.
    this.flagField = this._field('marker-flag', this.flagMat, this.geo.flag, {
      castShadow: false, receiveShadow: true, cullAngular: 0.0008,
    });

    let budget = Math.round(T.poles.limit * clamp(T.density ?? 1, 0.05, 4));

    const plant = (x, z, withFlag) => {
      if (budget <= 0) return false;
      if (Math.abs(x) > 1015 || Math.abs(z) > 1015) return false;
      const s = P.sample(x, z);
      if (s.slope / DEG > 42) return false;
      const y = s.height;
      // Poles lean a little; a field of perfectly plumb poles reads as CAD.
      _e.set(rng.range(-0.075, 0.075), rng() * TAU, rng.range(-0.075, 0.075), 'YXZ');
      _q.setFromEuler(_e);
      _v3.set(x, y, z);
      const h = rng.range(0.92, 1.08);
      _v3b.set(1, h, 1);
      _m4.compose(_v3, _q, _v3b);
      this.poleField.add(_m4, 1.25, null);
      budget--;

      if (withFlag) {
        // The flag streams downwind off the pole top.
        _e.set(0, this.windYaw + rng.range(-0.35, 0.35), 0, 'YXZ');
        _q.setFromEuler(_e);
        _v3.set(x, y + 2.15 * h - 0.20, z);
        _v3b.set(1, 1, 1);
        _m4.compose(_v3, _q, _v3b);
        _col.setRGB(rng.range(0.92, 1.10), rng.range(0.90, 1.06), rng.range(0.88, 1.08));
        this.flagField.add(_m4, 0.34, _col);
      }
      // A drift tail at the base: a pole planted in snow always has one, and
      // without it the pole looks stabbed through a sheet of paper.
      if (this.driftField && rng() < 0.55) {
        _e.set(0, this.windYaw, 0, 'YXZ');
        _q.setFromEuler(_e);
        _v3.set(x + this.wind.x * 0.35, y - 0.16, z + this.wind.z * 0.35);
        const r = rng.range(0.7, 1.5);
        _v3b.set(r, rng.range(0.12, 0.30), r * 0.8);
        _m4.compose(_v3, _q, _v3b);
        this.driftField.add(_m4, r * 1.5, null);
      }
      return true;
    };

    /* -- Both edges of every groomed corridor ----------------------------- */
    for (const c of this.features.corridors || []) {
      const off = (c.halfWidth ?? 20) + 1.4;
      let i = 0;
      walkPolyline(c.pts, T.poles.corridorSpacing, (x, z, tx, tz) => {
        const px = -tz, pz = tx;
        const j = rng.range(-1.6, 1.6);
        plant(x + px * off + tx * j, z + pz * off + tz * j, true);
        plant(x - px * off + tx * j, z - pz * off + tz * j, true);
        i++;
      });
      void i;
    }

    /* -- Downhill edge of each benched traverse --------------------------- */
    for (const t of this.features.tracks || []) {
      const off = (t.halfWidth ?? 3) + 1.1;
      walkPolyline(t.pts, T.poles.trackSpacing, (x, z, tx, tz) => {
        // Pick the perpendicular that goes downhill.
        const px = -tz, pz = tx;
        const hA = P.height(x + px * off, z + pz * off);
        const hB = P.height(x - px * off, z - pz * off);
        const s = hA < hB ? 1 : -1;
        plant(x + px * off * s, z + pz * off * s, true);
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * boundary fencing and hazard netting
   * ------------------------------------------------------------------ */

  _placeFences() {
    const T = this.tune;
    const rng = makeRng(this._seed('fence'));
    const P = this.probe;

    this.fencePostField = this._field('fence-post', this.poleMat, this.geo.fencePost, {
      castShadow: true, receiveShadow: true, shadowLevels: 2, cullAngular: 0.0016,
    });

    let budget = Math.round(T.fence.limit * clamp(T.density ?? 1, 0.05, 4));
    const netStations = [];
    const ropeStations = [];
    const postH = T.fence.postHeight ?? 1.85;

    const post = (x, z, out) => {
      if (budget <= 0) return;
      if (Math.abs(x) > 1015 || Math.abs(z) > 1015) { out.push(null); return; }
      const s = P.sample(x, z);
      if (s.slope / DEG > 44) { out.push(null); return; }
      // Height and lean come off a metre-scale noise rather than per-post
      // white noise, so consecutive posts agree with their neighbours and the
      // run wanders the way a hand-strung fence does instead of stepping
      // randomly — the difference between "fence" and "ruler".
      const w = this.simp.noise2D(x * 0.09, z * 0.09);
      const w2 = this.simp.noise2D(x * 0.031 + 41.7, z * 0.031 - 18.3);
      const h = postH * clamp(1 + w * 0.11 + w2 * 0.06, 0.78, 1.20);
      _e.set(w2 * 0.085 + rng.range(-0.03, 0.03), rng() * TAU, w * 0.085 + rng.range(-0.03, 0.03), 'YXZ');
      _q.setFromEuler(_e);
      // Sunk 0.15–0.30 m below the surface: a post driven into windpack sits
      // in a small crater, and a post whose base stops exactly on the drawn
      // surface is the decal tell one scale down.
      _v3.set(x, s.height - 0.15 - 0.15 * clamp01(w * 0.5 + 0.5), z);
      _v3b.set(1, h, 1);
      _m4.compose(_v3, _q, _v3b);
      this.fencePostField.add(_m4, h * 0.75, null);
      budget--;
      // A drift collar at every third post. The fence line is the one place
      // in the frame where a whole *row* of contact points is visible at once,
      // so getting the contact wrong there is visible as a pattern.
      if (this.driftField && rng() < 0.34) {
        _e.set(0, this.windYaw, 0, 'YXZ');
        _q.setFromEuler(_e);
        _v3.set(x + this.wind.x * 0.30, s.height - 0.18, z + this.wind.z * 0.30);
        const r = rng.range(0.55, 1.15);
        _v3b.set(r, rng.range(0.14, 0.32), r * 0.8);
        _m4.compose(_v3, _q, _v3b);
        this.driftField.add(_m4, r * 1.5, null);
      }
      out.push({ x, y: s.height, z, h: Math.min(T.fence.netHeight, h - 0.85) });
    };

    /* -- Orange hazard netting along the top of every bluff band ---------- */
    // A roped-and-netted cliff edge is the single most recognisable "this is a
    // patrolled ski area" object there is, and the orange is one of the three
    // small high-chroma accents the colour recipe allows (§9.2).
    for (const bl of this.features.bluffs || []) {
      const run = [];
      walkPolyline(bl.pts, T.fence.postSpacing, (x, z) => {
        const n = P.normal(x, z, _v3);
        let dx = n.x, dz = n.z;
        const l = Math.hypot(dx, dz);
        if (l < 1e-3) { dx = 0; dz = 1; } else { dx = -dx / l; dz = -dz / l; }
        // 8 m back from the lip, on the uphill side.
        post(x + dx * 8, z + dz * 8, run);
      });
      if (run.length > 1) netStations.push(...run, null);
    }

    /* -- Rope-and-pole boundary on the run-out road and the east margin --- */
    const ropeRuns = [];
    const tracks = this.features.tracks || [];
    const home = tracks.find((t) => t.name === 'home-track') || tracks[tracks.length - 1];
    if (home) ropeRuns.push({ pts: home.pts, off: (home.halfWidth ?? 3) + 2.2, downhill: true });
    const east = (this.features.corridors || []).find((c) => c.name === 'east-side');
    if (east) ropeRuns.push({ pts: east.pts, off: (east.halfWidth ?? 18) + 9, downhill: false, side: 1 });

    for (const r of ropeRuns) {
      const run = [];
      walkPolyline(r.pts, T.fence.postSpacing + 1.5, (x, z, tx, tz) => {
        const px = -tz, pz = tx;
        let s = r.side ?? 1;
        if (r.downhill) {
          s = P.height(x + px * r.off, z + pz * r.off) < P.height(x - px * r.off, z - pz * r.off) ? 1 : -1;
        }
        post(x + px * r.off * s, z + pz * r.off * s, run);
      });
      if (run.length > 1) ropeStations.push(...run, null);
    }

    if (netStations.length) {
      // The stations carry their own net height (post height minus the free
      // post top), so the run's top edge follows the posts rather than sitting
      // at one constant offset above the ground line.
      const geo = buildNetting(netStations, T.fence.netHeight);
      this._static(geo, this.netMat, 'props-hazard-netting', { castShadow: true, receiveShadow: false });
      // The netting is hung on a rope along its top edge — with the same
      // catenary the netting has, so the two agree, and casting, because at
      // 10.6° even a 1.8 m post owes a 9.6 m shadow and the whole point of the
      // fence is the shadow ladder it lays across the fall line.
      const top = netStations.map((s) => (
        s ? { x: s.x, y: s.y + (Number.isFinite(s.h) ? s.h : T.fence.netHeight), z: s.z } : null
      ));
      this._static(buildRopeRun(top, 0.16, 0.030, [0.055, 0.058, 0.062]), this.ropeMat, 'props-net-rope', {
        castShadow: true, receiveShadow: false,
      });
    }
    if (ropeStations.length) {
      const mid = ropeStations.map((s) => (s ? { x: s.x, y: s.y + 0.98, z: s.z } : null));
      this._static(buildRopeRun(mid, 0.16, 0.030, [0.520, 0.098, 0.028]), this.ropeMat, 'props-boundary-rope', {
        castShadow: true, receiveShadow: false,
      });
      const low = ropeStations.map((s) => (s ? { x: s.x, y: s.y + 0.52, z: s.z } : null));
      this._static(buildRopeRun(low, 0.20, 0.024, [0.045, 0.048, 0.052]), this.ropeMat, 'props-boundary-rope-low', {
        castShadow: true, receiveShadow: false,
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * the chairlift
   * ------------------------------------------------------------------ */

  /**
   * The Soho Express: 14 towers over 379 m of rise and 1,318 m of slope
   * length, two haul-rope strands, moving six-packs and a shed at each end.
   *
   * A lift line does more work than any other single prop: it is the one
   * object in the frame whose scale the viewer knows absolutely, it draws a
   * long converging line up the mountain that reads depth instantly, and its
   * cable is a legitimate near-black silhouette against the sky in a scene
   * that otherwise has no true darks.
   */
  _buildLift() {
    const F = this.features.lift;
    if (!F || !F.base || !F.top) return;
    const T = this.tune;
    const rng = makeRng(this._seed('lift'));
    const P = this.probe;

    const ax = F.base.x, az = F.base.z, bx = F.top.x, bz = F.top.z;
    const dx = bx - ax, dz = bz - az;
    const runLen = Math.hypot(dx, dz) || 1;
    const tx = dx / runLen, tz = dz / runLen;
    const px = -tz, pz = tx;                 // cross-line, cable offset axis
    const yaw = Math.atan2(tx, tz);          // local +Z along the line
    const gauge = 2.6;                       // half the rope spacing

    // Both LOD levels write to the shadow map. A 9.5 m tower owes a 51 m
    // shadow at 10.6°, which would be one of the strongest compositional
    // elements in `hero-basin`; with `shadowLevels: 1` every tower past the
    // 0.020 rad detail threshold — which is anything beyond ~370 m — was
    // silently dropped from the shadow pass. (This is necessary, not
    // sufficient: see the note in the report about the single-frustum shadow
    // fit in sky.js, which is what is actually deleting the near towers'
    // shadows too.)
    this.towerField = this._field('lift-tower', this.steelMat, this.geo.tower, {
      castShadow: true, receiveShadow: true, shadowLevels: 2, cullAngular: 0.0012,
    });
    this.chairField = this._field('lift-chair', this.steelMat, this.geo.chair, {
      castShadow: true, receiveShadow: true, shadowLevels: 1, cullAngular: 0.0016,
    });

    /* -- Towers ----------------------------------------------------------- */
    const nTowers = Math.max(2, F.towers ?? T.lift.towers);
    const sheave = [];   // one entry per tower, plus a terminal at each end
    const terminalDrop = 22;   // towers start this far in from each terminal

    const addSheave = (x, z, y) => sheave.push({ x, y, z });
    addSheave(ax, az, P.height(ax, az) + 5.4);

    for (let i = 0; i < nTowers; i++) {
      const u = (i + 0.5) / nTowers;
      const s = terminalDrop + u * (runLen - terminalDrop * 2);
      const x = ax + tx * s, z = az + tz * s;
      const g = P.height(x, z);
      // Towers stand taller where the ground sags away under the span.
      const chord = lerp(P.height(ax, az), P.height(bx, bz), s / runLen);
      const hs = clamp(0.78 + (chord - g) * 0.035, 0.70, 1.45) * rng.range(0.97, 1.03);
      _e.set(0, yaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      _v3.set(x, g, z);
      _v3b.set(1, hs, 1);
      _m4.compose(_v3, _q, _v3b);
      this.towerField.add(_m4, 7.5 * hs, null);
      addSheave(x, z, g + 9.5 * hs + 0.05);

      // A wind-scoured moat and a lee drift around the base flange. Every mast
      // in `shots/r6/hero-basin.png` terminates on flat white with a razor
      // edge and no contact darkening whatever; a real tower foot sits in a
      // 3–4 m plough of drifted snow, and the collar is geometry that shades
      // itself even when the shadow pass is not helping.
      if (this.driftField) {
        _e.set(0, this.windYaw, 0, 'YXZ');
        _q.setFromEuler(_e);
        const ox = x + this.wind.x * 0.9, oz = z + this.wind.z * 0.9;
        const cr = rng.range(2.3, 3.4);
        _v3.set(ox, P.height(ox, oz) - 0.55, oz);
        _v3b.set(cr, rng.range(0.85, 1.35), cr * 0.82);
        _m4.compose(_v3, _q, _v3b);
        this.driftField.add(_m4, cr * 1.6, null);
      }

      this._colliders.push({
        type: 'box',
        position: new THREE.Vector3(x, g + 9.5 * hs * 0.5, z),
        halfExtents: new THREE.Vector3(0.62, 9.5 * hs * 0.5, 0.62),
        quaternion: new THREE.Quaternion(),
        tag: 'lift-tower',
      });
    }
    addSheave(bx, bz, P.height(bx, bz) + 5.4);

    /* -- Haul rope: catenary sag between every pair of sheaves ------------ */
    const path = [[], []];
    const cableGeo = new TriBuilder();
    const cableCol = [0.030, 0.032, 0.035];
    for (let side = 0; side < 2; side++) {
      const off = side === 0 ? gauge : -gauge;
      let prevRing = null;
      for (let i = 0; i < sheave.length - 1; i++) {
        const A = sheave[i], B = sheave[i + 1];
        const sx = B.x - A.x, sz = B.z - A.z;
        const span = Math.hypot(sx, sz) || 1;
        const sag = Math.min(2.6, span * 0.018);
        const N = 6;
        for (let s = (i === 0 ? 0 : 1); s <= N; s++) {
          const t = s / N;
          const x = A.x + sx * t + px * off;
          const z = A.z + sz * t + pz * off;
          const y = lerp(A.y, B.y, t) - sag * 4 * t * (1 - t);
          path[side].push({ x, y, z });
          // Triangular prism section — thin, dark, and it must survive at
          // 800 m, so it is not allowed to get any thinner than this. At 0.055
          // the haul rope is 0.36 px at the `hero-basin` framing and the
          // chairs read as detached red ticks with nothing joining them;
          // 0.085 holds a continuous line without becoming a drawn cable.
          const r = 0.085;
          const ring = [
            [x, y + r, z],
            [x + px * r * 0.87, y - r * 0.5, z + pz * r * 0.87],
            [x - px * r * 0.87, y - r * 0.5, z - pz * r * 0.87],
          ];
          if (prevRing) {
            for (let k = 0; k < 3; k++) {
              const k2 = (k + 1) % 3;
              cableGeo.quad(prevRing[k], prevRing[k2], ring[k2], ring[k], cableCol, cableCol, cableCol, cableCol);
            }
          }
          prevRing = ring;
        }
      }
      prevRing = null;
    }
    this._static(cableGeo.build('soho-cable'), this.steelMat, 'props-lift-cable', {
      castShadow: false, receiveShadow: false,
    });

    /* -- Terminals -------------------------------------------------------- */
    const term = new TriBuilder();
    pushTerminal(term, ax, P.height(ax, az) - 0.6, az, yaw, 11.0);
    pushTerminal(term, bx, P.height(bx, bz) - 0.6, bz, yaw, 7.0);
    this._static(term.build('soho-terminals'), this.steelMat, 'props-lift-terminals', {
      castShadow: true, receiveShadow: true,
    });

    // "Soho EXPRESS" fascia lettering on the base station (canvas texture -
    // procedural, like everything else). Faces down-run so it greets the
    // rider finishing a lap.
    {
      const cnv = document.createElement('canvas');
      cnv.width = 1024; cnv.height = 192;
      const g = cnv.getContext('2d');
      g.fillStyle = '#0b0c0f'; g.fillRect(0, 0, 1024, 192);
      g.fillStyle = '#f2f0ec'; g.textBaseline = 'middle';
      g.font = 'italic 900 118px system-ui, sans-serif';
      g.fillText('Soho', 96, 100);
      g.font = '600 104px system-ui, sans-serif';
      let xx = 420;
      for (const ch of 'EXPRESS') { g.fillText(ch, xx, 104); xx += 82; }
      const tex = new THREE.CanvasTexture(cnv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const signMat = new THREE.MeshStandardMaterial({
        map: tex, roughness: 0.5, metalness: 0.05,
        emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.22,
      });
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 1.42), signMat);
      const sy = P.height(ax, az) - 0.6 + 3.1;
      sign.position.set(ax - Math.sin(yaw) * 0.0 + Math.cos(yaw) * 0.0, sy, az);
      // sit just proud of the down-run gable end
      // On the broad eave fascia, like the reference photos - the face the
      // whole slope sees on the way in.
      const lz = 6.0 + 1.0 + 0.06;
      sign.position.set(ax + lz * Math.sin(yaw), sy + 0.35, az + lz * Math.cos(yaw));
      sign.rotation.y = -yaw;
      sign.name = 'props-lift-sign';
      this.object3D.add(sign);
    }
    for (const [cx, cz, len] of [[ax, az, 8.5], [bx, bz, 7.0]]) {
      this._colliders.push({
        type: 'box',
        position: new THREE.Vector3(cx, P.height(cx, cz) + 1.1, cz),
        halfExtents: new THREE.Vector3(len, 2.0, 4.6),
        quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ')),
        tag: 'lift-terminal',
      });
    }

    /* -- Chairs ----------------------------------------------------------- */
    // Precompute arc length along each strand so a chair can be placed by
    // distance travelled; the update loop then just moves one scalar.
    const strands = [];
    for (let side = 0; side < 2; side++) {
      const pts = path[side];
      if (pts.length < 2) continue;
      const cum = [0];
      for (let i = 1; i < pts.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z));
      }
      strands.push({ pts, cum, total: cum[cum.length - 1], dir: side === 0 ? 1 : -1 });
    }
    const spacing = T.lift.chairSpacing;
    const chairs = [];
    for (const st of strands) {
      const n = Math.max(1, Math.floor(st.total / spacing));
      for (let i = 0; i < n; i++) {
        const idx = this.chairField.add(_m4.identity(), 2.6, null);
        chairs.push({ strand: st, s0: i * spacing, idx });
      }
    }
    this._lift = { strands, chairs, speed: T.lift.chairSpeed, spacing };
    this._poseChairs(0);
  }

  /** Slide every chair along its strand. Pure function of `t`, so it diffs. */
  _poseChairs(t) {
    const L = this._lift;
    if (!L || !this.chairField || !this.chairField.matrices) return;
    const M = this.chairField.matrices;
    for (const c of L.chairs) {
      const st = c.strand;
      let s = (c.s0 + t * L.speed * st.dir) % st.total;
      if (s < 0) s += st.total;
      // Locate the segment (linear scan from a cached hint is overkill for 33).
      let i = 1;
      while (i < st.cum.length - 1 && st.cum[i] < s) i++;
      const a = st.pts[i - 1], b = st.pts[i];
      const seg = Math.max(1e-4, st.cum[i] - st.cum[i - 1]);
      const u = clamp01((s - st.cum[i - 1]) / seg);
      const x = lerp(a.x, b.x, u), y = lerp(a.y, b.y, u), z = lerp(a.z, b.z, u);
      const dx = (b.x - a.x) * st.dir, dz = (b.z - a.z) * st.dir;
      _e.set(0, Math.atan2(dx, dz), 0, 'YXZ');
      _q.setFromEuler(_e);
      _v3.set(x, y, z);
      _v3b.set(1, 1, 1);
      _m4.compose(_v3, _q, _v3b);
      _m4.toArray(M, c.idx * 16);
    }
  }

  /* ------------------------------------------------------------------ *
   * tussock
   * ------------------------------------------------------------------ */

  /**
   * Narrow-leaved snow tussock (*Chionochloa rigida*) in the wind-scoured
   * margins, and cushionfield above the belt. Against a white field these gold
   * patches are the most valuable natural colour accent we have (§2), and they
   * are the direct substitute for the reference set's trees.
   *
   * Scattered in two levels — blue-noise patch centres, then a jittered lattice
   * within each patch — because tussock genuinely grows in clumps separated by
   * bare fellfield, and a single flat Poisson over 2 km² would need an 9M-cell
   * background grid to resolve a 0.9 m spacing.
   *
   * **Why the gate is written the way it is.** Six rounds measured warm
   * high-chroma at 0.00–0.13% of frame against §9.2's 1.5–6%, and each round
   * moved the budget, the cull distance or the colour. None of those was the
   * problem. The predicate was, in two places:
   *
   *   1. `surface === 'rock'` was rejected. `terrain._phaseClassify` labels
   *      *any* post carrying under 10 cm of snow `rock`, and the depth field
   *      is explicitly bisected so that 5.5% of the basin sits there — so the
   *      single largest body of genuinely wind-scoured ground in the basin,
   *      the exact ground §6.2 asks for, was the first thing discarded.
   *   2. The 1,560 m ceiling. The basin runs 1,410–1,865 m and every wide
   *      preset frames 1,500–1,800 m, so the belt proper was almost entirely
   *      out of shot even when it did place.
   *
   * The rule below asks the three questions the art direction actually asks —
   * is this ground scoured, is it shallow enough to stand in, is it flat
   * enough to hold a plant — and takes elevation as a *size and species* cue
   * rather than an on/off switch. On the shipped seed it passes 4.4% of the
   * basin against the old rule's 1.2%, and 2.4% / 20% inside the `hero-basin`
   * and `west-spur` framings against 0.7% / 5.5%.
   */
  _placeTussock() {
    const T = this.tune.tussock;
    const density = clamp(this.tune.density ?? 1, 0.05, 4);
    const rng = makeRng(this._seed('tussock'));
    const P = this.probe;
    const b = P.bounds;

    this.tussockField = new ChunkedField('tussock', this.geo.tussock, this.tussockMat, {
      size: T.chunk, near: T.near, far: T.far, cull: T.cull, minFrac: T.minFrac,
      castShadow: false, receiveShadow: true, useColor: true,
    });
    this.chunked.push(this.tussockField);

    // `relax` widens the depth window on a retry: a lean scour year on some
    // future seed could still leave the belt thin, and a basin with no gold in
    // it at all loses the only saturated natural colour in the frame.
    let relax = 1;
    /**
     * Returns 0 (nothing grows here), 1 (tussock belt: tall gold *Chionochloa*)
     * or 2 (fellfield above the belt: shorter, sparser, a shade off gold). The
     * caller needs the class, not just a boolean, because the two are
     * different plants at different sizes.
     */
    const classify = (x, z) => {
      const s = P.sample(x, z);
      // A groomed piste is mown by a winch cat every night. Nothing else is
      // excluded by surface class — least of all `rock`, which is where
      // tussock grows.
      if (s.surface === 'groomed') return 0;
      const slopeDeg = s.slope / DEG;
      if (slopeDeg > T.maxSlopeDeg + relax * 3) return 0;
      // Wind-scoured, by any of the three channels the terrain exposes: a thin
      // pack, a high upwind-shelter index, or a convex shoulder (§6.2 —
      // "convex ridge shoulders and the windward side of outcrops").
      const scoured = s.depth <= T.scourDepth
        || s.exposure > T.scourExposure
        || s.curvature > T.scourCurvature;
      if (!scoured) return 0;
      // Tier 1 — the belt proper (TERRAIN_BRIEF §2.13).
      if (s.height <= T.maxElevation && s.depth <= T.maxDepth * relax) return 1;
      // Tier 2 — *Raoulia* cushionfield and *Aciphylla* above the belt, on
      // scoured ground only. Thinned by `fellfieldFrac` at placement.
      if (s.height <= T.fellfieldMaxElevation && s.depth <= T.fellfieldMaxDepth * relax) return 2;
      return 0;
    };
    const suitable = (x, z) => classify(x, z) !== 0;

    const scatterPatches = () => poissonScatter(makeRng(this._seed('tussock.patches') + relax), {
      minX: b.minX + 20, maxX: b.maxX - 20, minZ: b.minZ + 20, maxZ: b.maxZ - 20,
      // A *wide* blue-noise radius, deliberately. Bridson grows a connected
      // front from each seed and only re-seeds when that front dies, so a
      // tight radius lets the first eligible region absorb the entire patch
      // budget: at rMin 11 all twelve populated chunks came out west of
      // x = −380 and the `hero-basin` framing got nothing. At rMin 28 a patch
      // costs ~700 m² of the 180,000 m² eligible area, which is the whole
      // budget — so the sampler is forced to spread across every scoured
      // shoulder in the basin instead of carpeting one of them.
      rMin: 28, rMax: 88, k: 8, limit: T.patches, seedBudget: 40000,
      radiusAt: (x, z) => {
        // Denser patches where the wind has scoured hardest.
        const s = P.sample(x, z);
        return lerp(88, 28, clamp01(s.exposure * 0.7 + (1 - s.depth / T.maxDepth) * 0.4));
      },
      accept: (x, z) => (this._cleared(x, z) ? false : suitable(x, z)),
    });

    let patches = scatterPatches();
    while (patches.count < 90 && relax < 3) {
      relax++;
      patches = scatterPatches();
    }
    if (typeof console !== 'undefined' && CONFIG.debug?.verbose) {
      console.info(`[props] tussock: ${patches.count} patches at relax ${relax}`);
    }

    // Spread the budget across every patch rather than filling the first few:
    // Bridson grows outward from its seeds, so a first-come budget would put
    // the entire tussock population in one corner of the run-out.
    const total = Math.round(T.limit * density);
    const perPatch = Math.max(3, Math.floor(total / Math.max(1, patches.count)));
    const baseCol = new THREE.Color();
    for (let p = 0; p < patches.count; p++) {
      let budget = perPatch;
      const cx = patches.x[p], cz = patches.z[p];
      const radius = rng.range(5.0, 14.0);
      // The lattice pitch is derived from the budget and the patch area rather
      // than rolled independently. With an independent pitch the lattice
      // produces several times more candidates than the budget allows and the
      // budget runs out partway down the *first few rows* — every patch came
      // out as a crescent along its northern edge, at roughly a tenth of the
      // density the numbers said it had. Solving for the pitch makes the
      // budget and the geometry agree, so a patch fills as a patch.
      const wanted = perPatch / (0.62 * (relax > 1 ? 0.8 : 1));
      const spacing = clamp(Math.sqrt((Math.PI * radius * radius) / Math.max(1, wanted)), 0.55, 1.5)
        * rng.range(0.92, 1.08);
      const n = Math.ceil((radius * 2) / spacing);
      for (let j = 0; j <= n && budget > 0; j++) {
        for (let i = 0; i <= n && budget > 0; i++) {
          const gx = cx - radius + i * spacing + rng.range(-0.42, 0.42) * spacing;
          const gz = cz - radius + j * spacing + rng.range(-0.42, 0.42) * spacing;
          const rr = Math.hypot(gx - cx, gz - cz);
          if (rr > radius) continue;
          // Feather the patch edge, otherwise every clump field is a disc.
          if (rng() > 1 - smoothstep(radius * 0.45, radius * 1.02, rr)) continue;
          const cls = classify(gx, gz);
          if (cls === 0) continue;
          // Cushionfield is genuinely sparse; thinning it here rather than at
          // the patch level keeps the belt at full density where it belongs.
          if (cls === 2 && rng() > T.fellfieldFrac) continue;
          const s = P.sample(gx, gz);
          // The plant is buried to whatever depth the pack has: a clump is
          // 0.45–0.85 m tall, and the deeper the snow the less of it clears —
          // down to heads and seed stalks only (§1.4: 0.1–0.4 m showing).
          const sink = clamp(s.depth * 0.9, 0.0, 0.55);
          const showing = clamp(0.88 - s.depth * 0.62, 0.18, 0.88) * rng.range(0.82, 1.12)
            * (cls === 2 ? 0.48 : 1.0);
          const h = showing + sink;
          const spread = cls === 2 ? rng.range(0.65, 1.00) : rng.range(1.00, 1.55);
          _e.set(rng.range(-0.10, 0.10), rng() * TAU, rng.range(-0.10, 0.10), 'YXZ');
          _q.setFromEuler(_e);
          _v3.set(gx, s.height - sink, gz);
          _v3b.set(spread, h, cls === 2 ? spread * rng.range(0.9, 1.1) : spread * rng.range(0.85, 1.15));
          _m4.compose(_v3, _q, _v3b);
          // Bronze → straw → gold. The mesh's baked vertex colour already runs
          // #6A5738 → #B08A4E, so this is the per-clump multiplier around it.
          //
          // Every one of these ramps keeps R > G > B at both ends. The old
          // cushionfield ramp had G *above* R, pulling tier 2 to a neutral
          // olive — and tier 2 is the only tier that reaches the elevations
          // the `hero-basin` and `ridge-backlight` presets frame, so the one
          // place the accent could have appeared in those shots was the one
          // place it was desaturated out. Cushionfield is duller than snow
          // tussock, but *Aciphylla* and dead *Chionochloa* litter are bronze,
          // not grey.
          const k = rng();
          if (cls === 2) {
            baseCol.setRGB(
              lerp(0.82, 1.06, k) * rng.range(0.95, 1.05),
              lerp(0.76, 0.96, k) * rng.range(0.95, 1.05),
              lerp(0.64, 0.82, k) * rng.range(0.93, 1.07),
            );
          } else {
            baseCol.setRGB(
              lerp(0.94, 1.30, k) * rng.range(0.95, 1.05),
              lerp(0.86, 1.14, k) * rng.range(0.95, 1.05),
              lerp(0.70, 0.96, k) * rng.range(0.93, 1.07),
            );
          }
          this.tussockField.add(_m4, gx, gz, baseCol);
          budget--;
        }
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * bookkeeping
   * ------------------------------------------------------------------ */

  _collectStats() {
    let instances = 0, objects = 0, triangles = 0;
    const triOf = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
    for (const f of this.fields) {
      instances += f.count;
      objects += f.meshes.length;
      if (f.count) triangles += triOf(f.levels[0].geometry) * f.count;
    }
    for (const c of this.chunked) {
      instances += c.count;
      objects += c.chunks.length;
      triangles += triOf(c.geometry) * c.count;
    }
    for (const m of this.statics) {
      objects++;
      triangles += triOf(m.geometry);
    }
    this._stats = { instances, objects, triangles: Math.round(triangles) };
  }

  /** `CONFIG.debug.showColliders` — one wireframe box per collider. */
  _buildColliderDebug() {
    if (!this._colliders.length) return;
    const geo = new THREE.BoxGeometry(2, 2, 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x30ff90, wireframe: true, depthTest: false });
    const mesh = new THREE.InstancedMesh(geo, mat, this._colliders.length);
    mesh.name = 'props-collider-debug';
    mesh.frustumCulled = false;
    let i = 0;
    for (const c of this._colliders) {
      const he = c.halfExtents || new THREE.Vector3(c.radius ?? 1, c.radius ?? 1, c.radius ?? 1);
      _m4.compose(c.position, c.quaternion || _q.identity(), _v3b.copy(he));
      mesh.setMatrixAt(i++, _m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.object3D.add(mesh);
    this._debugMesh = mesh;
  }

  /* ------------------------------------------------------------------ *
   * per-frame
   * ------------------------------------------------------------------ */

  _refreshLod(force) {
    const cam = this.ctx.camera;
    if (!cam) return;
    const p = cam.position;
    const moved = this._lodCam.distanceToSquared(p);
    const eps = this.tune.lodEpsilon;
    const frame = this.ctx.frame ?? 0;
    if (!force && moved < eps * eps && frame - this._lodFrame < this.tune.lodMaxFrames) return;
    this._lodCam.copy(p);
    this._lodFrame = frame;
    for (const f of this.fields) f.refresh(p);
  }

  update(dt, ctx) {
    if (!this.built) return;
    const cam = ctx.camera;

    // Deterministic clock: the harness steps `elapsed` in exact increments.
    this._time = Number.isFinite(ctx.elapsed) ? ctx.elapsed : this._time + (Number.isFinite(dt) ? dt : 0);

    const u = this._windUniforms;
    u.uPropTime.value = this._time;
    u.uWindXZ.value.set(this.wind.x, this.wind.z);
    // Gusting: a slow, smooth envelope rather than a per-frame jitter. At
    // 4.2 m/s the tussock should breathe, not thrash.
    const speed = clamp((CONFIG.world?.windSpeed ?? 4.2) / 8, 0.15, 1.6);
    u.uWindGust.value = speed * (0.55 + 0.45 * this.simp.noise2D(this._time * 0.16, 3.7));

    const sun = ctx.sky?.sunDirection;
    if (sun && cam) {
      _v3.copy(sun).transformDirection(cam.matrixWorldInverse);
      u.uSunViewDir.value.copy(_v3);
      // Translucent rim only matters under a low sun; at 10.6° it is huge.
      u.uBacklitStrength.value = 0.85 * (1 - smoothstep(0.05, 0.55, Math.max(0, sun.y)));
    }

    this._refreshLod(false);

    if (cam) {
      for (const c of this.chunked) c.update(cam.position);
    }

    // Chairs move; they only need repositioning while anyone can see them.
    if (this._lift && this.chairField && this.chairField.count && cam) {
      const base = this._lift.strands[0]?.pts[0];
      const far = base
        ? Math.hypot(cam.position.x - base.x, cam.position.z - base.z) > 2600
        : false;
      if (!far) {
        this._poseChairs(this._time);
        // The chair field's LOD buckets read from `matrices`, so a pose change
        // has to be followed by a re-pack; it is 33 instances, not a concern.
        this.chairField.refresh(cam.position);
      }
    }

    updateSnowMaterial(this.rockMat, dt, ctx);
    updateSnowMaterial(this.snowMat, dt, ctx);
  }

  /* ------------------------------------------------------------------ *
   * physics interface
   * ------------------------------------------------------------------ */

  /**
   * Collision shapes for `physics.js`. Boxes for anything with a face the
   * rider can hit square (tors, outcrops, lift towers, terminals); nothing is
   * emitted for props a board just brushes through — poles, netting, tussock
   * and debris are all deliberately non-colliding so a fast line is never
   * stopped by set dressing.
   *
   * @returns {Array<{type:string, position:THREE.Vector3, radius?:number,
   *                  halfExtents?:THREE.Vector3, quaternion?:THREE.Quaternion,
   *                  tag:string}>}
   */
  getColliders() { return this._colliders; }

  /**
   * Broad-phase helper: everything whose centre is within `radius` of `pos`.
   * Not part of the ARCHITECTURE contract, but a 1,400-entry linear scan per
   * physics substep is not something `physics.js` should have to write itself.
   */
  getCollidersNear(pos, radius, out = []) {
    out.length = 0;
    const r2 = radius * radius;
    for (const c of this._colliders) {
      const dx = c.position.x - pos.x, dy = c.position.y - pos.y, dz = c.position.z - pos.z;
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(c);
    }
    return out;
  }

  /** Instance/triangle census, for the HUD debug overlay and the harness. */
  getStats() { return this._stats; }

  dispose() {
    for (const f of this.fields) f.dispose();
    for (const c of this.chunked) c.dispose();
    for (const m of this.statics) { m.geometry.dispose(); }
    for (const m of this.materials) m.dispose?.();
    this._debugMesh?.geometry.dispose();
    this._debugMesh?.material.dispose();
    this.netTex?.dispose();
    this.fields.length = 0;
    this.chunked.length = 0;
    this.statics.length = 0;
    this._colliders.length = 0;
    this.object3D.parent?.remove(this.object3D);
    this.built = false;
  }
}
