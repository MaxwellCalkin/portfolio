import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Challenges, GrooveTracker } from '../game/gameplay/challenges.js';

const FX = { ring() {}, sparks() {}, flash() {} };
const pad = k => -5.25 + 1.5 * k; // the stage's pad row (art/blender/landmarks_a.py)

test('walking across the pads in between never breaks the groove', () => {
  const groove = new GrooveTracker();
  // 1, 4, 5, 4, 6, 5 on foot: every pad crossed on the way plays too.
  const walk = [0, 1, 2, 3, 4, 3, 4, 5, 4];
  assert.deepEqual(walk.map(p => groove.note(p)), [false, false, false, false, false, false, false, false, true]);
});

test('a wrong note still breaks the groove, and stepping back on a pad does not count twice', () => {
  const wrong = new GrooveTracker();
  assert.ok(![0, 3, 4, 3, 6, 5, 4].some(p => wrong.note(p)), 'overshooting to 7 is a wrong note');
  const repeats = new GrooveTracker();
  assert.deepEqual([0, 0, 3, 3, 4, 3, 5, 4].map(p => repeats.note(p)).at(-1), true);
  const restart = new GrooveTracker();
  assert.ok(![0, 3, 1].some(p => restart.note(p)));
  assert.deepEqual([0, 3, 4, 3, 5, 4].map(p => restart.note(p)).at(-1), true, 'starting over on pad 1 works');
});

test('walking the groove on the stage unlocks the air bass once', () => {
  let grooves = 0;
  const challenges = new Challenges(new THREE.Scene(), { fx: FX, sound: null, events: { onGroove: () => grooves++ } });
  const world = { pois: Array.from({ length: 8 }, (_, k) => ({ name: `POI_pad_${k}`, position: new THREE.Vector3(pad(k), 0, 0) })) };
  const player = { position: new THREE.Vector3(pad(0), 0, 0), grounded: true, up: new THREE.Vector3(0, 1, 0) };
  const walkTo = k => {
    while (Math.abs(player.position.x - pad(k)) > 0.05) {
      player.position.x += Math.sign(pad(k) - player.position.x) * 0.05;
      challenges.updatePads(world, player);
    }
  };
  challenges.updatePads(world, player);
  for (const k of [3, 4, 3, 5, 4]) walkTo(k);
  assert.equal(grooves, 1);
});

test('a target run cancels without a result; targets share materials and bob along the planet up', () => {
  const phases = [];
  const up = new THREE.Vector3(0.29, 0.88, 0.38).normalize();
  const spawns = Array.from({ length: 8 }, (_, i) => ({ name: `SPAWN_target_${i}`, position: new THREE.Vector3(i * 3, 2, 0), up }));
  const challenges = new Challenges(new THREE.Scene(), { fx: FX, sound: null, events: { onArena: phase => phases.push(phase) } });
  assert.equal(challenges.startArena({ spawns }), true);
  challenges.update(0.1, 0.4);
  assert.equal(challenges.targets.length, 3);
  assert.equal(new Set(challenges.targets.map(t => t.ring.material)).size, 1);
  for (const t of challenges.targets) {
    const offset = t.root.position.clone().sub(t.position);
    assert.ok(offset.clone().cross(up).length() < 1e-9, 'the bob follows the radial up');
  }
  challenges.cancelArena();
  assert.equal(challenges.arenaActive, false);
  assert.equal(challenges.group.children.length, 0);
  challenges.update(60, 60);
  assert.deepEqual(phases, ['start'], 'no fail toast after leaving');
  challenges.startArena({ spawns });
  challenges.update(36, 36);
  assert.deepEqual(phases, ['start', 'start', 'fail'], 'an abandoned run still times out');
});
