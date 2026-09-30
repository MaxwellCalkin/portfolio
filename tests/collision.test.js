import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCollisionWorld, createTerrainSampler, createMeshFootprint } from '../game/collision.js';
import { createSurfaceWorld, createShip, PLANETS } from '../game/world.js';

const p = (x = 0, z = 0, y = 0) => new THREE.Vector3(x, y, z);
const near = (actual, expected, epsilon = .002) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} should be within ${epsilon} of ${expected}`);
const flatWorld = () => createCollisionWorld({ bounds: null });

test('a full 14-unit dash cannot tunnel through a thin tree trunk', () => {
  const world = flatWorld();
  world.addCollider({ type: 'circle', x: 0, z: 0, radius: .12 });
  const result = world.resolveMovement(p(-7), p(14));
  near(result.x, -.72); near(result.z, 0); near(result.y, 0);
});

test('rounded capsule sweeps stop at the actual wall and preserve wall sliding', () => {
  const world = flatWorld();
  world.addCollider({ type: 'box', x: 0, z: 0, halfX: .1, halfZ: 10 });
  const result = world.resolveMovement(p(-3, -4), p(6, 8));
  near(result.x, -.7); near(result.z, 4);
  for (let i = 0; i < 60; i++) result.copy(world.resolveMovement(result, p(.1, -.1)));
  near(result.x, -.7); near(result.z, -2);
});

test('tangent travel is not sticky on circular obstacles or straight edges', () => {
  const world = flatWorld();
  world.addCollider({ type: 'circle', x: 0, z: 0, radius: 1 });
  const tangent = world.resolveMovement(p(-5, 1.6), p(10));
  near(tangent.x, 5); near(tangent.z, 1.6);
  const wall = flatWorld();
  wall.addCollider({ type: 'box', x: 0, z: 0, halfX: .4, halfZ: 8 });
  const along = wall.resolveMovement(p(-1, -5), p(0, 10));
  near(along.x, -1); near(along.z, 5);
});

test('rounded box corners do not create invisible square extensions', () => {
  const world = flatWorld();
  world.addCollider({ type: 'box', x: 0, z: 0, halfX: 1, halfZ: 1 });
  const result = world.resolveMovement(p(1.5, 1.5), p(.1, .1));
  near(result.x, 1.6); near(result.z, 1.6);
});

test('capsules and rotated architecture block from both sides', () => {
  const capsule = flatWorld();
  capsule.addCollider({ type: 'capsule', ax: 0, az: -3, bx: 0, bz: 3, radius: .2 });
  near(capsule.resolveMovement(p(-7), p(14)).x, -.8);
  near(capsule.resolveMovement(p(7), p(-14)).x, .8);
  const box = flatWorld();
  box.addCollider({ type: 'box', x: 0, z: 0, halfX: .2, halfZ: 5, rotation: Math.PI / 2 });
  near(box.resolveMovement(p(0, -7), p(0, 14)).z, -.8);
});

test('obstacle corners cannot be tunneled or oscillated through with repeated input', () => {
  const world = flatWorld();
  world.addCollider({ type: 'box', x: 0, z: 0, halfX: .1, halfZ: 12 });
  world.addCollider({ type: 'box', x: -6, z: 0, halfX: 6, halfZ: .1 });
  let result = p(-5, -5);
  for (let i = 0; i < 100; i++) result = world.resolveMovement(result, p(1, 1));
  near(result.x, -.7); near(result.z, -.7);
});

test('stationary embedded spawns depenetrate and return to ground height', () => {
  const world = createCollisionWorld({ heightAt: () => 3, bounds: null });
  world.addCollider({ type: 'circle', x: 0, z: 0, radius: 2 });
  const result = world.resolveMovement(p(0, 0, 99), p());
  assert.ok(Math.hypot(result.x, result.z) >= 2.6); near(result.y, 3);
});

test('play area edges constrain the capsule radius and allow sliding', () => {
  const world = createCollisionWorld();
  const result = world.resolveMovement(p(150, 0), p(14, 14));
  near(result.x, 154.4); near(result.z, 14);
  const corner = world.resolveMovement(p(150, 150), p(50, 50));
  near(corner.x, 154.4); near(corner.z, 154.4);
});

test('removing a destroyed prop opens the path and backgrounds outside play area are excluded', () => {
  const world = createCollisionWorld();
  const id = world.addCollider({ type: 'circle', x: 0, z: 0, radius: 1 });
  assert.ok(world.resolveMovement(p(-7), p(14)).x < 0);
  world.removeCollider(id);
  near(world.resolveMovement(p(-7), p(14)).x, 7);
  assert.equal(world.addCollider({ type: 'circle', x: 250, z: 0, radius: 10 }), null);
});

test('feet match actual rendered terrain triangles rather than bilinear or analytic approximations', () => {
  const geometry = new THREE.PlaneGeometry(8, 8, 2, 2); geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) position.setY(i, [0, 3, 1, 2, 8, 2, 4, -1, 5][i]);
  geometry.computeVertexNormals();
  const sampler = createTerrainSampler(geometry), mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld();
  const ray = new THREE.Raycaster();
  for (let i = 0; i < 75; i++) {
    const x = Math.sin(i * 3.1) * 3.999, z = Math.cos(i * 1.3) * 3.999;
    ray.set(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(mesh)[0];
    assert.ok(hit); near(sampler.heightAt(x, z), hit.point.y, 1e-6);
  }
  mesh.material.dispose(); geometry.dispose();
});

test('walkable inclines keep grounded feet while slopes above 45 degrees block climbing', () => {
  const gentle = createCollisionWorld({ heightAt: x => x * .7, bounds: null });
  const climb = gentle.resolveMovement(p(-2), p(4));
  near(climb.x, 2); near(climb.y, 1.4);
  const heightAt = x => Math.max(0, x) * 1.8;
  const steep = createCollisionWorld({ heightAt, sampleTerrain: (x) => ({ height: heightAt(x), slopeX: x > 0 ? 1.8 : 0, slopeZ: 0 }), bounds: null });
  const blocked = steep.resolveMovement(p(-3, -3), p(6, 6));
  assert.ok(blocked.x < .01); near(blocked.z, 3); near(blocked.y, heightAt(blocked.x));
});

test('large up or down steps cannot be teleported across by a dash', () => {
  for (const direction of [-1, 1]) {
    const heightAt = x => x >= 0 ? direction * 4 : 0;
    const world = createCollisionWorld({ heightAt, sampleTerrain: x => ({ height: heightAt(x), slopeX: 0, slopeZ: 0 }), bounds: null });
    const result = world.resolveMovement(p(-7), p(14));
    assert.ok(result.x < 0); near(result.y, 0);
  }
});

test('footprint clipping ignores overhead geometry and follows transformed visible solids', () => {
  const box = new THREE.BoxGeometry(2, 10, 2), matrix = new THREE.Matrix4().makeTranslation(10, 5, 20);
  const footprint = createMeshFootprint(box, matrix, .04, 2.5);
  assert.ok(footprint); assert.equal(footprint.points.length, 4);
  assert.deepEqual(footprint.points, [{ x: 9, z: 19 }, { x: 11, z: 19 }, { x: 11, z: 21 }, { x: 9, z: 21 }]);
  assert.equal(createMeshFootprint(box, new THREE.Matrix4().makeTranslation(0, 30, 0), .04, 2.5), null);
  box.dispose();
});

test('all five procedural surfaces register real obstacles, a solid parked ship, and reachable archive', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {} }) }) };
  try {
    for (const planet of PLANETS) {
      const scene = new THREE.Scene(), surface = createSurfaceWorld(scene, planet.id);
      const kinds = new Set([...surface.colliders.values()].map(collider => collider.kind));
      for (const kind of ['boulder', 'crystal', 'tree', 'arch-post', 'pillar', 'archive-base', 'parked-ship']) assert.ok(kinds.has(kind), `${planet.id}: missing ${kind}`);
      const spawn = new THREE.Vector3(...surface.spawn);
      const resting = surface.resolveMovement(spawn, p());
      near(resting.x, spawn.x); near(resting.z, spawn.z); near(resting.y, spawn.y);
      const archive = surface.resolveMovement(p(0, 0), p(0, -30));
      assert.ok(archive.z > -15.101 && archive.z < -15, `${planet.id}: archive collision at ${archive.z}`);
      assert.ok(archive.distanceTo(new THREE.Vector3(...surface.beaconPosition)) < 13);
      const ship = surface.resolveMovement(p(0, 15), p(0, 20));
      assert.ok(ship.z < 25, `${planet.id}: walked through parked ship`);
      const parkedShip=createShip();parkedShip.position.fromArray(surface.shipPosition);parkedShip.rotation.y=Math.PI*.2;
      surface.setParkedShip(parkedShip);
      const realShip=surface.resolveMovement(p(0, 15),p(0, 20));
      assert.ok(realShip.z < 25, `${planet.id}: walked through mesh-aligned parked ship`);
      surface.group.add(parkedShip);
      const terrain = surface.group.getObjectByName('terrain'); terrain.updateMatrixWorld();
      const ray = new THREE.Raycaster(new THREE.Vector3(13.3, 100, -17.6), new THREE.Vector3(0, -1, 0));
      near(surface.heightAt(13.3, -17.6), ray.intersectObject(terrain)[0].point.y, 1e-5);
      surface.dispose();
    }
  } finally { globalThis.document = previousDocument; }
});
