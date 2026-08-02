# Soho Shred — Art Direction Bible

**Status: binding.** This document is the visual contract. Every visual
workstream — sky, snow material, terrain, props, rider, particles, trails,
post-processing, camera, HUD — is graded against it. The final section, **AAA
ACCEPTANCE CHECKLIST**, is the pass/fail gate for a screenshot.

It sits alongside two other documents and their precedence is:

1. `docs/REFERENCE_ANALYSIS.md` — per-frame notes on the Shredders reference set.
2. **This document** — the physics, the numbers, and the grading criteria.
3. `docs/ARCHITECTURE.md` — the module contract (what owns what).

Where this document quotes a number as *measured*, it was extracted by
programmatic pixel analysis of the 21 official Shredders frames in
`reference/shredders/` (bottom-55% ground mask, snow pixels isolated as
`saturation < 0.30 && B >= R-4 && max > 55`, percentiles taken over that
population, sun/shadow ratios computed in **linear** light after undoing the
sRGB transfer). Those are facts about the target, not opinions.

---

## 0. The thesis, in one paragraph

Photoreal snow is a **lighting** problem, not a **texture** problem. The four
things that carry a snow frame, in strict order of importance, are: (1) the
colour and strength of the fill light in shadow, (2) aerial perspective
separating near from far, (3) veiling glare off the snowfield, (4) silhouettes
and tracks that give scale and history. Surface detail is a distant fifth, and
piling on sparkle and normal noise actively makes the frame worse. Shredders'
snow is, over most of the screen, *smooth and almost matte*. It looks real
because the light is right.

---

## 1. What the target actually looks like (measured)

### 1.1 The tone curve

| Quantity | Measured across the reference set | Our target |
| --- | --- | --- |
| Mean frame luma (sRGB 0–255) | 63–199, bluebird alpine 125–182 | 130–185 |
| Median (p50) luma | 68–220, bluebird alpine 116–196 | 120–200 |
| p99.9 luma | 228–252 — **never 255** | ≤ 252 |
| Pure-white pixels (all ch ≥ 254), sun out of frame | 0.000%–0.135% | ≤ 0.20% |
| Pure-white pixels, sun in frame | 0.43%–5.82% | ≤ 3.0% |
| Mean saturation | 0.115–0.583, bluebird alpine 0.21–0.32 | 0.20–0.34 |

The headline: **snow does not clip.** Even in the brightest frames, the top
0.1% of pixels sits at 244–252, not 255. This is highlight rolloff doing real
work, and it is the difference between "photograph" and "renderer output".

### 1.2 Sunlit snow vs shadowed snow, per channel

The 93rd-percentile snow pixel is "sunlit"; the 10th-percentile snow pixel is
"shadowed". Measured pairs from the open-terrain bluebird frames:

| Frame | Sunlit | Shadowed | linear shadow÷sun (R, G, B) | shadow B/R |
| --- | --- | --- | --- | --- |
| ref_08 | `#CACBD0` | `#66718F` | 0.225, 0.277, 0.435 | 1.40 |
| ref_10 | `#E7E6EC` | `#8897B6` | 0.308, 0.391, 0.558 | 1.34 |
| ref_13 | `#DDDBE9` | `#A3A9CB` | 0.507, 0.560, 0.733 | 1.25 |
| ref_14 | `#F1F1FD` | `#A2ABCA` | 0.411, 0.463, 0.601 | 1.25 |
| ref_16 | `#EFEEF4` | `#8E92BF` | 0.313, 0.336, 0.576 | 1.35 |
| ref_17 | `#EFEEF3` | `#494D66` | 0.077, 0.087, 0.148 | 1.40 |
| ref_19 | `#D0CED9` | `#687190` | 0.219, 0.268, 0.402 | 1.39 |
| ref_20 | `#DAD2DF` | `#909DC7` | 0.398, 0.523, 0.774 | 1.38 |

Three laws fall straight out of this table and they are non-negotiable:

**LAW 1 — Sunlit snow is neutral.** B/R of the sunlit sample is **0.99–1.06**
across every single frame. Sunlit snow is a *neutral, slightly-off* white, not
a blue one. The universal hobbyist mistake is tinting the snow albedo blue;
that is wrong. `CONFIG.snow.sssColor` is a *transport* tint, not a base colour.

**LAW 2 — Shadowed snow is decisively blue.** B/R of the shadow sample is
**1.25–1.40**. Not 1.05. Not "a hint of blue". Distinctly, obviously blue.

**LAW 3 — The fill is enormous.** Linear shadow ÷ sunlit luminance is
**0.22–0.56** for open terrain. In a non-snow scene that ratio would be
0.05–0.15. Snow at 0.86 albedo is a giant reflector; every shadow is filled
from the sky *and* from the surrounding snowfield. If your shadows sit at 0.08
of the sunlit value, your scene reads as asphalt painted white.

And the corollary that makes the blue: the **blue channel survives shadow
roughly 1.5–2.0× better than the red channel**. Take `ref_16`: R keeps 0.313,
B keeps 0.576 — a ratio of 1.84. That single number is the entire "blue
shadows" phenomenon expressed as a shader requirement.

### 1.3 Aerial perspective, measured

Local contrast = standard deviation of luma within 32×32 px tiles, averaged per
horizontal band (band 0 = top of frame = far field; band 7 = bottom = near).

| Frame | far-field σ | near-field σ | ratio |
| --- | --- | --- | --- |
| ref_08 | 3.6 | 22.6 | 6.3× |
| ref_19 | 4.0 | 26.2 | 6.6× |
| ref_13 | 2.1 | 25.9 | 12.3× |
| ref_16 | 1.9 | 14.7 | 7.7× |
| ref_20 | 1.7 | 10.9 | 6.4× |
| ref_15 | 5.3 | 23.8 | 4.5× |

**Target: near-field local contrast must be at least 4× the far-field value,
ideally 6–8×.** This single measurement separates "alpine photograph" from
"terrain demo" more reliably than anything else you can compute from a frame.

### 1.4 Sky, measured at top-of-frame

| Condition | Frames | Top-of-frame sky |
| --- | --- | --- |
| Hard bluebird, sun behind camera | ref_02, ref_21 | `#004482`, `#1E558D` |
| Bluebird, sun off-axis | ref_07, ref_17, ref_06 | `#335088`, `#4E78B4`, `#3F6CA8` |
| Bluebird with high cloud | ref_19, ref_20, ref_08 | `#5D83BD`, `#6E91CB`, `#94AED8` |
| Overcast-bright / high-key | ref_05, ref_16, ref_03 | `#ABB2CC`, `#A2B9E5`, `#90A5D4` |

**Bluebird sky is deep and saturated**, down to `#004482` — a rich, almost
navy blue at the top of frame, running to `#C2D4EA`-ish at the horizon. A pale
washed `#87CEEB` "sky blue" is an instant fail. Note that in a 62° vertical
FOV frame the top of frame is only ~25–30° above the horizon, so the true
zenith is *deeper still*.

---

## 2. The place: Soho Basin, Cardrona

`CONFIG.LOCATION`: lat −44.8748, lon 168.9486, base 1410 m, summit 1865 m,
aspect 135° (SE-facing), treeline 1100 m — **the basin is entirely above
treeline**. That is a defining art-direction fact and it separates us from
every European and North American reference frame.

Consequences:

- **No trees.** Not one. The Shredders references lean heavily on frosted
  birches and spruce for silhouette and scale; we cannot. Our silhouette
  budget must be carried by **schist rock outcrops, tussock poking through
  wind-scoured patches, marker poles, fence lines, lift towers, avalanche
  debris and the rider**. Losing the trees means props work harder — a props
  pass that produces "a few rocks" will fail this document.
- **Southern Alps schist.** The bedrock is Otago/Haast schist: grey-brown,
  strongly foliated (parallel platy layering), fracturing into slabs and
  blocky ledges, not rounded boulders. Lichen adds sparse sulphur-yellow and
  rust-orange patches. Every ledge holds snow.
- **Tussock.** Below the snowline and through wind-scoured patches, NZ snow
  tussock (*Chionochloa*) is a strong gold-brown, `#B08A4E` lit,
  `#6A5738` shadowed. Against a white field these gold patches are our single
  most valuable natural colour accent — the direct analogue of the autumn
  orange in `ref_05`.
- **Southern-hemisphere sun.** The sun is in the **north**. Every intuition
  built on northern-hemisphere reference photography is mirrored. Get this
  wrong and NZ viewers will spot it immediately.

### 2.1 Solar position — computed, and binding

`CONFIG.world`: `timeOfDay 9.67`, `dayOfYear 195` (mid-July, deep NZ winter).

- Declination (Cooper): δ = 23.45° · sin(360(284+195)/365) = **+21.7°**
- Longitude correction: NZST standard meridian 180°E, site 168.95°E →
  local solar time runs **44.2 min behind the clock**.
- Equation of time, day 195 ≈ **−5.9 min**.
- Solar time ≈ 08:50 → hour angle H = **−47.5°**.
- sin(alt) = sin φ sin δ + cos φ cos δ cos H = −0.2608 + 0.4448 = 0.1840
  → **solar elevation ≈ 10.6°**
- cos(Az) = (sin δ − sin(alt) sin φ)/(cos(alt) cos φ) = 0.7173
  → **solar azimuth ≈ 44° east of north (NNE–NE), morning side**

**This is a very low, very raking light.** It is the single best gift the
time-of-day choice gives us and everything must honour it:

- **Shadow length = height / tan(10.6°) = 5.34 × height.** A 1.80 m rider
  casts a **9.6 m** shadow. A 3 m rock casts 16 m. If your rider's shadow is
  2 m long, you have implicitly set the sun to 42° and the frame will read as
  flat midday no matter what the sky says. This is a screenshot-checkable fail.
- **The light is a cross-light.** The fall line runs down-slope on bearing 135°
  (SE); the sun is at bearing 44°. Facing downhill, **the sun is 91° to the
  rider's left, essentially abeam, and only 10.6° up.** Every ripple, sastrugi
  ridge, wind lip, track and carve trench across the fall line is raked and
  reads in relief. Terrain form is described by shadow shape, exactly as in
  `ref_19`. This is why we chose 09:40 and it must not be quietly "fixed" to a
  higher sun because the shadows are inconvenient.
- Air mass ≈ 1/sin(10.6°) ≈ **5.4**. The sun is heavily attenuated and
  reddened, and its disc is a soft glowing blob, not a hard circle.

### 2.2 The mood

Bluebird morning after a clear cold night at −6.5 °C. Dry, squeaky, cold snow.
The air is exceptionally clean (1800 m, dry continental-ish airmass over
Central Otago) — which is why **the distance goes blue rather than milky
grey**. This is the alpine look as distinct from the coastal-mountain look.

---

## 3. Snow BRDF — why snow is not a white Lambert surface

### 3.1 What snow physically is

Snow is a **dense random medium of ice grains** (radius 50–1000 µm) in air,
with a density of 50–150 kg/m³ for fresh, 200–400 for settled/windpack. Ice's
complex refractive index in the visible is n ≈ 1.31 with an imaginary part
k ≈ 10⁻⁹ at 500 nm — i.e. **ice barely absorbs visible light at all**. Single-
scattering albedo of a grain is 0.99999+.

Two facts follow, and they drive everything.

**Fact A — photons make hundreds of bounces before they leave.** With almost
no absorption, light entering the pack refracts through grain after grain and
mostly comes back out. That is why the directional-hemispherical albedo of
fresh fine-grained dry snow is **0.85–0.90** in the visible (up to 0.95 for the
freshest). `CONFIG.snow.albedo = 0.86` is correct. For comparison: fresh white
paint is 0.80, a white studio card is 0.90, and typical "white" game albedo is
capped around 0.80 for a reason.

| Snow state | Broadband albedo | Notes |
| --- | --- | --- |
| Fresh, dry, fine-grained (< 0.2 mm) | 0.85–0.92 | our default |
| Settled / windpack (0.3–0.7 mm) | 0.75–0.82 | most of the basin surface |
| Groomed corduroy | 0.72–0.80 | compacted, larger grains |
| Sun crust / refrozen | 0.65–0.75 | + a strong specular |
| Wet spring snow (0 °C, clustered grains) | 0.55–0.70 | grains clump → optically larger |
| Blue ice / boilerplate | 0.30–0.60 | + a mirror specular |
| Dirty / dust-on-crust | 0.40–0.60 | needed for the skin track / lift line |

**Fact B — the absorption that *does* exist is wavelength-dependent, and
steeply so.** Ice absorbs almost nothing at 450 nm, roughly 10× more at
600 nm, and 30× more at 700 nm. Photons that travel a *long* path inside the
pack come back **red-depleted, i.e. cyan-blue**. In fine dry snow, the
e-folding depth is 5–20 cm, and the blue becomes visually obvious once the
transport path exceeds roughly **30 cm**.

### 3.2 The two blues, and why you must model them separately

This is the single most-botched thing in CG snow.

**Blue #1 — ILLUMINANT blue (the big one, ~85% of the effect).**
Snow in shadow receives no direct sun. It is lit only by the sky, whose CCT on
a clear high-altitude day is **12,000–18,000 K**. The snow is not blue; the
*light* is blue, and snow's 0.86 albedo reflects it back with near-perfect
fidelity. This is a **lighting-system problem**, owned by `sky.js` (ambient
colour, IBL) and consumed by `snowMaterial.js`. It is the mechanism behind the
measured B/R = 1.25–1.40 in §1.2.

**Blue #2 — TRANSPORT blue (the small, precious one, ~15%).**
Light that enters the pack, travels far, and re-emerges. This is a **material
problem**. It shows up only in specific places, and putting it everywhere is
a tell:

- the interior wall of a fresh carve trench (10–25 cm deep)
- the shaded lee side of a wind drift or cornice lip
- the wall of a bootpack hole, a crater, or a sluff runnel
- the underside of a broken slab edge in avalanche debris
- the shadowed face of a snow pillow over a rock

Use `CONFIG.snow.sssColor = [0.62, 0.74, 0.95]` here — note it is a *cyan-blue*,
not a violet-blue, because the loss is in the red end. Gate it on local
concavity/curvature and depth-below-local-plane, with strength ramping from 0
at 0 cm to `CONFIG.snow.sssStrength` (0.62) by ~35 cm.

**If you tint the base albedo blue, you have collapsed both mechanisms into one
and you will fail LAW 1.**

### 3.3 The phase function: snow is strongly forward-scattering

Ice grains are enormous relative to visible wavelength — size parameter
x = 2πr/λ runs 600–14,000 — so scattering is in the geometric-optics regime and
is dominated by **refraction straight through the grain**. The asymmetry
parameter is **g ≈ 0.85–0.89** for spherical grains and **0.72–0.80** for
realistic non-spherical crystals. Compare: an isotropic scatterer is g = 0,
water cloud droplets g ≈ 0.85.

The measurable consequence, from the remote-sensing literature: **the ratio of
snow's reflectance in the forward-scatter direction to its nadir reflectance is
3–5×.** Snow is emphatically, measurably **non-Lambertian**. Anyone who has
skinned uphill toward a low sun and then turned around knows this — the slope
you look at *toward* the sun is blinding, and the identical slope with the sun
behind you is dull. **This behaviour is almost universally absent from CG snow
and its absence is a top-3 tell.**

### 3.4 The shading model we ship

`snowMaterial.js` owns this. Five terms, summed:

**(a) Wrapped multiple-scatter diffuse — the base.**
A raw `max(0, N·L)` produces a hard terminator that snow never has, because
photons enter on the lit side of a bump and exit on the dark side. Use wrap:

```
NdotL_wrapped = saturate((N·L + w) / (1 + w)),   w = 0.35 – 0.50
```

At w = 0.40 the falloff spreads an extra **23.6°** of surface angle past the
geometric terminator — on a 5 m snow roller that is a ~2 m band of soft
transition. Energy-normalise by `1/(1+w)` so albedo is preserved. Modulate the
wrap width by surface state: fresh loose powder w = 0.50, windpack 0.35,
ice 0.10 (ice is nearly a hard dielectric and *should* have a crisp terminator).

**(b) Forward-scatter lobe — the term everyone forgets.**
A broad view-dependent gain when the camera is looking down-sun, i.e. when the
view vector is close to the continuation of the light direction. Henyey-
Greenstein, but with an *effective* g **lower than physical** because we are
approximating many scattering events, not one:

```
cosθ  = dot(V, L)                      // V toward camera, L toward sun
HG(g) = (1 - g²) / (4π · (1 + g² - 2g·cosθ)^1.5)
forward = k_f · HG(0.55 … 0.70) · saturate(N·L + 0.2)
k_f such that the lobe peaks at 0.25 – 0.50 × the diffuse term
```

Ramp `k_f` up at grazing view angles (the effect is strongest looking along a
slope) and down as the surface state moves toward ice. Get this right and a
slope *changes character* as the camera swings around it, which is the thing
that makes a snowfield feel like a real material rather than a painted mesh.

**(c) Back-scatter / subsurface term.**
The transport blue of §3.2, in the shadowed hemisphere. Gate on concavity;
tint `[0.62, 0.74, 0.95]`.

**(d) GGX specular sheen.**
Ice: n = 1.31 → **F0 = ((1.31−1)/(1.31+1))² = 0.018**. Because we are shading
an aggregate of facets and not a slab, use a slightly higher effective
**F0 = 0.025–0.035**. Roughness by state:

| Surface | GGX roughness | Notes |
| --- | --- | --- |
| Fresh cold dry powder | 0.50–0.65 | broad soft sheen, nearly invisible except at grazing |
| Windpack / sastrugi | 0.35–0.50 | |
| Groomed corduroy | 0.30–0.45 | anisotropic *along* the groomer lines |
| Sun crust / refrozen | 0.12–0.25 | a distinct sheet-glare when it catches the sun |
| Wet spring snow | 0.20–0.35 | wet film → smoother and *darker* |
| Boilerplate ice | 0.05–0.12 | near-mirror; reflects the sky |

Corduroy anisotropy is worth the shader cost: it is a strong, instantly-read
"this is a real ski area" cue.

**(e) Glints — sparse, view-dependent, distance-limited.**
Individual crystal facets acting as tiny mirrors. Requirements:

- **Deterministic and world-anchored.** Hash a quantised world position
  (`worley2` or `hash32` from `core/rng.js`) → a per-cell pseudo-normal. Glints
  must be *nailed to the snow*, not to screen space or UV space, or they crawl.
- **Sparse and intense**, never a uniform overlay. Target **500–2000 visible
  glints per 1920×1080 frame**, each 1–3 px, at **3–20× local diffuse
  intensity** so they survive tone mapping as genuine speculars. A dense field
  of dim sparkles is the "glitter texture" tell.
- **Tight cone.** Light a glint only when `dot(H, facetNormal) > 0.998`-ish.
  The field of glints must be visibly **densest near the specular direction**
  of the sun — a diamond field that migrates as the camera moves.
- **Distance-limited.** Full strength to ~25 m, cross-fade to zero by 40 m.
  Beyond that they cannot survive mip filtering or AA and become shimmer.
  Verify against `ref_12`: fine granular sparkle exists in the near field and
  is *gone* by the mid-field.
- Kill them entirely on wet snow (a water film bridges the facets) and
  strongly reduce on groomed snow.

**(f) Surface-state channels, not material variants.**
One shader, three scalars from `terrain.sample()`: `compression` (powder →
groomed → boilerplate), `wetness`, `ice`. Blend albedo, roughness, wrap width,
sss strength and glint density along those axes. `terrain.js` supplies
`surface` ∈ `powder|groomed|ice|rock|windpack` plus `roughness`; map those to
the scalars.

### 3.5 Dry vs wet — the whole-frame difference

| | Dry cold (−10 to −5 °C) — **our default** | Wet spring (0 °C) |
| --- | --- | --- |
| Albedo | 0.85–0.90 | 0.55–0.70 |
| Roughness | 0.50–0.65 | 0.20–0.35 |
| Glints | strong, sparse, twinkling | none (water film) |
| Transport blue | deep (loose, fine grains) | shallow (clustered grains absorb) |
| Spray | dust-like, hangs 1.5–3 s, drifts on wind | heavy clumps, drops in < 0.7 s |
| Carve trench | clean shear walls, spray plume | wet slabby chunks, glossy track |
| Overall frame | high-key, blue shadows, sparkle | lower-key, greyer, glossier |

We ship dry. `CONFIG.world.temperature = −6.5`. Anything that reads as wet
(glossy, grey, heavy spray) is a fail.

---

## 4. Alpine lighting

### 4.1 The three light sources, with numbers

At 1800 m under a clear sky with the sun at 10.6°:

| Source | Irradiance (approx) | Colour |
| --- | --- | --- |
| **Direct sun** (normal to beam, air mass 5.4) | 550–700 W/m² | 4300–4800 K |
| **Sky** (diffuse horizontal) | 70–100 W/m² | 12,000–18,000 K |
| **Snow bounce** (0.86 × horizontal irradiance) | **150–190 W/m²** | neutral, very slightly warm |

Horizontal irradiance = DNI·sin(10.6°) + DHI ≈ 650×0.184 + 85 ≈ **205 W/m²**.
Bounce = 0.86 × 205 ≈ **176 W/m²**.

**Read that table again. The bounce off the snow is roughly 2× the sky fill.**
On an open snowfield, a downward-facing surface is lit *more strongly* than an
upward-facing shadowed one. This is why:

- The rider's **jaw, chin, the underside of the helmet brim, the underside of
  an outstretched arm, the base of the board** are all clearly lit from below,
  neutral-white. Not black.
- **Rock overhangs and the undercut of a cornice** are filled, not voids.
- **Nothing in an open-slope frame is genuinely dark.** Measured: the darkest
  1% of pixels in the alpine reference frames sits at sRGB 28–68, not 0–10.
  The only near-blacks are deliberate silhouettes (a rider against the sky, a
  lift cable, a goggle strap).

Practical requirement for `sky.js`: the IBL / ambient must have a **lower
hemisphere at 0.6–1.0× the intensity of the upper hemisphere**, neutral-white,
not a dark grey and never black. A standard `HemisphereLight(sky, ground)` with
ground set to dark grey is an automatic fail. Set ground ≈ `#E8E9EC` at
0.7–0.9 of sky intensity, and if you build a PMREM, bake the snowfield into it.

### 4.2 Colour temperature → linear sRGB

Useful conversions (normalised so the max channel is 1.0):

| CCT | Linear sRGB | Use |
| --- | --- | --- |
| 3500 K | (1.00, 0.67, 0.44) | sunset rim, not our TOD |
| 4000 K | (1.00, 0.75, 0.57) | sun at 5° |
| **4500 K** | **(1.00, 0.82, 0.68)** | **our direct sun at 10.6°** |
| 5000 K | (1.00, 0.88, 0.78) | sun at ~20° |
| 5500 K | (1.00, 0.93, 0.87) | sun at 40°+ |
| 12,000 K | (0.67, 0.80, 1.00) | sky fill, moderate |
| **15,000 K** | **(0.63, 0.76, 1.00)** | **our sky fill, clear high alt.** |
| 18,000 K | (0.60, 0.74, 1.00) | very clean cold zenith |

Recommendation: `sunColor` ≈ **(1.00, 0.82, 0.68)** scaled to intensity,
`ambientColor` ≈ **(0.63, 0.76, 1.00)**. Then check the *result* against LAW 1
and LAW 2 in §1.2 — the sunlit snow must come out neutral (B/R 0.99–1.06) after
tone mapping despite the warm sun and the blue fill, because the two cancel.
If your sunlit snow renders orange, your sun is too warm or your exposure too
low; if it renders blue, your fill is winning and the sun is too weak.

### 4.3 Dynamic range and exposure

Absolute luminances in the real scene:

| | cd/m² |
| --- | --- |
| Sun disc (through AM 5.4) | ~1.6 × 10⁹ |
| Sunlit snow | 12,000–20,000 |
| Clear sky near the sun | 8,000–15,000 |
| Clear sky, anti-solar | 2,000–4,000 |
| Shadowed snow | 3,000–6,000 |
| Shadowed rock | 300–900 |

That is roughly **17 stops** from shadowed rock to the sun disc. The display
gets 8. So:

- **Middle grey maps to ~0.18; sunlit snow lands at 0.75–0.90 in the tone-mapped
  output, not 1.0.** This is the photographic "+1.7 to +2 stop snow
  compensation" expressed in render terms — a meter left alone renders snow as
  18% grey, so you push up, but you push up *into a shoulder*, not off a cliff.
- **`CONFIG.render.toneMapping = 'agx'` is the correct choice and should not be
  changed.** AgX desaturates into the highlight (which is what film does and
  what our eyes expect), and it has a long, gentle shoulder. ACES has a
  well-known blue→cyan and red→orange skew; on a frame that is 70% blue-white
  snow, ACES tilts the whole image cyan and crushes the sky's saturation.
  Reinhard has no shoulder worth the name. Linear/clamp is an instant fail.
- `CONFIG.render.exposure = 1.05` is a good anchor. The verification is the
  histogram, not the number: median luma 120–200, p99.9 ≤ 252, clipped
  fraction ≤ 0.2% (sun out of frame).
- **Highlight rolloff must be visible as *retained detail*.** Look at `ref_02`:
  the sunlit concrete-adjacent snow holds surface modulation all the way to
  `#F1F2F6`. If your sunlit snow is a flat plateau of one value, the shoulder
  is too short or your exposure is too high.

### 4.4 Shadows

The sun at 10.6° is brutal on shadow-mapping. Requirements:

- **Normal-offset bias, not constant depth bias.** At grazing incidence the
  depth gradient across a texel is enormous and constant bias either acnes or
  peter-pans. Offset the sample position along the geometric normal by
  ~1.5 texel-world-widths × sqrt(1 − (N·L)²).
- `CONFIG.render.csmCascades = [0, 28, 90, 260, 900]`. Four cascades. Cascade 0
  at 28 m must resolve the rider's own shadow crisply — that shadow is 9.6 m
  long and is a hero element in every third-person frame.
- **Blend cascades over ~10% of each split's range.** A visible hard line
  across a snow slope where the cascade changes is one of the most immediately
  recognisable "this is a game" artefacts, and on uniform white snow there is
  nothing to hide it.
- **Soft edges.** A 10.6°-elevation shadow on snow has a penumbra that widens
  fast with distance from the caster. PCF with a receiver-distance-scaled
  kernel (or PCSS if affordable): ~2–3 px penumbra at the contact point,
  10–20 px at 8 m from the caster. A uniformly hard-edged 9.6 m shadow is wrong.
- Shadow *colour* comes from the fill, not from multiplying to black. The
  shadow term must attenuate the **sun** contribution only; the sky and bounce
  terms keep lighting the surface. This is how LAW 3 is satisfied structurally
  rather than by fudging a "shadow tint".

---

## 5. Aerial perspective

If you do one thing in this document, do this one. It is the highest
believability-per-instruction effect in the entire renderer.

### 5.1 The physics, with coefficients

Standard sea-level scattering coefficients (Bruneton/Nishita set), for
λ = (680, 550, 440) nm:

```
β_Rayleigh(sea level) = (5.8e-6, 13.5e-6, 33.1e-6)  m⁻¹     H_R = 8000 m
β_Mie(sea level)      = 21e-6 (grey)                m⁻¹     H_M = 1200 m,  g = 0.76
β_Ozone (25 km layer) = (0.65e-6, 1.881e-6, 0.085e-6) m⁻¹   (optional; deepens zenith blue)
```

Blue scatters **5.7×** more than red. That ratio *is* aerial perspective.

At the basin's 1800 m:

```
Rayleigh density factor = exp(−1800/8000) = 0.80  →  β_R = (4.6e-6, 10.8e-6, 26.5e-6)
Mie      density factor = exp(−1800/1200) = 0.223 →  β_M = 4.7e-6
```

**Mie is 4.5× weaker at 1800 m than at sea level.** That is precisely why alpine
distance goes *blue* while coastal distance goes *milky grey*. Do not model our
far field with a grey haze; model it with a blue-selective extinction.

Transmittance `T = exp(−β·d)` at the backdrop radius (`CONFIG.terrain.backdropRadius = 26000`):

| Channel | β (m⁻¹) | T at 26 km |
| --- | --- | --- |
| R | 4.6e-6 | **0.887** |
| G | 10.8e-6 | **0.755** |
| B | 26.5e-6 | **0.502** |

So a snow ridge at 26 km keeps 89% of its red, 76% of its green and **50% of
its blue** — plus a large, strongly-blue inscattering term added on top. Net:
the Crown Range backdrop should read as **the sky colour at that elevation
angle with only 10–20% of its own contrast surviving**.

### 5.2 The rule everyone gets wrong

**Distant terrain fades toward the sky colour *at the same elevation angle*,
not toward the horizon colour, and definitely not toward a single fog colour.**

A ridge whose crest sits 8° above the horizon fades toward the sky at 8°. A
peak at 20° fades toward the sky at 20° — which is measurably darker and more
saturated. Fade everything toward one horizon colour and you get the classic
artefact where **mountain peaks are paler than the sky behind them** — an
impossible image that the eye rejects instantly even when the viewer cannot say
why.

Implementation: compute inscattering as a function of the view ray, exactly as
the sky shader already does, and apply it per-pixel to terrain. `THREE.Fog` /
`FogExp2` with a single colour **cannot do this** and must not be used as the
primary aerial-perspective mechanism. If a legacy fog uniform is needed for
compatibility, drive its colour from the per-pixel sky lookup.

### 5.3 The near range needs help, honestly

Pure molecular Rayleigh at the playable-basin scale is almost nothing:

| Distance | T_R | T_G | T_B |
| --- | --- | --- | --- |
| 500 m | 0.998 | 0.995 | 0.987 |
| 2000 m | 0.991 | 0.979 | 0.948 |
| 4000 m | 0.982 | 0.958 | 0.899 |

Only ~5% blue loss at 2 km. Yet the references show a 4–8× near/far contrast
ratio *within a couple of kilometres*. That gap is real and it is not filled by
cranking a uniform fog — `CONFIG.world.visibility = 42000` forbids a milky
frame. It is filled by four things, in this order:

1. **Geometric detail falloff.** A 30 cm sastrugi ridge at 800 m subtends
   0.02° — well under a pixel. If your detail normal map is still at full
   strength at 800 m you are manufacturing contrast that physics deleted. Fade
   detail-normal amplitude to zero over 40 → 250 m, and fade glints out by 40 m.
   *Most of the missing far-field contrast reduction is an LOD bug, not a fog
   bug.*
2. **A valley haze layer.** Real basins pool cold, slightly hazy air. Add an
   exponential-height term: β_H = **8e-5 m⁻¹** at 1400 m with a **250 m scale
   height**. At 3 km along the basin floor that gives T = exp(−0.24) = 0.79 — a
   clearly visible softening that vanishes entirely at ridge level, which is
   exactly the real behaviour. Sanity check against CONFIG: total green-channel
   extinction ≈ 10.8e-6 + 4.7e-6 + 8e-5 = 9.6e-5 m⁻¹, giving a meteorological
   visual range of 3.912/9.6e-5 = **41 km** — matching
   `CONFIG.world.visibility = 42000`. The numbers are consistent; use them.
3. **Spindrift and ice-crystal haze on the crests.** `CONFIG.world.windSpeed =
   4.2 m/s` from 292° — enough to lift surface snow off exposed ridges. A thin
   blowing-snow band along the ridgelines is both physically right and a
   massive believability win.
4. **Veiling glare.** See §7.1. In `ref_19` and `ref_08` it is *glare*, not fog,
   that lifts the mid-distance blacks and collapses far-field contrast. This is
   the least-known and one of the most important mechanisms in the list.

### 5.4 Clouds in the terrain

`ref_19` and `ref_08` both show dense cloud banks **hugging and intersecting
the ridgelines** — bright rims, grey-blue cores, soft edges dissolving into the
slope. They sit *in* the terrain, not above it. `docs/REFERENCE_ANALYSIS.md`
calls this "a huge believability contributor and usually missing from procedural
scenes", and that is correct. A sky dome with a few flat billboards floating at
altitude is not a substitute. Target: one or two cloud banks at 1600–1900 m
(i.e. straddling our summit elevation of 1865 m) that visibly occlude and are
occluded by ridgelines.

---

## 6. Materials other than snow

### 6.1 Schist rock

The most important non-snow material we have. `props.js` and
`snowMaterial.createRockMaterial` own it.

- Base colour lit `#7A7268`, shadowed `#3E4453` — note the shadow is **blue-
  shifted**, same physics as the snow: it is lit by sky and by snow bounce.
- Roughness 0.55–0.80. Wet-looking rock is wrong at −6.5 °C.
- **Foliation.** Otago schist is platy and strongly layered. The surface must
  show parallel banding at a consistent local orientation, with fracture edges
  perpendicular to it. Isotropic noise-bumped grey rock is a tell.
- **Lichen.** Sparse patches of `#B8B24A` (sulphur) and `#B0642A` (rust) at
  2–8% coverage, biased to sun-exposed faces.
- **Every ledge holds snow.** A rock outcrop with clean bare faces and no snow
  in the horizontal breaks is fake. Blend snow onto any surface with
  `N·up > 0.55`, with a soft, drift-shaped transition, plus a thin rime dusting
  on the windward (292°) side.
- **Snow-rock boundaries are never razor edges.** There is always a wind moat
  (a 10–40 cm gap where the rock's absorbed heat has melted the snow back), a
  drift lip on the lee side, or a melt-out ring. A hard geometric intersection
  between a white mesh and a grey mesh is one of the most damning tells in the
  whole document.

### 6.2 Tussock

Gold-brown `#B08A4E` lit / `#6A5738` shadowed, in wind-scoured patches on
convex ridge shoulders and on the windward side of outcrops. Individual blades
0.3–0.6 m, splayed, with a strong **translucent backlit rim** when the low sun
is behind them — at 10.6° elevation, backlit tussock glows and is worth the
shader cost. This is our substitute for the reference set's autumn trees.

### 6.3 Outerwear (rider)

From `ref_12`, `ref_15`, `ref_21`: modern coated-nylon/polyester shell.

- Roughness 0.38–0.55, F0 0.04, **plus a sheen term** — fabric fuzz produces a
  grazing-angle brightening that neither plain diffuse nor plain GGX captures.
  Without sheen, outerwear reads as painted plastic; with too much, as satin.
- **Panel seams, zips, drawcord hems, pocket flaps, cuff tabs** as geometry or
  normal detail. The reference character is unambiguously *constructed*, not a
  single smooth shell.
- Colour: **one** high-chroma jacket colour per rider (`#E8531F` orange,
  `#C41E23` red, `#1E3A8A` navy, or white `#EDEDF0`), with the pants in a
  neutral (charcoal `#3A3A3E`, stone `#D8D5CE`). Never two saturated colours.

### 6.4 Helmet, goggles, board

- **Helmet:** hard shell, roughness 0.25–0.35, a visible shell seam and vent
  slots.
- **Goggle lens:** the highest value-per-square-centimetre surface in the
  entire game. Mirrored, roughness 0.05–0.12, coloured metallic tint
  (gold/orange `#E8A030`, or purple-blue `#7080C8`). A goggle that **reflects
  the sky gradient and the snow horizon line** reads as expensive instantly.
  `ref_15` and `ref_21` both make the goggle the focal point of the frame.
- **Board base:** roughness 0.08–0.18, high gloss, a printed graphic, and a
  **visible steel edge** — a thin bright metallic strip that catches the low sun
  and draws the eye along the board's arc. `ref_12` and `ref_15` both show it.
- **No face.** Balaclava, buff, or full-face goggle+helmet coverage. The
  Shredders team explicitly avoided animated faces for budget reasons and it is
  the correct call for us too. There is no uncanny valley if there is no face.
- Silhouette outranks shading: from 30 m the rider is a dark shape, and that
  shape must instantly read as "snowboarder" — knees bent, board across the
  fall line, arms out for balance.

---

## 7. The post-processing look

`fx/postprocess.js` owns this. `CONFIG.post` holds the numbers. Order matters:

```
scene HDR → SSAO → motion blur → DoF → bloom (2-tier) → tone map (AgX)
          → grade → chromatic aberration → grain → vignette → sharpen
```

Note grain and CA come **after** tone mapping (they are sensor/lens artefacts,
not scene radiance) and sharpening comes last (it must restore edges that DoF,
motion blur and AA softened).

### 7.1 Bloom and veiling glare — two tiers, not one

This is the effect that most defines the snowboarding-game look, and a single
mid-radius bloom pass will not produce it.

- **Tier 1 — the sun and the glints.** High threshold (~1.2 in linear /
  post-exposure), small-to-medium radius, strength ~0.30. Produces the tight
  core glow on the sun and makes individual crystal glints bloom into visible
  stars.
- **Tier 2 — veiling glare off the snowfield.** Low threshold (~0.75), very
  large radius, low strength (~0.10–0.15). This is light scattering inside the
  lens because 70% of the frame is a 15,000 cd/m² white field. It **lifts the
  blacks across the whole image**, softens the mid-distance, and is a large part
  of why the reference frames' far field has such low contrast. Measured in
  `ref_19`/`ref_08`: the glare envelope around the sun bleeds **200–500 px at
  1920 wide (10–25% of frame width)** and visibly washes across the cloud bank
  and the mid-distance slopes.

`CONFIG.post.bloom = { threshold: 0.86, strength: 0.42, radius: 0.55 }` should
be read as the *combined* budget; split it across the two tiers.

**Failure modes:** a threshold low enough that the entire snowfield glows
("everything is bloom"); a bloom that is bright but *tight*, giving a hard
halo instead of a soft veil; and the sun rendered as a hard-edged disc. At
10.6° elevation through air mass 5.4, the sun is a large soft glowing blob with
a gradual falloff — see `ref_19`, where there is no discernible disc edge at all.

**Absolutely forbidden:** hexagonal aperture ghosts, anamorphic streak sprites,
or any pre-authored lens-flare texture. That is a 2008 tell and it will fail
review immediately. If a streak is wanted, derive it physically from the
bloom buffer.

### 7.2 Depth of field

Snowboard films are shot two ways: long-lens follow (f/4–f/8, shallow) and
GoPro/gimbal follow (tiny sensor, near-infinite DoF). Our chase camera is the
second. Therefore:

- **Chase mode: DoF is barely present.** Focus on the rider, near-focus
  softening only within ~1.5 m of the lens, and a very slight far softening
  beyond ~60 m. `CONFIG.post.dof = { focusDistance: 9, aperture: 0.9,
  maxBlur: 0.012 }` — a max blur of 1.2% of screen height ≈ 13 px at 1080p,
  which is the right ceiling.
- **Never bokeh the mountain.** A soft distant ridge reads as a miniature. This
  is the "tilt-shift" tell and it destroys scale.
- **Cinematic mode may open up:** maxBlur 0.020, focus locked to the rider, the
  near snow bank going soft. Reserve it for replay/hero shots.
- DoF must not shimmer or bleed. On a near-uniform white field, a badly
  bilateral-filtered CoC produces visible blotching that has nothing to hide
  behind.

### 7.3 Motion blur

- **180° shutter** (exposure = half the frame time) is the film standard and the
  right target. At 60 fps that is 1/120 s; at 25 m/s the camera translates
  0.21 m during the exposure — enough to smear the near snow and the spray, not
  enough to smear the rider.
- **Object motion blur matters more than camera motion blur.** The board and the
  hands moving *relative to the camera* during a hard carve is what sells the
  carve. A camera-only blur just smears the whole frame.
- `CONFIG.post.motionBlur = { strength: 0.55, samples: 12 }` is about right.
  12 samples is the floor — fewer and you get visible ghost steps on the
  high-contrast rider-against-snow edge.
- Blur must **not** be applied to the sky (infinite depth, zero parallax) or you
  get a smeared sun.

### 7.4 Grain, chromatic aberration, vignette

- **Grain:** σ = 0.015–0.030 in output units (`CONFIG.post.grain.strength =
  0.022` ✓), applied **after** tone mapping. Critically, weight it **away from
  the highlights**: real film grain is finest in the highlights and coarsest in
  the mid-tones and shadows; digital sensor noise is the opposite. Multiply by
  something like `(1 − L)^0.5`. Uniform full-strength grain over a 70%-white
  frame reads as **dirt on the lens**, and it is one of the most common
  amateur-render tells. Grain must also be **temporally deterministic** — seed
  it from `ctx.frame`, never `Math.random()`.
- **Chromatic aberration:** lateral (transverse) only — scale the R and B
  sample positions radially by different factors. Max displacement
  0.0015–0.0025 of frame width at the corners (`CONFIG.post.chromatic.strength
  = 0.0018` ✓), and **exactly zero inside the central 40% radius**. Any colour
  fringing visible at frame centre is a fail. Longitudinal CA (a uniform
  full-frame colour split) is not a real lens artefact and must not be used.
- **Vignette:** 0.30–0.40 corner falloff (`CONFIG.post.vignette.strength = 0.34`
  ✓), smooth, starting at ~0.55 of the frame radius, following a cos⁴-ish curve.
  On a uniformly bright snowfield the eye *knows* the field is even, so a hard
  or heavy vignette is spotted instantly. If a viewer can consciously see the
  vignette, it is too strong.

### 7.5 SSAO on snow — a special case

`CONFIG.post.ssao = { radius: 0.6, intensity: 0.75 }`. Snow AO has two rules
that differ from every other material:

1. **AO attenuates the sky/ambient term only, never the sun term.** Sun
   visibility is the shadow map's job. Multiplying the direct sun by AO
   double-darkens and produces the grey-smudge-in-the-crease look.
2. **AO on snow must be tinted, not neutral.** An occluded pocket of snow sees
   less sky *and* more of the surrounding snow's own multiply-scattered light —
   it goes **bluer and softer**, not grey. Tint the occluded result toward
   `CONFIG.snow.sssColor`, and clamp the minimum AO to ~0.45 so no crease ever
   goes to grey mud. **Grey dirt in the concavities is a top-5 tell.**

### 7.6 The grade

Cool shadows, neutral-to-warm highlights, lifted blacks. As an ASC-CDL:

```
slope  = (1.000, 1.000, 1.020)
offset = (+0.004, +0.006, +0.012)      // lifts the shadows blue
power  = (1.020, 1.000, 0.980)
saturation = 1.05 – 1.12
```

**These are single-digit-percent moves and that is the point.** The blue in the
shadows must come from the *lighting*, not from the grade. Diagnostic: disable
the grade entirely. If the frame stops reading as snow, the lighting is wrong
and the grade was covering for it. A grade doing more than ~10% of the work is
a bug report against `sky.js`, not a win.

Never crush the blacks on snow. Lifted, blue-tinted shadows are the look.

### 7.7 Anti-aliasing and determinism

Snow's glint field and the rider's steel edge alias viciously. `MAX_SAMPLES = 4`
on the SwiftShader target, so 4× MSAA on the main pass is available and worth
it where affordable. If temporal jitter is used for extra quality, the jitter
sequence **must** be a deterministic function of `ctx.frame` (a fixed Halton
2,3 sequence indexed by the frame counter) — the harness diffs frames across
runs and any `Math.random()` in the jitter breaks it. Sharpening
(`CONFIG.post.sharpen.strength = 0.32`) is contrast-adaptive and must not
produce a bright halo along the ridge-against-sky boundary; that halo is a
distinctive over-sharpening tell and is highly visible on a blue/white edge.

---

## 8. Camera language

`player/camera.js` owns this. `CONFIG.camera` holds the numbers.

### 8.1 Framing

`fov: 62` is Three.js's **vertical** FOV. At 16:9 that is a horizontal FOV of
`2·atan(tan(31°)·16/9) = 93.8°` — GoPro Linear territory (~90° H). That is the
right register for a follow-cam and matches player descriptions of Shredders as
"follow close and follow even closer".

Two consequences:

- **Keep the rider inside the central 60% of frame.** At 94° horizontal, edge
  stretching is severe and a rider at the frame edge distorts visibly.
- **Hero and beauty shots should drop to 35–45° vertical** (58–72° horizontal),
  which is where snowboard-film long-lens shots live. That compression is what
  makes the backdrop mountains loom. The capture harness should have at least
  one preset at ~40°.

`followDistance: 6.4`, `followHeight: 2.1` → the camera looks down at
`atan(2.1/6.4) = 18.2°`. On a 28° pitch that puts the camera above the slope
surface with the rider silhouetted against the terrain falling away below —
correct, and it is the framing in `ref_08`.

### 8.2 Speed response

- FOV widens with speed: `62 + 0.42 × speed`, capped at 82. At `maxSpeed = 34`
  that yields 76.3°.
- **Asymmetric, heavily damped.** Rise λ ≈ 1.5–2.5 (≈0.8–1.2 s), fall λ ≈ 0.8–1.2
  (≈1.5–2 s). **FOV that pumps with every bump is one of the most visible camera
  tells there is.** The player should never consciously notice the FOV moving;
  they should only notice that fast feels fast.
- The strongest speed cue is **not** FOV — it is **near-field parallax**. The
  snow surface must sweep past the bottom of frame. Keep the camera low enough
  that the ground occupies the **bottom 15–25% of frame**. A high camera over an
  empty white field cannot be made to feel fast by any amount of FOV or blur.
- `shakeAtSpeed: 0.35`: low-amplitude, **low-frequency (2–5 Hz)** positional
  noise scaled by speed × surface roughness, angular amplitude ≤ 0.5°.
  High-frequency shake reads as a broken spring, not as velocity. Drive it from
  a `Simplex` sampled at `ctx.elapsed`, never from per-frame random.

### 8.3 Carving

- **The camera yaw lags the rider's heading.** Target λ ≈ 3.5–5.0, i.e. a
  0.2–0.3 s lag. A camera that tracks heading instantly makes the *world* rotate
  around a locked rider, which is the single most common third-person camera
  failure and it makes carving unreadable.
- **The camera should follow the fall line more than the board heading.** During
  a carve the rider drifts laterally across frame. *That drift is what makes a
  carve read as a carve.* Blend the camera's target yaw ~65% fall line / ~35%
  board heading while `physics.state.carving` is true.
- **Slight bank.** Roll the camera with the rider's edge angle at 0.15–0.25×,
  **maximum 3–8°**. More than that and it reads as a rollercoaster.

### 8.4 Air and impact

- On takeoff (`grounded` → false): ease the camera back 15–25% over ~0.3 s and
  lower the pitch so the rider rises in frame with ground visible beneath.
  Nothing sells air like seeing the gap.
- On landing: a short compression impulse — the camera dips 0.15–0.30 m and
  returns over 0.12–0.20 s, critically damped. **Not a shake.** Scale by
  `physics.state.gForce`.
- On crash: hold, do not cut. Let the ragdoll play out with the camera settling
  to a wider, slightly higher framing.

### 8.5 Modes

| Mode | FOV (v) | Distance | Notes |
| --- | --- | --- | --- |
| `chase` | 62 → 82 by speed | 6.4 m | default; GoPro register |
| `cinematic` | 38–45 | 12–25 m | long lens, DoF open, slow orbit; hero shots |
| `firstPerson` | 78–90 | 0 | helmet-cam; strong head bob at 1.5–3 Hz |
| `orbit` | 45 | 8–14 m | replay |
| `free` | 55 | — | debug |

---

## 9. Composition and set dressing

An all-white field has no image in it. Every reference frame is carried by
something that is *not* snow.

1. **Silhouettes.** Rock outcrops, poles, fences, lift towers, the rider. Target
   at least **three distinct non-snow silhouette elements** in any hero frame.
   Since we have no trees (§2), this is on `props.js`.
2. **Saturated accents, few and small.** In `ref_08` the red jacket, red
   banners and orange fence together occupy roughly 3% of frame; everything else
   is desaturated. The recipe is **1.5–6% of pixels at high chroma** (HSV S ≥
   0.45, V ≥ 0.4). A field of many medium-saturation colours reads cheap; a
   desaturated field with two or three tiny hot accents reads expensive. Our
   accent palette: orange `#E8531F` (poles, fence netting, jacket), red
   `#C41E23` (lift cars, banners), and the tussock gold `#B08A4E`.
3. **History.** Every single reference frame has tracks, corduroy, or carve
   trenches. Untouched snow across the entire frame reads as a raw heightfield.
   Even a "fresh pow" shot should have old tracks in the mid-distance, a skin
   track traversing a ridge, or a groomer line. `fx/trails.js` handles the
   player's own; `terrain.js`/`props.js` must supply the pre-existing ones.
4. **Scale.** Nothing in a snow frame has intrinsic scale. A 2 m wind lip and a
   200 m ridge are the same shape. Without a rider, a pole, or a lift tower the
   viewer cannot size the mountain and the image feels like a maquette.
5. **Cloud in the terrain.** See §5.4.
6. **Foreground occlusion.** A near snow bank, a rock, or a pole partially
   entering the frame edge creates depth layering immediately. `ref_19` uses a
   gondola cable and car across the top-right corner for exactly this.

---

## 10. HUD

`ui/hud.js` owns this. Rules specific to a white-field game:

- **Never pure white at 100% alpha.** On snow it disappears. Use near-white
  (`#F2F4F8`) at 0.88–0.94 alpha over a **soft dark scrim** — either a 2 px,
  40%-opacity dark outline, or a subtle radial darkening behind the element
  (never a hard rounded rectangle).
- **Tabular figures.** Speed and score digits must be monospaced-width or the
  readout jitters as digits change. This is a small detail that separates
  shipped UI from prototype UI.
- **Condensed grotesque, tight tracking, generous letter height.** Weight 600–
  700 for numerals, 400–500 for labels. Since we cannot ship a font file, draw
  the numerals procedurally or use the system UI stack with a fallback chain.
- **One accent colour**, matching the rider's jacket accent. No rainbow.
- **Stay out of the centre 50%.** The rider lives there. Speed bottom-left, air
  time / trick call-out lower-centre-but-below-the-rider, combo upper-right,
  timer upper-left.
- **Motion.** Trick call-outs should appear with a fast (~120 ms) ease-out and
  leave with a slower (~350 ms) fade. Nothing bounces, nothing spins.
- Whether DOM overlay or rendered quad, it **must appear in a Playwright
  screenshot** — verify explicitly against the harness.

---

## 11. The tells: what makes CG snow look fake

This is the critic's checklist. Be brutal with it.

### Lighting
1. **Grey or black shadows on snow.** The definitive tell. See LAW 2.
2. **Weak fill.** Shadows at 0.05–0.15 of sunlit instead of 0.22–0.56. See LAW 3.
3. **Black undersides.** No snow bounce onto the rider's chin, the board base,
   rock overhangs, or the underside of a cornice. §4.1 — the bounce is ~2× the
   sky fill; nothing should be a void.
4. **A hard Lambert terminator** on a rolling snow surface. Real snow's
   terminator is soft and wide because of multiple scattering.
5. **Shadow length inconsistent with the stated sun elevation.** At 10.6°, a
   1.8 m rider casts 9.6 m. A 2 m shadow means a 42° sun and a noon-flat frame.
6. **Shadow-map acne, peter-panning, or a visible cascade seam** across a slope.
7. **Uniformly hard-edged shadows** with no penumbra growth over 9 m of length.
8. **Northern-hemisphere sun** (in the south of the sky). We are at −44.9°.

### Snow material
9. **Snow clipped to pure white** with a flat detail-free plateau.
10. **Pure white albedo (1,1,1).** Real is 0.86 and renders to ~`#EFEEF3`.
11. **The whole frame tinted blue**, including sunlit snow. Violates LAW 1.
12. **Uniform sparkle everywhere, at every distance** — the "glitter texture on
    a plane" tell. Real glints are sparse, intense, view-dependent, clustered
    near the specular direction, and gone past ~40 m.
13. **No forward-scatter behaviour.** The slope looks identical looking up-sun
    and down-sun. Real snow's forward peak is 3–5× nadir.
14. **A visible tiling period** in the detail normal or albedo — the wallpaper
    tell. Use ≥3 octaves at non-harmonic scales (e.g. 0.37 m / 1.9 m / 11 m)
    plus a low-frequency breakup mask.
15. **Over-texturing.** `docs/REFERENCE_ANALYSIS.md` is explicit: Shredders'
    snow is mostly smooth. High-frequency normal detail at full strength across
    the whole slope is a *tell*, not a fix.
16. **Detail that does not fade with distance.** Sastrugi at 800 m subtends
    0.02° — it must be gone.
17. **Grey AO mud in the concavities.** §7.5.
18. **No wetness/compression variation.** One snow everywhere.

### Terrain
19. **Perfectly smooth, uninterrupted heightfield.** No sastrugi, no wind lips,
    no cornices, no rollers, no runnels, no debris.
20. **Fractal at every scale with no geology.** Real mountains have *direction*:
    ridges run somewhere, gullies drain somewhere, snow loads on lee aspects and
    scours on windward ones. With wind from 292°, the NW faces are scoured
    (rock and windpack showing) and the SE faces are loaded (deep, smooth,
    with cornices on the crests). Ignoring that is a tell to anyone who has
    stood on a mountain.
21. **Snow at impossible angles.** Snow does not hold above ~55°; deep
    unconsolidated snow not above ~45°. A uniformly white 70° face is fake — it
    should be rock, ice, or a sluff-scoured runnel.
22. **Razor-edge snow/rock boundaries.** §6.1.
23. **Objects sitting *on* the surface like decals** instead of *in* a drift,
    with no accumulation on their upper faces and no scour pit on the lee side.
24. **No contact shadow / occlusion** where a pole or rock meets snow.
25. **No tracks or history anywhere in frame.**
26. **Repeated prop instances in an obvious grid or at an obvious spacing.**

### Atmosphere
27. **No aerial perspective**, or aerial perspective as one flat `THREE.Fog`
    colour.
28. **Peaks paler than the sky behind them** — the "faded to horizon colour"
    artefact. §5.2.
29. **A visible band where the fogged ridge meets the sky.**
30. **Uniform-height haze with no vertical structure.** Real valley haze pools.
31. **Distant mountains with the same contrast and texture frequency as near
    terrain.** Target 4–8× near/far local-contrast ratio.
32. **Milky grey distance** instead of blue. At 1800 m, Mie is 4.5× weaker than
    at sea level; the distance goes *blue*.

### Sky
33. **Flat pale sky blue** instead of the measured deep `#004482`–`#1E558D`
    top-of-frame.
34. **A sky gradient with no sun-relative structure** — no Mie forward-scatter
    halo around the sun, no darkening toward the anti-solar zenith.
35. **8-bit banding** in the sky gradient. Render in float or dither.
36. **Billboard clouds floating above the terrain with hard bottom edges**,
    rather than volumes intersecting the ridgelines.
37. **The sun as a hard-edged disc with a small tight halo.** At AM 5.4 it is a
    huge soft blob.

### Post
38. **Everything-is-bloom** — a threshold low enough that the whole snowfield
    glows.
39. **No veiling glare at all** — an impossibly clean, high-contrast frame with
    the sun in it.
40. **Hexagonal ghosts or anamorphic streak sprites.** Forbidden.
41. **A consciously visible vignette or chromatic aberration.**
42. **Uniform full-strength grain over the white field** — reads as lens dirt.
43. **Bokeh'd mountains** — the tilt-shift/miniature tell.
44. **Over-sharpening haloes** on the ridge-against-sky edge.
45. **Crushed blacks.** Snow scenes have lifted, blue shadows.

### Motion, particles, camera
46. **Camera-facing white squares with a soft-round alpha** for spray — the
    default-particle tell. Spray must be many small (2–8 cm) elements,
    motion-stretched, *lit* (bright toward the sun, blue away from it),
    turbulent, and it must **hang**: dry cold spray has a 1.5–3 s fall time.
47. **Symmetric spray from under the board** instead of thrown off the engaged
    edge, and spray that continues after the edge disengages.
48. **Spray that is pure white.** It is a translucent medium — its shadowed side
    is blue and its sun side is blown out. Both, in the same plume.
49. **Carve trails as a flat decal stripe** instead of a trench with a shadowed
    inner wall, a bright displaced lip, and a soft outer feather.
50. **Trails that appear instantly at full depth** instead of being cut
    progressively.
51. **Camera that tracks heading instantly**, rotating the world around a locked
    rider.
52. **FOV that pumps visibly** with every speed fluctuation.
53. **No near-field parallax** — nothing close enough to sweep past.
54. **High-frequency camera shake** standing in for speed.
55. **Nothing in frame that gives scale.**

---

## 12. Colour script (quick reference)

Output-referred sRGB hex, post-tone-map, for a bluebird 09:40 basin frame.

| Element | Sunlit | Shadowed |
| --- | --- | --- |
| Snow, fresh | `#EFEEF3` – `#F6F4F8` | `#8E9AC0` – `#A8B4D4` |
| Snow, mid-tone | `#D6D6E0` | `#96A2C4` |
| Deep trench / cornice undercut | — | `#5F6C8E`, cyan-biased `#7FA0C8` |
| Groomed corduroy | `#E4E4EC` (banded ±4%) | `#93A0C2` |
| Schist rock | `#7A7268` | `#3E4453` |
| Tussock | `#B08A4E` | `#6A5738` |
| Sky, top of frame | `#0F4C8E` – `#2A64A6` | — |
| Sky, mid | `#4C86C6` | — |
| Sky, horizon | `#C2D4EA` | — |
| Sun halo | `#FFF6E6` → `#E8F0FF` | — |
| Ridge at 2–6 km | `#9CAECB` (15–25% own contrast) | — |
| Backdrop at > 12 km | `#A9BCD6` (10–20% own contrast) | — |
| Accent orange | `#E8531F` | `#8E3416` |
| Accent red | `#C41E23` | `#75161A` |
| HUD near-white | `#F2F4F8` @ 0.90 alpha | — |

---

## AAA ACCEPTANCE CHECKLIST

A screenshot must satisfy **all** of the following to pass as AAA. Each item is
visually checkable, and most are numerically checkable by sampling the PNG. The
"snow population" means pixels with `saturation < 0.30 && B >= R−4 && max > 55`
in the bottom 55% of the frame; "sunlit" is that population's 93rd percentile
and "shadowed" its 10th percentile.

**Tone and exposure**

1. Pure-white pixels (all channels ≥ 254) are **≤ 0.20%** of the frame when the
   sun is out of frame, **≤ 3.0%** when it is in frame.
2. The 99.9th-percentile frame luma is **≤ 252**. Nothing is a clipped plateau.
3. Median frame luma is in **[110, 210]**.
4. The sunlit snow sample sits in sRGB **`#DC…`–`#FA…`** (0xDC–0xFA per channel)
   and visibly retains surface modulation — not one flat value.
5. Mean frame saturation is in **[0.18, 0.36]**.

**Snow lighting — the three laws**

6. **Sunlit snow is neutral:** B/R of the sunlit sample ∈ **[0.99, 1.06]**.
7. **Shadowed snow is blue:** B/R of the shadowed sample ≥ **1.20** (target
   1.25–1.40).
8. **The fill is strong:** linear luminance of shadowed ÷ sunlit ∈
   **[0.22, 0.55]**.
9. **Blue survives shadow better than red:** `(B_sha/B_sun) ÷ (R_sha/R_sun)` in
   linear ∈ **[1.4, 2.1]**.
10. The darkest 1% of pixels sits at sRGB **≥ 20** except for deliberate
    silhouettes (rider against sky, cables, goggle strap). No black voids.
11. A downward-facing surface in frame — the board base, a rock overhang, the
    rider's chin — is lit at **≥ 0.30×** the sunlit snow's linear luminance.

**Sun and shadow geometry**

12. The rider's cast shadow is **≥ 4.5× the rider's height** in ground length,
    consistent with a ≤ 13° sun.
13. Shadow edges show visible **penumbra growth** with distance from the caster.
14. There is **no cascade seam**, no acne, and no peter-panning anywhere.
15. The sun (if in frame) is a **soft blob**, not a hard disc, and its glare
    envelope spans **≥ 8% of frame width** at ≥ 20% above the local background.
16. The sun is in the **northern** half of the sky.

**Aerial perspective**

17. Near-field 32 px-tile luma σ ÷ far-field σ is **≥ 4.0** (target 6–8).
18. The far field is **bluer** than the near field: far B/R > near B/R + 0.08.
19. No distant ridge is **paler than the sky immediately above it**.
20. There is **no visible band or discontinuity** where a fogged ridge meets sky.
21. Haze has **vertical structure** — the basin floor is hazier than the crests.

**Sky**

22. Top-of-frame sky in bluebird conditions is **deep and saturated**: HSV
    S ≥ 0.45, and its luma differs from the horizon sky by **≥ 45 sRGB levels**.
23. The sky gradient shows **no banding** (no visible contour steps).
24. The sky brightens toward the sun (Mie halo) and is not a pure vertical ramp.

**Snow surface**

25. Glint pixels are **< 0.5%** of the snow area, are **sparse and intense**
    rather than a uniform field, and **none are visible beyond ~40 m**.
26. There is **no visible tiling period** in the snow at any distance.
27. Detail-normal amplitude visibly **falls off with distance**; the far field is
    smooth.
28. **History is present**: at least one carve trench, groomer line, skin track,
    or old track in the near-to-mid field.
29. Concavities (trench interiors, drift undercuts) show a **cyan-blue transport
    tint**, and AO nowhere reads as neutral grey mud.
30. No snow surface in frame is **steeper than 55°**.
31. Snow/rock boundaries show a **wind moat, drift lip, or melt-out ring** — no
    razor-edge intersections.

**Composition**

32. At least **three distinct non-snow silhouette elements** are in frame.
33. High-chroma pixels (HSV S ≥ 0.45 and V ≥ 0.4) are **1.5–6%** of the frame —
    present but scarce.
34. Something in frame **establishes scale** unambiguously.
35. Terrain shows **directional geology**: ridges, gullies, wind-loaded lee
    slopes and scoured windward slopes, consistent with the 292° wind.

**Rider (close shots)**

36. Helmet, goggles, jacket, pants, gloves, boots, bindings and board are
    **separately readable**, with panel seams, zips, binding straps and a
    printed board graphic.
37. The **goggle lens is mirrored** and visibly reflects the sky/horizon.
38. The **board's steel edge** is a visible bright metallic line.
39. Outerwear shows **fabric sheen at grazing angles** — not plastic, not flat
    diffuse.
40. The rider casts a **correctly shaped, crisp** shadow with a soft contact
    darkening under the board.
41. No face is visible.

**Motion and effects**

42. Spray is **motion-stretched, lit and turbulent** — not camera-facing white
    squares — and shows both a blown-out sun side and a blue shadow side.
43. Spray is thrown **asymmetrically off the engaged edge**.
44. Carve trails are **trenches** with a shadowed inner wall and a bright
    displaced lip, not flat decal stripes.

**Post**

45. There is a visible **soft veiling glare** lifting the mid-distance, distinct
    from any tight sun bloom.
46. The snowfield as a whole is **not glowing** — bloom is thresholded above the
    general snow level.
47. There are **no lens-flare sprites, hexagonal ghosts, or anamorphic streaks**.
48. Chromatic aberration is **zero inside the central 40% radius**.
49. The vignette is **not consciously visible**; corner falloff ≤ 40%.
50. Grain is **σ ≤ 0.03** and visibly **weaker in the highlights** than in the
    mid-tones.
51. Distant terrain is **in focus** — no miniature/tilt-shift effect.
52. There are **no sharpening haloes** on the ridge-against-sky edge.

**Camera and system**

53. The near ground occupies the **bottom 15–25%** of frame in chase mode,
    providing near-field parallax.
54. The rider sits within the **central 60%** of frame horizontally.
55. HUD text is **not pure white at full alpha**, uses tabular digits, and stays
    out of the central 50% of frame.
56. **Determinism:** two runs of the same shot preset produce a byte-identical
    PNG. No `Math.random()` anywhere in the visual pipeline, including grain,
    jitter, sparkle and camera shake.

---

*Measurements in §1 were taken from the 21 official Shredders frames in
`reference/shredders/` via programmatic pixel analysis. Scattering coefficients
follow the standard Bruneton/Nishita atmospheric parameter set. Snow optical
properties (albedo ranges, asymmetry parameter g ≈ 0.85–0.89, the 3–5× forward-
scatter to nadir reflectance ratio, and the grain-size/wetness albedo
relationship) follow the snow radiative-transfer and remote-sensing literature.
Solar position for Soho Basin is computed in §2.1 from `CONFIG.LOCATION` and
`CONFIG.world` and is reproducible.*
