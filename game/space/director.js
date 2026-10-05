import * as THREE from 'three';
import { RIFTS, FIELD_RADIUS, LEASH_RADIUS, wavesFor, tierFor } from './rifts.js';

/**
 * Encounters in deep space. Flying into a rift's field starts an incursion:
 * waves of the Static until the rift falls silent (fly out to retreat).
 * Elsewhere, the odd patrol finds the Aster in open space; the pulse drive
 * outruns it. Pure logic over an injected fleet (spawn, count, despawn).
 */
const WARNING = 2.4, PATROL_GAP = [70, 120], PATROL_LEASH = 6500;

export class SpaceDirector {
  /**
   * @param {object} o { fleet, clears(riftId) -> times silenced, random, events:
   *   { onIncursion(enc), onWave(enc), onWaveCleared(enc), onRiftCleared(enc), onAbort(enc, reason), onPatrol() } }
   */
  constructor({ fleet, events = {}, random = Math.random, clears = () => 0 } = {}) {
    Object.assign(this, { fleet, events, random, clears });
    this.rifts = RIFTS.map(rift => ({ ...rift, center: new THREE.Vector3(...rift.position) }));
    this.encounter = null;
    this.patrolTimer = 45 + random() * 30;
  }

  /** The rift whose field holds `position` (the pulse drive is jammed there). */
  fieldAt(position, margin = 0) { return this.rifts.find(r => r.center.distanceTo(position) < FIELD_RADIUS + margin) || null; }

  /**
   * @param {object} ctx { position, forward, flying (manual flight), patrols (setting), quiet (near a world, racing) }
   */
  update(dt, ctx) {
    if (this.encounter) this.#updateEncounter(dt, ctx);
    else if (ctx.flying) {
      // A rift that just fell quiet (or that you fled) waits until you leave its field.
      const rift = this.fieldAt(ctx.position);
      if (!rift || rift.id !== this.lull) { this.lull = null; if (rift) this.#begin(rift); }
    }
    this.#updatePatrol(dt, ctx);
  }

  #begin(rift) {
    const clears = this.clears(rift.id);
    // Going down mid-incursion keeps your place: fly back in to resume at that wave.
    const wave = this.checkpoint?.rift === rift.id ? this.checkpoint.wave : 0;
    this.checkpoint = null;
    this.encounter = { rift, clears, tier: tierFor(rift, clears), waves: wavesFor(rift, clears), wave, phase: 'warning', timer: WARNING, encore: clears > 0, resumed: wave > 0 };
    this.fleet.despawn('patrol');
    this.events.onIncursion?.(this.encounter);
  }
  #updateEncounter(dt, ctx) {
    const enc = this.encounter;
    if (enc.rift.center.distanceTo(ctx.position) > LEASH_RADIUS) { this.abort('retreat'); return; }
    if (enc.phase === 'warning') {
      if ((enc.timer -= dt) > 0) return;
      this.#spawnWave(enc, ctx);
      enc.phase = 'fighting';
      this.events.onWave?.(enc);
    } else if (this.fleet.count('rift') === 0) {
      if (enc.wave + 1 < enc.waves.length) { enc.wave++; enc.phase = 'warning'; enc.timer = WARNING; this.events.onWaveCleared?.(enc); }
      else { this.encounter = null; this.lull = enc.rift.id; this.events.onRiftCleared?.(enc); }
    }
  }
  #spawnWave(enc, ctx) {
    for (const [type, count] of enc.waves[enc.wave]) {
      for (let i = 0; i < count; i++) {
        // The carrier holds station in front of the rift's core, between it and the Aster.
        const position = type === 'boss' ? enc.rift.center.clone().addScaledVector(ctx.position.clone().sub(enc.rift.center).normalize(), 750) : this.#spawnPoint(enc.rift.center, ctx.position);
        this.fleet.spawn(type, position, { tier: enc.tier, tag: 'rift', toward: ctx.position, color: enc.rift.color });
      }
    }
  }
  /** Around the rift's core, never on top of the Aster. */
  #spawnPoint(center, ship) {
    for (let i = 0; i < 12; i++) {
      const p = new THREE.Vector3(this.random() - 0.5, (this.random() - 0.5) * 0.5, this.random() - 0.5).normalize().multiplyScalar(500 + this.random() * 1100).add(center);
      if (p.distanceTo(ship) > 900) return p;
    }
    return center.clone().addScaledVector(center.clone().sub(ship).normalize(), 600);
  }

  /** Ends the incursion without a result (retreat, the Aster went down, left the ship). */
  abort(reason = 'retreat') {
    const enc = this.encounter; if (!enc) return;
    this.encounter = null; this.lull = enc.rift.id;
    this.checkpoint = reason === 'down' ? { rift: enc.rift.id, wave: enc.wave } : null;
    this.fleet.despawn('rift');
    this.events.onAbort?.(enc, reason);
  }
  /** Where the Aster re-forms after going down: outside the field, facing the rift. */
  respawnPoint(position) {
    const rift = this.encounter?.rift || this.fieldAt(position, 2500);
    if (!rift) return null;
    const out = position.clone().sub(rift.center); if (out.lengthSq() < 1) out.set(0, 0, 1);
    out.normalize();
    return { position: rift.center.clone().addScaledVector(out, FIELD_RADIUS + 1400), facing: out.clone().negate(), rift };
  }

  #updatePatrol(dt, ctx) {
    if (this.fleet.count('patrol')) {
      let near = false;
      for (const e of this.fleet.enemies) if (e.tag === 'patrol' && !e.dead && e.position.distanceTo(ctx.position) < PATROL_LEASH) { near = true; break; }
      if (!near || ctx.quiet || !ctx.flying) this.fleet.despawn('patrol'); // outran, or reached a world
      return;
    }
    if (!ctx.patrols || !ctx.flying || ctx.quiet || this.encounter || this.fieldAt(ctx.position, 4000)) return;
    if ((this.patrolTimer -= dt) > 0) return;
    this.patrolTimer = PATROL_GAP[0] + this.random() * (PATROL_GAP[1] - PATROL_GAP[0]);
    const silenced = this.rifts.filter(r => this.clears(r.id) > 0).length;
    const squad = [['glitch', 2 + (this.random() < 0.5 ? 1 : 0)], ...(silenced >= 2 ? [['jammer', 1]] : [])];
    for (const [type, count] of squad) for (let i = 0; i < count; i++) {
      const dir = ctx.forward.clone().add(new THREE.Vector3(this.random() - 0.5, this.random() - 0.5, this.random() - 0.5).multiplyScalar(0.7)).normalize();
      this.fleet.spawn(type, ctx.position.clone().addScaledVector(dir, 2200 + this.random() * 600), { tier: 1 + Math.min(3, silenced), tag: 'patrol', toward: ctx.position, color: '#ff4d6d' });
    }
    this.events.onPatrol?.();
  }
}
