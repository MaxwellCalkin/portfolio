import * as THREE from 'three';
import { getGlowTexture } from '../world/space.js';

/**
 * Pooled, cheap visual effects: sparks, shockwave rings, flashes and beams.
 * Everything is additive so it reads well against bright skies and at night.
 */
export class FX {
  constructor(scene, { reducedMotion = false } = {}) {
    this.scene = scene; this.reducedMotion = reducedMotion;
    this.group = new THREE.Group(); this.group.name = 'fx'; scene.add(this.group);
    this.sparkGeo = new THREE.OctahedronGeometry(0.09, 0);
    this.ringGeo = new THREE.TorusGeometry(1, 0.035, 6, 72);
    this.discGeo = new THREE.RingGeometry(0.7, 1, 64);
    this.materials = new Map();
    this.live = [];
    this.pool = [];
    this.flashPool = [];
  }
  #mat(color, kind = 'basic') {
    const key = `${kind}:${color}`;
    if (!this.materials.has(key)) {
      const m = kind === 'sprite'
        ? new THREE.SpriteMaterial({ map: getGlowTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
        : new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      this.materials.set(key, m);
    }
    return this.materials.get(key);
  }
  /** Burst of sparks. */
  sparks(position, color = '#9ffcea', count = 12, speed = 7, up = null) {
    const n = this.reducedMotion ? Math.ceil(count / 3) : count;
    for (let i = 0; i < n; i++) {
      const mesh = this.pool.pop() || new THREE.Mesh(this.sparkGeo);
      mesh.material = this.#mat(color); mesh.position.copy(position); mesh.scale.setScalar(0.6 + Math.random() * 1.4);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random()));
      if (up) v.addScaledVector(up, speed * 0.4);
      this.group.add(mesh);
      this.live.push({ mesh, v, life: 0.35 + Math.random() * 0.45, max: 0.8, kind: 'spark', up });
    }
  }
  /** Expanding ring, oriented to `up` (planet radial or any axis). */
  ring(position, up, color = '#8cf0d1', size = 8, life = 0.6, disc = false) {
    const mesh = new THREE.Mesh(disc ? this.discGeo : this.ringGeo, this.#mat(color).clone());
    mesh.position.copy(position);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
    this.group.add(mesh);
    this.live.push({ mesh, life, max: life, kind: 'ring', size, own: true });
  }
  /** Soft additive flash sprite. */
  flash(position, color = '#ffffff', size = 3, life = 0.18) {
    const sprite = new THREE.Sprite(this.#mat(color, 'sprite').clone());
    sprite.position.copy(position); sprite.scale.setScalar(size);
    this.group.add(sprite);
    this.live.push({ mesh: sprite, life, max: life, kind: 'flash', size, own: true });
  }
  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const e = this.live[i];
      e.life -= dt;
      const k = Math.max(0, e.life / e.max);
      if (e.kind === 'spark') {
        e.mesh.position.addScaledVector(e.v, dt);
        e.v.multiplyScalar(Math.exp(-dt * 2.2));
        if (e.up) e.v.addScaledVector(e.up, -9 * dt);
        e.mesh.rotation.x += dt * 8; e.mesh.scale.multiplyScalar(Math.exp(-dt * 2.5));
      } else if (e.kind === 'ring') {
        const s = 0.2 + (1 - k) * e.size; e.mesh.scale.setScalar(s); e.mesh.material.opacity = k;
      } else if (e.kind === 'flash') {
        e.mesh.scale.setScalar(e.size * (0.6 + 0.4 * k)); e.mesh.material.opacity = k;
      }
      if (e.life <= 0) {
        this.group.remove(e.mesh);
        if (e.own) e.mesh.material.dispose();
        else if (e.kind === 'spark') this.pool.push(e.mesh);
        else if (e.kind === 'flash') this.flashPool.push(e.mesh);
        this.live.splice(i, 1);
      }
    }
  }
  clear() { for (const e of this.live) { this.group.remove(e.mesh); if (e.own) e.mesh.material.dispose(); } this.live.length = 0; }
}
