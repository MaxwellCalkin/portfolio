import * as THREE from 'three';

const TAU = Math.PI * 2;
const DEFAULT_FORWARD = new THREE.Vector3(0, 0, -1);
const INITIAL_VIEW = new THREE.Vector3(0, 8, 120);
const clamp = THREE.MathUtils.clamp;

function hash(x, y, z, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const smooth = t => t * t * (3 - 2 * t);
  const fx = smooth(x - ix), fy = smooth(y - iy), fz = smooth(z - iz);
  const lerp = (a, b, t) => a + (b - a) * t;
  return lerp(
    lerp(lerp(hash(ix, iy, iz, seed), hash(ix + 1, iy, iz, seed), fx), lerp(hash(ix, iy + 1, iz, seed), hash(ix + 1, iy + 1, iz, seed), fx), fy),
    lerp(lerp(hash(ix, iy, iz + 1, seed), hash(ix + 1, iy, iz + 1, seed), fx), lerp(hash(ix, iy + 1, iz + 1, seed), hash(ix + 1, iy + 1, iz + 1, seed), fx), fy), fz) * 2 - 1;
}
function finiteDirection(value, fallback) {
  const direction = new THREE.Vector3(value?.x ?? 0, value?.y ?? 0, value?.z ?? 0);
  const length = direction.length();
  return Number.isFinite(length) && length > 1e-12 ? direction.divideScalar(length) : fallback.clone();
}
function tangentFrame(up, hint = DEFAULT_FORWARD) {
  const forward = new THREE.Vector3().copy(hint).addScaledVector(up, -hint.dot(up));
  if (!Number.isFinite(forward.lengthSq()) || forward.lengthSq() < 1e-10) {
    // Pick the least-aligned world axis: even the poles have a reliable basis.
    const ax = Math.abs(up.x), ay = Math.abs(up.y), az = Math.abs(up.z);
    forward.set(ax <= ay && ax <= az ? 1 : 0, ay < ax && ay <= az ? 1 : 0, az < ax && az < ay ? 1 : 0);
    forward.addScaledVector(up, -forward.dot(up));
  }
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();
  forward.crossVectors(up, right).normalize();
  const matrix = new THREE.Matrix4().makeBasis(right, up, forward.clone().negate());
  return { up, forward, right, quaternion: new THREE.Quaternion().setFromRotationMatrix(matrix).normalize() };
}

/**
 * A closed, star-shaped terrain shell. Geometry is planet-local; every public
 * position is a world coordinate. Put the unrotated geometry at `center` and
 * retain the planet's existing material. Rotating only its shader is safe;
 * rotating/scaling the mesh would invalidate the world-space sampler.
 *
 * `normalAt` is radial gravity-up. `surfaceNormalAt` is the rendered face normal.
 * The optional terrainSegments object is useful for tests/quality tuning.
 */
export function createSphericalTerrain(spec, index = 0) {
  if (!Number.isFinite(spec?.radius) || spec.radius <= 0) throw new RangeError('A planet needs a positive finite radius');
  const radius = spec.radius;
  const center = new THREE.Vector3().fromArray(spec.position ?? [0, 0, 0]);
  if (!center.toArray().every(Number.isFinite)) throw new RangeError('A planet needs a finite center');
  const siteUp = finiteDirection(INITIAL_VIEW.clone().sub(center), new THREE.Vector3(0, 1, 0));
  const siteFrame = tangentFrame(siteUp);
  const siteForward = siteFrame.forward, siteRight = siteFrame.right;
  const width = Math.max(16, Math.floor(spec.terrainSegments?.width ?? 160));
  const height = Math.max(8, Math.floor(spec.terrainSegments?.height ?? 96));
  const seed = Math.imul((index + 1) | 0, 198491317);
  const geometry = new THREE.SphereGeometry(radius, width, height);
  geometry.name = `${spec.id ?? 'planet'}-spherical-terrain`;
  geometry.userData.sphericalTerrain = true;
  const position = geometry.getAttribute('position');
  const direction = new THREE.Vector3();
  const sculptedRadius = direction => {
    // Cartesian 3D noise has no longitude seam or polar singularity.
    const x = direction.x, y = direction.y, z = direction.z;
    const continental = noise3(x * 3.1 + 4.7, y * 3.1 + 8.3, z * 3.1 - 2.6, seed);
    const hills = noise3(x * 8.2 - 9.1, y * 8.2 + 2.8, z * 8.2 + 3.4, seed + 37);
    const detail = noise3(x * 19.5 + 1.7, y * 19.5 - 3.2, z * 19.5 + 8.8, seed + 91);
    const angularDistance = Math.acos(clamp(direction.dot(siteUp), -1, 1));
    const siteDistance = angularDistance * radius;
    const wildness = THREE.MathUtils.smoothstep(siteDistance, 42, 115);
    const undulation = continental * .72 + hills * .23 + detail * .05;
    // Roughly 0.4m of relief at the arrival site, rising to several meters on
    // the far hemisphere. The visible sphere, rather than a flat patch, bends
    // continuously beneath the player everywhere.
    return radius + undulation * (.65 + radius * .043 * wildness);
  };
  for (let iy = 0; iy <= height; iy++) {
    const theta = iy / height * Math.PI;
    for (let ix = 0; ix <= width; ix++) {
      const phi = (ix === width ? 0 : ix / width) * TAU;
      if (iy === 0 || iy === height) direction.set(0, iy === 0 ? 1 : -1, 0);
      else direction.set(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
      const r = sculptedRadius(direction);
      position.setXYZ(iy * (width + 1) + ix, direction.x * r, direction.y * r, direction.z * r);
    }
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  // SphereGeometry duplicates seam and polar vertices for its UVs. Weld the
  // shading normals, while preserving UVs and the original shader appearance.
  const normals = geometry.getAttribute('normal');
  for (let iy = 1; iy < height; iy++) {
    const a = iy * (width + 1), b = a + width;
    direction.fromBufferAttribute(normals, a).add(new THREE.Vector3().fromBufferAttribute(normals, b)).normalize();
    normals.setXYZ(a, direction.x, direction.y, direction.z);
    normals.setXYZ(b, direction.x, direction.y, direction.z);
  }
  for (const iy of [0, height]) {
    direction.set(0, 0, 0);
    for (let ix = 0; ix <= width; ix++) direction.add(new THREE.Vector3().fromBufferAttribute(normals, iy * (width + 1) + ix));
    direction.normalize();
    for (let ix = 0; ix <= width; ix++) normals.setXYZ(iy * (width + 1) + ix, direction.x, direction.y, direction.z);
  }
  normals.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // Store the inverse [A B C] matrix for every rendered triangle. Multiplying
  // by a radial direction yields nonnegative cone coordinates for its triangle;
  // their sum is 1 / the exact intersection radius. All coefficients derive
  // from the final Float32 positions, never from the analytic terrain function.
  const indices = geometry.index.array, vertices = position.array;
  const inverse = new Float64Array(indices.length * 3);
  const cells = new Int32Array(width * height * 2).fill(-1);
  let face = 0;
  for (let iy = 0; iy < height; iy++) for (let ix = 0; ix < width; ix++) {
    for (let half = 0; half < 2; half++) {
      if ((iy === 0 && half === 0) || (iy === height - 1 && half === 1)) continue;
      cells[(iy * width + ix) * 2 + half] = face;
      const ia = indices[face * 3] * 3, ib = indices[face * 3 + 1] * 3, ic = indices[face * 3 + 2] * 3;
      const ax = vertices[ia], ay = vertices[ia + 1], az = vertices[ia + 2];
      const bx = vertices[ib], by = vertices[ib + 1], bz = vertices[ib + 2];
      const cx = vertices[ic], cy = vertices[ic + 1], cz = vertices[ic + 2];
      const bcX = by * cz - bz * cy, bcY = bz * cx - bx * cz, bcZ = bx * cy - by * cx;
      const determinant = ax * bcX + ay * bcY + az * bcZ;
      const o = face * 9, reciprocal = 1 / determinant;
      inverse[o] = bcX * reciprocal; inverse[o + 1] = bcY * reciprocal; inverse[o + 2] = bcZ * reciprocal;
      inverse[o + 3] = (cy * az - cz * ay) * reciprocal; inverse[o + 4] = (cz * ax - cx * az) * reciprocal; inverse[o + 5] = (cx * ay - cy * ax) * reciprocal;
      inverse[o + 6] = (ay * bz - az * by) * reciprocal; inverse[o + 7] = (az * bx - ax * bz) * reciprocal; inverse[o + 8] = (ax * by - ay * bx) * reciprocal;
      face++;
    }
  }
  const coneTolerance = 1e-9 / radius;
  const lookupCell = (ix, iy, u) => {
    if (iy < 0 || iy >= height) return null;
    ix = (ix + width) % width;
    const cell = (iy * width + ix) * 2;
    for (let half = 0; half < 2; half++) {
      const face = cells[cell + half];
      if (face < 0) continue;
      const o = face * 9;
      const a = inverse[o] * u.x + inverse[o + 1] * u.y + inverse[o + 2] * u.z;
      const b = inverse[o + 3] * u.x + inverse[o + 4] * u.y + inverse[o + 5] * u.z;
      const c = inverse[o + 6] * u.x + inverse[o + 7] * u.y + inverse[o + 8] * u.z;
      if (a >= -coneTolerance && b >= -coneTolerance && c >= -coneTolerance && a + b + c > 0) return { radius: 1 / (a + b + c), face };
    }
    return null;
  };
  const sampleDirection = u => {
    let phi = Math.atan2(u.z, -u.x);
    if (phi < 0) phi += TAU;
    const ix = Math.min(width - 1, Math.floor(phi / TAU * width));
    const iy = Math.min(height - 1, Math.floor(Math.acos(clamp(u.y, -1, 1)) / Math.PI * height));
    let sample = lookupCell(ix, iy, u);
    if (sample) return sample;
    // Spherical triangle edges are great-circle chords, not latitude lines:
    // the exact containing face can live in the neighboring latitude band.
    for (let ring = 1; ring <= 2; ring++) {
      for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        sample = lookupCell(ix + dx, iy + dy, u);
        if (sample) return sample;
      }
    }
    // A valid finite direction on this closed radial mesh must be found above.
    // Fail visibly if the topology is edited rather than silently floating feet.
    throw new Error('Spherical terrain radial triangle lookup failed');
  };
  const normalAt = worldPoint => finiteDirection(new THREE.Vector3().subVectors(worldPoint, center), siteUp);
  const radiusAt = unitDirection => sampleDirection(finiteDirection(unitDirection, siteUp)).radius;
  const altitudeAt = worldPoint => new THREE.Vector3().subVectors(worldPoint, center).length() - radiusAt(normalAt(worldPoint));
  const groundAt = (worldPoint, clearance = 0) => {
    const up = normalAt(worldPoint);
    return center.clone().addScaledVector(up, radiusAt(up) + clearance);
  };
  const surfaceNormalAt = worldPoint => {
    const sample = sampleDirection(normalAt(worldPoint)), o = sample.face * 9;
    return new THREE.Vector3(inverse[o] + inverse[o + 3] + inverse[o + 6], inverse[o + 1] + inverse[o + 4] + inverse[o + 7], inverse[o + 2] + inverse[o + 5] + inverse[o + 8]).normalize();
  };
  const frameAt = (worldPoint, forwardHint = DEFAULT_FORWARD) => tangentFrame(normalAt(worldPoint), forwardHint);
  const patchPoint = (x, z, clearance = 0) => {
    const distance = Math.hypot(x, z), angle = distance / radius;
    const up = siteUp.clone().multiplyScalar(Math.cos(angle));
    if (distance > 1e-12) up.addScaledVector(siteRight, Math.sin(angle) * x / distance).addScaledVector(siteForward, -Math.sin(angle) * z / distance);
    up.normalize();
    return center.clone().addScaledVector(up, radiusAt(up) + clearance);
  };
  const patchCoordinates = worldPoint => {
    const up = normalAt(worldPoint), cosine = clamp(up.dot(siteUp), -1, 1);
    const tangent = up.clone().addScaledVector(siteUp, -cosine), sine = tangent.length();
    if (sine < 1e-12) return { x: cosine >= 0 ? 0 : Math.PI * radius, z: 0 };
    const scale = Math.atan2(sine, cosine) * radius / sine;
    return { x: tangent.dot(siteRight) * scale, z: -tangent.dot(siteForward) * scale };
  };
  return { spec, center, radius, geometry, siteUp, siteForward, siteRight, normalAt, surfaceNormalAt, radiusAt, altitudeAt, groundAt, frameAt, patchPoint, patchCoordinates };
}
