// The six musical themes of The Unfolding. Each theme is data (tempo, mode,
// chords, sections, forms, mix) plus small generators that write one bar of
// bass, drums and keys at a time from a seeded PRNG. The bass is the star.

import { chord, combatPattern, embellish, lockedKick, modePitchClasses, parseBassPattern, parseDrumPattern, scaleStep } from './harmony.js';

const pcs = (tonic, mode) => modePitchClasses(tonic, mode);

/** FM presets for the keys stem. */
export const FM_PRESETS = {
  bell: { ratio: 3.5, index: 1.1, decay: 3.2, level: 0.56 },
  glass: { ratio: 5, index: 0.7, decay: 0.8, level: 0.42 },
  ep: { ratio: 1, index: 1.6, decay: 1.6, level: 0.28, indexFloor: 0.25, indexDecay: 0.3 },
  mallet: { ratio: 3, index: 1, decay: 0.7, level: 0.45 },
  deepBell: { ratio: 1.41, index: 1.8, decay: 4.5, level: 0.42 },
};

/**
 * The bass groove for a bar: a main pattern held for the whole phrase, an
 * alternate that answers it on even bars, and occasional fills at phrase ends.
 */
function phraseGroove(g, patterns, { fills = [], fillChance = 0.55, altChance = 0.45 } = {}) {
  if (fills.length && g.isPhraseEnd && g.rng.chance(fillChance)) return g.rng.pick(fills);
  const main = g.phraseChoice('bass', () => g.rng.weighted(patterns));
  const alt = g.phraseChoice('bassAlt', () => g.rng.weighted(patterns));
  return g.barInPhrase % 2 === 1 && g.rng.chance(altChance) ? alt : main;
}

/** Picks `count` distinct chord tones above `floor` from a chord's pad (lifted by octaves). */
function bellNotes(chordDef, rng, { lift = 12, count = 1 } = {}) {
  const pool = (chordDef.arp || chordDef.pad).map((note) => note + lift);
  const notes = [];
  for (let i = 0; i < count; i++) notes.push(rng.pick(pool));
  return notes;
}

/** Sparse, floating bells used by the calmer themes. */
function sparseBells(g, { probability, preset = 'bell', lift = 12, steps = [4, 6, 8, 10, 12, 14] }) {
  const events = [];
  if (!g.rng.chance(probability)) return events;
  const step = g.rng.pick(steps);
  const [midi] = bellNotes(g.chordAt(step), g.rng, { lift });
  events.push({ kind: 'keys', preset, step, midi, vel: g.rng.range(0.45, 0.7), pan: g.rng.range(-0.6, 0.6) });
  return events;
}

/** A rising three-note "wave" motif in the current scale (phrase openings). */
function waveMotif(g, { start = 4, lift = 12, preset = 'bell', spacing = 2 }) {
  const first = g.chordAt(start);
  let midi = g.rng.pick(first.pad) + lift;
  const scale = g.pitchClasses(start);
  const events = [];
  for (let i = 0; i < 3; i++) {
    events.push({ kind: 'keys', preset, step: start + i * spacing, midi, vel: 0.6 - i * 0.08, pan: -0.4 + i * 0.4 });
    midi = scaleStep(midi, g.rng.pick([1, 2]), scale);
  }
  return events;
}

/** Electric-piano / stab comping from a 16-step rhythm string ('X' long, 'x' short). */
function comp(g, rhythm, { len = 2, longLen = 6, vel = 0.5, preset = 'ep' } = {}) {
  const events = [];
  const symbols = rhythm.replace(/\s+/g, '');
  for (let step = 0; step < 16; step++) {
    const symbol = symbols[step];
    if (symbol !== 'x' && symbol !== 'X') continue;
    events.push({ kind: 'chord', preset, step, notes: g.chordAt(step).pad, len: symbol === 'X' ? longLen : len, vel: vel * (symbol === 'X' ? 1 : 0.85) });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Philosophy: D dorian, 84 bpm. Calm, spacious, hopeful (morning by the sea).
// A: Dm9 | G6/9 | Fmaj9 | C/E (bass sings D-G-F-E), B: Bbmaj9 | C6/9 | Dm9 | Am11
// (an aeolian lift: bVI-bVII-i).
// ---------------------------------------------------------------------------
const D_DORIAN = pcs(2, 'dorian');
const D_AEOLIAN = pcs(2, 'aeolian');

const philosophy = {
  id: 'philosophy',
  bpm: 84,
  swing8: 0.05,
  tonic: 38,
  mode: 'dorian',
  scale: D_DORIAN,
  tomMidi: 45,
  gain: 1.13,
  levels: { bass: 1, pad: 0.71, keys: 1, perc: 0.83 },
  sends: { bass: 0.1, pad: 0.55, keys: 0.6, perc: 0.16 },
  delay: { beats: 0.75, feedback: 0.32, send: 0.22 },
  padStyle: { attack: 1.8, release: 2.6, cutoff: 1300, detune: 6, width: 0.5, level: 0.15, lfoRate: 0.09 },
  bassStyle: { level: 0.5, gate: 0.96, decay: 0.9, brightness: 0.85, sub: 0.55 },
  drumStyle: { kick: { from: 120, to: 46, decay: 0.1 }, snare: { decay: 0.14 }, hatLevel: 0.05 },
  chords: {
    Dm9: chord('Dm9', 38, 'm7', [53, 57, 60, 64]),
    G69: chord('G6/9', 43, 'six', [59, 62, 64, 69]),
    Fmaj9: chord('Fmaj9', 41, 'maj7', [57, 60, 64, 67]),
    CE: chord('Cadd9/E', 40, 'firstInversion', [55, 60, 62, 67]),
    Em7: chord('Em7', 40, 'aeolian', [55, 59, 62, 67]),
    Bbmaj9: chord('Bbmaj9', 34, 'maj7', [57, 60, 62, 65], { scale: D_AEOLIAN }),
    C69: chord('C6/9', 36, 'six', [55, 57, 62, 64], { scale: D_AEOLIAN }),
    Am11: chord('Am11', 33, 'aeolian', [55, 60, 62, 64]),
  },
  sections: {
    A: [['Dm9'], ['G69'], ['Fmaj9'], ['CE']],
    A2: [['Dm9'], ['G69'], ['Fmaj9'], ['Em7']],
    B: [['Bbmaj9'], ['C69'], ['Dm9'], ['Am11']],
  },
  forms: [['A', 'A2', 'B', 'A'], ['A', 'B', 'A2', 'B'], ['A2', 'A', 'B', 'A']],
  bass(g) {
    const pattern = phraseGroove(g, [
      ['R...........5...', 3],
      ['R.......5...A...', 3],
      ['R.....O.9.......', 2],
      ['R.......5.~O....', 2],
      ['R...........W.A.', 1.5],
      ['R.......R...5.x.', 1],
    ], { fills: ['R.5.O.9.7.5.3.A.', 'R.....5.O.7.6.W.'], altChance: 0.6 });
    return parseBassPattern(pattern, g, { velocity: 0.82 });
  },
  drums(g) {
    const pattern = g.phraseChoice('drums', () => g.rng.weighted([
      [{ kick: 'x.......o.......', snare: '........x.......', hat: '..o...o...o...o?' }, 3],
      [{ kick: 'x.........o.....', snare: '........x.......', sweep: '....x...........', hat: '..o...o...o...?.' }, 2],
      [{ kick: 'x.......o.......', snare: '........x......o', hat: '..o.?.o...o.?.o.' }, 1],
    ]));
    const events = parseDrumPattern(pattern, g);
    if (g.isPhraseEnd && g.rng.chance(0.5)) events.push({ kind: 'sweep', step: 12, vel: 0.6 });
    return events;
  },
  keys(g) {
    const events = sparseBells(g, { probability: 0.6 });
    if (g.barInPhrase === 0 && g.rng.chance(0.5)) events.push(...waveMotif(g, { start: 8, lift: 12 }));
    return events;
  },
};

// ---------------------------------------------------------------------------
// Experience: A dorian funk, 96 bpm. The "bass years": 16th-note ghosts,
// octave pops and slides. A: Am9 | D9 (i-IV vamp), B: Fmaj9 | Em7 | Dm9 | E7#9.
// ---------------------------------------------------------------------------
const A_AEOLIAN = pcs(9, 'aeolian');
const A_HARMONIC = [9, 11, 0, 2, 4, 5, 8];

const FUNK_BASS = [
  ['R.xR--OxR.7x5.Ox', 3],
  ['R..x-R-xO-5-7.5A', 3],
  ['R.-xR.-x--O.5.7.', 2],
  ['R-xRx-O-R-x5-7OA', 2],
  ['R..xR.xO-xR.5~O.', 2],
  ['R.x.O.xRx.7.5xOA', 1.5],
];

const experience = {
  id: 'experience',
  bpm: 96,
  swing16: 0.07,
  tonic: 33,
  mode: 'dorian',
  scale: pcs(9, 'dorian'),
  tomMidi: 45,
  gain: 1.08,
  levels: { bass: 1.12, pad: 0.52, keys: 0.79, perc: 0.85 },
  sends: { bass: 0.06, pad: 0.4, keys: 0.35, perc: 0.1 },
  delay: { beats: 0.75, feedback: 0.25, send: 0.12 },
  padStyle: { attack: 0.6, release: 1.0, cutoff: 1100, detune: 7, width: 0.4, level: 0.12 },
  bassStyle: { level: 0.52, gate: 0.82, decay: 0.38, brightness: 1.08, sub: 0.45 },
  drumStyle: { kick: { from: 140, to: 48, decay: 0.09 }, snare: { decay: 0.085 }, hatLevel: 0.06 },
  chords: {
    Am9: chord('Am9', 33, 'm7', [60, 64, 67, 71]),
    D9: chord('D9', 38, 'dom', [60, 64, 66, 69]),
    Fmaj9: chord('Fmaj9', 41, 'maj7', [57, 60, 64, 67], { scale: A_AEOLIAN }),
    Em7: chord('Em7', 40, 'aeolian', [59, 62, 64, 67]),
    Dm9: chord('Dm9', 38, 'm7', [53, 57, 60, 64], { scale: A_AEOLIAN }),
    E7s9: chord('E7#9', 40, 'dom', [56, 62, 67], { scale: A_HARMONIC }),
  },
  sections: {
    A: [['Am9'], ['D9'], ['Am9'], ['D9']],
    B: [['Fmaj9'], ['Em7'], ['Dm9'], ['E7s9']],
  },
  forms: [['A', 'A', 'B', 'A'], ['A', 'B', 'A', 'B'], ['A', 'A', 'A', 'B']],
  bass(g) {
    const pattern = phraseGroove(g, FUNK_BASS, { fills: ['R.xR5.7.O.7.5.3A', 'R.xRO.xO7.O.5x3A'], fillChance: 0.6, altChance: 0.4 });
    return parseBassPattern(embellish(pattern, g.rng, { ghosts: 0.12, drops: 0.06 }), g);
  },
  drums(g) {
    // Snare and hats hold a pattern per phrase; the kick locks to the bass line.
    const pattern = g.phraseChoice('drums', () => g.rng.weighted([
      [{ snare: '....X..o....X..o', hat: 'xoxoxoxoxoxoxOxo' }, 3],
      [{ snare: '....X.o.....X...', hat: 'x.xox.xox.xox.xO' }, 2],
      [{ snare: '....X.......X.o.', hat: 'xoxoxoxoxoxoxoxo' }, 2],
    ]));
    const events = [...parseDrumPattern(pattern, g), ...lockedKick(g, { extra: 3 })];
    if (g.isPhraseEnd && g.rng.chance(0.5)) [13, 14, 15].forEach((step) => events.push({ kind: 'snare', step, vel: 0.3 + 0.1 * (step - 13) }));
    return events;
  },
  keys(g) {
    const rhythm = g.phraseChoice('comp', () => g.rng.weighted([['..x...x....x..x.', 3], ['...x..x...x..x..', 2], ['..x.x.....x...x.', 2], ['......x.......x.', 1]]));
    const events = comp(g, rhythm, { len: 1, vel: 0.5 });
    if (g.isPhraseEnd && g.rng.chance(0.5)) {
      const top = [...g.chordAt(8).pad].sort((a, b) => a - b).slice(-3);
      const lift = top[top.length - 1] < 70 ? 24 : 12;
      top.forEach((midi, i) => events.push({ kind: 'keys', preset: 'bell', step: 8 + i * 2, midi: midi + lift, vel: 0.45, pan: 0.3 }));
    }
    return events;
  },
};

/**
 * Arpeggiator over the current chord's `arp` tones (or its pad an octave up).
 * Modes: up, down, updown, random. Pans ping-pong and accents the beats.
 */
function arpeggio(g, { mode = 'up', rate = 8, preset = 'glass', lift = 0, rest = 0.12 }) {
  const events = [];
  const stride = rate === 16 ? 1 : 2;
  let index = 0;
  for (let step = 0; step < 16; step += stride, index++) {
    if (step % 4 !== 0 && g.rng.chance(rest)) continue;
    const chordDef = g.chordAt(step);
    const notes = (chordDef.arp || chordDef.pad.map((note) => note + 12)).map((note) => note + lift);
    const n = notes.length;
    let midi;
    if (mode === 'down') midi = notes[n - 1 - (index % n)];
    else if (mode === 'updown') {
      const period = Math.max(1, 2 * (n - 1));
      const k = index % period;
      midi = notes[k < n ? k : period - k];
    } else if (mode === 'random') midi = g.rng.pick(notes);
    else midi = notes[index % n];
    events.push({ kind: 'keys', preset, step, midi, vel: step % 4 === 0 ? 0.62 : 0.46, pan: (index % 2 ? 0.55 : -0.55), delay: true });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Projects: E lydian, 100 bpm. Glassy arpeggios, curious staccato bass on an
// E pedal. A: Emaj9 | F#/E (the lydian II over I), B: C#m9 | Bmaj7 | G#m7 | F#6.
// ---------------------------------------------------------------------------
const projects = {
  id: 'projects',
  bpm: 100,
  tonic: 40,
  mode: 'lydian',
  scale: pcs(4, 'lydian'),
  tomMidi: 47,
  gain: 1.04,
  levels: { bass: 1, pad: 0.73, keys: 0.94, perc: 0.69 },
  sends: { bass: 0.08, pad: 0.5, keys: 0.45, perc: 0.12 },
  delay: { beats: 0.75, feedback: 0.36, send: 0.3 },
  padStyle: { attack: 1.0, release: 1.6, cutoff: 2000, detune: 9, width: 0.6, level: 0.12 },
  bassStyle: { level: 0.5, gate: 0.55, decay: 0.3, brightness: 1.05, sub: 0.5 },
  drumStyle: { kick: { from: 130, to: 50, decay: 0.08 }, snare: { decay: 0.07 }, hatLevel: 0.055 },
  chords: {
    Emaj9: chord('Emaj9', 40, 'lydian', [59, 63, 66, 68], { arp: [64, 68, 71, 75, 78] }),
    FsE: chord('F#/E', 40, 'pedal', [58, 61, 66, 70], { arp: [66, 70, 73, 76, 78] }),
    Csm9: chord('C#m9', 37, 'm7', [52, 56, 59, 63], { arp: [61, 64, 68, 71, 75] }),
    Bmaj7: chord('Bmaj7(6)', 35, 'maj7', [54, 58, 63, 68], { arp: [63, 66, 70, 71, 75] }),
    Gsm7: chord('G#m7', 32, 'aeolian', [54, 59, 63, 68], { arp: [63, 66, 68, 71, 75] }),
    Fs6: chord('F#6', 30, 'six', [58, 61, 63, 66], { arp: [66, 70, 73, 75, 78] }),
  },
  sections: {
    A: [['Emaj9'], ['FsE'], ['Emaj9'], ['FsE']],
    B: [['Csm9'], ['Bmaj7'], ['Gsm7'], ['Fs6']],
  },
  forms: [['A', 'A', 'B', 'A'], ['A', 'B', 'A', 'B']],
  bass(g) {
    const patterns = g.sectionName === 'B'
      ? [['R.R.5.R.7.5.A...', 2], ['R.R.5.R.O.R.5.6.', 1], ['R.-R5.-RO.-R6.5.', 1]]
      : [['R.R.5.R.O.R.5.6.', 3], ['R.R.R.5.R.R.O.5.', 2], ['R.-R5.-RO.-R6.5.', 2], ['R.O.R.5.R.O.9.O.', 1.5]];
    return parseBassPattern(phraseGroove(g, patterns, { fills: ['R.5.O.9.O.5.6.A.'], fillChance: 0.5 }), g, { velocity: 0.9 });
  },
  drums(g) {
    const pattern = g.phraseChoice('drums', () => g.rng.weighted([
      [{ snare: '....x.......x...', hat: 'x.o.x.o.x.o.x.oo' }, 3],
      [{ snare: '....x.......x..o', hat: 'x.x.x.x.x.x.x.x.' }, 2],
    ]));
    return [...parseDrumPattern(pattern, g), ...lockedKick(g, { extra: 2, chance: 0.5 })];
  },
  keys(g) {
    const mode = g.phraseChoice('arp', () => g.rng.weighted([['up', 3], ['updown', 3], ['down', 1.5], ['random', 1]]));
    const rate = g.phraseChoice('rate', () => (g.sectionName === 'B' || g.rng.chance(0.25) ? 16 : 8));
    const events = arpeggio(g, { mode, rate, lift: g.phraseIndex % 3 === 2 ? 12 : 0 });
    if (g.barInPhrase % 2 === 1 && g.rng.chance(0.4)) {
      events.push({ kind: 'keys', preset: 'bell', step: 12, midi: g.rng.pick(g.chordAt(12).pad) + 24, vel: 0.4, pan: 0 });
    }
    return events;
  },
};

// ---------------------------------------------------------------------------
// Mission: C, 72 bpm. Wide and epic. A: a C pedal under Cadd9 | F/C | G/C;
// B: the bass rises C-D-E-F-G-A-Bb-C in half-bar chords with bells in tenths
// above it; C: Am9 | Fmaj7#11 | C/G | Gsus4 G.
// ---------------------------------------------------------------------------
const C_MIXOLYDIAN = pcs(0, 'mixolydian');

const mission = {
  id: 'mission',
  bpm: 72,
  tonic: 36,
  mode: 'ionian',
  scale: pcs(0, 'ionian'),
  tomMidi: 41,
  gain: 0.9,
  levels: { bass: 1, pad: 1.4, keys: 0.9, perc: 0.84 },
  sends: { bass: 0.14, pad: 0.6, keys: 0.65, perc: 0.22 },
  delay: { beats: 1, feedback: 0.3, send: 0.18 },
  padStyle: { attack: 2.4, release: 3.2, cutoff: 1700, detune: 11, width: 0.75, level: 0.15, lfoRate: 0.06 },
  bassStyle: { level: 0.48, gate: 0.98, decay: 1.4, brightness: 0.78, sub: 0.75, sustain: 0.5, attack: 0.02, release: 0.25 },
  drumStyle: { kick: { from: 100, to: 38, decay: 0.22 }, snare: { decay: 0.16 }, hatLevel: 0.04 },
  chords: {
    Cadd9: chord('Cadd9', 36, 'maj7', [48, 55, 62, 64, 67]),
    FC: chord('F/C', 36, 'pedal', [48, 53, 60, 65, 69]),
    GC: chord('G/C', 36, 'pedal', [48, 55, 59, 62, 67]),
    C: chord('C', 36, 'maj7', [55, 60, 64, 67], { mel: 76 }),
    Dm7: chord('Dm7', 38, 'm7', [57, 60, 65, 69], { mel: 77 }),
    CE: chord('C/E', 40, 'firstInversion', [55, 60, 64, 67], { mel: 79 }),
    Fmaj7: chord('Fmaj7', 41, 'lydian', [57, 60, 64, 69], { mel: 81 }),
    G: chord('G', 43, 'dom', [59, 62, 67, 71], { mel: 83 }),
    Am7: chord('Am7', 45, 'aeolian', [60, 64, 67, 72], { mel: 84 }),
    Bb: chord('Bbmaj9', 46, 'maj7', [60, 62, 65, 69], { mel: 86, scale: C_MIXOLYDIAN }),
    Chigh: chord('C', 48, 'maj7', [64, 67, 72, 76], { mel: 88 }),
    Am9: chord('Am9', 33, 'aeolian', [60, 64, 67, 71]),
    Fmaj7s11: chord('Fmaj7#11', 29, 'lydian', [57, 60, 64, 71]),
    CG: chord('C/G', 31, { 3: 5, 5: 9, 7: 12, 6: 9, 9: 14 }, [60, 64, 67, 72]),
    Gsus: chord('Gsus4', 31, 'sus', [60, 62, 67, 72]),
    G7: chord('G', 31, 'dom', [59, 62, 67, 71]),
  },
  sections: {
    A: [['Cadd9'], ['FC'], ['GC'], ['Cadd9']],
    B: [['C', 'Dm7'], ['CE', 'Fmaj7'], ['G', 'Am7'], ['Bb', 'Chigh']],
    C: [['Am9'], ['Fmaj7s11'], ['CG'], ['Gsus', 'G7']],
  },
  forms: [['A', 'B', 'C', 'A'], ['A', 'A', 'B', 'C'], ['A', 'C', 'B', 'A']],
  bass(g) {
    if (g.sectionName === 'A') {
      if (g.isPhraseEnd) return parseBassPattern('R.......5.6.7.O.', g, { velocity: 0.85 });
      return parseBassPattern(phraseGroove(g, [['R...............', 3], ['R.......R...5...', 2]]), g, { velocity: 0.85 });
    }
    if (g.sectionName === 'B') {
      return parseBassPattern(phraseGroove(g, [['R.......R.......', 2], ['R.....~.R.......', 3], ['R...5...R.....A.', 1.5], ['R.....~.R...5...', 1.5]], { altChance: 0.6 }), g, { velocity: 0.9 });
    }
    return parseBassPattern(phraseGroove(g, [['R...............', 2], ['R.......5...O...', 2], ['R...........A...', 1.5]], { altChance: 0.6 }), g, { velocity: 0.88 });
  },
  drums(g) {
    const pattern = g.phraseChoice('drums', () => g.rng.weighted([
      [{ kick: 'X.......o.......', snare: '........x.......', hat: 'o...o...o...o...' }, 3],
      [{ kick: 'X...............', sweep: '....x.......x...', hat: '....o.......o...' }, 2],
    ]));
    const events = parseDrumPattern(pattern, g);
    if (g.isPhraseEnd && g.rng.chance(0.7)) {
      [12, 13, 14, 15].forEach((step, i) => events.push({ kind: 'tom', step, midi: 50 - i * 3, vel: 0.45 + i * 0.12 }));
    }
    return events;
  },
  keys(g) {
    if (g.sectionName === 'B') {
      return g.segments.map((segment, i) => ({
        kind: 'keys', preset: 'bell', step: segment.startStep, midi: segment.chord.mel, vel: 0.5 + g.barInPhrase * 0.05 + i * 0.03, pan: -0.3 + i * 0.6,
      }));
    }
    const events = sparseBells(g, { probability: 0.55, preset: 'deepBell', lift: 12, steps: [0, 8] });
    if (g.rng.chance(0.3)) events.push(...sparseBells(g, { probability: 1, preset: 'bell', lift: 24, steps: [6, 12] }));
    return events;
  },
};

// ---------------------------------------------------------------------------
// Contact: G mixolydian, 90 bpm, swung. Warm and friendly (golden hour).
// A: G6/9 | F6/9 | C/E | D9sus4 (bass walks down G-F-E-D, quartal voicings
// planing down a step), B: Em7 | Am7 | Cmaj7 | D9sus4.
// ---------------------------------------------------------------------------
const G_PENTATONIC_HIGH = [74, 76, 79, 81, 83, 86, 88];

const contact = {
  id: 'contact',
  bpm: 90,
  swing8: 0.13,
  tonic: 43,
  mode: 'mixolydian',
  scale: pcs(7, 'mixolydian'),
  tomMidi: 43,
  gain: 1,
  levels: { bass: 1.05, pad: 0.71, keys: 1.23, perc: 0.92 },
  sends: { bass: 0.08, pad: 0.5, keys: 0.4, perc: 0.14 },
  delay: { beats: 0.5, feedback: 0.22, send: 0.12 },
  padStyle: { attack: 1.2, release: 1.8, cutoff: 1500, detune: 7, width: 0.5, level: 0.12 },
  bassStyle: { level: 0.5, gate: 0.85, decay: 0.55, brightness: 0.95, sub: 0.55 },
  drumStyle: { kick: { from: 125, to: 47, decay: 0.1 }, snare: { decay: 0.12 }, hatLevel: 0.05 },
  chords: {
    G69: chord('G6/9', 43, 'dom', [59, 64, 69, 74]),
    F69: chord('F6/9', 41, 'lydian', [57, 62, 67, 72]),
    CE: chord('C/E', 40, 'firstInversion', [55, 60, 64, 67]),
    D9sus: chord('D9sus4', 38, 'sus', [57, 60, 64, 67]),
    Em7: chord('Em7', 40, 'aeolian', [55, 62, 64, 71]),
    Am7: chord('Am7', 33, 'aeolian', [55, 60, 64, 69]),
    Cmaj7: chord('Cmaj7', 36, 'maj7', [55, 59, 64, 67]),
  },
  sections: {
    A: [['G69'], ['F69'], ['CE'], ['D9sus']],
    B: [['Em7'], ['Am7'], ['Cmaj7'], ['D9sus']],
  },
  forms: [['A', 'A', 'B', 'A'], ['A', 'B', 'A', 'B']],
  bass(g) {
    const pattern = phraseGroove(g, [
      ['R....xR.5...6.A.', 3],
      ['R...R.5.O...5.A.', 2.5],
      ['R..xR...5.3.5.A.', 2],
      ['R.....5.R...7.6.', 1.5],
      ['R...5~O.....5.A.', 2],
    ], { fills: ['R.5.O.7.6.5.3.A.'], fillChance: 0.5, altChance: 0.5 });
    return parseBassPattern(pattern, g, { velocity: 0.9 });
  },
  drums(g) {
    const pattern = g.phraseChoice('drums', () => g.rng.weighted([
      [{ snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' }, 3],
      [{ snare: '....x.......x..o', hat: 'x.x.x.x.x.x.x.xO' }, 2],
      [{ snare: '....x.......x...', hat: 'x.o.x.o.x.o.x.o.' }, 2],
    ]));
    return [...parseDrumPattern(pattern, g), ...lockedKick(g, { extra: 2, chance: 0.6 })];
  },
  keys(g) {
    const rhythm = g.phraseChoice('comp', () => g.rng.weighted([['X.....x.........', 3], ['X.......x..x....', 2], ['X.....x.....x...', 2]]));
    const events = comp(g, rhythm, { len: 2, longLen: 6, vel: 0.42 });
    if (g.barInPhrase % 2 === 1 && g.rng.chance(0.55)) {
      let index = g.rng.int(1, G_PENTATONIC_HIGH.length - 2);
      const count = g.rng.int(3, 4);
      for (let i = 0; i < count; i++) {
        events.push({ kind: 'keys', preset: 'mallet', step: 8 + i * 2, midi: G_PENTATONIC_HIGH[index], vel: 0.55 - i * 0.05, pan: 0.35 });
        index = Math.max(0, Math.min(G_PENTATONIC_HIGH.length - 1, index + g.rng.pick([-1, 1, 1])));
      }
    }
    return events;
  },
};

// ---------------------------------------------------------------------------
// Deep space (world = null): an ambient drone. A D pedal under slowly
// changing colours (Dsus2, Bbmaj7/D, C/D), sparse bells, no drums.
// ---------------------------------------------------------------------------
const SPACE_BELLS = [74, 76, 79, 81, 84, 86, 88];

const space = {
  id: 'space',
  bpm: 60,
  tonic: 38,
  mode: 'aeolian',
  scale: pcs(2, 'aeolian'),
  tomMidi: 45,
  noDrums: true,
  gain: 0.83,
  levels: { bass: 0.9, pad: 1.08, keys: 1.27, perc: 0 },
  sends: { bass: 0.2, pad: 0.7, keys: 0.75, perc: 0 },
  delay: { beats: 1.5, feedback: 0.45, send: 0.35 },
  padStyle: { attack: 3.2, release: 4.5, cutoff: 900, detune: 8, width: 0.8, level: 0.16, lfoRate: 0.05, lfoDepth: 320 },
  bassStyle: { level: 0.42, gate: 1, decay: 3, brightness: 0.55, sub: 0.85, sustain: 0.75, attack: 0.9, release: 2 },
  drumStyle: { kick: { from: 110, to: 42, decay: 0.12 }, snare: { decay: 0.12 }, hatLevel: 0.04 },
  chords: {
    Dsus2: chord('Dsus2', 38, 'pedal', [50, 57, 62, 64]),
    BbD: chord('Bbmaj7/D', 38, 'pedal', [53, 58, 62, 69]),
    CD: chord('C/D', 38, 'pedal', [52, 55, 60, 67]),
  },
  sections: {
    A: [['Dsus2'], ['Dsus2'], ['BbD'], ['BbD']],
    B: [['Dsus2'], ['Dsus2'], ['CD'], ['CD']],
  },
  forms: [['A', 'B']],
  bass(g) {
    if (g.barInPhrase % 2 !== 0) return [];
    if (g.rng.chance(0.3)) {
      // A slow glide up from the fifth below into the pedal.
      return [{ kind: 'bass', step: 0, len: 32, midi: 33, vel: 0.7, slideTo: 38, slideStep: 2, slideSteps: 6 }];
    }
    return [{ kind: 'bass', step: 0, len: 32, midi: 38, vel: 0.7 }];
  },
  drums() {
    return [];
  },
  keys(g) {
    if (!g.rng.chance(0.45)) return [];
    const events = [{ kind: 'keys', preset: 'spaceBell', step: g.rng.pick([0, 4, 8, 10]), midi: g.rng.pick(SPACE_BELLS), vel: g.rng.range(0.4, 0.65), pan: g.rng.range(-0.8, 0.8), delay: true }];
    if (g.rng.chance(0.3)) events.push({ ...events[0], step: Math.min(15, events[0].step + 6), midi: g.rng.pick(SPACE_BELLS), vel: 0.4, pan: -events[0].pan });
    return events;
  },
};

FM_PRESETS.spaceBell = { ratio: 3.5, index: 0.8, decay: 5, level: 0.45 };

/** All themes by id; `space` plays when the world is null. */
export const THEMES = Object.freeze({ philosophy, experience, projects, mission, contact, space });

/** Maps a scene world (or null) to a theme id. */
export function themeIdForWorld(world) {
  return world && Object.prototype.hasOwnProperty.call(THEMES, world) && world !== 'space' ? world : 'space';
}

/** Combat events for a bar of the given theme. */
export function combatEvents(theme, g) {
  return combatPattern(g, { tomMidi: theme.tomMidi });
}
