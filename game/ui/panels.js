import { CONTENT } from '../content.js';
import { PLANETS } from '../world/system.js';
import { DISCOVERIES, discoveriesFor, WORLD_ORDER } from '../gameplay/discoveries.js';
import { SHARDS_PER_WORLD } from '../gameplay/shards.js';
import { escapeHTML, ARROW, formatTime, plainTitle } from './format.js';

/**
 * Modal panels in the shared <dialog>: the five portfolio chapters (verbatim
 * from content.js), the system map, the journal, settings, controls and the
 * flight log. Panels never touch the game directly; they emit commands.
 */
const $ = id => document.getElementById(id);
const PANEL_IDS = ['map', 'journal', 'pause', 'controls', 'scores', 'achievement'];
const planet = id => PLANETS.find(p => p.id === id);
const sentence = text => text.charAt(0) + text.slice(1).toLowerCase().replace(/\bi\b/g, 'I');

export class Panels {
  /**
   * @param {object} provider getters: journal, settings, run, board, ready, world, playing
   * @param {(type:string, detail?:object)=>void} command
   */
  constructor(provider, command) {
    this.p = provider; this.command = command;
    this.dialog = $('portfolio-dialog'); this.content = $('dialog-content'); this.eyebrow = $('dialog-eyebrow');
    this.active = null; this.returnFocus = null; this.resetArmed = false;
    $('death-restart').hidden = true;
    this.dialog.addEventListener('close', () => {
      if (this.dialog.open) return;
      const was = this.active; this.active = null;
      document.body.classList.remove('dialog-open');
      this.command('panelClosed', { panel: was });
      if (this.returnFocus?.isConnected && this.returnFocus !== document.body) this.returnFocus.focus({ preventScroll: true });
    });
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener('click', event => {
      if (event.target !== this.dialog) return;
      const b = this.dialog.getBoundingClientRect();
      if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) this.close();
    });
    $('close-dialog').addEventListener('click', () => this.close());
    document.addEventListener('click', event => {
      const el = event.target.closest('[data-panel], [data-close], [data-travel], [data-command]');
      if (!el) return;
      if (el.matches('a[data-panel]') && (event.metaKey || event.ctrlKey || event.shiftKey)) return; // let modified clicks open the portfolio
      event.preventDefault();
      if (el.dataset.panel) this.open(el.dataset.panel);
      else if (el.hasAttribute('data-close')) this.close();
      else if (el.dataset.travel) { if (!this.p.ready) return; this.close(); this.command('travel', { world: el.dataset.travel }); }
      else if (el.dataset.command) this.#commandButton(el);
    });
    this.dialog.addEventListener('change', event => this.#setting(event.target));
    this.dialog.addEventListener('input', event => { if (event.target.type === 'range') this.#setting(event.target); });
    this.dialog.addEventListener('submit', event => {
      if (event.target.id !== 'score-form') return;
      event.preventDefault();
      this.command('saveScore', { name: $('pilot-name').value.trim().slice(0, 20) || 'Anonymous explorer' });
    });
  }

  get isOpen() { return this.dialog.open; }

  #commandButton(el) {
    const type = el.dataset.command;
    if (type === 'reset') {
      if (!this.resetArmed) { this.resetArmed = true; el.textContent = 'Press again to erase your journal'; setTimeout(() => { this.resetArmed = false; if (el.isConnected) el.textContent = 'Reset journal'; }, 4000); return; }
      this.resetArmed = false;
    }
    this.command(type, { ...el.dataset });
    if (type === 'reset') this.render();
  }

  #setting(target) {
    if (!target?.id?.startsWith('setting-')) return;
    const key = target.id.slice(8);
    const value = target.type === 'checkbox' ? target.checked : target.type === 'range' ? Number(target.value) : target.value;
    this.command('settings', { [key]: value });
  }

  open(id) {
    if (!CONTENT[id] && !PANEL_IDS.includes(id)) return;
    if (!this.dialog.open) this.returnFocus = document.activeElement;
    this.active = id;
    this.dialog.dataset.panel = id;
    this.render();
    this.dialog.scrollTop = 0;
    if (!this.dialog.open) {
      this.dialog.showModal();
      document.body.classList.add('dialog-open');
      this.command('panelOpened', { panel: id });
    }
    $('close-dialog').focus({ preventScroll: true });
  }

  close() { if (this.dialog.open) this.dialog.close(); }

  toggle(id) { if (this.dialog.open && this.active === id) this.close(); else this.open(id); }

  render() {
    const id = this.active; if (!id) return;
    const html = CONTENT[id] ? this.#chapter(id) : this[`_${id}`]();
    this.content.innerHTML = html;
    if (id === 'scores') this.renderScores(true);
  }

  #chapter(id) {
    const c = CONTENT[id], spec = planet(id), here = this.p.world === id;
    this.eyebrow.textContent = c.eyebrow;
    const travel = here ? '' : `<button class="button button-ghost" data-travel="${id}">Travel to ${escapeHTML(spec.name)} ${ARROW}</button>`;
    return `<h2 id="dialog-title">${c.title}</h2><p class="dialog-lede">${c.lede}</p>${c.html}<div class="dialog-actions">${this.p.playing ? `<button class="button button-primary" data-close>Back to exploring ${ARROW}</button>` : ''}${travel}<button class="button button-ghost" data-panel="map">All five worlds</button></div>`;
  }

  _map() {
    this.eyebrow.textContent = 'NAVIGATION / FIVE WORLDS';
    const j = this.p.journal;
    const rows = WORLD_ORDER.map(id => {
      const spec = planet(id), prog = j.progress(id), shards = j.data.shards.filter(s => s.startsWith(`${id}:`)).length, warden = j.data.wardens.includes(id);
      const here = this.p.world === id;
      const status = [`${prog.found} / ${prog.total} DISCOVERIES`, `${shards} / ${SHARDS_PER_WORLD} SHARDS`, warden ? 'WARDEN DEFEATED' : null].filter(Boolean).join(' · ');
      return `<li style="--planet-color:${spec.color}"><span class="planet-avatar" aria-hidden="true"></span><div><span class="tiny map-number">${spec.number} / ${escapeHTML(spec.title.toUpperCase())}</span><h3>${escapeHTML(spec.name)}</h3><p>${escapeHTML(sentence(spec.subtitle))}. ${escapeHTML(CONTENT[id].lede)}</p><span class="tiny">${status}${here ? ' · YOU ARE HERE' : ''}</span></div><div class="map-actions"><button class="warp-button" data-travel="${id}" ${here || !this.p.ready ? 'disabled' : ''} aria-label="Travel to ${escapeHTML(spec.name)}">${here ? 'HERE' : 'TRAVEL'} <span aria-hidden="true">${ARROW}</span></button><button class="warp-button is-quiet" data-panel="${id}" aria-label="Read the ${escapeHTML(spec.name)} chapter">READ</button></div></li>`;
    }).join('');
    const total = j.progress();
    return `<h2 id="dialog-title">Chart your<br>own course.</h2><p class="dialog-lede">Five worlds to explore. ${total.found} of ${total.total} discoveries found so far.</p><ul class="map-destinations">${rows}</ul><div class="system-projects"><a href="https://beacn.space" target="_blank" rel="noopener noreferrer"><span class="tiny">FEATURED PROJECT</span><strong>BEACN ${ARROW}</strong></a><a href="https://heard-us.vercel.app" target="_blank" rel="noopener noreferrer"><span class="tiny">FEATURED PROJECT</span><strong>Heard Us ${ARROW}</strong></a></div><p class="fine-print">Travel is instant. You can also fly your ship between worlds: take off, open the map and choose a destination for autopilot, or steer there yourself. Every chapter can be read without playing.</p>`;
  }

  _journal() {
    this.eyebrow.textContent = 'FIELD JOURNAL / DISCOVERIES';
    const j = this.p.journal, total = j.progress();
    const worlds = WORLD_ORDER.map(id => {
      const spec = planet(id), list = discoveriesFor(id), prog = j.progress(id);
      const shards = j.data.shards.filter(s => s.startsWith(`${id}:`)).length;
      const items = list.map(d => {
        const found = j.has(d.id);
        if (!found) return `<li class="journal-item"><span class="tiny">${escapeHTML(d.kind === 'archive' ? 'MAIN ARCHIVE' : 'UNDISCOVERED')}</span><strong>Somewhere on ${escapeHTML(spec.name)}</strong></li>`;
        const body = d.list ? `<ol>${d.list.map(x => `<li>${escapeHTML(x)}</li>`).join('')}</ol>` : d.links ? d.links.map(l => `<a class="text-link" href="${escapeHTML(l.url)}">${escapeHTML(l.label)} <span>${ARROW}</span></a>`).join('<br>') : `<p>${escapeHTML(d.text || '')}</p>`;
        const link = d.panel ? `<button class="text-link as-button" data-panel="${d.panel}">Read the full chapter <span>${ARROW}</span></button>` : d.link ? `<a class="text-link" href="${escapeHTML(d.link)}" ${d.link.startsWith('mailto:') ? '' : 'target="_blank" rel="noopener noreferrer"'}>${escapeHTML(d.linkLabel || 'Open')} <span>${ARROW}</span></a>` : '';
        return `<li class="journal-item is-found"><span class="tiny">${escapeHTML(d.eyebrow || '')}</span><strong>${escapeHTML(d.title)}</strong>${body}${link}</li>`;
      }).join('');
      return `<section class="journal-world" style="--planet-color:${spec.color}"><header><span class="planet-avatar" aria-hidden="true"></span><div><span class="tiny">${spec.number} / ${escapeHTML(spec.title.toUpperCase())}</span><h3>${escapeHTML(spec.name)}</h3></div><span class="tiny journal-count">${prog.found}/${prog.total} · ${shards}/${SHARDS_PER_WORLD} SHARDS${j.data.wardens.includes(id) ? ' · WARDEN ✓' : ''}</span></header><ul class="journal-list">${items}</ul></section>`;
    }).join('');
    const extras = [
      j.data.arenaBest ? `Arena best: ${formatTime(j.data.arenaBest)}` : null,
      j.data.riff ? 'The groove: found (press B to air bass)' : null,
      j.data.wardens.length ? `${j.data.wardens.length} of 5 wardens defeated` : null,
    ].filter(Boolean);
    return `<h2 id="dialog-title">What you<br>have found.</h2><p class="dialog-lede">${total.found} of ${total.total} discoveries. ${j.data.shards.length} of ${SHARDS_PER_WORLD * 5} resonance shards.</p>${extras.length ? `<p class="fine-print">${extras.map(escapeHTML).join(' · ')}</p>` : ''}${worlds}<div class="dialog-actions"><button class="button button-primary" data-close>Back to exploring ${ARROW}</button><button class="button button-ghost" data-panel="map">System map</button><a class="button button-ghost" href="./portfolio.html">Read the portfolio ${ARROW}</a></div>`;
  }

  _pause() {
    this.eyebrow.textContent = 'MISSION CONTROL / SETTINGS';
    const s = this.p.settings.data;
    const quality = ['auto', 'high', 'medium', 'low'].map(q => `<option value="${q}" ${s.quality === q ? 'selected' : ''}>${q === 'auto' ? `Automatic (${this.p.quality})` : q.charAt(0).toUpperCase() + q.slice(1)}</option>`).join('');
    const playing = this.p.playing;
    return `<h2 id="dialog-title">A moment<br>of stillness.</h2><p class="dialog-lede">Take your time. The universe can wait.</p>
      <div class="settings-list">
        <label class="setting"><span>Sound<small>A live, generative bass-forward score and effects.</small></span><input id="setting-sound" type="checkbox" ${s.sound ? 'checked' : ''}></label>
        <label class="setting"><span>Volume</span><input class="range" id="setting-volume" type="range" min="0" max="1" step="0.05" value="${s.volume}"></label>
        <label class="setting"><span>Graphics quality<small>Detail, shadows and effects. Automatic adapts to your device.</small></span><select id="setting-quality">${quality}</select></label>
        <label class="setting"><span>Look sensitivity</span><input class="range" id="setting-sensitivity" type="range" min="0.3" max="2.5" step="0.05" value="${s.sensitivity}"></label>
        <label class="setting"><span>Invert look<small>Moving the mouse up looks down.</small></span><input id="setting-invertY" type="checkbox" ${s.invertY ? 'checked' : ''}></label>
        <label class="setting"><span>Reduced motion<small>Calmer camera, fewer flashes and particles.</small></span><input id="setting-reducedMotion" type="checkbox" ${this.p.settings.reducedMotion ? 'checked' : ''}></label>
      </div>
      <div class="dialog-actions"><button class="button button-primary" data-close>${playing ? 'Resume' : 'Back to the universe'} ${ARROW}</button><button class="button button-ghost" data-panel="controls">Controls</button><button class="button button-ghost" data-panel="journal">Journal</button><button class="button button-ghost" data-panel="scores">Flight log</button>${playing ? '<button class="button button-ghost" data-command="respawn">Return to the site</button>' : ''}<button class="button button-ghost" data-command="reset">Reset journal</button></div>
      <p class="fine-print">The complete reading version is always available. You never need to play to explore the work.</p>`;
  }

  _controls() {
    this.eyebrow.textContent = 'FIELD MANUAL / CONTROLS';
    const rows = list => `<div class="controls-grid">${list.map(([a, k]) => `<div class="control-row"><span>${a}</span><kbd>${k}</kbd></div>`).join('')}</div>`;
    return `<h2 id="dialog-title">Make yourself<br>at home.</h2><p class="dialog-lede">Walk the worlds. Read the landmarks. Fly anywhere.</p>
      <div class="manual-section"><span class="tiny">01 / ON FOOT</span><h3>The agent.</h3>${rows([['Move', 'W A S D'], ['Look and aim', 'MOUSE'], ['Jump · hold to jetpack', 'SPACE'], ['Sprint', 'SHIFT'], ['Read a landmark · board the ship', 'E'], ['Fire', 'CLICK'], ['Aim down sights', 'RIGHT CLICK'], ['Glissando (dash)', 'Q'], ['Low End (shockwave)', 'C'], ['The Drop (ultimate)', 'X'], ['Air bass (once unlocked)', 'B'], ['Map · journal · pause', 'M · J · ESC']])}<p>Click the world to capture the mouse. Escape releases it and pauses. The main site on every world is a sanctuary: nothing hostile spawns there.</p></div>
      <div class="manual-section"><span class="tiny">02 / IN THE SHIP</span><h3>The Aster.</h3>${rows([['Throttle up / down', 'W / S'], ['Steer', 'MOUSE'], ['Turn', 'A / D'], ['Boost · pulse drive in open space', 'SHIFT'], ['Land (near a surface)', 'E'], ['Fire', 'CLICK'], ['Autopilot to a world', 'M']])}<p>Takeoff and landing are automatic. Near a world, press E and the ship finds flat ground, or the landing pad at the site.</p></div>
      <div class="manual-section"><span class="tiny">03 / TOUCH</span><h3>On a phone or tablet.</h3><p>Drag on the left side to move and on the right side to look. The buttons fire, jump, interact and trigger abilities.</p></div>
      <div class="dialog-actions"><button class="button button-primary" data-close>Back to the universe ${ARROW}</button></div>`;
  }

  _achievement() {
    const earned = this.p.journal.data.wardens.length >= 5;
    this.eyebrow.textContent = earned ? 'EXPEDITION COMPLETE / ACHIEVEMENT EARNED' : 'FIVE WORLDS / FIVE WARDENS';
    const list = WORLD_ORDER.map(id => { const spec = planet(id), done = this.p.journal.data.wardens.includes(id); return `<li class="${done ? 'is-cleared' : ''}"><span style="--planet-color:${spec.color}" class="warden-world-dot" aria-hidden="true"></span><span>${escapeHTML(spec.name)}</span><span class="tiny">${done ? 'DEFEATED' : 'AWAITING YOU'}</span></li>`; }).join('');
    return `<div class="achievement-emblem${earned ? ' is-earned' : ''}" aria-hidden="true"><svg viewBox="0 0 96 96" fill="none"><path d="m48 9 11 24 26 3-19 18 5 27-23-13-23 13 5-27L11 36l26-3L48 9Z"/><circle cx="48" cy="48" r="44"/><circle cx="48" cy="48" r="35"/></svg></div><h2 id="dialog-title">${earned ? 'Starforged<br>Explorer.' : 'Five worlds.<br>Five wardens.'}</h2><p class="dialog-lede">${earned ? 'Every warden has fallen. Your aurora thrusters are earned.' : 'Each world has a warden beyond the sanctuary. Defeat all five to earn the Starforged Explorer title and aurora thrusters.'}</p>${earned ? '<div class="achievement-rewards"><span class="tiny">REWARDS EARNED</span><strong>Starforged Explorer</strong><p>Explorer title + aurora jet and ship thrusters</p><span class="aurora-swatch" aria-hidden="true"></span></div>' : ''}<ul class="warden-checklist">${list}</ul><div class="dialog-actions"><button class="button button-primary" data-close>${earned ? 'Keep exploring' : 'Continue'} ${ARROW}</button><button class="button button-ghost" data-panel="map">System map</button></div>`;
  }

  _scores() {
    const b = this.p.board, global = b.mode === 'global';
    this.eyebrow.textContent = global ? 'PUBLIC FLIGHT LOG / COMMUNITY' : 'LOCAL FLIGHT LOG / THIS DEVICE';
    const run = this.p.run;
    return `<h2 id="dialog-title">${global ? 'A shared<br>flight log.' : 'Leave a<br>flight record.'}</h2><p class="dialog-lede">This expedition: ${run.score.toLocaleString()} points · ${run.kills} cleared · ${run.wardens} wardens.</p><p class="fine-print" id="leaderboard-disclosure">${global ? 'Your callsign and score will be public. Casual leaderboard; scores are not cheat-proof.' : 'THIS DEVICE ONLY · Records are saved in this browser, not a global ranking.'}</p><div id="leaderboard-results" aria-live="polite"></div><form class="score-form" id="score-form"><label for="pilot-name">YOUR CALLSIGN</label><input id="pilot-name" name="callsign" maxlength="20" autocomplete="nickname" placeholder="Anonymous explorer" aria-describedby="leaderboard-disclosure"><button class="button button-primary" id="save-score-button" type="submit">${global ? 'Publish score' : 'Save run'} ${ARROW}</button></form><p class="fine-print" id="leaderboard-notice" role="status"></p><div class="dialog-actions"><button class="button button-ghost" data-close>Back to exploring</button></div>`;
  }

  renderScores(force = false) {
    if (this.active !== 'scores') return;
    const b = this.p.board, run = this.p.run;
    const signature = JSON.stringify([b.rows, b.loading, b.notice, run.score]);
    if (!force && signature === this.scoreSignature) return;
    this.scoreSignature = signature;
    const results = $('leaderboard-results'); if (!results) return;
    const rows = Array.isArray(b.rows) ? b.rows : [];
    results.innerHTML = rows.length
      ? `<ol class="leaderboard">${rows.slice(0, 10).map((row, i) => `<li><span class="rank">${String(i + 1).padStart(2, '0')}</span><span><strong>${escapeHTML(row.name || 'Anonymous explorer')}</strong><small>LVL ${Math.max(1, Math.floor(Number(row.level) || 1))} · ${Math.max(0, Math.floor(Number(row.kills) || 0))} CLEARED${row.bossKills ? ` · ${row.bossKills} WARDENS` : ''}</small></span><span class="record-score">${Math.max(0, Math.floor(Number(row.score) || 0)).toLocaleString()}</span></li>`).join('')}</ol>`
      : `<div class="leaderboard-empty">${b.loading ? 'Receiving flight records…' : 'No records yet. Explore, discover and save your first expedition.'}</div>`;
    const save = $('save-score-button');
    if (save) save.disabled = Boolean(b.loading) || !(run.score > 0);
    const notice = $('leaderboard-notice');
    if (notice) notice.textContent = b.notice || (run.score > 0 ? `Current run · ${run.score.toLocaleString()} points` : 'Earn a score before saving a run.');
  }
}

/** Topbar shortcuts work before the 3D world is ready. */
export function totalDiscoveries() { return DISCOVERIES.length; }
export { plainTitle };
