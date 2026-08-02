# Soho Shred

A snowboarding game set in the **Soho Basin** of Cardrona Alpine Resort, Otago,
New Zealand. Built in Three.js, targeting the visual and feel quality bar of
*Shredders* (FoamPunch, 2022).

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static bundle in dist/
```

The game is entirely self-contained: **zero external assets**. Every texture,
mesh, and sound is generated procedurally at runtime from seeded noise, canvas
rasterisation and WebAudio synthesis. `dist/` runs offline from any static host.

## Controls

| Input | Action |
| --- | --- |
| `A` / `D` or `←` / `→` | Steer / set edge |
| `S` / `↓` | Crouch — load the board |
| `Space` | Pop / ollie |
| `Shift` | Tuck for speed |
| `W` / `↑` | Level out, absorb |
| Gamepad | Left stick steer, `A` pop, triggers edge |

## Architecture

`docs/ARCHITECTURE.md` is the binding contract between subsystems and the place
to start reading. In short: `Engine` owns the renderer and a fixed-timestep loop
(120 Hz physics, render-rate visuals) and ticks a list of *systems*, each of
which publishes itself onto a shared `ctx` rather than importing its peers.

```
src/
  core/     engine, config, deterministic noise/PRNG, camera shot presets
  world/    terrain generation, snow + rock shading, sky/atmosphere, set dressing
  player/   board physics, rider model + animation, camera, tricks, input
  fx/       particles, carve trails, post-processing chain
  ui/       HUD
  audio/    synthesised audio
```

**Determinism is a hard requirement.** Nothing calls `Math.random()`; all
randomness flows from seeded generators in `src/core/rng.js`. This is what lets
the screenshot harness produce frame-for-frame reproducible captures.

## Visual development pipeline

Quality here is measured, not asserted.

```bash
node tools/shoot.mjs --width 1280 --height 720 --out shots/r1
node tools/compare.mjs --ours shots/r1 --out compare/r1
```

- **`tools/shoot.mjs`** builds the game, serves it, drives it in headless
  Chromium with the simulation clock under *manual* control, and captures one PNG
  per camera preset. Stepping the sim by hand rather than by animation frame is
  what makes captures reproducible regardless of how slow the software
  rasteriser is. It fails loudly on console errors and blank frames.
- **`tools/compare.mjs`** composites each capture beside a real *Shredders*
  frame into a blind A/B pair with a hidden answer key, so quality is judged by
  comparison against the actual target rather than by self-assessment.

Reference frames live in `reference/` and are **not committed** — they are
copyrighted marketing assets used only as local development reference.
`docs/REFERENCE_ANALYSIS.md` records what was measured from them.

## Design notes

`docs/TERRAIN_BRIEF.md` grounds the terrain in the real geography of Soho Basin —
elevation range, aspect, the schist tor landforms of the Otago high country, and
where wind puts the snow. `docs/ART_DIRECTION.md` holds the rendering bible and
the acceptance checklist.

The terrain is not raw fractal noise: an art-directed basin profile is combined
with ridged multifractal spurs and then run through droplet-based hydraulic and
thermal erosion, which is what produces believable drainage, talus-limited slope
angles and concave run-outs.
