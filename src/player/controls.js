/**
 * Input.
 *
 * Publishes one normalised struct that every other system reads, from three
 * sources that can all be live at once: keyboard, gamepad, and touch. The
 * struct is the contract (ARCHITECTURE.md); the sources are implementation.
 *
 * Two details that matter more than they look:
 *
 *   · Keyboard steering is *ramped*, not binary. A key is a step function and
 *     a snowboard is not; feeding ±1 straight into the edge would make every
 *     keyboard turn identical and maximal. The ramp gives a keyboard player
 *     the same continuous edge control a stick player gets, just slower to
 *     reach the extremes.
 *   · Analogue sticks get a radial dead zone with the remaining range
 *     rescaled to full travel. Per-axis dead zones — the common shortcut —
 *     make diagonals reach only 0.7 and put a square hole in the middle of a
 *     round stick.
 *
 * Nothing here reads wall-clock time or Math.random, so a recorded input
 * sequence replays identically.
 */

import { CONFIG } from '../core/config.js';
import { clamp, clamp01, damp } from '../core/rng.js';

/** Radial dead zone as a fraction of stick travel. */
const DEAD_ZONE = 0.16;
/** How fast a held key ramps the steering axis to full lock, per second. */
const KEY_RAMP = 3.6;
/** How fast steering returns to centre when nothing is held. */
const KEY_RETURN = 7.5;

/** Grab bindings — face buttons on a pad, number row on a keyboard. */
const GRAB_KEYS = {
  Digit1: 'indy', Digit2: 'mute', Digit3: 'melon', Digit4: 'stalefish',
  Digit5: 'nose', Digit6: 'tail', Digit7: 'method',
};
/** Pad face/shoulder buttons → grabs, in the order a thumb finds them. */
const PAD_GRABS = [
  [0, 'indy'], [1, 'mute'], [2, 'melon'], [3, 'stalefish'],
  [4, 'nose'], [5, 'tail'],
];

export class Input {
  constructor(ctx) {
    this.ctx = ctx;

    this.state = {
      steer: 0, lean: 0, crouch: 0, pop: false, spin: 0, flip: 0,
      grab: null, tuck: false, brake: 0, reset: false,
    };

    this.keys = new Set();
    this.enabled = true;
    this._padIndex = null;
    this._steer = 0;
    this._lean = 0;
    this._crouch = 0;
    this._touch = { active: false, steer: 0, crouch: 0, pop: false, tuck: false };

    if (typeof window === 'undefined') return;

    this._kd = (e) => {
      // Don't eat browser shortcuts, and don't fight a focused text field.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      this.keys.add(e.code);
      // Arrows and space scroll the page otherwise, which is a jarring bug to
      // hit mid-run.
      if (PREVENT.has(e.code)) e.preventDefault();
    };
    this._ku = (e) => { this.keys.delete(e.code); };
    // A window that loses focus with keys held would otherwise leave the rider
    // steering hard left forever.
    this._blur = () => { this.keys.clear(); };

    window.addEventListener('keydown', this._kd, { passive: false });
    window.addEventListener('keyup', this._ku);
    window.addEventListener('blur', this._blur);

    this._padConnect = (e) => { this._padIndex = e.gamepad.index; };
    this._padDisconnect = (e) => { if (this._padIndex === e.gamepad.index) this._padIndex = null; };
    window.addEventListener('gamepadconnected', this._padConnect);
    window.addEventListener('gamepaddisconnected', this._padDisconnect);

    this._bindTouch();
  }

  /* ------------------------------------------------------------------ *
   * Touch
   * ------------------------------------------------------------------ */
  _bindTouch() {
    const el = this.ctx.renderer?.domElement || document.body;
    if (!el || typeof window.ontouchstart === 'undefined') return;

    // Left half of the screen steers by horizontal drag; right half is pop on
    // tap and tuck on hold. No on-screen buttons: they cover the picture, and
    // the picture is the point.
    let originX = 0, originY = 0, holdSide = 0, downAt = 0, frames = 0;

    const onStart = (e) => {
      const t = e.changedTouches[0];
      originX = t.clientX; originY = t.clientY;
      holdSide = t.clientX < window.innerWidth * 0.5 ? -1 : 1;
      downAt = frames;
      this._touch.active = true;
      if (holdSide > 0) this._touch.pop = true;
      e.preventDefault();
    };
    const onMove = (e) => {
      const t = e.changedTouches[0];
      if (holdSide < 0) {
        this._touch.steer = clamp((t.clientX - originX) / (window.innerWidth * 0.18), -1, 1);
        this._touch.crouch = clamp01((t.clientY - originY) / (window.innerHeight * 0.2));
      } else {
        this._touch.tuck = (t.clientY - originY) < -window.innerHeight * 0.06;
      }
      e.preventDefault();
    };
    const onEnd = (e) => {
      this._touch.steer = 0;
      this._touch.crouch = 0;
      this._touch.tuck = false;
      this._touch.pop = false;
      this._touch.active = false;
      e.preventDefault();
    };

    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('touchcancel', onEnd, { passive: false });
    this._touchHandlers = { el, onStart, onMove, onEnd };
    this._tickTouch = () => { frames++; };
  }

  /* ------------------------------------------------------------------ *
   * Per-frame
   * ------------------------------------------------------------------ */
  update(dt = 1 / 60) {
    const s = this.state;
    if (!this.enabled) {
      // Hands off entirely — do NOT publish a zeroed struct. Disabling input
      // is how a cutscene or a capture preset takes the controls, and if this
      // kept writing zeros into physics every frame it would stamp out
      // whatever the preset set, one frame after it set it.
      s.steer = 0; s.lean = 0; s.crouch = 0; s.spin = 0; s.flip = 0;
      s.pop = false; s.tuck = false; s.brake = 0; s.grab = null; s.reset = false;
      return;
    }

    const k = this.keys;
    const held = (...codes) => codes.some((c) => k.has(c));

    /* ---- keyboard ---------------------------------------------------- */
    const keySteer = (held('ArrowRight', 'KeyD') ? 1 : 0) - (held('ArrowLeft', 'KeyA') ? 1 : 0);
    // Ramp toward the held direction; spring back to centre when released.
    // The asymmetry is deliberate — a rider can flatten a board far faster
    // than they can roll it onto a new edge.
    if (keySteer !== 0) {
      this._steer = damp(this._steer, keySteer, KEY_RAMP, dt);
    } else {
      this._steer = damp(this._steer, 0, KEY_RETURN, dt);
    }
    const keyCrouch = held('ArrowDown', 'KeyS') ? 1 : 0;
    this._crouch = damp(this._crouch, keyCrouch, 9, dt);
    const keyLean = (held('KeyE') ? 1 : 0) - (held('KeyQ') ? 1 : 0);
    this._lean = damp(this._lean, keyLean, 6, dt);

    let steer = this._steer;
    let lean = this._lean;
    let crouch = this._crouch;
    let spin = 0, flip = 0, brake = 0;
    let pop = held('Space');
    let tuck = held('ShiftLeft', 'ShiftRight');
    let reset = held('KeyR');
    let grab = null;

    for (const code of Object.keys(GRAB_KEYS)) {
      if (k.has(code)) { grab = GRAB_KEYS[code]; break; }
    }
    if (held('ArrowUp', 'KeyW')) brake = 1;
    // In the air the steering axis becomes spin, which is how every
    // snowboarding game since 1080° has done it and what players expect.
    spin = steer;
    flip = (held('KeyF') ? 1 : 0) - (held('KeyG') ? 1 : 0);

    /* ---- gamepad ----------------------------------------------------- */
    const pad = this._readPad();
    if (pad) {
      const [lx, ly] = radialDeadZone(pad.axes[0] || 0, pad.axes[1] || 0);
      const [rx, ry] = radialDeadZone(pad.axes[2] || 0, pad.axes[3] || 0);
      if (Math.abs(lx) > Math.abs(steer)) steer = lx;
      if (Math.abs(lx) > Math.abs(spin)) spin = lx;
      if (ly > 0.05) crouch = Math.max(crouch, ly);
      if (Math.abs(rx) > Math.abs(lean)) lean = rx;
      if (Math.abs(ry) > Math.abs(flip)) flip = -ry;

      const btn = (i) => (pad.buttons[i] ? pad.buttons[i].value || (pad.buttons[i].pressed ? 1 : 0) : 0);
      if (btn(0) > 0.5) pop = true;                     // A / cross
      if (btn(6) > 0.1) brake = Math.max(brake, btn(6)); // left trigger
      if (btn(7) > 0.1) tuck = true;                     // right trigger
      if (btn(8) > 0.5 || btn(9) > 0.5) reset = true;
      for (const [i, name] of PAD_GRABS) {
        if (btn(i) > 0.5) { grab = name; break; }
      }
    }

    /* ---- touch ------------------------------------------------------- */
    if (this._touch.active) {
      if (Math.abs(this._touch.steer) > Math.abs(steer)) steer = this._touch.steer;
      spin = steer;
      crouch = Math.max(crouch, this._touch.crouch);
      if (this._touch.pop) pop = true;
      if (this._touch.tuck) tuck = true;
    }
    if (this._tickTouch) this._tickTouch();

    /* ---- publish ----------------------------------------------------- */
    s.steer = clamp(steer, -1, 1);
    s.lean = clamp(lean, -1, 1);
    s.crouch = clamp01(crouch);
    s.spin = clamp(spin, -1, 1);
    s.flip = clamp(flip, -1, 1);
    s.brake = clamp01(brake);
    s.pop = pop;
    s.tuck = tuck;
    s.grab = grab;
    s.reset = reset;

    this.ctx.physics?.applyInput?.(s);
  }

  _readPad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (!pads) return null;
    if (this._padIndex !== null && pads[this._padIndex]) return pads[this._padIndex];
    for (const p of pads) if (p && p.connected) { this._padIndex = p.index; return p; }
    return null;
  }

  dispose() {
    if (typeof window === 'undefined') return;
    window.removeEventListener('keydown', this._kd);
    window.removeEventListener('keyup', this._ku);
    window.removeEventListener('blur', this._blur);
    window.removeEventListener('gamepadconnected', this._padConnect);
    window.removeEventListener('gamepaddisconnected', this._padDisconnect);
    const th = this._touchHandlers;
    if (th) {
      th.el.removeEventListener('touchstart', th.onStart);
      th.el.removeEventListener('touchmove', th.onMove);
      th.el.removeEventListener('touchend', th.onEnd);
      th.el.removeEventListener('touchcancel', th.onEnd);
    }
  }
}

/** Keys the page must not act on while the game has focus. */
const PREVENT = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
]);

/**
 * Radial dead zone: kill the centre, then rescale what is left to full travel
 * so the stick reaches 1.0 in every direction, diagonals included.
 */
function radialDeadZone(x, y) {
  const mag = Math.hypot(x, y);
  if (mag < DEAD_ZONE) return [0, 0];
  const scaled = Math.min((mag - DEAD_ZONE) / (1 - DEAD_ZONE), 1) / mag;
  return [x * scaled, y * scaled];
}
