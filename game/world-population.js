import * as THREE from 'three';

export const POPULATION_LIMIT = 10;
export const POPULATION_RANGE = 170;
const RETAIN_RANGE = 220;
function hash(text) {
  let value = 2166136261;
  for (const letter of text) value = Math.imul(value ^ letter.charCodeAt(0), 16777619);
  return value >>> 0;
}

/** Lazily materialized inhabitants. Stable habitat IDs retain damage and deaths
 * throughout the current expedition; leaving a sector cannot refill its XP. */
export function createWorldPopulation(surfaces, { spawn, despawn }) {
  const active = new Map(), dormant = new Map(), defeated = new Set();
  let pending = [];
  let lastCheck = -Infinity, lastFocus = new THREE.Vector3(Infinity, Infinity, Infinity), lastSurface = null, lastEnabled = false;
  function deactivate(id, enemy) {
    dormant.set(id, { hp: enemy.hp, position: enemy.mesh.position.clone(), shoot: enemy.shoot });
    active.delete(id); despawn(enemy);
  }
  function descriptors(surface, focus) {
    const sectors = surface.nearbySectors(focus, POPULATION_RANGE + 80);
    const result = [];
    for (const sector of sectors) {
      const frame = surface.frameAt(sector.position);
      for (let slot = 0; slot < 3; slot++) {
        const id = `${surface.spec.id}:${sector.id}:creature-${slot}`, seed = hash(id);
        const angle = (seed % 62832) / 10000, radius = 23 + ((seed >>> 8) % 32);
        let position = surface.groundAt(sector.position.clone().addScaledVector(frame.right, Math.cos(angle) * radius).addScaledVector(frame.forward, Math.sin(angle) * radius));
        const shrine = surface.nearestShrine(position);
        if (shrine && position.distanceTo(shrine.position) < 16) {
          const away = position.clone().sub(shrine.position).addScaledVector(frame.up, -position.clone().sub(shrine.position).dot(frame.up));
          if (away.lengthSq() < .01) away.copy(frame.right);
          position = surface.groundAt(shrine.position.clone().addScaledVector(away.normalize(), 20));
        }
        // The safe boarding strip at the original survey camp remains clear.
        if (position.distanceTo(surface.shipPosition) < 20) position = surface.groundAt(position.addScaledVector(frame.right, 28));
        result.push({ id, surface, position, species: seed % 3, hp: 73 + (seed % 3) * 8, speed: 2.6 + (seed % 5) * .12, phase: (seed % 100) / 10, shoot: 1.8 + (seed % 19) / 10 });
      }
    }
    return result;
  }
  function update(focus, surface, time, enabled = true) {
    if (time - lastCheck < .4 && surface === lastSurface && enabled === lastEnabled && focus.distanceToSquared(lastFocus) < 18 ** 2) { materialize(focus, surface, enabled); return; }
    lastCheck = time; lastSurface = surface; lastEnabled = enabled; lastFocus.copy(focus);
    for (const [id, enemy] of active) {
      if (!enabled || enemy.surface !== surface || enemy.mesh.position.distanceTo(focus) > RETAIN_RANGE) deactivate(id, enemy);
    }
    if (!enabled || !surface) return;
    const candidates = descriptors(surface, focus).filter(item => !defeated.has(item.id) && !active.has(item.id));
    candidates.forEach(item => { const saved = dormant.get(item.id); if (saved) Object.assign(item, { ...saved, position: saved.position.clone() }); item.distance = item.position.distanceTo(focus); });
    candidates.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    pending = candidates;
    materialize(focus, surface, enabled);
  }
  function materialize(focus, surface, enabled) {
    if (!enabled || !surface) { pending = []; return; }
    // One detailed model per rendered update prevents first-contact geometry
    // construction from freezing a continuous approach for hundreds of ms.
    while (pending.length && active.size < POPULATION_LIMIT) {
      const item = pending.shift(), distance = item.position.distanceTo(focus);
      if (item.surface !== surface || defeated.has(item.id) || active.has(item.id) || distance > POPULATION_RANGE || distance < 14) continue;
      const enemy = spawn(item);
      if (enemy) { enemy.populationId = item.id; active.set(item.id, enemy); dormant.delete(item.id); }
      break;
    }
  }
  function markDefeated(id) { if (!id) return; defeated.add(id); active.delete(id); dormant.delete(id); }
  function reset() { for (const enemy of active.values()) despawn(enemy); active.clear(); dormant.clear(); defeated.clear(); pending = []; lastCheck = -Infinity; lastSurface = null; lastFocus.set(Infinity, Infinity, Infinity); }
  function getStats() { return { activeCount: active.size, dormantCount: dormant.size, defeatedCount: defeated.size, limit: POPULATION_LIMIT }; }
  return { update, markDefeated, reset, getStats, descriptors };
}
