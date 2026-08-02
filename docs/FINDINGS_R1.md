# Round 1 findings — first render of the full world stack

Measured from `shots/first/hero-basin.png` (960×540, all five world modules
live, full post chain). Recorded so the integration and critique phases start
from evidence rather than from a fresh guess.

## Headline: the frame is *not* clipping. It is flat and hot.

The obvious visual read is "blown out whiteout". The pixel statistics say
otherwise, and the distinction matters because it points at a different fix.

| Metric | Measured | ART_DIRECTION §1.1 target | Verdict |
| --- | --- | --- | --- |
| p99.9 luma | 238 | ≤ 252 | pass |
| Pure-white pixels | 0.000 % | ≤ 0.20 % | pass |
| Max luma | 239 | — | nothing at 255 |
| Mean luma | 212.1 | 130–185 | **~1 stop hot** |
| p50 luma | 218 | 120–200 | **over** |

Highlight rolloff is working: nothing reaches 255, and the top of the range is
held at 238–239. The tone curve is doing its job.

The actual defect is **tonal range collapse**. The frame runs p50 = 218 to
max = 239 — a span of about 21 levels across the entire upper half of the
histogram, with essentially no dark pixels at all. There is no shadowed snow in
frame, so there is nothing to model the terrain's form against, and a 200 m
headwall reads the same as a 2 m wind lip. This is the failure
`REFERENCE_ANALYSIS.md` warns about from the other direction: the reference
frames get their realism from the *ratio* between sunlit and shadowed snow
(linear 0.08–0.5), and here that ratio is close to 1.

## Diagnosis, in priority order

1. **Exposure is roughly one stop too high.** Mean 212 against a 130–185
   target. Reduce `CONFIG.render.exposure`, or the sun irradiance feeding it,
   until mean luma lands in range. This alone will not fix the flatness.
2. **There is no shadow in frame.** Either the directional light's shadow
   camera is not covering the visible terrain, cascades are misconfigured, or
   the sun elevation at the configured time of day is close enough to the
   surface normal that self-shadowing never triggers. Verify a shadow actually
   rasterises before tuning anything else — without it the scene cannot have
   form at any exposure.
3. **Aerial perspective is over-applied at short range.** The mid-ground is
   already washed to near sky value, which flattens the near-to-far value
   separation that the reference relies on for depth. It should be subtle
   inside ~500 m and strong beyond several km.
4. **Cloud layer shows a radial starburst artefact** near the zenith — streaks
   converging to a point, which reads as a UV/projection singularity at the
   pole of the sky dome rather than as cloud.
5. **No set dressing is visible** despite `props.js` shipping ~900 rocks, ~700
   poles and ~5 000 tussock clumps. Either the camera is pointed at a bare
   run-out, placement is failing against the new terrain, or the props are
   beyond the cull distance. Frame has 51 draw calls, so *something* is
   drawing — worth confirming what.
6. **Shot presets may be aimed at the wrong place.** `src/core/shots.js`
   composes around `terrain.getSpawn()`, which now returns real basin
   coordinates rather than the placeholder's. The hero framing may simply be
   pointed at a flat part of the run-out. Re-aim before concluding the terrain
   itself is featureless.

## Harness fix applied

`page.screenshot()` was inheriting Playwright's 30 s default and timing out —
the software rasteriser needs ~98 s to compose one 960×540 frame with the full
post chain. `tools/shoot.mjs` now takes `--shot-timeout` (default 600 s). Any
capture run before this fix would have failed at the screenshot step regardless
of how good the frame was.

## Performance baseline

Boot 8.4 s · 51 draw calls · 144 k triangles · **98 s per 960×540 frame** on
SwiftShader. Budget roughly 10–15 minutes of pure rasterisation for a full
eight-preset capture round, and scale critique resolution accordingly.
