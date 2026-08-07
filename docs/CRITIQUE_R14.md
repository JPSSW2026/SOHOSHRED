# r14 critique — merged and ranked

Three independent critics graded the nine-shot r14 set against
`ART_DIRECTION.md` (§8, §9, §11, §12 and the acceptance checklist), one per
lens: lighting/snow, terrain/atmosphere/composition, rider/camera/particles.
Each was required to open the source file before naming a mechanism. Their
measurements are reproduced as given.

Status is honest about verification: **fixed+verified** means the change is in
and the improvement was observed in a re-shot frame; **fixed (unverified)**
means the change is in and reasoned but not yet demonstrated in an image.

---

## ⚠ Blocker: the capture is not deterministic — and it is a *renderer* problem

Two runs of `tools/shoot.mjs --shots chase-carve` on the *same build* produce
different images: **17.0% of pixels differ by more than 4 levels, max 146**.
That is far above anti-alias jitter, and large enough to swamp the tile-contrast
and channel-ratio measurements in this document. Every before/after comparison
here, including the critics' numbers, carries that noise.

Treat measured deltas below the noise floor as unproven until this is fixed.

**The sim is not the culprit.** Calling `shot('chase-carve')` three times in one
page session, capturing physics state either side of each call:

| run | after `reset()` | after `shot()` | image |
|-----|-----------------|----------------|-------|
| 1 | speed 0, x 400, z 740 | speed 5.0278, x 138.652, z 913.385 | differs |
| 2 | speed 0, x 400, z 740 | speed 5.0069, x 138.689, z 913.076 | differs |
| 3 | speed 0, x 400, z 740 | speed 5.0069, x 138.689, z 913.076 | differs |

`reset()` lands on byte-identical state every time, and runs 2 and 3 end
**bit-identical in physics** — yet all three render differently. Whatever moves
the pixels is downstream of the simulation.

Run 1 differing from 2 and 3 is a separate, smaller effect: until `shot()` sets
`manualTime`, the engine runs on requestAnimationFrame, so a load-dependent
number of wall-clock frames perturb the state the first settle starts from.

### Ruled out — do not retry these shapes

| hypothesis | result |
|---|---|
| Sun drift | `_solarKey` is keyed on `CONFIG.world.timeOfDay/dayOfYear`, not elapsed time. Not it |
| The settle | Fixed count of fixed-dt steps; deterministic by construction |
| Async terrain LOD streaming | **Disproven** — `_updateLod` rebuilds dirty levels synchronously inside `update()` |
| Clearing trails + particle pool + fx clock in `shot()` | **Worse: 37.5%.** Zeroing the particle clock leaves pooled sprites carrying spawn stamps from the future |
| Freezing `manualTime` at ready + clearing trails per shot | **Worse: 28.3%.** Reverted |
| Pinning the grain seed via `ctx.frame` | **No effect: 16.8%.** `tick()` does `this.frame++; this.ctx.frame = this.frame`, so the mirror is overwritten immediately |
| Pinning `engine.frame` itself | **Worse: 37.1%.** The counter also drives the other temporal systems; jumping it to an arbitrary value disrupts them |
| Pinning `uSeed` directly via a new `post.grain.fixedSeed`, bracketed around `shot()` like `shotExposure` | **Catastrophically worse: 99.2% of pixels, mean 35.** The seed itself is constant per preset, so this cannot be grain — mean 35 is far above the 0.022 amplitude. Introducing the property appears to perturb something structural, most likely the shader feature key and with it recompile timing |

### Confirmed: it is purely the render path

That check has now been run. `shot('chase-carve')` once, then `engine.tick(0,
true)` four times — `dt = 0`, so nothing in the sim can advance — and
screenshot after each:

```
["e6a8fa4ddc53", "219142d84b9b", "897a62106d6a", "07f1ea9a045d"]   all four differ
```

Four re-renders of one frozen frame, four different images. No sim hygiene can
fix this.

The grain seed looked like the answer — `uSeed = hash32(ctx.frame)`, and the
0.022 grain amplitude is ~5.6/255, which brackets the observed 2.89 mean. But
seeding it deterministically changed nothing, and pinning the underlying
counter made things worse, so grain is at most part of it.

### Grain is exonerated; the frozen-frame probe was flawed

Two corrections to the section above, both from direct measurement.

**Grain is not the cause.** Disabling it outright via the existing
`CONFIG.post.grain.enabled` flag — no new property, no bracketing — leaves
divergence at **16.98%** against the 17.04% baseline. Unchanged. Every
seed-related hypothesis is therefore dead, including the one attempt 5 was
built on.

**The frozen-frame probe proves less than claimed.** `engine.tick` increments
the frame counter regardless of `dt`, so grain necessarily changes on every
call. Four differing hashes only demonstrated that grain animates. The
"purely the render path" conclusion over-read it, and a 40-frame warm-up
before measuring did not converge the hashes either. The probe needs the
frame counter held still to say anything — as written it cannot.

What still stands, because it does not depend on that probe: two consecutive
shots in one session end **bit-identical in physics** and still render
differently. Something downstream of the sim varies, and it is not grain.

Remaining candidates, none tested: the AO rotation and DoF sampling (the
postprocess header notes these are frame-indexed like grain was), motion-blur
reprojection, or non-deterministic rasterisation under SwiftShader. Test each
by disabling it with its existing flag and re-running the two-shoot
comparison — that method is cheap, needs no engine change, and just produced
a clean answer for grain.

### The decisive observation: it is bimodal, and it *can* be reproducible

Three runs of one preset on one build, nothing changed between them:

| pair | mean | >4 levels |
|---|---|---|
| run 1 vs run 2 | 2.923 | 17.16% |
| run 2 vs run 3 | 2.922 | 17.15% |
| **run 1 vs run 3** | **0.006** | **0.05%** |

Runs 1 and 3 are *the same image*. The capture is not randomly noisy — it
lands in one of (at least) two states, and two runs that land in the same one
agree to within a rounding error. **Reproducible capture is achievable**; what
is missing is control over which state a run lands in.

This also invalidates every earlier A/B in this document, including the ones
that condemned the attempted fixes. A two-sample comparison of a bimodal
process measures which states the two samples happened to land in, not the
change under test. **Any future comparison needs at least three runs per
build**, and should compare the modal image, not run 1 against run 1.

Two further results, both from the existing-flag method:

- **All eight post effects disabled at once: 99.67%, mean 36.5.** Worse than
  leaving them on, which rules out "a post effect in isolation" as the story.
- **Frame-parity normalisation failed twice.** Forcing the capture onto an even
  `engine.frame` gave 24.2/17.3/17.1%, and doing the same with a `dt = 0` tick
  so the phase moved without the sim gave 25.6/29.7/34.5%. The two-phase
  temporal-effect reading of the bimodality is therefore *not* supported.

### The pattern across attempts

| approach | result vs 17.0% baseline |
|---|---|
| Clear fx accumulators | 37.5% |
| Freeze clock + clear trails | 28.3% |
| Pin `ctx.frame` | 16.8% (no effect) |
| Pin `engine.frame` | 37.1% |
| Pin `uSeed` via new config property | 99.2% |
| Disable grain entirely (existing flag) | 17.0% — unchanged, and it exonerates grain |
| Disable all eight post effects | 99.7% |
| Normalise capture frame parity (dt = 1/60) | 24.2 / 17.3 / 17.1% |
| Normalise capture frame parity (dt = 0) | 25.6 / 29.7 / 34.5% |

**Read these with the bimodality in mind.** Each is a two-sample comparison of
a process with two attractors, so a "worse" number may only mean the two runs
landed in different states. The interventions are not thereby vindicated — but
they are not fairly condemned either, and none should be re-run without the
three-run protocol.

### Root cause identified: the LOD snap boundary

Step 2 of the plan below has now been run — the spatial signature of the
difference between the two modal images:

| measurement | value |
|---|---|
| top quarter of frame (sky) | **0.0% differing** |
| bottom-left blocks (near field) | 47.4% / 42.2% |
| mean image gradient where differing | **14.04** |
| mean image gradient elsewhere | 2.68 |
| signed mean difference | −0.016 (i.e. none) |

The sky is bit-identical, which excludes post, grade, grain and exposure —
all of them would touch it. The difference is confined to the near field, sits
on high-gradient pixels at 5.2x the background rate, and has no net brightness
shift. That is **geometry resampling**, not shading.

`_updateLod` centres each ring with `Math.round(px / snap) * snap`. A camera
that lands a hair either side of a snap boundary flips that rounding — a
**binary** decision, which is exactly the two attractors observed. The tiny
physics differences between runs (5.0278 vs 5.0069 m/s) are more than enough to
straddle one, and a half-cell shift in the near ring resamples every detailed
pixel in the foreground while leaving the sky untouched.

**This also rehabilitates attempt 2.** Freezing `manualTime` at ready targets
exactly the right thing: it removes the load-dependent rAF frames that cause
the small physics divergence in the first place. It was rejected on a
two-sample comparison, which we now know cannot distinguish a real improvement
from a state flip. It should be re-tested under the three-run protocol before
anything else is tried.

### Attempt 2 re-tested under the three-run protocol — genuinely dead

Freezing `manualTime` at ready, harness-only, no engine change:

| pair | baseline | clock frozen at ready |
|---|---|---|
| 1 vs 2 | 17.16% | **95.93%** |
| 2 vs 3 | 17.15% | 23.94% |
| 1 vs 3 | **0.05%** | 95.87% |

Run 1 becomes a 96% outlier and the other pair is worse than baseline. Freezing
at "ready" stops the clock *before the world has settled*, so the first shot
photographs an unbuilt state. This is now a valid negative, measured under the
protocol — not a bimodal artefact. The rehabilitation in the previous section
was wrong; attempt 2 is dead on its own merits.

That is nine interventions, none of which improved on doing nothing.

### Recommendation: work around it, do not keep fixing it

The root cause is understood (LOD snap boundary, driven by sub-metre camera
differences) but every attempt to remove the *source* of those differences has
made the capture worse, because the state that varies is also the state the
world needs in order to settle correctly.

The pragmatic position, and the one I would take next:

1. **Adopt the modal protocol as the measurement standard.** Capture 3 runs,
   keep the two that agree (they agree to 0.05%, which is effectively exact),
   discard the odd one. This gives an exact reference image with no engine
   change at all, and it is the only thing here that has actually worked.
2. **Only trust deltas above ~17%** for any comparison not using that protocol.
   Several items in this document clear that easily — the horizon cross-hatch
   and the jacket colour were both visible, structural changes.
3. **If a real fix is wanted later**, the direction implied by the root cause is
   a fixed number of warm-up ticks after `reset()` and before the first shot, so
   every run reaches the same settled state — rather than freezing the clock,
   which prevents settling. Untested; measure with the modal protocol.

Exhausted, do not retry: seed pinning of any kind, frame-parity normalisation,
clearing fx accumulators, disabling post effects wholesale, and freezing the
clock at ready.

**Superseded — recommendation kept for the record:**

1. **Adopt the three-run protocol first.** Nothing else is measurable without
   it. Capture N=5 runs of one preset, hash each, and confirm the hashes fall
   into a small number of clusters rather than all differing.
2. **Diff the two modal images and look at *where* they differ.** 17% of pixels
   at mean 2.9 is a specific spatial signature. If it is confined to shadowed
   regions it is the shadow path; if it tracks edges it is a jitter/AA phase;
   if it is uniform it is exposure or grade. That picture names the subsystem
   directly and replaces this whole guessing sequence.
3. **Only then intervene**, and re-measure with the three-run protocol.

Exhausted, do not retry: seed pinning of any kind, frame-parity normalisation,
clearing fx accumulators, and disabling post effects wholesale.

## Severity 5

| # | Defect | Mechanism | Status |
|---|--------|-----------|--------|
| 1 | Modelled range brighter than its own sky — luma 186–200 vs 151 (tell #28, checklist 19) | `backdropModel.js` mixed haze toward a near-white in *display* space, then multiplied by the 1/exposure gain → ~(2.7,2.8,3.0) linear against a (0.55,0.66,0.82) fog colour. Compounded: the paler-than-sky clamp read `scene.fog.color` once at mount, but the main path nulls `scene.fog` | **fixed (unverified)** — gain now first, converges to live `SOHO_HORIZON`; range still reads slightly pale against its sky |
| 2 | Woven cross-hatch stripe across the full width of the horizon (checklist 20) | Dithered discard: screen-space interleaved-gradient noise on a jagged silhouette. No band width fixes it — the dither *is* the artefact | **fixed + verified** — mix reaches 1.0 so the discard is retired; stripe gone in re-shot `valley-vista` |
| 3 | No aerial perspective. Near/far 32px tile σ: hero-basin 0.66, chase-carve 1.66, valley-vista 1.91, west-spur 2.32 vs checklist 17's ≥4.0. `hero-basin` **inverted** — far ridge carries more local contrast than foreground | Blue-extinction gate is 0.00 at 400 m, 0.06 at 900 m; playable box is ±1010 m, so nothing in the bowl gets any depth cue. Also `visibility: 110000` (§5.3 derives 42000) and `haze: 2.6e-5` (doc: 8e-5) | **open** |
| 4 | Rider casts no shadow; board has no contact darkening (checklist 12, 13, 40) | `sky.js` fit floor of 280 m → 0.167 m texel → ~0.5 m depth bias along beam → **2.7 m lateral peter-pan** on a 1.8 m caster at 10.6° sun, plus normalBias pinned at its 0.28 ceiling | **fixed (unverified)** — floor to 90 m, both bias ceilings rescaled, 1/sinAlt floored |
| 5 | Rider is sitting in a chair — pelvis at deck height, thighs horizontal, torso reclined ~30° backward | Pelvis height: `absorb+tuck+compress+grab` sums to 0.72 against `standH` 0.735, and the guard trims `hx`, which only reaches pelvis height via sin(roll) — zero authority on a flat board. Recline: cause **unresolved** | **partially fixed** — pelvis floored. The backward recline persists and is the dominant half. The critique blamed `chest.rotation.x`'s `+A.absorb*0.16`; flipping that sign produced a pixel-identical frame, so `A.absorb` is ≈0 in these captures and that term is not the driver. Reverted rather than shipped unverified. Needs a pose probe that reports the live `A.*` values before the next attempt |
| 6 | Nothing in nine frames cuts the surface (checklist 44) | Three stacked: `VISUAL_SINK_CAP = 0.010` (1 cm vs 0.55 m powder); `trails.js` 2048/320 m = 6.4 texels/m so a 0.16 m halfWidth is a **two-texel** trench; `fast = smoothstep(2,14,speed)` = 0.16 at the captured 18 km/h | **2 of 3 fixed** — RES 4096 (12.8 texels/m, profile resolves) and the speed gate now saturates at carving speed; probed peak trench 235/255. `VISUAL_SINK_CAP` left alone: the deck is 13 mm thick, so sinking the board further needs the trench feeding back into the height it is drawn against, and that coupling does not exist yet |
| 7 | Spray is grey exhaust — darker than the snow it came from, hard rectangular banding, detached from the board, symmetric about the board axis (tell #47) | `col = mix(uSkyColor*1.15, lit, sunAmount)` puts the shadow term below snow value; puff sizes 16–42 cm vs §11's 2–8 cm exceed the `gl_PointSize` clamp → clipped squares; launch line is centred on the board, only velocity is one-sided | **open** |

## Severity 4

| # | Defect | Mechanism | Status |
|---|--------|-----------|--------|
| 8 | Caster-less dark smudges over the mid-field. hero-basin (830,370): fill ratio **0.19** (LAW 3 floor 0.22), B/R **1.79** (band 1.25–1.40) — under-filled *and* over-saturated | Coarse-LOD terrain self-shadowing inside the 280–520 m slice (`terrain.js:2444` `castShadow = li < SHADOW_LEVELS`) | partially addressed — the 90 m fit shrinks the slice; needs re-measure |
| 9 | Shadowed snow is grey. chase-carve trough B/R **1.034**, blue-survival 0.95 vs required [1.4, 2.1] — tell #1 verbatim | `snowMaterial.js:1042` `sunAway` zeroes past N·L = 0.125 and `sunOccl` needs a real shadow-map occlusion; rippled slopes facing the sun trigger neither gate | **open** |
| 10 | Rider is eight shades of one charcoal — ~10-level spread head to foot | `shell` and `shellGrey` shipped as **byte-identical hex** `0x2c2e33`, so the yoke/sleeve blocking was a no-op | **fixed + verified** — jacket now `#E8531F` per §6.3; orange torso reads against charcoal sleeves in `rider-portrait` |
| 11 | 1.2–7 km annulus is a dead white apron with no landform | `_farHeightRaw` leaves that band carrying only 40 m fBm and ridge chains start at 8.5 km; then the inversion-deck block force-fogs it flat | **open** |
| 12 | Camera pins the rider to dead frame centre, zero lead | `_computeDesired` puts look point and station on the *same* axis. `s.carving` is referenced **zero times** in `camera.js` — §8.3's 65/35 fall-line blend is unimplemented | **open** |
| 13 | Horizon is a ruler line; no foreground occlusion anywhere in nine frames (§9.6) | composition | **open** |
| 14 | `hero-basin` reads as a bedsheet over furniture; skyline one sagging curve, right third repeats a scalloped lump | band 1: `ridged2(...) * 24 * ridgeMask` — ±12 m at λ340 m is too small to build a ridge, right size to read as repeated bumps. Checklist 35 not legible in any frame | **open** |
| 15 | Rock props are detached floating slabs, sky visible under them — plainly visible on the tor in `rider-portrait` | `buildSlabStack` random-walks `ox` by ±0.20 cumulatively over 5 slabs against a 0.5 plan radius, then draws the underside | **open** |
| 16 | Base station is a 44 m slab floating 5 m above the snow with visible interior faces | `mountBaseStation` position `gy + 5.0`, `side = DoubleSide` | **fixed (unverified)** — buried to `gy - 3.0`, FrontSide |
| 17 | Air pose is a doll dropped off a table — mirrored arms, no grab, board intersecting both shins | `airTuck` feeds only `squat`; `_poseArms` collapses the fore/aft split to ±15° | **open** |
| 18 | Arms have no elbow — shoulder to fist is one straight tube | `_poseArms` writes only `ua.rotation.x/.z` and `fa.rotation.z`; no shoulder Y, no wrist | **open** |
| 19 | Board flat with zero edge in every grounded frame; incline is decorative | `A.incline` feeds only a 10 cm hip shift and `head.rotation.z*0.18`; real lean comes from `s.roll`, which is near zero in these captures | **open** |
| 20 | `ridge-backlight` is blue everywhere including its brightest snow — B/R **1.213** vs LAW 1's [0.99,1.06] | `shotExposure['ridge-backlight']: 4.70`, a 2.2-stop push lifting sky-fill-lit snow. Exposure doing the lighting's job | **open** |

## Severity 3 and below

- **Sunlit snow renders light grey, not white** — six of nine fail checklist 4's 0xDC floor (snow-detail `#C2C4CE`). `render.exposure: 0.34` + per-shot pushes.
- **Veiling glare effectively off** — net veil ≈ 0.009; §7.1 tier 2 is a whole-frame effect driven by the snowfield, not the sun disc (checklist 45, tell #39).
- **Wallpaper repeat in the far field** — valley-vista 8.8 px period, peak/median 8.7; `fadeMacro` keeps the macro band alive to ~650 m.
- **Nearest snow is the smoothest snow** — high-pass σ 2.70/2.93 in the bottom 20% vs 10.2/4.4 mid-field. LOD inverted.
- **Framing off-spec** — `followDistance 8.6 / followHeight 2.7` vs §8.1's 6.4/2.1; rider ~11% of frame height, nearest snow 8–9 m out, nothing sweeps the bottom edge (tell #53).
- **Steel edge sub-pixel** — `edgeBand = 0.005` is 0.35 px at 9 m.
- **Landing is a shake, not an impulse** — `_computeShake` at ~9 Hz vs §8.2's 2–5 Hz; §8.4 says explicitly "not a shake". The critically-damped 0.15–0.30 m dip does not exist.
- **Glints survive into the far field** — west-spur 1.08% of pixels, 2387 above the horizon midline; checklist 25 wants <0.5% and nothing past 40 m.
- **Snow/rock boundaries are triangular** — hard integer thresholds snap class boundaries to mesh triangles; no wind moat, drift lip or melt-out ring (checklist 31).

## What passes

No crushed blacks (darkest 1% ≥ 36 everywhere), no sky banding, no pure-white
clipping (max 0.03%), no lens-flare sprites, and near/far contrast ratio is
healthy in the wide framings (west-spur 10.0, air-trick 6.7, valley-vista 6.6).
One critic's summary: *the lighting structure is right; the calibration and the
shadow pipeline are not.*

## Note on the backdrop clamp

A critic observed that converging the matte to a single horizon colour is
itself the flat single-colour fade §5.2 warns about. The clamp is a ceiling and
should stay, but the *fade* wants depth variation rather than one colour —
worth addressing alongside item 3, since both are the same missing atmosphere.

---

# r18 round — outcomes, including where the critics were wrong

Three critics graded the r18 set (the first capture containing the mountain
range, and the restyled rider). Most findings were sound and are fixed. Three
were checked against measurement and did **not** survive, recorded here so
nobody "fixes" them later.

## Wrong: "carve trails are decal stripes"

The claim was that `slip` derives from a zeroed `lateralSpeed`, so a carve
gets `lip` at its 0.15 floor and `halfWidth` at its 0.16 m minimum.

Measured lateral speed through a real carve is 5.56–8.49 m/s, so
`slip = clamp01(|lat| / 6)` is 0.93–1.00. Substituting into the trail
formulas:

| lateral | slip | depth | lip | halfWidth |
|---|---|---|---|---|
| 5.56 | 0.93 | 0.82 | **1.00** | 0.436 m |
| 8.49 | 1.00 | 0.79 | **1.00** | 0.455 m |

`lip` is saturated at its maximum and width is near its maximum — the
opposite of the finding. If the trails still read as decals, the cause is in
how the trail texture is rendered, not in these parameters. Do not "restore"
a lip that is already at 1.0.

## Wrong: "hero-basin and west-spur show empty sky a wider backdrop would fill"

Both framings look UP-slope. The near rim is their horizon, and what fills
their upper third is terrain, not sky. Shot before and after ringing the
basin with three more copies of the massif: both frames unchanged. Getting a
massif into those views is a camera or landform problem.

## Overstated: "the flanking backdrop copies read paler"

That was mine, not a critic's. Measured left/centre/right at 164.2 / 163.6 /
163.2 — a spread of 0.7 levels, invisible, and inside the capture's own
noise.

## Right, and fixed

- Grey shelf under the range: the fade used world heights that predated a
  rescale, leaving two thirds of raw paint surviving. Band now derived from
  the mesh's own bounds at mount.
- Shadow chroma capped below the doc's own target by a 0.52 tint ceiling —
  arithmetically unreachable. Raised to 0.80.
- The chair-sit: an ABSENCE, not a stray rotation. The torso's only fold term
  is a function of board roll and therefore zero riding flat.
- See-through rider: jacket hem, pant legs, pelvis bridge and sleeve cuffs
  all built as open tubes.
- Hood sat behind the skull rather than over it.
- Sleeves reading as bare arms: two saturated colours in one hue family mush
  rather than block.

## Right, and still open

- `west-spur` navy patch (severity 4). **Still present, attribution UNPROVEN.**
  A hard-edged flat blue-grey plate mid-frame (rows ~330-420, cols ~180-780)
  with a regular horizontal dashed stipple.
  - The critic called it shadow-map acne on a coarse clipmap ring.
  - Hazard netting is ruled out: that prop is orange alpha-tested lattice,
    the patch is blue-grey.
  - Quartering `shadowMapSize` (4096 -> 1024) moved the patch region by 14.1%
    while the whole frame moved 12.8%, and the patch's mean RGB was unchanged
    (116,130,151 vs 117,130,151). Against a 17% capture noise floor that
    proves nothing either way.
  This one cannot be attributed by re-shooting and diffing, because the effect
  is smaller than the noise. It needs either a deterministic capture or
  geometric isolation — render the region with prop/terrain groups toggled
  through a path that yields valid images. Note that toggling visibility and
  calling `page.screenshot()` does NOT work: it returned an identical 0.1%
  diff for every object tried, including ones that certainly matter.
- Mannequin arms: no shoulder Y, no wrist, `sway` zeroed at riding speed (4).
- Nothing breaks the skyline (severity 3). The WANT is legitimate (§9.1), but
  the critic's mechanism is **wrong and must not be acted on as written**.
  It claimed rock classification is "zeroed past 2.4 km". The gate is
  `rb *= smoothstep(2400, 4800, r2)`, which is 0 BELOW 2400 and 1 above 4800
  — rock is zeroed *inside* 2.4 km, the opposite reading, and the comment
  beside it says so in as many words.
  Both distance gates are deliberate and were driven by this project's own
  playtest history:
  - inside 2.4 km, because the round-7 white-override probe proved this
    painter was striping the inner-valley steeps into the "tan pillars";
  - past 10 km, because schist-tinted crests half-dissolved in haze read as
    smoke plumes behind the ridge — the user called it a bushfire.
  Re-enabling rock to give props crest candidates would reintroduce both
  artefacts. If the skyline wants breaking, do it by scattering actual
  outcrop props on high-slope crest positions INDEPENDENT of surface class,
  not by widening the rock painter.

## r24 — backdrop "horizontal lines": diagnosed, NOT fixed

The thin dark dash the user photographed in the sky, left of the massif in
`valley-vista`, is **not** the backdrop GLB and not a leftover ring copy.

Raycast through the pixel (`tools/pick.mjs valley-vista 40,166`):

```
terrain-backdrop  dist 25527  y 2502
terrain-backdrop  dist 26554  y 2532
terrain-backdrop  dist 26604  y 2533
```

It is the procedural far ring at 26.5 km, three surfaces deep along the ray.
Measured against the sky beside it: 12–19 levels down in G and B.

Two hypotheses tested and **rejected**:

1. *"An unresolved facet — radial post spacing is 450 m out there, so a far
   ridge is one or two quads with a smoothed normal, and under a 10.6° sun one
   of them shades dark."* Blended the vertex height toward the mean of the four
   gradient taps (a free ±390 m low-pass) at 0.85 weight, which is full
   strength at that radius. The pixel moved **2 levels** — inside the ±4-level
   capture noise. A kernel that wide would erase a 450 m facet, so the feature
   is far larger than one: it is a real ridge whose top few pixels clear the
   horizon. Reverted; do not retry the low-pass.

2. *"Aerial perspective isn't reaching 26 km."* It is. `sohoAerialPerspective`
   uses exact exponential column integrals with no distance cap, and at 2500 m
   through thin high air, 26 km of genuine residual contrast is correct. Real
   ranges at that distance on a clear day are visible and darker than sky.

So the remaining complaint is presentational, not physical: a legitimate
distant ridge that clears the horizon by only a few pixels reads as a hard
isolated dash rather than as a mountain. Whatever fixes it has to act on the
SILHOUETTE — softening the top few pixels of the far ring, or lifting the ring
so ridges present a face rather than an edge — not on shading or on relief
amplitude, both of which have now been measured out.


## r27 — the spray system is not the problem; judging it from captures might be

`close-spray` renders with no plume — a handful of specks near the board. The
obvious reading is that the emitter is not firing. It is firing hard.

`tools/shot-state.mjs` samples the state at the moment the shot composes, by
calling `S.shot(name)` — the same entry point shoot.mjs uses — and reading the
physics state and the particle pool immediately after:

```
speed 18.69   roll -44.1   edgeLoad 1.0   sliding true
sprayIntensity        1.000        (saturated)
liveParticles          1945
  kind 0 (crystals)    1433
  kind 2 (puffs)        455
particlesOnScreen       445        (drawn positions, not spawn points)
puffsOnScreen           107        (these are 16-42 cm sprites)
medianParticleDist      5.6 m
meanAlphaOnScreen       0.699
buriedUnderSnow          56        (13%)
```

Four hypotheses tested and rejected, in order:

1. *Emitter never fires.* No — `sprayIntensity` is saturated at 1.0.
2. *Particles are off-screen.* No — 445 on screen. The first pass of this
   probe projected SPAWN points and got 473; the shader integrates ballistics
   with linear drag over age, so the drawn position is the one that matters.
   Projecting it properly barely moved the number.
3. *Alpha has faded them out.* No — evaluating the vertex shader's own
   `fadeIn * fadeOut²` on the CPU gives a mean of 0.699 across the on-screen
   set.
4. *They spawn at the sunk contact point and the snow mesh occludes them.*
   Only 13% are below terrain height.

So ~389 visible-by-every-CPU-measure sprites, 107 of them large, sit in frame
at 0.7 alpha, and the PNG shows almost none. The remaining candidate is the
harness: the captured frame does not correspond to the state `S.shot()` leaves
behind. That is consistent with the already-documented finding that
`page.screenshot()` after `shot()` returns a stale frame.

**CORRECTION (r28). The conclusion above is wrong.** The harness was not the
problem and the captures do contain the particles.

`tools/spray-visible.mjs` settles it without `page.screenshot()`: it renders
the shot, reads the canvas back inside the page in the same task as the draw,
hides `fx.dynamic.points`, renders and reads again, and diffs — with hiding the
RIDER as a control, so a readback that cannot see anything is distinguishable
from particles that are not there.

```
removing spray            12.4% of pixels changed, mean delta 22.7
removing rider (control)  10.3% of pixels changed, mean delta 18.0
```

Removing the spray changes MORE of the frame than removing the whole rider. It
was always rendering, and an amplified difference image shows a large,
correctly-shaped plume trailing off the edge.

The real fault was value, not presence. Over the plume region:

```
mean luma with spray     187.4
mean luma without spray  199.8      -> the spray was 12.3 levels DARKER
```

Snow thrown off an edge that *darkens* the snow behind it reads as a grey
veil, which is why a plume covering 12–13% of the frame was mistaken for "no
spray at all". Cause: the big area-covering puffs were authored at brightness
0.72–0.92 while the individual crystals they represent are 0.9–1.35, and with
the sun off-axis `sunAmount` falls to ~0.35 so the colour is dominated by
`uSkyColor * 1.15` — ambient sky, well under sunlit snow. Puffs moved to
1.02–1.24; the plume region now sits at −0.2 levels against the no-spray
frame instead of −12.3, and it reads as thrown snow.

Lesson worth keeping: "the effect is missing" and "the effect has no contrast
against its background" look identical in a screenshot and are diagnosed
completely differently. Diff against the effect disabled before concluding
anything is absent.


## r32 — the "hole in the jacket" is the sleeve

Cropped large, the top of the torso in `rider-portrait` shows a dark oval with
a lit rim and a bright sliver across it — the classic look of an open garment
tube you are seeing down inside. The jacket collar ring is r 0.17 against a
neck cylinder of r 0.06, so there is a wide annulus a cap has to close, which
made the reading plausible.

It is wrong. `tools/who-owns.mjs` hides each rider mesh in turn and re-renders,
identifying the owner of a screen rectangle by its absence:

```
sleeveL      skinned  92.5% of rect  mean delta 140.3
jacketBody   skinned  75.8%          mean delta  71.1
<everything else>     ~19%           mean delta   8.3   <- noise floor
```

The dark oval is the near sleeve crossing the chest in shadow; the "rim" is the
lit jacket shoulder behind it. A hole would have been owned by whatever lay
behind it, not by a garment drawn in front. No cap is missing and nothing was
changed.

Two things this probe needs, both learned the hard way:

- **Render with `tick(0)`.** Every `tick(1/60)` advances the simulation, so
  across ~30 meshes the rider drifts and motion swamps the signal: the first
  run reported *every* mesh at 100% of the rect changed, at saturation.
- **Expect a ~19% noise floor.** The frame counter advances even at dt 0, so
  the grain changes on every re-render. Anything at 19% / mean 8.3 is nothing;
  the signal here was 4–17× the floor.

Third time in this session that a confident read of a still turned out to be
something else (the backdrop sliver, the missing spray, this). The still says
what a thing looks like; only removing an object says what it is.

## r34 — "no snow on the rock ledges": wrong, and a lesson about two code paths

Rendered large in `air-trick`, the near tors look like bare rock standing in a
midwinter snowfield with nothing on their up-facing ledges. Chasing it, I found
this in snowMaterial.js and did the arithmetic:

```
accum = saturate( ... + ( sohoWN.y - 0.55 ) * 0.70 * uSnowOnRock )   // line 1188
snowAmt = smoothstep( 0.18, 0.78, accum )
```

`uSnowOnRock` scales only that term, which maxes at 0.315 even at 1.0, so at
the shipped 0.64 a dead-flat ledge reaches accum 0.202 and snowAmt 0.004 — no
snow. It also appeared to contradict the call-site comment in props.js, which
claims a flat ledge reaches "accum ≈ 0.61 → 85% snow".

**Both conclusions were wrong.** There are TWO accumulation blocks in that
file. Props use the one at line 1611:

```
float ledge = saturate( ( nW.y - 0.28 ) * 1.30 );
accum = saturate( ledge*1.05 + cavity*0.35 + driftBias + surface*0.55 - 0.16 ) * uSnowOnRock;
snowAmt = smoothstep( 0.24, 0.72, accum );
```

which is exactly the formula the comment describes. A flat ledge gives
ledge 0.936, accum ≈ 0.64, snowAmt ≈ 0.87. Prop ledges load snow correctly and
the comment was accurate all along; line 1188 is a different surface class.

Confirmed by measurement rather than by re-reading: with the line-1188 term
steepened, the near slab in `rider-portrait` measured **118.9 mean / 46.0 sd
both before and after** — bit-identical, because the prop never used that path.
Reverted.

Two things worth keeping:

- Before editing a shared shader, confirm WHICH block the surface in question
  actually executes. Grepping a uniform name found three hits and I reasoned
  about the first one.
- `air-trick` and `west-spur` re-frame between runs, so they cannot carry an
  A/B. `rider-portrait` holds its framing and is the shot to use for one.

---

## R15 — the radiance-level bug, and why hue edits could not fix it

Two materials in this codebase are raw `ShaderMaterial`s that write **linear
radiance straight into the HDR target the post chain tonemaps**: the board
spray (`src/fx/particles.js`) and, once it existed, the snow-gun plume
(`src/fx/snowplume.js`). Both were writing a value around **1.0**.

Sunlit snow in this scene sits near **5.0**:

| quantity | value |
|---|---|
| `sun.intensity` (DirectionalLight) | 30.2 |
| `sun.color` | 0.81, 0.78, 0.76 |
| ambient `snow-bounce` | 0.06, 0.07, 0.11 at intensity 1 |
| snow radiance ≈ albedo/π × I × N·L | ≈ 0.9/π × 30.2 × 0.8 × 0.7 ≈ **4.8** |

So both effects were **darker than the snow they are made of**, and darker
than the sky behind them. Composited over a bright background at partial
alpha, a below-background colour reads as a *veil*, and the tonemapper turns a
dim blue veil into grey-brown. The plume looked like diesel exhaust; the spray
looked like a grey smudge that pulled the frame down.

The root cause is that **`uSunColor` is a normalised colour** — the intensity
lives on the light, not in the colour. Any shader that lights itself from
`sky.sunColor` alone is writing at roughly 1/5 scale.

Both now multiply by `sky.sun.intensity * 0.16`, which lands them on sunlit
snow and makes them track the sun through the day.

### Why this took so long to find

Three consecutive edits to the plume's **hue** — rebalancing sky against sun,
lifting the non-forward term, re-weighting the ambient — produced *no visible
change at all*. That should have been the tell after the first one: when an
edit that should obviously change the picture does not, the variable being
edited is not the one that is wrong.

### The diagnostic that settled it in one shot

Forcing `gl_FragColor = vec4(0.0, 1.0, 0.0, a)` rendered **pure green**.

That single frame killed an entire class of hypotheses — "the postprocess is
eating it", "the shader is not the one being compiled", "something downstream
overrides the colour", "it is being drawn into the wrong buffer" — and proved
the colour being written really was that dull. Substituting a known, garish
constant for a computed value is the cheapest possible test of "is my output
reaching the frame, and is it what I think it is".

### Sweep

`grep -rn "gl_FragColor = " src/` finds only these two plus `sky.js` and the
postprocess passes. `sky.js`'s cloud shader already reasons in these units —
its own comment compares a forward lobe against "forty times above sunlit
snow" — and needs nothing. The postprocess passes operate on already-rendered
buffers. So the sweep is complete: those were the only two.

Note also that three.js forces `NoToneMapping` when rendering to a render
target, so the scene pass is untonemapped and `<tonemapping_fragment>` inside
`sky.js` is a no-op there. Writing raw linear was the right *kind* of output
in both files; only the *level* was wrong.

### Prior finding this supersedes

The spray was measured earlier as pulling its region of the frame down by
**12.3 levels** (mean luma 187.4 with spray against 199.8 without). That was
diagnosed as puff sprites authored darker than the crystals they are made of
and patched by lifting a brightness constant from 0.72 to 1.02. The constant
was a real second defect and the fix stands, but it was a band-aid: the
dominant term was a radiance level five times too low.

---

## R16 — checklist 3 (black undersides): measured, and it passes

`tools/rider-fill.mjs` isolates the rider's own pixels and reports their luma
distribution as a fraction of sunlit snow.

| | rider-portrait | air-trick |
|---|---|---|
| rider pixels | 61 857 | 9 262 |
| median, as fraction of sunlit snow | 0.325 | 0.266 |
| p25 | 0.239 | 0.158 |
| under 10% of sunlit | **0.8%** | **6.9%** |
| under 20% of sunlit | 14.8% | 38.6% |

Essentially none of the figure is black. Checklist 3 passes; no change made.

### The probe needed fixing before its answer was worth anything

The first version isolated the rider by hiding it and diffing, which also
removes its **cast shadow** — so 39 859 pixels of shadowed snow were being
labelled "rider", 39% of the set. Shadowed snow sits squarely inside LAW 3's
0.22–0.56 band, so that contamination would have produced a pass no matter how
black the figure was. It flattered the median by 0.04.

The fix is a third frame with the rider visible but `castShadow` off on every
mesh: pixels that change between *that* and the normal frame are shadow, and
the figure itself is identical across the pair.

### A 5× error I nearly shipped as a global lighting change

Chasing why `air-trick` measured darker, I found `sky.groundColor` — the
PMREM's lower hemisphere, commented "snowfield bounce radiance (linear)" —
sitting at (0.74, 0.94, 1.44) while I calculated sunlit snow emitting ~4.85.
Five times too dark, blue-shifted, and the same *shape* of bug as the plume
and the spray. It would have explained the symptom exactly.

It is wrong. I computed snow radiance as `albedo/π × I × N·L` with N·L = 0.75.
**This scene's sun is at 10.6° elevation**, so a horizontal snowfield receives
`sunMu = sin(10.6°) = 0.184` of the beam, not 0.75. Redone:

    irradiance = 30.21 × 0.806 × 0.184 = 4.48
    radiance   = 0.86 × 4.48 / π       = 1.23

against `groundColor`'s ~1.04 mean — the right order, with the remainder
explained by `GROUND_LIT_FRACTION` (only part of the visible snowfield is in
direct sun). `sky.js` derives it as `albedo × (direct + skyLit) / π`, which is
the Lambertian relation, correctly. The blue shift is the documented
`(1 − lit)·albedo` second-bounce term, and it is what makes LAW 2 reachable.

Two lessons, both about the same reflex:

- Finding one instance of a bug class makes the next thing that *looks* like it
  much more convincing than the evidence warrants. Two real radiance bugs had
  just been fixed, and that made a third feel almost pre-confirmed.
- The grazing sun is the premise of this whole art direction. Any calculation
  about this scene that quietly assumes an overhead cosine is wrong before it
  starts.

### On applying LAW 3 to the rider

`air-trick`'s p25 of 0.158 is below LAW 3's 0.22 floor, but LAW 3 is about
**shadowed snow**, not about a figure whose garments have albedos of 0.03–0.2.
A plum jacket in full sun reads far below snow at 0.86. Comparing them is a
category error; the part of checklist 3 that does apply — is the figure black —
is answered by the two rows above.

---

## R17 — snow detail falloff: the premise was wrong about the geometry

`chase-carve` is the view a player spends the run looking at, and it reads as
a field of wind-scour streaks at one density from the board to the horizon —
which would be checklist 16, "detail that does not fade with distance".

`tools/detail-falloff.mjs` bands the frame, measures local RMS contrast in
each, and ray-marches the heightfield to put a distance on it:

| band | ground | local RMS |
|---|---|---|
| 8 (bottom) | 5 m | 8.76 |
| 7 | 6 m | 10.43 |
| 6 | 7 m | 14.62 |
| 5 | 13 m | 14.36 |
| 4 | 22 m | 14.26 |
| 3 | beyond the heightfield | 10.32 |
| 0–2 | sky | ~1.8 |

**The visible heightfield in that shot spans 5 m to 22 m.** What looked like
the horizon is twenty metres away. Detail is not supposed to fade appreciably
over a 4× distance change that close, so a flat profile across bands 4–6 is
correct, not a tell. The dip to 8.76 in the nearest band is motion blur, which
§7 asks for. No change made.

The first version of this probe reported bands in PIXELS while asserting in
its own docstring that screen height is a proxy for distance. That makes any
claim about detail-per-metre unfalsifiable — the whole question is the rate of
decay with distance, and pixels are not distance. The tool only became an
argument once it marched the terrain.

**Known limit:** bands past ~22 m report "sky" because `terrain.sample`
returns nothing beyond the heightfield's bounds; that ground is the backdrop
ranges, a separate asset. So this cannot yet speak to checklist 16 over
22 m – 800 m, which is where the tell actually bites. Anyone picking this up
should extend the march to the backdrop before drawing conclusions about it.

---

## R18 — detail falloff, now measurable to 9 km, and no tell found

`tools/detail-falloff.mjs` was blind past 22 m (R17). Two fixes made it
useful, and both were found by making it say what it was actually looking at
rather than trusting it.

**Raycast the scene, not the heightfield.** `terrain.sample` returns nothing
beyond the heightfield bounds, so everything further was invisible. A
Raycaster covers heightfield, backdrop and props uniformly — but the first hit
on every band came back as `Points`: the ambient snowfall pool, drifting a
metre in front of the lens. Filtering by NAME could not fix that reliably.
Requiring `isMesh` could, because it is a property of what the object *is*
rather than of what someone remembered to name it. The near bands had also
been reporting 1 m, which was the rider's own back — this is a chase camera.

**Measure two scales, because one is not interpretable.** At a single small
window, contrast RISES with distance in both wide shots — 5.15 at 221 m to
9.07 at 669 m in `hero-basin`. That looks exactly like checklist 16 failing.
It is not: those bands are full of ridgelines, shadowed gullies and the lift
line, which are large-scale structure and entirely desirable. Fine texture
contributes to a small window and not much to a large one, so the ratio
separates them.

`hero-basin`, fine (8 px) over wide (32 px):

| ground | rms8 | rms32 | fine/wide |
|---|---|---|---|
| 221 m | 5.15 | 9.10 | **0.566** |
| 268 m | 5.11 | 11.11 | 0.460 |
| 377 m | 7.50 | 19.24 | 0.390 |
| 669 m | 9.07 | 21.72 | 0.417 |
| 1065 m | 4.77 | 11.61 | 0.411 |

The ratio declines with distance, which is the direction checklist 16 asks
for. The apparent rise in raw contrast is `rms32` climbing 9.1 → 21.7 — pure
silhouette structure. **No tell. No change made.**

`valley-vista` is flat near (0.46 out to 258 m), rises at 765 m, and on the
backdrop ranges at 6.8–8.9 km reads 0.48–0.64 — higher than the terrain at
2 km. That would be checklist 31, "distant mountains with the same texture
frequency as near". It is NOT being acted on: `rms8` in those bands is 2.0–3.5
levels, which is at the frame's dither floor, and a ratio computed on that is
not evidence. Anyone wanting to pursue it should first establish the noise
floor on a flat-field render.

Third consecutive investigation ending in "measured, nothing to fix" — after
checklist 3 and the `groundColor` 5×. Taken together that says the near and
mid field are in good order, and the genuinely unexamined territory is the
backdrop's own detail budget, at contrast levels that need a noise floor
established before they mean anything.

---

## R19 — the noise floor, and a real checklist-31 lead on the backdrop

R18 declined to act on the backdrop's fine-detail numbers because they sat
near the dither floor and no floor had been established. This establishes it.

Film grain in this pipeline doubles as the 8-bit dither, so it is a floor
under every `rms8` reading. Turning it off, `valley-vista`:

| band | ground | rms8 grain ON | rms8 grain OFF |
|---|---|---|---|
| 0 | sky | 1.80 | **0.67** ← the floor |
| 1 | 8884 m | 2.04 | 1.21 |
| 2 | 6800 m | 3.48 | **2.95** |
| 3 | 2057 m | 2.26 | 1.76 |
| 4 | 1494 m | 3.60 | 3.02 |
| 6 | 258 m | 11.20 | 10.82 |
| 8 | 106 m | 8.74 | 8.42 |

**The floor is 0.67.** Against it, the backdrop ranges at 6800 m carry
`rms8` 2.95 — 4.4× the floor, as much fine detail as the heightfield at
1494 m (3.02) and MORE than the heightfield at 2057 m (1.76).

That is checklist 31, "distant mountains with the same contrast and texture
frequency as near", and it points at the aerial in-scatter not flattening the
backdrop enough (checklist 27/28). **Recorded as a lead, not acted on** — it
is a global change to the world's look, and this session has already produced
one 5× error that would have shipped as exactly that kind of change. It wants
its own round with before/after frames.

### Two failed switches before the measurement was real

The `--no-grain` flag did nothing, twice, and both times the two runs came
back identical to 0.02 — which reads as "grain is free" and is really "the
switch missed".

1. It set `ctx.fx.uniforms.uGrain`. `ctx.fx` is the PARTICLE system; the
   grain uniform lives on `ctx.composer.passes[15]`. Found by walking ctx for
   any object carrying a `uGrain`, rather than by guessing again.
2. Setting that pass's uniform directly *also* did nothing, because the
   postprocess update re-derives it from config on every tick and the render
   that matters happens after. Setting `config.post.grain.enabled = false`
   works.

Failure 2 is the same shape as the `playtest.mjs` bug from earlier in this
project, where the probe wrote `ctx.input.state` and `Input.update()`
overwrote it before physics ran. **Writing a value that the owning system
re-derives every frame is a recurring way to measure nothing and believe it.**
When a switch produces no change, suspect the switch before the conclusion.

---

## R20 — the backdrop lead is dead: a band is not an object

R19 raised a checklist-31 lead — the backdrop appearing to carry as much fine
detail at 6800 m as the heightfield does at 1494 m — and deliberately did not
act on it. Acting would have been wrong.

`tools/backdrop-detail.mjs` isolates each asset by removal (hide, diff, keep
the pixels that changed) instead of trusting a horizontal band, and measures
RMS only over windows lying FULLY inside the mask, so a window straddling the
silhouette cannot contribute the edge itself as if it were surface texture.

`valley-vista`, grain off, against the 0.67 floor:

| | share of frame | rms8 | rms32 | fine/wide |
|---|---|---|---|---|
| backdrop ranges | 16.9% | **1.73** | 3.67 | 0.471 |
| heightfield | 66.5% | **7.28** | 16.42 | 0.443 |

The backdrop carries **4.2× less** fine detail than the near terrain — 2.6× the
noise floor against the terrain's 10.9×. Checklist 31 does not fail. No change.

The band reading of 2.95 came from a stripe that contained near ridge as well
as backdrop. **Attributing a whole band to whatever its centre ray happened to
hit is the error**, and it is the same error in a new costume: R17 measured a
region assumed to be distant terrain that was 22 m away, R18 measured
silhouette structure as though it were texture, and R19 measured a band as
though it were an asset. Per-object isolation by removal is the only version
of this that has held up.

Worth noting what the deferral bought: the change this lead implied was a
low-pass on the backdrop, which would have blunted the one asset whose whole
job is to look majestic, in service of a defect that does not exist.

### Where the measurable checklist now stands

Four consecutive investigations have ended in "measured, nothing to fix":
checklist 3 (rider undersides), the `groundColor` 5×, checklist 16 (detail
falloff), and now checklist 31 (backdrop texture frequency). Every checklist
item reachable with the instruments now in `tools/` is passing. Anything
further wants either a new class of instrument or a human eye on the frames.

---

## R21 — does it actually RUN? A class of check never made

Every instrument here drives the engine through `S.shot()` and `engine.tick()`
with `manualTime` on — a mode no player is ever in. Nothing had checked what a
player does: load the page, let requestAnimationFrame drive it, hold the keys
down. `tools/playability.mjs` does that, through the real keyboard rather than
by writing to physics, so the input path is part of what is under test.

**Result, 45 s of held input:**

- `errorCount` **0** — no pageerrors, no console errors on the rAF path
- `nonFiniteCount` **0** — no NaN anywhere in physics state or in any rig bone
- input path works: speed reaches 6.97 from real key events
- growth is **flat**

| t (s) | frame | objects | geometries | textures | heap MB |
|---|---|---|---|---|---|
| 0.4 | 7 | 199 | 134 | 43 | 103.6 |
| 5.8 | 14 | 208 | 137 | 46 | 167.5 |
| 15.8 | 17 | 208 | 137 | 46 | 125.3 |
| 25.8 | 26 | 208 | 137 | 46 | 125.8 |
| 45.1 | 35 | 208 | 137 | 46 | 126.2 |

All growth is one-time lazy initialisation, complete by frame 14; nothing
accumulates across the following 21 frames and 39 seconds. The heap spike at
5.8–10.4 s and its fall to 125 is GC, not a trend.

**Two samples could not have shown this.** Endpoints alone say "it went up",
which is what lazy init and a leak both look like. The series distinguishes
them: lazy init is asymptotic, a leak is linear in frames.

### The honest limit

35 frames is 0.6 simulated seconds. This rules out a fast leak and an
immediate crash; it does **not** rule out a slow leak over minutes of play.

And the obvious way to buy more frames does not work: dropping the viewport
from 1280×720 to 400×225 — a tenth of the pixels — went from 22 frames to 35,
not to hundreds. Frame cost in this harness is close to resolution-independent,
so it is not rasterisation. Anyone wanting a long-run leak test needs to find
the actual cost (fixed-size post buffers, shadow passes, scene traversal) or
run headless without rendering at all.

---

## R22 — where the frame goes, and why performance cannot be answered here

R21 left one unexplained fact: dropping the viewport to a tenth of the pixels
barely changed the frame count. `tools/playability.mjs` now wraps every
system's `update`/`fixedUpdate` and the composer's `render` in a timer — the
per-system share its docstring had promised and never measured.

| what | calls | ms/call | % of profiled |
|---|---|---|---|
| **composer.render** | 27 | 347.04 | **98.9** |
| update:Terrain | 27 | 2.62 | 0.7 |
| update:PostProcessing | 27 | 0.27 | 0.1 |
| everything else (physics, rider, sky, props, trails, input, tricks, camera, fx) | | ≤0.17 | ~0.2 |

**JS-side game logic is about 1% of the frame.** That is the one number here
that transfers to real hardware, and it is a good one.

### Three hypotheses, all wrong

Frame cost is resolution-light, so something fixed dominates. Each candidate
was tested by changing it and counting completed frames:

| condition | fps |
|---|---|
| as shipped (4096² shadow) | 0.80 |
| shadow map 1024² — 16× fewer texels | 0.76 |
| terrain + backdrop hidden | 0.76 |

None of them moves it. The shadow map is not the cost; the terrain and
backdrop geometry are not the cost.

### A measurement that could not have worked

The first shadow A/B used `engine.tick()` under `manualTime` and timed it with
`performance.now()`. It reported 5.7 ms/frame at 4096² and 6.7 ms at 1024² —
the *smaller* map slower, and both fifty times faster than the 347 ms the rAF
profile showed for the same work.

`tick()` returns once GPU work is **submitted**. WebGL is asynchronous, so
that timer never saw the rendering at all; it measured command submission.
Only under rAF, where the browser blocks on presentation, does elapsed time
include the GPU. Both A/Bs above were re-run that way before being believed.

### The honest conclusion: this question is out of reach from here

SwiftShader is a software rasteriser. Its bottleneck is not a GPU's
bottleneck, and the fact that no lever moves it says the cost is SwiftShader's
own fixed overhead rather than anything about this game. **0.8 fps here means
nothing about real hardware and must not be quoted as if it did.**

What can be stated:

- JS game logic ≈ 1% of frame time — transferable, and healthy
- 1.4 M triangles and 210 draw calls per frame — modest for real hardware
- the post chain's targets scale correctly with the canvas (400×225 canvas →
  400×225 scene target, bloom pyramid 200×112 down to 12×7)
- a 4096² shadow map for one directional light — an ordinary choice, and
  measurably not a bottleneck even here

Anyone who needs a real performance answer has to run it on a real GPU. No
further tuning should be attempted from this container.

---

## R23 — which shots can carry an A/B, and which cannot

Two claims about harness noise have been carried in this project, and both
were wrong. This settles it with a direct experiment: shoot the same set
twice, in separate processes, and diff.

**Run-to-run difference, identical build, identical shot sequence:**

| shot | mean levels | % of pixels > 4 | max |
|---|---|---|---|
| valley-vista | **0.0000** | **0.000%** | 0 |
| west-spur | **0.0000** | **0.000%** | 0 |
| hero-basin | 1.7482 | 5.824% | 131 |
| chase-carve | 1.6543 | 4.425% | 175 |
| close-spray | 2.1641 | 6.295% | 161 |
| air-trick | 1.6408 | 4.617% | 102 |
| rider-portrait | 2.0887 | 6.415% | 173 |

Determinism is **per-shot**, and it reproduces: the `valley-vista,west-spur`
pair came back bit-exact on two independent attempts. The split tracks
whether the rider and its simulation are in frame — the two bit-exact shots
are pure free-camera landscape views.

### Both prior claims corrected

- The long-standing note that "~17% of pixels differ >4 levels between runs,
  ~19% noise floor even at tick(0)" is **too high and not universal**. It was
  measured inside a single page across repeated mutate-and-tick cycles, which
  is a different thing from two independent runs, and it was then applied to
  everything.
- Last turn I said "these shots are deterministic" on the strength of one
  matching pair. That is true of `valley-vista` and `west-spur` and false of
  every rider shot.

### What this changes

**A quantitative A/B belongs on `valley-vista` or `west-spur`**, where the
floor is zero and a 0.18% difference is unambiguous signal. On a rider shot
the floor is 4–6% of pixels over 4 levels, so any effect smaller than that is
invisible no matter how carefully it is measured — and several earlier
"inconclusive" readings on rider shots were probably below that floor rather
than absent.

It also strengthens the meshopt result in the previous commit rather than
weakening it: that comparison happened to use the two bit-exact shots, so the
1683 differing pixels on `valley-vista` were real signal against a true zero
floor.

---

## R24 — the rider-shot noise floor located, and removed

R23 established that rider shots differ 4–6% run to run while landscape shots
are bit-exact, and left it there. `shoot.mjs`'s own docstring promises output
"reproducible frame-for-frame", so this was a defect against its contract.
Found by splitting the pipeline and testing each layer.

| layer tested | result |
|---|---|
| simulation state — position, speed, heading, bone rotations, `ctx.frame` | **bit-identical** (frames 68 / 372 / 616 both runs) |
| capture method — in-page readback vs `page.screenshot` | **identical within a run**, and both differ identically across runs |
| render-side scalars — sun dir/colour/intensity, ambient, `groundColor`, env map present, prop time, wind gust, fx time, live particle count (307), camera position and quaternion | **bit-identical** |
| **transparent particle pools hidden** | **0.000%** — was 6.735% |

So every CPU-side input matches and the output still differs: the variance is
below the JS layer, in how the software rasteriser blends the transparent
`Points` pools. It is not fixable from here — but it is entirely avoidable.

`--no-particles` on `shoot.mjs` hides both pools before each shot. Verified
across separate processes: `rider-portrait` and `close-spray` both go to
**mean 0.0000, 0.000% of pixels** — from 6.735%.

### What this recovers

R23 concluded that on a rider shot "anything below 4–6% of pixels is invisible
however carefully it is measured", and that several earlier inconclusive
readings were probably below that floor rather than absent. **That limitation
is now lifted for any measurement that does not need the spray in frame.** A
rider A/B run with `--no-particles` has a true zero floor, which is the same
sensitivity the landscape shots always had.

Leave the flag off when the picture itself is the point: the spray is half of
what `close-spray` exists to show.

### Method note

Four hypotheses died here in order — capture timing, grain seeding (it is
keyed on `ctx.frame`, which matched), simulation drift, and render-side state
drift. Each was killed by measuring the layer rather than reasoning about it,
and the one that survived was the one nobody had suspected. Splitting a
pipeline and testing each stage separately is slower than guessing and it is
the only thing that has reliably worked in this project.

---

## R25 — an exact regression check, built on R24's determinism

R24 made rider shots byte-identical across processes. That turns a question
that used to need judgement — "did my rider tweak also move the terrain, the
sky, or a prop?" — into an exact one, so `tools/regress.mjs` asks it.

    node tools/regress.mjs            # compare against the manifest
    node tools/regress.mjs --update   # accept current output as the baseline

It shoots eight presets with `--no-particles` and compares a SHA-256 per shot
against `docs/regression-manifest.json`. The manifest stores hashes, not
images: storing PNGs would put megabytes into git on every baseline update,
in a project that has just spent a round taking 41 MB back out of the build.
A hash answers "did it change"; when the answer is yes, the fresh frames are
on disk to look at.

### Validated in both directions

> **Corrected in R27 — read that section before trusting this one.** The
> validation below is real but its scope was overstated: determinism holds for
> a given shot list *within one container session*, not across sessions, and
> not across different shot lists. A manifest committed to git will not match
> a later session.

A regression check that only ever says "unchanged" is worse than none, so both
halves were tested rather than assumed.

- **No false positives.** Two consecutive runs with no source change: all 8
  unchanged, exit 0.
- **True positive, correctly scoped.** One rider colour changed
  (`glove: 0x141416` → `0x8a1416`) and re-run:

      unchanged (5): hero-basin, ridge-backlight, snow-detail, valley-vista, west-spur
      CHANGED   (3): air-trick, chase-carve, rider-portrait

  Exactly the three shots with the rider prominent, and not one landscape
  shot. Then reverted, re-run, all 8 unchanged again — so the revert is clean
  and the manifest still valid.

### The limitation this inherits

Particles are off for every shot, because they are the one thing that is not
reproducible across processes (R24). It follows that **this cannot catch a
regression whose only effect is on the spray** — `close-spray` still has to be
looked at by eye. That is a real hole, and it is the direct cost of the trick
that makes the rest of it exact.

---

## R26 — The glove: four rounds of fixing the wrong object

The user's standing note on the rider is "clothing is better, arms are rigid
and head is weird". The turnaround card said the same thing more precisely:
the sleeves ran at one diameter from shoulder to wrist and ended in a dark
socket with a small dark lump inside it. Three previous rounds had all read
that socket as a **cuff** problem and adjusted cuff radii — out, in, out,
narrower, "close onto the wrist bridge". The comments in `rider.js` record
each of those as a fix. None of them worked, and the reason is worth keeping.

### What the tint test showed

Rather than reason about radii again, all three glove pieces were given flat
`MeshBasicMaterial` colours and the turnaround re-shot. That took about a
minute and ended the argument:

- **green** (gauntlet) and **yellow** (mitt) were almost entirely *inside* the
  sleeve. Only a crescent of each was ever on screen.
- the dark region everyone had been calling "a hole" was **the sleeve's own
  surface**, not the glove and not a gap.

So every previous round had been adjusting the object that was not visible,
to fix an artifact owned by the object that was.

### Two real causes, both structural

**1. The sleeve did not taper.** It ran 0.092 below the elbow to 0.086 at the
wrist — a 172 mm wrist against a 188 mm bicep, ratio 0.92, where a real arm is
about 0.70 even inside a padded shell. That is exactly what "the arms are
rigid" describes: a limb whose diameter never changes reads as unarticulated
however the bones move. It also made the glove problem *unsolvable* — a gloved
hand is about 110 mm across and simply cannot emerge from a 172 mm sleeve, so
no cuff geometry could ever have worked.

**2. `capEnd` produces a dish, not a dome.** In `tube()` the end cap sweeps in
**+Y** (`p.y + lift`, and `rr` shrinks to the axis). For the jacket hem, whose
stations run downward and whose cap should curl up inside the garment, that is
correct — and that is the case it was written for. A sleeve's stations also run
downward, so its cap curls *back up into the sleeve*: the tube finishes with a
concave dish sunk into its own end. Seen from below — most of a snowboarder's
screen time — that dish is a dark cup. It is the "hole".

### The fix

- Forearm tapers 0.086 → 0.072 → 0.070, wrist/bicep ratio 0.75.
- The sleeve **shuts 55 mm clear of the wrist**, so its dish is nowhere near
  where a hand goes.
- A 120 mm gauntlet on the **forearm** bone covers the whole termination,
  dish included. On the forearm and not the hand deliberately: the wrist swings
  up to ~25° off the forearm, which over a long cone walks the mouth about
  10 mm sideways and would uncover the sleeve rim on one side. A real gauntlet
  sits on the forearm too; the hand flexes inside it.
- Mitt enlarged to 0.059 × 0.076 × 0.071 so it is *wider* than the sleeve end,
  which is what makes a hand read as a hand rather than a stub.

### The method note

Tinting is cheaper than reasoning and it is not close. Four rounds of careful
argument about cuff radii produced four wrong answers; one flat-colour render
produced the right one in a single pass. This is the same lesson as the
removal-based isolation in `who-owns.mjs` and `backdrop-detail.mjs` — when a
question is "which object am I actually looking at", make the object identify
itself instead of inferring it from what the picture ought to contain.

One caveat recorded honestly: cells 3 and 4 of the turnaround still show a
stubby foreshortened arm, because in those poses the forearm points near the
lens. That is projection, not geometry — it was present before this change and
is not something arm profiling can remove.


---

## R27 — What `regress.mjs` determinism actually means

R25 claimed `shoot.mjs --no-particles` "renders byte-identically across
separate processes" and that the manifest could therefore scope a change
exactly. Using it on the R26 rider work produced a result that could not be
right: **all 8 shots changed**, including pure landscape frames — where the
earlier glove-colour A/B had moved only 3.

The control settles it. On **clean HEAD, with the working tree stashed and
zero source changes**, all 8 shots still differed from the committed manifest.
So the manifest was not measuring my edit at all.

### Three runs, three answers, and what separates them

| run | shot list | `valley-vista` |
|---|---|---|
| committed manifest | 8 shots | `8e2fda497accdc8e` |
| clean HEAD, this session | 8 shots | `b6f8f6426e0bc6e4` |
| with R26 change | 8 shots | `f26739561ceb1f5e` |
| single shot, twice | 1 shot | `205462dc…` (both) |
| two shots, twice | 2 shots | `f2673956…` (both) |

Two facts fall out, and they point in opposite directions from "the tool is
flaky":

1. **Determinism holds.** Every repeated run with the *same* shot list is
   byte-identical — single-shot twice, two-shot twice, and the two-shot run
   agrees exactly with the 8-shot run of the same source. This is not a
   coin-flip.
2. **Output depends on the shot list.** `valley-vista` alone hashes
   `205462dc`; as the second of two it hashes `f2673956`. Shots are rendered
   sequentially in one browser process, and a frame depends on what preceded
   it. So a hash is only comparable against another hash taken with the *same*
   list.

That leaves the manifest/HEAD mismatch, which neither fact explains — same
list, same source, different bytes. The remaining variable is the process
itself: the manifest was baselined in an earlier container. **Determinism is
per-session, not per-repository**, and a manifest committed to git is a
cross-session artifact that will not reproduce. It has to be re-baselined at
the start of a session to mean anything.

### And the premise of the old A/B was wrong too

R25 read "glove colour changed → only the 3 rider shots moved" as proof the
tool scopes changes tightly. It does — but that result does not generalise the
way it was used. A rider **colour** change cannot move a landscape frame; a
rider **geometry** change can, because the rider is in the shadow cascade and
its silhouette alters the depth map that terrain is lit against. So "8 of 8
changed" after a geometry edit is not necessarily a fault, and R25's implied
rule — landscape frames moving means something is wrong — does not hold.

### What this costs

The R26 rider change is verified by the turnaround card across six angles, by
a direct dump of the sleeve's rest radii, and by a green build — **not** by the
regression tool, which could not speak to it. The manifest is re-baselined in
this session so the tool is usable again going forward, with the honest caveat
that the next session will have to do the same before its first comparison
means anything.

---

## R28 — Two negative results, and a rule about zoom

After the arm work, two things on the figure looked like defects and neither
is. Recording both, because a phantom lead costs the next round real time.

### The jacket hem underside — not open, not sawtoothed

Seen from below (the figure is airborne in half the turnaround cells) the hem
appeared to show a dark void with a hard stair-stepped edge, which had the
exact signature of two near-coincident surfaces z-fighting. The suspicion was
concrete: `capStart` lifts in **+Y** just as `capEnd` does, so a hem whose
stations run bottom-to-top would dish open downward — the same bug shape that
produced the sleeve's dark cup in R26.

Tinting settled it. `jacketHem` and `jacketBody` are both clean; the dark
region is the pant leg and the seat, both on `M.pants`, on the shadowed
underside of the figure. Correct, and invisible in the untinted render because
the two pieces share a material.

### The sawtooth was the zoom

The stair-stepping was an artifact of **my crop, not the render**. The
inspection crop was 200x170 source pixels scaled 7x with nearest-neighbour, so
a 3-pixel edge became a 21-pixel staircase. Re-cropped at 3x with lanczos the
edge is smooth and the hem reads as intended.

**Rule: match the zoom to the feature size before calling something a defect.**
Nearest-neighbour at 7x+ manufactures hard edges out of ordinary antialiasing,
and every one of them looks like z-fighting. Use nearest only when the question
is "which object is this pixel" (the tint tests, where exact colour matters);
use lanczos at 2-4x when the question is "does this read correctly".

This is the third time in this project that a measurement has been taken over
the wrong support and reported as a fault — after the band-that-was-not-an-
object in `backdrop-detail.mjs` and the "head detached" claim that turned out
to be 565 vs 567 background pixels. The failure mode is stable enough to name:
**the instrument's resolution has to be checked before its reading is.**

### Still open, and not mine to sit on

The playability run surfaces the game's own terrain validators firing:

    [terrain] fall-line glide hits 78°
    [terrain] fall-line gradient jump 9.35 m over 2 m
    [terrain] spawn slope 23.3° outside 5–11°
    [terrain] spawn surface is powder, expected windpack

These predate the rider work (identical warnings before any edit this session)
and rider geometry cannot affect terrain. A fall line hitting 78° with a 9.35 m
drop over 2 m is a cliff in the run, and the spawn is on the wrong surface at
twice the intended slope. Left alone deliberately — BAILED is at 18% against a
20% target, so this is not currently costing the player — but it is a real
lead for the course pass, not noise.

---

## R29 — Six pieces of head detail that have never rendered a pixel

"Head is weird" was the user's third note on the rider and the one never
chased. Four views plus a tint pass and `head-extents.mjs` locate it exactly.

### What owns what

Tinting the head parts flat:

- **the entire back of the head is the HOOD**, not the helmet. The back view is
  100% `hoodUp`; the hard vertical line splitting the side view is its rim.
- the goggle strap is a sliver, the brim never appears at all.

### And the measurement says why

`head-extents.mjs` reports every mesh under the head bone against the skull's
own ellipsoid at the same height. Sorted by `proud`:

    TorusGeometry    +0.0175   hood rim
    SphereGeometry   +0.0128   hood
    SphereGeometry   +0.0072   lining
    TorusGeometry    +0.0015   ear pad
    ---- surface ----
    BoxGeometry      -0.0168   vent slot
    BoxGeometry      -0.0187   vent slot
    SphereGeometry   -0.0264   ear pad
    BoxGeometry      -0.0276   vent slot
    CylinderGeometry -0.0362   BRIM
    TorusGeometry    -0.0383   GOGGLE STRAP
    BoxGeometry      -0.0394   vent slot

**This table was over-read when first written, and the correction matters more
than the original claim.** `proud` is `maxX - skullHalfWidthHere`: it measures
whether a part breaks the skull's **X silhouette**, which is precisely what the
tool's docstring says it is for. That is the right question for a ring at
goggle height, which is supposed to girdle the helmet. It is the *wrong*
question for a vent slot lying on the crown or a strap wrapping the back —
both legitimately score negative while sitting on the surface and rendering
perfectly well.

The tint pass in this same section proves it: the goggle strap shows as visible
magenta slivers. It is not buried. Only the **brim** is confirmed dead, and by
two independent means — it scores -0.0362 on a metric that genuinely applies to
it (a ring of radius 0.071 inside a shell of radius 0.106), and orange never
appeared anywhere in the four tinted views.

So: one piece confirmed invisible, not six. The rest of the negative rows are
unproven either way, because no instrument here has yet asked "is this on the
surface" as distinct from "does this cross the silhouette".

Both buried pieces got there the same way, and the comments record it: each was
once poking out wrongly (the brim "read as a rod driven through the helmet"),
each was corrected, and each was corrected straight past the surface. The fix
for "sticks out" was applied without a measurement of where the surface was.

### Fixed here: the brim

Sized *from* the measurement rather than guessed — `skullHalfWidthHere` is
0.1064 at that height, so a torus of major radius 0.1045 with a 6 mm tube
stands ~4 mm proud. The skull is scaled 1.10 in Z against 0.96 in X, so the
torus takes the same ratio or it buries itself front-and-back while standing
off at the sides. Re-measured: **-0.0362 → +0.0025**, and the moulding line is
visible in the 3/4 and side views.

### Left alone deliberately

The hood owning the whole back of the head, with a razor rim cutting a vertical
seam down the side view and a near-black featureless back, is the biggest thing
wrong with the head. It is *not* touched here. That geometry carries four
rounds of tuning against genuinely conflicting constraints — the opening must
clear a skull 1.16 headRadii wide or the rim lands in front of the face, but a
larger radius makes the shell float and its rim "read as a hoop hung around the
head". Moving the rim back far enough to stop halving the side view requires
growing HOOD_R, which walks straight back into the floating-hoop failure. That
needs a considered pass, not a late-session parameter nudge.

The other negative rows are **not** established as defects, per the correction
above, and must not be "fixed" on the strength of that table. Deciding whether
a crown vent or a rear strap actually sits on the shell needs a surface-distance
measurement — per vertex against the ellipsoid along its own normal — which
`head-extents.mjs` does not currently compute. That is the tool change the next
round should make before touching any of them.

Note what nearly happened: having found one real buried piece, the temptation
was to read the whole negative column as the same defect and fix six things.
Five of them may not be broken. A metric that answers one question will answer
a different question wrongly and just as confidently.

---

## R30 — Asking the right question: no head part is buried

R29 flagged six head pieces as buried, then retracted to one on the grounds
that `proud` measures silhouette-crossing rather than surface distance, and
said the remaining five were *unproven* pending a tool that could tell the
difference. This is that tool, and the answer is cleaner than either version.

### The measurement

`head-extents.mjs` now evaluates the skull ellipsoid's implicit function per
vertex. `r = sqrt(f)` is 1 on the surface; `outsideMax` is the radial distance
of the furthest vertex outside it, `outsidePct` the share of vertices outside.
The ellipsoid is read **from the skull mesh** (now named), not hardcoded — the
hardcoded copy carried `sx` and `sy` but no `sz`, so every silhouette number
this tool has ever produced quietly ignored that the skull is 1.10 deep.

    type                verts  outsideMax  outside%  state
    SphereGeometry        425      0.0629     100.0  on surface
    SphereGeometry        315      0.0562     100.0  on surface
    ... 13 more ...
    TorusGeometry         175      0.0024       9.7  on surface

**Fifteen parts, zero fully inside.** The vents are on the crown, the goggle
strap is on the shell, the ear pads are proud. Every piece of head detail
renders.

### Validated, because a metric that never fires is indistinguishable from one that cannot

A sphere was injected at the skull's dead centre and the tool re-run:

    SphereGeometry         63     -0.1004       0.0  FULLY INSIDE

It fires, and it separates the two cases by a wide margin. Then reverted. The
old brim checks out by hand against the same metric — radius 0.0713 at
y 0.1219 gives r = 0.68, comfortably inside — which agrees with the tint pass
that showed orange appearing in none of the four views. So the one confirmed
kill in R29 was real, and the fix for it stands.

### What this closes, and what it leaves

Closed: **do not "fix" the other five pieces.** They are not broken. R29 warned
against it on principle; this proves it. Had the original reading been acted
on, five sound pieces would have been moved to fix a defect that only one of
them had.

Left, and now isolated by elimination rather than assumed: the head reads as a
featureless egg **because of the hood**, not because its detail is buried. The
hood owns the entire back hemisphere, its rim cuts a hard vertical seam down
the side view, and it renders near-black from behind. That is the whole of the
remaining problem, and it is a shape-and-shading question rather than a
find-the-missing-geometry one.

### The pattern, third instance

R27: a manifest compared across containers. R28: a defect that was the crop's
magnification. R29/R30: a silhouette metric read as a surface metric. Each time
the instrument answered a question adjacent to the one being asked, and did it
confidently. The habit that catches it is cheap and mechanical — **before
believing a measurement, inject the thing it claims to detect and check that it
fires.** That is what turned `regress.mjs` from an assumption into a fact, and
it is what makes "zero buried parts" a result here rather than a shrug.

---

## R31 — Check the scale before spending the effort

Every rider judgement this session was made on `rider-turnaround` (a 400 px
cell per angle) or `head-preview` (a head filling 300 px). Neither is a view
any player occupies. Shooting `chase-carve` — the framing the player actually
looks at for the whole run — and cropping at native resolution:

- the rider stands roughly **90 px tall** including the board, in a 1280x720
  frame
- the head is roughly **18 px**

### What that says about the work

**The arm and glove work reads at gameplay scale.** The forearm taper is
visible, and the gauntlet and mitt read as a distinct hand rather than a stub.
Those are large features — a 14 mm change in sleeve radius is a real fraction
of a 90 px figure — so R26 and the glove sizing were worth doing on the view
that matters, not only on the turnaround.

**The head detail does not, and cannot.** At 18 px the brim moulding line
(~4 mm proud), the vent slots and the goggle strap are all sub-pixel. R29's
brim fix is correct and it is verified, but its entire value is in close shots
— portraits, air-trick, the manoeuvre cards — and none in play. Had the six
"buried" pieces been real and all six been fixed, the gameplay view would have
been identical.

**What IS visible on the head at 18 px is the two-tone split** — grey hood over
black helmet reads as a cap sitting askew on a dark ball. That is a
large-feature, low-frequency property, exactly the class that survives to 18 px,
and it is the most plausible referent for the user's "head is weird". The hood
was already isolated in R30 as the whole of the remaining head problem; this
says it is also the only part of it worth fixing for the player.

### The rule

The turnaround and the head preview are look-dev instruments and they are
excellent at what they do — but they magnify. **Before spending a round on a
feature, render the view the player occupies and measure how many pixels the
feature gets there.** Detail below a couple of pixels is for cards and replays,
and should be scheduled as such rather than as gameplay polish.

This is the same failure family as R27, R28 and R30, one level up: not a
measurement taken over the wrong support, but a *judgement* taken at the wrong
magnification. The instrument was fine. The zoom was the assumption.
