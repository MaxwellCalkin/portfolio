import test from 'node:test';
import assert from 'node:assert/strict';
import { WEAPONS, weaponForXP, levelForXP, hitSegmentSphere, applyDamage } from '../game/model.js';

const point = (x = 0, y = 0, z = 0) => ({ x, y, z });
const add = (p, d) => point(p.x + d.x, p.y + d.y, p.z + d.z);

test('weapon progression is monotonic and exact at every upgrade boundary', () => {
  let previous = 1;
  for (let xp = 0; xp <= 1000; xp++) {
    const level = levelForXP(xp);
    assert.ok(level >= previous && level <= WEAPONS.length);
    assert.equal(weaponForXP(xp), WEAPONS[level - 1]);
    previous = level;
  }
  WEAPONS.forEach((weapon, index) => {
    assert.equal(weaponForXP(weapon.at), weapon);
    if (index) assert.equal(weaponForXP(weapon.at - 0.001), WEAPONS[index - 1]);
  });
});

test('swept shots detect tangency, starting inside, and zero movement', () => {
  assert.equal(hitSegmentSphere(point(-8), point(8), point(0, 2), 2), true);
  assert.equal(hitSegmentSphere(point(-8), point(8), point(0, 2.001), 2), false);
  assert.equal(hitSegmentSphere(point(), point(20), point(), 1), true);
  assert.equal(hitSegmentSphere(point(), point(), point(0, 0, 1), 1), true);
  assert.equal(hitSegmentSphere(point(), point(), point(0, 0, 1.01), 1), false);
});

test('swept shots do not hit a sphere only on the line beyond the actual flight segment', () => {
  assert.equal(hitSegmentSphere(point(), point(5), point(7), 1), false);
  assert.equal(hitSegmentSphere(point(), point(5), point(-2), 1), false);
  assert.equal(hitSegmentSphere(point(), point(5), point(6), 1), true);
});

test('swept hit results are invariant under travel reversal and world translation', () => {
  const offset = point(140, -71, 1000);
  for (let i = 0; i < 80; i++) {
    const start = point(Math.sin(i) * 20, Math.cos(i * 1.7) * 5, i / 4);
    const end = point(Math.cos(i) * 15, Math.sin(i * 0.7) * 8, -i / 3);
    const center = point(Math.sin(i * 2.3) * 9, Math.cos(i * 0.5) * 3, 0);
    const radius = 0.5 + (i % 7);
    const hit = hitSegmentSphere(start, end, center, radius);
    assert.equal(hitSegmentSphere(end, start, center, radius), hit);
    assert.equal(hitSegmentSphere(add(start, offset), add(end, offset), add(center, offset), radius), hit);
  }
});

test('fractional contact damage consumes shields first without negative vitality', () => {
  const state = { shield: 100, health: 100 };
  let totalDamage = 0;
  for (let frame = 0; frame < 900; frame++) {
    const damage = 18 / 60;
    totalDamage += damage;
    const dead = applyDamage(state, damage);
    assert.ok(state.shield >= 0 && state.health >= 0);
    assert.equal(dead, state.health === 0);
    assert.ok(Math.abs(state.shield + state.health - Math.max(0, 200 - totalDamage)) < 1e-8);
  }
  assert.deepEqual(state, { shield: 0, health: 0 });
});
