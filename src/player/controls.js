/** PLACEHOLDER — replaced by the controls workstream. */
export class Input {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = {
      steer: 0, lean: 0, crouch: 0, pop: false, spin: 0, flip: 0,
      grab: null, tuck: false, brake: 0, reset: false,
    };
    this.keys = new Set();
    if (typeof window !== 'undefined') {
      this._kd = (e) => { this.keys.add(e.code); };
      this._ku = (e) => { this.keys.delete(e.code); };
      window.addEventListener('keydown', this._kd);
      window.addEventListener('keyup', this._ku);
    }
  }

  update() {
    const k = this.keys, s = this.state;
    s.steer = (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
    s.crouch = k.has('ArrowDown') || k.has('KeyS') ? 1 : 0;
    s.tuck = k.has('ShiftLeft');
    s.pop = k.has('Space');
  }

  dispose() {
    window.removeEventListener('keydown', this._kd);
    window.removeEventListener('keyup', this._ku);
  }
}
