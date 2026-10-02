/**
 * The Unfolding star system: five portfolio worlds plus the deep-space project
 * landmarks. Everything here is plain data so it can be cloned into workers.
 * Units are meters. Each planet's terrain is a closed sphere of `radius` with
 * analytic relief from planet-shape.js; sea level is radius + seaLevel.
 */

/** Direction from any point in the system toward the (very distant) sun. */
export const SUN_DIRECTION = normalize([-0.42, 0.34, 0.84]);
export const SUN_COLOR = [1.0, 0.94, 0.86];

function normalize(v) { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; }
function mixDir(a, b, t) { return normalize([a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t]); }
/** A direction `angle` radians away from `dir`, rotated toward `toward`. */
function tilt(dir, toward, angle) {
  const d = normalize(dir), t0 = normalize(toward);
  const dot = d[0] * t0[0] + d[1] * t0[1] + d[2] * t0[2];
  const t = normalize([t0[0] - d[0] * dot, t0[1] - d[1] * dot, t0[2] - d[2] * dot]);
  return normalize([d[0] * Math.cos(angle) + t[0] * Math.sin(angle), d[1] * Math.cos(angle) + t[1] * Math.sin(angle), d[2] * Math.cos(angle) + t[2] * Math.sin(angle)]);
}
// Main sites sit in the morning: the sun is ~38° above their horizon, which
// keeps long readable shadows and warm light on the content landmarks.
const morning = (toward, angle = 0.9) => tilt(SUN_DIRECTION, toward, angle);

export const PLANETS = [
  {
    id: 'philosophy', name: 'Philosophy', title: 'The Origin', number: '01', subtitle: 'THE WAY I SEE',
    color: '#8cf0d1', position: [-21000, 2600, -30000], radius: 6200, seed: 1101,
    terrain: { kind: 'archipelago', seaLevel: 0, relief: 1 },
    siteDir: morning([0.3, 1, 0.2], 0.85), siteHeight: 22,
    palette: {
      sand: '#f1dfb0', grassA: '#4fb787', grassB: '#86cf8e', grassC: '#2f8f6e', dirt: '#7f9a6a',
      rockA: '#dde7de', rockB: '#94aba1', cliff: '#6c8a85', seabedShallow: '#38c4bb', seabedDeep: '#0b4d60',
      water: '#2bb8b6', waterDeep: '#0b4558', foam: '#e9fff8', glow: '#8cf0d1', path: '#f4ead2',
    },
    atmosphere: { rayleigh: [0.30, 0.62, 0.86], mie: 0.6, mieTint: [1.0, 0.94, 0.86], height: 0.14, density: 1.0, sunset: [1.0, 0.62, 0.45], night: [0.04, 0.09, 0.13] },
    ambient: { sky: '#bfe8f2', ground: '#6f9a86' }, fog: 1.0, clouds: 0.55,
  },
  {
    id: 'experience', name: 'Experience', title: 'The Arc', number: '02', subtitle: 'WHERE I HAVE BEEN',
    color: '#ec8c69', position: [26000, 6200, -52000], radius: 7200, seed: 2207,
    terrain: { kind: 'canyons', seaLevel: null, relief: 1 },
    siteDir: morning([0.6, 0.8, -0.1], 1.05), siteHeight: 38, // a canyon-floor amphitheater ringed by mesas
    palette: {
      sand: '#e7b07a', grassA: '#e3bd6b', grassB: '#cf9a58', grassC: '#b6844c', dirt: '#c9784f',
      rockA: '#c86e4c', rockB: '#9a4f3a', cliff: '#6e3a30', strataA: '#e0a06a', strataB: '#b85f42', strataC: '#7c3e33',
      seabedShallow: '#a8603f', seabedDeep: '#5b2e26', water: '#4e9aa6', waterDeep: '#1d4b5a', foam: '#fff1dc', glow: '#ff9a62', path: '#f2d3a8',
    },
    atmosphere: { rayleigh: [0.36, 0.56, 0.84], mie: 1.25, mieTint: [1.0, 0.6, 0.34], height: 0.14, density: 1.05, sunset: [1.0, 0.46, 0.28], night: [0.10, 0.05, 0.06] },
    ambient: { sky: '#f3c7a6', ground: '#8a5a44' }, fog: 1.15, clouds: 0.25,
  },
  {
    id: 'projects', name: 'Projects', title: 'The Workshop', number: '03', subtitle: 'WORLDS I HAVE BUILT',
    color: '#b9a2ff', position: [47000, -5200, -8000], radius: 5600, seed: 3313,
    terrain: { kind: 'crystal', seaLevel: null, relief: 1 },
    siteDir: morning([-0.2, 0.9, 0.4], 0.95), siteHeight: 4, // a hollow among crystal ridges
    palette: {
      sand: '#a996dc', grassA: '#8069cc', grassB: '#9f8ae3', grassC: '#5d4aa6', dirt: '#55467f',
      rockA: '#5c5080', rockB: '#3d3557', cliff: '#2c2742', seabedShallow: '#6d5a9e', seabedDeep: '#2c2742',
      water: '#7e6be0', waterDeep: '#2b2160', foam: '#f3eaff', glow: '#e2b8ff', path: '#e9e0ff',
    },
    atmosphere: { rayleigh: [0.58, 0.40, 0.95], mie: 0.9, mieTint: [1.0, 0.52, 0.82], height: 0.14, density: 0.95, sunset: [1.0, 0.55, 0.78], night: [0.07, 0.04, 0.13] },
    ambient: { sky: '#d9c9ff', ground: '#5d4d87' }, fog: 0.9, clouds: 0.35,
  },
  {
    id: 'mission', name: 'Mission', title: 'The Horizon', number: '04', subtitle: 'WHAT COMES NEXT',
    color: '#83beff', position: [-46000, -3000, 9000], radius: 8000, seed: 4421,
    terrain: { kind: 'ocean', seaLevel: 0, relief: 1 },
    siteDir: morning([0.5, 1, -0.3], 0.8), siteHeight: 64,
    palette: {
      sand: '#ece6d2', grassA: '#4a9d90', grassB: '#73bca7', grassC: '#357f7d', dirt: '#6f8c95',
      rockA: '#c9d8e8', rockB: '#8fa9c6', cliff: '#6f8fb3', seabedShallow: '#3fd0e0', seabedDeep: '#0b2f63',
      water: '#1f86d6', waterDeep: '#0a2a5c', foam: '#f2fbff', glow: '#83e8ff', path: '#f4f1e6',
    },
    atmosphere: { rayleigh: [0.26, 0.55, 0.98], mie: 0.5, mieTint: [0.86, 0.95, 1.0], height: 0.14, density: 1.0, sunset: [1.0, 0.68, 0.52], night: [0.03, 0.06, 0.14] },
    ambient: { sky: '#cfe6ff', ground: '#5f7f94' }, fog: 0.95, clouds: 0.7,
  },
  {
    id: 'contact', name: 'Contact', title: 'The Signal', number: '05', subtitle: 'A SIGNAL BETWEEN US',
    color: '#f3d28c', position: [4000, 11000, 38000], radius: 5000, seed: 5527,
    terrain: { kind: 'dunes', seaLevel: null, relief: 1 },
    siteDir: morning([0, 1, -0.6], 1.2), siteHeight: 14, // a dune valley below the buttes
    palette: {
      sand: '#ecc77e', grassA: '#d7b35c', grassB: '#c49d4c', grassC: '#a8853f', dirt: '#d4a35a',
      rockA: '#c27f52', rockB: '#9a5a38', cliff: '#7a4330', seabedShallow: '#5ec2b0', seabedDeep: '#1f5f66',
      water: '#3fb5b0', waterDeep: '#155660', foam: '#fff6e0', glow: '#ffd27a', path: '#fbe7bd',
    },
    atmosphere: { rayleigh: [0.44, 0.50, 0.88], mie: 1.15, mieTint: [1.0, 0.78, 0.42], height: 0.14, density: 1.05, sunset: [1.0, 0.52, 0.30], night: [0.09, 0.07, 0.10] },
    ambient: { sky: '#ffe2b8', ground: '#9a7350' }, fog: 1.1, clouds: 0.2,
  },
];

export const PROJECT_LANDMARK_POSITIONS = {
  beacn: [0, 4200, -27000],
  heardUs: [4500, 2100, -13500],
};

export function planetById(id) { return PLANETS.find(p => p.id === id) || null; }
export { normalize, mixDir, tilt };
