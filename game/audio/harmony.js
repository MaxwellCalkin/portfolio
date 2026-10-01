// Harmony and pattern helpers for the generative music: chord definitions,
// scale-aware passing tones, and parsers that turn compact 16-step pattern
// strings into note events. Pure data in, pure data out (no Web Audio).

import { MODES } from './util.js';

export const STEPS_PER_BAR = 16;
export const BASS_LOW = 28; // E1
export const BASS_HIGH = 59; // B3

/** Interval sets (semitones above the bass note) used by bass lines. */
const QUALITIES = {
  maj7: { 3: 4, 5: 7, 7: 11, 6: 9, 9: 14 },
  m7: { 3: 3, 5: 7, 7: 10, 6: 9, 9: 14 },
  aeolian: { 3: 3, 5: 7, 7: 10, 6: 8, 9: 14 },
  dom: { 3: 4, 5: 7, 7: 10, 6: 9, 9: 14 },
  sus: { 3: 5, 5: 7, 7: 10, 6: 9, 9: 14 },
  six: { 3: 4, 5: 7, 7: 9, 6: 9, 9: 14 },
  lydian: { 3: 4, 5: 7, 7: 11, 6: 6, 9: 14 },
  // Pedal and slash chords: keep the bass on safe tones (root, fifth, octave).
  pedal: { 3: 7, 5: 7, 7: 12, 6: 14, 9: 14 },
  firstInversion: { 3: 3, 5: 8, 7: 12, 6: 5, 9: 15 },
};

/**
 * Defines a chord.
 * @param {string} name display name
 * @param {number} bass MIDI bass note (the slash note for inversions)
 * @param {string|object} quality interval set name or explicit {3,5,7,6,9}
 * @param {number[]} pad MIDI pad voicing
 * @param {object} [extra] e.g. { scale: [pitch classes], arp: [MIDI] }
 */
export function chord(name, bass, quality, pad, extra = {}) {
  const tones = typeof quality === 'string' ? QUALITIES[quality] : quality;
  return Object.freeze({ name, bass, tones, pad, ...extra });
}

/** Absolute pitch classes for a tonic and mode. */
export function modePitchClasses(tonic, mode) {
  return MODES[mode].map((offset) => (tonic + offset) % 12);
}

/** Keeps a bass note inside the instrument's comfortable range. */
export function foldBass(midi, low = BASS_LOW, high = BASS_HIGH) {
  let note = midi;
  while (note > high) note -= 12;
  while (note < low) note += 12;
  return note;
}

/** Chord tone by symbol: R, O (octave), 3, 5, 7, 6, 9, L (fifth below). */
export function chordTone(chordDef, symbol) {
  const { bass, tones } = chordDef;
  switch (symbol) {
    case 'R': return bass;
    case 'O': return bass + 12;
    case 'L': return bass + tones[5] - 12;
    case '3': case '5': case '7': case '6': case '9': return bass + tones[symbol];
    default: return bass;
  }
}

/** Moves `delta` scale steps from `midi` (midi need not be in the scale). */
export function scaleStep(midi, delta, pitchClasses) {
  let note = midi;
  let remaining = Math.abs(delta);
  const direction = Math.sign(delta);
  let guard = 0;
  while (remaining > 0 && guard++ < 48) {
    note += direction;
    if (pitchClasses.includes(((note % 12) + 12) % 12)) remaining -= 1;
  }
  return note;
}

/** Nearest scale tone at or below `midi`. */
export function snapToScale(midi, pitchClasses) {
  let note = Math.round(midi);
  for (let i = 0; i < 12; i++) {
    if (pitchClasses.includes(((note % 12) + 12) % 12)) return note;
    note -= 1;
  }
  return Math.round(midi);
}

/** Moves a note that is outside the scale one semitone (down first) into it. */
export function diatonic(midi, pitchClasses) {
  const inScale = (note) => pitchClasses.includes(((note % 12) + 12) % 12);
  if (inScale(midi)) return midi;
  if (inScale(midi - 1)) return midi - 1;
  if (inScale(midi + 1)) return midi + 1;
  return midi;
}

/** A leading note into `target`: chromatic or diatonic, from above or below. */
export function approachNote(target, rng, pitchClasses) {
  const kind = rng.weighted([['chromaticBelow', 4], ['chromaticAbove', 1.5], ['scaleBelow', 2.5], ['scaleAbove', 1.5]]);
  if (kind === 'chromaticBelow') return target - 1;
  if (kind === 'chromaticAbove') return target + 1;
  if (kind === 'scaleBelow') return scaleStep(target, -1, pitchClasses);
  return scaleStep(target, 1, pitchClasses);
}

/** Velocity by metric position, with a little human variation. */
export function accent(step, rng, base = 1) {
  const position = step % 4 === 0 ? 0.9 : step % 2 === 0 ? 0.76 : 0.64;
  return Math.min(1, base * position * (1 + (rng.next() * 2 - 1) * 0.07));
}

/**
 * Parses a 16-step bass pattern into note events.
 *
 * Symbols: R O 3 5 7 6 9 L (chord tones), A (approach the next chord's root),
 * W (scale step toward the next root), x (ghost note), . (hold), - (rest),
 * ~ (glide: the previous note slides into the following note without a new pluck).
 *
 * @param {string} pattern 16 characters (spaces are ignored)
 * @param {object} g generator context: { rng, chordAt(step), chordAfter(step), pitchClasses(step) }
 * @param {{ velocity?: number }} [options]
 */
export function parseBassPattern(pattern, g, { velocity = 1 } = {}) {
  const symbols = pattern.replace(/\s+/g, '');
  const events = [];
  let last = null; // the sounding note that '.' extends
  let lastPitch = null; // pitch a ghost note mutes
  let glideNext = false;
  for (let step = 0; step < Math.min(STEPS_PER_BAR, symbols.length); step++) {
    const symbol = symbols[step];
    if (symbol === '.') {
      if (last) last.len += 1;
      continue;
    }
    if (symbol === '-') {
      last = null;
      glideNext = false;
      continue;
    }
    if (symbol === '~') {
      glideNext = Boolean(last);
      if (last) last.len += 1;
      continue;
    }
    const current = g.chordAt(step);
    const pcs = g.pitchClasses(step);
    let midi;
    let ghost = false;
    if (symbol === 'x') {
      midi = lastPitch ?? current.bass;
      ghost = true;
    } else if (symbol === 'A') {
      midi = approachNote(foldBass(g.chordAfter(step).bass), g.rng, pcs);
    } else if (symbol === 'W') {
      const from = lastPitch ?? current.bass;
      const target = foldBass(g.chordAfter(step).bass);
      midi = from === target ? scaleStep(from, g.rng.chance(0.5) ? 1 : -1, pcs) : scaleStep(from, Math.sign(target - from), pcs);
    } else {
      // Colour tones (e.g. the 9th over a phrygian chord) are kept in the key.
      midi = diatonic(chordTone(current, symbol), pcs);
    }
    midi = foldBass(midi);
    if (glideNext && last && !ghost) {
      last.slideTo = midi;
      last.slideStep = step - 1;
      last.slideSteps = 1;
      last.len += 1;
      lastPitch = midi;
      glideNext = false;
      continue;
    }
    glideNext = false;
    const event = {
      kind: 'bass',
      step,
      len: 1,
      midi,
      vel: (ghost ? 0.5 : accent(step, g.rng)) * velocity * (symbol === 'O' ? 1.08 : 1),
      ghost,
      pop: symbol === 'O',
    };
    events.push(event);
    lastPitch = midi;
    last = ghost ? null : event;
  }
  return events;
}

/**
 * Parses drum patterns: { kick, snare, hat, ... } strings of 16 steps.
 * X accent, x normal, o ghost, O open hat, ? 45% chance soft hit, . nothing.
 */
export function parseDrumPattern(patterns, g, kinds = {}) {
  const events = [];
  for (const [name, raw] of Object.entries(patterns)) {
    const symbols = raw.replace(/\s+/g, '');
    for (let step = 0; step < Math.min(STEPS_PER_BAR, symbols.length); step++) {
      const symbol = symbols[step];
      if (symbol === '.') continue;
      if (symbol === '?' && !g.rng.chance(0.45)) continue;
      const vel = { X: 0.95, x: 0.68, o: 0.34, O: 0.6, '?': 0.32 }[symbol] ?? 0.6;
      events.push({ kind: kinds[name] || name, step, vel: vel * (1 + (g.rng.next() * 2 - 1) * 0.08), open: symbol === 'O' });
    }
  }
  return events;
}

/**
 * Kick drum locked to the bass line: always on the downbeat, then under some
 * of the bass's sounding notes (mostly on 8th-note positions), avoiding the
 * backbeat steps the snare owns.
 */
export function lockedKick(g, { extra = 3, avoid = [4, 12], chance = 0.65, velocity = 0.78 } = {}) {
  const events = [{ kind: 'kick', step: 0, vel: 0.95 }];
  let added = 0;
  for (const note of g.bassEvents || []) {
    if (added >= extra) break;
    if (note.ghost || note.step === 0 || avoid.includes(note.step)) continue;
    if (!g.rng.chance(note.step % 2 === 0 ? chance : chance * 0.4)) continue;
    events.push({ kind: 'kick', step: note.step, vel: velocity * (note.step % 4 === 0 ? 1 : 0.85) });
    added += 1;
  }
  return events;
}

/** Applies random ghost-note embellishment to a bass pattern string. */
export function embellish(pattern, rng, { ghosts = 0.2, drops = 0.05 } = {}) {
  const chars = pattern.replace(/\s+/g, '').split('');
  for (let i = 1; i < chars.length; i++) {
    if (chars[i] === '-' && rng.chance(ghosts)) chars[i] = 'x';
    else if (chars[i] === 'x' && rng.chance(drops)) chars[i] = '-';
  }
  return chars.join('');
}

/**
 * Generic combat layer: a driving, palm-muted 8th-note bass on the current
 * root with tom pulses. Each event carries `min`, the combat intensity at which
 * it starts to play, so the layer thickens as intensity rises.
 */
export function combatPattern(g, { tomMidi }) {
  const events = [];
  for (let step = 0; step < STEPS_PER_BAR; step += 2) {
    const current = g.chordAt(step);
    const root = foldBass(current.bass, BASS_LOW, 45);
    const octave = step % 8 === 6 && g.rng.chance(0.5);
    events.push({ kind: 'combatBass', step, len: 1.6, midi: octave ? root + 12 : root, vel: step % 4 === 0 ? 0.95 : 0.72, min: octave ? 0.5 : 0.04 });
  }
  for (let beat = 0; beat < 4; beat++) {
    events.push({ kind: 'tom', step: beat * 4, midi: tomMidi + (beat === 3 ? 3 : 0), vel: beat % 2 === 0 ? 0.9 : 0.62, min: beat % 2 === 0 ? 0.04 : 0.3 });
    events.push({ kind: 'combatKick', step: beat * 4, vel: 0.8, min: 0.6 });
  }
  for (let step = 1; step < STEPS_PER_BAR; step += 2) events.push({ kind: 'combatHat', step, vel: 0.45, min: 0.45 });
  if (g.isPhraseEnd) {
    [12, 13, 14, 15].forEach((step, i) => events.push({ kind: 'tom', step, midi: tomMidi + 7 - i * 2, vel: 0.6 + i * 0.1, min: 0.72 }));
  }
  return events;
}
