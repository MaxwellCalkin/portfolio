import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHeroExplorer } from '../game/hero-explorer.js';

const vec = (...xyz) => new THREE.Vector3(...xyz);

test('hero explorer is a finite, game-budgeted original articulated model', () => {
  const hero = createHeroExplorer();
  assert.equal(hero.name, 'Kestrel-07-hero-explorer');
  assert.equal(hero.userData.modelName, 'KESTREL / 07');
  let meshes = 0, triangles = 0;
  hero.traverse(object => {
    if (!object.isMesh) return;
    meshes++;
    assert.ok(object.castShadow && object.receiveShadow);
    const geometry = object.geometry;
    assert.ok(geometry.attributes.position.count > 0);
    for (const value of geometry.attributes.position.array) assert.ok(Number.isFinite(value));
    for (const value of geometry.attributes.normal.array) assert.ok(Number.isFinite(value));
    triangles += (geometry.index?.count ?? geometry.attributes.position.count) / 3;
  });
  assert.ok(meshes >= 50 && meshes <= 150, `draw meshes: ${meshes}`);
  assert.ok(triangles >= 3000 && triangles <= 20000, `triangles: ${triangles}`);
  const bounds = new THREE.Box3().setFromObject(hero);
  const size = bounds.getSize(vec());
  assert.ok(size.y > 2.3 && size.y < 2.6, `height: ${size.y}`);
  assert.ok(size.x > 1 && size.x < 1.6, `shoulder/weapon width: ${size.x}`);
  assert.ok(Math.abs(bounds.min.y) < .01, `resting sole: ${bounds.min.y}`);
  for (const name of ['leftLeg', 'rightLeg', 'leftArm', 'rightArm']) {
    assert.ok(hero.userData.limbs[name]?.isGroup, `${name} articulation`);
    assert.equal(hero.userData.parts[name], hero.userData.limbs[name]);
  }
  for (const name of ['left-split-coattail', 'right-split-coattail', 'wind-swept-scarf', 'angular-flight-helmet']) {
    assert.ok(hero.getObjectByName(name), name);
  }
  assert.ok(hero.userData.weapon.isGroup);
  assert.ok(hero.userData.muzzle.isVector3);
  hero.userData.dispose();
});

test('aim and locomotion keep the barrel muzzle, hands, and planted sole coherent', () => {
  const hero = createHeroExplorer();
  const rootPosition = vec(12.1, 4.25, -8.5);
  let maxMuzzleError = 0, maxGripError = 0, minSole = Infinity, maxSole = -Infinity;
  let sawLeftKneeBend = false, sawRightKneeBend = false;
  for (let frame = 0; frame < 160; frame++) {
    hero.position.copy(rootPosition);
    hero.rotation.y = frame * .018;
    hero.userData.update(frame / 30, 1 / 30, {
      moving: frame > 30,
      aimPitch: -.75 + frame / 159 * 1.6,
      fire: frame % 20 < 5,
      speed: frame > 130 ? 2 : 1,
    });
    const physicalMuzzle = hero.getObjectByName('muzzle-marker').getWorldPosition(vec());
    const gameplayMuzzle = hero.localToWorld(hero.userData.muzzle.clone());
    maxMuzzleError = Math.max(maxMuzzleError, physicalMuzzle.distanceTo(gameplayMuzzle));
    for (const [side, grip] of [
      ['left', vec(-.012, -.063, -.30)],
      ['right', vec(.004, -.123, .001)],
    ]) {
      const knuckle = hero.getObjectByName(`${side}-glove`).localToWorld(vec(0, -.052, 0));
      const actualGrip = hero.userData.weapon.localToWorld(grip);
      maxGripError = Math.max(maxGripError, knuckle.distanceTo(actualGrip));
    }
    const sole = new THREE.Box3().setFromObject(hero).min.y - rootPosition.y;
    minSole = Math.min(minSole, sole);
    maxSole = Math.max(maxSole, sole);
    sawLeftKneeBend ||= hero.userData.knees.left.rotation.x < -.5;
    sawRightKneeBend ||= hero.userData.knees.right.rotation.x < -.5;
    for (const value of hero.userData.muzzle.toArray()) assert.ok(Number.isFinite(value));
  }
  assert.ok(maxMuzzleError < 1e-10, `muzzle alignment: ${maxMuzzleError}`);
  assert.ok(maxGripError < .045, `glove-to-rifle separation: ${maxGripError}`);
  assert.ok(minSole >= -.01 && maxSole <= .015, `ground contact range: ${minSole}..${maxSole}`);
  assert.ok(sawLeftKneeBend && sawRightKneeBend, 'both knees articulate during running');
  hero.userData.dispose();
});

test('hero disposal releases rendered geometries and materials and detaches the root', () => {
  const hero = createHeroExplorer();
  const scene = new THREE.Scene();
  scene.add(hero);
  const geometries = new Set(), materials = new Set(), disposed = new Set();
  hero.traverse(object => {
    if (!object.isMesh) return;
    geometries.add(object.geometry);
    materials.add(object.material);
  });
  for (const resource of [...geometries, ...materials]) {
    resource.addEventListener('dispose', () => disposed.add(resource));
  }
  hero.userData.dispose();
  assert.equal(hero.parent, null);
  for (const resource of [...geometries, ...materials]) assert.ok(disposed.has(resource));
});
