import { PLANETS, CONTENT } from './content.js';
import { WEAPONS } from './model.js';

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value) || 0));
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const command = (type, details = {}) => window.dispatchEvent(new CustomEvent('game:command', { detail: { type, ...details } }));
const planetFor = id => PLANETS.find(planet => planet.id === (typeof id === 'object' ? id?.id : id));
const controlsMarkup = () => `<div class="controls-grid">${[
  ['Thrust / walk', 'W S'], ['Steer / strafe', 'A D'], ['Look / aim', 'MOUSE / ↑ ↓ ← →'], ['Fire pulse weapon', 'SPACE / CLICK'], ['Boost / vector dash', 'SHIFT'], ['Land / archive / embark', 'E'], ['Set anchor / recall', 'Q'], ['Singularity ultimate', 'R'], ['Open system map', 'M'], ['Pause / close panel', 'ESC'],
].map(([action, keys]) => `<div class="control-row"><span>${action}</span><kbd>${keys}</kbd></div>`).join('')}</div><p>In space, fly toward a world and press E when landing is available. On the surface, find the glowing archive to read, or return to your ship to launch. The map can take you directly to any world.</p><p>On desktop, click the world to capture your mouse. Move the mouse to aim and use WASD to move. Escape releases the mouse. On touchscreens, use the movement arrows, drag to aim, and tap or hold the fire button. Tap the ability icons to dash, anchor, or unleash your ultimate.</p><p class="fine-print">Reading is always available through the navigation. No combat, score, or unlock is needed to read any portfolio section.</p>`;

export function initUI() {
  const byId = id => document.getElementById(id);
  const dialog = byId('portfolio-dialog');
  const dialogContent = byId('dialog-content');
  const canvas = byId('game-canvas');
  let state = { started: false, mode: 'space', visited: [], leaderboard: [], leaderboardMode: 'local' };
  let activePanel = null;
  let returnFocus = null;
  let toastTimeout;
  let ready = false;
  let errored = false;
  let leaderboardSignature = '';
  const text = (id, value) => { const node = byId(id); if (node && node.textContent !== String(value)) node.textContent = value; };
  const fraction = (id, value) => { const node = byId(id); if (node) node.style.width = `${clamp(value)}%`; };

  PLANETS.forEach(planet => {
    const button = document.createElement('button');
    button.className = 'map-dot';
    button.dataset.planet = planet.id;
    button.style.setProperty('--planet-color', planet.color);
    button.style.left = `${50 + planet.position[0] / 12}%`;
    button.style.top = `${50 + planet.position[2] / 14}%`;
    button.setAttribute('aria-label', `Warp to ${planet.name}`);
    button.title = `${planet.name} · Warp to world`;
    const label = document.createElement('span');
    label.className = `map-dot-label ${planet.position[0] > 100 ? 'left' : ''}`;
    label.textContent = planet.number;
    button.append(label);
    button.addEventListener('click', () => { if (!ready) return; closePanel(); command('warp', { planet: planet.id }); });
    byId('minimap').append(button);
  });

  function showToast(message) {
    const toast = byId('toast');
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('is-visible'), 4200);
  }

  function closePanel() {
    if (!dialog.open) return;
    dialog.close();
  }

  function scoreMarkup() {
    const global = state.leaderboardMode === 'global';
    return `<h2 id="dialog-title">${global ? 'A shared<br>flight log.' : 'Leave a<br>flight record.'}</h2><p class="dialog-lede">${global ? 'Community leaderboard' : 'Your expeditions, on this device.'}</p><p class="fine-print" id="leaderboard-disclosure">${global ? 'Your callsign and score will be public. Casual leaderboard; scores are not cheat-proof.' : 'THIS DEVICE ONLY · Records are saved in this browser. This is a local leaderboard, not a global ranking. Clearing browser storage removes saved records.'}</p><div id="leaderboard-results" aria-live="polite"></div><form class="score-form" id="score-form"><label for="pilot-name">YOUR CALLSIGN</label><input id="pilot-name" name="callsign" maxlength="20" autocomplete="nickname" placeholder="Anonymous explorer" aria-describedby="leaderboard-disclosure"><button class="button button-primary" id="save-score-button" type="submit">${global ? 'Publish score' : 'Save run'} <span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg></span></button></form><p class="fine-print" id="leaderboard-notice" role="status"></p><div class="dialog-actions"><button class="button button-ghost" data-command="restart">Restart expedition <span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg></span></button><button class="button button-ghost" data-close>Return to exploring</button></div>`;
  }

  function renderScores(force = false) {
    if (activePanel !== 'scores' && activePanel !== 'leaderboard') return;
    const rows = Array.isArray(state.leaderboard) ? state.leaderboard : [];
    const signature = JSON.stringify([rows, state.leaderboardLoading, state.leaderboardNotice, state.score, state.leaderboardMode]);
    if (!force && signature === leaderboardSignature) return;
    leaderboardSignature = signature;
    const results = byId('leaderboard-results');
    if (!results) return;
    results.innerHTML = rows.length ? `<ol class="leaderboard">${rows.slice(0, 10).map((row, index) => `<li><span class="rank">${String(index + 1).padStart(2, '0')}</span><span><strong>${escapeHTML(row.name || 'Anonymous explorer')}</strong><small>LVL ${Math.max(1, Math.floor(Number(row.level) || 1))} · ${Math.max(0, Math.floor(Number(row.kills) || 0))} ANOMALIES CLEARED</small></span><span class="record-score">${Math.max(0, Math.floor(Number(row.score) || 0)).toLocaleString()}</span></li>`).join('')}</ol>` : `<div class="leaderboard-empty">${state.leaderboardLoading ? 'Receiving flight records…' : 'No records yet. Explore a world, clear a few anomalies, and save your first expedition.'}</div>`;
    const saveButton = byId('save-score-button');
    saveButton.disabled = Boolean(state.leaderboardLoading) || !(Number(state.score) > 0);
    saveButton.innerHTML = state.leaderboardLoading ? 'Working…' : `${state.leaderboardMode === 'global' ? 'Publish score' : 'Save run'} <span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg></span>`;
    text('leaderboard-notice', state.leaderboardNotice || (Number(state.score) > 0 ? `Current run · ${Math.round(state.score).toLocaleString()} points` : 'Earn a score before saving a run.'));
  }

  function openPanel(id) {
    if (id === 'leaderboard') id = 'scores';
    if (!CONTENT[id] && !['map', 'pause', 'controls', 'scores'].includes(id)) return;
    const wasOpen = dialog.open;
    if (!wasOpen) returnFocus = document.activeElement;
    activePanel = id;
    dialog.dataset.panel = id;
    const content = CONTENT[id];
    if (content) {
      text('dialog-eyebrow', content.eyebrow);
      dialogContent.innerHTML = `<h2 id="dialog-title">${content.title}</h2><p class="dialog-lede">${content.lede}</p>${content.html}<div class="dialog-actions"><button class="button button-ghost" data-warp="${id}">Explore this world <span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg></span></button><button class="button button-ghost" data-close>Return to universe</button></div>`;
    } else if (id === 'map') {
      text('dialog-eyebrow', 'NAVIGATION / FIVE WORLDS');
      dialogContent.innerHTML = `<h2 id="dialog-title">Chart your<br>own course.</h2><p class="dialog-lede">Five places to explore. A different part of the story on each.</p><ul class="map-destinations">${PLANETS.map(planet => `<li style="--planet-color:${planet.color}"><span class="planet-avatar" aria-hidden="true"></span><div><h3>${planet.name}</h3><p>${planet.description}</p><span class="tiny">${planet.terrain.toUpperCase()}${state.visited?.includes(planet.id) ? ' / VISITED' : ''}</span></div><button class="warp-button" data-warp="${planet.id}" aria-label="Warp to ${planet.name}">WARP <span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg></span></button></li>`).join('')}</ul><p class="fine-print">Warp lands you directly on a world. Find its glowing archive to read, or open any section from the top navigation at any time.</p>`;
    } else if (id === 'controls') {
      text('dialog-eyebrow', 'FIELD MANUAL / CONTROLS');
      dialogContent.innerHTML = `<h2 id="dialog-title">Make yourself<br>at home.</h2><p class="dialog-lede">Fly, land, explore. Follow your curiosity.</p>${controlsMarkup()}<div class="dialog-actions"><button class="button button-primary" data-close>Back to the universe <span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg></span></button></div>`;
    } else if (id === 'pause') {
      text('dialog-eyebrow', 'MISSION CONTROL / SETTINGS');
      dialogContent.innerHTML = `<h2 id="dialog-title">A moment<br>of stillness.</h2><p class="dialog-lede">Take your time. The universe can wait.</p><div class="settings-list"><label class="setting"><span>Sound<small>Procedural flight, weapon, and ability audio.</small></span><input id="setting-sound" type="checkbox" ${state.sound ? 'checked' : ''}></label><label class="setting"><span>Reduced motion<small>Less camera movement, flashes, and visual effects.</small></span><input id="setting-motion" type="checkbox" ${state.reducedMotion ? 'checked' : ''}></label></div><div class="dialog-actions"><button class="button button-primary" data-close>${state.started ? 'Resume expedition' : 'Back to the universe'} <span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg></span></button><button class="button button-ghost" data-panel="controls">Flight manual</button><button class="button button-ghost" data-panel="scores">Flight log</button>${state.started ? '<button class="button button-ghost" data-command="restart">Restart expedition</button>' : ''}</div><p class="fine-print">The complete reading version is available at any time. You don’t need to play to explore the work.</p>`;
    } else if (id === 'scores') {
      text('dialog-eyebrow', state.leaderboardMode === 'global' ? 'PUBLIC FLIGHT LOG / COMMUNITY' : 'LOCAL FLIGHT LOG / THIS DEVICE');
      dialogContent.innerHTML = scoreMarkup();
      renderScores(true);
    }
    dialog.scrollTop = 0;
    if (!wasOpen) { dialog.showModal(); document.body.classList.add('dialog-open'); command('overlay', { open: true }); }
    byId('close-dialog').focus({ preventScroll: true });
  }

  dialog.addEventListener('close', () => {
    activePanel = null;
    document.body.classList.remove('dialog-open');
    command('overlay', { open: false });
    if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus({ preventScroll: true });
    else if (state.started) canvas.focus({ preventScroll: true });
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); closePanel(); });
  dialog.addEventListener('click', event => {
    if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closePanel(); }
  });
  byId('close-dialog').addEventListener('click', closePanel);

  document.addEventListener('click', event => {
    const button = event.target.closest('button, a');
    if (!button?.matches('[data-panel], [data-command], [data-close], [data-warp]')) return;
    event.preventDefault();
    if (button.dataset.panel) openPanel(button.dataset.panel);
    else if (button.hasAttribute('data-close')) closePanel();
    else if (button.dataset.warp) { if (!ready) return showToast('The universe is still loading. You can read every section now.'); const planet = button.dataset.warp; closePanel(); command('warp', { planet }); }
    else if (button.dataset.command) { if (button.dataset.command === 'restart') closePanel(); command(button.dataset.command); }
  });
  dialog.addEventListener('submit', event => {
    if (event.target.id !== 'score-form') return;
    event.preventDefault();
    command('saveScore', { name: byId('pilot-name').value.trim().slice(0, 20) || 'Anonymous explorer' });
  });
  dialog.addEventListener('change', event => {
    if (event.target.id === 'setting-sound') command('settings', { sound: event.target.checked });
    if (event.target.id === 'setting-motion') command('settings', { reducedMotion: event.target.checked });
  });
  byId('sound-toggle').addEventListener('click', () => command('settings', { sound: !state.sound }));
  byId('launch-button').addEventListener('click', () => { if (ready) { command('start'); canvas.focus({ preventScroll: true }); } });
  byId('interact-button').addEventListener('click', () => command('interact'));

  document.querySelectorAll('[data-input], [data-fire]').forEach(button => {
    const emit = pressed => {
      button.classList.toggle('is-held', pressed);
      if (button.hasAttribute('data-fire')) command('fire', { pressed });
      else command('input', { key: button.dataset.input.replace(/^Key/, '').toLowerCase(), pressed });
    };
    button.addEventListener('pointerdown', event => { event.preventDefault(); button.setPointerCapture(event.pointerId); emit(true); });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(name, () => emit(false));
  });

  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (dialog.open) closePanel(); else if (state.started) openPanel('pause');
      return;
    }
    if (event.target.closest('input, textarea, select') || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (event.key.toLowerCase() === 'm') { event.preventDefault(); event.stopImmediatePropagation(); if (dialog.open && activePanel === 'map') closePanel(); else openPanel('map'); }
  }, true);

  function update(next) {
    const previousMode = state.leaderboardMode;
    state = { ...state, ...next };
    document.body.dataset.mode=state.mode;
    document.body.classList.toggle('is-playing', Boolean(state.started) && !errored);
    document.body.classList.toggle('reduce-motion', Boolean(state.reducedMotion));
    document.body.dataset.mode = state.mode || 'space';
    text('level-value', String(state.level || 1).padStart(2, '0'));
    text('score-value', String(Math.max(0, Math.round(state.score || 0))).padStart(6, '0'));
    text('health-value', Math.ceil(clamp(state.health)));
    text('shield-value', Math.ceil(clamp(state.shield)));
    fraction('health-fill', state.health); fraction('shield-fill', state.shield);
    const xp = Number(state.xp) || 0;
    text('xp-label', `${state.weaponName || 'PULSE I'} / LV ${state.level || 1}`);
    const weaponIndex = Math.max(0, WEAPONS.findLastIndex(weapon => xp >= weapon.at));
    const currentWeapon = WEAPONS[weaponIndex];
    const nextWeapon = WEAPONS[weaponIndex + 1];
    fraction('xp-fill', nextWeapon ? ((xp - currentWeapon.at) / (nextWeapon.at - currentWeapon.at)) * 100 : 100);
    const hints=document.querySelector('.controls-strip');if(hints){hints.children[0].innerHTML=state.mode==='surface'?'<kbd>W</kbd><kbd>S</kbd> MOVE':'<kbd>W</kbd><kbd>S</kbd> THRUST';hints.children[1].innerHTML=state.mode==='surface'?'<kbd>A</kbd><kbd>D</kbd> STRAFE':'<kbd>A</kbd><kbd>D</kbd> STEER';}
    text('mode-label', state.mode === 'surface' ? 'SURFACE EXPLORER' : 'ORBITAL EXPLORER');
    byId('speed-value').innerHTML = `${String(Math.abs(Math.round(state.speed || 0))).padStart(3, '0')} <small>M/S</small>`;
    text('dash-state', state.dashCooldown > 0 ? `${Math.ceil(state.dashCooldown)}s` : 'READY');
    text('recall-state', state.recallActive ? `RECALL ${state.recallRemaining || ''}` : state.recallCooldown > 0 ? `${Math.ceil(state.recallCooldown)}s` : 'SET ANCHOR');
    text('ultimate-state', state.ultimate >= 100 ? 'READY' : `${Math.floor(clamp(state.ultimate))}%`);
    byId('ultimate-fill').style.setProperty('--charge', `${clamp(state.ultimate)}%`);
    byId('ultimate-button').classList.toggle('is-ready', state.ultimate >= 100);
    const visited = state.visited || [];
    text('visited-count', `${visited.length} / 5 WORLDS`);
    document.querySelectorAll('.map-dot').forEach(dot => dot.classList.toggle('is-visited', visited.includes(dot.dataset.planet)));
    const p = planetFor(state.planetId);
    const near = planetFor(state.nearPlanet);
    const target = planetFor(state.targetPlanet?.id);
    if (state.mode === 'surface') {
      text('objective-title', `${p?.name || 'World'} / Archive signal`);
      text('objective-detail', state.canInteract ? 'Press E to open the archive' : state.canEmbark ? 'Press E to return to orbit' : 'Find the glowing archive. Explore at your own pace.');
      text('target-label', state.canInteract ? 'ARCHIVE IN RANGE' : state.canEmbark ? 'SHIP IN RANGE' : `${p?.title || 'SURFACE'} · ${state.weaponName || 'PULSE I'}`);
    } else {
      text('objective-title', visited.length === 5 ? 'A universe well explored' : 'Explore the five worlds');
      text('objective-detail', state.canLand ? `${near?.name || 'World'} in range · E to land` : 'Choose a destination on the system map');
      text('target-label', target ? `NEAREST · ${target.name} / ${Math.round(state.targetPlanet.distance || 0)} M${state.targetPlanet.behind ? ' · BEHIND' : ''}` : near ? `${near.name} / ${Math.round(state.nearestDistance || 0)} M` : 'FOLLOW A SIGNAL');
    }
    const canInteract = Boolean(state.canLand || state.canInteract || state.canEmbark);
    byId('interaction').hidden = !canInteract;
    text('interact-label', state.mode === 'space' ? 'Land & explore' : state.canInteract ? 'Open the archive' : 'Return to orbit');
    const mapPosition = state.mode === 'surface' && p ? { x: p.position[0], z: p.position[2] } : state.position || { x: 0, z: 120 };
    byId('map-player').style.left = `${clamp(50 + mapPosition.x / 12, 3, 97)}%`;
    byId('map-player').style.top = `${clamp(50 + mapPosition.z / 14, 3, 97)}%`;
    const soundButton = byId('sound-toggle');
    soundButton.setAttribute('aria-pressed', String(Boolean(state.sound)));
    soundButton.setAttribute('aria-label', state.sound ? 'Turn sound off' : 'Turn sound on');
    if (activePanel === 'scores') {
      if (previousMode !== state.leaderboardMode) { const name = byId('pilot-name')?.value || ''; openPanel('scores'); if (byId('pilot-name')) byId('pilot-name').value = name; }
      else renderScores();
    }
  }

  function setReady() { ready = true; byId('launch-button').disabled = false; text('launch-button-text', 'Explore the universe'); }
  function setError(message) { errored = true; ready = false; document.body.classList.add('is-error'); document.body.classList.remove('is-playing'); text('launch-note', message || 'The 3D world could not load. The complete reading version is ready below.'); showToast('The reading version is available without the 3D experience.'); }
  update({ reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
  return { update, showToast, openPanel, closePanel, setReady, setError };
}
