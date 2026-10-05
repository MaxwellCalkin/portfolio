import { CONTENT, PROJECTS, ESSAYS } from '../content.js';
import { levelOf, nextCost } from '../space/pedals.js';

/**
 * Discoveries: the portfolio, scattered across the worlds as places.
 * Every snippet is quoted verbatim from content.js (the site's existing copy);
 * the main archive on each world opens that chapter's full panel.
 *
 * Keys: `${landmarkId}` or `${landmarkId}#${poi}` (for landmarks with several
 * interaction points). Landmark ids come from game/world/layout.js.
 */
const project = name => PROJECTS.find(p => p.name === name);
const essay = i => ESSAYS[i];

export const DISCOVERIES = [
  // 01 PHILOSOPHY / THE ORIGIN
  { id: 'philosophy:origin', world: 'philosophy', landmark: 'origin', poi: 'POI_archive', kind: 'archive', title: 'The Origin', eyebrow: '01 / THE ORIGIN', text: 'I will live to participate in the unfolding of a better world.', panel: 'philosophy' },
  { id: 'philosophy:health', world: 'philosophy', landmark: 'health', kind: 'memory', title: 'Health', eyebrow: 'I / THE FOUNDATION', text: 'Sleep, strength, movement, nourishment, and emotional steadiness. My body is an instrument of service.' },
  { id: 'philosophy:family', world: 'philosophy', landmark: 'family', kind: 'memory', title: 'Family', eyebrow: 'II / THE CENTER', text: 'A loving home and a present father. No outer victory compensates for inner betrayal at home.' },
  { id: 'philosophy:mission', world: 'philosophy', landmark: 'mission', kind: 'memory', title: 'Mission', eyebrow: 'III / THE FIRE', text: 'Hard, meaningful work worthy of my gifts, directed toward what is genuinely good.' },
  { id: 'philosophy:depth-span', world: 'philosophy', landmark: 'depth-span', kind: 'memory', title: 'Depth × span', eyebrow: 'A LENS FOR CHOOSING', text: 'Depth is interior richness, integration, and wisdom. Span is reach, inclusion, capability, and care. The aim is to grow both, without sacrificing either.' },
  { id: 'philosophy:filter', world: 'philosophy', landmark: 'filter', kind: 'memory', title: 'The decision filter', eyebrow: 'FIVE QUESTIONS', list: ['Does this protect health?', 'Does this strengthen family?', 'Does this serve the mission?', 'Is it true, courageous, and beautiful?', 'Does it propagate genuine goodness outward?'] },
  { id: 'philosophy:essay-0', world: 'philosophy', landmark: 'library', poi: 'POI_essay_0', kind: 'essay', title: essay(0).title, eyebrow: 'READ THE THINKING', text: essay(0).description, link: essay(0).url },
  { id: 'philosophy:essay-1', world: 'philosophy', landmark: 'library', poi: 'POI_essay_1', kind: 'essay', title: essay(1).title, eyebrow: 'READ THE THINKING', text: essay(1).description, link: essay(1).url },
  { id: 'philosophy:essay-2', world: 'philosophy', landmark: 'library', poi: 'POI_essay_2', kind: 'essay', title: essay(2).title, eyebrow: 'READ THE THINKING', text: essay(2).description, link: essay(2).url },

  // 02 EXPERIENCE / THE ARC
  { id: 'experience:arc', world: 'experience', landmark: 'arc', poi: 'POI_archive', kind: 'archive', title: 'The Arc', eyebrow: '02 / THE ARC', text: 'Each chapter trained something the next one needed.', panel: 'experience' },
  { id: 'experience:bass', world: 'experience', landmark: 'bass', poi: 'POI_read', kind: 'memory', title: 'The bass years', eyebrow: '01 / 2015–2020', text: 'Touring bassist. Radio City Music Hall, Broadway pits, orchestras, and recording studios. Music taught me what mastery feels like in the body.', hint: 'Step on the stage pads to play.' },
  { id: 'experience:arena', world: 'experience', landmark: 'arena', poi: 'POI_arena', kind: 'memory', title: 'A harder game', eyebrow: '02 / THE ARENA YEARS', text: 'Competitive League of Legends, Valorant, and Fortnite. High ranks, hard-contested games, and a lesson that lasted: stimulation is not the same as aliveness. I needed to contribute.', challenge: 'arena' },
  { id: 'experience:build', world: 'experience', landmark: 'build', kind: 'memory', title: 'Work that compounds', eyebrow: '03 / THE BUILD YEARS', text: 'Software engineering at Interactive Aptitude, a DoD contractor funded by SBIR grants. Building real systems while moving toward work in AI safety and a future research lab.' },
  { id: 'experience:tools', world: 'experience', landmark: 'tools', kind: 'memory', title: 'Tools and areas', eyebrow: 'THE TOOLKIT', list: ['Python', 'TypeScript', 'PyTorch', 'Machine learning', 'AI safety'] },
  { id: 'experience:ready', world: 'experience', landmark: 'ready', kind: 'essay', title: 'Ready enough to begin', eyebrow: essay(3).title.toUpperCase(), text: 'Software has been the bridge: the discipline of building real things in the real world. The next chapter is the one I was preparing for the whole time.', link: essay(3).url, linkLabel: `Read “${essay(3).title}”` },

  // 03 PROJECTS / THE WORKSHOP
  { id: 'projects:workshop', world: 'projects', landmark: 'workshop', poi: 'POI_archive', kind: 'archive', title: 'The Workshop', eyebrow: '03 / THE WORKSHOP', text: 'Build with conscience.', panel: 'projects' },
  ...['BEACN', 'Heard Us', 'alignment-evals', 'alignment-probes', 'interpretability-toolkit', 'prompt-injection-benchmark', 'llm-circuit-visualizer'].map(name => {
    const p = project(name), landmark = name === 'BEACN' ? 'beacn' : name === 'Heard Us' ? 'heard-us' : name;
    return { id: `projects:${landmark}`, world: 'projects', landmark, kind: 'project', title: p.name, eyebrow: p.tag, text: p.description, link: p.url, linkLabel: `Open ${p.name}` };
  }),
  { id: 'projects:build-log', world: 'projects', landmark: 'build-log', kind: 'link', title: 'The full build log', eyebrow: 'GITHUB / MAXWELLCALKIN', text: 'These are ongoing projects. Visit each app or repository for its current implementation, documentation, and limitations.', link: 'https://github.com/MaxwellCalkin', linkLabel: 'Explore the full build log' },

  // 04 MISSION / THE HORIZON
  { id: 'mission:observatory', world: 'mission', landmark: 'observatory', poi: 'POI_archive', kind: 'archive', title: 'The Horizon', eyebrow: '04 / THE HORIZON', text: 'Not just more powerful intelligence. Intelligence in service of what is genuinely life-giving.', panel: 'mission' },
  { id: 'mission:principle-1', world: 'mission', landmark: 'lens-1', kind: 'memory', title: 'Capability needs alignment.', eyebrow: 'PRINCIPLE 01', text: 'The first duty of a serious AI program is to keep its outputs oriented toward the good at every level of capability.' },
  { id: 'mission:principle-2', world: 'mission', landmark: 'lens-2', kind: 'memory', title: 'Alignment is not obedience.', eyebrow: 'PRINCIPLE 02', text: 'A perfectly compliant system is not necessarily a safe one. The target is wisdom, not servility.' },
  { id: 'mission:principle-3', world: 'mission', landmark: 'lens-3', kind: 'memory', title: 'Safety belongs to the whole system.', eyebrow: 'PRINCIPLE 03', text: 'Inside the model, outside the model, around the model, and beyond the model: no single perspective is enough.' },
  { id: 'mission:principle-4', world: 'mission', landmark: 'lens-4', kind: 'memory', title: 'Build what deserves to exist.', eyebrow: 'PRINCIPLE 04', text: 'I will resist participating in systems that addict, diminish, manipulate, or flatten human beings.' },
  { id: 'mission:long-view', world: 'mission', landmark: 'long-view', kind: 'memory', title: 'The long view', eyebrow: 'WHATEVER I BUILD', text: 'Whatever I build, I will build well. Respect detail. Favor substance over theater. Finish what matters. Prototype, test, refine, persist.' },
  { id: 'mission:essays', world: 'mission', landmark: 'essays', kind: 'essay', title: 'Notes from the unfolding.', eyebrow: 'LONG FORM', links: [{ label: essay(4).title, url: essay(4).url, note: essay(4).description }, { label: essay(5).title, url: essay(5).url, note: essay(5).description }] },

  // 05 CONTACT / THE SIGNAL
  { id: 'contact:signal', world: 'contact', landmark: 'signal', poi: 'POI_archive', kind: 'archive', title: 'The Signal', eyebrow: '05 / THE SIGNAL', text: 'Good work begins with a real conversation.', panel: 'contact' },
  { id: 'contact:email', world: 'contact', landmark: 'email', kind: 'link', title: 'Email', eyebrow: 'SEND A SIGNAL', text: 'mcalkinmusic@gmail.com', link: 'mailto:mcalkinmusic@gmail.com', linkLabel: 'Write an email' },
  { id: 'contact:github', world: 'contact', landmark: 'github', kind: 'link', title: 'GitHub', eyebrow: 'THE BUILD LOG', text: 'MaxwellCalkin', link: 'https://github.com/MaxwellCalkin', linkLabel: 'Open GitHub' },
  { id: 'contact:linkedin', world: 'contact', landmark: 'linkedin', kind: 'link', title: 'LinkedIn', eyebrow: 'CONNECT', text: 'Maxwell Calkin', link: 'https://linkedin.com/in/maxwellcalkin', linkLabel: 'Open LinkedIn' },
  { id: 'contact:public-square', world: 'contact', landmark: 'public-square', kind: 'link', title: 'Public square', eyebrow: 'FOLLOW ALONG', text: '@maxcalkin', link: 'https://x.com/MaxCalkin', linkLabel: 'Open profile' },
  { id: 'contact:closing', world: 'contact', landmark: 'closing', kind: 'memory', title: 'Strong enough to be kind.', eyebrow: 'A CLOSING NOTE', text: 'Strong enough to be kind. Ready enough to begin.' },
];

export const WORLD_ORDER = ['philosophy', 'experience', 'projects', 'mission', 'contact'];
export const CHAPTERS = Object.fromEntries(WORLD_ORDER.map(id => [id, CONTENT[id]]));

// The HUD looks these up every frame, so they are built once (shared and frozen).
const byWorld = new Map(), byLandmark = new Map(), NONE = Object.freeze([]);
for (const d of DISCOVERIES) {
  for (const [map, key] of [[byWorld, d.world], [byLandmark, `${d.world}/${d.landmark}`]]) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  }
}
for (const map of [byWorld, byLandmark]) for (const list of map.values()) Object.freeze(list);

export function discoveriesFor(world) { return byWorld.get(world) || NONE; }
/** The discoveries at one landmark of a world. */
export function discoveriesAt(world, landmark) { return byLandmark.get(`${world}/${landmark}`) || NONE; }
export function discoveryFor(world, landmark, poi) {
  const list = discoveriesAt(world, landmark);
  return list.find(d => d.poi === poi) || list.find(d => !d.poi) || list[0] || null;
}

const STORAGE_KEY = 'unfolding-journal-v2';

/** The visitor's journal: discovered ids, shards, wardens, records, and the ship's Tone and pedals. */
export class Journal {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.data = { discovered: [], shards: [], wardens: [], arenaBest: null, riff: false, visited: [], tone: 0, pedals: {}, rifts: {}, circuitBest: null, medals: [] };
    try { const raw = storage?.getItem(STORAGE_KEY); if (raw) Object.assign(this.data, JSON.parse(raw)); } catch { /* storage unavailable */ }
    for (const key of ['discovered', 'shards', 'wardens', 'visited', 'medals']) if (!Array.isArray(this.data[key])) this.data[key] = [];
    for (const key of ['pedals', 'rifts']) if (!this.data[key] || typeof this.data[key] !== 'object' || Array.isArray(this.data[key])) this.data[key] = {};
    if (!Number.isFinite(this.data.tone) || this.data.tone < 0) this.data.tone = 0;
    if (!Number.isFinite(this.data.circuitBest) || this.data.circuitBest <= 0) this.data.circuitBest = null;
  }
  save() { try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.data)); return true; } catch { return false; } }
  has(id) { return this.data.discovered.includes(id); }
  /** @returns {boolean} true if newly discovered */
  discover(id) { if (this.has(id)) return false; this.data.discovered.push(id); this.save(); return true; }
  addShard(id) { if (this.data.shards.includes(id)) return false; this.data.shards.push(id); this.save(); return true; }
  addWarden(id) { if (this.data.wardens.includes(id)) return false; this.data.wardens.push(id); this.save(); return true; }
  visit(world) { if (!this.data.visited.includes(world)) { this.data.visited.push(world); this.save(); } }
  progress(world) {
    const list = world ? discoveriesFor(world) : DISCOVERIES;
    const found = list.filter(d => this.has(d.id)).length;
    return { found, total: list.length };
  }
  get complete() { return DISCOVERIES.every(d => this.has(d.id)); }

  /* ------------------------------------------------------- the Aster */
  /** @returns {number} the new Tone balance */
  addTone(amount) {
    this.data.tone = Math.max(0, Math.round(this.data.tone + (Number(amount) || 0)));
    this.save();
    return this.data.tone;
  }
  /** Engages the next level of a pedal. @returns {number|null} the new level, or null if it can't be bought */
  buyPedal(id) {
    const cost = nextCost(this.data.pedals, id);
    if (cost === null || this.data.tone < cost) return null;
    const level = levelOf(this.data.pedals, id) + 1;
    this.data.tone -= cost;
    this.data.pedals = { ...this.data.pedals, [id]: level };
    this.save();
    return level;
  }
  /** Pedals that are earned, not bought (Reverb). @returns {boolean} true if newly earned */
  earnPedal(id) {
    if (levelOf(this.data.pedals, id) >= 1) return false;
    this.data.pedals = { ...this.data.pedals, [id]: 1 };
    this.save();
    return true;
  }
  riftClears(id) { return Math.max(0, Math.floor(Number(this.data.rifts[id]) || 0)); }
  /** @returns {number} how many times the rift has now been cleared */
  clearRift(id) { const clears = this.riftClears(id) + 1; this.data.rifts = { ...this.data.rifts, [id]: clears }; this.save(); return clears; }
  /** @returns {boolean} true for a new best lap */
  recordLap(seconds) {
    if (this.data.circuitBest !== null && seconds >= this.data.circuitBest) return false;
    this.data.circuitBest = seconds; this.save();
    return true;
  }
  /** @returns {boolean} true the first time a medal is won */
  addMedal(medal) { if (this.data.medals.includes(medal)) return false; this.data.medals.push(medal); this.save(); return true; }

  /** Clears discoveries; records, the Aster's Tone and pedals stay. */
  reset() {
    const { arenaBest, riff, tone, pedals, rifts, circuitBest, medals } = this.data;
    this.data = { discovered: [], shards: [], wardens: [], arenaBest, riff, visited: [], tone, pedals, rifts, circuitBest, medals };
    this.save();
  }
}
