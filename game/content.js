import { SOLAR_SCALE } from './solar-scale.js';

/** Portfolio copy is drawn from the original site and MaxwellCalkin's profile README.
 * These worlds are narrative navigation, not claims about completed research results. */
export const PLANETS = [
  { id: 'philosophy', name: 'Philosophy', title: 'The Origin', number: '01', color: '#8cf0d1', position: [-735, 87.5, -1015], radius: 150, description: 'The principles beneath the practice', terrain: 'Living archipelago' },
  { id: 'experience', name: 'Experience', title: 'The Arc', number: '02', color: '#ec8c69', position: [770, 210, -1750], radius: 190, description: 'Stages. Screens. Systems.', terrain: 'Copper highlands' },
  { id: 'projects', name: 'Projects', title: 'The Workshop', number: '03', color: '#b9a2ff', position: [1575, -175, -280], radius: 145, description: 'Open-source tools for safer intelligence', terrain: 'Crystalline frontier' },
  { id: 'mission', name: 'Mission', title: 'The Horizon', number: '04', color: '#83beff', position: [-1575, -105, 315], radius: 210, description: 'Intelligence in service of the good', terrain: 'Azure ocean world' },
  { id: 'contact', name: 'Contact', title: 'The Signal', number: '05', color: '#f3d28c', position: [140, 350, 1225], radius: 115, description: 'A conversation worth beginning', terrain: 'Golden outpost' },
].map(planet => ({ ...planet, position: planet.position.map(value => value * SOLAR_SCALE.planetSpacing), radius: planet.radius * SOLAR_SCALE.planetRadius }));

export const ESSAYS = [
  { title: 'What I Mean by the Unfolding', url: 'https://maxwellcalkin.netlify.app/essays/the-unfolding', description: 'On widening and deepening what is genuinely life-giving.' },
  { title: 'Depth × Span', url: 'https://maxwellcalkin.netlify.app/essays/depth-span', description: 'A lens for choosing what to build.' },
  { title: 'On Constitution Over Goals', url: 'https://maxwellcalkin.netlify.app/essays/constitution-over-goals', description: 'A contract with the present self.' },
  { title: 'Why I Bet on Alignment', url: 'https://maxwellcalkin.netlify.app/essays/bet-on-alignment', description: 'From touring musician to the work of AI safety.' },
  { title: 'Fatherhood as Alignment', url: 'https://maxwellcalkin.netlify.app/essays/fatherhood-as-alignment', description: 'Presence, care, and the limits of optimization.' },
  { title: 'Building What Will Outlive Me', url: 'https://maxwellcalkin.netlify.app/essays/outlive-me', description: 'The responsibility of leaving systems behind.' },
];

export const PROJECTS = [
  { name: 'BEACN', tag: 'COLLECTIVE ALIGNMENT EXPERIMENT', url: 'https://beacn.space', description: 'An experimental app for sharing and voting on visions of the future, exploring collective signals for AI alignment.' },
  { name: 'Heard Us', tag: 'YOUR VOICE MATTERS', url: 'https://heard-us.vercel.app', description: 'A place to make your voice heard. One of my favorite projects, alongside BEACN.' },
  { name: 'alignment-evals', tag: 'BEHAVIORAL EVALUATION', url: 'https://github.com/MaxwellCalkin/alignment-evals', description: 'Open-source work on measuring how AI systems behave under pressure.' },
  { name: 'alignment-probes', tag: 'MODEL INVESTIGATION', url: 'https://github.com/MaxwellCalkin/alignment-probes', description: 'Tools for exploring questions of alignment inside models.' },
  { name: 'interpretability-toolkit', tag: 'INTERPRETABILITY', url: 'https://github.com/MaxwellCalkin/interpretability-toolkit', description: 'Work on understanding the structures behind model behavior.' },
  { name: 'prompt-injection-benchmark', tag: 'ADVERSARIAL EVALUATION', url: 'https://github.com/MaxwellCalkin/prompt-injection-benchmark', description: 'An open-source benchmark project focused on prompt injection.' },
  { name: 'llm-circuit-visualizer', tag: 'CIRCUIT EXPLORATION', url: 'https://github.com/MaxwellCalkin/llm-circuit-visualizer', description: 'A project for making model circuits more approachable to explore.' },];

const essayLinks = (indices) => `<div class="reading-list">${indices.map(i => `<a class="reading-link" href="${ESSAYS[i].url}"><span><strong>${ESSAYS[i].title}</strong><small>${ESSAYS[i].description}</small></span><span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg></span></a>`).join('')}</div>`;

export const CONTENT = {
  philosophy: {
    eyebrow: '01 / THE ORIGIN', title: 'A constitution<br>for not drifting.',
    lede: 'I will live to participate in the unfolding of a better world.',
    html: `<p>A life is good to the degree that it generates and propagates goodness: within the self, within the family, within the community, within humanity, and within the universe.</p>
      <p>“The unfolding” is the widening and deepening of what is genuinely life-giving. It is the conviction underneath my work, my family, and the way I choose to live.</p>
      <div class="text-columns"><section><span class="tiny">I / THE FOUNDATION</span><h3>Health</h3><p>Sleep, strength, movement, nourishment, and emotional steadiness. My body is an instrument of service.</p></section><section><span class="tiny">II / THE CENTER</span><h3>Family</h3><p>A loving home and a present father. No outer victory compensates for inner betrayal at home.</p></section><section><span class="tiny">III / THE FIRE</span><h3>Mission</h3><p>Hard, meaningful work worthy of my gifts, directed toward what is genuinely good.</p></section></div>
      <h3>Depth × span</h3><p>Depth is interior richness, integration, and wisdom. Span is reach, inclusion, capability, and care. The aim is to grow both, without sacrificing either.</p>
      <h3>The decision filter</h3><ol class="principle-list"><li>Does this protect health?</li><li>Does this strengthen family?</li><li>Does this serve the mission?</li><li>Is it true, courageous, and beautiful?</li><li>Does it propagate genuine goodness outward?</li></ol>
      <h3>Read the thinking</h3>${essayLinks([0, 1, 2])}`,
  },
  experience: {
    eyebrow: '02 / THE ARC', title: 'Stages. Screens.<br>Systems.',
    lede: 'Each chapter trained something the next one needed.',
    html: `<div class="timeline"><section><span class="tiny">01 / 2015–2020</span><h3>The bass years</h3><p>Touring bassist. Radio City Music Hall, Broadway pits, orchestras, and recording studios. Music taught me what mastery feels like in the body.</p></section><section><span class="tiny">02 / THE ARENA YEARS</span><h3>A harder game</h3><p>Competitive League of Legends, Valorant, and Fortnite. High ranks, hard-contested games, and a lesson that lasted: stimulation is not the same as aliveness. I needed to contribute.</p></section><section><span class="tiny">03 / THE BUILD YEARS</span><h3>Work that compounds</h3><p>Software engineering at Interactive Aptitude, a DoD contractor funded by SBIR grants. Building real systems while moving toward work in AI safety and a future research lab.</p></section></div>
      <div class="tool-list" aria-label="Tools and areas">Python <span>·</span> TypeScript <span>·</span> PyTorch <span>·</span> Machine learning <span>·</span> AI safety</div>
      <h3>Ready enough to begin</h3><p>Software has been the bridge: the discipline of building real things in the real world. The next chapter is the one I was preparing for the whole time.</p>${essayLinks([3])}`,
  },
  projects: {
    eyebrow: '03 / THE WORKSHOP', title: 'Build with<br>conscience.',
    lede: 'BEACN. Heard Us. Tools for better futures and a stronger human voice.',
    html: `<p>Alignment is a multidimensional problem. Behavior, internal representations, shared understanding, and institutional oversight all matter. These apps and open-source tools are part of my effort to work across those perspectives.</p>
      <div class="project-list">${PROJECTS.map((project, i) => `<a class="project-link${i < 2 ? ' is-featured' : ''}" href="${project.url}" target="_blank" rel="noopener noreferrer"><span class="project-number">0${i + 1}</span><span><span class="tiny">${project.tag}</span><h3>${project.name}</h3><p>${project.description}</p></span><span class="external-arrow" aria-label="Opens in a new tab"><svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg></span></a>`).join('')}</div>
      <p class="fine-print">These are ongoing projects. Visit each app or repository for its current implementation, documentation, and limitations.</p><a class="text-link" href="https://github.com/MaxwellCalkin" target="_blank" rel="noopener noreferrer">Explore the full build log <span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg></span></a>`,
  },
  mission: {
    eyebrow: '04 / THE HORIZON', title: 'Intelligence<br>toward wisdom.',
    lede: 'Not just more powerful intelligence. Intelligence in service of what is genuinely life-giving.',
    html: `<p>My aim is to help ensure that as artificial minds grow in capability, they also grow in alignment with the deepest good available to us. An AI safety research and development lab is the horizon I am building toward.</p>
      <div class="mission-principles"><section><span class="tiny">01</span><h3>Capability needs alignment.</h3><p>The first duty of a serious AI program is to keep its outputs oriented toward the good at every level of capability.</p></section><section><span class="tiny">02</span><h3>Alignment is not obedience.</h3><p>A perfectly compliant system is not necessarily a safe one. The target is wisdom, not servility.</p></section><section><span class="tiny">03</span><h3>Safety belongs to the whole system.</h3><p>Inside the model, outside the model, around the model, and beyond the model: no single perspective is enough.</p></section><section><span class="tiny">04</span><h3>Build what deserves to exist.</h3><p>I will resist participating in systems that addict, diminish, manipulate, or flatten human beings.</p></section></div>
      <h3>The long view</h3><p>Whatever I build, I will build well. Respect detail. Favor substance over theater. Finish what matters. Prototype, test, refine, persist.</p>${essayLinks([4, 5])}`,
  },
  contact: {
    eyebrow: '05 / THE SIGNAL', title: 'At this edge?<br>Let’s talk.',
    lede: 'Good work begins with a real conversation.',
    html: `<p>I want to hear from people working on AI alignment, safety-motivated foundation model research, interpretability, integral theory, or anyone taking the widening of consciousness seriously.</p>
      <div class="contact-links"><a href="mailto:mcalkinmusic@gmail.com"><span class="tiny">EMAIL</span><strong>mcalkinmusic@gmail.com</strong><span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg></span></a><a href="https://github.com/MaxwellCalkin" target="_blank" rel="noopener noreferrer"><span class="tiny">GITHUB</span><strong>MaxwellCalkin</strong><span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg></span></a><a href="https://linkedin.com/in/maxwellcalkin" target="_blank" rel="noopener noreferrer"><span class="tiny">LINKEDIN</span><strong>Maxwell Calkin</strong><span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg></span></a><a href="https://x.com/MaxCalkin" target="_blank" rel="noopener noreferrer"><span class="tiny">PUBLIC SQUARE</span><strong>@maxcalkin</strong><span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg></span></a></div>
      <p class="closing-note">Strong enough to be kind.<br>Ready enough to begin.</p>`,
  },
};
