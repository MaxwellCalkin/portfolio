import * as THREE from 'three';

/**
 * Simple, robust character collision on a spherical world.
 *
 * Colliders are vertical cylinders, oriented boxes (both with walkable tops)
 * and spheres, stored in a spatial hash. The player is a vertical capsule
 * (feet point + radius + height, "vertical" = the planet's radial up).
 * Resolution is positional (push-out) plus "stand on top" support, which is
 * all a third-person explorer needs and never tunnels at walking speeds
 * because movement is sub-stepped by the controller.
 */
const CELL = 24;
const STEP_UP = 0.5;

export class ColliderWorld {
  constructor() { this.cells = new Map(); this.all = new Map(); this.nextId = 1; }
  #key(x, y, z) { return `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`; }
  /** @returns {number} id */
  add(collider) {
    const id = this.nextId++;
    collider.id = id;
    const r = collider.bound, c = collider.center;
    const keys = [];
    for (let x = Math.floor((c.x - r) / CELL); x <= Math.floor((c.x + r) / CELL); x++)
      for (let y = Math.floor((c.y - r) / CELL); y <= Math.floor((c.y + r) / CELL); y++)
        for (let z = Math.floor((c.z - r) / CELL); z <= Math.floor((c.z + r) / CELL); z++) {
          const key = `${x},${y},${z}`; keys.push(key);
          if (!this.cells.has(key)) this.cells.set(key, new Set());
          this.cells.get(key).add(collider);
        }
    collider.keys = keys;
    this.all.set(id, collider);
    return id;
  }
  remove(id) {
    const collider = this.all.get(id); if (!collider) return;
    for (const key of collider.keys) this.cells.get(key)?.delete(collider);
    this.all.delete(id);
  }
  removeTagged(tag) { for (const [id, c] of [...this.all]) if (c.tag === tag) this.remove(id); }
  query(point, radius, out = []) {
    out.length = 0;
    const seen = new Set();
    for (let x = Math.floor((point.x - radius) / CELL); x <= Math.floor((point.x + radius) / CELL); x++)
      for (let y = Math.floor((point.y - radius) / CELL); y <= Math.floor((point.y + radius) / CELL); y++)
        for (let z = Math.floor((point.z - radius) / CELL); z <= Math.floor((point.z + radius) / CELL); z++) {
          const set = this.cells.get(`${x},${y},${z}`); if (!set) continue;
          for (const c of set) if (!seen.has(c) && c.enabled !== false) { seen.add(c); out.push(c); }
        }
    return out;
  }
}

/** Vertical cylinder: base center, unit axis (up), radius, height. */
export function cylinderCollider(base, axis, radius, height, tag) {
  return { type: 'cyl', base: base.clone(), axis: axis.clone().normalize(), radius, height, tag, center: base.clone().addScaledVector(axis, height / 2), bound: Math.hypot(radius, height / 2) };
}
/** Oriented box from a world matrix and a local-space Box3 (the mesh bounding box). */
export function boxColliderFromMesh(mesh, tag) {
  mesh.updateWorldMatrix(true, false);
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox, m = mesh.matrixWorld;
  const center = box.getCenter(new THREE.Vector3()).applyMatrix4(m);
  const ax = new THREE.Vector3(), ay = new THREE.Vector3(), az = new THREE.Vector3();
  m.extractBasis(ax, ay, az);
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  half.x *= ax.length(); half.y *= ay.length(); half.z *= az.length();
  ax.normalize(); ay.normalize(); az.normalize();
  return { type: 'box', center, axes: [ax, ay, az], half, tag, bound: half.length() };
}
export function cylinderColliderFromMesh(mesh, tag) {
  mesh.updateWorldMatrix(true, false);
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox, m = mesh.matrixWorld;
  const ax = new THREE.Vector3(), ay = new THREE.Vector3(), az = new THREE.Vector3();
  m.extractBasis(ax, ay, az);
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x * ax.length(), size.z * az.length()) / 2, height = size.y * ay.length();
  const bottom = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2).applyMatrix4(m);
  return cylinderCollider(bottom, ay.normalize(), radius, height, tag);
}
export function sphereCollider(center, radius, tag) { return { type: 'sph', center: center.clone(), radius, tag, bound: radius }; }

const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _l = new THREE.Vector3();

/**
 * Pushes a capsule (feet at `feet`, radial `up`) out of colliders.
 * Returns the highest walkable support height (meters above `feet` along up,
 * may be negative) that the feet are standing on or stepping onto, or null.
 */
export function resolveCapsule(feet, up, radius, height, colliders, falling) {
  let support = null;
  for (const c of colliders) {
    if (c.type === 'cyl') {
      _d.subVectors(feet, c.base);
      const h = _d.dot(c.axis);                     // feet height along the cylinder axis
      if (h > c.height + 0.05 || h + height < 0) continue; // fully above or below
      _d.addScaledVector(c.axis, -h);               // horizontal offset from the axis
      const dist = _d.length(), reach = c.radius + radius * 0.85;
      if (dist >= reach) continue;
      const top = c.height - h;                      // how far the top is above the feet
      if (top <= STEP_UP && (falling || top >= -0.05) && dist < c.radius + radius * 0.3) { support = Math.max(support ?? -Infinity, top); continue; }
      if (dist < 1e-5) _d.set(1, 0, 0).addScaledVector(up, -up.x).normalize(); else _d.divideScalar(dist);
      feet.addScaledVector(_d, reach - dist);
    } else if (c.type === 'box') {
      // Feet into box-local coordinates.
      _p.subVectors(feet, c.center);
      _l.set(_p.dot(c.axes[0]), _p.dot(c.axes[1]), _p.dot(c.axes[2]));
      const hy = c.half.y;
      if (_l.y > hy + 0.05 || _l.y + height < -hy) continue;
      const qx = Math.max(-c.half.x, Math.min(c.half.x, _l.x)), qz = Math.max(-c.half.z, Math.min(c.half.z, _l.z));
      const dx = _l.x - qx, dz = _l.z - qz, dist = Math.hypot(dx, dz);
      if (dist >= radius * 0.85) continue;
      const top = hy - _l.y;
      if (top <= STEP_UP && (falling || top >= -0.05)) { support = Math.max(support ?? -Infinity, top); continue; }
      if (dist > 1e-5) {
        const push = radius * 0.85 - dist;
        feet.addScaledVector(c.axes[0], dx / dist * push).addScaledVector(c.axes[2], dz / dist * push);
      } else {
        // Inside the footprint: exit through the nearest side.
        const ex = c.half.x - Math.abs(_l.x), ez = c.half.z - Math.abs(_l.z);
        if (ex < ez) feet.addScaledVector(c.axes[0], Math.sign(_l.x || 1) * (ex + radius * 0.85));
        else feet.addScaledVector(c.axes[2], Math.sign(_l.z || 1) * (ez + radius * 0.85));
      }
    } else if (c.type === 'sph') {
      const mid = _p.copy(feet).addScaledVector(up, Math.min(height * 0.5, Math.max(0, _d.subVectors(c.center, feet).dot(up))));
      _d.subVectors(mid, c.center); const dist = _d.length(), reach = c.radius + radius;
      if (dist >= reach || dist < 1e-5) continue;
      _d.divideScalar(dist).addScaledVector(up, -_d.dot(up));
      if (_d.lengthSq() < 1e-6) continue;
      feet.addScaledVector(_d.normalize(), reach - dist);
    }
  }
  return support;
}
