/**
 * Unified input: keyboard, mouse (pointer lock) and touch, mapped to
 * semantic actions. The game reads `input.state` every frame and consumes
 * one-shot `pressed` actions.
 */

const KEY_ACTIONS = {
  KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint', KeyE: 'interact', KeyF: 'interact', KeyQ: 'ability1', KeyC: 'ability2', KeyX: 'ultimate',
  KeyM: 'map', KeyJ: 'journal', KeyB: 'emote', KeyR: 'reload', Escape: 'pause', KeyH: 'help', Tab: 'journal',
};

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.down = new Set();
    this.pressed = new Set();
    this.look = { x: 0, y: 0 };
    this.fire = false;
    this.aim = false;
    this.locked = false;
    this.enabled = false;
    this.touch = { moveX: 0, moveY: 0, active: false };
    this.lastDevice = 'keyboard';
    this.sensitivity = 1;
    this.invertY = false;
    this._bind();
  }
  _bind() {
    const typing = e => e.target?.matches?.('input, textarea, select') || e.target?.closest?.('dialog[open]');
    addEventListener('keydown', e => {
      if (typing(e) && e.code !== 'Escape') return;
      const action = KEY_ACTIONS[e.code];
      if (!action) return;
      if (this.enabled && ['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this.lastDevice = 'keyboard';
      if (!this.down.has(action) && !e.repeat) this.pressed.add(action);
      this.down.add(action);
    });
    addEventListener('keyup', e => { const action = KEY_ACTIONS[e.code]; if (action) this.down.delete(action); });
    addEventListener('blur', () => this.reset());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.reset(); });
    this.canvas.addEventListener('mousedown', e => {
      if (!this.enabled) return;
      this.lastDevice = 'mouse';
      if (!this.locked) { this.requestLock(); return; }
      if (e.button === 0) { this.fire = true; this.pressed.add('fire'); }
      if (e.button === 2) this.aim = true;
    });
    addEventListener('mouseup', e => { if (e.button === 0) this.fire = false; if (e.button === 2) this.aim = false; });
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.fire = false; this.aim = false; }
      this.onLockChange?.(this.locked);
    });
    document.addEventListener('mousemove', e => {
      if (!this.locked || !this.enabled) return;
      this.look.x += Math.max(-200, Math.min(200, e.movementX)) * this.sensitivity;
      this.look.y += Math.max(-200, Math.min(200, e.movementY)) * this.sensitivity * (this.invertY ? -1 : 1);
    });
    // Touch: left half = virtual stick, right half = look drag (buttons are DOM).
    let stickId = null, lookId = null, stickOrigin = null, lookLast = null;
    this.canvas.addEventListener('touchstart', e => {
      if (!this.enabled) return;
      this.lastDevice = 'touch';
      for (const t of e.changedTouches) {
        if (t.clientX < innerWidth * 0.42 && stickId === null) { stickId = t.identifier; stickOrigin = { x: t.clientX, y: t.clientY }; this.touch.active = true; this.onStick?.(stickOrigin, { x: 0, y: 0 }); }
        else if (lookId === null) { lookId = t.identifier; lookLast = { x: t.clientX, y: t.clientY }; }
      }
      e.preventDefault();
    }, { passive: false });
    this.canvas.addEventListener('touchmove', e => {
      for (const t of e.changedTouches) {
        if (t.identifier === stickId) {
          const dx = t.clientX - stickOrigin.x, dy = t.clientY - stickOrigin.y, r = 55, len = Math.hypot(dx, dy) || 1, k = Math.min(1, len / r);
          this.touch.moveX = dx / len * k; this.touch.moveY = dy / len * k;
          this.onStick?.(stickOrigin, { x: this.touch.moveX, y: this.touch.moveY });
        } else if (t.identifier === lookId) {
          this.look.x += (t.clientX - lookLast.x) * 1.6; this.look.y += (t.clientY - lookLast.y) * 1.6;
          lookLast = { x: t.clientX, y: t.clientY };
        }
      }
      e.preventDefault();
    }, { passive: false });
    const end = e => {
      for (const t of e.changedTouches) {
        if (t.identifier === stickId) { stickId = null; this.touch.moveX = 0; this.touch.moveY = 0; this.touch.active = false; this.onStick?.(null); }
        if (t.identifier === lookId) lookId = null;
      }
    };
    this.canvas.addEventListener('touchend', end); this.canvas.addEventListener('touchcancel', end);
  }
  requestLock() {
    if (this.locked || !this.enabled || matchMedia('(pointer: coarse)').matches) return;
    // Browsers may refuse (no user gesture yet, right after Escape, or no raw
    // mouse input): that is expected, and the next click on the world retries.
    const plain = () => { try { this.canvas.requestPointerLock()?.catch?.(() => {}); } catch { /* refused */ } };
    try { const p = this.canvas.requestPointerLock({ unadjustedMovement: true }); if (p?.catch) p.catch(plain); } catch { plain(); }
  }
  releaseLock() { if (document.pointerLockElement === this.canvas) document.exitPointerLock(); }
  /** Virtual buttons (touch UI) call these. */
  press(action) { this.pressed.add(action); this.down.add(action); }
  release(action) { this.down.delete(action); }
  /** Movement axes in [-1, 1]: x = strafe right, y = forward. */
  get move() {
    let x = (this.down.has('right') ? 1 : 0) - (this.down.has('left') ? 1 : 0);
    let y = (this.down.has('forward') ? 1 : 0) - (this.down.has('back') ? 1 : 0);
    if (this.touch.active) { x += this.touch.moveX; y -= this.touch.moveY; }
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    return { x, y };
  }
  consume(action) { if (this.pressed.has(action)) { this.pressed.delete(action); return true; } return false; }
  takeLook() { const v = { x: this.look.x, y: this.look.y }; this.look.x = 0; this.look.y = 0; return v; }
  endFrame() { this.pressed.clear(); }
  reset() { this.down.clear(); this.pressed.clear(); this.fire = false; this.aim = false; this.look.x = 0; this.look.y = 0; this.touch.moveX = 0; this.touch.moveY = 0; this.touch.active = false; }
}
