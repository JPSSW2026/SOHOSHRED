/**
 * The rider.
 *
 * Everything here is built from code — there is no imported mesh, no rig file
 * and no animation clip anywhere in this project. The character is a bone
 * hierarchy of plain Object3Ds with procedurally lathed limb geometry hung off
 * it, and every pose is computed each frame from the physics state.
 *
 * That constraint is not a hardship for a snowboarder. A rider has no gait
 * cycle: their feet are bolted to a plank. What they *do* have is a continuous
 * relationship between what the board is doing and where their mass is, and
 * that relationship is far better expressed as arithmetic than as baked clips.
 * Inclination into a carve, absorption under g-load, the unweighting before a
 * pop, the tuck in the air, the compression on landing — these are all
 * functions of numbers the physics already computes.
 *
 * The rig, from the root down:
 *
 *   root                     — board contact point, positioned by physics
 *    ├ contact               — the soft AO patch the board presses into the snow
 *    └ boardPivot            — edge roll + pitch, lifted so the base rides ON the snow
 *       ├ board              — deck, base, steel edges, bindings
 *       └ hips               — the rider's mass, offset by inclination
 *          ├ spine → chest → neck → head (helmet, goggles)
 *          │   ├ shoulderL → upperArmL → foreArmL → handL
 *          │   └ shoulderR → upperArmR → foreArmR → handR
 *          ├ thighF → shinF → bootF   (two-bone IK onto the front binding)
 *          └ thighB → shinB → bootB   (two-bone IK onto the back binding)
 *
 * Legs are solved with analytic two-bone IK so the boots stay welded to the
 * bindings no matter what the hips do — which is the whole trick, because it
 * means the animation system only has to move the hips and chest and the legs
 * follow correctly for free.
 *
 * Two orientation facts drive the whole build and are easy to get wrong:
 *
 *   - **Board-local +Z is the nose, +X is the toe edge.** Both the stance and
 *     the shoulder line therefore run along **Z**, not X. A rig with the hips
 *     split along Z and the shoulders split along X is a skier wearing a
 *     snowboard, and it is the difference between a silhouette that reads as
 *     "snowboarder" at 30 m and one that reads as a shop mannequin.
 *   - **The head faces +Z** (down the board, down the fall line) while the
 *     chest faces roughly +X. That 80-odd degrees of separation is free once
 *     the shoulders are anchored along Z, and it is what makes the pose read.
 *
 * Every limb is a **closed** lathe with rounded end domes that overrun the
 * joint. An open-ended tube shows its bright interior the moment a joint bends
 * — which is a mesh bug, not a shading problem — and rounded overrunning caps
 * mean no gap can open at a joint at any pose. Explicit joint spheres at the
 * shoulder, elbow, hip and knee belt-and-brace that.
 */

import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { makeRng, seedFromString, clamp, clamp01, lerp, smoothstep, damp } from '../core/rng.js';

/* ---------------------------------------------------------------- *
 * Dimensions. A 178 cm rider on a 156 cm all-mountain deck.
 * ---------------------------------------------------------------- */
const DIM = {
  boardLength: 1.56,
  boardWaist: 0.252,
  boardTip: 0.298,
  boardThickness: 0.014,
  /** Effective edge — where the sidecut actually contacts. */
  effectiveEdge: 1.19,
  /** Camber under the bindings, and tip/tail rocker. */
  camber: 0.007,
  rocker: 0.042,
  /** Height of the bright steel band on the sidewall + base wrap. */
  edgeBand: 0.005,

  stanceWidth: 0.55,
  /** Duck stance: front foot open, back foot slightly negative. */
  frontAngle: THREE.MathUtils.degToRad(15),
  backAngle: THREE.MathUtils.degToRad(-6),

  bootHeight: 0.13,
  shinLength: 0.44,
  thighLength: 0.44,
  hipWidth: 0.20,
  spineLength: 0.20,
  chestLength: 0.26,
  neckLength: 0.09,
  headRadius: 0.115,
  shoulderWidth: 0.215,
  /** How far the chest is opened toward the nose, radians. */
  chestOpen: 0.26,
  upperArm: 0.30,
  foreArm: 0.28,
};

/**
 * The board's base rides this far above the snow surface. Four millimetres is
 * below the resolution of any shot we take, but it is the difference between a
 * deck that reads as a deck and a deck that is buried in the heightfield with
 * only its rockered nose poking out as a dark shard.
 */
const BOARD_LIFT = 0.004;

/** Grab points on the board, in board-local space. */
const GRABS = {
  //            [x (toe+), z (nose+)]   which hand
  indy:      { point: [ 0.13, -0.22], hand: 'back',  tweak: [0.10, -0.05, 0.02] },
  mute:      { point: [ 0.13,  0.24], hand: 'front', tweak: [0.06,  0.02, 0.04] },
  melon:     { point: [-0.13,  0.20], hand: 'front', tweak: [-0.05, 0.03, 0.02] },
  stalefish: { point: [-0.13, -0.24], hand: 'back',  tweak: [-0.09,-0.04, 0.03] },
  nose:      { point: [ 0.00,  0.70], hand: 'front', tweak: [0.00,  0.10, 0.06] },
  tail:      { point: [ 0.00, -0.70], hand: 'back',  tweak: [0.00, -0.08, 0.05] },
  method:    { point: [-0.13,  0.02], hand: 'front', tweak: [-0.14, 0.06, -0.05] },
};

/* ---------------------------------------------------------------- *
 * Procedural textures
 * ---------------------------------------------------------------- */

const hex = (c) => {
  const col = new THREE.Color(c);
  return `rgb(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0})`;
};

/**
 * Technical-shell fabric: a fine ripstop grid over a subtle twill weave, with
 * the grid squares slightly darker at their borders. At the distances the
 * camera actually sees the rider this reads as cloth rather than as plastic,
 * which is most of the difference between a character and a mannequin.
 *
 * Deliberately tileable and deliberately featureless: the *construction* of
 * the garment — seams, zips, hem cord, cuffs, pocket flaps — is geometry, not
 * texture, because a zip painted into a map that repeats 2x3 down a sleeve is
 * three zips.
 */
function makeShellTexture(rng, base, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = hex(base);
  g.fillRect(0, 0, size, size);

  // Weave noise.
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 13;
    d[i] = clamp(d[i] + n, 0, 255);
    d[i + 1] = clamp(d[i + 1] + n, 0, 255);
    d[i + 2] = clamp(d[i + 2] + n, 0, 255);
  }
  g.putImageData(img, 0, 0);

  // Twill: a faint diagonal, which is what actually distinguishes a coated
  // face fabric from a flat painted surface at grazing angles.
  g.strokeStyle = 'rgba(255,255,255,0.045)';
  g.lineWidth = 1;
  for (let i = -size; i < size * 2; i += 3) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + size, size); g.stroke();
  }

  // Ripstop grid — the reinforcing thread every 8 px.
  g.strokeStyle = 'rgba(0,0,0,0.15)';
  for (let i = 0; i < size; i += 8) {
    g.beginPath(); g.moveTo(i + 0.5, 0); g.lineTo(i + 0.5, size); g.stroke();
    g.beginPath(); g.moveTo(0, i + 0.5); g.lineTo(size, i + 0.5); g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.07)';
  for (let i = 0; i < size; i += 8) {
    g.beginPath(); g.moveTo(i + 1.5, 0); g.lineTo(i + 1.5, size); g.stroke();
    g.beginPath(); g.moveTo(0, i + 1.5); g.lineTo(size, i + 1.5); g.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = CONFIG.render.anisotropy;
  return tex;
}

/**
 * Board topsheet. A graphic deck, because a plain black slab reads as
 * untextured geometry in every close shot — and the topsheet is the one
 * surface in frame the camera is guaranteed to see from above.
 */
function makeTopsheetTexture(rng, size = 512) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');

  // Base: deep alpine blue-black with a vertical gradient.
  const grad = g.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, '#0d1622');
  grad.addColorStop(0.5, '#14243a');
  grad.addColorStop(1, '#0b1119');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);

  // A stylised ridgeline running the length of the deck — Soho Basin's own
  // skyline, which is the sort of thing a board brand would actually print.
  g.save();
  g.translate(0, size * 0.62);
  g.beginPath();
  g.moveTo(0, size * 0.2);
  let y = size * 0.05;
  for (let x = 0; x <= size; x += size / 24) {
    y += (rng() - 0.45) * size * 0.05;
    y = clamp(y, -size * 0.12, size * 0.16);
    g.lineTo(x, y);
  }
  g.lineTo(size, size * 0.4);
  g.lineTo(0, size * 0.4);
  g.closePath();
  g.fillStyle = 'rgba(224,238,255,0.90)';
  g.fill();
  g.restore();

  // A single accent band, the same hue as the jacket.
  g.fillStyle = 'rgba(232,83,31,0.92)';
  g.fillRect(0, size * 0.455, size, size * 0.022);

  // Brand mark.
  g.fillStyle = 'rgba(255,255,255,0.94)';
  g.font = `bold ${Math.round(size * 0.085)}px sans-serif`;
  g.textAlign = 'center';
  g.fillText('SOHO', size * 0.5, size * 0.24);
  g.fillStyle = 'rgba(120,190,255,0.85)';
  g.font = `${Math.round(size * 0.05)}px sans-serif`;
  g.fillText('SHRED', size * 0.5, size * 0.32);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = CONFIG.render.anisotropy;
  return tex;
}

/**
 * Board base. A sintered base is dark, but §4.1 is explicit that on an open
 * snowfield the bounce is ~2x the sky fill and nothing downward-facing is a
 * void: a jet-black quad under the board is the "black undersides" tell. A
 * real base is also *printed* — so this is graphite with a large light-ice
 * graphic across it, which both breaks up the value and gives the gloss
 * something to modulate.
 */
function makeBaseTexture(rng, size = 512) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#2a2f38';
  g.fillRect(0, 0, size, size);

  // Sintered grain: fine, low-contrast, structural.
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 18;
    d[i] = clamp(d[i] + n, 0, 255);
    d[i + 1] = clamp(d[i + 1] + n, 0, 255);
    d[i + 2] = clamp(d[i + 2] + n, 0, 255);
  }
  g.putImageData(img, 0, 0);

  // Printed graphic: a long ice-white wedge down the running length, which is
  // what the camera sees on every air and every layed-out toeside.
  g.save();
  g.beginPath();
  g.moveTo(size * 0.5, size * 0.02);
  g.lineTo(size * 0.86, size * 0.52);
  g.lineTo(size * 0.5, size * 0.98);
  g.lineTo(size * 0.14, size * 0.52);
  g.closePath();
  g.fillStyle = 'rgba(206,216,230,0.86)';
  g.fill();
  g.restore();

  g.fillStyle = 'rgba(232,83,31,0.9)';
  g.fillRect(size * 0.44, size * 0.30, size * 0.12, size * 0.40);

  g.fillStyle = 'rgba(24,28,34,0.85)';
  g.font = `bold ${Math.round(size * 0.07)}px sans-serif`;
  g.textAlign = 'center';
  g.fillText('SOHO SHRED', size * 0.5, size * 0.54);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = CONFIG.render.anisotropy;
  return tex;
}

/**
 * The soft contact darkening the board presses into the snow. A radial falloff
 * in alpha only — the colour is a flat cyan-blue, because an occluded pocket of
 * snow sees less sky *and* more of the surrounding snowfield's own multiply-
 * scattered light, so it goes bluer and softer rather than grey (§7.5).
 */
function makeContactTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.00, 'rgba(255,255,255,1.00)');
  grad.addColorStop(0.34, 'rgba(255,255,255,0.86)');
  grad.addColorStop(0.62, 'rgba(255,255,255,0.40)');
  grad.addColorStop(0.85, 'rgba(255,255,255,0.10)');
  grad.addColorStop(1.00, 'rgba(255,255,255,0.00)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ---------------------------------------------------------------- *
 * Geometry helpers
 * ---------------------------------------------------------------- */

/**
 * A tapered limb segment, built along −Y from the joint, so a bone rotation
 * swings it the way a limb swings. Slight bulge at the belly of the muscle.
 *
 * **Closed at both ends**, with rounded domes that overrun the joint by
 * `capTop`/`capBottom` times the local radius. That is not cosmetic: a lathe
 * whose profile starts and ends at a non-zero radius is an open tube, and the
 * moment a knee or an elbow bends you are looking down the inside of it. The
 * overrun also guarantees that the parent's bottom dome and the child's top
 * dome interpenetrate at every joint angle, so no gap can open at any pose.
 */
function limbGeometry(length, rTop, rBottom, bulge = 1.08, seg = 12, capTop = 0.85, capBottom = 0.85) {
  const pts = [];
  const capSeg = 3;
  const capA = rTop * capTop;
  const capB = rBottom * capBottom;

  // Top dome, from the pole down to the rim.
  for (let i = 0; i <= capSeg; i++) {
    const a = (i / capSeg) * Math.PI * 0.5;
    pts.push(new THREE.Vector2(rTop * Math.sin(a), capA * Math.cos(a)));
  }
  // Shaft.
  const rings = 6;
  for (let i = 1; i < rings; i++) {
    const t = i / rings;
    const r = lerp(rTop, rBottom, t) * lerp(1, bulge, Math.sin(t * Math.PI));
    pts.push(new THREE.Vector2(r, -t * length));
  }
  // Bottom dome, from the rim down to the pole.
  for (let i = 0; i <= capSeg; i++) {
    const a = (i / capSeg) * Math.PI * 0.5;
    pts.push(new THREE.Vector2(rBottom * Math.cos(a), -length - capB * Math.sin(a)));
  }

  // LatheGeometry's own normals are correct across the phi seam and at the
  // poles; computeVertexNormals() would replace them with face averages and
  // leave a visible hairline down the length of every limb.
  return new THREE.LatheGeometry(pts, seg);
}

/**
 * A raised garment panel that follows a limb's own profile — the zip tape down
 * the chest, a pocket face, a shoulder yoke. Sharing the profile function with
 * `limbGeometry` is the point: a flat box laid against a barrel either sinks
 * into it at the belly or floats off it at the shoulders, and a jacket whose
 * zip floats is worse than a jacket with no zip.
 */
function limbPanel(length, rTop, rBottom, bulge, pad, phiStart, phiLength, t0 = 0, t1 = 1, seg = 6) {
  const pts = [];
  const rings = 8;
  for (let i = 0; i <= rings; i++) {
    const t = lerp(t0, t1, i / rings);
    const r = lerp(rTop, rBottom, t) * lerp(1, bulge, Math.sin(t * Math.PI)) + pad;
    pts.push(new THREE.Vector2(r, -t * length));
  }
  return new THREE.LatheGeometry(pts, seg, phiStart, phiLength);
}

/** Sidecut half-width and camber/rocker height at a station along the deck. */
function boardStation(z) {
  const half = DIM.boardLength * 0.5;
  const az = Math.abs(z);
  const s = az / half;
  const contact = DIM.effectiveEdge * 0.5;

  const edgeT = clamp01((az - contact) / (half - contact));
  const widthAtEdge = lerp(DIM.boardWaist, DIM.boardTip, s * s);
  let width = edgeT > 0
    ? lerp(widthAtEdge, DIM.boardTip * 0.80, smoothstep(0, 1, edgeT))
    : widthAtEdge;
  // Blunt round nose/tail rather than a knife point.
  const tipT = clamp01((az - half * 0.88) / (half * 0.12));
  width *= Math.sqrt(Math.max(0.05, 1 - tipT * tipT * 0.93));

  const camber = az < contact
    ? DIM.camber * Math.cos((z / contact) * Math.PI * 0.5)
    : 0;
  const rocker = DIM.rocker * smoothstep(contact, half, az) ** 1.6;
  return { halfWidth: width * 0.5, y: camber + rocker };
}

/**
 * The deck: a sidecut outline swept with camber and tip/tail rocker, built as
 * a **closed solid** — top surface, running base, and a sidewall rim joining
 * them — with three material groups so the topsheet graphic, the printed base
 * and the sidewall are separately shaded.
 *
 * The previous revision was two copies of a single open surface, one of them
 * mirrored through y = 0, which produced a lens that pinched to zero thickness
 * exactly at the contact points and put the entire running base *below* the
 * plane physics reports as the contact plane. That is why the deck was buried
 * in the heightfield with only its rockered nose showing.
 */
function boardGeometry() {
  const nz = 56, nx = 6;
  const half = DIM.boardLength * 0.5;
  const th = DIM.boardThickness;
  const pos = [], uv = [], idx = [];
  const groups = [];

  const stations = [];
  for (let j = 0; j <= nz; j++) {
    const t = j / nz;
    const z = lerp(-half, half, t);
    stations.push({ z, t, ...boardStation(z) });
  }

  const gridAt = (i, j, top) => {
    const st = stations[j];
    const u = i / nx;
    return [lerp(-st.halfWidth, st.halfWidth, u), st.y + (top ? th : 0), st.z];
  };

  // --- top surface (group 0) and base (group 1) ---
  for (const top of [true, false]) {
    const startVert = pos.length / 3;
    const startIdx = idx.length;
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const p = gridAt(i, j, top);
        pos.push(p[0], p[1], p[2]);
        uv.push(i / nx, stations[j].t);
      }
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = startVert + j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        if (top) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    }
    groups.push([startIdx, idx.length - startIdx, top ? 0 : 1]);
  }

  // --- sidewall rim (group 2) ---
  // Walk the perimeter of the grid as an ordered loop and raise a quad strip
  // from the base edge to the top edge.
  const loop = [];
  for (let i = 0; i <= nx; i++) loop.push([i, 0]);
  for (let j = 1; j <= nz; j++) loop.push([nx, j]);
  for (let i = nx - 1; i >= 0; i--) loop.push([i, nz]);
  for (let j = nz - 1; j >= 1; j--) loop.push([0, j]);

  const rimStartVert = pos.length / 3;
  const rimStartIdx = idx.length;
  for (let k = 0; k < loop.length; k++) {
    const [i, j] = loop[k];
    const pb = gridAt(i, j, false);
    const pt = gridAt(i, j, true);
    pos.push(pb[0], pb[1], pb[2]); uv.push(k / loop.length, 0);
    pos.push(pt[0], pt[1], pt[2]); uv.push(k / loop.length, 1);
  }
  for (let k = 0; k < loop.length; k++) {
    const a = rimStartVert + k * 2;
    const b = a + 1;
    const c = rimStartVert + ((k + 1) % loop.length) * 2;
    const d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  groups.push([rimStartIdx, idx.length - rimStartIdx, 2]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  for (const [s, c, m] of groups) geo.addGroup(s, c, m);
  geo.computeVertexNormals();
  return geo;
}

/**
 * The steel edge: a bright metallic band wrapping the base rail on both sides
 * of the deck, following the real sidecut rather than being a straight box.
 * §6.4 calls this out explicitly and `ref_12`/`ref_15` both show it — it is a
 * thin, hard specular line that draws the eye along the board's arc, and at
 * portrait distance it wants to survive as roughly a pixel of pure highlight,
 * so it wraps both the bottom of the sidewall and the outer strip of the base.
 */
function steelEdgeGeometry() {
  const nz = 56;
  const half = DIM.boardLength * 0.5;
  const band = DIM.edgeBand;
  const pos = [], uv = [], idx = [];

  for (const sx of [-1, 1]) {
    const ring = [];
    for (let j = 0; j <= nz; j++) {
      const z = lerp(-half, half, j / nz);
      const st = boardStation(z);
      const x = sx * st.halfWidth;
      // Three profile points: inboard on the base, the rail corner, and up
      // the sidewall.
      ring.push([
        [x - sx * band, st.y + 0.0004, z],
        [x + 0.0002 * sx, st.y + 0.0006, z],
        [x + 0.0002 * sx, st.y + band, z],
      ]);
    }
    const start = pos.length / 3;
    for (let j = 0; j <= nz; j++) {
      for (let k = 0; k < 3; k++) {
        const p = ring[j][k];
        pos.push(p[0], p[1], p[2]);
        uv.push(k / 2, j / nz);
      }
    }
    for (let j = 0; j < nz; j++) {
      for (let k = 0; k < 2; k++) {
        const a = start + j * 3 + k, b = a + 1, c = a + 3, d = c + 1;
        if (sx > 0) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/* ---------------------------------------------------------------- *
 * Rider
 * ---------------------------------------------------------------- */

export class Rider {
  constructor(ctx) {
    this.ctx = ctx;
    this.object3D = new THREE.Object3D();
    this.object3D.name = 'rider';
    this.boardObject = null;
    this.bones = {};

    this._rng = makeRng(seedFromString(CONFIG.seed + ':rider'));
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    // IK scratch. The solver runs twice a frame and must not allocate.
    this._ikDir = new THREE.Vector3();
    this._ikPole = new THREE.Vector3();
    this._ikThigh = new THREE.Vector3();
    this._ikX = new THREE.Vector3();
    this._ikY = new THREE.Vector3();
    this._ikZ = new THREE.Vector3();
    this._ikQ = new THREE.Quaternion();
    this._ikQ2 = new THREE.Quaternion();
    this._chk = new THREE.Vector3();
    this._chk2 = new THREE.Vector3();

    // Smoothed animation channels. Every one of these is a value the pose
    // reads; damping them here rather than in the pose keeps the rider from
    // snapping when the physics state changes discontinuously (landing,
    // crash recovery, a reset).
    this._an = {
      incline: 0, absorb: 0, tuck: 0, twist: 0, reach: 0,
      grabBlend: 0, crash: 0, lean: 0, edge: 0, compress: 0,
    };
    this._grab = null;
    this._time = 0;
    this._contact = null;
    this._boardLift = BOARD_LIFT;
  }

  /* ------------------------------------------------------------------ *
   * Materials
   * ------------------------------------------------------------------ */
  _buildMaterials(rng) {
    /**
     * §6.3: **one** high-chroma colour per rider, everything else neutral.
     * The jacket body is the accent orange; the yoke, sleeves-below-the-elbow
     * and hem are charcoal, which is both how a real shell is colour-blocked
     * and what keeps the high-chroma pixel budget (checklist 33: 1.5–6% of
     * frame) inside its band on a close portrait.
     *
     * Roughness 0.46 sits mid-band for §6.3's 0.38–0.55, and the sheen term is
     * the thing that stops coated nylon reading as painted plastic: fabric
     * fuzz brightens at grazing angles in a way neither Lambert nor GGX gives
     * you (checklist 39).
     */
    const cloth = (base, rough, sheen, repeat) => {
      const map = makeShellTexture(rng, base);
      map.repeat.set(repeat[0], repeat[1]);
      const m = new THREE.MeshPhysicalMaterial({
        map,
        color: 0xffffff,
        roughness: rough,
        metalness: 0.0,
        sheen,
        sheenRoughness: 0.55,
        sheenColor: new THREE.Color(0xfff0e2),
      });
      return m;
    };

    const shell = cloth(0xe8531f, 0.46, 0.62, [2, 3]);
    const shellDark = cloth(0x3a3a3e, 0.50, 0.55, [2, 3]);
    const pants = cloth(0x35353b, 0.58, 0.40, [2, 3]);

    const helmet = new THREE.MeshStandardMaterial({
      color: 0x14181e, roughness: 0.30, metalness: 0.06, envMapIntensity: 1.1,
    });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x101318, roughness: 0.62 });
    /**
     * §6.4: the goggle lens is the highest value-per-square-centimetre surface
     * in the game. A purple-blue mirror rather than a gold one, so the rider
     * carries exactly one warm accent and the lens reads as a cool highlight
     * against it. Roughness 0.08 is the middle of the 0.05–0.12 band, and with
     * `scene.environment` bound to sky.js's PMREM it picks up the sky gradient
     * and the snow horizon line for free.
     */
    const goggle = new THREE.MeshStandardMaterial({
      color: 0x7080c8, roughness: 0.08, metalness: 1.0, envMapIntensity: 1.9,
    });
    const strap = new THREE.MeshStandardMaterial({ color: 0xe8531f, roughness: 0.66 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.66 });
    const boot = new THREE.MeshStandardMaterial({ color: 0x24282f, roughness: 0.58 });
    const sole = new THREE.MeshStandardMaterial({ color: 0x3c4048, roughness: 0.86 });
    const binding = new THREE.MeshStandardMaterial({
      color: 0x2f3238, roughness: 0.42, metalness: 0.28, envMapIntensity: 1.1,
    });
    const buckle = new THREE.MeshStandardMaterial({
      color: 0xa8b0ba, roughness: 0.26, metalness: 0.95, envMapIntensity: 1.3,
    });
    const topsheet = new THREE.MeshStandardMaterial({
      map: makeTopsheetTexture(rng), roughness: 0.22, metalness: 0.12, envMapIntensity: 1.2,
    });
    const base = new THREE.MeshStandardMaterial({
      map: makeBaseTexture(rng), roughness: 0.12, metalness: 0.04, envMapIntensity: 1.7,
    });
    const sidewall = new THREE.MeshStandardMaterial({ color: 0x1a1e26, roughness: 0.34 });
    // Double-sided: the edge band is a three-quad ribbon wrapping the rail and
    // it must read as a bright line whichever side of the board is toward the
    // lens, including through the board on a fully layed-out toeside.
    const steel = new THREE.MeshStandardMaterial({
      color: 0xdfe6ee, roughness: 0.11, metalness: 1.0, envMapIntensity: 1.8,
      side: THREE.DoubleSide,
    });

    const M = {
      shell, shellDark, pants, helmet, rubber, goggle, strap, glove, boot, sole,
      binding, buckle, topsheet, base, sidewall, steel,
    };
    this._materials = Object.values(M);
    return M;
  }

  async build() {
    const rng = this._rng;
    const M = this._buildMaterials(rng);

    const bone = (name, parent, x = 0, y = 0, z = 0) => {
      const b = new THREE.Object3D();
      b.name = name;
      b.position.set(x, y, z);
      parent.add(b);
      this.bones[name] = b;
      return b;
    };
    const part = (geo, mat, parent, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    /** Detail trim — seams, cords, zips. Too small to be worth a shadow pass. */
    const trim = (geo, mat, parent, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = false;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    /** An overlapping joint ball, so no pose can open a seam at a joint. */
    const joint = (r, mat, parent, x = 0, y = 0, z = 0) =>
      part(new THREE.SphereGeometry(r, 12, 9), mat, parent, x, y, z);

    /* --- board ------------------------------------------------------ */
    const boardPivot = bone('boardPivot', this.object3D, 0, BOARD_LIFT, 0);
    const deck = part(boardGeometry(), [M.topsheet, M.base, M.sidewall], boardPivot);
    deck.name = 'deck';
    const edges = part(steelEdgeGeometry(), M.steel, boardPivot);
    edges.name = 'steelEdges';
    edges.castShadow = false;
    this.boardObject = boardPivot;

    // Bindings and their mount points — the leg IK targets. The mount sits on
    // the *deck surface* at that station rather than at a guessed constant, so
    // camber cannot float or sink the binding relative to the topsheet.
    const halfStance = DIM.stanceWidth * 0.5;
    for (const [tag, zPos, angle] of [['Front', halfStance, DIM.frontAngle], ['Back', -halfStance, DIM.backAngle]]) {
      const deckTop = boardStation(zPos).y + DIM.boardThickness;
      const mount = bone(`binding${tag}`, boardPivot, 0, deckTop, zPos);
      mount.rotation.y = angle;

      part(new THREE.BoxGeometry(0.135, 0.020, 0.30), M.binding, mount, 0, 0.010, 0);
      // Heelcup + highback.
      const hb = part(new THREE.BoxGeometry(0.128, 0.20, 0.026), M.binding, mount, 0, 0.115, -0.118);
      hb.rotation.x = -0.20;
      part(new THREE.BoxGeometry(0.132, 0.062, 0.028), M.binding, mount, 0, 0.040, -0.116);
      // Mounting disc.
      trim(new THREE.CylinderGeometry(0.052, 0.052, 0.008, 14), M.binding, mount, 0, 0.023, 0);

      // Ankle and toe straps: real arcs over the boot, with ratchet buckles and
      // ladder tails on the toe side.
      const ankle = trim(new THREE.TorusGeometry(0.072, 0.013, 6, 14, 2.5), M.rubber, mount, 0, 0.052, -0.010);
      ankle.rotation.set(Math.PI * 0.5, 0, Math.PI * 0.5 - 1.25);
      const toe = trim(new THREE.TorusGeometry(0.062, 0.011, 6, 14, 2.4), M.rubber, mount, 0, 0.036, 0.098);
      toe.rotation.set(Math.PI * 0.5, 0, Math.PI * 0.5 - 1.20);
      trim(new THREE.BoxGeometry(0.030, 0.022, 0.036), M.buckle, mount, 0.070, 0.062, -0.010);
      trim(new THREE.BoxGeometry(0.026, 0.018, 0.032), M.buckle, mount, 0.062, 0.044, 0.098);
      trim(new THREE.BoxGeometry(0.010, 0.052, 0.020), M.rubber, mount, -0.070, 0.040, -0.010);
    }

    /* --- rider ------------------------------------------------------ */
    // Hips sit above the board; the pose drives the actual ride height.
    const hips = bone('hips', boardPivot, 0, 0.78, 0);
    const pelvis = part(limbGeometry(0.20, 0.150, 0.140, 1.0, 12, 0.5, 0.55), M.pants, hips, 0, 0.10, 0);
    pelvis.scale.x = 0.84;
    joint(0.098, M.pants, hips, 0, 0, DIM.hipWidth * 0.55);
    joint(0.098, M.pants, hips, 0, 0, -DIM.hipWidth * 0.55);

    const spine = bone('spine', hips, 0, 0.06, 0);
    // The abdomen. Its absence is what left a 16 cm hole between the pelvis and
    // the ribcage — a torso mesh anchored at the chest bone and a pelvis mesh
    // anchored at the hips do not meet, and because both were open tubes the
    // hole showed their bright interiors.
    const abdomen = part(limbGeometry(0.23, 0.150, 0.158, 1.02, 14, 0.35, 0.55), M.shell, spine, 0, 0.21, 0);
    abdomen.scale.x = 0.82;
    // Drawcord hem, so the shell reads as a garment with an edge to it.
    const hem = part(new THREE.CylinderGeometry(0.170, 0.156, 0.052, 16), M.shellDark, spine, 0, -0.012, 0);
    hem.scale.x = 0.82;
    const cord = trim(new THREE.TorusGeometry(0.163, 0.0055, 6, 20), M.rubber, spine, 0, 0.008, 0);
    cord.rotation.x = Math.PI * 0.5;
    cord.scale.x = 0.82;

    const chest = bone('chest', spine, 0, DIM.spineLength, 0);
    const torso = part(limbGeometry(DIM.chestLength, 0.148, 0.176, 1.06, 14, 0.42, 0.5), M.shell, chest, 0, DIM.chestLength, 0);
    // A ribcage is deep along the shoulder line and shallow across it. With the
    // shoulders on Z, that means squashing X — the previous build squashed Z
    // and gave the rider a skier's chest on a snowboarder's stance.
    torso.scale.x = 0.74;

    // Construction: a chest panel seam, the main zip up the front (+X, which
    // is the way the chest faces), and a chest pocket with its own zip. The
    // zip and the pocket are lathe panels sharing the torso's own profile, so
    // they hug the barrel instead of sinking into it at the belly.
    const seam = trim(new THREE.TorusGeometry(0.174, 0.0055, 6, 24), M.shellDark, chest, 0, 0.145, 0);
    seam.rotation.x = Math.PI * 0.5;
    seam.scale.x = 0.74;
    const HP = Math.PI * 0.5;
    const zip = trim(
      limbPanel(DIM.chestLength, 0.148, 0.176, 1.06, 0.005, HP - 0.105, 0.21, 0.06, 0.92),
      M.shellDark, chest, 0, DIM.chestLength, 0,
    );
    zip.scale.x = 0.74;
    trim(new THREE.BoxGeometry(0.014, 0.024, 0.016), M.buckle, chest, 0.133, 0.056, 0);
    const pocket = trim(
      limbPanel(DIM.chestLength, 0.148, 0.176, 1.06, 0.006, HP - 0.86, 0.46, 0.22, 0.44),
      M.shellDark, chest, 0, DIM.chestLength, 0,
    );
    pocket.scale.x = 0.74;

    const neck = bone('neck', chest, 0, DIM.chestLength, 0);
    part(new THREE.CylinderGeometry(0.056, 0.064, DIM.neckLength + 0.03, 10), M.shellDark, neck, 0, DIM.neckLength * 0.45, 0);
    // Collar / hood bunched behind the neck — a silhouette detail that reads
    // even at 30 m and covers the neck-to-helmet junction from behind.
    const hood = part(new THREE.SphereGeometry(0.098, 12, 10), M.shellDark, chest, -0.070, DIM.chestLength * 0.96, 0);
    hood.scale.set(0.70, 0.78, 1.05);

    const head = bone('head', neck, 0, DIM.neckLength, 0);
    // Balaclava: the lower face, so there is a head under the helmet without
    // there ever being a face (§6.4, checklist 41).
    const face = part(new THREE.SphereGeometry(DIM.headRadius * 0.90, 12, 10), M.rubber, head, 0, DIM.headRadius * 0.42, 0.010);
    face.scale.set(0.92, 1.0, 1.02);

    const skull = part(new THREE.SphereGeometry(DIM.headRadius, 18, 14), M.helmet, head, 0, DIM.headRadius * 0.85, 0);
    skull.scale.set(1.0, 1.06, 1.10);
    // Shell seam and brim.
    const shellSeam = trim(new THREE.TorusGeometry(DIM.headRadius * 1.005, 0.004, 6, 22), M.rubber, head, 0, DIM.headRadius * 0.86, 0);
    shellSeam.rotation.y = Math.PI * 0.5;
    shellSeam.scale.set(1.10, 1.06, 1.0);
    const brim = part(new THREE.CylinderGeometry(DIM.headRadius * 1.03, DIM.headRadius * 1.0, 0.016, 18), M.helmet, head, 0, DIM.headRadius * 0.99, 0.008);
    brim.scale.z = 1.08;
    // Vent slots.
    for (const vz of [-0.055, 0.0, 0.055]) {
      trim(new THREE.BoxGeometry(0.052, 0.010, 0.020), M.rubber, head, 0, DIM.headRadius * 1.72, vz);
    }

    /**
     * The goggle. The old build put a squashed hemisphere at radius
     * 0.97 x headRadius *inside* a skull scaled to 1.10, so the lens was
     * buried in the helmet and the only thing visible was the strap torus —
     * "a flat orange stripe that reflects nothing" is exactly what that is.
     *
     * The lens is now a spherical cap on the +Z pole (the direction the head
     * faces), scaled proud of the skull in both X and Z so it stands off the
     * shell the way a real goggle does, with a rubber frame behind it and the
     * strap wrapping only the *back* of the helmet.
     */
    const lensGeo = new THREE.SphereGeometry(DIM.headRadius, 24, 14, 0, Math.PI * 2, 0, 0.92);
    lensGeo.rotateX(Math.PI * 0.5);
    const lens = part(lensGeo, M.goggle, head, 0, DIM.headRadius * 0.80, 0.004);
    lens.scale.set(1.06, 0.82, 1.22);
    lens.castShadow = false;

    const frameGeo = new THREE.SphereGeometry(DIM.headRadius * 1.005, 24, 14, 0, Math.PI * 2, 0, 1.06);
    frameGeo.rotateX(Math.PI * 0.5);
    const frame = trim(frameGeo, M.rubber, head, 0, DIM.headRadius * 0.80, 0.002);
    frame.scale.set(1.09, 0.88, 1.17);

    const strapGeo = new THREE.TorusGeometry(DIM.headRadius * 1.03, 0.011, 6, 26, 4.05);
    strapGeo.rotateZ(2.68);          // centre the covered arc on the back of the head
    strapGeo.rotateX(Math.PI * 0.5);
    const gstrap = trim(strapGeo, M.strap, head, 0, DIM.headRadius * 0.82, 0);
    gstrap.scale.set(1.06, 1.0, 1.08);

    /* --- arms -------------------------------------------------------- */
    // Shoulders sit on the **Z** axis: a snowboarder's shoulder line runs along
    // the deck, opened `chestOpen` toward the nose. 'L' is the front (nose-
    // side) arm, which is the hand the front-foot grabs use.
    for (const side of ['L', 'R']) {
      const sx = side === 'L' ? -1 : 1;
      const sh = bone(
        `shoulder${side}`, chest,
        sx * DIM.shoulderWidth * Math.sin(DIM.chestOpen),
        DIM.chestLength * 0.86,
        -sx * DIM.shoulderWidth * Math.cos(DIM.chestOpen),
      );
      joint(0.086, M.shellDark, sh);

      const ua = bone(`upperArm${side}`, sh, 0, 0, 0);
      part(limbGeometry(DIM.upperArm, 0.070, 0.058, 1.06, 12, 0.9, 0.95), M.shell, ua);
      // Shoulder-yoke seam and a bicep panel seam.
      const yoke = trim(new THREE.TorusGeometry(0.070, 0.005, 6, 16), M.shellDark, ua, 0, -0.062, 0);
      yoke.rotation.x = Math.PI * 0.5;

      joint(0.062, M.shell, ua, 0, -DIM.upperArm, 0);
      const fa = bone(`foreArm${side}`, ua, 0, -DIM.upperArm, 0);
      part(limbGeometry(DIM.foreArm, 0.056, 0.046, 1.04, 12, 0.95, 0.9), M.shellDark, fa);
      // Cuff tab at the wrist.
      const cuff = trim(new THREE.TorusGeometry(0.050, 0.008, 6, 16), M.rubber, fa, 0, -DIM.foreArm + 0.012, 0);
      cuff.rotation.x = Math.PI * 0.5;

      const hand = bone(`hand${side}`, fa, 0, -DIM.foreArm, 0);
      const mitt = part(new THREE.SphereGeometry(0.060, 12, 10), M.glove, hand, 0, -0.048, 0.004);
      mitt.scale.set(0.82, 1.30, 1.05);
      // A thumb, so the glove is a glove rather than a ball on a stick.
      const thumb = part(new THREE.CapsuleGeometry(0.020, 0.036, 3, 7), M.glove, hand, sx * 0.030, -0.042, 0.030);
      thumb.rotation.set(0.5, 0, -sx * 0.5);
      const knuckle = trim(new THREE.BoxGeometry(0.052, 0.030, 0.070), M.rubber, hand, 0, -0.086, 0.006);
      knuckle.rotation.x = 0.12;
    }

    /* --- legs -------------------------------------------------------- */
    for (const [side, tag] of [['F', 'Front'], ['B', 'Back']]) {
      const sz = side === 'F' ? 1 : -1;
      const hip = bone(`hip${side}`, hips, 0, 0, sz * DIM.hipWidth * 0.55);
      const thigh = bone(`thigh${side}`, hip, 0, 0, 0);
      part(limbGeometry(DIM.thighLength, 0.108, 0.084, 1.10, 14, 0.85, 0.95), M.pants, thigh);
      // Cargo pocket flap on the outer thigh.
      const cargo = trim(new THREE.BoxGeometry(0.014, 0.092, 0.084), M.pants, thigh, 0.104, -0.20, 0);
      cargo.rotation.z = -0.06;
      const thighSeam = trim(new THREE.TorusGeometry(0.090, 0.0055, 6, 18), M.pants, thigh, 0, -0.40, 0);
      thighSeam.rotation.x = Math.PI * 0.5;

      // Knee ball. Two tapered tubes that merely touch at a point read as a
      // break in the leg the instant the knee bends; an overlapping ball never
      // can.
      joint(0.088, M.pants, thigh, 0, -DIM.thighLength, 0);
      const shin = bone(`shin${side}`, thigh, 0, -DIM.thighLength, 0);
      part(limbGeometry(DIM.shinLength, 0.080, 0.064, 1.05, 14, 0.95, 0.6), M.pants, shin);
      // Knee panel seam below the joint (the one above rides on the thigh).
      const kneeSeam = trim(new THREE.TorusGeometry(0.082, 0.0055, 6, 18), M.pants, shin, 0, -0.060, 0);
      kneeSeam.rotation.x = Math.PI * 0.5;
      // Gaiter over the boot cuff.
      const gaiter = part(new THREE.CylinderGeometry(0.086, 0.076, 0.11, 12), M.pants, shin, 0, -DIM.shinLength + 0.055, 0);

      const bt = bone(`boot${side}`, shin, 0, -DIM.shinLength, 0);
      const bootMesh = part(new THREE.BoxGeometry(0.108, DIM.bootHeight, 0.245), M.boot, bt, 0, -DIM.bootHeight * 0.45, 0.015);
      bootMesh.name = `bootMesh${tag}`;
      part(new THREE.BoxGeometry(0.114, 0.024, 0.252), M.sole, bt, 0, -DIM.bootHeight * 0.94, 0.015);
      part(new THREE.CylinderGeometry(0.074, 0.080, 0.11, 10), M.boot, bt, 0, 0.030, -0.010);
      // BOA dial + a lace band, outboard so the camera sees them.
      trim(new THREE.CylinderGeometry(0.017, 0.017, 0.012, 12), M.buckle, bt, 0.056, 0.028, 0.020).rotation.z = Math.PI * 0.5;
      trim(new THREE.BoxGeometry(0.112, 0.012, 0.030), M.rubber, bt, 0, -0.012, 0.098);
    }

    /* --- contact darkening ------------------------------------------- */
    // Checklist 40 wants "a soft contact darkening under the board". It is a
    // child of the root rather than of boardPivot, because the patch belongs to
    // the *snow*: it lies in the surface plane and must not roll with the edge.
    const cg = new THREE.PlaneGeometry(1, 1);
    cg.rotateX(-Math.PI * 0.5);
    const contact = new THREE.Mesh(cg, new THREE.MeshBasicMaterial({
      map: makeContactTexture(),
      color: 0x2f4278,
      transparent: true,
      opacity: 0.50,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: true,
    }));
    contact.scale.set(0.82, 1, DIM.boardLength + 0.34);
    contact.position.y = this._boardLift - 0.0025;
    contact.renderOrder = 3;
    contact.name = 'boardContact';
    this.object3D.add(contact);
    this._contact = contact;
    this._materials.push(contact.material);

    this.ctx.scene.add(this.object3D);
    // The IK blends toward its solution rather than snapping, so settle the
    // pose before checking it (and before the first frame is drawn).
    const seed = this._defaultState();
    for (let i = 0; i < 20; i++) this._applyPose(0, seed, 1 / 60);
    this._verifyRig();
  }

  /**
   * Build check: every boot must land on its binding. The legs are the one
   * part of the rig that is solved rather than authored, so this is the one
   * place a silent regression can put a limb somewhere the hierarchy does not
   * imply. Runs once, at build, and costs nothing.
   */
  _verifyRig() {
    this.object3D.updateWorldMatrix(false, true);
    for (const [side, tag] of [['F', 'Front'], ['B', 'Back']]) {
      const bt = this.bones[`boot${side}`];
      const mount = this.bones[`binding${tag}`];
      if (!bt || !mount) { console.warn(`[rider] rig check: missing boot${side}/binding${tag}`); continue; }
      const d = this._chk.setFromMatrixPosition(bt.matrixWorld)
        .sub(this._chk2.setFromMatrixPosition(mount.matrixWorld)).length();
      if (d > 0.12) console.warn(`[rider] boot${side} is ${d.toFixed(3)} m off binding${tag}`);
    }
  }

  /**
   * Regular stance, left foot forward.
   *
   * The stance is not a pose detail, it is the rider's handedness, and it has
   * to be present at rest: a duck-stance rider's hips and chest sit rotated
   * toward the nose all the time, leading with the front shoulder, and the
   * head carries the rest of the way to face travel. Without this base yaw
   * the twist channel is zero at neutral, the body faces square across the
   * board, and the silhouette reads as goofy (or as nothing) from most
   * angles. Board +Z is the nose; a positive yaw about +Y carries the LEFT
   * side of the body toward it, which is what "regular" means.
   */
  static STANCE_YAW = { hips: 0.30, chest: 0.55, head: 0.85 };

  _defaultState() {
    return {
      position: new THREE.Vector3(), velocity: new THREE.Vector3(),
      heading: Math.PI, pitch: 0, roll: 0, edgeAngle: 0,
      grounded: true, airTime: 0, speed: 0, gForce: 1,
      crashed: false, flex: 0, edgeLoad: 0, sinkDepth: 0,
      normal: new THREE.Vector3(0, 1, 0), slipAngle: 0, landingImpact: 0,
    };
  }

  /* ------------------------------------------------------------------ *
   * Per-frame
   * ------------------------------------------------------------------ */
  update(dt, ctx) {
    const s = ctx.physics?.state;
    if (!s || !this.bones.hips) return;
    this._time += dt;

    // ---- Root placement -------------------------------------------
    // The board sits in the surface plane, not the horizontal plane. Aligning
    // the root's up-axis to the terrain normal is what stops a rider looking
    // like a sticker on a hillside.
    const root = this.object3D;
    root.position.copy(s.position);

    const n = s.normal ? this._v3.copy(s.normal) : this._v3.set(0, 1, 0);
    const fwd = this._v.set(Math.sin(s.heading), 0, Math.cos(s.heading));
    // In the air the board follows its own trajectory rather than the ground,
    // then re-acquires the surface normal as it comes back down.
    const up = s.grounded
      ? this._v2.copy(n)
      : this._v2.set(0, 1, 0).lerp(n, clamp01(1 - s.airTime * 1.4));
    up.normalize();
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-6) fwd.set(Math.sin(s.heading), 0, Math.cos(s.heading));
    fwd.normalize();
    const right = this._ikX.crossVectors(up, fwd).normalize();
    this._m.makeBasis(right, up, fwd);
    this._q.setFromRotationMatrix(this._m);
    // Slerp rather than snap: the terrain normal is a bilinear field and steps
    // between posts, and an unfiltered basis reads as a twitch at speed.
    root.quaternion.slerp(this._q, clamp01(dt * 18));

    // ---- Board ride height ------------------------------------------
    // `physics.state.position` is the board's *running surface* and is pushed
    // a centimetre or so below the heightfield while the board is sinking, so
    // that the contact solve has somewhere to go. Taken literally that buries
    // the deck: 14 mm of board under 10 mm of snow leaves only the rockered
    // nose showing, which is precisely the "dark triangular shard" the deck
    // had become. Read the real ground height back and put the base on it.
    const ground = ctx.terrain ? ctx.terrain.getHeight(s.position.x, s.position.z) : s.position.y;
    const sunk = clamp(ground - s.position.y, 0, 0.08);
    this._boardLift = damp(this._boardLift, sunk + BOARD_LIFT, 22, dt);

    this._applyPose(this._time, s, dt);
    this._updateContact(s, dt);
  }

  /**
   * The contact patch. It fades and spreads as the board leaves the snow —
   * a hard-edged AO decal still sitting under a rider three metres into a
   * front three is worse than no decal at all.
   */
  _updateContact(s, dt) {
    const c = this._contact;
    if (!c) return;
    const h = Math.max(0, s.airHeight || 0);
    const fade = s.grounded ? 1 : clamp01(1 - h / 1.6);
    const spread = 1 + clamp(h, 0, 1.6) * 0.55;
    c.material.opacity = 0.50 * fade;
    c.visible = fade > 0.02;
    c.scale.set(0.82 * spread, 1, (DIM.boardLength + 0.34) * lerp(1, 1.18, clamp01(h)));
    // The patch belongs to the snow, so it stays on the contact plane while
    // the root climbs away from it. `_boardLift` already carries the physics
    // sink; back off the 4 mm the deck itself floats by, then drop by the air
    // height so a small hop does not fly its own shadow around with it.
    c.position.set(0, this._boardLift - 0.0025 - h, 0);
  }

  /* ------------------------------------------------------------------ *
   * Pose
   * ------------------------------------------------------------------ */
  _applyPose(t, s, dt) {
    const B = this.bones;
    const A = this._an;
    const input = this.ctx.input?.state;
    const grabName = this.ctx.tricks?.current?.grab || input?.grab || null;

    // ---- Animation channels ---------------------------------------
    // Inclination: in a real carve the rider's whole body leans *into* the
    // turn to balance centripetal acceleration. The angle is not a style
    // choice — it is atan(a_lat / g), so a 2 g carve is a 63° lean and the
    // pose falls out of the physics for free.
    const inclineTarget = s.grounded
      ? clamp(Math.atan2((s.gForce - 1) * 9.81 * Math.sign(-(s.edgeAngle || 0)), 9.81), -0.85, 0.85)
        + (s.edgeAngle || 0) * -0.42
      : (s.roll || 0) * 0.5;
    A.incline = damp(A.incline, inclineTarget, 9, dt);

    // Absorption: legs compress under load and extend when light. This is the
    // single most important channel — a rider whose knees do not move looks
    // like a statue being dragged downhill.
    const loadAbsorb = clamp01((s.gForce - 1) * 0.55) + clamp01(s.flex || 0) * 0.6;
    const crouchIn = input ? clamp01(input.crouch) : 0;
    const airTuck = s.grounded ? 0 : clamp01(0.35 + (grabName ? 0.5 : 0.2));
    A.absorb = damp(A.absorb, clamp01(loadAbsorb + crouchIn * 0.8), 11, dt);
    A.tuck = damp(A.tuck, airTuck, 7, dt);
    A.compress = damp(A.compress, clamp01((s.landingImpact || 0) / 12), s.landingImpact ? 26 : 6, dt);
    A.edge = damp(A.edge, s.edgeAngle || 0, 10, dt);
    A.crash = damp(A.crash, s.crashed ? 1 : 0, s.crashed ? 12 : 2.5, dt);
    A.grabBlend = damp(A.grabBlend, grabName ? 1 : 0, 9, dt);
    if (grabName) this._grab = grabName;

    // Counter-rotation: the upper body leads the turn and the hips follow,
    // which is what separates a snowboarder from a skier in silhouette.
    A.twist = damp(A.twist, clamp(-(s.edgeAngle || 0) * 0.55 + (s.slipAngle || 0) * 0.5, -0.7, 0.7), 8, dt);

    const crash = A.crash;
    const live = 1 - crash;

    // ---- Board ------------------------------------------------------
    const bp = B.boardPivot;
    bp.rotation.z = (s.roll || 0);
    bp.rotation.x = (s.pitch || 0) * 0.4;
    bp.position.y = this._boardLift;

    // ---- Hips -------------------------------------------------------
    const hips = B.hips;
    // Ride height. Total leg length is 0.88 m, so standing the hips at 0.86
    // locks the knees straight — nobody rides like that. 0.735 puts roughly
    // 25° of bend in a neutral stance, which is where a rider actually lives
    // and which leaves the legs room to both extend and absorb.
    const standH = 0.735;
    // A grab is not just an arm pose — the rider pulls the deck up to the hand
    // by tucking harder, and without that extra drop the hand is left waving a
    // half-metre above a board it is nominally holding.
    const squat = A.absorb * 0.20 + A.tuck * 0.26 + A.compress * 0.13 + A.grabBlend * 0.13;
    hips.position.y = standH - squat;
    // Lean the mass across the board to balance the carve.
    hips.position.x = Math.sin(A.incline) * (0.30 + 0.18 * A.absorb) * live;
    hips.position.z = (A.tuck * -0.02) + (s.pitch || 0) * 0.06;
    hips.rotation.z = A.incline * 0.45 * live + crash * 0.9;
    hips.rotation.y = Rider.STANCE_YAW.hips + A.twist * 0.35;
    hips.rotation.x = A.tuck * 0.30 + A.absorb * 0.12 + crash * 0.5;

    // ---- Spine / chest ----------------------------------------------
    B.spine.rotation.z = A.incline * 0.28 * live;
    B.spine.rotation.x = A.tuck * 0.22 + A.absorb * 0.10;
    B.chest.rotation.y = (Rider.STANCE_YAW.chest - Rider.STANCE_YAW.hips) + A.twist * 0.62;
    B.chest.rotation.z = A.incline * 0.20 * live - crash * 0.6;
    B.chest.rotation.x = -A.tuck * 0.10 + A.absorb * 0.16 + crash * 0.7;

    // ---- Head -------------------------------------------------------
    // A rider looks where they are going: down the fall line and into the
    // turn, never at their own board. The helmet is built facing board +Z, so
    // an unrotated head bone already looks over the front shoulder; the twist
    // channel only leads or trails that.
    B.neck.rotation.y = (Rider.STANCE_YAW.head - Rider.STANCE_YAW.chest) * 0.45 - A.twist * 0.30;
    B.head.rotation.y = (Rider.STANCE_YAW.head - Rider.STANCE_YAW.chest) * 0.55 - A.twist * 0.45 + (s.grounded ? 0 : (s.airRotation || 0) * 0.05);
    B.head.rotation.x = clamp(-0.12 - A.tuck * 0.25 + A.absorb * 0.1, -0.5, 0.3) + crash * 0.4;
    B.head.rotation.z = -A.incline * 0.18 * live;

    // ---- Legs: two-bone IK onto the bindings -------------------------
    this._solveLeg('F', 'bindingFront', dt);
    this._solveLeg('B', 'bindingBack', dt);

    // ---- Arms --------------------------------------------------------
    this._poseArms(t, s, A, grabName, dt);
  }

  /**
   * Analytic two-bone IK. Given the world position of the binding, find the
   * thigh and shin rotations that put the boot on it, with the knee breaking
   * forward and slightly outward.
   *
   * There is no iteration here and no solver to converge: with two segments
   * and a target, the knee angle is the law of cosines and nothing else.
   */
  _solveLeg(side, bindingName, dt) {
    const B = this.bones;
    const hip = B[`hip${side}`];
    const thigh = B[`thigh${side}`];
    const shin = B[`shin${side}`];
    const target = B[bindingName];
    if (!hip || !target) return;

    // Target in the hip's local space.
    hip.updateWorldMatrix(true, false);
    target.updateWorldMatrix(true, false);
    const p = this._v.setFromMatrixPosition(target.matrixWorld);
    // Boots sit above the binding plate by the boot's own height.
    p.y += DIM.bootHeight * 0.5;
    hip.worldToLocal(p);

    const l1 = DIM.thighLength, l2 = DIM.shinLength;
    let dist = p.length();
    const maxReach = (l1 + l2) * 0.998;
    if (dist > maxReach) { p.multiplyScalar(maxReach / dist); dist = maxReach; }
    if (dist < 1e-4) return;

    // Law of cosines. Two segments and a target admit exactly one solution
    // up to the choice of which way the knee breaks, so there is nothing to
    // iterate and nothing to converge.
    const cosKnee = clamp((l1 * l1 + l2 * l2 - dist * dist) / (2 * l1 * l2), -1, 1);
    const knee = Math.PI - Math.acos(cosKnee);          // 0 = straight
    const cosThigh = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
    const thighOffset = Math.acos(cosThigh);            // thigh off the hip→target line

    // The knee pole: the direction the knee is displaced toward. A rider's
    // knees break the way their toes point, and in any stance that is
    // dominantly across the deck toward the toe edge — board +X — not toward
    // the nose. Getting this axis wrong is what makes procedural riders look
    // like they have their legs on backwards.
    const dir = this._ikDir.copy(p).normalize();
    const pole = this._ikPole.set(1, 0, 0);
    pole.addScaledVector(dir, -pole.dot(dir));
    if (pole.lengthSq() < 1e-8) {
      pole.set(0, 0, 1).addScaledVector(dir, -dir.z);
    }
    pole.normalize();

    // Thigh points along the hip→target line, swung off it toward the pole.
    const thighDir = this._ikThigh.copy(dir)
      .multiplyScalar(Math.cos(thighOffset))
      .addScaledVector(pole, Math.sin(thighOffset));

    // Build the thigh's basis explicitly rather than taking a shortest-arc
    // rotation, so we know exactly where its local axes end up: local −Y runs
    // down the bone, and local +X lands on the pole. That makes the shin's
    // bend a plain rotation about local +Z with no ambiguity.
    const yA = this._ikY.copy(thighDir).negate();
    const zA = this._ikZ.crossVectors(pole, yA).normalize();
    const xA = this._ikX.crossVectors(yA, zA).normalize();
    this._m.makeBasis(xA, yA, zA);
    this._ikQ.setFromRotationMatrix(this._m);

    const blend = clamp01(dt * 30);
    thigh.quaternion.slerp(this._ikQ, blend);
    // The shin bends by −knee, not +knee. The thigh was already swung off the
    // hip→target line *toward* the pole, so the knee is displaced to that
    // side; the shin has to come back across the line to put the foot on the
    // target. Bending it the same way as the thigh sends the foot out to
    // roughly twice the offset — which is exactly the half-metre miss that
    // left the boots hanging in the air beside the bindings.
    this._ikQ2.setFromAxisAngle(this._ikZ.set(0, 0, 1), -knee);
    shin.quaternion.slerp(this._ikQ2, blend);

    // Boot: cancel the accumulated leg rotation so the foot stays bolted flat
    // to the binding instead of pointing wherever the shin happened to end up.
    const bootBone = B[`boot${side}`];
    if (bootBone) {
      shin.updateWorldMatrix(true, false);
      this._ikQ.setFromRotationMatrix(target.matrixWorld);
      this._ikQ2.setFromRotationMatrix(shin.matrixWorld).invert();
      bootBone.quaternion.copy(this._ikQ2.multiply(this._ikQ));
    }
  }

  /**
   * Arms. Free-riding arms counterbalance the carve; grabbing arms reach for
   * a fixed point on the deck. Both are the same solve — only the target
   * changes — so a grab blends in and out without a transition clip.
   *
   * Two axes, and both are board-relative rather than body-relative, which is
   * what lets the grab table be written in board coordinates:
   *
   *   `swingX` — upper-arm rotation.z; +ve carries the hand toward **+X**, the
   *              toe edge, which is the way the chest faces.
   *   `alongZ` — upper-arm rotation.x; +ve carries the hand toward **−Z**, the
   *              tail. The front arm therefore wants a negative value.
   *
   * The old build fed `grab.point[1]` (nose-positive) straight into the second
   * of those, so every nose grab reached for the tail.
   */
  _poseArms(t, s, A, grabName, dt) {
    const B = this.bones;
    const grab = GRABS[grabName || this._grab] || null;
    const blend = grabName ? A.grabBlend : A.grabBlend * 0.0;

    for (const side of ['L', 'R']) {
      const sx = side === 'L' ? -1 : 1;
      const front = side === 'L' ? 1 : -1;   // +1 = the nose-side arm
      const ua = B[`upperArm${side}`];
      const fa = B[`foreArm${side}`];
      if (!ua) continue;

      // Free pose: arms spread along the deck for balance — one out over the
      // nose, one over the tail — held slightly ahead of the chest, with a
      // slow idle sway so a stationary rider is not a mannequin.
      const sway = Math.sin(t * 1.7 + sx) * 0.05 * clamp01(1 - s.speed / 12);
      let alongZ = -front * (0.52 + A.absorb * 0.14 - A.tuck * 0.30 + A.twist * front * 0.30) + sway;
      let swingX = 0.30 + A.incline * 0.35 + A.absorb * 0.16 + sway * 0.4;
      let elbow = 0.55 + A.absorb * 0.35 + A.tuck * 0.75;

      // Crashed riders throw their arms up and out.
      alongZ = lerp(alongZ, -front * 1.05, A.crash);
      swingX = lerp(swingX, 0.95, A.crash);
      elbow = lerp(elbow, 1.5, A.crash);

      // Grab: whichever hand the trick calls for reaches the deck point.
      const isGrabHand = grab && (
        (grab.hand === 'front' && side === 'L') || (grab.hand === 'back' && side === 'R')
      );
      if (isGrabHand && blend > 0.001) {
        // Reaching down and across to the board is a deep shoulder rotation
        // and a nearly closed elbow.
        // Small `swingX` means the arm hangs *down* — a grab reaches for the
        // deck, so the shoulder drops the arm and only leans it toe- or
        // heel-ward by the amount the grab point calls for.
        alongZ = lerp(alongZ, -(grab.point[1] + (grab.tweak[1] || 0)) * 0.80, blend);
        swingX = lerp(swingX, 0.10 + grab.point[0] * 1.1, blend);
        // A grab is a *reach*, so the elbow opens rather than closing: folding
        // it to 1.8 rad threw the forearm out sideways at chest height, which
        // is the opposite of the shape the trick has.
        elbow = lerp(elbow, 0.95, blend);
      } else if (grab && blend > 0.001) {
        // The other arm goes up and out — the tweak that sells the trick.
        alongZ = lerp(alongZ, -front * 0.95, blend * 0.7);
        swingX = lerp(swingX, 0.15, blend * 0.7);
        elbow = lerp(elbow, 0.40, blend * 0.7);
      }

      ua.rotation.x = damp(ua.rotation.x, alongZ, 12, dt);
      ua.rotation.z = damp(ua.rotation.z, swingX, 12, dt);
      fa.rotation.z = damp(fa.rotation.z, elbow, 12, dt);
    }
  }

  /* ------------------------------------------------------------------ *
   * Queries used by the FX and camera layers
   * ------------------------------------------------------------------ */
  getBoneWorldPosition(name, out = new THREE.Vector3()) {
    const b = this.bones[name];
    if (!b) return out.copy(this.object3D.position);
    b.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(b.matrixWorld);
  }

  /** World position of a board-local point — the emitter anchor for spray. */
  getBoardPoint(x, z, out = new THREE.Vector3()) {
    const bp = this.bones.boardPivot;
    if (!bp) return out.copy(this.object3D.position);
    bp.updateWorldMatrix(true, false);
    return out.set(x, 0, z).applyMatrix4(bp.matrixWorld);
  }

  dispose() {
    this.object3D.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    for (const m of this._materials || []) {
      if (m.map) m.map.dispose();
      m.dispose();
    }
    this.ctx.scene.remove(this.object3D);
  }
}
