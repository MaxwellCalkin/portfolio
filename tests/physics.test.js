import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ColliderWorld, cylinderCollider, boxColliderFromMesh, resolveCapsule } from '../game/actors/physics.js';
import { segmentSphereHitTime } from '../game/engine/math.js';

const up = new THREE.Vector3(0, 1, 0);

test('the agent is pushed out of a pillar and can stand on its top', () => {
  const pillar = cylinderCollider(new THREE.Vector3(0, 0, 0), up, 1, 0.4, 'test');
  const feet = new THREE.Vector3(0.9, 0, 0);
  const support = resolveCapsule(feet, up, 0.42, 1.85, [pillar], false);
  // A 0.4 m step is low enough to step onto rather than be blocked by.
  assert.ok(support !== null && Math.abs(support - 0.4) < 1e-9);
  const wall = cylinderCollider(new THREE.Vector3(0, 0, 0), up, 1, 3, 'test');
  const inside = new THREE.Vector3(0.9, 0, 0);
  assert.equal(resolveCapsule(inside, up, 0.42, 1.85, [wall], false), null);
  assert.ok(inside.x >= 1 + 0.42 * 0.85 - 1e-9, `pushed to ${inside.x}`);
});

test('oriented boxes block from the side and support from above', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 2));
  mesh.position.set(0, 0.5, 0); mesh.rotation.y = 0.6;
  const box = boxColliderFromMesh(mesh, 'test');
  const onTop = new THREE.Vector3(0, 1.0, 0);
  assert.ok(Math.abs(resolveCapsule(onTop, up, 0.42, 1.85, [box], true)) < 1e-9);
  const side = new THREE.Vector3(Math.cos(0.6) * 2.1, 0, -Math.sin(0.6) * 2.1);
  resolveCapsule(side, up, 0.42, 1.85, [{ ...box, half: box.half.clone().setY(3) }], false);
  assert.ok(side.length() > 2.1, 'pushed away from the long face');
});

test('the spatial hash finds, removes and filters colliders', () => {
  const world = new ColliderWorld();
  const a = world.add(cylinderCollider(new THREE.Vector3(100, 0, 0), up, 1, 2, 'a'));
  world.add(cylinderCollider(new THREE.Vector3(-500, 0, 0), up, 1, 2, 'b'));
  assert.equal(world.query(new THREE.Vector3(101, 0, 0), 3).length, 1);
  world.remove(a);
  assert.equal(world.query(new THREE.Vector3(101, 0, 0), 3).length, 0);
  world.removeTagged('b');
  assert.equal(world.query(new THREE.Vector3(-500, 0, 0), 3).length, 0);
});

test('fast bolts never tunnel through a target', () => {
  const center = new THREE.Vector3(0, 0, 50);
  assert.ok(Math.abs(segmentSphereHitTime(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 100), center, 1) - 0.49) < 1e-9);
  assert.equal(segmentSphereHitTime(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 2, 100), center, 1), null);
  assert.equal(segmentSphereHitTime(center, center.clone().addScalar(5), center, 1), 0, 'starting inside counts as a hit');
  assert.equal(segmentSphereHitTime(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 10), center, 1), null, 'short of the target');
});
