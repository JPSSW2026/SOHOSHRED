/**
 * Trick recognition and scoring.
 *
 * The system watches the physics state and *names* what the rider did — it
 * never drives them. A trick is not a canned move you trigger; it is an
 * observation about how much rotation happened between leaving the snow and
 * touching it again, which way it went, what the hands were doing, and
 * whether the landing held.
 *
 * Naming rules follow the sport:
 *   · Spin is counted in 180° units and quoted at the nearest completed one.
 *     A 400° rotation is a 360, not a "400" and not a 540 — you get credit for
 *     what you landed.
 *   · Direction is frontside or backside, decided by the sign of the rotation
 *     relative to the rider's stance. A regular rider spinning clockwise from
 *     above is going backside.
 *   · Riding away in the opposite stance makes it a switch landing, worth
 *     more, and a spin *started* switch is worth more again.
 *   · Grabs multiply. Holding one longer multiplies more, up to a cap —
 *     tapping a grab at the apex should not score like a poked-out method.
 *
 * Scoring is deliberately legible: base points for rotation, multiplied by
 * grab quality, air time and landing cleanliness, then a combo multiplier for
 * linking without touching a rail or blowing a landing. Nothing random.
 */

import { clamp, clamp01, lerp, smoothstep } from '../core/rng.js';

const DEG = 180 / Math.PI;

/** Rotation names, in half-turns. */
const SPIN_NAMES = {
  1: '180', 2: '360', 3: '540', 4: '720', 5: '900', 6: '1080', 7: '1260', 8: '1440',
};

/** Base points per completed half-turn — rotation scores superlinearly. */
const SPIN_BASE = [0, 100, 250, 480, 800, 1250, 1800, 2500, 3400];

/** Base points per completed flip — a single back is worth about a 540. */
const FLIP_BASE = [0, 460, 1500, 3100];
const FLIP_NAMES = ['', '', 'Double ', 'Triple '];

/** Pretty names for grabs. */
const GRAB_NAMES = {
  indy: 'Indy', mute: 'Mute', melon: 'Melon', stalefish: 'Stalefish',
  nose: 'Nosegrab', tail: 'Tailgrab', method: 'Method',
};

/** Seconds without an air before a combo closes out. */
const COMBO_WINDOW = 2.6;
/** Minimum air time that counts as an air at all, seconds. */
const MIN_AIR = 0.28;

export class TrickSystem {
  constructor(ctx) {
    this.ctx = ctx;

    /** The trick in progress, or null when the rider is on the snow. */
    this.current = null;
    /** The combo being built. */
    this.combo = { tricks: [], score: 0, active: false, multiplier: 1 };
    /** Everything landed this run, for the results screen. */
    this.history = [];
    /** Run totals. */
    this.totals = { score: 0, best: 0, longestAir: 0, biggestSpin: 0, landed: 0, crashed: 0 };
    /** Set for a few seconds after a landing so the HUD can call it out. */
    this.callout = null;

    this._wasGrounded = true;
    this._lastHeading = 0;
    this._comboTimer = 0;
    this._calloutTimer = 0;
    this._stanceAtTakeoff = 1;
  }

  update(dt, ctx) {
    const s = ctx.physics?.state;
    if (!s) return;

    // Callout decay.
    if (this._calloutTimer > 0) {
      this._calloutTimer -= dt;
      if (this._calloutTimer <= 0) this.callout = null;
    }

    // Combo window.
    if (this.combo.active) {
      this._comboTimer -= dt;
      if (this._comboTimer <= 0) this._closeCombo();
    }

    const grounded = s.grounded;

    // ---- Takeoff --------------------------------------------------------
    if (this._wasGrounded && !grounded) {
      this.current = {
        name: null,
        rotation: 0,
        flip: 0,
        grab: null,
        grabTime: 0,
        grabSwitches: 0,
        score: 0,
        multiplier: 1,
        airTime: 0,
        height: 0,
        popped: !!s.popped,
      };
      this._lastHeading = s.heading;
      // Which way the rider was facing relative to travel decides whether a
      // spin reads frontside or backside, and whether the take-off was switch.
      this._stanceAtTakeoff = (s.forwardSpeed ?? 1) >= 0 ? 1 : -1;
    }

    // ---- Airborne -------------------------------------------------------
    if (!grounded && this.current) {
      const c = this.current;
      c.airTime = s.airTime;
      c.height = Math.max(c.height, s.airHeight || 0);

      // Accumulate signed rotation from the heading delta, unwrapped so a
      // spin through π does not read as a sudden reversal.
      let d = s.heading - this._lastHeading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      c.rotation += d;
      this._lastHeading = s.heading;
      c.flip = s.pitch || 0;

      const held = ctx.input?.state?.grab || null;
      if (held) {
        if (c.grab !== held) {
          if (c.grab !== null) c.grabSwitches++;
          c.grab = held;
        }
        c.grabTime += dt;
      }
    }

    // ---- Touchdown ------------------------------------------------------
    // The landing itself is reported by physics through onLanded(), which
    // knows whether the edge caught. Here we only need to notice that the
    // airborne phase is over in case physics never called us (a very short
    // hop, below MIN_AIR).
    if (!this._wasGrounded && grounded && this.current) {
      if (this.current.airTime < MIN_AIR) this.current = null;
    }

    this._wasGrounded = grounded;
  }

  /**
   * Called by physics at touchdown.
   * @param {'perfect'|'clean'|'sketchy'|'crash'} quality
   */
  onLanded(quality) {
    const c = this.current;
    this.current = null;
    if (!c || c.airTime < MIN_AIR) return;

    const s = this.ctx.physics?.state;
    const switchLanding = s && (s.forwardSpeed ?? 1) * this._stanceAtTakeoff < 0;

    if (quality === 'crash') {
      this.totals.crashed++;
      this.callout = { text: 'BAILED', score: 0, quality: 'crash' };
      this._calloutTimer = 2.0;
      this._breakCombo();
      return;
    }

    const scored = this._score(c, quality, switchLanding);
    if (!scored.points) return;

    this.history.push(scored);
    this.totals.landed++;
    this.totals.longestAir = Math.max(this.totals.longestAir, c.airTime);
    this.totals.biggestSpin = Math.max(this.totals.biggestSpin, Math.abs(c.rotation) * DEG);
    this.totals.best = Math.max(this.totals.best, scored.points);

    // Combo.
    if (!this.combo.active) {
      this.combo.active = true;
      this.combo.tricks = [];
      this.combo.score = 0;
      this.combo.multiplier = 1;
    }
    this.combo.tricks.push(scored.name);
    this.combo.score += scored.points;
    this.combo.multiplier = 1 + (this.combo.tricks.length - 1) * 0.5;
    this._comboTimer = COMBO_WINDOW;

    this.callout = {
      text: scored.name,
      score: scored.points,
      quality,
      combo: this.combo.tricks.length,
    };
    this._calloutTimer = 2.4;

    this.ctx.audio?.playTrick?.(scored, quality);
  }

  /* ------------------------------------------------------------------ *
   * Scoring
   * ------------------------------------------------------------------ */
  _score(c, quality, switchLanding) {
    const absRot = Math.abs(c.rotation);
    // Half-turns *completed* — a 400° spin is a 360.
    const halves = Math.floor(absRot / Math.PI);
    const capped = Math.min(halves, 8);

    // Flips. `c.flip` is the accumulated pitch at the last airborne frame; a
    // landing up to ~40° shy still counts — physics lets the rider absorb
    // that much, so you get credit for what you rode away from. Positive
    // pitch sends the nose down first (front), negative is back.
    const flips = Math.min(Math.floor((Math.abs(c.flip) + 0.7) / (Math.PI * 2)), 3);
    const flipWord = flips > 0
      ? `${FLIP_NAMES[flips]}${c.flip < 0 ? 'Backflip' : 'Frontflip'}`
      : '';

    // Frontside vs backside. For a regular rider, a positive (counter-
    // clockwise seen from above) rotation is frontside.
    const dirWord = capped === 0 ? '' : (c.rotation > 0 ? 'Frontside ' : 'Backside ');
    const spinWord = capped > 0 ? SPIN_NAMES[capped] : '';

    // Grab. Time held past a token tap is what earns the multiplier.
    const grabName = c.grab ? GRAB_NAMES[c.grab] || c.grab : '';
    const holdT = clamp01((c.grabTime - 0.15) / 0.75);
    const grabMult = c.grab ? lerp(1.0, 1.55, holdT) + c.grabSwitches * 0.12 : 1.0;

    // Air time and height both count, with diminishing returns — a huge
    // straight air should score, but never like a spin.
    const airMult = 1 + smoothstep(0.3, 2.4, c.airTime) * 0.85 + smoothstep(1, 12, c.height) * 0.4;

    const landMult = quality === 'perfect' ? 1.25 : quality === 'clean' ? 1.0 : 0.72;
    const switchMult = switchLanding ? 1.4 : 1.0;

    let base = (SPIN_BASE[capped] || 0) + (FLIP_BASE[flips] || 0);
    // A straight air with a grab is still a trick; a straight air without one
    // is just riding, and should score nothing at all.
    if (base === 0) base = c.grab ? 60 : 0;

    const points = Math.round(base * grabMult * airMult * landMult * switchMult);

    // Assemble the name the way a commentator would say it: flip first,
    // then rotation, then the grab — "Backflip Frontside 360 Indy".
    const spinPart = capped > 0 ? `${dirWord}${spinWord}` : '';
    let name = [flipWord, spinPart, grabName].filter(Boolean).join(' ');
    if (!name) name = 'Air';
    if (switchLanding && (capped > 0 || flips > 0)) name = `Switch ${name}`;

    this.totals.score += points;
    return {
      name: name.trim(),
      points,
      rotation: absRot * DEG,
      grab: c.grab,
      airTime: c.airTime,
      height: c.height,
      quality,
      switch: switchLanding,
    };
  }

  _closeCombo() {
    if (!this.combo.active) return;
    const bonus = Math.round(this.combo.score * (this.combo.multiplier - 1));
    if (bonus > 0) {
      this.totals.score += bonus;
      this.callout = { text: `${this.combo.tricks.length}× COMBO`, score: bonus, quality: 'combo' };
      this._calloutTimer = 2.0;
    }
    this.combo.active = false;
    this.combo.tricks = [];
    this.combo.score = 0;
    this.combo.multiplier = 1;
  }

  /** A crash loses the combo's accumulated bonus but keeps the base points. */
  _breakCombo() {
    this.combo.active = false;
    this.combo.tricks = [];
    this.combo.score = 0;
    this.combo.multiplier = 1;
    this._comboTimer = 0;
  }

  reset() {
    this.current = null;
    this.history.length = 0;
    this.callout = null;
    this._calloutTimer = 0;
    this._breakCombo();
    this.totals = { score: 0, best: 0, longestAir: 0, biggestSpin: 0, landed: 0, crashed: 0 };
  }
}
