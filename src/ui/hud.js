/**
 * HUD.
 *
 * A DOM overlay rather than a canvas texture: it screenshots correctly, it
 * costs no draw calls, it stays crisp at any resolution, and text rendered by
 * the browser will always beat text we rasterise ourselves.
 *
 * The design rule is restraint. A snowboarding game is a landscape game, and
 * the reference footage sells itself on the mountain rather than on telemetry.
 * Everything here therefore earns its place or fades out:
 *
 *   · Speed is always up, because it is the one number that changes how you
 *     read what you are seeing.
 *   · Air time appears only in the air, and only past the point where the
 *     jump is worth noticing.
 *   · The trick call-out appears on landing and fades. It never sits.
 *   · Score and run timer live small and low-contrast in a corner.
 *
 * And critically: the HUD hides itself whenever the camera is not a gameplay
 * camera. The capture harness puts the camera in 'free' for every landscape
 * preset, and a speedometer stamped over a hero shot of the basin would be a
 * defect in its own right.
 */

import { clamp01, damp, smoothstep } from '../core/rng.js';

const CSS = `
.soho-hud {
  position: absolute; inset: 0; pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #fff; opacity: 0; transition: opacity 260ms ease;
  -webkit-font-smoothing: antialiased;
  text-shadow: 0 1px 3px rgba(0, 20, 40, 0.55), 0 0 18px rgba(0, 20, 40, 0.30);
}
.soho-hud.visible { opacity: 1; }

.soho-speed {
  position: absolute; left: 3.2vw; bottom: 4.2vh;
  display: flex; align-items: baseline; gap: 0.45em;
}
.soho-speed .v {
  font-size: 5.6vh; font-weight: 200; letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums; line-height: 1;
}
.soho-speed .u { font-size: 1.5vh; font-weight: 500; letter-spacing: 0.18em; opacity: 0.62; }

/* Edge-load bar: fills as the edge approaches its grip limit, so the player
   can feel a turn about to wash out before it actually does. */
.soho-edge {
  position: absolute; left: 3.2vw; bottom: 2.6vh;
  width: 11vh; height: 0.32vh; background: rgba(255,255,255,0.20); border-radius: 2px;
  overflow: hidden;
}
.soho-edge i {
  display: block; height: 100%; width: 0%; border-radius: 2px;
  background: linear-gradient(90deg, #8fd0ff, #ffffff 65%, #ffb36b);
  transition: width 60ms linear;
}

.soho-air {
  /* Lower-right corner block with the speedo's grammar — never over the
     rider. Centre-frame at 14vh sat the counter directly on the subject in
     every air shot. */
  position: absolute; right: 3.2vw; bottom: 12.5vh; text-align: right;
  font-size: 3.6vh; font-weight: 200; font-variant-numeric: tabular-nums;
  opacity: 0; transition: opacity 140ms ease;
}
.soho-air.on { opacity: 0.95; }
.soho-air small { font-size: 1.5vh; letter-spacing: 0.2em; opacity: 0.6; margin-left: 0.35em; }

.soho-trick {
  position: absolute; left: 50%; top: 71vh; transform: translateX(-50%);
  text-align: center; opacity: 0;
}
/* Type matched to the end frame: Archivo, heavy, italic, tight tracking on
   the name; wide-tracked small caps underneath. The call-out used to be a
   light 300 with open tracking, which read as a different product from the
   title and result cards it sits between. */
.soho-trick .n {
  font-size: 4.0vh; font-weight: 900; font-style: italic; letter-spacing: -0.012em;
  white-space: nowrap; text-transform: uppercase;
}
.soho-trick .p {
  font-size: 2.0vh; font-weight: 700; letter-spacing: 0.10em; opacity: 0.9;
  margin-top: 0.15em;
}
.soho-trick .c {
  font-size: 1.3vh; font-weight: 600; letter-spacing: 0.34em; opacity: 0.75;
  margin-top: 0.4em; text-transform: uppercase;
}
/* Three grades of bad landing, three readings. OOF is a shrug, BAILED is a
   warning, FAILED is the run ending -- so it takes the title card's red and
   the most size. */
.soho-trick.oof .n { color: #ffd9a8; font-size: 3.2vh; }
.soho-trick.crash .n { color: #ff8c6b; }
.soho-trick.failed .n { color: #e02310; font-size: 5.2vh; letter-spacing: 0.02em; }
.soho-trick.failed .c { color: #e02310; opacity: 0.9; }

.soho-run { position: absolute; right: 3.2vw; bottom: 4.2vh; text-align: right; }
.soho-run .s {
  font-size: 3.0vh; font-weight: 300; font-variant-numeric: tabular-nums; line-height: 1;
}
.soho-run .t {
  font-size: 1.5vh; font-weight: 400; opacity: 0.55; margin-top: 0.4em;
  font-variant-numeric: tabular-nums; letter-spacing: 0.06em;
}

.soho-place {
  position: absolute; left: 3.2vw; top: 3.4vh;
  font-size: 1.4vh; letter-spacing: 0.24em; opacity: 0.5; font-weight: 500;
}
`;

/** Camera modes the HUD is allowed to appear in. */
const GAMEPLAY_MODES = new Set(['chase', 'cinematic', 'firstPerson']);

export class HUD {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = null;
    this.visible = false;
    this._forced = null;
    this._speed = 0;
    this._trickFade = 0;
    this._runTime = 0;
    this._lastCallout = null;
  }

  build() {
    if (typeof document === 'undefined') return;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this._style = style;

    const root = document.createElement('div');
    root.className = 'soho-hud';
    root.innerHTML = `
      <div class="soho-place">SOHO BASIN &middot; CARDRONA</div>
      <div class="soho-speed"><span class="v">0</span><span class="u">KM/H</span></div>
      <div class="soho-edge"><i></i></div>
      <div class="soho-air"><span class="t">0.00</span><small>AIR</small></div>
      <div class="soho-trick"><div class="n"></div><div class="p"></div><div class="c"></div></div>
      <div class="soho-run"><div class="s">0</div><div class="t">0:00</div></div>
    `;

    const host = this.ctx.renderer?.domElement?.parentElement || document.body;
    // Position against the canvas's container, not the page, or the overlay
    // drifts the moment the canvas is not full-bleed.
    if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(root);

    this.root = root;
    this.el = {
      speed: root.querySelector('.soho-speed .v'),
      edge: root.querySelector('.soho-edge i'),
      air: root.querySelector('.soho-air'),
      airT: root.querySelector('.soho-air .t'),
      trick: root.querySelector('.soho-trick'),
      trickN: root.querySelector('.soho-trick .n'),
      trickP: root.querySelector('.soho-trick .p'),
      trickC: root.querySelector('.soho-trick .c'),
      score: root.querySelector('.soho-run .s'),
      timer: root.querySelector('.soho-run .t'),
    };
  }

  /** Explicit override: true/false pins it, null returns to automatic. */
  setVisible(v) {
    this._forced = v === null || v === undefined ? null : !!v;
  }

  update(dt, ctx) {
    if (!this.root) return;

    // ---- Should this be on screen at all? ----------------------------
    const mode = ctx.player?.camera?.mode || ctx.chaseCamera?.mode;
    const auto = GAMEPLAY_MODES.has(mode);
    const show = this._forced === null ? auto : this._forced;
    if (show !== this.visible) {
      this.visible = show;
      this.root.classList.toggle('visible', show);
    }
    if (!show) return;

    const s = ctx.physics?.state;
    if (!s) return;
    this._runTime += dt;

    // ---- Speed --------------------------------------------------------
    // Damped: an undamped readout flickers through three digits a second on
    // rough ground and is unreadable.
    this._speed = damp(this._speed, s.speed * 3.6, 7, dt);
    this.el.speed.textContent = Math.round(this._speed);
    this.el.edge.style.width = `${clamp01(s.edgeLoad || 0) * 100}%`;

    // ---- Air ----------------------------------------------------------
    const airing = !s.grounded && s.airTime > 0.25;
    this.el.air.classList.toggle('on', airing);
    if (airing) this.el.airT.textContent = s.airTime.toFixed(2);

    // ---- Trick call-out ------------------------------------------------
    const callout = ctx.tricks?.callout || null;
    if (callout && callout !== this._lastCallout) {
      this._lastCallout = callout;
      this._trickFade = 1;
      this.el.trickN.textContent = callout.text || '';
      this.el.trickP.textContent = callout.score ? `+${callout.score.toLocaleString()}` : '';
      this.el.trickC.textContent = callout.combo > 1 ? `${callout.combo}× COMBO` : '';
      // One class per grade, so the CSS above can read them differently.
      for (const q of ['oof', 'crash', 'failed']) {
        this.el.trick.classList.toggle(q, callout.quality === q);
      }
    }
    if (!callout) this._lastCallout = null;

    if (this._trickFade > 0) {
      this._trickFade = Math.max(0, this._trickFade - dt * 0.5);
      // Ease out and drift upward slightly — motion is what makes a call-out
      // read as an event rather than as a label.
      const a = smoothstep(0, 0.35, this._trickFade);
      this.el.trick.style.opacity = a;
      this.el.trick.style.transform = `translateX(-50%) translateY(${(1 - a) * -1.6}vh)`;
    }

    // ---- Run ----------------------------------------------------------
    const totals = ctx.tricks?.totals;
    if (totals) this.el.score.textContent = Math.round(totals.score).toLocaleString();
    const m = Math.floor(this._runTime / 60);
    const sec = Math.floor(this._runTime % 60);
    this.el.timer.textContent = `${m}:${sec < 10 ? '0' : ''}${sec}`;
  }

  dispose() {
    this.root?.remove();
    this._style?.remove();
  }
}
