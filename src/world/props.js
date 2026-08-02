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
 *   ~900 rock instances · ~700 poles · ~5k tussock clumps · ~600 debris lumps
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
    scatterLimit: 300,   // free-standing outcrops on rock-classed ground
    blockLimit: 240,     // crest blockfield plates
    talusLimit: 260,     // bluff toe apron + bluff crest teeth
    driftCollars: true,
  },
  poles: {
    corridorSpacing: 21, // m between marker poles down a corridor edge
    trackSpacing: 24,    // m between poles along a benched traverse
    limit: 760,
  },
  fence: {
    postSpacing: 7.5,
    netHeight: 1.05,
    limit: 420,
  },
  tussock: {
    limit: 5200,
    chunk: 96,           // m; one InstancedMesh per chunk
    maxElevation: 1560,  // TERRAIN_BRIEF §2.13
    maxDepth: 0.25,
    maxSlopeDeg: 24,
    near: 55, far: 210, cull: 300, minFrac: 0.18,
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
    const sc = lerp(1, taper, u) * rng.range(0.9, 1.07);
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
    for (let j = 0; j < sides; j++) {
      const j2 = (j + 1) % sides;
      B.quad(bot[j], bot[j2], top[j2], top[j]);
    }
    B.fan(top, false);
    B.fan(bot, true);
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
    B.tri(apex, ringPt(1, si), ringPt(1, si + 1));
  }
  for (let ri = 1; ri < rings; ri++) {
    for (let si = 0; si < segs; si++) {
      B.quad(ringPt(ri, si), ringPt(ri + 1, si), ringPt(ri + 1, si + 1), ringPt(ri, si + 1));
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
      B.quad(prev[i], prev[j], cur[j], cur[i], prevC, prevC, curC, curC);
    }
    prev = cur; prevC = curC;
  }
  B.fan(prev, false, prevC);
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
  const baseCol = [0.155, 0.108, 0.048];
  const tipCol = [0.512, 0.352, 0.128];

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
    B.quad(a[i], a[j], b[j], b[i], col, col, col, col);
  }
  B.fan(b, false, col);
}

const STEEL = [0.415, 0.432, 0.452];
const STEEL_DARK = [0.085, 0.090, 0.098];
const CHAIR_RED = [0.470, 0.021, 0.024];

/** Lift tower: tubular shaft, base flange, crossarm and two sheave trains. */
function buildLiftTower(height, detail = 1) {
  const B = new TriBuilder();
  const radial = detail ? 8 : 4;
  pushTube(B, 0, 0, -1.2, height, 0.56, 0.36, radial, STEEL);
  if (detail) {
    pushBox(B, 0, -0.9, 0, 0.95, 0.32, 0.95, STEEL_DARK);
    pushBox(B, 0, height + 0.22, 0, 2.95, 0.17, 0.17, STEEL);
    for (const s of [-1, 1]) {
      pushBox(B, s * 2.6, height - 0.18, 0, 0.85, 0.24, 0.16, STEEL_DARK);
      pushBox(B, s * 2.6, height + 0.05, 0, 0.20, 0.30, 0.14, STEEL);
    }
  } else {
    pushBox(B, 0, height + 0.22, 0, 2.95, 0.17, 0.17, STEEL);
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

/** A terminal shed: box building with a shallow gable, on its own pad. */
function pushTerminal(B, x, y, z, yaw, len) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const rot = (lx, ly, lz) => [x + lx * c + lz * s, y + ly, z - lx * s + lz * c];
  const W = 4.6, H = 3.4, L = len;
  const wall = [0.300, 0.316, 0.334];
  const roof = [0.130, 0.140, 0.152];
  const corners = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) corners.push([sx * L, sz * W]);
  const bot = corners.map(([lx, lz]) => rot(lx, 0, lz));
  const top = corners.map(([lx, lz]) => rot(lx, H, lz));
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    B.quad(bot[i], bot[j], top[j], top[i], wall, wall, wall, wall);
  }
  const ridgeA = rot(-L, H + 1.25, 0), ridgeB = rot(L, H + 1.25, 0);
  B.quad(top[0], top[1], ridgeB, ridgeA, roof, roof, roof, roof);
  B.quad(top[2], top[3], ridgeA, ridgeB, roof, roof, roof, roof);
  B.tri(top[1], top[2], ridgeB, wall, wall, wall);
  B.tri(top[3], top[0], ridgeA, wall, wall, wall);
}

/* ==========================================================================
 * 4.  RIBBON BUILDERS (cornices, ropes, netting)
 * ======================================================================== */

/**
 * A cornice / drift lip. Heightfields cannot overhang, so the terrain caps the
 * crest bulge at 0° and this ribbon supplies the silhouette: a rounded crest,
 * an overhanging lip, and — the valuable part — a shadowed undercut, which is
 * the one place in the frame where the transport-blue of §3.2 really shows.
 *
 * `stations` is [{x, z, lee:{x,z}, lip, over, ground}] walked along the crest.
 */
function buildCorniceRibbon(stations) {
  const B = new TriBuilder();
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i], b = stations[i + 1];
    if (!a || !b) continue;
    const pt = (s, back, up) => [
      s.x + s.lx * back, s.ground + up, s.z + s.lz * back,
    ];
    // Four rails: buried root uphill, crest, overhanging lip, undercut return.
    const a0 = pt(a, -3.0, -0.55), b0 = pt(b, -3.0, -0.55);
    const a1 = pt(a, 0.35 * a.over, a.lip), b1 = pt(b, 0.35 * b.over, b.lip);
    const a2 = pt(a, a.over, a.lip * 0.72), b2 = pt(b, b.over, b.lip * 0.72);
    const a3 = pt(a, a.over * 0.55, -0.35), b3 = pt(b, b.over * 0.55, -0.35);
    B.quad(a0, b0, b1, a1);   // windward back, rising to the crest
    B.quad(a1, b1, b2, a2);   // the lip itself
    B.quad(a2, b2, b3, a3);   // the undercut, facing down and into shadow
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
    const N = 4;
    let prev = null;
    for (let s = 0; s <= N; s++) {
      const t = s / N;
      const x = a.x + dx * t, z = a.z + dz * t;
      const y = lerp(a.y, b.y, t) - sag * 4 * t * (1 - t);
      const cur = ring(x, y, z, tx, tz);
      if (prev) {
        for (let k = 0; k < 3; k++) {
          const k2 = (k + 1) % 3;
          B.quad(prev[k], prev[k2], cur[k2], cur[k], col, col, col, col);
        }
      }
      prev = cur;
    }
  }
  return B.build('soho-rope');
}

/** Hazard netting panels between posts, UV'd for the alpha-tested net map. */
function buildNetting(stations, height) {
  const pos = [], nrm = [], uvs = [];
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i], b = stations[i + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3 || len > 24) continue;
    const nx = -dz / len, nz = dx / len;
    // Slight sag in the middle so the run is not a ruler-straight fence.
    const midSag = Math.min(0.16, len * 0.02);
    const rail = [
      [a.x, a.y, a.z], [b.x, b.y, b.z],
    ];
    const uSpan = len / 2.0;
    const quad = (p0, p1, y0a, y1a, y0b, y1b, u0, u1) => {
      const A = [p0[0], p0[1] + y0a, p0[2]];
      const Bv = [p1[0], p1[1] + y0b, p1[2]];
      const C = [p1[0], p1[1] + y1b, p1[2]];
      const D = [p0[0], p0[1] + y1a, p0[2]];
      pos.push(...A, ...Bv, ...C, ...A, ...C, ...D);
      for (let q = 0; q < 6; q++) nrm.push(nx, 0, nz);
      uvs.push(u0, 0, u1, 0, u1, 1, u0, 0, u1, 1, u0, 1);
    };
    quad(rail[0], rail[1], -0.1, height - midSag, -0.1, height - midSag, 0, uSpan);
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

/** Orange safety netting: a diamond lattice with an alpha-tested cutout. */
function makeNetTexture(size = 64) {
  const data = new Uint8Array(size * size * 4);
  const strand = 0.16;         // fraction of the cell occupied by the strand
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // Two crossed sawtooth families → a diamond mesh.
      const d1 = Math.abs(((u + v) * 4) % 1 - 0.5) * 2;
      const d2 = Math.abs(((u - v) * 4 + 8) % 1 - 0.5) * 2;
      const on = (d1 > 1 - strand * 2) || (d2 > 1 - strand * 2);
      const i = (y * size + x) * 4;
      // Warm orange with a little shading variation along the strand.
      const k = 0.86 + 0.14 * Math.sin((u + v) * 40);
      data[i] = Math.round(232 * k);
      data[i + 1] = Math.round(83 * k);
      data[i + 2] = Math.round(31 * k);
      data[i + 3] = on ? 255 : 0;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
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

function installWind(material, uniforms, cacheKey, backlit) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_PARS}`)
      .replace('#include <project_vertex>', WIND_PROJECT);
    let frag = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\nvarying float vBendAmt;\n${backlit ? BACKLIT_PARS : ''}`,
    );
    if (backlit) {
      frag = frag.replace('#include <opaque_fragment>', `${BACKLIT_MAIN}\n#include <opaque_fragment>`);
    }
    shader.fragmentShader = frag;
  };
  material.customProgramCacheKey = () => cacheKey;
  // Geometry that forgets the attribute still compiles and simply stands still.
  material.defaultAttributeValues = { ...(material.defaultAttributeValues || {}), aBend: 0 };
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

    this._windUniforms = {
      uPropTime: { value: 0 },
      uWindXZ: { value: new THREE.Vector2(-0.921, 0.391) },
      uWindGust: { value: 0.4 },
      uSunViewDir: { value: new THREE.Vector3(0, 0, -1) },
      uBacklitColor: { value: new THREE.Color(0.66, 0.42, 0.13) },
      uBacklitStrength: { value: 0.0 },
      uSwayAmp: { value: 0.10 },
      uSwayFreq: { value: 1.35 },
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
    this.rockMat = createRockMaterial(ctx, {});
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

    this.netTex = makeNetTexture(64);
    this.netTex.anisotropy = Math.max(1, Math.min(8, ctx?.maxAnisotropy ?? 4));
    this.netMat = new THREE.MeshStandardMaterial({
      name: 'props-netting',
      map: this.netTex,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 0.82,
      metalness: 0.0,
    });

    // Flag: light coated nylon. Fluttering, and lit from both sides.
    this.flagMat = new THREE.MeshStandardMaterial({
      name: 'props-flag',
      color: new THREE.Color(0.760, 0.086, 0.020),
      roughness: 0.62,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    installWind(this.flagMat, this._windUniforms, 'soho-flag', true);

    // Snow tussock: double-sided ribbons, wind-swayed, backlit rim.
    this.tussockMat = new THREE.MeshStandardMaterial({
      name: 'props-tussock',
      vertexColors: true,
      roughness: 0.86,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    installWind(this.tussockMat, this._windUniforms, 'soho-tussock', true);

    this.materials.push(
      this.rockMat, this.snowMat, this.poleMat, this.steelMat,
      this.ropeMat, this.netMat, this.flagMat, this.tussockMat,
    );
  }

  /* ------------------------------------------------------------------ *
   * geometry library
   * ------------------------------------------------------------------ */

  _buildGeometryLibrary() {
    const rng = makeRng(this._seed('geometry'));

    /**
     * Three rock archetypes, each at three levels of detail. They are
     * semantically different landforms, not just three random blobs: a tall
     * tor on the crest, a broad low outcrop on rock-classed ground, and an
     * angular block for talus and blockfield.
     */
    const lod = (params) => [
      { geometry: buildSlabStack(makeRng(params.seed), { ...params, slabs: params.slabs, sides: params.sides }), angular: 0.052 },
      { geometry: buildSlabStack(makeRng(params.seed), { ...params, slabs: Math.max(2, params.slabs - 2), sides: Math.max(4, params.sides - 1), batter: 0.95 }), angular: 0.014 },
      { geometry: buildSlabStack(makeRng(params.seed), { ...params, slabs: 1, sides: 4, batter: 0.97 }), angular: 0.0 },
    ];

    this.geo = {
      tor: lod({ seed: this._seed('geo.tor'), slabs: 5, sides: 6, taper: 0.66, jag: 0.30, flatten: 0.55, step: 0.10 }),
      outcrop: lod({ seed: this._seed('geo.outcrop'), slabs: 4, sides: 7, taper: 0.80, jag: 0.24, flatten: 0.48, step: 0.13 }),
      block: lod({ seed: this._seed('geo.block'), slabs: 3, sides: 5, taper: 0.72, jag: 0.34, flatten: 0.70, step: 0.08 }),
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
        { geometry: buildPole({ radial: 4, segs: 2, radius: 0.030, tipFrac: 0.16 }), angular: 0.0 },
      ],
      fencePost: [
        { geometry: buildPole({ height: 1.55, radius: 0.028, tipFrac: 0.0, body: [0.196, 0.166, 0.096] }), angular: 0.010 },
        { geometry: buildPole({ height: 1.55, radius: 0.038, radial: 4, segs: 2, tipFrac: 0.0, body: [0.196, 0.166, 0.096] }), angular: 0.0 },
      ],
      flag: [{ geometry: buildFlag({}), angular: 0.0 }],
      tower: [
        { geometry: buildLiftTower(9.5, 1), angular: 0.020 },
        { geometry: buildLiftTower(9.5, 0), angular: 0.0 },
      ],
      chair: [{ geometry: buildChair(), angular: 0.0 }],
      tussock: buildTussock(makeRng(this._seed('geo.tussock')), { blades: 6, segs: 3, height: 1.0 }),
    };

    void rng;
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
    // plus whatever the local pack is, so nothing reads as a decal.
    const sink = opt.sink ?? (0.16 * height + Math.min(0.5, opt.depth ?? 0.3));
    _e.set(rng.range(-0.10, 0.10), -strike, rng.range(-0.10, 0.10), 'YXZ');
    _q.setFromEuler(_e);
    _v3.set(x, y - sink, z);
    _v3b.set(length, height + sink, width);
    _m4.compose(_v3, _q, _v3b);
    // Base tint: schist varies from grey-green to a rusty weathered rind.
    const rust = clamp01(rng() * 0.9 - 0.35);
    _col.setRGB(
      lerp(0.94, 1.16, rust) * rng.range(0.92, 1.08),
      lerp(0.97, 1.02, rust) * rng.range(0.93, 1.06),
      lerp(1.02, 0.86, rust) * rng.range(0.92, 1.06),
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
    if (this.driftField && this.tune.rock.driftCollars && height > 0.9) {
      const scale = Math.max(length, width);
      const dx = this.wind.x, dz = this.wind.z;
      // Offset the mound so its steep face hugs the rock and the tail runs off.
      const ox = x + dx * scale * 0.18, oz = z + dz * scale * 0.18;
      const gy = this.probe.height(ox, oz);
      _e.set(0, this.windYaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      _v3.set(ox, gy - 0.28, oz);
      const rr = scale * rng.range(0.70, 1.05);
      _v3b.set(rr, Math.min(height * 0.55, 1.5) * rng.range(0.6, 1.0) + 0.25, rr * 0.85);
      _m4.compose(_v3, _q, _v3b);
      this.driftField.add(_m4, rr * 1.6, null);
    }
  }

  _placeRocks() {
    this._buildExclusion();
    const T = this.tune;
    const density = clamp(T.density ?? 1, 0.05, 4);

    this.torField = this._field('tor', this.rockMat, this.geo.tor, {
      useColor: true, shadowLevels: 2, cullAngular: 0.0022,
    });
    this.outcropField = this._field('outcrop', this.rockMat, this.geo.outcrop, {
      useColor: true, shadowLevels: 2, cullAngular: 0.0026,
    });
    this.blockField = this._field('block', this.rockMat, this.geo.block, {
      useColor: true, shadowLevels: 1, cullAngular: 0.0040,
    });
    this.driftField = this._field('rock-drift', this.snowMat, this.geo.drift, {
      castShadow: false, receiveShadow: true, cullAngular: 0.0060,
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
      const big = rng() < 0.30;
      const len = big ? rng.range(6, 15) : rng.range(2.2, 6.5);
      this._addRock(this.outcropField, {
        x, z, y: s.height,
        length: len,
        height: len * rng.range(0.20, 0.55) * (big ? 1.0 : 0.8),
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
      const l = rng.range(0.25, 1.25);
      this._addRock(this.blockField, {
        x, z, y: s.height, length: l,
        height: l * rng.range(0.16, 0.34), width: l * rng.range(0.55, 0.9),
        strike: FOLIATION_STRIKE + rng.range(-0.35, 0.35),
        rng, depth: s.depth, sink: l * 0.10,
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
    let budget = Math.round(T.rock.talusLimit * clamp(T.density ?? 1, 0.05, 4));

    for (const bl of this.features.bluffs || []) {
      if (budget <= 0) break;
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
        if (rng() < 0.55) {
          const ux = x - dx * rng.range(1.5, 5), uz = z - dz * rng.range(1.5, 5);
          const s = P.sample(ux, uz);
          const len = rng.range(1.4, 4.2);
          this._addRock(this.outcropField, {
            x: ux, z: uz, y: s.height, length: len,
            height: len * rng.range(0.45, 1.05), width: len * rng.range(0.4, 0.75),
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
      castShadow: true, receiveShadow: true, shadowLevels: 1, cullAngular: 0.0075,
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
      // Downhill from the mouth: radially away from the cirque focus below the
      // headwall, and straight down the fall line for the bluff gaps.
      let ddx = m.x - FOCUS_X, ddz = m.z - FOCUS_Z;
      const dl = Math.hypot(ddx, ddz) || 1;
      ddx /= dl; ddz /= dl;
      // Radially outward from the focus points *uphill* on the headwall side,
      // so the debris runs the other way.
      ddx = -ddx; ddz = -ddz;

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
  _buildCornices() {
    const rng = makeRng(this._seed('cornice'));
    const P = this.probe;
    const stations = [];

    const pushRun = (run) => {
      if (run.length > 2) { stations.push(...run, null); }
    };

    /* -- Crest arc (headwall lip) ----------------------------------------- */
    for (const seg of this.features.cornice || []) {
      const arcLen = Math.abs(seg.phi1 - seg.phi0) * CREST_R;
      if (arcLen < 12) continue;
      const steps = Math.max(4, Math.round(arcLen / 5));
      const run = [];
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const phi = lerp(seg.phi0, seg.phi1, u);
        const x = FOCUS_X + Math.sin(phi) * CREST_R;
        const z = FOCUS_Z + Math.cos(phi) * CREST_R;
        if (Math.abs(x) > 1010 || Math.abs(z) > 1010) continue;
        // Downhill on the headwall is radially inward, toward the focus.
        const lx = -Math.sin(phi), lz = -Math.cos(phi);
        // Taper both ends to nothing so a segment never terminates in a wall.
        const taper = Math.sin(Math.PI * clamp01(u)) ** 0.55;
        const lip = (seg.lip ?? 2.4) * taper * rng.range(0.88, 1.12);
        run.push({
          x, z, lx, lz, lip,
          over: lip * rng.range(1.15, 1.75),
          ground: P.height(x, z),
        });
      }
      pushRun(run);
    }

    /* -- Spur crests: lee-side wind pillows and small cornices ------------ */
    // Wind from 292° loads the −X flank of every spur and rib. The lip there
    // is smaller than the crest cornice but there is a lot of it, and it is
    // what makes the same slope read differently 40 m apart.
    for (const spur of this.features.spurs || []) {
      let run = [];
      let carry = rng.range(0, 60);
      walkPolyline(spur.pts, 6, (x, z, tx, tz, s) => {
        // Present over ~55% of the crest in 40–110 m segments.
        const on = ((s + carry) % 150) < 82;
        if (!on) { pushRun(run); run = []; return; }
        if (Math.abs(x) > 1000 || Math.abs(z) > 1000) { pushRun(run); run = []; return; }
        // Lee side = whichever perpendicular runs downwind.
        let lx = -tz, lz = tx;
        if (lx * this.wind.x + lz * this.wind.z < 0) { lx = -lx; lz = -lz; }
        const ground = P.height(x, z);
        const lip = rng.range(0.45, 1.35);
        run.push({ x, z, lx, lz, lip, over: lip * rng.range(1.3, 2.1), ground });
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
      castShadow: true, receiveShadow: true, shadowLevels: 2, cullAngular: 0.0055,
    });
    this.flagField = this._field('marker-flag', this.flagMat, this.geo.flag, {
      castShadow: false, receiveShadow: true, cullAngular: 0.0022,
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
      castShadow: true, receiveShadow: true, shadowLevels: 2, cullAngular: 0.0060,
    });

    let budget = Math.round(T.fence.limit * clamp(T.density ?? 1, 0.05, 4));
    const netStations = [];
    const ropeStations = [];

    const post = (x, z, out) => {
      if (budget <= 0) return;
      if (Math.abs(x) > 1015 || Math.abs(z) > 1015) { out.push(null); return; }
      const s = P.sample(x, z);
      if (s.slope / DEG > 44) { out.push(null); return; }
      _e.set(rng.range(-0.05, 0.05), rng() * TAU, rng.range(-0.05, 0.05), 'YXZ');
      _q.setFromEuler(_e);
      _v3.set(x, s.height, z);
      _v3b.set(1, rng.range(0.95, 1.05), 1);
      _m4.compose(_v3, _q, _v3b);
      this.fencePostField.add(_m4, 0.95, null);
      budget--;
      out.push({ x, y: s.height, z });
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
      const geo = buildNetting(
        netStations.map((s) => (s ? { x: s.x, y: s.y, z: s.z } : null)),
        T.fence.netHeight,
      );
      this._static(geo, this.netMat, 'props-hazard-netting', { castShadow: true, receiveShadow: false });
      // The netting is hung on a rope along its top edge.
      const top = netStations.map((s) => (s ? { x: s.x, y: s.y + T.fence.netHeight, z: s.z } : null));
      this._static(buildRopeRun(top, 0.05, 0.026, [0.055, 0.058, 0.062]), this.ropeMat, 'props-net-rope', {
        castShadow: false, receiveShadow: false,
      });
    }
    if (ropeStations.length) {
      const mid = ropeStations.map((s) => (s ? { x: s.x, y: s.y + 0.98, z: s.z } : null));
      this._static(buildRopeRun(mid, 0.16, 0.030, [0.520, 0.098, 0.028]), this.ropeMat, 'props-boundary-rope', {
        castShadow: true, receiveShadow: false,
      });
      const low = ropeStations.map((s) => (s ? { x: s.x, y: s.y + 0.52, z: s.z } : null));
      this._static(buildRopeRun(low, 0.20, 0.024, [0.045, 0.048, 0.052]), this.ropeMat, 'props-boundary-rope-low', {
        castShadow: false, receiveShadow: false,
      });
    }
  }
}
