// Shared helpers for the synthesized soundscape: seeded randomness, pitch math,
// musical modes and small AudioParam conveniences. No Web Audio nodes are
// created here, so this module is safe to import anywhere (including Node).

/** Semitone offsets for the modes the themes use. */
export const MODES = Object.freeze({
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
});

/** Five-note subsets that stay diatonic inside each mode (used by pickups). */
export const PENTATONIC = Object.freeze({
  ionian: [0, 2, 4, 7, 9],
  dorian: [0, 2, 3, 7, 9],
  lydian: [0, 2, 4, 7, 9],
  mixolydian: [0, 2, 4, 7, 9],
  aeolian: [0, 3, 5, 7, 10],
});

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const lerp = (a, b, t) => a + (b - a) * t;

/** Hermite smoothstep from edge0 to edge1 (returns 0..1). */
export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);
export const dbToGain = (db) => 10 ** (db / 20);

/** Finite-number guard: returns `fallback` for NaN, Infinity or non-numbers. */
export const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

/** True for OfflineAudioContext (rendering is driven manually, never suspended). */
export const isOfflineContext = (ctx) => Boolean(ctx) && typeof ctx.startRendering === 'function';

/** FNV-1a string hash, used to derive per-theme seeds. */
export function hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Small seeded PRNG (mulberry32) with musical conveniences. All randomness in
 * the soundscape flows through instances of this class so a given seed always
 * produces the same (varied, never chaotic) performance.
 */
export class Rng {
  constructor(seed = 1) {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Uniform float in [0, 1). */
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min, max) {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  chance(probability) {
    return this.next() < probability;
  }

  pick(items) {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Picks from [[item, weight], ...]. */
  weighted(entries) {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [item, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return item;
    }
    return entries[entries.length - 1][0];
  }

  /** Symmetric jitter: value * (1 ± amount). */
  jitter(value, amount) {
    return value * (1 + (this.next() * 2 - 1) * amount);
  }
}

/**
 * Smoothly move an AudioParam toward `value` using an exponential approach.
 * Cancels nothing; callers gate calls so automation lists stay short.
 */
export function glide(param, value, time, timeConstant) {
  param.setTargetAtTime(finite(value), Math.max(0, time), Math.max(0.001, timeConstant));
}

/** Hard-set an AudioParam at `time` after clearing any pending automation. */
export function setNow(param, value, time) {
  param.cancelScheduledValues(time);
  param.setValueAtTime(finite(value), time);
}
