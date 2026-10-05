import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Ship, FLIGHT } from '../game/actors/ship.js';
import { SpaceScenery } from '../game/space/scenery.js';
import { RIFTS } from '../game/space/rifts.js';
import { Run } from '../game/gameplay/run.js';
import { validateRun } from '../netlify/functions/_shared/leaderboard-core.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const ship = () => new Ship({ scene: new THREE.Group(), animations: [] });
const fly = (s, seconds, input = {}, env = {}) => {
  for (let t = 0; t < seconds; t += 1 / 60) s.update(1 / 60, { pitch: 0, yaw: 0, roll: 0, throttleUp: false, throttleDown: false, boost: false, mouse: { x: 0, y: 0 }, ...input }, { inAtmosphere: 0, nearestDistance: Infinity, ...env });
};

test('limits hold the Aster to dogfight speed and jam the pulse drive; open space does not', () => {
  const s = ship(); s.launchAt(V(), V(0, 0, -1));
  fly(s, 20, { boost: true }, { limits: { max: 520, boost: 820, pulse: false } });
  assert.equal(s.pulse, false);
  assert.ok(Math.abs(s.speed - 820) < 1, `boost cap (${s.speed.toFixed(0)})`);
  fly(s, 4, { boost: true });
  assert.equal(s.pulse, true, 'the pulse drive engages in open space');
  assert.ok(s.speed > FLIGHT.spaceMax * 1.6);
});

test('a slipstream surge carries the Aster past its cap, then bleeds off', () => {
  const s = ship(); s.launchAt(V(), V(0, 0, -1), V(0, 1, 0), 1000);
  fly(s, 2, { throttleUp: true }, { limits: { max: 1000, boost: 1450, pulse: false } });
  s.addSurge(600);
  fly(s, 0.2, { throttleUp: true }, { limits: { max: 1000, boost: 1450, pulse: false } });
  assert.ok(s.speed > 1250, `surging (${s.speed.toFixed(0)})`);
  fly(s, 4, { throttleUp: true }, { limits: { max: 1000, boost: 1450, pulse: false } });
  assert.ok(s.surge === 0 && Math.abs(s.speed - 1000) < 2, `back to the cap (${s.speed.toFixed(0)})`);
});

test('a barrel roll is a full turn about the nose with a cooldown, and dodges while it lasts', () => {
  const s = ship(); s.launchAt(V(), V(0, 0, -1));
  const up = s.up(V()).clone();
  assert.equal(s.barrelRoll(1), true);
  assert.equal(s.evading, true);
  assert.equal(s.barrelRoll(1), false, 'cooldown');
  fly(s, 0.3);
  assert.ok(s.up(V()).dot(up) < 0, 'upside down halfway through');
  fly(s, 0.4);
  assert.equal(s.evading, false);
  assert.ok(s.up(V()).dot(up) > 0.999, 'level again');
  assert.ok(s.forward(V()).dot(V(0, 0, -1)) > 0.999, 'still on course');
  fly(s, 1.5);
  assert.equal(s.barrelRoll(-1), true);
});

test('debris fields are solid: overlaps push out, bolts spark, and steering avoids rocks', () => {
  const scenery = new SpaceScenery(new THREE.Scene());
  const rock = scenery.views.get('hum').rocks.find(r => r.radius > 20);
  const inside = rock.center.clone().add(V(rock.radius * 0.5, 0, 0));
  const hit = scenery.collide(inside, 7);
  assert.ok(hit && hit.depth > 0 && hit.normal.x > 0.9);
  assert.ok(scenery.segmentHit(rock.center.clone().add(V(rock.radius * 2, 0, 0)), rock.center.clone().add(V(rock.radius * 0.5, 0, 0))));
  const push = scenery.avoid(rock.center.clone().add(V(rock.radius + 10, 0, 0)), 40, V());
  assert.ok(push.x > 0);
  assert.equal(scenery.collide(new THREE.Vector3(...RIFTS[0].position).add(V(0, 60000, 0)), 7), null, 'nothing in open space');
});

test('space runs (kills, gates, laps, rifts, the carrier) are accepted by the flight log', () => {
  let t = 0; const run = new Run(() => t * 1000);
  for (let i = 0; i < 16; i++) { run.reward(`circuit:${i}`, 'gate'); t += 2; }
  run.reward('lap', 'lap');
  for (let i = 0; i < 60; i++) { run.kill(false); t += 1.5; }
  run.reward('rift:hum', 'rift'); run.reward('rift:dissonance', 'rift'); run.reward('flagship', 'flagship');
  const r = run.record('Pilot');
  assert.doesNotThrow(() => validateRun({ name: r.name, score: r.score, kills: r.kills, level: r.level, xp: r.xp, duration: r.duration, bossKills: r.bossKills }), JSON.stringify(r));
});
