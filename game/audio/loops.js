// Continuous sounds: jetpack, ship engine, boost and ultimate charge. Each loop
// builds its nodes on first activation, follows its parameters smoothly (with
// change thresholds so per-frame calls add no automation spam), fades out when
// deactivated and tears its nodes down shortly afterwards to save CPU.

import { clamp, finite, smoothstep } from './util.js';

const TEARDOWN_DELAY = 1.2;

/** Smoothly moves a param when the target changed by more than `epsilon`. */
function follow(loop, key, param, value, time, timeConstant, epsilon) {
  const last = loop.applied[key];
  if (last !== undefined && Math.abs(last - value) < epsilon) return;
  loop.applied[key] = value;
  param.setTargetAtTime(value, time, timeConstant);
}

const DEFINITIONS = {
  jetpack: {
    fadeIn: 0.04,
    fadeOut: 0.12,
    build(loop) {
      const flutter = loop.gain(0.75);
      const band = loop.filter('bandpass', 900, 0.9);
      const top = loop.filter('lowpass', 3200, 0.7);
      loop.noise('pink').connect(band).connect(top).connect(flutter).connect(loop.out);
      const lfo = loop.osc('sine', 23);
      lfo.connect(loop.gain(0.22)).connect(flutter.gain);
      loop.osc('sine', 62).connect(loop.gain(0.35)).connect(loop.out);
      loop.refs = { band };
    },
    level(params) {
      return 0.08 + 0.06 * clamp(finite(params.thrust ?? params.intensity, 1), 0, 1);
    },
    update(loop, params, time) {
      const thrust = clamp(finite(params.thrust ?? params.intensity, 1), 0, 1);
      follow(loop, 'band', loop.refs.band.frequency, 700 + 600 * thrust, time, 0.08, 10);
    },
  },

  engine: {
    fadeIn: 0.3,
    fadeOut: 0.4,
    build(loop) {
      const body = loop.filter('lowpass', 300, 2);
      const sawA = loop.osc('sawtooth', 40);
      const sawB = loop.osc('sawtooth', 40.2);
      const sub = loop.osc('sine', 20);
      sawA.connect(body);
      sawB.connect(body);
      body.connect(loop.gain(0.5)).connect(loop.out);
      sub.connect(loop.gain(0.6)).connect(loop.out);
      const airBand = loop.filter('bandpass', 600, 0.6);
      const airGain = loop.gain(0);
      loop.noise('pink').connect(airBand).connect(airGain).connect(loop.out);
      loop.refs = { body, sawA, sawB, sub, airBand, airGain };
    },
    level(params) {
      return 0.08 + 0.07 * clamp(finite(params.throttle, 0), 0, 1);
    },
    update(loop, params, time) {
      const throttle = clamp(finite(params.throttle, 0), 0, 1);
      const speed = Math.abs(finite(params.speed, 0));
      const { body, sawA, sawB, sub, airBand, airGain } = loop.refs;
      const pitch = 38 + 34 * throttle + 9 * Math.log10(1 + speed / 10);
      follow(loop, 'sawA', sawA.frequency, pitch, time, 0.15, 0.3);
      follow(loop, 'sawB', sawB.frequency, pitch * 1.006, time, 0.15, 0.3);
      follow(loop, 'sub', sub.frequency, pitch / 2, time, 0.15, 0.2);
      follow(loop, 'body', body.frequency, 180 + 1400 * throttle + 300 * smoothstep(0, 7200, speed), time, 0.15, 15);
      follow(loop, 'air', airGain.gain, 0.12 * smoothstep(20, 2400, speed), time, 0.3, 0.004);
      follow(loop, 'airBand', airBand.frequency, 500 + 1500 * smoothstep(0, 7200, speed), time, 0.3, 20);
    },
  },

  boost: {
    fadeIn: 0.03,
    fadeOut: 0.12,
    build(loop) {
      const top = loop.filter('lowpass', 2600, 0.7);
      const band = loop.filter('bandpass', 1400, 0.8);
      loop.noise('pink').connect(top).connect(band).connect(loop.out);
      const whine = loop.osc('sine', 900);
      whine.connect(loop.gain(0.25)).connect(loop.out);
      loop.osc('sine', 55).connect(loop.gain(0.4)).connect(loop.out);
      loop.refs = { whine };
    },
    level() {
      return 0.16;
    },
    onStart(loop, time) {
      const { frequency } = loop.refs.whine;
      frequency.cancelScheduledValues(time);
      frequency.setValueAtTime(900, time);
      frequency.exponentialRampToValueAtTime(1400, time + 0.6);
    },
    update() {},
  },

  charge: {
    fadeIn: 0.05,
    fadeOut: 0.15,
    build(loop) {
      const tone = loop.osc('triangle', 220);
      const modulator = loop.osc('sine', 440);
      const depth = loop.gain(130);
      modulator.connect(depth).connect(tone.frequency);
      const tremolo = loop.gain(0.7);
      const lfo = loop.osc('sine', 4);
      lfo.connect(loop.gain(0.3)).connect(tremolo.gain);
      tone.connect(tremolo).connect(loop.out);
      const sub = loop.osc('sine', 55);
      const subGain = loop.gain(0);
      sub.connect(subGain).connect(loop.out);
      loop.refs = { tone, modulator, depth, lfo, sub, subGain };
    },
    level(params) {
      return 0.035 + 0.08 * clamp(finite(params.amount, 0), 0, 1);
    },
    update(loop, params, time) {
      const amount = clamp(finite(params.amount, 0), 0, 1);
      const { tone, modulator, depth, lfo, sub, subGain } = loop.refs;
      const pitch = 220 * 2 ** (2 * amount);
      follow(loop, 'tone', tone.frequency, pitch, time, 0.05, 0.5);
      follow(loop, 'mod', modulator.frequency, pitch * 2, time, 0.05, 1);
      follow(loop, 'depth', depth.gain, pitch * (0.4 + 0.8 * amount), time, 0.05, 1);
      follow(loop, 'lfo', lfo.frequency, 4 + 14 * amount, time, 0.1, 0.1);
      follow(loop, 'sub', sub.frequency, pitch / 4, time, 0.05, 0.3);
      follow(loop, 'subGain', subGain.gain, 0.5 * amount, time, 0.1, 0.005);
    },
  },
};

export const LOOP_NAMES = Object.keys(DEFINITIONS);

class Loop {
  constructor(ctx, mixer, definition) {
    this.ctx = ctx;
    this.mixer = mixer;
    this.definition = definition;
    this.nodes = [];
    this.sources = [];
    this.applied = {};
    this.refs = {};
    this.built = false;
    this.active = false;
    this.offAt = Infinity;
  }

  track(node) {
    this.nodes.push(node);
    return node;
  }

  gain(value) {
    const node = this.track(this.ctx.createGain());
    node.gain.setValueAtTime(value, this.ctx.currentTime);
    return node;
  }

  filter(type, frequency, q) {
    const node = this.track(this.ctx.createBiquadFilter());
    node.type = type;
    node.frequency.setValueAtTime(frequency, this.ctx.currentTime);
    node.Q.setValueAtTime(q, this.ctx.currentTime);
    return node;
  }

  osc(type, frequency) {
    const node = this.track(this.ctx.createOscillator());
    node.type = type;
    node.frequency.setValueAtTime(frequency, this.ctx.currentTime);
    this.sources.push(node);
    return node;
  }

  noise(color) {
    const node = this.track(this.ctx.createBufferSource());
    node.buffer = this.mixer.noise[color];
    node.loop = true;
    this.sources.push(node);
    return node;
  }

  build() {
    this.out = this.gain(0);
    this.out.connect(this.mixer.sfxIn);
    this.definition.build(this);
    const now = this.ctx.currentTime;
    for (const source of this.sources) source.start(now);
    this.built = true;
  }

  /** Activates (or re-parameterizes) the loop. */
  start(params, time) {
    const wasActive = this.active;
    if (!this.built) this.build();
    this.active = true;
    this.offAt = Infinity;
    if (!wasActive) {
      delete this.applied.level;
      this.definition.onStart?.(this, time);
    }
    follow(this, 'level', this.out.gain, this.definition.level(params), time, this.definition.fadeIn, 0.003);
    this.definition.update(this, params, time);
  }

  stop(time) {
    if (!this.active) return;
    this.active = false;
    this.applied.level = 0;
    this.out.gain.setTargetAtTime(0, time, this.definition.fadeOut);
    this.offAt = time + this.definition.fadeOut * 6 + TEARDOWN_DELAY;
  }

  teardown() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Not started or already stopped.
      }
    }
    for (const node of this.nodes) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.nodes = [];
    this.sources = [];
    this.applied = {};
    this.refs = {};
    this.built = false;
  }
}

/** Owns the continuous loops. */
export class LoopManager {
  constructor({ ctx, mixer }) {
    this.ctx = ctx;
    this.mixer = mixer;
    this.loops = new Map();
  }

  /** Turns a loop on or off; returns false for unknown names. */
  set(name, active, params = {}) {
    const definition = DEFINITIONS[name];
    if (!definition) return false;
    const time = this.ctx.currentTime;
    let loop = this.loops.get(name);
    if (active) {
      if (!loop) {
        loop = new Loop(this.ctx, this.mixer, definition);
        this.loops.set(name, loop);
      }
      loop.start(params || {}, time);
    } else if (loop) {
      loop.stop(time);
    }
    return true;
  }

  isActive(name) {
    return Boolean(this.loops.get(name)?.active);
  }

  isBuilt(name) {
    return Boolean(this.loops.get(name)?.built);
  }

  /** Tears down loops that have finished fading out. */
  tick(now = this.ctx.currentTime) {
    for (const [name, loop] of this.loops) {
      if (!loop.active && loop.built && now >= loop.offAt) {
        loop.teardown();
        this.loops.delete(name);
      }
    }
  }

  stopAll() {
    const time = this.ctx.currentTime;
    for (const loop of this.loops.values()) loop.stop(time);
  }

  dispose() {
    for (const loop of this.loops.values()) loop.teardown();
    this.loops.clear();
  }
}
