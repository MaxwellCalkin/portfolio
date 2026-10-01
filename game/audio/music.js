// Generative music engine. A lookahead scheduler (driven by Soundscape) asks
// the engine to schedule everything up to `until` on AudioContext time. Each
// world has a ThemePlayer with its own stems; switching worlds crossfades two
// players. Bars are planned as data (seeded), then turned into voices step by
// step, so only ~120 ms of notes exist ahead of the playhead.

import { STEPS_PER_BAR } from './harmony.js';
import { bass, brush, fm, hat, kick, pad, tom } from './instruments.js';
import { FM_PRESETS, THEMES, combatEvents, themeIdForWorld } from './themes.js';
import { Rng, clamp, finite, hashString, smoothstep } from './util.js';

export const CROSSFADE_SECONDS = 4;
export const READING_LEVEL = 0.35;
const FIRST_FADE_SECONDS = 1.5;
const MIN_SWITCH_INTERVAL = 2.5;
const TAIL_SECONDS = 6;

/** Fills missing scene fields from the previous scene and clamps the rest. */
export function normalizeScene(scene = {}, previous) {
  const world = scene.world === undefined ? previous.world : scene.world;
  return {
    world: typeof world === 'string' && world !== 'space' && themeIdForWorld(world) === world ? world : null,
    mode: scene.mode === 'ship' || scene.mode === 'foot' ? scene.mode : previous.mode,
    altitude: Math.max(0, finite(scene.altitude, previous.altitude)),
    speed: Math.abs(finite(scene.speed, previous.speed)),
    combat: clamp(finite(scene.combat, previous.combat), 0, 1),
    night: clamp(finite(scene.night, previous.night), 0, 1),
    reading: scene.reading === undefined ? previous.reading : Boolean(scene.reading),
  };
}

/** Plays one theme: owns its stems, plans bars and schedules their notes. */
class ThemePlayer {
  constructor(engine, theme, { now, startTime, seed, fadeSeconds }) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.theme = theme;
    this.rng = new Rng(seed);
    this.stepDur = 60 / theme.bpm / 4;
    this.barStart = startTime;
    this.nextStepTime = startTime;
    this.step = 0;
    this.bar = 0;
    this.form = this.rng.pick(theme.forms);
    this.nextForm = this.rng.pick(theme.forms);
    this.sectionIndex = 0;
    this.barInPhrase = 0;
    this.phraseIndex = 0;
    this.plan = null;
    this.padPlan = [];
    this.phraseMemo = new Map();
    this.targets = {};
    this.combatIntensity = 0;
    this.fadingOut = false;
    this.stopAt = Infinity;
    this.disposeAt = Infinity;
    this.disposed = false;
    this.nodes = [];
    this.level = finite(theme.gain, 1);
    this.fade = { from: 0, to: this.level, start: startTime, end: startTime + fadeSeconds };
    this.buildGraph(now, startTime, fadeSeconds);
  }

  buildGraph(now, startTime, fadeSeconds) {
    const { ctx, theme } = this;
    const mixer = this.engine.mixer;
    const node = (created) => {
      this.nodes.push(created);
      return created;
    };
    const gainNode = (value) => {
      const created = node(ctx.createGain());
      created.gain.setValueAtTime(value, now);
      return created;
    };

    // Theme faders (dry and reverb-send paths move together).
    this.dry = gainNode(0);
    this.wet = gainNode(0);
    this.dry.connect(mixer.musicIn);
    this.wet.connect(mixer.musicWetIn);
    for (const fader of [this.dry, this.wet]) {
      fader.gain.setValueAtTime(0, startTime);
      fader.gain.linearRampToValueAtTime(this.level, startTime + fadeSeconds);
    }

    // Stems. Levels are driven by applyMix().
    this.stems = {
      bass: gainNode(0),
      pad: gainNode(0),
      keys: gainNode(0),
      perc: gainNode(0),
      combat: gainNode(0),
      combatBass: gainNode(0),
    };
    const bassBody = mixer.createBassBody(this.dry, node);
    this.stems.bass.connect(bassBody);
    this.stems.combatBass.connect(bassBody);
    for (const name of ['pad', 'keys', 'perc', 'combat']) this.stems[name].connect(this.dry);
    const send = (stem, amount) => {
      if (!amount) return;
      const sendGain = gainNode(amount);
      stem.connect(sendGain).connect(this.wet);
    };
    send(this.stems.bass, theme.sends.bass);
    send(this.stems.pad, theme.sends.pad);
    send(this.stems.keys, theme.sends.keys);
    send(this.stems.perc, theme.sends.perc);
    send(this.stems.combat, 0.1);

    // Tempo-synced echo on the keys, darkening with each repeat.
    const echo = theme.delay;
    if (echo && echo.send > 0) {
      const input = gainNode(echo.send);
      const delay = node(ctx.createDelay(3));
      delay.delayTime.setValueAtTime(Math.min(2.9, (echo.beats * 60) / theme.bpm), now);
      const tone = node(ctx.createBiquadFilter());
      tone.type = 'lowpass';
      tone.frequency.setValueAtTime(2600, now);
      const feedback = gainNode(echo.feedback);
      const toWet = gainNode(0.4);
      this.stems.keys.connect(input).connect(delay).connect(tone);
      tone.connect(feedback).connect(delay);
      tone.connect(this.dry);
      tone.connect(toWet).connect(this.wet);
    }
  }

  /** Applies stem targets for the current scene mix (gated to avoid automation spam). */
  applyMix(mix, time, instant = false) {
    const { levels } = this.theme;
    const combat = this.fadingOut ? 0 : mix.combatLevel;
    const targets = {
      bass: levels.bass * (1 - 0.55 * mix.combat),
      pad: levels.pad * (1 - 0.25 * mix.combat),
      keys: levels.keys * (1 - 0.3 * mix.combat),
      perc: this.fadingOut ? 0 : levels.perc * mix.perc,
      combat,
      combatBass: combat,
    };
    for (const [name, value] of Object.entries(targets)) {
      const last = this.targets[name];
      if (last !== undefined && Math.abs(last - value) < 0.004) continue;
      this.targets[name] = value;
      const param = this.stems[name].gain;
      if (instant) param.setValueAtTime(value, time);
      else param.setTargetAtTime(value, time, name === 'perc' ? 0.5 : name.startsWith('combat') ? 0.35 : 0.6);
    }
    this.combatIntensity = this.fadingOut ? 0 : mix.combat;
  }

  fadeValueAt(time) {
    const { from, to, start, end } = this.fade;
    if (time >= end) return to;
    if (time <= start) return from;
    return from + ((to - from) * (time - start)) / (end - start);
  }

  /** Fades the whole theme out (percussion leaves first) and schedules disposal. */
  fadeOut(time, seconds) {
    const value = this.fadeValueAt(time);
    for (const fader of [this.dry, this.wet]) {
      fader.gain.cancelScheduledValues(time);
      fader.gain.setValueAtTime(value, time);
      fader.gain.linearRampToValueAtTime(0, time + seconds);
    }
    this.fade = { from: value, to: 0, start: time, end: time + seconds };
    this.fadingOut = true;
    this.stopAt = Math.min(this.stopAt, time + seconds);
    this.disposeAt = this.stopAt + TAIL_SECONDS;
    this.targets.perc = 0;
    this.stems.perc.gain.setTargetAtTime(0, time, Math.min(0.4, seconds / 3));
  }

  /** Schedules every step whose time falls before `until`. */
  scheduleUntil(until) {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const barLength = STEPS_PER_BAR * this.stepDur;
    if (this.nextStepTime < now - barLength) {
      // Far behind (e.g. a throttled background tab): jump to the current bar.
      const skip = Math.min(256, Math.floor((now - this.barStart) / barLength));
      for (let i = 0; i < skip; i++) this.advanceBar();
      this.barStart += skip * barLength;
      this.step = 0;
      this.nextStepTime = this.barStart;
    }
    const limit = Math.min(until, this.stopAt);
    let guard = 0;
    while (this.nextStepTime < limit && guard++ < 256) {
      if (this.step === 0) this.planBar();
      if (this.nextStepTime >= now - 0.03) this.playStep(this.step, this.nextStepTime);
      this.advanceStep();
    }
  }

  advanceStep() {
    this.step += 1;
    if (this.step >= STEPS_PER_BAR) {
      this.step = 0;
      this.barStart += STEPS_PER_BAR * this.stepDur;
      this.advanceBar();
    }
    this.nextStepTime = this.barStart + this.step * this.stepDur;
  }

  advanceBar() {
    const { theme } = this;
    this.bar += 1;
    this.barInPhrase += 1;
    if (this.barInPhrase >= theme.sections[this.form[this.sectionIndex]].length) {
      this.barInPhrase = 0;
      this.phraseIndex += 1;
      this.sectionIndex += 1;
      if (this.sectionIndex >= this.form.length) {
        this.sectionIndex = 0;
        this.form = this.nextForm;
        this.nextForm = this.rng.pick(theme.forms);
      }
    }
  }

  get sectionName() {
    return this.form[this.sectionIndex];
  }

  /** Name of the first chord of the following bar (looks across phrases and forms). */
  peekNextChordName() {
    const { theme } = this;
    const section = theme.sections[this.sectionName];
    if (this.barInPhrase + 1 < section.length) return section[this.barInPhrase + 1][0];
    const nextSection = this.sectionIndex + 1 < this.form.length ? this.form[this.sectionIndex + 1] : this.nextForm[0];
    return theme.sections[nextSection][0][0];
  }

  /** Generator context handed to the theme's bass/drums/keys functions. */
  context() {
    const { theme } = this;
    const section = theme.sections[this.sectionName];
    const names = section[this.barInPhrase];
    const span = STEPS_PER_BAR / names.length;
    const segments = names.map((name, i) => ({ name, chord: theme.chords[name], startStep: i * span, endStep: (i + 1) * span }));
    const nextChord = theme.chords[this.peekNextChordName()];
    const indexAt = (step) => Math.min(segments.length - 1, Math.floor(clamp(step, 0, STEPS_PER_BAR - 1) / span));
    const chordAt = (step) => segments[indexAt(step)].chord;
    return {
      rng: this.rng,
      theme,
      bar: this.bar,
      barInPhrase: this.barInPhrase,
      phraseLength: section.length,
      phraseIndex: this.phraseIndex,
      sectionName: this.sectionName,
      isPhraseEnd: this.barInPhrase === section.length - 1,
      segments,
      nextChord,
      chordAt,
      chordAfter: (step) => (indexAt(step) + 1 < segments.length ? segments[indexAt(step) + 1].chord : nextChord),
      pitchClasses: (step) => chordAt(step).scale || theme.scale,
      /** A choice made once per phrase (grooves repeat and vary; they don't re-roll every bar). */
      phraseChoice: (key, choose) => {
        if (!this.phraseMemo.has(key)) this.phraseMemo.set(key, choose());
        return this.phraseMemo.get(key);
      },
      bassEvents: [],
    };
  }

  /** One pad per chord across the phrase; repeated chords are tied, not re-attacked. */
  planPhrasePads() {
    const { theme } = this;
    const merged = [];
    theme.sections[this.sectionName].forEach((names, bar) => {
      const span = STEPS_PER_BAR / names.length;
      names.forEach((name, i) => {
        const previous = merged[merged.length - 1];
        if (previous && previous.name === name) previous.len += span;
        else merged.push({ name, chord: theme.chords[name], bar, step: i * span, len: span });
      });
    });
    this.padPlan = merged;
  }

  planBar() {
    const { theme } = this;
    if (this.barInPhrase === 0) {
      this.planPhrasePads();
      this.phraseMemo.clear();
    }
    const g = this.context();
    const buckets = Array.from({ length: STEPS_PER_BAR }, () => []);
    const add = (events, layer) => {
      for (const event of events || []) {
        event.layer = layer;
        buckets[clamp(Math.round(finite(event.step)), 0, STEPS_PER_BAR - 1)].push(event);
      }
    };
    // Bass first, so the drums can lock the kick to it.
    g.bassEvents = theme.bass(g) || [];
    add(g.bassEvents, 'bass');
    if (!theme.noDrums) add(theme.drums(g), 'perc');
    add(theme.keys(g), 'keys');
    add(combatEvents(theme, g), 'combat');
    add(this.padPlan.filter((entry) => entry.bar === this.barInPhrase).map((entry) => ({ kind: 'pad', step: entry.step, notes: entry.chord.pad, len: entry.len })), 'pad');
    this.plan = buckets;
  }

  swingOffset(step) {
    const { theme } = this;
    let offset = 0;
    if (theme.swing8 && step % 4 === 2) offset += theme.swing8 * 2 * this.stepDur;
    if (theme.swing16 && step % 2 === 1) offset += theme.swing16 * this.stepDur;
    return offset;
  }

  playStep(step, baseTime) {
    const events = this.plan?.[step];
    if (!events?.length) return;
    for (const event of events) this.playEvent(event, baseTime);
  }

  playEvent(e, baseTime) {
    const { theme, stems, stepDur } = this;
    if (e.layer === 'perc' && !(this.targets.perc > 0.01)) return;
    if (e.layer === 'combat' && (this.fadingOut || this.combatIntensity < e.min || !(this.targets.combat > 0.01))) return;
    const kit = this.engine.kit;
    const human = e.layer === 'bass' || e.layer === 'perc' ? this.rng.range(-0.003, 0.003) : 0;
    const time = Math.max(this.ctx.currentTime, baseTime + this.swingOffset(e.step) + human);
    const brightness = this.engine.brightness;
    const drums = theme.drumStyle || {};
    switch (e.kind) {
      case 'bass': {
        const style = theme.bassStyle;
        const legato = e.slideTo !== undefined || e.len >= STEPS_PER_BAR;
        bass(kit, stems.bass, {
          time,
          midi: e.midi,
          duration: e.len * stepDur * (legato ? 1 : style.gate),
          velocity: e.vel,
          ghost: e.ghost,
          pop: e.pop,
          slideTo: e.slideTo,
          slideAt: e.slideTo !== undefined ? this.barStart + e.slideStep * stepDur : undefined,
          slideTime: (e.slideSteps || 1) * stepDur * 0.85,
          level: style.level,
          decay: style.decay,
          brightness: style.brightness * brightness,
          sub: style.sub,
          sustain: style.sustain,
          attack: style.attack,
          release: style.release,
        });
        break;
      }
      case 'pad':
        pad(kit, stems.pad, { time, notes: e.notes, duration: e.len * stepDur, ...theme.padStyle, brightness });
        break;
      case 'chord':
        e.notes.forEach((midi, i) => {
          fm(kit, stems.keys, {
            ...FM_PRESETS[e.preset || 'ep'], tag: 'ep', time: time + i * 0.007, midi, duration: e.len * stepDur, velocity: e.vel, brightness, detune: this.rng.range(-4, 4),
          });
        });
        break;
      case 'keys':
        fm(kit, stems.keys, { ...FM_PRESETS[e.preset || 'bell'], tag: 'keys', time, midi: e.midi, velocity: e.vel, pan: e.pan, brightness });
        break;
      case 'kick':
        kick(kit, stems.perc, { time, velocity: e.vel, level: 0.6, ...drums.kick });
        break;
      case 'snare':
        brush(kit, stems.perc, { time, velocity: e.vel, level: 0.2, decay: drums.snare?.decay, pan: -0.12 });
        break;
      case 'sweep':
        brush(kit, stems.perc, { time, velocity: e.vel, level: 0.2, sweep: true, pan: 0.2 });
        break;
      case 'hat':
        hat(kit, stems.perc, { time, velocity: e.vel, open: e.open, level: 1.5 * (drums.hatLevel ?? 0.05), pan: 0.22, brightness });
        break;
      case 'tom':
        tom(kit, e.layer === 'combat' ? stems.combat : stems.perc, { time, midi: e.midi, velocity: e.vel, level: 0.3 });
        break;
      case 'combatBass':
        bass(kit, stems.combatBass, {
          tag: 'cbass', time, midi: e.midi, duration: e.len * stepDur * 0.55, velocity: e.vel, level: 0.4, decay: 0.12, brightness: 1.2 * brightness, sub: 0.6, filterTc: 0.05,
        });
        break;
      case 'combatKick':
        kick(kit, stems.combat, { time, velocity: e.vel, level: 0.42, from: 150, to: 50, decay: 0.08 });
        break;
      case 'combatHat':
        hat(kit, stems.combat, { time, velocity: e.vel, level: 0.045, pan: -0.25, brightness });
        break;
      default:
        break;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const created of this.nodes) {
      try {
        created.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.nodes.length = 0;
    this.plan = null;
  }
}

/** Owns the theme players, scene mixing and theme transitions. */
export class MusicEngine {
  /**
   * @param {{ ctx: BaseAudioContext, mixer: import('./mixer.js').Mixer, voices: import('./voices.js').VoiceManager, seed?: number }} options
   */
  constructor({ ctx, mixer, voices, seed = 1 }) {
    this.ctx = ctx;
    this.mixer = mixer;
    this.seed = seed >>> 0;
    this.kit = { ctx, voices, mixer, rng: new Rng(seed + 101) };
    this.players = [];
    this.current = null;
    this.pendingThemeId = null;
    this.lastSwitch = -Infinity;
    this.switchCount = 0;
    this.scene = { world: null, mode: 'foot', altitude: 0, speed: 0, combat: 0, night: 0, reading: false };
    this.mix = { perc: 0, combat: 0, combatLevel: 0 };
    this.brightness = 1;
  }

  /** Active theme id ('philosophy' … 'contact', or 'space'), or null before the first scene. */
  get themeId() {
    return this.current ? this.current.theme.id : null;
  }

  /** The current player's tonal centre and mode (used by musical sound effects). */
  get key() {
    const theme = this.current?.theme || THEMES.space;
    return { tonic: theme.tonic, mode: theme.mode, scale: theme.scale, chord: this.current?.plan ? this.current.context().chordAt(this.current.step) : null };
  }

  /**
   * Updates the scene. A world change starts a crossfade, at most once per
   * MIN_SWITCH_INTERVAL seconds (later changes wait); `immediate` skips the wait.
   */
  setScene(scene, { immediate = false } = {}) {
    this.scene = normalizeScene(scene, this.scene);
    const id = themeIdForWorld(this.scene.world);
    this.pendingThemeId = !this.current || id !== this.current.theme.id ? id : null;
    this.trySwitch(immediate);
    this.applyMix();
  }

  computeMix() {
    const { reading, world, altitude, combat } = this.scene;
    const perc = reading || world === null ? 0 : 1 - smoothstep(250, 400, altitude);
    const intensity = reading ? 0 : combat;
    return { perc, combat: intensity, combatLevel: intensity > 0.001 ? intensity ** 0.7 : 0 };
  }

  applyMix() {
    const now = this.ctx.currentTime;
    this.mix = this.computeMix();
    this.brightness = 1 - 0.3 * this.scene.night;
    for (const player of this.players) player.applyMix(this.mix, now);
    this.mixer.setMusicLevel(this.scene.reading ? READING_LEVEL : 1, now, this.scene.reading ? 0.35 : 0.8);
    this.mixer.setNight(this.scene.night, now);
  }

  /** Starts the pending theme if the minimum interval since the last switch has passed. */
  trySwitch(immediate = false) {
    const id = this.pendingThemeId;
    if (!id) return false;
    const now = this.ctx.currentTime;
    if (!immediate && this.current && now - this.lastSwitch < MIN_SWITCH_INTERVAL) return false;
    const fadeSeconds = this.current ? CROSSFADE_SECONDS : FIRST_FADE_SECONDS;
    for (const player of this.players) {
      if (player === this.current) player.fadeOut(now, CROSSFADE_SECONDS);
      else if (!player.disposed) player.fadeOut(now, 0.4);
    }
    const seed = ((this.seed ^ hashString(id)) + this.switchCount * 7919) >>> 0;
    const player = new ThemePlayer(this, THEMES[id], { now, startTime: now + 0.05, seed, fadeSeconds });
    player.applyMix(this.mix, now, true);
    this.players.push(player);
    this.current = player;
    this.pendingThemeId = null;
    this.lastSwitch = now;
    this.switchCount += 1;
    return true;
  }

  /** Schedules all players up to `until` and retires finished ones. */
  schedule(until) {
    this.trySwitch();
    for (const player of this.players) player.scheduleUntil(until);
    const now = this.ctx.currentTime;
    this.players = this.players.filter((player) => {
      if (player !== this.current && now >= player.disposeAt) player.dispose();
      return !player.disposed;
    });
  }

  dispose() {
    for (const player of this.players) player.dispose();
    this.players = [];
    this.current = null;
  }
}
