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

## Severity 5

| # | Defect | Mechanism | Status |
|---|--------|-----------|--------|
| 1 | Modelled range brighter than its own sky — luma 186–200 vs 151 (tell #28, checklist 19) | `backdropModel.js` mixed haze toward a near-white in *display* space, then multiplied by the 1/exposure gain → ~(2.7,2.8,3.0) linear against a (0.55,0.66,0.82) fog colour. Compounded: the paler-than-sky clamp read `scene.fog.color` once at mount, but the main path nulls `scene.fog` | **fixed (unverified)** — gain now first, converges to live `SOHO_HORIZON`; range still reads slightly pale against its sky |
| 2 | Woven cross-hatch stripe across the full width of the horizon (checklist 20) | Dithered discard: screen-space interleaved-gradient noise on a jagged silhouette. No band width fixes it — the dither *is* the artefact | **fixed + verified** — mix reaches 1.0 so the discard is retired; stripe gone in re-shot `valley-vista` |
| 3 | No aerial perspective. Near/far 32px tile σ: hero-basin 0.66, chase-carve 1.66, valley-vista 1.91, west-spur 2.32 vs checklist 17's ≥4.0. `hero-basin` **inverted** — far ridge carries more local contrast than foreground | Blue-extinction gate is 0.00 at 400 m, 0.06 at 900 m; playable box is ±1010 m, so nothing in the bowl gets any depth cue. Also `visibility: 110000` (§5.3 derives 42000) and `haze: 2.6e-5` (doc: 8e-5) | **open** |
| 4 | Rider casts no shadow; board has no contact darkening (checklist 12, 13, 40) | `sky.js` fit floor of 280 m → 0.167 m texel → ~0.5 m depth bias along beam → **2.7 m lateral peter-pan** on a 1.8 m caster at 10.6° sun, plus normalBias pinned at its 0.28 ceiling | **fixed (unverified)** — floor to 90 m, both bias ceilings rescaled, 1/sinAlt floored |
| 5 | Rider is sitting in a chair — pelvis at deck height, thighs horizontal, torso reclined ~30° backward | Pelvis height: `absorb+tuck+compress+grab` sums to 0.72 against `standH` 0.735, and the guard trims `hx`, which only reaches pelvis height via sin(roll) — zero authority on a flat board. Recline: cause **unresolved** | **partially fixed** — pelvis floored. The backward recline persists and is the dominant half. The critique blamed `chest.rotation.x`'s `+A.absorb*0.16`; flipping that sign produced a pixel-identical frame, so `A.absorb` is ≈0 in these captures and that term is not the driver. Reverted rather than shipped unverified. Needs a pose probe that reports the live `A.*` values before the next attempt |
| 6 | Nothing in nine frames cuts the surface (checklist 44) | Three stacked: `VISUAL_SINK_CAP = 0.010` (1 cm vs 0.55 m powder); `trails.js` 2048/320 m = 6.4 texels/m so a 0.16 m halfWidth is a **two-texel** trench; `fast = smoothstep(2,14,speed)` = 0.16 at the captured 18 km/h | **open** |
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
