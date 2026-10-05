/**
 * The Pedalboard: the Aster's upgrades, as bass effect pedals. Tone earned
 * in space (and on the worlds) engages them one level at a time. Everything
 * here is plain data and pure functions so the journal, the game and the
 * panels share one source of truth.
 */
export const PEDALS = Object.freeze([
  { id: 'overdrive', name: 'Overdrive', kind: 'DRIVE', effect: 'The cannons fire faster.', color: '#ff9a62', levels: ['+20% fire rate', '+45% fire rate', '+75% fire rate'] },
  { id: 'octaver', name: 'Octaver', kind: 'PITCH', effect: 'More bolts in every volley.', color: '#b9a2ff', levels: ['3 bolts', '4 bolts', '5 bolts, +15% damage'] },
  { id: 'harmonics', name: 'Harmonics', kind: 'MODULATION', effect: 'Homing missiles: right click or C.', color: '#8cf0d1', levels: ['2 missiles', '4 missiles', '6 missiles, faster reload'] },
  { id: 'compressor', name: 'Compressor', kind: 'DYNAMICS', effect: 'Bigger shields that recover sooner.', color: '#83beff', levels: ['140 shield', '185 shield', '240 shield'] },
  { id: 'fuzz', name: 'Fuzz', kind: 'DRIVE', effect: 'A faster boost and bigger slipstream surges.', color: '#f3d28c', levels: ['+15% boost', '+30% boost', '+45% boost, ram through the Static'] },
  { id: 'delay', name: 'Delay', kind: 'TIME', effect: 'Every volley echoes a beat later.', color: '#ec8c69', levels: ['40% echo', '65% echo', '90% echo'] },
  { id: 'reverb', name: 'Reverb', kind: 'SPACE', effect: 'Kills ring out and shatter nearby Static.', color: '#e2b8ff', levels: ['Earned by silencing the Dissonance'], earned: true },
]);

/** Tone to engage level 1, 2 and 3 of a pedal. */
export const COSTS = Object.freeze([120, 300, 600]);

/** Tone rewards. */
export const TONE = Object.freeze({
  glitch: 12, spike: 10, jammer: 30, node: 60, boss: 400,
  wave: 20, rift: 150, encore: 60, gate: 3, slingshot: 15, lap: 40, bronze: 60, silver: 120, gold: 250,
  streak: 25, shard: 15, discovery: 5, warden: 100,
});

const byId = id => PEDALS.find(p => p.id === id) || null;

export function maxLevel(id) { return byId(id)?.levels.length ?? 0; }

export function levelOf(pedals, id) {
  return Math.max(0, Math.min(maxLevel(id), Math.floor(Number(pedals?.[id]) || 0)));
}

/** Tone for the next level, or null when maxed or not for sale. */
export function nextCost(pedals, id) {
  const pedal = byId(id);
  if (!pedal || pedal.earned) return null;
  const level = levelOf(pedals, id);
  return level < pedal.levels.length ? COSTS[level] : null;
}

/** What the engaged pedals do to the ship. */
export function loadout(pedals = {}) {
  const L = id => levelOf(pedals, id);
  const octave = L('octaver'), harmonics = L('harmonics'), compressor = L('compressor'), fuzz = L('fuzz');
  return {
    fireInterval: [0.13, 0.108, 0.09, 0.074][L('overdrive')],
    bolts: [2, 3, 4, 5][octave],
    spread: [0.010, 0.014, 0.018, 0.022][octave],
    damage: octave >= 3 ? 30 : 26,
    echo: [0, 0.4, 0.65, 0.9][L('delay')],
    missiles: [0, 2, 4, 6][harmonics],
    missileCooldown: [0, 6, 5, 3.6][harmonics],
    missileDamage: 130,
    shieldMax: [100, 140, 185, 240][compressor],
    shieldDelay: [3.2, 2.6, 2.1, 1.6][compressor],
    shieldRegen: [26, 34, 44, 58][compressor],
    boost: [1, 1.15, 1.3, 1.45][fuzz],
    surge: [420, 520, 640, 780][fuzz],
    ram: fuzz >= 3,
    reverb: L('reverb') >= 1,
  };
}

/** Total levels engaged (for the journal and the map). */
export function pedalCount(pedals) { return PEDALS.reduce((n, p) => n + levelOf(pedals, p.id), 0); }
