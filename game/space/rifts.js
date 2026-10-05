/**
 * Static rifts: tears in deep space where the Static (noise that drowns out
 * every signal) pours through. Flying into a rift's field starts an
 * incursion of waves; silencing it is permanent progress, and every later
 * visit is an encore with tougher waves. Plain data, shared by the encounter
 * director (logic) and the scenery (visuals).
 */
export const FIELD_RADIUS = 3200; // the incursion starts here, and the pulse drive is jammed inside
export const LEASH_RADIUS = 6000; // fly this far out to retreat

export const RIFTS = Object.freeze([
  {
    id: 'hum', name: 'The Hum', number: 'I', color: '#ff4d6d', calm: '#8c6bbd', position: [-6000, 12500, -40000], tier: 1,
    waves: [[['glitch', 3]], [['glitch', 4], ['spike', 2]], [['glitch', 3], ['jammer', 1]]],
  },
  {
    id: 'crackle', name: 'The Crackle', number: 'II', color: '#ff7a45', calm: '#9a7ac9', position: [38000, 12000, -30000], tier: 2,
    waves: [[['glitch', 3], ['jammer', 1]], [['spike', 5], ['glitch', 2]], [['jammer', 2], ['glitch', 4]]],
  },
  {
    id: 'dissonance', name: 'The Dissonance', number: 'III', color: '#d94dff', calm: '#7f8bd6', position: [-22000, 17000, 26000], tier: 3, boss: true,
    waves: [[['glitch', 4], ['jammer', 1]], [['spike', 4], ['jammer', 2], ['glitch', 2]], [['boss', 1]]],
  },
]);

export function riftById(id) { return RIFTS.find(r => r.id === id) || null; }

/** Encores add glitches to every wave (one per encore, up to three) and raise the tier. */
export function wavesFor(rift, clears = 0) {
  const extra = Math.min(3, clears);
  return rift.waves.map(wave => {
    if (!extra || wave.some(([type]) => type === 'boss')) return wave;
    return wave.some(([type]) => type === 'glitch') ? wave.map(([type, n]) => [type, type === 'glitch' ? n + extra : n]) : [...wave, ['glitch', extra]];
  });
}
export function tierFor(rift, clears = 0) { return rift.tier + Math.min(4, clears); }
