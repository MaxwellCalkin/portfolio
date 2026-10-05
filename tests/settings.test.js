import test from 'node:test';
import assert from 'node:assert/strict';
import { Settings, detectQuality, QUALITY } from '../game/app/settings.js';

const env = ({ coarse = false, cores = 8, memory = 8, width = 1440, height = 900, search = '' } = {}) => ({
  location: { search }, innerWidth: width, innerHeight: height,
  navigator: { hardwareConcurrency: cores, deviceMemory: memory },
  matchMedia: q => ({ matches: q.includes('coarse') ? coarse : false }),
});

test('quality adapts to the device unless chosen', () => {
  assert.equal(detectQuality('auto', env()), 'high');
  assert.equal(detectQuality('auto', env({ coarse: true, width: 390, height: 844 })), 'low');
  assert.equal(detectQuality('auto', env({ cores: 4 })), 'medium');
  assert.equal(detectQuality('low', env()), 'low');
  assert.equal(detectQuality('auto', env({ search: '?quality=medium' })), 'medium');
  for (const tier of ['high', 'medium', 'low']) assert.ok(QUALITY[tier].pixelRatio >= 1);
});

test('settings persist and notify listeners', () => {
  const memory = new Map();
  const storage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) };
  const s = new Settings(storage);
  let seen = null; s.onChange(patch => { seen = patch; });
  s.set({ volume: 0.3, invertY: true });
  assert.deepEqual(seen, { volume: 0.3, invertY: true });
  const again = new Settings(storage);
  assert.equal(again.get('volume'), 0.3);
  assert.equal(again.get('invertY'), true);
  assert.equal(new Settings({ getItem: () => '{"quality":"ultra"}' }).get('quality'), 'auto');
});
