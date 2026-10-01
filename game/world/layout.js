import { PLANETS, SUN_DIRECTION } from './system.js';
import { tangentFrame, siteLocalToDir } from './planet-shape.js';

/**
 * Where everything sits on each world. Coordinates are meters in the main
 * site's tangent frame: +x is right, -z is "ahead" (the direction you face
 * when you arrive), so the spawn sits at positive z looking toward the archive.
 *
 * The frame is oriented so the sun lights the main view from behind-right,
 * which keeps landmark colors readable and shadows long and graphic.
 */

/** Builds the site frame at a planet's main site. */
export function siteFrameFor(spec) {
  const up = spec.siteDir;
  const s = SUN_DIRECTION, d = s[0] * up[0] + s[1] * up[1] + s[2] * up[2];
  let sx = s[0] - up[0] * d, sy = s[1] - up[1] * d, sz = s[2] - up[2] * d;
  const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
  // forward0 = up x sunH (sun exactly to the right); rotate 30° away from the sun.
  const f0 = [up[1] * sz - up[2] * sy, up[2] * sx - up[0] * sz, up[0] * sy - up[1] * sx];
  const a = (spec.siteSunAngle ?? 30) * Math.PI / 180;
  const hint = [f0[0] * Math.cos(a) - sx * Math.sin(a), f0[1] * Math.cos(a) - sy * Math.sin(a), f0[2] * Math.cos(a) - sz * Math.sin(a)];
  return tangentFrame(up, hint);
}

/* Per-world landmark layout. `kind` maps to a landmark builder; `poi` ids map
 * to discoveries in content-map.js. Radii are the flattened footprint. */
export const LAYOUTS = {
  philosophy: {
    plateau: { radius: 120, falloff: 90, mound: 3 },
    spawn: [0, 34], ship: [30, 40], shipYaw: -0.5,
    landmarks: [
      { id: 'origin', kind: 'origin-monument', at: [0, -28], yaw: 0 },
      { id: 'health', kind: 'pillar', at: [-30, -58], yaw: 0.6, variant: 0 },
      { id: 'family', kind: 'pillar', at: [0, -72], yaw: 0, variant: 1 },
      { id: 'mission', kind: 'pillar', at: [30, -58], yaw: -0.6, variant: 2 },
      { id: 'depth-span', kind: 'depth-span', at: [74, -14], yaw: -1.2 },
      { id: 'filter', kind: 'filter-stones', at: [-62, 2], yaw: 1.3 },
      { id: 'library', kind: 'reading-pavilion', at: [-66, -50], yaw: 0.9 },
    ],
    paths: [
      [[0, 30], [0, 4], [0, -14]],
      [[0, -40], [-18, -50], [-28, -56]], [[0, -40], [0, -64]], [[0, -40], [18, -50], [28, -56]],
      [[8, -20], [40, -18], [64, -14]],
      [[-6, 8], [-30, 6], [-56, 2]],
      [[-20, -40], [-44, -46], [-60, -50]],
    ],
  },
  experience: {
    plateau: { radius: 150, falloff: 120, mound: 2 },
    spawn: [0, 40], ship: [34, 48], shipYaw: -0.4,
    landmarks: [
      { id: 'arc', kind: 'arc-gate', at: [0, -10], yaw: 0 },
      { id: 'bass', kind: 'bass-stage', at: [-70, -60], yaw: 0.7 },
      { id: 'arena', kind: 'arena', at: [74, -58], yaw: -0.7 },
      { id: 'build', kind: 'workshop', at: [0, -104], yaw: 0 },
      { id: 'tools', kind: 'tool-glyphs', at: [-36, -90], yaw: 0.3 },
      { id: 'ready', kind: 'essay-plinth', at: [40, -96], yaw: -0.3 },
    ],
    paths: [
      [[0, 36], [0, 10], [0, -30]], [[0, -30], [-36, -48], [-60, -58]], [[0, -30], [40, -48], [64, -56]], [[0, -30], [0, -60], [0, -90]],
    ],
  },
  projects: {
    plateau: { radius: 135, falloff: 100, mound: 2 },
    spawn: [0, 40], ship: [-34, 44], shipYaw: 0.5,
    landmarks: [
      { id: 'workshop', kind: 'workshop-core', at: [0, -24], yaw: 0 },
      { id: 'beacn', kind: 'project-beacn', at: [-46, -64], yaw: 0.5 },
      { id: 'heard-us', kind: 'project-heard', at: [46, -64], yaw: -0.5 },
      { id: 'alignment-evals', kind: 'project-crystal', at: [-74, -12], yaw: 1.2, variant: 0 },
      { id: 'alignment-probes', kind: 'project-crystal', at: [-60, 22], yaw: 1.6, variant: 1 },
      { id: 'interpretability-toolkit', kind: 'project-crystal', at: [74, -12], yaw: -1.2, variant: 2 },
      { id: 'prompt-injection-benchmark', kind: 'project-crystal', at: [60, 22], yaw: -1.6, variant: 3 },
      { id: 'llm-circuit-visualizer', kind: 'project-crystal', at: [0, -96], yaw: 0, variant: 4 },
      { id: 'build-log', kind: 'build-log', at: [0, 10], yaw: 0 },
    ],
    paths: [
      [[0, 36], [0, -8]], [[-10, -36], [-40, -58]], [[10, -36], [40, -58]], [[0, -40], [0, -88]],
      [[-14, -20], [-66, -12]], [[14, -20], [66, -12]], [[-10, 6], [-54, 20]], [[10, 6], [54, 20]],
    ],
  },
  mission: {
    plateau: { radius: 100, falloff: 70, mound: 2 },
    spawn: [0, 32], ship: [-30, 36], shipYaw: 0.4,
    landmarks: [
      { id: 'observatory', kind: 'observatory', at: [0, -40], yaw: 0 },
      { id: 'principle-1', kind: 'principle-beacon', at: [-140, -150], yaw: 0, variant: 0, stack: { radius: 11, height: 38 } },
      { id: 'principle-2', kind: 'principle-beacon', at: [-50, -205], yaw: 0, variant: 1, stack: { radius: 11, height: 44 } },
      { id: 'principle-3', kind: 'principle-beacon', at: [50, -205], yaw: 0, variant: 2, stack: { radius: 11, height: 44 } },
      { id: 'principle-4', kind: 'principle-beacon', at: [140, -150], yaw: 0, variant: 3, stack: { radius: 11, height: 38 } },
      { id: 'long-view', kind: 'long-view-bench', at: [52, -60], yaw: -0.4 },
      { id: 'essays', kind: 'essay-plinth', at: [-52, -58], yaw: 0.4 },
    ],
    paths: [[[0, 28], [0, -20]], [[-10, -44], [-46, -56]], [[10, -44], [46, -58]]],
  },
  contact: {
    plateau: { radius: 125, falloff: 100, mound: 1.5 },
    spawn: [0, 40], ship: [32, 46], shipYaw: -0.5,
    landmarks: [
      { id: 'signal', kind: 'signal-dish', at: [0, -40], yaw: 0 },
      { id: 'email', kind: 'contact-antenna', at: [-64, -20], yaw: 1.1, variant: 0 },
      { id: 'github', kind: 'contact-antenna', at: [-40, -84], yaw: 0.5, variant: 1 },
      { id: 'linkedin', kind: 'contact-antenna', at: [40, -84], yaw: -0.5, variant: 2 },
      { id: 'public-square', kind: 'contact-antenna', at: [64, -20], yaw: -1.1, variant: 3 },
      { id: 'closing', kind: 'closing-monolith', at: [0, 6], yaw: 0 },
    ],
    paths: [[[0, 36], [0, -16]], [[-12, -40], [-56, -22]], [[-8, -54], [-36, -78]], [[8, -54], [36, -78]], [[12, -40], [56, -22]]],
  },
};

/**
 * Adds the site frame, flattened plateaus and painted paths to each planet
 * spec. The result is plain JSON-safe data (workers receive it via postMessage).
 */
export function prepareSpecs(specs = PLANETS) {
  return specs.map(spec => {
    const layout = LAYOUTS[spec.id];
    const frame = siteFrameFor(spec);
    if (!layout) return { ...spec, frame, sites: [], paths: [] };
    const R = spec.radius;
    const sites = [{ dir: frame.up, radius: layout.plateau.radius, falloff: layout.plateau.falloff, height: spec.siteHeight ?? null, mound: layout.plateau.mound }];
    for (const mark of layout.landmarks) {
      if (!mark.stack) continue;
      sites.push({ dir: siteLocalToDir(frame, R, mark.at[0], mark.at[1]), radius: mark.stack.radius, falloff: 18, height: mark.stack.height, mound: 1 });
    }
    const paths = [{ frame, polylines: layout.paths, width: 2.4, extent: layout.plateau.radius + layout.plateau.falloff + 40 }];
    return { ...spec, frame, sites, paths };
  });
}
