import * as THREE from 'three';
import { PLANETS, PROJECT_LANDMARK_POSITIONS } from '../world/system.js';

/**
 * Speed in deep space: slipstream gates surge the Aster past its top speed.
 *  - The Circuit: sixteen gold gates weaving around the BEACN monument. Fly
 *    through the first to start the clock; medals for fast laps.
 *  - Slingshot lanes: five gates leaving each world toward the next one.
 *    Thread all five for a slingshot into the pulse drive.
 */
const TAU = Math.PI * 2;
export const CIRCUIT = Object.freeze({ center: PROJECT_LANDMARK_POSITIONS.beacn, radius: 5200, gates: 16, gateRadius: 80, bound: 10500 });
export const LANE = Object.freeze({ gates: 5, spacing: 1100, gateRadius: 95, start: 1.55, window: 8 });
/** Speed limits while racing (the pulse drive would skip the gates). */
export const RACE_LIMITS = Object.freeze({ max: 1000, boost: 1450 });

/** True when start->end crosses the gate's plane inside its aperture. */
export function crossesRing(start, end, center, normal, radius) {
  const ax = start.x - center.x, ay = start.y - center.y, az = start.z - center.z;
  const bx = end.x - center.x, by = end.y - center.y, bz = end.z - center.z;
  const a = ax * normal.x + ay * normal.y + az * normal.z;
  const b = bx * normal.x + by * normal.y + bz * normal.z;
  if (a * b > 0 || Math.abs(a - b) < 1e-9) return false;
  const t = a / (a - b);
  const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
  return x * x + y * y + z * z <= radius * radius;
}

function circuitPoint(a, out = new THREE.Vector3()) {
  const [cx, cy, cz] = CIRCUIT.center, r = CIRCUIT.radius + Math.sin(a * 3) * 900;
  return out.set(cx + Math.cos(a) * r, cy + Math.sin(a * 2 + 0.6) * 1100 + Math.sin(a) * r * 0.22, cz + Math.sin(a) * r);
}

/** The circuit: a closed loop weaving around the BEACN monument. */
export function circuitGates() {
  const gates = [];
  for (let i = 0; i < CIRCUIT.gates; i++) {
    const a = i / CIRCUIT.gates * TAU;
    const normal = circuitPoint(a + 0.002).sub(circuitPoint(a - 0.002)).normalize();
    gates.push({ id: `circuit:${i}`, kind: 'circuit', index: i, center: circuitPoint(a), normal, radius: CIRCUIT.gateRadius });
  }
  return gates;
}

/** Slingshot lanes: five gates leaving each world toward the next one. */
export function laneGates() {
  const gates = [];
  PLANETS.forEach((planet, i) => {
    const next = PLANETS[(i + 1) % PLANETS.length];
    const from = new THREE.Vector3(...planet.position), dir = new THREE.Vector3(...next.position).sub(from).normalize();
    for (let k = 0; k < LANE.gates; k++) {
      const center = from.clone().addScaledVector(dir, planet.radius * LANE.start + k * LANE.spacing);
      gates.push({ id: `lane:${planet.id}:${k}`, kind: 'lane', lane: planet.id, to: next.id, index: k, center, normal: dir.clone(), radius: LANE.gateRadius, color: next.color });
    }
  });
  return gates;
}

/** Medal times (seconds) from the lap length and target average speeds. */
export function medalTimes(gates = circuitGates()) {
  let length = 0;
  for (let i = 0; i < gates.length; i++) length += gates[i].center.distanceTo(gates[(i + 1) % gates.length].center);
  return { length, gold: Math.round(length / 1400), silver: Math.round(length / 1150), bronze: Math.round(length / 850) };
}

const GOLD = new THREE.Color('#ffd27a'), _c = new THREE.Color(), _d = new THREE.Vector3();

export class Slipstream {
  /** @param {{ onGate?, onRaceStart?, onLap?, onRaceAbort?, onSlingshot? }} events */
  constructor(scene, { events = {} } = {}) {
    this.events = events;
    this.circuit = circuitGates(); this.lanes = laneGates();
    this.gates = [...this.circuit, ...this.lanes];
    this.medals = medalTimes(this.circuit);
    this.center = new THREE.Vector3(...CIRCUIT.center);
    this.race = null; this.chain = null;
    this.group = new THREE.Group(); this.group.name = 'slipstream'; scene.add(this.group);
    const glow = (geometry, opacity) => new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }), this.gates.length);
    this.rings = glow(new THREE.TorusGeometry(1, 0.04, 8, 72), 1);
    this.discs = glow(new THREE.RingGeometry(0.55, 0.97, 72), 0.1);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), z = new THREE.Vector3(0, 0, 1);
    this.gates.forEach((g, i) => {
      g.slot = i; g.tint = g.kind === 'circuit' ? GOLD : new THREE.Color(g.color);
      m.compose(g.center, q.setFromUnitVectors(z, g.normal), s.setScalar(g.radius));
      this.rings.setMatrixAt(i, m); this.discs.setMatrixAt(i, m);
    });
    for (const mesh of [this.rings, this.discs]) { mesh.frustumCulled = false; this.group.add(mesh); }
    this.#paint(0);
  }

  get racing() { return Boolean(this.race); }
  /** The gate the HUD should point at: the race's next gate, the lane's next gate, or the circuit's start. */
  get nextGate() {
    if (this.race) return this.circuit[this.race.next];
    if (this.chain) return this.lanes.find(g => g.lane === this.chain.lane && g.index === this.chain.next) || null;
    return null;
  }
  medalFor(time) { return time <= this.medals.gold ? 'gold' : time <= this.medals.silver ? 'silver' : time <= this.medals.bronze ? 'bronze' : null; }

  /** Checks the ship's path this frame (from -> to) against every gate. */
  update(dt, time, from, to, { active = true } = {}) {
    if (this.race) {
      this.race.t += dt;
      if (this.race.t > 300 || to.distanceTo(this.center) > CIRCUIT.bound || !active) this.abortRace();
    }
    if (this.chain && (this.chain.timer -= dt) <= 0) this.chain = null;
    const step = _d.copy(to).sub(from), moved = step.lengthSq();
    if (active && moved > 1e-6 && moved < 1e8) { // a jump (teleport, respawn) is not a pass
      for (const gate of this.gates) if (step.dot(gate.normal) > 0 && crossesRing(from, to, gate.center, gate.normal, gate.radius)) this.#pass(gate);
    }
    this.#paint(time);
  }

  abortRace() { if (!this.race) return; const race = this.race; this.race = null; this.events.onRaceAbort?.(race); }

  #pass(gate) {
    if (gate.kind === 'circuit') {
      const race = this.race;
      if (!race) {
        if (gate.index !== 0) return;
        this.race = { t: 0, next: 1, lap: 1 };
        this.events.onRaceStart?.(this.race);
      } else if (gate.index !== race.next) return;
      else if (gate.index === 0) { // the finish line starts the next lap
        this.race = { t: 0, next: 1, lap: race.lap + 1 };
        this.events.onLap?.({ time: race.t, lap: race.lap, medal: this.medalFor(race.t) });
      } else race.next = (race.next + 1) % this.circuit.length;
      this.events.onGate?.(gate, { race: this.race });
      return;
    }
    const chain = this.chain;
    if (chain && chain.lane === gate.lane && gate.index === chain.next) { chain.next++; chain.timer = LANE.window; }
    else if (gate.index === 0) this.chain = { lane: gate.lane, next: 1, timer: LANE.window };
    else { this.chain = null; return; } // out of order: no surge
    const done = this.chain.next >= LANE.gates;
    this.events.onGate?.(gate, { chain: this.chain.next, done });
    if (done) { this.chain = null; this.events.onSlingshot?.(gate); }
  }

  #paint(time) {
    const pulse = 0.75 + 0.25 * Math.sin(time * 6), race = this.race, chain = this.chain;
    for (const g of this.gates) {
      let k;
      if (g.kind === 'circuit') {
        const next = race ? race.next : 0, done = race && (race.next === 0 || g.index < race.next);
        k = g.index === next ? 2.4 * pulse : done ? 0.22 : race ? 1 : 0.8;
      } else if (chain && chain.lane === g.lane) k = g.index === chain.next ? 2.4 * pulse : g.index < chain.next ? 0.22 : 1;
      else k = 0.75;
      _c.copy(g.tint).multiplyScalar(k);
      this.rings.setColorAt(g.slot, _c); this.discs.setColorAt(g.slot, _c);
    }
    this.rings.instanceColor.needsUpdate = true; this.discs.instanceColor.needsUpdate = true;
  }
}
