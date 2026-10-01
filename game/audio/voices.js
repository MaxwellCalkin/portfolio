// Voice bookkeeping: every synthesized note or sound effect is a Voice that
// owns its nodes, starts and stops its sources, and disconnects everything
// once it has finished. VoiceManager caps concurrency and steals gracefully.

import { finite } from './util.js';

const STEAL_FADE = 0.025;
const PRUNE_MARGIN = 0.3;

/** One short-lived sound: a small graph ending in `voice.out`. */
export class Voice {
  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} destination where `out` connects
   * @param {{ tag?: string, priority?: number, start?: number }} options
   */
  constructor(ctx, destination, { tag = 'voice', priority = 1, start } = {}) {
    this.ctx = ctx;
    this.tag = tag;
    this.priority = priority;
    this.startTime = Math.max(ctx.currentTime, finite(start, ctx.currentTime));
    this.endTime = this.startTime;
    this.nodes = [];
    this.sources = [];
    this.pendingEnds = 0;
    this.done = false;
    this.scheduled = false;
    this.out = this.track(ctx.createGain());
    this.out.connect(destination);
  }

  /** Registers a node for disconnection when the voice finishes. */
  track(node) {
    this.nodes.push(node);
    return node;
  }

  /** Connects nodes in series and returns the last one. */
  chain(...nodes) {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }

  /** Oscillator source; `wave` (PeriodicWave) overrides `type`. */
  osc(type, frequency, { wave = null, detune = 0, start } = {}) {
    const node = this.ctx.createOscillator();
    if (wave) node.setPeriodicWave(wave);
    else node.type = type;
    node.frequency.setValueAtTime(finite(frequency, 440), this.startTime);
    if (detune) node.detune.setValueAtTime(detune, this.startTime);
    this.sources.push({ node, start: finite(start, this.startTime) });
    return this.track(node);
  }

  /** Buffer source (noise etc.) starting at a random offset to avoid repetition. */
  buffer(audioBuffer, { loop = true, rate = 1, offset = 0, start } = {}) {
    const node = this.ctx.createBufferSource();
    node.buffer = audioBuffer;
    node.loop = loop;
    node.playbackRate.setValueAtTime(rate, this.startTime);
    this.sources.push({ node, start: finite(start, this.startTime), offset });
    return this.track(node);
  }

  gain(value = 1) {
    const node = this.ctx.createGain();
    node.gain.setValueAtTime(finite(value), this.startTime);
    return this.track(node);
  }

  filter(type, frequency, q = 0.707, gainDb = 0) {
    const node = this.ctx.createBiquadFilter();
    node.type = type;
    node.frequency.setValueAtTime(finite(frequency, 1000), this.startTime);
    node.Q.setValueAtTime(q, this.startTime);
    if (gainDb) node.gain.setValueAtTime(gainDb, this.startTime);
    return this.track(node);
  }

  /** Stereo panner, or a pass-through gain where StereoPanner is unavailable. */
  pan(value = 0) {
    if (typeof this.ctx.createStereoPanner !== 'function') return this.gain(1);
    const node = this.ctx.createStereoPanner();
    node.pan.setValueAtTime(Math.max(-1, Math.min(1, finite(value))), this.startTime);
    return this.track(node);
  }

  /**
   * Starts every source and schedules them to stop at `end`.
   * Cleanup runs when the final source reports `ended`.
   */
  schedule(end) {
    if (this.scheduled) return this;
    this.scheduled = true;
    this.endTime = Math.max(this.startTime + 0.005, finite(end, this.startTime + 0.5));
    this.pendingEnds = this.sources.length;
    for (const entry of this.sources) {
      entry.node.onended = () => {
        this.pendingEnds -= 1;
        if (this.pendingEnds <= 0) this.dispose();
      };
      if (entry.offset !== undefined) entry.node.start(entry.start, entry.offset);
      else entry.node.start(entry.start);
      entry.node.stop(this.endTime);
    }
    if (!this.sources.length) this.dispose();
    return this;
  }

  /** Quick fade-out used when the voice is stolen or everything is silenced. */
  release(time = this.ctx.currentTime, fade = STEAL_FADE) {
    if (this.done) return;
    const at = Math.max(time, this.ctx.currentTime);
    const stopAt = at + fade + 0.01;
    if (stopAt >= this.endTime) return;
    this.out.gain.cancelScheduledValues(at);
    this.out.gain.setValueAtTime(1, at);
    this.out.gain.linearRampToValueAtTime(0, at + fade);
    this.endTime = stopAt;
    for (const entry of this.sources) {
      try {
        entry.node.stop(stopAt);
      } catch {
        // Source already stopped; nothing to do.
      }
    }
  }

  /** Disconnects every node. Safe to call more than once. */
  dispose() {
    if (this.done) return;
    this.done = true;
    for (const node of this.nodes) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected.
      }
      if ('onended' in node) node.onended = null;
    }
    this.nodes.length = 0;
    this.sources.length = 0;
  }
}

/**
 * Bounded pool of active voices. Limits total concurrency and per-tag
 * concurrency, rate-limits identical triggers, and steals the oldest,
 * lowest-priority voice when full.
 */
export class VoiceManager {
  /**
   * @param {BaseAudioContext} ctx
   * @param {{ maxVoices?: number, tagLimits?: Record<string, number>, minIntervals?: Record<string, number> }} options
   */
  constructor(ctx, { maxVoices = 32, tagLimits = {}, minIntervals = {} } = {}) {
    this.ctx = ctx;
    this.maxVoices = maxVoices;
    this.tagLimits = tagLimits;
    this.minIntervals = minIntervals;
    this.active = [];
    this.releasing = [];
    this.lastTrigger = new Map();
    this.created = 0;
    this.stolen = 0;
    this.dropped = 0;
  }

  get count() {
    this.prune();
    return this.active.length;
  }

  countTag(tag) {
    this.prune();
    return this.active.reduce((n, voice) => n + (voice.tag === tag ? 1 : 0), 0);
  }

  /** True when a trigger of `tag` at `time` would be inside its minimum interval. */
  isRateLimited(tag, time = this.ctx.currentTime) {
    const interval = this.minIntervals[tag];
    if (!interval) return false;
    const last = this.lastTrigger.get(tag);
    return last !== undefined && time - last < interval && time >= last;
  }

  /**
   * Creates a voice, stealing older ones if limits are reached.
   * Returns null when the trigger is rate-limited.
   */
  create(tag, destination, { priority = 1, start, limit } = {}) {
    const at = finite(start, this.ctx.currentTime);
    if (this.isRateLimited(tag, at)) {
      this.dropped += 1;
      return null;
    }
    this.lastTrigger.set(tag, at);
    this.prune();
    const tagLimit = limit ?? this.tagLimits[tag] ?? this.maxVoices;
    const sameTag = this.active.filter((voice) => voice.tag === tag);
    if (sameTag.length >= tagLimit) this.steal(sameTag[0]);
    if (this.active.length >= this.maxVoices) {
      const victim = [...this.active].sort((a, b) => a.priority - b.priority || a.startTime - b.startTime)[0];
      this.steal(victim);
    }
    const voice = new Voice(this.ctx, destination, { tag, priority, start: at });
    this.active.push(voice);
    this.created += 1;
    return voice;
  }

  steal(voice) {
    if (!voice) return;
    voice.release(this.ctx.currentTime);
    this.active = this.active.filter((entry) => entry !== voice);
    this.stolen += 1;
    // A stolen voice disposes itself on `ended`; it is also kept here so that
    // prune() can clean it up by time if that event never arrives.
    this.releasing.push(voice);
  }

  /** Removes voices that have finished (by event or by time). */
  prune(now = this.ctx.currentTime) {
    if (this.active.length) {
      this.active = this.active.filter((voice) => {
        if (voice.done) return false;
        if (voice.scheduled && now > voice.endTime + PRUNE_MARGIN) {
          voice.dispose();
          return false;
        }
        return true;
      });
    }
    if (this.releasing.length) {
      this.releasing = this.releasing.filter((voice) => {
        if (voice.done) return false;
        if (now > voice.endTime + PRUNE_MARGIN) {
          voice.dispose();
          return false;
        }
        return true;
      });
    }
  }

  /** Fades out everything (used by dispose and hard stops). */
  releaseAll(fade = 0.05) {
    const now = this.ctx.currentTime;
    for (const voice of this.active) voice.release(now, fade);
    this.releasing.push(...this.active);
    this.active = [];
  }

  /** Immediately disconnects every voice. */
  disposeAll() {
    for (const voice of [...this.active, ...this.releasing]) voice.dispose();
    this.active = [];
    this.releasing = [];
  }
}
