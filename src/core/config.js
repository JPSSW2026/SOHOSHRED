/**
 * Central tuning surface for Soho Shred.
 *
 * Anything a designer or a tuning pass would want to reach lives here rather
 * than being buried in a system. Systems import CONFIG and read from it at
 * construction time (and per-frame where it is cheap to do so), which keeps the
 * screenshot harness able to override values before boot.
 */

/** Real-world anchor: Soho Basin sits on the Cardrona side of the Crown Range. */
export const LOCATION = {
  name: 'Soho Basin',
  resort: 'Cardrona Alpine Resort',
  region: 'Otago, New Zealand',
  latitude: -44.8748,
  longitude: 168.9486,
  // Soho Basin runs roughly 1400 m (valley floor / access) to 1860 m (ridge).
  baseElevation: 1410,
  summitElevation: 1865,
  // The basin faces broadly south-east, which is why it holds cold snow.
  aspectDegrees: 135,
  treeline: 1100, // NZ southern alps treeline is low — the basin is fully alpine.
};

export const CONFIG = {
  seed: 'soho-basin-2026',

  /** Renderer + presentation. */
  render: {
    // Software raster (headless CI) cannot afford full res; the harness
    // overrides these. On real hardware we target native resolution.
    pixelRatioCap: 2,
    antialias: true,
    // ACES-derived filmic curve, exposure tuned for high-albedo snow.
    //
    // Snow is the hardest subject there is to expose. At 1.05 the whole
    // snowfield sat on the flat shoulder of the AgX curve, so a 2:1 radiance
    // ratio between a sunlit and a shaded slope compressed into three sRGB
    // levels and the mountain rendered as a featureless white sheet. 0.6 fixed
    // the whiteout but not the flatness: round-3 captures measured mean frame
    // luma 161/180/191/192/199/202/203/218/225 across the nine presets — seven
    // of nine above ART_DIRECTION §1.1's 130–185 band — with medians of 233
    // (rider-portrait), 231 (snow-detail), 218 (valley-vista) and 214
    // (chase-carve) against the §1.1 / item-3 ceiling of 210.
    //
    // The size of the correction is set by the *slope* of AgX, not by a gamma
    // guess. On the neutral axis three's AgX reduces to
    //   t = (log2(L·E) + 12.47393) / 16.5   →   code = sRGB_OETF(poly(t)^2.2)
    // (all three of its matrices have unit row sums, so a grey stays a grey;
    // the curve tops out at 254.6, which is exactly why §1.1 measures p99.9 at
    // 228–252 and never 255). Differentiating that gives the levels of sRGB
    // separation a one-stop scene ratio actually renders as:
    //
    //   code   130   150   175   200   215   225   235   245
    //   Δ/stop 32.2  32.5  31.3  28.0  24.5  21.3  17.0  11.0
    //
    // Above ~200 the curve has already given up a third of its slope, and by
    // 235 it has given up half. That is the whole complaint: the frame is not
    // clipping, it is being rendered on the part of the curve that cannot
    // carry local contrast. A naive gamma-2.2 estimate says a half stop is
    // worth ~60 levels at code 199 and is wrong by 2.4×; the real curve is
    // worth ~28.
    //
    // 0.34 is −0.82 stop, and by the model above it puts seven of the nine
    // presets inside 130–185 (135, 155, 167, 168, 176, 180, 181), drops
    // valley-vista's median to ~199 and chase-carve's to ~194, and moves
    // hero-basin's near field off the shoulder — 221–227 → 203–211, where the
    // curve renders 27.4 levels/stop instead of 22.7, a 21% gain in rendered
    // surface modulation before any post change (checklist item 4). Sunlit
    // snow lands ~222 and shadowed snow ~123, both mid-distribution against
    // the §1.2 reference samples (sunlit 202–241, shadowed 78–170), so LAW 1
    // and LAW 3 keep their headroom in both directions.
    //
    // NOTE for anyone re-tuning: the bloom bright-pass knee is derived from
    // 1/exposure (postprocess.js), so it is invariant to this value by design.
    // Change it and re-measure; do not compensate for a veiled frame here.
    exposure: 0.34,

    /**
     * Per-shot exposure compensation, as a multiplier on `exposure`.
     *
     * Two presets are framed almost entirely on sunlit snow with no sky and
     * almost no shadow in frame, so their histogram *is* the snow: at the base
     * exposure they sit at mean 199/208 and median 219/216 no matter how well
     * the global stop is chosen, because there is nothing dark in the shot to
     * pull the mean down. A cinematographer meters each setup rather than
     * shooting a whole reel at one stop, and these are the two setups that
     * need it. The values below are the smallest correction that puts each
     * median under the item-3 ceiling of 210 without pushing sunlit snow below
     * the §1.2 reference range — deliberately *not* enough to force the mean
     * to the middle of the 130–185 band, because a frame that is 100% sunlit
     * snow rendering at mean 165 is an under-exposed frame, not a graded one.
     *
     *   rider-portrait  ×0.65 → mean ~182, median ~205
     *   snow-detail     ×0.60 → mean ~189, median ~199
     *
     * Anything not listed rides the base exposure. Consumed where a shot
     * preset is applied (see main.js `shot()`), by setting
     * `renderer.toneMappingExposure = CONFIG.render.exposure *
     * (CONFIG.render.shotExposure[name] ?? 1)` and restoring it afterwards.
     */
    shotExposure: {
      'rider-portrait': 0.75,
      'snow-detail': 0.60,
      // The other direction: these two are framed into the light and onto
      // shadowed slopes, so the base stop that suits a sunlit snowfield
      // leaves them at mean 73 and 109 against a 130-185 band. Metered, not
      // guessed - see the sweep in the commit that added them.
      'ridge-backlight': 4.70,
      'air-trick': 1.45,
    },
    toneMapping: 'agx',
    shadowMapSize: 4096,
    // Cascaded shadow map splits, in metres from the camera.
    csmCascades: [0, 28, 90, 260, 900],
    anisotropy: 16,
  },

  /** Time of day + weather. Drives sky, lighting, snow response and mood. */
  world: {
    // 09:40 local — low winter sun, long blue shadows, warm rim on the ridges.
    timeOfDay: 9.67,
    dayOfYear: 195, // mid-July: deep NZ winter
    // Bluebird after a clear cold night.
    weather: 'bluebird',
    windSpeed: 4.2, // m/s
    windDirection: 292, // degrees, from the north-west (the prevailing NW flow)
    temperature: -6.5, // degC — cold enough that the snow stays dry
    visibility: 42000, // m
  },

  /** Terrain extent and resolution. */
  terrain: {
    // The playable basin is ~2 km across; the visible range extends far beyond.
    size: 2048,
    // Heightfield resolution used for physics queries and collision.
    heightfieldRes: 1024,
    // Mesh LOD rings around the player.
    lodRings: 5,
    lodBaseRes: 128,
    maxAltitude: 1865,
    minAltitude: 1410,
    // Distant mountain backdrop (Crown Range, Pisa Range) radius.
    backdropRadius: 26000,
  },

  /** Board + rider physics. Units are metres, seconds, kilograms. */
  physics: {
    gravity: 9.81,
    riderMass: 78, // kg, rider + board + gear
    // Coefficient of friction of a waxed base on cold dry snow.
    baseFriction: 0.045,
    // Edge grip: how much lateral force a fully engaged edge can hold, in g.
    edgeGrip: 1.85,
    // Air drag: 0.5 * rho * Cd * A, tucked vs upright.
    dragTucked: 0.22,
    dragUpright: 0.55,
    // How deep the board sinks — drives spray volume and drag in powder.
    powderDepth: 0.55,
    maxSpeed: 34, // m/s (~122 km/h) — realistic terminal for a steep pitch
    fixedTimestep: 1 / 120,
    maxSubSteps: 8,
  },

  /** Chase camera. */
  camera: {
    fov: 62,
    near: 0.12,
    far: 40000,
    // Spring-damper follow.
    followDistance: 6.4,
    followHeight: 2.1,
    stiffness: 9.0,
    damping: 0.86,
    // FOV widens with speed for a sense of velocity.
    fovSpeedGain: 0.42,
    fovMax: 82,
    shakeAtSpeed: 0.35,
  },

  /** Post-processing chain. */
  post: {
    bloom: { enabled: true, threshold: 0.86, strength: 0.42, radius: 0.55 },
    dof: { enabled: true, focusDistance: 9, aperture: 0.9, maxBlur: 0.012 },
    motionBlur: { enabled: true, strength: 0.55, samples: 12 },
    grain: { enabled: true, strength: 0.022 },
    vignette: { enabled: true, strength: 0.34 },
    chromatic: { enabled: true, strength: 0.0018 },
    sharpen: { enabled: true, strength: 0.32 },
    ssao: { enabled: true, radius: 0.6, intensity: 0.75 },
  },

  /** Snow surface appearance. */
  snow: {
    // Fresh cold snow albedo is extremely high.
    albedo: 0.86,
    // Subsurface scattering tint — snow shadows go blue because the sky is
    // the only thing lighting them and light scatters far inside the pack.
    sssColor: [0.62, 0.74, 0.95],
    sssStrength: 0.62,
    sparkleDensity: 1400,
    sparkleStrength: 0.9,
    // Wind-carved ridges (sastrugi) on exposed aspects.
    sastrugiStrength: 0.55,
  },

  /** Debug + capture. */
  debug: {
    stats: false,
    freeCamera: false,
    wireframe: false,
    showColliders: false,
  },
};

/** Deep-merge an override object into CONFIG (used by the capture harness). */
export function applyOverrides(overrides) {
  const merge = (dst, src) => {
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof dst[k] === 'object' && dst[k] !== null) {
        merge(dst[k], v);
      } else {
        dst[k] = v;
      }
    }
  };
  if (overrides) merge(CONFIG, overrides);
  return CONFIG;
}
