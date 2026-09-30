import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGlobalScores, submitGlobalScore, GlobalLeaderboardError } from '../game/leaderboard.js';

test('client fetches shared scores without uploading local data', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => { calls.push(args); return Response.json({ mode: 'global', scores: [] }); });
  assert.deepEqual(await fetchGlobalScores(), { mode: 'global', scores: [] });
  assert.equal(calls[0][0], '/.netlify/functions/leaderboard');
  assert.equal(calls[0][1].body, undefined);
  assert.equal(calls[0][1].credentials, 'omit');
});

test('explicit submission sends only public fields and exposes the cutoff result', async t => {
  let posted;
  t.mock.method(globalThis, 'fetch', async (url, options) => { posted = options; return Response.json({ mode: 'global', scores: [], ranked: false }); });
  const result = await submitGlobalScore({ name: '<Pilot>', score: 110, kills: 1, xp: 40, level: 1, duration: 10, email: 'never-send@example.test' });
  assert.equal(result.ranked, false);
  assert.equal(posted.method, 'POST');
  assert.deepEqual(JSON.parse(posted.body), { name: 'Pilot', score: 110, kills: 1, level: 1, xp: 40, duration: 10 });
});

test('Vite HTML fallback is not mistaken for a live shared leaderboard', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(fetchGlobalScores(), error => error instanceof GlobalLeaderboardError && error.code === 'UNAVAILABLE');
});

test('client surfaces server validation and rate-limiting failures without retrying POST', async t => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => { count++; return Response.json({ error: 'INVALID_RUN', message: 'Invalid run.' }, { status: 400 }); });
  await assert.rejects(submitGlobalScore({}), error => error.status === 400 && error.code === 'INVALID_RUN');
  assert.equal(count, 1);
});

test('non-JSON platform 429 gets a useful retry message', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Too many requests', { status: 429 }));
  await assert.rejects(fetchGlobalScores(), error => error.status === 429 && error.code === 'RATE_LIMITED');
});

test('invalid successful responses fail closed', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ mode: 'global', scores: [{ name: 'Bad', score: -10 }] }));
  await assert.rejects(fetchGlobalScores(), GlobalLeaderboardError);
});

test('offline and abort errors remain honest about device-local availability', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(fetchGlobalScores(), /device-local/);
});
