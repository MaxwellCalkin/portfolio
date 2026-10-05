import * as THREE from 'three';
import { loadModel } from '../engine/assets.js';
import { createGlow } from '../world/space.js';
import { boxColliderFromMesh } from './physics.js';

/**
 * The Aster: arcade flight that is forgiving near the ground and fast in
 * deep space, with automated landing/takeoff so visitors never have to fight
 * the controls to reach a world.
 */
export const FLIGHT = Object.freeze({
  atmoMax: 230, atmoBoost: 460, spaceMax: 1800, pulseMax: 14000,
  accel: 90, boostAccel: 260, pulseAccel: 5200, brake: 160,
  pitchRate: 1.35, yawRate: 1.1, rollRate: 2.6, mouseRate: 0.0021,
  minClearance: 6,
});

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();

export class Ship {
  static async load() { return new Ship(await loadModel('ship.glb')); }

  constructor(gltf) {
    this.object = new THREE.Group(); this.object.name = 'ship';
    this.model = gltf.scene; this.model.rotation.y = Math.PI; // glTF +Z forward -> game -Z forward
    this.object.add(this.model);
    this.model.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.userData.shipStyled) continue; m.userData.shipStyled = true;
        if (m.name === 'Glow') { m.emissive = new THREE.Color('#8cf0d1'); m.emissiveIntensity = 2.8; }
        if (m.name === 'Glass') { m.roughness = 0.06; m.metalness = 0.5; m.emissive = new THREE.Color('#0a3036'); m.emissiveIntensity = 0.6; }
        if (m.name === 'HullDark') m.color.set('#22304a');
        if (m.name === 'Metal') { m.metalness = 0.65; m.roughness = 0.35; }
      }
    });
    this.engines = ['Engine_L', 'Engine_R'].map(n => this.model.getObjectByName(n)).filter(Boolean);
    this.muzzles = ['Muzzle_L', 'Muzzle_R'].map(n => this.model.getObjectByName(n)).filter(Boolean);
    this.cockpit = this.model.getObjectByName('Cockpit');
    this.boarding = this.model.getObjectByName('Boarding');
    this.flames = this.engines.map(engine => {
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.62, 4, 16, 1, true), new THREE.MeshBasicMaterial({ color: '#8ff7e4', transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      // Engine empties point their local +Z out of the nozzle (glTF); cone along +Z.
      flame.geometry.rotateX(Math.PI / 2); flame.geometry.translate(0, 0, 2);
      engine.add(flame);
      const glow = createGlow('#8cf0d1', 5, 0.9); engine.add(glow);
      return { flame, glow };
    });
    // Landing gear (0 = stowed, 1 = deployed).
    this.mixer = new THREE.AnimationMixer(this.model);
    const clip = gltf.animations.find(a => a.name === 'GearDeploy');
    if (clip) {
      this.gearAction = this.mixer.clipAction(clip); this.gearAction.setLoop(THREE.LoopOnce); this.gearAction.clampWhenFinished = true; this.gearAction.play();
      this.gearDuration = clip.duration;
    }
    this.gear = 1; this.gearTarget = 1;
    this.flameColors = { base: '#8ff7e4', hot: '#d6fff6' };
    this.velocity = new THREE.Vector3();
    this.speed = 0; this.throttle = 0;
    this.state = 'landed'; // landed | takeoff | flying | landing | autopilot
    this.boost = false; this.pulse = false;
    this.surge = 0; // slipstream speed above the cap, decaying
    this.roll = null; this.rollCooldown = 0;
    this.anim = null;
    this.colliderIds = [];
    // A shield bubble that flashes when hits land.
    this.bubble = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: '#8cf0d1', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.bubble.scale.set(8, 4.6, 10); this.bubble.position.y = 2.2; this.bubble.visible = false; this.shieldFlash = 0;
    this.object.add(this.bubble);
    this.#setGear(1);
  }

  #setGear(v) { if (!this.gearAction) return; this.gearAction.time = Math.min(this.gearDuration - 1e-3, Math.max(0, v * this.gearDuration)); this.mixer.update(0); }

  /** Starforged reward: aurora-tinted engines. */
  setAurora(on) {
    this.flameColors = on ? { base: '#c9a6ff', hot: '#ffd6f4' } : { base: '#8ff7e4', hot: '#d6fff6' };
    for (const f of this.flames) f.glow.material.color.set(on ? '#d9b8ff' : '#8cf0d1');
  }

  /** Parks the ship on the ground at `position` (ground point), facing `forward`. */
  park(position, up, forward) {
    this.state = 'landed';
    const back = _v.copy(forward).addScaledVector(up, -forward.dot(up)).normalize().negate();
    const right = _w.crossVectors(up, back).normalize();
    this.object.quaternion.setFromRotationMatrix(_m.makeBasis(right, up, back));
    this.object.position.copy(position);
    this.velocity.set(0, 0, 0); this.speed = 0; this.gear = this.gearTarget = 1; this.#setGear(1);
    this.object.updateMatrixWorld(true);
  }

  /** Box colliders for the parked hull so the agent can't walk through it. */
  registerColliders(world) {
    this.unregisterColliders(world);
    this.object.updateMatrixWorld(true);
    // A simple capsule-ish set: fuselage + wings, from the model bounds.
    const fuselage = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.4, 12.6));
    fuselage.position.set(0, 2.2, -0.4); this.object.add(fuselage); fuselage.updateMatrixWorld(true);
    const wings = new THREE.Mesh(new THREE.BoxGeometry(11, 0.8, 4)); wings.position.set(0, 2.1, 2.4); this.object.add(wings); wings.updateMatrixWorld(true);
    for (const mesh of [fuselage, wings]) { this.colliderIds.push(world.add(boxColliderFromMesh(mesh, 'ship'))); this.object.remove(mesh); mesh.geometry.dispose(); }
    this.colliderWorld = world;
  }
  unregisterColliders(world = this.colliderWorld) { for (const id of this.colliderIds) world?.remove(id); this.colliderIds = []; }

  /** Puts the ship straight into flight at `position`, facing `forward` (respawns, autopilot arrivals). */
  launchAt(position, forward, up = new THREE.Vector3(0, 1, 0), speed = 120) {
    const f = forward.clone().normalize(), u = up.clone().addScaledVector(f, -up.dot(f));
    if (u.lengthSq() < 1e-6) u.set(1, 0, 0).addScaledVector(f, -f.x);
    u.normalize();
    const right = new THREE.Vector3().crossVectors(f, u).normalize();
    this.object.quaternion.setFromRotationMatrix(_m.makeBasis(right, u, f.clone().negate()));
    this.object.position.copy(position);
    this.state = 'flying'; this.anim = null; this.roll = null; this.surge = 0;
    this.speed = speed; this.velocity.copy(f).multiplyScalar(speed);
    this.gear = this.gearTarget = 0; this.#setGear(0);
    this.object.updateMatrixWorld(true);
  }

  /** Slipstream: speed past the cap that bleeds off over a second or two. */
  addSurge(amount) { this.surge = Math.max(this.surge, amount); this.speed += amount * 0.7; }

  /** An evasive barrel roll: a quick sidestep that dodges fire. @returns {boolean} */
  barrelRoll(dir = 1) {
    if (this.state !== 'flying' || this.rollCooldown > 0) return false;
    this.roll = { t: 0, duration: 0.6, dir, angle: 0 };
    this.rollCooldown = 1.9;
    this.velocity.addScaledVector(_v.set(dir, 0, 0).applyQuaternion(this.object.quaternion), 150);
    return true;
  }
  get evading() { return Boolean(this.roll); }
  flashShield(strength = 1) { this.shieldFlash = Math.max(this.shieldFlash, strength); }

  forward(out = new THREE.Vector3()) { return out.set(0, 0, -1).applyQuaternion(this.object.quaternion); }
  up(out = new THREE.Vector3()) { return out.set(0, 1, 0).applyQuaternion(this.object.quaternion); }
  boardingPoint(out = new THREE.Vector3()) { return this.boarding ? this.boarding.getWorldPosition(out) : this.object.localToWorld(out.set(4, 0, 0)); }

  /** Starts an automated vertical takeoff. */
  takeoff(radialUp) {
    if (this.state !== 'landed') return;
    this.state = 'takeoff';
    this.anim = { t: 0, duration: 1.8, from: this.object.position.clone(), up: radialUp.clone() };
    this.gearTarget = 0;
  }

  /**
   * Starts an automated landing at a ground point (world), keeping heading.
   * @param {THREE.Vector3} ground world point on the surface
   * @param {THREE.Vector3} radialUp
   */
  land(ground, radialUp) {
    if (this.state !== 'flying') return false;
    this.state = 'landing';
    const fwd = this.forward(new THREE.Vector3()).addScaledVector(radialUp, -this.forward(_v).dot(radialUp));
    if (fwd.lengthSq() < 1e-4) fwd.copy(this.up(_v)).addScaledVector(radialUp, -_v.dot(radialUp));
    fwd.normalize();
    const back = fwd.clone().negate(), right = new THREE.Vector3().crossVectors(radialUp, back).normalize();
    const endQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, radialUp, back));
    const dist = this.object.position.distanceTo(ground);
    this.anim = { t: 0, duration: THREE.MathUtils.clamp(dist / 55, 2.2, 6), from: this.object.position.clone(), fromQuat: this.object.quaternion.clone(), to: ground.clone(), toQuat: endQuat, up: radialUp.clone() };
    this.velocity.set(0, 0, 0); this.speed = 0;
    return true;
  }

  /**
   * @param {number} dt
   * @param {object} input { pitch, yaw, roll, throttleUp, throttleDown, boost, mouse:{x,y} }
   * @param {object} env { radialUp, altitude, inAtmosphere (0-1), groundRadiusAt(dir), planet, nearestDistance }
   */
  update(dt, input, env) {
    // Gear easing.
    if (Math.abs(this.gear - this.gearTarget) > 1e-3) { this.gear += Math.sign(this.gearTarget - this.gear) * Math.min(Math.abs(this.gearTarget - this.gear), dt * 1.3); this.#setGear(this.gear); }
    this.shieldFlash = Math.max(0, this.shieldFlash - dt * 3);
    this.bubble.visible = this.shieldFlash > 0.01; this.bubble.material.opacity = this.shieldFlash * 0.08;
    this.rollCooldown = Math.max(0, this.rollCooldown - dt);
    this.surge = Math.max(0, this.surge - dt * (180 + this.surge * 0.6));
    if (this.state === 'landed') { this.#flames(0, false); return; }
    if (this.state === 'takeoff') {
      const a = this.anim; a.t += dt; const k = Math.min(1, a.t / a.duration), e = k * k * (3 - 2 * k);
      this.object.position.copy(a.from).addScaledVector(a.up, e * 26);
      this.#flames(0.6, false);
      if (k >= 1) { this.state = 'flying'; this.speed = 30; this.velocity.copy(this.forward(_v)).multiplyScalar(30); this.anim = null; }
      return;
    }
    if (this.state === 'landing') {
      const a = this.anim; a.t += dt; const k = Math.min(1, a.t / a.duration);
      const e = 1 - Math.pow(1 - k, 3);
      // Arc in: approach above the target, then settle vertically.
      const hover = a.to.clone().addScaledVector(a.up, 16 * (1 - THREE.MathUtils.smoothstep(k, 0.55, 1)));
      this.object.position.copy(a.from).lerp(hover, Math.min(1, e * 1.15));
      if (k > 0.55) this.object.position.lerp(a.to, THREE.MathUtils.smoothstep(k, 0.55, 1));
      this.object.quaternion.copy(a.fromQuat).slerp(a.toQuat, Math.min(1, k * 1.6));
      if (k > 0.35) this.gearTarget = 1;
      this.#flames(0.5 * (1 - k), false);
      if (k >= 1) { this.state = 'landed'; this.anim = null; this.onLanded?.(); }
      return;
    }
    if (this.state === 'autopilot') { this.#autopilot(dt, env); return; }
    // ---- manual flight
    const q = this.object.quaternion;
    const pitch = THREE.MathUtils.clamp(input.pitch * FLIGHT.pitchRate * dt - input.mouse.y * FLIGHT.mouseRate, -0.09, 0.09);
    const yaw = THREE.MathUtils.clamp(input.yaw * FLIGHT.yawRate * dt - input.mouse.x * FLIGHT.mouseRate * 0.85, -0.09, 0.09);
    const roll = input.roll * FLIGHT.rollRate * dt + yaw * 0.6;
    q.multiply(_q.setFromAxisAngle(_v.set(1, 0, 0), pitch)).multiply(_q.setFromAxisAngle(_v.set(0, 1, 0), yaw)).multiply(_q.setFromAxisAngle(_v.set(0, 0, 1), roll)).normalize();
    if (this.roll) { // a full turn about the nose, eased in and out
      const r = this.roll; r.t += dt;
      const k = Math.min(1, r.t / r.duration), angle = k * k * (3 - 2 * k) * Math.PI * 2 * r.dir;
      q.multiply(_q.setFromAxisAngle(_v.set(0, 0, 1), -(angle - r.angle))).normalize();
      r.angle = angle;
      if (k >= 1) this.roll = null;
    }
    // Auto-level roll near planets (keeps the horizon calm for non-pilots).
    if (env.radialUp && env.inAtmosphere > 0.05 && Math.abs(input.roll) < 0.1 && !this.roll) {
      const fwd = this.forward(_v), shipUp = this.up(_w);
      const desired = env.radialUp.clone().addScaledVector(fwd, -env.radialUp.dot(fwd));
      if (desired.lengthSq() > 1e-3) {
        desired.normalize();
        const angle = Math.atan2(fwd.dot(new THREE.Vector3().crossVectors(shipUp, desired)), THREE.MathUtils.clamp(shipUp.dot(desired), -1, 1));
        q.premultiply(_q.setFromAxisAngle(fwd, angle * (1 - Math.exp(-dt * 2.2 * env.inAtmosphere)))).normalize();
      }
    }
    // Throttle and speed caps (pulse drive only in open space). `env.limits`
    // tightens them where speed would spoil the fun: rifts, races.
    const atmo = env.inAtmosphere ?? 0, limits = env.limits || {}, boostScale = limits.boostScale ?? 1;
    const far = (env.nearestDistance ?? Infinity) > 4000;
    this.boost = input.boost && !this.pulse;
    this.pulse = input.boost && atmo < 0.02 && far && limits.pulse !== false;
    const spaceMax = limits.max ?? FLIGHT.spaceMax, spaceBoost = limits.boost ?? FLIGHT.spaceMax * 1.6 * boostScale;
    const cap = (this.pulse ? FLIGHT.pulseMax : THREE.MathUtils.lerp(input.boost ? spaceBoost : spaceMax, input.boost ? FLIGHT.atmoBoost * boostScale : FLIGHT.atmoMax, atmo)) + this.surge;
    if (input.throttleUp || input.boost) this.speed = Math.min(cap, this.speed + (this.pulse ? FLIGHT.pulseAccel : input.boost ? FLIGHT.boostAccel : FLIGHT.accel) * dt);
    else if (input.throttleDown) this.speed = Math.max(-30, this.speed - FLIGHT.brake * dt);
    if (this.speed > cap) this.speed = THREE.MathUtils.damp(this.speed, cap, 1.8, dt);
    const fwd = this.forward(_v);
    this.velocity.lerp(fwd.multiplyScalar(this.speed), 1 - Math.exp(-dt * 3.5));
    this.object.position.addScaledVector(this.velocity, dt);
    // Terrain avoidance: never closer than minClearance; slide along the ground.
    if (env.groundRadiusAt && env.planet) {
      const c = env.planet.center, d = this.object.position.distanceTo(c), up = _w.copy(this.object.position).sub(c).divideScalar(d);
      const floor = env.groundRadiusAt(up) + FLIGHT.minClearance;
      if (d < floor) {
        this.object.position.copy(c).addScaledVector(up, floor);
        const into = this.velocity.dot(up);
        if (into < 0) { this.velocity.addScaledVector(up, -into * 1.2); this.speed *= 0.97; this.scraped = true; }
      }
    }
    this.#flames(THREE.MathUtils.clamp(Math.abs(this.speed) / (this.pulse ? 4000 : 400), 0.15, 1.6), this.boost || this.pulse);
  }

  /**
   * Autopilot along a cubic Bezier (start, c1, c2, end): leave the current
   * world upward, arrive above the destination from its sky.
   */
  travelTo(c1, c2, end, onArrive) {
    this.state = 'autopilot';
    const start = this.object.position.clone();
    this.anim = { start, c1: c1.clone(), c2: c2.clone(), end: end.clone(), t: 0, onArrive };
    const dist = start.distanceTo(end);
    this.anim.duration = THREE.MathUtils.clamp(3 + dist / 11000, 3.5, 9);
    this.gearTarget = 0;
  }
  #bezier(a, k, out) {
    const u = 1 - k;
    return out.copy(a.start).multiplyScalar(u * u * u).addScaledVector(a.c1, 3 * u * u * k).addScaledVector(a.c2, 3 * u * k * k).addScaledVector(a.end, k * k * k);
  }
  #autopilot(dt, env) {
    const a = this.anim; a.t += dt;
    const k = Math.min(1, a.t / a.duration), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const prev = this.object.position.clone();
    this.#bezier(a, e, this.object.position);
    const vel = this.object.position.clone().sub(prev);
    this.speed = vel.length() / Math.max(dt, 1e-3);
    this.velocity.copy(vel).divideScalar(Math.max(dt, 1e-3));
    if (vel.lengthSq() > 1e-6) {
      const fwd = vel.clone().normalize(), up = env.radialUp && k > 0.7 ? env.radialUp : this.up(_w);
      _m.lookAt(new THREE.Vector3(), fwd, up); // matrix lookAt: -Z toward target (game forward)
      const target = new THREE.Quaternion().setFromRotationMatrix(_m);
      this.object.quaternion.slerp(target, 1 - Math.exp(-dt * 4));
    }
    this.pulse = k > 0.1 && k < 0.85;
    this.#flames(this.pulse ? 1.6 : 0.6, this.pulse);
    if (k >= 1) {
      this.state = 'flying'; this.speed = 60; this.velocity.copy(this.forward(_v)).multiplyScalar(60);
      const done = a.onArrive; this.anim = null; done?.();
    }
  }

  #flames(power, hot) {
    for (const f of this.flames) {
      f.flame.visible = power > 0.05;
      f.flame.scale.set(1, 1, power * (0.85 + Math.random() * 0.3));
      f.flame.material.color.set(hot ? this.flameColors.hot : this.flameColors.base);
      f.glow.material.opacity = Math.min(1, 0.35 + power * 0.5);
      f.glow.scale.setScalar(3 + power * 3);
    }
  }
}
