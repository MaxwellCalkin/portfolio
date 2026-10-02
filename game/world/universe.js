import * as THREE from 'three';
import { SUN_DIRECTION, SUN_COLOR } from './system.js';
import { prepareSpecs } from './layout.js';
import { createPlanetShape } from './planet-shape.js';
import { PlanetTerrain, TerrainWorkerPool } from './terrain-lod.js';
import { createTerrainMaterial } from './terrain-material.js';
import { createAtmosphereShell, createAtmosphereUniforms, fogPalette } from './atmosphere.js';
import { createNebula, createStarfield, createSun } from './space.js';
import { createCloudLayer } from './clouds.js';

/**
 * The whole star system: planets (LOD terrain + atmosphere), the space
 * backdrop and the shared sun/sky lighting. One persistent coordinate system:
 * nothing is ever teleported between scenes.
 */
export class Universe {
  constructor(scene, { quality = 'high', specs = prepareSpecs() } = {}) {
    this.scene = scene;
    this.quality = quality;
    this.sunDir = new THREE.Vector3(...SUN_DIRECTION);
    this.group = new THREE.Group(); this.group.name = 'universe'; scene.add(this.group);
    this.nebula = createNebula(); this.stars = createStarfield(quality === 'low' ? 5000 : 9000); this.sun = createSun();
    this.group.add(this.nebula, this.stars, this.sun);

    this.shapes = new Map(specs.map(spec => [spec.id, createPlanetShape(spec)]));
    this.pool = new TerrainWorkerPool(specs, { shapes: this.shapes });
    this.planets = specs.map(spec => {
      const shape = this.shapes.get(spec.id);
      const atmo = createAtmosphereUniforms(spec, quality);
      atmo.uSunDir.value.copy(this.sunDir);
      const fog = fogPalette(spec);
      const material = createTerrainMaterial(spec, atmo, fog);
      const terrain = new PlanetTerrain({ spec, shape, material, pool: this.pool, N: quality === 'low' ? 24 : 32, splitK: quality === 'low' ? 0.8 : 1.0 });
      const shell = createAtmosphereShell(spec, atmo);
      shell.position.fromArray(spec.position);
      const clouds = (spec.clouds ?? 0) > 0.05 ? createCloudLayer(spec, atmo, quality) : null;
      this.group.add(terrain.group, shell);
      if (clouds) this.group.add(clouds);
      return { spec, shape, terrain, atmo, shell, clouds, material, fog, center: new THREE.Vector3(...spec.position) };
    });

    // Each sky knows where the other worlds are (relative to its own center).
    for (const p of this.planets) {
      const others = this.planets.filter(o => o !== p), u = p.shell.material.uniforms;
      others.slice(0, 6).forEach((o, i) => u.uOthers.value[i].set(o.center.x - p.center.x, o.center.y - p.center.y, o.center.z - p.center.z, o.spec.radius * 1.17));
      u.uOtherCount.value = Math.min(6, others.length);
    }

    // Lighting: a directional sun whose shadow frustum follows the focus point,
    // and a hemisphere light re-aimed at the local "up" every frame.
    this.sunLight = new THREE.DirectionalLight(new THREE.Color(...SUN_COLOR), 3.2);
    this.sunLight.castShadow = quality !== 'low';
    const s = this.sunLight.shadow;
    s.mapSize.set(quality === 'high' ? 2048 : 1024, quality === 'high' ? 2048 : 1024);
    s.camera.near = 1; s.camera.far = 600; s.camera.left = s.camera.bottom = -45; s.camera.right = s.camera.top = 45;
    s.bias = -0.0006; s.normalBias = 0.04;
    this.hemi = new THREE.HemisphereLight('#bfe8f2', '#6f9a86', 1.1);
    this.scene.add(this.sunLight, this.sunLight.target, this.hemi);
    this.focus = new THREE.Vector3();
    this.local = { planet: null, altitude: Infinity, day: 1, up: new THREE.Vector3(0, 1, 0), inAtmosphere: 0 };
    this._tmp = new THREE.Vector3();
  }

  /** Nearest planet by altitude above its surface. */
  nearest(point) {
    let best = null, altitude = Infinity;
    for (const planet of this.planets) {
      const a = point.distanceTo(planet.center) - planet.spec.radius;
      if (a < altitude) { altitude = a; best = planet; }
    }
    if (best) altitude = best.terrain.altitudeAt(point);
    return { planet: best, altitude };
  }

  /**
   * @param {number} time seconds
   * @param {THREE.Camera} camera
   * @param {THREE.Vector3} focus player/ship position (drives LOD + shadows)
   */
  update(time, camera, focus) {
    this.focus.copy(focus);
    const { planet, altitude } = this.nearest(focus);
    this.local.planet = planet; this.local.altitude = altitude;
    for (const p of this.planets) {
      p.atmo.uCamPlanet.value.copy(camera.position).sub(p.center);
      p.material.userData.uniforms.uTime.value = time;
      if (p.clouds) p.clouds.material.uniforms.uTime.value = time;
      // LOD follows the camera (what you see) but never coarser than needed under the player.
      p.terrain.update(camera.position);
    }
    this.pool.pump(this.pool.usable ? 0 : 6);
    this.stars.material.uniforms.uTime.value = time;
    // Local frame + lighting.
    if (planet) {
      const up = this.local.up.copy(focus).sub(planet.center).normalize();
      const sunCos = up.dot(this.sunDir);
      this.local.day = THREE.MathUtils.smoothstep(sunCos, -0.18, 0.22);
      this.local.inAtmosphere = 1 - THREE.MathUtils.smoothstep(altitude, planet.spec.radius * planet.spec.atmosphere.height * 0.4, planet.spec.radius * planet.spec.atmosphere.height * 1.3);
      const amb = planet.spec.ambient;
      this.hemi.color.set(amb.sky); this.hemi.groundColor.set(amb.ground);
      this.hemi.position.copy(up);
      this.hemi.intensity = THREE.MathUtils.lerp(0.18, 1.15, this.local.day) * this.local.inAtmosphere + 0.25 * (1 - this.local.inAtmosphere);
      // Sun dims and warms near the horizon.
      const sunset = 1 - THREE.MathUtils.smoothstep(sunCos, 0.02, 0.35);
      this.sunLight.color.setRGB(1, 0.94 - sunset * 0.22, 0.86 - sunset * 0.38);
      this.sunLight.intensity = 3.2 * THREE.MathUtils.smoothstep(sunCos, -0.06, 0.12) * this.local.inAtmosphere + 3.4 * (1 - this.local.inAtmosphere);
    }
    this.sunLight.target.position.copy(focus);
    this.sunLight.position.copy(focus).addScaledVector(this.sunDir, 300);
    this.sunLight.target.updateMatrixWorld();
    // Stars fade in daylight inside an atmosphere.
    const starFade = 1 - this.local.day * this.local.inAtmosphere * 0.97;
    this.stars.material.uniforms.uFade.value = starFade;
    this.nebula.material.uniforms.uFade.value = 1 - this.local.day * this.local.inAtmosphere;
    // Clouds of the world you are on draw over its sky; other worlds' clouds
    // draw before the skies, so they sit behind your atmosphere like their ground.
    for (const p of this.planets) {
      if (!p.clouds) continue;
      p.clouds.renderOrder = p === planet && altitude < p.spec.radius * 0.6 ? 3 : 1;
      // Only one hemisphere of the shell is ever visible: draw just that side.
      p.clouds.material.side = p.atmo.uCamPlanet.value.length() < p.clouds.material.uniforms.uRadius.value ? THREE.BackSide : THREE.FrontSide;
    }
    // Skip the (full-screen) nebula and stars when daylight hides them.
    this.nebula.visible = this.nebula.material.uniforms.uFade.value > 0.02;
    this.stars.visible = starFade > 0.02;
    this.sun.position.copy(camera.position).addScaledVector(this.sunDir, 300000);
    this.nebula.position.copy(camera.position); this.stars.position.copy(camera.position);
    return this.local;
  }

  stats() {
    return this.planets.map(p => ({ id: p.spec.id, ...p.terrain.stats }));
  }

  dispose() { this.pool.dispose(); for (const p of this.planets) p.terrain.dispose(); this.group.removeFromParent(); }
}
