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
    spawn: [0, 34], ship: [30, 44], shipYaw: -0.5,
    landmarks: [
      { id: 'origin', node: 'origin_monument', at: [0, -28], yaw: 0, clear: 18 },
      { id: 'health', node: 'pillar_health', at: [-30, -58], yaw: 0.5, clear: 7 },
      { id: 'family', node: 'pillar_family', at: [0, -74], yaw: 0, clear: 7 },
      { id: 'mission', node: 'pillar_mission', at: [30, -58], yaw: -0.5, clear: 7 },
      { id: 'depth-span', node: 'depth_span', at: [74, -14], yaw: -1.25, clear: 18 },
      { id: 'filter', node: 'filter_stones', at: [-62, 4], yaw: 1.35, clear: 16 },
      { id: 'library', node: 'reading_pavilion', at: [-66, -50], yaw: 0.85, clear: 12 },
    ],
    paths: [
      [[0, 30], [0, 4], [0, -14]],
      [[0, -40], [-18, -50], [-28, -55]], [[0, -40], [0, -68]], [[0, -40], [18, -50], [28, -55]],
      [[8, -20], [40, -18], [62, -14]],
      [[-6, 8], [-30, 6], [-52, 4]],
      [[-20, -40], [-44, -46], [-58, -48]],
    ],
  },
  experience: {
    plateau: { radius: 150, falloff: 120, mound: 2 },
    spawn: [0, 44], ship: [38, 52], shipYaw: -0.4,
    landmarks: [
      { id: 'arc', node: 'arc_gate', at: [0, -10], yaw: 0, clear: 18 },
      { id: 'bass', node: 'bass_stage', at: [-70, -62], yaw: 0.75, clear: 16 },
      { id: 'arena', node: 'arena', at: [76, -60], yaw: -0.75, clear: 20 },
      { id: 'build', node: 'workshop', at: [0, -106], yaw: 0, clear: 14 },
      { id: 'tools', node: 'tool_glyphs', at: [-38, -96], yaw: 0.35, clear: 12 },
      { id: 'ready', node: 'essay_plinth', shared: true, at: [42, -100], yaw: -0.35, clear: 5 },
    ],
    paths: [
      [[0, 40], [0, 12], [0, -30]], [[0, -30], [-36, -48], [-58, -58]], [[0, -30], [40, -48], [62, -56]], [[0, -30], [0, -60], [0, -94]],
    ],
  },
  projects: {
    plateau: { radius: 135, falloff: 100, mound: 2 },
    spawn: [0, 44], ship: [-36, 48], shipYaw: 0.5,
    landmarks: [
      { id: 'workshop', node: 'workshop_core', at: [0, -24], yaw: 0, clear: 16 },
      { id: 'beacn', node: 'project_beacn', at: [-46, -66], yaw: 0.6, clear: 8 },
      { id: 'heard-us', node: 'project_heard', at: [46, -66], yaw: -0.6, clear: 9 },
      { id: 'alignment-evals', node: 'project_crystal_0', at: [-76, -14], yaw: 1.25, clear: 7 },
      { id: 'alignment-probes', node: 'project_crystal_1', at: [-62, 22], yaw: 1.7, clear: 7 },
      { id: 'interpretability-toolkit', node: 'project_crystal_2', at: [76, -14], yaw: -1.25, clear: 7 },
      { id: 'prompt-injection-benchmark', node: 'project_crystal_3', at: [62, 22], yaw: -1.7, clear: 7 },
      { id: 'llm-circuit-visualizer', node: 'project_crystal_4', at: [0, -98], yaw: 0, clear: 7 },
      { id: 'build-log', node: 'build_log', at: [9, 12], yaw: -0.4, clear: 5 },
    ],
    paths: [
      [[0, 40], [0, -6]], [[-10, -36], [-40, -58]], [[10, -36], [40, -58]], [[0, -40], [0, -90]],
      [[-14, -20], [-68, -14]], [[14, -20], [68, -14]], [[-10, 6], [-54, 20]], [[10, 6], [54, 20]],
    ],
  },
  mission: {
    plateau: { radius: 100, falloff: 70, mound: 2 },
    spawn: [0, 34], ship: [-34, 40], shipYaw: 0.4,
    landmarks: [
      { id: 'observatory', node: 'observatory', at: [0, -36], yaw: 0, clear: 16 },
      { id: 'principle-1', node: 'principle_beacon_0', at: [-140, -150], yaw: 0, stack: { radius: 11, height: 38 }, clear: 0 },
      { id: 'principle-2', node: 'principle_beacon_1', at: [-50, -205], yaw: 0, stack: { radius: 11, height: 44 }, clear: 0 },
      { id: 'principle-3', node: 'principle_beacon_2', at: [50, -205], yaw: 0, stack: { radius: 11, height: 44 }, clear: 0 },
      { id: 'principle-4', node: 'principle_beacon_3', at: [140, -150], yaw: 0, stack: { radius: 11, height: 38 }, clear: 0 },
      { id: 'lens-1', node: 'principle_lens_0', at: [-58, -70], face: [-140, -150], clear: 4 },
      { id: 'lens-2', node: 'principle_lens_1', at: [-22, -86], face: [-50, -205], clear: 4 },
      { id: 'lens-3', node: 'principle_lens_2', at: [22, -86], face: [50, -205], clear: 4 },
      { id: 'lens-4', node: 'principle_lens_3', at: [58, -70], face: [140, -150], clear: 4 },
      { id: 'long-view', node: 'long_view_bench', at: [62, -30], yaw: -0.9, clear: 6 },
      { id: 'essays', node: 'essay_plinth', shared: true, at: [-56, -32], yaw: 0.9, clear: 5 },
    ],
    paths: [[[0, 30], [0, -18]], [[-10, -44], [-50, -64]], [[10, -44], [50, -64]], [[-8, -50], [-20, -80]], [[8, -50], [20, -80]], [[12, -30], [54, -30]], [[-12, -30], [-48, -32]]],
  },
  contact: {
    plateau: { radius: 125, falloff: 100, mound: 1.5 },
    spawn: [0, 44], ship: [34, 50], shipYaw: -0.5,
    landmarks: [
      { id: 'signal', node: 'signal_dish', at: [0, -40], yaw: 0, clear: 18 },
      { id: 'email', node: 'contact_antenna_0', at: [-66, -20], yaw: 1.1, clear: 6 },
      { id: 'github', node: 'contact_antenna_1', at: [-40, -86], yaw: 0.5, clear: 6 },
      { id: 'linkedin', node: 'contact_antenna_2', at: [40, -86], yaw: -0.5, clear: 6 },
      { id: 'public-square', node: 'contact_antenna_3', at: [66, -20], yaw: -1.1, clear: 6 },
      { id: 'closing', node: 'closing_monolith', at: [-14, 8], yaw: 0.35, clear: 6 },
    ],
    paths: [[[0, 40], [0, -18]], [[-12, -40], [-58, -22]], [[-8, -54], [-36, -80]], [[8, -54], [36, -80]], [[12, -40], [58, -22]]],
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
