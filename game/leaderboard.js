import { sanitizeName, validateScore } from './model.js';

const ENDPOINT = '/.netlify/functions/leaderboard';
const TIMEOUT_MS = 8_000;

function validGlobalRow(row) {
  const bossKills = row?.bossKills === undefined ? 0 : row.bossKills;
  return validateScore(row) && Number.isSafeInteger(row.score) && row.score <= 10_000_000 &&
    Number.isSafeInteger(row.kills) && row.kills <= 100_000 &&
    Number.isSafeInteger(bossKills) && bossKills >= 0 && bossKills <= 5 && bossKills <= row.kills &&
    Number.isSafeInteger(row.xp) && row.xp >= 0 && row.xp <= 10_000_000 &&
    Number.isSafeInteger(row.duration) && row.duration >= 0 && row.duration <= 86_400 &&
    typeof row.id === 'string' && /^[0-9a-f-]{36}$/i.test(row.id) &&
    row.date.length === 24 && Number.isFinite(Date.parse(row.date));
}

export class GlobalLeaderboardError extends Error {
  constructor(message, { status = 0, code = 'UNAVAILABLE' } = {}) {
    super(message);
    this.name = 'GlobalLeaderboardError';
    this.status = status;
    this.code = code;
  }
}

async function requestScores(options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      ...options,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/json', ...options.headers },
    });
    // A plain Vite/static server may return the SPA HTML shell with HTTP 200.
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new GlobalLeaderboardError(response.status === 429
        ? 'Too many flight-log requests. Try again in a minute.'
        : 'Shared scores are unavailable here. Your device-local flight log still works.',
      { status: response.status, code: response.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE' });
    }
    const data = await response.json();
    if (!response.ok) {
      throw new GlobalLeaderboardError(typeof data.message === 'string' ? data.message : 'Shared scores are temporarily unavailable.', {
        status: response.status,
        code: typeof data.error === 'string' ? data.error : 'UNAVAILABLE',
      });
    }
    if (data.mode !== 'global' || !Array.isArray(data.scores) || data.scores.length > 10 ||
        data.scores.some(row => !validGlobalRow(row))) {
      throw new GlobalLeaderboardError('The shared flight log returned an invalid response.');
    }
    const scores = data.scores.map(row => ({
      id: typeof row.id === 'string' ? row.id.slice(0, 36) : '',
      name: sanitizeName(row.name), score: row.score, kills: row.kills, level: row.level,
      date: row.date, xp: row.xp, duration: row.duration, bossKills: row.bossKills ?? 0,
    }));
    return { mode: 'global', scores, ...(typeof data.ranked === 'boolean' ? { ranked: data.ranked } : {}) };
  } catch (error) {
    if (error instanceof GlobalLeaderboardError) throw error;
    throw new GlobalLeaderboardError(error?.name === 'AbortError'
      ? 'The shared flight log took too long to respond. Your device-local score is safe.'
      : 'Cannot reach the shared flight log. Your device-local flight log still works.');
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchGlobalScores() {
  return requestScores();
}

// Call only after the visitor explicitly chooses to publish a public callsign/run.
// This module never uploads localStorage history or retries a POST automatically.
export async function submitGlobalScore({ name, score, kills, level, xp, duration, bossKills }) {
  return requestScores({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sanitizeName(name), score, kills, level, xp, duration, bossKills }),
  });
}
