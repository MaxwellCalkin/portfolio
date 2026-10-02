import * as THREE from 'three';
import { createCreature, createBoss } from '../creatures.js';
import { segmentSphereHitTime } from '../space-playground.js';
import { LAYOUTS } from '../world/layout.js';
import { siteLocalToDir } from '../world/planet-shape.js';

/**
 * Combat: projectiles, wild sentinels, world wardens and the agent's
 * bass-themed abilities. Fighting is always optional: the main sites are
 * sanctuaries, and every chapter can be read without firing a shot.
 */
export const ABILITIES = Object.freeze({
  pulse: { name: 'Low End', key: 'C', cooldown: 7, radius: 15, damage: 70 },
  dash: { name: 'Glissando', key: 'Q', cooldown: 2.6 },
  drop: { name: 'The Drop', key: 'X', radius: 46, damage: 520, windup: 0.9 },
});

const ENEMY = { speed: 4.2, range: 16, aggro: 55, boltSpeed: 36, boltDamage: 9, hp: 110, contact: 16 };
const _v = new THREE.Vector3(), _w = new THREE.Vector3();

export class Combat {
  constructor(scene, { fx, sound, events }) {
    this.scene = scene; this.fx = fx; this.sound = sound; this.events = events;
    this.group = new THREE.Group(); this.group.name = 'combat'; scene.add(this.group);
    this.projectiles = [];
    this.enemies = [];
    this.wardens = new Map(); // world -> enemy
    this.pool = { player: [], enemy: [] };
    this.boltGeo = new THREE.CylinderGeometry(0.05, 0.09, 2.2, 6); this.boltGeo.rotateX(Math.PI / 2);
    this.orbGeo = new THREE.IcosahedronGeometry(0.28, 1);
    this.boltMats = [
      new THREE.MeshBasicMaterial({ color: '#b8fff1', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      new THREE.MeshBasicMaterial({ color: '#ff9a74', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    ];
    this.spawnTimer = 2;
    this.dropCharge = null;
  }

  /* ------------------------------------------------------------ projectiles */
  firePlayer(origin, target, { damage = 30, speed = 170, color = 0 } = {}) {
    const dir = _v.copy(target).sub(origin).normalize();
    const mesh = this.pool.player.pop() || new THREE.Mesh(this.boltGeo, this.boltMats[0]);
    mesh.position.copy(origin); mesh.quaternion.setFromUnitVectors(_w.set(0, 0, 1), dir);
    this.group.add(mesh);
    this.projectiles.push({ mesh, velocity: dir.clone().multiplyScalar(speed), life: 1.6, hostile: false, damage });
    this.fx.flash(origin, '#bafff0', 0.9, 0.06);
  }
  fireEnemy(origin, dir, damage = ENEMY.boltDamage, speed = ENEMY.boltSpeed) {
    const mesh = this.pool.enemy.pop() || new THREE.Mesh(this.orbGeo, this.boltMats[1]);
    mesh.position.copy(origin); this.group.add(mesh);
    this.projectiles.push({ mesh, velocity: dir.clone().normalize().multiplyScalar(speed), life: 4, hostile: true, damage });
  }

  /** Ray vs enemies (for aim assist / target point). */
  raycast(origin, dir, maxDist = 220) {
    let best = null, bestT = maxDist;
    const end = origin.clone().addScaledVector(dir, maxDist);
    for (const e of this.enemies) {
      if (e.dead) continue;
      const t = segmentSphereHitTime(origin, end, e.center, e.radius * 1.1);
      if (t !== null && t * maxDist < bestT) { bestT = t * maxDist; best = e; }
    }
    return best ? { enemy: best, distance: bestT } : null;
  }

  /* ---------------------------------------------------------------- enemies */
  #spawn(planet, position, { boss = false } = {}) {
    const type = Math.floor(Math.random() * 3);
    const mesh = boss ? createBoss(planet.spec.id) : createCreature(type);
    const up = position.clone().sub(planet.center).normalize();
    const e = {
      mesh, boss, planet, up, position: position.clone(), center: position.clone(), heading: new THREE.Vector3(-up.z, 0, up.x).normalize(),
      hp: boss ? 1500 + ['philosophy', 'experience', 'projects', 'mission', 'contact'].indexOf(planet.spec.id) * 250 : ENEMY.hp,
      radius: Math.max(1.1, (mesh.userData.radius || 1.2) * (boss ? 0.75 : 1)), flying: !!mesh.userData.isFlying,
      groundOffset: mesh.userData.groundOffset || 1.2, shootTimer: 1.5 + Math.random() * 2, telegraph: 0, phase: Math.random() * 10,
      stagger: 0, charge: 0, home: position.clone(), aggro: false, volley: 0,
    };
    e.maxHp = e.hp;
    mesh.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
    this.group.add(mesh);
    this.enemies.push(e);
    return e;
  }
  spawnWarden(planet, position, defeated) {
    const existing = this.wardens.get(planet.spec.id);
    if (existing || defeated) return existing || null;
    const e = this.#spawn(planet, position, { boss: true });
    e.name = e.mesh.userData.displayName || 'World warden';
    this.wardens.set(planet.spec.id, e);
    return e;
  }
  /** Finds a dry, gentle spot for the warden's lair, ~320-520 m from the site. */
  static lairFor(planet) {
    const spec = planet.spec, shape = planet.shape, frame = spec.frame;
    let best = null;
    for (let i = 0; i < 48; i++) {
      const a = (i * 2.399963) % (Math.PI * 2), r = 320 + (i % 5) * 50;
      const dir = siteLocalToDir(frame, spec.radius, Math.sin(a) * r, -Math.cos(a) * r);
      const h = shape.heightAt(...dir);
      if (shape.seaLevel !== null && h < shape.seaLevel + 3) continue;
      const score = -Math.abs(h - (shape.seaLevel ?? 0) - 20) * 0.1 + (i < 12 ? 2 : 0);
      if (!best || score > best.score) best = { dir, h, score };
    }
    if (!best) return null;
    return planet.center.clone().addScaledVector(new THREE.Vector3(...best.dir), spec.radius + best.h);
  }

  #despawn(e) {
    this.group.remove(e.mesh); e.mesh.userData.dispose?.();
    const i = this.enemies.indexOf(e); if (i >= 0) this.enemies.splice(i, 1);
    if (e.boss) for (const [id, w] of this.wardens) if (w === e) this.wardens.delete(id);
  }

  damage(e, amount, at, { ability = false } = {}) {
    if (e.dead) return;
    e.hp -= amount; e.aggro = true;
    this.events.onHit?.(e, amount, at);
    if (e.hp <= 0) {
      e.dead = true;
      this.fx.sparks(e.center, e.boss ? '#ffe2a8' : '#ffb38f', e.boss ? 60 : 22, e.boss ? 16 : 9);
      this.fx.ring(e.center, e.up, '#ffc39a', e.boss ? 24 : 6, 0.5);
      this.fx.flash(e.center, '#ffffff', e.boss ? 16 : 5, 0.25);
      this.events.onKill?.(e, ability);
      this.#despawn(e);
    }
  }

  /** Ability C: a bass shockwave around the player. */
  pulse(center, up) {
    const a = ABILITIES.pulse;
    this.fx.ring(center.clone().addScaledVector(up, 0.3), up, '#8cf0d1', a.radius, 0.55);
    this.fx.ring(center.clone().addScaledVector(up, 0.6), up, '#c9a6ff', a.radius * 0.7, 0.4);
    this.fx.sparks(center.clone().addScaledVector(up, 0.5), '#9ffcea', 24, 12, up);
    let hits = 0;
    for (const e of [...this.enemies]) {
      const d = e.center.distanceTo(center);
      if (d > a.radius + e.radius) continue;
      hits++;
      this.damage(e, e.boss ? a.damage * 1.5 : a.damage, e.center, { ability: true });
      if (!e.dead) { e.stagger = 1.1; e.knock = e.center.clone().sub(center).addScaledVector(up, -e.center.clone().sub(center).dot(up)).setLength(e.boss ? 5 : 16); }
    }
    return hits;
  }

  /** Ability X: The Drop. Charges for a beat, then detonates. */
  drop(center, up) {
    if (this.dropCharge) return false;
    this.dropCharge = { t: 0, center: center.clone(), up: up.clone() };
    this.fx.ring(center.clone().addScaledVector(up, 0.4), up, '#c9a6ff', 8, ABILITIES.drop.windup);
    return true;
  }
  #updateDrop(dt) {
    const d = this.dropCharge; if (!d) return;
    d.t += dt;
    if (Math.random() < 0.6) {
      const p = d.center.clone().add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(30));
      this.fx.sparks(p, '#d9c4ff', 2, 4);
    }
    if (d.t >= ABILITIES.drop.windup && !d.done) {
      d.done = true;
      const a = ABILITIES.drop;
      for (const [color, size, life] of [['#c9a6ff', a.radius, 1.3], ['#8cf0d1', a.radius * 0.8, 1.0], ['#ffffff', a.radius * 0.5, 0.6]]) this.fx.ring(d.center.clone().addScaledVector(d.up, 0.6), d.up, color, size, life);
      this.fx.flash(d.center.clone().addScaledVector(d.up, 4), '#e8dcff', 60, 0.5);
      this.fx.sparks(d.center.clone().addScaledVector(d.up, 1), '#e5d8ff', 70, 30, d.up);
      for (const e of [...this.enemies]) if (e.center.distanceTo(d.center) < a.radius + e.radius) { this.damage(e, e.boss ? a.damage * 1.8 : a.damage, e.center, { ability: true }); if (!e.dead) e.stagger = 2.2; }
      this.events.onDrop?.(d.center);
    }
    if (d.t > ABILITIES.drop.windup + 0.4) this.dropCharge = null;
  }

  /**
   * @param {object} ctx { player, planet, sanctuary:(pos)=>bool, timeOfDay, playerHit(dmg, at), invulnerable }
   */
  update(dt, time, ctx) {
    const { player, planet } = ctx;
    this.#updateDrop(dt);
    // ---- wild spawning (only on a planet surface, outside sanctuaries)
    const onPlanet = planet && ctx.onFoot;
    const wild = this.enemies.filter(e => !e.boss);
    if (onPlanet) {
      this.spawnTimer -= dt;
      const outside = !ctx.sanctuary(player.position, 40);
      const cap = outside ? 6 : 2;
      if (this.spawnTimer <= 0 && wild.length < cap) {
        this.spawnTimer = 3 + Math.random() * 3;
        for (let attempt = 0; attempt < 6; attempt++) {
          const a = Math.random() * Math.PI * 2, r = 70 + Math.random() * 45;
          const up = player.up, t1 = _v.set(-up.z, 0, up.x).normalize(), t2 = _w.crossVectors(up, t1);
          const dir = player.position.clone().sub(planet.center).normalize().multiplyScalar(planet.spec.radius).addScaledVector(t1, Math.cos(a) * r).addScaledVector(t2, Math.sin(a) * r).normalize();
          const h = planet.shape.heightAt(dir.x, dir.y, dir.z);
          if (planet.shape.seaLevel !== null && h < planet.shape.seaLevel + 1) continue;
          const pos = planet.center.clone().addScaledVector(dir, planet.spec.radius + h);
          if (ctx.sanctuary(pos, 25)) continue;
          this.#spawn(planet, pos);
          break;
        }
      }
    }
    // ---- enemy behavior
    for (const e of [...this.enemies]) {
      if (e.planet !== planet) { if (!e.boss) this.#despawn(e); continue; }
      const toPlayer = _v.copy(player.position).sub(e.position);
      const dist = toPlayer.length();
      if (!e.boss && dist > 260) { this.#despawn(e); continue; }
      e.up.copy(e.position).sub(planet.center).normalize();
      const tangent = toPlayer.clone().addScaledVector(e.up, -toPlayer.dot(e.up));
      const flat = tangent.length();
      if (flat > 1e-3) tangent.divideScalar(flat);
      if (dist < (e.boss ? 70 : ENEMY.aggro)) e.aggro = true;
      if (e.boss && e.home.distanceTo(player.position) > 170) { e.aggro = false; e.hp = Math.min(e.maxHp, e.hp + dt * 120); }
      e.stagger = Math.max(0, e.stagger - dt);
      let move = new THREE.Vector3();
      if (e.knock) { move.copy(e.knock); e.knock.multiplyScalar(Math.exp(-dt * 6)); if (e.knock.lengthSq() < 0.1) e.knock = null; }
      if (e.stagger <= 0) {
        if (e.aggro && ctx.onFoot) {
          const range = e.boss ? 18 : ENEMY.range;
          const speed = (e.boss ? 5.5 : ENEMY.speed) * (e.charge > 0 ? 4 : 1);
          if (flat > range || e.charge > 0) move.addScaledVector(tangent, speed);
          else move.addScaledVector(new THREE.Vector3().crossVectors(e.up, tangent), Math.sin(time * 0.7 + e.phase) * 2.5);
          e.heading.lerp(tangent, 1 - Math.exp(-dt * 6)).normalize();
        } else {
          // Idle wander around home.
          const wander = new THREE.Vector3(Math.sin(time * 0.3 + e.phase), 0, Math.cos(time * 0.23 + e.phase * 1.7));
          wander.addScaledVector(e.up, -wander.dot(e.up));
          if (e.position.distanceTo(e.home) > 20) wander.copy(e.home).sub(e.position).addScaledVector(e.up, -e.home.clone().sub(e.position).dot(e.up)).normalize();
          move.addScaledVector(wander.normalize(), 1.4);
          if (wander.lengthSq() > 0) e.heading.lerp(wander, 1 - Math.exp(-dt * 2)).normalize();
        }
      }
      e.charge = Math.max(0, e.charge - dt);
      e.position.addScaledVector(move, dt);
      const dir = _w.copy(e.position).sub(planet.center).normalize();
      const ground = planet.shape.surfaceRadius(dir.x, dir.y, dir.z);
      const hover = e.flying ? 2.2 + Math.sin(time * 1.6 + e.phase) * 0.5 : 0;
      e.position.copy(planet.center).addScaledVector(dir, ground + e.groundOffset + hover);
      e.center.copy(e.position);
      e.mesh.position.copy(e.position);
      // Orientation: -Z along heading, +Y radial.
      e.heading.addScaledVector(dir, -e.heading.dot(dir)).normalize();
      const right = new THREE.Vector3().crossVectors(e.heading, dir).normalize();
      e.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, dir, e.heading.clone().negate()));
      e.mesh.userData.update?.(time, dt);
      // Attacks.
      if (e.aggro && ctx.onFoot && e.stagger <= 0 && dist < (e.boss ? 90 : 70)) {
        e.shootTimer -= dt;
        e.telegraph = e.shootTimer < 0.45 ? 1 - e.shootTimer / 0.45 : 0;
        if (e.shootTimer <= 0) {
          const origin = e.center.clone().addScaledVector(e.up, e.boss ? 1.6 : 0.3);
          const aim = player.position.clone().addScaledVector(player.up, 1.1).addScaledVector(player.velocity, dist / ENEMY.boltSpeed * 0.6).sub(origin).normalize();
          if (e.boss) {
            e.volley++;
            const count = 5;
            for (let i = 0; i < count; i++) this.fireEnemy(origin, aim.clone().applyAxisAngle(e.up, (i - (count - 1) / 2) * 0.12), 13, 40);
            if (e.volley % 3 === 0) { e.charge = 1.0; this.fx.ring(e.center, e.up, '#ff9368', 10, 0.8); this.sound?.play('bossRoar'); }
            e.shootTimer = 2.4;
          } else { this.fireEnemy(origin, aim); e.shootTimer = 2.2 + Math.random() * 1.6; }
        }
      }
      if (ctx.onFoot && dist < e.radius + 1.2 && !ctx.invulnerable) ctx.playerHit(dt * (e.boss ? 40 : ENEMY.contact), e.center);
      // Telegraph glow.
      for (const m of e.mesh.userData.materials || []) if (m.emissive && m.userData.baseEmissive === undefined) m.userData.baseEmissive = m.emissiveIntensity;
      for (const m of e.mesh.userData.materials || []) if (m.userData.baseEmissive !== undefined) m.emissiveIntensity = m.userData.baseEmissive * (1 + e.telegraph * 2.5);
    }
    // ---- projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const start = p.mesh.position.clone();
      const end = start.clone().addScaledVector(p.velocity, dt);
      p.life -= dt;
      let hit = false, hitPoint = null;
      if (p.hostile) {
        if (ctx.onFoot) {
          const c = player.position.clone().addScaledVector(player.up, 1.0);
          const t = segmentSphereHitTime(start, end, c, 0.75);
          if (t !== null) { hit = true; hitPoint = start.clone().lerp(end, t); if (!ctx.invulnerable) ctx.playerHit(p.damage, hitPoint); }
        }
      } else {
        let best = null, bestT = 1;
        for (const e of this.enemies) { const t = segmentSphereHitTime(start, end, e.center, e.radius); if (t !== null && t < bestT) { bestT = t; best = e; } }
        if (best) { hit = true; hitPoint = start.clone().lerp(end, bestT); this.fx.sparks(hitPoint, '#ffd2b0', 6, 5); this.damage(best, p.damage, hitPoint); }
        else if (this.events.onBoltSegment?.(start, end)) hit = true;
      }
      // Terrain.
      if (!hit && planet) {
        const dEnd = end.distanceTo(planet.center), dir = end.clone().sub(planet.center).divideScalar(dEnd);
        if (dEnd < planet.shape.surfaceRadius(dir.x, dir.y, dir.z)) { hit = true; hitPoint = end; this.fx.sparks(end, p.hostile ? '#ffb08a' : '#b8fff1', 5, 4, dir); }
      }
      if (!hit && ctx.colliders) {
        for (const c of ctx.colliders.query(end, 1, this._q || (this._q = []))) if (pointInside(c, end)) { hit = true; hitPoint = end; this.fx.sparks(end, '#ffffff', 4, 3); break; }
      }
      p.mesh.position.copy(end);
      if (hit || p.life <= 0) {
        this.group.remove(p.mesh);
        (p.hostile ? this.pool.enemy : this.pool.player).push(p.mesh);
        this.projectiles.splice(i, 1);
      }
    }
  }

  get activeWarden() { for (const e of this.wardens.values()) if (e.aggro && !e.dead) return e; return null; }
  get threat() { let t = 0; for (const e of this.enemies) if (e.aggro) t += e.boss ? 1 : 0.35; return Math.min(1, t); }

  clear() {
    for (const e of [...this.enemies]) this.#despawn(e);
    for (const p of this.projectiles) this.group.remove(p.mesh);
    this.projectiles.length = 0; this.wardens.clear(); this.dropCharge = null;
  }
}

function pointInside(c, p) {
  if (c.type === 'cyl') {
    const d = p.clone().sub(c.base), h = d.dot(c.axis);
    if (h < 0 || h > c.height) return false;
    return d.addScaledVector(c.axis, -h).length() < c.radius;
  }
  if (c.type === 'box') {
    const d = p.clone().sub(c.center);
    return Math.abs(d.dot(c.axes[0])) < c.half.x && Math.abs(d.dot(c.axes[1])) < c.half.y && Math.abs(d.dot(c.axes[2])) < c.half.z;
  }
  return c.type === 'sph' && p.distanceTo(c.center) < c.radius;
}

/** Site-local sanctuary test: no wild spawns near the content landmarks. */
export function makeSanctuary(planet) {
  const layout = LAYOUTS[planet.spec.id]; if (!layout) return () => false;
  const up = new THREE.Vector3(...planet.spec.frame.up), R = planet.spec.radius, radius = layout.plateau.radius;
  return (position, margin = 0) => {
    const d = position.clone().sub(planet.center).normalize();
    return Math.acos(Math.min(1, Math.max(-1, d.dot(up)))) * R < radius + margin;
  };
}
