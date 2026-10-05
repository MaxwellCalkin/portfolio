import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Slipstream, crossesRing, circuitGates, laneGates, medalTimes, CIRCUIT, LANE } from '../game/space/slipstream.js';
import { RIFTS, FIELD_RADIUS, LEASH_RADIUS } from '../game/space/rifts.js';
import { PLANETS, PROJECT_LANDMARK_POSITIONS } from '../game/world/system.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const through = (gate, before = 30, after = 30) => [gate.center.clone().addScaledVector(gate.normal, -before), gate.center.clone().addScaledVector(gate.normal, after)];

test('a ring only counts a path that crosses its plane inside the aperture', () => {
  const n = V(0, 0, 1);
  assert.equal(crossesRing(V(0, 0, -5), V(0, 0, 5), V(), n, 10), true);
  assert.equal(crossesRing(V(9, 0, -5), V(9, 0, 5), V(), n, 10), true);
  assert.equal(crossesRing(V(11, 0, -5), V(11, 0, 5), V(), n, 10), false, 'outside the ring');
  assert.equal(crossesRing(V(0, 0, 2), V(0, 0, 5), V(), n, 10), false, 'never reaches the plane');
  assert.equal(crossesRing(V(-20, 0, 0), V(20, 0, 0), V(), n, 10), false, 'slides along the plane');
});

test('the circuit is a closed loop of sixteen gates around BEACN, each facing the next', () => {
  const gates = circuitGates(), beacn = V(...PROJECT_LANDMARK_POSITIONS.beacn);
  assert.equal(gates.length, CIRCUIT.gates);
  gates.forEach((g, i) => {
    const next = gates[(i + 1) % gates.length], to = next.center.clone().sub(g.center);
    assert.ok(to.length() > 1500 && to.length() < 3000, `gate ${i} spacing ${to.length().toFixed(0)}`);
    assert.ok(to.normalize().dot(g.normal) > 0.8, `gate ${i} faces the next`);
    assert.ok(g.center.distanceTo(beacn) > 4000, `gate ${i} clears the monument`);
  });
  const medals = medalTimes(gates);
  assert.ok(medals.gold < medals.silver && medals.silver < medals.bronze);
});

test('slingshot lanes leave every world above its sky, aimed at the next world', () => {
  const lanes = laneGates();
  assert.equal(lanes.length, PLANETS.length * LANE.gates);
  for (const gate of lanes) {
    const from = PLANETS.find(p => p.id === gate.lane), to = PLANETS.find(p => p.id === gate.to);
    assert.ok(gate.center.distanceTo(V(...from.position)) > from.radius * 1.3, `${gate.id} clears the atmosphere`);
    assert.ok(V(...to.position).sub(V(...from.position)).normalize().dot(gate.normal) > 0.999);
  }
});

test('rifts sit in open space, clear of worlds, monuments, the circuit and the lanes', () => {
  const gates = [...circuitGates(), ...laneGates()];
  const monuments = Object.values(PROJECT_LANDMARK_POSITIONS).map(p => V(...p));
  for (const rift of RIFTS) {
    const c = V(...rift.position);
    for (const p of PLANETS) assert.ok(c.distanceTo(V(...p.position)) - p.radius * 1.14 > LEASH_RADIUS, `${rift.id} vs ${p.id}`);
    for (const m of monuments) assert.ok(c.distanceTo(m) > LEASH_RADIUS + 3000, `${rift.id} vs a monument`);
    for (const g of gates) assert.ok(c.distanceTo(g.center) > FIELD_RADIUS + 2000, `${rift.id} vs ${g.id}`);
  }
});

test('a lap: start at the first gate, thread them in order, finish for a medal', () => {
  const events = [];
  const slip = new Slipstream(new THREE.Scene(), { events: {
    onRaceStart: () => events.push('start'), onLap: lap => events.push(lap), onGate: g => events.push(g.id),
  } });
  const fly = (gate, dt = 0.5) => { const [a, b] = through(gate); slip.update(dt, 0, a, b); };
  fly(slip.circuit[3]);
  assert.equal(slip.racing, false, 'only the first gate starts a race');
  fly(slip.circuit[0]);
  assert.equal(slip.racing, true);
  fly(slip.circuit[5]);
  assert.equal(slip.race.next, 1, 'gates out of order do not count');
  const [a, b] = through(slip.circuit[1]); slip.update(0.5, 0, b, a);
  assert.equal(slip.race.next, 1, 'nor do gates flown backwards');
  for (let i = 1; i < slip.circuit.length; i++) fly(slip.circuit[i], 1);
  assert.equal(slip.nextGate, slip.circuit[0], 'then the finish line');
  fly(slip.circuit[0], 0.1);
  const lap = events.find(e => typeof e === 'object');
  assert.ok(lap && Math.abs(lap.time - (0.5 + 0.5 + 15 * 1 + 0.1)) < 1e-6, `lap ${lap?.time}`); // the clock starts at the line
  assert.equal(lap.medal, slip.medalFor(lap.time));
  assert.equal(slip.racing, true, 'the next lap starts at the line');
  assert.equal(slip.race.lap, 2);
  slip.update(0.1, 0, V(...CIRCUIT.center).add(V(0, 20000, 0)), V(...CIRCUIT.center).add(V(0, 20001, 0)));
  assert.equal(slip.racing, false, 'flying far away abandons the race');
});

test('threading a lane in order fires a slingshot; a skipped gate breaks the chain', () => {
  let slings = 0, surges = 0;
  const slip = new Slipstream(new THREE.Scene(), { events: { onSlingshot: () => slings++, onGate: () => surges++ } });
  const lane = slip.lanes.filter(g => g.lane === 'philosophy');
  for (const gate of lane) { const [a, b] = through(gate); slip.update(0.5, 0, a, b); }
  assert.equal(slings, 1); assert.equal(surges, LANE.gates);
  for (const gate of [lane[0], lane[1], lane[3], lane[4]]) { const [a, b] = through(gate); slip.update(0.5, 0, a, b); }
  assert.equal(slings, 1, 'skipping gate 3 breaks it');
  const [a, b] = through(lane[0], 30, 30), jump = b.clone().addScaledVector(lane[0].normal, 50000);
  slip.update(0.5, 0, a.clone().addScaledVector(lane[0].normal, -50000), jump);
  assert.equal(surges, LANE.gates + 2, 'a teleport through a gate is not a pass');
});
