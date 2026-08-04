/**
 * Game flow: the state ribbon around the riding core.
 *
 *   sting → title-hold → riding   (→ run-end, when its rules arrive)
 *
 * The user supplies the presentation assets (animated sting, title art,
 * soundtrack); this module is deliberately just the SOCKETS around them:
 * a full-bleed layer that plays the sting, holds on a title card, starts
 * the music on the first real input (the same gesture browsers require
 * for audio anyway), and hands control to the mountain.
 *
 * The capture harness must never see any of it — `skip()` tears the layer
 * down synchronously and is called the moment the harness takes manual
 * control of time.
 */

const CSS = /* css */ `
.soho-flow {
  position: absolute; inset: 0; z-index: 40;
  background: #0a0507; overflow: hidden;
  font-family: 'Archivo', 'Arial Narrow', system-ui, sans-serif;
  transition: opacity 0.45s ease; opacity: 1; pointer-events: auto;
}
.soho-flow.gone { opacity: 0; pointer-events: none; }
.soho-flow video {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover;
}
/* Title card: shown once the sting finishes. A styled stand-in echoing the
   delivered treatment until the artwork PNGs land in public/img/. */
.soho-card {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 1.2vh;
  opacity: 0; transition: opacity 0.6s ease;
  background:
    radial-gradient(130% 90% at 50% 108%, rgba(224, 228, 236, 0.16), transparent 55%),
    linear-gradient(168deg, #c01806 0%, #a51204 34%, #170d0e 58%, #05080d 100%);
}
.soho-card.show { opacity: 1; }
.soho-card .lockup {
  font-weight: 900; font-style: italic; letter-spacing: -0.012em;
  line-height: 0.84; text-align: center; transform: skewX(-6deg);
  text-shadow: 0 0.5vh 3vh rgba(0,0,0,0.55);
}
.soho-card .lockup .soho { display: block; font-size: 15vh; color: #f4f2ee; }
.soho-card .lockup .shred { display: block; font-size: 15vh; color: #e02310; }
.soho-card .strap {
  margin-top: 2.4vh; font-weight: 600; font-size: 1.7vh;
  letter-spacing: 0.55em; color: #e8e4de; opacity: 0.85;
}
.soho-card .strap b { color: #e02310; font-weight: 600; }
.soho-card .prompt {
  margin-top: 7vh; font-size: 1.9vh; font-weight: 700;
  letter-spacing: 0.34em; color: #fff;
  animation: sohoPulse 1.6s ease-in-out infinite;
}
@keyframes sohoPulse { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }
`;

export class TitleFlow {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = 'sting';
    this._music = null;
    this.stats = { time: 0, topSpeed: 0, maxAir: 0, _air: 0 };

    if (typeof document === 'undefined') return;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const host = document.getElementById('app') || document.body;
    this.el = document.createElement('div');
    this.el.className = 'soho-flow';
    this.el.innerHTML = `
      <video muted autoplay playsinline preload="auto" src="video/sting.mp4"></video>
      <div class="soho-card">
        <div class="lockup"><span class="soho">SOHO</span><span class="shred">SHRED</span></div>
        <div class="strap">CARDRONA <b>/</b> NEW ZEALAND</div>
        <div class="prompt">PRESS ANY KEY TO DROP</div>
      </div>`;
    host.appendChild(this.el);

    const video = this.el.querySelector('video');
    const card = this.el.querySelector('.soho-card');
    const toCard = () => { this.state = 'title'; card.classList.add('show'); };
    video.addEventListener('ended', toCard);
    // Autoplay can be refused even muted (rare) — fail toward the card.
    video.play?.()?.catch?.(toCard);
    setTimeout(toCard, 5200);   // backstop: never strand the player in black

    // The rider must not move under the title. Any gesture drops in.
    if (this.ctx.input) this.ctx.input.enabled = false;
    this._drop = (e) => {
      if (e.type === 'keydown' && (e.metaKey || e.ctrlKey || e.altKey)) return;
      this._begin();
    };
    window.addEventListener('keydown', this._drop);
    window.addEventListener('pointerdown', this._drop);
  }

  /** First real input: music up, layer out, mountain in. */
  _begin() {
    if (this.state === 'riding') return;
    this.state = 'riding';
    window.removeEventListener('keydown', this._drop);
    window.removeEventListener('pointerdown', this._drop);
    // The gesture that dismisses the title is the gesture that legally
    // unlocks audio — one motion, no second prompt.
    try {
      this._music = new Audio('audio/snowboard-chill.mp3');
      this._music.loop = true;
      this._music.volume = 0.35;
      this._music.play().catch(() => {});
    } catch { /* headless */ }
    if (this.ctx.input) this.ctx.input.enabled = true;
    this.el.classList.add('gone');
    this.stats = { time: 0, topSpeed: 0, maxAir: 0, _air: 0 };
  }

  /** Capture harness: no sting, no card, no music, input untouched. */
  skip() {
    if (this._skipped) return;
    this._skipped = true;
    this.state = 'riding';
    window.removeEventListener('keydown', this._drop);
    window.removeEventListener('pointerdown', this._drop);
    this.el?.remove();
    if (this.ctx.input) this.ctx.input.enabled = true;
  }

  /** Run tally, cheap enough to run every frame. */
  update(dt) {
    if (this.state !== 'riding') return;
    const s = this.ctx.physics?.state;
    if (!s) return;
    this.stats.time += dt;
    if (s.speed > this.stats.topSpeed) this.stats.topSpeed = s.speed;
    if (!s.grounded) {
      this.stats._air += dt;
      if (this.stats._air > this.stats.maxAir) this.stats.maxAir = this.stats._air;
    } else {
      this.stats._air = 0;
    }
  }

  /**
   * Run-end socket. The rules for WHEN a run ends (arriving back at the
   * lift line, per the user's design) arrive later; whoever detects it
   * calls this with nothing extra — the tally is already here.
   */
  endRun() {
    this.state = 'ended';
    // Presentation TBD: the user's end-frame artwork mounts here.
  }

  dispose() {
    this._music?.pause();
    this.el?.remove();
  }
}
