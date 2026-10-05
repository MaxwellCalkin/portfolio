import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SpaceDirector } from '../game/space/director.js';
import { RIFTS, FIELD_RADIUS, LEASH_RADIUS, wavesFor, tierFor } from '../game/space/rifts.js';

/** Just enough fleet for the director: spawn, count, despawn. */
class FakeFleet {
  constructor() { this.enemies = []; }
  spawn(type, position, { tag, tier }) { const e = { type, position: position.clone(), tag, tier, dead: false }; this.enemies.push(e); return e; }
  count(tag) { return this.enemies.filter(e => !e.dead && (!tag || e.tag === tag)).length; }
  despawn(tag) { this.enemies = this.enemies.filter(e => tag && e.tag !== tag); }
  kill(tag = 'rift') { this.enemies = this.enemies.filter(e => e.tag !== tag); }
}

function setup({ patrols = false } = {}) {
  const fleet = new FakeFleet(), clears = {}, log = [];
  const director = new SpaceDirector({ fleet, random: () => 0.25, clears: id => clears[id] || 0, events: {
    onIncursion: e => log.push(`incursion ${e.rift.id} w${e.wave}${e.resumed ? ' resumed' : ''}${e.encore ? ' encore' : ''}`), onWave: e => log.push(`wave ${e.wave}`),
    onWaveCleared: () => log.push('cleared'), onRiftCleared: e => { clears[e.rift.id] = (clears[e.rift.id] || 0) + 1; log.push(`silenced ${e.rift.id}`); },
    onAbort: (e, reason) => log.push(`abort ${reason}`), onPatrol: () => log.push('patrol'),
  } });
  const hum = RIFTS[0], center = new THREE.Vector3(...hum.position);
  const at = d => center.clone().add(new THREE.Vector3(0, 0, d)); // `d` meters from the rift
  const ctx = (position, extra = {}) => ({ position, forward: new THREE.Vector3(0, 0, -1), flying: true, patrols, quiet: false, ...extra });
  const tick = (position, seconds = 0.1, extra) => { for (let t = 0; t < seconds; t += 0.1) director.update(0.1, ctx(position, extra)); };
  return { fleet, director, clears, log, at, tick, hum };
}

test('flying into a field starts an incursion; waves arrive after a warning, away from the Aster', () => {
  const { fleet, director, log, at, tick } = setup();
  tick(at(FIELD_RADIUS + 200));
  assert.equal(director.encounter, null, 'outside the field');
  tick(at(FIELD_RADIUS - 100));
  assert.deepEqual(log, ['incursion hum w0']);
  assert.equal(fleet.count(), 0, 'a warning first');
  tick(at(FIELD_RADIUS - 100), 2.6);
  assert.equal(fleet.count('rift'), 3);
  for (const e of fleet.enemies) assert.ok(e.position.distanceTo(at(FIELD_RADIUS - 100)) > 900 && e.tier === 1);
});

test('clearing every wave silences the rift, which stays quiet until you leave and come back', () => {
  const { fleet, director, log, at, tick } = setup();
  const inside = at(1500);
  tick(inside, 2.6);
  for (let w = 0; w < 3; w++) { fleet.kill(); tick(inside, 0.2); if (w < 2) tick(inside, 2.6); }
  assert.deepEqual(log, ['incursion hum w0', 'wave 0', 'cleared', 'wave 1', 'cleared', 'wave 2', 'silenced hum']);
  tick(inside, 5);
  assert.equal(director.encounter, null, 'no instant encore while still inside');
  tick(at(FIELD_RADIUS + 500));
  tick(inside);
  assert.equal(log.at(-1), 'incursion hum w0 encore');
  assert.equal(director.encounter.tier, 2);
  assert.deepEqual(director.encounter.waves[0], [['glitch', 4]], 'encores add to the glitch count');
});

test('flying out of the leash retreats; going down resumes at the same wave', () => {
  const { fleet, director, log, at, tick } = setup();
  tick(at(1500), 2.6);
  tick(at(LEASH_RADIUS + 100), 0.2);
  assert.equal(log.at(-1), 'abort retreat');
  assert.equal(fleet.count(), 0);
  tick(at(1500), 2.6); fleet.kill(); tick(at(1500), 2.8); // into wave 2
  assert.equal(director.encounter.wave, 1);
  const spot = director.respawnPoint(at(1500));
  director.abort('down');
  assert.ok(spot.position.distanceTo(at(0)) > FIELD_RADIUS, 'the Aster re-forms outside the field');
  tick(spot.position);
  tick(at(1500));
  assert.equal(log.at(-1), 'incursion hum w1 resumed');
});

test('encores scale; the boss wave never grows', () => {
  for (const rift of RIFTS) {
    assert.deepEqual(wavesFor(rift, 0), rift.waves);
    const encore = wavesFor(rift, 5);
    encore.forEach((wave, i) => {
      if (rift.waves[i].some(([t]) => t === 'boss')) assert.deepEqual(wave, rift.waves[i]);
      else assert.equal(wave.reduce((n, [, c]) => n + c, 0), rift.waves[i].reduce((n, [, c]) => n + c, 0) + 3);
    });
    assert.equal(tierFor(rift, 9), rift.tier + 4);
  }
});

test('patrols find you in open space, only when allowed, and give up when you outrun them', () => {
  const { fleet, director, log, tick } = setup({ patrols: true });
  const open = new THREE.Vector3(15000, 25000, 5000);
  director.patrolTimer = 0.05;
  tick(open, 0.1, { quiet: true });
  assert.equal(fleet.count(), 0, 'not near a world');
  tick(open, 0.1, { patrols: false });
  assert.equal(fleet.count(), 0, 'not with patrols off');
  tick(open, 0.1);
  assert.deepEqual(log, ['patrol']);
  const squad = fleet.count('patrol');
  assert.ok(squad >= 2 && squad <= 3);
  for (const e of fleet.enemies) assert.ok(e.position.z < open.z, 'ahead of the Aster');
  tick(open.clone().add(new THREE.Vector3(0, 0, -20000)));
  assert.equal(fleet.count(), 0, 'outran');
});
