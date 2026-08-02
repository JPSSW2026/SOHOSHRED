/**
 * Audio.
 *
 * Fully synthesised through WebAudio — there is not a single sample file in
 * this project, and there is not going to be one. Everything you hear is
 * generated from noise buffers and oscillators shaped by filters whose cutoff
 * and gain are driven directly by the physics state.
 *
 * That is not a limitation here, it is the right approach, because the sound a
 * snowboard makes is *continuous* and *parametric*. A board on snow is
 * essentially filtered noise: the pitch and brightness of the hiss track edge
 * angle, speed and how hard the snow is, and they track them smoothly. Sample
 * playback fights that — you end up crossfading loops and hearing the seams.
 * A filtered noise bed driven by the same numbers the physics already computes
 * gives you the whole continuum for free, and it is inherently in sync because
 * it *is* the simulation.
 *
 * The voices:
 *   · EDGE — the carve hiss. Bandpassed noise; centre frequency rises with
 *     speed, Q rises with edge engagement (a committed carve is a narrower,
 *     more tonal sound than a skid), gain scales with edge load.
 *   · BASE — the low rumble of the running surface over the snowpack, cut off
 *     low and driven mostly by speed.
 *   · WIND — broadband noise through a gentle low-pass, gain rising with speed
 *     and with air time; this is what makes a jump feel fast.
 *   · CHATTER — amplitude modulation applied to the edge voice on hard
 *     surfaces, because on ice a board does not hiss, it rattles.
 *   · Transients — pop, landing thump, crash — as short filtered bursts.
 *
 * Everything is gated behind a user gesture, because browsers will not start
 * an AudioContext without one, and the whole system degrades to a no-op when
 * there is no audio device at all — which is the case in the headless capture
 * harness, where this must never throw and never block a frame.
 */

import { CONFIG } from '../core/config.js';
import { clamp, clamp01, lerp, smoothstep } from '../core/rng.js';

/** Seconds of noise in the looping buffer. Long enough to not hear the loop. */
const NOISE_SECONDS = 3;

/** Per-surface voicing. Snow is dark and soft; ice is bright and hard. */
const SURFACE_TONE = {
  //          centre Hz   Q     gain   chatter
  powder:    { hz: 620,  q: 0.7, g: 0.55, chat: 0.00 },
  windpack:  { hz: 1500, q: 1.4, g: 0.80, chat: 0.10 },
  sastrugi:  { hz: 1900, q: 1.8, g: 0.95, chat: 0.45 },
  crust:     { hz: 2600, q: 2.6, g: 0.90, chat: 0.55 },
  ice:       { hz: 3800, q: 4.2, g: 1.00, chat: 0.85 },
  groomed:   { hz: 1750, q: 2.0, g: 0.85, chat: 0.05 },
  slush:     { hz: 900,  q: 0.9, g: 0.70, chat: 0.00 },
  rock:      { hz: 2400, q: 1.2, g: 1.00, chat: 0.95 },
  scree:     { hz: 2100, q: 1.0, g: 1.00, chat: 0.90 },
  tussock:   { hz: 1100, q: 0.8, g: 0.60, chat: 0.30 },
};
const DEFAULT_TONE = SURFACE_TONE.powder;

export class AudioSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.muted = false;
    this.ready = false;
    this.ac = null;
    this._volume = 0.8;
    this._edgeGain = 0;
    this._baseGain = 0;
    this._windGain = 0;
    this._lastGrounded = true;
  }

  async build() {
    if (typeof window === 'undefined') return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    try {
      this.ac = new AC({ latencyHint: 'interactive' });
    } catch {
      // No audio device — headless capture, or a locked-down environment.
      // Every method below tolerates this.
      this.ac = null;
      return;
    }

    const ac = this.ac;

    // ---- Master ------------------------------------------------------
    this.master = ac.createGain();
    this.master.gain.value = 0;           // faded in once running
    // A gentle limiter so a landing transient on top of a full-tilt carve
    // cannot clip the bus.
    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.18;
    this.master.connect(this.limiter).connect(ac.destination);

    // ---- Noise source ------------------------------------------------
    // One looping buffer feeds every continuous voice. Uncorrelated playback
    // rates keep them from phasing against each other.
    const len = Math.floor(ac.sampleRate * NOISE_SECONDS);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    // Deterministic white noise — a tiny LCG rather than Math.random, to keep
    // the project's no-Math.random rule intact even where it cannot be seen.
    let seed = 0x9e3779b9;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      d[i] = (seed / 0xffffffff) * 2 - 1;
    }
    this.noiseBuffer = buf;

    // ---- EDGE voice ---------------------------------------------------
    this.edgeSrc = ac.createBufferSource();
    this.edgeSrc.buffer = buf;
    this.edgeSrc.loop = true;
    this.edgeFilter = ac.createBiquadFilter();
    this.edgeFilter.type = 'bandpass';
    this.edgeFilter.frequency.value = 900;
    this.edgeFilter.Q.value = 1;
    this.edgeAmp = ac.createGain();
    this.edgeAmp.gain.value = 0;
    // Chatter: a gain modulated by a fast oscillator, mixed in on hard snow.
    this.chatterOsc = ac.createOscillator();
    this.chatterOsc.type = 'square';
    this.chatterOsc.frequency.value = 38;
    this.chatterDepth = ac.createGain();
    this.chatterDepth.gain.value = 0;
    this.chatterOsc.connect(this.chatterDepth).connect(this.edgeAmp.gain);
    this.edgeSrc.connect(this.edgeFilter).connect(this.edgeAmp).connect(this.master);

    // ---- BASE voice ---------------------------------------------------
    this.baseSrc = ac.createBufferSource();
    this.baseSrc.buffer = buf;
    this.baseSrc.loop = true;
    this.baseSrc.playbackRate.value = 0.83;   // decorrelate from the edge voice
    this.baseFilter = ac.createBiquadFilter();
    this.baseFilter.type = 'lowpass';
    this.baseFilter.frequency.value = 240;
    this.baseFilter.Q.value = 0.7;
    this.baseAmp = ac.createGain();
    this.baseAmp.gain.value = 0;
    this.baseSrc.connect(this.baseFilter).connect(this.baseAmp).connect(this.master);

    // ---- WIND voice ----------------------------------------------------
    this.windSrc = ac.createBufferSource();
    this.windSrc.buffer = buf;
    this.windSrc.loop = true;
    this.windSrc.playbackRate.value = 1.19;
    this.windFilter = ac.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 700;
    this.windAmp = ac.createGain();
    this.windAmp.gain.value = 0;
    this.windSrc.connect(this.windFilter).connect(this.windAmp).connect(this.master);

    this.edgeSrc.start();
    this.baseSrc.start();
    this.windSrc.start();
    this.chatterOsc.start();

    this.ready = true;

    // Browsers refuse to run an AudioContext until the user has interacted.
    // Resume on the first gesture of any kind, then stop listening.
    if (ac.state === 'suspended') {
      const resume = () => {
        ac.resume().catch(() => {});
        for (const e of ['pointerdown', 'keydown', 'touchstart']) {
          window.removeEventListener(e, resume);
        }
      };
      for (const e of ['pointerdown', 'keydown', 'touchstart']) {
        window.addEventListener(e, resume, { once: false });
      }
      this._resumeHandler = resume;
    }
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.master && this.ac) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this._volume, this.ac.currentTime, 0.05);
    }
  }

  setVolume(v) {
    this._volume = clamp01(v);
    if (!this.muted) this.setMuted(false);
  }

  update(dt, ctx) {
    if (!this.ready || !this.ac || this.ac.state !== 'running') return;
    const s = ctx.physics?.state;
    if (!s) return;

    const ac = this.ac;
    const t = ac.currentTime;
    // setTargetAtTime rather than direct assignment: stepping a gain or a
    // filter cutoff once per frame produces audible zipper noise, and at 60 Hz
    // that lands right in the ear's most sensitive band.
    const glide = 0.045;

    const tone = SURFACE_TONE[s.surface] || DEFAULT_TONE;
    const speedT = smoothstep(0.5, 26, s.speed);
    const edgeLoad = clamp01(s.edgeLoad || 0);
    const slip = clamp01(Math.abs(s.lateralSpeed || 0) / 6);
    const grounded = s.grounded && !s.crashed;

    // ---- EDGE ---------------------------------------------------------
    // A carve and a skid are different sounds, not the same sound at
    // different volumes: the carve is narrow and tonal (high Q), the skid is
    // broadband. Blending Q between them across the slip axis is what makes a
    // turn washing out audible before it is visible.
    const edgeTarget = grounded
      ? (0.05 + 0.95 * Math.max(edgeLoad, slip * 0.8)) * tone.g * speedT * 0.30
      : 0;
    this.edgeAmp.gain.setTargetAtTime(edgeTarget, t, glide);
    this.edgeFilter.frequency.setTargetAtTime(
      tone.hz * lerp(0.65, 1.35, speedT), t, glide,
    );
    this.edgeFilter.Q.setTargetAtTime(
      lerp(tone.q * 2.2, tone.q * 0.55, slip), t, glide,
    );
    // Chatter rate rises with speed — it is the edge skipping over ridges.
    this.chatterDepth.gain.setTargetAtTime(
      grounded ? tone.chat * edgeTarget * 0.85 : 0, t, glide,
    );
    this.chatterOsc.frequency.setTargetAtTime(24 + s.speed * 3.4, t, glide);

    // ---- BASE ---------------------------------------------------------
    const sink = clamp01((s.sinkDepth || 0) / Math.max(CONFIG.physics.powderDepth, 1e-3));
    const baseTarget = grounded ? (0.10 + 0.35 * sink) * speedT * 0.55 : 0;
    this.baseAmp.gain.setTargetAtTime(baseTarget, t, glide);
    this.baseFilter.frequency.setTargetAtTime(150 + 260 * speedT, t, glide);

    // ---- WIND ----------------------------------------------------------
    // Rises with speed and jumps in the air, where there is nothing else.
    const airT = grounded ? 0 : clamp01(0.4 + (s.airTime || 0));
    const windTarget = (0.06 + 0.34 * speedT + 0.22 * airT) * 0.5;
    this.windAmp.gain.setTargetAtTime(windTarget, t, glide);
    this.windFilter.frequency.setTargetAtTime(400 + 1500 * speedT, t, glide);

    // ---- Transients ----------------------------------------------------
    if (s.popped) this._burst(1400, 0.06, 0.30, 'highpass');
    if (s.landingImpact > 0.5) {
      const i = clamp01(s.landingImpact / 14);
      this._burst(180 + 900 * i, 0.16 + 0.12 * i, 0.28 + 0.5 * i, 'lowpass');
      this._thump(52 + 26 * i, 0.22, 0.3 + 0.5 * i);
    }
    if (s.crashed && this._lastGrounded && !grounded) this._burst(700, 0.5, 0.7, 'lowpass');
    this._lastGrounded = grounded;

    // Fade the bus in once, on the first running frame.
    if (this.master.gain.value < 0.001 && !this.muted) {
      this.master.gain.setTargetAtTime(this._volume, t, 0.4);
    }
  }

  /** A filtered noise burst — impacts, pops, crashes. */
  _burst(hz, dur, amp, filterType = 'lowpass') {
    const ac = this.ac;
    if (!ac) return;
    const t = ac.currentTime;
    const src = ac.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    // Start at a varying offset so repeated impacts are not identical.
    src.playbackRate.value = 0.8 + (hz % 97) / 240;

    const f = ac.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = hz;
    f.Q.value = 0.9;

    const g = ac.createGain();
    // Percussive envelope: near-instant attack, exponential decay. Exponential
    // rather than linear because that is how real impacts decay and a linear
    // tail sounds synthetic.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(amp, 0.0002), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(f).connect(g).connect(this.master);
    src.start(t, (t * 7.3) % (NOISE_SECONDS - 0.5));
    src.stop(t + dur + 0.05);
  }

  /** A low sine thump — the body of a landing. */
  _thump(hz, dur, amp) {
    const ac = this.ac;
    if (!ac) return;
    const t = ac.currentTime;
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(hz * 1.6, t);
    // Pitch drop is what makes a thump read as mass rather than as a beep.
    o.frequency.exponentialRampToValueAtTime(hz * 0.7, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(amp, 0.0002), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Called by tricks.js when a trick lands. */
  playTrick(scored, quality) {
    if (!this.ready || !this.ac || this.ac.state !== 'running') return;
    if (quality === 'crash') { this._burst(420, 0.45, 0.55, 'lowpass'); return; }
    // A short two-note figure, rising with how good the landing was. Kept
    // quiet and brief — a call-out should acknowledge the trick, not applaud.
    const ac = this.ac;
    const t = ac.currentTime;
    const root = quality === 'perfect' ? 660 : 550;
    for (let i = 0; i < 2; i++) {
      const o = ac.createOscillator();
      o.type = 'triangle';
      o.frequency.value = root * (i === 0 ? 1 : 1.5);
      const g = ac.createGain();
      const at = t + i * 0.09;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.12, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      o.connect(g).connect(this.master);
      o.start(at);
      o.stop(at + 0.26);
    }
  }

  dispose() {
    if (this._resumeHandler && typeof window !== 'undefined') {
      for (const e of ['pointerdown', 'keydown', 'touchstart']) {
        window.removeEventListener(e, this._resumeHandler);
      }
    }
    try {
      this.edgeSrc?.stop();
      this.baseSrc?.stop();
      this.windSrc?.stop();
      this.chatterOsc?.stop();
      this.ac?.close();
    } catch {
      // Already torn down; nothing to do.
    }
    this.ready = false;
  }
}
