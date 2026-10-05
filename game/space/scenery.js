import * as THREE from 'three';
import { mulberry32 } from '../world/noise.js';
import { createGlow, getGlowTexture } from '../world/space.js';
import { RIFTS } from './rifts.js';

/**
 * What the rifts look like: a dark core in a swirl of hot rings, ringed by a
 * debris field to fight among. The rocks are solid: the Aster bounces off
 * them, bolts spark on them, and the Static steers around them.
 */
const ROCKS = 200, CELL = 400, REACH = 3400; // a field's rocks all sit within REACH of the rift
const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler();
const cellKey = (x, y, z) => (Math.floor(x / CELL) + 512) * 1048576 + (Math.floor(y / CELL) + 512) * 1024 + (Math.floor(z / CELL) + 512);

/** A lumpy icosahedron shared by every rock (shared corners move together, so faces never crack). */
function rockGeometry() {
  const geometry = new THREE.IcosahedronGeometry(1, 1), pos = geometry.attributes.position, bumps = new Map(), random = mulberry32(77);
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i);
    const key = `${_v.x.toFixed(3)},${_v.y.toFixed(3)},${_v.z.toFixed(3)}`;
    if (!bumps.has(key)) bumps.set(key, 0.74 + random() * 0.42);
    _v.multiplyScalar(bumps.get(key));
    pos.setXYZ(i, _v.x, _v.y, _v.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function swirl(count, radius, color, seed) {
  const random = mulberry32(seed), data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = random() * Math.PI * 2, r = radius * (0.25 + random() * 0.75), y = (random() - 0.5) * radius * 0.35;
    data.set([Math.cos(a) * r, y, Math.sin(a) * r], i * 3);
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(data, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({ color, size: 26, map: getGlowTexture(), transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
}

class RiftView {
  constructor(rift, parent, rockGeo, rockMat) {
    this.rift = rift; this.state = 'open'; this.spin = 1;
    this.center = new THREE.Vector3(...rift.position);
    const root = this.root = new THREE.Group(); root.name = `rift-${rift.id}`; root.position.copy(this.center); parent.add(root);
    const hot = new THREE.Color(rift.color);
    root.add(new THREE.Mesh(new THREE.SphereGeometry(150, 32, 16), new THREE.MeshBasicMaterial({ color: '#050208' })));
    this.rim = createGlow(rift.color, 1150, 0.9); this.halo = createGlow(rift.color, 3400, 0.32);
    root.add(this.halo, this.rim);
    this.rings = [[250, 7, 0.3], [380, 5, -0.2], [560, 9, 0.12]].map(([radius, tube, speed], i) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 96), new THREE.MeshBasicMaterial({ color: hot.clone().multiplyScalar(i === 1 ? 2.4 : 1.6), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      ring.rotation.set(Math.PI / 2 + i * 0.45, i * 0.7, 0); ring.userData.speed = speed;
      root.add(ring); return ring;
    });
    this.sparks = swirl(260, 900, rift.color, rift.tier * 31); root.add(this.sparks);
    // The debris field: a thick ring of rocks around the rift, plus a few strays inside it.
    const random = mulberry32(rift.tier * 977), rocks = this.rocks = [];
    const field = new THREE.InstancedMesh(rockGeo, rockMat, ROCKS), tint = new THREE.Color();
    for (let i = 0; i < ROCKS; i++) {
      const a = random() * Math.PI * 2, inner = i < 24, ring = inner ? 650 + random() * 500 : 1250 + random() * 1450;
      const lift = (random() + random() - 1) * (inner ? 260 : 650);
      const radius = 7 + Math.pow(random(), 3) * 52;
      const center = new THREE.Vector3(Math.cos(a) * ring, lift, Math.sin(a) * ring).add(this.center);
      rocks.push({ center, radius });
      _e.set(random() * 6.3, random() * 6.3, random() * 6.3);
      _s.set(radius * (0.85 + random() * 0.3), radius * (0.8 + random() * 0.3), radius * (0.85 + random() * 0.3));
      field.setMatrixAt(i, _m.compose(center, _q.setFromEuler(_e), _s));
      field.setColorAt(i, tint.setHSL(0.78 + random() * 0.08, 0.08 + random() * 0.1, 0.32 + random() * 0.16));
    }
    field.frustumCulled = false; field.castShadow = false; field.receiveShadow = false;
    parent.add(field); this.field = field;
  }
  setState(state) {
    if (this.state === state) return;
    this.state = state;
    const color = new THREE.Color(state === 'silenced' ? this.rift.calm : this.rift.color);
    this.rim.material.color.copy(color); this.halo.material.color.copy(color); this.sparks.material.color.copy(color);
    this.rings.forEach((ring, i) => ring.material.color.copy(color).multiplyScalar(state === 'silenced' ? 0.8 : i === 1 ? 2.4 : 1.6));
    this.spin = state === 'active' ? 2.2 : state === 'silenced' ? 0.25 : 1;
  }
  update(time, dt) {
    for (const ring of this.rings) ring.rotation.z += ring.userData.speed * this.spin * dt;
    this.sparks.rotation.y += 0.05 * this.spin * dt;
    const beat = this.state === 'silenced' ? 0 : Math.sin(time * (this.state === 'active' ? 5 : 2)) * 0.08;
    this.rim.material.opacity = (this.state === 'silenced' ? 0.45 : 0.85) + beat;
    this.halo.material.opacity = this.state === 'silenced' ? 0.16 : 0.3 + beat * 0.6;
  }
}

export class SpaceScenery {
  constructor(scene) {
    this.group = new THREE.Group(); this.group.name = 'space-scenery'; scene.add(this.group);
    const rockGeo = rockGeometry(), rockMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, metalness: 0.06, flatShading: true, emissive: '#1c0c1a' });
    this.views = new Map(RIFTS.map(rift => [rift.id, new RiftView(rift, this.group, rockGeo, rockMat)]));
    this.grid = new Map();
    for (const view of this.views.values()) for (const rock of view.rocks) {
      const key = cellKey(rock.center.x, rock.center.y, rock.center.z);
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push(rock);
    }
  }
  setState(riftId, state) { this.views.get(riftId)?.setState(state); }
  update(time, dt) { for (const view of this.views.values()) view.update(time, dt); }

  /** Rocks whose centers are within one grid cell of `p` (enough for anything smaller than CELL). */
  *near(p) {
    if (!this.#inAnyField(p)) return;
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      const list = this.grid.get(cellKey(p.x + x * CELL, p.y + y * CELL, p.z + z * CELL));
      if (list) yield* list;
    }
  }
  #inAnyField(p) { for (const view of this.views.values()) if (view.center.distanceToSquared(p) < REACH * REACH) return true; return false; }

  /** The deepest rock a sphere overlaps: { rock, depth, normal } or null. */
  collide(position, radius) {
    let best = null;
    for (const rock of this.near(position)) {
      const d = position.distanceTo(rock.center), depth = rock.radius + radius - d;
      if (depth > 0 && (!best || depth > best.depth)) best = { rock, depth, normal: position.clone().sub(rock.center).divideScalar(d || 1) };
    }
    return best;
  }
  /** Where a short segment (one frame of a bolt) first enters a rock, or null. */
  segmentHit(start, end) {
    let best = null, bestD = Infinity;
    for (const rock of this.near(end)) {
      const d = end.distanceTo(rock.center);
      if (d < rock.radius && d < bestD) { bestD = d; best = rock; }
    }
    return best ? end.clone().sub(best.center).setLength(best.radius).add(best.center) : null;
  }
  /** Adds a push away from rocks within `range` to `out` (steering). */
  avoid(position, range, out) {
    for (const rock of this.near(position)) {
      _v.copy(position).sub(rock.center);
      const d = _v.length(), clear = rock.radius + range;
      if (d < clear && d > 1e-3) out.addScaledVector(_v, (clear - d) / clear / d);
    }
    return out;
  }
}
