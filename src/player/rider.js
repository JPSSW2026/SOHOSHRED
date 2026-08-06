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
 *   - **Board-local +Z is the nose, −X is the toe edge.** Both the stance and
 *     the shoulder line therefore run along **Z**, not X. A rig with the hips
 *     split along Z and the shoulders split along X is a skier wearing a
 *     snowboard, and it is the difference between a silhouette that reads as
 *     "snowboarder" at 30 m and one that reads as a shop mannequin.
 *   - **The head faces +Z** (down the board, down the fall line) while the
 *     chest faces roughly −X. That 80-odd degrees of separation is free once
 *     the shoulders are anchored along Z, and it is what makes the pose read.
 *
 *     The toe edge being −X is not arbitrary — it is what makes the rider
 *     REGULAR. The chest faces the toes, so with the nose at +Z a chest facing
 *     +X puts the anatomical right side toward the nose (goofy) and a chest
 *     facing −X puts the left side toward the nose (regular, left foot
 *     forward). The first build had the toe edge at +X and no amount of yaw
 *     could un-mirror it: the stance handedness is fixed the moment those two
 *     axes are chosen.
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
  /**
   * Binding angles, measured the way real ones are: from the board's
   * TRANSVERSE axis. 0° is a boot pointing straight across the deck at the
   * toe edge; +15° opens the front foot toward the nose, −6° closes the back
   * foot slightly toward the tail. Boots run across a snowboard, not along
   * it — along it is a skier.
   */
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

/**
 * Ankle-bone to the underside of the sole.
 *
 * The `boot{side}` bone is the ANKLE, and the boot geometry hangs below it:
 * the sole slab is centred 0.94 boot-heights down and is 24 mm thick. The
 * IK drives the ankle, so anything that wants the boot to sit ON something
 * has to add this — lifting by half a boot height (what the first pass did)
 * leaves the sole 7 cm under the topsheet and the whole binding-and-boot
 * assembly punches out through the base of the board.
 */
const SOLE_DROP = DIM.bootHeight * 0.94 + 0.012;

/** Top of the binding baseplate above its mount — what the sole rests on. */
const PLATE_TOP = 0.014;

/**
 * Grab points on the board, in board-local space. The x column is written
 * toe-positive — the toe edge is board −X, and the arm solve negates on
 * application — so "indy grabs the toe edge" stays legible as a positive x.
 */
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
  // face fabric from a flat painted surface at grazing angles. The white
  // overlays are relative to the base: on a dark kit the bright-base
  // opacities wash charcoal toward silver (round-8 black-out catch).
  const bl = ((base >> 16 & 255) * 0.2126 + (base >> 8 & 255) * 0.7152 + (base & 255) * 0.0722) / 255;
  const wA = bl > 0.3 ? 0.028 : 0.011;
  const wB = bl > 0.3 ? 0.045 : 0.018;
  g.strokeStyle = `rgba(255,255,255,${wA})`;
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
  g.strokeStyle = `rgba(255,255,255,${wB})`;
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
 * Cloth relief as a normal map — the half of "fabric" the albedo cannot carry.
 *
 * Round 6, all five critics: the kit read as "smooth plastic" because the
 * surface had colour variation but zero relief, so grazing light (the only
 * light this mountain has) raked across a mathematically smooth barrel. The
 * height field here is the construction of a real shell garment:
 *
 *  - soft wrinkle lobes at ~3-8 cm scale (fabric never lies flat),
 *  - the ripstop thread grid as fine grooves,
 *  - optionally, horizontal quilt channels with a stitch dip at each seam
 *    (the torso of an insulated jacket), rounded like a filled baffle.
 *
 * Sobel-differentiated into a tangent-space normal map. At the 2x3 repeat a
 * sleeve uses, the lobes land at real-wrinkle scale on a 960 px portrait.
 */
function makeClothNormalTexture(rng, { quilt = 0, wrinkle = 1.0, size = 256 } = {}) {
  const H = new Float32Array(size * size);

  // Wrinkle lobes: elongated soft ridges at random angles.
  const lobes = 26;
  for (let l = 0; l < lobes; l++) {
    const cx = rng() * size, cy = rng() * size;
    const ang = rng() * Math.PI;
    const len = size * (0.16 + rng() * 0.30);
    const wid = size * (0.04 + rng() * 0.07);
    const amp = (rng() - 0.35) * 0.9 * wrinkle;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const reach = Math.ceil(Math.max(len, wid) * 1.8);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const x = ((cx + dx | 0) + size) % size, y = ((cy + dy | 0) + size) % size;
        const u = (dx * ca + dy * sa) / len, v = (-dx * sa + dy * ca) / wid;
        const d2 = u * u + v * v;
        if (d2 < 1) H[y * size + x] += amp * (1 - d2) * (1 - d2);
      }
    }
  }

  // Quilt channels: horizontal filled baffles with a hard stitch dip between.
  if (quilt > 0) {
    const channels = 7;
    for (let y = 0; y < size; y++) {
      const t = (y / size) * channels % 1;
      const baffle = Math.pow(Math.sin(t * Math.PI), 0.55);      // rounded fill
      const stitch = Math.exp(-Math.pow(Math.min(t, 1 - t) * channels * 6, 2));
      const row = (baffle - stitch * 0.8) * quilt;
      for (let x = 0; x < size; x++) H[y * size + x] += row;
    }
  }

  // Ripstop grooves.
  for (let i = 0; i < size; i += 8) {
    for (let k = 0; k < size; k++) { H[i * size + k] -= 0.18; H[k * size + i] -= 0.18; }
  }

  // Sobel -> tangent-space normal.
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const S = 2.2; // slope scale
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = (x + size - 1) % size, xp = (x + 1) % size;
      const ym = (y + size - 1) % size, yp = (y + 1) % size;
      const dhx = (H[y * size + xp] - H[y * size + xm]) * 0.5 * S;
      const dhy = (H[yp * size + x] - H[ym * size + x]) * 0.5 * S;
      const inv = 1 / Math.hypot(dhx, dhy, 1);
      const i = (y * size + x) * 4;
      d[i] = (-dhx * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (dhy * inv * 0.5 + 0.5) * 255;
      d[i + 2] = (inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = CONFIG.render.anisotropy;
  return tex;
}

/**
 * A cuff / hem flare: a short flared skirt of cloth, open at the bottom but
 * curled inward so no raw edge ever faces the lens. Hung from the END of a
 * parent limb so it overlaps the child's top dome — the round-6 fix for
 * "visible ring seams at every joint": the joint is still two domes, but the
 * lens never sees where they meet.
 */
function cuffFlare(rTop, rBottom, len) {
  const pts = [
    new THREE.Vector2(rTop, 0),
    new THREE.Vector2(lerp(rTop, rBottom, 0.55) * 1.01, -len * 0.55),
    new THREE.Vector2(rBottom, -len * 0.9),
    new THREE.Vector2(rBottom * 1.015, -len),
    new THREE.Vector2(rBottom * 0.90, -len - 0.010),
  ];
  return new THREE.LatheGeometry(pts, 14);
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
    this._flipQ = new THREE.Quaternion();
    this._flipV = new THREE.Vector3();
    // IK scratch. The solver runs twice a frame and must not allocate.
    this._ikDir = new THREE.Vector3();
    this._ikUp = new THREE.Vector3();
    this._ikPole = new THREE.Vector3();
    this._ikThigh = new THREE.Vector3();
    this._ikX = new THREE.Vector3();
    this._ikY = new THREE.Vector3();
    this._ikZ = new THREE.Vector3();
    this._ikQ = new THREE.Quaternion();
    this._ikQ2 = new THREE.Quaternion();
    this._chk = new THREE.Vector3();
    this._chk2 = new THREE.Vector3();
    this._chk3 = new THREE.Vector3();

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
   * Skinned garments
   * ------------------------------------------------------------------ */
  /**
   * One continuous deformable cloth surface per garment piece, skinned to the
   * existing bone hierarchy — the fix the segment-and-conceal approach could
   * never reach (user: "flexible garment mesh over the round forms"). Each
   * tube is a stack of rings; every vertex carries linear-blend weights that
   * smoothstep from one bone to the next across a joint, so a bending knee
   * CURVES the fabric. There are no segment ends, so there are no rims.
   *
   * Built in the rest pose (all bone rotations zero, every chain hanging
   * straight down −Y), which makes the ring frames trivial: horizontal
   * ellipses stacked along the joint positions read straight from the bones'
   * rest matrices.
   */
  _buildSkinnedGarments(M) {
    this.object3D.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(this.object3D.matrixWorld).invert();
    const jointPos = (name, dy = 0) => {
      const p = new THREE.Vector3().setFromMatrixPosition(this.bones[name].matrixWorld)
        .applyMatrix4(rootInv);
      p.y += dy;
      return p;
    };

    /**
     * stations: [{bone, pos, r, sx}] — bone NAMES; crossing interior station j
     * blends bone[j-1] → bone[j] over 35% of the shorter adjacent span.
     * A terminal station may repeat its neighbour's bone (taper only).
     */
    const tube = (stations, mat, { seg = 14, capEnd = false, capStart = false } = {}) => {
      const boneNames = [];
      for (const st of stations) if (!boneNames.includes(st.bone)) boneNames.push(st.bone);
      const bones = boneNames.map((n) => this.bones[n]);

      // Arc length per station.
      const arc = [0];
      for (let i = 1; i < stations.length; i++) {
        arc.push(arc[i - 1] + stations[i].pos.distanceTo(stations[i - 1].pos));
      }
      const total = arc[arc.length - 1];

      // Blend windows at interior stations.
      const blend = stations.map((st, j) => {
        if (j === 0 || j === stations.length - 1) return 0;
        if (st.bone === stations[j - 1].bone) return 0;
        return 0.35 * Math.min(arc[j] - arc[j - 1], arc[j + 1] - arc[j]);
      });

      const pos = [], nrm = [], uv = [], sIdx = [], sWgt = [], idx = [];
      const rings = [];
      for (let j = 0; j < stations.length - 1; j++) {
        const span = arc[j + 1] - arc[j];
        const n = Math.max(3, Math.ceil(span * 22));
        for (let k = 0; k < n; k++) rings.push(arc[j] + (span * k) / n);
      }
      rings.push(total);

      const evalAt = (s) => {
        let j = 0;
        while (j < stations.length - 2 && s > arc[j + 1]) j++;
        const t = (s - arc[j]) / Math.max(arc[j + 1] - arc[j], 1e-6);
        const a = stations[j], b = stations[j + 1];
        return {
          p: a.pos.clone().lerp(b.pos, t),
          r: a.r + (b.r - a.r) * t,
          sx: (a.sx ?? 1) + ((b.sx ?? 1) - (a.sx ?? 1)) * t,
          taper: (a.r - b.r) / Math.max(arc[j + 1] - arc[j], 1e-6),
        };
      };
      const weightsAt = (s) => {
        // Walk the interior stations; each crossing hands weight to its bone.
        let wPrev = 1, bPrev = boneNames.indexOf(stations[0].bone);
        for (let j = 1; j < stations.length - 1; j++) {
          if (blend[j] === 0) continue;
          const t = THREE.MathUtils.smoothstep(s, arc[j] - blend[j], arc[j] + blend[j]);
          if (t <= 0) break;
          const bNext = boneNames.indexOf(stations[j].bone);
          if (t >= 1) { wPrev = 1; bPrev = bNext; continue; }
          return [bPrev, 1 - t, bNext, t];
        }
        return [bPrev, wPrev, -1, 0];
      };

      const smooth = (f) => f * f * (3 - 2 * f);
      for (let ri = 0; ri < rings.length; ri++) {
        const s = rings[ri];
        const { p, r, sx, taper } = evalAt(s);
        const [b0, w0, b1, w1] = weightsAt(s);
        for (let k = 0; k <= seg; k++) {
          const a = (k / seg) * Math.PI * 2;
          const ca = Math.cos(a), sa = Math.sin(a);
          // Cloth ease: a perfect ellipse stack reads as a rigid box (user
          // catch). Two low-frequency lobes, phase-drifting along the tube,
          // give the silhouette the slack of fabric over a body.
          const rr = r * (1 + 0.035 * Math.sin(3 * a + s * 5.0)
                            + 0.022 * Math.sin(5 * a - s * 3.0));
          pos.push(p.x + ca * rr * sx, p.y, p.z + sa * rr);
          const nx = ca / Math.max(sx, 0.5);
          const inv = 1 / Math.hypot(nx, taper, sa);
          nrm.push(nx * inv, taper * inv, sa * inv);
          uv.push(k / seg, s / Math.max(total, 1e-6));
          sIdx.push(b0, b1 < 0 ? 0 : b1, 0, 0);
          sWgt.push(w0, w1, 0, 0);
        }
      }
      for (let ri = 0; ri < rings.length - 1; ri++) {
        const a = ri * (seg + 1), b = a + seg + 1;
        for (let k = 0; k < seg; k++) {
          idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
        }
      }
      // Optional end cap: a dome shrinking to the axis (collar top, hem lip).
      if (capEnd) {
        const s = total;
        const { p, r, sx } = evalAt(s);
        const [b0, w0, b1, w1] = weightsAt(s);
        const capRings = 3;
        for (let c = 1; c <= capRings; c++) {
          const f = c / capRings;
          const rr = r * Math.cos(f * Math.PI * 0.5);
          const lift = r * 0.55 * Math.sin(f * Math.PI * 0.5);
          for (let k = 0; k <= seg; k++) {
            const a = (k / seg) * Math.PI * 2;
            const ca = Math.cos(a), sa = Math.sin(a);
            pos.push(p.x + ca * rr * sx, p.y + lift, p.z + sa * rr);
            const inv = 1 / Math.hypot(ca * (1 - f), 1.2 * f, sa * (1 - f));
            nrm.push(ca * (1 - f) * inv, 1.2 * f * inv, sa * (1 - f) * inv);
            uv.push(k / seg, 1);
            sIdx.push(b0, b1 < 0 ? 0 : b1, 0, 0);
            sWgt.push(w0, w1, 0, 0);
          }
        }
        const base = rings.length - 1;
        for (let c = 0; c < capRings; c++) {
          const a = (base + c) * (seg + 1), b = a + seg + 1;
          for (let k = 0; k < seg; k++) {
            idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
          }
        }
      }

      // Start cap: an inward dome over the first ring, so an open tube
      // mouth (a sleeve top seen from above) never shows its hollow inside
      // - the "see-through body parts" of the user's v9 zooms.
      if (capStart) {
        const s0 = 0;
        const { p, r, sx } = evalAt(s0);
        const [b0, w0, b1, w1] = weightsAt(s0);
        const capRings = 3;
        let base = rings.length + 0;   // rows appended after existing ones
        // account for capEnd rows already appended
        base = pos.length / (3 * (seg + 1)) ;
        for (let c = 1; c <= capRings; c++) {
          const f = c / capRings;
          const rr = r * Math.cos(f * Math.PI * 0.5);
          const lift = r * 0.5 * Math.sin(f * Math.PI * 0.5);
          for (let k = 0; k <= seg; k++) {
            const a = (k / seg) * Math.PI * 2;
            const ca = Math.cos(a), sa = Math.sin(a);
            pos.push(p.x + ca * rr * sx, p.y + lift, p.z + sa * rr);
            const inv = 1 / Math.hypot(ca * (1 - f), 1.1 * f, sa * (1 - f));
            nrm.push(ca * (1 - f) * inv, 1.1 * f * inv, sa * (1 - f) * inv);
            uv.push(k / seg, 0);
            sIdx.push(b0, b1 < 0 ? 0 : b1, 0, 0);
            sWgt.push(w0, w1, 0, 0);
          }
        }
        for (let c = 0; c < capRings; c++) {
          const rowA = c === 0 ? 0 : base + c - 1;
          const a = rowA * (seg + 1), b = (base + c) * (seg + 1);
          for (let k = 0; k < seg; k++) {
            idx.push(a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k);
          }
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(sIdx, 4));
      geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sWgt, 4));
      geo.setIndex(idx);

      const mesh = new THREE.SkinnedMesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;   // skinned bounds never update
      this.object3D.add(mesh);
      const inverses = bones.map((b) =>
        new THREE.Matrix4().copy(b.matrixWorld).premultiply(rootInv).invert());
      mesh.bind(new THREE.Skeleton(bones, inverses), new THREE.Matrix4());
      return mesh;
    };

    /* Pant legs: yoke ring on the pelvis, thigh, shin, into the gaiter. */
    for (const side of ['F', 'B']) {
      const hip = jointPos(`hip${side}`);
      tube([
        // Snowboard pants are a wide tube that barely tapers and breaks over
        // the boot. These were a leg cast: 0.128 at the hip down to 0.085 at
        // the ankle, a 34% taper, which is a cyclist's tights.
        //
        // The numbers here are NOT chasing the reference's silhouette area,
        // and an earlier version of this comment claiming we carried 60% of
        // its mass was wrong. tools/rider-compare.mjs was rendering the two
        // figures in different orientations: identity put our board's long
        // axis straight down the camera's line of sight while the reference
        // carries its board across, so our board was seen end-on AND the
        // stance spread -- which runs along the board -- was foreshortened
        // with it. Orientation-matched, ours measures 0.418 silhouette area
        // against the reference's 0.379: not short of mass, slightly over it.
        // The lower legs in particular measured 0.49-0.52 against 0.29-0.30.
        //
        // What the comparison can and cannot settle: the two figures are in
        // different POSES, so any band whose width depends on limb placement
        // -- the arm bands, the stance bands -- is not comparable at all. It
        // is good for gross mass and for the torso core, and that is all it is
        // used for here.
        // BAGGY, not fitted. Rendered beside the reference on one card, the
        // single pose-independent difference left between the two figures is
        // the trouser: the reference's are a loose insulated pant that holds
        // its width from the hip through the knee and only gathers at the
        // cuff, and ours were a close tube that pinched at the knee. Garment
        // volume is a property of the garment, so unlike the width bands --
        // which depend entirely on where the limbs happen to be, and are not
        // comparable between two figures in different poses -- this one is
        // readable straight off the card.
        //
        // A reshape with a modest mass increase, not another volume round:
        // total silhouette area goes 0.373 against the reference's 0.379, so
        // there is room for it and not much more.
        { bone: 'hips',          pos: hip.clone().setY(hip.y + 0.085), r: 0.176, sx: 0.96 },
        { bone: `thigh${side}`,  pos: hip,                             r: 0.176, sx: 0.96 },
        { bone: `thigh${side}`,  pos: jointPos(`shin${side}`, 0.05),   r: 0.166 },
        { bone: `shin${side}`,   pos: jointPos(`shin${side}`, -0.04),  r: 0.148 },
        // Widens again at the cuff: the hem sits ON the boot, it does not
        // shrink to the ankle.
        // A hem that sits ON the boot, not a lampshade over it. At 0.148 the
        // cuff was a 29.6 cm bell dropped over a boot 10.8 cm wide, and it
        // rendered as a hard scalloped cone ending in mid-air above the ankle.
        { bone: `shin${side}`,   pos: jointPos(`boot${side}`, 0.062),  r: 0.126 },
        // ...and then CLOSES onto it. Same defect the sleeve had: the profile
        // ended on its widest ring, so the hem finished as an open 23 cm disc
        // floating above a 10.8 cm boot — a lampshade, with a hard scalloped
        // rim. A pant hem is a gaiter with a hem cord: it stands off the shin
        // and grips down over the boot top, so the last ring is the narrowest.
        { bone: `shin${side}`,   pos: jointPos(`boot${side}`, 0.024),  r: 0.104 },
        { bone: `boot${side}`,   pos: jointPos(`boot${side}`, -0.014), r: 0.082 },
        // Capped BOTH ends. Open tubes are why the rider was see-through:
        // with front-side culling you look straight down the inside of the
        // garment, and in close-spray the snow showed through the pelvis.
      ], M.pants, { capStart: true, capEnd: true }).name = `pantLeg${side}`;
    }
    /* Pelvis / seat, bridging the two legs under the jacket hem. */
    {
      const hips = jointPos('hips');
      tube([
        // The seat is one of the few bands where the orientation-matched
        // comparison still shows us narrow (0.446 against 0.525), and a 0.86
        // squash was pressing the one part of the figure that should be full
        // into a plate. Widened, but nothing like the round that was chasing
        // the mis-oriented profile.
        { bone: 'hips', pos: hips.clone().setY(hips.y - 0.10), r: 0.166, sx: 0.92 },
        { bone: 'hips', pos: hips.clone().setY(hips.y + 0.12), r: 0.176, sx: 0.92 },
      ], M.pants, { capStart: true, capEnd: true }).name = 'seat';
    }
    /* Jacket body: hem below the hips to the collar, one surface. */
    {
      const hips = jointPos('hips');
      const chest = jointPos('chest');
      const collarY = chest.y + DIM.chestLength;
      tube([
        // An insulated shell, not a base layer. Radii up ~18% and the
        // front-to-back squash relaxed (sx was pressing the torso into a
        // flat plate, which is why the figure read thin from every angle
        // except dead front).
        // A HEM, then a body, then a chest -- not one monotone taper. A single
        // smooth cone from hips to collar is why this read as a tabard rather
        // than a jacket: real shells drop below the seat, flare, and pull in
        // on a hem band, and that break is most of what says "garment" at any
        // distance. The profile below goes hem edge -> flare -> waist -> chest,
        // so each section has to disagree with its neighbours.
        // The BREAK is the point, not the volume: radii sit essentially where
        // they did before the hem was added, so this is a reshape and not
        // another mass increase.
        { bone: 'hips',  pos: hips.clone().setY(hips.y - 0.075),  r: 0.210, sx: 0.92 },
        { bone: 'hips',  pos: hips.clone().setY(hips.y - 0.030),  r: 0.226, sx: 0.92 },
        { bone: 'hips',  pos: hips.clone().setY(hips.y + 0.035),  r: 0.206, sx: 0.90 },
        { bone: 'spine', pos: jointPos('spine', 0.10),            r: 0.192, sx: 0.88 },
        { bone: 'chest', pos: chest.clone().setY(chest.y + 0.02), r: 0.208, sx: 0.87 },
        { bone: 'chest', pos: chest.clone().setY(collarY * 0.55 + chest.y * 0.45), r: 0.200, sx: 0.85 },
        { bone: 'chest', pos: chest.clone().setY(collarY - 0.012), r: 0.170, sx: 0.85 },
      ], M.shell, { capStart: true, capEnd: true }).name = 'jacketBody';
    }
    /* Sleeves: a short yoke on the chest, then upper arm and forearm. */
    for (const side of ['L', 'R']) {
      const sh = jointPos(`shoulder${side}`);
      tube([
        // A padded sleeve holds its diameter to the cuff. Ours tapered 40%
        // from shoulder to wrist, which is the shape of a bare arm.
        // An ELBOW and a CUFF. Holding diameter to the wrist fixed the tights
        // problem but left a smooth tapered tube -- a sleeve with no articulation
        // anywhere along it. A worn shell bunches at the elbow and flares at
        // the cuff over the glove, so the profile has to go out, in, out.
        { bone: 'chest',           pos: sh.clone().setY(sh.y + 0.055), r: 0.118 },
        { bone: `upperArm${side}`, pos: sh,                            r: 0.114 },
        { bone: `upperArm${side}`, pos: jointPos(`foreArm${side}`, 0.075), r: 0.096 },
        { bone: `upperArm${side}`, pos: jointPos(`foreArm${side}`, 0.020), r: 0.108 },
        { bone: `foreArm${side}`,  pos: jointPos(`foreArm${side}`, -0.05), r: 0.092 },
        { bone: `foreArm${side}`,  pos: jointPos(`hand${side}`, 0.062),    r: 0.086 },
        // Cuff band, then CLOSE onto the glove. The profile used to end on
        // its widest ring, so the sleeve finished as an open 20 cm disc with
        // a 10 cm mitt poking out of it — a wizard sleeve, and the loudest
        // wrong note anywhere on the figure at a close crop. A shell cuff is
        // an elasticated band: it stands proud of the forearm and then grips
        // down onto the glove, so the last ring has to be the NARROWEST.
        { bone: `foreArm${side}`,  pos: jointPos(`hand${side}`, 0.030),    r: 0.101 },
        { bone: `foreArm${side}`,  pos: jointPos(`hand${side}`, 0.010),    r: 0.090 },
        // Close onto the 0.048 wrist bridge, not merely narrower than the
        // ring before it: at 0.070 the cuff still ended clear of the wrist and
        // you looked down an open annulus into the inside of the sleeve.
        { bone: `foreArm${side}`,  pos: jointPos(`hand${side}`, -0.016),   r: 0.044 },
        // SHELL, not shellDeep. Rendered beside the reference under one light
        // rig, that figure reads as a magenta rider throughout -- its sleeves
        // are the same bright shell as its body, measurably 1.2-2.1x the body's
        // own value -- while ours read 0.09x the body and the figure came out
        // as a dark silhouette with a red bib. Dark sleeves were a §6.3
        // high-chroma-budget decision; the reference the user pointed at does
        // not make it, and the reference is the brief.
        //
        // Judged, not measured: the two figures are in different poses under
        // one light rig, so absolute per-part values are not comparable (our
        // body renders at 0.60 of its albedo and our legs at 0.17, purely from
        // facing). The within-figure ratio is what carries.
      ], M.shell, { capEnd: true, capStart: true }).name = `sleeve${side}`;
    }
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
    const cloth = (base, rough, sheen, repeat, normalOpts = {}) => {
      const map = makeShellTexture(rng, base);
      map.repeat.set(repeat[0], repeat[1]);
      const normalMap = makeClothNormalTexture(rng, normalOpts);
      normalMap.repeat.set(repeat[0], repeat[1]);
      const m = new THREE.MeshPhysicalMaterial({
        map,
        normalMap,
        // Strong enough that the 10.6° sun rakes real shading out of the
        // wrinkles (round 6: "smooth plastic" was the absence of exactly
        // this relief; the user's Shredders reference is all fold shading).
        normalScale: new THREE.Vector2(0.95, 0.95),
        color: 0xffffff,
        roughness: rough,
        metalness: 0.0,
        sheen,
        sheenRoughness: 0.55,
        // Whitening the sheen 35% was a third of the salmon wash the user
        // called out — the grazing fuzz was painting the whole silhouette
        // pastel. Keep the fuzz, keep it red.
        sheenColor: new THREE.Color(base).lerp(new THREE.Color(0xffffff), 0.08),
        // A whisper of same-hue emissive keeps saturated kit colours from
        // greying out under AgX in shade - the trick every game uses to make
        // a signal jacket read as signal at all light levels.
        emissive: new THREE.Color(base),
        emissiveIntensity: 0.02,
      });
      // The snow env probe is ~5x brighter than the kit's albedo, and its
      // IBL contribution is what silvers the sunlit panels (round 4
      // close-ups; halving the sheen barely moved them). Matte softgoods
      // keep a fraction of it — enough to model the folds in shade.
      m.envMapIntensity = 0.30;
      return m;
    };

    // Albedo floors matter more than any lighting trick here: charcoal
    // garments authored at L≈20 render as voids on open snow no matter how
    // much bounce the scene has, and the round-3 critics measured the limbs
    // at L14 — "black wet plastic". Real dark softgoods sit nearer L 30–38
    // albedo, and the roughness goes UP relative to the first build so the
    // sun highlight spreads into a fabric sheen instead of a wet specular.
    // The Cardrona snowboard-instructor kit (user's reference): signal-red
    // jacket with a black shoulder yoke/hood, black pants, black hardware.
    // The red is the frame's single high-chroma element (§6.3) and pops
    // against both the snow and the range wall. Sleeves are red full length —
    // round 5 flagged mixed limb blocking as "bare capsule" segments.
    // Head-to-toe Cardrona red (the full-body instructor reference): warm
    // tomato-red jacket, matching red pants a half-step darker so the
    // garments separate, black helmet/gloves/hardware, black balaclava.
    // ALL red, per the user: one continuous Cardrona red across jacket,
    // yoke, hood and pants — the silhouette reads as a single red figure
    // against the snow, exactly like the instructor reference. Black stays
    // only on helmet, gloves, boots and hardware.
    // Matched to the user's Shredders red-jacket reference: flame red-orange,
    // matte (the ref jacket has no specular ping at all — the life is in the
    // FOLD SHADING), with bold wrinkle relief. Torso wrinkles biggest (loose
    // shell over insulation), sleeves a touch finer, pants heaviest and a
    // step darker so the garments separate tonally like the reference.
    // AgX note (user's Shredders ref): a BRIGHT saturated red albedo gets
    // rendered salmon — AgX desaturates high-luminance primaries. The ref
    // jacket's red is deep (~#C33) and keeps its chroma; the highlights get
    // their orange from shading, not from the albedo. So: darker base, and
    // the emissive floor carries the signal in shade.
    // ALL BLACK (user: black the rider out and let the silhouette carry).
    // Round-3 law still binds: true-black albedo renders as a void on open
    // snow, so the kit sits at charcoal (L~30-36) where the snow bounce can
    // still model the folds, with a restrained fabric sheen. The jacket a
    // half-step lighter than the pants so the garments separate; the
    // mirrored goggle becomes the rider's single accent.
    // Round 4 (trick close-ups): in full sun the black kit washed to
    // silver — the sheen fuzz brightening at grazing angles was painting
    // whole sunlit panels pastel over a charcoal base. Half the sheen and
    // a touch more roughness keeps the fabric fuzz in the rim light only;
    // the albedo (locked charcoal, L~30-36 law) is untouched.
    // (Round-4 note: a darker albedo was tried against the sunlit wash and
    // measured nearly invisible — the lit panels sit on the AgX shoulder,
    // so the wash is exposure physics, not the kit. Albedo stays at the
    // locked charcoal.)
    /**
     * RIDER STYLE PALETTE -- sampled from the supplied reference GLB.
     *
     * Everything the reference changes about the rider's look lives in this
     * one block, deliberately, so the whole style is a single revert if it
     * does not survive contact with the game.
     *
     * The reference is a hooded two-tone shell -- a bright magenta body with a
     * deeper crimson hood and yoke -- over dark plum pants, near-black gloves,
     * pale boots and a light cyan deck. Dominant bins measured off a render of
     * the asset: #903050 and #703050 for the shell, #501030 and #301030 for
     * the plum, #101010/#303030 for the gloves, #70b0d0 for the board.
     *
     * This supersedes §6.3's #E8531F orange. The doc's rule -- ONE high-chroma
     * garment colour carrying the figure, everything else low-chroma -- still
     * holds; the reference simply picks a different hue for it, and the
     * two-tone split gives the yoke and sleeve blocking something real to do.
     */
    const RIDER_STYLE = {
      shell: 0xa82d5e,      // jacket body: the one high-chroma note. Deeper than
                            // the sampled magenta, which blew to flesh-pink
                            // under grazing sun.
      shellDeep: 0x3f2440,  // sleeves, hood, yoke: dark plum, NOT a second
                            // crimson. Two saturated colours in one hue family
                            // mush at distance instead of blocking, and the
                            // sleeves were reading as bare pink arms in
                            // close-spray.
                            //
                            // "Dark limbs against a bright torso is the block
                            // the reference actually has" used to be asserted
                            // here. It is FALSE. Rendered beside it under one
                            // light rig and cropped large, the reference's
                            // sleeves are the BRIGHTEST thing on the figure --
                            // the same magenta as the body, 1.2-2.1x its
                            // value. Only the hood and yoke go deeper. The
                            // sleeves are on M.shell accordingly.
      pants: 0x453155,      // lifted a step: at 0x33203a the legs read as a void beside the reference's plum
      glove: 0x141416,
      // Charcoal, not pale. "The reference's one bright accent below the knee"
      // was asserted here for a near-white 0xd6d8dd, and it is FALSE: cropped
      // large, the reference's boots are dark charcoal with a glossy toe
      // highlight, and its one bright accent is the SLEEVES. Under the game's
      // sun a near-white boot blew out and the portrait read as two white
      // blocks bolted to the deck, which is the same error seen from the
      // other end.
      boot: 0x2c2f36,
      helmet: 0x2a1830,     // plum-black, under the hood
    };
    const shell = cloth(RIDER_STYLE.shell, 0.66, 0.11, [1.4, 2], { quilt: 0.12, wrinkle: 1.1 });
    const shellGrey = cloth(RIDER_STYLE.shellDeep, 0.66, 0.11, [1.4, 2], { wrinkle: 1.1 });
    const pants = cloth(RIDER_STYLE.pants, 0.68, 0.10, [1.4, 2], { wrinkle: 1.2 });
    const shellDark = shellGrey; // collar/hem trim reads as the deep crimson blocking

    const helmet = new THREE.MeshStandardMaterial({
      color: RIDER_STYLE.helmet, roughness: 0.46, metalness: 0.06, envMapIntensity: 1.1,
    });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.66 });
    /**
     * §6.4: the goggle lens is the highest value-per-square-centimetre surface
     * in the game. A purple-blue mirror rather than a gold one, so the rider
     * carries exactly one warm accent and the lens reads as a cool highlight
     * against it. Roughness 0.08 is the middle of the 0.05–0.12 band, and with
     * `scene.environment` bound to sky.js's PMREM it picks up the sky gradient
     * and the snow horizon line for free.
     */
    // A goggle lens has to read as a bright band on its own, not only where
    // the environment happens to reflect in it. At metalness 1.0 a standard
    // material has no diffuse term at all, so away from a strong reflection
    // the lens rendered as a black void with a single specular dot in it --
    // which on a dark head is an eye, and is most of why this looked like an
    // alien. Dropping metalness gives it a body colour that survives any
    // lighting; the emissive keeps it live in shadow, where a mirrored lens
    // still glows against a shaded face.
    const goggle = new THREE.MeshStandardMaterial({
      color: 0x9fb4e8, roughness: 0.14, metalness: 0.45, envMapIntensity: 1.9,
      emissive: 0x22304f, emissiveIntensity: 0.55,
    });
    const strap = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.66 });
    const glove = new THREE.MeshStandardMaterial({ color: RIDER_STYLE.glove, roughness: 0.72 });
    // Pale boots are the reference's one bright note below the knee, and they
    // do real work: against dark plum pants they separate the feet from the
    // legs, so the stance reads at chase distance instead of merging into one
    // dark column.
    const boot = new THREE.MeshStandardMaterial({ color: RIDER_STYLE.boot, roughness: 0.68 });
    const sole = new THREE.MeshStandardMaterial({ color: 0x3c4048, roughness: 0.86 });
    // Composite, not metal. At roughness 0.42 / metalness 0.28 under a bright
    // snow-and-sky environment the hardware picked up so much specular that
    // it rendered PALER than the boot it is bolted to, and the baseplate and
    // highback read as a light-grey exoskeleton clamped round a dark boot --
    // the loudest thing below the knee, on a part that should disappear. A
    // real baseplate and highback are matte glass-filled nylon.
    const binding = new THREE.MeshStandardMaterial({
      color: 0x2b2e34, roughness: 0.62, metalness: 0.06, envMapIntensity: 0.7,
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
      shell, shellGrey, shellDark, pants, helmet, rubber, goggle, strap, glove, boot, sole,
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

      // The binding hardware is authored with the boot's long axis on local
      // +Z, then the whole plate is yawed −90° so that axis lands ACROSS the
      // deck with the toes at −X (the toe edge) and the highback on the heel
      // edge at +X. The mount bone itself carries only the stance angle, so
      // the leg IK targets stay a pure "0° = straight across" convention.
      const plate = new THREE.Object3D();
      plate.rotation.y = -Math.PI * 0.5;
      mount.add(plate);

      part(new THREE.BoxGeometry(0.108, 0.014, 0.255), M.binding, plate, 0, 0.007, 0).name = `basePlate${tag}`;
      // Heelcup + highback — behind the boot, which after the plate yaw is
      // the heel edge of the board.
      const hb = part(new THREE.BoxGeometry(0.096, 0.155, 0.014), M.binding, plate, 0, 0.095, -0.104);
      hb.name = `highback${tag}`;
      hb.rotation.x = -0.24;
      // Taper: a highback narrows toward the top.
      hb.scale.set(1, 1, 1); hb.geometry.translate(0, 0, 0);
      part(new THREE.BoxGeometry(0.104, 0.045, 0.016), M.binding, plate, 0, 0.030, -0.102);
      // Mounting disc.
      trim(new THREE.CylinderGeometry(0.052, 0.052, 0.008, 14), M.binding, plate, 0, 0.023, 0);

      // Ankle and toe straps: real arcs over the boot, with ratchet buckles and
      // ladder tails on the toe side.
      // Strap radii are bounded by the BOARD, not just by the boot: measured
      // per vertex the ankle strap now reaches 0.1414 against a 0.1396 deck
      // half-width, so the hardware sits inside the board's outline.
      //
      // A note on how these numbers were arrived at, because the first pass
      // was wrong: the original probe took each geometry's LOCAL bounding box
      // and transformed it, which for a torus rotated on two axes inflates the
      // extent enormously -- it reported 3.3 cm of overhang on straps whose
      // real vertices were nearly flush. An AABB of a transformed AABB is a
      // bound, not a measurement. tools/board-preview.mjs walks vertices now.
      // The reported "bindings through the base" was never this at all; it was
      // the leg IK, fixed in _solveLeg.
      // Sized to ARCH OVER the boot. The boot is 0.108 across, so a strap of
      // ring radius 0.050 cannot get over it -- it sat buried inside the boot
      // and the portrait showed white boot blocks with no visible hardware on
      // them at all. That shrink was chasing the bad AABB overhang figure; the
      // vertex probe says the board has the room.
      //
      // The toe strap does measure ~1.9 cm outside the board's widest half-
      // width (0.1584 against 0.1396), and that is CORRECT, not a defect: it
      // sits over the toe edge at board x -0.0875 by construction, and real
      // boots overhang the toe edge. Naming the meshes is what settled this --
      // the probe's unnamed "TorusGeometry" rows were the toe straps all
      // along, and two rounds were spent shrinking the ankle strap, which had
      // never overhung anything.
      //
      // HEIGHT matters as much as radius. The boot runs from y 0.025 to 0.155
      // in this space, so straps at 0.046 and 0.032 were wrapped around the
      // SOLE, a couple of centimetres off the deck -- which is why the portrait
      // showed white boot blocks with no hardware on them however the radii
      // were tuned. An ankle strap crosses the upper boot and a toe strap the
      // instep, so they go at 0.086 and 0.058.
      //
      // 0.086, not 0.100: the boot's CUFF cylinder spans z +/-0.0759 over
      // y 0.123-0.233, which is the same half-width as the strap ring and
      // overlaps its whole height. A strap at 0.100 was therefore sitting
      // exactly inside the cuff and invisible even though it cleared the boot
      // BODY comfortably. Dropped onto the body, where the boot is only
      // +/-0.054 across, the ring stands 2.2 cm proud the way a strap does.
      const ankle = trim(new THREE.TorusGeometry(0.070, 0.010, 6, 16, 2.5), M.rubber, plate, 0, 0.086, -0.014);
      // NO X rotation. The boot's long axis is plate-local +Z, so a strap
      // crossing the top of it lies in the plate's XY plane -- which is where
      // a torus already is. The rotation.x = PI/2 that used to be here laid the
      // ring FLAT, so both straps were horizontal loops buried inside the boot
      // rather than arches over it. That is why no amount of tuning the radii
      // or the heights ever made hardware appear on the boot: the rotation.z
      // term below was always right, centring a 2.5 rad arc on +Y, and the X
      // term was cancelling it.
      ankle.rotation.set(0, 0, Math.PI * 0.5 - 1.25);
      ankle.name = `ankleStrap${tag}`;
      const toe = trim(new THREE.TorusGeometry(0.062, 0.009, 6, 16, 2.4), M.rubber, plate, 0, 0.058, 0.088);
      toe.rotation.set(0, 0, Math.PI * 0.5 - 1.20);
      toe.name = `toeStrap${tag}`;
      trim(new THREE.BoxGeometry(0.024, 0.018, 0.028), M.buckle, plate, 0.066, 0.090, -0.014);
      trim(new THREE.BoxGeometry(0.021, 0.015, 0.026), M.buckle, plate, 0.056, 0.062, 0.088);
      trim(new THREE.BoxGeometry(0.008, 0.044, 0.016), M.rubber, plate, -0.066, 0.076, -0.014);
    }

    /* --- rider ------------------------------------------------------ */
    // Hips sit above the board; the pose drives the actual ride height.
    const hips = bone('hips', boardPivot, 0, 0.78, 0);
    // Pelvis, torso and limbs are now the skinned garment surfaces built in
    // _buildSkinnedGarments() — continuous cloth over the skeleton, no
    // segment rims. Only rigid parts and trims remain here.

    const spine = bone('spine', hips, 0, 0.06, 0);
    // The abdomen. Its absence is what left a 16 cm hole between the pelvis and
    // the ribcage — a torso mesh anchored at the chest bone and a pelvis mesh
    // anchored at the hips do not meet, and because both were open tubes the
    // hole showed their bright interiors.
    const cord = trim(new THREE.TorusGeometry(0.163, 0.0055, 6, 20), M.rubber, spine, 0, 0.008, 0);
    cord.rotation.x = Math.PI * 0.5;
    cord.scale.x = 0.82;

    const chest = bone('chest', spine, 0, DIM.spineLength, 0);

    // Construction: a chest panel seam, the main zip up the front (−X, which
    // is the way the chest faces), and a chest pocket with its own zip. The
    // zip and the pocket are lathe panels sharing the torso's own profile, so
    // they hug the barrel instead of sinking into it at the belly. Lathe φ=0
    // is +Z and φ=π/2 is +X, so the front of the chest is φ = −π/2.
    const seam = trim(new THREE.TorusGeometry(0.174, 0.0055, 6, 24), M.shellDark, chest, 0, 0.145, 0);
    seam.rotation.x = Math.PI * 0.5;
    seam.scale.x = 0.74;
    const HP = Math.PI * 0.5;
    const zip = trim(
      limbPanel(DIM.chestLength, 0.148, 0.176, 1.06, 0.005, -HP - 0.105, 0.21, 0.06, 0.92),
      M.rubber, chest, 0, DIM.chestLength, 0,
    );
    zip.scale.x = 0.74;
    trim(new THREE.BoxGeometry(0.014, 0.024, 0.016), M.buckle, chest, -0.133, 0.056, 0);
    const pocket = trim(
      limbPanel(DIM.chestLength, 0.148, 0.176, 1.06, 0.006, 0.40 - HP, 0.46, 0.22, 0.44),
      M.shellDark, chest, 0, DIM.chestLength, 0,
    );
    pocket.scale.x = 0.74;

    const neck = bone('neck', chest, 0, DIM.chestLength, 0);
    part(new THREE.CylinderGeometry(0.056, 0.064, DIM.neckLength + 0.03, 10), M.shellGrey, neck, 0, DIM.neckLength * 0.45, 0);
    // Collar / hood bunched behind the neck — a silhouette detail that reads
    // even at 30 m and covers the neck-to-helmet junction from behind.
    // Collar roll. The two-lobe packed hood read as a bulge growing off the
    // back at gameplay distance (user catch on the v9 zooms) — a snug roll
    // hugging the collar keeps the silhouette cue without the growth.
    const hood = part(new THREE.SphereGeometry(0.082, 14, 12), M.shellGrey, chest, 0.055, DIM.chestLength * 1.00, 0);
    hood.scale.set(0.55, 0.42, 1.12);

    const head = bone('head', neck, 0, DIM.neckLength, 0);
    // Balaclava: the lower face, so there is a head under the helmet without
    // there ever being a face (§6.4, checklist 41).
    const face = part(new THREE.SphereGeometry(DIM.headRadius * 0.90, 14, 12), M.rubber, head, 0, DIM.headRadius * 0.42, 0.010);
    // Narrower than the helmet and tapering back: a jaw, not a second ball.
    face.scale.set(0.86, 0.98, 0.98);
    // Chin and jawline. Without these the lower head is a sphere that meets
    // the skull sphere in a circle, and the whole head reads as two stacked
    // balls -- which is what "rudimentary" was describing.
    const chin = part(new THREE.SphereGeometry(DIM.headRadius * 0.52, 12, 10), M.rubber, head,
      0, DIM.headRadius * 0.02, DIM.headRadius * 0.30);
    chin.scale.set(0.86, 0.78, 0.92);
    const jaw = part(new THREE.BoxGeometry(DIM.headRadius * 1.30, DIM.headRadius * 0.34, DIM.headRadius * 1.24), M.rubber, head,
      0, DIM.headRadius * 0.20, DIM.headRadius * 0.06);
    jaw.rotation.x = -0.16;

    // A helmet is longer front-to-back than it is wide, and its crown is
    // flatter than a sphere's. At 1.00 x 1.06 x 1.10 this was near-spherical,
    // which is most of why four rendered views all read as "ball".
    const skull = part(new THREE.SphereGeometry(DIM.headRadius, 20, 16), M.helmet, head, 0, DIM.headRadius * 0.85, 0.006);
    skull.scale.set(0.96, 1.02, 1.10);
    // Ear pads. A bare ellipsoid has no feature between the goggle and the
    // jaw, so the side view -- the one gameplay shows most -- was blank.
    for (const ex of [-1, 1]) {
      // INSIDE the skull's own half-width (0.96 r). At 0.88 r plus a 0.176 r
      // half-thickness these reached 1.056 r and stood out of the side of the
      // head as a pale peg -- the side view, which is the one gameplay shows
      // most, had a bar growing out of the ear.
      const ear = part(new THREE.SphereGeometry(DIM.headRadius * 0.32, 10, 8), M.helmet, head,
        ex * DIM.headRadius * 0.80, DIM.headRadius * 0.64, -DIM.headRadius * 0.04);
      ear.scale.set(0.42, 1.02, 0.90);
    }
    // Shell seam and brim.
    const shellSeam = trim(new THREE.TorusGeometry(DIM.headRadius * 1.005, 0.004, 6, 22), M.rubber, head, 0, DIM.headRadius * 0.86, 0);
    shellSeam.rotation.y = Math.PI * 0.5;
    shellSeam.scale.set(1.02, 1.04, 1.0);   // was 1.10: it punched out through the hood as a grey peg
    // HOOD UP, per the reference: the single most recognisable thing about
    // that silhouette. A cowl, not a full sphere -- pushed back off the face
    // so the goggle still reads as the brightest surface on the rider, and
    // scaled long so it peaks behind the skull the way a hood sits when it is
    // up and full of air. In the deep crimson, so the head reads as a darker
    // mass against the bright shell body, which is what gives the reference
    // its weight.
    // Sat at z = -0.74 head radii this was BEHIND the skull, not over it, and
    // read as a bun stuck to the back of the head with a hard scalloped
    // intersection where it cut the helmet. A hood is a shell that wraps the
    // skull and opens at the face, so: centred close to the head, enlarged to
    // clear it, and pushed back only enough to leave the goggle proud.
    // OPEN AT THE FRONT. This was a full sphere, so it enclosed the whole head
    // -- face, goggle and all -- and left a featureless dark ovoid. Rendered
    // from four angles the head was a uniform near-black egg with the goggle
    // strap poking out sideways as a bar, and the lens was not visible from
    // ANY view. That is the round-headed alien: less a shape problem than a
    // hood eating the face.
    //
    // The cut has to be by THETA, not PHI. phiStart/phiLength slice a sphere
    // around its Y axis, which removes a wedge and leaves two FLAT VERTICAL
    // edges -- rendered from the front those two edges are the pair of thin
    // dark commas floating either side of the skull, and that is the "hard
    // crescent". A hood opening is a circle, and the only cut on a sphere
    // that yields a circle is the polar one, so: cut by theta to get a bowl
    // open around +Y, then rotate the geometry a quarter turn about X so the
    // opening faces +Z -- the direction the head looks.
    // Snug. A hood over a helmet clears it by a centimetre, not by two: at 1.13
    // scaled 1.06 in Y the crown of the hood stood 0.18 headRadii off a skull
    // at 1.02, so the shell floated and its rim read as a hoop hung around the
    // head rather than an edge lying on it.
    const HOOD_R = DIM.headRadius * 1.06;
    // The opening must CLEAR the helmet, or the rim lands in front of the face
    // and the hood reads as a diving-helmet porthole. The opening radius is
    // HOOD_R*sin(open); the skull's widest is 1.16 headRadius, so open has to
    // satisfy 1.17*sin(open) > 1.16 -- i.e. past 1.43 rad. At 1.02 the opening
    // was 1.00 headRadius, narrower than the head it was meant to frame.
    const HOOD_OPEN = 1.46;                      // polar half-angle of the opening
    const hoodGeo = new THREE.SphereGeometry(
      HOOD_R, 24, 16, 0, Math.PI * 2, HOOD_OPEN, Math.PI - HOOD_OPEN,
    );
    hoodGeo.rotateX(Math.PI * 0.5);
    const hoodUp = part(hoodGeo, M.shellGrey, head, 0, DIM.headRadius * 0.80, -DIM.headRadius * 0.30);
    // A cowl with a peak behind the skull, not a sphere over a sphere: the
    // axes have to disagree. Held close enough that the helmet still shows.
    hoodUp.scale.set(1.01, 1.03, 1.22);
    // The hood needs THICKNESS. A single shell is a zero-thickness surface, so
    // the opening is a razor cut and a side view looks straight through it
    // onto the shell's own inside. A back-facing lining behind the outer shell
    // gives the edge somewhere to end.
    const liningGeo = new THREE.SphereGeometry(
      HOOD_R * 0.955, 20, 14, 0, Math.PI * 2, HOOD_OPEN + 0.04, Math.PI - HOOD_OPEN - 0.04,
    );
    liningGeo.rotateX(Math.PI * 0.5);
    const lining = part(liningGeo, M.shellDark, head, 0, DIM.headRadius * 0.80, -DIM.headRadius * 0.30);
    lining.scale.copy(hoodUp.scale);
    // The rim. The torus that used to sit here WAS the bar through the head --
    // but only because it lay HORIZONTALLY at goggle height, across the face.
    // The opening of a theta-cut bowl is a circle in the XY plane, so a torus
    // in that same plane traces the edge exactly instead of cutting across it:
    // radius R*sin(open), standing at z = R*cos(open).
    // PARTIAL, and open at the bottom. A full ring closes under the chin, and
    // a closed ring standing off the skull on every side is a halo -- the head
    // read as a ball inside a wire hoop. A real hood edge runs over the crown,
    // down past the cheeks, and vanishes into the collar; it is never a circle
    // the viewer can see all of. Arc centred on +Y leaves the bottom open.
    const RIM_ARC = 4.30;
    const rim = part(
      new THREE.TorusGeometry(HOOD_R * Math.sin(HOOD_OPEN), DIM.headRadius * 0.040, 7, 22, RIM_ARC),
      M.shellGrey, head, 0, DIM.headRadius * 0.80, -DIM.headRadius * 0.30 + HOOD_R * Math.cos(HOOD_OPEN) * 1.22,
    );
    rim.rotation.z = Math.PI * 0.5 - RIM_ARC * 0.5;
    rim.scale.set(1.01, 1.03, 1.00);

    // The bar through the head. This is a flat disc of radius 1.03 r sat at
    // y = 0.99 r -- up where the skull ellipsoid has tapered well inside that
    // radius -- so it stuck out past the silhouette on both sides and read as
    // a rod driven through the helmet. It survived every goggle and hood fix
    // because it is neither. Sized to the skull at the height it actually
    // sits, it goes back to being a moulding line.
    const brim = part(new THREE.CylinderGeometry(DIM.headRadius * 0.62, DIM.headRadius * 0.54, 0.014, 18), M.helmet, head, 0, DIM.headRadius * 1.06, 0.008);
    brim.scale.z = 1.10;
    // Vent slots, ON THE SHELL rather than inside it.
    //
    // These sat at a flat y = 1.72 r for every slot, which is 2.3 cm INSIDE
    // the skull -- head-extents measured them at proud -0.0231, i.e. they have
    // never been visible on any frame. A helmet's crown is an ellipsoid, so
    // the height of a point on it depends on where along the crown it is; a
    // constant y can only be right for one slot and buries the rest.
    //
    // Solved from the skull's own semi-axes (0.96, 1.02, 1.10 on headRadius,
    // centred at 0.85 r) so each slot lands on the surface at its own z, then
    // lifted a hair so it reads as a dark inset rather than z-fighting.
    {
      const cy = DIM.headRadius * 0.85;
      const sy = DIM.headRadius * 1.02;
      const sz = DIM.headRadius * 1.10;
      for (const vz of [-0.062, 0.0, 0.062]) {
        const t = Math.min(0.999, Math.abs(vz) / sz);
        const vy = cy + sy * Math.sqrt(1 - t * t) - 0.004;
        trim(new THREE.BoxGeometry(0.060, 0.014, 0.024), M.rubber, head, 0, vy, vz);
      }
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
    // A goggle is a SHIELD THAT WRAPS THE FACE, not a piece of a sphere
    // centred on the head. Six rounds of reshaping a spherical cap each traded
    // one failure for another -- snout, then flat plate, then two lobes either
    // side of the nose -- because a cap centred on the skull can only be proud
    // at its pole and buried at its rim, and the rim is exactly where a goggle
    // has to tuck into the cheek. The geometry was wrong, not the numbers.
    //
    // A cylindrical shell segment has the shape a lens actually has: a large
    // horizontal radius centred BEHIND the face, so the surface stands proud
    // across the middle and curves back into the head at both sides. From the
    // front it is a band; from three-quarter it wraps away round the cheek
    // instead of bulging off it.
    //
    //   R      = 1.25 headRadius, well outside the skull's 0.96-1.10
    //   centre = z -0.10 r, so the front face lands at 1.15 r -- proud
    //   edges  = at +/-0.8 rad the surface is x 0.90 r, z 0.77 r, INSIDE the
    //            skull's 0.96 half-width, so the lens ends in the face
    // A goggle is an OFFSET OF THE SKULL, cut to a band.
    //
    // Seven rounds of reshaping a spherical cap, then a cylinder, each traded
    // one failure for another -- snout, flat plate, two lobes either side of
    // the nose, skull poking through the middle. Every one of them has the
    // same root: the lens surface and the skull surface were different shapes,
    // so wherever the lens was proud somewhere else it was buried, and the
    // boundary between the two is what kept rendering as a defect.
    //
    // The skull is an ellipsoid scaled (0.96, 1.02, 1.10). A lens built from
    // the SAME sphere at the SAME ratios, 6% larger and concentric, is an
    // offset surface -- parallel to the face everywhere, uniformly proud, and
    // incapable of intersecting it. Cutting that to a band gives the goggle:
    // phi limits how far it wraps around the face, theta how tall it is.
    //
    // phi = PI/2 is +Z, the direction the head looks, so a band centred on the
    // face spans PI/2 +/- 0.80. theta is polar from +Y, so the band sits just
    // below the skull's equator, which is where eyes are.
    const lensGeo = new THREE.SphereGeometry(
      DIM.headRadius, 28, 10,
      Math.PI * 0.5 - 0.80, 1.60,
      Math.PI * 0.5 - 0.16, 0.50,
    );
    // ROUND THE OUTLINE. A phi/theta band is a rectangle in parameter space,
    // so its ends are square corners -- correct as a wrap, wrong as a lens,
    // because a goggle is a rounded rectangle. Tapering each vertex's height
    // toward the band's ends turns the outline into one without touching the
    // wrap: the surface stays the skull's offset, only the CUT changes.
    //
    // u is the azimuth from +Z, so |u| / 0.80 runs 0 at the nose to 1 at the
    // ends. The taper holds full height across the middle and eases to 45% at
    // the tips -- easing to zero would make points rather than rounded ends.
    {
      const pos = lensGeo.attributes.position;
      const yMid = Math.cos(Math.PI * 0.5 + 0.09) * DIM.headRadius;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const t = Math.min(1, Math.abs(Math.atan2(x, z)) / 0.80);
        const f = 0.45 + 0.55 * Math.sqrt(Math.max(0, 1 - t * t * t));
        pos.setY(i, yMid + (y - yMid) * f);
      }
      pos.needsUpdate = true;
      lensGeo.computeVertexNormals();
    }
    const lens = part(lensGeo, M.goggle, head, 0, DIM.headRadius * 0.85, 0.006);
    lens.scale.set(0.96 * 1.06, 1.02 * 1.06, 1.10 * 1.06);
    lens.castShadow = false;
    // The gasket torus that used to sit here traced the lens cap's RIM. With
    // the lens flattened and pushed into the face that rim now sits behind the
    // skull surface, so the ring bounded nothing and floated as a loop around
    // a lens it no longer touched. The skull's own opening is the frame.

    // The opaque frame cap that used to sit behind the lens is GONE. Its job
    // was to stop the goggle reading as a window through the head, but the
    // lens now emerges from the skull, so the skull is the backing. Kept at a
    // similar size and depth it did what every previous version of it did --
    // poked through the middle of the lens and split the goggle into two pale
    // blobs, which is a pair of googly eyes, not a visor.

    const strapGeo = new THREE.TorusGeometry(DIM.headRadius * 1.03, 0.011, 6, 26, 4.05);
    strapGeo.rotateZ(2.68);          // centre the covered arc on the back of the head
    strapGeo.rotateX(Math.PI * 0.5);
    // Raised clear of the lens. Both sat at ~0.8 r, and since the lens is
    // scaled proud of the skull it pushed straight through the strap, so the
    // front view had a dark bar cutting across the middle of the goggle.
    const gstrap = trim(strapGeo, M.strap, head, 0, DIM.headRadius * 1.04, 0);
    // Sized to the SKULL'S CROSS-SECTION at the height the strap actually sits,
    // not to a nominal sphere. The skull is an ellipsoid 0.96 wide and 1.10
    // long; at y = 1.04 r that section is 0.943 x 1.080. A strap ring of
    // radius 1.03 r scaled a flat 1.005 therefore reached 1.035 across a head
    // only 0.943 wide -- 0.9 cm proud on each side, which from the side view
    // crossed the silhouette as a grey bar at goggle height. Scaled to the
    // section it lies ON the shell, a hair proud, the way a strap does.
    //
    // Scale the OUTER radius, not the ring radius: the tube adds 0.011 on top
    // of 1.03 r, so a factor picked against the ring alone still left the
    // strap 1.1 cm proud and the bar still crossed the side view. Solving
    // (1.03 r + tube) * sx = halfWidthHere + 1.5 mm gives 0.850, and the same
    // against the section's half-length gives 0.972.
    // Tried and REVERTED: thickening the tube to 0.016 and scaling to 0.875 to
    // make the strap read as a band, on the theory that nothing visually joins
    // the goggle to the head so the lens looks stuck on. The tube's own radius
    // adds to the proudness, so it came out as a dark stub protruding from the
    // side of the helmet -- the same grey-bar failure as the 11 mm version.
    // The strap has to stay flush; the goggle's stuck-on read needs solving on
    // the goggle.
    gstrap.scale.set(0.850, 1.0, 0.972);

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
      const ua = bone(`upperArm${side}`, sh, 0, 0, 0);
      const fa = bone(`foreArm${side}`, ua, 0, -DIM.upperArm, 0);
      // Cuff tab at the wrist.
      const cuff = trim(new THREE.TorusGeometry(0.050, 0.008, 6, 16), M.rubber, fa, 0, -DIM.foreArm + 0.012, 0);
      cuff.rotation.x = Math.PI * 0.5;

      const hand = bone(`hand${side}`, fa, 0, -DIM.foreArm, 0);
      // Wrist bridge: the cuff-to-mitt junction opened a visible gap whenever
      // the arm extended (round-4 critic catch).
      joint(0.048, M.glove, hand, 0, -0.006, 0);
      const mitt = part(new THREE.SphereGeometry(0.060, 12, 10), M.glove, hand, 0, -0.048, 0.004);
      mitt.scale.set(0.88, 1.30, 1.05);
      // A thumb, so the glove is a glove rather than a ball on a stick. It
      // sits on the chest side (−X) of the mitt — the side of a relaxed
      // hanging hand a viewer actually sees.
      const thumb = part(new THREE.CapsuleGeometry(0.020, 0.036, 3, 7), M.glove, hand, -0.030, -0.042, 0.030);
      thumb.rotation.set(0.5, 0, sx * 0.5);
      const knuckle = trim(new THREE.BoxGeometry(0.052, 0.030, 0.070), M.rubber, hand, 0, -0.086, 0.006);
      knuckle.rotation.x = 0.12;
    }

    /* --- legs -------------------------------------------------------- */
    for (const [side, tag] of [['F', 'Front'], ['B', 'Back']]) {
      const sz = side === 'F' ? 1 : -1;
      const hip = bone(`hip${side}`, hips, 0, 0, sz * DIM.hipWidth * 0.55);
      const thigh = bone(`thigh${side}`, hip, 0, 0, 0);
      // Cargo pocket flap on the outer thigh.
      const cargo = trim(new THREE.BoxGeometry(0.014, 0.092, 0.084), M.pants, thigh, 0.104, -0.20, 0);
      cargo.rotation.z = -0.06;
      const thighSeam = trim(new THREE.TorusGeometry(0.090, 0.0055, 6, 18), M.pants, thigh, 0, -0.40, 0);
      thighSeam.rotation.x = Math.PI * 0.5;

      const shin = bone(`shin${side}`, thigh, 0, -DIM.thighLength, 0);
      // Knee panel seam below the joint (the one above rides on the thigh).
      const kneeSeam = trim(new THREE.TorusGeometry(0.082, 0.0055, 6, 18), M.pants, shin, 0, -0.060, 0);
      kneeSeam.rotation.x = Math.PI * 0.5;
      // Gaiter over the boot cuff.
      const gaiter = part(new THREE.CylinderGeometry(0.078, 0.070, 0.11, 12), M.pants, shin, 0, -DIM.shinLength + 0.055, 0);

      const bt = bone(`boot${side}`, shin, 0, -DIM.shinLength, 0);
      // The boot bone is slaved to the binding mount's orientation by the IK,
      // and the mount's convention is "0° = straight across the deck". The
      // boot geometry is authored toe-along-local-+Z, so the same −90° yaw
      // the binding plate gets puts the toe on the toe edge.
      const foot = new THREE.Object3D();
      foot.rotation.y = -Math.PI * 0.5;
      bt.add(foot);
      const bootMesh = part(new THREE.BoxGeometry(0.108, DIM.bootHeight, 0.245), M.boot, foot, 0, -DIM.bootHeight * 0.45, 0.015);
      bootMesh.name = `bootMesh${tag}`;
      part(new THREE.BoxGeometry(0.114, 0.024, 0.252), M.sole, foot, 0, -DIM.bootHeight * 0.94, 0.015);
      part(new THREE.CylinderGeometry(0.074, 0.080, 0.11, 10), M.boot, foot, 0, 0.030, -0.010);
      // BOA dial + a lace band, outboard so the camera sees them.
      trim(new THREE.CylinderGeometry(0.017, 0.017, 0.012, 12), M.buckle, foot, 0.056, 0.028, 0.020).rotation.z = Math.PI * 0.5;
      trim(new THREE.BoxGeometry(0.112, 0.012, 0.030), M.rubber, foot, 0, -0.012, 0.098);
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

    // Skinned cloth over the completed skeleton — must run in the rest pose,
    // before the IK settle below moves a single bone.
    this._buildSkinnedGarments(M);

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
      // Measure the SOLE against the baseplate, not the ankle against the
      // mount: the ankle is meant to sit a boot-height above the mount, so a
      // bone-to-mount distance cannot tell a boot standing on the plate from
      // one buried through the deck — which is exactly the regression that
      // got past this check and showed up in play as the binding poking out
      // under the board.
      // Measured along the MOUNT's axes, not the world's. A world-Y version of
      // this check is blind on edge — which is how an IK that offset the ankle
      // along world up got past it and put the sole through the base on every
      // carve.
      const sole = this._chk.setFromMatrixPosition(bt.matrixWorld);
      const plate = this._chk2.setFromMatrixPosition(mount.matrixWorld);
      const e = mount.matrixWorld.elements;
      const up = this._chk3.set(e[4], e[5], e[6]).normalize();
      const off = sole.sub(plate);
      const along = off.dot(up);
      const drop = along - SOLE_DROP - PLATE_TOP;
      const lateral = Math.sqrt(Math.max(0, off.lengthSq() - along * along));
      if (Math.abs(drop) > 0.02) {
        console.warn(`[rider] boot${side} sole sits ${drop.toFixed(3)} m ` +
          `${drop < 0 ? 'BELOW' : 'above'} binding${tag}'s plate`);
      }
      if (lateral > 0.06) console.warn(`[rider] boot${side} is ${lateral.toFixed(3)} m off binding${tag} laterally`);
    }
  }

  /**
   * Base body yaw, radians from "square across the board" (chest on −X, the
   * toe edge). A duck-stance rider's hips and chest sit rotated toward the
   * nose all the time, leading with the front shoulder, and the head carries
   * the rest of the way to face travel. With the toe edge on −X, a positive
   * yaw about +Y rotates the chest from −X toward +Z — toward the nose — so
   * these are positive. (The handedness itself — regular, left foot forward —
   * comes from the axes, not from these values: see the class comment.)
   */
  static STANCE_YAW = { hips: 0.30, chest: 0.55 };

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
    // Flips rotate the *whole rider*, not just the board (physics carries a
    // real accumulated pitch; the old build tilted the board 40% and called
    // it a backflip). The rotation pivots about a point near the centre of
    // mass — flipping about the feet sweeps the head through a two-metre
    // arc and reads as a cartwheel.
    const flip = s.flipRot || 0;
    if (Math.abs(flip) > 1e-3) {
      this._flipQ.setFromAxisAngle(right, flip);
      this._q.premultiply(this._flipQ);
      this._flipV.copy(up).multiplyScalar(0.88);
      root.position.add(this._flipV);
      this._flipV.applyQuaternion(this._flipQ);
      root.position.sub(this._flipV);
    }
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
    // Sign convention: physics +edgeAngle digs the +X (heel) rail and turns
    // the board toward +X, so a positive incline — mass carried toward +X —
    // is leaning INTO that turn. Both terms therefore carry edgeAngle's own
    // sign. In the air, +roll lifts the heel rail, so the toe rail meets the
    // snow first and the body pre-leans toe-ward: the opposite sign.
    const inclineTarget = s.grounded
      ? clamp(Math.atan2((s.gForce - 1) * 9.81 * Math.sign(s.edgeAngle || 0), 9.81), -0.85, 0.85)
        + (s.edgeAngle || 0) * 0.42
      : (s.roll || 0) * -0.5;
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
    // CRUNCH: the failed tier folds the rider up rather than just putting
    // them down. Driven off the wipeout flag, which only the unsalvageable
    // landings raise, so an ordinary bail still reads as a bail.
    A.crunch = damp(A.crunch || 0, s.wipeout || (s.crashed && s.stumble === 0 && A.crunch > 0.02) ? 1 : 0,
      s.wipeout ? 16 : 1.6, dt);
    // WOBBLE: the oof tier. A quick lateral shudder that decays over the
    // stumble timer -- caught out, rode away, never left their feet.
    A.wobble = (s.stumble || 0) > 0
      ? Math.sin((s.stumble || 0) * 46) * (s.stumble || 0) * 0.85
      : damp(A.wobble || 0, 0, 8, dt);
    A.grabBlend = damp(A.grabBlend, grabName ? 1 : 0, 9, dt);
    if (grabName) this._grab = grabName;

    // Counter-rotation: the upper body leads the turn and the hips follow,
    // which is what separates a snowboarder from a skier in silhouette.
    // +edgeAngle turns the board toward +X and +twist adds +yaw, so the edge
    // term shares edgeAngle's sign; the slip term counter-rotates against a
    // washing tail.
    A.twist = damp(A.twist, clamp((s.edgeAngle || 0) * 0.55 - (s.slipAngle || 0) * 0.5, -0.7, 0.7), 8, dt);

    const crash = A.crash;
    const crunch = A.crunch || 0;
    const wobble = A.wobble || 0;
    const live = 1 - crash;

    // ---- Board ------------------------------------------------------
    const bp = B.boardPivot;
    bp.rotation.z = (s.roll || 0);
    // Surface-following attitude, as it always was — flips live on their
    // own channel (s.flipRot) and rotate the root instead.
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
    // ---- Inclination -------------------------------------------------
    // The body hangs off boardPivot, which is ALREADY rolled to s.roll, so
    // inclination is an angle from the surface — not something to add on top
    // of the deck. Adding it was a jackknife: at a held full-steer carve the
    // per-bone terms summed to roll(-0.97) + hips(0.55) + spine(0.34) +
    // chest(0.25) = +0.18 rad, i.e. the torso finished 10 degrees tilted to
    // the OUTSIDE of a 2.5 g turn while the deck was over at 55.
    //
    // Pick the total tilt the body should show in the root frame, then hand
    // the bones only what the board has not already provided. A shade under
    // the deck's own roll is the angulated look a real carve has: board
    // edged hardest, body stacked slightly more upright over it.
    const rollNow = s.roll || 0;
    const residual = rollNow * 0.85 - rollNow;
    // Old per-bone weights, normalised so they distribute the residual
    // exactly rather than scaling it by their sum.
    const WSUM = 0.45 + 0.28 + 0.20;

    // Lean the mass across the board to balance the carve. The gain used to
    // be 0.30 + 0.18*absorb, which put the pelvis 70 cm outboard of a 25 cm
    // deck and — once the board roll was applied — 5.6 cm BELOW the contact
    // plane, burying the seat and back leg in the heightfield.
    // Flexing folds the rider FORWARD over the toes; it does not merely lower
    // the pelvis. This is the chair-sit, and it has survived two previous
    // attempts because both went looking for a stray backward rotation. There
    // is none. The fault is an ABSENCE: the only term on the torso's fold axis
    // is `residual`, which is a function of board roll and therefore exactly
    // zero riding flat, so absorb/tuck/compress dropped the hips straight down
    // with the spine left standing erect on top of them. That is a man sitting
    // on a stool, and no amount of pelvis-height tuning could have fixed it.
    //
    // A rotation about +Z tips the head toward -X, which is the toe edge, so
    // this folds the chest out over the board the way a flexed rider actually
    // stands. The hips travel the other way as they drop -- heel-side, the
    // counterweight that keeps the mass over the deck rather than off the nose.
    const fold = squat * 0.46;
    let hx = Math.sin(A.incline) * 0.10 * live + squat * 0.085;
    const MIN_PELVIS_Y = 0.30;
    // Bound the squat itself, not only the lateral shift. absorb + tuck +
    // compress + grab can sum to 0.72 against a 0.735 stance height, which
    // puts the pelvis at deck level with the thighs horizontal -- a toilet
    // squat, not a stance. The guard below could never catch it: it works by
    // trimming hx, and hx only reaches the pelvis height through sin(roll),
    // so on a flat board it has no authority at all. Straight-line absorb is
    // exactly where the collapse looked worst and exactly where sin(roll) is
    // zero.
    hips.position.y = Math.max(standH - squat - crunch * 0.22, MIN_PELVIS_Y * (1.0 - crunch * 0.45));
    // Guard it directly: the pelvis bone, after the deck roll, must stay
    // clear of the snow. Solved rather than tuned, so it holds at any roll.
    const sr = Math.sin(rollNow), cr = Math.cos(rollNow);
    if (Math.abs(sr) > 1e-4 && hx * sr + hips.position.y * cr < MIN_PELVIS_Y) {
      const limit = (MIN_PELVIS_Y - hips.position.y * cr) / sr;
      if (Math.abs(limit) < Math.abs(hx)) hx = limit;
    }
    hips.position.x = hx;
    hips.position.z = (A.tuck * -0.02) + (s.pitch || 0) * 0.06;
    hips.rotation.z = residual * (0.45 / WSUM) + fold * 0.42 - crash * 0.9 + wobble * 0.30 - crunch * 0.35;
    hips.rotation.y = Rider.STANCE_YAW.hips + A.twist * 0.35;
    hips.rotation.x = A.tuck * 0.30 + A.absorb * 0.12 + crash * 0.5 + crunch * 0.85;

    // ---- Spine / chest ----------------------------------------------
    // SIDE BEND. A rider laid over on an edge does not stay a straight column
    // from pelvis to shoulders -- the torso bends laterally over the working
    // edge, and that curve is a large part of what a carve looks like from
    // behind. Measured over a run the spine swept 7 deg, the stiffest link in
    // the whole rig.
    B.spine.rotation.z = residual * (0.28 / WSUM) + fold * 0.34 - A.incline * 0.20;
    B.spine.rotation.x = A.tuck * 0.22 + A.absorb * 0.10 + crunch * 0.70;
    // TWIST THROUGH THE SPINE, not just at the chest.
    //
    // rotation.y was never set here at all, so the counter-rotation stepped
    // from hips (0.35) straight to chest (0.62) with the spine contributing
    // nothing -- a torso that pivots at one joint instead of winding along its
    // length. The total is unchanged, only distributed: 0.26 here and 0.36 at
    // the chest still sums to the 0.62 the chest carried alone.
    B.spine.rotation.y = A.twist * 0.26;
    B.chest.rotation.y = (Rider.STANCE_YAW.chest - Rider.STANCE_YAW.hips) + A.twist * 0.36;
    B.chest.rotation.z = residual * (0.20 / WSUM) + fold * 0.24 + crash * 0.6;
    B.chest.rotation.x = -A.tuck * 0.10 + A.absorb * 0.16 + crash * 0.7;

    // ---- Head -------------------------------------------------------
    // A rider looks where they are going: down the fall line, never at their
    // own board. The helmet geometry faces local +Z — already the nose when
    // every ancestor yaw is zero — but the chest above it carries STANCE_YAW
    // plus most of the twist, so the neck and head unwind nearly all of that
    // to hold the face on travel. The ~25% of twist they deliberately leave
    // in is the head leading the turn.
    B.neck.rotation.y = -Rider.STANCE_YAW.chest * 0.55 - A.twist * 0.30;
    B.head.rotation.y = -Rider.STANCE_YAW.chest * 0.65 - A.twist * 0.45 + (s.grounded ? 0 : (s.airRotation || 0) * 0.05);
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
    // Stand the boot ON the baseplate: the IK target is the ankle, so it has
    // to clear the whole drop from ankle to sole, plus the plate itself.
    //
    // That clearance runs along the BOARD's up, not the world's. This used to
    // be a plain `p.y += ...`, which is only correct with the board flat. On
    // edge the offset stayed vertical while the plate rolled out from under
    // it, so the ankle ended up the right DISTANCE from the mount in the
    // wrong DIRECTION: measured at 62° of edge, the ankle sat 13.1 cm
    // outboard and only 6.9 cm above the mount instead of 14.8 cm straight
    // up, which drove the sole 4.6 cm through the base. That is the "bindings
    // popping through the bottom of the board" report, and because it scales
    // with edge angle it was showing on every carve, not just extreme ones.
    const e = target.matrixWorld.elements;
    this._ikUp.set(e[4], e[5], e[6]).normalize();
    p.addScaledVector(this._ikUp, SOLE_DROP + PLATE_TOP);
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
    // dominantly across the deck toward the toe edge — board −X — not toward
    // the nose. Getting this axis wrong is what makes procedural riders look
    // like they have their legs on backwards.
    const dir = this._ikDir.copy(p).normalize();
    const pole = this._ikPole.set(-1, 0, 0);
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
   *   `swingT` — toe-ward swing, kept toe-positive to match the grab table's
   *              x column and applied as rotation.z = −swingT, because the toe
   *              edge (the way the chest faces) is board **−X**.
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
      // Life in the arms must SURVIVE riding. The idle sway was multiplied by
      // clamp01(1 - speed/12), i.e. faded to exactly zero by 12 m/s -- so the
      // only asymmetry in the whole upper body switched off precisely when the
      // rider is moving and the camera is watching. Frozen mirrored limbs is
      // the scarecrow read.
      //
      // Two sources now. A slow idle for a stationary rider, and a faster,
      // smaller ride motion that grows with speed and edge -- the arms
      // counter-balancing a working board rather than hanging off it. Opposite
      // phase per side, so they never mirror.
      const idle = Math.sin(t * 1.7 + sx) * 0.05 * clamp01(1 - s.speed / 12);
      const ride = Math.sin(t * 3.1 * sx + sx * 1.1) * 0.035
        * smoothstep(2, 11, s.speed) * (0.6 + 0.4 * clamp01(s.edgeLoad || 0));
      const sway = idle + ride;
      // `A.incline` is heel-positive (+X), so the toe-ward arm swing that
      // balances a lean carries a negative incline coefficient; likewise the
      // twist term here, because +twist yaws the body heel-ward.
      let alongZ = -front * (0.52 + A.absorb * 0.14 - A.tuck * 0.30 - A.twist * front * 0.30) + sway;
      let swingT = 0.30 - A.incline * 0.35 + A.absorb * 0.16 + sway * 0.4;
      // The two arms do different jobs, so they must not carry one number.
      // The nose-side arm leads and stays the straighter of the two; the
      // tail-side arm tucks in behind the hip. `front` is +1 on the nose side.
      // The elbow swept only 25 deg over a whole run, because its target barely
      // varied: absorb and tuck are the only live terms and both are small
      // most of the time. Arms fold as a rider lays into a turn and open as
      // they come out of it, so the turn itself has to drive it.
      let elbow = 0.55 + A.absorb * 0.35 + A.tuck * 0.75
        - front * 0.16
        + Math.abs(A.incline) * 0.42
        + Math.sin(t * 2.3 + sx * 2.0) * 0.10 * smoothstep(2, 11, s.speed);

      // Crashed riders throw their arms up and out.
      alongZ = lerp(alongZ, -front * 1.05, A.crash);
      swingT = lerp(swingT, 0.95, A.crash);
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
        swingT = lerp(swingT, 0.10 + grab.point[0] * 1.1, blend);
        // A grab is a *reach*, so the elbow opens rather than closing: folding
        // it to 1.8 rad threw the forearm out sideways at chest height, which
        // is the opposite of the shape the trick has.
        elbow = lerp(elbow, 0.95, blend);
      } else if (grab && blend > 0.001) {
        // The other arm goes up and out — the tweak that sells the trick.
        alongZ = lerp(alongZ, -front * 0.95, blend * 0.7);
        swingT = lerp(swingT, 0.15, blend * 0.7);
        elbow = lerp(elbow, 0.40, blend * 0.7);
      }

      // Toe-ward is −X, so the toe-positive swing and the elbow bend both
      // apply negated: positive rotation.z carries a hanging arm toward +X.
      // Shoulder YAW. Without it the forearm can only swing in one body
      // plane and can never come across the chest, which is why the arms read
      // as pinned to a board rather than held. The lead arm reaches slightly
      // across the deck, the trail arm opens away, and inclination pulls both
      // toward the inside of the turn the way a rider actually balances.
      const shoulderY = front * (0.16 + A.tuck * 0.10) - A.incline * 0.22;

      // UNDER-damped, not critically damped.
      //
      // Every arm channel used to be damp()'d straight onto its target, and
      // the targets are themselves smooth functions of slow state, so the arms
      // arrived everywhere exactly on time and never once overshot. Measured
      // over a 30 s run that reads as: upperArm sweeping 48 deg, forearm 25,
      // wrist 5, shoulder 0 -- a limb that moves without ever looking like it
      // has mass. A real arm trails the torso into a turn and swings past on
      // the way out, and that lag is most of what separates an animated arm
      // from a posed one.
      //
      // A light second-order spring per channel gives it that: it lags going
      // in, overshoots coming out, and settles. zeta ~0.55 is enough to read
      // without wobbling.
      const spr = (this._armSpring ||= {});
      const swing = (key, cur, target, omega) => {
        const st = (spr[key] ||= { v: 0 });
        const a = omega * omega * (target - cur) - 2 * 0.55 * omega * st.v;
        st.v += a * dt;
        return cur + st.v * dt;
      };

      ua.rotation.x = swing(`${side}ux`, ua.rotation.x, alongZ, 13);
      ua.rotation.y = swing(`${side}uy`, ua.rotation.y || 0, shoulderY, 11);
      ua.rotation.z = swing(`${side}uz`, ua.rotation.z, -swingT, 13);
      fa.rotation.z = swing(`${side}fz`, fa.rotation.z, -elbow, 15);

      // SHOULDER GIRDLE. This bone existed and was never touched -- measured
      // sweep over a full run was 0.0 deg, so the whole arm hung off a dead
      // clavicle and the shoulders sat like a coat hanger no matter what the
      // arms did. A rider's girdle lifts as the arm comes up and counters the
      // chest as it twists, and it is the joint that makes an arm look
      // attached to a living torso rather than socketed into a mannequin.
      const shoulder = B[`shoulder${side}`];
      if (shoulder) {
        // Lift with the arm's own swing, plus a counter to the body twist.
        const lift = -swingT * 0.26 - A.absorb * 0.10;
        const roll = front * A.twist * 0.30 + (A.incline || 0) * 0.10;
        shoulder.rotation.z = swing(`${side}sz`, shoulder.rotation.z || 0, lift, 9);
        shoulder.rotation.y = swing(`${side}sy`, shoulder.rotation.y || 0, roll, 8);
      }

      // A wrist, so the hand is not a continuation of the forearm tube.
      //
      // Driven off the forearm's angular VELOCITY rather than a constant. The
      // old target was -elbow*0.22 - 0.10, which barely varies, so the wrist
      // measured 5.4 deg of sweep across an entire run -- welded. A hand
      // trails the arm it is on the end of, so the flick comes from how fast
      // the forearm is moving, not from where it happens to be.
      const hand = B[`hand${side}`];
      if (hand) {
        const faVel = spr[`${side}fz`]?.v || 0;
        hand.rotation.z = swing(`${side}hz`, hand.rotation.z || 0,
          -elbow * 0.22 - 0.10 - clamp(faVel * 0.16, -0.45, 0.45), 12);
        hand.rotation.y = swing(`${side}hy`, hand.rotation.y || 0,
          front * 0.18 + clamp((spr[`${side}uz`]?.v || 0) * 0.12, -0.30, 0.30), 12);
      }
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
