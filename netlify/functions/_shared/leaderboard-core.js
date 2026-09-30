import { randomUUID } from 'node:crypto';
import { levelForXP, sanitizeName } from '../../../game/model.js';

export const BOARD_KEY = 'top-runs-v1';
export const MAX_ENTRIES = 100;
export const MAX_BODY_BYTES = 1024;
const DISPLAY_ENTRIES = 10;
const MAX_ATTEMPTS = 8;
const FIELDS = ['name', 'score', 'kills', 'level', 'xp', 'duration'];

export class LeaderboardError extends Error {
  constructor(message, status = 400, code = 'INVALID_RUN') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function integer(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

// These checks catch broken clients and obvious nonsense, not determined cheats.
// The browser owns the simulation, so every public score remains unverified.
export function validateRun(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !FIELDS.includes(key))) {
    throw new LeaderboardError('Send only the callsign and run fields.');
  }
  if (typeof input.name !== 'string' || input.name.length > 80 ||
      !integer(input.score, 1, 10_000_000) || !integer(input.kills, 0, 100_000) ||
      !integer(input.xp, 0, 10_000_000) || !integer(input.level, 1, 4) ||
      !integer(input.duration, 0, 86_400)) {
    throw new LeaderboardError('Run values are missing or outside the supported limits.');
  }
  const { score, kills, xp, level, duration } = input;
  const crystalXP = xp - kills * 40;
  if (crystalXP < 0 || crystalXP % 5 !== 0 || level !== levelForXP(xp)) {
    throw new LeaderboardError('XP, eliminations, and weapon level do not agree.');
  }
  const crystals = crystalXP / 5;
  const maxWave = 1 + Math.floor(kills / 6);
  const minScore = kills * 110 + crystals * 20;
  const maxScore = kills * (100 + maxWave * 10) + crystals * 20 + 25 * (8 + duration * 2);
  if (kills > 20 + duration * 8 || crystals > 22 + duration * 12 ||
      score < minScore || score > maxScore || score % 5 !== 0) {
    throw new LeaderboardError('This run falls outside the game’s scoring bounds.');
  }
  return { name: sanitizeName(input.name), score, kills, level, xp, duration };
}

export function compareScores(a, b) {
  return b.score - a.score || b.kills - a.kills || a.duration - b.duration ||
    a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
}

function publicRow(row) {
  // Explicit projection avoids exposing any future internal metadata.
  const { id, name, score, kills, level, xp, duration, date } = row;
  return { id, name, score, kills, level, xp, duration, date };
}

function decodeBoard(entry) {
  if (entry === null) return [];
  const data = entry?.data;
  // Do not "repair" unknown data by overwriting it with an empty board.
  if (data?.version !== 1 || !Array.isArray(data.scores) || data.scores.length > MAX_ENTRIES) {
    throw new LeaderboardError('The shared flight log is temporarily unavailable.', 503, 'UNAVAILABLE');
  }
  return data.scores.map(row => {
    try {
      if (typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(row.id) ||
          typeof row.date !== 'string' || row.date.length !== 24 || !Number.isFinite(Date.parse(row.date))) {
        throw new Error('Invalid stored row');
      }
      const run = validateRun(Object.fromEntries(FIELDS.map(field => [field, row[field]])));
      return { ...run, id: row.id, date: row.date };
    } catch {
      throw new LeaderboardError('The shared flight log is temporarily unavailable.', 503, 'UNAVAILABLE');
    }
  }).sort(compareScores);
}

function result(scores, extra = {}) {
  return { mode: 'global', verification: 'unverified', scores: scores.slice(0, DISPLAY_ENTRIES).map(publicRow), ...extra };
}

export async function readLeaderboard(store) {
  const entry = await store.getWithMetadata(BOARD_KEY, { type: 'json', consistency: 'strong' });
  return result(decodeBoard(entry));
}

function sameRun(a, b) {
  return a.name === b.name && a.score === b.score && a.kills === b.kills && a.xp === b.xp && a.level === b.level;
}

export async function recordRun(store, input, { now = () => new Date(), uuid = randomUUID, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const run = validateRun(input);
  const date = now().toISOString();
  const incoming = { ...run, id: uuid(), date };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const entry = await store.getWithMetadata(BOARD_KEY, { type: 'json', consistency: 'strong' });
    const current = decodeBoard(entry);
    // A retried browser request does not create duplicate entries after a timeout.
    const duplicate = current.find(row => sameRun(row, incoming) && Math.abs(Date.parse(date) - Date.parse(row.date)) < 10 * 60_000);
    if (duplicate) return result(current, { submitted: duplicate, ranked: true, duplicate: true });
    const next = [...current, incoming].sort(compareScores).slice(0, MAX_ENTRIES);
    if (!next.some(row => row.id === incoming.id)) return result(current, { submitted: publicRow(incoming), ranked: false });

    if (entry !== null && (typeof entry.etag !== 'string' || !entry.etag)) {
      // Some local emulators omit ETags. Reading is fine; a safe conditional
      // update is impossible, so keep the device-local fallback rather than
      // ever issuing an unconditional write.
      throw new LeaderboardError('Shared publishing is unavailable in this runtime. Device-local scores still work.', 503, 'UNAVAILABLE');
    }

    // Conditional writes are atomic. A concurrent update forces a fresh read;
    // never fall back to an unconditional write of a stale snapshot.
    const options = entry === null ? { onlyIfNew: true } : { onlyIfMatch: entry.etag };
    const write = await store.setJSON(BOARD_KEY, { version: 1, scores: next }, options);
    if (write.modified) {
      if (typeof write.etag !== 'string' || !write.etag) {
        throw new LeaderboardError('Shared publishing could not be verified. Please check the board before retrying.', 503, 'UNAVAILABLE');
      }
      return result(next, { submitted: publicRow(incoming), ranked: true });
    }
    if (attempt < MAX_ATTEMPTS - 1) await pause(10 + Math.floor(Math.random() * 25) * (attempt + 1));
  }
  throw new LeaderboardError('The shared flight log is busy. Your device-local score is safe; try publishing again shortly.', 503, 'BUSY');
}

async function readJSON(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    throw new LeaderboardError('Use application/json.', 415, 'CONTENT_TYPE');
  }
  const declaredSize = request.headers.get('content-length');
  if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > MAX_BODY_BYTES)) {
    throw new LeaderboardError('Run submission is too large.', 413, 'BODY_TOO_LARGE');
  }
  if (!request.body) throw new LeaderboardError('A run submission is required.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let body = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new LeaderboardError('Run submission is too large.', 413, 'BODY_TOO_LARGE');
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof LeaderboardError) throw error;
    throw new LeaderboardError('Run submission must be valid JSON.');
  } finally {
    reader.releaseLock();
  }
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

export function createLeaderboardHandler({ getStore, recordOptions } = {}) {
  return async request => {
    if (!['GET', 'POST'].includes(request.method)) {
      return json({ error: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' }, 405, { Allow: 'GET, POST' });
    }
    try {
      let run;
      if (request.method === 'POST') {
        const origin = request.headers.get('origin');
        if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
          throw new LeaderboardError('Publish scores from the game’s own website.', 403, 'ORIGIN');
        }
        run = validateRun(await readJSON(request));
      }
      const store = getStore();
      return json(request.method === 'GET' ? await readLeaderboard(store) : await recordRun(store, run, recordOptions));
    } catch (error) {
      const known = error instanceof LeaderboardError;
      const status = known ? error.status : 503;
      return json({
        error: known ? error.code : 'UNAVAILABLE',
        message: known ? error.message : 'The shared flight log is unavailable. Device-local scores still work.',
      }, status, status === 503 ? { 'Retry-After': '10' } : {});
    }
  };
}
