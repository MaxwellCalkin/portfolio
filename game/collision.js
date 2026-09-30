import { Vector3 } from 'three';

const EPSILON = 1e-8;
const SKIN = 1e-4;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** Samples the same two triangles as Three's indexed PlaneGeometry, including its diagonal. */
export function createTerrainSampler(geometry) {
  const positions = geometry.attributes.position;
  const columns = geometry.parameters.widthSegments;
  const rows = geometry.parameters.heightSegments;
  const stride = columns + 1;
  const minX = positions.getX(0), minZ = positions.getZ(0);
  const cellX = (positions.getX(columns) - minX) / columns;
  const cellZ = (positions.getZ(rows * stride) - minZ) / rows;
  function sample(x, z) {
    const gridX = clamp((x - minX) / cellX, 0, columns);
    const gridZ = clamp((z - minZ) / cellZ, 0, rows);
    const column = Math.min(columns - 1, Math.floor(gridX));
    const row = Math.min(rows - 1, Math.floor(gridZ));
    const u = gridX - column, v = gridZ - row, i = row * stride + column;
    const a = positions.getY(i), b = positions.getY(i + 1);
    const c = positions.getY(i + stride), d = positions.getY(i + stride + 1);
    if (u + v <= 1) return { height: a + u * (b - a) + v * (c - a), slopeX: (b - a) / cellX, slopeZ: (c - a) / cellZ };
    return { height: d + (1 - u) * (c - d) + (1 - v) * (b - d), slopeX: (d - c) / cellX, slopeZ: (d - b) / cellZ };
  }
  return { sample, heightAt: (x, z) => sample(x, z).height };
}

function convexHull(points) {
  const sorted = points.sort((a, b) => a.x - b.x || a.z - b.z)
    .filter((p, i, all) => !i || p.x !== all[i - 1].x || p.z !== all[i - 1].z);
  if (sorted.length < 3) return sorted;
  const cross = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const lower = [], upper = [];
  for (const p of sorted) { while (lower.length > 1 && cross(lower.at(-2), lower.at(-1), p) <= EPSILON) lower.pop(); lower.push(p); }
  for (let i = sorted.length - 1; i >= 0; i--) { const p = sorted[i]; while (upper.length > 1 && cross(upper.at(-2), upper.at(-1), p) <= EPSILON) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Project the actual visible mesh into a tight convex footprint at character-body height. */
export function createMeshFootprint(geometry, matrix, minY = -Infinity, maxY = Infinity) {
  const vertices = [], positions = geometry.attributes.position, indices = geometry.index;
  const transformed = Array.from({ length: positions.count }, (_, i) => new Vector3().fromBufferAttribute(positions, i).applyMatrix4(matrix));
  function clip(polygon, height, keepAbove) {
    if (!Number.isFinite(height)) return polygon;
    const output = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const insideA = keepAbove ? a.y >= height : a.y <= height;
      const insideB = keepAbove ? b.y >= height : b.y <= height;
      if (insideA) output.push(a);
      if (insideA !== insideB) output.push(a.clone().lerp(b, (height - a.y) / (b.y - a.y)));
    }
    return output;
  }
  const count = indices ? indices.count : positions.count;
  for (let i = 0; i < count; i += 3) {
    let triangle = [0, 1, 2].map(j => transformed[indices ? indices.getX(i + j) : i + j]);
    triangle = clip(clip(triangle, minY, true), maxY, false);
    for (const p of triangle) vertices.push({ x: p.x, z: p.z });
  }
  const points = convexHull(vertices);
  return points.length >= 3 ? { type: 'polygon', points } : null;
}

function closestOnSegment(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, lengthSq = dx * dx + dz * dz;
  const t = lengthSq > EPSILON ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq, 0, 1) : 0;
  return { x: a.x + dx * t, z: a.z + dz * t };
}

function sweepCircle(p, d, center, radius) {
  const x = p.x - center.x, z = p.z - center.z;
  const a = d.x * d.x + d.z * d.z, b = x * d.x + z * d.z;
  if (a < EPSILON || b >= 0) return null;
  const c = x * x + z * z - radius * radius;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const t = Math.max(0, (-b - Math.sqrt(discriminant)) / a);
  if (t > 1) return null;
  const nx = x + d.x * t, nz = z + d.z * t, length = Math.hypot(nx, nz);
  if (length < EPSILON || d.x * nx + d.z * nz >= -EPSILON) return null; // A tangent is not an obstruction.
  return { t, nx: nx / length, nz: nz / length };
}

function earliest(a, b) { return b && (!a || b.t < a.t) ? b : a; }

function sweepCapsule(p, d, a, b, radius) {
  let hit = earliest(sweepCircle(p, d, a, radius), sweepCircle(p, d, b, radius));
  const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
  if (length < EPSILON) return hit;
  const tx = dx / length, tz = dz / length, nx = -tz, nz = tx;
  const distance = (p.x - a.x) * nx + (p.z - a.z) * nz;
  const speed = d.x * nx + d.z * nz;
  for (const sign of [-1, 1]) {
    if (speed * sign >= -EPSILON) continue;
    const t = (sign * radius - distance) / speed;
    if (t < -EPSILON || t > 1) continue;
    const along = (p.x + d.x * t - a.x) * tx + (p.z + d.z * t - a.z) * tz;
    if (along >= 0 && along <= length) hit = earliest(hit, { t: Math.max(0, t), nx: nx * sign, nz: nz * sign });
  }
  return hit;
}

function sweepShape(p, d, shape, radius) {
  if (shape.type === 'circle') return sweepCircle(p, d, shape, radius + shape.radius);
  if (shape.type === 'capsule') return sweepCapsule(p, d, shape.a, shape.b, radius + shape.radius);
  let hit = null;
  for (let i = 0; i < shape.points.length; i++) hit = earliest(hit, sweepCapsule(p, d, shape.points[i], shape.points[(i + 1) % shape.points.length], radius));
  return hit;
}

function penetration(p, shape, radius) {
  if (shape.type === 'circle' || shape.type === 'capsule') {
    const q = shape.type === 'circle' ? shape : closestOnSegment(p, shape.a, shape.b);
    const dx = p.x - q.x, dz = p.z - q.z, distance = Math.hypot(dx, dz), total = radius + shape.radius;
    if (distance >= total - EPSILON) return null;
    return { nx: distance > EPSILON ? dx / distance : 1, nz: distance > EPSILON ? dz / distance : 0, depth: total - distance };
  }
  let inside = true, near = null, distanceSq = Infinity, insideNormal = null, nearestPlane = -Infinity;
  for (let i = 0; i < shape.points.length; i++) {
    const a = shape.points[i], b = shape.points[(i + 1) % shape.points.length];
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz), nx = dz / length, nz = -dx / length;
    const signed = (p.x - a.x) * nx + (p.z - a.z) * nz;
    if (signed > EPSILON) inside = false;
    if (signed > nearestPlane) { nearestPlane = signed; insideNormal = { nx, nz }; }
    const q = closestOnSegment(p, a, b), sq = (p.x - q.x) ** 2 + (p.z - q.z) ** 2;
    if (sq < distanceSq) { distanceSq = sq; near = q; }
  }
  if (inside) return { ...insideNormal, depth: radius - nearestPlane };
  const distance = Math.sqrt(distanceSq);
  if (distance >= radius - EPSILON || distance < EPSILON) return null;
  return { nx: (p.x - near.x) / distance, nz: (p.z - near.z) / distance, depth: radius - distance };
}

function normalizeShape(input) {
  let shape = { ...input };
  if (shape.type === 'box') {
    const c = Math.cos(shape.rotation || 0), s = Math.sin(shape.rotation || 0);
    // Three.js rotates local +X toward -Z for a positive Y rotation.
    shape = { ...shape, type: 'polygon', points: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => ({
      x: shape.x + x * shape.halfX * c + z * shape.halfZ * s,
      z: shape.z - x * shape.halfX * s + z * shape.halfZ * c,
    })) };
  }
  if (shape.type === 'polygon') shape.points = convexHull(shape.points.map(p => ({ x: p.x ?? p[0], z: p.z ?? p[1] })));
  if (shape.type === 'capsule') { shape.a = { x: shape.ax, z: shape.az }; shape.b = { x: shape.bx, z: shape.bz }; }
  let points, pad = 0;
  if (shape.type === 'circle') { points = [shape]; pad = shape.radius; }
  else if (shape.type === 'capsule') { points = [shape.a, shape.b]; pad = shape.radius; }
  else if (shape.type === 'polygon' && shape.points.length >= 3) points = shape.points;
  else throw new TypeError('Expected a circle, capsule, box, or convex polygon collider');
  shape.bounds = { minX: Math.min(...points.map(p => p.x)) - pad, maxX: Math.max(...points.map(p => p.x)) + pad,
    minZ: Math.min(...points.map(p => p.z)) - pad, maxZ: Math.max(...points.map(p => p.z)) + pad };
  return shape;
}

/** Grounded capsule controller: continuous obstacle sweeps, contour/wall sliding, and bounded terrain steps. */
export function createCollisionWorld({ heightAt = () => 0, sampleTerrain, bounds = { minX: -155, maxX: 155, minZ: -155, maxZ: 155 }, maxSlope = Math.PI / 4, maxStep = .45, cellSize = 12 } = {}) {
  const colliders = new Map(), buckets = new Map();
  let nextId = 0;
  const slopeLimit = Math.tan(maxSlope);
  const sample = sampleTerrain || ((x, z) => ({ height: heightAt(x, z), slopeX: (heightAt(x + .02, z) - heightAt(x - .02, z)) / .04, slopeZ: (heightAt(x, z + .02) - heightAt(x, z - .02)) / .04 }));
  function keysFor(b) {
    const keys = [];
    for (let x = Math.floor(b.minX / cellSize); x <= Math.floor(b.maxX / cellSize); x++)
      for (let z = Math.floor(b.minZ / cellSize); z <= Math.floor(b.maxZ / cellSize); z++) keys.push(`${x}:${z}`);
    return keys;
  }
  function addCollider(input) {
    if (!input) return null;
    const shape = normalizeShape(input), b = shape.bounds;
    if (bounds && (b.maxX < bounds.minX || b.minX > bounds.maxX || b.maxZ < bounds.minZ || b.minZ > bounds.maxZ)) return null;
    const id = input.id ?? `collider-${++nextId}`;
    removeCollider(id);
    shape.id = id; shape.keys = keysFor(b); colliders.set(id, shape);
    for (const key of shape.keys) { if (!buckets.has(key)) buckets.set(key, new Set()); buckets.get(key).add(shape); }
    return id;
  }
  function removeCollider(id) {
    const shape = colliders.get(id);
    if (!shape) return;
    for (const key of shape.keys) { const bucket = buckets.get(key); bucket.delete(shape); if (!bucket.size) buckets.delete(key); }
    colliders.delete(id);
  }
  function query(p, d, radius) {
    const found = new Set(), b = { minX: Math.min(p.x, p.x + d.x) - radius, maxX: Math.max(p.x, p.x + d.x) + radius,
      minZ: Math.min(p.z, p.z + d.z) - radius, maxZ: Math.max(p.z, p.z + d.z) + radius };
    for (const key of keysFor(b)) for (const shape of buckets.get(key) || []) found.add(shape);
    return found;
  }
  function keepInBounds(p, radius) {
    if (bounds) { p.x = clamp(p.x, bounds.minX + radius, bounds.maxX - radius); p.z = clamp(p.z, bounds.minZ + radius, bounds.maxZ - radius); }
  }
  function unstick(p, radius) {
    for (let i = 0; i < 10; i++) {
      let corrected = false;
      keepInBounds(p, radius);
      for (const shape of query(p, { x: 0, z: 0 }, radius)) {
        const overlap = penetration(p, shape, radius);
        if (overlap) { p.x += overlap.nx * (overlap.depth + SKIN); p.z += overlap.nz * (overlap.depth + SKIN); corrected = true; }
      }
      if (!corrected) break;
    }
    keepInBounds(p, radius);
  }
  function sweepBounds(p, d, radius) {
    let hit = null;
    if (!bounds) return hit;
    for (const [axis, low, high] of [['x', bounds.minX + radius, bounds.maxX - radius], ['z', bounds.minZ + radius, bounds.maxZ - radius]]) {
      if (Math.abs(d[axis]) < EPSILON) continue;
      const side = d[axis] > 0 ? high : low, t = (side - p[axis]) / d[axis];
      if (t >= 0 && t <= 1) hit = earliest(hit, { t, nx: axis === 'x' ? -Math.sign(d.x) : 0, nz: axis === 'z' ? -Math.sign(d.z) : 0 });
    }
    return hit;
  }
  function moveHorizontal(start, delta, radius) {
    const p = { x: start.x, z: start.z }, d = { x: delta.x, z: delta.z };
    for (let pass = 0; pass < 8 && Math.hypot(d.x, d.z) > EPSILON; pass++) {
      let hit = sweepBounds(p, d, radius);
      for (const shape of query(p, d, radius)) hit = earliest(hit, sweepShape(p, d, shape, radius));
      if (!hit) { p.x += d.x; p.z += d.z; break; }
      p.x += d.x * hit.t + hit.nx * SKIN; p.z += d.z * hit.t + hit.nz * SKIN;
      d.x *= 1 - hit.t; d.z *= 1 - hit.t;
      const into = d.x * hit.nx + d.z * hit.nz;
      if (into < 0) { d.x -= hit.nx * into; d.z -= hit.nz * into; }
    }
    keepInBounds(p, radius);
    return p;
  }
  function terrainBlock(start, end) {
    const from = sample(start.x, start.z), length = Math.hypot(end.x - start.x, end.z - start.z);
    if (length < EPSILON) return null;
    for (const t of [.5, 1]) {
      const at = sample(start.x + (end.x - start.x) * t, start.z + (end.z - start.z) * t);
      const rise = at.height - from.height, slope = Math.hypot(at.slopeX, at.slopeZ);
      if (Math.abs(rise) > maxStep || (slope > slopeLimit + EPSILON && Math.abs(rise) > length * t * .025 + EPSILON)) {
        // Project along the contour. At a discontinuity use the direction of travel instead.
        const normalLength = slope > EPSILON ? slope : length;
        return { nx: slope > EPSILON ? at.slopeX / normalLength : (end.x - start.x) / normalLength,
          nz: slope > EPSILON ? at.slopeZ / normalLength : (end.z - start.z) / normalLength };
      }
    }
    return null;
  }
  function resolveMovement(start, delta, radius = .6) {
    if (![start.x, start.z, delta.x, delta.z, radius].every(Number.isFinite) || radius <= 0) throw new TypeError('Movement and radius must be finite; radius must be positive');
    const p = { x: start.x, z: start.z };
    unstick(p, radius);
    // Terrain checks are kept shorter than the capsule radius. Static geometry uses a true sweep,
    // so even a complete 14-unit dash in one frame cannot cross thin stems or arch posts.
    const steps = Math.max(1, Math.ceil(Math.hypot(delta.x, delta.z) / Math.min(.25, radius * .4)));
    const step = { x: delta.x / steps, z: delta.z / steps };
    for (let i = 0; i < steps; i++) {
      let target = moveHorizontal(p, step, radius);
      const block = terrainBlock(p, target);
      if (block) {
        let low = 0, high = 1;
        for (let n = 0; n < 12; n++) {
          const t = (low + high) / 2;
          const candidate = { x: p.x + (target.x - p.x) * t, z: p.z + (target.z - p.z) * t };
          if (terrainBlock(p, candidate)) high = t; else low = t;
        }
        const safe = { x: p.x + (target.x - p.x) * low, z: p.z + (target.z - p.z) * low };
        const remainder = { x: target.x - safe.x, z: target.z - safe.z };
        const amount = remainder.x * block.nx + remainder.z * block.nz;
        remainder.x -= block.nx * amount; remainder.z -= block.nz * amount;
        target = moveHorizontal(safe, remainder, radius);
        if (terrainBlock(safe, target)) target = safe;
      }
      p.x = target.x; p.z = target.z;
    }
    return new Vector3(p.x, heightAt(p.x, p.z), p.z);
  }
  return { resolveMovement, addCollider, removeCollider, colliders };
}
