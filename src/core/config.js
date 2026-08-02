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
    // Snow is the hardest subject there is to expose: at 1.05 the whole
    // snowfield sat on the flat shoulder of the AgX curve, so a 2:1 radiance
    // ratio between a sunlit and a shaded slope compressed into three sRGB
    // levels and the mountain rendered as a featureless white sheet. 0.6 puts
    // sunlit snow at ~235 (the top of the photographic range) and shaded snow
    // near 150, which is where the blue shadow and the surface modelling live.
    exposure: 0.6,
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
