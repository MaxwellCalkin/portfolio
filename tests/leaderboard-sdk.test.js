import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStore } from '@netlify/blobs';
import { BlobsServer } from '@netlify/blobs/server';
import { BOARD_KEY, createLeaderboardHandler, readLeaderboard } from '../netlify/functions/_shared/leaderboard-core.js';

test('real Netlify SDK/local emulator round-trip, conditional writes, and missing-ETag safety', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unfolding-blobs-test-'));
  const server = new BlobsServer({ directory });
  try {
    const { address } = await server.start();
    const store = getStore({
      name: 'leaderboard-test',
      siteID: 'local-test-only',
      token: 'unused-local-test-value',
      apiURL: address,
      consistency: 'strong',
    });
    const endpoint = createLeaderboardHandler({ getStore: () => store });
    const response = await endpoint(new Request('https://portfolio.test/.netlify/functions/leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://portfolio.test' },
      body: JSON.stringify({ name: 'SDK Pilot', score: 110, kills: 1, xp: 40, level: 1, duration: 10 }),
    }));
    assert.equal(response.status, 200);
    assert.equal((await readLeaderboard(store)).scores[0].name, 'SDK Pilot');
    const first = await store.getWithMetadata(BOARD_KEY, { type: 'json', consistency: 'strong' });
    assert.equal((await store.setJSON(BOARD_KEY, first.data, { onlyIfNew: true })).modified, false);
    // Blobs11.1.2's local GET omits ETags. Production code must not degrade to
    // unconditional writes; this check adapts if the emulator gains support.
    const secondResponse = await endpoint(new Request('https://portfolio.test/.netlify/functions/leaderboard', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Another Pilot', score: 110, kills: 1, xp: 40, level: 1, duration: 10 }),
    }));
    assert.equal(secondResponse.status, first.etag ? 200 : 503);
    const probe = await store.setJSON('conditional-test', { revision: 1 }, { onlyIfNew: true });
    assert.equal((await store.setJSON('conditional-test', { revision: 2 }, { onlyIfMatch: probe.etag })).modified, true);
    assert.equal((await store.setJSON('conditional-test', { revision: 3 }, { onlyIfMatch: probe.etag })).modified, false);
    assert.equal((await store.get('conditional-test', { type: 'json' })).revision, 2);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
