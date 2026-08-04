# Round 4 findings — the rider was mirror-imaged, and the physics only turned one way

## SOLVED — rider chirality (commit 8a4ae7a)

The user reported demo v2 "still shows a goofy stance rider" after a
STANCE_YAW commit that was supposed to fix it. The yaw could never have
fixed it:

**Stance handedness is fixed by the axes, not the pose.** The chest faces
the toe edge. With the nose at +Z and the toe edge at +X, the anatomical
right side necessarily leads (goofy). Regular — left foot forward — requires
the toe edge at **−X**. The rig was rebuilt on that convention, and the
mirror flip was carried through every chirality-coupled sign: STANCE_YAW
(whose old positive value actually rotated the chest toward the *tail*),
head/neck unwind, incline, twist, arm swing/elbow application, crash roll,
garment front (zip/pocket/hood), knee pole, grab-table application.

Verified numerically in the live scene, not by eyeballing a render:

| Probe | Value |
| --- | --- |
| (shoulderL − shoulderR) · noseDir | **+0.412 m** (left leads = regular) |
| chest facing · toe edge | 0.852 |
| front-boot long axis · toe edge | 0.966 |
| head facing · nose | 0.987 |
| boot-to-binding distance F/B | 0.065 m / 0.065 m |

## SOLVED — bindings and boots ran ALONG the deck (same commit)

The binding hardware was authored boot-axis-along-the-board — highback at
the tail, like a ski binding — and the boot boxes pointed at the nose. Real
bindings run across the deck (0° = transverse; +15°/−6° duck), highback on
the heel edge. Both are now wrapped in a −90° group so the stance-angle
convention on the mount bone is unchanged and the leg IK needed no edits.
This also un-twists the legs: the knee pole (toe-ward) and the boots now
agree.

## SOLVED — the turn direction never depended on the edge (same commit)

`physics.js` line 422:

```js
s.heading += carveRate * hold * h * Math.sign(1);   // sign of a constant
```

`carveRate` is unsigned in edge angle, so **both edges turned the board the
same direction**, while the body-lean channels (which did read the edge
sign) leaned the opposite way half the time — the exact "terrible physics"
read of demo v2: a rider turning right while leaning left. The dug edge now
chooses the turn (`Math.sign(incl)`).

Probe: steer +1 for 1.5 s → heading +2.18 rad; steer −1 → −1.91 rad.

**Lesson repeated from round 3:** the stance defect survived one plausible
fix (STANCE_YAW) because the fix addressed a symptom inside a mirrored
coordinate system. The probe that settled it cost 40 lines. Pose bugs get
probes, not adjectives.

## Round-3 blind scoring (r10): 5.5 / 4.5 / 3.2, 9/9 identification ×3

Consensus blockers, in planned attack order:

1. **Rider softgoods read as black wet plastic** (L14 darkest-1%) —
   albedo floor + roughness raised in 9227122, thigh now L61.
2. **Chase camera rode the rider's shoulder** — pulled to 8.6 m / 2.7 m,
   occlusion floor 1.9 → 4.2 m (9227122).
3. **Contour-terrace banding at 1–3 km** — diagnosis: coarse clipmap rings
   compute normals from adjacent *point-sampled* posts, so sub-Nyquist
   terrain detail aliases into low-frequency N·L stripes that a 10.6° sun
   turns into terraces. Fix: wide central differences (eps ∝ post spacing)
   = gradients of a low-passed field. NOT yet applied.
4. **Cast-shadow slice 400–900 m shadows quantised steps + caster-less tor
   smudges** — pull adaptive far back toward ~520 m; N·L carries the far
   field. NOT yet applied.
5. **Ridge paler than sky** — the §5.2 clamp limits a crest to the sky
   along its *own* ray (bright, near-horizon); the eye compares it to sky
   *above* the silhouette (darker). Clamp against sky sampled slightly
   above the ray. NOT yet applied.
6. **Far shadows grey (LAW 2)** — valley-haze inscatter too neutral;
   needs a blue floor (B/R ≥ 1.25). NOT yet applied.
7. **close-spray has no spray** — suspect the trail/spray stamping only
   lands on *rendered* frames while settle() draws only the last two.
   Needs a probe before any fix.
8. **Talus confetti / air-trick floating shard / snow-detail box rock** —
   props conform + distance cull. NOT yet applied.

---

# Round-5 verdicts (r12): 5.5 / 3.5 / 4.6 / 4.5 / 4.0 — avg 4.4, still 9/9 blind

One critic conceded "ridge-backlight and hero-basin would survive a
lighting-only comparison" — tone/lighting parity is close; frame identity
still gives it away structurally. Consensus queue, next session:

1. RIDER (all five critics, #1): joints still read proud, upper arms render
   pale instead of shell-orange (sleeve colour-blocking), jacket belly glowed
   from bounce (BOUNCE_VIEW_FACTOR cut shipped, verify), air-trick grab hand
   floats ~20 cm off the deck.
2. Near-shadow blue: B/R 1.06-1.10 vs 1.20 law. Bounce cut helps; remaining
   suspect is PCF leak under thin casters (tracks/sastrugi never reach umbra).
3. Mid-field shadow slats within the 520 m slice: receiver-distance-scaled
   PCF + cascade blend + normal-offset bias.
4. Prop chips still float at crests in west-spur/ridge-backlight (300-600 m,
   inside cull range): need surface conform/sink; ALSO verify rockMat
   actually receives the aerial injection — critics measured full-contrast
   chips at km range.
5. close-spray: r12 predates the steep-line move; re-verify spray density at
   the capture instant on the new line.
6. Sky zenith saturation below colour script (wash partly from per-setup
   exposure comps).

Range-wall v1 shipped (see commit aa7bf84 + follow-up); remaining wall
polish: shaded serrated sections ghost cyan (inscatter-dominated), backdrop
stitch seams at steep flank edges, flute shading subtle at 15 km+.

## Range-wall status after the user feedback round

Shipped: massif clustering, 450 m wall rings (log rings had left 2-4 km
radial gaps - the "featureless curtain" cause), steep-far-face rock
classification (kills XZ-planar snow streaking), 1.6x far relief
exaggeration, 120 m gradient smoothing floor.

Attempted and reverted: 2.2x exaggeration + 1536 posts + 300 m rings =
prism-palisade artifacts (per-post normal jitter on amplified gradients).

NEXT for majesty (needs a dedicated session): a purpose-built ridge-and-
spur skeleton generator for the wall band (drainage-consistent ridgelines
with spurs, not isotropic ridged noise), telephoto-style shot framing for
vista presets (longer lens compresses perspective like the reference
photography), and warm/cool split lighting on the wall faces.

Also this round: bindings slimmed 20-30%, signal red locked (hotter base
+ 0.055 same-hue emissive floor), far-face classification threshold
eases 44->38 deg beyond 6 km.

## Majesty pass (ridge chains) — commit above

Wall structure is now analytic crest-line chains (peaks, serration, spur
flutes, stacked rows). Confirmed remaining artifact: vertical sliver bands
START AT THE 8 km STITCH FAN (192->768 1:4 fan triangles, interpolated
normals). Fix candidates: two-stage 1:2 fans, or move the fan inward to
~4 km where relief is nil. Wall tops still wash pale - aerial crossfade at
15+ km; consider per-chain contrast preservation. Sky-horizon milk band
also pending (zenith saturation item).

## The sliver-band investigation — evidence table (carry into next session)

The pale vertical-sliver band at the wall base (2-7 km, full width):

FALSIFIED by ablation: chain wobble folding (smooth wobble, no change);
hard-max creases (smooth-max, no change); serration amplitude (tamed, no
change); discrete rock/windpack id flip (continuous-only, no change);
vertex-colour schist tint strength (capped 0.18, no change); stitch-fan
position (8 km -> 4 km, no change); classification eps (24 -> 130, no
change); albedo-modulation streaking (texFade, no change on the band);
BACKDROP_INNER gap (2400 -> 1900, no change); backdrop normal eps.

ESTABLISHED: band is part of the terrain-backdrop mesh (backdrop-off
removes it); visible under a plain white override (geometry/normals, not
snowMaterial); PRE-DATES the ridge chains (visible at 8e71713 and, in
hindsight, in every capture back to r10 - the critics' "cutout rock
shards"); analytic field smooth along radial and angular scans at probe
resolutions.

NEXT ATTACK (fresh context): render the backdrop with MeshNormalMaterial
and in wireframe, cropped to the band - one probe each; the fin geometry
will identify itself immediately. Prime suspect: crease lines of the
ridged2(x/3800) sharpness-1.25 noise running radially through the 2-7 km
log-ring zone.

OPERATIONAL LESSON (cost: nearly lost a session of work): NEVER
stash-drop to bisect - commit WIP first, bisect in a separate worktree.
Recovery was only possible via git fsck unreachable-commit archaeology.

---

# Round-6 verdicts (r13): 5.5 / 4.0 / 4.4 / 5.5 / 4.5 — avg 4.78, still 9/9 blind

Scored BEFORE the bushfire-horizon fix (c360ac7) and crest-rock fix
(3d91aa2) — the valley-vista "brown vertical smears" (4/5 critics) and part
of the prop-confetti complaints are stale; re-verify, don't re-fix.

Consensus queue, in attack order:

1. **LAW 2 shadow chroma + fill (5/5, critical).** Shadow B/R 1.047-1.151
   vs >=1.20; fill 0.586-0.654 vs <=0.55; blue-survival ch9 ~1.0 vs
   1.4-2.1. snow-detail (macro, all sastrugi shadow) measures 1.069 —
   shader defect, not sampling. Mechanism candidate (critic 3): the
   occluded-bounce gate `sohoBounceOccluded * sohoSunVis` decays no faster
   than the beam, so the NEUTRAL ground bounce fills the umbra; square
   sohoSunVis (or smoothstep(0.35,0.9)) so bounce dies at the shadow edge
   while sky fill (blue) remains. Also drop total fill ~20-25%.
   Acceptance: measure.mjs shaBR >= 1.20 AND fill <= 0.55 AND ch9 in
   [1.4,2.1] on all nine presets.
2. **Near/far contrast (item 17) inverted (5/5).** nf 0.25-3.16 vs >=4.0.
   Far too busy: fade detail-normal + rock speckle amplitude to zero over
   40-250 m, multiply far shadow contrast by the haze veil gate past
   ~1.5 km. Near too smooth: micro-relief (sastrugi/chatter) inside 40 m
   fading by 80 m.
3. **Props (5/5).** Tors render paler than sky with no sun shading — verify
   rockMat/imposters receive aerial + sun uniforms; drift-lip skirt +
   15-25% embed at every contact; per-instance rotation/scale/color jitter;
   cull sub-1.5 m instances beyond 400 m; caster-less blob shadows: tie
   castShadow to the same LOD/cull state as the render mesh (assert
   castShadow === visible).
4. **Rider garments round 2 (4/5, 3x critical).** Capsule end-rims at
   hip/shoulder/thigh, plastic specular. Merge limb segments into
   continuous sleeves/pant-legs with cuffs overlapping joints; ripstop
   normal amplitude up until it reads at 960 px; wrinkle normals at
   elbows/knees. (One critic claimed no goggle/board graphic — false,
   check what shot hid them.)
5. **Spray + trail (4/5).** Emission up ~2 orders at high edge angle,
   velocity-stretched quads, two-tone sun/sky lighting, engaged-edge-only
   cone; trail = trench with shadowed inner wall + displaced bright lip,
   bicubic/higher-res near-camera sampling (kill texel stair-steps).
6. **close-spray washout (4/5).** median 216 (cap 210), meanSat 0.065
   (floor 0.18): cap tier-2 veiling glare (~12% of frame luma) and/or
   shotExposure ~0.88; meter off sunlit-snow percentile, not frame mean.
7. **Right-edge vertical strip, chase-carve (3/5, one critical).** ~20-30px
   desaturated grey full-height strip (ground rgb 151,151,151; sky B/R
   2.02 -> 1.20 inside). A UV-offsetting post pass clamps outside the
   framebuffer (CA / sharpen / motion-blur / veil blur / AO). ABLATE pass
   by pass before fixing; verify column means x>935 vs 850-900, delta < 2.
8. **LAW 1 on ridge-backlight (2/5).** Sunlit B/R 1.23 vs <=1.06 — HG
   forward-scatter lobe tinted by ambient/sky instead of sun colour.
9. **snow-detail zigzag LOD silhouette + checkerboard box (3/5)** — LOD
   skirt/morph at macro distance; no fallback texture may reach a shot.
10. **f0180 rig break (1/5, from demo v4 frames)**: board detached at waist
   height mid-air + stray edge rod — IK pin feet to bindings through
   aerial rotation; grab-hand contact (round-5 carryover).

## Post-round-6 fix state (r14, shots/r14)

Fixes shipped this cycle: LAW-2 micro-horizon + geometric horizon ramp
(e734dbf), vignette/streak/banks edge-band batch (97b83e2), garment pass 2
with cloth normal maps + AgX-aware vermilion (01dbecb), packed hood +
sun-local veil (55d7be6), spray motion-stretch + C1 trail sampling
(f27d9a8). Sizzle-reel quality-bar notes in CARDRONA_REFERENCE §6.

r14 vs r13: shaBR 1.05-1.10 -> 1.11-1.42 (8/9 frames; air-trick 1.418,
ridge-backlight 1.371, west-spur 1.229); ch9 ~1.0 -> 1.14-1.92; nf passes
item 17 on hero/west-spur/air-trick/portrait; close-spray meanSat 0.065 ->
0.108 with the frame keeping saturation away from the sun; trail facets
dissolved (C1 sampling); chase-carve shaBR 1.000 is a one-frame percentile
quirk (spray mist claims the darkest decile) - re-check next round.

Still open, in order: props lighting/aerial + contact (5/5), edge slab
(NOT post, NOT banks - MAD toggle probe interrupted, see task #6),
LAW-1 backlight HG sun-tint (1.277 vs <=1.06), LOD zigzag in snow-detail,
rock TV-static albedo near camera, portrait backdrop slat fence, f0180
air rig break, orphan shadows.

## Down-valley seam artifact (user report, demo v8) — diagnosis state

The "weird lines between backdrop and foreground": three stacked layers
at the field/backdrop seam, visible down-valley (valley-vista reproduces).

ESTABLISHED: (1) tan pillars are 100-300 m tall - TALLER than any clipmap
skirt (cap to 9 m changed nothing) - so they are BACKDROP INNER-EDGE
geometry: prime suspects are far-LUT bilinear extrapolation at the inner
boundary (LUT undefined inside BACKDROP_INNER -> spikes) or the inner
angular ring rows stretching; (2) the navy "lake" band sits between the
field silhouette and the backdrop wall base - either the backdrop's own
floor pooling dark or sky through a residual radial gap; ramp far-floor
lift (shipped) only partially brightens it; (3) the floating-island look
is the wall's base hidden behind layers 1-2.

NEXT ATTACK: white-override probe on the backdrop alone at the
valley-vista camera; then dump far-LUT heights along the down-valley
azimuth at r 1700-4200 and compare with _heightAt - a spike or a datum
step at the seam will identify itself. Skirt cap (9 m) and ramp floor
lift are shipped regardless - both are correct on their own.

## Pillar hunt round 2 — elimination table (next session: read this first)

Numeric diffs PROVE each change applied (MAD 0.2-1.6 per step) yet the
down-valley pillars survive ALL of: horizon-ramp retirement past 1 km
(3102 px changed elsewhere), far rock cap 0.18 -> 0.05, tussock near-gate
(no-op: inBox false on backdrop), rb zero inside 4.8 km, skirt cap 9 m.
FACTS: pillars are on/of terrain-backdrop (hide-test), killed by UNLIT
white override, anchored to a horizontal SKY SLOT at the wall base (the
"lake" = sky through missing/dropped geometry - bp-nobackdrop proves the
gradient matches the dome), evenly spaced, warm, fading up. NEXT: (a) the
sky slot is a GEOMETRY hole - dump backdrop ring heights vs ring index
along the down-valley azimuth and find the band that drops out of
silhouette (suspect the FAR_R=4000 fan row or a ring whose y falls below
the nearer ring); (b) the pillars are probably the fan row's thin
triangles catching grazing N.L between the slot edges - fix the slot and
they likely go with it. Probes: bluffprobe.mjs pattern in scratchpad.
