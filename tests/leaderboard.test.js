import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_KEY, MAX_BODY_BYTES, MAX_ENTRIES, validateRun, recordRun, readLeaderboard, createLeaderboardHandler } from '../netlify/functions/_shared/leaderboard-core.js';

const valid = { name: 'Explorer', score: 110, kills: 1, xp: 40, level: 1, duration: 10 };
let id = 0;
const options = {
  now: () => new Date('2026-09-30T12:00:00.000Z'),
  uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
  pause: async () => {},
};

class MemoryStore {
  value = null;
  revision = 0;
  writes = [];
  reads = [];
  async getWithMetadata(key, opts) {
    this.reads.push({ key, opts });
    return this.value === null ? null : { data: structuredClone(this.value), etag: `"${this.revision}"` };
  }
  async setJSON(key, value, opts) {
    this.writes.push({ key, value: structuredClone(value), opts });
    const matches = this.value === null ? opts.onlyIfNew === true : opts.onlyIfMatch === `"${this.revision}"`;
    if (!matches) return { modified: false };
    this.value = structuredClone(value);
    this.revision++;
    return { modified: true, etag: `"${this.revision}"` };
  }
}

function handler(store = new MemoryStore()) {
  return createLeaderboardHandler({ getStore: () => store, recordOptions: options });
}

function request(body = valid, init = {}) {
  return new Request('https://portfolio.test/.netlify/functions/leaderboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://portfolio.test' },
    body: JSON.stringify(body),
    ...init,
  });
}

test('run validation sanitizes names and projects only approved fields', () => {
  assert.equal(validateRun({ ...valid, name: '  <Pilot> & 🚀  ' }).name, 'Pilot');
  assert.equal(validateRun({ ...valid, name: ' '.repeat(20) }).name, 'Explorer');
  assert.equal(validateRun({ ...valid, name: 'x'.repeat(50) }).name.length, 20);
  assert.throws(() => validateRun({ ...valid, email: 'private@example.test' }));
  assert.throws(() => validateRun({ ...valid, date: '2030-01-01' }));
});

test('valid gameplay includes instant landing, first-wave ultimate, crystals, and later waves', () => {
  for (const run of [
    { ...valid, score: 25, kills: 0, xp: 0, level: 1, duration: 0 },
    { ...valid, score: 660, kills: 6, xp: 240, level: 2, duration: 1 },
    { ...valid, score: 1100, kills: 6, xp: 350, level: 3, duration: 2 },
    { ...valid, score: 1525, kills: 13, xp: 520, level: 3, duration: 30 },
    { ...valid, score: 600, kills: 0, xp: 110, level: 1, duration: 10 },
  ]) assert.doesNotThrow(() => validateRun(run));
});

test('inconsistent XP, level, score, fractional values, and absurd rates are rejected', () => {
  for (const patch of [
    { xp: 39 }, { xp: 41 }, { level: 4 }, { score: 1 }, { score: 111 },
    { score: 1e8 }, { kills: -1 }, { score: Infinity }, { duration: 0.5 },
    { duration: 86_401 }, { duration: -1 }, { name: 'x'.repeat(81) },
    { score: 66000, kills: 600, xp: 24000, level: 4, duration: 1 },
    { score: 10000, kills: 0, xp: 2500, level: 4, duration: 1 },
  ]) assert.throws(() => validateRun({ ...valid, ...patch }), JSON.stringify(patch));
  for (const input of [null, [], 3, 'run', {}]) assert.throws(() => validateRun(input));
});

test('new board uses create-only write, subsequent writes compare exact ETag', async () => {
  const store = new MemoryStore();
  await recordRun(store, valid, options);
  await recordRun(store, { ...valid, name: 'Second' }, options);
  assert.deepEqual(store.writes[0].opts, { onlyIfNew: true });
  assert.deepEqual(store.writes[1].opts, { onlyIfMatch: '"1"' });
  assert.ok(store.reads.every(read => read.opts.consistency === 'strong' && read.key === BOARD_KEY));
});

test('concurrent creates/updates retain every qualifying run', async () => {
  const store = new MemoryStore();
  await Promise.all(Array.from({ length: 6 }, (_, index) => recordRun(store, { ...valid, name: `Pilot ${index}` }, options)));
  assert.equal(store.value.scores.length, 6);
  assert.equal(new Set(store.value.scores.map(row => row.id)).size, 6);
  assert.ok(store.writes.length > 6, 'a simulated stale write actually retried');
  assert.ok(store.writes.every(write => write.opts.onlyIfNew || write.opts.onlyIfMatch));
});

test('conflict retries are bounded and never make an unconditional write', async () => {
  const store = new MemoryStore();
  store.setJSON = async (key, value, opts) => { store.writes.push({ key, value, opts }); return { modified: false }; };
  await assert.rejects(recordRun(store, valid, options), error => error.code === 'BUSY' && error.status === 503);
  assert.equal(store.writes.length, 8);
  assert.ok(store.writes.every(write => write.opts.onlyIfNew === true));
});

test('identical retry is deduplicated without writing or collecting an identifier', async () => {
  const store = new MemoryStore();
  const first = await recordRun(store, valid, options);
  const repeated = await recordRun(store, { ...valid, duration: 11 }, options);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.submitted.id, first.submitted.id);
  assert.equal(store.writes.length, 1);
  assert.deepEqual(Object.keys(store.value.scores[0]).sort(), ['date', 'duration', 'id', 'kills', 'level', 'name', 'score', 'xp']);
});

test('top 100 storage and top 10 response remain bounded', async () => {
  const store = new MemoryStore();
  for (let index = 0; index < MAX_ENTRIES; index++) {
    await recordRun(store, { ...valid, name: `Pilot ${index}`, score: 135 }, options);
  }
  const writesBefore = store.writes.length;
  const lower = await recordRun(store, { ...valid, name: 'Below cutoff' }, options);
  assert.equal(lower.ranked, false);
  assert.equal(store.writes.length, writesBefore);
  assert.equal(store.value.scores.length, MAX_ENTRIES);
  assert.equal((await readLeaderboard(store)).scores.length, 10);
  const higher = await recordRun(store, { ...valid, name: 'Above cutoff', score: 160 }, options);
  assert.equal(higher.ranked, true);
  assert.equal(higher.scores[0].name, 'Above cutoff');
  assert.equal(store.value.scores.length, MAX_ENTRIES);
});

test('unknown or corrupt stored data is never overwritten', async () => {
  for (const value of [{ version: 99, scores: [] }, { version: 1, scores: [valid] }, { version: 1, scores: new Array(101).fill(valid) }]) {
    const store = new MemoryStore();
    store.value = value;
    await assert.rejects(recordRun(store, valid, options), error => error.status === 503);
    assert.equal(store.writes.length, 0);
  }
});

test('missing read/write ETags never degrade into unsafe updates or false success', async () => {
  const store = new MemoryStore();
  await recordRun(store, valid, options);
  store.getWithMetadata = async () => ({ data: store.value });
  assert.equal((await readLeaderboard(store)).scores.length, 1);
  await assert.rejects(recordRun(store, { ...valid, name: 'Another' }, options), error => error.status === 503);
  assert.equal(store.writes.length, 1);
  const failedStore = new MemoryStore();
  failedStore.setJSON = async () => ({ modified: true, etag: '' });
  await assert.rejects(recordRun(failedStore, valid, options), error => error.status === 503);
});

test('GET returns an empty honest global board; POST stores a server timestamp and ID', async () => {
  const store = new MemoryStore();
  const endpoint = handler(store);
  const empty = await endpoint(new Request('https://portfolio.test/.netlify/functions/leaderboard'));
  assert.deepEqual(await empty.json(), { mode: 'global', verification: 'unverified', scores: [] });
  const submitted = await endpoint(request());
  assert.equal(submitted.status, 200);
  assert.equal(submitted.headers.get('cache-control'), 'no-store');
  const data = await submitted.json();
  assert.equal(data.scores[0].date, '2026-09-30T12:00:00.000Z');
  assert.equal(data.scores[0].id.length, 36);
});

test('HTTP rejects cross-origin publishing before touching the store', async () => {
  const store = new MemoryStore();
  const response = await handler(store)(request(valid, { headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' } }));
  assert.equal(response.status, 403);
  assert.equal(store.reads.length, 0);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('HTTP rejects unsupported method and content type', async () => {
  const endpoint = handler();
  assert.equal((await endpoint(new Request('https://portfolio.test', { method: 'DELETE' }))).status, 405);
  assert.equal((await endpoint(request(valid, { headers: { 'Content-Type': 'text/plain' } }))).status, 415);
  assert.equal((await endpoint(request(valid, { body: '{invalid JSON' }))).status, 400);
});

test('HTTP body cap applies with and without a content-length header', async () => {
  const endpoint = handler();
  const oversized = JSON.stringify({ name: 'x'.repeat(MAX_BODY_BYTES) });
  assert.equal((await endpoint(request(valid, { body: oversized }))).status, 413);
  assert.equal((await endpoint(request(valid, { headers: { 'Content-Type': 'application/json', 'Content-Length': '4096' } }))).status, 413);
  const chunks = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(700)); controller.enqueue(new Uint8Array(700)); controller.close(); } });
  assert.equal((await endpoint(request(valid, { body: chunks, duplex: 'half' }))).status, 413);
});

test('unavailable storage returns generic 503 without leaking provider errors', async () => {
  const endpoint = createLeaderboardHandler({ getStore: () => { throw new Error('secret-provider-token'); } });
  const response = await endpoint(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '10');
  assert.doesNotMatch(await response.text(), /secret-provider-token/);
});
