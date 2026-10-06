import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CameraRig } from '../game/actors/camera-rig.js';

function rig() {
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 1e6), r = new CameraRig(camera);
  r.setMode('ship', 0.01);
  return { camera, r, ship: { object: new THREE.Object3D(), speed: 0 } };
}

test('the chase camera holds its distance behind a fast ship at any frame rate', () => {
  for (const fps of [30, 60, 144, 240]) {
    for (const speed of [150, 400, 900, 1800, 14000]) {
      const { camera, r, ship } = rig(), dt = 1 / fps, distances = [];
      ship.speed = speed;
      for (let t = 0; t < 3; t += dt) {
        ship.object.position.z -= speed * dt; // the Aster's forward is -Z
        r.updateShip(dt, ship);
        if (t > 1) distances.push(camera.position.distanceTo(ship.object.position));
      }
      const spread = Math.max(...distances) - Math.min(...distances);
      assert.ok(spread < 0.05, `${speed} m/s at ${fps} fps: the distance wanders ${spread.toFixed(2)} m`);
      assert.ok(distances[0] < 40, `${speed} m/s at ${fps} fps: it stays close (${distances[0].toFixed(1)} m)`);
    }
  }
});

test('the chase camera trails a turn smoothly and cuts when the view flips', () => {
  const { camera, r, ship } = rig(), dt = 1 / 60;
  ship.speed = 600;
  const forward = () => new THREE.Vector3(0, 0, -1).applyQuaternion(ship.object.quaternion);
  let previous = null, largest = 0;
  for (let i = 0; i < 180; i++) {
    ship.object.rotateY(3 * dt); // a hard, steady turn
    ship.object.position.addScaledVector(forward(), ship.speed * dt);
    r.updateShip(dt, ship);
    const offset = camera.position.clone().sub(ship.object.position);
    if (previous) largest = Math.max(largest, offset.distanceTo(previous));
    previous = offset;
  }
  assert.ok(largest < 2, `the view swings smoothly (largest step ${largest.toFixed(2)} m)`);
  ship.object.rotateY(Math.PI); // a respawn facing the other way
  ship.object.position.add(new THREE.Vector3(5000, 0, 0));
  r.updateShip(dt, ship);
  const behind = camera.position.clone().sub(ship.object.position).dot(forward());
  assert.ok(behind < -10, 'it cuts to behind the ship instead of swinging through it');
});
