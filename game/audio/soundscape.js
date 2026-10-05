// The Unfolding: live-synthesized soundtrack and sound effects.
// Warm, bass-forward generative music (a love letter to the bass years) plus
// punchy game effects, all built from Web Audio oscillators, noise and filters.
// No samples, no audio files, no external libraries.
//
// Entry point. The game constructs one Soundscape, calls unlock() from its
// first user gesture, and then drives it with setScene(), play() and setLoop().

import { LOOP_NAMES, LoopManager } from './loops.js';
import { Mixer } from './mixer.js';
import { MusicEngine, normalizeScene } from './music.js';
import { SFX_INTERVALS, SFX_LIMITS, SFX_NAMES, SfxLibrary } from './sfx.js';
import { Rng, clamp, finite, isOfflineContext } from './util.js';
import { VoiceManager } from './voices.js';

export { LOOP_NAMES, SFX_NAMES };

const TICK_MS = 25;
const LOOKAHEAD = 0.12;
const HIDDEN_LOOKAHEAD = 0.6;
const DEFAULT_VOLUME = 0.7;
/** Master gain at volume 1 (after the limiter). Volume uses a squared, perceptual curve. */
const MASTER_LEVEL = 0.95;
const FADE_IN_SECONDS = 0.6;
const FADE_OUT_SECONDS = 0.4;
const MUSIC_LIMITS = { bass: 6, cbass: 4, pad: 6, keys: 14, ep: 12, kick: 3, hat: 8, brush: 4, tom: 4 };
const DEFAULT_SCENE = Object.freeze({ world: null, mode: 'foot', altitude: 0, speed: 0, combat: 0, night: 0, reading: false });
const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchend'];

const masterGainFor = (volume) => MASTER_LEVEL * volume * volume;

export class Soundscape {
  /**
   * Creates the soundscape. No AudioContext is created until unlock() or
   * setEnabled(true) (browser autoplay policy).
   *
   * @param {object} [options]
   * @param {BaseAudioContext} [options.context] use this context (e.g. an OfflineAudioContext for tests) instead of creating one
   * @param {number} [options.seed] seed for all musical and SFX randomness
   * @param {number} [options.volume] initial master volume, 0..1 (default 0.7)
   * @param {boolean} [options.manualClock] schedule from update() instead of a timer (default: true for offline contexts)
   * @param {boolean} [options.autoUnlock] resume on the next user gesture if the browser kept audio suspended (default true)
   * @param {boolean} [options.strict] rethrow errors from play()/setLoop() instead of swallowing them (tests)
   */
  constructor(options = {}) {
    this.options = { ...options };
    this.seed = Number.isFinite(options.seed) ? options.seed >>> 0 : 0x5eed1e;
    this._volume = clamp(finite(options.volume, DEFAULT_VOLUME), 0, 1);
    this._enabled = false;
    this._disposed = false;
    this._scene = { ...DEFAULT_SCENE };
    this._sceneSet = false;
    this._loopRequests = new Map();
    this._timer = null;
    this._suspendTimer = null;
    this._gestureHandler = null;
    this._lastPrune = 0;
    this._enabledAt = 0;
    this.ctx = null;
    this._ownsContext = false;
  }

  /** True when sound is switched on. */
  get enabled() {
    return this._enabled;
  }

  /** Current master volume (0..1). */
  get volume() {
    return this._volume;
  }

  /** The AudioContext in use, or null before unlock()/setEnabled(true). */
  get context() {
    return this.ctx;
  }

  /** Active music theme id ('philosophy' … 'contact', 'space'), or null. */
  get theme() {
    return this.music?.themeId ?? null;
  }

  /** Diagnostics: theme, pending theme, active voice counts and live loops. */
  get stats() {
    return {
      theme: this.theme,
      pendingTheme: this.music?.pendingThemeId ?? null,
      contextState: this.ctx?.state ?? 'none',
      musicVoices: this.musicVoices?.count ?? 0,
      sfxVoices: this.sfxVoices?.count ?? 0,
      players: this.music?.players.length ?? 0,
      loops: this.loops ? [...this.loops.loops.keys()] : [],
    };
  }

  /**
   * Call from a user gesture (click, key, touch). Creates the AudioContext if
   * needed and resumes it. Resolves true when audio is running.
   * @returns {Promise<boolean>}
   */
  async unlock() {
    const ctx = this._ensureContext();
    if (!ctx) return false;
    if (!this._offline && ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // Still blocked; the gesture listener retries.
      }
    }
    if (this._disposed || !this.ctx) return false;
    const running = this._offline || ctx.state === 'running';
    if (!running) this._armGestureUnlock();
    if (this._enabled) {
      this._fadeMaster(true);
      this._startScheduler();
    } else if (running && !this._offline) {
      // Unlocked for later, but stay idle while muted.
      this._scheduleSuspend();
    }
    return running;
  }

  /**
   * Master on/off with a smooth fade. Turning off fades to silence, then
   * suspends the context to save CPU. Persists nothing.
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    if (this._disposed) return;
    this._enabled = Boolean(enabled);
    if (this._enabled) {
      const ctx = this._ensureContext();
      if (!ctx) return;
      clearTimeout(this._suspendTimer);
      this._suspendTimer = null;
      if (!this._offline && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
        this._armGestureUnlock();
      }
      for (const [name, request] of this._loopRequests) this.loops.set(name, true, request.params);
      this._enabledAt = ctx.currentTime;
      this._fadeMaster(true);
      this._startScheduler();
    } else if (this.ctx) {
      this._fadeMaster(false);
      this._scheduleSuspend();
    }
  }

  /**
   * Master volume, 0..1 (default 0.7). A squared curve keeps low settings usable.
   * @param {number} volume
   */
  setVolume(volume) {
    this._volume = clamp(finite(volume, this._volume), 0, 1);
    if (this.ctx && this._enabled) {
      this.mixer.master.gain.setTargetAtTime(masterGainFor(this._volume), this.ctx.currentTime, 0.05);
    }
  }

  /**
   * Describes the player's situation; call about 10x per second. Missing
   * fields keep their previous values.
   * @param {{ world?: string|null, mode?: 'foot'|'ship', altitude?: number, speed?: number, combat?: number, night?: number, reading?: boolean }} scene
   */
  setScene(scene = {}) {
    this._scene = normalizeScene(scene || {}, this._scene);
    const first = !this._sceneSet;
    this._sceneSet = true;
    if (this.music) this.music.setScene(this._scene, { immediate: first });
  }

  /**
   * Plays a one-shot effect (see SFX_NAMES).
   * @param {string} name
   * @param {{ volume?: number, pitch?: number, pan?: number, surface?: string, tier?: number }} [opts]
   *   `pitch` is a frequency multiplier (1 = normal), except for 'notePad' where it is a MIDI note.
   * @returns {object|null} the voice, or null when muted, unknown or rate-limited
   */
  play(name, opts = {}) {
    if (!this._enabled || this._disposed || !this.ctx) return null;
    if (!this._offline && this.ctx.state !== 'running') return null;
    try {
      return this.sfx.play(name, opts || {});
    } catch (error) {
      if (this.options.strict) throw error;
      return null;
    }
  }

  /**
   * Starts, updates or stops a continuous sound: 'jetpack', 'engine', 'boost', 'charge'.
   * Safe to call every frame. engine params: { throttle 0..1, speed m/s };
   * charge params: { amount 0..1 }; jetpack params: { thrust 0..1 }.
   * @param {string} name
   * @param {boolean} active
   * @param {object} [params]
   * @returns {boolean} false for unknown loop names
   */
  setLoop(name, active, params = {}) {
    if (!LOOP_NAMES.includes(name)) return false;
    if (active) this._loopRequests.set(name, { params: { ...params } });
    else this._loopRequests.delete(name);
    if (!this.loops || (!this._enabled && active)) return true;
    try {
      this.loops.set(name, Boolean(active), params || {});
    } catch (error) {
      if (this.options.strict) throw error;
    }
    return true;
  }

  /**
   * Optional per-frame hook (cheap). With a manual clock (offline rendering)
   * it also drives the music scheduler.
   * @param {number} [dt] seconds since the last frame (timing comes from the AudioContext clock)
   */
  // eslint-disable-next-line no-unused-vars
  update(dt = 0) {
    if (!this.ctx || this._disposed) return;
    if (this._manual) {
      if (this._enabled) this._tick();
      return;
    }
    const now = this.ctx.currentTime;
    if (now - this._lastPrune > 0.5) this._housekeeping(now);
  }

  /** Stops everything, disconnects every node and closes a context this instance created. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._enabled = false;
    this._stopScheduler();
    clearTimeout(this._suspendTimer);
    this._suspendTimer = null;
    this._disarmGestureUnlock();
    if (this.ctx) {
      this.loops.dispose();
      this.music.dispose();
      this.musicVoices.disposeAll();
      this.sfxVoices.disposeAll();
      this.mixer.dispose();
      if (this._ownsContext && this.ctx.state !== 'closed' && typeof this.ctx.close === 'function') this.ctx.close().catch(() => {});
    }
    this._loopRequests.clear();
    this.ctx = null;
    this.mixer = null;
    this.music = null;
    this.sfx = null;
    this.loops = null;
  }

  // -- internals ---------------------------------------------------------------

  _ensureContext() {
    if (this.ctx || this._disposed) return this.ctx;
    let ctx = this.options.context || null;
    if (!ctx) {
      const AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioCtor) return null;
      try {
        ctx = new AudioCtor({ latencyHint: 'interactive' });
      } catch {
        try {
          ctx = new AudioCtor();
        } catch {
          return null;
        }
      }
      this._ownsContext = true;
    }
    this.ctx = ctx;
    this._offline = isOfflineContext(ctx);
    this._manual = this.options.manualClock ?? this._offline;
    this.mixer = new Mixer(ctx, { seed: this.seed });
    this.musicVoices = new VoiceManager(ctx, { maxVoices: 56, tagLimits: MUSIC_LIMITS });
    this.sfxVoices = new VoiceManager(ctx, { maxVoices: 32, tagLimits: SFX_LIMITS, minIntervals: SFX_INTERVALS });
    this.music = new MusicEngine({ ctx, mixer: this.mixer, voices: this.musicVoices, seed: this.seed });
    this.sfx = new SfxLibrary({ ctx, mixer: this.mixer, voices: this.sfxVoices, rng: new Rng(this.seed + 7), music: this.music });
    this.loops = new LoopManager({ ctx, mixer: this.mixer });
    if (this._sceneSet) this.music.setScene(this._scene, { immediate: true });
    return ctx;
  }

  /**
   * Fades the master toward on/off. setTargetAtTime continues from the value the
   * param actually has at `now`; reading `param.value` here is unreliable (it can
   * still report the default of 1 before the first render quantum).
   */
  _fadeMaster(on) {
    const param = this.mixer.master.gain;
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    if (on) param.setTargetAtTime(masterGainFor(this._volume), now, FADE_IN_SECONDS / 3);
    else param.setTargetAtTime(0, now, FADE_OUT_SECONDS / 4);
  }

  _scheduleSuspend() {
    clearTimeout(this._suspendTimer);
    this._suspendTimer = setTimeout(() => {
      this._suspendTimer = null;
      if (this._enabled || !this.ctx || this._disposed) return;
      this._stopScheduler();
      if (!this._offline && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
    }, (FADE_OUT_SECONDS + 0.25) * 1000);
    this._suspendTimer.unref?.();
  }

  _startScheduler() {
    if (!this.ctx) return;
    this._tick();
    if (this._manual || this._timer) return;
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._timer.unref?.();
  }

  _stopScheduler() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _tick() {
    if (!this.ctx || this._disposed) return;
    if (!this._offline && this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    // Without any setScene() call, fall back to the deep-space theme after a moment.
    if (!this.music.current && (this._sceneSet || now - this._enabledAt > 1)) this.music.setScene(this._scene, { immediate: true });
    const lookahead = !this._offline && globalThis.document?.hidden ? HIDDEN_LOOKAHEAD : LOOKAHEAD;
    this.music.schedule(now + lookahead);
    this.loops.tick(now);
    if (now - this._lastPrune > 0.5) this._housekeeping(now);
  }

  _housekeeping(now) {
    this._lastPrune = now;
    this.musicVoices.prune(now);
    this.sfxVoices.prune(now);
    this.loops.tick(now);
  }

  _armGestureUnlock() {
    if (this._gestureHandler || this.options.autoUnlock === false) return;
    const target = globalThis.window;
    if (!target?.addEventListener) return;
    const handler = () => {
      const ctx = this.ctx;
      if (!ctx || ctx.state === 'running') {
        this._disarmGestureUnlock();
        return;
      }
      if (this._enabled) {
        ctx.resume().then(() => {
          if (this.ctx?.state === 'running') {
            this._disarmGestureUnlock();
            this._startScheduler();
          }
        }).catch(() => {});
      }
    };
    for (const type of GESTURE_EVENTS) target.addEventListener(type, handler, { capture: true, passive: true });
    this._gestureHandler = handler;
  }

  _disarmGestureUnlock() {
    const target = globalThis.window;
    if (this._gestureHandler && target?.removeEventListener) {
      for (const type of GESTURE_EVENTS) target.removeEventListener(type, this._gestureHandler, { capture: true });
    }
    this._gestureHandler = null;
  }
}

export default Soundscape;
