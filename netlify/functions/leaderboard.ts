import { getStore } from '@netlify/blobs';
import type { Config, Context } from '@netlify/functions';
import { createLeaderboardHandler } from './_shared/leaderboard-core.js';

export default async (request: Request, context: Context) => {
  // Branch/preview testing must never write into the live site's board.
  const scope = context.deploy.context === 'production' ? 'public' : 'preview';
  return createLeaderboardHandler({
    getStore: () => getStore({ name: `unfolding-${scope}-leaderboard-v1`, consistency: 'strong' }),
  })(request);
};

// Platform enforcement happens before function execution; the app never stores
// addresses or fingerprints. GET and POST share the same per-IP/domain budget.
export const config: Config = {
  path: '/.netlify/functions/leaderboard',
  rateLimit: {
    action: 'rate_limit',
    windowLimit: 20,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};
