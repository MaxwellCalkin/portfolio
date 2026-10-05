/**
 * Visitor settings (persisted) and graphics quality presets.
 */
const KEY = 'unfolding-settings-v2';

export const QUALITY = Object.freeze({
  high: { pixelRatio: 1.75, shadows: true, shadowSize: 2048, post: 'high', terrain: 'high', flora: 'high' },
  medium: { pixelRatio: 1.35, shadows: true, shadowSize: 1024, post: 'medium', terrain: 'high', flora: 'medium' },
  low: { pixelRatio: 1.0, shadows: false, shadowSize: 512, post: 'low', terrain: 'low', flora: 'low' },
});

const DEFAULTS = Object.freeze({ sound: true, volume: 0.7, quality: 'auto', sensitivity: 1, invertY: false, reducedMotion: null, hints: true, patrols: true });

export class Settings {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.data = { ...DEFAULTS };
    try { const raw = storage?.getItem(KEY); if (raw) Object.assign(this.data, JSON.parse(raw)); } catch { /* storage unavailable */ }
    if (!['auto', 'high', 'medium', 'low'].includes(this.data.quality)) this.data.quality = 'auto';
    this.listeners = new Set();
  }
  get(key) { return this.data[key]; }
  set(patch) {
    Object.assign(this.data, patch);
    try { this.storage?.setItem(KEY, JSON.stringify(this.data)); } catch { /* ignore */ }
    for (const fn of this.listeners) fn(patch, this.data);
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  get reducedMotion() {
    if (typeof this.data.reducedMotion === 'boolean') return this.data.reducedMotion;
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }
}

/** Picks a starting quality tier from the device, unless the visitor chose one. */
export function detectQuality(choice = 'auto', env = globalThis) {
  const forced = new URLSearchParams(env.location?.search || '').get('quality');
  if (['high', 'medium', 'low'].includes(forced)) return forced;
  if (choice !== 'auto') return choice;
  const coarse = env.matchMedia?.('(pointer: coarse)').matches;
  const cores = env.navigator?.hardwareConcurrency || 4;
  const memory = env.navigator?.deviceMemory || 8;
  const small = Math.min(env.innerWidth || 1280, env.innerHeight || 800) < 600;
  if (coarse && (small || cores <= 6 || memory <= 4)) return 'low';
  if (coarse || cores <= 4 || memory <= 4) return 'medium';
  return 'high';
}
