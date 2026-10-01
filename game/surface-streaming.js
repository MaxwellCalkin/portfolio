import * as THREE from 'three';
import { createSphericalWorldCatalog } from './spherical-world-catalog.js';

const UP = new THREE.Vector3(0, 1, 0), TAU = Math.PI * 2;
export const SURFACE_STREAM_LIMITS = Object.freeze({ sectors: 24, radius: 310, altitude: 650, refreshDistance: 12, shrineCoverage: 145 });
function random(seed) { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/** Only local tile groups exist. The full catalog is lightweight deterministic
 * data; leaving a tile removes its colliders and releases its CPU instance data.
 * A fixed set of shared GPU instance pools is reused through tile churn, then
 * disposed with its shared geometry/materials once at shutdown.
 */
export function createSurfaceStreaming({ terrain, collision, group, index, theme, materials }) {
  const catalog = createSphericalWorldCatalog(terrain, { seed: 1384 + index * 71, maxShrineDistance: SURFACE_STREAM_LIMITS.shrineCoverage });
  const root = new THREE.Group(); root.name = 'streamed-surface-sectors';
  const hubRoots = group.children.slice(), hubColliders = [...collision.colliders.values()];
  group.add(root);
  const active = new Map(), pools = new Map(), animatedInstances = [];
  const lastFocus = new THREE.Vector3(Infinity, Infinity, Infinity);
  const stats = { createdSectors: 0, disposedSectors: 0 };
  let hubActive = true, wasNear = false, disposed = false;
  const { rockMat, floraMat, structureMat, trim } = materials;
  const canopyMat = new THREE.MeshStandardMaterial({ color: theme.flora, roughness: .75, metalness: .15 });
  const coreMat = new THREE.MeshStandardMaterial({ color: '#defaed', emissive: terrain.spec.color, emissiveIntensity: 2.6, roughness: .22 });
  const haloMat = new THREE.MeshBasicMaterial({ color: terrain.spec.color, transparent: true, opacity: .75 });
  const beamMat = new THREE.MeshBasicMaterial({ color: terrain.spec.color, transparent: true, opacity: .16, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const geometries = {
    rock: new THREE.IcosahedronGeometry(1, 1), crystal: new THREE.CylinderGeometry(0, .7, 4, 5, 1).translate(0, 2, 0),
    stem: new THREE.CylinderGeometry(.16, .32, 5.5, 7), canopy: new THREE.SphereGeometry(1, 12, 8, 0, TAU, 0, Math.PI * .55),
    base: new THREE.CylinderGeometry(3.4, 4.3, .65, 12), trim: new THREE.CylinderGeometry(2.7, 3.15, .15, 32),
    post: new THREE.ConeGeometry(.43, 4.7, 4), core: new THREE.OctahedronGeometry(.77),
    halo: new THREE.TorusGeometry(1.35, .035, 6, 40), beam: new THREE.CylinderGeometry(.05, .2, 29, 8, 1, true),
    pillar: new THREE.CylinderGeometry(1.1, 1.3, 9, 6), rune: new THREE.BoxGeometry(.12, 6.5, .06),
  };
  const dummy = new THREE.Object3D(), yawRotation = new THREE.Quaternion();
  function pose(at, lift, yaw, x, y, z) {
    const frame = terrain.frameAt(at);
    dummy.position.copy(at).addScaledVector(frame.up, lift);
    dummy.quaternion.copy(frame.quaternion).multiply(yawRotation.setFromAxisAngle(UP, yaw));
    dummy.scale.set(x, y, z); dummy.updateMatrix(); return frame;
  }
  function addCollider(tile, record) {
    const id = collision.addCollider({ ...record, id: `${tile.sector.id}:collider:${tile.colliderIds.length}`, sectorId: tile.sector.id });
    tile.colliderIds.push(id);
  }
  function localCollider(tile, anchor, a, b, radius, kind) {
    anchor.updateMatrix();
    addCollider(tile, { a: new THREE.Vector3(...a).applyMatrix4(anchor.matrix), b: new THREE.Vector3(...b).applyMatrix4(anchor.matrix), radius, kind });
  }
  function addMesh(tile, geometry, material, anchor, x = 0, y = 0, z = 0) {
    const item = new THREE.Mesh(geometry, material); item.position.set(x, y, z); item.castShadow = true; item.receiveShadow = true;
    anchor.add(item); tile.meshCount++; return item;
  }
  function shrineFor(tile) {
    if (tile.sector.hub) return;
    const shrine = tile.sector.shrine, anchor = new THREE.Group(); anchor.name = `archive-${shrine.id}`;
    anchor.position.copy(shrine.position); anchor.quaternion.copy(terrain.frameAt(shrine.position).quaternion);
    anchor.userData.radialAnchor = true; anchor.userData.shrineId = shrine.id; tile.group.add(anchor);
    addMesh(tile, geometries.base, structureMat, anchor, 0, .2, 0);
    addMesh(tile, geometries.trim, trim, anchor, 0, .63, 0);
    for (let i = 0; i < 3; i++) {
      const angle = i * TAU / 3, x = Math.cos(angle) * 2.35, z = Math.sin(angle) * 2.35;
      addMesh(tile, geometries.post, structureMat, anchor, x, 2.55, z);
      localCollider(tile, anchor, [x, .5, z], [x, 4.2, z], .32, 'archive-post');
    }
    // Continuous overlapping shallow rim capsules, rather than a player-height
    // invisible cylindrical wall. The same dimensions as the original archive.
    for (let i = 0; i < 20; i++) {
      const angle = i * TAU / 20, x = Math.cos(angle) * 3.65, z = Math.sin(angle) * 3.65;
      localCollider(tile, anchor, [x, .2, z], [x, .23, z], .58, 'archive-base');
    }
    const core = addMesh(tile, geometries.core, coreMat, anchor, 0, 2.45, 0);
    const halo = addMesh(tile, geometries.halo, haloMat, anchor, 0, 2.45, 0); halo.rotation.x = Math.PI / 2;
    addMesh(tile, geometries.beam, beamMat, anchor, 0, 16.8, 0).castShadow = false;
    localCollider(tile, anchor, [0, 2.45, 0], [0, 2.45, 0], .6, 'archive-core');
    tile.shrine = { core, halo, phase: (tile.sector.seed % 100) * .1 };
  }
  function protectedLocation(at, sector) {
    if (at.distanceToSquared(sector.shrine.position) < 13 ** 2) return true;
    if (at.distanceToSquared(catalog.hubShrine.position) > 155 ** 2) return false;
    const { x, z } = terrain.patchCoordinates(at);
    if (Math.abs(x) < 13 && z > -40 && z < 48) return true;
    if ((x + 38) ** 2 + (z + 55) ** 2 < 225 || (x - 58) ** 2 + (z + 72) ** 2 < 256) return true;
    for (let i = 0; i < 5; i++) if ((x + 65 - i * 10) ** 2 + (z + 91 + (i % 2) * 9) ** 2 < 25) return true;
    return false;
  }
  function createTile(sector) {
    const tileGroup = new THREE.Group(); tileGroup.name = sector.id; tileGroup.userData.sectorId = sector.id;
    const tile = { sector, group: tileGroup, colliderIds: [], instanceCount: 0, meshCount: 0, shrine: null, draws: [] };
    tileGroup.visible = false; root.add(tileGroup); const rnd = random(sector.seed);
    const positions = count => {
      const result = [];
      for (let attempt = 0; result.length < count && attempt < count * 5; attempt++) {
        const at = catalog.pointInSector(sector, .03 + rnd() * .94, .03 + rnd() * .94);
        if (!protectedLocation(at, sector)) result.push(at);
      }
      return result;
    };
    function instance(geometry, material, points, name, populate) {
      if (!points.length) return;
      const colors = [];
      const items = { setColorAt(i, color) { colors[i] = color.clone(); } };
      points.forEach((at, i) => { populate(at, i, items); tile.draws.push({ geometry, material, name, matrix: dummy.matrix.clone(), color: colors[i] }); });
      tile.instanceCount += points.length;
    }
    instance(geometries.rock, rockMat, positions(Math.max(12, Math.min(64, Math.ceil(sector.area / 540)))), 'radial-boulders', at => {
      const s = .6 + rnd() * 2.8, frame = pose(at, s * .32, rnd() * TAU, s, s * .73, s);
      addCollider(tile, { position: at.clone().addScaledVector(frame.up, s * .38), radius: s * .83, kind: 'boulder' });
    });
    instance(geometries.crystal, floraMat, positions(Math.max(10, Math.min(52, Math.ceil(sector.area / 700)))), 'radial-mineral-blooms', (at, i, items) => {
      const s = .4 + rnd() * 1.1, tall = s * (.9 + rnd() * 1.1), frame = pose(at, -.07, rnd() * TAU, s, tall, s);
      items.setColorAt(i, new THREE.Color(theme.flora).multiplyScalar(.72 + rnd() * .4));
      addCollider(tile, { a: at.clone().addScaledVector(frame.up, .2 * tall), b: at.clone().addScaledVector(frame.up, 2.6 * tall), radius: .4 * s, kind: 'crystal' });
    });
    const trees = positions(Math.max(3, Math.min(14, Math.ceil(sector.area / 2500))));
    const treeScales = trees.map(() => .85 + rnd() * .85), treeYaws = trees.map(() => rnd() * TAU);
    instance(geometries.stem, rockMat, trees, 'radial-umbrella-stems', (at, i) => {
      const s = treeScales[i], frame = pose(at, 2.7 * s, treeYaws[i], s, s, s);
      addCollider(tile, { a: at.clone().addScaledVector(frame.up, .2), b: at.clone().addScaledVector(frame.up, 5.3 * s), radius: .24 * s, kind: 'flora-stem' });
    });
    instance(geometries.canopy, canopyMat, trees, 'radial-umbrella-canopies', (at, i) => {
      const s = treeScales[i]; pose(at, 5.3 * s, treeYaws[i], 2.9 * s, .9 * s, 2.3 * s);
    });
    // Ruined survey pillars make remote biomes read as explored landscapes too.
    if (!sector.hub && sector.seed % 3 === 0) {
      const at = catalog.pointInSector(sector, .28, .68);
      if (!protectedLocation(at, sector)) {
        const anchor = new THREE.Group(); anchor.position.copy(at); anchor.quaternion.copy(terrain.frameAt(at).quaternion); anchor.userData.radialAnchor = true;
        anchor.name = 'radial-frontier-survey-pillar'; tileGroup.add(anchor);
        addMesh(tile, geometries.pillar, structureMat, anchor, 0, 4.5, 0);
        addMesh(tile, geometries.rune, trim, anchor, -.4, 4.7, -1.14);
        localCollider(tile, anchor, [0, 1.1, 0], [0, 7.9, 0], 1.2, 'archive-pillar');
      }
    }
    shrineFor(tile); active.set(sector.id, tile); stats.createdSectors++; return tile;
  }
  function removeTile(id) {
    const tile = active.get(id); if (!tile) return;
    for (const colliderId of tile.colliderIds) collision.removeCollider(colliderId);
    tile.group.traverse(object => { if (object.isInstancedMesh) object.dispose(); });
    tile.group.removeFromParent(); active.delete(id); stats.disposedSectors++;
  }
  function poolFor(geometry, material, name = '') {
    const key = `${geometry.uuid}:${material.uuid}`;
    if (pools.has(key)) return pools.get(key);
    const propCapacity = geometry === geometries.rock ? 64 : geometry === geometries.crystal ? 52 : geometry === geometries.stem || geometry === geometries.canopy ? 14 : geometry === geometries.post ? 3 : 1;
    const pool = new THREE.InstancedMesh(geometry, material, SURFACE_STREAM_LIMITS.sectors * propCapacity);
    pool.name = name || `streamed-${Object.keys(geometries).find(key => geometries[key] === geometry)}`;
    pool.userData.radialAssembly = ![geometries.rock, geometries.crystal, geometries.stem, geometries.canopy].includes(geometry);
    pool.userData.shrineIds = [];
    pool.count = 0; pool.castShadow = geometry !== geometries.beam; pool.receiveShadow = true;
    pool.instanceMatrix.setUsage(THREE.DynamicDrawUsage); root.add(pool); pools.set(key, pool); return pool;
  }
  function rebuildPools() {
    animatedInstances.length = 0;
    for (const pool of pools.values()) { pool.count = 0; pool.userData.shrineIds.length = 0; }
    for (const tile of active.values()) {
      for (const draw of tile.draws) {
        const pool = poolFor(draw.geometry, draw.material, draw.name), i = pool.count++;
        pool.setMatrixAt(i, draw.matrix); if (draw.color) pool.setColorAt(i, draw.color);
      }
      tile.group.updateMatrixWorld(true);
      tile.group.traverse(object => {
        if (!object.isMesh) return;
        const pool = poolFor(object.geometry, object.material), index = pool.count++;
        pool.setMatrixAt(index, object.matrixWorld);
        if (tile.shrine && object.parent.userData.shrineId) pool.userData.shrineIds.push(object.parent.userData.shrineId);
        if (object === tile.shrine?.core || object === tile.shrine?.halo) animatedInstances.push({ object, pool, index });
      });
    }
    for (const pool of pools.values()) {
      pool.visible = pool.count > 0; pool.instanceMatrix.needsUpdate = true;
      if (pool.instanceColor) pool.instanceColor.needsUpdate = true;
      pool.computeBoundingSphere(); if (pool.boundingSphere) pool.boundingSphere.radius += 1;
    }
  }
  function setHubActive(visible) {
    if (visible === hubActive) return;
    hubActive = visible; hubRoots.forEach(object => { object.visible = visible; });
    for (const collider of hubColliders) { if (visible) collision.addCollider(collider); else collision.removeCollider(collider.id); }
  }
  function update(time, dt, focusPosition = terrain.patchPoint(0, 15)) {
    if (disposed) return;
    const near = terrain.altitudeAt(focusPosition) <= SURFACE_STREAM_LIMITS.altitude && focusPosition.distanceTo(terrain.center) >= terrain.radius * .5;
    if (near !== wasNear || focusPosition.distanceToSquared(lastFocus) >= SURFACE_STREAM_LIMITS.refreshDistance ** 2) {
      const grounded = terrain.groundAt(focusPosition);
      const sectors = near ? catalog.nearbySectors(grounded, SURFACE_STREAM_LIMITS.radius, SURFACE_STREAM_LIMITS.sectors) : [];
      const wanted = new Set(sectors.map(sector => sector.id));
      for (const id of active.keys()) if (!wanted.has(id)) removeTile(id);
      setHubActive(near && grounded.distanceToSquared(catalog.hubShrine.position) < (SURFACE_STREAM_LIMITS.radius + 145) ** 2);
      for (const sector of sectors) if (!active.has(sector.id)) createTile(sector);
      rebuildPools();
      lastFocus.copy(focusPosition); wasNear = near;
    }
    for (const tile of active.values()) if (tile.shrine) {
      const { core, halo, phase } = tile.shrine;
      core.rotation.y = time * .4 + phase; core.rotation.z = Math.sin(time * .5 + phase) * .15; core.position.y = 2.45 + Math.sin(time * 1.5 + phase) * .16;
      halo.rotation.z = time * .3 + phase; halo.rotation.x = Math.PI / 2 + Math.sin(time * .4 + phase) * .25;
    }
    for (const { object, pool, index } of animatedInstances) {
      object.updateWorldMatrix(true, false); pool.setMatrixAt(index, object.matrixWorld); pool.instanceMatrix.needsUpdate = true;
    }
  }
  function getStats() {
    let activeShrineCount = hubActive ? 1 : 0, instanceCount = 0, meshCount = 0, streamedColliderCount = 0;
    const activeShrineIds = hubActive ? [catalog.hubShrine.id] : [];
    for (const tile of active.values()) { if (tile.shrine) { activeShrineCount++; activeShrineIds.push(tile.sector.shrine.id); } instanceCount += tile.instanceCount; meshCount += tile.meshCount; streamedColliderCount += tile.colliderIds.length; }
    return { ...stats, activeSectorCount: active.size, activeSectorIds: [...active.keys()].sort(), activeShrineCount, activeShrineIds: activeShrineIds.sort(), catalogShrineCount: catalog.shrines.length,
      catalogSectorCount: catalog.sectors.length, instanceCount, meshCount, streamedDrawCalls: [...pools.values()].filter(pool => pool.visible).length, colliderCount: collision.colliders.size, streamedColliderCount,
      maxShrineDistance: catalog.maxShrineDistance, maxActiveSectors: SURFACE_STREAM_LIMITS.sectors, streamRadius: SURFACE_STREAM_LIMITS.radius, hubActive };
  }
  function dispose() {
    if (disposed) return; disposed = true;
    for (const id of [...active.keys()]) removeTile(id);
    for (const pool of pools.values()) pool.dispose(); pools.clear();
    root.removeFromParent(); Object.values(geometries).forEach(geometry => geometry.dispose());
    for (const material of [canopyMat, coreMat, haloMat, beamMat]) material.dispose();
  }
  return { catalog, active, update, dispose, getStats };
}
