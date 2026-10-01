import * as THREE from 'three';

const FACE_AXES = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];
export function sectorSeed(face, x, y, seed = 0) {
  let n = Math.imul(face + 1, 73856093) ^ Math.imul(x + 1, 19349663) ^ Math.imul(y + 1, 83492791) ^ seed;
  n = Math.imul(n ^ (n >>> 16), 2246822507);
  return (n ^ (n >>> 13)) >>> 0;
}

/** A deterministic data-only cube-sphere catalog. No global meshes or colliders.
 * Every cell has an archive at its center, including the poles and cube seams.
 * normalize(face + u*axisU + v*axisV) has spherical metric <= 1. Therefore any
 * point in a cell is at most sqrt(2)/divisions radians from its center along a
 * path inside that cell. terrain.surfaceMetricBound includes rendered slopes:
 * their product is a conservative world-meter path/Euclidean coverage bound.
 */
export function createSphericalWorldCatalog(terrain, { maxShrineDistance = 145, seed = 0 } = {}) {
  const metric = terrain.surfaceMetricBound ?? terrain.radius * 1.5;
  const divisions = Math.max(2, Math.ceil(Math.SQRT2 * metric / maxShrineDistance));
  const hubPosition = terrain.patchPoint(0, -12), hubDirection = terrain.normalAt(hubPosition);
  const mid = Math.floor(divisions / 2), midUV = (mid + .5) * 2 / divisions - 1;
  const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(midUV, midUV, 1).normalize(), hubDirection);
  const axes = FACE_AXES.map(face => face.map(axis => new THREE.Vector3(...axis).applyQuaternion(rotation)));
  const pointInSector = (sector, u = .5, v = .5, clearance = 0) => {
    const [normal, horizontal, vertical] = axes[sector.face];
    const direction = normal.clone().addScaledVector(horizontal, (sector.x + u) * 2 / divisions - 1).addScaledVector(vertical, (sector.y + v) * 2 / divisions - 1).normalize();
    return terrain.center.clone().addScaledVector(direction, terrain.radiusAt(direction) + clearance);
  };
  const sectors = [], shrines = [], coordinates = new Float64Array(6 * divisions * divisions * 3);
  for (let face = 0; face < 6; face++) for (let y = 0; y < divisions; y++) for (let x = 0; x < divisions; x++) {
    const hub = face === 4 && x === mid && y === mid;
    const id = `${terrain.spec.id}:sector:${face}:${x}:${y}`, sector = { id, face, x, y, seed: sectorSeed(face, x, y, seed), hub };
    const position = hub ? hubPosition.clone() : pointInSector(sector), up = terrain.normalAt(position);
    const shrine = { id: `${terrain.spec.id}:archive:${hub ? 'hub' : `${face}:${x}:${y}`}`, sectorId: id, position, hub };
    Object.assign(sector, { position, up, shrine, area: (2 * terrain.radius / divisions) ** 2 / (1 + ((x + .5) * 2 / divisions - 1) ** 2 + ((y + .5) * 2 / divisions - 1) ** 2) ** 1.5 });
    coordinates.set(position.toArray(), shrines.length * 3); sectors.push(sector); shrines.push(shrine);
  }
  const nearestShrine = worldPoint => {
    let best = 0, bestSquared = Infinity;
    for (let i = 0; i < shrines.length; i++) {
      const o = i * 3, x = worldPoint.x - coordinates[o], y = worldPoint.y - coordinates[o + 1], z = worldPoint.z - coordinates[o + 2];
      const square = x * x + y * y + z * z;
      if (square < bestSquared) { best = i; bestSquared = square; }
    }
    return { ...shrines[best], position: shrines[best].position.clone(), distance: Math.sqrt(bestSquared) };
  };
  const nearbySectors = (worldPoint, range = 300, limit = 24) => {
    const grounded = terrain.groundAt(worldPoint), rangeSquared = range * range, nearby = [];
    for (let i = 0; i < sectors.length; i++) {
      const o = i * 3, x = grounded.x - coordinates[o], y = grounded.y - coordinates[o + 1], z = grounded.z - coordinates[o + 2], distanceSquared = x * x + y * y + z * z;
      if (distanceSquared <= rangeSquared) nearby.push({ sector: sectors[i], distanceSquared });
    }
    nearby.sort((a, b) => a.distanceSquared - b.distanceSquared || a.sector.id.localeCompare(b.sector.id));
    return nearby.slice(0, limit).map(item => item.sector);
  };
  return { sectors, shrines, divisions, maxShrineDistance: Math.SQRT2 * metric / divisions, hubShrine: shrines.find(shrine => shrine.hub), pointInSector, nearestShrine, nearbySectors };
}
