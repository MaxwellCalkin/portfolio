// The mixing desk: buses, generated-impulse reverbs, the master dynamics chain
// and shared resources (noise buffers, periodic waves).
//
//   music stems ─▶ musicIn ─▶ scene ─▶ duck ─▶ night tone ─┐
//   music wet sends ─▶ musicWetIn ─▶ sceneWet ─▶ large reverb ─┤
//   sfx voices ─▶ sfxIn ───────────────────────────────────────┤
//   sfx sends ─▶ small / large reverb ─────────────────────────┤
//                                                              ▼
//        bus ─▶ high-pass 30 Hz ─▶ glue compressor ─▶ limiter ─▶ master ─▶ out

import { Rng, clamp, finite, lerp } from './util.js';

const NOISE_SECONDS = 2;
/** Bus trims: the music sits well under the effects and under the compressor thresholds. */
export const MUSIC_TRIM = 0.375;
export const SFX_TRIM = 1;

/** Generates a stereo decaying-noise impulse with progressive high-frequency damping. */
export function createImpulse(ctx, { duration, decay, predelay = 0, brightness = 0.55, early = [], seed = 1 }) {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * duration));
  const buffer = ctx.createBuffer(2, length, rate);
  const rng = new Rng(seed);
  const pre = Math.floor(predelay * rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let smoothed = 0;
    for (let i = pre; i < length; i++) {
      const t = (i - pre) / rate;
      const envelope = Math.exp((-6.9 * t) / decay);
      const fadeIn = Math.min(1, t / 0.004);
      const coefficient = 0.04 + brightness * Math.exp(-t * 2.4);
      smoothed += coefficient * (rng.next() * 2 - 1 - smoothed);
      data[i] = smoothed * envelope * fadeIn;
    }
    for (const [time, amount] of early) {
      const index = pre + Math.floor((time + channel * 0.0037) * rate);
      if (index < length) data[index] += amount * (rng.chance(0.5) ? 1 : -1);
    }
  }
  return buffer;
}

function createNoiseBuffer(ctx, color, seed) {
  const length = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rng = new Rng(seed);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, brown = 0;
  for (let i = 0; i < length; i++) {
    const white = rng.next() * 2 - 1;
    if (color === 'white') {
      data[i] = white;
    } else if (color === 'pink') {
      // Paul Kellet's refined pink filter.
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    } else {
      brown = (brown + 0.02 * white) / 1.02;
      data[i] = brown * 3.5;
    }
  }
  return buffer;
}

/** Fourier series of a pulse wave with the given duty cycle. */
function createPulseWave(ctx, duty, harmonics = 48) {
  const real = new Float32Array(harmonics);
  const imag = new Float32Array(harmonics);
  for (let n = 1; n < harmonics; n++) real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
  return ctx.createPeriodicWave(real, imag);
}

/** Soft, rounded saw-like wave for pads (harmonics fall off faster than a saw). */
function createWarmWave(ctx, harmonics = 32) {
  const real = new Float32Array(harmonics);
  const imag = new Float32Array(harmonics);
  for (let n = 1; n < harmonics; n++) imag[n] = (n === 2 ? 1.25 : n === 3 ? 1.1 : 1) / n ** 1.7;
  return ctx.createPeriodicWave(real, imag);
}

/**
 * Gentle tanh saturation for bass warmth. Unity gain for small signals, so it
 * only rounds off (and adds harmonics to) the loudest plucks.
 */
function createSaturationCurve(drive = 1.4, size = 1024) {
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / drive;
  }
  return curve;
}

export class Mixer {
  /**
   * @param {BaseAudioContext} ctx
   * @param {{ seed?: number }} options
   */
  constructor(ctx, { seed = 1 } = {}) {
    this.ctx = ctx;
    this.nodes = [];
    const t = ctx.currentTime;
    const node = (created) => {
      this.nodes.push(created);
      return created;
    };

    // Master chain.
    this.master = node(ctx.createGain());
    // Intrinsic value (not just an automation event), so a later
    // cancelScheduledValues() can never fall back to the default gain of 1.
    this.master.gain.value = 0;
    this.limiter = node(ctx.createDynamicsCompressor());
    this.glue = node(ctx.createDynamicsCompressor());
    this.subFilter = node(ctx.createBiquadFilter());
    this.bus = node(ctx.createGain());
    this.configureDynamics(t);
    this.subFilter.type = 'highpass';
    this.subFilter.frequency.setValueAtTime(30, t);
    this.subFilter.Q.setValueAtTime(0.707, t);
    this.bus.connect(this.subFilter);
    this.subFilter.connect(this.glue);
    this.glue.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(ctx.destination);

    // Reverbs.
    this.reverbSmall = node(ctx.createConvolver());
    this.reverbSmall.buffer = createImpulse(ctx, {
      duration: 1.0, decay: 0.75, predelay: 0.004, brightness: 0.6, seed: seed + 11,
      early: [[0.011, 0.5], [0.019, 0.35], [0.027, 0.28], [0.041, 0.2]],
    });
    this.reverbLarge = node(ctx.createConvolver());
    this.reverbLarge.buffer = createImpulse(ctx, {
      duration: 3.4, decay: 3.0, predelay: 0.024, brightness: 0.42, seed: seed + 23,
    });
    this.smallReturn = node(ctx.createGain());
    this.smallReturn.gain.setValueAtTime(0.5, t);
    this.largeReturn = node(ctx.createGain());
    this.largeReturn.gain.setValueAtTime(0.55, t);
    this.reverbSmall.connect(this.smallReturn).connect(this.bus);
    this.reverbLarge.connect(this.largeReturn).connect(this.bus);
    this.sendSmall = node(ctx.createGain());
    this.sendLarge = node(ctx.createGain());
    this.sendSmall.connect(this.reverbSmall);
    this.sendLarge.connect(this.reverbLarge);

    // Music bus: scene level (reading duck, enable), transient SFX duck, night tone.
    this.musicIn = node(ctx.createGain());
    this.musicIn.gain.setValueAtTime(MUSIC_TRIM, t);
    this.musicScene = node(ctx.createGain());
    this.musicDuck = node(ctx.createGain());
    this.musicTone = node(ctx.createBiquadFilter());
    this.musicTone.type = 'lowpass';
    this.musicTone.frequency.setValueAtTime(16000, t);
    this.musicTone.Q.setValueAtTime(0.5, t);
    this.musicIn.connect(this.musicScene).connect(this.musicDuck).connect(this.musicTone).connect(this.bus);
    this.musicWetIn = node(ctx.createGain());
    this.musicWetIn.gain.setValueAtTime(MUSIC_TRIM, t);
    this.musicSceneWet = node(ctx.createGain());
    this.musicWetIn.connect(this.musicSceneWet).connect(this.sendLarge);

    // SFX bus (always above the music).
    this.sfxIn = node(ctx.createGain());
    this.sfxIn.gain.setValueAtTime(SFX_TRIM, t);
    this.sfxIn.connect(this.bus);
    this.sfxBassIn = this.createBassBody(this.sfxIn, node, { send: this.sendSmall, sendLevel: 0.22 });

    // Shared resources.
    this.noise = {
      white: createNoiseBuffer(ctx, 'white', seed + 1),
      pink: createNoiseBuffer(ctx, 'pink', seed + 2),
      brown: createNoiseBuffer(ctx, 'brown', seed + 3),
    };
    this.waves = {
      pulse: createPulseWave(ctx, 0.3),
      narrow: createPulseWave(ctx, 0.18),
      warm: createWarmWave(ctx),
    };
    this.lastScene = { level: -1, tone: -1 };
  }

  configureDynamics(t) {
    const set = (param, value) => param.setValueAtTime(value, t);
    set(this.glue.threshold, -12);
    set(this.glue.knee, 10);
    set(this.glue.ratio, 1.8);
    set(this.glue.attack, 0.015);
    set(this.glue.release, 0.25);
    set(this.limiter.threshold, -3);
    set(this.limiter.knee, 0);
    set(this.limiter.ratio, 20);
    set(this.limiter.attack, 0.001);
    set(this.limiter.release, 0.08);
  }

  /**
   * Electric-bass "body": low resonance, finger growl, tamed top, light saturation.
   * @param {AudioNode} destination
   * @param {(node: AudioNode) => AudioNode} node registers created nodes with their owner
   * @param {{ send?: AudioNode, sendLevel?: number }} [options] optional reverb send
   * @returns {AudioNode} the chain's input
   */
  createBassBody(destination, node, { send = null, sendLevel = 0 } = {}) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const input = node(ctx.createGain());
    const low = node(ctx.createBiquadFilter());
    low.type = 'peaking';
    low.frequency.setValueAtTime(105, t);
    low.Q.setValueAtTime(0.9, t);
    low.gain.setValueAtTime(3, t);
    const growl = node(ctx.createBiquadFilter());
    growl.type = 'peaking';
    growl.frequency.setValueAtTime(760, t);
    growl.Q.setValueAtTime(1.3, t);
    growl.gain.setValueAtTime(2.5, t);
    const top = node(ctx.createBiquadFilter());
    top.type = 'highshelf';
    top.frequency.setValueAtTime(3000, t);
    top.gain.setValueAtTime(-5, t);
    const warmth = node(ctx.createWaveShaper());
    warmth.curve = createSaturationCurve(1.4);
    warmth.oversample = '2x';
    const trim = node(ctx.createGain());
    trim.gain.setValueAtTime(0.9, t);
    input.connect(low).connect(growl).connect(top).connect(warmth).connect(trim).connect(destination);
    if (send && sendLevel > 0) {
      const sendGain = node(ctx.createGain());
      sendGain.gain.setValueAtTime(sendLevel, t);
      trim.connect(sendGain).connect(send);
    }
    return input;
  }

  /**
   * Music level from the scene (reading duck etc.), applied to dry and wet paths.
   * Gated so repeated identical calls add no automation events.
   */
  setMusicLevel(level, time, timeConstant = 0.6) {
    const value = clamp(finite(level), 0, 1.5);
    if (Math.abs(value - this.lastScene.level) < 0.005) return;
    this.lastScene.level = value;
    this.musicScene.gain.setTargetAtTime(value, time, timeConstant);
    this.musicSceneWet.gain.setTargetAtTime(value, time, timeConstant);
  }

  /** Night (0..1) darkens the music through the bus low-pass. */
  setNight(night, time) {
    const cutoff = lerp(16000, 2600, clamp(finite(night), 0, 1) ** 0.8);
    if (Math.abs(cutoff - this.lastScene.tone) < 60) return;
    this.lastScene.tone = cutoff;
    this.musicTone.frequency.setTargetAtTime(cutoff, time, 1.2);
  }

  /** Brief "sidechain" dip so a big sound effect reads clearly over the music. */
  duckMusic(depth, time, { attack = 0.03, hold = 0.25, release = 1.2 } = {}) {
    const floor = clamp(1 - depth, 0.05, 1);
    const holdEnd = time + attack + hold;
    // A deeper duck that is still holding wins over a shallower request.
    if (this.duck && time < this.duck.holdEnd && floor >= this.duck.floor && holdEnd <= this.duck.holdEnd) return;
    const param = this.musicDuck.gain;
    param.cancelScheduledValues(time);
    param.setTargetAtTime(floor, time, attack / 3);
    param.setTargetAtTime(1, holdEnd, release / 3);
    this.duck = { floor, holdEnd };
  }

  dispose() {
    for (const created of this.nodes) {
      try {
        created.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.nodes.length = 0;
  }
}
