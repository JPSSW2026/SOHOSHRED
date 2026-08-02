/**
 * Soho Shred — sky, atmosphere, sun and aerial perspective.
 * =========================================================
 *
 * This module owns every photon in the game that does not come off a surface:
 * the sky dome, the solar disc, the directional light and its shadow map, the
 * image-based ambient (PMREM), the clouds, and — most importantly — the aerial
 * perspective that separates near from far.
 *
 * ## One scattering model, used everywhere
 *
 * Sky, haze, ambient and sun colour all come out of a *single* model, so they
 * cannot drift apart.  `ART_DIRECTION.md` §5.2 is explicit that the classic
 * failure — "peaks paler than the sky behind them", plus a visible band where a
 * fogged ridge meets sky — comes from fading terrain toward one flat fog colour
 * instead of toward *the sky at that elevation angle*.  Here a surface at
 * infinite distance provably converges to exactly the radiance the sky dome
 * draws in the same direction, because both evaluate the same function.  There
 * is no seam to hide.
 *
 * The model is single-scattering Rayleigh + Mie + ozone through a spherical,
 * exponentially-stratified atmosphere, plus an isotropic multiple-scattering
 * term, plus ground-albedo coupling — which matters here because a snowfield at
 * 0.86 albedo measurably brightens its own sky.
 *
 * The expensive part (the nested optical-depth integrals) runs **once on the
 * CPU** into 1-D tables indexed by the view ray's zenith cosine:
 *
 *     L(dir) = IR(dir.y)·phaseRayleigh(dir·sun)
 *            + IM(dir.y)·phaseMie(dir·sun)
 *            + IA(dir.y)·isotropicTint            // cloud deck
 *
 * The factorisation is not a shortcut: transmittance from a sample point to the
 * sun depends only on that point's altitude and the sun's zenith angle, and over
 * the ~100 km of atmosphere we can see the local zenith barely rotates.
 * Everything the eye reads as sun-relative structure — the Mie forward-scatter
 * halo, the darkening toward the anti-solar sky — lives in the phase functions,
 * which are evaluated exactly, per pixel.
 *
 * The tables are two `vec4` arrays and travel as plain uniform arrays, which
 * lets the *same* function run inside three.js's built-in materials (see
 * `installAerialPerspective`) with no per-material cooperation required.
 *
 * ## Aerial perspective
 *
 * Injected globally by replacing three's `fog_*` shader chunks and appending to
 * `opaque_fragment` — the last point at which `gl_FragColor` holds linear scene
 * radiance.  (three's stock `fog_fragment` sits *after* `<tonemapping_fragment>`
 * and `<colorspace_fragment>`, i.e. in display-referred space, which is
 * physically meaningless for scattering.)  For a fragment at world position P
 * seen from camera C:
 *
 *   - exact analytic column densities through the exponential Rayleigh (8 km),
 *     Mie (1.2 km) and valley-haze (250 m, referenced to the basin floor)
 *     profiles along the segment C→P;
 *   - extinction `T = exp(−τ)`, blue-selective by construction (β_B/β_R = 5.7);
 *   - in-scatter that is sun-direction dependent and converges to the full sky
 *     radiance as d → ∞.
 *
 * The valley-haze term is what gives the frame *vertical* structure: 8e-5 m⁻¹
 * at 1410 m with a 250 m scale height is a clearly visible softening along the
 * basin floor that has vanished by the crest (§5.3.2), and its green-channel
 * total works out to a 41 km meteorological range, matching
 * `CONFIG.world.visibility`.
 *
 * ## Compass conventions (please read before "fixing" the sun)
 *
 * Two binding documents disagree about which true bearing game −Z points along.
 * `ART_DIRECTION.md` §2.1 — the visual contract, and the higher-precedence
 * document — states the fall line runs on bearing 135° (matching
 * `LOCATION.aspectDegrees`) and that at the shipped `timeOfDay` the sun is "91°
 * to the rider's left, essentially abeam, and only 10.6° up".  The whole
 * acceptance checklist is written around that raking cross-light.
 * `TERRAIN_BRIEF.md` §2.1 adopts 225° instead, which places its §1.6 skyline
 * beautifully but puts the 09:40 sun directly behind the headwall, leaving the
 * entire basin unlit (its §2.12 says so, and recommends `timeOfDay: 15.0`).
 *
 * Both documents also make explicit *game-space* statements, and those do not
 * conflict, so we honour both:
 *
 *   - the **sun** is placed with `sunBearingOfMinusZ` (default
 *     `LOCATION.aspectDegrees` = 135), reproducing §2.1's abeam cross-light;
 *   - the **skyline** is already built by `terrain.js` out to
 *     `CONFIG.terrain.backdropRadius` on its own 225° mapping, so this module
 *     deliberately does not build a competing backdrop.
 *
 * Override with `CONFIG.sky.sunBearingOfMinusZ`.  Nothing is faked:
 * declination, equation of time, hour angle, altitude and azimuth are computed
 * from `LOCATION.latitude/longitude` and `CONFIG.world.dayOfYear/timeOfDay`
 * with the NOAA solar-position equations.
 *
 * ## Determinism
 *
 * No `Math.random()`.  Cloud shapes come from `Simplex`/`makeRng` seeded off
 * `CONFIG.seed`; cloud motion is a pure function of accumulated `dt`.
 */

import * as THREE from 'three';
import { CONFIG, LOCATION } from '../core/config.js';
import { makeRng, Simplex, clamp, clamp01, lerp, smoothstep } from '../core/rng.js';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Planet + atmosphere geometry (metres). */
const R_PLANET = 6371000;
const H_ATMO = 80000;
const R_ATMO = R_PLANET + H_ATMO;

/** Sea-level scattering coefficients, λ = (680, 550, 440) nm — Bruneton set. */
const BETA_RAYLEIGH = [5.802e-6, 13.558e-6, 33.1e-6];
const H_RAYLEIGH = 8000;
/** Mie *scattering*; extinction is scattering / single-scatter albedo. */
const BETA_MIE = 21e-6;
const MIE_SINGLE_ALBEDO = 0.9;
const H_MIE = 1200;
/** Ozone Chappuis band — a tent layer centred at 25 km. Deepens the low-sun blue. */
const BETA_OZONE = [0.650e-6, 1.881e-6, 0.085e-6];
const OZONE_CENTRE = 25000;
const OZONE_HALF_WIDTH = 15000;

/** Angular radius of the solar disc (radians). */
const SUN_ANGULAR_RADIUS = 0.004654;
const SUN_SOLID_ANGLE = Math.PI * SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS;

/**
 * Top-of-atmosphere solar irradiance expressed in renderer units.  This single
 * scale ties physical radiance to the linear values the tone mapper sees; every
 * other light level in the frame derives from it, so sky, sun and haze cannot
 * come apart.  Calibrated so snow at 0.86 albedo under the shipped 10.6° sun
 * lands in AgX's shoulder (~0.75–0.9 output) rather than clipping — see
 * `ART_DIRECTION.md` §4.3.
 */
const SOLAR_IRRADIANCE_UNITS = 41.0;

/**
 * Strength of the isotropic multiple-scattering + ground-coupling term,
 * relative to the physically-estimated mean sphere radiance at each sample.
 * Calibrated so the zenith lands on `ART_DIRECTION.md` §1.4's measured
 * `#0F4C8E`–`#2A64A6` through AgX at `CONFIG.render.exposure`: too little and
 * the sky is a black-blue void, too much and it greys out and fails §12.
 */
const MS_STRENGTH = 0.27;

/**
 * The camera, in three constants.  These are the only numbers in this file that
 * are not pure atmospheric physics, and each stands for a real thing a
 * photographer does when shooting snow.  They were fitted offline against
 * `ART_DIRECTION.md` §1.2/§1.4/§12 through three's exact AgX curve at
 * `CONFIG.render.exposure`; the resulting frame satisfies LAW 1, LAW 2, LAW 3
 * and acceptance items 6–9 and 22 simultaneously, which no single knob can do.
 *
 * `WHITE_BALANCE` — daylight white balance locked to the direct beam.  At 1.0
 * the sun renders perfectly neutral; 0.9 leaves a trace of the 4470 K warmth on
 * rock and rime.  This is what makes LAW 1 ("sunlit snow is neutral") true *by
 * construction* while simultaneously pushing the 15,000 K skylight to the deep
 * blue §1.4 measures — the two are the same operation, seen from both ends.
 *
 * `POLARISER` — a circular polariser, which is permanently on the front of
 * every lens that has ever shot a snowboard film.  It removes up to this
 * fraction of the *polarised* component of the sky, and Rayleigh single
 * scattering is ~99% polarised at 90° from the sun.  With our abeam sun that is
 * the entire forward view, so the sky over the fall line goes navy while the
 * snow — which reflects almost unpolarised — is untouched.  It applies to the
 * sky as *seen*, never to the sky as a *light source*: the environment probe
 * compiles with it disabled, so the fill stays physical.
 *
 * `SKY_CALIBRATION` — a single scale on sky radiance.  It stands in for the two
 * things this renderer cannot trace: the terrain that occludes the low sky from
 * a point inside a cirque (a large share of the hemispherical irradiance), and
 * the absence of true global illumination.  What that terrain reflects back is
 * returned explicitly by `BOUNCE_VIEW_FACTOR` below.
 */
const WHITE_BALANCE = 0.90;
const POLARISER = 0.80;
const SKY_CALIBRATION = 0.65;

/**
 * Fraction of a surface's hemisphere filled by the surrounding snowfield.
 *
 * `ART_DIRECTION.md` §4.1: the bounce off 0.86-albedo snow is roughly 2× the
 * sky fill, and "nothing in an open-slope frame is genuinely dark".  With no
 * GI, that bounce is delivered as an explicit ambient term whose colour and
 * magnitude are computed from the actual horizontal irradiance every time the
 * sky is rebuilt — so it tracks time of day and weather instead of being a
 * fixed grey lift.
 */
const BOUNCE_VIEW_FACTOR = 0.085;

/** Resolution of the sky radiance tables (bins in zenith cosine). */
const LUT_N = 20;

/** Rec.709 luminance weights. */
const LW = [0.2126, 0.7152, 0.0722];
const lum3 = (a) => LW[0] * a[0] + LW[1] * a[1] + LW[2] * a[2];

/** Default: game −Z ≡ true bearing 135° (SE) — `LOCATION.aspectDegrees`. */
const DEFAULT_SUN_BEARING_OF_MINUS_Z = LOCATION.aspectDegrees ?? 135;

/**
 * Weather presets.  Each moves the *whole* system coherently: aerosol load
 * (sky colour, halo size, haze), the cloud deck (how much sun survives and how
 * far the sky's angular distribution flattens toward the CIE overcast curve),
 * and the valley haze.
 *
 *   turbidity        aerosol multiplier on the Mie coefficient
 *   deckSky          fraction of the sky the deck actually occults
 *   deckCover        coverage fed to the cloud shader (visual density)
 *   sunTransmission  direct-beam survival through the deck
 *   haze             valley-haze β (m⁻¹) at the reference altitude, §5.3.2
 */
const WEATHER = {
  bluebird: {
    turbidity: 1.0,
    deckSky: 0.02,
    deckCover: 0.06,
    deckAltitude: 3600,
    cirrus: 0.34,
    lenticular: 0.85,
    ridgeBank: 0.42,
    sunTransmission: 1.0,
    haze: 8.0e-5,
    hazeScaleHeight: 250,
    aerosolTint: [1.0, 0.98, 0.95],
    msGain: 1.0,
  },
  golden: {
    // Warm absorbing aerosol: more Mie, redder extinction, a bigger aureole.
    turbidity: 2.3,
    deckSky: 0.06,
    deckCover: 0.12,
    deckAltitude: 3200,
    cirrus: 0.58,
    lenticular: 1.0,
    ridgeBank: 0.55,
    sunTransmission: 0.94,
    haze: 1.9e-4,
    hazeScaleHeight: 340,
    aerosolTint: [1.0, 0.86, 0.66],
    msGain: 1.12,
  },
  overcast: {
    turbidity: 3.4,
    deckSky: 0.90,
    deckCover: 0.92,
    deckAltitude: 2400,
    cirrus: 0.15,
    lenticular: 0.15,
    ridgeBank: 1.0,
    sunTransmission: 0.20,
    haze: 3.4e-4,
    hazeScaleHeight: 420,
    aerosolTint: [0.98, 0.99, 1.0],
    msGain: 1.35,
  },
  storm: {
    turbidity: 5.2,
    deckSky: 1.0,
    deckCover: 1.0,
    deckAltitude: 1900,
    cirrus: 0.05,
    lenticular: 0.05,
    ridgeBank: 1.0,
    sunTransmission: 0.07,
    haze: 9.5e-4,
    hazeScaleHeight: 620,
    aerosolTint: [0.94, 0.96, 1.0],
    msGain: 1.5,
  },
};

/* ------------------------------------------------------------------ *
 * Solar position — NOAA equations, no fudging
 * ------------------------------------------------------------------ */

/**
 * True solar position for a site and a local clock time.
 *
 * @param {number} dayOfYear   1..366
 * @param {number} hourLocal   local clock hours (decimal)
 * @param {number} latDeg      latitude, north positive
 * @param {number} lonDeg      longitude, east positive
 * @param {number} tzHours     standard-time offset from UTC, east positive
 * @returns {{altitude:number, azimuth:number, declination:number,
 *            hourAngle:number, equationOfTime:number, airMass:number}}
 *          Angles in radians except `equationOfTime` (minutes); `azimuth` is
 *          the sun's true bearing measured clockwise from north.
 */
export function solarPosition(dayOfYear, hourLocal, latDeg, lonDeg, tzHours) {
  // Fractional year (radians).
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (hourLocal - 12) / 24);

  // Equation of time, minutes (NOAA / Spencer series).
  const eqTime = 229.18 * (
    0.000075
    + 0.001868 * Math.cos(g)
    - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g)
    - 0.040849 * Math.sin(2 * g)
  );

  // Solar declination, radians (Spencer).
  const decl = 0.006918
    - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);

  // Longitude + equation-of-time correction, in minutes of clock time.
  // At Soho (168.95°E) against the 180°E standard meridian this is −44.2 min.
  const timeOffset = eqTime + 4 * lonDeg - 60 * tzHours;
  const trueSolarMinutes = hourLocal * 60 + timeOffset;
  const hourAngle = (trueSolarMinutes / 4 - 180) * DEG;

  const lat = latDeg * DEG;
  const sinAlt = Math.sin(lat) * Math.sin(decl)
    + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const altitude = Math.asin(clamp(sinAlt, -1, 1));

  // Azimuth from south, westward positive → bearing from north.
  const azFromSouth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat),
  );
  let azimuth = azFromSouth + Math.PI;
  azimuth = ((azimuth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  // Kasten–Young relative air mass, clamped once the sun is below the horizon.
  const altDeg = altitude * RAD;
  const airMass = altDeg > -1
    ? 1 / (Math.sin(altitude) + 0.50572 * Math.pow(Math.max(altDeg, 0) + 6.07995, -1.6364))
    : 40;

  return { altitude, azimuth, declination: decl, hourAngle, equationOfTime: eqTime, airMass };
}

/**
 * Planckian locus → linear sRGB, normalised so the largest channel is 1.
 *
 * Used for the direct-beam colour.  `ART_DIRECTION.md` §4.2 tabulates the values
 * we are expected to hit (4500 K → 1.00, 0.82, 0.68 at our sun angle).  A pure
 * extinction calculation over-reddens a 10° sun relative to what a calibrated
 * camera records, because it ignores the circumsolar aureole a lens integrates
 * back into the beam; the CCT curve is the measured answer, so chromaticity
 * comes from here while the *magnitude* stays physical (see `_refreshSky`).
 */
export function cctToLinearRGB(cct) {
  const t = clamp(cct, 1500, 25000);
  // CIE 1931 approximation of the Planckian locus (Kim et al.).
  const t1 = 1000 / t, t2 = t1 * t1, t3 = t2 * t1;
  let x;
  if (t <= 4000) x = -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t1 + 0.179910;
  else x = -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t1 + 0.240390;
  const x2 = x * x, x3 = x2 * x;
  let y;
  if (t <= 2222) y = -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683;
  else if (t <= 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;

  const Y = 1;
  const X = (x / Math.max(y, 1e-4)) * Y;
  const Z = ((1 - x - y) / Math.max(y, 1e-4)) * Y;

  // XYZ → linear sRGB (sRGB primaries, D65).
  let r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let gg = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  let b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  r = Math.max(r, 0); gg = Math.max(gg, 0); b = Math.max(b, 0);
  const m = Math.max(r, gg, b, 1e-6);
  return [r / m, gg / m, b / m];
}

/** Correlated colour temperature of the direct beam at a given solar altitude. */
function sunCCT(altitudeRad, weather) {
  const a = clamp(altitudeRad * RAD, -2, 90);
  // Fitted through ART_DIRECTION §4.2: ~3400 K at the horizon, 4500 K at 10.6°,
  // 5000 K near 20°, asymptotic to ~5700 K high up.
  const k = 3400 + 2300 * (1 - Math.exp(-a / 13.5));
  // A warm absorbing aerosol load (the 'golden' preset) pulls it further down.
  const warm = weather.aerosolTint[2] < 0.8 ? 340 : 0;
  return clamp(k - warm, 2800, 6000);
}

/* ------------------------------------------------------------------ *
 * Atmosphere tables (CPU)
 * ------------------------------------------------------------------ */

/** Distance from radius `r` along a ray with zenith cosine `mu` to sphere `R`. */
function raySphereExit(r, mu, R) {
  const disc = r * r * (mu * mu - 1) + R * R;
  if (disc < 0) return 0;
  return Math.max(0, -r * mu + Math.sqrt(disc));
}

/** Distance to the planet surface, or -1 if the ray misses it. */
function rayGroundHit(r, mu) {
  if (mu >= 0) return -1;
  const disc = r * r * (mu * mu - 1) + R_PLANET * R_PLANET;
  if (disc < 0) return -1;
  const d = -r * mu - Math.sqrt(disc);
  return d > 0 ? d : -1;
}

function ozoneDensity(h) {
  return Math.max(0, 1 - Math.abs(h - OZONE_CENTRE) / OZONE_HALF_WIDTH);
}

/**
 * Optical depth from an altitude out to space along zenith cosine `mu`.
 * Returns false (and leaves `out` at zero) when the ray is blocked by the
 * planet, which is how the terminator gets handled without a special case.
 */
function opticalDepthToSpace(h, mu, betaMieExt, out) {
  const r = R_PLANET + h;
  out[0] = out[1] = out[2] = 0;
  if (rayGroundHit(r, mu) > 0) return false;
  const len = raySphereExit(r, mu, R_ATMO);
  if (len <= 0) return true;
  const STEPS = 10;
  const ds = len / STEPS;
  for (let i = 0; i < STEPS; i++) {
    const s = (i + 0.5) * ds;
    const hh = Math.max(0, Math.sqrt(r * r + s * s + 2 * r * s * mu) - R_PLANET);
    const dr = Math.exp(-hh / H_RAYLEIGH);
    const dm = Math.exp(-hh / H_MIE);
    const doz = ozoneDensity(hh);
    out[0] += (BETA_RAYLEIGH[0] * dr + betaMieExt * dm + BETA_OZONE[0] * doz) * ds;
    out[1] += (BETA_RAYLEIGH[1] * dr + betaMieExt * dm + BETA_OZONE[1] * doz) * ds;
    out[2] += (BETA_RAYLEIGH[2] * dr + betaMieExt * dm + BETA_OZONE[2] * doz) * ds;
  }
  return true;
}

const _odA = [0, 0, 0];
const _odB = [0, 0, 0];

/** Map a zenith cosine to [0,1] with resolution concentrated at the horizon. */
function lutCoord(mu) {
  const s = mu < 0 ? -1 : 1;
  return clamp01(0.5 + 0.5 * s * Math.sqrt(Math.abs(mu)));
}
function lutCoordInverse(t) {
  const u = (t - 0.5) * 2;
  return (u < 0 ? -1 : 1) * u * u;
}

function phaseRayleigh(c) { return (3 / (16 * Math.PI)) * (1 + c * c); }
function phaseMie(c, g) {
  const g2 = g * g;
  const d = Math.max(1 + g2 - 2 * g * c, 1e-4);
  return (3 / (8 * Math.PI)) * ((1 - g2) * (1 + c * c)) / ((2 + g2) * Math.pow(d, 1.5));
}
/** Spherical mean of the Rayleigh phase function. */
const PHASE_MEAN = 1 / (4 * Math.PI);

/**
 * Build the sky radiance tables.
 *
 * `ir` and `im` are `LUT_N × 3` in-scatter integrals along a view ray leaving
 * the camera, *without* the phase function applied; `ia` is an isotropic term
 * (the cloud deck) with a single chromaticity `iaTint`.  Radiance is then
 *
 *     L = ir·phaseRayleigh(cosθ) + im·phaseMie(cosθ, g) + ia·iaTint
 *
 * Multiple scattering is estimated from the computed sky irradiance plus the
 * snowfield's own bounce, summed as a geometric series and folded into `ir`
 * (scaled by 1/⟨phaseRayleigh⟩ so its spherical mean is preserved).  Ignoring
 * it makes a high-altitude sky far too dark and far too saturated.
 *
 * @param {object} opts
 * @param {number} opts.eyeAltitude   metres above sea level
 * @param {number} opts.sunMu         cosine of the solar zenith angle
 * @param {object} opts.weather       one of the WEATHER presets
 * @param {number} [opts.groundAlbedo]
 * @param {number} [opts.mieG]
 */
export function buildAtmosphereTables(opts) {
  const eyeAlt = opts.eyeAltitude;
  const sunMu = clamp(opts.sunMu, -1, 1);
  const w = opts.weather;
  const groundAlbedo = opts.groundAlbedo ?? 0.82;
  const mieG = opts.mieG ?? 0.76;

  const betaMieScat = BETA_MIE * w.turbidity;
  const betaMieExt = betaMieScat / MIE_SINGLE_ALBEDO;
  const tint = w.aerosolTint;

  const ir = new Float32Array(LUT_N * 3);
  const im = new Float32Array(LUT_N * 3);
  const ia = new Float32Array(LUT_N);
  const iaTint = [1.0, 1.0, 1.0];
  // Column of scattering mass per direction, reused by the multiple-scatter pass.
  const massR = new Float32Array(LUT_N);
  const massM = new Float32Array(LUT_N);

  // --- Direct-beam transmittance down to the camera ----------------------
  const sunT = [0, 0, 0];
  const sunLit = opticalDepthToSpace(eyeAlt, sunMu, betaMieExt, _odA);
  for (let c = 0; c < 3; c++) sunT[c] = sunLit ? Math.exp(-_odA[c]) : 0;

  const rEye = R_PLANET + eyeAlt;
  const STEPS = 28;

  // --- Pass 1: single scattering ------------------------------------------
  for (let i = 0; i < LUT_N; i++) {
    const mu = clamp(lutCoordInverse(i / (LUT_N - 1)), -1, 1);
    const ground = rayGroundHit(rEye, mu);
    const len = ground > 0 ? ground : raySphereExit(rEye, mu, R_ATMO);
    if (len <= 0) continue;

    let tau0 = 0, tau1 = 0, tau2 = 0;
    let accR0 = 0, accR1 = 0, accR2 = 0;
    let accM0 = 0, accM1 = 0, accM2 = 0;
    let mR = 0, mM = 0;

    // Quadratic step distribution: dense near the camera, where the air is thick.
    for (let k = 0; k < STEPS; k++) {
      const t0 = (k / STEPS) ** 2;
      const t1 = ((k + 1) / STEPS) ** 2;
      const ds = (t1 - t0) * len;
      if (ds <= 0) continue;
      const s = 0.5 * (t0 + t1) * len;
      const h = Math.max(0, Math.sqrt(rEye * rEye + s * s + 2 * rEye * s * mu) - R_PLANET);
      const dr = Math.exp(-h / H_RAYLEIGH);
      const dm = Math.exp(-h / H_MIE);
      const doz = ozoneDensity(h);

      // View-ray transmittance, evaluated at the segment midpoint.
      const e0 = (BETA_RAYLEIGH[0] * dr + betaMieExt * dm + BETA_OZONE[0] * doz) * ds;
      const e1 = (BETA_RAYLEIGH[1] * dr + betaMieExt * dm + BETA_OZONE[1] * doz) * ds;
      const e2 = (BETA_RAYLEIGH[2] * dr + betaMieExt * dm + BETA_OZONE[2] * doz) * ds;
      const tv0 = Math.exp(-(tau0 + 0.5 * e0));
      const tv1 = Math.exp(-(tau1 + 0.5 * e1));
      const tv2 = Math.exp(-(tau2 + 0.5 * e2));
      tau0 += e0; tau1 += e1; tau2 += e2;

      // Sun transmittance at the sample.  The local solar zenith rotates by
      // well under a degree over the distances we can see, so `sunMu` holds.
      const lit = opticalDepthToSpace(h, sunMu, betaMieExt, _odB);
      const ts0 = lit ? Math.exp(-_odB[0]) : 0;
      const ts1 = lit ? Math.exp(-_odB[1]) : 0;
      const ts2 = lit ? Math.exp(-_odB[2]) : 0;

      const wr = dr * ds, wm = dm * ds;
      accR0 += tv0 * ts0 * BETA_RAYLEIGH[0] * wr;
      accR1 += tv1 * ts1 * BETA_RAYLEIGH[1] * wr;
      accR2 += tv2 * ts2 * BETA_RAYLEIGH[2] * wr;
      accM0 += tv0 * ts0 * betaMieScat * wm * tint[0];
      accM1 += tv1 * ts1 * betaMieScat * wm * tint[1];
      accM2 += tv2 * ts2 * betaMieScat * wm * tint[2];

      mR += tv1 * BETA_RAYLEIGH[1] * wr;
      mM += tv1 * betaMieScat * wm;
    }

    const o = i * 3;
    ir[o] = accR0; ir[o + 1] = accR1; ir[o + 2] = accR2;
    im[o] = accM0; im[o + 1] = accM1; im[o + 2] = accM2;
    massR[i] = mR; massM[i] = mM;
  }

  // --- Hemispherical irradiance of the current tables ---------------------
  const sunHoriz = Math.sqrt(Math.max(0, 1 - sunMu * sunMu));
  const _rad = [0, 0, 0];
  const sampleRadiance = (dirY, cosTheta, out) => {
    const f = lutCoord(dirY) * (LUT_N - 1);
    const i0 = Math.min(LUT_N - 1, Math.max(0, Math.floor(f)));
    const i1 = Math.min(LUT_N - 1, i0 + 1);
    const t = f - i0;
    const pr = phaseRayleigh(cosTheta);
    const pm = phaseMie(cosTheta, mieG);
    const iso = ia[i0] * (1 - t) + ia[i1] * t;
    for (let c = 0; c < 3; c++) {
      const a = ir[i0 * 3 + c] * (1 - t) + ir[i1 * 3 + c] * t;
      const b = im[i0 * 3 + c] * (1 - t) + im[i1 * 3 + c] * t;
      out[c] = a * pr + b * pm + iso * iaTint[c];
    }
  };

  const integrateSkyIrradiance = () => {
    const E = [0, 0, 0];
    const NT = 12, NP = 24;
    for (let a = 0; a < NT; a++) {
      const th = ((a + 0.5) / NT) * (Math.PI / 2);
      const sinT = Math.sin(th), cosT = Math.cos(th);
      const dOmegaBase = (Math.PI / 2 / NT) * ((2 * Math.PI) / NP) * sinT * cosT;
      for (let b = 0; b < NP; b++) {
        const ph = ((b + 0.5) / NP) * 2 * Math.PI;
        const dx = sinT * Math.cos(ph), dy = cosT, dz = sinT * Math.sin(ph);
        const c = dx * sunHoriz + dy * sunMu + dz * 0;
        sampleRadiance(dy, c, _rad);
        E[0] += _rad[0] * dOmegaBase;
        E[1] += _rad[1] * dOmegaBase;
        E[2] += _rad[2] * dOmegaBase;
      }
    }
    return E;
  };

  let E = integrateSkyIrradiance();

  // --- Pass 2: isotropic multiple scattering + ground coupling ------------
  // Source radiance: the sky's own diffuse field plus the snowfield bounce,
  // summed as a geometric series — the standard cheap stand-in for a full
  // multiple-scattering LUT.  Everything here is in model units (E0 = 1).
  const sunUp = Math.max(0, sunMu);
  const src = [0, 0, 0];
  // Mean radiance over the *full sphere* at a scattering point: the snowfield
  // fills the lower hemisphere (attenuated, and shrinking with altitude), the
  // sky fills the upper.  J_ms = beta_scatter * meanRadiance, so this is the
  // quantity the isotropic source needs — not the sum of the two.
  const GROUND_VIEW = 0.55;
  for (let c = 0; c < 3; c++) {
    const horizontal = sunT[c] * sunUp + E[c];
    const groundRadiance = (groundAlbedo * horizontal) / Math.PI;
    const skyRadiance = E[c] / Math.PI;
    src[c] = 0.5 * groundRadiance * GROUND_VIEW + 0.5 * skyRadiance;
  }
  const series = MS_STRENGTH * w.msGain;
  for (let i = 0; i < LUT_N; i++) {
    const o = i * 3;
    const mass = massR[i] + massM[i];
    // Folded through the Rayleigh phase: divide by its spherical mean so the
    // energy of the isotropic term survives the multiplication in the shader.
    for (let c = 0; c < 3; c++) ir[o + c] += (mass * src[c] * series) / PHASE_MEAN;
  }

  E = integrateSkyIrradiance();

  // --- Cloud deck ---------------------------------------------------------
  // The deck occults the clear sky and replaces it with a CIE-standard-overcast
  // dome whose irradiance is a realistic fraction of the clear-sky global
  // horizontal.  Handling it here — rather than as a shader overlay — is what
  // keeps ambient, IBL, haze and the visible sky agreeing under every preset.
  const deck = clamp01(w.deckSky);
  if (deck > 0.001) {
    const clearGlobal = lum3(sunT) * sunUp + lum3(E);
    // Overcast global horizontal is roughly 0.30–0.55 of the clear value.
    const deckE = clearGlobal * lerp(0.55, 0.30, deck) * deck;
    // ∫ L cosθ dω for L(θz) = Lz(1 + 2cosθz)/3 over the hemisphere = Lz·π·7/9.
    const Lz = deckE / (Math.PI * (7 / 9));
    // Cloud base: neutral, a touch cool, and darker under a storm.
    const base = lerp(1.0, 0.72, clamp01((deck - 0.85) / 0.15));
    iaTint[0] = 0.985 * base; iaTint[1] = 1.0 * base; iaTint[2] = 1.045 * base;

    const occlude = 1 - deck * 0.95;
    for (let i = 0; i < LUT_N; i++) {
      const mu = clamp(lutCoordInverse(i / (LUT_N - 1)), -1, 1);
      const o = i * 3;
      for (let c = 0; c < 3; c++) {
        ir[o + c] *= occlude;
        im[o + c] *= 1 - deck * 0.985;   // the halo is the first thing to go
      }
      ia[i] = Lz * ((1 + 2 * Math.max(0, mu)) / 3);
    }
    E = integrateSkyIrradiance();
  }

  // --- Scale into renderer units -----------------------------------------
  for (let i = 0; i < LUT_N * 3; i++) {
    ir[i] *= SOLAR_IRRADIANCE_UNITS;
    im[i] *= SOLAR_IRRADIANCE_UNITS;
  }
  for (let i = 0; i < LUT_N; i++) ia[i] *= SOLAR_IRRADIANCE_UNITS;

  const skyIrradiance = [
    E[0] * SOLAR_IRRADIANCE_UNITS,
    E[1] * SOLAR_IRRADIANCE_UNITS,
    E[2] * SOLAR_IRRADIANCE_UNITS,
  ];

  // Diagnostics — used by the calibration tests and handy when tuning exposure.
  const zenith = [0, 0, 0], horizonSun = [0, 0, 0], antisolar = [0, 0, 0];
  sampleRadiance(1, sunMu, zenith);
  sampleRadiance(0, sunHoriz, horizonSun);
  sampleRadiance(0.4, -0.6, antisolar);
  for (let c = 0; c < 3; c++) {
    zenith[c] *= SOLAR_IRRADIANCE_UNITS;
    horizonSun[c] *= SOLAR_IRRADIANCE_UNITS;
    antisolar[c] *= SOLAR_IRRADIANCE_UNITS;
  }

  return {
    ir, im, ia, iaTint,
    sunTransmittance: sunT,
    skyIrradiance,
    zenith, horizonSun, antisolar,
    betaMieScat, betaMieExt,
  };
}

/* ------------------------------------------------------------------ *
 * Shared GLSL
 * ------------------------------------------------------------------ */

/**
 * The uniform block plus the evaluation functions shared by the sky dome, the
 * environment probe, the cloud banks and the injected aerial perspective — one
 * implementation of the scattering maths on the GPU, not four.
 *
 * sohoAtmo packing:
 *   [0].xyz sun direction (world, toward the sun)   [0].w  enable flag
 *   [1].xyz Rayleigh β at sea level (m⁻¹)           [1].w  Mie extinction β
 *   [2].x   Rayleigh scale height                   [2].y  Mie scale height
 *   [2].z   valley haze β at the reference altitude [2].w  haze scale height
 *   [3].x   haze reference altitude                 [3].y  Mie asymmetry g
 *   [3].z   aerial-perspective strength             [3].w  haze sky-lit fraction
 *   [4].xyz haze illuminant tint                    [4].w  sun disc intensity
 *   [5].xyz sun beam colour                         [5].w  disc softness (rad)
 *   [6].xyz isotropic (cloud deck) tint             [6].w  polariser strength
 *   [7].xyz solar irradiance reaching the ground    [7].w  aureole radiance
 *
 * sohoSkyR[i] = ( Rayleigh integral .xyz, isotropic deck radiance .w )
 * sohoSkyM[i] = ( Mie integral .xyz, unused .w )
 */
const ATMO_GLSL = /* glsl */ `
#ifndef SOHO_ATMO
#define SOHO_ATMO
#define SOHO_LUT_N ${LUT_N}

uniform vec4 sohoAtmo[ 8 ];
uniform vec4 sohoSkyR[ SOHO_LUT_N ];
uniform vec4 sohoSkyM[ SOHO_LUT_N ];

float sohoLutCoord( float mu ) {
	float s = mu < 0.0 ? -1.0 : 1.0;
	return clamp( 0.5 + 0.5 * s * sqrt( abs( mu ) ), 0.0, 1.0 );
}

void sohoSampleTables( float mu, out vec4 sr, out vec4 sm ) {
	float f = sohoLutCoord( mu ) * float( SOHO_LUT_N - 1 );
	int i0 = int( floor( f ) );
	int i1 = min( i0 + 1, SOHO_LUT_N - 1 );
	float t = f - float( i0 );
	sr = mix( sohoSkyR[ i0 ], sohoSkyR[ i1 ], t );
	sm = mix( sohoSkyM[ i0 ], sohoSkyM[ i1 ], t );
}

float sohoPhaseR( float c ) {
	return 0.0596831 * ( 1.0 + c * c );
}

float sohoPhaseM( float c, float g ) {
	float g2 = g * g;
	float d = max( 1.0 + g2 - 2.0 * g * c, 1e-4 );
	return 0.1193662 * ( ( 1.0 - g2 ) * ( 1.0 + c * c ) ) / ( ( 2.0 + g2 ) * pow( d, 1.5 ) );
}

/**
 * Circular-polariser transmission for the Rayleigh component.
 *
 * Rayleigh single scattering is linearly polarised with degree
 * sin²θ / (1 + cos²θ), i.e. ~99% at 90° from the sun.  Multiply-scattered light
 * and Mie light are effectively depolarised and are left alone, which is why a
 * polariser deepens a clean high-altitude sky so much more than a hazy one.
 *
 * Disabled inside the environment probe: the filter sits in front of the
 * *camera*, not between the sky and the snow, so it must never touch the light
 * that actually falls on the world.
 */
float sohoPolariser( float c, float mu ) {
	#ifdef SOHO_ENV
		return 1.0;
	#else
		float P = ( 1.0 - c * c ) / ( 1.0 + c * c );
		// Long, low paths are depolarised by multiple scattering and by ground
		// reflection — the reason a polariser guts the high sky and barely
		// touches the horizon.  Modelling that is not optional: without it the
		// aerial perspective loses its blue and the far field goes milky grey,
		// which is tell #32.
		float depol = mix( 0.22, 1.0, smoothstep( 0.0, 0.42, mu ) );
		return 1.0 - sohoAtmo[ 6 ].w * P * depol;
	#endif
}

/** Full-path sky radiance for a world-space view direction. */
vec3 sohoSkyRadiance( vec3 dir ) {
	vec4 sr, sm;
	sohoSampleTables( dir.y, sr, sm );
	float c = dot( dir, sohoAtmo[ 0 ].xyz );
	return sr.xyz * sohoPhaseR( c ) * sohoPolariser( c, dir.y )
		+ sm.xyz * sohoPhaseM( c, sohoAtmo[ 3 ].y )
		+ sr.w * sohoAtmo[ 6 ].xyz;
}

/**
 * Exact column integral of exp( -( h - href ) / H ) along a straight segment of
 * length d running from altitude h0 to h1.  Linear-in-h is correct for a
 * straight ray; the small-k branch keeps it stable when the segment is level.
 */
float sohoColumn( float h0, float h1, float d, float H, float href ) {
	float a = exp( - ( h0 - href ) / H );
	float b = exp( - ( h1 - href ) / H );
	float k = ( h1 - h0 ) / H;
	return abs( k ) < 1e-4 ? d * 0.5 * ( a + b ) : d * ( a - b ) / k;
}

/**
 * Aerial perspective for a surface fragment.
 *
 * As d → ∞ the extinction goes to zero and the in-scatter converges to
 * sohoSkyRadiance( dir ), i.e. a distant ridge fades toward the sky at its
 * own elevation angle.  That removes the horizon band and the "peaks paler
 * than the sky" artefact as a matter of arithmetic rather than of tuning.
 */
vec3 sohoAerialPerspective( vec3 color, vec3 worldPos, vec3 camPos ) {
	if ( sohoAtmo[ 0 ].w < 0.5 ) return color;

	vec3 D = worldPos - camPos;
	float d = length( D );
	if ( d < 0.05 ) return color;
	vec3 dir = D / d;

	// Mean density of each species along the segment, from the exact
	// exponential column integrals.
	float invD = 1.0 / d;
	float rhoR = sohoColumn( camPos.y, worldPos.y, d, sohoAtmo[ 2 ].x, 0.0 ) * invD;
	float rhoM = sohoColumn( camPos.y, worldPos.y, d, sohoAtmo[ 2 ].y, 0.0 ) * invD;
	float rhoH = sohoColumn( camPos.y, worldPos.y, d, sohoAtmo[ 2 ].w, sohoAtmo[ 3 ].x ) * invD;

	vec3 betaR = sohoAtmo[ 1 ].xyz * rhoR;
	float betaM = sohoAtmo[ 1 ].w * rhoM;
	float betaH = sohoAtmo[ 2 ].z * rhoH;
	vec3 betaExt = betaR + vec3( betaM + betaH );
	vec3 T = exp( - betaExt * d );

	vec4 sr, sm;
	sohoSampleTables( dir.y, sr, sm );
	float c = dot( dir, sohoAtmo[ 0 ].xyz );
	float pR = sohoPhaseR( c ) * sohoPolariser( c, dir.y );
	float pM = sohoPhaseM( c, sohoAtmo[ 3 ].y );

	// --- Near field: the exact single-scattering solution for a slab of the
	// mean density we just measured.  This is the term that carries the blue,
	// because it is weighted by beta_Rayleigh (B/R = 5.7) rather than by the
	// full-path sky colour, which the horizon's own extinction has already
	// bleached to white.  Getting this wrong is why so many renderers have a
	// grey far field (tell #32).
	vec3 scatterR = betaR * pR;
	float scatterM = betaM * 0.9 * pM;
	float scatterH = betaH * pM;
	float sunLum = dot( sohoAtmo[ 7 ].xyz, vec3( 0.2126, 0.7152, 0.0722 ) );
	// Valley haze sits deep in the basin, where most of the light reaching it
	// is skylight rather than direct beam — which is exactly why alpine valley
	// haze reads blue while coastal haze reads milky grey (§5.1).
	vec3 hazeSource = mix( sohoAtmo[ 7 ].xyz, sohoAtmo[ 4 ].xyz * sunLum, sohoAtmo[ 3 ].w );
	vec3 J = sohoAtmo[ 7 ].xyz * ( scatterR + vec3( scatterM ) )
		+ hazeSource * scatterH;
	vec3 local = ( J / max( betaExt, vec3( 1e-12 ) ) ) * ( 1.0 - T )
		+ sr.w * sohoAtmo[ 6 ].xyz * ( 1.0 - T );

	// --- Far field: the sky itself, so an infinitely distant surface converges
	// on exactly what the dome draws in the same direction.  That equality is
	// what removes the band at the ridge/sky boundary and the "peaks paler than
	// the sky" artefact, and it holds by construction rather than by tuning.
	vec3 sky = sr.xyz * pR + sm.xyz * pM + sr.w * sohoAtmo[ 6 ].xyz;

	// Quadratic crossfade: pure slab solution while the path is optically thin,
	// pure sky once it is thick.  Quadratic (not linear) so the near field is
	// not contaminated by the white horizon colour at first order.
	float t = 1.0 - T.g;
	vec3 inscatter = mix( local, sky, t * t );

	return color * T + inscatter * sohoAtmo[ 3 ].z;
}
#endif
`;

/* ------------------------------------------------------------------ *
 * Global aerial-perspective injection
 * ------------------------------------------------------------------ */

let _apInstalled = false;

/** The one shared uniform payload every material in the scene points at. */
const AP_UNIFORMS = {
  sohoAtmo: { value: new Float32Array(8 * 4) },
  sohoSkyR: { value: new Float32Array(LUT_N * 4) },
  sohoSkyM: { value: new Float32Array(LUT_N * 4) },
};

/**
 * Replace three's fog chunks with a physically-based aerial-perspective term.
 *
 * Three implementation notes that matter:
 *
 * 1. The work happens in `opaque_fragment`, not `fog_fragment`.  three's stock
 *    fog runs after `<tonemapping_fragment>` and `<colorspace_fragment>` — in
 *    display-referred space — which is meaningless for scattering.
 *    `fog_fragment` keeps a guarded fallback for the handful of built-in
 *    shaders (ShadowMaterial) that emit `gl_FragColor` without going through
 *    `opaque_fragment`.
 *
 * 2. The uniform payload is shared *by reference*.  `UniformsUtils.cloneUniforms`
 *    copies `Float32Array` values by reference (they are neither three objects
 *    nor plain Arrays), so one mutation per frame reaches every material cloned
 *    from `ShaderLib` or merged from `UniformsLib.fog`.
 *
 * 3. It cannot crash a material that misses the uniforms: `seqWithValue` filters
 *    the upload list to uniforms the material actually holds, and the shader
 *    then reads zeros — for which `sohoAtmo[0].w == 0` disables the effect.
 *
 * The world position needed by the fragment stage is reconstructed in the
 * vertex stage from `mvPosition`, which every built-in vertex shader that
 * includes `<fog_vertex>` has in scope (verified against r185, including the
 * sprite shader, which declares it without `<project_vertex>`).
 */
function installAerialPerspective() {
  if (_apInstalled) return;
  _apInstalled = true;

  Object.assign(THREE.UniformsLib.fog, AP_UNIFORMS);
  for (const key of Object.keys(THREE.ShaderLib)) {
    const lib = THREE.ShaderLib[key];
    if (lib && lib.uniforms) Object.assign(lib.uniforms, AP_UNIFORMS);
  }

  const C = THREE.ShaderChunk;

  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vSohoWorldPos;
#endif`;

  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	// World position without inverting the view matrix: its rotation block is
	// orthonormal, so the transpose is the inverse and column dots suffice.
	vSohoWorldPos = cameraPosition + vec3(
		dot( viewMatrix[ 0 ].xyz, mvPosition.xyz ),
		dot( viewMatrix[ 1 ].xyz, mvPosition.xyz ),
		dot( viewMatrix[ 2 ].xyz, mvPosition.xyz ) );
#endif`;

  C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vSohoWorldPos;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	${ATMO_GLSL}
	float sohoFogDone = 0.0;
#endif`;

  C.opaque_fragment = /* glsl */ `
#ifdef OPAQUE
diffuseColor.a = 1.0;
#endif
#ifdef USE_TRANSMISSION
diffuseColor.a *= material.transmissionAlpha;
#endif
gl_FragColor = vec4( outgoingLight, diffuseColor.a );
#ifdef USE_FOG
	gl_FragColor.rgb = sohoAerialPerspective( gl_FragColor.rgb, vSohoWorldPos, cameraPosition );
	sohoFogDone = 1.0;
#endif`;

  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
	if ( sohoFogDone < 0.5 ) {
		#ifdef FOG_EXP2
			float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
		#else
			float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		#endif
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
	}
#endif`;
}

/* ------------------------------------------------------------------ *
 * Sky dome / environment shaders
 * ------------------------------------------------------------------ */

/** Covering triangle; reconstructs a world-space view ray per vertex. */
const DOME_VERT = /* glsl */ `
uniform mat4 uInvProjection;
uniform mat3 uCamRotation;
varying vec3 vRay;
void main() {
	// position.xy holds clip-space coordinates for the three corners.  The
	// reconstruction is affine in (x, y) for a perspective projection, so the
	// varying interpolates exactly across the oversized triangle.
	vec4 vp = uInvProjection * vec4( position.xy, -1.0, 1.0 );
	vRay = uCamRotation * ( vp.xyz / vp.w );
	gl_Position = vec4( position.xy, 0.5, 1.0 );
}`;

/** Inverted sphere used as the PMREM source. */
const ENV_VERT = /* glsl */ `
varying vec3 vRay;
void main() {
	vRay = position;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

/**
 * Sky fragment shader.
 *
 * `SOHO_ENV` builds the environment probe: no cirrus/lenticular parallax
 * detail, a clamped sun so PMREM does not smear a fireball across the whole
 * upper hemisphere, and a lit ground hemisphere so image-based lighting carries
 * the snowfield bounce.  `ART_DIRECTION.md` §4.1 makes that bounce roughly 2×
 * the sky fill; a dark lower hemisphere is an automatic fail.
 */
const SKY_FRAG = /* glsl */ `
// three prepends <tonemapping_pars_fragment> and <colorspace_pars_fragment> to
// every ShaderMaterial fragment shader, so only <common> (for rand(), which
// the dither chunk needs) has to be pulled in explicitly.
#include <common>
#include <dithering_pars_fragment>

varying vec3 vRay;

uniform sampler2D uNoise;
uniform vec4 uCloud;          // cirrus, deckCover, lenticular, time
uniform vec4 uCloudWind;      // windTowardXZ, cirrusSpeed, deckSpeed
uniform vec4 uCloudGeom;      // cirrusAltitude, deckAltitude, eyeAltitude, clearness
uniform vec3 uGroundColor;    // snowfield bounce radiance (linear)
uniform vec4 uLens[ 4 ];      // lenticular lobes: direction.xyz, angular half-width
uniform vec4 uLensShape[ 4 ]; // thinness, tilt, density, seed

${ATMO_GLSL}

/**
 * Two-fetch fbm.  The noise texture packs four octave bands into RGBA, so a
 * pair of samples at non-harmonic scales buys six effective octaves without
 * six dependent texture reads — which matters on a software rasteriser.
 */
float sohoFbm( vec2 p ) {
	vec4 a = texture2D( uNoise, p );
	vec4 b = texture2D( uNoise, p * 3.17 + vec2( 0.37, 0.71 ) );
	return a.r * 0.44 + a.g * 0.24 + b.b * 0.19 + b.a * 0.13;
}

/** Ray to a horizontal plane at world altitude alt; returns uv and a fade. */
bool sohoPlane( vec3 dir, float alt, float eye, float scale, out vec2 puv, out float fade ) {
	puv = vec2( 0.0 );
	fade = 0.0;
	if ( dir.y < 0.012 ) return false;
	float t = ( alt - eye ) / dir.y;
	if ( t <= 0.0 ) return false;
	puv = dir.xz * t * scale;
	// Fade the layer out at grazing angles: the projection stretches without
	// bound there and would alias into a hard band along the horizon.
	fade = smoothstep( 0.012, 0.10, dir.y ) * ( 1.0 - smoothstep( 120000.0, 260000.0, t ) );
	return true;
}

void main() {
	vec3 dir = normalize( vRay );
	vec3 sunDir = sohoAtmo[ 0 ].xyz;
	float cosSun = dot( dir, sunDir );
	vec3 sunTint = sohoAtmo[ 5 ].xyz;
	float sunI = sohoAtmo[ 4 ].w;

	vec3 col = sohoSkyRadiance( dir );

	// ---- Solar disc ------------------------------------------------------
	// At air mass 5.4 the disc has no discernible edge (ART_DIRECTION §7.1), so
	// the limb-darkened profile is convolved with a softness that grows with the
	// airmass, and an aureole carries the glare seed for the bloom pass.
	float ang = acos( clamp( cosSun, -1.0, 1.0 ) );
	float discR = ${SUN_ANGULAR_RADIUS.toFixed(6)};
	float soft = sohoAtmo[ 5 ].w;
	float rr = clamp( ang / discR, 0.0, 1.0 );
	float limb = 1.0 - 0.62 * ( 1.0 - sqrt( max( 0.0, 1.0 - rr * rr ) ) );
	float discMask = 1.0 - smoothstep( discR * 0.35, discR + soft, ang );
	// Circumsolar aureole: the glare seed the bloom pass expands into the soft
	// envelope §7.1 asks for.  Two exponentials — a tight core and a ~8 deg
	// skirt.  Both must die well inside 30 deg or they lift the whole sky and
	// wash the deep blue out of the top of frame.
	float aureole = exp( - ang / 0.045 ) * 0.55 + exp( - ang / 0.14 ) * 0.07;
	vec3 sunGlow = sunTint * ( sunI * discMask * limb + sohoAtmo[ 7 ].w * aureole );

	#ifdef SOHO_ENV
		sunGlow = min( sunGlow, vec3( 90.0 ) );
	#endif
	col += sunGlow;

	float time = uCloud.w;
	vec2 wind = uCloudWind.xy;
	vec3 zenithRad = sohoSkyRadiance( vec3( 0.0, 1.0, 0.0 ) );

	#ifndef SOHO_ENV
	// ---- High cirrus -----------------------------------------------------
	// Thin ice cloud, streaked hard along the NW flow.
	if ( uCloud.x > 0.001 ) {
		vec2 cuv; float fade;
		if ( sohoPlane( dir, uCloudGeom.x, uCloudGeom.z, 1.0 / 9000.0, cuv, fade ) ) {
			vec2 flow = cuv + wind * ( time * uCloudWind.z );
			// A 4:1 stretch along the flow is what makes cirrus read as cirrus
			// rather than as generic noise.
			vec2 al = vec2( dot( flow, wind ), dot( flow, vec2( -wind.y, wind.x ) ) );
			al.x *= 0.26;
			float n = sohoFbm( al * 0.5 );
			float streak = sohoFbm( al * vec2( 0.18, 1.9 ) + 3.1 );
			float d = smoothstep( 0.62 - 0.30 * uCloud.x, 0.86, n * 0.65 + streak * 0.45 );
			d *= fade * uCloud.x;
			// Ice cloud forward-scatters hard: a bright silver edge toward the sun.
			float silver = 1.0 + 2.6 * pow( max( cosSun, 0.0 ), 14.0 );
			vec3 cirrusCol = zenithRad * 1.35 + sohoAtmo[ 7 ].xyz * 0.24 * silver;
			col = mix( col, cirrusCol, clamp( d, 0.0, 0.94 ) );
		}
	}

	// ---- Lenticular / cap cloud ------------------------------------------
	// The signature nor'west lens, evaluated in angular space so each lobe
	// stays welded to its range no matter where the camera goes.
	for ( int i = 0; i < 4; i ++ ) {
		float amt = uLensShape[ i ].z * uCloud.z;
		if ( amt < 0.001 ) continue;
		vec3 lc = uLens[ i ].xyz;
		float halfW = uLens[ i ].w;
		float dz = dot( dir, lc );
		if ( dz < 0.25 ) continue;
		vec3 tX = normalize( cross( vec3( 0.0, 1.0, 0.0 ), lc ) );
		vec3 tY = normalize( cross( lc, tX ) );
		vec2 q = vec2( dot( dir, tX ), dot( dir, tY ) ) / dz;
		float ti = uLensShape[ i ].y;
		vec2 qr = vec2( q.x * cos( ti ) - q.y * sin( ti ), q.x * sin( ti ) + q.y * cos( ti ) );
		vec2 e = vec2( qr.x / halfW, qr.y / ( halfW * uLensShape[ i ].x ) );
		float body = 1.0 - smoothstep( 0.45, 1.0, length( e ) );
		if ( body <= 0.0 ) continue;
		// Break the perfect ellipse so it does not read as a decal.
		float wob = sohoFbm( qr * 6.0 + uLensShape[ i ].w + wind * time * 0.004 );
		body = smoothstep( 0.10, 0.55, body * ( 0.60 + 0.60 * wob ) );
		if ( body <= 0.0 ) continue;
		// Shading: hot rim on the sun side, underside filled by snow bounce.
		vec2 sunQ = normalize( vec2( dot( sunDir, tX ), dot( sunDir, tY ) ) + vec2( 1e-4 ) );
		float rim = smoothstep( -0.2, 0.85, dot( normalize( qr + vec2( 1e-4 ) ), sunQ ) );
		float updown = clamp( 0.5 - qr.y * 1.4 / max( halfW, 1e-3 ) * 0.35, 0.0, 1.0 );
		vec3 lit = sohoAtmo[ 7 ].xyz * 0.33 * ( 0.35 + 0.85 * rim );
		vec3 shade = mix( uGroundColor * 0.55, zenithRad * 1.15, 0.55 );
		vec3 lensCol = mix( lit + shade * 0.55, shade * 0.72, updown );
		col = mix( col, lensCol, clamp( body * amt, 0.0, 0.96 ) );
	}
	#endif

	// ---- Mid-level deck (overcast / storm) -------------------------------
	// Kept in the probe as well, because when it is present it *is* the ambient.
	if ( uCloud.y > 0.001 ) {
		vec2 duv; float fade;
		if ( sohoPlane( dir, uCloudGeom.y, uCloudGeom.z, 1.0 / 2600.0, duv, fade ) ) {
			vec2 flow = duv + wind * ( time * uCloudWind.w );
			float n = sohoFbm( flow * 0.42 );
			float n2 = sohoFbm( flow * 1.31 + 7.3 );
			float dens = n * 0.68 + n2 * 0.32;
			float cover = uCloud.y;
			float d = smoothstep( 0.72 - 0.62 * cover, 0.92 - 0.35 * cover, dens ) * fade;
			// Two-tap vertical shading: a cheap stand-in for a light march that
			// still gives bright tops, grey-blue cores and a soft base.
			float above = sohoFbm( flow * 0.42 + wind * 0.055 );
			float thick = clamp( ( dens - above ) * 3.0 + 0.5, 0.0, 1.0 );
			vec3 top = sohoAtmo[ 7 ].xyz * 0.50 * ( 0.55 + 0.75 * max( cosSun, 0.0 ) );
			vec3 core = mix( uGroundColor * 0.62, zenithRad, 0.45 );
			vec3 deckCol = mix( core * ( 0.42 + 0.5 * uCloudGeom.w ), top + core, thick );
			col = mix( col, deckCol, clamp( d, 0.0, 0.985 ) );
		}
	}

	#ifdef SOHO_ENV
		// Lower hemisphere: the snowfield.  Faded through the horizon band so
		// the probe has no hard seam to convolve.
		col = mix( col, uGroundColor, smoothstep( 0.02, -0.09, dir.y ) );
	#endif

	gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );

	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <dithering_fragment>
}`;

/* ------------------------------------------------------------------ *
 * Ridge cloud banks (world space)
 * ------------------------------------------------------------------ */

/**
 * `ART_DIRECTION.md` §5.4 asks for cloud that sits *in* the terrain rather than
 * above it.  These are y-axis-billboarded soft cards anchored to fixed world
 * positions around the upper basin at 1950–2150 m — straddling the 1865 m crest
 * — depth-tested so ridges cut into them, with a heavily feathered lower edge
 * so the intersection reads as fuzz rather than as a polygon crossing a slope.
 */
const BANK_VERT = /* glsl */ `
attribute vec3 aCentre;
attribute vec4 aSize;      // halfWidth, halfHeight, phase, seed
varying vec2 vBankUv;
varying vec3 vWorld;
varying float vSeed;
uniform float uTime;
uniform vec2 uDrift;
void main() {
	vBankUv = uv;
	vSeed = aSize.w;
	vec3 c = aCentre;
	c.xz += uDrift * uTime * ( 0.55 + 0.45 * fract( aSize.w ) );
	c.y += sin( uTime * 0.06 + aSize.z ) * 3.5;
	vec3 toCam = cameraPosition - c;
	vec3 right = normalize( vec3( - toCam.z, 0.0, toCam.x ) + vec3( 1e-5, 0.0, 0.0 ) );
	vec3 world = c + right * ( position.x * aSize.x ) + vec3( 0.0, position.y * aSize.y, 0.0 );
	vWorld = world;
	gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
}`;

const BANK_FRAG = /* glsl */ `
#include <common>

varying vec2 vBankUv;
varying vec3 vWorld;
varying float vSeed;
uniform sampler2D uNoise;
uniform float uTime;
uniform float uOpacity;
uniform vec3 uGroundColor;

${ATMO_GLSL}

void main() {
	vec2 p = vBankUv * 1.35 + vec2( vSeed, vSeed * 1.7 ) + vec2( uTime * 0.0035, uTime * -0.0018 );
	vec4 a = texture2D( uNoise, p );
	vec4 b = texture2D( uNoise, p * 2.63 + 0.41 );
	float n = a.r * 0.46 + a.g * 0.22 + b.b * 0.19 + b.a * 0.13;

	// Radial falloff, with the base feathered far harder than the top so the
	// card dissolves before it can show an edge against a slope.
	vec2 q = vBankUv * 2.0 - 1.0;
	float radial = 1.0 - smoothstep( 0.15, 1.0, length( q * vec2( 0.85, 1.15 ) ) );
	float base = smoothstep( -1.0, -0.05, q.y );
	float alpha = clamp( ( n * 1.5 - 0.52 ) * 2.2, 0.0, 1.0 ) * radial * base * uOpacity;
	if ( alpha < 0.004 ) discard;

	vec3 V = normalize( vWorld - cameraPosition );
	float c = dot( V, sohoAtmo[ 0 ].xyz );
	// Beer–Powder: silver lining looking through the cloud toward the sun,
	// grey-blue core away from it, snow bounce lifting the underside.
	float forward = sohoPhaseM( c, 0.62 ) * 5.5;
	vec3 sunTint = sohoAtmo[ 7 ].xyz * 0.37;
	vec3 core = mix( uGroundColor * 0.7, sohoSkyRadiance( vec3( 0.0, 1.0, 0.0 ) ) * 1.1, 0.5 );
	vec3 col = core * ( 0.55 + 0.45 * n ) + sunTint * ( 0.35 + forward );

	col = sohoAerialPerspective( col, vWorld, cameraPosition );

	gl_FragColor = vec4( col, alpha );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`;

/* ------------------------------------------------------------------ *
 * Procedural noise texture
 * ------------------------------------------------------------------ */

/**
 * One 256² RGBA texture carrying four octave bands of seamlessly tiling noise.
 * Everything cloud-shaped in this module is built from it, which holds the
 * software rasteriser to two texture fetches per cloud layer.  The tiling comes
 * from sampling 3-D simplex around a circle in one axis, so there is no seam
 * and therefore no wallpaper period visible along the horizon.
 */
function makeNoiseTexture(seed, anisotropy) {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  const simplex = new Simplex(seed);
  const bands = [4, 9, 19, 37];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N;
      const i = (y * N + x) * 4;
      for (let b = 0; b < 4; b++) {
        const f = bands[b];
        const a = simplex.noise3D(
          Math.cos(u * Math.PI * 2) * f * 0.16,
          Math.sin(u * Math.PI * 2) * f * 0.16,
          v * f,
        );
        const c = simplex.noise3D(
          Math.cos(v * Math.PI * 2) * f * 0.16 + 31.7,
          Math.sin(v * Math.PI * 2) * f * 0.16 - 11.3,
          u * f,
        );
        data[i + b] = Math.round(clamp01((a + c) * 0.25 + 0.5) * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy || 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 * Sky
 * ------------------------------------------------------------------ */

export class Sky {
  constructor(ctx) {
    this.ctx = ctx;
    this.object3D = new THREE.Group();
    this.object3D.name = 'sky';

    installAerialPerspective();

    /** @type {THREE.Vector3} unit vector pointing from the origin toward the sun. */
    this.sunDirection = new THREE.Vector3(0, 0.2, 1);
    /** @type {THREE.Color} linear colour of the direct beam (max channel 1). */
    this.sunColor = new THREE.Color(1, 0.82, 0.68);
    /** @type {THREE.Color} representative linear colour of the sky fill. */
    this.ambientColor = new THREE.Color(0.63, 0.76, 1.0);
    /** @type {THREE.Color} snowfield bounce radiance — the lower-hemisphere fill. */
    this.groundColor = new THREE.Color(0.3, 0.32, 0.36);
    /** @type {THREE.Texture|null} PMREM cube used as `scene.environment`. */
    this.environmentTexture = null;
    /** @type {THREE.DirectionalLight|null} created in build(). */
    this.sun = null;
    /** @type {THREE.AmbientLight|null} the snowfield bounce, created in build(). */
    this.bounce = null;

    /** Full solar solution, exposed for HUD / debug / shot presets. */
    this.solar = {
      altitude: 0, azimuth: 0, declination: 0, hourAngle: 0,
      equationOfTime: 0, airMass: 1, altitudeDeg: 0, azimuthDeg: 0, planAngleDeg: 0,
    };
    /** Irradiance bookkeeping in renderer units — useful when tuning exposure. */
    this.irradiance = { direct: 0, sky: new THREE.Color(0, 0, 0), horizontal: 0 };

    this._weatherName = null;
    this._weather = WEATHER.bluebird;
    this._tables = null;
    this._pmrem = null;
    this._envTarget = null;
    this._envScene = null;
    this._lastEnvSun = new THREE.Vector3(0, -1, 0);
    this._built = false;
    this._time = 0;
    this._solarKey = '';
    this._solarDirty = false;

    // Solve the sun immediately: shot presets read `sunDirection`, and systems
    // constructed after us may sample it before build() has run.
    this._updateSolar();
  }

  /* -------------------------------------------------------------- *
   * Configuration helpers
   * -------------------------------------------------------------- */

  get _cfg() { return CONFIG.sky || {}; }

  /** True bearing that game −Z points along, used to place the sun. */
  get sunBearingOfMinusZ() {
    return this._cfg.sunBearingOfMinusZ ?? DEFAULT_SUN_BEARING_OF_MINUS_Z;
  }

  /** Reference altitude for the atmosphere tables — mid-basin eye height. */
  get _eyeAltitude() {
    const t = CONFIG.terrain;
    return this._cfg.eyeAltitude ?? (t.minAltitude + t.maxAltitude) * 0.5 + 40;
  }

  /* -------------------------------------------------------------- *
   * Solar position → game-space vector
   * -------------------------------------------------------------- */

  _updateSolar() {
    const w = CONFIG.world;
    const tz = LOCATION.timeZoneHours ?? 12; // NZST, UTC+12 in winter
    const s = solarPosition(
      w.dayOfYear, w.timeOfDay,
      LOCATION.latitude, LOCATION.longitude, tz,
    );

    this.solar.altitude = s.altitude;
    this.solar.azimuth = s.azimuth;
    this.solar.declination = s.declination;
    this.solar.hourAngle = s.hourAngle;
    this.solar.equationOfTime = s.equationOfTime;
    this.solar.airMass = s.airMass;
    this.solar.altitudeDeg = s.altitude * RAD;
    this.solar.azimuthDeg = s.azimuth * RAD;

    // True bearing → game plan angle, measured from −Z rotating toward +X.
    const theta = s.azimuth - this.sunBearingOfMinusZ * DEG;
    const ca = Math.cos(s.altitude);
    this.sunDirection.set(
      Math.sin(theta) * ca,
      Math.sin(s.altitude),
      -Math.cos(theta) * ca,
    ).normalize();
    this.solar.planAngleDeg = ((theta * RAD + 540) % 360) - 180;

    this._solarKey = `${w.timeOfDay}|${w.dayOfYear}|${this.sunBearingOfMinusZ}`;
  }

  /* -------------------------------------------------------------- *
   * Build
   * -------------------------------------------------------------- */

  build() {
    const ctx = this.ctx;
    const scene = ctx.scene;

    const noiseSeed = makeRng(`${CONFIG.seed}:sky-noise`).int(1, 0x7fffffff);
    this._noise = makeNoiseTexture(noiseSeed, ctx.maxAnisotropy);

    this._sharedUniforms = {
      sohoAtmo: AP_UNIFORMS.sohoAtmo,
      sohoSkyR: AP_UNIFORMS.sohoSkyR,
      sohoSkyM: AP_UNIFORMS.sohoSkyM,
    };

    this._cloudUniforms = {
      uNoise: { value: this._noise },
      uCloud: { value: new THREE.Vector4(0.3, 0.05, 0.8, 0) },
      uCloudWind: { value: new THREE.Vector4(-0.92, 0.39, 0.0018, 0.0012) },
      uCloudGeom: { value: new THREE.Vector4(9000, 3600, this._eyeAltitude, 0.5) },
      uGroundColor: { value: new THREE.Color(0.3, 0.32, 0.36) },
      uLens: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      uLensShape: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    };

    this._buildLenticular();

    // --- Sky dome: a covering triangle, drawn first, no depth -------------
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3,
    ));
    tri.setAttribute('uv', new THREE.BufferAttribute(
      new Float32Array([0, 0, 2, 0, 0, 2]), 2,
    ));
    tri.setAttribute('normal', new THREE.BufferAttribute(
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3,
    ));

    this._domeMaterial = new THREE.ShaderMaterial({
      uniforms: Object.assign({
        uInvProjection: { value: new THREE.Matrix4() },
        uCamRotation: { value: new THREE.Matrix3() },
      }, this._sharedUniforms, this._cloudUniforms),
      vertexShader: DOME_VERT,
      fragmentShader: SKY_FRAG,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      dithering: true,   // a banded sky gradient is an instant fail (§AAA #23)
      toneMapped: true,
    });

    this._dome = new THREE.Mesh(tri, this._domeMaterial);
    this._dome.name = 'sky-dome';
    this._dome.frustumCulled = false;
    this._dome.renderOrder = -10000;
    this._dome.matrixAutoUpdate = false;
    this.object3D.add(this._dome);

    // --- Sun --------------------------------------------------------------
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.name = 'sun';
    this.sun.castShadow = true;
    const mapSize = Math.min(CONFIG.render.shadowMapSize || 2048, 4096);
    this.sun.shadow.mapSize.set(mapSize, mapSize);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 3000;
    this.sun.shadow.bias = -0.00006;
    this.sun.shadow.normalBias = 0.08;
    this.object3D.add(this.sun);
    this.object3D.add(this.sun.target);

    // Snowfield bounce.  Directionless on purpose: inside a bowl of 0.86-albedo
    // snow the reflected field is close to uniform, and this is what keeps the
    // rider's chin, the board base and every rock overhang out of the void
    // (ART_DIRECTION §4.1, tell #3).  Colour and level are recomputed from the
    // actual horizontal irradiance on every sky refresh.
    this.bounce = new THREE.AmbientLight(0xffffff, 0);
    this.bounce.name = 'snow-bounce';
    this.object3D.add(this.bounce);

    this._buildRidgeBanks();

    scene.add(this.object3D);

    // `scene.fog` must be non-null or three never compiles the fog chunks and
    // the aerial perspective never runs.  Its own colour/density serve only the
    // fallback path in `fog_fragment`.
    scene.fog = new THREE.FogExp2(new THREE.Color(0.55, 0.66, 0.82), 2.4e-5);

    this._built = true;
    this.setWeather(CONFIG.world.weather || 'bluebird', true);
  }

  /* -------------------------------------------------------------- *
   * Lenticular lobes + ridge banks
   * -------------------------------------------------------------- */

  /**
   * Place lens clouds over the ranges.  Directions are fixed in game space so
   * a lobe stays welded to its range; under a nor'west flow they sit downwind
   * of the high ground with their long axis across the flow.
   */
  _buildLenticular() {
    const rng = makeRng(`${CONFIG.seed}:lenticular`);
    // Plan angles measured from −Z toward +X.
    const lobes = [
      { theta: 168, elev: 13.5, half: 0.30, thin: 0.20, density: 1.0 },
      { theta: -132, elev: 9.0, half: 0.24, thin: 0.17, density: 0.72 },
      { theta: 42, elev: 7.0, half: 0.20, thin: 0.15, density: 0.55 },
      { theta: -46, elev: 17.0, half: 0.16, thin: 0.22, density: 0.40 },
    ];
    const u = this._cloudUniforms;
    for (let i = 0; i < 4; i++) {
      const l = lobes[i];
      const t = l.theta * DEG;
      const e = l.elev * DEG;
      const ce = Math.cos(e);
      u.uLens.value[i].set(Math.sin(t) * ce, Math.sin(e), -Math.cos(t) * ce, l.half);
      u.uLensShape.value[i].set(l.thin, (rng() - 0.5) * 0.35, l.density, rng() * 10);
    }
  }

  /** Soft cards banded across the upper basin and the far ridges. */
  _buildRidgeBanks() {
    const rng = makeRng(`${CONFIG.seed}:ridge-bank`);
    const banks = [
      { r: 2400, theta: 165, spread: 55, y: 1980, n: 14, w: 420, h: 200 },
      { r: 5200, theta: -110, spread: 40, y: 2060, n: 10, w: 700, h: 260 },
      { r: 9000, theta: 55, spread: 46, y: 2140, n: 10, w: 1100, h: 320 },
    ];
    let total = 0;
    for (const b of banks) total += b.n;

    const pos = new Float32Array(total * 4 * 3);
    const uv = new Float32Array(total * 4 * 2);
    const centre = new Float32Array(total * 4 * 3);
    const sizeAttr = new Float32Array(total * 4 * 4);
    const index = new Uint16Array(total * 6);
    // Quad corners in order: (-1,-1) (1,-1) (1,1) (-1,1).
    const CX = [-1, 1, 1, -1];
    const CY = [-1, -1, 1, 1];

    let v = 0, q = 0;
    for (const b of banks) {
      for (let i = 0; i < b.n; i++) {
        const t = (b.theta + (rng() - 0.5) * b.spread * 2) * DEG;
        const r = b.r * (0.82 + rng() * 0.42);
        const cx = Math.sin(t) * r;
        const cz = -Math.cos(t) * r;
        const cy = b.y + (rng() - 0.5) * 130;
        const hw = b.w * (0.65 + rng() * 0.8);
        const hh = b.h * (0.6 + rng() * 0.9);
        const phase = rng() * 100;
        const seed = rng();
        for (let k = 0; k < 4; k++) {
          pos[v * 3] = CX[k]; pos[v * 3 + 1] = CY[k]; pos[v * 3 + 2] = 0;
          uv[v * 2] = CX[k] * 0.5 + 0.5; uv[v * 2 + 1] = CY[k] * 0.5 + 0.5;
          centre[v * 3] = cx; centre[v * 3 + 1] = cy; centre[v * 3 + 2] = cz;
          sizeAttr[v * 4] = hw; sizeAttr[v * 4 + 1] = hh;
          sizeAttr[v * 4 + 2] = phase; sizeAttr[v * 4 + 3] = seed;
          v++;
        }
        const base = q * 4;
        index[q * 6] = base; index[q * 6 + 1] = base + 1; index[q * 6 + 2] = base + 2;
        index[q * 6 + 3] = base; index[q * 6 + 4] = base + 2; index[q * 6 + 5] = base + 3;
        q++;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aCentre', new THREE.BufferAttribute(centre, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizeAttr, 4));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2000, 0), 40000);

    this._bankUniforms = {
      uNoise: { value: this._noise },
      uTime: { value: 0 },
      uDrift: { value: new THREE.Vector2(-0.92, 0.39) },
      uOpacity: { value: 0.4 },
      uGroundColor: this._cloudUniforms.uGroundColor,
    };

    this._bankMaterial = new THREE.ShaderMaterial({
      uniforms: Object.assign({}, this._sharedUniforms, this._bankUniforms),
      vertexShader: BANK_VERT,
      fragmentShader: BANK_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: true,
    });

    this._banks = new THREE.Mesh(geo, this._bankMaterial);
    this._banks.name = 'ridge-cloud-banks';
    this._banks.frustumCulled = false;
    this._banks.renderOrder = 900;
    this._banks.matrixAutoUpdate = false;
    this.object3D.add(this._banks);
  }

  /* -------------------------------------------------------------- *
   * Weather
   * -------------------------------------------------------------- */

  /**
   * Switch the weather preset.  Sky tables, sun colour and intensity, ambient,
   * haze, cloud cover and the IBL are all rebuilt from it, so the variants stay
   * coherent instead of drifting apart.
   */
  setWeather(name, force = false) {
    const key = WEATHER[name] ? name : 'bluebird';
    if (!force && key === this._weatherName) return;
    this._weatherName = key;
    this._weather = WEATHER[key];
    // `CONFIG.world.weather` is the source of truth that `update()` polls, so
    // write it back or the next frame would revert the change.
    CONFIG.world.weather = key;
    if (this._built) this._refreshSky(true);
  }

  /** @returns {string} the active weather preset name. */
  get weather() { return this._weatherName; }

  /* -------------------------------------------------------------- *
   * Sky refresh — the expensive path, run only on meaningful change
   * -------------------------------------------------------------- */

  _refreshSky(rebuildEnvironment) {
    const w = this._weather;
    const cfg = this._cfg;

    // --- Atmosphere tables -------------------------------------------------
    const sunMu = Math.sin(this.solar.altitude);
    const groundAlbedo = cfg.groundAlbedo ?? CONFIG.snow.albedo ?? 0.86;
    const mieG = cfg.mieG ?? 0.76;
    const tables = buildAtmosphereTables({
      eyeAltitude: this._eyeAltitude,
      sunMu,
      weather: w,
      groundAlbedo,
      mieG,
    });
    this._tables = tables;

    // --- Camera white balance ---------------------------------------------
    // Daylight WB locked to the direct beam, luminance-preserving so it moves
    // colour without moving exposure.  Applied at the source (sun, sky tables,
    // bounce) rather than as a grade, because this module owns every light in
    // the scene and `postprocess.js` must not have to compensate for it.
    const cct = sunCCT(this.solar.altitude, w);
    const beam0 = cctToLinearRGB(cct);
    const alpha = clamp01(cfg.whiteBalance ?? WHITE_BALANCE);
    const gRaw = [
      Math.pow(Math.max(beam0[0], 1e-4), -alpha),
      Math.pow(Math.max(beam0[1], 1e-4), -alpha),
      Math.pow(Math.max(beam0[2], 1e-4), -alpha),
    ];
    const wbNorm = lum3(beam0) / Math.max(1e-6, lum3([
      beam0[0] * gRaw[0], beam0[1] * gRaw[1], beam0[2] * gRaw[2],
    ]));
    const wb = [gRaw[0] * wbNorm, gRaw[1] * wbNorm, gRaw[2] * wbNorm];
    const beam = [beam0[0] * wb[0], beam0[1] * wb[1], beam0[2] * wb[2]];
    const beamLuma = Math.max(lum3(beam), 1e-3);

    // Pack the vec3 tables into the vec4 uniform arrays (w = isotropic deck),
    // applying the white balance and the sky calibration in one pass.
    const skyScale = cfg.skyIntensityScale ?? SKY_CALIBRATION;
    const sR = skyScale * wb[0], sG = skyScale * wb[1], sB = skyScale * wb[2];
    const R = AP_UNIFORMS.sohoSkyR.value;
    const M = AP_UNIFORMS.sohoSkyM.value;
    const isoScale = skyScale * lum3(wb);
    for (let i = 0; i < LUT_N; i++) {
      R[i * 4] = tables.ir[i * 3] * sR;
      R[i * 4 + 1] = tables.ir[i * 3 + 1] * sG;
      R[i * 4 + 2] = tables.ir[i * 3 + 2] * sB;
      R[i * 4 + 3] = tables.ia[i] * isoScale;
      M[i * 4] = tables.im[i * 3] * sR;
      M[i * 4 + 1] = tables.im[i * 3 + 1] * sG;
      M[i * 4 + 2] = tables.im[i * 3 + 2] * sB;
      M[i * 4 + 3] = 0;
    }

    // --- Direct beam -------------------------------------------------------
    // Luminous attenuation is physical (Rayleigh + aerosol + ozone + deck);
    // chromaticity comes from the calibrated CCT curve, white-balanced above.
    const tl = lum3(tables.sunTransmittance);
    const rise = clamp01(this.solar.altitude / (1.5 * DEG));  // fade through set
    const E = SOLAR_IRRADIANCE_UNITS * tl * rise
      * w.sunTransmission * (cfg.sunIntensityScale ?? 1.0);

    this.sunColor.setRGB(beam[0], beam[1], beam[2]);
    if (this.sun) {
      this.sun.color.copy(this.sunColor);
      // three multiplies colour × intensity, so divide out the colour's own
      // luminance to keep the *luminous* irradiance exactly E.
      this.sun.intensity = E / beamLuma;
      this.sun.visible = E > 1e-4;
    }
    this.irradiance.direct = E;

    // --- Ambient -----------------------------------------------------------
    const sky = [
      tables.skyIrradiance[0] * sR,
      tables.skyIrradiance[1] * sG,
      tables.skyIrradiance[2] * sB,
    ];
    const skyLuma = Math.max(1e-5, lum3(sky));
    const amax = Math.max(sky[0], sky[1], sky[2], 1e-5);
    this.ambientColor.setRGB(sky[0] / amax, sky[1] / amax, sky[2] / amax);
    this.irradiance.sky.setRGB(sky[0], sky[1], sky[2]);
    this.irradiance.horizontal = E * Math.max(0, sunMu) + skyLuma;

    // --- Snowfield bounce --------------------------------------------------
    // Lambertian: L = albedo · E_horizontal / π.  §4.1 puts this at roughly
    // twice the sky fill, and it is why nothing in an open snow frame is dark.
    const kDir = (E * Math.max(0, sunMu)) / beamLuma;
    this.groundColor.setRGB(
      groundAlbedo * (kDir * beam[0] + sky[0]) / Math.PI,
      groundAlbedo * (kDir * beam[1] + sky[1]) / Math.PI,
      groundAlbedo * (kDir * beam[2] + sky[2]) / Math.PI,
    );
    this._cloudUniforms.uGroundColor.value.copy(this.groundColor);

    // Delivered as an explicit ambient term: the probe's lower hemisphere only
    // reaches surfaces that face down, but on an open snowfield every surface
    // sees a slab of lit snow.  `vf` is the share of the hemisphere it fills.
    if (this.bounce) {
      const vf = cfg.bounceViewFactor ?? BOUNCE_VIEW_FACTOR;
      this.bounce.color.setRGB(
        vf * Math.PI * this.groundColor.r,
        vf * Math.PI * this.groundColor.g,
        vf * Math.PI * this.groundColor.b,
      );
      this.bounce.intensity = 1;
    }

    // --- Pack the shared uniform block -------------------------------------
    const a = AP_UNIFORMS.sohoAtmo.value;
    const sd = this.sunDirection;
    a[0] = sd.x; a[1] = sd.y; a[2] = sd.z; a[3] = 1;
    a[4] = BETA_RAYLEIGH[0]; a[5] = BETA_RAYLEIGH[1]; a[6] = BETA_RAYLEIGH[2];
    a[7] = (BETA_MIE * w.turbidity) / MIE_SINGLE_ALBEDO;
    a[8] = H_RAYLEIGH; a[9] = H_MIE;
    a[10] = cfg.hazeDensity ?? w.haze;
    a[11] = cfg.hazeScaleHeight ?? w.hazeScaleHeight;
    a[12] = cfg.hazeReferenceAltitude ?? CONFIG.terrain.minAltitude;
    a[13] = mieG;
    a[14] = cfg.aerialStrength ?? 1.0;
    a[15] = clamp01(cfg.hazeSkyFraction ?? 0.75);

    // Haze illuminant: the diffuse sky, lifted a little toward white by the
    // snowfield bounce that also reaches it.  This is what makes the far field
    // go *blue* rather than milky grey — the alpine look as distinct from the
    // coastal one (§5.1, tell #32).
    const ac = this.ambientColor;
    a[16] = lerp(ac.r, 1.0, 0.28);
    a[17] = lerp(ac.g, 1.0, 0.20);
    a[18] = lerp(ac.b, 1.0, 0.05);
    // Sun disc radiance: irradiance ÷ solid angle, capped so the raw value
    // never destabilises the float buffer.  It is a bloom seed, not a light.
    a[19] = Math.min(E / SUN_SOLID_ANGLE, 26000) * (cfg.sunDiscScale ?? 1.0);
    a[20] = beam[0]; a[21] = beam[1]; a[22] = beam[2];
    // Disc softness grows with airmass: at AM 5.4 there is no visible edge.
    a[23] = SUN_ANGULAR_RADIUS * (0.5 + 0.42 * clamp(this.solar.airMass, 1, 12));
    a[24] = tables.iaTint[0]; a[25] = tables.iaTint[1]; a[26] = tables.iaTint[2];
    a[27] = clamp01(cfg.polariser ?? POLARISER);
    // Spectral solar irradiance reaching the ground, white-balanced: the source
    // term for the near-field aerial perspective.
    a[28] = E * beam[0] / beamLuma;
    a[29] = E * beam[1] / beamLuma;
    a[30] = E * beam[2] / beamLuma;
    // Aureole radiance, scaled by the true beam irradiance rather than by the
    // clamped disc value, so it thins out correctly under a cloud deck.
    a[31] = E * (cfg.aureoleScale ?? 1.1);

    // --- Clouds ------------------------------------------------------------
    const cu = this._cloudUniforms;
    cu.uCloud.value.set(w.cirrus, w.deckCover, w.lenticular, this._time);
    // CONFIG.world.windDirection is the bearing the wind blows *from*.
    const windToward = (CONFIG.world.windDirection + 180 - this.sunBearingOfMinusZ) * DEG;
    const wx = Math.sin(windToward), wz = -Math.cos(windToward);
    const wspd = Math.max(0.5, CONFIG.world.windSpeed || 4);
    cu.uCloudWind.value.set(wx, wz, wspd * 0.00042, wspd * 0.00028);
    cu.uCloudGeom.value.set(9000, w.deckAltitude, this._eyeAltitude, clamp01(1 - w.deckSky));
    if (this._bankUniforms) {
      this._bankUniforms.uDrift.value.set(wx * wspd * 0.22, wz * wspd * 0.22);
      this._bankUniforms.uOpacity.value = w.ridgeBank * (cfg.ridgeBankOpacity ?? 1.0);
      if (this._banks) this._banks.visible = this._bankUniforms.uOpacity.value > 0.004;
    }

    // --- Fog carrier (fallback path only) ----------------------------------
    const scene = this.ctx.scene;
    if (scene && scene.fog) {
      const hz = this._skyRadianceCPU(0.02, Math.PI * 0.5);
      scene.fog.color.setRGB(hz[0] * 0.35, hz[1] * 0.35, hz[2] * 0.35);
      scene.fog.density = Math.sqrt(Math.max(1e-9, (cfg.hazeDensity ?? w.haze) * 0.35));
    }

    if (rebuildEnvironment) this._buildEnvironment();
  }

  /**
   * CPU twin of `sohoSkyRadiance`.  Reads the *packed* uniform arrays, not the
   * raw tables, so it is guaranteed to agree with the GPU including the white
   * balance, the sky calibration and the polariser.
   *
   * @param {number} mu zenith cosine of the view direction
   * @param {number} [azOffRad] azimuth away from the sun; 0 samples the
   *   sunward vertical plane, which is where the haze tint comes from.
   * @returns {number[]} linear RGB radiance in renderer units
   */
  _skyRadianceCPU(mu, azOffRad = 0) {
    const R = AP_UNIFORMS.sohoSkyR.value;
    const M = AP_UNIFORMS.sohoSkyM.value;
    const a = AP_UNIFORMS.sohoAtmo.value;
    const f = lutCoord(mu) * (LUT_N - 1);
    const i0 = Math.min(LUT_N - 1, Math.max(0, Math.floor(f)));
    const i1 = Math.min(LUT_N - 1, i0 + 1);
    const k = f - i0;
    const elev = Math.asin(clamp(mu, -1, 1));
    const cosT = Math.cos(elev) * Math.cos(this.solar.altitude) * Math.cos(azOffRad)
      + Math.sin(elev) * Math.sin(this.solar.altitude);
    const pr = phaseRayleigh(cosT);
    const pm = phaseMie(cosT, a[13] || 0.76);
    const depol = lerp(0.22, 1.0, smoothstep(0.0, 0.42, mu));
    const pol = 1 - a[27] * ((1 - cosT * cosT) / (1 + cosT * cosT)) * depol;
    const iso = R[i0 * 4 + 3] * (1 - k) + R[i1 * 4 + 3] * k;
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const ir = R[i0 * 4 + c] * (1 - k) + R[i1 * 4 + c] * k;
      const im = M[i0 * 4 + c] * (1 - k) + M[i1 * 4 + c] * k;
      out[c] = ir * pr * pol + im * pm + iso * a[24 + c];
    }
    return out;
  }

  /* -------------------------------------------------------------- *
   * Image-based lighting
   * -------------------------------------------------------------- */

  /**
   * Render the sky (plus the snowfield's own bounce in the lower hemisphere)
   * into a PMREM cube and hand it to the scene as `environment`.
   *
   * This is the mechanism behind LAW 2 and LAW 3 of `ART_DIRECTION.md` §1.2:
   * shadowed snow is lit *only* by this probe, so if the probe is right the
   * shadows come out blue and strong without any shader tinting anywhere else.
   */
  _buildEnvironment() {
    const ctx = this.ctx;
    const renderer = ctx.renderer;
    if (!renderer) return;

    if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(renderer);

    if (!this._envScene) {
      const geo = new THREE.SphereGeometry(90, 48, 32);
      const mat = new THREE.ShaderMaterial({
        uniforms: Object.assign({}, this._sharedUniforms, this._cloudUniforms),
        vertexShader: ENV_VERT,
        fragmentShader: SKY_FRAG,
        defines: { SOHO_ENV: '' },
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
        toneMapped: false,   // the probe stores linear radiance, not display values
      });
      this._envScene = new THREE.Scene();
      this._envMesh = new THREE.Mesh(geo, mat);
      this._envMesh.frustumCulled = false;
      this._envScene.add(this._envMesh);
    }

    const prevTarget = renderer.getRenderTarget();
    let rt = null;
    try {
      rt = this._pmrem.fromScene(this._envScene, 0, 1, 400);
    } catch (err) {
      // A probe failure must never take the frame down; keep whatever we had.
      console.warn('[sky] environment probe failed', err);
      renderer.setRenderTarget(prevTarget);
      return;
    }
    renderer.setRenderTarget(prevTarget);

    if (this._envTarget) this._envTarget.dispose();
    this._envTarget = rt;
    this.environmentTexture = rt.texture;
    ctx.scene.environment = rt.texture;
    if ('environmentIntensity' in ctx.scene) {
      ctx.scene.environmentIntensity = this._cfg.environmentIntensity ?? 1.0;
    }

    this._lastEnvSun.copy(this.sunDirection);
  }

  /* -------------------------------------------------------------- *
   * Shadow camera — tight, camera-following, texel-snapped
   * -------------------------------------------------------------- */

  /**
   * Fit the directional light's orthographic shadow frustum to the slice of the
   * view frustum the player can actually resolve detail in.
   *
   * Two things make this behave under a 10.6° sun:
   *
   * 1. The fit uses the minimal *bounding sphere* of the frustum slice, not its
   *    AABB.  A sphere's radius is invariant under camera rotation, so the ortho
   *    box never changes size as the player turns — without that, the texel
   *    footprint breathes and every shadow edge in the frame crawls.
   * 2. The box origin is snapped to whole texels in light space.  That is the
   *    difference between a crisp contact shadow and a permanent shimmer, and on
   *    a uniform white snowfield there is nothing to hide shimmer behind.
   *
   * `shadow.normalBias` is then derived from the *measured* world size of a
   * texel and widened at grazing incidence — three offsets the receiver along
   * its normal, which is exactly the normal-offset bias §4.4 asks for, and it
   * keeps both acne and peter-panning away as the fit changes.
   */
  _updateShadow(camera) {
    const light = this.sun;
    if (!light || !camera || !light.visible) return;

    const cfg = this._cfg;
    const far = cfg.shadowDistance ?? 120;
    const near = Math.max(camera.near, 0.05);

    // Minimal bounding sphere of the frustum slice [near, far], in view space.
    // Its centre lies on the view axis at z = −c with
    //   c = (1 + k)(near + far)/2,  k = tan²(halfFovH) + tan²(halfFovV),
    // clamped to the far plane when the far corners dominate.
    const tanV = Math.tan(camera.fov * 0.5 * DEG);
    const tanH = tanV * Math.max(camera.aspect, 1e-3);
    const k = tanH * tanH + tanV * tanV;
    let centreZ = 0.5 * (near + far) * (1 + k);
    let radius;
    if (centreZ >= far) {
      centreZ = far;
      radius = far * Math.sqrt(k);
    } else {
      const dn = near * Math.sqrt(k);
      radius = Math.sqrt(dn * dn + (centreZ - near) * (centreZ - near));
    }
    radius = Math.max(radius, 1);

    const fwd = _v3a.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const centre = _v3b.copy(camera.position).addScaledVector(fwd, centreZ);

    // Light-space basis.
    const L = _v3c.copy(this.sunDirection).normalize();
    const upRef = Math.abs(L.y) > 0.985 ? _v3d.set(0, 0, 1) : _v3d.set(0, 1, 0);
    const lx = _v3e.crossVectors(upRef, L).normalize();
    const ly = _v3f.crossVectors(L, lx).normalize();

    // Snap the centre to whole shadow texels along the light basis.
    const texel = (2 * radius) / light.shadow.mapSize.x;
    const sx = Math.round(centre.dot(lx) / texel) * texel;
    const sy = Math.round(centre.dot(ly) / texel) * texel;
    const sz = centre.dot(L);
    centre.set(
      lx.x * sx + ly.x * sy + L.x * sz,
      lx.y * sx + ly.y * sy + L.y * sz,
      lx.z * sx + ly.z * sy + L.z * sz,
    );

    // Pull the light back far enough that casters up-sun of the box still reach
    // it.  At 10.6° elevation that distance is substantial.
    const back = radius + clamp(radius / Math.max(0.16, Math.abs(L.y)), radius, 1400);
    light.position.copy(centre).addScaledVector(L, back);
    light.target.position.copy(centre);
    light.target.updateMatrixWorld();

    const cam = light.shadow.camera;
    cam.left = -radius; cam.right = radius;
    cam.top = radius; cam.bottom = -radius;
    cam.near = Math.max(0.5, back - radius * 2.2);
    cam.far = back + radius * 2.2 + 400;
    cam.updateProjectionMatrix();

    // Bias, sized from the geometry rather than guessed.
    //
    // At a 10.5 deg sun a horizontal snow surface is almost parallel to the
    // light, so the depth stored across a single shadow texel varies by
    // texel / tan(altitude) — here about 5.4 texels' worth of depth.  A
    // constant bias smaller than that acnes; a normal offset large enough to
    // cover it peter-pans, because offsetting along the normal displaces the
    // shadow horizontally by offset / tan(altitude), which at this sun angle is
    // 5.4x the offset.  So the depth term carries the slope and the normal
    // offset stays at a couple of texels.  Net displacement works out at ~0.4 m
    // on a 9.6 m rider shadow: 4%, invisible, and no acne.
    //
    // INTEGRATION NOTE: on the real basin geometry the derived values above
    // still acne, because snowMaterial's *wrapped* diffuse lifts surfaces with
    // N·L ≤ 0 to a third of full brightness instead of leaving them black. The
    // usual place acne hides — the already-dark backside of a slope — is
    // therefore lit, and every grazing face stipples. Both terms are now
    // scaled by tunables so the look can be dialled without touching the
    // derivation; the defaults are the values that measured clean on the shipped
    // terrain at a 10.5° sun.
    const sinAlt = Math.max(0.12, Math.abs(L.y));
    const nbScale = cfg.shadowNormalBiasScale ?? 3.6;
    const nbMax = cfg.shadowNormalBiasMax ?? 0.30;
    const dbScale = cfg.shadowDepthBiasScale ?? 1.1;
    light.shadow.normalBias = clamp(texel * nbScale, 0.02, nbMax);
    light.shadow.bias = -clamp(texel * dbScale / sinAlt, 0.05, 1.2) / (cam.far - cam.near);
  }

  /* -------------------------------------------------------------- *
   * Per-frame update
   * -------------------------------------------------------------- */

  update(dt, ctx) {
    if (!this._built) return;
    const camera = ctx.camera;
    this._time += dt;

    // Time of day and weather can both be changed live by the harness.
    const w = CONFIG.world;
    const timeScale = this._cfg.timeScale ?? 0;
    if (timeScale) w.timeOfDay = ((w.timeOfDay + dt * timeScale) % 24 + 24) % 24;

    if (`${w.timeOfDay}|${w.dayOfYear}|${this.sunBearingOfMinusZ}` !== this._solarKey) {
      this._updateSolar();
      this._solarDirty = true;
    }
    if ((w.weather || 'bluebird') !== this._weatherName) {
      this.setWeather(w.weather, true);
      this._solarDirty = false;
    } else if (this._solarDirty) {
      // Only pay for the probe when the sun has moved enough to see it.
      const moved = this._lastEnvSun.dot(this.sunDirection) < Math.cos(0.4 * DEG);
      this._refreshSky(moved);
      this._solarDirty = false;
    }

    // Cheap per-frame uniforms.
    this._cloudUniforms.uCloud.value.w = this._time;
    this._cloudUniforms.uCloudGeom.value.z = camera ? camera.position.y : this._eyeAltitude;
    if (this._bankUniforms) this._bankUniforms.uTime.value = this._time;

    if (camera) {
      camera.updateMatrixWorld();
      const u = this._domeMaterial.uniforms;
      u.uInvProjection.value.copy(camera.projectionMatrixInverse);
      u.uCamRotation.value.setFromMatrix4(camera.matrixWorld);
      this._updateShadow(camera);
    }
  }

  /* -------------------------------------------------------------- *
   * Teardown
   * -------------------------------------------------------------- */

  dispose() {
    this._dome?.geometry.dispose();
    this._domeMaterial?.dispose();
    this._banks?.geometry.dispose();
    this._bankMaterial?.dispose();
    this._envMesh?.geometry.dispose();
    this._envMesh?.material.dispose();
    this._noise?.dispose();
    this._envTarget?.dispose();
    this._pmrem?.dispose();
    if (this.ctx?.scene) {
      this.ctx.scene.environment = null;
      this.ctx.scene.fog = null;
    }
    this.environmentTexture = null;
    this.object3D.parent?.remove(this.object3D);
  }
}

/* Scratch vectors — module scope so the shadow fit allocates nothing. */
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _v3d = new THREE.Vector3();
const _v3e = new THREE.Vector3();
const _v3f = new THREE.Vector3();

export default Sky;
