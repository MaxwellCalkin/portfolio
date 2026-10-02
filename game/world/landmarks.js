import * as THREE from 'three';
import { loadModel } from '../engine/assets.js';
import { LAYOUTS } from './layout.js';
import { siteLocalToDir, tangentFrame } from './planet-shape.js';
import { boxColliderFromMesh, cylinderColliderFromMesh } from '../actors/physics.js';
import { discoveryFor } from '../gameplay/discoveries.js';

/**
 * Places each world's landmark GLB nodes on its plateau, conformed to the
 * sphere, and extracts the gameplay contract inside them: POI_ interaction
 * points, LABEL_ title anchors, ANIM_ parts, SPAWN_ markers and COL_ proxies.
 */

const nameOf = o => o.userData?.name || o.name || '';

export class Landmarks {
  constructor(parent, universe, colliders) {
    this.parent = parent; this.universe = universe; this.colliders = colliders;
    this.group = new THREE.Group(); this.group.name = 'landmarks'; parent.add(this.group);
    this.worlds = new Map(); // world -> { items, pois, labels, anims }
    this.loading = new Map();
  }

  /** Surface frame at site-local (x, z) of a planet: position + basis. */
  static placement(planet, x, z, yaw = 0, sink = 0) {
    const spec = planet.spec, frame = spec.frame, R = spec.radius;
    const dir = siteLocalToDir(frame, R, x, z);
    const h = planet.shape.heightAt(dir[0], dir[1], dir[2]);
    const ground = planet.shape.seaLevel !== null ? Math.max(h, planet.shape.seaLevel) : h;
    const up = new THREE.Vector3(...dir);
    // Re-derive the site's forward at this point (parallel to the site frame).
    const local = tangentFrame(dir, frame.forward);
    const forward = new THREE.Vector3(...local.forward), right = new THREE.Vector3(...local.right);
    const back = forward.clone().negate();
    const basis = new THREE.Matrix4().makeBasis(right, up, back);
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(basis).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
    const position = planet.center.clone().addScaledVector(up, R + ground - sink);
    return { position, quaternion, up, forward, right, ground };
  }

  /** Loads and places one world's landmarks (idempotent). */
  async load(planet) {
    const id = planet.spec.id;
    if (this.worlds.has(id)) return this.worlds.get(id);
    if (this.loading.has(id)) return this.loading.get(id);
    const task = (async () => {
      const layout = LAYOUTS[id];
      const [worldGltf, sharedGltf] = await Promise.all([loadModel(`landmarks-${id}.glb`), loadModel('landmarks-shared.glb')]);
      const nodes = new Map(), shared = new Map();
      for (const n of worldGltf.scene.children) nodes.set(nameOf(n), n);
      for (const n of sharedGltf.scene.children) shared.set(nameOf(n), n);
      const world = { id, items: [], pois: [], labels: [], anims: [], spawns: [], colliderIds: [], group: new THREE.Group() };
      world.group.name = `landmarks-${id}`;
      this.group.add(world.group);
      const place = (node, mark, extra = {}) => {
        const object = node.clone(true);
        let yaw = mark.yaw ?? 0;
        if (mark.face) yaw = Math.atan2(-(mark.face[0] - mark.at[0]), -(mark.face[1] - mark.at[1])) + Math.PI; // front (+Z) toward the target
        const p = Landmarks.placement(planet, mark.at[0], mark.at[1], yaw, extra.sink ?? 0.05);
        object.position.copy(p.position); object.quaternion.copy(p.quaternion);
        object.updateMatrixWorld(true);
        const item = { id: mark.id, node: mark.node || node.name, object, up: p.up, position: p.position.clone(), world: id };
        this.#harvest(item, world, planet);
        world.group.add(object);
        world.items.push(item);
        return item;
      };
      for (const mark of layout.landmarks) {
        const source = mark.shared ? shared.get(mark.node) : nodes.get(mark.node);
        if (!source) { console.warn(`landmark ${mark.node} missing from GLB`); continue; }
        place(source, mark);
      }
      // Every world gets a landing pad for the ship.
      const pad = shared.get('landing_pad');
      if (pad) place(pad, { id: 'pad', node: 'landing_pad', at: layout.ship, yaw: layout.shipYaw ?? 0 }, { sink: 0.02 });
      world.ready = true;
      this.worlds.set(id, world);
      return world;
    })();
    this.loading.set(id, task);
    return task;
  }

  #harvest(item, world, planet) {
    const remove = [];
    item.object.traverse(o => {
      const name = nameOf(o);
      if (o.isMesh) {
        o.castShadow = true; o.receiveShadow = true;
        this.#styleMaterial(o, planet.spec);
      }
      if (/^COL_/.test(name)) {
        // The proxy may live on this node or (after packing) on a child mesh.
        const mesh = o.isMesh ? o : o.children.find(c => c.isMesh);
        if (mesh) {
          const collider = /^COL_CYL/.test(name) ? cylinderColliderFromMesh(mesh, `landmark:${world.id}`) : boxColliderFromMesh(mesh, `landmark:${world.id}`);
          collider.landmark = item.id;
          world.colliderIds.push(this.colliders.add(collider));
        }
        remove.push(o);
        return;
      }
      if (/^POI_/.test(name)) {
        const position = o.getWorldPosition(new THREE.Vector3());
        const discovery = discoveryFor(world.id, item.id, name);
        world.pois.push({ name, landmark: item.id, node: item.node, position, discovery, up: item.up });
      } else if (/^LABEL_/.test(name)) {
        world.labels.push({ name, landmark: item.id, position: o.getWorldPosition(new THREE.Vector3()) });
      } else if (/^SPAWN_/.test(name)) {
        world.spawns.push({ name, landmark: item.id, position: o.getWorldPosition(new THREE.Vector3()) });
      } else if (/^ANIM_/.test(name)) {
        const kind = name.split('_')[1];
        world.anims.push({ object: o, kind, base: o.position.clone(), baseQuat: o.quaternion.clone(), phase: Math.random() * 6.28, materials: kind === 'PULSE' ? collectGlow(o) : null });
      }
    });
    for (const o of remove) o.parent?.remove(o);
  }

  #styleMaterial(mesh, spec) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (m.userData.styled) continue;
      m.userData.styled = true;
      const slot = m.name;
      if (slot === 'Glow') { m.emissive?.copy(m.color); m.emissiveIntensity = 2.2; m.toneMapped = true; }
      else if (slot === 'Glass') { m.roughness = 0.12; m.metalness = 0.2; m.envMapIntensity = 1; if (m.emissive) { m.emissive.copy(m.color).multiplyScalar(0.25); } }
      else if (slot === 'Metal') { m.roughness = Math.min(m.roughness, 0.45); m.metalness = Math.max(m.metalness, 0.5); }
      else { m.roughness = Math.max(0.55, m.roughness); }
      // Heard Us uses its own navy and gold identity.
      if (spec.id === 'projects' && slot === 'Accent' && mesh.parent && /heard/.test(nameOf(rootOf(mesh)))) m.color.set('#e9c46a');
    }
  }

  /** Nearest POI (world space) within `radius` meters. */
  nearestPoi(worldId, position, radius = 3.2) {
    const world = this.worlds.get(worldId); if (!world) return null;
    let best = null, bestD = radius * radius;
    for (const poi of world.pois) {
      const d = poi.position.distanceToSquared(position);
      if (d < bestD) { bestD = d; best = poi; }
    }
    return best;
  }

  update(time, dt) {
    for (const world of this.worlds.values()) {
      if (!world.group.visible) continue;
      for (const a of world.anims) {
        if (a.kind === 'SPIN') a.object.rotateY(dt * 0.6);
        else if (a.kind === 'BOB') a.object.position.y = a.base.y + Math.sin(time * 1.6 + a.phase) * 0.12;
        else if (a.kind === 'PULSE' && a.materials) for (const m of a.materials) m.emissiveIntensity = 1.6 + Math.sin(time * 2.4 + a.phase) * 0.9;
      }
    }
  }

  /** Show only the active world's landmarks (others are far away anyway). */
  setActive(worldId) { for (const [id, world] of this.worlds) world.group.visible = id === worldId; }
}

function rootOf(o) { while (o.parent && o.parent.parent && o.parent.parent.type !== 'Scene' && o.parent.name !== '') o = o.parent; return o; }
function collectGlow(object) {
  const set = new Set();
  object.traverse(o => { if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m.name === 'Glow') { const c = m.clone(); o.material = c; set.add(c); } });
  return [...set];
}
