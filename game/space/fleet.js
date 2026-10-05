import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { segmentSphereHitTime } from '../engine/math.js';
import { createGlow } from '../world/space.js';

/**
 * The Static: hostile craft in deep space, everything they fire, and the
 * Aster's own bolts and missiles. Plain steering AI tuned for readable
 * dogfights: glitches dive in and break off, spikes ram, jammers circle and
 * spray, and the Dissonance (a carrier) hides its core behind four amps.
 * Projectiles are instanced, so a busy fight stays a handful of draw calls.
 */
export const STATIC = Object.freeze({
  glitch: { name: 'Glitch', hp: 120, radius: 7, speed: 340, turn: 2.0, range: 1200, fire: 1.5, burst: 4, damage: 5, boltSpeed: 950, weight: 0.35, charge: 0.06 },
  spike: { name: 'Spike', hp: 70, radius: 5, speed: 400, turn: 2.6, damage: 26, blast: 55, weight: 0.3, charge: 0.05 },
  jammer: { name: 'Jammer', hp: 420, radius: 13, speed: 210, turn: 1.0, range: 1600, fire: 2.4, spread: 5, damage: 7, boltSpeed: 560, orbit: 750, weight: 0.6, charge: 0.1 },
  boss: { name: 'The Dissonance', core: 3200, node: 900, radius: 190, speed: 40, damage: 11, boltSpeed: 600, weight: 1, charge: 0.4 },
});
const PLAYER_BOLT = { speed: 1500, life: 1.35 };
const MISSILE = { speed: 1300, accel: 1100, turn: 3.4, life: 5, splash: 55 };
const NODE_OFFSETS = [[130, 0, 0], [-130, 0, 0], [0, 130, 0], [0, -130, 0]];

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _s = new THREE.Vector3(1, 1, 1), _axis = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1), Y = new THREE.Vector3(0, 1, 0);

/** Where to aim so a shot of `speed` meets a target moving at `velocity`. */
export function leadPoint(origin, target, velocity, speed, out = new THREE.Vector3()) {
  const dx = target.x - origin.x, dy = target.y - origin.y, dz = target.z - origin.z;
  const a = velocity.lengthSq() - speed * speed, b = 2 * (dx * velocity.x + dy * velocity.y + dz * velocity.z), c = dx * dx + dy * dy + dz * dz;
  let t = -1;
  if (Math.abs(a) < 1e-6) t = b < 0 ? -c / b : -1;
  else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc), t1 = (-b - s) / (2 * a), t2 = (-b + s) / (2 * a);
      t = Math.min(t1 > 0 ? t1 : Infinity, t2 > 0 ? t2 : Infinity);
    }
  }
  if (!(t > 0) || !Number.isFinite(t)) t = Math.sqrt(c) / speed;
  t = Math.min(t, 4);
  return out.set(target.x + velocity.x * t, target.y + velocity.y * t, target.z + velocity.z * t);
}

/** Rotates unit vector `dir` toward unit vector `target` by at most `maxAngle` radians. */
export function turnToward(dir, target, maxAngle) {
  const angle = Math.acos(THREE.MathUtils.clamp(dir.dot(target), -1, 1));
  if (angle <= maxAngle) return dir.copy(target);
  _axis.crossVectors(dir, target);
  if (_axis.lengthSq() < 1e-12) { _axis.set(-dir.y, dir.x, 0); if (_axis.lengthSq() < 1e-12) _axis.set(0, -dir.z, dir.y); }
  return dir.applyAxisAngle(_axis.normalize(), maxAngle).normalize();
}

/* ------------------------------------------------------------------ models */
function loft(profiles, sides = 6) {
  const vertices = [], indices = [];
  for (const [z, w, h, y = 0] of profiles) for (let i = 0; i < sides; i++) { const a = i / sides * Math.PI * 2 + Math.PI / 6; vertices.push(Math.cos(a) * w, Math.sin(a) * h + y, z); }
  for (let r = 0; r < profiles.length - 1; r++) for (let i = 0; i < sides; i++) { const a = r * sides + i, b = r * sides + (i + 1) % sides; indices.push(a, b, b + sides, a, b + sides, a + sides); }
  for (let i = 1; i < sides - 1; i++) { indices.push(0, i + 1, i); const base = (profiles.length - 1) * sides; indices.push(base, base + i, base + i + 1); }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setIndex(indices);
  return geometry;
}
/** Flat-shaded union of parts (one draw call per material). */
function merged(parts) {
  const geometry = mergeGeometries(parts.map(g => { const n = g.index ? g.toNonIndexed() : g; n.deleteAttribute('uv'); n.deleteAttribute('normal'); return n; }));
  geometry.computeVertexNormals();
  return geometry;
}
const radial = (geometry, k, count = 4, offset = Math.PI / 4) => geometry.rotateZ(offset + k * Math.PI * 2 / count);

function buildModels() {
  const dark = new THREE.MeshStandardMaterial({ color: '#1d1524', metalness: 0.6, roughness: 0.36, flatShading: true });
  const plate = new THREE.MeshStandardMaterial({ color: '#4a3150', metalness: 0.5, roughness: 0.42, flatShading: true });
  const hot = color => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 3, roughness: 0.4 });
  const red = hot('#ff3d6e'), orange = hot('#ff7a45'), violet = hot('#c04dff');
  const models = {};

  // Glitch: an X-finned dart with hot fin tips.
  const glitch = new THREE.Group();
  glitch.add(new THREE.Mesh(merged([loft([[-5.4, 0.05, 0.05], [-3.1, 0.82, 0.5], [0.5, 1.35, 0.78], [3.6, 0.95, 0.52], [4.4, 0.4, 0.26]]),
    ...[0, 1, 2, 3].map(k => radial(new THREE.BoxGeometry(0.16, 3.6, 2.8).translate(0, 2.3, 1.4), k))]), dark));
  glitch.add(new THREE.Mesh(merged([...[0, 1, 2, 3].map(k => radial(new THREE.BoxGeometry(0.24, 0.24, 2.4).translate(0, 4.05, 2.2), k)), new THREE.SphereGeometry(0.5, 8, 6).translate(0, 0.4, -2.6)]), red));
  const exhaust = createGlow('#ff3d6e', 11, 0.95); exhaust.position.set(0, 0, 4.9); glitch.add(exhaust);
  models.glitch = glitch;

  // Spike: a spined mine that rams.
  const phi = (1 + Math.sqrt(5)) / 2, dirs = [[0, 1, phi], [0, -1, phi], [0, 1, -phi], [0, -1, -phi], [1, phi, 0], [-1, phi, 0], [1, -phi, 0], [-1, -phi, 0], [phi, 0, 1], [-phi, 0, 1], [phi, 0, -1], [-phi, 0, -1]];
  const spike = new THREE.Group();
  spike.add(new THREE.Mesh(merged(dirs.map(d => new THREE.ConeGeometry(0.6, 3, 5).translate(0, 3.2, 0).applyQuaternion(_q.setFromUnitVectors(Y, _a.set(...d).normalize())))), dark));
  const spikeCore = new THREE.Mesh(new THREE.IcosahedronGeometry(2.4, 0), orange); spikeCore.name = 'core'; spike.add(spikeCore);
  spike.add(createGlow('#ff7a45', 17, 0.95));
  models.spike = spike;

  // Jammer: a hex gunship with three prongs and a spinning emitter ring.
  const jammer = new THREE.Group();
  jammer.add(new THREE.Mesh(merged([new THREE.CylinderGeometry(4.6, 6.2, 2.6, 6).rotateX(Math.PI / 2),
    ...[0, 1, 2].map(k => radial(new THREE.BoxGeometry(0.8, 0.8, 7).translate(0, 4.4, -2.6), k, 3, 0))]), plate));
  jammer.add(new THREE.Mesh(merged([0, 1, 2].map(k => radial(new THREE.BoxGeometry(1.1, 1.1, 1.4).translate(0, 4.4, -6.6), k, 3, 0))), violet));
  const jamRing = new THREE.Mesh(new THREE.TorusGeometry(8.6, 0.5, 6, 36), violet); jamRing.name = 'ring'; jammer.add(jamRing);
  jammer.add(createGlow('#c04dff', 24, 0.9));
  models.jammer = jammer;

  // The Dissonance: a carrier whose core hides behind four amps and a shield.
  const boss = new THREE.Group();
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(40, 1), hot('#ff2d55')); core.name = 'core'; boss.add(core);
  const cage = new THREE.Group(); cage.name = 'cage'; boss.add(cage);
  for (let i = 0; i < 3; i++) { const ring = new THREE.Mesh(new THREE.TorusGeometry(64, 3.5, 6, 48), dark); ring.rotation.set(i * 1.05, i * 0.6, 0); cage.add(ring); }
  const halo = new THREE.Group(); halo.name = 'halo'; boss.add(halo);
  halo.add(new THREE.Mesh(new THREE.TorusGeometry(162, 7, 8, 96), dark), new THREE.Mesh(new THREE.TorusGeometry(178, 2.4, 6, 96), red));
  NODE_OFFSETS.forEach((offset, i) => {
    const node = new THREE.Group(); node.name = `node${i}`; node.position.fromArray(offset); boss.add(node);
    node.add(new THREE.Mesh(new THREE.BoxGeometry(30, 38, 24), dark));
    node.add(new THREE.Mesh(new THREE.CylinderGeometry(10, 13, 5, 18).rotateX(Math.PI / 2).translate(0, 0, -13), red));
    node.add(createGlow('#ff3d6e', 46, 0.8));
  });
  const shield = new THREE.Mesh(new THREE.SphereGeometry(80, 32, 16), new THREE.MeshBasicMaterial({ color: '#ff3d8a', transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  shield.name = 'shield'; boss.add(shield);
  boss.add(createGlow('#ff2d55', 300, 0.65));
  models.boss = boss;

  models.missile = new THREE.Group();
  models.missile.add(new THREE.Mesh(new THREE.ConeGeometry(0.7, 3.4, 6).rotateX(-Math.PI / 2), hot('#c9fff4')));
  models.missile.add(createGlow('#8cf0d1', 9, 0.95));
  return models;
}

/** Instanced projectiles of one kind. */
class Bolts {
  constructor(parent, geometry, color, capacity) {
    this.mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), capacity);
    this.mesh.frustumCulled = false; this.mesh.count = 0; parent.add(this.mesh);
    this.items = []; this.capacity = capacity;
  }
  add(position, velocity, life, damage) {
    if (this.items.length >= this.capacity) this.items.shift();
    this.items.push({ position: position.clone(), velocity: velocity.clone(), life, damage });
  }
  /** Moves every bolt; `hit(bolt, start, end)` returns true to remove it. */
  update(dt, hit) {
    let n = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const bolt = this.items[i], start = _d.copy(bolt.position);
      bolt.position.addScaledVector(bolt.velocity, dt);
      bolt.life -= dt;
      if (bolt.life <= 0 || hit(bolt, start, bolt.position)) { this.items.splice(i, 1); continue; }
    }
    for (const bolt of this.items) {
      _q.setFromUnitVectors(Z, _e.copy(bolt.velocity).normalize());
      this.mesh.setMatrixAt(n++, _m.compose(bolt.position, _q, _s));
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear() { this.items.length = 0; this.mesh.count = 0; }
}

export class SpaceFleet {
  /**
   * @param {THREE.Scene} scene
   * @param {object} o { fx (space-scale FX), sound, scenery (rocks), events:
   *   { onHit(e, amount, at), onKill(e, cause), onShipHit(amount, at, kind), onBossPhase(e, phase), onPartDestroyed(e, part), onShieldBlock(at), onExplosion(at, size) } }
   */
  constructor(scene, { fx, sound = null, scenery = null, events = {}, random = Math.random } = {}) {
    Object.assign(this, { fx, sound, scenery, events, random });
    this.group = new THREE.Group(); this.group.name = 'static-fleet'; scene.add(this.group);
    this.models = buildModels();
    this.enemies = []; this.missiles = []; this.waves = [];
    this.playerBolts = new Bolts(this.group, new THREE.CylinderGeometry(0.32, 0.32, 16, 6).rotateX(Math.PI / 2), '#b8fff1', 420);
    this.enemyBolts = new Bolts(this.group, new THREE.CylinderGeometry(0.55, 0.55, 12, 6).rotateX(Math.PI / 2), '#ff5a4d', 360);
    this.orbs = new Bolts(this.group, new THREE.IcosahedronGeometry(2.6, 1), '#ff4dd2', 360);
    this.waveGeo = new THREE.SphereGeometry(1, 40, 20);
    this.nextId = 1;
  }

  /* ------------------------------------------------------------ roster */
  spawn(type, position, { tier = 1, tag = 'rift', toward = null, color = '#ff4d6d' } = {}) {
    const def = STATIC[type]; if (!def) return null;
    const mesh = this.models[type].clone(); mesh.position.copy(position);
    this.group.add(mesh);
    const forward = (toward ? _a.copy(toward).sub(position) : _a.set(this.random() - 0.5, this.random() - 0.5, this.random() - 0.5)).normalize();
    if (forward.lengthSq() < 0.5) forward.set(0, 0, -1);
    const scale = tier - 1;
    const e = {
      id: this.nextId++, type, def, tag, mesh, tier, dead: false,
      position: position.clone(), velocity: new THREE.Vector3(), forward: forward.clone(), up: new THREE.Vector3(0, 1, 0), bank: 0,
      radius: def.radius, hpScale: 1 + scale * 0.18, dmgScale: 1 + scale * 0.12, rate: 1 + scale * 0.08, speedScale: 1 + scale * 0.04,
      state: 'attack', timer: 0, fireTimer: 1 + this.random() * 1.5, burstLeft: 0, burstTimer: 0, strafe: this.random() < 0.5 ? -1 : 1, lastRam: -9,
      breakDir: new THREE.Vector3(),
    };
    if (type === 'boss') {
      e.home = position.clone(); e.orbit = 0; e.phase = 1; e.escortTimer = 6; e.spiral = { on: false, timer: 4, angle: 0, shot: 0 }; e.pulseTimer = 8; e.dying = 0;
      e.parts = [
        { name: 'core', object: mesh.getObjectByName('core'), radius: 46, hp: def.core * e.hpScale, max: def.core * e.hpScale, dead: false, world: new THREE.Vector3() },
        ...NODE_OFFSETS.map((_, i) => ({ name: `node${i}`, object: mesh.getObjectByName(`node${i}`), radius: 26, hp: def.node * e.hpScale, max: def.node * e.hpScale, dead: false, world: new THREE.Vector3(), fireTimer: 1.2 + i * 0.6 })),
      ];
      e.shield = mesh.getObjectByName('shield'); e.shield.material = e.shield.material.clone();
      e.maxHp = e.parts.reduce((n, p) => n + p.max, 0); e.hp = e.maxHp;
      this.#placeParts(e);
    } else e.hp = e.maxHp = def.hp * e.hpScale;
    this.enemies.push(e);
    this.fx.flash(position, color, type === 'boss' ? 900 : 70, 0.45);
    this.fx.ring(position, forward, color, type === 'boss' ? 420 : 40, 0.6);
    return e;
  }
  count(tag) { let n = 0; for (const e of this.enemies) if (!e.dead && (!tag || e.tag === tag)) n++; return n; }
  /** Removes a group of enemies without rewards (retreat, respawn). */
  despawn(tag) { for (const e of [...this.enemies]) if (!tag || e.tag === tag) this.#remove(e); }
  clear() {
    this.despawn();
    this.playerBolts.clear(); this.enemyBolts.clear(); this.orbs.clear();
    for (const m of this.missiles) this.group.remove(m.mesh);
    for (const w of this.waves) this.group.remove(w.mesh);
    this.missiles.length = 0; this.waves.length = 0;
  }
  get boss() { return this.enemies.find(e => e.type === 'boss' && !e.dead) || null; }
  get threat() { let t = 0; for (const e of this.enemies) if (!e.dead) t += e.def.weight; return Math.min(1, t); }
  #remove(e) {
    e.dead = true; this.group.remove(e.mesh);
    const i = this.enemies.indexOf(e); if (i >= 0) this.enemies.splice(i, 1);
  }

  /** Every damageable point (enemies, boss parts) for aiming and the HUD. */
  *targets() {
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (e.type !== 'boss') yield { enemy: e, part: null, position: e.position, radius: e.radius };
      else for (const part of e.parts) if (!part.dead && (part.name !== 'core' || e.phase === 2)) yield { enemy: e, part, position: part.world, radius: part.radius };
    }
  }
  /** The target nearest the aim ray within `maxAngle` (radians) and `maxDist`. */
  aimTarget(origin, dir, maxAngle = 0.35, maxDist = 2600) {
    let best = null, bestAngle = maxAngle;
    for (const t of this.targets()) {
      const to = _a.copy(t.position).sub(origin), d = to.length();
      if (d > maxDist || d < 1) continue;
      const angle = Math.acos(THREE.MathUtils.clamp(to.dot(dir) / d, -1, 1));
      if (angle < bestAngle) { bestAngle = angle; best = { ...t, angle, distance: d }; }
    }
    return best;
  }
  velocityOf(enemy) { return enemy.type === 'boss' ? _c.set(0, 0, 0) : enemy.velocity; }

  /* ------------------------------------------------------------ the Aster's weapons */
  firePlayer(origin, dir, damage, shipVelocity) {
    const velocity = _b.copy(dir).multiplyScalar(PLAYER_BOLT.speed);
    if (shipVelocity) velocity.addScaledVector(dir, Math.max(0, shipVelocity.dot(dir)));
    this.playerBolts.add(origin, velocity, PLAYER_BOLT.life, damage);
  }
  fireMissile(origin, velocity, target, damage) {
    const mesh = this.models.missile.clone(); mesh.position.copy(origin); this.group.add(mesh);
    this.missiles.push({ mesh, position: origin.clone(), velocity: velocity.clone(), speed: velocity.length(), target, damage, life: MISSILE.life });
  }
  /** Damage everything within `radius` (The Drop, Reverb). */
  blast(center, radius, damage, cause = 'blast') {
    let hits = 0;
    for (const t of [...this.targets()]) {
      const d = t.position.distanceTo(center);
      if (d > radius + t.radius) continue;
      hits++;
      this.damage(t.enemy, damage * (t.part ? 0.7 : 1), t.position, { part: t.part, cause });
    }
    return hits;
  }

  /* ------------------------------------------------------------ damage */
  damage(e, amount, at, { part = null, cause = 'bolt' } = {}) {
    if (e.dead || amount <= 0) return 0;
    if (e.type === 'boss') return this.#damageBoss(e, amount, at, part, cause);
    e.hp -= amount;
    this.events.onHit?.(e, amount, at);
    if (e.hp <= 0) this.#kill(e, cause);
    return amount;
  }
  #damageBoss(e, amount, at, part, cause) {
    if (e.dying) return 0;
    if (!part) { let best = Infinity; for (const p of e.parts) if (!p.dead) { const d = p.world.distanceTo(at); if (d < best) { best = d; part = p; } } }
    if (!part || part.dead) return 0;
    if (part.name === 'core' && e.phase === 1) { e.shieldFlash = 1; this.events.onShieldBlock?.(at); return 0; }
    part.hp -= amount;
    e.hp = e.parts.reduce((n, p) => n + Math.max(0, p.hp), 0);
    this.events.onHit?.(e, amount, at, part);
    if (part.hp > 0) return amount;
    part.dead = true; part.object.visible = false;
    this.#explode(part.world, part.name === 'core' ? 9 : 5);
    this.events.onPartDestroyed?.(e, part);
    if (part.name === 'core') { e.dying = 1.8; e.dyingCause = cause; }
    else if (e.parts.every(p => p.name === 'core' || p.dead)) { e.phase = 2; e.shield.visible = false; this.events.onBossPhase?.(e, 2); }
    return amount;
  }
  #kill(e, cause) {
    this.#explode(e.position, e.type === 'boss' ? 14 : e.type === 'jammer' ? 3 : 2);
    this.#remove(e);
    this.events.onKill?.(e, cause);
  }
  #explode(at, size) {
    this.fx.flash(at, '#ffd2b0', 26 * size, 0.35);
    this.fx.ring(at, _a.set(this.random() - 0.5, this.random() - 0.5, this.random() - 0.5).normalize(), '#ff7a5c', 14 * size, 0.6);
    this.fx.sparks(at, '#ffb38a', Math.min(26, 8 + size * 2), 28 * size);
    this.sound?.play('boom', { pitch: Math.max(0.5, 1.25 - size * 0.06), volume: Math.min(1.4, 0.5 + size * 0.1) });
    this.events.onExplosion?.(at, size);
  }

  /* ------------------------------------------------------------ simulation */
  /**
   * @param {object} ctx { ship: { position, velocity, radius, evading, ram }, hitShip(amount, at, kind) }
   */
  update(dt, time, ctx) {
    const ship = ctx.ship;
    this.time = time;
    for (const e of [...this.enemies]) {
      if (e.dead) continue;
      if (e.type === 'boss') this.#boss(e, dt, time, ship, ctx);
      else { this.#think(e, dt, ship, ctx); if (!e.dead) this.#ram(e, ship, ctx, time); }
      if (!e.dead) this.#pose(e, dt, time);
    }
    this.playerBolts.update(dt, (bolt, start, end) => this.#playerBoltHit(bolt, start, end));
    const hostile = (bolt, start, end) => this.#hostileBoltHit(bolt, start, end, ship, ctx);
    this.enemyBolts.update(dt, hostile);
    this.orbs.update(dt, hostile);
    this.#updateMissiles(dt);
    this.#updateWaves(dt, ship, ctx);
  }

  #think(e, dt, ship, ctx) {
    const def = e.def, toShip = _a.copy(ship.position).sub(e.position), dist = toShip.length();
    const desired = _b.set(0, 0, 0);
    let speed = def.speed * e.speedScale;
    if (e.type === 'glitch') {
      if (e.state === 'break') {
        desired.copy(e.breakDir); speed *= 1.15;
        if ((e.timer -= dt) <= 0) e.state = 'attack';
      } else {
        leadPoint(e.position, ship.position, ship.velocity, def.boltSpeed, _c);
        desired.copy(_c).sub(e.position).normalize();
        this.#gunnery(e, dt, dist, desired, def.boltSpeed);
        // Jink while closing in, so they are never a sitting target.
        if (dist < 1100) {
          const right = _d.crossVectors(e.forward, e.up).normalize(), t = this.time * 2.1 + e.id * 1.7;
          desired.addScaledVector(e.up, Math.sin(t) * 0.45).addScaledVector(right, Math.cos(t * 0.8) * 0.45);
        }
        if (dist < 240) { // overshoot: break off to a random side, then come around
          e.state = 'break'; e.timer = 1.1 + this.random() * 0.9;
          e.breakDir.set(this.random() - 0.5, this.random() - 0.5, this.random() - 0.5).addScaledVector(toShip, -0.6 / dist).normalize();
        }
      }
    } else if (e.type === 'spike') {
      leadPoint(e.position, ship.position, ship.velocity, speed * 1.4, _c);
      desired.copy(_c).sub(e.position).normalize();
      if (dist < 700) speed *= 1.5;
      if (dist < def.radius + ship.radius + 5) { this.#detonate(e, ship, ctx); return; }
    } else if (e.type === 'jammer') {
      const out = _c.copy(toShip).multiplyScalar(-1 / Math.max(dist, 1));
      desired.crossVectors(out, e.up).normalize().multiplyScalar(e.strafe).addScaledVector(out, THREE.MathUtils.clamp((def.orbit - dist) / 400, -1, 1));
      e.fireTimer -= dt * e.rate;
      if (e.fireTimer <= 0 && dist < def.range) {
        e.fireTimer = def.fire * (0.85 + this.random() * 0.3);
        leadPoint(e.position, ship.position, ship.velocity, def.boltSpeed, _d);
        const aim = _e.copy(_d).sub(e.position).normalize(), side = _a.crossVectors(aim, e.up).normalize();
        for (let i = 0; i < def.spread; i++) {
          const dir = aim.clone().applyAxisAngle(e.up, (i - (def.spread - 1) / 2) * 0.09).addScaledVector(side, (this.random() - 0.5) * 0.02).normalize();
          this.orbs.add(e.position, dir.multiplyScalar(def.boltSpeed), 3.4, def.damage * e.dmgScale);
        }
        this.#enemySound(dist, 0.6);
      }
    }
    // Keep apart, and around the rocks.
    for (const o of this.enemies) {
      if (o === e || o.dead || o.type === 'boss') continue;
      const d = e.position.distanceTo(o.position);
      if (d < 70 && d > 1e-3) desired.addScaledVector(_a.copy(e.position).sub(o.position), (70 - d) / 70 / d * 0.8);
    }
    this.scenery?.avoid(e.position, e.radius + 45, desired);
    if (desired.lengthSq() < 1e-8) desired.copy(e.forward); else desired.normalize();
    _e.copy(e.forward);
    turnToward(e.forward, desired, def.turn * e.speedScale * dt);
    e.turnRate = _e.cross(e.forward).dot(e.up) / Math.max(dt, 1e-4);
    e.velocity.copy(e.forward).multiplyScalar(speed);
    e.position.addScaledVector(e.velocity, dt);
  }

  /** Glitch bursts: three quick shots when the target is in the cone. */
  #gunnery(e, dt, dist, aimDir, speed) {
    const def = e.def;
    if (e.burstLeft > 0) {
      if ((e.burstTimer -= dt) > 0) return;
      const dir = _d.copy(aimDir).add(_e.set(this.random() - 0.5, this.random() - 0.5, this.random() - 0.5).multiplyScalar(0.035)).normalize();
      this.enemyBolts.add(e.position, dir.multiplyScalar(speed), 2.2, def.damage * e.dmgScale);
      e.burstLeft--; e.burstTimer = 0.09;
      if (e.burstLeft === def.burst - 1) this.#enemySound(dist, 0.8);
      return;
    }
    e.fireTimer -= dt * e.rate;
    if (e.fireTimer <= 0 && dist < def.range && e.forward.dot(aimDir) > Math.cos(0.16)) {
      e.burstLeft = def.burst; e.burstTimer = 0; e.fireTimer = def.fire * (0.8 + this.random() * 0.45);
    }
  }
  #enemySound(dist, pitch) { if (dist < 900) this.sound?.play('fire', { tier: 1, volume: 0.22, pitch }); }

  #detonate(e, ship, ctx) {
    const def = e.def;
    if (!ship.evading) ctx.hitShip?.(def.damage * e.dmgScale, e.position, 'ram');
    this.#explode(e.position, 3);
    this.#remove(e);
    this.events.onKill?.(e, 'detonate');
  }
  #ram(e, ship, ctx, time) {
    const reach = e.radius + ship.radius;
    if (e.position.distanceToSquared(ship.position) > reach * reach || time - e.lastRam < 0.5) return;
    if (e.type === 'spike') { this.#detonate(e, ship, ctx); return; } // one hit, not a scrape and then a blast
    e.lastRam = time;
    _a.copy(e.position).sub(ship.position).setLength(reach + 2);
    e.position.copy(ship.position).add(_a);
    if (ship.ram) { this.damage(e, 450, e.position, { cause: 'ram' }); return; }
    if (!ship.evading) ctx.hitShip?.(12, e.position, 'ram');
    this.damage(e, 60, e.position, { cause: 'ram' });
  }

  #pose(e, dt, time) {
    // Keep a stable "up", bank into turns.
    e.up.addScaledVector(e.forward, -e.up.dot(e.forward));
    if (e.up.lengthSq() < 1e-6) e.up.set(0, 1, 0).addScaledVector(e.forward, -e.forward.y);
    e.up.normalize();
    if (e.type !== 'boss') {
      e.bank = THREE.MathUtils.damp(e.bank, THREE.MathUtils.clamp(-(e.turnRate || 0) * 0.6, -1.1, 1.1), 6, dt);
      const right = _a.crossVectors(e.forward, e.up).normalize();
      _m.makeBasis(right, e.up, _b.copy(e.forward).negate());
      e.mesh.quaternion.setFromRotationMatrix(_m).multiply(_q.setFromAxisAngle(Z, e.bank));
      e.mesh.position.copy(e.position);
      if (e.type === 'spike') e.mesh.getObjectByName('core')?.scale.setScalar(1 + Math.sin(time * 14 + e.id) * 0.18);
      if (e.type === 'jammer') { const ring = e.mesh.getObjectByName('ring'); if (ring) ring.rotation.z += dt * 2.4; }
    }
  }

  /* ------------------------------------------------------------ the Dissonance */
  #placeParts(e) {
    e.mesh.updateMatrixWorld(true);
    for (const part of e.parts) part.object.getWorldPosition(part.world);
  }
  #boss(e, dt, time, ship, ctx) {
    const def = e.def;
    // Drift on a slow circle around the rift, always turning to face the Aster.
    e.orbit += dt * 0.05;
    _a.set(Math.cos(e.orbit) * 300, Math.sin(e.orbit * 0.7) * 120, Math.sin(e.orbit) * 300).add(e.home);
    e.position.lerp(_a, 1 - Math.exp(-dt * 0.5));
    e.mesh.position.copy(e.position);
    _m.lookAt(e.position, ship.position, Y); // -Z toward the ship
    e.mesh.quaternion.slerp(_q.setFromRotationMatrix(_m), 1 - Math.exp(-dt * 0.6));
    e.mesh.getObjectByName('cage').rotation.y += dt * 0.5;
    e.mesh.getObjectByName('halo').rotation.z += dt * 0.12;
    this.#placeParts(e);
    const core = e.parts[0], dist = ship.position.distanceTo(e.position);
    e.shieldFlash = Math.max(0, (e.shieldFlash || 0) - dt * 3);
    if (e.shield.visible) e.shield.material.opacity = 0.1 + e.shieldFlash * 0.4 + Math.sin(time * 3) * 0.03;
    if (e.dying) {
      e.dying -= dt;
      if (this.random() < dt * 9) this.#explode(_a.copy(e.position).add(_b.set(this.random() - 0.5, this.random() - 0.5, this.random() - 0.5).multiplyScalar(320)), 4 + this.random() * 4);
      if (e.dying <= 0) this.#kill(e, e.dyingCause || 'bolt');
      return;
    }
    if (e.phase === 1) {
      for (const node of e.parts) {
        if (node.dead || node.name === 'core') continue;
        node.fireTimer -= dt * e.rate;
        if (node.fireTimer > 0 || dist > 2600) continue;
        node.fireTimer = 2.4;
        leadPoint(node.world, ship.position, ship.velocity, def.boltSpeed, _c);
        const aim = _d.copy(_c).sub(node.world).normalize(), side = _e.crossVectors(aim, Y).normalize();
        for (let i = -1; i <= 1; i++) this.orbs.add(node.world, aim.clone().addScaledVector(side, i * 0.07).normalize().multiplyScalar(def.boltSpeed), 4, def.damage * e.dmgScale);
        this.#enemySound(dist, 0.5);
      }
      if ((e.escortTimer -= dt) <= 0) {
        e.escortTimer = 12;
        if (this.enemies.filter(x => x.tag === e.tag && x.type === 'glitch').length < 4) {
          for (const s of [-1, 1]) this.spawn('glitch', _a.copy(e.position).addScaledVector(_b.set(s, 0.3, 0.2).normalize(), 260), { tier: e.tier, tag: e.tag, toward: ship.position });
        }
      }
      return;
    }
    // Phase 2: the core is open. Spirals of feedback, and pulses to outrun or roll through.
    const sp = e.spiral;
    sp.timer -= dt;
    if (sp.on) {
      sp.shot -= dt;
      if (sp.shot <= 0) {
        sp.shot = 0.15 / e.rate; sp.angle += 0.31;
        const fwd = _a.set(0, 0, -1).applyQuaternion(e.mesh.quaternion), right = _b.set(1, 0, 0).applyQuaternion(e.mesh.quaternion), up = _c.set(0, 1, 0).applyQuaternion(e.mesh.quaternion);
        for (let k = 0; k < 6; k++) {
          const a = sp.angle + k * Math.PI / 3;
          const dir = _d.copy(fwd).multiplyScalar(0.55).addScaledVector(right, Math.cos(a)).addScaledVector(up, Math.sin(a)).normalize();
          this.orbs.add(core.world, dir.multiplyScalar(def.boltSpeed * 0.8), 4.5, def.damage * e.dmgScale);
        }
      }
      if (sp.timer <= 0) { sp.on = false; sp.timer = 2.2; }
    } else if (sp.timer <= 0) { sp.on = true; sp.timer = 3.2; sp.shot = 0; this.#enemySound(dist, 0.4); }
    e.pulseTimer -= dt;
    core.object.scale.setScalar(1 + Math.max(0, 1.2 - e.pulseTimer) * 0.35); // the telegraph: the core swells
    if (e.pulseTimer <= 0) {
      e.pulseTimer = 9.5;
      const mesh = new THREE.Mesh(this.waveGeo, new THREE.MeshBasicMaterial({ color: '#ff3d6e', transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
      mesh.position.copy(core.world); this.group.add(mesh);
      this.waves.push({ mesh, center: core.world.clone(), r: 0, speed: 760, max: 1900, damage: 24 * e.dmgScale, hit: false });
      this.sound?.play('bossRoar', { volume: 0.8 });
    }
  }
  #updateWaves(dt, ship, ctx) {
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i], before = w.r;
      w.r += w.speed * dt;
      const d = ship.position.distanceTo(w.center);
      if (!w.hit && d >= before - 30 && d <= w.r + 30) { w.hit = true; if (!ship.evading) ctx.hitShip?.(w.damage, ship.position, 'wave'); }
      w.mesh.scale.setScalar(Math.max(1, w.r));
      w.mesh.material.opacity = 0.35 * (1 - w.r / w.max);
      if (w.r >= w.max) { this.group.remove(w.mesh); w.mesh.material.dispose(); this.waves.splice(i, 1); }
    }
  }

  /* ------------------------------------------------------------ projectiles */
  #playerBoltHit(bolt, start, end) {
    let best = null, bestT = Infinity;
    for (const t of this.targets()) {
      const hit = segmentSphereHitTime(start, end, t.position, t.radius * (t.part ? 1.1 : 1.3));
      if (hit !== null && hit < bestT) { bestT = hit; best = t; }
    }
    // The boss's shield takes hits for its core while the amps stand.
    const boss = this.boss;
    if (boss && boss.phase === 1 && !boss.dying) {
      const hit = segmentSphereHitTime(start, end, boss.parts[0].world, 80);
      if (hit !== null && hit < bestT) { boss.shieldFlash = 1; this.fx.sparks(_a.copy(start).lerp(end, hit), '#ff8ab4', 4, 60); return true; }
    }
    if (best) {
      const at = _a.copy(start).lerp(end, bestT);
      this.fx.sparks(at, '#bafff0', 4, 60);
      this.damage(best.enemy, bolt.damage, at.clone(), { part: best.part });
      return true;
    }
    const rock = this.scenery?.segmentHit(start, end);
    if (rock) { this.fx.sparks(rock, '#d9c8ff', 3, 40); return true; }
    return false;
  }
  #hostileBoltHit(bolt, start, end, ship, ctx) {
    if (!ship.evading && segmentSphereHitTime(start, end, ship.position, ship.radius + 2) !== null) {
      ctx.hitShip?.(bolt.damage, end.clone(), 'bolt');
      return true;
    }
    return Boolean(this.scenery?.segmentHit(start, end));
  }
  #updateMissiles(dt) {
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      if (!m.target || m.target.enemy.dead || (m.target.part && m.target.part.dead)) m.target = this.#nearestTarget(m.position, 3200);
      const dir = _a.copy(m.velocity).normalize();
      if (m.target) {
        leadPoint(m.position, m.target.position, this.velocityOf(m.target.enemy), Math.max(m.speed, 600), _b);
        turnToward(dir, _b.sub(m.position).normalize(), MISSILE.turn * dt);
      }
      m.speed = Math.min(MISSILE.speed, m.speed + MISSILE.accel * dt);
      m.velocity.copy(dir).multiplyScalar(m.speed);
      const start = _c.copy(m.position);
      m.position.addScaledVector(m.velocity, dt);
      m.life -= dt;
      let hit = m.life <= 0 || Boolean(this.scenery?.segmentHit(start, m.position));
      if (!hit) for (const t of this.targets()) if (segmentSphereHitTime(start, m.position, t.position, t.radius + 10) !== null) { hit = true; break; }
      m.mesh.position.copy(m.position);
      m.mesh.quaternion.setFromUnitVectors(_d.set(0, 0, -1), dir);
      if (!hit) continue;
      this.fx.flash(m.position, '#c9fff4', 60, 0.25);
      this.fx.ring(m.position, dir, '#8cf0d1', 40, 0.45);
      if (m.life > 0) this.blast(m.position, MISSILE.splash, m.damage, 'missile');
      this.sound?.play('boom', { pitch: 1.3, volume: 0.6 });
      this.group.remove(m.mesh);
      this.missiles.splice(i, 1);
    }
  }
  #nearestTarget(from, maxDist) {
    let best = null, bestD = maxDist;
    for (const t of this.targets()) { const d = t.position.distanceTo(from); if (d < bestD) { bestD = d; best = t; } }
    return best;
  }
}
