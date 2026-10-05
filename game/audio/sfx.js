// One-shot sound effects. Each play() builds one short Voice (a few layered
// oscillators and noise bursts with their own envelopes) on the SFX bus, so
// the voice manager can cap, rate-limit and steal whole effects at once.
// Musical effects (kill, discover, pickup, levelUp, notePad) follow the key of
// whatever theme is playing, so they always harmonize with the music.

import { bass, fm } from './instruments.js';
import { MODES, PENTATONIC, clamp, finite, midiToHz } from './util.js';

/** Voice limits, minimum retrigger intervals (s) and priorities per effect. */
export const SFX_LIMITS = {
  fire: 6, hit: 6, hitmarker: 4, kill: 4, footstep: 3, pickup: 6, uiHover: 2, uiClick: 3, land: 2, jump: 2, dash: 3, hurt: 2, notePad: 4,
  killBass: 3, discoverBass: 1, levelBass: 1, ultimate: 1, discover: 2, boom: 5, missile: 3,
};
export const SFX_INTERVALS = {
  fire: 0.03, hit: 0.02, hitmarker: 0.025, kill: 0.03, footstep: 0.06, pickup: 0.03, uiHover: 0.04, uiClick: 0.02, hurt: 0.08,
  denied: 0.1, jump: 0.05, land: 0.08, dash: 0.08, gate: 0.1, ultimate: 0.5, discover: 0.5, shieldBreak: 0.2, pulse: 0.15,
  levelUp: 0.3, bossRoar: 0.4, warpStart: 0.3, warpEnd: 0.3, shipBoard: 0.3, shipLand: 0.3, takeoff: 0.3, archiveOpen: 0.2, notePad: 0.02,
  boom: 0.04, missile: 0.08,
};
const PRIORITY = {
  ultimate: 9, discover: 8, bossRoar: 7, levelUp: 7, warpStart: 7, warpEnd: 7, kill: 6, hurt: 6, shieldBreak: 6, pulse: 6,
  boom: 5, hit: 4, missile: 4, fire: 3, hitmarker: 3, footstep: 1, uiHover: 1,
};

export const SFX_NAMES = [
  'fire', 'hit', 'hitmarker', 'kill', 'hurt', 'shieldBreak', 'dash', 'pulse', 'ultimate', 'jump', 'land', 'footstep',
  'discover', 'archiveOpen', 'uiClick', 'uiHover', 'warpStart', 'warpEnd', 'shipBoard', 'shipLand', 'takeoff', 'gate',
  'bossRoar', 'levelUp', 'pickup', 'denied', 'notePad', 'boom', 'missile',
];

/** Per-effect loudness calibration in dB (measured with K-weighted momentary loudness). */
const SFX_GAIN_DB = {
  fire: 1.5, hit: 6, hitmarker: 3, hurt: 3, shieldBreak: 4, dash: 6, jump: 7, footstep: 6, archiveOpen: 3, uiClick: 4,
  uiHover: 6, shipBoard: 2, takeoff: 2, gate: 9, pickup: 7, denied: 4, notePad: -3,
};

const PICKUP_WINDOW = 2.5;

/** Attack then exponential decay (about -43 dB at start + attack + decay). */
function envelope(param, start, attack, decay, level) {
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(level, start + attack);
  param.setTargetAtTime(0, start + attack, decay / 5);
}

function sweepParam(param, from, to, start, duration) {
  param.setValueAtTime(from, start);
  param.exponentialRampToValueAtTime(Math.max(0.01, to), start + Math.max(0.005, duration));
}

export class SfxLibrary {
  /**
   * @param {{ ctx: BaseAudioContext, mixer: import('./mixer.js').Mixer, voices: import('./voices.js').VoiceManager, rng: import('./util.js').Rng, music: import('./music.js').MusicEngine }} deps
   */
  constructor({ ctx, mixer, voices, rng, music }) {
    this.ctx = ctx;
    this.mixer = mixer;
    this.voices = voices;
    this.rng = rng;
    this.music = music;
    this.kit = { ctx, voices, mixer, rng };
    this.footSide = 1;
    this.pickupIndex = -1;
    this.lastPickup = -Infinity;
  }

  /**
   * Plays a named effect. Returns the created voice(s) or null when unknown,
   * rate-limited or out of voices.
   */
  play(name, opts = {}) {
    const method = this[`sfx_${name}`];
    if (typeof method !== 'function') return null;
    const o = {
      volume: clamp(finite(opts.volume, 1), 0, 2) * 10 ** ((SFX_GAIN_DB[name] || 0) / 20),
      pitch: clamp(finite(opts.pitch, 1), 0.25, 4),
      pan: clamp(finite(opts.pan, 0), -1, 1),
      surface: typeof opts.surface === 'string' ? opts.surface : 'rock',
      tier: clamp(Math.round(finite(opts.tier, 1)), 1, 4),
      raw: opts,
    };
    return method.call(this, o, this.ctx.currentTime + 0.005) || null;
  }

  // -- building blocks -------------------------------------------------------

  /** Creates the effect's voice and its bus (volume -> pan -> out, plus reverb sends). */
  begin(tag, t, o, { small = 0, large = 0, volume = 1 } = {}) {
    const voice = this.voices.create(tag, this.mixer.sfxIn, { start: t, priority: PRIORITY[tag] ?? 4 });
    if (!voice) return null;
    const input = voice.gain(volume * o.volume);
    if (o.pan) input.connect(voice.pan(o.pan)).connect(voice.out);
    else input.connect(voice.out);
    if (small) voice.out.connect(voice.gain(small)).connect(this.mixer.sendSmall);
    if (large) voice.out.connect(voice.gain(large)).connect(this.mixer.sendLarge);
    voice.bus = input;
    voice.end = t;
    return voice;
  }

  finish(voice) {
    if (!voice) return null;
    voice.schedule(voice.end + 0.05);
    return voice;
  }

  /** Oscillator layer with optional pitch sweep and filter sweep. */
  tone(voice, { type = 'sine', wave, freq, to, sweep = 0.1, start, attack = 0.002, decay = 0.1, level = 0.2, detune = 0, filter, dest }) {
    const osc = voice.osc(type, freq, { wave, detune, start });
    if (to && to !== freq) sweepParam(osc.frequency, freq, to, start, sweep);
    let node = osc;
    if (filter) {
      const f = voice.filter(filter.type || 'lowpass', filter.freq, filter.q ?? 0.7);
      if (filter.to) sweepParam(f.frequency, filter.freq, filter.to, start, filter.sweep ?? sweep);
      node.connect(f);
      node = f;
    }
    const amp = voice.gain(0);
    node.connect(amp).connect(dest || voice.bus);
    envelope(amp.gain, start, attack, decay, level);
    voice.end = Math.max(voice.end, start + attack + decay * 1.3);
    return { osc, amp };
  }

  /** Filtered noise layer. */
  noise(voice, { color = 'white', start, attack = 0.002, decay = 0.1, level = 0.2, type = 'bandpass', freq = 1000, q = 0.8, to, sweep = 0.1, rate = 1, dest }) {
    const source = voice.buffer(this.mixer.noise[color], { start, offset: this.rng.next() * 1.5, rate });
    const f = voice.filter(type, freq, q);
    if (to) sweepParam(f.frequency, freq, to, start, sweep);
    const amp = voice.gain(0);
    source.connect(f).connect(amp).connect(dest || voice.bus);
    envelope(amp.gain, start, attack, decay, level);
    voice.end = Math.max(voice.end, start + attack + decay * 1.3);
    return { filter: f, amp };
  }

  /** Two-operator FM layer (bells, glass, metal). */
  ping(voice, { freq, ratio = 3.5, index = 1.5, start, attack = 0.002, decay = 0.8, level = 0.08, detune = 0, pan = 0 }) {
    const carrier = voice.osc('sine', freq, { detune, start });
    const modulator = voice.osc('sine', freq * ratio, { start });
    const depth = voice.gain(freq * index);
    depth.gain.setValueAtTime(freq * index, start);
    depth.gain.setTargetAtTime(freq * index * 0.15, start + attack, decay * 0.25);
    modulator.connect(depth).connect(carrier.frequency);
    const amp = voice.gain(0);
    carrier.connect(amp);
    if (pan) amp.connect(voice.pan(pan)).connect(voice.bus);
    else amp.connect(voice.bus);
    envelope(amp.gain, start, attack, decay, level);
    voice.end = Math.max(voice.end, start + attack + decay * 1.3);
  }

  /** Current musical key: tonic pitch class, mode intervals and the sounding chord. */
  key() {
    const key = this.music?.key || { tonic: 38, mode: 'aeolian', chord: null };
    return { pc: ((key.tonic % 12) + 12) % 12, mode: key.mode, intervals: MODES[key.mode] || MODES.aeolian, chord: key.chord };
  }

  /** A MIDI note for pitch class `pc` placed inside [low, low + 11]. */
  static place(pc, low) {
    return low + ((((pc - low) % 12) + 12) % 12);
  }

  // -- combat ----------------------------------------------------------------

  sfx_fire(o, t) {
    const tier = o.tier;
    const r = o.pitch * this.rng.jitter(1, 0.03);
    const voice = this.begin('fire', t, o, { small: tier >= 3 ? 0.18 : 0.08, volume: [0, 1, 1, 0.95, 0.9][tier] });
    if (!voice) return null;
    this.tone(voice, {
      type: 'square', freq: 1250 * r, to: 260 * r, sweep: 0.07, start: t, decay: 0.08 + 0.02 * tier, level: 0.16,
      filter: { type: 'lowpass', freq: 4200, to: 1100, q: 1.2, sweep: 0.08 },
    });
    this.noise(voice, { start: t, decay: 0.02, level: 0.14, type: 'highpass', freq: 2200, q: 0.7 });
    if (tier >= 2) this.tone(voice, { freq: 165 * r, to: 52, sweep: 0.06, start: t, decay: 0.09, level: tier >= 3 ? 0.3 : 0.24 });
    if (tier >= 3) {
      this.tone(voice, {
        type: 'sawtooth', freq: 1875 * r, to: 390 * r, sweep: 0.075, start: t + 0.004, decay: 0.08, level: 0.07, detune: 8,
        filter: { type: 'lowpass', freq: 5200, to: 1400, q: 0.9, sweep: 0.08 },
      });
    }
    if (tier >= 4) {
      this.ping(voice, { freq: 2350 * r, ratio: 1.5, index: 4, start: t, decay: 0.16, level: 0.045 });
      this.noise(voice, { start: t + 0.01, decay: 0.12, level: 0.05, type: 'bandpass', freq: 5200, to: 1800, q: 1.5, sweep: 0.12 });
    }
    return this.finish(voice);
  }

  sfx_hit(o, t) {
    const r = o.pitch * this.rng.jitter(1, 0.05);
    const voice = this.begin('hit', t, o);
    if (!voice) return null;
    this.noise(voice, { start: t, decay: 0.08, level: 0.26, type: 'bandpass', freq: 1400 * r, to: 650 * r, q: 1.1, sweep: 0.08 });
    this.tone(voice, { type: 'square', freq: 240 * r, to: 105 * r, sweep: 0.06, start: t, decay: 0.07, level: 0.1, filter: { freq: 2000, q: 0.7 } });
    this.ping(voice, { freq: 2900 * r, ratio: 1.41, index: 1.5, start: t + 0.003, decay: 0.12, level: 0.04 });
    return this.finish(voice);
  }

  sfx_hitmarker(o, t) {
    const r = o.pitch * this.rng.jitter(1, 0.02);
    const voice = this.begin('hitmarker', t, o);
    if (!voice) return null;
    this.tone(voice, { freq: 3300 * r, to: 2900 * r, sweep: 0.02, start: t, attack: 0.001, decay: 0.03, level: 0.1 });
    this.noise(voice, { start: t, attack: 0.0005, decay: 0.005, level: 0.05, type: 'highpass', freq: 6000 });
    return this.finish(voice);
  }

  sfx_kill(o, t) {
    const voice = this.begin('kill', t, o, { small: 0.15 });
    if (!voice) return null;
    const r = o.pitch * this.rng.jitter(1, 0.03);
    this.tone(voice, { freq: 900 * r, to: 140 * r, sweep: 0.045, start: t, decay: 0.07, level: 0.28 });
    this.noise(voice, { start: t, decay: 0.03, level: 0.16, type: 'bandpass', freq: 2400, q: 0.9 });
    // A short bass note on the chord root (or its fifth), then a high sparkle.
    const key = this.key();
    const rootPc = key.chord ? key.chord.bass % 12 : key.pc;
    const note = SfxLibrary.place(rootPc, 36) + (this.rng.chance(0.35) ? 7 : 0);
    bass(this.kit, this.mixer.sfxBassIn, {
      tag: 'killBass', time: t + 0.012, midi: note, duration: 0.34, velocity: 0.85, level: 0.5 * o.volume, decay: 0.22, brightness: 1.15, pan: o.pan, pop: true,
    });
    this.ping(voice, { freq: midiToHz(note + 36), ratio: 3.5, index: 0.9, start: t + 0.02, decay: 0.5, level: 0.04 });
    return this.finish(voice);
  }

  sfx_hurt(o, t) {
    const voice = this.begin('hurt', t, o);
    if (!voice) return null;
    this.tone(voice, { freq: 95 * o.pitch, to: 48, sweep: 0.12, start: t, attack: 0.003, decay: 0.18, level: 0.42 });
    this.noise(voice, { color: 'pink', start: t, decay: 0.16, level: 0.3, type: 'lowpass', freq: 900, q: 0.8 });
    for (const f of [185, 196]) {
      this.tone(voice, { type: 'square', freq: f * o.pitch, to: f * 0.8 * o.pitch, sweep: 0.14, start: t + 0.01, decay: 0.14, level: 0.06, filter: { freq: 1200, q: 0.8 } });
    }
    this.mixer.duckMusic(0.35, t, { hold: 0.15, release: 0.8 });
    return this.finish(voice);
  }

  sfx_shieldBreak(o, t) {
    const voice = this.begin('shieldBreak', t, o, { small: 0.35 });
    if (!voice) return null;
    for (let i = 0; i < 5; i++) {
      this.ping(voice, {
        freq: this.rng.range(2200, 5200) * o.pitch, ratio: this.rng.pick([1.41, 2.76, 3.5]), index: 2, start: t + this.rng.range(0, 0.06),
        decay: this.rng.range(0.12, 0.45), level: 0.035, pan: this.rng.range(-0.6, 0.6),
      });
    }
    this.noise(voice, { start: t, decay: 0.35, level: 0.18, type: 'highpass', freq: 3000, q: 0.7 });
    this.tone(voice, { type: 'triangle', freq: 700 * o.pitch, to: 140 * o.pitch, sweep: 0.3, start: t, decay: 0.35, level: 0.12 });
    this.mixer.duckMusic(0.25, t, { hold: 0.2, release: 0.8 });
    return this.finish(voice);
  }

  sfx_dash(o, t) {
    const voice = this.begin('dash', t, o);
    if (!voice) return null;
    const pan = voice.pan(o.pan - 0.5);
    if (pan.pan) pan.pan.linearRampToValueAtTime(clamp(o.pan + 0.5, -1, 1), t + 0.3);
    pan.connect(voice.bus);
    const whoosh = this.noise(voice, { color: 'pink', start: t, attack: 0.03, decay: 0.28, level: 0.36, type: 'bandpass', freq: 450 * o.pitch, q: 1.6, dest: pan });
    whoosh.filter.frequency.exponentialRampToValueAtTime(2600 * o.pitch, t + 0.12);
    whoosh.filter.frequency.exponentialRampToValueAtTime(900 * o.pitch, t + 0.3);
    this.tone(voice, { freq: 75, to: 50, sweep: 0.15, start: t, attack: 0.01, decay: 0.16, level: 0.2 });
    return this.finish(voice);
  }

  sfx_pulse(o, t) {
    const voice = this.begin('pulse', t, o, { large: 0.18 });
    if (!voice) return null;
    this.tone(voice, { freq: 120 * o.pitch, to: 36, sweep: 0.45, start: t, attack: 0.004, decay: 0.8, level: 0.5 });
    this.tone(voice, {
      type: 'sawtooth', freq: 110 * o.pitch, to: 41, sweep: 0.5, start: t, attack: 0.004, decay: 0.6, level: 0.22,
      filter: { type: 'lowpass', freq: 1600, to: 90, q: 4, sweep: 0.5 },
    });
    this.noise(voice, { start: t, decay: 0.025, level: 0.22, type: 'highpass', freq: 1500 });
    this.noise(voice, { color: 'pink', start: t, attack: 0.01, decay: 0.5, level: 0.14, type: 'lowpass', freq: 1200, to: 200, sweep: 0.5 });
    this.mixer.duckMusic(0.45, t, { hold: 0.25, release: 1 });
    return this.finish(voice);
  }

  /** Riser for 1.0 s, a sub sweep into the drop, then a boom at t + 1.0 (the game's detonation). */
  sfx_ultimate(o, t) {
    const voice = this.begin('ultimate', t, o, { large: 0.32 });
    if (!voice) return null;
    const drop = t + 1.0;
    // Filtered noise riser.
    this.noise(voice, { color: 'pink', start: t, attack: 1.0, decay: 0.06, level: 0.2, type: 'bandpass', freq: 300, to: 5000, q: 2, sweep: 1.0 });
    // Pitch riser (two detuned saws).
    for (const detune of [-12, 12]) {
      this.tone(voice, {
        type: 'sawtooth', freq: 55 * o.pitch, to: 440 * o.pitch, sweep: 1.0, start: t, attack: 0.98, decay: 0.06, level: 0.07, detune,
        filter: { type: 'lowpass', freq: 400, to: 6000, q: 1, sweep: 1.0 },
      });
    }
    // Sub sweep into the drop.
    this.tone(voice, { freq: 180, to: 28, sweep: 0.75, start: drop - 0.15, attack: 0.15, decay: 1.4, level: 0.55 });
    // Boom.
    this.tone(voice, { freq: 85, to: 30, sweep: 0.4, start: drop, attack: 0.003, decay: 1.6, level: 0.62 });
    this.noise(voice, { color: 'pink', start: drop, attack: 0.003, decay: 1.2, level: 0.36, type: 'lowpass', freq: 1200, to: 200, sweep: 1.2 });
    // Wobbling bass tail ("wub-wub").
    const wub = voice.filter('lowpass', 900, 5);
    const wubAmp = voice.gain(0);
    wub.connect(wubAmp).connect(voice.bus);
    for (const [type, wave] of [['sawtooth', null], ['custom', this.mixer.waves.pulse]]) voice.osc(type, 41.2, { wave, start: drop }).connect(wub);
    wub.frequency.setValueAtTime(900, drop);
    wub.frequency.linearRampToValueAtTime(150, drop + 0.25);
    wub.frequency.linearRampToValueAtTime(700, drop + 0.5);
    wub.frequency.linearRampToValueAtTime(120, drop + 0.85);
    envelope(wubAmp.gain, drop, 0.005, 1.6, 0.16);
    voice.end = Math.max(voice.end, drop + 2.2);
    this.mixer.duckMusic(0.8, t, { attack: 0.2, hold: 1.3, release: 2.5 });
    return this.finish(voice);
  }

  // -- movement --------------------------------------------------------------

  /**
   * Surface texture for footsteps and landings. Every parameter is jittered so
   * no two steps sound alike; `lite` thins the layer for the heel-toe echo.
   */
  surfaceLayer(voice, surface, t, weight = 1, lite = false) {
    const j = (value, amount = 0.12) => this.rng.jitter(value, amount);
    // Soft surfaces are lifted so every surface reads at a similar loudness.
    const surfaceTrim = { grass: 1.8, sand: 2, water: 1.4, rock: 1.2, crystal: 1.1 }[surface] ?? 1;
    const level = weight * surfaceTrim * j(1, 0.2);
    switch (surface) {
      case 'grass':
        this.noise(voice, { color: 'pink', start: t, attack: 0.004, decay: j(0.07), level: 0.1 * level, type: 'bandpass', freq: j(3200, 0.18), q: 0.7 });
        if (!lite) this.noise(voice, { start: t + j(0.015, 0.4), decay: j(0.04), level: 0.035 * level, type: 'bandpass', freq: j(5200, 0.15), q: 1 });
        this.noise(voice, { color: 'brown', start: t, decay: 0.05, level: 0.08 * level, type: 'lowpass', freq: 280 });
        break;
      case 'sand': {
        const grains = lite ? 2 : this.rng.int(3, 5);
        for (let i = 0; i < grains; i++) {
          this.noise(voice, {
            start: t + this.rng.range(0, 0.07), attack: 0.001, decay: this.rng.range(0.015, 0.03), level: this.rng.range(0.035, 0.06) * level,
            type: 'bandpass', freq: this.rng.range(2200, 3800), q: 1.2,
          });
        }
        this.noise(voice, { color: 'brown', start: t, decay: 0.06, level: 0.07 * level, type: 'lowpass', freq: 220 });
        break;
      }
      case 'crystal': {
        const key = this.key();
        const pent = PENTATONIC[key.mode] || PENTATONIC.aeolian;
        const midi = SfxLibrary.place(key.pc, 84) + this.rng.pick(pent);
        this.ping(voice, { freq: midiToHz(midi), ratio: 3.5, index: 0.8, start: t + 0.004, decay: j(0.22), level: 0.03 * level });
        this.noise(voice, { start: t, decay: 0.02, level: 0.05 * level, type: 'bandpass', freq: j(3000), q: 1.4 });
        if (!lite) this.noise(voice, { color: 'brown', start: t, decay: 0.04, level: 0.05 * level, type: 'lowpass', freq: 300 });
        break;
      }
      case 'metal': {
        const f0 = this.rng.range(320, 480);
        const partials = lite ? [[1, 0.05, 0.12], [2.76, 0.03, 0.08]] : [[1, 0.05, 0.14], [2.76, 0.035, 0.09], [5.4, 0.02, 0.06]];
        for (const [ratio, partLevel, decay] of partials) {
          this.tone(voice, { freq: f0 * ratio, start: t, attack: 0.001, decay: j(decay), level: partLevel * level });
        }
        this.noise(voice, { start: t, attack: 0.0005, decay: 0.01, level: 0.05 * level, type: 'highpass', freq: 3000 });
        if (!lite) this.tone(voice, { freq: 150, to: 90, sweep: 0.04, start: t, decay: 0.04, level: 0.05 * level });
        break;
      }
      case 'water': {
        this.noise(voice, { start: t, attack: 0.008, decay: j(0.12), level: 0.08 * level, type: 'bandpass', freq: j(900), to: j(2400), q: 1, sweep: 0.1 });
        const bubbles = lite ? 1 : this.rng.int(1, 2);
        for (let i = 0; i < bubbles; i++) {
          const f = this.rng.range(350, 700);
          this.tone(voice, { freq: f, to: f * 1.8, sweep: 0.03, start: t + this.rng.range(0.02, 0.06), attack: 0.002, decay: 0.04, level: 0.035 * level });
        }
        break;
      }
      default: // rock
        this.noise(voice, { start: t, attack: 0.001, decay: j(0.04), level: 0.09 * level, type: 'bandpass', freq: j(1500, 0.15), q: 1.6 });
        this.tone(voice, { freq: j(190, 0.13), to: 120, sweep: 0.04, start: t, attack: 0.001, decay: 0.04, level: 0.06 * level });
        if (!lite) this.noise(voice, { start: t + 0.003, attack: 0.0005, decay: 0.015, level: 0.03 * level, type: 'highpass', freq: 4000 });
    }
  }

  sfx_footstep(o, t) {
    this.footSide = -this.footSide;
    const pan = clamp(o.pan + this.footSide * this.rng.range(0.04, 0.1), -1, 1);
    const voice = this.begin('footstep', t, { ...o, pan }, { volume: this.rng.range(0.75, 1) });
    if (!voice) return null;
    this.surfaceLayer(voice, o.surface, t, 1);
    if (this.rng.chance(0.35)) this.surfaceLayer(voice, o.surface, t + this.rng.range(0.018, 0.03), 0.45, true);
    return this.finish(voice);
  }

  sfx_jump(o, t) {
    const voice = this.begin('jump', t, o);
    if (!voice) return null;
    this.noise(voice, { color: 'pink', start: t, attack: 0.01, decay: 0.13, level: 0.14, type: 'bandpass', freq: 600, to: 1800, q: 1.2, sweep: 0.12 });
    this.tone(voice, { freq: 230 * o.pitch, to: 360 * o.pitch, sweep: 0.08, start: t, attack: 0.004, decay: 0.09, level: 0.08 });
    return this.finish(voice);
  }

  sfx_land(o, t) {
    const voice = this.begin('land', t, o, { small: 0.12 });
    if (!voice) return null;
    this.tone(voice, { freq: 130, to: 52, sweep: 0.09, start: t, decay: 0.14, level: 0.32 });
    this.noise(voice, { color: 'brown', start: t, decay: 0.12, level: 0.18, type: 'lowpass', freq: 500 });
    this.surfaceLayer(voice, o.surface, t, 1.8);
    return this.finish(voice);
  }

  // -- musical stings --------------------------------------------------------

  /** "You found a memory": bass root, then bells on the 5th, 9th, 6th and octave. */
  sfx_discover(o, t) {
    const voice = this.begin('discover', t, o, { large: 0.45 });
    if (!voice) return null;
    const key = this.key();
    const base = SfxLibrary.place(key.pc, 67);
    const motif = [base + 7, base + 12 + key.intervals[1], base + key.intervals[5], base + 12];
    const times = [0, 0.2, 0.4, 0.62];
    const pans = [-0.3, 0.2, -0.1, 0.25];
    motif.forEach((midi, i) => {
      this.ping(voice, { freq: midiToHz(midi), ratio: 3.5, index: 1.1, start: t + times[i], decay: i === 3 ? 3.2 : 1.6, level: i === 3 ? 0.075 : 0.065, pan: pans[i] });
    });
    this.ping(voice, { freq: midiToHz(base + 24), ratio: 2, index: 0.5, start: t + 0.64, decay: 2.4, level: 0.025, detune: 6 });
    bass(this.kit, this.mixer.sfxBassIn, {
      tag: 'discoverBass', time: t, midi: SfxLibrary.place(key.pc, 36), duration: 1.6, velocity: 0.8, level: 0.48 * o.volume, decay: 0.7, brightness: 0.9, sub: 0.6, pan: o.pan,
    });
    this.mixer.duckMusic(0.45, t, { attack: 0.06, hold: 1.4, release: 1.6 });
    return this.finish(voice);
  }

  sfx_archiveOpen(o, t) {
    const voice = this.begin('archiveOpen', t, o, { large: 0.35 });
    if (!voice) return null;
    const key = this.key();
    this.noise(voice, { color: 'pink', start: t, attack: 0.25, decay: 0.5, level: 0.09, type: 'bandpass', freq: 1200, to: 3000, q: 0.8, sweep: 0.5 });
    const root = SfxLibrary.place(key.pc, 60);
    [root, root + 7, root + 14].forEach((midi, i) => {
      this.ping(voice, { freq: midiToHz(midi), ratio: 1, index: 1.2, start: t + 0.05 + i * 0.045, attack: 0.004, decay: 1.4, level: 0.05, pan: (i - 1) * 0.35 });
    });
    this.tone(voice, { freq: midiToHz(SfxLibrary.place(key.pc, 36)), start: t, attack: 0.2, decay: 0.6, level: 0.12 });
    return this.finish(voice);
  }

  sfx_levelUp(o, t) {
    const voice = this.begin('levelUp', t, o, { large: 0.3 });
    if (!voice) return null;
    const key = this.key();
    const base = SfxLibrary.place(key.pc, 72);
    [0, 7, 12, 19].forEach((interval, i) => {
      this.ping(voice, { freq: midiToHz(base + interval), ratio: 3.5, index: 1, start: t + i * 0.09, decay: 1, level: 0.06, pan: -0.3 + i * 0.2 });
    });
    [24, 31].forEach((interval, i) => {
      this.ping(voice, { freq: midiToHz(base + interval), ratio: 2, index: 0.6, start: t + 0.36 + i * 0.01, decay: 1.6, level: 0.035, detune: i ? 7 : -7 });
    });
    this.noise(voice, { start: t, attack: 0.3, decay: 0.08, level: 0.06, type: 'highpass', freq: 2000, to: 8000, sweep: 0.35 });
    bass(this.kit, this.mixer.sfxBassIn, {
      tag: 'levelBass', time: t, midi: SfxLibrary.place(key.pc, 36), duration: 0.8, velocity: 0.85, level: 0.45 * o.volume, decay: 0.45, brightness: 1, pan: o.pan,
    });
    this.mixer.duckMusic(0.35, t, { hold: 0.6, release: 1.2 });
    return this.finish(voice);
  }

  /** Resonance shard: a shimmering bell; quick successive pickups climb a pentatonic scale. */
  sfx_pickup(o, t) {
    const voice = this.begin('pickup', t, o, { small: 0.25 });
    if (!voice) return null;
    this.pickupIndex = t - this.lastPickup < PICKUP_WINDOW ? Math.min(this.pickupIndex + 1, 9) : 0;
    this.lastPickup = t;
    const key = this.key();
    const pent = PENTATONIC[key.mode] || PENTATONIC.aeolian;
    const midi = SfxLibrary.place(key.pc, 72) + pent[this.pickupIndex % 5] + 12 * Math.floor(this.pickupIndex / 5);
    this.ping(voice, { freq: midiToHz(midi) * o.pitch, ratio: 3.5, index: 1.2, start: t, decay: 0.9, level: 0.085 });
    this.ping(voice, { freq: midiToHz(midi + 12) * o.pitch, ratio: 2, index: 0.6, start: t + 0.012, decay: 0.6, level: 0.035, detune: 7 });
    return this.finish(voice);
  }

  /** Stage pad: a warm, fingered electric-bass pluck at MIDI note `opts.pitch`. */
  sfx_notePad(o, t) {
    const midi = clamp(Math.round(finite(o.raw.pitch, 40)), 24, 72);
    return bass(this.kit, this.mixer.sfxBassIn, {
      tag: 'notePad', priority: 5, time: t, midi, duration: 1.25, velocity: clamp(finite(o.raw.velocity, 0.85), 0.2, 1), level: 0.55 * o.volume,
      decay: 0.32, brightness: 1, sub: 0.55, pan: o.pan, release: 0.08,
    });
  }

  // -- travel ----------------------------------------------------------------

  sfx_warpStart(o, t) {
    const voice = this.begin('warpStart', t, o, { large: 0.3 });
    if (!voice) return null;
    for (const detune of [-10, 10]) {
      this.tone(voice, {
        type: 'sawtooth', freq: 70, to: 900, sweep: 1.3, start: t, attack: 1.3, decay: 0.12, level: 0.06, detune,
        filter: { type: 'lowpass', freq: 300, to: 7000, q: 1, sweep: 1.3 },
      });
    }
    this.noise(voice, { start: t, attack: 1.25, decay: 0.15, level: 0.12, type: 'highpass', freq: 200, to: 4000, q: 0.7, sweep: 1.3 });
    this.ping(voice, { freq: 1760, ratio: 2.01, index: 3, start: t + 0.6, attack: 0.7, decay: 0.3, level: 0.03 });
    this.mixer.duckMusic(0.6, t, { attack: 0.4, hold: 1, release: 1.5 });
    return this.finish(voice);
  }

  sfx_warpEnd(o, t) {
    const voice = this.begin('warpEnd', t, o, { large: 0.45 });
    if (!voice) return null;
    this.tone(voice, { freq: 90, to: 38, sweep: 0.5, start: t, decay: 1.2, level: 0.42 });
    this.noise(voice, { color: 'pink', start: t, decay: 1, level: 0.2, type: 'lowpass', freq: 2000, to: 300, sweep: 1 });
    const root = SfxLibrary.place(this.key().pc, 72);
    [root, root + 7, root + 14].forEach((midi, i) => {
      this.ping(voice, { freq: midiToHz(midi), ratio: 3.5, index: 1, start: t + 0.05 + i * 0.02, decay: 2.5, level: 0.045, pan: (i - 1) * 0.4 });
    });
    return this.finish(voice);
  }

  sfx_shipBoard(o, t) {
    const voice = this.begin('shipBoard', t, o, { small: 0.3 });
    if (!voice) return null;
    for (const delay of [0, 0.11]) this.tone(voice, { freq: 120, to: 60, sweep: 0.08, start: t + delay, decay: 0.08, level: 0.28 });
    [1, 2.76].forEach((ratio, i) => this.tone(voice, { freq: 520 * ratio, start: t + 0.002, attack: 0.001, decay: 0.25 - i * 0.08, level: 0.04 - i * 0.015 }));
    this.noise(voice, { start: t + 0.12, attack: 0.02, decay: 0.45, level: 0.07, type: 'highpass', freq: 3500 });
    this.tone(voice, { freq: 300, to: 620, sweep: 0.25, start: t + 0.3, attack: 0.01, decay: 0.3, level: 0.07 });
    return this.finish(voice);
  }

  sfx_shipLand(o, t) {
    const voice = this.begin('shipLand', t, o, { small: 0.25 });
    if (!voice) return null;
    this.tone(voice, { freq: 100, to: 45, sweep: 0.2, start: t, decay: 0.25, level: 0.42 });
    this.noise(voice, { color: 'brown', start: t, decay: 0.2, level: 0.22, type: 'lowpass', freq: 600 });
    this.noise(voice, { start: t + 0.1, attack: 0.05, decay: 0.6, level: 0.07, type: 'bandpass', freq: 2500, to: 1200, q: 0.9, sweep: 0.5 });
    this.tone(voice, { freq: 600, to: 180, sweep: 0.5, start: t + 0.25, attack: 0.02, decay: 0.5, level: 0.05 });
    return this.finish(voice);
  }

  sfx_takeoff(o, t) {
    const voice = this.begin('takeoff', t, o, { small: 0.2 });
    if (!voice) return null;
    this.tone(voice, { freq: 80, to: 40, sweep: 0.2, start: t, decay: 0.2, level: 0.28 });
    this.tone(voice, {
      type: 'sawtooth', freq: 45, to: 140, sweep: 1.4, start: t, attack: 1.2, decay: 0.7, level: 0.12, filter: { freq: 200, to: 2200, q: 1.2, sweep: 1.4 },
    });
    this.noise(voice, { color: 'pink', start: t, attack: 1.1, decay: 0.8, level: 0.16, type: 'lowpass', freq: 400, to: 3000, q: 0.8, sweep: 1.4 });
    return this.finish(voice);
  }

  /** Boost ring: whoosh plus a bright two-bell "shing" in the current key. */
  sfx_gate(o, t) {
    const voice = this.begin('gate', t, o, { small: 0.3 });
    if (!voice) return null;
    const base = SfxLibrary.place(this.key().pc, 79);
    this.noise(voice, { start: t, attack: 0.02, decay: 0.35, level: 0.16, type: 'bandpass', freq: 800, to: 4000, q: 1.4, sweep: 0.25 });
    this.ping(voice, { freq: midiToHz(base) * o.pitch, ratio: 3.5, index: 1, start: t + 0.03, decay: 0.9, level: 0.06, pan: -0.25 });
    this.ping(voice, { freq: midiToHz(base + 7) * o.pitch, ratio: 3.5, index: 1, start: t + 0.07, decay: 0.9, level: 0.055, pan: 0.25 });
    this.tone(voice, { freq: 600, to: 1200, sweep: 0.2, start: t, attack: 0.02, decay: 0.25, level: 0.05 });
    return this.finish(voice);
  }

  /** Explosion in space: a sub thump, a falling roar of filtered noise and a crackle. */
  sfx_boom(o, t) {
    const voice = this.begin('boom', t, o, { large: 0.22 });
    if (!voice) return null;
    const p = o.pitch * this.rng.jitter(1, 0.06);
    this.tone(voice, { freq: 120 * p, to: 32 * p, sweep: 0.35, start: t, attack: 0.002, decay: 0.7, level: 0.5 });
    this.noise(voice, { color: 'pink', start: t, attack: 0.002, decay: 0.6, level: 0.32, type: 'lowpass', freq: 2400 * p, to: 240, sweep: 0.5 });
    this.noise(voice, { start: t + 0.01, decay: 0.12, level: 0.12, type: 'bandpass', freq: 3200 * p, q: 0.7 });
    return this.finish(voice);
  }

  /** Missile launch: a rising whoosh with a hint of tone. */
  sfx_missile(o, t) {
    const voice = this.begin('missile', t, o);
    if (!voice) return null;
    this.noise(voice, { color: 'pink', start: t, attack: 0.01, decay: 0.45, level: 0.3, type: 'bandpass', freq: 600 * o.pitch, to: 3200 * o.pitch, q: 1.2, sweep: 0.4 });
    this.tone(voice, { type: 'triangle', freq: 300 * o.pitch, to: 900 * o.pitch, sweep: 0.3, start: t, attack: 0.01, decay: 0.3, level: 0.07 });
    return this.finish(voice);
  }

  // -- creatures and UI ------------------------------------------------------

  /** Warden roar: detuned saws through vowel formants with a fast tremolo and a rumble. */
  sfx_bossRoar(o, t) {
    const voice = this.begin('bossRoar', t, o, { large: 0.25 });
    if (!voice) return null;
    const lowpass = voice.filter('lowpass', 1800, 0.7);
    const formants = voice.gain(1);
    const tremolo = voice.gain(0.6);
    const amp = voice.gain(0);
    for (const [freq, q] of [[700, 3], [1150, 4]]) lowpass.connect(voice.filter('bandpass', freq, q)).connect(formants);
    lowpass.connect(voice.gain(0.5)).connect(formants);
    formants.connect(tremolo).connect(amp).connect(voice.bus);
    for (const freq of [55, 58.3]) {
      const osc = voice.osc('sawtooth', freq * o.pitch, { start: t });
      sweepParam(osc.frequency, freq * o.pitch, 42 * o.pitch, t, 1.4);
      osc.connect(lowpass);
    }
    const lfo = voice.osc('sine', 17, { start: t });
    lfo.connect(voice.gain(0.4)).connect(tremolo.gain);
    envelope(amp.gain, t, 0.12, 1.5, 0.55);
    voice.end = Math.max(voice.end, t + 2.1);
    this.noise(voice, { color: 'brown', start: t, attack: 0.1, decay: 1.4, level: 0.15, type: 'lowpass', freq: 300 });
    this.mixer.duckMusic(0.5, t, { hold: 1, release: 1.2 });
    return this.finish(voice);
  }

  sfx_uiClick(o, t) {
    const voice = this.begin('uiClick', t, o);
    if (!voice) return null;
    this.tone(voice, { freq: 1900 * o.pitch, start: t, attack: 0.001, decay: 0.028, level: 0.1 });
    this.noise(voice, { start: t, attack: 0.0005, decay: 0.004, level: 0.06, type: 'highpass', freq: 5000 });
    return this.finish(voice);
  }

  sfx_uiHover(o, t) {
    const voice = this.begin('uiHover', t, o);
    if (!voice) return null;
    this.tone(voice, { freq: 2600 * o.pitch, start: t, attack: 0.002, decay: 0.018, level: 0.02 });
    return this.finish(voice);
  }

  sfx_denied(o, t) {
    const voice = this.begin('denied', t, o);
    if (!voice) return null;
    this.tone(voice, { type: 'triangle', freq: 520 * o.pitch, start: t, attack: 0.004, decay: 0.07, level: 0.09, filter: { freq: 2000 } });
    this.tone(voice, { type: 'triangle', freq: 390 * o.pitch, start: t + 0.085, attack: 0.004, decay: 0.1, level: 0.09, filter: { freq: 2000 } });
    return this.finish(voice);
  }
}
