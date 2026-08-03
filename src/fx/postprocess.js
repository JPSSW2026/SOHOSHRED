/**
 * Soho Shred — the film layer.
 * ===========================================================================
 *
 * This module owns everything between "the renderer finished shading the
 * scene" and "the pixel that reaches the display". It is the difference
 * between a tech demo and a shipped game, and on a 70%-white alpine frame it
 * is doing more work than usual because snow has nowhere to hide a mistake.
 *
 * PIPELINE (docs/ART_DIRECTION.md §7 prescribes this order and it is followed
 * exactly):
 *
 *   scene → HDR half-float RT (MSAA 4x, depth texture attached)
 *     ├─ AO            half-res, depth-derived normals, tinted + floored
 *     ├─ AO blur       half-res cross-bilateral
 *     ├─ SceneFX       AO apply + fused velocity motion blur / physical DoF
 *     ├─ Bloom         bright-pass → 5-level pyramid → weighted upsample
 *     ├─ BloomComposite  two-tier bloom + analytic veiling glare on the sun
 *     ├─ OutputPass    AgX tone map + sRGB transfer   ← THE ONLY PLACE
 *     └─ Finish        CA → contrast-adaptive sharpen → ASC-CDL grade →
 *                      highlight rolloff → vignette → luminance-weighted grain
 *
 * COLOUR MANAGEMENT — the thing everybody gets wrong.
 * Because the scene now renders into a `WebGLRenderTarget`, three.js
 * automatically compiles the scene materials with `NoToneMapping` and leaves
 * the render-target texture in the linear working space (see
 * WebGLRenderer.getParameters: `toneMapping: currentRenderTarget === null ?
 * _this.toneMapping : NoToneMapping`). So every intermediate buffer in this
 * chain is **linear scene-referred HDR**, AO / DoF / motion blur / bloom all
 * operate on real radiance, and the tone map + sRGB encode happen exactly once,
 * at the very end, in `OutputPass`. Grain, chromatic aberration and the vignette
 * come after that because they are sensor and lens artefacts, not scene light.
 *
 * DETERMINISM. No `Math.random()` anywhere — grain, AO rotation and the DoF
 * spiral all come from closed-form hashes of `gl_FragCoord` and a frame seed
 * produced by `hash32(ctx.frame)` from `core/rng.js`. Two runs of the same shot
 * preset are byte-identical.
 *
 * ZERO ASSETS. Every kernel, LUT-equivalent and noise field is computed in the
 * shader. Nothing is loaded. (This is also why SMAAPass is deliberately not
 * used: its area/search textures decode asynchronously from data URLs, which
 * would make the first frames after boot non-deterministic. 4x MSAA on the
 * scene target — `MAX_SAMPLES` is 4 on the SwiftShader target — plus the
 * halo-free adaptive sharpen at the end does the same job synchronously.)
 *
 * BUDGET. SwiftShader is a software rasteriser, so the chain is aggressively
 * fused: AO+motion-blur+DoF share one full-res pass, the two bloom tiers share
 * one pyramid, and the entire LDR finish (CA, sharpen, grade, vignette, grain)
 * is one pass. Four full-resolution passes total. Sample counts drop
 * automatically when a software rasteriser is detected, and `?nopost` bypasses
 * the composer entirely.
 *
 * @see docs/ART_DIRECTION.md §7 (the post look), §7.5 (AO on snow),
 *      §7.6 (the grade), and the AAA ACCEPTANCE CHECKLIST items 45–52.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

import { CONFIG } from '../core/config.js';
import { clamp, clamp01, damp, lerp, smoothstep, hash32 } from '../core/rng.js';

const DEG = Math.PI / 180;

/* ==========================================================================
 * Tunables that do not live in CONFIG.post.
 *
 * CONFIG is owned by another workstream, so anything the art direction does
 * not already expose there lives here. Every value is readable/writable at
 * runtime through `ctx.post.tune` and can be overridden from CONFIG.post if a
 * future config pass adds the keys (see `pick()` below).
 * ========================================================================== */

const TUNE = {
  /** 'auto' | 'low' | 'medium' | 'high' — auto detects software rasterisers. */
  quality: 'auto',
  /** 4x MSAA on the scene target when the driver offers it. */
  msaa: true,

  bloom: {
    /** Soft-knee width as a fraction of the threshold. */
    softKnee: 0.6,
    /** Firefly clamp on the bright pass, in linear post-exposure units. */
    clampMax: 60.0,
    /**
     * WHERE THE BRIGHT-PASS KNEE SITS — the single most consequential number
     * in this file.
     *
     * It cannot be a constant. `CONFIG.post.bloom.threshold` (0.86) is a
     * *relative* figure written as if diffuse white were 1.0, but this scene is
     * scene-referred: `sky.js` drives the sun off a real solar constant
     * (`SOLAR_IRRADIANCE_UNITS`), so sunlit snow lands at ~4 linear, not ~1.
     * A fixed 0.86-ish threshold therefore sits *below* the entire snowfield;
     * every snow pixel then feeds the pyramid and gets the blurred result added
     * back, which is failure mode #38 ("everything is bloom") and destroys
     * near-field local contrast — the whole frame converges on one value and
     * checklist item 17 (near σ ÷ far σ ≥ 4) collapses.
     *
     * So the knee is anchored to the physical radiance of sunlit snow instead
     * (see `_diffuseWhite`), and `whiteScale` places it that far above:
     *
     *     threshold = whiteScale · albedo · ( E_beam·N·L + E_sky ) / π
     *
     * The irradiances come from `ctx.sky.irradiance`, so the knee tracks sun
     * elevation and weather automatically and always sits the same distance
     * *above* the snowfield. At 1.8 only the sun disc, the aureole and genuine
     * specular glints cross it — which is what tiers 1 and 2 of §7.1 are
     * actually made of once the snowfield itself is excluded.
     */
    whiteScale: 1.8,
    /**
     * The tilt, toward the sun, of the slope that `_diffuseWhite` calls
     * "sunlit". It must not be zero: at Soho Basin's 10.5° winter sun a plane
     * tilted 25° into the beam collects sin(35.5°)/sin(10.5°) ≈ 3.2× the
     * irradiance of a horizontal one, so a horizontal-plane white reference
     * under-reads the actual sunlit snow by 3× and would leave the knee sitting
     * *below* the sunlit snowfield — i.e. would not fix #38 at all. Measured
     * against the shipped frames: horizontal white is 1.41 linear, while the
     * 93rd-percentile snow pixel inverts back to ~4.4 linear, and a 25° slope
     * predicts 4.0. 25° is also the pitch of the bowl-entry face the gameplay
     * presets ride.
     */
    sunlitSlopeDeg: 25,
    /** The `CONFIG.post.bloom.threshold` value that means "no relative trim". */
    whiteReference: 0.86,
    /**
     * Legacy absolute knee (post-exposure units), used only as a floor and as
     * the fallback when the sky system has not published an irradiance yet.
     */
    veilThresholdScale: 0.87,
    /** Split of CONFIG.post.bloom.strength across the two tiers (sums to it). */
    coreSplit: 0.30,
    veilSplit: 0.13,
    /**
     * Anamorphic-ish streak, derived from the coarsest bloom mip (never a
     * sprite). DEFAULT 0: the art-direction acceptance checklist item 47
     * forbids visible anamorphic streaks. Kept implemented and switchable
     * because the effect is wanted for replay/photo mode.
     */
    streak: 0.0,
    streakSpread: 0.035,
    /** Per-level weight when the pyramid is accumulated back up. */
    upWeightMin: 0.55,
    upWeightMax: 0.92,
  },

  /**
   * Veiling glare around the sun. Physical, not a sprite: at 10.6° elevation
   * the sun is behind air mass 5.4 and is a large soft blob with no discernible
   * disc edge (§7.1). Modelled as a Gaussian core plus a Lorentzian tail —
   * the Lorentzian is the standard form of the human/lens glare PSF.
   */
  glare: {
    core: 2.2,
    coreSigma: 0.035,   // in aspect-corrected UV (units of frame height)
    halo: 0.30,
    haloSigma: 0.18,
    /** Ray-march resolution for the CPU-side sun occlusion test. */
    marchSteps: 28,
  },

  ssao: {
    /** Normal bias — keeps grazing snow slopes from self-occluding. */
    bias: 0.055,
    /** §7.5: never let a crease go to grey mud. */
    floor: 0.45,
    /** Cap the screen radius so AO stays a *contact* effect, not a big smudge. */
    maxRadiusPx: 26,
    /** §7.5 rule 1: AO must attenuate ambient only, never the sun term. */
    sunSuppress: 0.82,
    sunLumLo: 0.34,
    sunLumHi: 0.78,
    blurSpread: 1.7,
    depthSigma: 0.055,
    /** Contact AO only: full strength to `fadeStart`, gone by `fadeEnd`. */
    fadeStart: 22,
    fadeEnd: 70,
  },

  dof: {
    /** Full-frame reference format — makes the f-numbers below mean what they say. */
    sensorHeight: 0.024,
    /** CONFIG.post.dof.aperture 0..1 maps onto this f-number range. */
    fNumberDeep: 16.0,
    fNumberOpen: 2.6,
    /** §7.2: cinematic/macro may open up to 2% of frame height. */
    cinematicMaxBlur: 0.020,
    /**
     * THE FAR SIDE OF FOCUS IS NOT THE NEAR SIDE — and `maxBlur` is a near-side
     * number.
     *
     * §7.2 reads: "near-focus softening only within ~1.5 m of the lens, and a
     * very slight far softening beyond ~60 m … never bokeh the mountain."
     * One cap could not express that. With a single cap the thin-lens CoC
     * saturates a few focus-distances out and then stays saturated all the way
     * to the horizon, so every pixel past ~3× the focus distance — the far
     * ridge, the backdrop skyline, the cloud bank — was blurred by the same
     * disc. On the cinematic presets (34–38° lens, f/2.6, focus locked on a
     * rider 3–12 m away) that is a background CoC of 1.5–6 px at 720p, which is
     * precisely the tilt-shift/miniature tell of checklist item 51, and it also
     * eats the far-field detail that item 17's σ ratio is measured on.
     *
     * So the far side gets its own ceiling, sized to stay at or under one pixel
     * of radius at the 1280×720 capture size (0.0012 · 720 = 0.9 px, 1.3 px at
     * 1080p). That is "very slight" and it is not bokeh. Cinematic gets a
     * little more room, still sub-2 px, because a hero shot may show a hint of
     * separation — but never enough to soften a ridge line.
     *
     * The cap only binds away from the focal plane, so the transition through
     * focus stays continuous: at z == focus the CoC is zero on both sides.
     */
    farMaxBlur: 0.0012,
    cinematicFarMaxBlur: 0.0020,
    /** Any lens longer than this reads as cinematic/macro. */
    cinematicFovDeg: 40,
    focusLambda: 6.0,
    /** Auto-focus ray budget. */
    focusRaySteps: 48,
    focusRayMax: 420,
    /**
     * Hyperfocal gate (§7.2, checklist items 17 and 51). Focus racked out past
     * `hyperfocalNear` metres is, on any lens this game uses, past its own
     * hyperfocal distance: a landscape framed on a ridge 300 m away is sharp
     * from a few metres to infinity, and every reference wide is. Without this
     * the thin-lens CoC keeps softening the *near* ground of a wide shot, which
     * inverts the depth cue — a reverse tilt-shift that reads as a miniature.
     * Fades out over [near, far] so a chase that drifts off the rider onto the
     * far slope does not pop.
     */
    hyperfocalNear: 40,
    hyperfocalFar: 120,
    /**
     * Focus distance used when the centre ray finds no ground at all (looking
     * out over a basin, or at the sky). "Infinity" is the correct answer for a
     * landscape; the old fallback to `CONFIG.post.dof.focusDistance` (9 m) put
     * the whole mountain behind the focal plane.
     */
    infinityFocus: 4000,
  },

  motionBlur: {
    /** Hard cap so a teleport or a spike can never produce a screen-long smear. */
    maxPixels: 44,
    /**
     * A follow camera pans with its subject: the subject stays sharp and the
     * world streaks. Camera-reprojection blur cannot know that, so the subject
     * is protected explicitly. Radii are aspect-corrected UV from the rider.
     */
    subjectInner: 0.10,
    subjectOuter: 0.34,
    subjectFloor: 0.25,
    /**
     * Depth mask (§7.3: "blur must not be applied to the sky … or you get a
     * smeared sun"). The sky dome itself never writes depth, so it already
     * reads as the far plane and is excluded — but the world does not end at
     * the sky dome. `CONFIG.terrain.backdropRadius` puts a real skyline shell
     * at 26 km while `camera.far` is 40 km, so the entire distant horizon was
     * classified as *geometry* and received the full camera-reprojection
     * velocity. Camera translation gives a 26 km ridge exactly zero parallax;
     * everything it was getting came from rotation, i.e. a whole-frame pan
     * smear, which §7.3 calls out as the failure mode of camera-only blur and
     * which showed up as directional streaking across the far ridge and the
     * high cloud.
     *
     * Velocity therefore fades to zero over [start, end] metres. 1.5 km is
     * past the LOD'd playable terrain and deep into the aerial-perspective
     * haze, so nothing that carries near-field detail is affected: this only
     * removes smear from surfaces that are, optically, at infinity.
     */
    farFadeStart: 1500,
    farFadeEnd: 5000,
    /**
     * The reprojection measures displacement over one *simulation* step, so a
     * long frame would produce a proportionally longer smear. §7.3 fixes the
     * exposure instead: a 180° shutter at 60 fps is 1/120 s no matter how long
     * the frame took. The shutter is scaled by `refFrameTime / dt`, clamped so
     * it can only ever shorten the smear — a hitch must never paint a
     * screen-long streak, and at the harness's fixed 1/60 step this is exactly
     * a no-op.
     */
    refFrameTime: 1 / 60,
  },

  /**
   * §7.6 — cool shadows, neutral-to-warm highlights, lifted blacks.
   * ASC-CDL: out = (in * slope + offset) ^ power. These are single-digit
   * percent moves *by design*: the blue in the shadows is the lighting's job.
   */
  grade: {
    slope: [1.000, 1.000, 1.020],
    offset: [0.004, 0.006, 0.012],
    power: [1.020, 1.000, 0.980],
    saturation: 1.08,
    shadowSaturation: 1.14,
    /**
     * Extreme-highlight desaturation, and how far up the curve it starts.
     *
     * Film and AgX both bleach the top of the range toward white, and the
     * finish pass used to reproduce that with a 35% pull starting at L = 0.75.
     * On a normal scene that is invisible. On *this* scene it is a global
     * desaturation in disguise: a bluebird snow frame is 70% white, its median
     * output luma sits at 0.55–0.80 and the snow-only presets put nearly every
     * pixel above 0.75 — so the ramp was stripping a third of the chroma from
     * the whole picture, exactly on the frames that measured mean saturation
     * 0.074/0.080 against a [0.18, 0.36] requirement (checklist item 5).
     *
     * §7.6 is explicit that the grade may only make single-digit-percent moves
     * and that the colour has to come from the lighting. So the pull is cut to
     * 12% and the knee raised to 0.86, which is above sunlit snow (§1.1 puts
     * the sunlit sample at 0xDC–0xFA, i.e. 0.86–0.98, so only its very top and
     * the sun/glint cores are touched) and below the rolloff knee at 0.94.
     * AgX has already done the real highlight bleach before this pass runs;
     * this is the last few percent on top of it, not a second helping.
     *
     * The move is exactly luminance-preserving — `mix(vec3(L), g, sat)` leaves
     * `dot(g, LUMA)` untouched — so it cannot shift exposure, the p99.9 luma or
     * the pure-white pixel count. It only returns chroma.
     */
    highlightDesat: 0.12,
    highlightDesatKnee: 0.86,
    /**
     * Highlight rolloff — an exponential shoulder that asymptotes to
     * `rolloffCeiling` and so can never produce a clipped plateau
     * (checklist item 2, p99.9 ≤ 252).
     *
     * The knee has to stay *above* sunlit snow. AgX already delivers sunlit
     * snow around 0.90 and the sun's core at the top of its range, so a knee at
     * 0.86 caught the snow as well and squashed a 27-level sun-over-snow lead
     * into 6: the sun read as a bright patch of cloud rather than as a source.
     * At 0.94 the shoulder only touches the top ~15 levels, snow passes through
     * untouched with all of its modulation, and the core keeps a ~20-level lead
     * over the snowfield. The ceiling is 1.0 because the tone mapper's gamut
     * clamp already bounds its input there — a higher ceiling would buy nothing
     * except the risk of clipping glints on the sun-out frames.
     */
    rolloffKnee: 0.94,
    rolloffCeiling: 1.0,
  },

  vignette: {
    start: 0.55,   // §7.4: falloff begins at 0.55 of the frame radius
    end: 1.14,
    curve: 1.35,
  },

  chromatic: {
    /** §7.4: exactly zero inside the central 40% radius. */
    innerRadius: 0.40,
  },
};

/** Sample budgets. `aoScale` is the AO buffer's fraction of full resolution. */
const QUALITY_TIERS = {
  low: { fxSamples: 8, aoSamples: 6, bloomLevels: 4, aoScale: 0.5 },
  medium: { fxSamples: 12, aoSamples: 8, bloomLevels: 5, aoScale: 0.5 },
  high: { fxSamples: 14, aoSamples: 12, bloomLevels: 5, aoScale: 0.5 },
};

/* ==========================================================================
 * Small helpers
 * ========================================================================== */

/** Read a query-string flag without throwing in a non-browser context. */
function qs(name) {
  try {
    if (typeof location === 'undefined' || !location.search) return null;
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}
function hasQs(name) {
  try {
    if (typeof location === 'undefined' || !location.search) return false;
    return new URLSearchParams(location.search).has(name);
  } catch {
    return false;
  }
}

/** CONFIG.post wins if it defines the key, otherwise our own default. */
function pick(cfgNode, key, fallback) {
  const v = cfgNode ? cfgNode[key] : undefined;
  return v === undefined || v === null ? fallback : v;
}

/** Try hard to identify a software rasteriser so we can drop sample counts. */
function detectSoftwareRaster(renderer) {
  try {
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(
      (dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '',
    );
    return /swiftshader|llvmpipe|lavapipe|softpipe|software|microsoft basic/i.test(name);
  } catch {
    return false;
  }
}

/* ==========================================================================
 * Shader source
 * ========================================================================== */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/**
 * Shared fragment prelude: deterministic hashing with no bitwise operators, so
 * it stays valid GLSL ES 1.00 and produces identical values on every backend.
 */
const FRAG_COMMON = /* glsl */ `
const float GOLDEN_ANGLE = 2.39996323;
const vec3  LUMA = vec3( 0.2126, 0.7152, 0.0722 );

/** Interleaved gradient noise — well distributed in screen space, closed form. */
float ign( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}

/** Hash a 2D position + a scalar seed to [0,1). Deterministic across runs. */
float hash13( vec3 p3 ) {
  p3 = fract( p3 * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
`;

/**
 * Depth helpers. Only included by passes that also `#include <packing>`, which
 * is where `perspectiveDepthToViewZ` (and its reversed-depth-buffer variant)
 * comes from.
 */
const FRAG_DEPTH = /* glsl */ `
/** Positive distance along the view axis, from a hardware depth sample. */
float linearZ( sampler2D depthTex, vec2 uv, float near, float far ) {
  float d = texture2D( depthTex, uv ).x;
  return - perspectiveDepthToViewZ( d, near, far );
}

/** View-space position of a pixel, from its UV and its axial distance. */
vec3 viewPos( vec2 uv, float z, vec2 tanHalf ) {
  return vec3( ( uv * 2.0 - 1.0 ) * tanHalf * z, -z );
}
`;

/* ------------------------------------------------------------------ AO --- *
 * Horizon-free hemisphere AO from the depth buffer.
 *
 * Normals are reconstructed from four depth taps (picking the closer of each
 * opposing pair, which keeps silhouettes from bleeding), which avoids a second
 * full scene render — GTAOPass and SSAOPass both re-render the whole scene into
 * a normal buffer and that is unaffordable on a software rasteriser with a
 * 2 km terrain in frame.
 *
 * Output: .r = raw AO, .g = linear depth (the bilateral blur's guide channel).
 * ------------------------------------------------------------------------ */
const AO_FRAG = /* glsl */ `
#include <packing>
${FRAG_COMMON}
${FRAG_DEPTH}

uniform sampler2D tDepth;
uniform vec2  uTexel;       // 1 / AO buffer size
uniform vec2  uTanHalf;
uniform float uNear;
uniform float uFar;
uniform float uRadius;      // metres
uniform float uIntensity;
uniform float uProjScale;   // full-res pixels per metre at 1 m distance
uniform float uMaxRadius;   // AO-buffer pixels
uniform float uBias;
uniform float uAoScale;     // AO buffer size / scene buffer size
uniform vec2  uFade;        // (start, end) metres

varying vec2 vUv;

void main() {

  float zc = linearZ( tDepth, vUv, uNear, uFar );

  // AO is a *contact* effect: it has no business existing past a few tens of
  // metres, where a 0.6 m radius is sub-pixel anyway. Cutting it off here is
  // three things at once — it matches the art direction's rule that detail
  // must vanish with distance, it removes the iso-depth banding that 24-bit
  // depth quantisation produces when normals are differenced at long range,
  // and it skips the whole sampling loop for most of a wide alpine frame.
  float fade = 1.0 - smoothstep( uFade.x, uFade.y, zc );
  if ( fade <= 0.001 ) {
    gl_FragColor = vec4( 1.0, zc, 0.0, 1.0 );
    return;
  }

  vec3 P = viewPos( vUv, zc, uTanHalf );

  // --- depth-derived normal ------------------------------------------------
  // Differenced over one AO-buffer texel rather than one scene texel: the
  // wider baseline halves the depth-quantisation noise in the slope estimate.
  vec2 ox = vec2( uTexel.x, 0.0 );
  vec2 oy = vec2( 0.0, uTexel.y );
  float zl = linearZ( tDepth, vUv - ox, uNear, uFar );
  float zr = linearZ( tDepth, vUv + ox, uNear, uFar );
  float zd = linearZ( tDepth, vUv - oy, uNear, uFar );
  float zu = linearZ( tDepth, vUv + oy, uNear, uFar );

  vec3 dx = ( abs( zr - zc ) < abs( zc - zl ) )
    ? ( viewPos( vUv + ox, zr, uTanHalf ) - P )
    : ( P - viewPos( vUv - ox, zl, uTanHalf ) );
  vec3 dy = ( abs( zu - zc ) < abs( zc - zd ) )
    ? ( viewPos( vUv + oy, zu, uTanHalf ) - P )
    : ( P - viewPos( vUv - oy, zd, uTanHalf ) );

  vec3 N = cross( dx, dy );
  float nl = length( N );
  if ( nl < 1e-12 ) {
    gl_FragColor = vec4( 1.0, zc, 0.0, 1.0 );
    return;
  }
  N /= nl;

  // --- sampling ------------------------------------------------------------
  // World radius projected to screen, then clamped: AO must read as contact
  // darkening in the small concavities, not as a wide dirty smudge (§7.5).
  float radiusPx = min( uRadius * uProjScale * uAoScale / zc, uMaxRadius );

  float phi = ign( gl_FragCoord.xy ) * 6.2831853;
  float occ = 0.0;

  for ( int i = 0; i < AO_SAMPLES; i ++ ) {
    float fi = float( i ) + 0.5;
    float a = fi * GOLDEN_ANGLE + phi;
    float r = sqrt( fi / float( AO_SAMPLES ) ) * radiusPx;
    vec2 suv = vUv + vec2( cos( a ), sin( a ) ) * r * uTexel;

    float sz = linearZ( tDepth, suv, uNear, uFar );
    vec3 S = viewPos( suv, sz, uTanHalf );
    vec3 v = S - P;
    float len = max( length( v ), 1e-4 );

    // Falls off outside the world radius so a distant silhouette does not
    // stamp a dark halo onto the surface behind it.
    float range = smoothstep( 0.0, 1.0, uRadius / len );
    occ += clamp( dot( N, v / len ) - uBias, 0.0, 1.0 ) * range;
  }

  float ao = 1.0 - uIntensity * fade * occ / float( AO_SAMPLES );
  gl_FragColor = vec4( clamp( ao, 0.0, 1.0 ), zc, 0.0, 1.0 );
}
`;

/** Depth-aware 8-tap cross-bilateral blur of the AO buffer. */
const AO_BLUR_FRAG = /* glsl */ `
uniform sampler2D tAO;
uniform vec2  uTexel;
uniform float uSpread;
uniform float uDepthSigma;
varying vec2 vUv;

void main() {
  vec2 c = texture2D( tAO, vUv ).rg;
  float sum = c.r;
  float wsum = 1.0;

  #define AO_TAP( OX, OY ) { \
    vec2 s = texture2D( tAO, vUv + vec2( OX, OY ) * uTexel * uSpread ).rg; \
    float w = exp( - abs( s.g - c.g ) / max( uDepthSigma * c.g, 0.02 ) ); \
    sum += s.r * w; wsum += w; \
  }

  AO_TAP( -1.0, -1.0 ) AO_TAP( 1.0, -1.0 ) AO_TAP( -1.0, 1.0 ) AO_TAP( 1.0, 1.0 )
  AO_TAP( -2.0, 0.0 ) AO_TAP( 2.0, 0.0 ) AO_TAP( 0.0, -2.0 ) AO_TAP( 0.0, 2.0 )

  gl_FragColor = vec4( sum / wsum, c.g, 0.0, 1.0 );
}
`;

/* -------------------------------------------------------------- SceneFX --- *
 * One full-resolution pass that does three things, because on a software
 * rasteriser three passes would cost three times the bandwidth:
 *
 *  1. Applies AO, tinted toward the snow transport colour and floored, and
 *     suppressed where the pixel is sun-dominated (§7.5 rule 1).
 *  2. Camera-velocity motion blur reconstructed from depth. No velocity buffer
 *     render is needed: the previous frame's view-projection is folded into a
 *     single matrix that maps *current view space* straight to *previous clip
 *     space*, which is both cheaper and more precise than a world-space round
 *     trip at 26 km draw distances.
 *  3. Depth of field with a circle of confusion from a real thin-lens model.
 *
 * The blur and the CoC are convolved into one gather: each tap is displaced
 * along the velocity vector *and* around the CoC disc. Taps use the centre
 * pixel's CoC (one fetch per tap rather than two) — at gameplay CoC sizes
 * (0.03–0.3% of frame height) the per-tap CoC test is not observable, and the
 * cinematic sizes are near-focus foreground softening where it also is not.
 * ------------------------------------------------------------------------ */
const SCENE_FX_FRAG = /* glsl */ `
#include <packing>
${FRAG_COMMON}
${FRAG_DEPTH}

uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2  uTexel;
uniform vec2  uRes;
uniform vec2  uTanHalf;
uniform float uNear;
uniform float uFar;
uniform float uAspect;

#ifdef USE_AO
uniform sampler2D tAO;
uniform vec3  uAoTint;        // hue-only, luminance-normalised
uniform vec2  uAoSunRange;    // (lo, hi) linear luminance of the sun/shadow split
uniform float uAoSunSuppress;
uniform float uAoFloor;
#endif

#ifdef USE_MB
uniform mat4  uReproj;        // current view space -> previous clip space
uniform float uShutter;       // 0.5 == a 180 degree shutter
uniform float uVelMaxPx;
uniform vec2  uSubjectUv;
uniform vec3  uSubjectMask;   // (inner, outer, floor)
uniform vec2  uMbFar;         // (fadeStart, fadeEnd) metres — infinity mask
#endif

#ifdef USE_DOF
uniform float uCocGain;       // A * f / ( sensorH * ( S - f ) )
uniform float uFocus;         // S, metres
uniform float uMaxCoc;        // near side, fraction of frame height
uniform float uMaxCocFar;     // far side, fraction of frame height
#endif

varying vec2 vUv;

void main() {

  float z = linearZ( tDepth, vUv, uNear, uFar );
  bool isSky = z >= uFar * 0.97;

  vec2 velPx = vec2( 0.0 );
  float cocPx = 0.0;

  #ifdef USE_MB
  if ( ! isSky ) {
    vec3 P = viewPos( vUv, z, uTanHalf );
    vec4 prevClip = uReproj * vec4( P, 1.0 );
    if ( prevClip.w > 1e-5 ) {
      vec2 prevUv = ( prevClip.xy / prevClip.w ) * 0.5 + 0.5;
      vec2 vel = ( vUv - prevUv ) * uShutter;

      // Protect the subject: a follow camera pans with the rider, so the rider
      // is sharp and the world streaks past. Without this the reprojection
      // treats the rider as static world geometry and smears the hero element.
      float sr = length( ( vUv - uSubjectUv ) * vec2( uAspect, 1.0 ) );
      vel *= mix( uSubjectMask.z, 1.0, smoothstep( uSubjectMask.x, uSubjectMask.y, sr ) );

      // Depth mask: anything optically at infinity (the 26 km backdrop shell,
      // the far ridge) has no translational parallax, so all it can receive is
      // a pan smear. §7.3 forbids that on the sky and it reads as smeared
      // distant terrain everywhere else.
      vel *= 1.0 - smoothstep( uMbFar.x, uMbFar.y, z );

      velPx = vel * uRes;
      float vl = length( velPx );
      if ( vl > uVelMaxPx ) velPx *= uVelMaxPx / vl;
    }
  }
  #endif

  #ifdef USE_DOF
  if ( ! isSky ) {
    // Thin lens: CoC = A * f * |d - S| / ( d * ( S - f ) ), expressed as a
    // fraction of frame height so it is resolution independent.
    float coc = uCocGain * abs( z - uFocus ) / max( z, 0.05 );
    // Separate ceilings either side of the focal plane (§7.2): the near side
    // may go properly soft, the far side may not — "never bokeh the mountain".
    // Both ceilings are inactive at z == uFocus, where the CoC is zero, so the
    // switch introduces no discontinuity.
    float cap = z > uFocus ? uMaxCocFar : uMaxCoc;
    cocPx = min( coc, cap ) * uRes.y;
  }
  // The sky is at infinity and carries no depth cue at all; softening it just
  // smears the sun and the cloud edges (§7.3). It stays at cocPx = 0.
  #endif

  vec3 col;
  float maxOff = max( length( velPx ) * 0.5, cocPx );

  if ( maxOff < 0.6 ) {
    // Sub-pixel: skip the gather entirely. This is the common case for most of
    // a gameplay frame and it is a large win on a software rasteriser.
    col = texture2D( tScene, vUv ).rgb;
  } else {
    float phi = ign( gl_FragCoord.xy );
    vec3 acc = vec3( 0.0 );

    for ( int i = 0; i < FX_SAMPLES; i ++ ) {
      float fi = float( i ) + 0.5;
      // Line parameter, dithered and centred on the pixel: a centred smear
      // reads as motion, a trailing one reads as a ghost.
      float t = fract( fi * 0.6180339887 + phi ) - 0.5;
      // Disc parameter: golden-angle spiral, uniform in area.
      float a = fi * GOLDEN_ANGLE + phi * 6.2831853;
      float r = sqrt( fi / float( FX_SAMPLES ) );

      vec2 off = velPx * t + vec2( cos( a ), sin( a ) ) * r * cocPx;
      acc += texture2D( tScene, vUv + off * uTexel ).rgb;
    }
    col = acc / float( FX_SAMPLES );
  }

  #ifdef USE_AO
  {
    float ao = texture2D( tAO, vUv ).r;

    // §7.5 rule 1 — AO attenuates the sky/bounce fill, never the sun. A
    // screen-space pass cannot separate the two, so sun dominance is inferred
    // from luminance: shadowed snow sits at 0.22–0.55 of sunlit (LAW 3).
    float lum = dot( col, LUMA );
    float sunW = smoothstep( uAoSunRange.x, uAoSunRange.y, lum );
    float aoE = mix( ao, 1.0, sunW * uAoSunSuppress );
    aoE = max( aoE, uAoFloor );

    // §7.5 rule 2 — an occluded pocket of snow sees less sky but more of the
    // snowfield's own multiply-scattered light: it goes bluer and softer, never
    // grey. uAoTint is CONFIG.snow.sssColor normalised to unit luminance, so
    // this shifts hue without changing how much it darkens.
    float occ = 1.0 - aoE;
    col *= aoE * mix( vec3( 1.0 ), uAoTint, occ );
  }
  #endif

  gl_FragColor = vec4( col, 1.0 );
}
`;

/* ---------------------------------------------------------------- Bloom --- */

/** Bright pass with a quadratic soft knee, folded into a 2x downsample. */
const BLOOM_BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2  uTexel;      // source (full-res) texel size
uniform float uThreshold;
uniform float uKnee;
uniform float uClampMax;
varying vec2 vUv;

void main() {
  vec3 c = texture2D( tDiffuse, vUv + vec2( -0.5, -0.5 ) * uTexel ).rgb
         + texture2D( tDiffuse, vUv + vec2(  0.5, -0.5 ) * uTexel ).rgb
         + texture2D( tDiffuse, vUv + vec2( -0.5,  0.5 ) * uTexel ).rgb
         + texture2D( tDiffuse, vUv + vec2(  0.5,  0.5 ) * uTexel ).rgb;
  c = min( c * 0.25, vec3( uClampMax ) );

  float l = max( c.r, max( c.g, c.b ) );
  float k = max( uKnee, 1e-4 );
  float rq = clamp( l - uThreshold + k, 0.0, 2.0 * k );
  rq = rq * rq / ( 4.0 * k );
  float contrib = max( rq, l - uThreshold ) / max( l, 1e-4 );

  gl_FragColor = vec4( c * contrib, 1.0 );
}
`;

/** 4-tap bilinear box downsample (covers a 4x4 source footprint). */
const BLOOM_DOWN_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uTexel;   // source texel size
varying vec2 vUv;
void main() {
  vec3 c = texture2D( tDiffuse, vUv + vec2( -1.0, -1.0 ) * uTexel ).rgb
         + texture2D( tDiffuse, vUv + vec2(  1.0, -1.0 ) * uTexel ).rgb
         + texture2D( tDiffuse, vUv + vec2( -1.0,  1.0 ) * uTexel ).rgb
         + texture2D( tDiffuse, vUv + vec2(  1.0,  1.0 ) * uTexel ).rgb;
  gl_FragColor = vec4( c * 0.25, 1.0 );
}
`;

/** 4-tap bilinear tent upsample, additively accumulated with a level weight. */
const BLOOM_UP_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2  uTexel;   // source texel size
uniform float uWeight;
varying vec2 vUv;
void main() {
  vec3 c = texture2D( tDiffuse, vUv + vec2( -0.5, -0.5 ) * uTexel ).rgb
         + texture2D( tDiffuse, vUv + vec2(  0.5, -0.5 ) * uTexel ).rgb
         + texture2D( tDiffuse, vUv + vec2( -0.5,  0.5 ) * uTexel ).rgb
         + texture2D( tDiffuse, vUv + vec2(  0.5,  0.5 ) * uTexel ).rgb;
  gl_FragColor = vec4( c * 0.25 * uWeight, 1.0 );
}
`;

/**
 * Two-tier bloom composite plus the sun's veiling glare.
 *
 * tBloom is the accumulated pyramid (narrow core + medium halo). tVeil is the
 * coarsest mip on its own, added at its own strength: that is the §7.1 tier-2
 * "light scattering inside the lens because 70% of the frame is a 15,000 cd/m²
 * white field" term, and it is what lifts the mid-distance blacks and collapses
 * far-field contrast in the reference frames.
 *
 * The sun glare is analytic and radially symmetric — a Gaussian core plus a
 * Lorentzian tail. It is not a sprite, has no ghosts, no hexagons and no
 * aperture structure, which is exactly what the art direction demands.
 */
const BLOOM_COMPOSITE_FRAG = /* glsl */ `
${FRAG_COMMON}

uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform sampler2D tVeil;
uniform vec2  uBloomTexel;
uniform float uBloomStrength;
uniform float uVeilStrength;
uniform float uAspect;

uniform vec2  uSunUv;
uniform float uSunVis;
uniform vec3  uSunTint;
uniform vec4  uGlare;      // (coreGain, coreSigma, haloGain, haloSigma)

#ifdef USE_STREAK
uniform float uStreak;
uniform float uStreakSpread;
#endif

varying vec2 vUv;

void main() {
  vec3 base = texture2D( tDiffuse, vUv ).rgb;

  vec3 b = texture2D( tBloom, vUv + vec2( -0.5, -0.5 ) * uBloomTexel ).rgb
         + texture2D( tBloom, vUv + vec2(  0.5, -0.5 ) * uBloomTexel ).rgb
         + texture2D( tBloom, vUv + vec2( -0.5,  0.5 ) * uBloomTexel ).rgb
         + texture2D( tBloom, vUv + vec2(  0.5,  0.5 ) * uBloomTexel ).rgb;
  b *= 0.25;

  vec3 veil = texture2D( tVeil, vUv ).rgb;

  vec3 outc = base + b * uBloomStrength + veil * uVeilStrength;

  #ifdef USE_STREAK
  {
    // Derived from the bloom buffer itself, never from a texture.
    vec3 st = vec3( 0.0 );
    float wsum = 0.0;
    for ( int i = -3; i <= 3; i ++ ) {
      float w = 1.0 - abs( float( i ) ) * 0.25;
      st += texture2D( tVeil, vUv + vec2( float( i ) * uStreakSpread, 0.0 ) ).rgb * w;
      wsum += w;
    }
    outc += st / wsum * uStreak;
  }
  #endif

  if ( uSunVis > 0.0 ) {
    float d = length( ( vUv - uSunUv ) * vec2( uAspect, 1.0 ) );
    float core = exp( - ( d * d ) / ( 2.0 * uGlare.y * uGlare.y ) );
    float k = d / uGlare.w;
    float halo = 1.0 / ( 1.0 + k * k );
    outc += uSunTint * uSunVis * ( uGlare.x * core + uGlare.z * halo );
  }

  gl_FragColor = vec4( outc, 1.0 );
}
`;

/* --------------------------------------------------------------- Finish --- *
 * Everything that happens to the image *after* it has become a picture:
 * lateral chromatic aberration, a halo-free contrast-adaptive sharpen, the
 * ASC-CDL grade, the highlight rolloff, the vignette and the film grain.
 *
 * Order note: the art direction lists sharpen last so that it restores edges
 * softened by DoF, motion blur and AA. It is placed before the grain here for
 * the obvious reason that sharpening grain amplifies grain; everything else
 * follows §7 exactly.
 * ------------------------------------------------------------------------ */
const FINISH_FRAG = /* glsl */ `
${FRAG_COMMON}

uniform sampler2D tDiffuse;
uniform vec2  uTexel;
uniform float uAspect;
uniform float uCornerR;

uniform float uCA;
uniform float uCAInner;
uniform float uSharpen;

uniform vec3  uSlope;
uniform vec3  uOffset;
uniform vec3  uPower;
uniform float uSaturation;
uniform float uShadowSat;
uniform vec2  uHiDesat;     // (amount, knee) of the extreme-highlight bleach
uniform vec2  uRolloff;     // (knee, ceiling)

uniform vec3  uVignette;    // (strength, start, end)
uniform float uVignetteCurve;

uniform float uGrain;
uniform float uSeed;

varying vec2 vUv;

void main() {

  vec2 c = vUv - 0.5;
  vec2 ac = c * vec2( uAspect, 1.0 );
  float rn = length( ac ) / uCornerR;          // 0 at centre, 1 at the corner

  // --- lateral chromatic aberration ---------------------------------------
  // Transverse only, radial, and exactly zero inside the central 40% radius
  // (§7.4). Longitudinal CA — a uniform full-frame colour split — is not a
  // real lens artefact and is deliberately absent.
  vec3 col;
  float disp = uCA * rn * smoothstep( uCAInner, 1.0, rn );
  if ( disp > 0.0 ) {
    vec2 nd = ac / max( length( ac ), 1e-6 );
    vec2 off = nd * disp * vec2( 1.0 / uAspect, 1.0 );
    col.r = texture2D( tDiffuse, vUv + off ).r;
    col.g = texture2D( tDiffuse, vUv ).g;
    col.b = texture2D( tDiffuse, vUv - off ).b;
  } else {
    col = texture2D( tDiffuse, vUv ).rgb;
  }

  // --- contrast-adaptive sharpen ------------------------------------------
  // The amount is scaled down where local contrast is already high, and the
  // result is hard-clamped to the neighbourhood's range. That clamp is what
  // makes it impossible to produce the bright halo along a ridge-against-sky
  // edge that checklist item 52 fails on.
  if ( uSharpen > 0.0 ) {
    vec3 n0 = texture2D( tDiffuse, vUv - vec2( uTexel.x, 0.0 ) ).rgb;
    vec3 n1 = texture2D( tDiffuse, vUv + vec2( uTexel.x, 0.0 ) ).rgb;
    vec3 n2 = texture2D( tDiffuse, vUv - vec2( 0.0, uTexel.y ) ).rgb;
    vec3 n3 = texture2D( tDiffuse, vUv + vec2( 0.0, uTexel.y ) ).rgb;

    vec3 mn = min( min( n0, n1 ), min( n2, n3 ) );
    vec3 mx = max( max( n0, n1 ), max( n2, n3 ) );
    vec3 blur = ( n0 + n1 + n2 + n3 ) * 0.25;

    vec3 amp = sqrt( clamp( min( mn, 1.0 - mx ) / max( mx, 1e-3 ), 0.0, 1.0 ) );
    vec3 sharp = col + ( col - blur ) * uSharpen * amp;
    col = clamp( sharp, min( mn, col ), max( mx, col ) );
  }

  // --- ASC-CDL grade -------------------------------------------------------
  vec3 g = max( col * uSlope + uOffset, 0.0 );
  g = pow( g, uPower );

  // Saturation by luminance: shadows keep (and slightly gain) their blue, and
  // only the *extreme* highlight bleaches toward white. The bleach knee has to
  // sit above sunlit snow — on a 70%-white frame a knee inside the snow range
  // is a whole-frame desaturation wearing a film-response costume, and it is
  // what put mean frame saturation at 0.07 on the snow-only presets.
  // Luminance-preserving by construction: dot(mix(vec3(l), g, s), LUMA) == l.
  float l = dot( g, LUMA );
  float sat = mix( uShadowSat, uSaturation, smoothstep( 0.0, 0.6, l ) );
  sat *= 1.0 - uHiDesat.x * smoothstep( uHiDesat.y, 1.0, l );
  g = mix( vec3( l ), g, sat );

  // --- highlight rolloff ---------------------------------------------------
  // Snow does not clip. An exponential shoulder above the knee asymptotes to
  // the ceiling and never reaches it, so there is no flat detail-free plateau
  // and the 99.9th percentile stays under 252/255.
  vec3 over = max( g - uRolloff.x, 0.0 );
  float span = max( uRolloff.y - uRolloff.x, 1e-4 );
  g = min( g, vec3( uRolloff.x ) ) + span * ( 1.0 - exp( - over / span ) );

  // --- vignette ------------------------------------------------------------
  // Natural lens falloff, smooth, starting at 0.55 of the frame radius. If a
  // viewer can consciously see it, it is too strong.
  float vg = 1.0 - uVignette.x * pow( smoothstep( uVignette.y, uVignette.z, rn ), uVignetteCurve );
  g *= vg;

  // --- film grain ----------------------------------------------------------
  // Weighted away from the highlights by (1 - L)^0.5: real film grain is
  // finest in the highlights, and uniform grain over a 70%-white frame reads
  // as dirt on the lens. Triangular PDF, so it doubles as an 8-bit dither and
  // kills sky banding. Seeded from ctx.frame — deterministic, never random.
  float lg = dot( g, LUMA );
  float gw = sqrt( max( 1.0 - lg, 0.0 ) );
  float n1h = hash13( vec3( gl_FragCoord.xy, uSeed ) );
  float n2h = hash13( vec3( gl_FragCoord.yx + 17.31, uSeed + 3.77 ) );
  float n = n1h + n2h - 1.0;
  g += n * ( uGrain * gw + 0.0015 );

  gl_FragColor = vec4( clamp( g, 0.0, 1.0 ), 1.0 );
}
`;

/* ==========================================================================
 * Pass plumbing
 * ========================================================================== */

/**
 * A full-screen shader pass with explicit control over its destination.
 *
 * Unlike `ShaderPass` this can render into a fixed render target (bloom mips,
 * the AO buffer) without touching the composer's ping-pong, and it can blend
 * additively without the renderer's autoClear wiping the destination.
 *
 * All materials are created with `depthTest`/`depthWrite` off. That matters:
 * the scene target carries a depth texture that later passes read, and a
 * full-screen quad that writes depth would silently corrupt it.
 */
class FxPass extends Pass {
  constructor(fragmentShader, uniforms, opts = {}) {
    super();
    this.material = new THREE.ShaderMaterial({
      name: opts.name || 'FxPass',
      defines: Object.assign({}, opts.defines),
      uniforms,
      vertexShader: VERT,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NoBlending,
      transparent: !!opts.additive,
    });
    this.uniforms = uniforms;
    this._fsQuad = new FullScreenQuad(this.material);

    /** Fixed destination; null means "the composer's write buffer". */
    this.target = opts.target ?? null;
    this.needsSwap = this.target === null;
    this.additive = !!opts.additive;
    /** Uniform name that should receive the composer's read buffer, if any. */
    this.sourceUniform = opts.sourceUniform ?? null;
  }

  render(renderer, writeBuffer, readBuffer) {
    if (this.sourceUniform && this.uniforms[this.sourceUniform]) {
      this.uniforms[this.sourceUniform].value = readBuffer.texture;
    }

    const dst = this.target !== null ? this.target : this.renderToScreen ? null : writeBuffer;
    // autoClear stays off: the quad covers the whole target, so a clear is pure
    // wasted bandwidth for the opaque passes — and it would destroy the
    // accumulation the additive bloom upsample depends on.
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(dst);
    this._fsQuad.render(renderer);
    renderer.autoClear = oldAutoClear;
  }

  setDefine(name, on) {
    const has = this.material.defines[name] !== undefined;
    if (on === has) return false;
    if (on) this.material.defines[name] = '';
    else delete this.material.defines[name];
    this.material.needsUpdate = true;
    return true;
  }

  dispose() {
    this.material.dispose();
    this._fsQuad.dispose();
  }
}

/** `RenderPass` pinned to a specific render target (the HDR scene buffer). */
class SceneRenderPass extends RenderPass {
  constructor(scene, camera, target) {
    super(scene, camera);
    this.target = target;
    this.needsSwap = false;
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const wasToScreen = this.renderToScreen;
    this.renderToScreen = false;
    super.render(renderer, writeBuffer, this.target, deltaTime, maskActive);
    this.renderToScreen = wasToScreen;
  }
}

/* ==========================================================================
 * The system
 * ========================================================================== */

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _size = new THREE.Vector2();

export class PostProcessing {
  constructor(ctx) {
    this.ctx = ctx;
    this.tune = TUNE;
    this.enabled = true;

    const renderer = ctx.renderer;
    this.renderer = renderer;

    // --- quality ------------------------------------------------------------
    renderer.getDrawingBufferSize(_size);
    const w = Math.max(1, Math.floor(_size.x) || 1280);
    const h = Math.max(1, Math.floor(_size.y) || 720);
    this.width = w;
    this.height = h;

    this.software = detectSoftwareRaster(renderer);
    this.quality = this._resolveQuality();
    const q = QUALITY_TIERS[this.quality];
    this.tier = q;

    // --- feature flags (snapshot; re-evaluated every frame) ------------------
    const post = CONFIG.post || {};
    this.flags = {
      ao: !!post.ssao?.enabled,
      mb: !!post.motionBlur?.enabled,
      dof: !!post.dof?.enabled,
      bloom: !!post.bloom?.enabled,
      streak: (pick(post.bloom, 'streak', TUNE.bloom.streak) || 0) > 0,
    };

    // --- render targets ------------------------------------------------------
    const maxSamples = renderer.capabilities?.maxSamples ?? 0;
    this.samples = TUNE.msaa && CONFIG.render.antialias && maxSamples >= 2
      ? Math.min(4, maxSamples)
      : 0;

    this._createTargets(w, h);

    // --- composer ------------------------------------------------------------
    // The composer's own ping-pong buffers carry no depth attachment; the scene
    // depth lives on `sceneRT` alone, which is what every depth-reading pass
    // samples. That removes any dependency on buffer-swap parity.
    const ppRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    ppRT.texture.name = 'post.pingpong';

    const composer = new EffectComposer(renderer, ppRT);
    composer.setPixelRatio(1);
    this.composer = composer;

    this._buildPasses();

    // --- per-frame state -----------------------------------------------------
    this._prevViewProj = new THREE.Matrix4();
    this._reproj = new THREE.Matrix4();
    this._prevCamPos = new THREE.Vector3();
    this._prevCamQuat = new THREE.Quaternion();
    this._prevFov = ctx.camera.fov;
    this._focus = pick(CONFIG.post?.dof, 'focusDistance', 9);
    this._dofOff = !this.flags.dof;
    this._sunVis = 0;
    this._firstFrame = true;
    this._syncedFrame = -1;
    this._defineSig = '';

    // Snow transport tint (CONFIG.snow.sssColor) normalised to unit luminance so
    // it shifts hue in the AO without changing how much the AO darkens.
    const sss = CONFIG.snow?.sssColor ?? [0.62, 0.74, 0.95];
    const sssLum = 0.2126 * sss[0] + 0.7152 * sss[1] + 0.0722 * sss[2] || 1;
    this._aoTint = new THREE.Vector3(sss[0] / sssLum, sss[1] / sssLum, sss[2] / sssLum);

    this._sunTint = new THREE.Vector3(1, 0.92, 0.84);

    this._syncDefines(true);
    this._resizeUniforms();
  }

  /* ---------------------------------------------------------------- setup -- */

  _resolveQuality() {
    const forced = qs('postq');
    if (forced && QUALITY_TIERS[forced]) return forced;
    const cfg = pick(CONFIG.post, 'quality', TUNE.quality);
    if (cfg && cfg !== 'auto' && QUALITY_TIERS[cfg]) return cfg;
    if (!this.software) return 'high';
    // Software raster: keep the doc's 12-sample motion-blur floor at ordinary
    // capture sizes, and only drop below it on very large buffers.
    return this.width * this.height > 2.3e6 ? 'low' : 'medium';
  }

  /**
   * 24-bit depth, nearest filtered. `UnsignedIntType` + `DepthFormat` maps to
   * DEPTH_COMPONENT24, which is what three also uses for the multisampled
   * depth renderbuffer, so the MSAA resolve blit has matching formats.
   */
  _makeDepthTexture(w, h) {
    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    depth.generateMipmaps = false;
    depth.name = 'post.depth';
    return depth;
  }

  _createTargets(w, h) {
    const q = this.tier;

    const depth = this._makeDepthTexture(w, h);
    this.depthTexture = depth;

    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      depthTexture: depth,
      samples: this.samples,
    });
    this.sceneRT.texture.name = 'post.scene';

    // --- AO (half res) -------------------------------------------------------
    const aw = Math.max(1, Math.floor(w * q.aoScale));
    const ah = Math.max(1, Math.floor(h * q.aoScale));
    const aoOpts = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    this.aoRT = new THREE.WebGLRenderTarget(aw, ah, aoOpts);
    this.aoRT.texture.name = 'post.ao';
    this.aoBlurRT = new THREE.WebGLRenderTarget(aw, ah, aoOpts);
    this.aoBlurRT.texture.name = 'post.aoBlur';
    this.aoSize = new THREE.Vector2(aw, ah);

    // --- bloom pyramid -------------------------------------------------------
    this.bloomRT = [];
    this.bloomSize = [];
    let bw = Math.max(1, Math.floor(w / 2));
    let bh = Math.max(1, Math.floor(h / 2));
    for (let i = 0; i < q.bloomLevels; i++) {
      const rt = new THREE.WebGLRenderTarget(bw, bh, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      rt.texture.name = `post.bloom${i}`;
      rt.texture.wrapS = THREE.ClampToEdgeWrapping;
      rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      this.bloomRT.push(rt);
      this.bloomSize.push(new THREE.Vector2(bw, bh));
      bw = Math.max(1, Math.floor(bw / 2));
      bh = Math.max(1, Math.floor(bh / 2));
    }
  }

  _buildPasses() {
    const ctx = this.ctx;
    const q = this.tier;
    const composer = this.composer;

    // 1 — scene into the HDR target (linear, no tone mapping: three disables it
    //     automatically when the destination is a render target).
    this.scenePass = new SceneRenderPass(ctx.scene, ctx.camera, this.sceneRT);
    composer.addPass(this.scenePass);

    // 2 — ambient occlusion, half resolution, from depth only.
    this.aoPass = new FxPass(
      AO_FRAG,
      {
        tDepth: { value: this.depthTexture },
        uTexel: { value: new THREE.Vector2() },
        uTanHalf: { value: new THREE.Vector2() },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uRadius: { value: 0.6 },
        uIntensity: { value: 0.75 },
        uProjScale: { value: 500 },
        uMaxRadius: { value: TUNE.ssao.maxRadiusPx },
        uBias: { value: TUNE.ssao.bias },
        uAoScale: { value: q.aoScale },
        uFade: { value: new THREE.Vector2(TUNE.ssao.fadeStart, TUNE.ssao.fadeEnd) },
      },
      { name: 'post/ao', target: this.aoRT, defines: { AO_SAMPLES: q.aoSamples } },
    );
    composer.addPass(this.aoPass);

    // 3 — cross-bilateral AO blur.
    this.aoBlurPass = new FxPass(
      AO_BLUR_FRAG,
      {
        tAO: { value: this.aoRT.texture },
        uTexel: { value: new THREE.Vector2() },
        uSpread: { value: TUNE.ssao.blurSpread },
        uDepthSigma: { value: TUNE.ssao.depthSigma },
      },
      { name: 'post/aoBlur', target: this.aoBlurRT },
    );
    composer.addPass(this.aoBlurPass);

    // 4 — AO apply + fused motion blur / depth of field.
    this.sceneFxPass = new FxPass(
      SCENE_FX_FRAG,
      {
        tScene: { value: this.sceneRT.texture },
        tDepth: { value: this.depthTexture },
        tAO: { value: this.aoBlurRT.texture },
        uTexel: { value: new THREE.Vector2() },
        uRes: { value: new THREE.Vector2() },
        uTanHalf: { value: new THREE.Vector2() },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uAspect: { value: 1 },
        uAoTint: { value: new THREE.Vector3(1, 1, 1) },
        uAoSunRange: { value: new THREE.Vector2(TUNE.ssao.sunLumLo, TUNE.ssao.sunLumHi) },
        uAoSunSuppress: { value: TUNE.ssao.sunSuppress },
        uAoFloor: { value: TUNE.ssao.floor },
        uReproj: { value: new THREE.Matrix4() },
        uShutter: { value: 0.5 },
        uVelMaxPx: { value: TUNE.motionBlur.maxPixels },
        uSubjectUv: { value: new THREE.Vector2(0.5, 0.5) },
        uSubjectMask: {
          value: new THREE.Vector3(
            TUNE.motionBlur.subjectInner,
            TUNE.motionBlur.subjectOuter,
            TUNE.motionBlur.subjectFloor,
          ),
        },
        uMbFar: {
          value: new THREE.Vector2(
            TUNE.motionBlur.farFadeStart, TUNE.motionBlur.farFadeEnd,
          ),
        },
        uCocGain: { value: 0 },
        uFocus: { value: 9 },
        uMaxCoc: { value: 0.012 },
        uMaxCocFar: { value: TUNE.dof.farMaxBlur },
      },
      { name: 'post/sceneFx', defines: { FX_SAMPLES: q.fxSamples } },
    );
    composer.addPass(this.sceneFxPass);

    // 5 — bloom bright pass + pyramid.
    this.bloomBrightPass = new FxPass(
      BLOOM_BRIGHT_FRAG,
      {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uThreshold: { value: 0.75 },
        uKnee: { value: 0.45 },
        uClampMax: { value: TUNE.bloom.clampMax },
      },
      { name: 'post/bloomBright', target: this.bloomRT[0], sourceUniform: 'tDiffuse' },
    );
    composer.addPass(this.bloomBrightPass);

    this.bloomDownPasses = [];
    for (let i = 0; i < this.bloomRT.length - 1; i++) {
      const p = new FxPass(
        BLOOM_DOWN_FRAG,
        {
          tDiffuse: { value: this.bloomRT[i].texture },
          uTexel: { value: new THREE.Vector2() },
        },
        { name: `post/bloomDown${i}`, target: this.bloomRT[i + 1] },
      );
      this.bloomDownPasses.push(p);
      composer.addPass(p);
    }

    this.bloomUpPasses = [];
    for (let i = this.bloomRT.length - 2; i >= 0; i--) {
      const p = new FxPass(
        BLOOM_UP_FRAG,
        {
          tDiffuse: { value: this.bloomRT[i + 1].texture },
          uTexel: { value: new THREE.Vector2() },
          uWeight: { value: 0.75 },
        },
        { name: `post/bloomUp${i}`, target: this.bloomRT[i], additive: true },
      );
      this.bloomUpPasses.push(p);
      composer.addPass(p);
    }

    // 6 — bloom composite + veiling glare.
    this.bloomCompositePass = new FxPass(
      BLOOM_COMPOSITE_FRAG,
      {
        tDiffuse: { value: null },
        tBloom: { value: this.bloomRT[0].texture },
        tVeil: { value: this.bloomRT[this.bloomRT.length - 1].texture },
        uBloomTexel: { value: new THREE.Vector2() },
        uBloomStrength: { value: 0.3 },
        uVeilStrength: { value: 0.13 },
        uAspect: { value: 1 },
        uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
        uSunVis: { value: 0 },
        uSunTint: { value: new THREE.Vector3(1, 0.92, 0.84) },
        uGlare: {
          value: new THREE.Vector4(
            TUNE.glare.core, TUNE.glare.coreSigma, TUNE.glare.halo, TUNE.glare.haloSigma,
          ),
        },
        uStreak: { value: 0 },
        uStreakSpread: { value: TUNE.bloom.streakSpread },
      },
      { name: 'post/bloomComposite', sourceUniform: 'tDiffuse' },
    );
    composer.addPass(this.bloomCompositePass);

    // 7 — tone mapping + sRGB. THE ONLY place either happens.
    this.outputPass = new OutputPass();
    this.outputPass.material.depthTest = false;
    this.outputPass.material.depthWrite = false;
    composer.addPass(this.outputPass);

    // 8 — the LDR finish.
    const g = TUNE.grade;
    this.finishPass = new FxPass(
      FINISH_FRAG,
      {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uAspect: { value: 1 },
        uCornerR: { value: 1 },
        uCA: { value: 0.0018 },
        uCAInner: { value: TUNE.chromatic.innerRadius },
        uSharpen: { value: 0.32 },
        uSlope: { value: new THREE.Vector3().fromArray(g.slope) },
        uOffset: { value: new THREE.Vector3().fromArray(g.offset) },
        uPower: { value: new THREE.Vector3().fromArray(g.power) },
        uSaturation: { value: g.saturation },
        uShadowSat: { value: g.shadowSaturation },
        uHiDesat: { value: new THREE.Vector2(g.highlightDesat, g.highlightDesatKnee) },
        uRolloff: { value: new THREE.Vector2(g.rolloffKnee, g.rolloffCeiling) },
        uVignette: { value: new THREE.Vector3(0.34, TUNE.vignette.start, TUNE.vignette.end) },
        uVignetteCurve: { value: TUNE.vignette.curve },
        uGrain: { value: 0.022 },
        uSeed: { value: 0 },
      },
      { name: 'post/finish', sourceUniform: 'tDiffuse' },
    );
    composer.addPass(this.finishPass);
  }

  /* --------------------------------------------------------------- resize -- */

  resize(bufW, bufH) {
    const w = Math.max(1, Math.floor(bufW));
    const h = Math.max(1, Math.floor(bufH));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;

    this.composer.setPixelRatio(1);
    this.composer.setSize(w, h);

    // `RenderTarget.setSize` only resizes the colour attachments, and three
    // allocates depth textures with immutable `texStorage2D` so they cannot be
    // resized in place. setSize() disposes the target (which also disposes the
    // attached depth texture), so allocate a fresh one afterwards and repoint
    // every consumer at it.
    this.sceneRT.setSize(w, h);
    const depth = this._makeDepthTexture(w, h);
    this.sceneRT.depthTexture = depth;
    this.depthTexture = depth;
    this.aoPass.uniforms.tDepth.value = depth;
    this.sceneFxPass.uniforms.tDepth.value = depth;

    const q = this.tier;
    const aw = Math.max(1, Math.floor(w * q.aoScale));
    const ah = Math.max(1, Math.floor(h * q.aoScale));
    this.aoRT.setSize(aw, ah);
    this.aoBlurRT.setSize(aw, ah);
    this.aoSize.set(aw, ah);

    let bw = Math.max(1, Math.floor(w / 2));
    let bh = Math.max(1, Math.floor(h / 2));
    for (let i = 0; i < this.bloomRT.length; i++) {
      this.bloomRT[i].setSize(bw, bh);
      this.bloomSize[i].set(bw, bh);
      bw = Math.max(1, Math.floor(bw / 2));
      bh = Math.max(1, Math.floor(bh / 2));
    }

    this._resizeUniforms();
  }

  _resizeUniforms() {
    const w = this.width;
    const h = this.height;
    const aspect = w / Math.max(1, h);

    this.aoPass.uniforms.uTexel.value.set(1 / this.aoSize.x, 1 / this.aoSize.y);
    this.aoBlurPass.uniforms.uTexel.value.set(1 / this.aoSize.x, 1 / this.aoSize.y);

    this.sceneFxPass.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.sceneFxPass.uniforms.uRes.value.set(w, h);
    this.sceneFxPass.uniforms.uAspect.value = aspect;
    this.sceneFxPass.uniforms.uVelMaxPx.value = Math.min(
      TUNE.motionBlur.maxPixels, h * 0.06,
    );

    this.bloomBrightPass.uniforms.uTexel.value.set(1 / w, 1 / h);
    for (let i = 0; i < this.bloomDownPasses.length; i++) {
      const s = this.bloomSize[i];
      this.bloomDownPasses[i].uniforms.uTexel.value.set(1 / s.x, 1 / s.y);
    }
    for (let k = 0; k < this.bloomUpPasses.length; k++) {
      // bloomUpPasses[0] upsamples the coarsest level.
      const src = this.bloomRT.length - 1 - k;
      const s = this.bloomSize[src];
      this.bloomUpPasses[k].uniforms.uTexel.value.set(1 / s.x, 1 / s.y);
    }

    this.bloomCompositePass.uniforms.uBloomTexel.value.set(
      1 / this.bloomSize[0].x, 1 / this.bloomSize[0].y,
    );
    this.bloomCompositePass.uniforms.uAspect.value = aspect;

    this.finishPass.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.finishPass.uniforms.uAspect.value = aspect;
    this.finishPass.uniforms.uCornerR.value = Math.hypot(0.5 * aspect, 0.5);
  }

  /* -------------------------------------------------------------- defines -- */

  _syncDefines(force) {
    const post = CONFIG.post || {};
    const f = this.flags;
    f.ao = !!post.ssao?.enabled;
    f.mb = !!post.motionBlur?.enabled;
    f.dof = !!post.dof?.enabled;
    f.bloom = !!post.bloom?.enabled;
    f.streak = (pick(post.bloom, 'streak', TUNE.bloom.streak) || 0) > 0;

    const sig = `${f.ao}|${f.mb}|${f.dof}|${f.bloom}|${f.streak}`;
    if (!force && sig === this._defineSig) return;
    this._defineSig = sig;

    this.sceneFxPass.setDefine('USE_AO', f.ao);
    this.sceneFxPass.setDefine('USE_MB', f.mb);
    this.sceneFxPass.setDefine('USE_DOF', f.dof);
    this.bloomCompositePass.setDefine('USE_STREAK', f.streak);

    this.aoPass.enabled = f.ao;
    this.aoBlurPass.enabled = f.ao;
    this.bloomBrightPass.enabled = f.bloom;
    for (const p of this.bloomDownPasses) p.enabled = f.bloom;
    for (const p of this.bloomUpPasses) p.enabled = f.bloom;
    this.bloomCompositePass.enabled = f.bloom;
  }

  /* ---------------------------------------------------------- per frame --- */

  update(dt, ctx) {
    this.syncFrame(dt, ctx);
  }

  /** Idempotent within a frame, so an external `updatePost()` call is safe. */
  syncFrame(dt, ctx) {
    if (this._syncedFrame === ctx.frame && !this._firstFrame) return;
    this._syncedFrame = ctx.frame;

    const cam = ctx.camera;
    // The renderer normally refreshes these during render(); we need them now.
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

    this._syncDefines(false);

    const step = Math.max(1e-4, Math.min(dt || 1 / 60, 0.1));
    const cut = this._detectCut(cam, step);

    this._updateCameraUniforms(cam);
    this._updateAO();
    this._updateMotionBlur(ctx, cam, step, cut);
    this._updateDof(ctx, cam, step, cut);
    this._updateBloom(ctx, cam, step, cut);
    this._updateFinish(ctx);

    this._firstFrame = false;
  }

  /**
   * Camera cuts (shot presets, respawns, mode switches) must not produce a
   * screen-wide smear or a lens rack. Thresholds are generous relative to real
   * motion: at the 34 m/s terminal speed the chase camera travels 0.57 m per
   * 60 Hz frame and yaws well under a degree.
   */
  _detectCut(cam, dt) {
    if (this._firstFrame) return true;
    const posDelta = cam.position.distanceTo(this._prevCamPos);
    const dot = Math.abs(cam.quaternion.dot(this._prevCamQuat));
    const angDelta = 2 * Math.acos(Math.min(1, dot));
    const fovDelta = Math.abs(cam.fov - this._prevFov);
    return posDelta > Math.max(1.0, 80 * dt) || angDelta > 0.45 || fovDelta > 1.5;
  }

  _updateCameraUniforms(cam) {
    const tanY = Math.tan(cam.fov * DEG * 0.5);
    const tanX = tanY * cam.aspect;

    const ao = this.aoPass.uniforms;
    ao.uTanHalf.value.set(tanX, tanY);
    ao.uNear.value = cam.near;
    ao.uFar.value = cam.far;
    // Full-resolution pixels subtended by one metre at one metre distance.
    ao.uProjScale.value = (0.5 * this.height) / Math.max(tanY, 1e-6);

    const fx = this.sceneFxPass.uniforms;
    fx.uTanHalf.value.set(tanX, tanY);
    fx.uNear.value = cam.near;
    fx.uFar.value = cam.far;
  }

  _updateAO() {
    const cfg = CONFIG.post?.ssao || {};
    const u = this.aoPass.uniforms;
    u.uRadius.value = pick(cfg, 'radius', 0.6);
    u.uIntensity.value = pick(cfg, 'intensity', 0.75);
    u.uBias.value = pick(cfg, 'bias', TUNE.ssao.bias);
    u.uMaxRadius.value = pick(cfg, 'maxRadiusPx', TUNE.ssao.maxRadiusPx);
    u.uFade.value.set(
      pick(cfg, 'fadeStart', TUNE.ssao.fadeStart),
      pick(cfg, 'fadeEnd', TUNE.ssao.fadeEnd),
    );

    const invExposure = 1 / Math.max(0.05, this.renderer.toneMappingExposure);
    const fx = this.sceneFxPass.uniforms;
    fx.uAoTint.value.copy(this._aoTint);
    fx.uAoFloor.value = pick(cfg, 'floor', TUNE.ssao.floor);
    fx.uAoSunSuppress.value = pick(cfg, 'sunSuppress', TUNE.ssao.sunSuppress);
    fx.uAoSunRange.value.set(
      TUNE.ssao.sunLumLo * invExposure,
      TUNE.ssao.sunLumHi * invExposure,
    );
  }

  _updateMotionBlur(ctx, cam, dt, cut) {
    const cfg = CONFIG.post?.motionBlur || {};
    const fx = this.sceneFxPass.uniforms;

    // `strength` is read as the shutter fraction: 0.5 is the 180 degree film
    // standard, and the config's 0.55 is a touch over that. The reprojection
    // yields one *simulation step* of displacement, so the shutter is rescaled
    // to a fixed 1/120 s exposure (§7.3) and clamped so a long frame can only
    // ever shorten the smear, never paint a screen-long streak. At the capture
    // harness's fixed 1/60 step the scale is exactly 1.
    const expScale = Math.min(1, TUNE.motionBlur.refFrameTime / Math.max(dt, 1e-4));
    fx.uShutter.value = pick(cfg, 'strength', 0.55) * expScale;

    // Distance at which a surface stops being "world" and starts being "sky".
    fx.uMbFar.value.set(
      pick(cfg, 'farFadeStart', TUNE.motionBlur.farFadeStart),
      pick(cfg, 'farFadeEnd', TUNE.motionBlur.farFadeEnd),
    );

    if (cut) {
      // Zero velocity for this frame: current view space -> current clip space
      // would still be non-identity, so build the reprojection from the *current*
      // matrices, which maps every pixel onto itself.
      this._prevViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    }
    this._reproj.multiplyMatrices(this._prevViewProj, cam.matrixWorld);
    fx.uReproj.value.copy(this._reproj);

    // Subject (rider) screen position for the pan-protection mask.
    const st = ctx.physics?.state;
    let sx = 0.5;
    let sy = 0.5;
    if (st && st.position) {
      _v3a.copy(st.position);
      _v3a.y += 0.9;
      _v3b.copy(_v3a).project(cam);
      cam.getWorldDirection(_v3c);
      _v3a.sub(cam.position);
      if (_v3a.dot(_v3c) > 0) {
        sx = _v3b.x * 0.5 + 0.5;
        sy = _v3b.y * 0.5 + 0.5;
      }
    }
    fx.uSubjectUv.value.set(sx, sy);
    fx.uSubjectMask.value.set(
      TUNE.motionBlur.subjectInner,
      TUNE.motionBlur.subjectOuter,
      TUNE.motionBlur.subjectFloor,
    );
  }

  /**
   * Physically-derived depth of field.
   *
   * Focal length comes from the live vertical FOV against a full-frame sensor
   * height, so the chase camera's 62–82° is a 15–20 mm lens (deep, GoPro-like,
   * §7.2) while the 28–38° hero presets are 35–48 mm and open up naturally. No
   * mode flag is needed to make cinematic shots shallower — the optics do it.
   *
   * Auto-focus prefers the rider when the rider is on screen and near the view
   * axis, and otherwise falls back to whatever the centre of frame is looking
   * at (ray-marched against the terrain heightfield on the CPU). That keeps the
   * macro snow preset focused on the snow rather than on a rider 25 m away.
   */
  _updateDof(ctx, cam, dt, cut) {
    const cfg = CONFIG.post?.dof || {};
    const fx = this.sceneFxPass.uniforms;

    // Skipping the auto-focus rays while DoF is off is worth ~50 heightfield
    // probes a frame, but the focus must then snap rather than rack when it
    // comes back on.
    const wasOff = this._dofOff;
    this._dofOff = !this.flags.dof;
    if (this._dofOff) return;

    const cine = cam.fov <= TUNE.dof.cinematicFovDeg
      || ctx.player?.camera?.mode === 'cinematic'
      || ctx.player?.camera?.mode === 'orbit';

    const target = this._autoFocusDistance(ctx, cam);
    this._focus = (cut || wasOff)
      ? target
      : damp(this._focus, target, TUNE.dof.focusLambda, dt);

    const sensorH = TUNE.dof.sensorHeight;
    const f = (sensorH * 0.5) / Math.max(1e-4, Math.tan(cam.fov * DEG * 0.5));
    const aperture = clamp01(pick(cfg, 'aperture', 0.9) * (cine ? 1.15 : 1.0));
    const N = lerp(TUNE.dof.fNumberDeep, TUNE.dof.fNumberOpen, aperture);
    const A = f / N;
    const S = Math.max(this._focus, f * 1.6);

    // Hyperfocal gate. Beyond ~40 m of focus these lenses are, for all
    // practical purposes, focused at infinity and the near field is *sharp*;
    // letting the thin-lens term keep running softens the foreground of every
    // wide shot and inverts the depth cue (items 17, 51). Landscape framing
    // therefore renders hyperfocal, and the shallow behaviour survives exactly
    // where §7.2 wants it — the close/rider/cinematic presets, which focus a
    // few metres out and never reach the gate.
    const hyper = 1 - smoothstep(TUNE.dof.hyperfocalNear, TUNE.dof.hyperfocalFar, S);

    fx.uCocGain.value = ((A * f) / (sensorH * (S - f))) * hyper;
    fx.uFocus.value = S;
    fx.uMaxCoc.value = cine
      ? pick(cfg, 'cinematicMaxBlur', TUNE.dof.cinematicMaxBlur)
      : pick(cfg, 'maxBlur', 0.012);
    // The far side of focus has its own, far tighter ceiling — see
    // TUNE.dof.farMaxBlur. This is what keeps the ridge line and the backdrop
    // skyline sharp (checklist 51) no matter how open the lens gets.
    fx.uMaxCocFar.value = cine
      ? pick(cfg, 'cinematicFarMaxBlur', TUNE.dof.cinematicFarMaxBlur)
      : pick(cfg, 'farMaxBlur', TUNE.dof.farMaxBlur);
  }

  _autoFocusDistance(ctx, cam) {
    const st = ctx.physics?.state;
    cam.getWorldDirection(_v3c);

    let riderDist = null;
    if (st && st.position) {
      _v3a.copy(st.position);
      _v3a.y += 0.9;
      _v3b.copy(_v3a).sub(cam.position);
      const d = _v3b.length();
      if (d > 1e-3) {
        const axial = _v3b.dot(_v3c) / d;
        // Within ~40° of the view axis and close enough to be the subject.
        if (axial > 0.76 && d < 90) riderDist = d;
      }
    }

    const groundDist = this._raymarchTerrain(ctx, cam.position, _v3c, TUNE.dof.focusRayMax);

    if (riderDist !== null) {
      // Anything markedly closer than the rider and dead centre (a near bank in
      // a macro shot) wins; otherwise the rider is the subject.
      if (groundDist !== null && groundDist < riderDist * 0.45) return groundDist;
      return riderDist;
    }
    // No rider and no ground within the ray budget: the frame is a landscape or
    // a sky shot, and a landscape focuses at infinity. Falling back to
    // `CONFIG.post.dof.focusDistance` (9 m, the chase-camera default) would put
    // the entire mountain behind the focal plane.
    return groundDist ?? TUNE.dof.infinityFocus;
  }

  /** March the terrain heightfield; returns distance to the hit or null. */
  _raymarchTerrain(ctx, origin, dir, maxDist) {
    const terrain = ctx.terrain;
    if (!terrain || typeof terrain.getHeight !== 'function') return null;
    const b = terrain.bounds;

    // Camera momentarily inside the slope (a hard landing, a clipping chase
    // spring): a "hit at 0.5 m" would rack the whole frame out of focus.
    const h0 = terrain.getHeight(origin.x, origin.z);
    if (Number.isFinite(h0) && origin.y <= h0) return null;

    let t = 0.5;
    let prevT = 0;
    for (let i = 0; i < TUNE.dof.focusRaySteps; i++) {
      _v3a.copy(origin).addScaledVector(dir, t);
      if (b && (_v3a.x < b.minX || _v3a.x > b.maxX || _v3a.z < b.minZ || _v3a.z > b.maxZ)) {
        return null;
      }
      const h = terrain.getHeight(_v3a.x, _v3a.z);
      if (!Number.isFinite(h)) return null;
      if (_v3a.y <= h) {
        // Bisect for a stable, non-quantised focus distance.
        let lo = prevT;
        let hi = t;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) * 0.5;
          _v3a.copy(origin).addScaledVector(dir, mid);
          const hm = terrain.getHeight(_v3a.x, _v3a.z);
          if (Number.isFinite(hm) && _v3a.y <= hm) hi = mid;
          else lo = mid;
        }
        return (lo + hi) * 0.5;
      }
      prevT = t;
      t = t * 1.14 + 0.6;
      if (t > maxDist) return null;
    }
    return null;
  }

  /**
   * Radiance of sunlit, Lambertian snow, in the same linear scene-referred
   * units the composer's buffers hold (i.e. *before* the tone mapper's exposure
   * multiply). This is the scene's diffuse-white reference: any threshold that
   * means "brighter than snow" must be a multiple of it, never a constant.
   *
   *   L = albedo · ( E_beam · N·L + E_sky ) / π
   *
   * `sky.js` publishes `irradiance.direct` (the beam at normal incidence) and
   * `irradiance.horizontal` (that beam projected onto the horizontal, plus the
   * sky's own hemispherical irradiance), so the sky term recovers as
   * `horizontal − direct · sinAlt` and the beam can then be re-projected onto a
   * slope that actually faces the sun — which is what "sunlit snow" means at a
   * 10.5° sun. Everything tracks time of day and weather automatically.
   *
   * @returns {number} linear radiance, or 0 when the sky has not published yet.
   */
  _diffuseWhite(ctx) {
    const ir = ctx.sky?.irradiance;
    if (!ir || !Number.isFinite(ir.horizontal) || ir.horizontal <= 0) return 0;

    const albedo = CONFIG.snow?.albedo ?? 0.86;
    const beam = Math.max(0, ir.direct || 0);
    const sinAlt = clamp01(ctx.sky?.sunDirection?.y ?? 0);
    // Diffuse sky + snowfield bounce on the horizontal, beam removed.
    const skyE = Math.max(0, ir.horizontal - beam * sinAlt);
    // The beam on a slope tilted `sunlitSlopeDeg` into it.
    const nDotL = clamp01(
      Math.sin(Math.asin(sinAlt) + TUNE.bloom.sunlitSlopeDeg * DEG),
    );
    return (albedo * (beam * nDotL + skyE)) / Math.PI;
  }

  _updateBloom(ctx, cam, dt, cut) {
    if (!this.flags.bloom) {
      this._sunVis = 0;
      return; // every bloom pass is disabled; skip the sun ray-march too
    }
    const cfg = CONFIG.post?.bloom || {};
    const u = this.bloomCompositePass.uniforms;
    const invExposure = 1 / Math.max(0.05, this.renderer.toneMappingExposure);

    // The bright-pass knee, anchored to the physical diffuse-white radiance of
    // sunlit snow rather than to a constant — see TUNE.bloom.whiteScale. The
    // CONFIG value is kept meaningful as a *relative* trim around its documented
    // default, and the legacy absolute value survives as a floor so a night or
    // whiteout frame (E_horizontal → 0) can never drop the knee onto the scene.
    const cfgThreshold = pick(cfg, 'threshold', 0.86);
    const legacy = cfgThreshold * TUNE.bloom.veilThresholdScale * invExposure;
    const white = this._diffuseWhite(ctx);
    const threshold = white > 0
      ? Math.max(
        white * TUNE.bloom.whiteScale * (cfgThreshold / TUNE.bloom.whiteReference),
        legacy,
      )
      : legacy;
    const strength = pick(cfg, 'strength', 0.42);
    const radius = clamp01(pick(cfg, 'radius', 0.55));
    const budget = strength / 0.42;

    const bu = this.bloomBrightPass.uniforms;
    bu.uThreshold.value = threshold;
    bu.uKnee.value = threshold * TUNE.bloom.softKnee;
    bu.uClampMax.value = TUNE.bloom.clampMax * invExposure;

    // Wider `radius` pushes more energy into the coarse mips, which is what
    // turns a tight halo into a soft veil.
    const upWeight = lerp(TUNE.bloom.upWeightMin, TUNE.bloom.upWeightMax, radius);
    for (const p of this.bloomUpPasses) p.uniforms.uWeight.value = upWeight;

    u.uBloomStrength.value = TUNE.bloom.coreSplit * budget;
    u.uVeilStrength.value = TUNE.bloom.veilSplit * budget;
    u.uStreak.value = pick(cfg, 'streak', TUNE.bloom.streak) * budget;
    u.uStreakSpread.value = pick(cfg, 'streakSpread', TUNE.bloom.streakSpread);

    // --- the sun ------------------------------------------------------------
    const sun = ctx.sky?.sunDirection;
    let vis = 0;
    let ux = 0.5;
    let uy = 0.5;

    if (sun && sun.y > 0.005) {
      cam.getWorldDirection(_v3c);
      if (_v3c.dot(sun) > 0.02) {
        _v3a.copy(cam.position).addScaledVector(sun, 1000);
        _v3b.copy(_v3a).project(cam);
        ux = _v3b.x * 0.5 + 0.5;
        uy = _v3b.y * 0.5 + 0.5;
        // Glare is still real when the sun is just outside the frame.
        if (ux > -1.2 && ux < 2.2 && uy > -1.2 && uy < 2.2) {
          vis = this._sunOcclusion(ctx, cam, sun);
        }
      }
    }

    this._sunVis = cut ? vis : damp(this._sunVis, vis, 8, dt);
    u.uSunUv.value.set(ux, uy);
    u.uSunVis.value = this._sunVis;

    const sc = ctx.sky?.sunColor;
    if (sc) {
      // Normalise so the glare's brightness is set by the gains, not by whatever
      // absolute intensity the sky system is running at, and desaturate slightly
      // toward white the way a real veiling glare does.
      const m = Math.max(sc.r, sc.g, sc.b) || 1;
      this._sunTint.set(
        lerp(sc.r / m, 1, 0.25), lerp(sc.g / m, 1, 0.25), lerp(sc.b / m, 1, 0.25),
      );
    }
    u.uSunTint.value.copy(this._sunTint);
    u.uGlare.value.set(
      TUNE.glare.core * budget * invExposure,
      TUNE.glare.coreSigma,
      TUNE.glare.halo * budget * invExposure,
      TUNE.glare.haloSigma,
    );
  }

  /**
   * CPU sun-occlusion test: march from the camera toward the sun and track the
   * smallest clearance above the terrain. Cheap (≈28 heightfield probes),
   * deterministic, and it correctly kills the glare when the sun is behind the
   * headwall — which at 10.6° elevation happens constantly.
   */
  _sunOcclusion(ctx, cam, sun) {
    const terrain = ctx.terrain;
    if (!terrain || typeof terrain.getHeight !== 'function') return 1;
    const b = terrain.bounds;

    let minClear = 1e9;
    let t = 2.0;
    for (let i = 0; i < TUNE.glare.marchSteps; i++) {
      _v3a.copy(cam.position).addScaledVector(sun, t);
      if (b && (_v3a.x < b.minX || _v3a.x > b.maxX || _v3a.z < b.minZ || _v3a.z > b.maxZ)) break;
      const h = terrain.getHeight(_v3a.x, _v3a.z);
      if (Number.isFinite(h)) {
        const clear = _v3a.y - h;
        if (clear < minClear) minClear = clear;
        if (minClear < -12) return 0;
      }
      t = t * 1.28 + 1.5;
    }
    if (minClear > 1e8) return 1;
    return clamp01(smoothstep(-1.0, 4.0, minClear));
  }

  _updateFinish(ctx) {
    const post = CONFIG.post || {};
    const u = this.finishPass.uniforms;
    const g = TUNE.grade;

    const caOn = post.chromatic?.enabled !== false;
    u.uCA.value = caOn ? pick(post.chromatic, 'strength', 0.0018) : 0;

    const shOn = post.sharpen?.enabled !== false;
    u.uSharpen.value = shOn ? pick(post.sharpen, 'strength', 0.32) : 0;

    const vgOn = post.vignette?.enabled !== false;
    u.uVignette.value.set(
      vgOn ? clamp(pick(post.vignette, 'strength', 0.34), 0, 0.4) : 0,
      TUNE.vignette.start,
      TUNE.vignette.end,
    );
    u.uVignetteCurve.value = TUNE.vignette.curve;

    const grOn = post.grain?.enabled !== false;
    u.uGrain.value = grOn ? clamp(pick(post.grain, 'strength', 0.022), 0, 0.03) : 0;

    // Deterministic per-frame grain seed. hash32 gives a well-distributed value
    // from the integer frame counter; the modulo keeps it in a range where a
    // 32-bit float still resolves every distinct seed exactly.
    u.uSeed.value = (hash32(ctx.frame | 0) % 65536) / 64.0;

    u.uSlope.value.fromArray(g.slope);
    u.uOffset.value.fromArray(g.offset);
    u.uPower.value.fromArray(g.power);
    u.uSaturation.value = g.saturation;
    u.uShadowSat.value = g.shadowSaturation;
    u.uHiDesat.value.set(g.highlightDesat, g.highlightDesatKnee);
    u.uRolloff.value.set(g.rolloffKnee, g.rolloffCeiling);
  }

  /** History capture — runs after the frame has been rendered. */
  postRender(dt, ctx) {
    const cam = ctx.camera;
    this._prevViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._prevCamPos.copy(cam.position);
    this._prevCamQuat.copy(cam.quaternion);
    this._prevFov = cam.fov;
  }

  /* -------------------------------------------------------------- teardown - */

  dispose() {
    this.composer.passes.forEach((p) => p.dispose?.());
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.sceneRT.dispose(); // also disposes the attached depth texture
    this.aoRT.dispose();
    this.aoBlurRT.dispose();
    for (const rt of this.bloomRT) rt.dispose();
    if (this.ctx.composer === this.composer) this.ctx.composer = null;
    if (this.ctx.post === this) this.ctx.post = null;
  }

  /** Diagnostics for the capture harness / debug HUD. */
  info() {
    return {
      quality: this.quality,
      software: this.software,
      samples: this.samples,
      size: [this.width, this.height],
      bloomLevels: this.bloomRT.length,
      fxSamples: this.tier.fxSamples,
      aoSamples: this.tier.aoSamples,
      passes: this.composer.passes.filter((p) => p.enabled).length,
      flags: { ...this.flags },
      focus: this._focus,
      cocGain: this.sceneFxPass.uniforms.uCocGain.value,
      // Near/far CoC ceilings as a fraction of frame height, and the far-field
      // CoC in pixels at the current buffer height — the number checklist item
      // 51 is really about. It must stay around a pixel.
      maxCoc: this.sceneFxPass.uniforms.uMaxCoc.value,
      maxCocFar: this.sceneFxPass.uniforms.uMaxCocFar.value,
      farCocPx: Math.min(
        this.sceneFxPass.uniforms.uCocGain.value,
        this.sceneFxPass.uniforms.uMaxCocFar.value,
      ) * this.height,
      sunVisibility: this._sunVis,
      // Both in linear scene-referred units: the sunlit-snow reference and the
      // bright-pass knee derived from it. The knee must stay above the first.
      diffuseWhite: this._diffuseWhite(this.ctx),
      bloomThreshold: this.bloomBrightPass.uniforms.uThreshold.value,
    };
  }
}

/* ==========================================================================
 * Module interface (see docs/ARCHITECTURE.md)
 * ========================================================================== */

/**
 * Build the post chain, publish it on `ctx.composer`, and register a system so
 * per-frame uniforms are refreshed after the camera has settled but before the
 * engine renders.
 *
 * Returns `null` (and leaves `ctx.composer` null, so the engine renders the
 * scene directly) when post is switched off with `?nopost` / `?post=off`, or if
 * anything about composer construction fails — a broken film layer must never
 * take the game down with it.
 *
 * @param {object} ctx shared engine context
 * @returns {?EffectComposer}
 */
export function createComposer(ctx) {
  const off = hasQs('nopost') || qs('post') === 'off' || CONFIG.post?.enabled === false;
  if (off) {
    ctx.composer = null;
    ctx.post = null;
    return null;
  }

  try {
    const system = new PostProcessing(ctx);
    ctx.post = system;
    ctx.composer = system.composer;
    // Registered last so it sees the final camera pose for this frame, and so
    // its postRender() captures history after everything else has run.
    ctx.engine.systems.push(system);
    // Prime the uniforms so the very first rendered frame is already correct.
    system.syncFrame(1 / 60, ctx);
    return system.composer;
  } catch (err) {
    console.error('[soho/post] composer construction failed, falling back to direct render', err);
    ctx.composer = null;
    ctx.post = null;
    return null;
  }
}

/**
 * Refresh per-frame post uniforms (sun screen position and visibility, focus
 * distance, camera reprojection, grain seed).
 *
 * `createComposer` already registers a system that calls this, so the engine
 * drives it automatically; the export exists because `ARCHITECTURE.md` specifies
 * it and because the capture harness may want to force a refresh after posing
 * the camera by hand. It is idempotent within a frame.
 *
 * @param {number} dt seconds since the previous frame
 * @param {object} ctx shared engine context
 */
export function updatePost(dt, ctx) {
  const system = ctx?.post;
  if (!system || !system.enabled) return;
  system.syncFrame(dt, ctx);
}

export default createComposer;
