import * as THREE from 'three';
import { segmentSphereHitTime } from '../engine/math.js';

/**
 * Two small, personal mini-games on the Experience world:
 *  - The Arena: a timed target run (a nod to the competitive years).
 *  - The Stage: glowing pads that play a fingered electric bass; find the
 *    groove to unlock the agent's air-bass emote.
 */
const PAD_NOTES = [33, 36, 38, 40, 43, 45, 48, 50]; // A1 C2 D2 E2 G2 A2 C3 D3 (A minor pentatonic)
const GROOVE = [0, 3, 4, 3, 5, 4]; // a little bassline to discover

export class Challenges {
  constructor(scene, { fx, sound, events }) {
    this.scene = scene; this.fx = fx; this.sound = sound; this.events = events;
    this.group = new THREE.Group(); this.group.name = 'challenges'; scene.add(this.group);
    this.arena = null; this.targets = [];
    this.padState = { last: -1, history: [], cooldown: 0 };
    this.targetGeo = new THREE.TorusGeometry(0.75, 0.16, 10, 28);
    this.targetCore = new THREE.SphereGeometry(0.32, 16, 10);
  }

  /* ---------------------------------------------------------------- arena */
  startArena(world) {
    if (this.arena) return false;
    const spawns = world.spawns.filter(s => /SPAWN_target/.test(s.name));
    if (!spawns.length) return false;
    this.arena = { t: 0, order: [...spawns].sort(() => Math.random() - 0.5), next: 0, hits: 0, total: spawns.length, limit: 35 };
    for (let i = 0; i < 3; i++) this.#spawnTarget();
    this.events.onArena?.('start', this.arena);
    return true;
  }
  #spawnTarget() {
    const a = this.arena; if (!a || a.next >= a.order.length) return;
    const s = a.order[a.next++];
    const root = new THREE.Group();
    const ring = new THREE.Mesh(this.targetGeo, new THREE.MeshStandardMaterial({ color: '#ffb27a', emissive: '#ff8a4c', emissiveIntensity: 1.6, roughness: 0.4 }));
    const core = new THREE.Mesh(this.targetCore, new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffe1b8', emissiveIntensity: 2.5 }));
    root.add(ring, core); root.position.copy(s.position);
    this.group.add(root);
    this.targets.push({ root, ring, position: s.position.clone(), phase: Math.random() * 6 });
  }
  /** Checks a player bolt segment against arena targets. */
  hitTest(start, end) {
    if (!this.arena) return false;
    for (const t of this.targets) {
      if (segmentSphereHitTime(start, end, t.root.position, 0.95) !== null) {
        this.fx.sparks(t.root.position, '#ffd2a8', 18, 8); this.fx.flash(t.root.position, '#ffe7c4', 4, 0.2);
        this.group.remove(t.root); this.targets.splice(this.targets.indexOf(t), 1);
        this.arena.hits++; this.sound?.play('hitmarker'); this.#spawnTarget();
        if (this.arena.hits >= this.arena.total) this.#finishArena(true);
        return true;
      }
    }
    return false;
  }
  #finishArena(won) {
    const a = this.arena; this.arena = null;
    for (const t of this.targets) this.group.remove(t.root);
    this.targets = [];
    this.events.onArena?.(won ? 'win' : 'fail', a);
  }

  /* ----------------------------------------------------------------- pads */
  updatePads(world, player, dt) {
    this.padState.cooldown = Math.max(0, this.padState.cooldown - dt);
    if (!world || !player.grounded) { this.padState.last = -1; return; }
    let on = -1;
    for (const poi of world.pois) {
      const m = /^POI_pad_(\d)/.exec(poi.name); if (!m) continue;
      if (poi.position.distanceTo(player.position) < 0.85) { on = Number(m[1]); break; }
    }
    if (on >= 0 && on !== this.padState.last) {
      this.sound?.play('notePad', { pitch: PAD_NOTES[on] });
      this.fx.ring(world.pois.find(p => p.name === `POI_pad_${on}`).position.clone().addScaledVector(player.up, 0.05), player.up, '#ffb27a', 1.6, 0.5);
      this.padState.history.push(on); if (this.padState.history.length > GROOVE.length) this.padState.history.shift();
      if (this.padState.history.join(',') === GROOVE.join(',')) { this.padState.history = []; this.events.onGroove?.(); }
      this.events.onPad?.(on);
    }
    this.padState.last = on;
  }

  update(dt, time) {
    if (this.arena) {
      this.arena.t += dt;
      if (this.arena.t > this.arena.limit) this.#finishArena(false);
    }
    for (const t of this.targets) {
      t.root.position.copy(t.position);
      t.root.position.y += Math.sin(time * 2 + t.phase) * 0.25;
      t.ring.rotation.y = time * 1.5 + t.phase;
    }
  }
  get arenaActive() { return !!this.arena; }
  static groove() { return GROOVE.slice(); }
}
