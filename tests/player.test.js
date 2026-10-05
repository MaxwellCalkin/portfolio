import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { prepareSpecs } from '../game/world/layout.js';
import { createPlanetShape, siteLocalToDir } from '../game/world/planet-shape.js';
import { Player, PLAYER } from '../game/actors/player.js';

const spec = prepareSpecs().find(s => s.id === 'philosophy');
const planet = { spec, shape: createPlanetShape(spec), center: new THREE.Vector3(...spec.position) };
const noColliders = () => [];
const altitude = p => { const d = p.position.clone().sub(planet.center); const r = d.length(); d.divideScalar(r); return r - planet.shape.surfaceRadius(d.x, d.y, d.z); };
const input = (o = {}) => ({ move: { x: 0, y: 0 }, jump: false, jumpPressed: false, sprint: false, aim: false, dash: false, ...o });

function spawn() {
  const p = new Player();
  const dir = new THREE.Vector3(...siteLocalToDir(spec.frame, spec.radius, 0, 34));
  p.place(planet, planet.center.clone().addScaledVector(dir, spec.radius + 50), new THREE.Vector3(...spec.frame.forward));
  return p;
}

test('the agent rests on the spherical ground', () => {
  const p = spawn();
  for (let i = 0; i < 120; i++) p.update(1 / 60, planet, input(), p.heading, noColliders);
  assert.ok(p.grounded);
  assert.ok(Math.abs(altitude(p)) < 0.05, `altitude ${altitude(p)}`);
});

test('running follows the surface and keeps the body upright', () => {
  const p = spawn();
  const start = p.position.clone();
  for (let i = 0; i < 180; i++) p.update(1 / 60, planet, input({ move: { x: 0, y: 1 } }), p.heading, noColliders);
  const travelled = p.position.distanceTo(start);
  assert.ok(travelled > PLAYER.run * 2.4 && travelled < PLAYER.run * 3.1, `ran ${travelled.toFixed(2)} m in 3 s`);
  assert.ok(Math.abs(altitude(p)) < 0.4);
  const radial = p.position.clone().sub(planet.center).normalize();
  assert.ok(p.up.dot(radial) > 0.9999);
  assert.ok(Math.abs(p.heading.dot(p.up)) < 1e-6, 'heading stays tangent');
});

test('jumping leaves the ground, the jetpack lifts, and the agent lands again', () => {
  const p = spawn();
  for (let i = 0; i < 30; i++) p.update(1 / 60, planet, input(), p.heading, noColliders);
  p.update(1 / 60, planet, input({ jump: true, jumpPressed: true }), p.heading, noColliders);
  assert.equal(p.grounded, false);
  let peak = 0;
  for (let i = 0; i < 90; i++) { p.update(1 / 60, planet, input({ jump: true }), p.heading, noColliders); peak = Math.max(peak, altitude(p)); }
  assert.ok(peak > 3, `jetpack peak ${peak.toFixed(2)} m`);
  assert.ok(p.jet < 100, 'fuel was spent');
  let landed = false;
  for (let i = 0; i < 600 && !landed; i++) { p.update(1 / 60, planet, input(), p.heading, noColliders); landed = p.grounded; }
  assert.ok(landed);
});

test('the dash is fast, short and on cooldown', () => {
  const p = spawn();
  for (let i = 0; i < 10; i++) p.update(1 / 60, planet, input(), p.heading, noColliders);
  const start = p.position.clone();
  p.update(1 / 60, planet, input({ dash: true }), p.heading, noColliders);
  assert.equal(p.dashed, true);
  for (let i = 0; i < 14; i++) p.update(1 / 60, planet, input(), p.heading, noColliders);
  assert.ok(p.position.distanceTo(start) > 4, 'dash covers ground');
  p.dashed = false;
  p.update(1 / 60, planet, input({ dash: true }), p.heading, noColliders);
  assert.notEqual(p.dashed, true, 'cooldown blocks a second dash');
});
