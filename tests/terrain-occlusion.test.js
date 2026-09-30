import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, Vector3 } from 'three';
import { earliestTerrainHit } from '../game/terrain-occlusion.js';
import { createSphericalTerrain } from '../game/spherical-terrain.js';
import { createSpacePlayground } from '../game/space-playground.js';

const v = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);
const sphere = (center = v(), radius = 10) => ({ center, radius, altitudeAt: p => p.distanceTo(center) - radius });
const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);

test('terrain sweep catches a through-globe chord with both endpoints outside', () => {
  const surface = sphere(), start = v(-100, 0, 0), end = v(100, 0, 0);
  const hit = earliestTerrainHit(start, end, [surface]);
  assert.equal(hit.surface, surface); close(hit.t, .45); close(hit.point.x, -10);
  assert.deepEqual(start.toArray(), [-100, 0, 0]); assert.deepEqual(end.toArray(), [100, 0, 0]);
});

test('terrain sweep returns earliest world independent of surface ordering or Map storage', () => {
  const far = sphere(v(60, 0, 0), 5), near = sphere(v(-30, 0, 0), 10);
  const hit = earliestTerrainHit(v(-100), v(100), new Map([['far', far], ['near', near]]));
  assert.equal(hit.surface, near); close(hit.t, .3);
  assert.equal(earliestTerrainHit(v(100), v(-100), [near, far]).surface, far);
});

test('zero-length, embedded, clearance, glancing, and bounded-miss segments are well defined', () => {
  const surface = sphere();
  assert.equal(earliestTerrainHit(v(), v(), [surface]).t, 0);
  assert.equal(earliestTerrainHit(v(20), v(20), [surface]), null);
  assert.equal(earliestTerrainHit(v(20), v(30), [surface]), null);
  assert.equal(earliestTerrainHit(v(-20, 10.01), v(20, 10.01), [surface]), null);
  const tangent = earliestTerrainHit(v(-20, 10), v(20, 10), [surface]);
  assert.ok(tangent && Math.abs(tangent.t - .5) < .0001);
  close(earliestTerrainHit(v(20), v(), [surface], 2).point.x, 12);
});

test('radius bounds reject far-away segments without calling terrain samplers', () => {
  let samples = 0;
  const surface = { center: v(1000, 200, 300), radius: 50, altitudeAt() { samples++; throw new Error('Should not sample'); } };
  assert.equal(earliestTerrainHit(v(), v(20, 30, 40), [surface]), null);
  assert.equal(samples, 0);
});

test('swept shots hit the real displaced triangles on arbitrary hemispheres and poles', () => {
  const terrain = createSphericalTerrain({ id: 'occlusion', position: [300, -240, 80], radius: 115, terrainSegments: { width: 48, height: 32 } }, 3);
  try {
    for (const direction of [v(1, .8, -2), v(-1, -2, .2), v(0, 1, 0), v(0, -1, 0)]) {
      direction.normalize();
      const a = terrain.center.clone().addScaledVector(direction, 300), b = terrain.center.clone().addScaledVector(direction, -300);
      const hit = earliestTerrainHit(a, b, [terrain]);
      assert.ok(hit); close(terrain.altitudeAt(hit.point), 0, 2e-6);
      assert.ok(hit.point.distanceTo(terrain.groundAt(a)) < 2e-6);
    }
  } finally { terrain.geometry.dispose(); }
});

test('terrain blocks external and pooled player bolts before any ship behind the surface', () => {
  const playground = createSpacePlayground(new Scene());
  for (const enemy of playground.enemies) { enemy.alive = false; enemy.respawnTimer = 999; }
  const enemy = playground.enemies[0]; enemy.alive = true; enemy.mesh.position.set(0, 0, -45); enemy.speed = 0;
  playground.setSurfaces([sphere(v(0, 0, -20), 8)]);
  const hp = enemy.hp;
  assert.equal(playground.tryHitSegment(v(), v(0, 0, -100), 1000), false); assert.equal(enemy.hp, hp);
  assert.equal(playground.tryHitSegment(v(0, 0, -30), v(0, 0, -100), 10), true); assert.equal(enemy.hp, hp - 10);
  playground.shoot(v(), v(0, 0, -1), 1000);
  playground.update(.1, .1, v(), v(0, 0, -1), 0);
  assert.equal(enemy.hp, hp - 10);
  playground.dispose();
});

test('real terrain shields the player from hostile bolts at the earlier contact', () => {
  const make = withTerrain => {
    let damage = 0; const playground = createSpacePlayground(new Scene(), { onPlayerDamage: amount => damage += amount });
    for (const enemy of playground.enemies) { enemy.alive = false; enemy.respawnTimer = 999; }
    const enemy = playground.enemies[0]; enemy.alive = true; enemy.mesh.position.set(0, 0, -200);
    enemy.mesh.quaternion.setFromUnitVectors(v(0, 0, -1), v(0, 0, 1)); enemy.direction.set(0, 0, 1); enemy.shootTimer = 0;
    if (withTerrain) playground.setSurfaces([sphere(v(0, 0, -8), 5)]);
    for (let i = 0; i < 30; i++) playground.update(1 / 60, i / 60, v(), v(0, 0, -1), 0);
    playground.dispose(); return damage;
  };
  assert.ok(make(false) > 0, 'control trajectory must hit the player');
  assert.equal(make(true), 0, 'the earlier surface blocks a later player contact');
});
