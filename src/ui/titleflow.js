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
  /* The sting's held final frame IS the title art — the card only carries
     the prompt over it. */
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: flex-end; padding-bottom: 7vh;
  opacity: 0; transition: opacity 0.6s ease; background: transparent;
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
  text-shadow: 0 0 1.6vh rgba(0,0,0,0.7); font-size: 1.9vh; font-weight: 700;
  letter-spacing: 0.34em; color: #fff;
  animation: sohoPulse 1.6s ease-in-out infinite;
}
@keyframes sohoPulse { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }
.soho-end {
  position: absolute; inset: 0; z-index: 45; display: none;
  flex-direction: column; align-items: center; justify-content: center;
  gap: 1.4vh; pointer-events: auto;
  background: transparent;
}
.soho-end.show { display: flex; }
.soho-end .done {
  font-weight: 900; font-style: italic; font-size: 17vh; line-height: 1;
  letter-spacing: -0.01em; color: #14161a; transform: skewX(-6deg);
  text-shadow: 0 0 4vh rgba(255,255,255,0.85), 0 0 1.2vh rgba(255,255,255,0.9);
  animation: sohoFlash 0.9s ease-out both;
}
.soho-end .done i { font-style: normal; color: #e02310; }
.soho-end .stats {
  margin-top: 3.2vh; display: flex; gap: 5vw; font-weight: 700;
  font-size: 2.1vh; letter-spacing: 0.18em; color: #14161a;
  text-shadow: 0 0 1.6vh rgba(255,255,255,0.9);
  animation: sohoFlash 0.9s 0.25s ease-out both;
}
.soho-end .stats b { color: #e02310; margin-right: 0.5em; }
.soho-end .again {
  margin-top: 6vh; font-size: 1.8vh; font-weight: 700; letter-spacing: 0.34em;
  color: #14161a; animation: sohoPulse 1.6s 1.1s ease-in-out infinite both; opacity: 0;
}
@keyframes sohoFlash {
  0% { opacity: 0; transform: scale(1.3) skewX(-6deg); }
  14% { opacity: 1; transform: scale(0.98) skewX(-6deg); }
  26% { opacity: 0.2; }
  40% { opacity: 1; }
  100% { opacity: 1; transform: scale(1) skewX(-6deg); }
}
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
        <div class="prompt">PRESS ANY KEY TO DROP</div>
      </div>`;
    host.appendChild(this.el);

    // Run-end flash. Uses the styled lockup until the user's end-frame
    // artwork lands in public/img/endframe.png (the <img> swaps itself in
    // when that file exists).
    this.endEl = document.createElement('div');
    this.endEl.className = 'soho-end';
    this.endEl.innerHTML = `
      <div class="done">DONE<i>.</i></div>
      <div class="stats"></div>
      <div class="again">PRESS ANY KEY TO RIDE AGAIN</div>`;
    host.appendChild(this.endEl);

    const video = this.el.querySelector('video');
    const card = this.el.querySelector('.soho-card');
    // Guard: the video's 'ended' and the backstop timer can both fire AFTER
    // the player has already dropped in - they must never drag the state
    // back to the title (probe caught riding -> title regression).
    const toCard = () => {
      if (this.state !== 'sting') return;
      this.state = 'title'; card.classList.add('show');
    };
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
    this.endEl?.remove();
    if (this.ctx.input) this.ctx.input.enabled = true;
  }

  /** Run tally, cheap enough to run every frame. */
  update(dt) {
    if (this.state !== 'riding') return;
    const s = this.ctx.physics?.state;
    if (!s) return;
    // The natural end of a Soho run is arriving back at the lift line
    // (user's rules): the base terminal sits at (320, -560).
    {
      const dx = s.position.x - 320, dz = s.position.z - (-560);
      if (dx * dx + dz * dz < 48 * 48) { this.endRun(); return; }
    }
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
    if (this.state === 'ended') return;
    this.state = 'ended';
    if (this.ctx.input) this.ctx.input.enabled = false;
    const st = this.stats;
    const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    this.endEl.querySelector('.stats').innerHTML =
      `<span><b>TIME</b>${fmt(st.time)}</span>` +
      `<span><b>TOP</b>${Math.round(st.topSpeed * 3.6)} KM/H</span>` +
      `<span><b>AIR</b>${st.maxAir.toFixed(1)}s</span>`;
    this.endEl.classList.add('show');
    this._again = (e) => {
      if (e.type === 'keydown' && (e.metaKey || e.ctrlKey || e.altKey)) return;
      window.removeEventListener('keydown', this._again);
      window.removeEventListener('pointerdown', this._again);
      this.endEl.classList.remove('show');
      const spawn = this.ctx.terrain?.getSpawn?.();
      if (spawn) this.ctx.physics.reset(spawn.position, spawn.heading);
      this.ctx.player?.camera?.snapToTarget?.();
      if (this.ctx.input) this.ctx.input.enabled = true;
      this.stats = { time: 0, topSpeed: 0, maxAir: 0, _air: 0 };
      this.state = 'riding';
    };
    // A beat of lockout so the landing keystroke cannot skip the flash.
    setTimeout(() => {
      window.addEventListener('keydown', this._again);
      window.addEventListener('pointerdown', this._again);
    }, 900);
  }

  dispose() {
    this._music?.pause();
    this.el?.remove();
  }
}
