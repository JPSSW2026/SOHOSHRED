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
  align-items: center; justify-content: flex-start; padding-top: 5.5vh;
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
      // Title theme (user asset). Autoplay may be blocked before any
      // gesture - fail silent; the drop gesture starts the riding track.
      try {
        this._titleMusic = new Audio('audio/soho-valley-tonight.mp3');
        this._titleMusic.loop = true;
        this._titleMusic.volume = 0.45;
        this._titleMusic.play().catch(() => {});
      } catch { /* headless */ }
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
    // Fresh drop: the sim has been running under the title the whole
    // time, so the boot glide has long since bled out on the flat -
    // the rider strands before the player ever gets control (first
    // playtest, twice). Respawn AT the moment control lands.
    const spawn = this.ctx.terrain?.getSpawn?.();
    if (spawn) this.ctx.physics?.reset(spawn.position, spawn.heading);
    this.ctx.player?.camera?.snapToTarget?.();
    // The gesture that dismisses the title is the gesture that legally
    // unlocks audio — one motion, no second prompt.
    // Fade the title theme into the riding track.
    if (this._titleMusic) {
      const tm = this._titleMusic;
      const fade = setInterval(() => {
        tm.volume = Math.max(0, tm.volume - 0.06);
        if (tm.volume <= 0.01) { tm.pause(); clearInterval(fade); }
      }, 80);
    }
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

  /** Tiny synthesized landing chime - thump plus a fifth, no asset. */
  _sfxLand(g) {
    try {
      this._ac = this._ac || new (window.AudioContext || window.webkitAudioContext)();
      const ac = this._ac, t = ac.currentTime;
      for (const [f, amp, dur] of [[120, 0.5, 0.10], [660, 0.22 * g, 0.14], [990, 0.16 * g, 0.18]]) {
        const o = ac.createOscillator(), gn = ac.createGain();
        o.frequency.value = f; o.type = f < 200 ? 'triangle' : 'sine';
        gn.gain.setValueAtTime(amp, t);
        gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(gn).connect(ac.destination);
        o.start(t); o.stop(t + dur + 0.02);
      }
    } catch { /* headless */ }
  }

  /**
   * Wipeout sting: a descending, detuned thud — the opposite shape to the
   * landing chime's bright rising pair, so the two are never confused even
   * with the screen out of view. Synthesized, no asset, same as the rest.
   */
  _sfxFail() {
    try {
      this._ac = this._ac || new (window.AudioContext || window.webkitAudioContext)();
      const ac = this._ac, t = ac.currentTime;
      for (const [f, to, amp, dur, type] of [
        [180, 48, 0.55, 0.55, 'triangle'],   // body: the impact, pitched down
        [300, 90, 0.30, 0.42, 'sawtooth'],   // detuned against it: the sour note
        [92, 40, 0.42, 0.70, 'sine'],        // low tail
      ]) {
        const o = ac.createOscillator(), gn = ac.createGain();
        o.type = type;
        o.frequency.setValueAtTime(f, t);
        o.frequency.exponentialRampToValueAtTime(to, t + dur);
        gn.gain.setValueAtTime(amp, t);
        gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(gn).connect(ac.destination);
        o.start(t); o.stop(t + dur + 0.02);
      }
    } catch { /* headless */ }
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

  /** Any controller button works the overlays (Gamepad API has no events). */
  _padAny() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return false;
    for (const p of navigator.getGamepads() || []) {
      if (p && p.connected && p.buttons.some((b) => b && b.pressed)) return true;
    }
    return false;
  }

  /** Run tally, cheap enough to run every frame. */
  update(dt) {
    if (this.state === 'sting' || this.state === 'title') {
      if (this._padAny()) this._begin();
      return;
    }
    if (this.state === 'ended') {
      // Same post-flash lockout as the keyboard path, and require a
      // fresh press (the arrival frame often still has a button down).
      this._endT = (this._endT || 0) + dt;
      const down = this._padAny();
      if (this._endT > 0.9 && down && !this._padHeld) this._again?.({ type: 'pad' });
      this._padHeld = down;
      return;
    }
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
      // Landing chime for a real air (playtest ask): synthesized, no asset.
      if (this.stats._air > 0.4) this._sfxLand(Math.min(1, this.stats._air / 1.4));
      this.stats._air = 0;
    }
    // Wipeout: an unsalvageable landing — inverted, or an impact far past a
    // normal crash — ends the run attempt. Physics flags it, we own the
    // response. The reset is deliberately held off for a beat: cutting
    // instantly to the drop reads as a bug, and the player needs to SEE
    // that they landed on their head. Same heli-back as the stall rescue,
    // stats keep running.
    if (s.wipeout) {
      s.wipeout = false;              // one-shot handshake with physics
      this._bail = 1.3;
      this._sfxFail();
    }
    if (this._bail > 0) {
      this._bail -= dt;
      if (this._bail <= 0) {
        this._bail = 0;
        this._stall = 0;
        const sp = this.ctx.terrain?.getSpawn?.();
        if (sp) { this.ctx.physics.reset(sp.position, sp.heading); this.ctx.player?.camera?.snapToTarget?.(); }
      }
      return;                          // no stall bookkeeping mid-bail
    }

    // Stall rescue (playtest: stranded on flats): grounded, slow, upright,
    // for ~3 s -> heli back to the drop. Stats keep running - it is a
    // rescue, not a new run. The timer *decays* rather than zeroing when
    // speed pokes over the line: a stranded rider creeps across the flat
    // at 1.3-1.6 m/s for tens of seconds, and the old hard reset at a
    // 1.3 threshold meant the rescue never fired for exactly the player
    // it exists for (measured on the runout).
    if (s.grounded && !s.crashed && s.speed < 2.2) {
      this._stall = (this._stall || 0) + dt;
      if (this._stall > 3.0) {
        this._stall = 0;
        const sp = this.ctx.terrain?.getSpawn?.();
        if (sp) { this.ctx.physics.reset(sp.position, sp.heading); this.ctx.player?.camera?.snapToTarget?.(); }
      }
    } else {
      this._stall = Math.max(0, (this._stall || 0) - dt * 2);
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
    this._endT = 0; this._padHeld = true;
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
    this._titleMusic?.pause();
    this.el?.remove();
  }
}
