// Unit tests for the synthesized soundscape (game/audio). Node has no Web
// Audio, so a small recording fake AudioContext stands in. The fake validates
// arguments the way browsers do (non-finite values, double start(), negative
// times), so NaN bugs and lifecycle mistakes fail loudly here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOOP_NAMES, SFX_NAMES, Soundscape } from '../game/audio/soundscape.js';
import { SFX_LIMITS } from '../game/audio/sfx.js';
import { READING_LEVEL } from '../game/audio/music.js';
import { midiToHz } from '../game/audio/util.js';

// ---------------------------------------------------------------------------
// Fake Web Audio
// ---------------------------------------------------------------------------

const finiteOrThrow = (value, what) => {
  if (!Number.isFinite(value)) throw new TypeError(`${what} is non-finite: ${value}`);
};

class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
    this.calls = [];
  }

  record(type, value, time, extra) {
    finiteOrThrow(value, `${type} value`);
    finiteOrThrow(time, `${type} time`);
    if (time < 0) throw new RangeError(`${type} time is negative`);
    const event = { type, value, time, ...extra };
    this.events.push(event);
    this.calls.push(event);
    return this;
  }

  setValueAtTime(value, time) {
    return this.record('set', value, time);
  }

  linearRampToValueAtTime(value, time) {
    return this.record('linear', value, time);
  }

  exponentialRampToValueAtTime(value, time) {
    if (!(value > 0) && !(value < 0)) throw new RangeError('exponential ramp target must be non-zero');
    return this.record('exponential', value, time);
  }

  setTargetAtTime(value, time, timeConstant) {
    finiteOrThrow(timeConstant, 'timeConstant');
    if (timeConstant < 0) throw new RangeError('timeConstant must be >= 0');
    return this.record('target', value, time, { timeConstant });
  }

  cancelScheduledValues(time) {
    finiteOrThrow(time, 'cancel time');
    this.events = this.events.filter((event) => event.time < time);
    this.calls.push({ type: 'cancel', time });
    return this;
  }

  /** Last event of a given type (most recent call). */
  last(type) {
    for (let i = this.calls.length - 1; i >= 0; i--) if (!type || this.calls[i].type === type) return this.calls[i];
    return null;
  }
}

class FakeNode {
  constructor(ctx, kind, params = {}) {
    this.context = ctx;
    this.kind = kind;
    this.connections = new Set();
    this.disconnected = false;
    for (const [name, value] of Object.entries(params)) this[name] = new FakeParam(value);
    ctx.created.push(this);
  }

  connect(destination) {
    if (!destination) throw new TypeError('connect() needs a destination');
    if (this.context.state === 'closed') throw new Error('context closed');
    this.connections.add(destination);
    return destination;
  }

  disconnect() {
    this.connections.clear();
    this.disconnected = true;
  }
}

class FakeSource extends FakeNode {
  constructor(ctx, kind, params) {
    super(ctx, kind, params);
    this.startTime = null;
    this.stopTime = null;
    this.ended = false;
    this.onended = null;
    ctx.sources.push(this);
  }

  start(when = 0) {
    finiteOrThrow(when, 'start time');
    if (this.startTime !== null) throw new Error('InvalidStateError: start() called twice');
    this.startTime = when;
  }

  stop(when = 0) {
    finiteOrThrow(when, 'stop time');
    if (this.startTime === null) throw new Error('InvalidStateError: stop() before start()');
    this.stopTime = when;
  }
}

class FakeOscillator extends FakeSource {
  constructor(ctx) {
    super(ctx, 'oscillator', { frequency: 440, detune: 0 });
    this.type = 'sine';
    this.wave = null;
  }

  setPeriodicWave(wave) {
    this.wave = wave;
    this.type = 'custom';
  }
}

class FakeBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }

  getChannelData(channel) {
    return this.data[channel];
  }
}

class FakeAudioContext {
  static instances = 0;

  constructor() {
    FakeAudioContext.instances += 1;
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.state = 'suspended';
    this.created = [];
    this.sources = [];
    this.destination = new FakeNode(this, 'destination');
  }

  createGain() { return new FakeNode(this, 'gain', { gain: 1 }); }
  createOscillator() { return new FakeOscillator(this); }
  createBufferSource() {
    const node = new FakeSource(this, 'bufferSource', { playbackRate: 1, detune: 0 });
    node.buffer = null;
    node.loop = false;
    return node;
  }
  createBiquadFilter() {
    const node = new FakeNode(this, 'biquad', { frequency: 350, Q: 1, gain: 0, detune: 0 });
    node.type = 'lowpass';
    return node;
  }
  createConvolver() {
    const node = new FakeNode(this, 'convolver');
    node.buffer = null;
    node.normalize = true;
    return node;
  }
  createDynamicsCompressor() {
    return new FakeNode(this, 'compressor', { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 });
  }
  createStereoPanner() { return new FakeNode(this, 'panner', { pan: 0 }); }
  createDelay(maxDelay = 1) {
    const node = new FakeNode(this, 'delay', { delayTime: 0 });
    node.maxDelayTime = maxDelay;
    return node;
  }
  createWaveShaper() {
    const node = new FakeNode(this, 'waveshaper');
    node.curve = null;
    node.oversample = 'none';
    return node;
  }
  createBuffer(channels, length, sampleRate) { return new FakeBuffer(channels, length, sampleRate); }
  createPeriodicWave(real, imag) { return { real, imag }; }

  resume() {
    if (this.state !== 'closed') this.state = 'running';
    return Promise.resolve();
  }

  suspend() {
    if (this.state !== 'closed') this.state = 'suspended';
    return Promise.resolve();
  }

  close() {
    this.state = 'closed';
    return Promise.resolve();
  }

  /** Moves time forward and fires `ended` on sources whose stop time has passed. */
  advance(seconds) {
    this.currentTime += seconds;
    for (const source of this.sources) {
      if (!source.ended && source.stopTime !== null && source.stopTime <= this.currentTime) {
        source.ended = true;
        source.onended?.();
      }
    }
  }

  /** Nodes that are still connected to something. */
  liveNodes() {
    return this.created.filter((node) => node.kind !== 'destination' && node.connections.size > 0);
  }
}

/** A soundscape on a fresh fake context, enabled, with a manual clock. */
function makeSoundscape(options = {}) {
  const ctx = new FakeAudioContext();
  const sound = new Soundscape({ context: ctx, manualClock: true, strict: true, seed: 42, ...options });
  return { ctx, sound };
}

/** Advances the fake clock in small steps, driving the scheduler like frames would. */
function run(ctx, sound, seconds, step = 0.05) {
  for (let t = 0; t < seconds - 1e-9; t += step) {
    ctx.advance(step);
    sound.update(step);
  }
}

const WORLDS = ['philosophy', 'experience', 'projects', 'mission', 'contact'];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('constructor creates no AudioContext, even when other methods are called first', () => {
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
  try {
    FakeAudioContext.instances = 0;
    const sound = new Soundscape();
    sound.setScene({ world: 'philosophy', mode: 'foot', altitude: 0, speed: 0, combat: 0, night: 0, reading: false });
    sound.setVolume(0.5);
    assert.equal(sound.play('fire'), null);
    assert.equal(sound.setLoop('engine', true, { throttle: 1, speed: 100 }), true);
    sound.update(0.016);
    assert.equal(FakeAudioContext.instances, 0);
    assert.equal(sound.context, null);
    assert.equal(sound.enabled, false);
    sound.dispose();
  } finally {
    globalThis.AudioContext = previous;
  }
});

test('unlock() creates and resumes one AudioContext; repeated unlocks reuse it', async () => {
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
  try {
    FakeAudioContext.instances = 0;
    const sound = new Soundscape();
    assert.equal(await sound.unlock(), true);
    assert.equal(FakeAudioContext.instances, 1);
    assert.equal(sound.context.state, 'running');
    await sound.unlock();
    assert.equal(FakeAudioContext.instances, 1);
    const ctx = sound.context;
    sound.dispose();
    assert.equal(ctx.state, 'closed', 'a context the soundscape created is closed on dispose');
  } finally {
    globalThis.AudioContext = previous;
  }
});

test('every SFX name plays without throwing, including odd options', () => {
  const { ctx, sound } = makeSoundscape();
  sound.setScene({ world: 'experience' });
  sound.setEnabled(true);
  assert.equal(SFX_NAMES.length, 29);
  for (const name of SFX_NAMES) {
    const voice = sound.play(name, name === 'notePad' ? { pitch: 40 } : {});
    assert.ok(voice, `${name} should create a voice`);
    ctx.advance(0.6);
  }
  const odd = [{ volume: Number.NaN }, { pitch: -3 }, { pan: 9 }, { tier: 99 }, { surface: 'lava' }, { pitch: Infinity }, null];
  for (const name of SFX_NAMES) {
    for (const opts of odd) assert.doesNotThrow(() => sound.play(name, opts), `${name} with ${JSON.stringify(opts)}`);
    ctx.advance(0.6);
  }
  for (const surface of ['grass', 'rock', 'sand', 'crystal', 'metal', 'water']) {
    assert.ok(sound.play('footstep', { surface }), `footstep on ${surface}`);
    assert.ok(sound.play('land', { surface }), `land on ${surface}`);
    ctx.advance(0.2);
  }
  for (const tier of [1, 2, 3, 4]) {
    assert.ok(sound.play('fire', { tier }));
    ctx.advance(0.1);
  }
  assert.equal(sound.play('no-such-sound'), null);
  sound.dispose();
});

test('fire gets richer with tier', () => {
  const { ctx, sound } = makeSoundscape();
  sound.setEnabled(true);
  const sizes = [1, 2, 3, 4].map((tier) => {
    const voice = sound.play('fire', { tier });
    const size = voice.nodes.length;
    ctx.advance(0.5);
    assert.equal(voice.done, true, 'the shot cleans itself up once it ends');
    return size;
  });
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i] > sizes[i - 1], `tier ${i + 1} adds layers (${sizes})`);
  sound.dispose();
});

test('notePad plays a plucked bass at the requested MIDI note', () => {
  const { ctx, sound } = makeSoundscape();
  sound.setEnabled(true);
  const before = ctx.sources.length;
  sound.play('notePad', { pitch: 45 });
  const oscillators = ctx.sources.slice(before).filter((source) => source.kind === 'oscillator');
  assert.ok(oscillators.length >= 2, 'saw/pulse/sub oscillators');
  for (const osc of oscillators) assert.ok(Math.abs(osc.frequency.calls[0].value - midiToHz(45)) < 1e-6);
  const stop = Math.max(...oscillators.map((osc) => osc.stopTime));
  assert.ok(stop > 1.1 && stop < 2.2, `about 1.2 s of decay (stops at ${stop.toFixed(2)} s)`);
  sound.dispose();
});

test('consecutive pickups climb a pentatonic scale, then reset after a pause', () => {
  const { ctx, sound } = makeSoundscape();
  sound.setScene({ world: 'philosophy' });
  sound.setEnabled(true);
  const pitchOf = () => {
    const before = ctx.sources.length;
    sound.play('pickup');
    return ctx.sources[before].frequency.calls[0].value;
  };
  const climb = [];
  for (let i = 0; i < 6; i++) {
    climb.push(pitchOf());
    ctx.advance(0.4);
  }
  for (let i = 1; i < climb.length; i++) assert.ok(climb[i] > climb[i - 1], `pickup ${i} climbs (${climb.map(Math.round)})`);
  ctx.advance(3);
  assert.equal(Math.round(pitchOf()), Math.round(climb[0]), 'combo resets after a pause');
  sound.dispose();
});

test('setScene switches the theme for every world, crossfading and rate-limiting rapid changes', () => {
  const { ctx, sound } = makeSoundscape();
  sound.setEnabled(true);
  sound.setScene({ world: 'philosophy', mode: 'foot', altitude: 0, speed: 0, combat: 0, night: 0, reading: false });
  assert.equal(sound.theme, 'philosophy', 'the first scene starts immediately');
  for (const world of [...WORLDS.slice(1), null, 'philosophy']) {
    run(ctx, sound, 3);
    const previous = sound.music.current;
    sound.setScene({ world });
    assert.equal(sound.theme, world ?? 'space');
    assert.ok(previous.fadingOut, 'the previous theme fades out');
    const fade = previous.dry.gain.last('linear');
    assert.equal(fade.value, 0);
    assert.ok(Math.abs(fade.time - ctx.currentTime - 4) < 1e-6, 'crossfade lasts about 4 s');
  }
  // A change right after a switch waits instead of thrashing.
  sound.setScene({ world: 'contact' });
  assert.equal(sound.theme, 'philosophy');
  assert.equal(sound.stats.pendingTheme, 'contact');
  run(ctx, sound, 3);
  assert.equal(sound.theme, 'contact', 'the pending theme starts once the interval passes');
  // Unknown worlds fall back to deep space; old players are retired.
  run(ctx, sound, 3);
  sound.setScene({ world: 'nowhere' });
  assert.equal(sound.theme, 'space');
  run(ctx, sound, 12);
  assert.equal(sound.music.players.length, 1, 'faded-out themes are disposed');
  sound.dispose();
});

test('music schedules notes ahead of time and is deterministic for a seed', () => {
  const trace = () => {
    const { ctx, sound } = makeSoundscape({ seed: 7 });
    sound.setScene({ world: 'experience' });
    sound.setEnabled(true);
    run(ctx, sound, 6);
    const latest = Math.max(...ctx.sources.map((source) => source.startTime ?? 0));
    assert.ok(latest <= ctx.currentTime + 0.13, 'nothing is scheduled beyond the ~120 ms lookahead');
    const pitches = ctx.sources.filter((source) => source.kind === 'oscillator').map((osc) => Math.round(osc.frequency.calls[0].value * 100));
    sound.dispose();
    return pitches;
  };
  const first = trace();
  assert.ok(first.length > 50, `music produced notes (${first.length} oscillators)`);
  assert.deepEqual(trace(), first, 'same seed, same performance');
});

test('reading ducks the music to about 35% and removes percussion and combat', () => {
  const { ctx, sound } = makeSoundscape();
  sound.setEnabled(true);
  sound.setScene({ world: 'experience', reading: false, combat: 0.8 });
  run(ctx, sound, 0.5);
  const player = sound.music.current;
  assert.ok(player.targets.perc > 0.5);
  assert.ok(player.targets.combat > 0.5);
  sound.setScene({ reading: true });
  assert.equal(sound.mixer.musicScene.gain.last('target').value, READING_LEVEL);
  assert.ok(Math.abs(READING_LEVEL - 0.35) < 1e-9);
  assert.equal(player.targets.perc, 0);
  assert.equal(player.targets.combat, 0);
  sound.setScene({ reading: false });
  assert.equal(sound.mixer.musicScene.gain.last('target').value, 1);
  sound.dispose();
});

test('altitude, deep space, combat and night shape the stems', () => {
  const { ctx, sound } = makeSoundscape();
  sound.setEnabled(true);
  sound.setScene({ world: 'projects', mode: 'foot', altitude: 0, combat: 0, night: 0 });
  const player = sound.music.current;
  assert.ok(player.targets.perc > 0.5, 'percussion on the ground');
  sound.setScene({ mode: 'ship', altitude: 450 });
  assert.equal(player.targets.perc, 0, 'percussion fades above 400 m');
  sound.setScene({ altitude: 0, combat: 1 });
  assert.ok(player.targets.combat > 0.9, 'combat layer fades in');
  assert.ok(player.targets.bass < player.theme.levels.bass, 'melodic bass makes room for the combat bass');
  sound.setScene({ combat: 0, night: 1 });
  assert.ok(sound.mixer.musicTone.frequency.last('target').value < 4000, 'night darkens the music');
  run(ctx, sound, 3);
  sound.setScene({ world: null });
  assert.equal(sound.music.current.targets.perc, 0, 'no drums in deep space');
  sound.dispose();
});

test('setEnabled(false) ramps the master down, then suspends the context', async () => {
  const { ctx, sound } = makeSoundscape();
  sound.setEnabled(true);
  assert.equal(sound.enabled, true);
  const master = sound.mixer.master.gain;
  assert.ok(master.last('target').value > 0, 'fades in');
  sound.setEnabled(false);
  assert.equal(sound.enabled, false);
  const fade = master.last('target');
  assert.equal(fade.value, 0, 'fades to silence');
  assert.ok(fade.timeConstant > 0 && fade.timeConstant < 0.3, 'smoothly, not instantly');
  assert.equal(master.last().type, 'target', 'no hard jump after the fade starts');
  assert.equal(sound.play('fire'), null, 'muted soundscape plays nothing');
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(ctx.state, 'suspended', 'context suspended after the fade');
  sound.setEnabled(true);
  assert.equal(ctx.state, 'running');
  assert.ok(master.last('target').value > 0);
  sound.dispose();
});

test('setVolume maps 0..1 onto a gentle master level', () => {
  const { sound } = makeSoundscape();
  sound.setEnabled(true);
  const master = sound.mixer.master.gain;
  sound.setVolume(1);
  const full = master.last('target').value;
  assert.ok(full > 0.5 && full <= 1, 'full volume stays at or below unity');
  sound.setVolume(0.7);
  assert.ok(master.last('target').value < full * 0.6, 'default volume is well below full');
  sound.setVolume(0);
  assert.equal(master.last('target').value, 0);
  sound.setVolume(Number.NaN);
  assert.equal(sound.volume, 0, 'invalid input keeps the previous volume');
  sound.dispose();
});

test('voice caps hold under spam (play("fire") 500 times)', () => {
  const { ctx, sound } = makeSoundscape();
  sound.setEnabled(true);
  for (let i = 0; i < 500; i++) sound.play('fire', { tier: 4 });
  assert.equal(sound.sfxVoices.countTag('fire'), 1, 'same-instant triggers are coalesced');
  let maxFire = 0;
  let maxTotal = 0;
  for (let i = 0; i < 500; i++) {
    ctx.advance(0.031);
    sound.play('fire', { tier: 4 });
    sound.play('hit');
    sound.play('footstep', { surface: 'rock' });
    maxFire = Math.max(maxFire, sound.sfxVoices.countTag('fire'));
    maxTotal = Math.max(maxTotal, sound.sfxVoices.count);
  }
  assert.ok(maxFire <= SFX_LIMITS.fire, `fire voices capped (${maxFire})`);
  assert.ok(maxTotal <= sound.sfxVoices.maxVoices, `total voices capped (${maxTotal})`);
  assert.ok(sound.sfxVoices.stolen > 0, 'oldest voices were stolen');
  ctx.advance(2);
  sound.update(0);
  const finishedSources = ctx.sources.filter((source) => source.ended);
  assert.ok(finishedSources.length > 0);
  assert.ok(finishedSources.every((source) => source.connections.size === 0), 'finished voices are disconnected');
  sound.dispose();
});

test('loops start, follow parameters without automation spam, and tear down', () => {
  const { ctx, sound } = makeSoundscape();
  sound.setEnabled(true);
  assert.deepEqual(LOOP_NAMES, ['jetpack', 'engine', 'boost', 'charge']);
  assert.equal(sound.setLoop('warp-drive', true), false);
  for (const name of LOOP_NAMES) assert.equal(sound.setLoop(name, true, { throttle: 0.5, speed: 300, amount: 0.2, thrust: 1 }), true);
  assert.deepEqual(sound.stats.loops.sort(), [...LOOP_NAMES].sort());
  const engine = sound.loops.loops.get('engine');
  const param = engine.refs.sawA.frequency;
  const before = param.calls.length;
  for (let i = 0; i < 100; i++) sound.setLoop('engine', true, { throttle: 0.5, speed: 300 });
  assert.equal(param.calls.length, before, 'identical parameters add no automation');
  sound.setLoop('engine', true, { throttle: 1, speed: 2000 });
  assert.ok(param.calls.length > before, 'changed parameters are followed');
  const charge = sound.loops.loops.get('charge');
  sound.setLoop('charge', true, { amount: 1 });
  assert.ok(charge.refs.tone.frequency.last('target').value > 800, 'charge pitch rises with amount');
  const engineNodes = [...engine.nodes];
  sound.setLoop('engine', false);
  run(ctx, sound, 4);
  assert.equal(sound.loops.isBuilt('engine'), false, 'stopped loop is torn down after its fade');
  assert.ok(engineNodes.every((node) => node.connections.size === 0));
  sound.dispose();
});

test('loops requested while muted start when sound is enabled', () => {
  const { sound } = makeSoundscape();
  sound.setLoop('engine', true, { throttle: 0.3, speed: 50 });
  sound.setEnabled(true);
  assert.equal(sound.loops.isActive('engine'), true);
  sound.dispose();
});

test('dispose cleans up timers, nodes and the context it created', async () => {
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
  try {
    const sound = new Soundscape({ strict: true });
    await sound.unlock();
    sound.setEnabled(true);
    sound.setScene({ world: 'mission', combat: 0.5 });
    const ctx = sound.context;
    for (let i = 0; i < 40; i++) {
      ctx.advance(0.05);
      sound._tick();
    }
    sound.setLoop('engine', true, { throttle: 1, speed: 500 });
    sound.play('ultimate');
    sound.play('discover');
    assert.ok(ctx.liveNodes().length > 50);
    assert.ok(sound._timer, 'scheduler timer running');
    sound.dispose();
    assert.equal(sound._timer, null, 'scheduler stopped');
    assert.equal(ctx.state, 'closed');
    assert.deepEqual(ctx.liveNodes().map((node) => node.kind), [], 'every node disconnected');
    assert.equal(sound.context, null);
    // Everything is a safe no-op afterwards.
    assert.equal(sound.play('fire'), null);
    assert.doesNotThrow(() => {
      sound.setScene({ world: 'contact' });
      sound.setLoop('boost', true);
      sound.setEnabled(true);
      sound.setVolume(1);
      sound.update(0.016);
      sound.dispose();
    });
    assert.equal(sound.enabled, false);
  } finally {
    globalThis.AudioContext = previous;
  }
});
