import * as THREE from 'three';
import { mulberry32 } from '../world/noise.js';
import { siteLocalToDir } from '../world/planet-shape.js';
import { createGlow } from '../world/space.js';

/**
 * Resonance shards: collectibles that reward exploring beyond the main site.
 * Ten per world, deterministic, biased toward high ground (hilltops, mesas,
 * sea stacks), each marked by a faint light shaft visible from far away.
 */
export const SHARDS_PER_WORLD = 10;

export function shardPositions(planet) {
  const spec = planet.spec, shape = planet.shape, random = mulberry32(spec.seed * 7 + 99);
  const out = [];
  let attempts = 0;
  while (out.length < SHARDS_PER_WORLD && attempts++ < 600) {
    const a = random() * Math.PI * 2, r = 150 + Math.pow(random(), 0.8) * 650;
    // Sample a few candidates nearby and keep the highest (rewards climbing).
    let best = null;
    for (let k = 0; k < 4; k++) {
      const rr = r + (random() - 0.5) * 60, aa = a + (random() - 0.5) * 0.2;
      const dir = siteLocalToDir(spec.frame, spec.radius, Math.sin(aa) * rr, -Math.cos(aa) * rr);
      const h = shape.heightAt(...dir);
      if (shape.seaLevel !== null && h < shape.seaLevel + 1.5) continue;
      if (!best || h > best.h) best = { dir, h };
    }
    if (!best) continue;
    const p = new THREE.Vector3(...best.dir).multiplyScalar(spec.radius + best.h + 1.6).add(planet.center);
    if (out.some(o => o.position.distanceTo(p) < 90)) continue;
    out.push({ id: `${spec.id}:shard:${out.length}`, position: p, up: new THREE.Vector3(...best.dir) });
  }
  return out;
}

export class Shards {
  constructor(scene, floraGltf) {
    this.group = new THREE.Group(); this.group.name = 'shards'; scene.add(this.group);
    const source = floraGltf?.scene.getObjectByName('shard');
    this.template = source ? source.clone(true) : new THREE.Mesh(new THREE.OctahedronGeometry(0.4, 0), new THREE.MeshStandardMaterial({ color: '#c9f7ff' }));
    this.template.traverse(o => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.material.emissive = new THREE.Color(o.material.name === 'Glow' ? '#c9a6ff' : '#8cf0d1');
      o.material.emissiveIntensity = o.material.name === 'Glow' ? 3 : 0.9;
    });
    this.items = [];
    this.world = null;
    this.beamMat = new THREE.MeshBasicMaterial({ color: '#b9f3ff', transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.beamGeo = new THREE.CylinderGeometry(0.25, 0.6, 60, 10, 1, true); this.beamGeo.translate(0, 30, 0);
  }
  setWorld(planet, collected) {
    if (this.world === planet?.spec.id) return;
    for (const item of this.items) this.group.remove(item.root);
    this.items = [];
    this.world = planet?.spec.id ?? null;
    if (!planet) return;
    for (const s of shardPositions(planet)) {
      if (collected.includes(s.id)) continue;
      const root = new THREE.Group();
      root.position.copy(s.position);
      root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), s.up);
      const shard = this.template.clone(true); shard.scale.setScalar(1.6); root.add(shard);
      const glow = createGlow('#b9e9ff', 3.2, 0.75); root.add(glow);
      const beam = new THREE.Mesh(this.beamGeo, this.beamMat); root.add(beam);
      this.group.add(root);
      this.items.push({ ...s, root, shard, glow });
    }
  }
  /** Returns the collected shard (if any) for this frame. */
  update(time, playerPosition) {
    let collected = null;
    for (const item of this.items) {
      item.shard.rotation.y = time * 1.4;
      item.shard.position.y = Math.sin(time * 2 + item.position.x) * 0.25;
      item.glow.material.opacity = 0.55 + Math.sin(time * 3 + item.position.z) * 0.2;
      if (!collected && item.position.distanceTo(playerPosition) < 2.6) collected = item;
    }
    if (collected) { this.group.remove(collected.root); this.items.splice(this.items.indexOf(collected), 1); }
    return collected;
  }
  nearest(position) {
    let best = null, d = Infinity;
    for (const item of this.items) { const k = item.position.distanceTo(position); if (k < d) { d = k; best = item; } }
    return best ? { item: best, distance: d } : null;
  }
}
