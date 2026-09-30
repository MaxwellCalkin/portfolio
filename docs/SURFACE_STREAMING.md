# Whole-planet surface streaming

All public positions remain in the solar system's shared world coordinates. The closed spherical terrain mesh stays allocated and visible during flight, landing, walking, and takeoff. Streaming only changes local scenery and archive models/colliders.

## Main-loop API

```js
surface.update(timeSeconds, deltaSeconds, playerWorldPosition);
const archive = surface.nearestShrine(playerWorldPosition);
// { id, sectorId, position: THREE.Vector3, distance: world-space meters, hub }

const sectors = surface.nearbySectors(playerWorldPosition, rangeMeters, maxCount);
// sorted nearest first; default range 300m, count 24
// Each sector: { id, face, x, y, seed, position, up, area, shrine, hub }

const habitatPosition = surface.worldCatalog.pointInSector(sector, 0.2, 0.7, 0);
// u/v are normalized within the sector; optional clearance is radial meters

surface.getStreamingStats();
```

Call `update` on every surface with the actual player position, including during the intro and orbital flight. Terrain remains available everywhere; tile props and colliders unload above 650m and on unrelated planets. Omitting focus retains the legacy arrival-site behavior. Existing `beaconPosition`, `spawn`, `shipPosition`, `setParkedShip`, collision operations, and terrain samplers are unchanged.

`nearestShrine` returns the exact nearest archive in the deterministic catalog, including unloaded locations. Distances use actual rendered-ground world positions, not chart offsets or a hub placeholder. Do not mutate catalog descriptors. Archive IDs survive unloading and returning. The hub is a real catalog archive, not an additional duplicate superimposed on it.

## Coverage and poles

The catalog divides the six faces of a cube into a uniform grid, normalizes directions onto the sphere, then rotates the complete catalog to align one archive precisely with the original hub. It has neither a longitude seam nor a pole singularity.

The rendered mesh measures its maximum vertex radius and minimum radial/face-normal alignment. Their quotient bounds the world-space metric of the exact faceted terrain shell. Cube normalization has spherical metric at most one; a cell's center is at most `sqrt(2) / divisions` away along that spherical path. Grid subdivisions are selected so their product is no more than 145 meters. Thus every ground position has an archive within 145m, including terrain relief. Dense samples, all cell corners, and both poles are tested in addition to the bound.

With the current production world definitions:

| World | Catalog archives | Conservative maximum nearest distance |
| --- | ---: | ---: |
| Philosophy | 1,944 | 142.65m |
| Experience | 4,704 | 143.26m |
| Projects | 1,734 | 136.54m |
| Mission | 5,400 | 140.76m |
| Contact | 1,014 | 139.21m |

These are data-only records. Thousands of meshes are **not** spawned.

## Budgets and lifetime

- At most 24 live sectors within a 310m center-distance neighborhood
- Rock, mineral bloom, tree, and shrine-part geometry shared across sectors
- At most 12 instanced draw calls for all streamed scenery and shrines combined, plus the nearby legacy hub
- At most 3,456 loose scenery instances; collider totals remain bounded by active sectors
- Sector changes are checked after 12m travel or crossing the orbital activation threshold
- Stable per-sector seeds generate identical object poses/collider IDs on return
- Unloading removes every tile collider and releases its tile data; reusable instance GPU buffers stay bounded and are disposed once at surface shutdown
- The hub's models/colliders are culled outside its neighborhood; explicitly registered parked-ship triangles remain under the existing ship lifecycle
- Giant planets use one fixed 256×160 terrain mesh (81,408 triangles), with exact collision lookup precomputed from its final Float32 vertices; no per-frame retessellation

`getStreamingStats()` includes live sector/archive IDs, catalog totals, maximum coverage, mesh/instance/collider counts, pooled draw counts, created/disposed sector counts, and whether the hub is active. These are observational diagnostics and do not alter gameplay.

## Verification

`tests/surface-streaming.test.js` checks large-planet ray/ground agreement, metric bounds, global shrine coverage, deterministic identities/poses, poles, bounded instancing/colliders, nearest archive model activation, collider removal, unload/reload collision, orbital unloading, and disposal. `tests/planet-surfaces.test.js` still checks original hub access, parked-ship triangles, radial poses, and swept obstacle collision. Animated archive subparts use their assembly's radial frame, while standalone scenery remains individually radial.
