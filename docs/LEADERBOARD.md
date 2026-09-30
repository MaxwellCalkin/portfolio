# Shared flight log

The game has two deliberately separate score destinations:

- **On this device:** the existing browser-local flight log. Saving here never transmits a score or old localStorage history.
- **Shared flight log:** a visitor explicitly chooses **Publish score**, publishing a callsign and game statistics to this site's Netlify Function. The UI should say these values become public, suggest a pseudonymous callsign, and label the board **Casual · unverified scores**.

The shared board is real persistent server storage when the site runs on Netlify. The ordinary Vite server does not emulate the endpoint; the client detects even an HTTP-200 HTML fallback and keeps the honest device-local experience. Network failures and HTTP errors do not silently become successful public submissions.

## API and client

Endpoint: `/.netlify/functions/leaderboard`

- `GET`: returns `{ mode: "global", verification: "unverified", scores: [...] }` with the best ten retained runs
- `POST` with `Content-Type: application/json`: accepts only `{ name, score, kills, level, xp, duration, bossKills? }`
- `bossKills` is optional and defaults to 0. If provided, it must be an integer between 0 and 5, no larger than `kills`. Public rows include `bossKills`, defaulting legacy runs to 0
- `duration` is an integer number of **active gameplay seconds since restart**, between 0 and 86,400
- Successful POST also includes `submitted`, `ranked`, and (when applicable) `duplicate`
- `ranked: false` means the run was valid but fell below the retained top 100. It is not persisted; the UI must not claim it was saved publicly
- All returned timestamps and run IDs are generated on the server. No client timestamp or ID is accepted
- Errors are JSON `{ error, message }` with HTTP 400/403/405/413/415/503; Netlify may return a platform-generated 429

`game/leaderboard.js` exports:

```js
await fetchGlobalScores();
await submitGlobalScore({ name, score, kills, level, xp, duration, bossKills });
```

Both resolve to `{ mode: 'global', scores }`; POST includes `ranked` when returned by the server. Public rows include the boss count for an optional badge. Omitting `bossKills` from an older client remains supported. Failures throw `GlobalLeaderboardError` with `status` and `code`. Requests time out after eight seconds. POST has no automatic retry, avoiding surprise repeated publications. If a visitor intentionally retries the same callsign/score/XP/kills/boss count within ten minutes, the backend returns the existing retained entry.

## Storage and concurrency

Runtime dependencies are `@netlify/blobs` and the `@netlify/functions` type package. The implementation was checked with Blobs 11.1.2 and Functions 6.0.1, using Node 22.12 or newer.

One bounded versioned object holds the best 100 runs. The function reads with strong consistency, then creates with `onlyIfNew` or updates with `onlyIfMatch` against the exact ETag. A conflict causes a fresh read, merge, and bounded retry. It never overwrites a stale snapshot unconditionally. A busy board returns 503 rather than losing another visitor's qualifying score. Unrecognized/corrupt stored data is left untouched and produces 503.

The optional boss count is backward compatible with the existing version 1 object and legacy submissions. Reading a legacy row projects `bossKills: 0` publicly without writing anything. A later board update preserves that row's existing stored fields, ID, and timestamp; there is no boss-field migration, score recalculation, or deletion of deployed data.

The store names are `unfolding-public-leaderboard-v1` for production and `unfolding-preview-leaderboard-v1` for other deploy contexts. Their key is `top-runs-v1`. Preview tests cannot change the production board. The application does not touch any pre-existing store, delete other user data, or provision another paid service. Scores falling below the top 100 are omitted from this purpose-built leaderboard object; this is not an archive of all submitted runs.

Netlify supplies the store connection inside its runtime. No API keys, database credentials, private visitor data, IP addresses, or device fingerprints are added to the application's storage. Existing Netlify usage allowances and charges still apply; this is not a guarantee of free unlimited traffic.

## Validation and limits

- Streamed request bodies are capped at 1,024 bytes, independently of `Content-Length`
- Only the six existing public fields and optional `bossKills` are accepted. Callsigns are normalized, stripped to letters/numbers/spaces/underscores/hyphens, and limited to 20 characters
- All numeric fields must be bounded safe integers. Weapon levels must match the game's XP thresholds
- Ordinary eliminations account for 40 XP and at least 110 score; space eliminations award exactly 110 score. Each boss is already included once in `kills` and adds 160 XP and 790 score above that baseline, giving totals of 200 XP and 900 score per boss. `crystalXP = xp - kills * 40 - bossKills * 160` must be nonnegative and divisible by 5. Each crystal awards 5 XP and 20 score
- The minimum score is `kills * 110 + crystals * 20 + bossKills * 790`. The upper bound permits advancing waves, the same boss bonus, and the existing generous 25-point duration allowance for flight landings and space rings. Rings award 25 score with zero XP. The initial singularity burst and legitimate all-five-boss runs are covered by tests
- Generous duration-based ceilings reject obvious impossible bursts; these are coarse checks, not proof of a legitimate run
- Browser POSTs with an unrelated Origin or cross-site fetch metadata are rejected. The API does not expose cross-origin CORS access
- Netlify configuration declares a limit of 20 requests per 60 seconds for each IP/domain pair. GET and POST share that budget. Verify acceptance and enforcement on each deployed build before treating that declaration as active protection. Platform enforcement can lag and is not a global spending cap
- The client never sends browser cookies. The handler returns generic provider-failure messages and no provider credentials

**This is a casual board, not competitive anti-cheat.** Browser code and public run values can be forged; names are not verified identities. The checks reduce accidents and trivial spam. They cannot establish genuine gameplay, prevent all duplicate runs, moderate names, stop a distributed attack, or guarantee a budget ceiling. Competitive rankings would require an authoritative simulation or independently verifiable run replay, authentication, moderation, and stronger abuse controls.

## Verification and rollout

```sh
npm test
npm run build
```

Leaderboard tests cover scoring boundaries, sanitization, body limits, unsafe origins, broken storage, concurrent conditional writes, bounded retention, duplicate retries, Vite HTML fallback, unavailable network, and error handling. A separate test uses the actual Netlify SDK with its temporary local Blobs emulator for a POST/read round trip and stale-ETag rejection. It never contacts production. Blobs11.1.2's emulator omits ETags on reads: reading and an initial create work there, but subsequent non-duplicate publishing safely returns503 instead of an unconditional write. The tests explicitly cover this limitation.

Build success alone does not test deployed routing, Netlify rate-limit enforcement, or persistent production storage. After an authorized Netlify deployment, check GET on the endpoint, intentionally publish one clearly named test run, then confirm the same board from a second browser/device. Verify the production UI and the separate device-local fallback before declaring the shared service live. Plain `npm run dev` is intentionally local-only; `netlify dev` can emulate Functions/Blobs when configured by the site owner, subject to the emulator ETag limitation above.

### Verifying the platform rate limit

Check the deploy log's **post-processing** stage for the accepted rule and its path, IP/domain aggregation, 20-request limit, and 60-second window. Netlify documents that an invalid or undetected rule may leave deployment successful, so successful deployment alone is insufficient evidence.

For a bounded GET-only smoke test, use one stable public egress IP and the same exact preview/domain throughout: cross the threshold, allow at least 10 seconds for counting/enforcement to catch up, then make one or two additional GETs while still within the 60-second window. A short concurrent burst in which all requests return 200 is inconclusive. Proxy rotation or different domains can create separate counters. Stop when 429 is observed; do not use synthetic POSTs or an unbounded load test. If the accepted rule and delayed 429 cannot be verified, report enforcement as **unverified**, and do not claim a guaranteed abuse or spending cap.

## Platform references

- [Netlify Blobs API: conditional writes, metadata, and consistency](https://docs.netlify.com/build/data-and-storage/netlify-blobs/)
- [Functions API and configuration](https://docs.netlify.com/build/functions/api/)
- [Netlify code-based rate limits](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/)
