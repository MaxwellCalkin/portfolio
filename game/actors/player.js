import * as THREE from 'three';
import { resolveCapsule } from './physics.js';

/**
 * On-foot controller for a spherical world.
 *
 * Gravity points to the planet center, "up" is radial, and the heading is a
 * tangent vector that is re-projected every step (parallel transport), so
 * walking around the whole planet never flips or spins the view.
 */
export const PLAYER = Object.freeze({
  radius: 0.42, height: 1.85,
  walk: 3.0, run: 6.0, sprint: 9.5, aimWalk: 3.6,
  accelGround: 42, accelAir: 11, friction: 10,
  gravity: 20, jump: 7.2,
  jetThrust: 31, jetMaxUp: 9, jetDrain: 26, jetRegen: 34, jetDelay: 0.45,
  dashSpeed: 22, dashTime: 0.24, dashCooldown: 2.6,
  wadeDepth: 1.25, slopeLimit: 0.42,
});

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _n = new THREE.Vector3();

export class Player {
  constructor() {
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.heading = new THREE.Vector3(0, 0, -1); // tangent forward of the body
    this.grounded = false;
    this.airTime = 0;
    this.jet = 100; this.jetIdle = 0; this.jetting = false;
    this.dashTime = 0; this.dashCooldown = 0; this.dashDir = new THREE.Vector3();
    this.sprinting = false; this.wading = false; this.lastSafe = new THREE.Vector3();
    this.landed = false; this.jumped = false; this.landSpeed = 0;
    this.localVel = { x: 0, z: 0 };
    this._colliders = [];
  }

  /** Puts the player on the surface at a world position, facing a tangent direction. */
  place(planet, position, facing) {
    this.planet = planet;
    this.up.copy(position).sub(planet.center).normalize();
    this.position.copy(planet.center).addScaledVector(this.up, this.#groundRadius(planet, this.up));
    this.velocity.set(0, 0, 0);
    this.heading.copy(facing).addScaledVector(this.up, -facing.dot(this.up)).normalize();
    this.grounded = true; this.lastSafe.copy(this.position);
  }

  #groundRadius(planet, dir) {
    const shape = planet.shape, h = shape.heightAt(dir.x, dir.y, dir.z);
    if (shape.seaLevel !== null && h < shape.seaLevel - PLAYER.wadeDepth) return planet.spec.radius + shape.seaLevel - PLAYER.wadeDepth;
    return planet.spec.radius + (shape.seaLevel !== null ? Math.max(h, shape.seaLevel - PLAYER.wadeDepth) : h);
  }
  #terrainNormal(planet, dir, out) {
    // Finite differences of the analytic terrain, ~0.9 m apart.
    const R = planet.spec.radius, eps = 0.9 / R, shape = planet.shape;
    const t1 = _v.set(-dir.z, 0, dir.x); if (t1.lengthSq() < 1e-8) t1.set(1, 0, 0); t1.normalize();
    const t2 = _w.crossVectors(dir, t1);
    const h0 = shape.heightAt(dir.x, dir.y, dir.z);
    const a = dir.clone().addScaledVector(t1, eps).normalize(), b = dir.clone().addScaledVector(t2, eps).normalize();
    const ha = shape.heightAt(a.x, a.y, a.z), hb = shape.heightAt(b.x, b.y, b.z);
    return out.copy(dir).multiplyScalar(eps * R).addScaledVector(t1, -(ha - h0)).addScaledVector(t2, -(hb - h0)).normalize();
  }

  /**
   * @param {number} dt
   * @param {object} planet active planet record (universe.planets[i])
   * @param {object} input { move:{x,y}, jump (held), jumpPressed, sprint, aim, dash (pressed) }
   * @param {THREE.Vector3} viewForward camera forward (world); movement is camera-relative
   * @param {(pos:THREE.Vector3, r:number)=>Array} gatherColliders
   */
  update(dt, planet, input, viewForward, gatherColliders) {
    this.planet = planet;
    this.landed = false; this.jumped = false;
    const steps = Math.max(1, Math.ceil(dt / 0.016));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.#step(h, planet, input, viewForward, gatherColliders, i === 0);
    // Body-relative velocity for animation.
    const right = _v.crossVectors(this.heading, this.up).normalize();
    this.localVel.x = this.velocity.dot(right); this.localVel.z = this.velocity.dot(this.heading);
  }

  #step(dt, planet, input, viewForward, gatherColliders, first) {
    const up = this.up.copy(this.position).sub(planet.center).normalize();
    // Camera-relative tangent basis.
    const fwd = _n.copy(viewForward).addScaledVector(up, -viewForward.dot(up));
    if (fwd.lengthSq() < 1e-6) fwd.copy(this.heading);
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const wish = new THREE.Vector3().addScaledVector(fwd, input.move.y).addScaledVector(right, input.move.x);
    const wishLen = Math.min(1, wish.length()); if (wishLen > 1e-4) wish.normalize();
    this.sprinting = input.sprint && input.move.y > 0.3 && !input.aim;
    const maxSpeed = (input.aim ? PLAYER.aimWalk : this.sprinting ? PLAYER.sprint : PLAYER.run) * (this.wading ? 0.55 : 1);
    // Split velocity into radial and tangential parts.
    const vUp = this.velocity.dot(up);
    const vTan = this.velocity.clone().addScaledVector(up, -vUp);
    // Dash.
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    if (first && input.dash && this.dashCooldown <= 0) {
      this.dashDir.copy(wishLen > 0.1 ? wish : fwd); this.dashTime = PLAYER.dashTime; this.dashCooldown = PLAYER.dashCooldown; this.dashed = true;
    }
    if (this.dashTime > 0) {
      this.dashTime -= dt;
      vTan.copy(this.dashDir).multiplyScalar(PLAYER.dashSpeed);
    } else {
      const target = wish.clone().multiplyScalar(maxSpeed * wishLen);
      const accel = this.grounded ? PLAYER.accelGround : PLAYER.accelAir * (this.jetting ? 1.6 : 1);
      const delta = target.sub(vTan), maxDelta = accel * dt;
      if (delta.length() > maxDelta) delta.setLength(maxDelta);
      vTan.add(delta);
    }
    // Vertical: gravity, jump, jetpack.
    let vy = vUp;
    if (this.grounded && first && input.jumpPressed) { vy = PLAYER.jump; this.grounded = false; this.jumped = true; this.jumpFlag = true; this.jetIdle = 0; this.airTime = 0; }
    this.jetting = false;
    if (!this.grounded) {
      this.airTime += dt;
      const wantsJet = input.jump && (!this.jumpFlag || this.airTime > 0.25) && this.jet > 0;
      if (wantsJet) {
        this.jetting = true;
        vy = Math.min(PLAYER.jetMaxUp, vy + (PLAYER.jetThrust - PLAYER.gravity) * dt + PLAYER.gravity * dt);
        this.jet = Math.max(0, this.jet - PLAYER.jetDrain * dt);
        this.jetIdle = 0;
      }
    }
    vy -= PLAYER.gravity * dt;
    if (!this.jetting) { this.jetIdle += dt; if (this.jetIdle > PLAYER.jetDelay && this.grounded) this.jet = Math.min(100, this.jet + PLAYER.jetRegen * dt); }
    // Integrate.
    this.velocity.copy(vTan).addScaledVector(up, vy);
    const prev = this.position.clone();
    this.position.addScaledVector(this.velocity, dt);
    let newUp = _w.copy(this.position).sub(planet.center).normalize();
    // Terrain.
    const groundR = this.#groundRadius(planet, newUp), r = this.position.distanceTo(planet.center);
    const shape = planet.shape, h = shape.heightAt(newUp.x, newUp.y, newUp.z);
    this.wading = shape.seaLevel !== null && h < shape.seaLevel - 0.35;
    // Steep slopes act like walls while grounded.
    if (this.grounded && !this.wading) {
      const n = this.#terrainNormal(planet, newUp, new THREE.Vector3());
      const slope = 1 - n.dot(newUp);
      if (slope > PLAYER.slopeLimit) {
        const downhill = n.clone().addScaledVector(newUp, -n.dot(newUp)).normalize();
        const into = -this.velocity.dot(downhill);
        if (into > 0) { this.position.copy(prev).addScaledVector(downhill, 0.02); this.velocity.addScaledVector(downhill, into); }
        newUp = _w.copy(this.position).sub(planet.center).normalize();
      }
    }
    // Colliders (landmarks, flora, parked ship).
    const colliders = gatherColliders(this.position, 4);
    const support = resolveCapsule(this.position, newUp, PLAYER.radius, PLAYER.height, colliders, vy <= 0.5);
    newUp = _w.copy(this.position).sub(planet.center).normalize();
    const ground = this.#groundRadius(planet, newUp);
    let floor = ground;
    if (support !== null) floor = Math.max(floor, this.position.distanceTo(planet.center) + support);
    const dist = this.position.distanceTo(planet.center);
    const wasGrounded = this.grounded;
    if (dist <= floor + (this.grounded && vy <= 0.5 ? 0.35 : 0)) {
      // Snap to the floor (also keeps us glued when walking downhill).
      this.position.copy(planet.center).addScaledVector(newUp, floor);
      const radialV = this.velocity.dot(newUp);
      if (radialV < 0) { if (!wasGrounded) { this.landed = true; this.landSpeed = -radialV; } this.velocity.addScaledVector(newUp, -radialV); }
      this.grounded = vy <= 0.5 || dist < floor;
      if (this.grounded) { this.airTime = 0; this.jumpFlag = false; if (!this.wading) this.lastSafe.copy(this.position); }
    } else {
      this.grounded = false;
    }
    void groundR; void r;
    this.up.copy(newUp);
    // Parallel transport of the heading.
    this.heading.addScaledVector(this.up, -this.heading.dot(this.up)).normalize();
  }

  /** Turns the body toward a tangent direction (smoothly). */
  face(direction, dt, rate = 14) {
    const target = _v.copy(direction).addScaledVector(this.up, -direction.dot(this.up));
    if (target.lengthSq() < 1e-6) return;
    target.normalize();
    const angle = Math.atan2(_w.crossVectors(this.heading, target).dot(this.up), THREE.MathUtils.clamp(this.heading.dot(target), -1, 1));
    const step = angle * (1 - Math.exp(-rate * dt));
    this.heading.applyAxisAngle(this.up, step).normalize();
  }

  /** Quaternion for the body: -Z = heading, +Y = up. */
  orientation(out = new THREE.Quaternion()) {
    const right = _v.crossVectors(this.heading, this.up).normalize();
    const back = _w.copy(this.heading).negate();
    return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, this.up, back));
  }
}
