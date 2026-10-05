import * as THREE from 'three';

/**
 * Space dust streaking past the camera, so speed reads even in empty space.
 * The motes are fixed in the world around the camera (real parallax) and
 * streak along the ship's motion; the pulse drive stretches them long.
 */
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();

export class SpeedLines {
  constructor(scene, count = 170, random = Math.random) {
    this.random = random;
    this.offsets = Array.from({ length: count }, () => new THREE.Vector3());
    this.positions = new Float32Array(count * 6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.LineBasicMaterial({ color: '#d8fff8', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.lines = new THREE.LineSegments(geometry, this.material);
    this.lines.frustumCulled = false; this.lines.visible = false; this.lines.renderOrder = 5;
    scene.add(this.lines);
    this.last = null;
  }
  #respawn(o, dir, ahead) {
    const side = _a.set(this.random() - 0.5, this.random() - 0.5, this.random() - 0.5);
    side.addScaledVector(dir, -side.dot(dir)).normalize().multiplyScalar(10 + this.random() * 110); // never across the line of sight
    o.copy(dir).multiplyScalar(ahead ? 60 + this.random() * 360 : (this.random() - 0.3) * 400).add(side);
  }
  /**
   * @param {THREE.Vector3} camera camera position
   * @param {THREE.Vector3} velocity ship velocity
   * @param {number} strength 0..1 (0 on foot and inside atmospheres)
   */
  update(camera, velocity, strength, pulse = false) {
    const speed = velocity.length(), show = strength * THREE.MathUtils.smoothstep(speed, 200, 1400);
    this.lines.visible = show > 0.01;
    if (!this.lines.visible) { this.last = null; return; }
    const dir = _d.copy(velocity).divideScalar(speed);
    if (!this.last || this.last.distanceToSquared(camera) > 600 * 600) { // first frame, or a jump: scatter
      for (const o of this.offsets) this.#respawn(o, dir, false);
      this.last = camera.clone();
    }
    const moved = _b.copy(camera).sub(this.last); this.last.copy(camera);
    const length = Math.min(pulse ? 420 : 140, speed * (pulse ? 0.03 : 0.045)), p = this.positions;
    this.offsets.forEach((o, i) => {
      o.sub(moved);
      if (o.dot(dir) < -60 || o.lengthSq() > 480 * 480) this.#respawn(o, dir, true);
      const k = i * 6;
      p[k] = o.x; p[k + 1] = o.y; p[k + 2] = o.z;
      p[k + 3] = o.x + dir.x * length; p[k + 4] = o.y + dir.y * length; p[k + 5] = o.z + dir.z * length;
    });
    this.lines.position.copy(camera);
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.material.opacity = show * (pulse ? 0.7 : 0.42);
  }
}
