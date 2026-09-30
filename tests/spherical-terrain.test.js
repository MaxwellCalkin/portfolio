import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSphericalTerrain } from '../game/spherical-terrain.js';

const near = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be within ${epsilon} of ${expected}`);
const vectorNear = (a, b, epsilon = 1e-6) => assert.ok(a.distanceTo(b) <= epsilon, `${a.toArray()} should be within ${epsilon} of ${b.toArray()}`);
const spec = { id: 'test', position: [770, 210, -1750], radius: 190 };
const terrain = createSphericalTerrain(spec, 1);
const unit = (x, y, z) => new THREE.Vector3(x, y, z).normalize();

function assertFrame(frame) {
  for (const v of [frame.up, frame.forward, frame.right]) { near(v.length(), 1, 1e-12); assert.ok(v.toArray().every(Number.isFinite)); }
  near(frame.up.dot(frame.forward), 0, 1e-12);
  near(frame.up.dot(frame.right), 0, 1e-12);
  near(frame.forward.dot(frame.right), 0, 1e-12);
  vectorNear(new THREE.Vector3(0, 1, 0).applyQuaternion(frame.quaternion), frame.up);
  vectorNear(new THREE.Vector3(0, 0, -1).applyQuaternion(frame.quaternion), frame.forward);
  vectorNear(new THREE.Vector3(1, 0, 0).applyQuaternion(frame.quaternion), frame.right);
}

test('terrain is a closed full-size planet with deterministic sculpting', () => {
  const copy = createSphericalTerrain(spec, 1), other = createSphericalTerrain(spec, 2);
  assert.deepEqual(terrain.geometry.attributes.position.array, copy.geometry.attributes.position.array);
  assert.notDeepEqual(terrain.geometry.attributes.position.array, other.geometry.attributes.position.array);
  assert.equal(terrain.geometry.attributes.position.count, 161 * 97);
  assert.equal(terrain.geometry.index.count / 3, 160 * 95 * 2);
  const positions = terrain.geometry.attributes.position, normal = terrain.geometry.attributes.normal;
  const radii = [];
  for (let i = 0; i < positions.count; i++) radii.push(new THREE.Vector3().fromBufferAttribute(positions, i).length());
  assert.ok(Math.min(...radii) > spec.radius * .94);
  assert.ok(Math.max(...radii) < spec.radius * 1.06);
  assert.ok(Math.max(...radii) - Math.min(...radii) > 3);
  for (let row = 0; row <= 96; row++) {
    const a = row * 161, b = a + 160;
    vectorNear(new THREE.Vector3().fromBufferAttribute(positions, a), new THREE.Vector3().fromBufferAttribute(positions, b), 0);
    vectorNear(new THREE.Vector3().fromBufferAttribute(normal, a), new THREE.Vector3().fromBufferAttribute(normal, b), 0);
  }
  for (const row of [0, 96]) for (let col = 1; col <= 160; col++) {
    vectorNear(new THREE.Vector3().fromBufferAttribute(positions, row * 161), new THREE.Vector3().fromBufferAttribute(positions, row * 161 + col), 0);
    vectorNear(new THREE.Vector3().fromBufferAttribute(normal, row * 161), new THREE.Vector3().fromBufferAttribute(normal, row * 161 + col), 0);
  }
  copy.geometry.dispose(); other.geometry.dispose();
});

test('ground sampling agrees with every rendered triangle, including seam and polar fans', () => {
  const indices = terrain.geometry.index.array, position = terrain.geometry.attributes.position;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < indices.length; i += 3) {
    a.fromBufferAttribute(position, indices[i]); b.fromBufferAttribute(position, indices[i + 1]); c.fromBufferAttribute(position, indices[i + 2]);
    p.copy(a).multiplyScalar(.173).addScaledVector(b, .391).addScaledVector(c, .436);
    near(terrain.radiusAt(p), p.length(), 2e-8);
    if (i % 123 === 0) {
      const world = p.clone().add(terrain.center);
      vectorNear(terrain.groundAt(world), world, 2e-8);
      const faceNormal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      vectorNear(terrain.surfaceNormalAt(world), faceNormal, 2e-8);
    }
  }
});

test('radial sampling matches raycast hits at arbitrary world locations to below a centimeter', () => {
  const mesh = new THREE.Mesh(terrain.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.position.copy(terrain.center); mesh.updateMatrixWorld();
  const raycaster = new THREE.Raycaster(), direction = new THREE.Vector3();
  for (let i = 0; i < 120; i++) {
    const y = -1 + (i + .5) / 60, phi = i * 2.399963229728653;
    direction.set(Math.cos(phi) * Math.sqrt(1 - y * y), y, Math.sin(phi) * Math.sqrt(1 - y * y));
    raycaster.set(terrain.center.clone().addScaledVector(direction, spec.radius * 3), direction.clone().negate());
    const hit = raycaster.intersectObject(mesh)[0];
    assert.ok(hit, 'the planet must be closed in every direction');
    vectorNear(terrain.groundAt(hit.point), hit.point, 1e-6);
    near(terrain.radiusAt(direction), hit.point.distanceTo(terrain.center), 1e-6);
  }
  mesh.material.dispose();
});

test('UV seam crossings are continuous and never create a collision boundary', () => {
  for (const y of [-.999999, -.82, -.2, 0, .51, .999999]) {
    const horizontal = Math.sqrt(1 - y * y);
    const left = new THREE.Vector3(-horizontal, y, -1e-9).normalize();
    const right = new THREE.Vector3(-horizontal, y, 1e-9).normalize();
    near(terrain.radiusAt(left), terrain.radiusAt(right), 1e-5);
    const leftGround = terrain.groundAt(terrain.center.clone().addScaledVector(left, 500));
    const rightGround = terrain.groundAt(terrain.center.clone().addScaledVector(right, 500));
    vectorNear(leftGround, rightGround, 1e-5);
  }
  for (let i = 0; i <= 2000; i++) {
    const angle = i / 2000 * Math.PI * 4;
    const p = terrain.center.clone().addScaledVector(unit(Math.sin(angle), .2 * Math.sin(angle * 3), Math.cos(angle)), spec.radius + 20);
    const grounded = terrain.groundAt(p, .04);
    near(terrain.altitudeAt(grounded), .04, 1e-8);
    assertFrame(terrain.frameAt(grounded));
  }
});

test('both poles, center fallback, and forward-parallel degeneracies remain finite', () => {
  for (const sign of [-1, 1]) {
    const pole = new THREE.Vector3(0, sign, 0);
    const world = terrain.center.clone().addScaledVector(pole, spec.radius);
    assert.ok(Number.isFinite(terrain.radiusAt(pole)));
    assertFrame(terrain.frameAt(world, pole));
    assertFrame(terrain.frameAt(world));
    for (let i = 0; i < 24; i++) {
      const angle = i / 24 * Math.PI * 2;
      for (const distance of [1e-10, 1e-7, 1e-4, .001, .01]) {
        const u = unit(Math.cos(angle) * distance, sign, Math.sin(angle) * distance);
        assert.ok(Number.isFinite(terrain.radiusAt(u)));
        assertFrame(terrain.frameAt(terrain.center.clone().addScaledVector(u, spec.radius), u));
      }
    }
  }
  assertFrame(terrain.frameAt(terrain.center));
  assert.ok(Number.isFinite(terrain.radiusAt(new THREE.Vector3())));
  assert.ok(Number.isFinite(terrain.altitudeAt(terrain.center)));
  vectorNear(terrain.normalAt(terrain.center), terrain.siteUp);
});

test('signed altitude, clearance, and frames use actual world coordinates and radial gravity', () => {
  for (const up of [unit(1, 2, 3), unit(-1, 0, 0), unit(0, -1, 0), terrain.siteUp]) {
    const radius = terrain.radiusAt(up);
    for (const altitude of [-12, -.5, 0, .03, 4.5, 200]) {
      const world = terrain.center.clone().addScaledVector(up, radius + altitude);
      near(terrain.altitudeAt(world), altitude, 1e-9);
      vectorNear(terrain.normalAt(world), up, 1e-12);
      const grounded = terrain.groundAt(world, 2.7);
      near(terrain.altitudeAt(grounded), 2.7, 1e-9);
      assertFrame(terrain.frameAt(world));
      assert.notEqual(grounded, world, 'groundAt must not mutate callers');
    }
  }
});

test('exponential site chart round-trips meter coordinates across all five planet sizes', () => {
  for (const radius of [115, 145, 150, 190, 210]) {
    const t = radius === spec.radius ? terrain : createSphericalTerrain({ ...spec, radius, terrainSegments: { width: 80, height: 48 } }, 1);
    vectorNear(t.patchPoint(0, 0), t.groundAt(new THREE.Vector3(0, 8, 120)), 1e-8);
    for (const x of [-120, -61, -1, 0, 1, 72, 120]) for (const z of [-120, -59, -1, 0, 1, 68, 120]) {
      for (const altitude of [0, 1.7, 90]) {
        const p = t.patchPoint(x, z, altitude), chart = t.patchCoordinates(p);
        near(chart.x, x, 1e-8); near(chart.z, z, 1e-8);
        near(t.altitudeAt(p), altitude, 1e-8);
        assertFrame(t.frameAt(p));
      }
    }
    const ahead = t.normalAt(t.patchPoint(0, -1)).sub(t.siteUp).normalize();
    const right = t.normalAt(t.patchPoint(1, 0)).sub(t.siteUp).normalize();
    assert.ok(ahead.dot(t.siteForward) > .999);
    assert.ok(right.dot(t.siteRight) > .999);
    // The chart covers scenery placements, but terrain remains valid far beyond
    // its edge: walking around the back of the sphere has no arena boundary.
    const farSide = t.center.clone().addScaledVector(t.siteUp, -radius * 2);
    near(t.altitudeAt(t.groundAt(farSide)), 0, 1e-8);
    if (t !== terrain) t.geometry.dispose();
  }
});

test('the arrival hemisphere has gentle real slopes and no flattening plane', () => {
  for (let x = -40; x <= 40; x += 10) for (let z = -40; z <= 40; z += 10) {
    const p = terrain.patchPoint(x, z);
    assert.ok(terrain.surfaceNormalAt(p).dot(terrain.normalAt(p)) > .98);
  }
  const origin = terrain.patchPoint(0, 0), edge = terrain.patchPoint(110, 0);
  assert.ok(edge.clone().sub(origin).dot(terrain.siteUp) < -20, 'the site must curve with the actual globe');
});
