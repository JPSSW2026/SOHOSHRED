# Round 3 findings — single-defect ablation

Round 1 and round 2 both ran wide (9 agents, many files at once) and both
*declined*: critic averages 2.7 → 2.3, with 9/9 blind identification every
time. Round 3 changed method: take one defect, isolate it by controlled
ablation, fix the root cause, and prove it with a measurement.

The first defect went the whole way. The second did not, and the negative
result is recorded here because it is worth more than a guess.

---

## SOLVED — the venetian-blind comb on the bluff faces (commit 83c2661)

All three round-2 critics named this the single most conspicuous artefact.

**Both earlier rounds attacked the wrong cause.** Two ablations settled it:

| Experiment | Result |
| --- | --- |
| Ledge-snow mask (`aSurface.w`) pinned to a constant | stripes **unchanged** |
| Foliation displacement zeroed | stripes **gone** |

The first rules out the mask — which is exactly what round 2 low-passed with a
5-tap kernel.

It was also **not aliasing**, which is what the code's own comments assumed and
what the whole `MIN_LAM` band-limit exists to prevent. Only the 3.8 m band
survives that limit, and at `ROW_STEP` 0.5 m that is 7.6 samples per
wavelength — comfortably inside the grid. The sampling theory was correct and
sampling was never the problem.

The real cause: the model was **too regular to be rock**. Uniform plate
spacing, uniform amplitude, plates running unbroken across a 300 m frontage.
At ~600 m each 3.8 m plate subtends ~5 px, so they stack into ~15 parallel
bands and read as a barcode.

Fixed as geology, not filtering: cross-jointing so plates step across
fractures, bed thickness varying over ~17 m, and relief cut 0.44 → 0.30 m.

**Measured** with `tools/banding.mjs` against the zero-displacement render as
ground truth: excess high-frequency energy **down 79 %**, with the foliation
relief retained.

---

## NOT SOLVED — the contour-parallel corduroy ripple

Visible over the entire shadowed mid-slope of `ridge-backlight`, and named by
all three round-2 critics ("fingerprint corrugation", "corduroy", "regular
parallel band pattern, visible unstretched").

**Seven ablations, all negative.** Each was built, captured and measured; the
ripple was unchanged in every one:

| Ablated | Ripple |
| --- | --- |
| `_micro()` — sastrugi micro-relief, λ 1.9 m | unchanged |
| All four detail-normal bands (`f1…f4 = 0`) | unchanged |
| `_phaseDrift()` — drift heightfield phase | unchanged |
| Sun shadow map (`castShadow = false`) | unchanged |
| `_thermalErosion()` — talus relaxation | unchanged |
| All eight post-processing effects | unchanged |
| (solifluction terraces — not run) | gated to `h ≤ 1456 m`; the affected slope is above it |

That eliminates surface detail, drift, shadowing, talus terracing and the
entire post chain. **The ripple is in the base terrain surface as rendered.**

Remaining candidates, in order of likelihood:

1. **Hydraulic erosion rills.** Droplet erosion on a regular grid produces
   parallel flow lines that follow the slope; this is the classic look.
2. **The ridged multifractal / landform noise itself** — a band whose
   wavelength lands near the post spacing.
3. **The clipmap mesh build** — specifically the snow-depth field applied at
   vertex time, which no ablation above touched.

Start at (1). Ablate `_hydraulicErosion` before anything else.

### The lesson that matters

Round 2's terrain agent *and* its snowMaterial agent both wrote extensive
comments claiming to have fixed this artefact. The snowMaterial comment even
describes it accurately — "a regular 6-8 px corrugation running unbroken over
hundreds of metres of mid-slope" — and added a distance fade for it. Both were
wrong: the artefact was never theirs to fix. Confident, well-written,
well-reasoned commentary attached to a fix that changes nothing is the
characteristic failure of the wide-fan-out rounds, and it is undetectable
without ablation.

**Never accept a stated cause without an ablation that toggles it.**

---

## NEW DEFECT FOUND — the schist tors are stacked discs

Disabling `_phaseDrift` (an experiment that was otherwise negative) exposed
what the drift phase had been half-burying: the tors render as **layered
wedding-cake stacks** — concentric discs of decreasing radius, with hard
horizontal steps.

This is almost certainly what the critics have been reporting as "small dark
blue-grey cuboids", "dice-like rock cuboids" and "pale square blocks scattered
on the ridge" across both rounds. At distance a stepped stack reads as a box.

It is currently masked in most framings by drift burying the lower steps, so
it looks like a placement or shading problem when it is actually the tor
geometry generator. `props.js`.

---

## Measurement tooling

`tools/banding.mjs` — orientation-agnostic banding metric: Laplacian energy
normalised by local contrast over a crop. Use a known-good ablation as the
control.

The first version of this metric scored the **no-stripes control as the worst**
of three variants, because the region sampled spanned snow and shadow and the
terrain's own row-to-row variation swamped the comb. It was the ablation
control that caught it. Any metric used to grade a fix must first be shown to
separate a positive control from a negative one.
