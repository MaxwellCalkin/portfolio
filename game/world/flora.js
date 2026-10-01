import * as THREE from 'three';
import { smoothstep } from './noise.js';
import { LAYOUTS } from './layout.js';
import { CELL_SIZE, STRIDE, cellOf, cellCenter, gridSize } from './flora-cells.js';

/**
 * Streamed, instanced vegetation and rocks.
 *
 * Deterministic cells (flora-cells.js) are generated in the world workers,
 * one layer at a time as the player comes within that layer's draw distance,
 * and cached. Visible instances are uploaded into one InstancedMesh per asset
 * primitive, positioned at a moving "stream origin" so Float32 instance
 * matrices stay precise tens of kilometers from the system origin.
 */

/* Per-world material colors (sRGB hex), by glTF material slot name. */
export const FLORA_COLORS = {
  philosophy: { Grass: '#5fc48c', Leaf: '#2f9e7c', LeafAlt: '#6fd3a6', Bark: '#5e4b3f', Rock: '#d9e3dc', RockDark: '#8aa39a', Petal: '#ffd38a', Crystal: '#9ff5dc', Glow: '#8cf0d1' },
  experience: { Grass: '#e3bd6b', Leaf: '#7d8f4a', LeafAlt: '#b38b4a', Bark: '#5a3b2e', Rock: '#c86e4c', RockDark: '#7a3f32', Petal: '#ff9a62', Crystal: '#ffb27a', Glow: '#ff9a62' },
  projects: { Grass: '#a68cec', Leaf: '#7f63d8', LeafAlt: '#c3a2ff', Bark: '#3d3557', Rock: '#5c5080', RockDark: '#3a3354', Petal: '#f0c2ff', Crystal: '#c9a6ff', Glow: '#e2b8ff' },
  mission: { Grass: '#5bb3a2', Leaf: '#2c7e88', LeafAlt: '#7cc9c0', Bark: '#4a5566', Rock: '#c3d4e6', RockDark: '#7590b1', Petal: '#9ff0ff', Crystal: '#a9f0ff', Glow: '#83e8ff' },
  contact: { Grass: '#d1b45e', Leaf: '#5f8f4a', LeafAlt: '#9fb85a', Bark: '#6e4a32', Rock: '#c27f52', RockDark: '#8c5233', Petal: '#ffd27a', Crystal: '#ffe3a0', Glow: '#ffd27a' },
};

/*
 * Layer recipes. density = instances per 1000 m² before filtering.
 * view = draw distance (m). veg = [min, max] vegetation suitability.
 * cluster = [noise frequency (per km), threshold] for forest/clump patches.
 * ground = tint from the terrain color under the instance (grass).
 */
const L = (asset, o) => ({ asset, density: 1, view: 120, scale: [0.8, 1.2], veg: [0, 1], slopeMax: 0.25, minAboveSea: 0.8, ...o });
export const RECIPES = {
  philosophy: [
    L('grass_tuft', { density: 1500, view: 24, ground: true, veg: [0.12, 1], scale: [0.85, 1.4] }),
    L('grass_tall', { density: 260, view: 52, ground: true, veg: [0.3, 1], scale: [0.8, 1.35] }),
    L('flower_a', { density: 40, view: 55, veg: [0.4, 1], cluster: [18, 0.15], scale: [0.8, 1.3] }),
    L('fern_a', { density: 16, view: 70, veg: [0.5, 1], cluster: [9, 0.1] }),
    L('bush_round', { density: 9, view: 150, veg: [0.35, 1], cluster: [6, 0.0], scale: [0.8, 1.6] }),
    L('tree_round', { density: 22, view: 300, veg: [0.4, 1], cluster: [2.6, 0.08], scale: [0.85, 1.4], collider: true, avoidPaths: true }),
    L('tree_pine', { density: 10, view: 300, veg: [0.3, 1], minHeight: 26, cluster: [3.4, 0.0], scale: [0.8, 1.4], collider: true, avoidPaths: true }),
    L('glow_bulb', { density: 5, view: 90, veg: [0.5, 1], cluster: [14, 0.2] }),
    L('reed_clump', { density: 50, view: 70, minAboveSea: 0.3, maxHeight: 3.2, slopeMax: 0.3 }),
    L('rock_boulder', { density: 3, view: 240, slopeMax: 0.6, scale: [0.8, 3.2], tilt: 0.6, collider: true, avoidPaths: true }),
    L('rock_pebbles', { density: 6, view: 60, slopeMax: 0.5, scale: [0.7, 1.6], tilt: 1 }),
  ],
  experience: [
    L('dune_grass', { density: 70, view: 50, ground: true, veg: [0.25, 1], scale: [0.8, 1.4] }),
    L('grass_tuft', { density: 90, view: 44, ground: true, veg: [0.45, 1], cluster: [10, 0.15] }),
    L('bush_round', { density: 1.2, view: 140, veg: [0.4, 1], scale: [0.6, 1.1] }),
    L('cactus_alien', { density: 1.5, view: 160, veg: [0.2, 1], scale: [0.7, 1.4], collider: true, avoidPaths: true }),
    L('rock_boulder', { density: 2.2, view: 220, slopeMax: 0.7, scale: [0.8, 3], tilt: 0.7, collider: true, avoidPaths: true }),
    L('rock_slab', { density: 1.2, view: 220, slopeMax: 0.6, scale: [0.8, 2.2], tilt: 0.8, collider: true, avoidPaths: true }),
    L('rock_spire', { density: 0.25, view: 420, slopeMax: 0.3, scale: [0.8, 2.2], collider: true, avoidPaths: true }),
    L('rock_pebbles', { density: 5, view: 60, slopeMax: 0.6, tilt: 1 }),
  ],
  projects: [
    L('grass_tuft', { density: 300, view: 46, ground: true, veg: [0.15, 1], scale: [0.8, 1.3] }),
    L('flower_a', { density: 16, view: 55, veg: [0.4, 1], cluster: [16, 0.3] }),
    L('crystal_cluster', { density: 2.2, view: 220, slopeMax: 0.5, scale: [0.7, 2], tilt: 0.4, collider: true, avoidPaths: true }),
    L('crystal_spire', { density: 0.18, view: 520, slopeMax: 0.4, scale: [0.7, 1.6], collider: true, avoidPaths: true }),
    L('tree_umbrella', { density: 2.6, view: 280, veg: [0.35, 1], cluster: [3.5, 0.08], scale: [0.8, 1.5], collider: true, avoidPaths: true }),
    L('glow_bulb', { density: 4, view: 90, veg: [0.4, 1], cluster: [12, 0.2] }),
    L('rock_slab', { density: 0.8, view: 200, slopeMax: 0.6, scale: [0.8, 1.8], tilt: 0.8, collider: true, avoidPaths: true }),
  ],
  mission: [
    L('grass_tuft', { density: 300, view: 46, ground: true, veg: [0.15, 1], scale: [0.8, 1.3] }),
    L('grass_tall', { density: 50, view: 60, ground: true, veg: [0.5, 1], cluster: [10, 0.15] }),
    L('flower_a', { density: 12, view: 55, veg: [0.45, 1], cluster: [15, 0.3] }),
    L('fern_a', { density: 8, view: 70, veg: [0.5, 1], cluster: [8, 0.15] }),
    L('tree_pine', { density: 5, view: 280, veg: [0.35, 1], cluster: [3.2, 0.06], scale: [0.8, 1.5], collider: true, avoidPaths: true }),
    L('bush_round', { density: 3, view: 140, veg: [0.35, 1], cluster: [6, 0.15] }),
    L('rock_boulder', { density: 1.4, view: 220, slopeMax: 0.7, scale: [0.6, 2.6], tilt: 0.6, collider: true, avoidPaths: true }),
    L('rock_spire', { density: 0.3, view: 420, slopeMax: 0.35, minHeight: 4, scale: [0.8, 1.8], collider: true, avoidPaths: true }),
    L('reed_clump', { density: 30, view: 70, minAboveSea: 0.3, maxHeight: 3, slopeMax: 0.3 }),
    L('coral_fan', { density: 12, view: 70, minAboveSea: 0.2, maxHeight: 1.8, slopeMax: 0.4, tilt: 0.5 }),
  ],
  contact: [
    L('dune_grass', { density: 60, view: 50, ground: true, veg: [0.2, 1], scale: [0.8, 1.5] }),
    L('tree_palm', { density: 2.5, view: 280, veg: [0.45, 1], cluster: [5, 0.25], scale: [0.85, 1.35], collider: true, avoidPaths: true }),
    L('cactus_alien', { density: 1.0, view: 160, veg: [0.1, 1], scale: [0.7, 1.4], collider: true, avoidPaths: true }),
    L('bush_round', { density: 0.8, view: 140, veg: [0.4, 1], scale: [0.6, 1.1] }),
    L('rock_boulder', { density: 1.0, view: 220, slopeMax: 0.7, scale: [0.8, 2.6], tilt: 0.6, collider: true, avoidPaths: true }),
    L('rock_slab', { density: 0.8, view: 220, slopeMax: 0.6, scale: [0.8, 2.2], tilt: 0.8, collider: true, avoidPaths: true }),
    L('sandstone_arch', { density: 0.035, view: 600, slopeMax: 0.15, scale: [0.9, 1.4], avoidPaths: true }),
  ],
};

/** Extracts per-asset primitive geometries/material names from the flora GLB. */
function extractAssets(gltf) {
  const assets = new Map();
  for (const node of gltf.scene.children) {
    const parts = [];
    node.updateMatrixWorld(true);
    const inverse = new THREE.Matrix4().copy(node.matrixWorld).invert();
    node.traverse(o => {
      if (!o.isMesh) return;
      const geometry = o.geometry.clone();
      geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, o.matrixWorld));
      parts.push({ geometry, material: o.material.name });
    });
    assets.set(node.name, parts);
  }
  return assets;
}

function makeMaterial(name, color, uniforms) {
  const glow = name === 'Glow' || name === 'Crystal';
  const material = new THREE.MeshStandardMaterial({
    color, vertexColors: true, roughness: name === 'Crystal' ? 0.35 : 0.82, metalness: name === 'Crystal' ? 0.1 : 0.0,
    side: ['Leaf', 'LeafAlt', 'Petal', 'Grass'].includes(name) ? THREE.DoubleSide : THREE.FrontSide,
    emissive: glow ? color : '#000000', emissiveIntensity: name === 'Glow' ? 1.2 : name === 'Crystal' ? 0.18 : 0,
  });
  const wind = { Grass: 0.07, Leaf: 0.006, LeafAlt: 0.006, Petal: 0.03, Bark: 0.0015 }[name] || 0;
  material.userData.slot = name;
  material.customProgramCacheKey = () => `flora-${name}`;
  material.onBeforeCompile = shader => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWind = { value: wind };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 iPos = instanceMatrix[3].xyz;
#else
  vec3 iPos = vec3(0.0);
#endif
  float hgt = max(position.y, 0.0);
  float gust = sin(uTime * 1.7 + iPos.x * 0.21 + iPos.z * 0.17) + 0.45 * sin(uTime * 3.1 + iPos.y * 0.37);
  transformed.x += gust * uWind * hgt * hgt;
  transformed.z += cos(uTime * 1.3 + iPos.z * 0.19) * uWind * 0.6 * hgt * hgt;`);
    if (name === 'Grass') {
      // Keep grass lit like the ground it grows from, on both faces.
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
#ifdef DOUBLE_SIDED
  normal *= faceDirection;
#endif`);
    }
  };
  return material;
}

export class Flora {
  /**
   * @param {THREE.Object3D} parent
   * @param {import('./universe.js').Universe} universe
   * @param {object} gltf flora.glb
   * @param {Array} manifest flora.json
   */
  constructor(parent, universe, gltf, manifest, { quality = 'high' } = {}) {
    this.universe = universe;
    this.pool = universe.pool;
    this.densityScale = quality === 'low' ? 0.35 : quality === 'medium' ? 0.65 : 1;
    this.viewScale = quality === 'low' ? 0.6 : quality === 'medium' ? 0.8 : 1;
    this.group = new THREE.Group(); this.group.name = 'flora'; parent.add(this.group);
    this.assets = extractAssets(gltf);
    this.colliderMeta = Object.fromEntries((manifest || []).filter(e => e.collider).map(e => [e.name, { radius: e.collider.radius, height: e.collider.height }]));
    this.uniforms = { uTime: { value: 0 } };
    this.materials = new Map();
    this.pools = new Map();
    this.cells = new Map();
    this.planet = null;
    this.origin = new THREE.Vector3();
    this.lastScan = new THREE.Vector3(Infinity, 0, 0);
    this.lastFill = new THREE.Vector3(Infinity, 0, 0);
    this.wanted = [];
    this.dirty = false;
    this.stats = { instances: 0, cells: 0, pending: 0 };
    this.inflight = 0;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._p = new THREE.Vector3(); this._c = new THREE.Color();
  }

  #materialsFor(world) {
    if (!this.materials.has(world)) {
      const colors = FLORA_COLORS[world], map = {};
      for (const slot of Object.keys(colors)) map[slot] = makeMaterial(slot, slot === 'Grass' ? '#ffffff' : colors[slot], this.uniforms);
      this.materials.set(world, map);
    }
    return this.materials.get(world);
  }
  #poolFor(asset) {
    if (!this.pools.has(asset)) {
      const parts = this.assets.get(asset);
      const pool = { parts, meshes: [], capacity: 0 };
      this.#allocate(pool, 256);
      this.pools.set(asset, pool);
    }
    return this.pools.get(asset);
  }
  #allocate(pool, capacity) {
    const oldMatrix = pool.matrix, oldColor = pool.color;
    for (const mesh of pool.meshes) { this.group.remove(mesh); mesh.dispose(); }
    pool.matrix = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
    pool.color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    if (oldMatrix) { pool.matrix.array.set(oldMatrix.array.subarray(0, Math.min(oldMatrix.array.length, capacity * 16))); pool.color.array.set(oldColor.array.subarray(0, Math.min(oldColor.array.length, capacity * 3))); }
    pool.matrix.setUsage(THREE.DynamicDrawUsage); pool.color.setUsage(THREE.DynamicDrawUsage);
    pool.capacity = capacity;
    const mats = this.planet ? this.#materialsFor(this.planet.spec.id) : null;
    pool.meshes = pool.parts.map(part => {
      const mesh = new THREE.InstancedMesh(part.geometry, mats?.[part.material] || mats?.Rock || new THREE.MeshStandardMaterial(), capacity);
      mesh.instanceMatrix = pool.matrix; mesh.instanceColor = pool.color;
      mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.userData.slot = part.material;
      this.group.add(mesh);
      return mesh;
    });
  }

  #setPlanet(planet) {
    if (this.planet === planet) return;
    this.planet = planet;
    this.cells.clear(); this.wanted = []; this.lastScan.set(Infinity, 0, 0); this.lastFill.set(Infinity, 0, 0);
    for (const pool of this.pools.values()) for (const m of pool.meshes) m.count = 0;
    if (!planet) return;
    const spec = planet.spec, layout = LAYOUTS[spec.id];
    this.recipe = (RECIPES[spec.id] || []).filter(layer => this.assets.has(layer.asset));
    this.gridN = gridSize(spec.radius);
    this.maxView = Math.max(...this.recipe.map(l => l.view)) * this.viewScale;
    const zones = layout ? [
      ...layout.landmarks.map(m => ({ x: m.at[0], z: m.at[1], r: m.clear ?? 16 })),
      { x: layout.spawn[0], z: layout.spawn[1], r: 7 }, { x: layout.ship[0], z: layout.ship[1], r: 15 },
    ] : [];
    const plateau = layout ? layout.plateau.radius + layout.plateau.falloff : 0;
    this.pool.setFloraContext(spec.id, {
      seed: spec.seed, radius: spec.radius, densityScale: this.densityScale, colliders: this.colliderMeta,
      recipe: this.recipe.map(({ asset, density, view, scale, veg, slopeMax, minAboveSea, maxHeight, minHeight, cluster, ground, collider, avoidPaths, tilt }) => ({ asset, density, view, scale, veg, slopeMax, minAboveSea, maxHeight, minHeight, cluster, ground, collider, avoidPaths, tilt })),
      exclusions: layout ? { frame: spec.frame, plateauCos: Math.cos((plateau + 60) / spec.radius), zones } : null,
    });
    const mats = this.#materialsFor(spec.id);
    for (const layer of this.recipe) for (const mesh of this.#poolFor(layer.asset).meshes) mesh.material = mats[mesh.userData.slot] || mats.Rock;
  }

  #cellsAround(local, radius) {
    const R = this.planet.spec.radius, n = this.gridN;
    const up = local.clone().normalize();
    const tA = new THREE.Vector3(-up.z, 0, up.x); if (tA.lengthSq() < 1e-6) tA.set(1, 0, 0); tA.normalize();
    const tB = new THREE.Vector3().crossVectors(up, tA);
    const step = CELL_SIZE * 0.35, found = new Map(), p = new THREE.Vector3();
    for (let x = -radius; x <= radius; x += step) for (let z = -radius; z <= radius; z += step) {
      if (x * x + z * z > (radius + step) ** 2) continue;
      p.copy(up).multiplyScalar(R).addScaledVector(tA, x).addScaledVector(tB, z).normalize();
      const c = cellOf([p.x, p.y, p.z], n), key = `${c.face}:${c.i}:${c.j}`;
      if (!found.has(key)) found.set(key, { ...c, key, center: new THREE.Vector3(...cellCenter(c.face, c.i, c.j, n, R)) });
    }
    return [...found.values()];
  }

  /** Requests any layer a cell now needs, given its distance. */
  #requestLayers(c, dist) {
    let cell = this.cells.get(c.key);
    if (!cell) { cell = { key: c.key, face: c.face, i: c.i, j: c.j, center: c.center, layers: {}, colliders: [], requested: new Set() }; this.cells.set(c.key, cell); }
    const need = [];
    this.recipe.forEach((layer, li) => { if (!cell.requested.has(li) && dist < layer.view * this.viewScale + CELL_SIZE) need.push(li); });
    if (!need.length) return;
    for (const li of need) cell.requested.add(li);
    const planetId = this.planet.spec.id;
    this.inflight++;
    this.pool.request({ type: 'flora', planet: planetId, face: c.face, i: c.i, j: c.j, layers: need }, dist - 1000, result => {
      this.inflight--;
      if (!result || this.planet?.spec.id !== planetId || this.cells.get(c.key) !== cell) return;
      Object.assign(cell.layers, result.layers);
      cell.colliders.push(...result.colliders);
      this.dirty = true;
    });
  }

  update(focus, time) {
    this.uniforms.uTime.value = time;
    const { planet, altitude } = this.universe.local;
    this.#setPlanet(planet && altitude < 700 ? planet : null);
    if (!this.planet) return this.stats;
    const mats = this.#materialsFor(this.planet.spec.id);
    mats.Glow.emissiveIntensity = 0.6 + 2.4 * (1 - this.universe.local.day);
    const local = this._p.copy(focus).sub(this.planet.center);
    if (this.lastScan.distanceTo(local) > 6) {
      this.lastScan.copy(local);
      this.wanted = this.#cellsAround(local, this.maxView + CELL_SIZE);
      for (const c of this.wanted) this.#requestLayers(c, local.distanceTo(c.center));
      // Drop far cells from the cache.
      if (this.cells.size > 1600) {
        const keep = new Set(this.wanted.map(c => c.key));
        for (const [key, cell] of this.cells) if (!keep.has(key) && local.distanceTo(cell.center) > this.maxView * 2) this.cells.delete(key);
      }
    }
    if ((this.dirty && this.inflight < 6) || (this.dirty && this.lastFill.distanceTo(local) > 4) || this.lastFill.distanceTo(local) > 10) this.#fill(local);
    this.stats.cells = this.cells.size; this.stats.pending = this.inflight;
    return this.stats;
  }

  #fill(local) {
    this.dirty = false; this.lastFill.copy(local);
    this.origin.copy(this.planet.center).add(local);
    const m = this._m, q = this._q, s = this._s, p = new THREE.Vector3(), color = this._c, used = new Set();
    let total = 0;
    const cells = this.wanted.map(c => this.cells.get(c.key)).filter(Boolean);
    this.recipe.forEach((layer, li) => {
      const view = layer.view * this.viewScale, view2 = (view + 2) ** 2, pool = this.#poolFor(layer.asset);
      used.add(layer.asset);
      let count = 0;
      for (const cell of cells) {
        const data = cell.layers[li]; if (!data) continue;
        for (let o = 0; o < data.length; o += STRIDE) {
          const dx = data[o] - local.x, dy = data[o + 1] - local.y, dz = data[o + 2] - local.z, d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > view2) continue;
          const fade = 1 - smoothstep(view * 0.8, view, Math.sqrt(d2));
          if (fade <= 0.03) continue;
          if (count >= pool.capacity) this.#allocate(pool, pool.capacity * 2);
          p.set(dx, dy, dz); q.set(data[o + 3], data[o + 4], data[o + 5], data[o + 6]); s.setScalar(data[o + 7] * fade);
          m.compose(p, q, s).toArray(pool.matrix.array, count * 16);
          color.setRGB(data[o + 8], data[o + 9], data[o + 10]).toArray(pool.color.array, count * 3);
          count++;
        }
      }
      for (const mesh of pool.meshes) { mesh.count = count; mesh.position.copy(this.origin); mesh.updateMatrix(); mesh.updateMatrixWorld(); }
      pool.matrix.needsUpdate = true; pool.color.needsUpdate = true;
      total += count;
    });
    for (const [asset, pool] of this.pools) if (!used.has(asset)) for (const mesh of pool.meshes) mesh.count = 0;
    this.stats.instances = total;
  }

  /** World-space vertical cylinder colliders near a world position. */
  collidersNear(world, radius = 6) {
    if (!this.planet) return [];
    const out = [], c = this.planet.center, lx = world.x - c.x, ly = world.y - c.y, lz = world.z - c.z;
    for (const w of this.wanted) {
      const cell = this.cells.get(w.key); if (!cell) continue;
      if ((cell.center.x - lx) ** 2 + (cell.center.y - ly) ** 2 + (cell.center.z - lz) ** 2 > (radius + CELL_SIZE * 1.2) ** 2) continue;
      for (const col of cell.colliders) {
        const dx = col.x - lx, dy = col.y - ly, dz = col.z - lz;
        if (dx * dx + dy * dy + dz * dz < (radius + col.radius) ** 2) out.push({ x: col.x + c.x, y: col.y + c.y, z: col.z + c.z, radius: col.radius, height: col.height });
      }
    }
    return out;
  }

  dispose() {
    for (const pool of this.pools.values()) for (const mesh of pool.meshes) mesh.dispose();
    for (const mats of this.materials.values()) for (const m of Object.values(mats)) m.dispose();
    this.group.removeFromParent();
  }
}
