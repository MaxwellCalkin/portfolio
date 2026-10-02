import { levelForXP, weaponForXP } from '../model.js';

/**
 * One expedition's score. The model mirrors the public flight log's server
 * validation (netlify/functions/_shared/leaderboard-core.js), so every run
 * a visitor chooses to publish is accepted:
 *   xp    = kills * 40  + wardens * 160 + crystals * 5
 *   score = kills * 110 + wardens * 790 + crystals * 20
 * "Crystals" are the scoring unit for everything that is not a fight:
 * discoveries, resonance shards and the Experience mini-games.
 */
export const CRYSTALS = Object.freeze({ discovery: 6, archive: 10, shard: 4, arena: 12, groove: 6, world: 5 });

export class Run {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.reset();
  }
  reset() {
    this.kills = 0; this.wardens = 0; this.crystals = 0;
    this.startedAt = this.now(); this.pausedFor = 0; this.pauseStart = null;
    this.read = new Set(); this.rewarded = new Set();
  }
  get xp() { return this.kills * 40 + this.wardens * 160 + this.crystals * 5; }
  get score() { return this.kills * 110 + this.wardens * 790 + this.crystals * 20; }
  get level() { return levelForXP(this.xp); }
  get weapon() { return weaponForXP(this.xp); }
  /** Seconds of active play (pauses excluded). */
  get duration() {
    const paused = this.pausedFor + (this.pauseStart !== null ? this.now() - this.pauseStart : 0);
    return Math.max(0, Math.floor((this.now() - this.startedAt - paused) / 1000));
  }
  pause(on) {
    if (on && this.pauseStart === null) this.pauseStart = this.now();
    else if (!on && this.pauseStart !== null) { this.pausedFor += this.now() - this.pauseStart; this.pauseStart = null; }
  }
  /** Adds crystals once per key (so re-reading a landmark never farms points). */
  reward(key, kind) {
    if (this.rewarded.has(key)) return 0;
    this.rewarded.add(key);
    const amount = CRYSTALS[kind] ?? 0;
    this.crystals += amount;
    return amount;
  }
  kill(warden = false) { this.kills++; if (warden) this.wardens = Math.min(5, this.wardens + 1); }
  /** The public fields for the flight log. */
  record(name) {
    return { name, score: this.score, kills: this.kills, level: this.level, xp: this.xp, duration: this.duration, bossKills: this.wardens, date: new Date().toISOString() };
  }
}
