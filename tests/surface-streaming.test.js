import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSphericalTerrain } from '../game/spherical-terrain.js';
import { createSphericalWorldCatalog } from '../game/spherical-world-catalog.js';
import { createPlanetSurfaces } from '../game/planet-surfaces.js';
import { SURFACE_STREAM_LIMITS } from '../game/surface-streaming.js';

const spec = { id: 'huge', radius: 2100, position: [47250, -5250, -8400], color: '#b9a2ff' };
const direction = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
const surfacePoint = (terrain, up) => terrain.groundAt(terrain.center.clone().addScaledVector(up, terrain.radius));
const makeSurface = (overrides = {}) => createPlanetSurfaces([{ ...spec, terrainSegments: { width: 96, height: 64 }, ...overrides }]).get(spec.id);
const fingerprint = surface => [...surface.colliders.values()].filter(collider => collider.sectorId).sort((a, b) => a.id.localeCompare(b.id)).map(collider => [collider.id, ...collider.a.toArray(), ...collider.b.toArray(), collider.radius]);

test('large terrain increases fixed tessellation while retaining a closed exact mesh and conservative surface metric', () => {
  const terrain = createSphericalTerrain(spec, 2);
  assert.deepEqual(terrain.terrainSegments, { width: 256, height: 160 });
  assert.equal(terrain.geometry.index.count / 3, 256 * 159 * 2);
  assert.ok(terrain.minRadialAlignment > .5 && terrain.minRadialAlignment <= 1);
  assert.ok(terrain.surfaceMetricBound >= terrain.maxRadius);
  const mesh = new THREE.Mesh(terrain.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.position.copy(terrain.center); mesh.updateMatrixWorld();
  const raycaster = new THREE.Raycaster();
  for (const up of [direction(0, 1, 0), direction(0, -1, 0), direction(-1, .4, 1e-9), direction(-1, .4, -1e-9), direction(1, 2, 3), terrain.siteUp.clone().negate()]) {
    raycaster.set(terrain.center.clone().addScaledVector(up, terrain.radius * 2), up.clone().negate());
    const hit = raycaster.intersectObject(mesh)[0]; assert.ok(hit);
    assert.ok(terrain.groundAt(hit.point).distanceTo(hit.point) < 1e-6);
  }
  terrain.geometry.dispose(); mesh.material.dispose();
});

test('cube-sphere archives guarantee <=145m coverage, with exhaustive cell corners, both poles and dense global sampling', () => {
  for (const radius of [1150, 1450, 1500, 1900, 2100]) {
    const terrain = createSphericalTerrain({ ...spec, radius, terrainSegments: { width: 80, height: 48 } }, 2);
    const catalog = createSphericalWorldCatalog(terrain, { seed: 63 });
    assert.ok(catalog.maxShrineDistance <= SURFACE_STREAM_LIMITS.shrineCoverage);
    assert.equal(catalog.shrines.length, 6 * catalog.divisions ** 2);
    assert.equal(new Set(catalog.shrines.map(shrine => shrine.id)).size, catalog.shrines.length);
    assert.ok(catalog.hubShrine.position.distanceTo(terrain.patchPoint(0, -12)) < 1e-8);
    for (const sector of catalog.sectors) for (const [u, v] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      const corner = catalog.pointInSector(sector, u, v);
      assert.ok(corner.distanceTo(sector.shrine.position) <= catalog.maxShrineDistance + 1e-6);
    }
    const samples = [direction(0, 1, 0), direction(0, -1, 0)];
    for (let i = 0; i < 2200; i++) {
      const y = -1 + 2 * (i + .5) / 2200, angle = i * Math.PI * (3 - Math.sqrt(5));
      samples.push(direction(Math.cos(angle) * Math.sqrt(1 - y * y), y, Math.sin(angle) * Math.sqrt(1 - y * y)));
    }
    for (const up of samples) {
      const at = surfacePoint(terrain, up), shrine = catalog.nearestShrine(at);
      assert.ok(shrine.distance <= catalog.maxShrineDistance + 1e-6, `${radius}: nearest archive ${shrine.distance}m away`);
      assert.ok(Math.abs(at.distanceTo(shrine.position) - shrine.distance) < 1e-8);
      assert.ok(Math.abs(terrain.altitudeAt(shrine.position)) < 1e-8);
    }
    terrain.geometry.dispose();
  }
});

test('catalog identity, poses and arbitrary local sector points are reproducible and seam/pole safe', () => {
  const terrain = createSphericalTerrain({ ...spec, terrainSegments: { width: 48, height: 32 } });
  const first = createSphericalWorldCatalog(terrain, { seed: 81 }), second = createSphericalWorldCatalog(terrain, { seed: 81 });
  assert.deepEqual(first.sectors, second.sectors);
  for (const up of [direction(0, 1, 0), direction(0, -1, 0), direction(1, 1, 1), direction(-1, -1, -1)]) {
    const at = surfacePoint(terrain, up), sectors = first.nearbySectors(at, 310, 24);
    assert.ok(sectors.length >= 3 && sectors.length <= 24);
    assert.ok(sectors.some(sector => sector.id === first.nearestShrine(at).sectorId));
    for (const sector of sectors) {
      assert.ok(Math.abs(sector.up.length() - 1) < 1e-12);
      const point = first.pointInSector(sector, .17, .84, 1.5);
      assert.ok(Math.abs(terrain.altitudeAt(point) - 1.5) < 1e-8);
    }
  }
  terrain.geometry.dispose();
});

test('scenery, colliders, and reachable archive models stream through distant hemispheres with strictly bounded draws and no stale collisions', () => {
  const surface = makeSurface(), geometry = surface.geometry;
  const route = [surface.spawn, surfacePoint(surface, direction(0, 1, 0)), surfacePoint(surface, direction(0, -1, 0)), surfacePoint(surface, direction(-1, 1, 1)), surfacePoint(surface, surface.siteUp.clone().negate())];
  let time = 0;
  for (const at of route) {
    const previous = new Set([...surface.colliders.values()].filter(collider => collider.sectorId).map(collider => collider.id));
    surface.update(time++, .016, at);
    const stats = surface.getStreamingStats(), nearest = surface.nearestShrine(at);
    assert.ok(stats.activeSectorCount > 0 && stats.activeSectorCount <= 24);
    assert.ok(stats.activeShrineIds.includes(nearest.id), 'the nearest catalog shrine must have a real active model');
    assert.ok(stats.activeShrineCount <= 25);
    assert.ok(stats.streamedDrawCalls <= 12, 'all sectors share the same small set of instanced draw pools');
    assert.ok(stats.colliderCount < 3800 && stats.instanceCount <= 3456);
    assert.ok(stats.instanceCount > 100, 'arbitrary surface locations retain rich scenery');
    const ids = new Set(stats.activeSectorIds);
    for (const collider of surface.colliders.values()) if (collider.sectorId) assert.ok(ids.has(collider.sectorId), 'no unloaded tile collider survives');
    if (time > 1) assert.ok([...previous].some(id => !surface.colliders.has(id)));
    assert.equal(surface.geometry, geometry, 'travel never swaps the actual planet terrain');
    assert.ok(Math.abs(surface.altitudeAt(surface.groundAt(at))) < 1e-7);
    let archiveVisible = nearest.hub;
    surface.group.traverse(object => { if (object.isInstancedMesh && object.visible && object.userData.shrineIds?.includes(nearest.id)) archiveVisible = true; });
    assert.ok(archiveVisible);
  }
  surface.dispose(); surface.geometry.dispose();
});

test('unload/reload preserves exact deterministic scenery and solid obstacles after circumnavigation', () => {
  const surface = makeSurface(), north = surfacePoint(surface, direction(0, 1, 0)), south = surfacePoint(surface, direction(0, -1, 0));
  surface.update(1, .016, north); const original = fingerprint(surface), originalStats = surface.getStreamingStats();
  const nearNoChange = surface.groundAt(north.clone().addScaledVector(surface.frameAt(north).right, 2));
  surface.update(2, .016, nearNoChange);
  assert.equal(surface.getStreamingStats().createdSectors, originalStats.createdSectors, 'no tile churn within the refresh threshold');
  surface.update(3, .016, south); surface.update(4, .016, north);
  assert.deepEqual(fingerprint(surface), original);
  assert.ok(surface.getStreamingStats().disposedSectors > 0);
  const boulder = [...surface.colliders.values()].find(collider => collider.kind === 'boulder' && collider.sectorId);
  assert.ok(boulder);
  const frame = surface.frameAt(boulder.a), start = surface.groundAt(boulder.a.clone().addScaledVector(frame.right, -8));
  const moved = surface.resolveMovement(start, frame.right.clone().multiplyScalar(16));
  assert.ok(moved.clone().sub(boulder.a).dot(frame.right) < 0, 'the reloaded boulder blocks a swept walk through its visible position');
  assert.ok(Math.abs(surface.altitudeAt(moved)) < 1e-7);
  surface.dispose(); surface.geometry.dispose();
});

test('orbital focus unloads all local buffers/colliders and moving back restores the same hub and shrine identity', () => {
  const surface = makeSurface(), nearest = surface.nearestShrine(surface.spawn);
  surface.update(1, .016, surface.center.clone().addScaledVector(surface.siteUp, surface.radius * 4));
  const stats = surface.getStreamingStats();
  assert.equal(stats.activeSectorCount, 0); assert.equal(stats.activeShrineCount, 0); assert.equal(stats.streamedDrawCalls, 0); assert.equal(stats.colliderCount, 0);
  assert.equal(surface.group.getObjectByName('radial-archive').visible, false);
  surface.update(2, .016, surface.spawn);
  assert.equal(surface.nearestShrine(surface.spawn).id, nearest.id);
  assert.equal(surface.group.getObjectByName('radial-archive').visible, true);
  assert.ok(surface.getStreamingStats().colliderCount > 0);
  const sceneGeometries = new Set(); surface.group.traverse(object => { if (object.geometry) sceneGeometries.add(object.geometry); });
  const counts = new Map(); for (const geometry of sceneGeometries) geometry.addEventListener('dispose', () => counts.set(geometry, (counts.get(geometry) ?? 0) + 1));
  surface.dispose(); assert.equal(surface.colliders.size, 0);
  assert.ok([...counts.values()].every(count => count === 1), 'shared pool geometry is released exactly once');
  surface.geometry.dispose();
});
