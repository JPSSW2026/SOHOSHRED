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
 *    └ boardPivot            — edge roll + pitch
 *       ├ board              — deck, base, edges, bindings
 *       └ hips               — the rider's mass, offset by inclination
 *          ├ spine → chest → neck → head (helmet, goggles)
 *          │   ├ shoulderL → upperArmL → foreArmL → handL
 *          │   └ shoulderR → upperArmR → foreArmR → handR
 *          ├ thighL → shinL → bootL   (two-bone IK onto the front binding)
 *          └ thighR → shinR → bootR   (two-bone IK onto the back binding)
 *
 * Legs are solved with analytic two-bone IK so the boots stay welded to the
 * bindings no matter what the hips do — which is the whole trick, because it
 * means the animation system only has to move the hips and chest and the legs
 * follow correctly for free.
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
  boardThickness: 0.013,
  /** Effective edge — where the sidecut actually contacts. */
  effectiveEdge: 1.19,
  /** Camber under the bindings, and tip/tail rocker. */
  camber: 0.007,
  rocker: 0.042,

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
  upperArm: 0.30,
  foreArm: 0.28,
};

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

/**
 * Technical-shell fabric: a fine ripstop grid over a subtle noise weave, with
 * the grid squares slightly darker at their borders. At the distances the
 * camera actually sees the rider this reads as cloth rather than as plastic,
 * which is most of the difference between a character and a mannequin.
 */
function makeShellTexture(rng, base, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const col = new THREE.Color(base);
  g.fillStyle = `rgb(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0})`;
  g.fillRect(0, 0, size, size);

  // Weave noise.
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 16;
    d[i] = clamp(d[i] + n, 0, 255);
    d[i + 1] = clamp(d[i + 1] + n, 0, 255);
    d[i + 2] = clamp(d[i + 2] + n, 0, 255);
  }
  g.putImageData(img, 0, 0);

  // Ripstop grid — the reinforcing thread every 8 px.
  g.strokeStyle = 'rgba(0,0,0,0.16)';
  g.lineWidth = 1;
  for (let i = 0; i < size; i += 8) {
    g.beginPath(); g.moveTo(i + 0.5, 0); g.lineTo(i + 0.5, size); g.stroke();
    g.beginPath(); g.moveTo(0, i + 0.5); g.lineTo(size, i + 0.5); g.stroke();
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

/* ---------------------------------------------------------------- *
 * Geometry helpers
 * ---------------------------------------------------------------- */

/**
 * A tapered limb segment, built along +Y from the joint, so a bone rotation
 * swings it the way a limb swings. Slight bulge at the belly of the muscle.
 */
function limbGeometry(length, rTop, rBottom, bulge = 1.08, seg = 7) {
  const pts = [];
  const rings = 6;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const r = lerp(rTop, rBottom, t) * lerp(1, bulge, Math.sin(t * Math.PI));
    pts.push(new THREE.Vector2(r, -t * length));
  }
  const geo = new THREE.LatheGeometry(pts, seg);
  geo.computeVertexNormals();
  return geo;
}

/**
 * The deck: a sidecut outline swept with camber and tip/tail rocker. Built as
 * a parametric strip so the sidecut is a real arc rather than a scaled box —
 * it shows in every shot where the board is edged over against the snow.
 */
function boardGeometry() {
  const L = DIM.boardLength, half = L * 0.5;
  const nz = 42, nx = 5;
  const pos = [], uv = [], idx = [];

  for (let j = 0; j <= nz; j++) {
    const t = j / nz;              // 0 = tail, 1 = nose
    const z = lerp(-half, half, t);
    const s = Math.abs(z) / half;

    // Sidecut: waist at centre, widening to the contact points, then the
    // tip taper past them.
    const edgeT = clamp01((Math.abs(z) - DIM.effectiveEdge * 0.5) / (half - DIM.effectiveEdge * 0.5));
    const widthAtEdge = lerp(DIM.boardWaist, DIM.boardTip, s * s);
    const width = lerp(widthAtEdge, DIM.boardTip * 0.72, smoothstep(0, 1, edgeT) * (edgeT > 0 ? 1 : 0));

    // Camber between the contact points, rocker beyond them.
    const camber = Math.abs(z) < DIM.effectiveEdge * 0.5
      ? DIM.camber * Math.cos((z / (DIM.effectiveEdge * 0.5)) * Math.PI * 0.5)
      : 0;
    const rocker = DIM.rocker * smoothstep(DIM.effectiveEdge * 0.5, half, Math.abs(z)) ** 1.6;
    const y = camber + rocker;

    for (let i = 0; i <= nx; i++) {
      const u = i / nx;
      const x = lerp(-width * 0.5, width * 0.5, u);
      pos.push(x, y, z);
      uv.push(u, t);
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
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
  }

  async build() {
    const rng = this._rng;

    /* --- materials ------------------------------------------------- */
    const shell = new THREE.MeshStandardMaterial({
      map: makeShellTexture(rng, 0x2b4a6f),
      color: 0xffffff,
      roughness: 0.78,
      metalness: 0.0,
    });
    shell.map.repeat.set(2, 3);

    const pants = new THREE.MeshStandardMaterial({
      map: makeShellTexture(rng, 0x1b2029),
      roughness: 0.86,
      metalness: 0.0,
    });
    pants.map.repeat.set(2, 3);

    const helmet = new THREE.MeshStandardMaterial({
      color: 0x14181e, roughness: 0.34, metalness: 0.05,
    });
    // Goggles are the one mirror on the rider, and in a bluebird scene a
    // mirror facing the snowfield is a bright ellipse — it is what makes a
    // helmet read as a head with a face behind it.
    const goggle = new THREE.MeshStandardMaterial({
      color: 0x2a1f10, roughness: 0.06, metalness: 0.95,
      envMapIntensity: 1.6,
    });
    const strap = new THREE.MeshStandardMaterial({ color: 0xc4442e, roughness: 0.72 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x191d24, roughness: 0.7 });
    const boot = new THREE.MeshStandardMaterial({ color: 0x20242c, roughness: 0.62 });
    const binding = new THREE.MeshStandardMaterial({ color: 0x2f3238, roughness: 0.45, metalness: 0.25 });
    const topsheet = new THREE.MeshStandardMaterial({
      map: makeTopsheetTexture(rng), roughness: 0.24, metalness: 0.1,
    });
    const base = new THREE.MeshStandardMaterial({ color: 0x07090c, roughness: 0.16, metalness: 0.05 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.18, metalness: 1.0 });
    this._materials = [shell, pants, helmet, goggle, strap, glove, boot, binding, topsheet, base, steel];

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

    /* --- board ------------------------------------------------------ */
    const boardPivot = bone('boardPivot', this.object3D, 0, 0, 0);
    const deckGeo = boardGeometry();
    const deck = part(deckGeo, topsheet, boardPivot, 0, DIM.boardThickness, 0);
    const underside = part(deckGeo, base, boardPivot, 0, 0, 0);
    underside.scale.y = -1;
    // Steel edges: two thin strips down the effective edge. They catch the
    // sun as a hard specular line when the board is on edge, which is a
    // signature of the real thing.
    for (const sx of [-1, 1]) {
      const e = part(
        new THREE.BoxGeometry(0.006, 0.014, DIM.effectiveEdge),
        steel, boardPivot, sx * DIM.boardWaist * 0.5, DIM.boardThickness * 0.5, 0,
      );
      e.name = `edge${sx > 0 ? 'Toe' : 'Heel'}`;
    }
    this.boardObject = boardPivot;

    // Bindings and their mount points — the leg IK targets.
    const halfStance = DIM.stanceWidth * 0.5;
    for (const [tag, zPos, angle] of [['Front', halfStance, DIM.frontAngle], ['Back', -halfStance, DIM.backAngle]]) {
      const mount = bone(`binding${tag}`, boardPivot, 0, DIM.boardThickness + 0.012, zPos);
      mount.rotation.y = angle;
      part(new THREE.BoxGeometry(0.13, 0.024, 0.30), binding, mount);
      // Highback.
      const hb = part(new THREE.BoxGeometry(0.125, 0.19, 0.028), binding, mount, 0, 0.10, -0.12);
      hb.rotation.x = -0.22;
      // Straps.
      part(new THREE.BoxGeometry(0.14, 0.030, 0.05), strap, mount, 0, 0.075, 0.02);
      part(new THREE.BoxGeometry(0.145, 0.028, 0.05), strap, mount, 0, 0.045, 0.10);
    }

    /* --- rider ------------------------------------------------------ */
    // Hips sit above the board, offset toward the nose so the rider's mass is
    // centred over the stance rather than over the board's midpoint.
    const hips = bone('hips', boardPivot, 0, 0.86, 0);
    part(limbGeometry(0.16, 0.155, 0.145, 1.0), pants, hips, 0, 0.08, 0);

    const spine = bone('spine', hips, 0, 0.04, 0);
    const chest = bone('chest', spine, 0, DIM.spineLength, 0);
    const torso = part(limbGeometry(DIM.chestLength, 0.145, 0.175, 1.06), shell, chest, 0, DIM.chestLength, 0);
    torso.scale.z = 0.78; // ribcage is deeper than it is wide, not round
    // Jacket hem, so the shell reads as a garment with an edge to it.
    part(new THREE.CylinderGeometry(0.163, 0.158, 0.045, 12, 1, true), shell, chest, 0, 0.02, 0);

    const neck = bone('neck', chest, 0, DIM.chestLength, 0);
    part(new THREE.CylinderGeometry(0.055, 0.062, DIM.neckLength, 8), shell, neck, 0, DIM.neckLength * 0.5, 0);

    const head = bone('head', neck, 0, DIM.neckLength, 0);
    const skull = part(new THREE.SphereGeometry(DIM.headRadius, 16, 12), helmet, head, 0, DIM.headRadius * 0.85, 0);
    skull.scale.set(1.0, 1.06, 1.12);
    // Helmet brim.
    const brim = part(new THREE.CylinderGeometry(DIM.headRadius * 1.02, DIM.headRadius * 1.02, 0.018, 16), helmet, head, 0, DIM.headRadius * 0.95, 0.01);
    brim.scale.z = 1.1;
    // Goggles: a wrapped lens across the front of the helmet.
    const lens = part(new THREE.SphereGeometry(DIM.headRadius * 0.97, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), goggle, head, 0, DIM.headRadius * 0.80, 0.012);
    lens.scale.set(1.02, 0.52, 1.06);
    lens.rotation.x = Math.PI * 0.52;
    part(new THREE.TorusGeometry(DIM.headRadius * 0.99, 0.012, 6, 20), strap, head, 0, DIM.headRadius * 0.82, 0).rotation.x = Math.PI * 0.5;

    /* --- arms -------------------------------------------------------- */
    for (const side of ['L', 'R']) {
      const sx = side === 'L' ? -1 : 1;
      const sh = bone(`shoulder${side}`, chest, sx * DIM.shoulderWidth, DIM.chestLength * 0.86, 0);
      part(new THREE.SphereGeometry(0.075, 10, 8), shell, sh);
      const ua = bone(`upperArm${side}`, sh, 0, 0, 0);
      part(limbGeometry(DIM.upperArm, 0.068, 0.056), shell, ua);
      const fa = bone(`foreArm${side}`, ua, 0, -DIM.upperArm, 0);
      part(limbGeometry(DIM.foreArm, 0.054, 0.044), shell, fa);
      const hand = bone(`hand${side}`, fa, 0, -DIM.foreArm, 0);
      const mitt = part(new THREE.SphereGeometry(0.062, 8, 6), glove, hand, 0, -0.045, 0);
      mitt.scale.set(0.85, 1.25, 1.0);
    }

    /* --- legs -------------------------------------------------------- */
    for (const [side, tag] of [['F', 'Front'], ['B', 'Back']]) {
      const sz = side === 'F' ? 1 : -1;
      const hip = bone(`hip${side}`, hips, 0, 0, sz * DIM.hipWidth * 0.55);
      const thigh = bone(`thigh${side}`, hip, 0, 0, 0);
      part(limbGeometry(DIM.thighLength, 0.105, 0.082, 1.10), pants, thigh);
      const shin = bone(`shin${side}`, thigh, 0, -DIM.thighLength, 0);
      part(limbGeometry(DIM.shinLength, 0.078, 0.062, 1.05), pants, shin);
      const bt = bone(`boot${side}`, shin, 0, -DIM.shinLength, 0);
      const bootMesh = part(new THREE.BoxGeometry(0.105, DIM.bootHeight, 0.235), boot, bt, 0, -DIM.bootHeight * 0.45, 0.015);
      bootMesh.name = `bootMesh${tag}`;
      // Cuff.
      part(new THREE.CylinderGeometry(0.072, 0.078, 0.10, 8), boot, bt, 0, 0.03, -0.01);
    }

    this.ctx.scene.add(this.object3D);
    this._applyPose(0, this._defaultState(), 1 / 60);
  }

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

    this._applyPose(this._time, s, dt);
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
    const lateral = Math.abs(s.lateralSpeed || 0);
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
    // The board flexes: press the nose on a tail-heavy landing, and bend into
    // reverse-camber under a loaded carve. Cheap approximation — bend the
    // whole deck rather than deforming vertices.
    bp.position.y = -(s.sinkDepth || 0) * 0.15;

    // ---- Hips -------------------------------------------------------
    const hips = B.hips;
    // Ride height. Total leg length is 0.88 m, so standing the hips at 0.86
    // locks the knees straight — nobody rides like that. 0.735 puts roughly
    // 25° of bend in a neutral stance, which is where a rider actually lives
    // and which leaves the legs room to both extend and absorb.
    const standH = 0.735;
    const squat = A.absorb * 0.20 + A.tuck * 0.26 + A.compress * 0.13;
    hips.position.y = standH - squat;
    // Lean the mass across the board to balance the carve.
    hips.position.x = Math.sin(A.incline) * (0.30 + 0.18 * A.absorb) * live;
    hips.position.z = (A.tuck * -0.02) + (s.pitch || 0) * 0.06;
    hips.rotation.z = A.incline * 0.45 * live + crash * 0.9;
    hips.rotation.y = A.twist * 0.35;
    hips.rotation.x = A.tuck * 0.30 + A.absorb * 0.12 + crash * 0.5;

    // ---- Spine / chest ----------------------------------------------
    B.spine.rotation.z = A.incline * 0.28 * live;
    B.spine.rotation.x = A.tuck * 0.22 + A.absorb * 0.10;
    B.chest.rotation.y = A.twist * 0.62;
    B.chest.rotation.z = A.incline * 0.20 * live - crash * 0.6;
    B.chest.rotation.x = -A.tuck * 0.10 + A.absorb * 0.16 + crash * 0.7;

    // ---- Head -------------------------------------------------------
    // A rider looks where they are going: down the fall line and into the
    // turn, never at their own board. The head counter-rotates against the
    // chest twist so the gaze stays ahead of the arc.
    B.neck.rotation.y = -A.twist * 0.30;
    B.head.rotation.y = -A.twist * 0.45 + (s.grounded ? 0 : (s.airRotation || 0) * 0.05);
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
   */
  _poseArms(t, s, A, grabName, dt) {
    const B = this.bones;
    const grab = GRABS[grabName || this._grab] || null;
    const blend = grabName ? A.grabBlend : A.grabBlend * 0.0;

    for (const side of ['L', 'R']) {
      const sx = side === 'L' ? -1 : 1;
      const ua = B[`upperArm${side}`];
      const fa = B[`foreArm${side}`];
      if (!ua) continue;

      // Free pose: arms out for balance, front arm leading the turn, with a
      // slow idle sway so a stationary rider is not a mannequin.
      const sway = Math.sin(t * 1.7 + sx) * 0.04 * clamp01(1 - s.speed / 12);
      let outX = sx * (0.62 + A.incline * sx * 0.42 + A.absorb * 0.18) + sway;
      let fwdZ = -0.28 + A.twist * sx * 0.55 - A.tuck * 0.35;
      let elbow = 0.55 + A.absorb * 0.35 + A.tuck * 0.75;

      // Crashed riders throw their arms up and forward.
      outX = lerp(outX, sx * 1.15, A.crash);
      fwdZ = lerp(fwdZ, -0.9, A.crash);
      elbow = lerp(elbow, 1.5, A.crash);

      // Grab: whichever hand the trick calls for reaches the deck point.
      const isGrabHand = grab && (
        (grab.hand === 'front' && side === 'L') || (grab.hand === 'back' && side === 'R')
      );
      if (isGrabHand && blend > 0.001) {
        // Reaching down and across to the board is a deep shoulder rotation
        // and a nearly closed elbow.
        outX = lerp(outX, sx * 0.30 + grab.point[0] * 1.2, blend);
        fwdZ = lerp(fwdZ, grab.point[1] * 0.55 + (grab.tweak[1] || 0), blend);
        elbow = lerp(elbow, 1.85, blend);
      } else if (grab && blend > 0.001) {
        // The other arm goes up and out — the tweak that sells the trick.
        outX = lerp(outX, sx * 1.05, blend * 0.7);
        fwdZ = lerp(fwdZ, -0.55, blend * 0.7);
        elbow = lerp(elbow, 0.4, blend * 0.7);
      }

      ua.rotation.z = damp(ua.rotation.z, outX, 12, dt);
      ua.rotation.x = damp(ua.rotation.x, fwdZ, 12, dt);
      fa.rotation.x = damp(fa.rotation.x, elbow, 12, dt);
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
