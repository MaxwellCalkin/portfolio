import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Combat, makeSanctuary } from '../game/gameplay/combat.js';
import { LAYOUTS } from '../game/world/layout.js';

// A smooth test world: the philosophy layout's sanctuary on a 1 km sphere.
const R = 1000;
const planet = { center: new THREE.Vector3(), spec: { id: 'philosophy', radius: R, frame: { up: [0, 1, 0] } }, shape: { surfaceRadius: () => R, heightAt: () => 0, seaLevel: null } };
const sanctuary = makeSanctuary(planet);
const SAFE = LAYOUTS.philosophy.plateau.radius;
const at = (arc, height = 0) => new THREE.Vector3(Math.sin(arc / R), Math.cos(arc / R), 0).multiplyScalar(R + height); // `arc` m from the site
const arcOf = p => Math.acos(p.clone().normalize().y) * R;

function setup(playerArc) {
  const hits = [];
  const combat = new Combat(new THREE.Scene(), { fx: { ring() {}, sparks() {}, flash() {} }, sound: null, events: {} });
  combat.spawnTimer = Infinity; // only the sentinels placed by the test
  const player = { position: at(playerArc), up: at(playerArc).normalize(), velocity: new THREE.Vector3() };
  const ctx = { player, planet, onFoot: true, sanctuary, playerHit: amount => hits.push(amount), invulnerable: false, colliders: null };
  const sentinel = arc => {
    const position = at(arc), mesh = new THREE.Object3D();
    const e = { mesh, boss: false, planet, up: position.clone().normalize(), position, center: position.clone(), heading: new THREE.Vector3(0, 0, 1), hp: 110, maxHp: 110, radius: 1.2, flying: false, groundOffset: 1.2, shootTimer: 0.2, telegraph: 0, phase: 0, stagger: 0, charge: 0, home: position.clone(), aggro: true, volley: 0 };
    combat.enemies.push(e); combat.group.add(mesh);
    return e;
  };
  const run = (seconds, each = () => {}) => { for (let t = 0; t < seconds; t += 0.05) { combat.update(0.05, t, ctx); each(); } };
  return { combat, hits, sentinel, run };
}

test('a sentinel never follows, touches or shoots the agent inside the sanctuary', () => {
  const { combat, hits, sentinel, run } = setup(SAFE - 20);
  const e = sentinel(SAFE + 30); // 50 m away: in aggro and firing range
  run(10, () => {
    assert.ok(!sanctuary(e.position), 'stays outside');
    assert.ok(combat.projectiles.every(p => !p.hostile), 'holds its fire');
  });
  assert.equal(e.aggro, false);
  assert.deepEqual(hits, []);
});

test('a chasing sentinel stops at the sanctuary edge instead of cutting through it', () => {
  const { combat, sentinel, run } = setup(-(SAFE + 5));
  const e = sentinel(SAFE + 5); // the agent is outside, on the far side of the site
  run(10, () => assert.ok(!sanctuary(e.position)));
  assert.ok(combat.enemies.includes(e));
  assert.ok(arcOf(e.position) < SAFE + 2, 'it did advance to the edge');
});

test('hostile bolts fizzle at the sanctuary edge', () => {
  const { combat, hits, run } = setup(SAFE - 10);
  const origin = at(SAFE + 20, 1.2), target = at(SAFE - 10, 1); // aimed at the chest, clear of the ground
  combat.fireEnemy(origin, target.clone().sub(origin));
  run(3);
  assert.equal(combat.projectiles.length, 0);
  assert.deepEqual(hits, []);
});
