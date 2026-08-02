# Soho Shred — Terrain Design Brief

**Status:** research + design spec. Binding reference for `src/world/terrain.js`, and the
authoritative source for terrain-adjacent decisions in `snowMaterial.js`, `props.js` and
`sky.js` (backdrop silhouettes).
**Author:** terrain research workstream. **Date:** 2026‑08‑02.
**Reference bar:** *Shredders* (FoamPunch, 2022) — photoreal-leaning alpine snowboarding.

This document has two halves:

* **Part 1 — Ground truth.** What Soho Basin and the Otago high country actually are,
  with real numbers.
* **Part 2 — The build spec.** A complete, tunable layout for the 2048 m × 2048 m playable
  box, in game coordinates, with an analytic base profile, a feature register with exact
  coordinates, surface classification rules, a wind/snow-depth model, and acceptance tests.

---

# PART 1 — GROUND TRUTH

## 1.1 Where Soho Basin is

Soho Basin is a glacially-scoured cirque on the western/south-western flank of the
**Mount Cardrona massif (1,936 m)**, in the **Crown Range**, Otago, South Island,
New Zealand. It sits immediately *behind* the ridge that forms the back of Cardrona
Alpine Resort's lift-served terrain — you reach it over the top of **Captain's Express
(top station 1,863 m)** or by following signage from the top of **McDougall's Chondola
(top station 1,835 m)**.

| Fact | Value | Source |
|---|---|---|
| Approx. centre of the basin | 44°52.7′S, 168°55.7′E (≈ −44.879, 168.928) | derived from LINZ features |
| Cardrona resort coordinates | 44°52′26″S, 168°57′00″E | Wikipedia |
| Basin elevation range (as an independent cat-ski field, pre-2025) | **1,425 m – 1,925 m**, 500 m vertical | skiresort.info |
| Lift-served vertical (Soho Express) | **379 m** | Doppelmayr / skiresort.info |
| Soho Express slope length | **1,237 m**, 5 m/s, 6-seat detachable, 3,000 pph, opened winter 2025 | skiresort.info |
| Implied mean lift-line gradient | **17.9°** (32%) — 379 m rise over 1,177 m horizontal | computed |
| Terrain added to Cardrona | **150 ha (370 ac)**; resort total now 615 ha — NZ's largest | Cardrona |
| Private cat-ski field area (historic) | 264 ha total, ~177 ha skiable | operator |
| Mean aspect | **south-westerly** (resort's own description); "mainly south-facing" per skiresort.info → treat as **S–SW, 200°–240°** | Cardrona / skiresort.info |
| Drainage | WSW into **Soho Creek** (LINZ point −44.8986, 168.8951) → Motatapu system | LINZ / topomap.co.nz |
| Named for | the Soho Creek headwater tributary + the view of **Mt Soho (1,752 m)** across the valley | Cardrona |

**Why the aspect matters.** In the southern hemisphere a *south*-facing slope is the
**shady** aspect. Soho Basin is cold, holds dry snow deep into the season, and stays in
shadow for much of a mid-winter morning. That is precisely why the resort bought it. It
also means the basin is a **blue-shadow, high-contrast** environment for most of the
playable day — see §1.5.

**Relationship to the ranges.** The Crown Range runs roughly N–S between the Wakatipu
Basin and the Cardrona River valley; the **Criffel Range** lies across the Cardrona River
to the east, and the **Pisa Range** (Mt Pisa, 1,963 m — the highest of the Otago
fault-block mountains) continues north-east. Cardrona/Soho sits at the junction: a
fault-block massif with a rounded, warped summit plateau, not a Southern Alps arête.
Everything you can see from Soho Basin looking downhill is *west* of the divide —
the Wakatipu Basin, and on a clear day Fiordland and the West Coast ranges.

## 1.2 Landform character of the Otago high country

This is the single most important thing to get right, and it is *not* the Alps and *not*
the Rockies. The visual grammar:

1. **Fault-block "range and basin" topography.** The ranges are uplifted, warped blocks of
   an ancient erosion surface (a peneplain). Summits are **broad, rounded, flat-ish
   plateaus** — whalebacks, not peaks. The steepness lives on the *flanks* and inside the
   cirques, not along the crest.
2. **Otago Schist.** Greenschist-facies metamorphic rock, ~200 Ma, strongly foliated. It
   splits into **platy slabs** along foliation. Colour: grey-green to silver-grey, with
   white quartz segregation veins parallel to foliation. Weathered faces go rust-brown.
   **Critical cue: every rock exposure in the basin shares one foliation strike and dip.**
   Randomly-oriented boulders read instantly as fake.
3. **Schist tors.** The signature landform. Residual knobs of unweathered schist left
   standing when Pleistocene periglacial soil creep stripped the weathered regolith away.
   They dot the **crests and upper flanks**, and are largely absent from cirque floors.
   Local tors (Pisa Range, Old Man Range) have **prominent planar faces mostly exceeding
   75°**. Typical dimensions: **1.5–8 m tall, 2–15 m long, 1.5–6 m wide**, tabular,
   long-axis aligned with foliation, in **clusters of 2–9** spaced 20–120 m apart.
4. **Glacially-scoured basins.** Small cirques bitten into the flanks of the blocks during
   the Pleistocene. Many hold tarns — the Pisa Range's Lake McKay sits at **1,692 m**.
   Cirque floors in this massif are **~1,650–1,750 m**; headwalls rise to the range crest
   at **1,850–1,960 m**. Cirque form: **arcuate headwall in plan, concave in section,
   with a flattened over-deepened floor and a lip/step at the mouth.**
5. **Periglacial modification.** Above ~1,500 m expect **solifluction lobes and terraces**
   (risers 0.3–0.8 m, treads 8–20 m, contour-parallel), **sorted stripes** on 5–20° slopes,
   and **blockfield/fellfield** on the crest — angular schist plates lying flat, 0.2–1.2 m
   across.
6. **Tussock, no trees.** The natural treeline in this part of Central Otago would be
   ~1,050–1,200 m, but the block ranges are functionally treeless. **There is not one tree
   anywhere in the playable area, and this is a defining visual.** No dark conifer masses,
   no forest edge. The white is uninterrupted. Vegetation is **narrow-leaved snow tussock
   (*Chionochloa rigida*)** — dense clumps **0.45–0.85 m tall, 0.4–0.8 m wide, spaced
   0.6–1.5 m**, bronze/straw/gold with silver seed heads — grading up into alpine
   herbfield, *Raoulia* cushionfield and *Aciphylla* speargrass above ~1,500 m.
7. **Wind-scoured ridgelines.** The prevailing NW ("nor'wester") gales strip the crests
   bare and drop the load into the lee gullies. Crests are dark, textured, half-rock,
   half-sastrugi ribbon; gullies are white and smooth.
8. **Bluffs.** Discontinuous schist bluff bands step across the flanks where the foliation
   dips into the slope — **5–25 m high, 55–80° faces, running cross-slope for 100–400 m
   before dying into a snow ramp.**

## 1.3 The terrain of Soho Basin specifically

Assembled from the resort's own descriptions, the historic cat-ski operation, and the
topography of the massif:

* **A broad open bowl**, not a narrow valley. Described as "wide-open bowls, rolling
  ridgelines, and long descents". The historic operation sold it as "wide, ungroomed
  terrain with natural features, chutes, and open faces". It "absorbs crowds well" — the
  useful fall line is **700–900 m wide**.
* **A defined headwall at the top**, below the range crest — the source of the "chutes"
  and the hike-to lines. Above the lift top there are "plenty of hike-to routes".
* **Rock ribs dividing the headwall into gullies/couloirs.** Standard schist-cirque
  geometry: ribs stand 8–20 m proud, gullies 20–90 m wide.
* **Rolling ridgelines / spines** through the mid-face — the "playful, progressive"
  character the resort keeps emphasising. Comparable in feel to Cardrona's Captain's Basin,
  which is described as "wide undulating terrain".
* **Groomed corridors are hard blues; off-piste is almost all black.** So the terrain must
  read as *steep enough to be black off the groomers* while the groomed lines themselves
  stay 12–20°.
* **A cat-track/traverse culture.** NZ ski areas are laced with benched traverses. Soho is
  reached *by traverse* from the top of Captain's, and the mid-mountain traverse to the
  untracked skier's-left is a universal NZ ritual. The lift-line groomer is named
  **"Broadway"**.
* **A flat run-out at the basin floor** with avalanche debris fans below the gully mouths,
  a shallow braided creek line (the head of Soho Creek), and solifluction terracing.
* **Historic landmark:** the cat-ski operation ran an **alpine hut** on the basin floor for
  lunch service. A single small stone/timber hut is a defensible and evocative prop.

## 1.4 Typical mid-winter snowpack

Cardrona averages **2.7–2.9 m of snowfall per season**. Settled mid-season depth at
mid-mountain is typically **1.0–2.0 m** (reported bases across seasons swing from 0.4 m in
a lean July to >3 m in a big August). Design for a **healthy but not enormous mid-July
pack** — enough to cover, not enough to bury the rocks.

**Wind is the dominant snowpack sculptor in New Zealand.** Wind slab is the most common
avalanche problem in the country. Storms arrive mostly from the SW/W behind a NW
pre-frontal gale; ridges are stripped and gullies are loaded.

| Feature | Where | Numbers |
|---|---|---|
| **Sastrugi** | Wind-exposed crests, spur tops, convex rollovers | Amplitude **0.04–0.35 m**, wavelength **0.35–2.2 m**, elongated ~4:1 along the wind, **sharp undercut upwind face (~70°)**, gentle lee tail |
| **Cornice** | Lee (downhill) lip of the crest, discontinuous | Overhang **1.5–4 m**, lip height above slope **1.5–3.5 m**, present over ~55% of the crest arc; gaps at the scoured rib heads are the safe entries |
| **Lee deposition (wind pillow)** | 40–120 m below the crest lip | **+0.8 to +2.4 m** over the open-slope depth |
| **Powder collection** | Gully floors, concave curvature, lee side of every rib and spine, the apron at the base of the headwall | 1.5–3.0× open-slope depth |
| **Scour** | Crests, convexities, spur tops, anything with positive curvature and windward exposure | **−0.4 to −1.4 m** |
| **Rock poking through** | Rib crests, tor tops, bluff faces, slopes >42° (sluffed clean), the wind-scoured crest plateau | ~**8%** of the map area shows rock; ~35% of the crest plateau |
| **Tussock showing** | Lowest, most wind-scoured margins of the run-out below ~1,440 m | Heads and seed stalks only, 0.1–0.4 m of plant above the snow |
| **Icy / windpack surface** | Steep convex windward faces >32°, scoured spur shoulders, refrozen groomer edges | ~6% ice, ~22% windpack |
| **Temperature** | At 1,700 m, mid-July | −12 to −5 °C overnight, −8 to −2 °C day — **cold enough that the snow stays dry all day** on this aspect |

**Snow depth by elevation band** (use as the base term of the depth field):

| Band | Continuous cover? | Open-slope settled depth |
|---|---|---|
| 1,410–1,450 m (run-out margins) | patchy; tussock + rock at the edges | 0.6–1.1 m |
| 1,450–1,650 m (lower + mid face) | continuous | 0.9–1.6 m |
| 1,650–1,820 m (bowl + headwall) | continuous in lee, scoured on ribs | 1.2–2.4 m lee / 0.1–0.5 m on rib crests |
| 1,820–1,865 m (crest plateau) | **no**, heavily scoured | 0–0.5 m over ~35% of area; blockfield and tors exposed |

## 1.5 The colour of New Zealand alpine light

Latitude **−44.87°**. Mid-July (`CONFIG.world.dayOfYear = 195`) solar declination ≈ **+21.6°**.
The sun crosses the **northern** sky and never gets high.

| Local clock (NZST, UTC+12) | Solar altitude | Solar azimuth (true) | Note |
|---|---|---|---|
| 08:15 | 0° | ~050° | sunrise |
| **09:40** (`CONFIG.world.timeOfDay = 9.67`) | **10.6°** | **044° (NE)** | current config; the SW-facing basin is **backlit / fully shadowed**, with warm rim light along the crest and cornice only |
| 12:47 | 23.4° | 000° (N) | solar noon — the daily maximum |
| **15:00** | **17.1°** | **328° (NNW)** | **sun is ~103° off the fall line → near-perfect cross-light on the basin.** This is the money light. |
| 17:20 | 0° | ~310° | sunset |

Computed for lon 168.95°E, EoT ≈ −5.6 min. See §2.12 for the game-space sun vectors.

Atmospheric character:

* **Exceptionally clean, dry air** (Central Otago rain-shadow). Rayleigh-dominant sky,
  **turbidity T ≈ 2.0–2.6** — cleaner than the European Alps in winter (~2.5–3.5).
  Aerial perspective is *weak and blue*, not milky; distant ranges stay legible to
  40 km+ (`CONFIG.world.visibility = 42000`).
* **Zenith sky CCT 12,000–20,000 K.** Very deep, saturated blue at zenith, washing pale
  and slightly warm at the horizon. Chappuis ozone absorption deepens the near-horizon
  blue at low sun.
* **Direct sun at 10–17° elevation: CCT 3,400–4,400 K** — genuinely warm, orange-gold on
  snow and rock. The contrast between warm direct light and 15,000 K skylight fill is what
  makes NZ winter photographs look the way they do.
* **Snow in shadow: 4–8% of sunlit snow luminance**, chromaticity pulled hard toward the
  sky. `CONFIG.snow.sssColor = [0.62, 0.74, 0.95]` is correct and should not be softened.
* Earth is near **aphelion** in July (≈3.4% below mean solar constant) — so do *not* push
  exposure hotter than `CONFIG.render.exposure = 1.05`; the drama comes from the low sun
  angle, not from brightness.

## 1.6 Surrounding skyline

Bearings and distances computed from the basin centre (−44.879, 168.928). All are real
peaks; `sky.js` should build the backdrop from this table.

| Feature | Summit | True bearing | Distance | Silhouette character |
|---|---|---|---|---|
| **Mount Cardrona** | 1,936 m | 065° | 2.4 km | The massif directly behind the headwall. Rounded whaleback, tor-studded, fills the sky above the crest. |
| Cardrona resort back ridge (Captain's) | 1,863 m | 074° | 1.7 km | The basin's own containing ridge. Lift towers just visible on the skyline. |
| Criffel Range | 1,626 m | 036° | 14 km | Long, flat-topped block range across the Cardrona valley. |
| **Mt Pisa / Pisa Range** | 1,963 m | 076° | 15 km | Broad plateau range; the classic Otago flat-top silhouette. |
| **Mt Soho** | 1,752 m | 243° | 6.5 km | *The namesake.* Directly across the Soho Creek valley, mid-ground, snow-streaked tussock flanks. |
| Coronet Peak | 1,649 m | 251° | 16 km | Conical, ski-area-scarred. |
| **The Remarkables (Double Cone)** | 2,319 m | 208° | 22 km | **The hero skyline element.** Serrated, sheer, ~2,000 m of visible relief above the Wakatipu Basin → subtends ~5°. Sits almost exactly down the fall line. |
| Hector Mountains | ~1,900 m | 191° | 42 km | Continuation of the Remarkables ridge, softer, hazier. |
| Richardson Mountains | ~2,100 m | 272° | 32 km | Sharp, glaciated, layered. |
| Buchanan Peaks / Harris Mountains | ~2,400 m | 337° | 42 km | Snow-and-ice, genuinely alpine — the visual break between "Otago tussock block range" and "Southern Alps". |
| Treble Cone / Mt Alta | 2,339 m | 352° | 28 km | Steep west-facing wall. |
| **Mt Aspiring / Tititea** | 3,033 m | 344° | 57 km | A white pyramid on the far horizon; the highest thing visible. |
| Fiordland horizon | ~2,000 m | 230–250° | 100–140 km | Layered pale-blue silhouettes stacked at the limit of visibility. Only present on a genuine bluebird. |

The looking-downhill view is therefore: **the Remarkables dead ahead at 22 km, Mt Soho and
Coronet Peak on the right, Fiordland stacked pale beyond, and the Mt Cardrona massif behind
you.** That composition is the game's signature wide shot.

---

# PART 2 — BUILD SPEC

## 2.1 Coordinate frame and compass mapping

Per `ARCHITECTURE.md`: **+Y is up, the fall line of the main face runs toward −Z.** With a
right-handed frame, facing −Z with +Y up puts **+X on the rider's right**.

**Adopt: game −Z ≡ true bearing 225° (SW).** This matches the resort's stated
south-westerly aspect and puts Mt Cardrona almost exactly behind the headwall.

```
 game −Z  =  true 225° (SW)   downhill / fall line
 game +Z  =  true 045° (NE)   uphill / headwall / crest
 game +X  =  true 315° (NW)   rider's right facing downhill
 game −X  =  true 135° (SE)   rider's left facing downhill
```

Conversion helper (recommended export from `terrain.js` so `sky.js` and `props.js` agree):

```js
export const TRUE_NORTH_BEARING_OF_MINUS_Z = 225; // degrees
/** Unit horizontal direction in game space for a true compass bearing. */
export function dirFromBearing(bearingDeg) {
  const t = (bearingDeg - 225) * Math.PI / 180;
  return new THREE.Vector3(Math.sin(t), 0, -Math.cos(t));
}
```

Skyline placements in game-space plan angle θ (degrees, measured from −Z rotating toward +X):
Remarkables **−17°**, Mt Soho **+18°**, Coronet **+26°**, Hector Mtns **−34°**,
Fiordland **+15°**, Richardson **+47°**, Aspiring **+119°**, Treble Cone **+127°**,
Mt Cardrona **−160°**, Pisa **−149°**, Criffel **+171°**.

> **NOTE FOR THE CONFIG OWNER (do not edit — reported, not changed):**
> `LOCATION.aspectDegrees` is currently `135` (SE). Research says Soho Basin faces
> **S–SW (≈225°)**; SE is the aspect of Cardrona's *main* basins, not Soho. Suggest
> `aspectDegrees: 225` and adding `trueNorthBearingOfMinusZ: 225`. Also `LOCATION.treeline: 1100`
> is a reasonable *climatic* treeline but the range is functionally treeless — the value
> should never be used to spawn vegetation inside the playable box.

## 2.2 Playable box, resolution and vertical budget

| Parameter | Value | Source |
|---|---|---|
| Playable extent | **2048 m × 2048 m**, x,z ∈ [−1024, +1024] | `CONFIG.terrain.size` |
| Physics heightfield | **1024²** → **2.0 m post spacing** | `CONFIG.terrain.heightfieldRes` |
| Elevation range | **1,410 m – 1,865 m** (455 m of vertical) | `CONFIG.terrain.minAltitude/maxAltitude` |
| Mean gradient, crest to basin floor | **18.0°** (424 m over 1,300 m) | designed to match the real 17.9° lift line |
| Playable fall-line length | ~1,450 m of descent + ~600 m of run-out | |

**2.0 m posts is the hard limit on what physics can feel.** Anything with a wavelength
below ~4 m cannot exist in `getHeight()`. Therefore:

> **Displacement rule.** Geometry displacement at wavelengths < 4 m must be capped at
> **±0.06 m** in every LOD ring, or `getHeight()` must reproduce it exactly. Everything
> finer (sastrugi micro-facets, crystal texture, drift ripples) lives in the **normal map**
> owned by `snowMaterial.js`. This is what keeps the contract "`getHeight` matches the
> rendered mesh to within a few centimetres".

## 2.3 Centreline elevation profile (analytic base)

Six zones, measured along the centreline x = 0. Drops sum to exactly 455 m.

| # | Zone | z range | Length | Top | Bottom | Drop | Mean slope | Local slope range |
|---|---|---|---|---|---|---|---|---|
| **A** | Crest plateau / blockfield | +1024 → +880 | 144 m | 1865 | 1852 | 13 m | **5.2°** | 2–14° |
| **B** | Cornice lip + headwall | +880 → +700 | 180 m | 1852 | 1725 | 127 m | **35.2°** | 28–48° |
| **C** | Headwall apron / upper bowl | +700 → +380 | 320 m | 1725 | 1620 | 105 m | **18.2°** | 12–26° |
| **D** | Mid face — spines, gullies, rollovers | +380 → −120 | 500 m | 1620 | 1480 | 140 m | **15.6°** | 8–35° |
| **E** | Bluff band + lower pitches | −120 → −420 | 300 m | 1480 | 1428 | 52 m | **9.8°** | 4–40° (bluff faces 55–80°) |
| **F** | Basin floor / run-out | −420 → −1024 | 604 m | 1428 | 1410 | 18 m | **1.7°** | 0–6° |

Interpolate with **monotone cubic (PCHIP)**, not Catmull-Rom — Catmull-Rom will overshoot
at the A/B and B/C breaks and produce a phantom cliff and a phantom bench.

Control points for `profile(zeff)`:

```
zeff:  +1024  +880   +700   +380   −120   −420   −1024
h:      1865   1852   1725   1620   1480   1428    1410
```

## 2.4 Making it a cirque, not a ramp

The basin must be **concave in plan and in section**: flanks rising away from the
centreline, wrapping forward at the top. Do it by warping the profile's argument rather
than by adding a cross-slope term (which produces a visible parabolic gutter).

```js
// Flank lift: pushes off-centreline samples "further up" the profile.
const A = 700 * smoothstep(-600, 500, z) + 60;   // metres of forward offset at |x| = 1024
const curl = A * Math.pow(Math.abs(x) / 1024, 1.6);
const zeff = z + curl;
let h = profile(zeff);
```

Behaviour this produces (all checked):

| Sample | Centreline h | h at that x | Rim relief |
|---|---|---|---|
| (±400, +380) | 1620 | 1674 | +54 m |
| (±800, +380) | 1620 | 1849 | **+229 m** — a proper cirque wall |
| (±800, −420) | 1428 | 1441 | +13 m — the basin mouth opens out |

The `p = 1.6` exponent keeps the bowl floor genuinely flat-bottomed for the middle
±350 m (the "wide open bowl that absorbs crowds") and puts the curvature out at the rim.

**Two clamps are mandatory:**

1. `profile()` must **clamp its argument to [−1024, +1024]** and return the endpoint value
   outside that range. `zeff` reaches ~1640 in the upper map corners (x = ±1024,
   z = +880); without the clamp, PCHIP extrapolation walks straight past `maxAltitude`.
2. The containment ramp (§2.5) is applied **only where the ground is low** — `z < −420`
   or (`|x| > 950` and `h < 1700`) — and its result is capped with
   `h = min(h + ramp, 1865)`. In the upper corners the flank lift has already carried the
   terrain to the crest, so no ramp is needed or wanted there.

**Cirque focus** for all radial features: **(x = 0, z = +240)**.
**Headwall crest arc:** radius **640 m** about the focus → crosses the centreline at
z = +880, wraps to z = +739 at x = ±400 and z = +463 at x = ±600.
**Headwall base arc:** radius **460 m** → z = +700 at centreline.

## 2.5 Feature register

All coordinates are game-space metres. `seed` column is the string to pass to
`seedFromString()` so each feature can be re-rolled independently and deterministically.

### Spawns

| Name | Position (x, z) | Elev | Heading | Purpose |
|---|---|---|---|---|
| **`broadway-gate`** (default) | (+70, +845) | ≈1847 | 0 rad (facing −Z) | Hero opening. Rider on the scoured crest, cornice lip 25 m ahead, whole basin + Remarkables below. `getSpawn()` returns this. |
| `bowl-entry` | (−180, +560) | ≈1690 | 0 | Below the headwall, straight into the powder apron. |
| `mid-traverse` | (+430, +120) | ≈1565 | −0.35 rad | Drops onto the spine field. |
| `runout` | (−60, −700) | ≈1418 | 0 | Flat-light / prop-test spawn near the lift base. |

### Headwall (zone B)

| Feature | Spec |
|---|---|
| **Rock ribs** ×5 | Radiating from the crest arc down-slope. Plan angles from −Z: **−34°, −16°, +2°, +21°, +41°**. Length **120–200 m**, width **25–45 m**, relief **8–20 m** above adjacent gully floor, Gaussian cross-section σ = 14–22 m. Rock exposed on the crest and upper 60%; snow-filled flanks. Seed `soho.terrain.headwall.ribs`. |
| **Gullies / couloirs** ×4 | Between the ribs. Width **18–40 m at the top → 60–90 m at the apron**. Entry angle **40–48°**, easing to 30° at the base. Snow-filled, powder-holding. Named anchors: **`broadway`** (widest, centre, x≈+40, 84 m at the apron), **`organ-pipes`** (tight western trio, x −180 … −420, 18–30 m), **`soho-chute`** (x≈+260, narrowest at **18 m**). |
| **Cornice** | Along the crest arc on the −Z lip. Overhang **1.5–4 m**, lip height **1.5–3.5 m**, present over **55%** of arc length in 40–110 m segments. **Gaps sit at the rib heads** (they are scoured) — the gaps are the walk-in entries, the cornice segments are the natural drop-ins. Implement as a signed-distance bulge on the height field so `getHeight()` sees it; cap the true overhang at 0° (heightfields cannot overhang) and let `props.js` add a thin overhanging lip mesh for silhouette. |
| **Bergschrund-analogue moat** | A 1.5–3 m deep, 6–12 m wide concave trough where the headwall meets the apron along the r = 460 m arc, present over ~40% of its length. Powder trap and natural landing transition. |

### Upper bowl and mid face (zones C, D)

| Feature | Spec |
|---|---|
| **Powder apron** | z +700 → +520, the full width of the bowl. Slope **14–22°**, curvature strongly concave. Deepest snow on the map (see §2.7). The primary landing zone for everything dropped off the headwall. |
| **Rollovers** ×15 | Convex breaks in zone C/D. Slope steepens by **8–14° over a 15–30 m transition**; radius of curvature **25–70 m**; lip stands **1.5–4.0 m** above the tangent plane. These are the natural jumps and blind entries. Distribute with a Poisson-disc (min spacing 85 m) seeded `soho.terrain.rollovers`. |
| **Spines** ×7 | Zone D, biased to the rider's right (x +80 … +700). Crest-to-crest spacing **45–70 m**, relief **4–9 m**, length **180–320 m**, running down the fall line, convex crests, 25–35° flanks. The playground. Seed `soho.terrain.spines`. |
| **Main gully (head of Soho Creek)** | Starts **(−120, +420)**, runs to **(−260, −520)** with two gentle inflections. Depth **2 m → 14 m**, width **12 m → 45 m**. Parabolic cross-section, walls **25–35°**, floor **8–16°**. The natural halfpipe / banked-slalom line and the map's biggest powder collector. |
| **Tributary gullies** ×2 | Join the main gully from **(+180, +150)** and **(−480, −60)**. Depth 1.5–7 m, width 8–26 m. |
| **West spur ("Soho Spur")** | Crest from **(−560, +560)** descending to **(−820, −700)**. Stands **6–25 m** above the adjacent bowl. Wind-scoured, tor clusters along the crest, tussock showing at its foot. |
| **East spur ("Captain's Shoulder")** | Crest from **(+600, +640)** descending to **(+880, −620)**. Same character; **carries the lift line**, so keep its crest broad (≥30 m of <12° ground) and free of bluffs. |

### Bluffs, rock and tors (zone E and crest)

| Feature | Spec |
|---|---|
| **Mid bluff band** | Three cross-slope segments at z ≈ **−140 to −220**, total ~700 m of frontage: **x −520…−230**, **x −60…+180**, **x +330…+540**. Step height **6–22 m**, face angle **55–80°**. The two gaps (x −230…−60 and +180…+330) are snow-ramp through-routes at 22–30°. This is the map's "air it or go around" feature. |
| **Tor clusters** | Zone A crest plateau and both spur crests. **28–40 clusters**, 2–9 tors each, tor height **1.5–8 m**, footprint **3–15 m × 1.5–6 m**. **All tors share one foliation strike: plan bearing +38° from +X, dip 32°.** Two or three faces per tor at >75°. Terrain provides the placement list + orientation; `props.js` builds the meshes. Seed `soho.terrain.tors`. |
| **Blockfield** | Crest plateau above 1,838 m and any cell with snow depth < 0.10 m on <20° ground: flat-lying angular schist plates **0.2–1.2 m** across, 30–60% ground cover. A displacement of ±0.10 m plus a rock material blend — no individual meshes. |
| **Avalanche debris fans** | Below each headwall gully mouth, on the apron and at the basin floor below the bluff gaps. Hummocky lumps **0.5–2.0 m** over fans **60–140 m** long. Billow noise, amplitude modulated by a cone mask from each gully mouth. |

### Benched traverses / cat tracks

Cut/fill benches are one of the highest-value realism cues in an alpine game: they are
dead-straight in profile against a noisy hillside, they are groomed (different surface),
and they carry a cut bank and a fill berm.

| ID | From → To | Along-track grade | Spec |
|---|---|---|---|
| **T1 `crest-traverse`** | (−700, +900) → (+700, +900) | −0.8° | The access line from the ridge. Running surface **5 m**, cut bank uphill **0.4–1.2 m**, fill berm downhill **0.6–1.5 m**. |
| **T2 `mid-traverse`** | (+880, +40) → (−760, +260) | **−1.6°** | The classic "traverse to the goods" line, crossing the bowl at ~1,565 m. Running surface **6 m**. Fill berm downhill up to **2.5 m** — a natural side-hit the whole way along. |
| **T3 `home-track`** | (−820, −480) → (+700, −760) | −1.1° | The run-out road to the lift base. Running surface **6 m**. |

Implementation: for each track compute the perpendicular distance `d` to the polyline and
blend the terrain toward the track's own linear profile with weight
`w = 1 - smoothstep(halfWidth, halfWidth + 9, d)`; add the fill berm as a
`0.6 * exp(-((d - halfWidth - 2.5)/3.0)^2)` bulge on the downhill side only. Mark all
cells with `d < halfWidth + 1` as `surface = 'groomed'`.

### Lift corridor (terrain reserves it; `props.js` builds it)

Modelled on the real Soho Express: **379 m rise, ~1,240 m slope length**. It tops out on
the east spur **below the crest**, which is exactly right — the real basin's best lines are
a hike above the lift top, and it gives us the "74 m hike to the crest" narrative.

| | Position (x, z) | Elevation |
|---|---|---|
| Base terminal | **(+320, −560)** | 1,412 m |
| Top terminal | **(+240, +700)** | 1,791 m (on the east spur, 66 m above the bowl floor at that z) |
| Rise / horizontal / slope length | 379 m / 1,262 m / **1,318 m** | mean **16.7°** |
| Towers | **14**, ~90 m spacing | terrain must keep each tower base within 4° of level over a 6 m pad |

Terrain guarantees: a **40 m wide corridor** along the line free of bluffs and of any slope
> 34°, plus a flat bench (**60 × 40 m, <3°**) at each terminal.

### Groomed run corridors

Three corridors, **25–45 m wide**, snaking down the fall line and avoiding the bluffs.
Grooming = flatten cross-slope camber to <6°, remove all noise below 8 m wavelength,
clamp roughness to 0.15, set `surface = 'groomed'`. Corduroy is `snowMaterial.js`'s job.

| Name | Route | Character |
|---|---|---|
| **`broadway`** | (+240, +680) → (+180, +420) → (+60, +120) → (+120, −180 *via the centre bluff gap*) → (+280, −520) | The lift-line groomer. Hard blue, 14–20°. |
| **`main-street`** | (−100, +560) → (−260, +200) → (−340, −120) → (−480, −430) → (−300, −700) | Wider, mellower, 12–17°; the confidence run. |
| **`east-side`** | (+520, +560) → (+620, +200) → (+560, −200) → (+400, −520) | Along the east spur shoulder; 15–21°, most exposed, most often wind-affected. |

### Run-out and containment (zone F)

* Solifluction terraces: contour-parallel risers **0.3–0.8 m**, treads **8–20 m**, across
  the whole floor below 1,435 m.
* Braided creek depression: **1–3 m deep, 15–40 m wide**, meandering from (−260, −520) to
  (−540, −1024).
* **Containment without invisible walls.** Beyond |x| > 950 and z < −950, ramp the ground
  up by **40–80 m over the final 100 m** (smoothstep, so `getNormal` stays continuous).
  The player reads a rising basin wall, not a boundary. Cross-check that the ramp never
  pushes elevation above 1,867 m.

## 2.6 Noise budget

Five bands. Everything analytic above 400 m; everything below 4 m in normals only.

| Band | Wavelength | Amplitude | Generator | Purpose |
|---|---|---|---|---|
| 0 | 400–1200 m | ±60 m | **analytic** (§2.3–2.4) | Cirque form. **Not noise** — a noise-only bowl reads as generic. |
| 1 | 120–400 m | ±18 m | `ridged2` (octaves 3, sharpness 1.35), masked to the spur/rib layout | Spurs, headwall ribs, main gullies |
| 2 | 30–120 m | ±6 m | `warpedFbm2` (octaves 4, warp 0.4, warpFrequency 0.6) | Rollovers, secondary gullies, spine field |
| 3 | 8–30 m | ±1.2 m | `billow2` (octaves 3), **amplitude × snowDepth/1.5** | Wind drifts, mogul-scale undulation, debris |
| 4 | 1.5–8 m | ±0.35 m | `worley2` F2−F1 + `fbm2`, amplitude × snowDepth | Drift lobes, snow pillows over buried rock |
| 5 | 0.05–1.5 m | ±0.12 m | sastrugi function (§2.8) | **Normal map only** below the innermost LOD; see the displacement rule in §2.2 |

Domain-warping (band 2) is what kills the "obviously procedural" grid signature. Use it.

**Seeding.** Derive every band and feature seed from
`seedFromString('soho.terrain.' + name)` combined with `CONFIG.seed`, so a designer can
re-roll the spine field without moving the headwall. Never call `Math.random()`.

## 2.7 Snow depth field (drives everything else)

Carry a **separate scalar depth field** at the same 1024² resolution. It is cheap, and it
is what makes the mountain read as *snow on rock* rather than *white terrain*.

```
depth(x,z) = base(elev)                       // 0.9 m @1410 → 1.8 m @1865, linear
           + 0.35 * fbm2(...)                 // ±0.35 m natural variation, λ ≈ 120 m
           + lee(x,z)                         // crest lee deposition
           + curvatureTerm(x,z)               // concave collects, convex sheds
           - exposure(x,z)                     // wind scour
           - slopeShed(x,z)                    // sluffing on steep ground
```

| Term | Rule | Range |
|---|---|---|
| `lee` | `+2.4 * exp(-((distBelowCrest - 55)/70)^2)` measured down-slope from the crest arc | 0 … **+2.4 m** |
| `curvatureTerm` | `-1.1 * meanCurvature * 55` (concave positive) | **−0.6 … +1.6 m** |
| `exposure` | Shelter index: sample terrain height at 8 points upwind (see §2.8) at 20, 40, 70, 110, 160, 220, 300, 400 m; `E = max((h_up - h)/d)`; scour `= 1.4 * clamp01(-E * 6)` | **0 … −1.4 m** |
| `slopeShed` | `clamp01((slopeDeg - 38) / 14) * 1.2` | 0 … **−1.2 m** |

Clamp to **[0, 3.5] m**. Where `depth < 0.10 m` → rock. Target ~8% of the map, concentrated
on crests, rib tops, bluffs and slopes >42°. **Assert this in a build-time check** —
if rock coverage drifts outside 5–12% the mountain either looks like a quarry or like a
featureless meringue.

`physics.js` consumes depth via `sample().sinkDepth` support; `CONFIG.physics.powderDepth = 0.55`
is the board's *maximum* sink, so `min(depth, 0.55)` is the useful term.

## 2.8 Wind model

`CONFIG.world.windDirection = 292` means wind **from** 292° true (NW), blowing **toward**
112° true (ESE).

```
Synoptic wind direction in game space (toward): W = (−0.921, 0, +0.391)
```

Two distinct effects, both needed:

1. **Crest barrier / lee deposition.** The range crest at the top of the map blocks the
   synoptic NW flow. Below the lip, flow separates and deposits: the cornice, plus the
   `lee` term in §2.7. This is *independent* of local slope direction.
2. **In-basin surface flow.** Project W onto the local surface:
   `Ws = normalize(W - (W·n) n)`. Inside the bowl this ends up flowing cross-slope toward
   −X with a slight up-slope bias, which is correct for a NW gale on a SW-facing basin.
   Use `Ws` for the exposure/shelter sampling in §2.7 and for sastrugi orientation.

**Consequence — build for the asymmetry.** The rider's-right (+X) faces of every rib and
spine are **windward: scoured, windpack, sastrugi, rock showing**. The rider's-left (−X)
faces and the gully floors are **lee: deep, smooth, soft**. Same slope, two completely
different surfaces, 40 m apart. This asymmetry is worth more visually than another octave
of noise.

**Sastrugi** (only where `surface ∈ {'windpack','ice'}`), scaled by
`CONFIG.snow.sastrugiStrength = 0.55`:

* Amplitude **0.04–0.35 m**, wavelength **0.35–2.2 m**.
* Anisotropy **4:1 elongated along `Ws`** — sample noise in a frame stretched 4× along the
  wind.
* Asymmetric profile: **upwind face steep (≈70°, slightly undercut), downwind tail gentle
  (≈12°)**. Get this by feeding a sawtooth through the along-wind coordinate rather than a
  symmetric sine — symmetric ripples look like corduroy, not sastrugi.
* Must appear in **both** the displacement (innermost LOD, ≤0.06 m) **and** the normal map,
  or it disappears at 30 m and the slope goes plastic.

## 2.9 Surface classification

`sample().surface` returns one of `'powder' | 'groomed' | 'ice' | 'rock' | 'windpack'`.
Evaluate in this priority order (first match wins):

| Priority | Surface | Rule | Target area |
|---|---|---|---|
| 1 | **`rock`** | `depth < 0.10` **or** `slope > 50°` **or** inside a bluff/tor footprint | **8%** |
| 2 | **`groomed`** | within a cat-track or groomed-corridor mask | **12%** |
| 3 | **`ice`** | `slope > 32°` **and** windward (`Ws · downhillDir < −0.25`) **and** `curvature > 0` | **6%** |
| 4 | **`windpack`** | `exposure > 0.5` **or** (`curvature > 0.15` **and** `depth < 1.0`) — i.e. crests, spur tops, convex rollovers | **22%** |
| 5 | **`powder`** | everything else | **52%** |

`sample().roughness` (0–1), for physics chatter and material response:
`rock` 1.0 · `ice` 0.05 · `groomed` 0.15 · `windpack` 0.55 (+ sastrugi amplitude × 1.2) ·
`powder` 0.30.

## 2.10 Slope-angle distribution — the acceptance histogram

Compute over the playable box excluding the containment ramps. This is the single best
one-number check that the mountain is *rideable and interesting*:

| Slope band | Target share | Reads as |
|---|---|---|
| 0–5° | 12% | run-out, benches, terminals |
| 5–12° | 18% | green / cruising |
| 12–20° | **27%** | blue — the groomers and the bowl floor |
| 20–28° | **22%** | black — the spines and gully walls |
| 28–35° | 13% | double black — rollover faces, headwall base |
| 35–45° | 6.5% | the couloirs |
| >45° | 1.5% | bluff faces, chute entries |

**Mean ≈ 19°, median ≈ 18°.** Allow ±4 percentage points per band.

## 2.11 LOD, streaming and the far field

| Ring | Radius | Post spacing | Notes |
|---|---|---|---|
| 0 | 0–64 m | **0.5 m** | Only ring that resolves band 4/5 displacement (capped ±0.06 m, §2.2) |
| 1 | 64–160 m | 1.25 m | |
| 2 | 160–384 m | 3 m | |
| 3 | 384–900 m | 7 m | |
| 4 | 900–2048 m | 16 m | |

`CONFIG.terrain.lodRings = 5`, `lodBaseRes = 128` — a 128² patch grid per ring fits these
radii. Stitch rings with vertical skirts (drop 1.2× the ring's post spacing) to hide cracks
without needing seam-matched indices.

**Near backdrop (terrain's responsibility, 1.0–6.0 km).** The playable box must not end in
a visible cliff at the horizon. Emit a coarse shell (32–64 m posts) continuing the spurs
and dropping into the Soho Creek valley to ~1,050 m at 5 km SW, and rising over the Mt
Cardrona massif to 1,936 m at 2.4 km NE. Beyond 6 km is `sky.js`
(`CONFIG.terrain.backdropRadius = 26000`) using the §1.6 table.

## 2.12 Lighting notes for `sky.js` (informational — terrain does not set these)

Game-space sun direction (unit, pointing *toward* the sun), derived from §1.5 with the
§2.1 compass mapping:

| Time | Sun direction (x, y, z) | Reads as |
|---|---|---|
| 09:40 (current `CONFIG.world.timeOfDay`) | **(+0.02, 0.18, +0.98)** | Almost exactly up-slope — the sun sits directly behind the headwall at 10.6° elevation, so **the whole basin is in shadow**, with warm rim light on the crest, the cornice lip and the tor tops against a deep blue sky. Dramatic and true to the aspect, but it flattens the mid-face to a single blue mass. |
| **15:00 (recommended)** | **(+0.93, 0.29, +0.22)** | Sun to the rider's right, slightly up-slope, 17.1° elevation → **cross-light rakes across the fall line.** Every rollover, spine, gully and sastrugi field reads in relief; shadows stretch 3.3× object height across the slope. |

> **NOTE FOR THE CONFIG / SKY OWNER (reported, not changed):** if the screenshot presets
> look flat and blue, the cause is `timeOfDay = 9.67` on a SW aspect, not the terrain.
> `timeOfDay: 15.0` is the correct fix and is equally physically truthful for this basin.

## 2.13 Material zoning hints for `snowMaterial.js` / `props.js`

* **Otago Schist base albedo:** grey-green ≈ `#6E7269` (linear-sRGB ~0.16, 0.17, 0.15),
  with **quartz banding** ≈ `#9AA096` in 2–15 cm stripes **parallel to foliation**
  (plan strike +38° from +X, dip 32°). Weathered/oxidised faces pull toward `#7A6A52`.
* **Lichen:** splotches at 5–25% coverage, **only on sun-facing (north-facing) rock**:
  yellow-green `#B4922F`, black `#2A2A26`, pale grey-green `#8E9B84`. Worley-based blotches,
  0.05–0.4 m across. Lichen is the difference between "grey rock" and "Otago".
* **Snow tussock:** `#8A6A3A` → `#B99A5E`, clumps 0.45–0.85 m tall / 0.4–0.8 m wide,
  spacing 0.6–1.5 m. **Instance only where `depth < 0.25 m` and `elev < 1560 m` and
  `slope < 24°`** — i.e. the scoured run-out margins and lower spur shoulders. Nowhere else.
* **Zero trees.** There is not a single tree within 6 km of the playable box. Do not add
  any, at any distance, in any silhouette.
* Snow albedo 0.86 and `sssColor [0.62, 0.74, 0.95]` from `CONFIG.snow` are researched-correct.

## 2.14 Acceptance tests

Assert these at build time (cheap, and they catch every class of terrain regression):

1. **Range.** `min(h) ≥ 1408` and `max(h) ≤ 1867` over the whole box.
2. **Continuity.** `|h(x+2,z) − h(x,z)| / 2 < 3.0` (≈71°) for every post *except* posts
   flagged as bluff faces; no NaN, no Infinity.
3. **Mesh/physics agreement.** `max |meshVertex.y − getHeight(x,z)| < 0.05 m` sampled over
   2,000 deterministic points in every LOD ring.
4. **Spawn sanity.** `sample()` at `broadway-gate` returns `slope ∈ [6°, 10°]` and
   `surface === 'windpack'`.
5. **Rideable line.** A straight glide from `broadway-gate` toward −Z reaches z = −600
   without encountering `slope > 48°` or a height discontinuity > 1.5 m over 2 m.
6. **Slope histogram** within ±4 pp of §2.10.
7. **Rock coverage** in `[5%, 12%]`; **groomed coverage** in `[9%, 15%]`.
8. **Determinism.** Two builds with the same `CONFIG.seed` produce bit-identical
   heightfields (hash the Float32Array).
9. **Lift corridor.** No post within 20 m of the lift line exceeds 34°; both terminal pads
   are <3° over 60 × 40 m.
10. **Placeholder tolerance.** `build()` and `update()` must not throw when `ctx.sky`,
    `ctx.player`, `ctx.physics` or `ctx.fx` are `undefined` — terrain is constructed first
    and must survive an empty `ctx`.

## 2.15 Plan view

```
              x=−1000    −600     −200     +200     +600    +1000
  z=+1024  ┌────────────────────────────────────────────────────────┐  1865 m
           │  ▓▓ CREST PLATEAU — blockfield, tor clusters, sastrugi │
           │      ═══════════ T1 crest-traverse ═══════════         │
  z= +880  ├──▲▲▲▲▲▲▲▲▲▲  C O R N I C E   L I P  (arc r=640) ▲▲▲▲▲──┤  1852 m
           │  \\\ribs///  H E A D W A L L  30–48°  \\\ribs///       │
           │   organ-pipes      ▼broadway▼      soho-chute          │
  z= +700  ├──────────── headwall base arc (r=460) ─────────────────┤  1725 m
           │      P O W D E R   A P R O N   14–22°     ⊙ lift top   │
           │                                             (+240,+700)│
  z= +380  │ WEST SPUR ╱                              ╲ EAST SPUR   │  1620 m
           │  (Soho Spur)   spines ∿∿∿∿∿ rollovers ●    (Captain's  │
           │        │ main gully ↓                       Shoulder)  │
  z= +100  │   ══════╪═══ T2 mid-traverse ════════════════          │
           │         │        M I D   F A C E   12–28°              │
  z= −120  ├─███████──gap──███████──gap──███████────────────────────┤  1480 m
           │        B L U F F   B A N D   (6–22 m, 55–80°)          │
           │              lower pitches 4–16°                       │
  z= −420  ├────────────────────────────────────────────────────────┤  1428 m
           │  ≈≈ avalanche fans ≈≈  solifluction terraces           │
           │       ═════ T3 home-track ═════      ⊙ lift base       │
           │   ~~~ Soho Creek ~~~                    (+320,−560)    │
  z=−1024  └────────────────────────────────────────────────────────┘  1410 m
                       ↓  fall line = −Z = true SW 225°
                  view: THE REMARKABLES 22 km, θ = −17°
```

---

## Sources

* [Soho Basin — Cardrona Alpine Resort](https://cardrona-treblecone.com/soho)
* [Cardrona Alpine Resort — Wikipedia](https://en.wikipedia.org/wiki/Cardrona_Alpine_Resort)
* [Soho Basin — skiresort.info](https://www.skiresort.info/ski-resort/soho-basin/) (1,425–1,925 m, 500 m vertical, south-facing)
* [Soho Express chairlift specs — skiresort.info](https://www.skiresort.info/ski-resort/cardrona/ski-lifts/l108727/) (379 m rise, 1,237 m, Doppelmayr 6CLD, 2025)
* [Cardrona 3D resort guide — PeakVisor](https://peakvisor.com/ski-resort/cardrona.html) (lift top/base elevations, basin names, surrounding peaks)
* [Ski Cardrona's Soho Basin: 10 things to know — NZ Herald](https://www.nzherald.co.nz/travel/cardrona-soho-basin-10-things-to-know-before-visiting-the-ski-field/PJCZEQB7OJFT5HQKNOXGEJNFF4/) (hard blues / black off-piste / hike-to routes)
* [New Zealand's Largest Ski Resort Reveals New Trail Map — Unofficial Networks](https://unofficialnetworks.com/2025/06/10/cardrona-new-trail-map/) ("Broadway" lift-line run)
* [Countdown to Soho Basin's Grand Opening — Mountainwatch](https://www.mountainwatch.com/Snow-news/new-season-new-cardrona-countdown-to-soho-basins-grand-opening/) (150 ha, 380 m vertical, wide-open bowls and rolling ridgelines)
* [Discovering the Secrets of Soho Basin — Ski Express](https://www.skiexpress.com.au/blog/soho-basin/) (chutes and bowls; Wakatipu / Fiordland / West Coast views)
* [Crown Range — Wikipedia](https://en.wikipedia.org/wiki/Crown_Range)
* [Mount Cardrona — Wikipedia](https://en.wikipedia.org/wiki/Mount_Cardrona) (1,936 m)
* [Pisa Range — Wikipedia](https://en.wikipedia.org/wiki/Pisa_Range) (Mt Pisa 1,963 m; cirque tarns; Lake McKay 1,692 m)
* [Otago mountains — Te Ara Encyclopedia of New Zealand](https://teara.govt.nz/en/1966/otago-mountains) (block mountains, peneplain, periglacial tors)
* [Geology and landscape, Otago — Te Ara](https://teara.govt.nz/en/otago-region/page-2)
* [Complex patterns of schist tor exposure and surface uplift, Otago — Geomorphology (2021)](https://www.sciencedirect.com/science/article/pii/S0169555X21002579) (tor faces >75° on the Pisa and Old Man Ranges)
* [Origin and age of upland schist tors in Central Otago — NZ J. Geol. Geophys.](https://www.tandfonline.com/doi/pdf/10.1080/00288306.1981.10422729)
* [Chionochloa rigida — NZ Native Plants](https://www.nativeplants.nz/chionochloa-rigida.html)
* [New Zealand Avalanche Advisory — Wanaka region](https://www.avalanche.net.nz/region/wanaka) (wind slab dominance; ridges stripped, gullies loaded)
* [Sastrugi — Avalanche.org encyclopedia](https://avalanche.org/avalanche-encyclopedia/snowpack/snow-metamorphism/wind-effects/wind-erosion/sastrugi/)
* [Cardrona snow history — Snow-Forecast](https://www.snow-forecast.com/resorts/Cardrona/history)
* [Soho Creek, Otago — NZ Topo Map](https://www.topomap.co.nz/NZTopoMap/nz19883/Soho-Creek/Otago) (−44.89865, 168.89509)
* Solar geometry for −44.875°, 168.95°E, day 195: computed from standard NOAA solar position equations (declination +21.6°, EoT −5.6 min).
