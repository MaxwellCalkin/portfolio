import test from 'node:test';
import assert from 'node:assert/strict';
import { Run, CRYSTALS, MAX_DURATION } from '../game/gameplay/run.js';
import { validateRun } from '../netlify/functions/_shared/leaderboard-core.js';
import { levelForXP } from '../game/model.js';

function clock() { let t = 0; const now = () => t; now.advance = s => { t += s * 1000; }; return now; }

test('rewards are granted once per key', () => {
  const run = new Run(clock());
  assert.equal(run.reward('philosophy:origin', 'archive'), CRYSTALS.archive);
  assert.equal(run.reward('philosophy:origin', 'archive'), 0);
  assert.equal(run.crystals, CRYSTALS.archive);
});

test('every reachable run is accepted by the public flight log', () => {
  const now = clock(), run = new Run(now);
  const mixes = [['discovery', 30], ['archive', 5], ['shard', 50], ['arena', 1], ['groove', 1], ['world', 10]];
  let n = 0;
  for (const [kind, count] of mixes) {
    for (let i = 0; i < count; i++) {
      run.reward(`${kind}:${i}`, kind); now.advance(7);
      if (++n % 3 === 0) run.kill(false);
      if (n % 25 === 0) run.kill(true);
      const record = run.record('Tester');
      assert.equal(record.level, levelForXP(record.xp));
      assert.equal(record.score % 5, 0);
      if (record.score > 0) assert.doesNotThrow(() => validateRun({ name: record.name, score: record.score, kills: record.kills, level: record.level, xp: record.xp, duration: record.duration, bossKills: record.bossKills }), JSON.stringify(record));
    }
  }
  assert.ok(run.wardens <= 5 && run.wardens <= run.kills);
});

test('paused time does not count toward the run duration', () => {
  const now = clock(), run = new Run(now);
  now.advance(10); run.pause(true); now.advance(100); run.pause(false); now.advance(5);
  assert.equal(run.duration, 15);
});

test('an open panel and a hidden tab pause the clock together, without double counting', () => {
  const now = clock(), run = new Run(now);
  now.advance(10); run.pause(true); now.advance(20); run.pause(true, 'hidden'); now.advance(30);
  run.pause(false); now.advance(40);
  assert.equal(run.duration, 10, 'still paused while the tab is hidden');
  run.pause(false, 'hidden'); now.advance(5);
  assert.equal(run.duration, 15);
});

test('a run left open for days can still be published', () => {
  const now = clock(), run = new Run(now);
  run.reward('philosophy:origin', 'archive'); now.advance(3 * MAX_DURATION);
  const record = run.record('Tester');
  assert.equal(record.duration, MAX_DURATION);
  assert.doesNotThrow(() => validateRun({ name: record.name, score: record.score, kills: record.kills, level: record.level, xp: record.xp, duration: record.duration, bossKills: record.bossKills }));
});
