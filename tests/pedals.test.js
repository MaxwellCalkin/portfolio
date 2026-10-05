import test from 'node:test';
import assert from 'node:assert/strict';
import { PEDALS, COSTS, loadout, levelOf, nextCost, pedalCount } from '../game/space/pedals.js';
import { Journal } from '../game/gameplay/discoveries.js';

function memory() { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) }; }

test('every pedal level costs Tone in order; earned pedals are never for sale', () => {
  for (const pedal of PEDALS) {
    if (pedal.earned) { assert.equal(nextCost({}, pedal.id), null); continue; }
    const owned = {};
    for (let level = 0; level < pedal.levels.length; level++) { assert.equal(nextCost(owned, pedal.id), COSTS[level]); owned[pedal.id] = level + 1; }
    assert.equal(nextCost(owned, pedal.id), null, `${pedal.id} maxes out`);
  }
  assert.equal(levelOf({ overdrive: 99 }, 'overdrive'), 3, 'levels are clamped');
  assert.equal(levelOf({ overdrive: 'x' }, 'overdrive'), 0);
});

test('every engaged pedal makes the Aster strictly better', () => {
  const base = loadout({});
  const max = loadout(Object.fromEntries(PEDALS.map(p => [p.id, p.levels.length])));
  assert.ok(max.fireInterval < base.fireInterval && max.bolts > base.bolts && max.damage > base.damage);
  assert.ok(max.missiles > 0 && base.missiles === 0 && max.missileCooldown > 0);
  assert.ok(max.shieldMax > base.shieldMax && max.shieldDelay < base.shieldDelay && max.shieldRegen > base.shieldRegen);
  assert.ok(max.boost > base.boost && max.surge > base.surge && max.echo > base.echo);
  assert.ok(max.ram && !base.ram && max.reverb && !base.reverb);
  for (const pedal of PEDALS) {
    let previous = loadout({});
    for (let level = 1; level <= pedal.levels.length; level++) {
      const next = loadout({ [pedal.id]: level });
      assert.notDeepEqual(next, previous, `${pedal.id} ${level} changes something`);
      previous = next;
    }
  }
});

test('the journal spends Tone on pedals and keeps them through a journal reset', () => {
  const storage = memory(), journal = new Journal(storage);
  assert.equal(journal.buyPedal('overdrive'), null, 'no Tone, no pedal');
  journal.addTone(COSTS[0] + COSTS[1] - 1);
  assert.equal(journal.buyPedal('overdrive'), 1);
  assert.equal(journal.buyPedal('overdrive'), null, 'one Tone short');
  journal.addTone(1);
  assert.equal(journal.buyPedal('overdrive'), 2);
  assert.equal(journal.data.tone, 0);
  assert.equal(journal.buyPedal('reverb'), null, 'Reverb is earned, not bought');
  assert.equal(journal.earnPedal('reverb'), true);
  assert.equal(journal.earnPedal('reverb'), false);
  assert.equal(journal.clearRift('hum'), 1); assert.equal(journal.clearRift('hum'), 2);
  assert.equal(journal.recordLap(41.2), true); assert.equal(journal.recordLap(44), false); assert.equal(journal.recordLap(39.9), true);
  assert.equal(journal.addMedal('bronze'), true); assert.equal(journal.addMedal('bronze'), false);
  journal.discover('philosophy:origin');
  journal.reset();
  const again = new Journal(storage);
  assert.equal(again.progress().found, 0, 'discoveries reset');
  assert.deepEqual(again.data.pedals, { overdrive: 2, reverb: 1 });
  assert.equal(again.riftClears('hum'), 2);
  assert.equal(again.data.circuitBest, 39.9);
  assert.deepEqual(again.data.medals, ['bronze']);
  assert.equal(pedalCount(again.data.pedals), 3);
});

test('a corrupted journal falls back to safe space values', () => {
  const storage = memory();
  storage.setItem('unfolding-journal-v2', JSON.stringify({ tone: -50, pedals: [1, 2], rifts: 'hum', circuitBest: 'fast', medals: 'gold' }));
  const journal = new Journal(storage);
  assert.equal(journal.data.tone, 0);
  assert.deepEqual(journal.data.pedals, {});
  assert.deepEqual(journal.data.rifts, {});
  assert.equal(journal.data.circuitBest, null);
  assert.deepEqual(journal.data.medals, []);
  assert.equal(journal.addTone(Number.NaN), 0);
});
