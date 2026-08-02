# Soho Shred — Architecture & Module Contracts

This document is the **binding contract** between parallel workstreams. Each
module below is owned by exactly one workstream. **Do not edit files you do not
own.** If you need something from another module, use its documented interface;
if the interface is insufficient, note it in your report rather than editing
the other file.

## Hard constraints

1. **Zero external assets.** No downloaded textures, models, audio, or fonts.
   Everything is generated procedurally at runtime (canvas/noise for textures,
   WebAudio synthesis for sound, code-built geometry for meshes). The game must
   run fully offline from a static `dist/`.
2. **Determinism.** Never call `Math.random()`. Use `makeRng(seed)` /
   `Simplex` from `src/core/rng.js`. The screenshot harness diffs frames across
   runs; nondeterminism breaks it.
3. **Three.js r185**, ES modules, no TypeScript. Import as
   `import * as THREE from 'three'`. Addons come from `three/addons/...`.
4. **Headless target is SwiftShader** (software raster). WebGL2, `MAX_SAMPLES`
   is 4, max texture 8192, float-linear and float-color-buffer available.
   Budget accordingly: prefer a few well-authored materials over hundreds of
   draw calls. Everything must still scale up on real GPU hardware.
5. **Units are SI.** Metres, seconds, kilograms, radians. +Y is up. The fall
   line of the main face runs toward −Z.

## Frame lifecycle

`Engine.tick(dt)` runs, in order:

1. `system.fixedUpdate(h, ctx)` — 0..8 times, `h = 1/120`. Physics only.
2. `system.update(dt, ctx)` — once, wall-clock delta. Visuals, animation, audio.
3. render (`ctx.composer.render()` if post is active, else direct).
4. `system.postRender(dt, ctx)`.

Every method is optional; the engine feature-detects. Systems also may
implement `resize(bufW, bufH, cssW, cssH)` and `dispose()`.

## The shared context (`ctx`)

Systems never import each other directly for runtime state. They read `ctx`:

```js
ctx = {
  engine, renderer, scene, camera, config, maxAnisotropy,
  elapsed,  // seconds since boot
  frame,    // integer frame counter
  dt,       // last frame delta
  alpha,    // fixed-step interpolation remainder [0,1)
  terrain, sky, player, physics, input, audio, hud, fx, composer,
}
```

A system publishes itself onto `ctx` in its constructor (e.g.
`ctx.terrain = this`). Registration order in `src/main.js` guarantees a system's
dependencies exist before it is constructed.

---

## Module contracts

### `src/core/rng.js` — OWNED, DO NOT EDIT
Provides `makeRng`, `Simplex`, `fbm2`, `ridged2`, `billow2`, `warpedFbm2`,
`worley2`, `hash32`, `seedFromString`, and math helpers `clamp`, `clamp01`,
`lerp`, `invLerp`, `smoothstep`, `smootherstep`, `damp`, `mod`, `angleDelta`.

### `src/core/config.js` — OWNED, DO NOT EDIT
`CONFIG` tuning tree and `LOCATION` (real Soho Basin geo data). Read freely.
If you need a new tunable, add it under your own subtree only.

### `src/core/engine.js` — OWNED, DO NOT EDIT

---

### `src/world/terrain.js` — Terrain
The single source of truth for ground geometry. Everything else queries it.

```js
export class Terrain {
  constructor(ctx)
  async build()                    // generate heightfield + meshes, add to scene
  getHeight(x, z) -> number        // metres, must be fast (called ~1000x/frame)
  getNormal(x, z, out?) -> Vector3 // unit surface normal
  sample(x, z, out?) -> {          // one-shot combined query
    height, normal, slope,         // slope in radians from horizontal
    surface,                       // 'powder'|'groomed'|'ice'|'rock'|'windpack'
    roughness }
  getSpawn() -> { position: Vector3, heading: number }
  update(dt, ctx)                  // LOD streaming around ctx.camera
  object3D                         // THREE.Object3D root
  bounds                           // { minX, maxX, minZ, maxZ }
}
```

`getHeight` **must** be continuous and match the rendered mesh to within a few
centimetres, or the rider will float/sink visibly.

### `src/world/snowMaterial.js` — snow surface shading
```js
export function createSnowMaterial(ctx, opts) -> THREE.Material
export function createRockMaterial(ctx, opts) -> THREE.Material
export function updateSnowMaterial(mat, dt, ctx)   // animate sparkle, sun, etc.
```
Materials are consumed by `terrain.js` and `props.js`. Own the shaders,
the procedural texture generation, and the BRDF. Do not edit terrain geometry.

### `src/world/sky.js` — Sky
```js
export class Sky {
  constructor(ctx)
  build()
  update(dt, ctx)
  sunDirection -> Vector3   // unit, points from origin toward the sun
  sunColor -> Color
  ambientColor -> Color
  object3D
  environmentTexture        // PMREM cube for IBL, or null
}
```
Owns: atmospheric scattering, sun/moon, clouds, aerial perspective / fog
parameters, IBL environment map, and the distant mountain backdrop silhouette.

### `src/world/props.js` — Props
Rocks, cliff bands, snow poles, marker flags, fences, lift towers, tussock
grass poking through wind-scoured patches, avalanche debris. Instanced.
```js
export class Props {
  constructor(ctx)
  async build()
  update(dt, ctx)
  object3D
  /** Optional collision shapes for the physics system. */
  getColliders() -> Array<{type, position, radius|halfExtents, quaternion}>
}
```

### `src/player/physics.js` — BoardPhysics
```js
export class BoardPhysics {
  constructor(ctx)
  fixedUpdate(h, ctx)
  state -> {
    position: Vector3, velocity: Vector3, heading: number,
    pitch, roll, edgeAngle,        // radians
    grounded: bool, airTime: number,
    speed: number, gForce: number,
    surface: string, sinkDepth: number,
    carving: bool, sliding: bool, crashed: bool,
  }
  applyInput(input)                // called by controls
  reset(position, heading)
}
```
Owns: gravity, edge grip and carving, board flex, powder sink, drag,
landing impact, crash detection, jump/pop impulse.

### `src/player/rider.js` — Rider
```js
export class Rider {
  constructor(ctx)
  async build()
  update(dt, ctx)   // reads ctx.physics.state, poses the skeleton
  object3D
  boardObject       // for trail/particle attachment
  getBoneWorldPosition(name, out) -> Vector3
}
```
Owns: procedurally built character mesh (body, jacket, pants, helmet, goggles,
gloves, boots, bindings, board), skeleton, IK, and all procedural animation
(carve lean, absorption, ollie tuck, grab poses, tweaks, landing compression,
ragdoll on crash). Reads physics state; never writes it.

### `src/player/tricks.js` — TrickSystem
```js
export class TrickSystem {
  constructor(ctx)
  update(dt, ctx)
  current -> { name, rotation, flip, grab, score, multiplier } | null
  onLanded(quality)   // 'perfect'|'clean'|'sketchy'|'crash'
  combo -> { tricks: [], score: number, active: bool }
}
```

### `src/player/camera.js` — ChaseCamera
```js
export class ChaseCamera {
  constructor(ctx)
  update(dt, ctx)   // drives ctx.camera
  setMode(mode)     // 'chase'|'cinematic'|'orbit'|'free'|'firstPerson'
  frame(preset)     // used by the capture harness for deterministic shots
}
```

### `src/player/controls.js` — Input
Keyboard + gamepad + touch. Publishes a normalised input struct:
```js
{ steer: -1..1, lean: -1..1, crouch: 0..1, pop: bool, spin: -1..1,
  flip: -1..1, grab: null|'indy'|'mute'|'melon'|'stalefish'|'nose'|'tail'|'method',
  tuck: bool, brake: 0..1, reset: bool }
```

### `src/fx/particles.js` — ParticleFX
Carve spray, powder plume, impact bursts, ambient snowfall, wind-blown surface
drift, contrail off the tail. GPU-instanced.
```js
export class ParticleFX {
  constructor(ctx); build(); update(dt, ctx)
  emitSpray(position, direction, intensity)
  emitImpact(position, intensity)
  object3D
}
```

### `src/fx/trails.js` — TrailSystem
Persistent carve trenches written into a splat texture that the snow material
samples — edge trench, sidewall shadow, displaced snow lip.
```js
export class TrailSystem {
  constructor(ctx); build(); update(dt, ctx)
  getTrackTexture() -> THREE.Texture   // consumed by snowMaterial
  clear()
}
```

### `src/fx/postprocess.js` — post chain
```js
export function createComposer(ctx) -> EffectComposer   // sets ctx.composer
export function updatePost(dt, ctx)
```
Owns: SSAO, bloom, depth of field, motion blur, tone mapping polish,
chromatic aberration, film grain, vignette, sharpening, and the snow-glare
/ lens-flare treatment. Must degrade gracefully when `MAX_SAMPLES === 4`.

### `src/ui/hud.js` — HUD
Speed, air time, trick call-outs, combo meter, score, run timer, minimap,
menus. DOM overlay or canvas texture — your call, but it must screenshot.
```js
export class HUD { constructor(ctx); build(); update(dt, ctx); setVisible(v) }
```

### `src/audio/audio.js` — AudioSystem
Fully synthesised: edge carve hiss (filtered noise driven by edge angle and
speed), powder whump, wind (speed-driven), board chatter, landing thud, lip
pop, ambient alpine bed. Must not block boot if the AudioContext is suspended
(headless has no audio device).
```js
export class AudioSystem { constructor(ctx); async build(); update(dt, ctx); setMuted(m) }
```

---

## Capture harness

`src/main.js` exposes `window.__SOHO` for the screenshot tool:

```js
window.__SOHO = {
  ready: Promise<void>,       // resolves when world build completes
  engine, ctx,
  setSize(w, h),
  step(dt),                   // advance exactly dt and render one frame
  settle(seconds, dt=1/60),   // advance many steps (warm up LOD, particles)
  shot(presetName),           // pose camera/state for a named shot
  presets: string[],
  setConfig(overrides),
  stats() -> { drawCalls, triangles, programs, fps },
}
```

Shot presets are defined in `src/core/shots.js` (owned by integration).
Adding a preset is the only reason to touch that file.
