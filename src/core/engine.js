/**
 * Engine — owns the WebGL renderer, the scene graph root, the camera and the
 * frame loop. Everything else in the game is a *system* that the engine ticks.
 *
 * Contract for systems:
 *   - `update(dt, ctx)`  called once per rendered frame with wall-clock delta
 *   - `fixedUpdate(h, ctx)` called 0..maxSubSteps times per frame with a fixed
 *     step (physics + anything that must be determinstic)
 *   - `resize(w, h)`     called when the drawing buffer changes
 *   - `dispose()`        release GPU resources
 * All are optional; the engine feature-detects them.
 */

import * as THREE from 'three';
import { CONFIG } from './config.js';

const TONE_MAPPINGS = {
  none: THREE.NoToneMapping,
  linear: THREE.LinearToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  cineon: THREE.CineonToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
};

export class Engine {
  constructor(container) {
    this.container = container;
    this.systems = [];
    this.running = false;
    this.frame = 0;
    this.elapsed = 0;
    this.accumulator = 0;
    /** Set by the capture harness to drive time manually. */
    this.manualTime = false;

    const canvas = document.createElement('canvas');
    canvas.id = 'soho-canvas';
    container.appendChild(canvas);
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: CONFIG.render.antialias,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      // Needed so the screenshot harness can read the drawing buffer.
      preserveDrawingBuffer: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.render.pixelRatioCap));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = TONE_MAPPINGS[CONFIG.render.toneMapping] ?? THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = CONFIG.render.exposure;
    this.renderer.shadowMap.enabled = true;
    // r185 deprecated PCFSoftShadowMap and silently substitutes PCFShadowMap;
    // naming the real path avoids a console warning on every boot.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;

    this.maxAnisotropy = Math.min(
      CONFIG.render.anisotropy,
      this.renderer.capabilities.getMaxAnisotropy(),
    );

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      CONFIG.camera.fov,
      1,
      CONFIG.camera.near,
      CONFIG.camera.far,
    );
    this.camera.position.set(0, 40, 40);
    this.camera.lookAt(0, 0, 0);

    /**
     * Shared per-frame context handed to every system. Systems read from it
     * rather than reaching into each other, which keeps the dependency graph
     * a star instead of a mesh.
     */
    this.ctx = {
      engine: this,
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      config: CONFIG,
      maxAnisotropy: this.maxAnisotropy,
      elapsed: 0,
      frame: 0,
      /** Filled in by systems as they come online. */
      terrain: null,
      sky: null,
      player: null,
      physics: null,
      input: null,
      audio: null,
      hud: null,
      fx: null,
      /** Composer, when post-processing is active. */
      composer: null,
    };

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    this._onResize();
  }

  /** Register a system. Order matters: systems tick in registration order. */
  add(system) {
    this.systems.push(system);
    return system;
  }

  _onResize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const dpr = this.renderer.getPixelRatio();
    for (const s of this.systems) s.resize?.(w * dpr, h * dpr, w, h);
  }

  /** Force a specific drawing-buffer size (capture harness uses this). */
  setSize(w, h) {
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const s of this.systems) s.resize?.(w, h, w, h);
  }

  /**
   * Advance the simulation by `dt` seconds and render exactly one frame.
   * Split out from the RAF loop so the capture harness can step deterministically.
   *
   * `doRender === false` runs the full simulation but skips the draw. The
   * capture harness uses it to warm the world up (LOD streaming, physics,
   * particles) without paying for hundreds of software-rasterised frames;
   * `postRender` still runs so history-dependent effects (motion-blur
   * reprojection) stay continuous across the settle.
   */
  tick(dt, doRender = true) {
    const { fixedTimestep, maxSubSteps } = CONFIG.physics;
    dt = Math.min(dt, 0.1); // clamp huge stalls (tab restore, GC pause)
    this.elapsed += dt;
    this.frame++;
    this.ctx.elapsed = this.elapsed;
    this.ctx.frame = this.frame;
    this.ctx.dt = dt;

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= fixedTimestep && steps < maxSubSteps) {
      for (const s of this.systems) s.fixedUpdate?.(fixedTimestep, this.ctx);
      this.accumulator -= fixedTimestep;
      steps++;
    }
    // Bleed off leftover time rather than spiralling.
    if (steps === maxSubSteps) this.accumulator = 0;
    this.ctx.alpha = this.accumulator / fixedTimestep;

    for (const s of this.systems) s.update?.(dt, this.ctx);

    if (doRender) {
      this.renderer.info.reset();
      if (this.ctx.composer) {
        this.ctx.composer.render(dt);
      } else {
        this.renderer.render(this.scene, this.camera);
      }
    }
    for (const s of this.systems) s.postRender?.(dt, this.ctx);
  }

  start() {
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(loop);
      if (this.manualTime) return;
      let dt = (now - last) / 1000;
      last = now;
      // Real-hardware rule the headless captures never needed: a frame
      // hitch (GC, texture decode, tab jank) must not become one giant
      // physics step - that is how the first playtest put the rider and
      // camera under the terrain. Clamp the wall-clock step and integrate
      // it in <=1/60 s quanta.
      dt = Math.min(dt, 0.05);
      const n = dt > 1 / 50 ? Math.ceil(dt / (1 / 60)) : 1;
      for (let i = 0; i < n; i++) this.tick(dt / n);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    for (const s of this.systems) s.dispose?.();
    this.renderer.dispose();
  }
}
