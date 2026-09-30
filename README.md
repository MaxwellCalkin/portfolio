# The Unfolding

Maxwell Calkin’s portfolio, reimagined as an original playable space-exploration game. Built on the existing portfolio and six essays, which remain available through a fully static, accessible reading route.

## Run locally

Node.js 22.12+ or 24, then:

```sh
npm ci
npm run dev
```

Open the URL Vite prints (default port 4173). In restricted containers where network-interface enumeration is unavailable, use `npm run dev -- --host 127.0.0.1`.

```sh
npm test       # deterministic gameplay, persistence, and server unit tests
npm run check # source syntax checks
npm run build # production static multipage build to dist/
```

The Netlify function runs on Netlify (or with Netlify Dev). Plain Vite and non-Netlify static previews explicitly fall back to a device-local flight log.

## Explore

- W / S: ship thrust or forward/back on foot
- A / D: turn the ship or strafe on foot
- Mouse/touch drag or arrow keys: steer / aim
- Left mouse or Space: fire
- Shift: ship boost / on-foot vector dash
- Manual landing: fly into a planet’s atmosphere, steer the descent, brake with S and lower the nose with ArrowDown; touchdown is automatic
- E: exit a landed ship, access an archive beacon, or board the ship
- Takeoff: W + ArrowUp; climb above 220m to return to space
- Q: on foot, set/recall a temporal anchor; in space, perform a full 360° Evasive Loop with entry speed conserved
- R: charged singularity ultimate, available on planetary surfaces
- M: system map and instant planet warp
- Escape: close an open panel or open settings / pause

Touch movement, fire, dash, interaction, and abilities have on-screen controls. Audio is original synthesis and starts muted. Motion intensity is adjustable and respects the system reduced-motion preference. The full portfolio is reachable without playing; fighting is never required to read any content.

## Game loop

Five explorable worlds represent Philosophy, Experience, Projects, Mission, and Contact. Orbital flight includes twelve dogfighting opponents, fourteen boost gates, the BEACN logo-inspired central monument, and a Heard Us beacon. The solar system is spaced farther apart for free flight. Planetary sentinels arrive in escalating waves. Combat earns XP; weapons evolve at 120, 320, and 680 XP into faster multi-bolt attacks. The ultimate starts charged so visitors can experience it immediately, then recharges through combat. Damage consumes shields before health; shields regenerate after a quiet interval. Every world has a distinct animated warden alongside three ordinary enemy species. Defeating all five wardens earns the Starforged Explorer title and permanent device-local aurora thrusters. Defeated explorers can save their run and redeploy.

Orbital approach streams into a manually flyable local biome. This is a connected flight-to-ground experience with an atmospheric transition; terrain maps are bounded, rather than fully spherical planets that can be circumnavigated.

## Files

- `game/main.js`: simulation, controls, combat, state, lifecycle
- `game/world.js`: procedural worlds, ship, and physical terrain/obstacle registration
- `game/collision.js`: swept character collision, sliding, mesh-accurate ground heights
- `game/hero-explorer.js`: original Kestrel / 07 hero, articulated locomotion, two-handed rifle IK
- `game/chase-camera.js`: rigid ship-frame camera that follows the complete evasive loop
- `game/creatures.js`: three sculpted alien species and five unique bosses
- `game/project-stars.js`: BEACN and Heard Us identity-grounded landmarks
- `game/space-playground.js`: dogfight AI, boost gates, pooled projectiles, and speed-conserving loop mathematics
- `game/ui.js`, `game/game.css`: HUD, map, dialogs, accessible interactions
- `game/content.js`: portfolio and project content grounded in the original site
- `game/model.js`: pure gameplay and local persistence rules
- `game/audio.js`: original Web Audio synthesis
- `game/leaderboard.js`: explicit public-score submission adapter
- `netlify/functions/`: shared scoreboard backend; see `docs/LEADERBOARD.md`
- `portfolio.html`: accessible, non-game reading version
- `essays/`: preserved original long-form writing

## Publishing

`netlify.toml` builds with `npm run build` and publishes `dist`. Review a branch deploy or draft deploy first. Nothing in this change enables auto-merge or deploys production by itself. The existing live site should only be replaced after review.

A separate private static review build may show a local leaderboard; it does not run the Netlify backend. The public Netlify leaderboard is casual and client-reported, not a cheat-proof ranked competition. No authentication credentials are embedded in browser code.

## Art and content

All game visuals are original procedural geometry/shaders. No assets were extracted from any game. Portfolio source and essays are preserved from MaxwellCalkin/portfolio; additional project links are taken from MaxwellCalkin’s public profile. Existing content license: `LICENSE.txt`. Three.js is MIT-licensed.
