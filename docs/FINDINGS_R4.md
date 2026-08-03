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
