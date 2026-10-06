import * as THREE from 'three';

/**
 * Third-person camera for a spherical world, a chase camera for the ship and
 * smooth blends between them. View angles live in the local tangent frame and
 * are parallel-transported as the player moves, so "up" is always the
 * planet's radial up and the horizon never rolls on foot.
 */
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _m = new THREE.Matrix4();

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.viewHeading = new THREE.Vector3(0, 0, -1);
    this.pitch = -0.12;
    this.aimBlend = 0;
    this.sprintBlend = 0;
    this.mode = 'foot';
    this.blend = 1; // 1 = fully in the current mode
    this.fromPos = new THREE.Vector3(); this.fromQuat = new THREE.Quaternion();
    this.position = new THREE.Vector3(); this.quaternion = new THREE.Quaternion();
    this.up = new THREE.Vector3(0, 1, 0);
    this.forward = new THREE.Vector3(0, 0, -1);
    this.shake = 0;
    this.baseFov = 62;
    this.reducedMotion = false;
    this.offset = new THREE.Vector3(); this.anchored = false; // ship follow: camera position relative to the ship
  }

  setMode(mode, duration = 0.9) {
    if (mode === this.mode) return;
    this.fromPos.copy(this.camera.position); this.fromQuat.copy(this.camera.quaternion);
    this.mode = mode; this.blend = 0; this.blendDuration = duration;
  }

  /** Points the on-foot view along a tangent direction. */
  lookAlong(up, direction, pitch = -0.1) {
    this.viewHeading.copy(direction).addScaledVector(up, -direction.dot(up)).normalize();
    this.pitch = pitch;
  }

  /** Current view direction (world) including pitch. */
  viewDirection(up, out = new THREE.Vector3()) {
    const right = _a.crossVectors(this.viewHeading, up).normalize();
    return out.copy(this.viewHeading).applyAxisAngle(right, this.pitch).normalize();
  }

  /**
   * @param {number} dt
   * @param {object} p { position, up } of the player
   * @param {object} o { look:{x,y}, aiming, sprinting, groundRadiusAt(dir) }
   */
  updateFoot(dt, p, o) {
    const up = p.up;
    // Parallel transport + mouse look.
    this.viewHeading.addScaledVector(up, -this.viewHeading.dot(up)).normalize();
    const sens = 0.0022 * (o.aiming ? 0.6 : 1);
    this.viewHeading.applyAxisAngle(up, -o.look.x * sens).normalize();
    this.pitch = THREE.MathUtils.clamp(this.pitch - o.look.y * sens, -1.15, 1.0);
    this.aimBlend = THREE.MathUtils.damp(this.aimBlend, o.aiming ? 1 : 0, 12, dt);
    this.sprintBlend = THREE.MathUtils.damp(this.sprintBlend, o.sprinting ? 1 : 0, 5, dt);
    const right = _a.crossVectors(this.viewHeading, up).normalize();
    const dir = this.viewDirection(up, _b);
    const dist = THREE.MathUtils.lerp(4.4, 1.9, this.aimBlend) + this.sprintBlend * 0.5;
    const shoulder = THREE.MathUtils.lerp(0.78, 0.62, this.aimBlend);
    const height = THREE.MathUtils.lerp(1.72, 1.62, this.aimBlend);
    const pivot = _c.copy(p.position).addScaledVector(up, height).addScaledVector(right, shoulder);
    const target = new THREE.Vector3().copy(pivot).addScaledVector(dir, -dist);
    // Keep the camera above the terrain (sample a few points along the boom).
    if (o.groundRadiusAt) {
      const center = o.center;
      for (let i = 1; i <= 3; i++) {
        const q = pivot.clone().lerp(target, i / 3), r = q.distanceTo(center), gr = o.groundRadiusAt(q.clone().sub(center).normalize()) + 0.45;
        if (r < gr) target.addScaledVector(up, (gr - r) * (i / 3) * 1.2);
      }
    }
    const look = pivot.clone().addScaledVector(dir, 30);
    this.#apply(dt, target, look, up, THREE.MathUtils.lerp(this.baseFov, 48, this.aimBlend) + this.sprintBlend * 8);
  }

  /** Chase camera behind the ship. */
  updateShip(dt, ship, o = {}) {
    const q = ship.object.quaternion, up = _a.set(0, 1, 0).applyQuaternion(q), fwd = _b.set(0, 0, -1).applyQuaternion(q);
    const speed = ship.speed || 0;
    const back = 15 + Math.min(10, speed / 60), lift = 4.4 + Math.min(3, speed / 120);
    // Near a planet, bias the camera up toward the radial up for a stable horizon.
    const camUp = up.clone();
    if (o.radialUp && o.altitude < 3000) camUp.lerp(o.radialUp, (1 - o.altitude / 3000) * 0.6).normalize();
    const target = ship.object.position.clone().addScaledVector(fwd, -back).addScaledVector(camUp, lift);
    const look = ship.object.position.clone().addScaledVector(fwd, 30).addScaledVector(camUp, 1.5);
    const fov = this.baseFov + Math.min(16, speed / 40) + (o.boost ? 6 : 0);
    this.#apply(dt, target, look, camUp, fov, 10, ship.object.position);
  }

  /** Slow orbit around a point (launch screen / photo mode). */
  updateOrbit(dt, center, up, radius, height, angle, lookOffset = null) {
    const ref = this.orbitRef || (this.orbitRef = new THREE.Vector3(1, 0, 0));
    const t1 = ref.clone().addScaledVector(up, -ref.dot(up)).normalize(), t2 = new THREE.Vector3().crossVectors(up, t1);
    const pos = center.clone().addScaledVector(t1, Math.cos(angle) * radius).addScaledVector(t2, Math.sin(angle) * radius).addScaledVector(up, height);
    const look = lookOffset ? center.clone().add(lookOffset) : center;
    this.#apply(dt, pos, look, up, this.baseFov, 3);
  }

  /**
   * `anchor` (the ship) makes the follow happen in the anchor's frame: the
   * camera then trails only when the view turns, never because the anchor is
   * fast. Smoothing world positions trails a fast ship by speed / followRate,
   * which crossed the teleport snap below every few frames above ~200 m/s.
   */
  #apply(dt, position, look, up, fov, followRate = 18, anchor = null) {
    _m.lookAt(position, look, up);
    const quat = new THREE.Quaternion().setFromRotationMatrix(_m);
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / (this.blendDuration || 0.9));
      const t = this.blend * this.blend * (3 - 2 * this.blend);
      this.position.copy(this.fromPos).lerp(position, t);
      this.quaternion.copy(this.fromQuat).slerp(quat, t);
      // Keep the offset current, so the follow picks up exactly where the blend ends.
      if (anchor) this.offset.copy(this.position).sub(anchor);
      this.anchored = Boolean(anchor);
    } else if (anchor) {
      const want = _c.copy(position).sub(anchor);
      if (!this.anchored) { this.offset.copy(this.position).sub(anchor); this.anchored = true; }
      // Cut (rather than swing through the ship) when the view flips, e.g. a respawn facing a new way.
      if (this.offset.distanceToSquared(want) > 45 * 45) this.offset.copy(want);
      else this.offset.lerp(want, 1 - Math.exp(-followRate * dt));
      this.position.copy(anchor).add(this.offset);
      this.quaternion.copy(quat);
    } else {
      this.anchored = false;
      // Exponential follow for position; rotation snaps (aim must be crisp).
      const k = 1 - Math.exp(-followRate * dt);
      if (this.position.distanceToSquared(position) > 400) this.position.copy(position); else this.position.lerp(position, k);
      this.quaternion.copy(quat);
    }
    this.camera.position.copy(this.position);
    this.camera.quaternion.copy(this.quaternion);
    if (this.shake > 0 && !this.reducedMotion) {
      this.camera.position.addScaledVector(_c.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5), this.shake * 0.25);
      this.shake = Math.max(0, this.shake - dt * 2.5);
    }
    this.camera.up.copy(up);
    if (Math.abs(this.camera.fov - fov) > 0.05) { this.camera.fov = THREE.MathUtils.damp(this.camera.fov, fov, 8, dt); this.camera.updateProjectionMatrix(); }
    this.forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.up.copy(up);
  }
}
