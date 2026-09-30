import * as THREE from 'three';
import { PLANETS } from './world.js';

// Original, asset-free flight playground. All ships face local -Z.
const TAU = Math.PI * 2;
const FORWARD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3();
const clamp = THREE.MathUtils.clamp;
const vec = value => value?.isVector3 ? value.clone() : new THREE.Vector3(value?.x ?? value?.[0] ?? 0, value?.y ?? value?.[1] ?? 0, value?.z ?? value?.[2] ?? 0);

/** Earliest swept sphere impact, including a projectile that starts inside it. */
export function segmentSphereHitTime(start, end, center, radius) {
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
  const ox = start.x - center.x, oy = start.y - center.y, oz = start.z - center.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-12) return null;
  const b = ox * dx + oy * dy + oz * dz;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / a;
  return t >= 0 && t <= 1 ? t : null;
}

/** A real plane crossing through the aperture, not merely proximity to a gate. */
export function crossesRing(start, end, center, normal, innerRadius) {
  const ax = start.x - center.x, ay = start.y - center.y, az = start.z - center.z;
  const bx = end.x - center.x, by = end.y - center.y, bz = end.z - center.z;
  const a = ax * normal.x + ay * normal.y + az * normal.z;
  const b = bx * normal.x + by * normal.y + bz * normal.z;
  if (Math.abs(a) < 1e-7 || a * b > 0 || Math.abs(a - b) < 1e-9) return false;
  const t = a / (a - b);
  if (t < 0 || t > 1) return false;
  const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
  return x * x + y * y + z * z <= innerRadius * innerRadius;
}

function orientation(forward, up) {
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();
  const actualUp = new THREE.Vector3().crossVectors(right, forward).normalize();
  const matrix = new THREE.Matrix4().makeBasis(right, actualUp, forward.clone().negate());
  return new THREE.Quaternion().setFromRotationMatrix(matrix);
}

/**
 * Speed-preserving evasive loop: one continuous 360° vertical backward loop.
 * Returns null while stationary. No input vectors are mutated.
 */
export function createLoop(position, forward, speed) {
  speed = Math.abs(Number(speed));
  if (!Number.isFinite(speed) || speed < 8) return null;
  const start = vec(position), direction = vec(forward);
  if (direction.lengthSq() < 1e-9) return null;
  direction.normalize();
  // Project global up onto the flight plane; vertical starts use a stable fallback.
  const up = UP.clone().addScaledVector(direction, -UP.dot(direction));
  if (up.lengthSq() < 1e-6) up.set(0, 0, 1).addScaledVector(direction, -direction.z);
  up.normalize();
  const duration = 1.65;
  return { start, forward: direction, up, speed, elapsed: 0, radius: speed * duration / TAU, duration };
}

/** Analytic constant-speed path, independent of frame rate and dt partitioning. */
export function updateLoop(state, dt) {
  if (!state) return null;
  state.elapsed = Math.min(state.duration, state.elapsed + Math.max(0, Number.isFinite(dt) ? dt : 0));
  const angle = TAU * state.elapsed / state.duration;
  const position = state.start.clone()
    .addScaledVector(state.forward, Math.sin(angle) * state.radius)
    .addScaledVector(state.up, (1 - Math.cos(angle)) * state.radius);
  const direction = state.forward.clone().multiplyScalar(Math.cos(angle)).addScaledVector(state.up, Math.sin(angle)).normalize();
  const up = state.up.clone().multiplyScalar(Math.cos(angle)).addScaledVector(state.forward, -Math.sin(angle)).normalize();
  return { position, direction, up, quaternion: orientation(direction, up), speed: state.speed,
    progress: state.elapsed / state.duration, done: state.elapsed >= state.duration };
}

function loft(profiles, sides = 6) {
  const vertices = [], indices = [];
  for (const [z, width, height, y = 0] of profiles) {
    for (let side = 0; side < sides; side++) {
      const a = side / sides * TAU + Math.PI / 6;
      vertices.push(Math.cos(a) * width, Math.sin(a) * height + y, z);
    }
  }
  for (let row = 0; row < profiles.length - 1; row++) {
    for (let side = 0; side < sides; side++) {
      const a = row * sides + side, b = row * sides + (side + 1) % sides;
      indices.push(a, b, b + sides, a, b + sides, a + sides);
    }
  }
  for (let side = 1; side < sides - 1; side++) {
    indices.push(0, side + 1, side);
    const base = (profiles.length - 1) * sides;
    indices.push(base, base + side, base + side + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

function wing(points, thickness = .28) {
  const shape = new THREE.Shape();
  points.forEach(([x, z], i) => i ? shape.lineTo(x, z) : shape.moveTo(x, z));
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, steps: 1 });
  geometry.rotateX(Math.PI / 2); geometry.translate(0, thickness / 2, 0);
  return geometry;
}

// Three distinct silhouettes, shared between their instances rather than rebuilt.
function createAssets() {
  const geometries = new Set(), materials = new Set();
  const geometry = value => (geometries.add(value), value);
  const standard = (color, extra = {}) => {
    const value = new THREE.MeshStandardMaterial({ color, metalness: .65, roughness: .36, ...extra });
    materials.add(value); return value;
  };
  const basic = (color, extra = {}) => {
    const value = new THREE.MeshBasicMaterial({ color, ...extra }); materials.add(value); return value;
  };
  const a = {
    geometry, standard, basic, geometries, materials,
    dark: standard('#19262e'), metal: standard('#a2aeb5'),
    hulls: [
      geometry(loft([[-10, .07, .08], [-5.8, .75, .45], [-1.8, 1.5, .75], [4.8, 1.1, .5], [6, .55, .3]])),
      geometry(loft([[-7.8, .12, .12], [-4.6, 1.1, .4], [1.1, 2, .7], [5.1, 1.6, .5]])),
      geometry(loft([[-8.5, .15, .09], [-3.2, .7, .44], [1.3, 1, .6], [5.4, .6, .35]])),
    ],
    wings: [
      geometry(wing([[.6,-4.5],[2,-1],[7.4,4.4],[7,5.5],[2.7,2.8],[.8,4]])),
      geometry(wing([[.8,-4.9],[10.4,2.7],[8.5,5.3],[2.3,3.3],[.7,4.5]])),
      geometry(wing([[.5,-2.8],[3.4,-5.7],[5.5,-4.7],[4.3,4.4],[1.7,3.1]])),
    ],
    cockpit: geometry(loft([[-5,.05,.04],[-3.5,.61,.3,.5],[-1.3,.72,.35,.65],[.8,.36,.14,.45]])),
    nacelle: geometry(loft([[-4.5,.25,.2],[-2.8,.56,.5],[3.9,.61,.4],[5.8,.44,.35]])),
    fin: geometry(wing([[0,-1.9],[2.3,1.4],[2.1,3.5],[0,2.5]], .17)),
    nozzle: geometry(new THREE.CylinderGeometry(.33,.45,.9,8)),
    flame: geometry(new THREE.ConeGeometry(.33,4.5,8)),
    box: geometry(new THREE.BoxGeometry(1,1,1)),
    bolt: geometry(new THREE.CylinderGeometry(.13,.19,9,5)),
    spark: geometry(new THREE.OctahedronGeometry(1,0)),
    gate: geometry(new THREE.TorusGeometry(44,.7,5,64)),
    gateRail: geometry(new THREE.TorusGeometry(46.7,.3,4,64)),
    gateHalo: geometry(new THREE.RingGeometry(41.5,47.8,64)),
    gateMarker: geometry(new THREE.ConeGeometry(1.15,6,3)),
    glass: standard('#092832', { emissive: '#267c89', emissiveIntensity: .6, roughness: .16 }),
    hostileBolt: basic('#ff775f', { toneMapped: false }),
    playerBolt: basic('#aefff0', { toneMapped: false }),
    sparkMaterial: basic('#ffb279', { toneMapped: false }),
  };
  a.palettes = [
    { name: 'Needle', shell: standard('#b0bfc0'), accent: standard('#ed795b'), light: basic('#ff866c', { toneMapped:false }) },
    { name: 'Manta', shell: standard('#6b7592'), accent: standard('#b49bf2'), light: basic('#c4aaff', { toneMapped:false }) },
    { name: 'Kestrel', shell: standard('#adad8a'), accent: standard('#f1bd66'), light: basic('#ffd589', { toneMapped:false }) },
  ];
  return a;
}

function mesh(geometry, material, group, x = 0, y = 0, z = 0) {
  const value = new THREE.Mesh(geometry, material);
  value.position.set(x,y,z); group.add(value); return value;
}

function createFighter(variant, assets) {
  const group = new THREE.Group(), palette = assets.palettes[variant], flames = [];
  group.name = `${palette.name}-interceptor`;
  mesh(assets.hulls[variant], palette.shell, group);
  mesh(assets.cockpit, assets.glass, group, 0, .25, variant === 1 ? 1.1 : 0);
  for (const sign of [-1, 1]) {
    const foil = mesh(assets.wings[variant], palette.shell, group, 0, -.22);
    foil.scale.x = sign;
    const rail = mesh(assets.box, palette.accent, group, sign * (variant === 1 ? 6.7 : 3.9), -.005, 2.25);
    rail.scale.set(variant === 1 ? 2.7 : 1.2, .18, 1.5); rail.rotation.y = -sign * .6;
    const engineX = sign * (variant === 2 ? 4.1 : variant === 1 ? 2.8 : 2.3);
    mesh(assets.nacelle, assets.dark, group, engineX, -.05, variant === 2 ? -.7 : 0);
    const cap = mesh(assets.box, palette.shell, group, engineX, .46, 1.8);
    cap.scale.set(.78,.16,3.9);
    const nozzle = mesh(assets.nozzle, palette.light, group, engineX, -.05, 5.7);
    nozzle.rotation.x = Math.PI / 2;
    const flame = mesh(assets.flame, palette.light, group, engineX, -.05, 8.05);
    flame.rotation.x = Math.PI / 2; flames.push(flame);
    const fin = mesh(assets.fin, palette.accent, group, engineX, .38, 1.8);
    fin.rotation.z = sign * Math.PI * .33; fin.scale.x = sign;
    const cannon = mesh(assets.box, assets.dark, group, sign * (variant === 1 ? 7.7 : 5.1), -.1, -.1);
    cannon.scale.set(.22,.22,4.4);
  }
  group.userData.flames = flames;
  return group;
}

const GATE_POSITIONS = [
  [0,18,-110], [0,38,-420], [115,70,-745], [375,96,-1025],
  [720,112,-1030], [1050,62,-820], [1280,-4,-525],
  [1210,16,25], [860,90,380], [420,180,590],
  [-70,180,500], [-445,105,255], [-595,70,-190], [-480,36,-610],
];
const SPAWNS = [
  [48,32,-310], [-185,-12,-520], [265,105,-660], [540,150,-1110],
  [1130,25,-970], [1370,-60,190], [720,160,620], [-550,155,520],
  [-1100,170,-180], [-1110,250,-1340], [400,260,-1990], [1710,120,-1030],
];

/**
 * Independent space-combat and race subsystem. Hide group and stop update off-orbit.
 * Prefer tryHitSegment for host-owned player projectiles; shoot is an optional
 * pooled alternative and should not also be called for the same shot.
 */
export function createSpacePlayground(scene, { onPlayerDamage = () => {}, onEnemyDestroyed = () => {}, onBoost = () => {} } = {}) {
  const group = new THREE.Group(); group.name = 'flight-playground'; scene.add(group);
  const assets = createAssets(), enemies = [], rings = [], bolts = [], sparks = [];
  const playerPrevious = new THREE.Vector3(), playerVelocity = new THREE.Vector3();
  let hasPlayerPrevious = false, disposed = false, elapsed = 0;
  const to = new THREE.Vector3(), target = new THREE.Vector3(), desired = new THREE.Vector3();
  const next = new THREE.Vector3(), normal = new THREE.Vector3(), lead = new THREE.Vector3();
  const facing = new THREE.Quaternion();
  const obstacles = PLANETS.map(p => ({ position: new THREE.Vector3(...p.position), radius: p.radius }));

  for (let index = 0; index < GATE_POSITIONS.length; index++) {
    const root = new THREE.Group(); root.name = `boost-gate-${index + 1}`;
    root.position.fromArray(GATE_POSITIONS[index]);
    const before = new THREE.Vector3(...GATE_POSITIONS[(index + GATE_POSITIONS.length - 1) % GATE_POSITIONS.length]);
    const after = new THREE.Vector3(...GATE_POSITIONS[(index + 1) % GATE_POSITIONS.length]);
    const direction = after.sub(before).normalize();
    if (index < 2) direction.set(0,0,-1);
    root.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1), direction);
    const material = assets.basic('#8aeada', { toneMapped: false });
    const haloMaterial = assets.basic('#66d9c6', { transparent:true, opacity:.13, side:THREE.DoubleSide, depthWrite:false, blending:THREE.AdditiveBlending, toneMapped:false });
    mesh(assets.gate, material, root);
    mesh(assets.gateRail, assets.metal, root);
    mesh(assets.gateHalo, haloMaterial, root);
    const markers = new THREE.Group(); root.add(markers);
    const supports = new THREE.InstancedMesh(assets.box,assets.dark,8);
    const strips = new THREE.InstancedMesh(assets.box,material,8);
    const pointers = new THREE.InstancedMesh(assets.gateMarker,material,4);
    const dummy = new THREE.Object3D(); root.add(supports,strips); markers.add(pointers);
    for (let marker = 0; marker < 8; marker++) {
      const angle = marker / 8 * TAU;
      dummy.position.set(Math.cos(angle)*46.6,Math.sin(angle)*46.6,0);
      dummy.rotation.set(0,0,angle);dummy.scale.set(6.6,2.1,3.3);dummy.updateMatrix();
      supports.setMatrixAt(marker,dummy.matrix);
      dummy.position.z=-1.8;dummy.scale.set(3.8,.65,.15);dummy.updateMatrix();
      strips.setMatrixAt(marker,dummy.matrix);
      if (marker % 2 === 0) {
        dummy.position.set(Math.cos(angle)*36,Math.sin(angle)*36,0);
        dummy.rotation.set(0,0,angle+Math.PI/2);dummy.scale.setScalar(1);dummy.updateMatrix();
        pointers.setMatrixAt(marker/2,dummy.matrix);
      }
    }
    supports.computeBoundingSphere();strips.computeBoundingSphere();pointers.computeBoundingSphere();
    group.add(root);
    rings.push({ mesh:root, index, position:root.position, normal:direction, innerRadius:39.5, material, haloMaterial, markers, cooldown:0, pulse:0, passes:0 });
  }

  for (let index = 0; index < SPAWNS.length; index++) {
    const variant = index % 3, root = createFighter(variant, assets);
    const home = new THREE.Vector3(...SPAWNS[index]); root.position.copy(home); group.add(root);
    const direction = new THREE.Vector3(index % 2 ? -.6 : .7, 0, 1).normalize();
    root.quaternion.setFromUnitVectors(FORWARD,direction);
    enemies.push({ id:`interceptor-${index+1}`, name:assets.palettes[variant].name, mesh:root, home,
      variant, hp:90 + variant * 15, maxHp:90 + variant * 15, radius:variant === 1 ? 10 : 8.3,
      direction, previous:home.clone(), speed:88+variant*12, alive:true,
      shootTimer:2.4+index*.37, breakTimer:0, respawnTimer:0, phase:index*2.39996,
      hitTimer:0, engaged:false, destroyedAt:null,
    });
  }

  // One allocation per pooled object. No projectile/effect geometry churn in combat.
  for (let index = 0; index < 64; index++) {
    const root = mesh(assets.bolt, assets.hostileBolt, group); root.visible = false;
    bolts.push({ mesh:root, velocity:new THREE.Vector3(), previous:new THREE.Vector3(), life:0, hostile:true, damage:12 });
  }
  for (let index = 0; index < 72; index++) {
    const root = mesh(assets.spark, assets.sparkMaterial, group); root.visible = false;
    sparks.push({ mesh:root, velocity:new THREE.Vector3(), life:0, maxLife:1 });
  }

  function burst(position, count, power) {
    let added = 0;
    for (const spark of sparks) {
      if (spark.life > 0) continue;
      const angle = (added * 2.39996 + elapsed) % TAU;
      const y = Math.sin(added * 1.731 + elapsed);
      spark.life = spark.maxLife = .35 + (added % 7) * .095;
      spark.mesh.visible = true; spark.mesh.position.copy(position);
      spark.mesh.scale.setScalar(.6 + (added % 4) * .3);
      spark.velocity.set(Math.cos(angle), y, Math.sin(angle)).normalize().multiplyScalar(power * (.55 + (added % 3) * .2));
      if (++added >= count) break;
    }
  }

  function launch(origin, direction, hostile = true, damage = 12, inheritedSpeed = 0) {
    const bolt = bolts.find(value => value.life <= 0);
    if (!bolt || disposed) return false;
    bolt.mesh.visible = true; bolt.mesh.material = hostile ? assets.hostileBolt : assets.playerBolt;
    bolt.mesh.position.copy(origin); bolt.previous.copy(origin);
    bolt.velocity.copy(direction).normalize().multiplyScalar((hostile ? 410 : 610) + inheritedSpeed);
    bolt.mesh.quaternion.setFromUnitVectors(UP, direction.clone().normalize());
    bolt.life = hostile ? 3.6 : 3.2; bolt.hostile = hostile; bolt.damage = damage;
    return true;
  }

  function hurtEnemy(enemy, damage, impact) {
    enemy.hp -= Math.max(0, Number.isFinite(damage) ? damage : 0); enemy.hitTimer = .17;
    burst(impact || enemy.mesh.position, 5, 25);
    if (enemy.hp > 0) return;
    enemy.hp = 0; enemy.alive = false; enemy.mesh.visible = false; enemy.respawnTimer = 22;
    enemy.destroyedAt = enemy.mesh.position.clone();
    burst(enemy.mesh.position, 25, 63);
    onEnemyDestroyed(enemy);
  }

  function tryHitSegment(start, end, damage = 30) {
    if (disposed) return false;
    let earliest = Infinity, hit = null;
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      const t = segmentSphereHitTime(start,end,enemy.mesh.position,enemy.radius);
      if (t !== null && t < earliest) { earliest = t; hit = enemy; }
    }
    if (!hit) return false;
    next.copy(start).lerp(end, earliest);
    hurtEnemy(hit,damage,next);
    return true;
  }

  function safeRespawn(enemy, player) {
    // An existing patrol re-enters away from the player; it never pops into a chase.
    const angle = enemy.phase + elapsed * .04;
    target.copy(enemy.home).add(new THREE.Vector3(Math.cos(angle)*170,Math.sin(angle*.7)*70,Math.sin(angle)*170));
    if (target.distanceToSquared(player) < 650 * 650) return false;
    for (const obstacle of obstacles) {
      normal.copy(target).sub(obstacle.position);
      if (normal.length() < obstacle.radius + 100) target.copy(obstacle.position).addScaledVector(normal.normalize(),obstacle.radius+110);
    }
    enemy.mesh.position.copy(target); enemy.previous.copy(target); enemy.hp = enemy.maxHp;
    enemy.alive = true; enemy.mesh.visible = true; enemy.shootTimer = 3.5; enemy.breakTimer = 0;
    return true;
  }

  function updateEnemies(dt, time, player, playerDirection, speed) {
    for (const enemy of enemies) {
      if (!enemy.alive) {
        enemy.respawnTimer -= dt;
        if (enemy.respawnTimer <= 0) safeRespawn(enemy,player);
        continue;
      }
      enemy.previous.copy(enemy.mesh.position);
      to.copy(player).sub(enemy.mesh.position);
      const distance = to.length();
      enemy.engaged = distance < 820;
      enemy.breakTimer = Math.max(0,enemy.breakTimer-dt);
      if (enemy.engaged) {
        if (distance < 100 && enemy.breakTimer <= 0) enemy.breakTimer = 1.9;
        if (enemy.breakTimer > 0) {
          desired.copy(enemy.direction).addScaledVector(UP,Math.sin(enemy.phase)*.22).normalize();
        } else {
          target.copy(player).addScaledVector(playerDirection, Math.min(distance * .22,110));
          target.x += Math.sin(time*.32+enemy.phase) * Math.min(55,distance*.1);
          target.y += Math.sin(time*.45+enemy.phase) * 24;
          desired.copy(target).sub(enemy.mesh.position).normalize();
        }
      } else {
        const a = time*.055+enemy.phase, radius = 165+enemy.variant*55;
        target.copy(enemy.home).add(new THREE.Vector3(Math.cos(a)*radius, Math.sin(a*.7)*85, Math.sin(a)*radius));
        desired.copy(target).sub(enemy.mesh.position).normalize();
      }
      // Turn around planetary volumes instead of allowing fighters to clip through them.
      for (const obstacle of obstacles) {
        normal.copy(enemy.mesh.position).sub(obstacle.position);
        const clearance = normal.length() - obstacle.radius;
        if (clearance < 175) desired.addScaledVector(normal.normalize(),(175-clearance)/45);
      }
      desired.normalize();
      facing.setFromUnitVectors(FORWARD,desired);
      enemy.mesh.quaternion.rotateTowards(facing,dt*(enemy.breakTimer > 0 ? .62 : .83+enemy.variant*.07));
      enemy.direction.copy(FORWARD).applyQuaternion(enemy.mesh.quaternion).normalize();
      const targetSpeed = enemy.engaged ? clamp(Math.abs(speed)*.86+35,92,215) : 78+enemy.variant*10;
      enemy.speed = THREE.MathUtils.damp(enemy.speed,targetSpeed,1.8,dt);
      enemy.mesh.position.addScaledVector(enemy.direction,enemy.speed*dt);
      for (const obstacle of obstacles) {
        normal.copy(enemy.mesh.position).sub(obstacle.position);
        if (normal.length() < obstacle.radius+18) enemy.mesh.position.copy(obstacle.position).addScaledVector(normal.normalize(),obstacle.radius+18);
      }
      enemy.hitTimer = Math.max(0,enemy.hitTimer-dt);
      const flicker = enemy.hitTimer > 0 ? (Math.floor(enemy.hitTimer*55)%2 ? .65 : 1.15) : 1;
      enemy.mesh.scale.setScalar(flicker);
      for (const flame of enemy.mesh.userData.flames) flame.scale.y = .6+enemy.speed/150+Math.sin(time*17+enemy.phase)*.08;
      enemy.shootTimer -= dt;
      if (enemy.shootTimer <= 0 && distance < 640 && distance > 55 && enemy.breakTimer <= 0) {
        lead.copy(player).addScaledVector(playerVelocity,Math.min(distance/410,.9)*.66).sub(enemy.mesh.position).normalize();
        if (lead.dot(enemy.direction) > .945) {
          target.copy(enemy.mesh.position).addScaledVector(enemy.direction,11);
          launch(target,lead,true,11+enemy.variant*2);
          enemy.shootTimer = 2.25 + enemy.variant*.25 + (Math.sin(enemy.phase+time)*.5+.5)*.5;
        }
      }
    }
  }

  function update(dt, time, playerPosition, playerDirection = FORWARD, speed = 0) {
    if (disposed || !group.visible || !(dt > 0)) return;
    dt = Math.min(dt,.1); elapsed += dt;
    playerVelocity.copy(playerDirection).normalize().multiplyScalar(speed);
    const movement = hasPlayerPrevious ? playerPrevious.distanceTo(playerPosition) : 0;
    const continuous = hasPlayerPrevious && movement <= Math.max(100,Math.abs(speed)*dt*4+35);
    for (const ring of rings) {
      ring.cooldown = Math.max(0,ring.cooldown-dt); ring.pulse = Math.max(0,ring.pulse-dt);
      ring.markers.rotation.z += dt*.13;
      if (continuous && ring.cooldown <= 0 && crossesRing(playerPrevious,playerPosition,ring.position,ring.normal,ring.innerRadius)) {
        ring.cooldown = 5; ring.pulse = 1.15; ring.passes++;
        onBoost({ ring, index:ring.index, duration:3.4, multiplier:1.35 });
      }
      const active = ring.pulse > 0;
      ring.material.color.set(active ? '#fff0a9' : ring.cooldown > 0 ? '#527e77' : '#8aeada');
      ring.haloMaterial.color.set(active ? '#ffda77' : '#66d9c6');
      ring.haloMaterial.opacity = active ? .12+ring.pulse*.2 : .085+Math.sin(time*2+ring.index)*.035;
      ring.mesh.scale.setScalar(active ? 1+Math.sin(ring.pulse*Math.PI)*.025 : 1);
    }
    updateEnemies(dt,time,playerPosition,playerDirection,speed);
    for (const bolt of bolts) {
      if (bolt.life <= 0) continue;
      bolt.previous.copy(bolt.mesh.position); bolt.mesh.position.addScaledVector(bolt.velocity,dt); bolt.life -= dt;
      let hit = false;
      if (bolt.hostile) {
        // Relative-motion sweep prevents high-speed player/bolt tunnelling.
        target.copy(bolt.previous).sub(continuous ? playerPrevious : playerPosition);
        next.copy(bolt.mesh.position).sub(playerPosition);
        if (segmentSphereHitTime(target,next,ZERO,5.6) !== null) {
          onPlayerDamage(bolt.damage); hit = true; burst(bolt.mesh.position,4,17);
        }
      } else hit = tryHitSegment(bolt.previous,bolt.mesh.position,bolt.damage);
      if (!hit) for (const obstacle of obstacles) {
        if (segmentSphereHitTime(bolt.previous,bolt.mesh.position,obstacle.position,obstacle.radius) !== null) { hit = true; break; }
      }
      if (hit || bolt.life <= 0) { bolt.life = 0; bolt.mesh.visible = false; }
    }
    for (const spark of sparks) {
      if (spark.life <= 0) continue;
      spark.life -= dt; spark.mesh.position.addScaledVector(spark.velocity,dt);
      spark.velocity.multiplyScalar(Math.exp(-dt*1.7)); spark.mesh.scale.multiplyScalar(Math.exp(-dt*2.1));
      spark.mesh.rotation.x += dt*3; spark.mesh.rotation.z += dt*2;
      if (spark.life <= 0) spark.mesh.visible = false;
    }
    playerPrevious.copy(playerPosition); hasPlayerPrevious = true;
  }

  function nearestEnemy(position, direction = null, maxDistance = 900) {
    let result = null, best = maxDistance;
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      to.copy(enemy.mesh.position).sub(position);
      const distance = to.length();
      if (distance > best || (direction && to.normalize().dot(direction) < .3)) continue;
      best = distance; result = enemy;
    }
    return result;
  }

  function reset() {
    hasPlayerPrevious = false; elapsed = 0;
    for (const ring of rings) { ring.cooldown = 0; ring.pulse = 0; ring.passes = 0; ring.mesh.scale.setScalar(1); ring.material.color.set('#8aeada'); }
    for (const enemy of enemies) {
      enemy.hp = enemy.maxHp; enemy.alive = true; enemy.mesh.visible = true;
      enemy.mesh.position.copy(enemy.home); enemy.previous.copy(enemy.home); enemy.mesh.scale.setScalar(1);
      enemy.direction.set(Math.sin(enemy.phase),0,Math.cos(enemy.phase)).normalize();
      enemy.mesh.quaternion.setFromUnitVectors(FORWARD,enemy.direction);
      enemy.shootTimer = 2.4+(enemy.phase%2); enemy.breakTimer = 0; enemy.hitTimer = 0; enemy.respawnTimer = 0; enemy.engaged = false;
    }
    for (const list of [bolts,sparks]) for (const value of list) { value.life = 0; value.mesh.visible = false; }
  }

  function dispose() {
    if (disposed) return;
    disposed = true; group.removeFromParent();
    assets.geometries.forEach(value => value.dispose()); assets.materials.forEach(value => value.dispose());
    group.clear();
  }

  return { group, enemies, rings, update, tryHitSegment, nearestEnemy, reset, dispose,
    shoot(origin,direction,damage=30) { return launch(origin,direction,false,damage); },
    clearProjectiles() { hasPlayerPrevious = false; for (const bolt of bolts) { bolt.life=0; bolt.mesh.visible=false; } },
  };
}
