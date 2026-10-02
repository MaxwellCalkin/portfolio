import { escapeHTML, formatDistance, ARROW } from './format.js';

/**
 * The in-game HUD (index.html #u-hud). Pure DOM: the game pushes state in,
 * the HUD never reads game objects. Keyed nodes are reused every frame so
 * compass markers and world labels stay cheap.
 */
const $ = id => document.getElementById(id);
const setText = (el, value) => { const v = String(value); if (el && el.textContent !== v) el.textContent = v; };

export class HUD {
  constructor() {
    this.root = $('u-hud');
    this.el = {
      compass: $('u-compass-track'), worldName: $('u-world-name'), world: $('u-world'),
      objTitle: $('u-objective-title'), objDetail: $('u-objective-detail'), progD: $('u-progress-discoveries'), progS: $('u-progress-shards'),
      boss: $('u-boss'), bossName: $('u-boss-name'), bossFill: $('u-boss-fill'),
      crosshair: $('u-crosshair'), prompt: $('u-prompt'), promptKey: $('u-prompt-key'), promptText: $('u-prompt-text'),
      health: $('u-health'), healthValue: $('u-health-value'), shield: $('u-shield'), jet: $('u-jet'),
      flight: $('u-flight'), flightMode: $('u-flight-mode'), speed: $('u-speed'), altitude: $('u-altitude'),
      abilities: $('u-abilities'), ultCharge: $('u-ult-charge'), ultValue: $('u-ult-value'), weapon: $('u-weapon'),
      card: $('u-card'), cardEyebrow: $('u-card-eyebrow'), cardTitle: $('u-card-title'), cardText: $('u-card-text'), cardList: $('u-card-list'), cardActions: $('u-card-actions'), cardCount: $('u-card-count'),
      toasts: $('u-toasts'), labels: $('u-labels'), popups: $('u-popups'), controls: $('u-controls'),
      touch: $('u-touch'), stick: $('u-stick'),
    };
    this.abilityEls = Object.fromEntries([...this.el.abilities.querySelectorAll('[data-ability]')].map(n => [n.dataset.ability, n]));
    this.markers = new Map();
    this.labelEls = new Map();
    this.cardId = null;
    this.lastToast = { text: '', at: 0 };
    this.hitTimer = null;
  }

  setVisible(on) { this.root.setAttribute('aria-hidden', on ? 'false' : 'true'); }

  setWorld(spec) {
    if (!spec) { setText(this.el.worldName, 'DEEP SPACE'); this.root.style.setProperty('--world', '#c9e9ff'); return; }
    setText(this.el.worldName, `${spec.number} · ${spec.name.toUpperCase()}`);
    this.root.style.setProperty('--world', spec.color);
  }
  setObjective(title, detail) { setText(this.el.objTitle, title); setText(this.el.objDetail, detail); }
  setProgress(found, total, shards, shardTotal) {
    setText(this.el.progD, `${found} / ${total} discoveries`);
    setText(this.el.progS, `${shards} / ${shardTotal} shards`);
  }

  setVitals(health, shield, jet) {
    this.el.health.style.width = `${Math.max(0, Math.min(100, health))}%`;
    this.el.shield.style.width = `${Math.max(0, Math.min(100, shield))}%`;
    this.el.jet.style.width = `${Math.max(0, Math.min(100, jet))}%`;
    setText(this.el.healthValue, Math.ceil(Math.max(0, health)));
  }

  setFlight(on, { speed = 0, altitude = 0, mode = '' } = {}) {
    this.el.flight.hidden = !on;
    if (!on) return;
    setText(this.el.speed, Math.round(Math.abs(speed)).toLocaleString());
    setText(this.el.altitude, Number.isFinite(altitude) ? formatDistance(altitude) : 'DEEP SPACE');
    setText(this.el.flightMode, mode);
  }

  /** cooldowns: 0 = ready, 1 = just used. charge: 0..1 */
  setAbilities({ dash = 0, pulse = 0, charge = 0, weapon = 'PULSE I' }) {
    for (const [name, value] of [['dash', dash], ['pulse', pulse]]) {
      const el = this.abilityEls[name]; if (!el) continue;
      el.style.setProperty('--cd', value.toFixed(3));
      el.classList.toggle('is-ready', value <= 0);
    }
    const ult = this.abilityEls.drop;
    if (ult) {
      ult.style.setProperty('--charge', (charge * 100).toFixed(1));
      ult.classList.toggle('is-ready', charge >= 1);
      setText(this.el.ultValue, charge >= 1 ? 'READY' : `${Math.floor(charge * 100)}%`);
    }
    setText(this.el.weapon, weapon);
  }

  setPrompt(key, text) {
    if (!text) { this.el.prompt.hidden = true; return; }
    this.el.prompt.hidden = false;
    setText(this.el.promptKey, key); setText(this.el.promptText, text);
  }

  setBoss(name, fraction) {
    if (!name) { this.el.boss.hidden = true; return; }
    this.el.boss.hidden = false;
    setText(this.el.bossName, name);
    this.el.bossFill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  }

  /**
   * Shows a discovery card. `actions`: [{ label, href?, onClick?, key?, ghost? }]
   */
  showCard(id, { eyebrow, title, text, list, hint = '', actions = [], count = '' }) {
    const el = this.el;
    const same = this.cardId === id && !el.card.hidden;
    this.cardId = id;
    setText(el.cardEyebrow, eyebrow || 'DISCOVERY');
    setText(el.cardTitle, title || '');
    el.cardText.hidden = !text; setText(el.cardText, text || '');
    el.cardList.hidden = !list?.length;
    if (list?.length) el.cardList.innerHTML = list.map(item => `<li>${escapeHTML(item)}</li>`).join('');
    const hintEl = document.getElementById('u-card-hint');
    if (hintEl) { hintEl.hidden = !hint; setText(hintEl, hint || ''); }
    el.cardActions.innerHTML = '';
    for (const action of actions) {
      const node = document.createElement(action.href ? 'a' : 'button');
      if (action.href) {
        node.href = action.href;
        if (!action.href.startsWith('mailto:')) { node.target = '_blank'; node.rel = 'noopener noreferrer'; }
      } else node.type = 'button';
      if (action.ghost) node.className = 'is-ghost';
      node.innerHTML = `${action.key ? `<kbd>${escapeHTML(action.key)}</kbd>` : ''}${escapeHTML(action.label)}${action.href ? ` ${ARROW}` : ''}`;
      if (action.onClick) node.addEventListener('click', event => { event.preventDefault(); action.onClick(); });
      el.cardActions.append(node);
    }
    setText(el.cardCount, count);
    if (!same) { el.card.hidden = false; el.card.style.animation = 'none'; void el.card.offsetWidth; el.card.style.animation = ''; }
  }
  hideCard() { this.el.card.hidden = true; this.cardId = null; }
  get cardOpen() { return !this.el.card.hidden; }

  toast(text, tone = '') {
    const now = performance.now();
    if (text === this.lastToast.text && now - this.lastToast.at < 1500) return;
    this.lastToast = { text, at: now };
    const node = document.createElement('div');
    node.className = `u-toast${tone ? ` is-${tone}` : ''}`;
    node.textContent = text;
    this.el.toasts.append(node);
    while (this.el.toasts.children.length > 4) this.el.toasts.firstChild.remove();
    setTimeout(() => node.remove(), 4300);
  }

  hitmarker(kill = false) {
    const c = this.el.crosshair;
    c.classList.remove('is-hit', 'is-kill'); void c.offsetWidth;
    c.classList.add('is-hit'); if (kill) c.classList.add('is-kill');
    clearTimeout(this.hitTimer);
    this.hitTimer = setTimeout(() => c.classList.remove('is-hit', 'is-kill'), kill ? 260 : 140);
  }

  popup(x, y, text, big = false) {
    if (this.el.popups.children.length > 14) this.el.popups.firstChild.remove();
    const node = document.createElement('span');
    node.className = `u-popup${big ? ' is-big' : ''}`;
    node.style.left = `${x}px`; node.style.top = `${y}px`;
    node.textContent = text;
    this.el.popups.append(node);
    setTimeout(() => node.remove(), 820);
  }

  pulseBody(cls, ms = 450) {
    document.body.classList.remove(cls); void document.body.offsetWidth;
    document.body.classList.add(cls);
    clearTimeout(this[`t_${cls}`]);
    this[`t_${cls}`] = setTimeout(() => document.body.classList.remove(cls), ms);
  }

  /**
   * Compass markers. Each: { id, bearing (radians, + is right), kind, label, color, main, found, distance }
   */
  setCompass(markers) {
    const seen = new Set();
    for (const m of markers) {
      seen.add(m.id);
      let node = this.markers.get(m.id);
      if (!node) {
        node = document.createElement('span');
        node.className = 'u-marker';
        node.innerHTML = '<i></i><small></small>';
        this.el.compass.append(node);
        this.markers.set(m.id, node);
      }
      const limit = 1.75, b = Math.max(-limit, Math.min(limit, m.bearing));
      const edge = Math.abs(m.bearing) > limit;
      node.style.left = `${50 + (b / limit) * 50}%`;
      node.style.opacity = edge ? (m.main ? 0.85 : 0) : 1;
      node.className = `u-marker is-${m.kind}${m.main ? ' is-main' : ''}${m.found ? ' is-found' : ''}`;
      if (m.color) node.style.setProperty('--c', m.color);
      setText(node.lastChild, (m.main || m.kind === 'planet') && !m.quiet ? `${m.label ? `${m.label} · ` : ''}${formatDistance(m.distance)}` : '');
    }
    for (const [id, node] of this.markers) if (!seen.has(id)) { node.remove(); this.markers.delete(id); }
  }

  /** World labels: { id, x, y, title, sub, found, main, opacity } in CSS pixels. */
  setLabels(items) {
    const seen = new Set();
    for (const item of items) {
      seen.add(item.id);
      let node = this.labelEls.get(item.id);
      if (!node) {
        node = document.createElement('div');
        node.className = 'u-label';
        node.innerHTML = '<strong></strong><small></small>';
        this.el.labels.append(node);
        this.labelEls.set(item.id, node);
      }
      node.style.transform = `translate(${item.x.toFixed(1)}px, ${item.y.toFixed(1)}px) translate(-50%, -100%)`;
      node.style.opacity = item.opacity.toFixed(2);
      node.className = `u-label${item.found ? ' is-found' : ''}${item.main ? ' is-main' : ''}`;
      setText(node.firstChild, item.title); setText(node.lastChild, item.sub || '');
    }
    for (const [id, node] of this.labelEls) if (!seen.has(id)) { node.remove(); this.labelEls.delete(id); }
  }

  setTouch(on) { this.el.touch.hidden = !on; document.body.classList.toggle('is-touch', on); }
  stick(origin, offset) {
    const s = this.el.stick;
    if (!origin) { s.classList.remove('is-active'); return; }
    s.classList.add('is-active');
    s.style.left = `${origin.x}px`; s.style.top = `${origin.y}px`;
    s.firstChild.style.transform = `translate(${offset.x * 34}px, ${offset.y * 34}px)`;
  }

  setControls(mode) {
    const html = mode === 'ship'
      ? '<span><kbd>W</kbd><kbd>S</kbd> throttle</span><span><kbd>MOUSE</kbd> steer</span><span><kbd>A</kbd><kbd>D</kbd> turn</span><span><kbd>SHIFT</kbd> boost</span><span><kbd>E</kbd> land</span><span><kbd>M</kbd> travel</span>'
      : '<span><kbd>WASD</kbd> move</span><span><kbd>SPACE</kbd> jump · hold to jetpack</span><span><kbd>SHIFT</kbd> sprint</span><span><kbd>E</kbd> interact</span><span><kbd>M</kbd> map</span><span><kbd>J</kbd> journal</span>';
    if (this.controlsMode !== mode) { this.controlsMode = mode; this.el.controls.innerHTML = html; }
  }
}
