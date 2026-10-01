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

- W / S: forward / reverse ship thrust, or forward / back on foot
- X: brake the ship to a stop; C: gentle radial descent near a planet
- A / D: turn the ship or strafe on foot
- Mouse/touch drag or arrow keys: steer / aim
- Left mouse or Space: fire
- Shift: ship boost / on-foot vector dash. Deep-space thrust smoothly reaches 2,400 m/s cruise or 7,200 m/s boost; X is the manual brake
- Manual landing: fly to the real spherical terrain, brake with X, and use C for the final controlled descent; touchdown is automatic
- E: open BEACN when near its central landmark; otherwise exit a landed ship, access an archive beacon, or board the ship
- Takeoff: W + ArrowUp; fly straight toward another visible planet without a scene change
- Q: on foot, set/recall a temporal anchor; while flying, perform a full 360° Evasive Loop with signed entry speed conserved
- R: charged singularity ultimate, available on planetary surfaces
- M: system map and instant planet warp
- Escape: close an open panel or open settings / pause

Touch movement, fire, dash, interaction, and abilities have on-screen controls. Audio is original synthesis and starts muted. Motion intensity is adjustable and respects the system reduced-motion preference. The full portfolio is reachable without playing; fighting is never required to read any content.

## Game loop

Five explorable worlds represent Philosophy, Experience, Projects, Mission, and Contact. Orbital flight includes twelve dogfighting opponents, fourteen boost gates, the BEACN logo-inspired central monument, and a Heard Us beacon. Planet radii are 1.15–2.1 km, ten times the original game scale; orbital centers are thirty times farther from the system origin. Three sentinel species inhabit deterministic regions across every sphere. Nearby regions activate gradually, with at most ten ordinary creatures live; damage and defeats persist when leaving and returning during the run. Combat earns XP; weapons evolve at 120, 320, and 680 XP into faster multi-bolt attacks. The ultimate starts charged so visitors can experience it immediately, then recharges through combat. Damage consumes shields before health; shields regenerate after a quiet interval. Every world has a distinct animated warden alongside three ordinary enemy species. Defeating all five wardens earns the Starforged Explorer title and permanent device-local aurora thrusters. Defeated explorers can save their run and redeploy.

The entire solar system is one persistent 3D world. Every planet is a closed, walkable spherical terrain mesh at its actual orbital coordinates. Flight, landing, walking and takeoff share that mesh and coordinate system; altitude changes never load a replacement scene, teleport the ship or reset its heading. The other planets and project landmarks remain at their real positions in the sky. The minimap is an explicitly optional warp shortcut.

Information archives repeat across the actual terrain. Every ground location has an archive within a conservative 145 m surface-path bound, including both poles. The HUD guides you to the nearest one; each opens that world’s portfolio information. Thousands of archive locations are data, not thousands of rendered objects: at most 24 neighboring sectors and 12 instanced scenery draws are active. Detailed creature construction is budgeted to one per frame, with a bounded reuse pool. See `docs/SURFACE_STREAMING.md` for coverage and budgets.

## Files

- `game/main.js`: simulation, controls, combat, state, lifecycle
- `game/world.js`: procedural worlds, ship, and physical terrain/obstacle registration
- `game/spherical-terrain.js`: closed spherical geometry and exact rendered-triangle ground sampling
- `game/planet-surfaces.js`: persistent radial scenery and swept 3D obstacle collision
- `game/spherical-world-catalog.js`, `game/surface-streaming.js`: worldwide archives and bounded local scenery
- `game/world-population.js`: stable monster habitats, gradual activation and run persistence
- `game/solar-scale.js`, `game/solar-depth.js`: shared system scale and logarithmic shader depth
- `game/continuous-flight.js`: quaternion flight, signed momentum, landing/takeoff and terrain sweeps
- `game/terrain-occlusion.js`: earliest swept terrain contact for weapon occlusion
- `game/collision.js`: legacy planar collision helpers retained for their tests
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
