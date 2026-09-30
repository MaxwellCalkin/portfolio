/** Shared physical scale. Positions are persistent world coordinates, in metres. */
export const SOLAR_SCALE = Object.freeze({
  planetRadius: 10,
  planetSpacing: 30,
  landmarkScale: 18,
  starfieldRadius: 300000,
  skyRadius: 360000,
  cameraFar: 600000,
  worldExtent: 65000,
});

export const FLIGHT_TUNING = Object.freeze({
  cruiseSpeed: 2400,
  boostSpeed: 7200,
  reverseSpeed: 1200,
  cruiseAcceleration: 520,
  boostAcceleration: 1600,
  reverseAcceleration: 520,
  cruiseStartsAt: 800,
  cruiseFullyAt: 8000,
  integrationRate: 120,
});

// One short introductory corridor, then widely separated pairs at destinations.
// Keeping a few encounters local gives the launch a readable foreground without
// packing the entire race/combat system around the player's initial position.
export const GATE_LOCATIONS = Object.freeze([
  [0, 18, -900], [0, 38, -3100],
  [-9800, 1100, -14200], [-12600, 1500, -18200],
  [9800, 2200, -21600], [12100, 2850, -26800],
  [29200, -1800, -7500], [35000, -2800, -8700],
  [1200, 3900, 18700], [2200, 5300, 24200],
  [-26000, -1500, 5600], [-32400, -2000, 6900],
  [2800, 3400, -21300], [3300, 4200, -25600],
].map(Object.freeze));
export const INTERCEPTOR_LOCATIONS = Object.freeze([
  [260, 90, -1450], [-330, 140, -6700],
  [-11100, 1260, -16200], [-20300, 2300, -28200],
  [11000, 2420, -23900], [20900, 5750, -48100],
  [32600, -2240, -8100], [43500, -4830, -7800],
  [2000, 4700, 21600], [3700, 9410, 33400],
  [-29200, -1800, 6240], [-43300, -2930, 8660],
].map(Object.freeze));
