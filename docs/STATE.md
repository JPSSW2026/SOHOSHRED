# State of play

Orientation for whoever picks this up next. `CRITIQUE_R14.md` holds the full
chronology (R14–R44, 2200+ lines); this is the part you need before reading it.

---

## Decisions waiting on the user

None of these are bugs. Each is a real trade-off that was measured, then left
alone because making the call is not mine to make.

**1. The head renders near-black.** L≈19 against snow at L≈200. It is dark
because `M.shellGrey` is dark by the §6.3 one-high-chroma-colour rule, and the
hood — which owns ~178 of 212 head pixels from the chase camera — inherits it.
Measurement says there is no defect: the two tones on the head are its own
sky-lit rim against a shadowed body. But it is the likeliest reason the head
reads oddly at speed. Lifting it trades against a rule the codebase holds
deliberately. (R31, R32)

**2. Backdrop majesty in the gameplay view.** `chase-carve`'s range is not
hazier or flatter than `valley-vista`'s — internal detail 1.76 vs 1.72, edge
contrast 2.32 vs 2.50. The only difference is coverage: 6.0% of frame vs 16.8%.
**Do not turn the haze down**; it would not fix the gameplay view and would
damage `valley-vista`, where the treatment works. The lever is angular size — a
taller or nearer range, or a higher chase camera. Both are world changes. (R37)

**3. The pant knee folds through itself.** `pantLegF` at 98.4% of a rect placed
inside one fold wedge. Linear-blend-skinning collapse at a knee bent past 90°.
The obvious fix is measurably wrong (widening the blend took the dark fraction
from 35.7% to 46.9% — it trades the fold for a candy-wrapper pinch). What is
left is structural: dual-quaternion skinning, a helper joint, or a snugger knee
radius that fights the baggy silhouette earlier rounds tuned. Portrait-scale
only; at the ~90 px gameplay figure the wedges are sub-pixel. (R38)

**4. Run length.** A straight-line, zero-input descent covers 950 m in 120 s and
is still 350 m from the finish at `z = −560`. So a full run is ~2.5 min minimum
and longer for anyone carving. There is also a slow section near `z ≈ −160`
where speed dips to ~10 km/h before recovering. (R41)

**5. `CRASH_LANDING` = 17.5 m/s.** Never reached in any probe; the largest
landing on record is 16.62, within 5%. So it is a rare event rather than dead
code. Leave it or lower it — a call about how punishing the game should be. (R42–R44)

---

## Shipped this session

- **Rider arms and gloves.** Forearm tapers to a 0.75 wrist/bicep ratio; sleeve
  stops clear of the wrist; gauntlet on the forearm bone (not the hand — the
  wrist swings ~25° and would walk a hand-mounted cone off the sleeve rim);
  glove sized to the sleeve with its wrist cap buried in the mitt.
- **Helmet brim** — was 36 mm *inside* the skull and had never rendered a pixel.
- **Terrain acceptance test** — four warnings fired on every load, all stale
  (they described `broadway-gate`, which stopped being the default spawn).
  Retuned from measured design intent, validated both directions.
- **Stumble timer never decayed** — the one real gameplay bug. Set to 0.85 by
  the OOF tier, decayed only inside `if (s.crashed)`, which the OOF tier
  deliberately never sets. Every rider carried a permanent ~0.71 lateral cant
  from their first oof onward. 71% of frames → 14%, bail rate unchanged.

---

## Tooling: what each answers, and its limits

| tool | answers | limit |
|---|---|---|
| `regress.mjs` | which frames did this edit move | **builds now**; 9 shots incl. `close-spray` |
| `playtest.mjs` | does the game *play* — speeds, bails, tricks | lazy S-turn policy; biased LOW on landing impacts |
| `fall-line.mjs` | does the mountain ride with no input | no steering, so it misses the kickers |
| `kicker-aim.mjs` | do deliberate lip hits reach the thresholds | steer sign determined empirically, not assumed |
| `head-extents.mjs` | is a head part on the surface | reports both surface distance and X-silhouette — they answer different questions |
| `backdrop-detail.mjs` | backdrop detail + silhouette contrast | isolates by removal, so numbers belong to the asset |
| `who-owns.mjs` | which mesh owns a region | **use a TIGHT rect** — it answers about the rectangle you draw |

`regress.mjs` determinism, measured: same shot list repeats byte-identically;
a *different-length* list changes the bytes; and it survives a container
restart, so the committed manifest is valid across sessions. Do **not**
`--update` as a session-start ritual — that destroys the history that makes a
regression detectable. If it reports changes you did not make, that is a real
signal.

---

## Dead leads — do not re-chase

Each of these looked like a defect and was measured to be either intentional or
absent. The measurement is in the cited section.

- **Backdrop haze in gameplay** — refuted, it is angular size (R37)
- **Hood geometry on the head** — no defect; both tones are its own shading (R32)
- **"Six buried head pieces"** — only the brim was real; the others were an
  X-silhouette metric read as a surface metric (R29 correction)
- **Widening the knee blend** — measurably worse (R38)
- **Rocks reading as cardboard/ice** — `props-schist` with documented foliation
  and a deliberate `snowOnRock`; the straight bright bands are bedding planes
- **Blue patches on the snow** — kicker dye lines, painted in the shader
  specifically because a decal mesh would z-fight the clipmap
- **`hero-basin` has no distant range** — framing choice; the backdrop loads fine
- **"The ollie is dead"** — fires 82/86; the probe was reading a one-shot flag
  after `postRender` cleared it (R39)

---

## The recurring failure mode

Nine of this session's own claims were corrected, and they share one shape:
**a measurement taken under one condition, reported as a property of the
system.** One container (R27). One magnification (R28, R31). One shot list
(R32). One rectangle (R44's five misidentifications). One riding policy
(R42, R43).

Two habits catch it, both cheap:

1. **When a measurement says a system does nothing, confirm the measurement can
   see the system.** Three separate "dead feature" findings were the instrument
   — the tint that never rebuilt, the ollie flag cleared before the read, the
   inert `uSunEnergy` fixture.
2. **Vary the condition before concluding.** The kicker question took three
   riding policies to answer correctly and produced two wrong public claims on
   the way.

---

## Camera on steep ground (user note, 2026-08-08)

> "Camera angle and spray obscure the rider at times especially on steep
> sections. On flatter sections camera angle allows for very cinematic carve
> flows but this is obscured on steep sections. Keep the spray but fix the
> angle."

**Fixed and shipped (`105ff40`).** Both halves were one cause: the chase station
was built on a world-vertical up vector, so on a pitch the ground behind the
rider is *above* them (at 34° and 10 m back, ~6.7 m higher). The wanted station
was inside the hill, the clearance guard shoved it out, and the result was a
view down onto the helmet across a foreground roll — with the spray plume on
the sightline to the board. The station now measures against the slope: the
offset basis blends toward the surface normal as pitch steepens, and follow
distance is re-squared into that plane.

    slope     rider ndcY, before -> after
    30-39°      +1.372 -> -0.085     (was off the top of the frame)
    40-49°      +0.334 -> -0.190
     0-29°      unchanged to ~0.01 NDC

Spray untouched, as asked — it stops crossing the lens because the camera no
longer looks down through it.

### Still open: framing VARIANCE on pitched ground

The mean is fixed; the spread is not. p10..p90 of rider ndcY:

    flat  ( 0-19°)   0.13 - 0.17
    pitch (20-49°)   0.51 - 0.65

So roughly 4x wider, and the worst frames still drop the rider to the bottom
edge (visible in `shots/steep-after/flat-24deg-8ms.png`, a p10 outlier).

**Slope jitter is NOT the cause** — tested and refuted. Low-passing `s.slope`
over 0.45 s before it steers the basis changed the spread by nothing:

    band      spread with raw slope   with 0.45 s low-pass
    20-29°           0.585                   0.589
    30-39°           0.636                   0.646
    40-49°           0.508                   0.508

and made the 40-49° mean worse (-0.190 -> -0.435, a mean below its own p10, so
extreme outliers are dragging it). Reverted.

The variance has some other source — candidates not yet tested: the
terrain-clearance sweep firing intermittently, the range lock, or the spring
responding to the rider's own vertical motion over rolls. Whoever picks this up
should instrument which of those fires on the outlier frames rather than
guessing, and `framing.mjs`-style ndcY bucketing is the metric to use.
