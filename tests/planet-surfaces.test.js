import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPlanetSurfaces, createSphericalCollisionWorld } from '../game/planet-surfaces.js';
import { createSphericalTerrain } from '../game/spherical-terrain.js';

const p = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const near = (value, expected, tolerance = .015) => assert.ok(Math.abs(value - expected) < tolerance, `${value} ≈ ${expected}`);
const flat = { groundAt: position => p(position.x, 0, position.z), normalAt: () => p(0, 1), frameAt: () => ({ right: p(1), forward: p(0, 0, -1) }) };
function planet(id = 'philosophy', position = [450, 70, -610]) {
  const parent = new THREE.Group(), group = new THREE.Group(), material = new THREE.MeshBasicMaterial({ color: '#81d9c0' });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(150, 12, 8), material); mesh.rotation.y = .8; group.position.fromArray(position); group.add(mesh); parent.add(group);
  return { id, radius: 150, position, color: '#81d9c0', mesh, group, terrainSegments: { width: 48, height: 32 } };
}

test('continuous 3D capsule sweep prevents dash tunneling through a thin radial stem', () => {
  const world = createSphericalCollisionWorld(flat);
  world.addCollider({ a: p(0, .1), b: p(0, 5), radius: .12, kind: 'stem' });
  const result = world.resolveMovement(p(-7), p(14));
  near(result.x, -.72); near(result.y, 0); near(result.z, 0);
  const reverse = world.resolveMovement(p(7), p(-14)); near(reverse.x, .72);
});

test('a swept world-space wall keeps tangential movement rather than trapping the player', () => {
  const world = createSphericalCollisionWorld(flat);
  world.addCollider({ a: p(0, 1.2, -20), b: p(0, 1.2, 20), radius: .2 });
  const result = world.resolveMovement(p(-3, 0, -4), p(6, 0, 8));
  near(result.x, -.8); near(result.z, 4);
  const tangent = world.resolveMovement(result, p(0, 0, -10)); near(tangent.x, -.8); near(tangent.z, -6);
});

test('dynamic spherical props can be removed, and aerial props never create invisible ground walls', () => {
  const world = createSphericalCollisionWorld(flat);
  const id = world.addCollider({ position: p(0, 1), radius: 1, kind: 'destructible' });
  assert.ok(world.resolveMovement(p(-5), p(10)).x < -1.5);
  world.removeCollider(id); near(world.resolveMovement(p(-5), p(10)).x, 5);
  world.addCollider({ position: p(0, 9), radius: 2 }); near(world.resolveMovement(p(-5), p(10)).x, 5);
});

test('terrain and decorations are persistent world-coordinate siblings and preserve the planet material', () => {
  const entry = planet(), originalMaterial = entry.mesh.material, map = createPlanetSurfaces([entry]), surface = map.get(entry.id);
  assert.equal(entry.mesh.geometry, surface.geometry); assert.equal(entry.mesh.material, originalMaterial);
  assert.equal(entry.mesh.rotation.y, 0); assert.equal(surface.group.parent, entry.group.parent);
  assert.equal(surface.group.position.length(), 0); assert.equal(surface.group.quaternion.angleTo(new THREE.Quaternion()), 0);
  for (const marker of [surface.spawn, surface.shipPosition, surface.beaconPosition]) assert.ok(marker.distanceTo(surface.center) > 145);
  near(surface.altitudeAt(surface.spawn), 0, 1e-6); near(surface.altitudeAt(surface.shipPosition), 1.9, 1e-6);
  const archive = surface.group.getObjectByName('radial-archive'); assert.ok(archive.position.distanceTo(surface.beaconPosition) < 1e-6);
  const before = archive.position.clone(); surface.update(15, .1); assert.ok(before.equals(archive.position)); assert.equal(surface.group.visible, true);
  assert.ok(!surface.group.children.some(child => /sky|moon|planet|terrain/.test(child.name)));
});

test('individual and instanced object poses follow each actual planetary radial up', () => {
  const entry = planet(), surface = createPlanetSurfaces([entry]).get(entry.id), up = p(0, 1), matrix = new THREE.Matrix4();
  surface.group.updateMatrixWorld(true);
  surface.group.traverse(object => {
    if (object.userData.radialAnchor) {
      const actual = up.clone().applyQuaternion(object.getWorldQuaternion(new THREE.Quaternion()));
      assert.ok(actual.dot(surface.normalAt(object.getWorldPosition(new THREE.Vector3()))) > .999999, object.name);
    }
    // Shared archive pools contain offset posts and animated halo/core parts.
    // Their assembly anchor is checked above; loose scenery is radial per item.
    if (object.isInstancedMesh && !object.userData.radialAssembly) for (let i = 0; i < object.count; i++) {
      object.getMatrixAt(i, matrix); const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3(); matrix.decompose(position, quaternion, scale);
      assert.ok(up.clone().applyQuaternion(quaternion).dot(surface.normalAt(position)) > .99999, `${object.name}[${i}]`);
    }
  });
});

test('circumnavigation crosses chart edges and the far hemisphere without any world reset', () => {
  const terrain = createSphericalTerrain({ id: 'walker', radius: 140, position: [940, -130, 270], terrainSegments: { width: 48, height: 32 } });
  const world = createSphericalCollisionWorld(terrain), start = terrain.patchPoint(0, 0), forward = terrain.frameAt(start).forward;
  const walked = world.resolveMovement(start, forward.clone().multiplyScalar(450));
  near(terrain.altitudeAt(walked), 0, 1e-6);
  assert.ok(walked.distanceTo(start) > 260); assert.ok(terrain.normalAt(walked).dot(terrain.normalAt(start)) < -.97);
  assert.ok(walked.distanceTo(terrain.center) > 130); assert.ok(walked.length() > 500);
});

test('parked ship hull and thin wings use their actual transformed triangles and can be removed', () => {
  const entry = planet(), surface = createPlanetSurfaces([entry]).get(entry.id);
  // Isolate ship collision from unrelated settlement props for a deterministic approach.
  surface.colliders.clear();
  const ship = new THREE.Group(); ship.position.copy(surface.shipPosition); ship.quaternion.copy(surface.frameAt(ship.position).quaternion);
  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.2, 12)); const wings = new THREE.Mesh(new THREE.BoxGeometry(13, .2, 1.2)); wings.position.z = 2; ship.add(hull, wings); entry.group.parent.add(ship);
  surface.setParkedShip(ship); assert.ok([...surface.colliders.values()].every(c => c.kind === 'parked-ship' && c.type === 'triangle'));
  const start = surface.patchPoint(-12, 25), delta = surface.patchPoint(12, 25).sub(start);
  const hullHit = surface.resolveMovement(start, delta); const coordinates = surface.patchCoordinates(hullHit);
  assert.ok(coordinates.x < -1.3 && coordinates.x > -2.2, `hull x=${coordinates.x}`);
  const wingStart = surface.patchPoint(5, 13), wingDelta = surface.patchPoint(5, 38).sub(wingStart);
  const wingHit = surface.resolveMovement(wingStart, wingDelta), wingCoordinates = surface.patchCoordinates(wingHit);
  assert.ok(wingCoordinates.z < 26.1, `wing z=${wingCoordinates.z}`);
  surface.setParkedShip(null); assert.equal(surface.colliders.size, 0);
  const free = surface.resolveMovement(start, delta); assert.ok(surface.patchCoordinates(free).x > 10);
});

test('the conformal landing ring follows the real terrain rather than floating on a flat plane', () => {
  const entry = planet(), surface = createPlanetSurfaces([entry]).get(entry.id), ring = surface.group.getObjectByName('conformal-landing-survey-ring');
  const positions = ring.geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) near(surface.altitudeAt(new THREE.Vector3().fromBufferAttribute(positions, i)), .065, .0001);
});

test('every persistent planet has an unobstructed arrival route and a physically reachable archive', () => {
  const entries = [
    ['philosophy', [-735, 87.5, -1015], 150], ['experience', [770, 210, -1750], 190],
    ['projects', [1575, -175, -280], 145], ['mission', [-1575, -105, 315], 210], ['contact', [140, 350, 1225], 115],
  ].map(([id, position, radius]) => ({ id, position, radius, color: '#a6e6c3', terrainSegments: { width: 32, height: 24 } }));
  const surfaces = createPlanetSurfaces(entries);
  for (const surface of surfaces.values()) {
    const kinds = new Set([...surface.colliders.values()].map(c => c.kind));
    for (const kind of ['boulder', 'crystal', 'flora-stem', 'ruin-post', 'archive-pillar', 'archive-base']) assert.ok(kinds.has(kind), `${surface.spec.id}: ${kind}`);
    assert.ok(surface.resolveMovement(surface.spawn, new THREE.Vector3()).distanceTo(surface.spawn) < 1e-7);
    const reached = surface.resolveMovement(surface.patchPoint(0, 0), surface.siteForward.clone().multiplyScalar(18));
    assert.ok(reached.distanceTo(surface.beaconPosition) > 4.3 && reached.distanceTo(surface.beaconPosition) < 5.3);
  }
});
