/**
 * Carve trails.
 *
 * The rider cuts a trench and the snow remembers it. That memory lives in one
 * RGBA render target that `snowMaterial.js` samples per-fragment, using the
 * channel layout it publishes as `SNOW_TRACK_TEXTURE_CHANNELS`:
 *
 *   R — trench depth   cut down, darken, tint blue, kill glints
 *   G — displaced lip  raise, brighten slightly
 *   B — compaction     lower roughness — the polished base line
 *   A — amount         multiplies the other three
 *
 * The implementation is a strip-mesh splat. Each frame the rider's travel
 * since the last stamp becomes a short quad strip, five columns wide, drawn
 * into the target with an orthographic camera looking straight down. The
 * columns give the trench its cross-section: a flat floor, a raised lip on
 * each side, and a feathered outer edge that fades to nothing.
 *
 * Two decisions worth stating, because both are the difference between this
 * looking like snow and looking like paint:
 *
 *   · The target is never cleared and blends with MAX rather than adding.
 *     Tracks therefore persist for the whole run at their true depth, and a
 *     rider crossing their own line does not burn a double-bright hole where
 *     the two overlap — which additive blending does immediately and which
 *     reads as a bug the instant you see it.
 *   · Depth comes from the physics, not from a constant. A skidded turn
 *     scrapes a broad shallow scar with a big lip; a clean carve leaves a
 *     narrow deep line with almost no displacement and high compaction. Those
 *     are visibly different marks in the reference footage and they should be
 *     visibly different here.
 *
 * The region is a fixed box centred on the basin rather than a window that
 * scrolls with the rider: scrolling costs a copy every time it recentres and
 * silently discards the track you just cut when you turn around to look at it.
 */

import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { clamp01, lerp, smoothstep } from '../core/rng.js';

/** Side of the square world region the target covers, metres. */
const REGION_SIZE = 320;
/** Target resolution. 320 m / 2048 ≈ 15.6 cm per texel. */
const RES = 2048;
/** Rider travel between stamps, metres. */
const STAMP_STEP = 0.14;
/** Ring capacity, in strip segments, for one frame's worth of stamps. */
const MAX_SEGMENTS = 96;

/** Cross-section, as offsets in board half-widths and their channel values. */
const PROFILE = [
  //  offset   R(trench) G(lip)  B(compact) A(amount)
  [-1.75, 0.00, 0.00, 0.00, 0.00],
  [-1.05, 0.06, 1.00, 0.15, 1.00],
  [-0.45, 0.92, 0.20, 0.95, 1.00],
  [0.45, 0.92, 0.20, 0.95, 1.00],
  [1.05, 0.06, 1.00, 0.15, 1.00],
  [1.75, 0.00, 0.00, 0.00, 0.00],
];
const COLS = PROFILE.length;

export class TrailSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.texture = null;
    this.target = null;

    // Region is resolved at build time against the terrain's actual spawn, so
    // the box is centred on where riding happens rather than on the origin.
    this.trackRegion = { minX: -REGION_SIZE / 2, minZ: -REGION_SIZE / 2, size: REGION_SIZE };

    this._last = new THREE.Vector3();
    this._lastRight = new THREE.Vector3(1, 0, 0);
    this._hasLast = false;
    this._pending = 0;

    this._v = new THREE.Vector3();
    this._right = new THREE.Vector3();
  }

  build() {
    const ctx = this.ctx;

    // Centre the box on the default spawn's fall line — a little downhill of
    // the gate, because that is where the run actually is.
    const terrain = ctx.terrain;
    if (terrain?.getSpawn) {
      const s = terrain.getSpawn();
      const cx = s.position.x;
      const cz = s.position.z - REGION_SIZE * 0.28;
      this.trackRegion = {
        minX: cx - REGION_SIZE / 2,
        minZ: cz - REGION_SIZE / 2,
        size: REGION_SIZE,
      };
    }

    this.target = new THREE.WebGLRenderTarget(RES, RES, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.target.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.target.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.target.texture.anisotropy = Math.min(4, CONFIG.render.anisotropy);
    // Track data is a mask, not colour — it must not be sRGB-decoded.
    this.target.texture.colorSpace = THREE.NoColorSpace;
    this.texture = this.target.texture;

    // Clear once to fully empty. Nothing clears it again for the rest of the
    // run; that is what makes the tracks persistent.
    const renderer = ctx.renderer;
    if (renderer) {
      const prevTarget = renderer.getRenderTarget();
      const prevClear = new THREE.Color();
      renderer.getClearColor(prevClear);
      const prevAlpha = renderer.getClearAlpha();
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevAlpha);
    }

    // ---- Splat scene --------------------------------------------------
    // The material samples this target at uv = (worldXZ − min) / size, so the
    // render has to put world +X at increasing u and world +Z at increasing v.
    //
    // Looking straight down with up = −Z gives world +X → camera +X (u is
    // correct) but world +Z → camera −Y, which would land v upside down. The
    // fix is to swap top and bottom in the frustum, which negates the
    // projection's y and puts +Z back at increasing v. Getting this wrong
    // mirrors every track across the fall line, and because a trench is
    // roughly symmetric it is easy to miss until the tracks stop lining up
    // with the rider.
    const r = this.trackRegion;
    const half = r.size / 2;
    const cx = r.minX + half;
    const cz = r.minZ + half;
    this._camera = new THREE.OrthographicCamera(-half, half, -half, half, 0.1, 2000);
    this._camera.position.set(cx, 1000, cz);
    this._camera.up.set(0, 0, -1);
    this._camera.lookAt(cx, 0, cz);
    this._camera.updateProjectionMatrix();
    this._camera.updateMatrixWorld(true);

    this._scene = new THREE.Scene();

    const verts = MAX_SEGMENTS * COLS * 2;
    this._pos = new Float32Array(verts * 3);
    this._col = new Float32Array(verts * 4);
    const geo = new THREE.BufferGeometry();
    this._aPos = new THREE.BufferAttribute(this._pos, 3).setUsage(THREE.DynamicDrawUsage);
    this._aCol = new THREE.BufferAttribute(this._col, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this._aPos);
    geo.setAttribute('color', this._aCol);

    // Index a quad strip: for each segment, (COLS-1) quads between the
    // previous cross-section and the current one.
    const idx = [];
    for (let s = 0; s < MAX_SEGMENTS; s++) {
      const a = s * COLS * 2;          // previous cross-section
      const b = a + COLS;              // current cross-section
      for (let c = 0; c < COLS - 1; c++) {
        idx.push(a + c, b + c, a + c + 1, a + c + 1, b + c, b + c + 1);
      }
    }
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this._geometry = geo;

    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      // MAX, not ADD: crossing your own track must not double its depth.
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.MaxEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this._material = mat;

    this._mesh = new THREE.Mesh(geo, mat);
    this._mesh.frustumCulled = false;
    this._scene.add(this._mesh);
    geo.setDrawRange(0, 0);
  }

  getTrackTexture() { return this.texture; }
  getTrackRegion() { return this.trackRegion; }

  update(dt, ctx) {
    if (!this.target) return;
    const s = ctx.physics?.state;
    const renderer = ctx.renderer;
    if (!s || !renderer) return;

    this._pending = 0;

    // The box is placed at build time from the default spawn, but a shot
    // preset — or simply a long traverse — can put the rider hundreds of
    // metres outside it, and every stamp then falls on the floor silently.
    // Recentre when that happens. Losing the old tracks is correct: the only
    // way to travel that far in one step is a teleport, and a teleport should
    // not smear a trench across the basin.
    if (this._outsideRegion(s.position)) this._recenter(s.position);

    if (s.grounded && !s.crashed) {
      this._accumulate(s);
    } else {
      // Airborne: break the strip so the trench does not draw a straight line
      // across the gap from take-off to landing.
      this._hasLast = false;
    }

    if (this._pending === 0) return;

    this._aPos.needsUpdate = true;
    this._aCol.needsUpdate = true;
    this._geometry.setDrawRange(0, this._pending * (COLS - 1) * 6);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.target);
    renderer.render(this._scene, this._camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  /** True when the rider has left the covered box, with a margin. */
  _outsideRegion(p) {
    const r = this.trackRegion;
    const m = 8;
    return p.x < r.minX + m || p.x > r.minX + r.size - m ||
           p.z < r.minZ + m || p.z > r.minZ + r.size - m;
  }

  /** Move the covered box to sit around `p`, and start it empty. */
  _recenter(p) {
    const half = REGION_SIZE / 2;
    this.trackRegion = { minX: p.x - half, minZ: p.z - half, size: REGION_SIZE };
    if (this._camera) {
      // Only the position moves — the frustum is already expressed relative
      // to the camera, so the projection stays valid.
      this._camera.position.set(p.x, 1000, p.z);
      this._camera.up.set(0, 0, -1);
      this._camera.lookAt(p.x, 0, p.z);
      this._camera.updateMatrixWorld(true);
    }
    this.clear();
  }

  /**
   * Walk from the last stamp to the rider's current position, emitting one
   * cross-section pair per STAMP_STEP so the strip is continuous at any speed.
   */
  _accumulate(s) {
    const pos = s.position;
    const region = this.trackRegion;

    // Outside the box there is nothing to write.
    if (pos.x < region.minX || pos.x > region.minX + region.size ||
        pos.z < region.minZ || pos.z > region.minZ + region.size) {
      this._hasLast = false;
      return;
    }

    // Board right, in the horizontal plane.
    this._right.set(Math.cos(s.heading), 0, -Math.sin(s.heading));

    if (!this._hasLast) {
      this._last.copy(pos);
      this._lastRight.copy(this._right);
      this._hasLast = true;
      return;
    }

    this._v.subVectors(pos, this._last);
    this._v.y = 0;
    const dist = this._v.length();
    if (dist < STAMP_STEP) return;

    // ---- Mark character, from the physics -----------------------------
    // A carve is narrow, deep and polished. A skid is wide and shallow with a
    // big displaced lip. Slow riding in deep snow leaves a broad soft trough.
    const sink = clamp01((s.sinkDepth || 0) / Math.max(CONFIG.physics.powderDepth, 1e-3));
    const edge = clamp01(s.edgeLoad || 0);
    const slip = clamp01(Math.abs(s.lateralSpeed || 0) / 6);
    const fast = smoothstep(2, 14, s.speed);

    // No mark at all on rock, and a faint one on ice.
    const surf = s.surface;
    const surfaceScale = surf === 'rock' || surf === 'scree' ? 0
      : surf === 'ice' ? 0.22
        : surf === 'crust' ? 0.55
          : surf === 'windpack' ? 0.7 : 1.0;
    if (surfaceScale <= 0) { this._last.copy(pos); return; }

    const depth = clamp01((0.30 + edge * 0.55 + sink * 0.45) * fast) * surfaceScale;
    const lip = clamp01((0.15 + slip * 0.85 + sink * 0.35) * fast) * surfaceScale;
    const compaction = clamp01((0.35 + edge * 0.65) * (1 - slip * 0.5)) * surfaceScale;
    // A skid is wider than a carve — up to about three board widths.
    const halfWidth = lerp(0.16, 0.42, slip) + sink * 0.10;

    const steps = Math.min(Math.floor(dist / STAMP_STEP), MAX_SEGMENTS - this._pending);
    if (steps <= 0) return;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this._v.copy(this._last).lerp(pos, t);
      // Interpolate the frame too, or a fast turn produces a visible polygon
      // fan where the cross-section snaps to the new heading.
      this._right.set(
        lerp(this._lastRight.x, Math.cos(s.heading), t), 0,
        lerp(this._lastRight.z, -Math.sin(s.heading), t),
      ).normalize();

      this._emit(this._v, this._right, halfWidth, depth, lip, compaction);
    }

    this._last.copy(pos);
    this._lastRight.set(Math.cos(s.heading), 0, -Math.sin(s.heading));
  }

  /** Write one segment: the previous cross-section and the new one. */
  _emit(centre, right, halfWidth, depth, lip, compaction) {
    if (this._pending >= MAX_SEGMENTS) return;
    const seg = this._pending++;
    const base = seg * COLS * 2;

    // The previous cross-section is whatever we wrote last time; re-emitting
    // it keeps every segment self-contained, which costs six vertices and
    // removes all the bookkeeping a shared-vertex strip would need.
    for (let pass = 0; pass < 2; pass++) {
      const src = pass === 0 ? this._prevSection : null;
      for (let c = 0; c < COLS; c++) {
        const vi = base + pass * COLS + c;
        const p = PROFILE[c];
        const off = p[0] * halfWidth;

        let px, pz;
        if (src) {
          px = src[c * 2]; pz = src[c * 2 + 1];
        } else {
          px = centre.x + right.x * off;
          pz = centre.z + right.z * off;
        }

        this._pos[vi * 3] = px;
        this._pos[vi * 3 + 1] = 0;
        this._pos[vi * 3 + 2] = pz;

        this._col[vi * 4] = p[1] * depth;
        this._col[vi * 4 + 1] = p[2] * lip;
        this._col[vi * 4 + 2] = p[3] * compaction;
        this._col[vi * 4 + 3] = p[4];
      }
    }

    // Remember this cross-section for the next segment's leading edge.
    if (!this._prevSection) this._prevSection = new Float32Array(COLS * 2);
    for (let c = 0; c < COLS; c++) {
      const off = PROFILE[c][0] * halfWidth;
      this._prevSection[c * 2] = centre.x + right.x * off;
      this._prevSection[c * 2 + 1] = centre.z + right.z * off;
    }
  }

  clear() {
    const renderer = this.ctx.renderer;
    if (!renderer || !this.target) return;
    const prevTarget = renderer.getRenderTarget();
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    this._hasLast = false;
    this._prevSection = null;
  }

  dispose() {
    this.target?.dispose();
    this._geometry?.dispose();
    this._material?.dispose();
  }
}
