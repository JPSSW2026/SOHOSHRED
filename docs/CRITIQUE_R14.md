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

