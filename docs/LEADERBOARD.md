# Shared flight log

The game has two deliberately separate score destinations:

- **On this device:** the existing browser-local flight log. Saving here never transmits a score or old localStorage history.
- **Shared flight log:** a visitor explicitly chooses **Publish score**, publishing a callsign and game statistics to this site's Netlify Function. The UI should say these values become public, suggest a pseudonymous callsign, and label the board **Casual · unverified scores**.

The shared board is real persistent server storage when the site runs on Netlify. The ordinary Vite server does not emulate the endpoint; the client detects even an HTTP-200 HTML fallback and keeps the honest device-local experience. Network failures and HTTP errors do not silently become successful public submissions.

## API and client

Endpoint: `/.netlify/functions/leaderboard`

- `GET`: returns `{ mode: "global", verification: "unverified", scores: [...] }` with the best ten retained runs
- `POST` with `Content-Type: application/json`: accepts only `{ name, score, kills, level, xp, duration }`
- `duration` is an integer number of **active gameplay seconds since restart**, between 0 and 86,400
- Successful POST also includes `submitted`, `ranked`, and (when applicable) `duplicate`
- `ranked: false` means the run was valid but fell below the retained top 100. It is not persisted; the UI must not claim it was saved publicly
- All returned timestamps and run IDs are generated on the server. No client timestamp or ID is accepted
- Errors are JSON `{ error, message }` with HTTP 400/403/405/413/415/503; Netlify may return a platform-generated 429

`game/leaderboard.js` exports:

```js
await fetchGlobalScores();
await submitGlobalScore({ name, score, kills, level, xp, duration });
```

Both resolve to `{ mode: 'global', scores }`; POST includes `ranked` when returned by the server. Failures throw `GlobalLeaderboardError` with `status` and `code`. Requests time out after eight seconds. POST has no automatic retry, avoiding surprise repeated publications. If a visitor intentionally retries the same callsign/score/XP/kills within ten minutes, the backend returns the existing retained entry.

## Storage and concurrency

Runtime dependencies are `@netlify/blobs` and the `@netlify/functions` type package. The implementation was checked with Blobs 11.1.2 and Functions 6.0.1, using Node 22.12 or newer.

One bounded versioned object holds the best 100 runs. The function reads with strong consistency, then creates with `onlyIfNew` or updates with `onlyIfMatch` against the exact ETag. A conflict causes a fresh read, merge, and bounded retry. It never overwrites a stale snapshot unconditionally. A busy board returns 503 rather than losing another visitor's qualifying score. Unrecognized/corrupt stored data is left untouched and produces 503.

The store names are `unfolding-public-leaderboard-v1` for production and `unfolding-preview-leaderboard-v1` for other deploy contexts. Their key is `top-runs-v1`. Preview tests cannot change the production board. The application does not touch any pre-existing store, delete other user data, or provision another paid service. Scores falling below the top 100 are omitted from this purpose-built leaderboard object; this is not an archive of all submitted runs.

Netlify supplies the store connection inside its runtime. No API keys, database credentials, private visitor data, IP addresses, or device fingerprints are added to the application's storage. Existing Netlify usage allowances and charges still apply; this is not a guarantee of free unlimited traffic.

## Validation and limits

- Streamed request bodies are capped at 1,024 bytes, independently of `Content-Length`
- Only the six public fields are accepted. Callsigns are normalized, stripped to letters/numbers/spaces/underscores/hyphens, and limited to 20 characters
- All numeric fields must be bounded safe integers. Weapon levels must match the game's XP thresholds
- Each elimination accounts for 40 XP; remaining crystal XP must be divisible by five. Score bounds allow 110+ points per kill as waves advance, 20 points per crystal, repeated 25-point flight landings, and the initial singularity burst
- Generous duration-based ceilings reject obvious impossible bursts; these are coarse checks, not proof of a legitimate run
- Browser POSTs with an unrelated Origin or cross-site fetch metadata are rejected. The API does not expose cross-origin CORS access
- Netlify configuration limits the endpoint to 20 requests per 60 seconds for each IP/domain pair. GET and POST share that budget. Platform enforcement can lag and is not a global spending cap
- The client never sends browser cookies. The handler returns generic provider-failure messages and no provider credentials

**This is a casual board, not competitive anti-cheat.** Browser code and public run values can be forged; names are not verified identities. The checks reduce accidents and trivial spam. They cannot establish genuine gameplay, prevent all duplicate runs, moderate names, stop a distributed attack, or guarantee a budget ceiling. Competitive rankings would require an authoritative simulation or independently verifiable run replay, authentication, moderation, and stronger abuse controls.

## Verification and rollout

```sh
npm test
npm run build
```

Leaderboard tests cover scoring boundaries, sanitization, body limits, unsafe origins, broken storage, concurrent conditional writes, bounded retention, duplicate retries, Vite HTML fallback, unavailable network, and error handling. A separate test uses the actual Netlify SDK with its temporary local Blobs emulator for a POST/read round trip and stale-ETag rejection. It never contacts production. Blobs11.1.2's emulator omits ETags on reads: reading and an initial create work there, but subsequent non-duplicate publishing safely returns503 instead of an unconditional write. The tests explicitly cover this limitation.

Build success alone does not test deployed routing, Netlify rate-limit enforcement, or persistent production storage. After an authorized Netlify deployment, check GET on the endpoint, intentionally publish one clearly named test run, then confirm the same board from a second browser/device. Verify the production UI and the separate device-local fallback before declaring the shared service live. Plain `npm run dev` is intentionally local-only; `netlify dev` can emulate Functions/Blobs when configured by the site owner, subject to the emulator ETag limitation above.

## Platform references

- [Netlify Blobs API: conditional writes, metadata, and consistency](https://docs.netlify.com/build/data-and-storage/netlify-blobs/)
- [Functions API and configuration](https://docs.netlify.com/build/functions/api/)
- [Netlify code-based rate limits](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/)
