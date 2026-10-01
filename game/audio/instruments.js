// Synthesized instruments shared by the music engine and the sound effects.
// Every function takes a `kit` ({ ctx, voices, mixer }), a destination node and
// a parameter object, creates one Voice, schedules it and returns it (or null
// when the voice manager rate-limited the trigger).

import { clamp, finite, midiToHz } from './util.js';

/** Seeded random value from the kit's PRNG (noise offsets, micro-variation). */
const rand = (kit) => (kit.rng ? kit.rng.next() : 0.5);

/**
 * Pluck envelope: fast attack, a quick drop (the finger leaving the string),
 * then a slower natural decay.
 */
function pluckEnvelope(param, t, peak, { attack = 0.004, drop = 0.55, dropTc = 0.06, decayTc = 0.32, sustain = 0 }) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setTargetAtTime(peak * Math.max(drop, sustain), t + attack, dropTc);
  param.setTargetAtTime(peak * sustain, t + attack + dropTc * 2, decayTc);
}

/**
 * Fingered electric bass: saw + pulse through a plucked low-pass, a sine for the
 * fundamental, and a short finger-noise transient. Supports slides (glides),
 * ghost notes, octave "pops" and a held (synth-pedal) mode via `sustain`.
 *
 * @param {object} kit
 * @param {AudioNode} destination usually a bass-body input
 * @param {object} p
 * @param {number} p.time start time
 * @param {number} p.midi MIDI note
 * @param {number} [p.duration] seconds until the note is muted
 * @param {number} [p.velocity] 0..1
 * @param {number} [p.slideTo] MIDI target of a glide
 * @param {number} [p.slideAt] absolute time the glide begins
 * @param {number} [p.slideTime] glide length in seconds
 */
export function bass(kit, destination, p) {
  const t = finite(p.time, kit.ctx.currentTime);
  const voice = kit.voices.create(p.tag || 'bass', destination, { start: t, priority: p.priority ?? 3 });
  if (!voice) return null;
  const velocity = clamp(finite(p.velocity, 0.8), 0.05, 1);
  const brightness = clamp(finite(p.brightness, 1), 0.3, 2);
  const ghost = Boolean(p.ghost);
  const pop = Boolean(p.pop);
  const frequency = midiToHz(finite(p.midi, 40));
  const duration = Math.max(0.03, finite(p.duration, 0.6));
  const level = finite(p.level, 0.5) * velocity;

  const filter = voice.filter('lowpass', 400, pop ? 2.2 : ghost ? 0.7 : 1.05);
  const amp = voice.gain(0);
  filter.connect(amp);
  if (p.pan) amp.connect(voice.pan(p.pan)).connect(voice.out);
  else amp.connect(voice.out);

  const saw = voice.osc('sawtooth', frequency, { detune: 2 });
  const pulse = voice.osc('custom', frequency, { wave: kit.mixer.waves.pulse, detune: -2 });
  const mix = voice.gain(0.5);
  saw.connect(mix);
  pulse.connect(mix);
  mix.connect(filter);
  const oscillators = [saw, pulse];
  const baseDetune = [2, -2];
  if (!ghost) {
    const sub = voice.osc('sine', frequency);
    const subGain = voice.gain(finite(p.sub, 0.5));
    sub.connect(subGain).connect(amp);
    oscillators.push(sub);
    baseDetune.push(0);
  }

  // Filter: bright pluck that settles into a warm sustain (key-tracked).
  const peakCutoff = clamp(380 + frequency * (5 + 10 * velocity), 500, 4200) * brightness * (pop ? 1.8 : 1);
  const sustainCutoff = clamp(frequency * 3 + 200, 260, 1200) * brightness;
  if (ghost) {
    filter.frequency.setValueAtTime(clamp(frequency * 6, 380, 900), t);
  } else {
    filter.frequency.setValueAtTime(peakCutoff, t);
    filter.frequency.setTargetAtTime(sustainCutoff, t + 0.004, finite(p.filterTc, pop ? 0.05 : 0.09));
  }

  // Amplitude.
  const end = t + duration;
  if (ghost) {
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(level * 0.6, t + 0.002);
    amp.gain.setTargetAtTime(0, t + 0.004, 0.018);
  } else {
    pluckEnvelope(amp.gain, t, level, {
      attack: finite(p.attack, 0.004),
      drop: pop ? 0.42 : 0.6,
      dropTc: pop ? 0.04 : 0.06,
      decayTc: finite(p.decay, 0.32),
      sustain: finite(p.sustain, 0),
    });
    amp.gain.setTargetAtTime(0, end, finite(p.release, 0.035));
  }

  // A plucked string starts slightly sharp and settles (harder plucks bend more).
  if (!ghost) {
    const bend = (pop ? 14 : 6) * velocity;
    oscillators.forEach((osc, i) => {
      osc.detune.setValueAtTime(baseDetune[i] + bend, t);
      osc.detune.setTargetAtTime(baseDetune[i], t + 0.002, 0.018);
    });
  }

  // Glide.
  if (Number.isFinite(p.slideTo)) {
    const target = midiToHz(p.slideTo);
    const slideAt = clamp(finite(p.slideAt, end - 0.12), t + 0.01, end);
    const slideEnd = slideAt + Math.max(0.02, finite(p.slideTime, 0.1));
    for (const osc of oscillators) {
      osc.frequency.setValueAtTime(frequency, slideAt);
      osc.frequency.exponentialRampToValueAtTime(target, slideEnd);
    }
  }

  // Finger / pop transient.
  const noise = voice.buffer(kit.mixer.noise.white, { offset: rand(kit) * 1.5 });
  const click = voice.filter('bandpass', pop ? 2600 : ghost ? 1100 : 1400, pop ? 1.6 : 1.1);
  const clickGain = voice.gain(0);
  noise.connect(click).connect(clickGain).connect(voice.out);
  const clickLevel = level * (pop ? 0.5 : ghost ? 0.45 : 0.16);
  clickGain.gain.setValueAtTime(0, t);
  clickGain.gain.linearRampToValueAtTime(clickLevel, t + 0.0015);
  clickGain.gain.setTargetAtTime(0, t + 0.002, ghost ? 0.008 : 0.006);

  const tail = ghost ? 0.12 : finite(p.release, 0.035) * 4.5;
  voice.schedule(end + tail);
  return voice;
}

/**
 * Warm pad chord: two detuned layers of a soft wave, each through its own
 * low-pass and panned apart, with slow attack/release and an optional filter LFO.
 */
export function pad(kit, destination, p) {
  const t = finite(p.time, kit.ctx.currentTime);
  const voice = kit.voices.create(p.tag || 'pad', destination, { start: t, priority: p.priority ?? 2 });
  if (!voice) return null;
  const notes = p.notes || [];
  const duration = Math.max(0.2, finite(p.duration, 4));
  const attack = finite(p.attack, 1.2);
  const release = finite(p.release, 1.6);
  const brightness = clamp(finite(p.brightness, 1), 0.2, 2);
  const detune = finite(p.detune, 7);
  const width = clamp(finite(p.width, 0.45), 0, 1);
  const level = (finite(p.level, 0.16) * finite(p.velocity, 1)) / Math.sqrt(Math.max(1, notes.length));
  const cutoff = finite(p.cutoff, 1500) * brightness;

  const amp = voice.gain(0);
  amp.connect(voice.out);
  const layers = [-1, 1].map((side) => {
    const filter = voice.filter('lowpass', cutoff * 0.6, finite(p.q, 0.6));
    const panner = voice.pan(side * width);
    filter.connect(panner).connect(amp);
    filter.frequency.setTargetAtTime(cutoff, t, attack * 0.6);
    return { side, filter };
  });
  for (const midi of notes) {
    const frequency = midiToHz(midi);
    for (const layer of layers) {
      const osc = voice.osc('custom', frequency, { wave: kit.mixer.waves.warm, detune: layer.side * detune });
      osc.connect(layer.filter);
    }
  }
  if (p.lfoRate) {
    const lfo = voice.osc('sine', p.lfoRate);
    const depth = voice.gain(finite(p.lfoDepth, cutoff * 0.35));
    lfo.connect(depth);
    for (const layer of layers) depth.connect(layer.filter.frequency);
  }
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + attack);
  amp.gain.setTargetAtTime(0, t + duration, release / 4);
  voice.schedule(t + duration + release * 1.1);
  return voice;
}

/**
 * Two-operator FM note: bells (inharmonic ratios), glass (ratio 2..4) and
 * electric-piano tines (ratio 1). The modulation index decays faster than the
 * amplitude, so attacks are bright and tails mellow.
 */
export function fm(kit, destination, p) {
  const t = finite(p.time, kit.ctx.currentTime);
  const voice = kit.voices.create(p.tag || 'bell', destination, { start: t, priority: p.priority ?? 2 });
  if (!voice) return null;
  const frequency = midiToHz(finite(p.midi, 72));
  const velocity = clamp(finite(p.velocity, 0.7), 0.02, 1);
  const decay = Math.max(0.05, finite(p.decay, 1.6));
  const ratio = finite(p.ratio, 3.5);
  const index = finite(p.index, 2.2) * clamp(finite(p.brightness, 1), 0.2, 2);
  const level = finite(p.level, 0.12) * velocity;
  const attack = finite(p.attack, 0.003);

  const carrier = voice.osc('sine', frequency, { detune: finite(p.detune, 0) });
  const modulator = voice.osc('sine', frequency * ratio);
  const depth = voice.gain(frequency * index);
  modulator.connect(depth).connect(carrier.frequency);
  depth.gain.setValueAtTime(frequency * index, t);
  depth.gain.setTargetAtTime(frequency * index * finite(p.indexFloor, 0.12), t + attack, decay * finite(p.indexDecay, 0.18));

  const amp = voice.gain(0);
  let tailNode = amp;
  if (p.pan) {
    const panner = voice.pan(p.pan);
    amp.connect(panner);
    tailNode = panner;
  }
  carrier.connect(amp);
  tailNode.connect(voice.out);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + attack);
  amp.gain.setTargetAtTime(0, t + attack, decay / 4.6);
  const end = Number.isFinite(p.duration) ? t + p.duration : null;
  if (end && end < t + decay) amp.gain.setTargetAtTime(0, end, finite(p.release, 0.08));
  voice.schedule(Math.min(t + decay * 1.15, end ? end + finite(p.release, 0.08) * 5 : Infinity));
  return voice;
}

/** Soft, round kick: a pitched sine drop plus a tiny beater click. */
export function kick(kit, destination, p) {
  const t = finite(p.time, kit.ctx.currentTime);
  const voice = kit.voices.create(p.tag || 'kick', destination, { start: t, priority: 2 });
  if (!voice) return null;
  const velocity = clamp(finite(p.velocity, 0.8), 0.05, 1);
  const level = finite(p.level, 0.5) * velocity;
  const body = voice.osc('sine', finite(p.from, 135));
  body.frequency.setValueAtTime(finite(p.from, 135), t);
  body.frequency.exponentialRampToValueAtTime(finite(p.to, 47), t + finite(p.sweep, 0.085));
  const amp = voice.gain(0);
  body.connect(amp).connect(voice.out);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + 0.002);
  amp.gain.setTargetAtTime(0, t + 0.012, finite(p.decay, 0.11));
  const noise = voice.buffer(kit.mixer.noise.white, { offset: rand(kit) });
  const hp = voice.filter('highpass', 2600, 0.7);
  const clickGain = voice.gain(0);
  noise.connect(hp).connect(clickGain).connect(voice.out);
  clickGain.gain.setValueAtTime(level * 0.14, t);
  clickGain.gain.setTargetAtTime(0, t + 0.001, 0.004);
  voice.schedule(t + finite(p.decay, 0.11) * 6);
  return voice;
}

/** Noise hat (closed or open) or shaker, optionally panned. */
export function hat(kit, destination, p) {
  const t = finite(p.time, kit.ctx.currentTime);
  const voice = kit.voices.create(p.tag || 'hat', destination, { start: t, priority: 1 });
  if (!voice) return null;
  const velocity = clamp(finite(p.velocity, 0.6), 0.02, 1);
  const level = finite(p.level, 0.08) * velocity;
  const decay = finite(p.decay, p.open ? 0.16 : 0.03);
  const noise = voice.buffer(kit.mixer.noise.white, { offset: rand(kit) * 1.8 });
  const hp = voice.filter('highpass', finite(p.cutoff, 7200) * clamp(finite(p.brightness, 1), 0.5, 1.3), 0.8);
  const color = voice.filter('peaking', finite(p.color, 10500), 1.2, 4);
  const amp = voice.gain(0);
  let tail = amp;
  if (p.pan) {
    tail = voice.pan(p.pan);
    amp.connect(tail);
  }
  noise.connect(hp).connect(color).connect(amp);
  tail.connect(voice.out);
  const attack = finite(p.attack, 0.0015);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + attack);
  amp.gain.setTargetAtTime(0, t + attack, decay / 3);
  voice.schedule(t + attack + decay * 2.2);
  return voice;
}

/** Brush snare: a band-passed noise "tap" with a faint tonal body, or a slow sweep. */
export function brush(kit, destination, p) {
  const t = finite(p.time, kit.ctx.currentTime);
  const voice = kit.voices.create(p.tag || 'brush', destination, { start: t, priority: 1 });
  if (!voice) return null;
  const velocity = clamp(finite(p.velocity, 0.6), 0.02, 1);
  const sweep = Boolean(p.sweep);
  const level = finite(p.level, 0.12) * velocity * (sweep ? 0.45 : 1);
  const noise = voice.buffer(kit.mixer.noise.pink, { offset: rand(kit) * 1.8 });
  const band = voice.filter('bandpass', sweep ? 1700 : 2300, sweep ? 0.6 : 0.75);
  const amp = voice.gain(0);
  let tail = amp;
  if (p.pan) {
    tail = voice.pan(p.pan);
    amp.connect(tail);
  }
  noise.connect(band).connect(amp);
  tail.connect(voice.out);
  const attack = sweep ? finite(p.attack, 0.16) : 0.006;
  const decay = sweep ? 0.22 : finite(p.decay, 0.11);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + attack);
  amp.gain.setTargetAtTime(0, t + attack, decay / 2.5);
  if (!sweep) {
    const body = voice.osc('triangle', 196);
    body.frequency.setValueAtTime(205, t);
    body.frequency.exponentialRampToValueAtTime(170, t + 0.06);
    const bodyGain = voice.gain(0);
    body.connect(bodyGain).connect(amp);
    bodyGain.gain.setValueAtTime(0.9, t);
    bodyGain.gain.setTargetAtTime(0, t + 0.004, 0.025);
  } else {
    band.frequency.setValueAtTime(1300, t);
    band.frequency.linearRampToValueAtTime(2300, t + attack + decay);
  }
  voice.schedule(t + attack + decay * 2.6);
  return voice;
}

/** Pitched tom with a stick tap (combat pulses). */
export function tom(kit, destination, p) {
  const t = finite(p.time, kit.ctx.currentTime);
  const voice = kit.voices.create(p.tag || 'tom', destination, { start: t, priority: 2 });
  if (!voice) return null;
  const velocity = clamp(finite(p.velocity, 0.7), 0.02, 1);
  const level = finite(p.level, 0.3) * velocity;
  const frequency = midiToHz(finite(p.midi, 45));
  const body = voice.osc('sine', frequency * 1.6);
  body.frequency.setValueAtTime(frequency * 1.6, t);
  body.frequency.exponentialRampToValueAtTime(frequency, t + 0.07);
  const amp = voice.gain(0);
  body.connect(amp).connect(voice.out);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + 0.003);
  amp.gain.setTargetAtTime(0, t + 0.01, finite(p.decay, 0.12));
  const noise = voice.buffer(kit.mixer.noise.white, { offset: rand(kit) });
  const band = voice.filter('bandpass', 900, 1.2);
  const tap = voice.gain(0);
  noise.connect(band).connect(tap).connect(voice.out);
  tap.gain.setValueAtTime(level * 0.35, t);
  tap.gain.setTargetAtTime(0, t + 0.002, 0.012);
  voice.schedule(t + finite(p.decay, 0.12) * 6);
  return voice;
}
