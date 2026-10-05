import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SpaceFleet, STATIC, leadPoint, turnToward } from '../game/space/fleet.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const FX = { ring() {}, sparks() {}, flash() {} };

function setup() {
  const events = { hits: [], kills: [], ship: [], phases: [] };
  const fleet = new SpaceFleet(new THREE.Scene(), { fx: FX, random: () => 0.5, events: {
    onHit: (e, amount) => events.hits.push(amount), onKill: (e, cause) => events.kills.push([e.type, cause]), onBossPhase: (e, phase) => events.phases.push(phase),
  } });
  const ship = { position: V(0, 0, 0), velocity: V(0, 0, 0), radius: 7, evading: false, ram: false };
  const ctx = { ship, hitShip: (amount, at, kind) => events.ship.push([Math.round(amount), kind]) };
  const run = (seconds, dt = 1 / 60) => { for (let t = 0; t < seconds; t += dt) fleet.update(dt, t, ctx); };
  return { fleet, ship, ctx, events, run };
}

test('lead points intercept a moving target at the shot speed', () => {
  const origin = V(0, 0, 0), target = V(1000, 0, 0), velocity = V(0, 0, 300), speed = 1500;
  const aim = leadPoint(origin, target, velocity, speed);
  const t = aim.clone().sub(target).length() / velocity.length();
  assert.ok(Math.abs(aim.length() - speed * t) < 1e-6, 'the shot and the target arrive together');
  assert.deepEqual(leadPoint(origin, target, V(), speed).toArray(), target.toArray(), 'a still target needs no lead');
  const away = leadPoint(origin, target, V(2000, 0, 0), speed); // faster than the shot: aim at it anyway
  assert.ok(Number.isFinite(away.x));
});

test('turning is capped per step and never stalls on a reversal', () => {
  const dir = V(0, 0, -1);
  turnToward(dir, V(1, 0, 0), 0.1);
  assert.ok(Math.abs(Math.acos(dir.dot(V(0, 0, -1))) - 0.1) < 1e-9);
  const back = V(0, 0, -1); turnToward(back, V(0, 0, 1), 0.2);
  assert.ok(Math.abs(back.length() - 1) < 1e-9 && back.dot(V(0, 0, -1)) < 0.99, 'a 180° turn still starts turning');
  const near = V(0, 0, -1); turnToward(near, V(0.01, 0, -1).normalize(), 0.5);
  assert.ok(near.distanceTo(V(0.01, 0, -1).normalize()) < 1e-9, 'small turns land exactly');
});

test('the Aster\'s bolts hit, damage and kill the Static', () => {
  const { fleet, events, run } = setup();
  const glitch = fleet.spawn('glitch', V(0, 0, -400), { toward: V() });
  glitch.def = { ...glitch.def, speed: 0, fire: 99 }; // hold still for the test
  for (let i = 0; i < 12; i++) fleet.firePlayer(V(0, 0, -20 - i * 30), V(0, 0, -1), 30);
  run(1);
  assert.ok(events.hits.length >= 4);
  assert.deepEqual(events.kills, [['glitch', 'bolt']]);
  assert.equal(fleet.count(), 0);
});

test('hostile bolts hit the Aster unless it is rolling', () => {
  const { fleet, ship, events, run } = setup();
  fleet.enemyBolts.add(V(0, 0, -200), V(0, 0, 900), 2, 6);
  run(0.5);
  assert.deepEqual(events.ship, [[6, 'bolt']]);
  ship.evading = true;
  fleet.enemyBolts.add(V(0, 0, -200), V(0, 0, 900), 2, 6);
  run(0.5);
  assert.equal(events.ship.length, 1, 'the roll dodged it');
});

test('a spike rams the Aster and earns nothing; jammers circle at range and spray', () => {
  const { fleet, events, run } = setup();
  fleet.spawn('spike', V(0, 0, -600), { toward: V() });
  run(3);
  assert.deepEqual(events.ship.map(([, kind]) => kind), ['ram']);
  assert.deepEqual(events.kills, [['spike', 'detonate']]);
  const jammer = fleet.spawn('jammer', V(0, 0, -1200), { toward: V() });
  run(12);
  const d = jammer.position.length();
  assert.ok(d > 450 && d < 1200, `holds an orbit (${d.toFixed(0)} m)`);
  assert.ok(events.ship.length > 1, 'and its fire lands');
});

test('the Dissonance: shielded core, four amps, then a core that can fall', () => {
  const { fleet, events, run } = setup();
  const boss = fleet.spawn('boss', V(0, 0, -1500), { tier: 1 });
  run(0.1);
  const core = boss.parts[0];
  assert.equal(fleet.damage(boss, 500, core.world.clone(), { part: core }), 0, 'the core is shielded');
  assert.equal([...fleet.targets()].length, 4, 'only the amps are targets');
  for (const node of boss.parts.slice(1)) fleet.damage(boss, 1e6, node.world.clone(), { part: node });
  assert.deepEqual(events.phases, [2]);
  assert.equal([...fleet.targets()].length, 1, 'now the core');
  fleet.damage(boss, 1e6, core.world.clone(), { part: core });
  assert.equal(events.kills.length, 0, 'it breaks apart first');
  run(2.5);
  assert.deepEqual(events.kills, [['boss', 'bolt']]);
  assert.equal(fleet.boss, null);
});

test('blasts, missiles and despawning by tag', () => {
  const { fleet, events, run } = setup();
  for (let i = 0; i < 3; i++) fleet.spawn('glitch', V(i * 40, 0, -300), { tag: 'patrol' });
  fleet.spawn('jammer', V(0, 0, -2000), { tag: 'rift' });
  assert.equal(fleet.blast(V(40, 0, -300), 120, 1000), 3);
  assert.equal(events.kills.length, 3);
  const target = [...fleet.targets()][0];
  fleet.fireMissile(V(0, 0, -10), V(0, 0, -200), target, STATIC.jammer.hp * 2);
  run(4);
  assert.equal(fleet.count('rift'), 0, 'the missile homed in');
  fleet.spawn('glitch', V(0, 0, -900), { tag: 'patrol' });
  fleet.despawn('patrol');
  assert.equal(fleet.count(), 0);
  assert.equal(events.kills.length, 4, 'despawning is not a kill');
});
