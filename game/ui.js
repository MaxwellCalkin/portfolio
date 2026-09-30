import { PLANETS, CONTENT } from './content.js';
import { WEAPONS } from './model.js';

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value) || 0));
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const command = (type, details = {}) => window.dispatchEvent(new CustomEvent('game:command', { detail: { type, ...details } }));
const planetFor = id => PLANETS.find(planet => planet.id === (typeof id === 'object' ? id?.id : id));
const ARROW = '<svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg>';
const controlsMarkup = () => `<div class="manual-section"><span class="tiny">01 / AT THE HELM</span><h3>Keep the horizon moving.</h3><div class="controls-grid">${[
  ['Thrust / brake', 'W / S'], ['Turn left / right', 'A / D'], ['Pitch / climb / descend', '↑ / ↓'], ['Fire ship weapons', 'SPACE / CLICK'], ['Ship boost', 'SHIFT'], ['360° evasive loop · in space', 'Q'],
].map(([action, keys]) => `<div class="control-row"><span>${action}</span><kbd>${keys}</kbd></div>`).join('')}</div><p>Fly straight toward a world to enter its atmosphere. Brake with S, steer over open ground, and descend with ↓. Touchdown is automatic when you are low and slow. Once landed, press E to leave the cockpit.</p><p>To leave a world, walk back to your ship and press E to board. Hold W and ↑ to lift off, then climb above 220 m to return to space. Fly through luminous rings for a boost and watch for hostile ships. Q performs a full evasive loop in space while preserving your forward speed.</p></div><div class="manual-section"><span class="tiny">02 / BOOTS ON THE GROUND</span><h3>Aim with your eyes.</h3><div class="controls-grid">${[
  ['Walk / strafe', 'W A S D'], ['Look / aim', 'MOUSE'], ['Fire pulse weapon', 'CLICK / SPACE'], ['Vector dash', 'SHIFT'], ['Set anchor / recall', 'Q'], ['Singularity ultimate', 'R'], ['Archive / board / exit ship', 'E'], ['System map / pause', 'M / ESC'],
].map(([action, keys]) => `<div class="control-row"><span>${action}</span><kbd>${keys}</kbd></div>`).join('')}</div><p>On desktop, click the world to capture your mouse. Move the mouse to aim in third person and use WASD to move relative to your view. Escape releases the mouse. Find the glowing archive to read. Defeat each world’s warden to earn the Starforged Explorer title and aurora thrusters.</p><p>On touchscreens, use the movement arrows and drag across the world to aim. Hold the fire button to shoot. The + and − flight buttons climb and descend; tap an ability to activate it.</p></div><p class="fine-print">The map’s Warp buttons are an optional shortcut. Every world can be reached by flying, and every portfolio section can be read from the navigation without combat, scores, or unlocks.</p>`;

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
  let achievementSignature = '';
  let controlContext = '';
  const defeatedWorlds = () => PLANETS.filter(planet => state.defeatedBosses?.includes(planet.id));
  const achievementEarned = () => state.achievement === 'Starforged Explorer';
  const text = (id, value) => { const node = byId(id); if (node && node.textContent !== String(value)) node.textContent = value; };
  const fraction = (id, value) => { const node = byId(id); if (node) node.style.width = `${clamp(value)}%`; };

  PLANETS.forEach(planet => {
    const button = document.createElement('button');
    button.className = 'map-dot';
    button.dataset.planet = planet.id;
    button.style.setProperty('--planet-color', planet.color);
    button.style.left = `${50 + planet.position[0] / 42}%`;
    button.style.top = `${50 + planet.position[2] / 49}%`;
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
    document.body.classList.add('has-toast');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toast.classList.remove('is-visible'); document.body.classList.remove('has-toast'); }, 4200);
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

  function renderAchievement(force = false) {
    const defeated = defeatedWorlds();
    const earned = achievementEarned();
    const signature = JSON.stringify([defeated.map(planet => planet.id), earned]);
    if (!force && signature === achievementSignature) return;
    achievementSignature = signature;
    text('dialog-eyebrow', earned ? 'EXPEDITION COMPLETE / ACHIEVEMENT EARNED' : 'FIVE WORLDS / FIVE WARDENS');
    dialogContent.innerHTML = `<div class="achievement-emblem${earned ? ' is-earned' : ''}" aria-hidden="true"><svg viewBox="0 0 96 96" fill="none"><path d="m48 9 11 24 26 3-19 18 5 27-23-13-23 13 5-27L11 36l26-3L48 9Z"/><circle cx="48" cy="48" r="44"/><circle cx="48" cy="48" r="35"/></svg></div><h2 id="dialog-title">${earned ? 'Starforged<br>Explorer.' : 'Five worlds.<br>One constellation.'}</h2><p class="dialog-lede">${earned ? 'Your explorer title and aurora thrusters are earned. Keep following your curiosity.' : `${defeated.length} of ${PLANETS.length} world wardens defeated in this expedition.`}</p>${earned ? '<div class="achievement-rewards"><span class="tiny">REWARDS EARNED</span><strong>Starforged Explorer</strong><p>Explorer title + aurora thruster cosmetic</p><span class="aurora-swatch" aria-hidden="true"></span></div>' : '<p>Land on each world and face its warden. Clear all five to earn the Starforged Explorer title and an aurora glow for your ship’s thrusters.</p>'}<span class="tiny achievement-run-label">THIS EXPEDITION · ${defeated.length} / ${PLANETS.length} WARDENS</span><ul class="warden-checklist">${PLANETS.map(planet => `<li class="${defeated.includes(planet) ? 'is-cleared' : ''}"><span style="--planet-color:${planet.color}" class="warden-world-dot" aria-hidden="true"></span><span>${planet.name}</span><span class="tiny">${defeated.includes(planet) ? 'DEFEATED' : 'AWAITING YOU'}</span></li>`).join('')}</ul><p class="fine-print">Portfolio reading stays available at every stage of your expedition.</p><div class="dialog-actions"><button class="button button-primary" data-close>${earned ? 'Keep exploring' : 'Continue expedition'} ${ARROW}</button><button class="button button-ghost" data-panel="map">View the system</button></div>`;
  }

  function openPanel(id) {
    if (id === 'leaderboard') id = 'scores';
    if (!CONTENT[id] && !['map', 'pause', 'controls', 'scores', 'achievement'].includes(id)) return;
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
      dialogContent.innerHTML = `<h2 id="dialog-title">Chart your<br>own course.</h2><p class="dialog-lede">Five worlds orbit BEACN. Fly your own approach, or take a shortcut.</p><ul class="map-destinations">${PLANETS.map(planet => `<li style="--planet-color:${planet.color}"><span class="planet-avatar" aria-hidden="true"></span><div><h3>${planet.name}</h3><p>${planet.description}</p><span class="tiny">${planet.terrain.toUpperCase()}${state.defeatedBosses?.includes(planet.id) ? ' / WARDEN DEFEATED' : state.visited?.includes(planet.id) ? ' / VISITED' : ''}</span></div><button class="warp-button" data-warp="${planet.id}" aria-label="Warp to ${planet.name}">WARP <span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg></span></button></li>`).join('')}</ul><div class="system-projects"><a href="https://beacn.space" target="_blank" rel="noopener noreferrer"><span class="tiny">THE CENTRAL SUN</span><strong>BEACN ${ARROW}</strong></a><a href="https://heard-us.vercel.app" target="_blank" rel="noopener noreferrer"><span class="tiny">FEATURED PROJECT</span><strong>Heard Us ${ARROW}</strong></a></div><p class="fine-print">Warp is an optional shortcut to a world’s surface. To land manually, fly toward a planet, brake in its atmosphere, and descend until touchdown. Open any portfolio section from the navigation at any time.</p>`;
    } else if (id === 'achievement') {
      renderAchievement(true);
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
    const onFoot = state.mode === 'surface' && !state.vehicle;
    const atmosphericFlight = state.mode === 'surface' && Boolean(state.vehicle);
    const inSpace = state.mode === 'space';
    document.body.dataset.vehicle = onFoot ? 'foot' : 'ship';
    document.body.classList.toggle('has-boss', Boolean(state.boss && state.boss.health > 0));
    document.body.classList.toggle('is-boosting', Boolean(state.boostActive));
    const nextContext = onFoot ? 'foot' : atmosphericFlight ? 'atmosphere' : 'space';
    if (nextContext !== controlContext) {
      controlContext = nextContext;
      const hints = document.querySelector('.controls-strip');
      hints.children[0].innerHTML = onFoot ? '<kbd>W</kbd><kbd>S</kbd> MOVE' : '<kbd>W</kbd><kbd>S</kbd> THRUST / BRAKE';
      hints.children[1].innerHTML = onFoot ? '<kbd>A</kbd><kbd>D</kbd> STRAFE' : '<kbd>A</kbd><kbd>D</kbd> STEER';
      byId('context-control').innerHTML = onFoot ? 'MOUSE LOOK · ESC RELEASES' : '<kbd>↑</kbd><kbd>↓</kbd> CLIMB / DESCEND';
    }
    text('mode-label', onFoot ? 'SURFACE EXPLORER' : atmosphericFlight ? state.landed ? 'SHIP LANDED' : 'ATMOSPHERIC FLIGHT' : 'ORBITAL EXPLORER');
    text('health-label', onFoot ? 'VITALS' : 'HULL');
    byId('speed-value').innerHTML = `${String(Math.abs(Math.round(state.speed || 0))).padStart(3, '0')} <small>M/S</small>`;
    byId('flight-telemetry').hidden = onFoot;
    text('altitude-label', atmosphericFlight ? `${Math.max(0, Math.round(state.altitude || 0))} M ALTITUDE` : 'DEEP SPACE');
    text('flight-activity', state.spaceEnemies > 0 && inSpace ? `${state.spaceEnemies} HOSTILES · ${state.ringCount || 0} RINGS` : `${state.ringCount || 0} RINGS`);
    byId('touch-flight').hidden = onFoot;
    text('dash-name', onFoot ? 'VECTOR DASH' : 'BOOST');
    text('dash-state', onFoot ? state.dashCooldown > 0 ? `${Math.ceil(state.dashCooldown)}s` : 'READY' : state.boostActive ? 'BOOSTING' : 'READY');
    byId('dash-button').setAttribute('aria-label', onFoot ? 'Vector dash, Shift' : 'Ship boost, Shift');
    text('recall-name', onFoot ? 'TEMPORAL ANCHOR' : 'EVASIVE LOOP');
    text('recall-state', onFoot ? state.recallActive ? `RECALL ${state.recallRemaining || ''}` : state.recallCooldown > 0 ? `${Math.ceil(state.recallCooldown)}s` : 'SET ANCHOR' : atmosphericFlight ? 'SPACE ONLY' : state.loopCooldown > 0 ? `${Math.ceil(state.loopCooldown)}s` : '360° · READY');
    byId('recall-button').disabled = atmosphericFlight;
    byId('recall-button').setAttribute('aria-label', onFoot ? 'Set temporal anchor or recall, Q' : atmosphericFlight ? 'Evasive loop available in space' : '360 degree evasive loop, Q');
    byId('ultimate-button').disabled = !onFoot;
    byId('ultimate-button').title = onFoot ? 'Singularity · R' : 'Singularity is available on foot';
    text('ultimate-state', !onFoot ? 'ON FOOT ONLY' : state.ultimate >= 100 ? 'READY' : `${Math.floor(clamp(state.ultimate))}%`);
    byId('ultimate-fill').style.setProperty('--charge', `${clamp(state.ultimate)}%`);
    byId('ultimate-button').classList.toggle('is-ready', onFoot && state.ultimate >= 100);
    const visited = state.visited || [];
    const defeated = defeatedWorlds();
    const earned = achievementEarned();
    text('visited-count', `${visited.length} / 5 WORLDS`);
    text('warden-count', `${defeated.length} / 5 WARDENS`);
    byId('warden-progress').setAttribute('aria-label', `View world warden progress, ${defeated.length} of 5 defeated${earned ? ', Starforged Explorer earned' : ''}`);
    byId('warden-progress').title = earned ? 'Starforged Explorer earned · View expedition progress' : 'Defeat all five wardens to earn Starforged Explorer';
    byId('warden-progress').classList.toggle('is-earned', earned);
    document.querySelectorAll('.warden-dots i').forEach((dot, index) => dot.classList.toggle('is-cleared', state.defeatedBosses?.includes(PLANETS[index].id)));
    document.querySelectorAll('.map-dot').forEach(dot => { dot.classList.toggle('is-visited', visited.includes(dot.dataset.planet)); dot.classList.toggle('is-cleared', Boolean(state.defeatedBosses?.includes(dot.dataset.planet))); });
    const boss = state.boss;
    const bossVisible = Boolean(boss && boss.health > 0);
    byId('boss-status').hidden = !bossVisible;
    if (bossVisible) {
      const health = clamp(boss.health / Math.max(1, Number(boss.maxHealth) || 1) * 100);
      text('boss-name', boss.name || 'World warden');
      text('boss-health-value', `${Math.ceil(health)}%`);
      fraction('boss-health-fill', health);
      byId('boss-health-track').setAttribute('aria-valuenow', String(Math.round(health)));
    }
    const p = planetFor(state.planetId);
    const near = planetFor(state.nearPlanet);
    const approach = planetFor(state.approachingPlanet);
    const target = planetFor(state.targetPlanet?.id || state.targetPlanet);
    if (onFoot) {
      text('objective-title', `${p?.name || 'World'} / ${bossVisible ? 'World warden' : 'Archive signal'}`);
      text('objective-detail', state.canInteract ? 'Press E to open the archive' : state.canEmbark ? 'Press E to board your ship' : bossVisible ? 'Keep moving. Defeat the warden, or explore the archive.' : 'Find the glowing archive. Explore at your own pace.');
      text('target-label', state.canInteract ? 'ARCHIVE IN RANGE' : state.canEmbark ? 'SHIP IN RANGE · E TO BOARD' : `${p?.title || 'SURFACE'} · ${state.weaponName || 'PULSE I'}`);
    } else if (atmosphericFlight) {
      text('objective-title', `${p?.name || 'World'} / ${state.landed ? 'Touchdown' : 'Atmospheric approach'}`);
      text('objective-detail', state.landed ? 'E to exit ship · W + ↑ to take off' : 'S to brake · ↓ to descend · land low and slow');
      text('target-label', state.landed ? 'LANDED · E TO EXIT SHIP' : `${Math.max(0, Math.round(state.altitude || 0))} M ALTITUDE · CLIMB ABOVE 220 M TO LEAVE`);
    } else {
      text('objective-title', approach ? `${approach.name} / Approach` : state.spaceEnemies > 0 ? 'Hostile ships on your route' : visited.length === 5 ? 'A universe well explored' : 'Explore the five worlds');
      text('objective-detail', approach ? 'Keep flying toward the world to enter its atmosphere' : state.spaceEnemies > 0 ? 'Aim and fire · Shift to boost · Q for an evasive loop' : 'Fly toward a world. Follow its approach signal.');
      text('target-label', target ? `NEAREST · ${target.name} / ${Math.round(state.targetPlanet?.distance || 0)} M${state.targetPlanet?.behind ? ' · BEHIND' : ''}` : near ? `${near.name} / ${Math.round(state.nearestDistance || 0)} M` : 'FOLLOW A SIGNAL');
    }
    const canInteract = atmosphericFlight ? Boolean(state.landed) : onFoot && Boolean(state.canInteract || state.canEmbark);
    byId('interaction').hidden = !canInteract;
    text('interact-label', atmosphericFlight ? 'Exit ship' : state.canInteract ? 'Open the archive' : 'Board ship');
    const mapPosition = state.mode === 'surface' && p ? { x: p.position[0], z: p.position[2] } : state.position || { x: 0, z: 120 };
    byId('map-player').style.left = `${clamp(50 + mapPosition.x / 42, 3, 97)}%`;
    byId('map-player').style.top = `${clamp(50 + mapPosition.z / 49, 3, 97)}%`;
    const soundButton = byId('sound-toggle');
    soundButton.setAttribute('aria-pressed', String(Boolean(state.sound)));
    soundButton.setAttribute('aria-label', state.sound ? 'Turn sound off' : 'Turn sound on');
    if (activePanel === 'achievement') renderAchievement();
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
