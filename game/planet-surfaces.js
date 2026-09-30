import * as THREE from 'three';
import { createSphericalTerrain } from './spherical-terrain.js';
import { createSurfaceStreaming } from './surface-streaming.js';

const TAU = Math.PI * 2, EPSILON = 1e-8, SKIN = .002;
const UP = new THREE.Vector3(0, 1, 0);
const clamp = THREE.MathUtils.clamp;
const vector = value => value?.isVector3 ? value.clone() : new THREE.Vector3(value?.x ?? value?.[0] ?? 0, value?.y ?? value?.[1] ?? 0, value?.z ?? value?.[2] ?? 0);
function random(seed) { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function closestSegments(p1, q1, p2, q2) {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.lengthSq(), e = d2.lengthSq(), f = d2.dot(r);
  let s = 0, t = 0;
  if (a <= EPSILON && e <= EPSILON) return { p: p1.clone(), q: p2.clone() };
  if (a <= EPSILON) t = clamp(f / e, 0, 1);
  else {
    const c = d1.dot(r);
    if (e <= EPSILON) s = clamp(-c / a, 0, 1);
    else { const b = d1.dot(d2), denominator = a * e - b * b; s = denominator > EPSILON ? clamp((b * f - c * e) / denominator, 0, 1) : 0; t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  return { p: p1.clone().addScaledVector(d1, s), q: p2.clone().addScaledVector(d2, t) };
}
function closestTriangleSegment(a, b, shape) {
  const direction = b.clone().sub(a), length = direction.length();
  if (length > EPSILON) {
    const hit = new THREE.Ray(a, direction.divideScalar(length)).intersectTriangle(shape.a, shape.b, shape.c, false, new THREE.Vector3());
    if (hit && hit.distanceToSquared(a) <= length * length) return { p: hit, q: hit.clone() };
  }
  let best = { p: a.clone(), q: shape.triangle.closestPointToPoint(a, new THREE.Vector3()) };
  let square = best.p.distanceToSquared(best.q);
  const end = shape.triangle.closestPointToPoint(b, new THREE.Vector3()), endSquare = b.distanceToSquared(end);
  if (endSquare < square) { best = { p: b.clone(), q: end }; square = endSquare; }
  for (const [u, v] of [[shape.a, shape.b], [shape.b, shape.c], [shape.c, shape.a]]) {
    const pair = closestSegments(a, b, u, v), candidate = pair.p.distanceToSquared(pair.q);
    if (candidate < square) { best = pair; square = candidate; }
  }
  return best;
}
function separation(a, b, shape, radius) {
  const pair = shape.type === 'triangle' ? closestTriangleSegment(a, b, shape) : closestSegments(a, b, shape.a, shape.b);
  const normal = pair.p.clone().sub(pair.q), length = normal.length();
  return { distance: length - radius - shape.radius, normal: length > EPSILON ? normal.divideScalar(length) : null };
}

/** Continuous capsule sweeps in world coordinates. No chart edges, teleport, or flat-origin reset. */
export function createSphericalCollisionWorld(terrain) {
  const colliders = new Map(); let nextId = 0;
  function addCollider(input) {
    if (!input) return null;
    const id = input.id ?? `radial-${++nextId}`, radius = Math.max(0, Number(input.radius ?? 0));
    if (!Number.isFinite(radius)) throw new TypeError('Collider radius must be finite');
    const shape = { ...input, id, radius, a: vector(input.a ?? input.position), b: vector(input.b ?? input.a ?? input.position) };
    if (input.c) { shape.type = 'triangle'; shape.c = vector(input.c); shape.triangle = new THREE.Triangle(shape.a, shape.b, shape.c); }
    else shape.type = shape.a.equals(shape.b) ? 'sphere' : 'capsule';
    const points = shape.c ? [shape.a, shape.b, shape.c] : [shape.a, shape.b];
    shape.bounds = new THREE.Box3().setFromPoints(points).expandByScalar(radius);
    colliders.set(id, shape); return id;
  }
  const removeCollider = id => colliders.delete(id);
  function axis(feet, radius) { const up = terrain.normalAt(feet); return { up, a: feet.clone().addScaledVector(up, radius), b: feet.clone().addScaledVector(up, Math.max(radius, 2.5 - radius)) }; }
  function candidates(a, b, d, radius) {
    const bounds = new THREE.Box3().setFromPoints([a, b, a.clone().add(d), b.clone().add(d)]).expandByScalar(radius + .03);
    const found = []; for (const shape of colliders.values()) if (bounds.intersectsBox(shape.bounds)) found.push(shape); return found;
  }
  function sweep(a, b, d, shape, radius) {
    const speed = d.length(); if (speed < EPSILON) return null;
    let t = 0;
    for (let step = 0; step < 36 && t <= 1; step++) {
      const result = separation(a.clone().addScaledVector(d, t), b.clone().addScaledVector(d, t), shape, radius);
      if (result.distance <= SKIN * .2) {
        const normal = result.normal ?? (shape.triangle ? shape.triangle.getNormal(new THREE.Vector3()) : d.clone().negate().normalize());
        if (d.dot(normal) >= -1e-7) return null;
        return { t: Math.max(0, t), normal };
      }
      t += Math.max(1e-7, result.distance / speed);
    }
    return null;
  }
  function unstick(feet, radius) {
    for (let iteration = 0; iteration < 10; iteration++) {
      const body = axis(feet, radius); let moved = false;
      for (const shape of candidates(body.a, body.b, new THREE.Vector3(), radius)) {
        const hit = separation(body.a, body.b, shape, radius);
        if (hit.distance >= -SKIN) continue;
        const normal = hit.normal ?? terrain.frameAt(feet).right;
        normal.addScaledVector(body.up, -normal.dot(body.up));
        if (normal.lengthSq() < .001) continue; // An overhead/underfoot surface is not a lateral wall.
        feet.addScaledVector(normal.normalize(), -hit.distance + SKIN); feet.copy(terrain.groundAt(feet)); moved = true;
      }
      if (!moved) break;
    }
  }
  function resolveMovement(worldPosition, displacement, radius = .6) {
    if (![worldPosition.x, worldPosition.y, worldPosition.z, displacement.x, displacement.y, displacement.z, radius].every(Number.isFinite) || radius <= 0) throw new TypeError('Movement and radius must be finite, with a positive radius');
    const feet = terrain.groundAt(worldPosition); unstick(feet, radius);
    // Only curvature is subdivided. Every obstacle test remains a continuous sweep.
    const up = terrain.normalAt(feet), motion = vector(displacement).addScaledVector(up, -displacement.dot(up));
    const length = motion.length(), steps = Math.max(1, Math.ceil(length / 1.5));
    const direction = length > EPSILON ? motion.divideScalar(length) : terrain.frameAt(feet).forward;
    const stride = length / steps;
    for (let step = 0; step < steps; step++) {
      const currentUp = terrain.normalAt(feet);
      direction.addScaledVector(currentUp, -direction.dot(currentUp)).normalize();
      const delta = direction.clone().multiplyScalar(stride);
      for (let pass = 0; pass < 7 && delta.lengthSq() > EPSILON; pass++) {
        const body = axis(feet, radius), end = terrain.groundAt(feet.clone().add(delta));
        const actual = end.clone().sub(feet); let hit = null;
        for (const shape of candidates(body.a, body.b, actual, radius)) { const candidate = sweep(body.a, body.b, actual, shape, radius); if (candidate && (!hit || candidate.t < hit.t)) hit = candidate; }
        if (!hit) { feet.copy(end); break; }
        feet.addScaledVector(actual, Math.max(0, hit.t - SKIN / Math.max(actual.length(), SKIN)));
        feet.copy(terrain.groundAt(feet)); delta.copy(actual).multiplyScalar(1 - hit.t);
        const tangentNormal = hit.normal.clone().addScaledVector(body.up, -hit.normal.dot(body.up));
        if (tangentNormal.lengthSq() < .0001) break;
        tangentNormal.normalize(); const inward = delta.dot(tangentNormal);
        if (inward < 0) delta.addScaledVector(tangentNormal, -inward);
        delta.addScaledVector(body.up, -delta.dot(body.up));
      }
    }
    unstick(feet, radius); return feet;
  }
  return { colliders, addCollider, removeCollider, resolveMovement };
}

const THEMES = [
  { rock: '#344f4e', flora: '#a6e6c3', dust: '#a7b0a0' }, { rock: '#623d37', flora: '#e6bca0', dust: '#cba28b' },
  { rock: '#494659', flora: '#c4a7fa', dust: '#b0a4c2' }, { rock: '#344f61', flora: '#a0d9ec', dust: '#a1b8c2' },
  { rock: '#605946', flora: '#ffe6a0', dust: '#c9bd95' },
];
const standard = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: .75, metalness: .15, ...extra });
function mesh(geometry, material, parent, x = 0, y = 0, z = 0) { const item = new THREE.Mesh(geometry, material); item.position.set(x, y, z); parent.add(item); return item; }
function radialGroup(terrain, parent, x, z, name, yaw = 0) {
  const group = new THREE.Group(); group.name = name; group.position.copy(terrain.patchPoint(x, z));
  group.quaternion.copy(terrain.frameAt(group.position).quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
  group.userData.radialAnchor = true; parent.add(group); return group;
}
function addLocalCapsule(collision, group, a, b, radius, kind) {
  group.updateWorldMatrix(true, false);
  return collision.addCollider({ a: vector(a).applyMatrix4(group.matrixWorld), b: vector(b).applyMatrix4(group.matrixWorld), radius, kind });
}
function surfaceFor(planet, index) {
  const spec = planet.spec ?? planet, terrain = createSphericalTerrain(spec, index), collision = createSphericalCollisionWorld(terrain);
  const group = new THREE.Group(); group.name = `planet-surface-${spec.id}`; group.userData.persistent = true;
  // Decoration vertices are already in the shared solar-world coordinate system.
  planet.group?.parent?.add(group);
  if (planet.mesh) { const old = planet.mesh.geometry; planet.mesh.geometry = terrain.geometry; planet.mesh.rotation.set(0, 0, 0); old?.dispose(); }
  const theme = THEMES[index % THEMES.length], rnd = random(1384 + index * 71);
  const rockMat = standard(theme.rock, { flatShading: true }), floraMat = standard(theme.flora, { emissive: theme.flora, emissiveIntensity: .13, roughness: .43, metalness: .35, flatShading: true });
  const structureMat = standard('#253d43', { roughness: .76, metalness: .34 });
  const trim = standard(spec.color, { emissive: spec.color, emissiveIntensity: .5, metalness: .4 });
  for (const [x, z, scale, yaw] of [[-38, -55, 1.15, -.24], [58, -72, 1.6, .53]]) {
    const ruin = radialGroup(terrain, group, x, z, 'radial-observatory-arch', yaw);
    const shape = new THREE.Shape(); shape.moveTo(-5, 0); shape.lineTo(-5, 12); shape.quadraticCurveTo(0, 17, 5, 12); shape.lineTo(5, 0); shape.lineTo(3.75, 0); shape.lineTo(3.75, 10.6); shape.quadraticCurveTo(0, 14.3, -3.75, 10.6); shape.lineTo(-3.75, 0); shape.closePath();
    const arch = mesh(new THREE.ExtrudeGeometry(shape, { depth: 1.25, bevelEnabled: true, bevelSegments: 1, bevelSize: .12, bevelThickness: .12 }), structureMat, ruin); arch.scale.setScalar(scale);
    for (const sign of [-1, 1]) {
      mesh(new THREE.BoxGeometry(.075 * scale, 8.5 * scale, .05), trim, ruin, sign * 4.2 * scale, 5.5 * scale, -.16);
      addLocalCapsule(collision, ruin, [sign * 4.375 * scale, .5 * scale, .625 * scale], [sign * 4.375 * scale, 11.6 * scale, .625 * scale], .75 * scale, 'ruin-post');
    }
  }
  for (let i = 0; i < 5; i++) {
    const pillar = radialGroup(terrain, group, -65 + i * 10, -91 - (i % 2) * 9, 'radial-archive-pillar'), height = 7 + (i % 3) * 4;
    mesh(new THREE.CylinderGeometry(1.5, 1.7, height, 6), structureMat, pillar, 0, height / 2, 0);
    mesh(new THREE.BoxGeometry(.12, height * .72, .06), trim, pillar, -.6, height * .54, -1.4);
    addLocalCapsule(collision, pillar, [0, 1.55, 0], [0, height - 1.5, 0], 1.55, 'archive-pillar');
  }
  const beacon = radialGroup(terrain, group, 0, -12, 'radial-archive');
  mesh(new THREE.CylinderGeometry(3.4, 4.3, .65, 12), structureMat, beacon, 0, .2, 0);
  mesh(new THREE.CylinderGeometry(2.7, 3.15, .15, 48), trim, beacon, 0, .63, 0);
  // A shallow physical plinth, with its three visible uprights separately solid.
  for (let i = 0; i < 3; i++) {
    const angle = i * TAU / 3, x = Math.cos(angle) * 2.35, z = Math.sin(angle) * 2.35;
    mesh(new THREE.ConeGeometry(.43, 4.7, 4), structureMat, beacon, x, 2.55, z);
    addLocalCapsule(collision, beacon, [x, .5, z], [x, 4.2, z], .32, 'archive-post');
  }
  // Ring the actual broad shallow pedestal rather than a full-height invisible cylinder.
  for (let i = 0; i < 28; i++) { const angle = i * TAU / 28; addLocalCapsule(collision, beacon, [Math.cos(angle) * 3.65, .2, Math.sin(angle) * 3.65], [Math.cos(angle) * 3.65, .23, Math.sin(angle) * 3.65], .45, 'archive-base'); }
  const core = mesh(new THREE.OctahedronGeometry(.77), standard('#defaed', { emissive: spec.color, emissiveIntensity: 2.6, roughness: .22 }), beacon, 0, 2.45, 0);
  const halo = mesh(new THREE.TorusGeometry(1.35, .035, 6, 64), new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: .75 }), beacon, 0, 2.45, 0); halo.rotation.x = Math.PI / 2;
  mesh(new THREE.CylinderGeometry(.05, .2, 29, 12, 1, true), new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: .18, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }), beacon, 0, 16.8, 0);
  addLocalCapsule(collision, beacon, [0, 2.45, 0], [0, 2.45, 0], .6, 'archive-core');
  const padVertices = [], padIndices = [];
  for (let i = 0; i <= 96; i++) for (const radius of [8.9, 9.1]) { const angle = i / 96 * TAU; padVertices.push(...terrain.patchPoint(Math.cos(angle) * radius, 25 + Math.sin(angle) * radius, .065).toArray()); }
  for (let i = 0; i < 96; i++) { const j = i * 2; padIndices.push(j, j + 1, j + 3, j, j + 3, j + 2); }
  const padGeo = new THREE.BufferGeometry(); padGeo.setAttribute('position', new THREE.Float32BufferAttribute(padVertices, 3)); padGeo.setIndex(padIndices);
  const pad = mesh(padGeo, new THREE.MeshBasicMaterial({ color: theme.dust, transparent: true, opacity: .65, side: THREE.DoubleSide, depthWrite: false }), group); pad.name = 'conformal-landing-survey-ring';
  for (let i = 0; i < 4; i++) { const angle = i * Math.PI / 2, mark = radialGroup(terrain, group, Math.cos(angle) * 10, 25 + Math.sin(angle) * 10, 'radial-pad-marker', -angle); mesh(new THREE.BoxGeometry(.2, .04, 2), trim, mark, 0, .09, 0); }
  const motePositions = [];
  for (let i = 0; i < 64; i++) motePositions.push(...terrain.patchPoint((rnd() - .5) * 100, (rnd() - .5) * 100, 2 + rnd() * 12).toArray());
  const moteGeo = new THREE.BufferGeometry(); moteGeo.setAttribute('position', new THREE.Float32BufferAttribute(motePositions, 3));
  const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({ color: theme.flora, size: .075, transparent: true, opacity: .55, depthWrite: false })); group.add(motes);
  group.traverse(object => { if (object.isMesh) { object.castShadow = true; object.receiveShadow = true; } });
  const streaming = createSurfaceStreaming({ terrain, collision, group, index, theme, materials: { rockMat, floraMat, structureMat, trim } });
  streaming.update(0, 0, terrain.patchPoint(0, 15));
  function setParkedShip(ship) {
    for (const [id, collider] of collision.colliders) if (collider.kind === 'parked-ship') collision.removeCollider(id);
    if (!ship) return;
    ship.updateWorldMatrix(true, true);
    // Exact visible hull/wing triangles avoid oversized bounding spheres beside thin wings.
    ship.traverse(part => {
      if (!part.isMesh || part.userData.flame || !part.geometry?.attributes.position) return;
      for (let ancestor = part; ancestor; ancestor = ancestor.parent) if (!ancestor.visible) return;
      const geometry = part.geometry, positions = geometry.attributes.position, indices = geometry.index;
      const count = indices?.count ?? positions.count;
      for (let i = 0; i < count; i += 3) {
        const points = [0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(positions, indices ? indices.getX(i + j) : i + j).applyMatrix4(part.matrixWorld));
        if (new THREE.Triangle(...points).getArea() < 1e-8) continue;
        collision.addCollider({ a: points[0], b: points[1], c: points[2], radius: .025, kind: 'parked-ship' });
      }
    });
  }
  return { ...terrain, ...collision, group, beaconPosition: terrain.patchPoint(0, -12), spawn: terrain.patchPoint(0, 15), shipPosition: terrain.patchPoint(0, 25, 1.9), setParkedShip,
    worldCatalog: streaming.catalog, nearestShrine: streaming.catalog.nearestShrine, nearbySectors: streaming.catalog.nearbySectors,
    getStreamingStats: streaming.getStats,
    update(time, dt = 0, focusPosition) { streaming.update(time, dt, focusPosition); core.rotation.y = time * .4; core.rotation.z = Math.sin(time * .5) * .15; core.position.y = 2.45 + Math.sin(time * 1.5) * .16; halo.rotation.z = time * .3; halo.rotation.x = Math.PI / 2 + Math.sin(time * .4) * .25; motes.material.opacity = .5 + Math.sin(time * .4) * .1; },
    dispose() { streaming.dispose(); group.removeFromParent(); const geometries = new Set(), materials = new Set([rockMat, floraMat, structureMat, trim]); group.traverse(o => { if (o.geometry) geometries.add(o.geometry); if (o.material) materials.add(o.material); }); geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); collision.colliders.clear(); },
  };
}

/** Terrain stays persistent. Local scenery and physical archive duplicates stream over its exact mesh. */
export function createPlanetSurfaces(planets) { return new Map(planets.map((planet, index) => [planet.id ?? planet.spec.id, surfaceFor(planet, index)])); }
