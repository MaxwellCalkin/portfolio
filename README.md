# The Unfolding

Maxwell Calkin's portfolio as a playable, third-person space-exploration game. Five worlds hold the portfolio as places: every landmark is a piece of the existing copy, quoted verbatim, and each world's main archive opens the full chapter. The complete portfolio and the essays stay available without playing, through `portfolio.html` and the navigation links.

## Run locally

Node.js 22.12+ or 24, then:

```sh
npm ci
npm run dev        # Vite on http://127.0.0.1:4173
npm test           # unit tests (worlds, discoveries, physics, scoring, audio, leaderboard)
npm run build      # static multipage build to dist/
npx playwright test  # browser tests (set CHROMIUM_PATH to use a system Chromium)
```

The Netlify function (shared flight log) runs on Netlify or with Netlify Dev. Plain Vite and static previews fall back to a device-local flight log.

## Play

**On foot (the agent)**

| Action | Keys |
|---|---|
| Move / look and aim | W A S D / mouse |
| Jump, hold to jetpack | Space |
| Sprint | Shift |
| Read a landmark, board the ship | E |
| Fire / aim down sights | Left click / right click |
| Glissando (dash) | Q |
| Low End (bass shockwave) | C |
| The Drop (ultimate, charges as you explore and fight) | X |
| Air bass (unlocked by finding the groove on the Experience stage) | B |
| Map, journal, controls, pause | M, J or Tab, H, Esc |

**In the ship (the Aster)**: W / S throttle, mouse to steer, A / D to turn, Shift to boost (the pulse drive engages in open space), E to land (it finds flat ground, or the landing pad near a site), M for autopilot to any world. Takeoff and landing are automatic.

Touch devices get a virtual stick (left side), look drag (right side) and buttons. Graphics quality adapts to the device (and steps down automatically if the frame rate drops); it can be set in the pause menu along with sound, volume, look sensitivity, invert look and reduced motion.

## What is in each world

| World | Theme | Things to find |
|---|---|---|
| 01 Philosophy, *the Origin* | living archipelago | the Origin monument, the three pillars, Depth × span, the decision filter, a reading pavilion with three essays |
| 02 Experience, *the Arc* | copper canyon amphitheater | the Arc, the bass stage (eight playable note pads), the arena (a timed target run), the workshop, the toolkit, an essay |
| 03 Projects, *the Workshop* | crystal frontier | the Workshop, BEACN and Heard Us monuments, five open-source project crystals, the build log |
| 04 Mission, *the Horizon* | ocean world | the observatory and lighthouse, four principle lenses aimed at sea-stack beacons, the long view, essays |
| 05 Contact, *the Signal* | golden dunes | the signal dish, four antennas (email, GitHub, LinkedIn, X), a closing monolith |

Thirty-seven discoveries, ten resonance shards per world, and a warden beyond each site's sanctuary. Nothing hostile ever spawns at a site, and no content is gated behind combat. The journal (J) remembers what you found on this device. Defeating all five wardens earns the Starforged Explorer title and aurora thrusters. Scores can be saved to the flight log (local, or the shared Netlify board).

## Architecture

```
game/
  main.js              entry: settings, journal, HUD, panels, flight log; lazy-loads the 3D game
  app/game.js          the game: frame loop, modes (intro, foot, ship), interactions, HUD feed
  app/settings.js      persisted settings and quality presets
  world/               the star system
    system.js          planets (radius, orbit, terrain kind, palette, atmosphere)
    layout.js          per-world site layouts (landmark placement, paths, plateaus)
    planet-shape.js    analytic terrain height and color (shared by workers and physics)
    terrain-lod.js     cube-sphere quadtree LOD, horizon culling, worker pool
    terrain-worker.js  chunk and flora generation off the main thread
    terrain-material.js, atmosphere.js, clouds.js, space.js   shading and sky
    flora.js, flora-cells.js   streamed instanced vegetation with far LODs
    landmarks.js       places landmark GLBs and extracts POI_/LABEL_/ANIM_/SPAWN_/COL_ nodes
    universe.js        ties the planets, sky and lighting together
  actors/              agent (skinned, layered animation), player controller, camera rig, ship, physics
  gameplay/            discoveries + journal, combat, shards, Experience challenges, effects, scoring
  ui/                  HUD and panels
  audio/               live-synthesized soundtrack and effects (no audio files)
  content.js           the portfolio copy (unchanged)
art/                   Blender pipeline: STYLE.md, specs, generator scripts, model preview tool
dev/                   world lab, creature lineup, screenshot and scripted play tools
public/models/         optimized GLB assets (meshopt) used by the game
```

One persistent coordinate system holds all five planets (5 to 8 km radius, tens of kilometers apart) and the deep-space BEACN and Heard Us monuments. Flight, landing and walking all happen in that one space: nothing is a separate scene. Terrain and flora are generated in Web Workers from the same analytic functions the physics uses, so what you see is what you walk on.

## Art pipeline

All 3D art is original and generated with Blender 5 (Python, headless) from the scripts in `art/blender/`, then optimized with `gltfpack`:

```sh
/path/to/blender-python art/blender/agent.py      # the agent: rig, 16 animation clips
/path/to/blender-python art/blender/ship.py       # the Aster, with animated landing gear
/path/to/blender-python art/blender/flora.py      # 23 vegetation and rock assets with far LODs
/path/to/blender-python art/blender/landmarks_a.py  # shared, Philosophy, Experience
/path/to/blender-python art/blender/landmarks_b.py  # Projects, Mission, Contact
node art/preview/shot.mjs "model=/models/agent.glb&anim=AirBass" out.png
```

`art/STYLE.md` sets the look and the material-slot contract; `art/specs/` documents the agent and landmark node conventions the game relies on.

## Publishing

`netlify.toml` builds with `npm run build` and publishes `dist`. Review a deploy preview first; nothing here deploys production by itself. The shared flight log is casual and client-reported, not a cheat-proof ranking. No credentials are embedded in browser code. See `docs/LEADERBOARD.md`.

## Art and content

All game visuals are original. No assets were taken from any game, and no characters from other games are depicted. The portfolio copy and essays are preserved from the original site (see `game/content.js`); `LICENSE.txt` covers the existing content. Three.js is MIT-licensed. See `game/assets/ART-SOURCES.txt` for the BEACN and Heard Us identity notes and font licenses.
