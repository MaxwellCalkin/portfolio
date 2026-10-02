import * as THREE from 'three';
import { Universe } from '../world/universe.js';
import { Flora } from '../world/flora.js';
import { Landmarks } from '../world/landmarks.js';
import { LAYOUTS } from '../world/layout.js';
import { loadModel, loadJSON } from '../engine/assets.js';
import { Input } from '../engine/input.js';
import { Post } from '../engine/post.js';
import { ColliderWorld, cylinderCollider } from '../actors/physics.js';
import { Agent } from '../actors/agent.js';
import { Player } from '../actors/player.js';
import { CameraRig } from '../actors/camera-rig.js';
import { Ship } from '../actors/ship.js';
import { FX } from '../gameplay/fx.js';
import { Combat, ABILITIES, makeSanctuary } from '../gameplay/combat.js';
import { Shards, SHARDS_PER_WORLD } from '../gameplay/shards.js';
import { Challenges } from '../gameplay/challenges.js';
import { DISCOVERIES, discoveriesFor, WORLD_ORDER } from '../gameplay/discoveries.js';
import { Soundscape } from '../audio/soundscape.js';
import { createProjectStars, PROJECT_LANDMARKS } from '../project-stars.js';
import { applyDamage } from '../model.js';
import { QUALITY, detectQuality } from './settings.js';
import { formatDistance, formatTime } from '../ui/format.js';

/**
 * The Unfolding: the game. One persistent star system, an agent on foot,
 * a ship, five portfolio worlds. This class wires the engine pieces together
 * and owns the frame loop, interaction rules and the HUD feed.
 */
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _p = new THREE.Vector3();
const SURFACE = { philosophy: 'grass', experience: 'sand', projects: 'crystal', mission: 'grass', contact: 'sand' };
const LAND_ALTITUDE = 1400;

export class Game {
  constructor({ canvas, hud, panels, settings, journal, run, onProgress }) {
    Object.assign(this, { canvas, hud, panels, settings, journal, run });
    this.onProgress = onProgress || (() => {});
    this.ready = false; this.started = false; this.playing = false; this.paused = false;
    this.mode = 'intro';
    this.time = 0; this.hudTimer = 0; this.soundTimer = 0;
    this.state = { health: 100, shield: 100, charge: 1, pulseCd: 0, fireCd: 0, lastFire: -9, lastHurt: -99, invuln: 0, emote: true, dead: false, deadTimer: 0 };
    this.planet = null; this.worldId = null;
    this.card = null;
    this.floraCols = []; this.floraColsAt = new THREE.Vector3(Infinity, 0, 0);
    this.lairs = new Map();
    this.perf = { frames: 0, time: 0, slow: 0, downgrades: 0 };
    const query = new URLSearchParams(location.search);
    this.forcedQuality = query.has('quality');
    this.maxDt = Math.min(0.5, Number(query.get('dt')) || 0.05); // ?dt= lets slow test machines simulate in real time
    this.profile = query.has('prof') ? {} : null;
  }

  /** QA helpers (used by dev/play.mjs; harmless in production). */
  get debug() {
    return {
      place: (x, z, faceX = 0, faceZ = -1e9) => {
        const planet = this.planet, p = Landmarks.placement(planet, x, z), f = Landmarks.placement(planet, faceX, faceZ === -1e9 ? z - 10 : faceZ);
        const facing = f.position.clone().sub(p.position); facing.addScaledVector(p.up, -facing.dot(p.up)).normalize();
        this.player.place(planet, p.position, facing); this.rig.lookAlong(p.up, facing, -0.12); this.#snapFootCamera();
      },
      info: () => ({ calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, geometries: this.renderer.info.memory.geometries, textures: this.renderer.info.memory.textures, flora: { ...this.flora.stats }, terrain: this.universe.stats().find(s => s.id === this.worldId), programs: this.renderer.info.programs?.length }),
      state: () => ({ mode: this.mode, world: this.worldId, ship: this.ship.state, pos: this.player.position.toArray().map(v => +v.toFixed(1)), alt: +this.universe.local.altitude.toFixed(1), time: +this.time.toFixed(2), card: this.card?.id ?? null, found: this.journal.progress().found, score: this.run.score }),
      interact: () => this.#interact(),
      board: () => this.#board(),
      aimNearest: () => {
        const p = this.player; let best = null, bestD = Infinity;
        for (const e of this.combat.enemies) { const d = e.center.distanceTo(p.position); if (d < bestD) { bestD = d; best = e; } }
        if (!best) return null;
        const to = best.center.clone().sub(p.position); const flat = to.clone().addScaledVector(p.up, -to.dot(p.up));
        const fl = flat.length(); this.rig.lookAlong(p.up, flat.normalize(), Math.atan2(to.dot(p.up) - 1.6, fl));
        return { name: best.name || best.mesh.userData.displayName, distance: +bestD.toFixed(1), hp: best.hp };
      },
      toShard: () => {
        const s = this.shards.nearest(this.player.position); if (!s) return null;
        const at = s.item.position.clone().addScaledVector(s.item.up, -1.6).add(new THREE.Vector3(3, 0, 0));
        this.player.place(this.planet, at, this.player.heading); this.#snapFootCamera();
        return { id: s.item.id, distance: +s.distance.toFixed(1) };
      },
      toPoi: name => {
        const world = this.landmarks.worlds.get(this.worldId); const poi = world?.pois.find(p => p.name === name || p.discovery?.id === name);
        if (!poi) return null;
        const at = poi.position.clone(), up = at.clone().sub(this.planet.center).normalize();
        this.player.position.copy(at).addScaledVector(up, 0.3); this.player.velocity.set(0, 0, 0); this.player.grounded = false; this.#snapFootCamera();
        return poi.name;
      },
      toLair: () => {
        const lair = this.lairs.get(this.worldId); if (!lair) return null;
        const up = lair.clone().sub(this.planet.center).normalize(), t = new THREE.Vector3(-up.z, 0, up.x).normalize();
        this.player.place(this.planet, lair.clone().addScaledVector(t, 60), t.clone().negate()); this.#snapFootCamera();
        return true;
      },
      enemies: () => this.combat.enemies.map(e => ({ boss: e.boss, hp: Math.round(e.hp), d: +e.center.distanceTo(this.player.position).toFixed(1) })),
    };
  }

  /* ================================================================ setup */
  async init() {
    this.quality = detectQuality(this.settings.get('quality'));
    const preset = QUALITY[this.quality];
    const renderer = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: preset.post === 'low', logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, preset.pixelRatio));
    renderer.setSize(innerWidth, innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.info.autoReset = false; // post-processing renders several passes; count the whole frame
    this.canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault(); this.lost = true;
      document.body.classList.add('is-error'); document.body.classList.remove('is-playing');
      document.getElementById('launch-note').textContent = 'The 3D view was interrupted. Reload to resume, or read the portfolio.';
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 900000);
    this.universe = new Universe(this.scene, { quality: preset.terrain });
    this.universe.sunLight.castShadow = preset.shadows;
    this.universe.sunLight.shadow.mapSize.set(preset.shadowSize, preset.shadowSize);
    this.post = new Post(renderer, this.scene, this.camera, preset.post);
    this.planets = new Map(this.universe.planets.map(p => [p.spec.id, p]));
    addEventListener('resize', () => this.resize());

    this.onProgress('Loading the agent');
    const [agent, ship, floraGltf, manifest] = await Promise.all([
      Agent.load(), Ship.load(), loadModel('flora.glb'), loadJSON('flora.json'),
      loadModel('landmarks-shared.glb'), loadModel('landmarks-philosophy.glb'),
    ]);
    this.onProgress('Shaping the worlds');
    this.agent = agent; this.ship = ship;
    this.scene.add(agent.root, ship.object);
    this.colliders = new ColliderWorld();
    this.flora = new Flora(this.scene, this.universe, floraGltf, manifest, { quality: preset.flora });
    this.landmarks = new Landmarks(this.scene, this.universe, this.colliders);
    this.projects = createProjectStars(this.scene);
    this.fx = new FX(this.scene, { reducedMotion: this.settings.reducedMotion });
    this.sound = new Soundscape({ volume: this.settings.get('volume') });
    this.combat = new Combat(this.scene, { fx: this.fx, sound: this.sound, events: this.#combatEvents() });
    this.shards = new Shards(this.scene, floraGltf);
    this.challenges = new Challenges(this.scene, { fx: this.fx, sound: this.sound, events: this.#challengeEvents() });
    this.player = new Player();
    this.rig = new CameraRig(this.camera);
    this.rig.reducedMotion = this.settings.reducedMotion;
    this.input = new Input(this.canvas);
    this.input.sensitivity = this.settings.get('sensitivity');
    this.input.invertY = this.settings.get('invertY');
    this.input.onLockChange = locked => this.#onLock(locked);
    this.input.onStick = (origin, offset) => this.hud.stick(origin, offset);
    this.gather = (pos, r) => {
      const out = this.colliders.query(pos, r + 2, this._query || (this._query = []));
      for (const c of this.floraCols) if (c.base.distanceToSquared(pos) < (r + c.radius + 3) ** 2) out.push(c);
      return out;
    };
    this.agent.onFootstep = speed => this.#footstep(speed);
    this.ship.onLanded = () => this.#shipLanded();
    this.#applyAurora();
    this.#bindTouch();
    this.#bindKeys();
    this.settings.onChange(patch => this.#applySettings(patch));

    const home = this.planets.get('philosophy');
    await this.landmarks.load(home);
    this.#arrive(home, { intro: true });
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.#frame());
    // Let the first view stream in before inviting the visitor in.
    this.onProgress('Growing the first world');
    const t0 = performance.now();
    await new Promise(resolve => {
      const check = () => {
        const stats = this.universe.stats().find(s => s.id === 'philosophy');
        if ((stats && stats.pending === 0 && this.flora.stats.instances > 0 && this.flora.stats.pending === 0) || performance.now() - t0 > 6000) resolve();
        else setTimeout(check, 120);
      };
      check();
    });
    this.ready = true;
    this.canvas.dataset.ready = 'true';
    // Load the other worlds' landmarks in the background so travel is instant.
    setTimeout(() => this.#preload(), 1500);
    return this;
  }

  async #preload() {
    for (const id of WORLD_ORDER) {
      try { await this.landmarks.load(this.planets.get(id)); } catch (error) { console.warn('landmark preload failed', id, error); }
      this.landmarks.setActive(this.worldId);
      await new Promise(r => setTimeout(r, 200));
    }
  }

  resize() {
    if (!this.renderer) return;
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.post.setSize(innerWidth, innerHeight);
  }

  #applySettings(patch) {
    if ('sound' in patch) { if (patch.sound) { this.sound.setEnabled(true); this.sound.unlock(); } else this.sound.setEnabled(false); }
    if ('volume' in patch) this.sound.setVolume(patch.volume);
    if ('sensitivity' in patch) this.input.sensitivity = patch.sensitivity;
    if ('invertY' in patch) this.input.invertY = patch.invertY;
    if ('reducedMotion' in patch) { this.rig.reducedMotion = this.fx.reducedMotion = this.settings.reducedMotion; }
    if ('quality' in patch) this.applyQuality(detectQuality(patch.quality));
  }

  applyQuality(quality) {
    this.quality = quality;
    const preset = QUALITY[quality];
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, preset.pixelRatio));
    this.universe.sunLight.castShadow = preset.shadows;
    if (preset.shadows) { this.universe.sunLight.shadow.mapSize.set(preset.shadowSize, preset.shadowSize); this.universe.sunLight.shadow.map?.dispose(); this.universe.sunLight.shadow.map = null; }
    this.post.setQuality(preset.post);
    this.resize();
  }

  /* ============================================================ lifecycle */
  start() {
    if (this.started || !this.ready) return;
    this.started = this.playing = true;
    this.run.reset();
    document.body.classList.add('is-playing');
    this.hud.setVisible(true);
    this.hud.setTouch(matchMedia('(pointer: coarse)').matches);
    if (this.settings.get('sound')) { this.sound.setEnabled(true); this.sound.unlock(); }
    this.sound.play('uiClick');
    this.state.emote = false;
    this.mode = 'foot';
    this.rig.setMode('foot', this.settings.reducedMotion ? 0.6 : 1.6);
    this.rig.lookAlong(this.player.up, this.site.spawn.forward, -0.12);
    this.turnTo = { dir: this.site.spawn.forward.clone(), t: 0.9 };
    this.input.enabled = true;
    this.input.requestLock();
    this.canvas.focus({ preventScroll: true });
    this.hud.setControls('foot');
    setTimeout(() => document.body.classList.add('hint-done'), 14000);
    this.hud.toast(this.journal.progress().found ? 'Welcome back. Your journal remembers what you found.' : 'Follow the marker to the Origin. Press E to read what you find.');
  }

  setPaused(on) {
    this.paused = on;
    this.run.pause(on);
    if (!this.input) return;
    this.input.enabled = !on && this.playing;
    if (on) { this.input.releaseLock(); this.input.reset(); this.fireHeld = false; }
    else if (this.playing && !matchMedia('(pointer: coarse)').matches) this.input.requestLock();
  }

  #onLock(locked) {
    document.body.classList.toggle('is-locked', locked);
    // Escape frees the cursor. With a discovery card open, that lets the
    // visitor click its links; otherwise it pauses.
    if (!locked && this.playing && !this.panels.isOpen && !this.leavingForLink && !this.card) this.panels.open('pause');
    this.leavingForLink = false;
  }

  onJournalReset() {
    this.shards.world = null;
    if (this.planet) this.shards.setWorld(this.planet, this.journal.data.shards);
  }

  #bindKeys() {
    addEventListener('keydown', event => {
      if (!this.playing || event.repeat) return;
      if (event.target?.closest?.('input, textarea, select')) return;
      const code = event.code;
      const open = this.panels.isOpen;
      if (code === 'KeyM') { event.preventDefault(); this.panels.toggle('map'); }
      else if (code === 'KeyJ' || (code === 'Tab' && !open)) { event.preventDefault(); this.panels.toggle('journal'); }
      else if (code === 'KeyH' && !open) this.panels.open('controls');
      else if (code === 'Escape' && !open && !this.input.locked) this.panels.open('pause');
    });
    addEventListener('blur', () => { this.input?.reset(); });
  }

  #bindTouch() {
    const buttons = document.querySelectorAll('[data-touch]');
    for (const button of buttons) {
      const action = button.dataset.touch;
      const down = event => {
        event.preventDefault(); button.setPointerCapture?.(event.pointerId);
        if (action === 'fire') { this.input.fire = true; this.input.pressed.add('fire'); }
        else if (action === 'map') this.panels.toggle('map');
        else this.input.press(action);
      };
      const up = () => { if (action === 'fire') this.input.fire = false; else this.input.release(action); };
      button.addEventListener('pointerdown', down);
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(name, up);
    }
  }

  /* ================================================================ world */
  #siteFor(planet) {
    if (!this.sites) this.sites = new Map();
    if (!this.sites.has(planet)) this.sites.set(planet, this.#computeSite(planet));
    return this.sites.get(planet);
  }
  #computeSite(planet) {
    const layout = LAYOUTS[planet.spec.id];
    const spawn = Landmarks.placement(planet, layout.spawn[0], layout.spawn[1]);
    const pad = Landmarks.placement(planet, layout.ship[0], layout.ship[1], layout.shipYaw ?? 0);
    pad.forward = new THREE.Vector3(0, 0, -1).applyQuaternion(pad.quaternion);
    const center = Landmarks.placement(planet, 0, 0);
    return { layout, spawn, pad, center };
  }

  /** Puts the agent at a world's main site, ship parked on its pad. */
  #arrive(planet, { intro = false } = {}) {
    this.#setContext(planet);
    const site = this.site = this.#siteFor(planet);
    this.ship.unregisterColliders(this.colliders);
    this.ship.park(site.pad.position.clone().addScaledVector(site.pad.up, 0.25), site.pad.up, site.pad.forward);
    this.ship.registerColliders(this.colliders);
    this.player.place(planet, site.spawn.position, intro ? site.spawn.forward.clone().negate() : site.spawn.forward);
    this.player.velocity.set(0, 0, 0);
    this.agent.root.visible = true;
    this.rig.lookAlong(this.player.up, site.spawn.forward, -0.1);
    this.combat.clear();
    this.hud.hideCard(); this.card = null;
    Object.assign(this.state, { health: 100, shield: 100, dead: false, invuln: 2.5 });
    if (!intro) { this.mode = 'foot'; this.rig.setMode('foot', 0.01); this.rig.blend = 1; this.#snapFootCamera(); }
  }

  #snapFootCamera() {
    // Place the camera directly behind the agent (no swoop) after a teleport.
    const p = this.player;
    this.rig.position.copy(p.position).addScaledVector(p.up, 1.8).addScaledVector(this.rig.viewHeading, -4.4);
    this.rig.updateFoot(0.016, p, { look: { x: 0, y: 0 }, aiming: false, sprinting: false, groundRadiusAt: this.#groundAt, center: p.planet.center });
  }

  get #groundAt() { const planet = this.planet; return dir => planet.shape.surfaceRadius(dir.x, dir.y, dir.z); }

  /** The world the agent (or ship) is engaged with: landmarks, shards, HUD. */
  #setContext(planet) {
    if (this.planet === planet) return;
    this.planet = planet;
    this.worldId = planet?.spec.id ?? null;
    this.canvas.dataset.world = this.worldId || '';
    if (!planet) { this.hud.setWorld(null); this.shards.setWorld(null, []); return; }
    this.sanctuary = makeSanctuary(planet);
    this.landmarks.load(planet).then(() => { this.landmarks.setActive(this.worldId); this.#buildLabels(planet.spec.id); });
    this.landmarks.setActive(planet.spec.id);
    this.shards.setWorld(planet, this.journal.data.shards);
    if (!this.lairs.has(planet.spec.id)) this.lairs.set(planet.spec.id, Combat.lairFor(planet));
    this.hud.setWorld(planet.spec);
    const first = !this.journal.data.visited.includes(planet.spec.id);
    this.journal.visit(planet.spec.id);
    if (this.started && first) this.hud.toast(`${planet.spec.number} · ${planet.spec.name}: ${planet.spec.title}`, 'gold');
  }

  /** Label text for each LABEL_ anchor of a world. */
  #buildLabels(worldId) {
    const world = this.landmarks.worlds.get(worldId); if (!world || world.labelInfo) return;
    world.labelInfo = world.labels.map(label => {
      const list = discoveriesFor(worldId).filter(d => d.landmark === label.landmark);
      if (/^LABEL_glyph_(\d)/.test(label.name)) {
        const tools = DISCOVERIES.find(d => d.id === 'experience:tools');
        return { ...label, title: tools.list[Number(label.name.slice(-1))] || '', sub: '', ids: [tools.id], small: true };
      }
      if (/^principle-/.test(label.landmark)) {
        const d = DISCOVERIES.find(x => x.id === `mission:${label.landmark}`);
        return d ? { ...label, title: d.title, sub: d.eyebrow, ids: [d.id], far: true } : null;
      }
      if (!list.length) return null;
      if (list.length > 1) return { ...label, title: 'Read the thinking', sub: `${list.length} ESSAYS`, ids: list.map(d => d.id) };
      const d = list[0];
      return { ...label, title: d.title, sub: d.eyebrow, ids: [d.id], main: d.kind === 'archive' };
    }).filter(Boolean);
  }

  /* ========================================================== frame loop */
  #frame() {
    if (this.lost) return;
    const dt = Math.min(this.clock.getDelta(), this.maxDt);
    this.renderer.info.reset();
    if (this.paused) { this.pausedFrames = (this.pausedFrames || 0) + 1; if (this.pausedFrames % 3) return; } else this.pausedFrames = 0;
    this.time += dt;
    const prof = this.profile, t = prof ? () => performance.now() : null;
    let mark = prof ? t() : 0;
    const lap = key => { if (!prof) return; const now = t(); prof[key] = (prof[key] || 0) * 0.9 + (now - mark) * 0.1; mark = now; };
    if (!this.paused) {
      if (this.mode === 'intro') this.#updateIntro(dt);
      else if (this.mode === 'foot') this.#updateFoot(dt);
      else if (this.mode === 'ship') this.#updateShip(dt);
      else if (this.mode === 'dead') this.#updateDead(dt);
      this.input.endFrame();
    }
    lap('sim');
    const focus = this.mode === 'ship' ? this.ship.object.position : this.player.position;
    this.camera.updateMatrixWorld();
    const local = this.universe.update(this.time, this.camera, focus);
    if (this.mode === 'ship' && local.planet && local.altitude < 30000) this.#setContext(local.planet);
    lap('universe');
    this.flora.update(focus, this.time);
    lap('flora');
    this.landmarks.update(this.time, dt);
    this.projects.update(this.time, dt);
    if (!this.paused) {
      this.#updateWorldSystems(dt);
      this.fx.update(dt);
    }
    lap('systems');
    this.#updateHUD(dt);
    lap('hud');
    this.#updateSound(dt);
    this.post.render(dt);
    lap('render');
    this.#monitorPerformance(dt);
  }

  /* ---------------------------------------------------------------- intro */
  #updateIntro(dt) {
    const p = this.player, up = p.up, s = this.site;
    this.agent.root.position.copy(p.position); this.player.orientation(this.agent.root.quaternion);
    this.agent.update(dt, { localVel: { x: 0, z: 0 }, grounded: true, emote: true, pitch: 0 });
    const center = _v.copy(p.position).addScaledVector(up, 1.15);
    const facing = _w.copy(p.heading);
    const sway = Math.sin(this.time * (this.settings.reducedMotion ? 0.05 : 0.11)) * 0.62 + 0.28;
    const dir = facing.clone().applyAxisAngle(up, sway);
    // Landscape: the agent stands right of the title. Portrait: below it.
    const wide = innerWidth / innerHeight > 1.15;
    const eye = center.clone().addScaledVector(dir, wide ? 5.2 : 7.4).addScaledVector(up, wide ? 0.55 : 0.9);
    const right = new THREE.Vector3().crossVectors(_u.copy(center).sub(eye).normalize(), up).normalize();
    const look = center.clone().addScaledVector(right, wide ? -1.7 : 0).addScaledVector(up, wide ? 0.1 : 2.3);
    const m = new THREE.Matrix4().lookAt(eye, look, up);
    this.camera.position.copy(eye); this.camera.quaternion.setFromRotationMatrix(m); this.camera.up.copy(up);
    this.rig.position.copy(eye); this.rig.quaternion.copy(this.camera.quaternion);
    void s;
  }

  /* ----------------------------------------------------------------- foot */
  #updateFoot(dt) {
    const input = this.input, p = this.player, s = this.state, planet = this.planet;
    const look = input.takeLook();
    const move = input.move;
    const aiming = input.aim, firing = input.fire;
    if (input.consume('interact')) this.#interact();
    if (input.consume('ability2')) this.#usePulse();
    if (input.consume('ultimate')) this.#useDrop();
    if (input.consume('emote')) this.#toggleEmote();
    const dash = input.consume('ability1');
    if (s.emote && (Math.hypot(move.x, move.y) > 0.1 || firing || aiming || !p.grounded)) s.emote = false;
    this.#refreshFloraColliders();
    p.dashed = false;
    p.update(dt, planet, { move, jump: input.down.has('jump'), jumpPressed: input.consume('jump'), sprint: input.down.has('sprint'), aim: aiming, dash }, this.rig.viewHeading, this.gather);
    if (p.dashed) { this.sound.play('dash'); this.agent.play('Dash'); this.fx.sparks(_v.copy(p.position).addScaledVector(p.up, 1), '#9ffcea', 10, 5); }
    else if (dash) this.sound.play('denied', { volume: 0.4 });
    if (p.jumped) { this.sound.play('jump'); this.agent.play('JumpStart', { layers: ['lower'] }); }
    if (p.landed && p.landSpeed > 3) { this.sound.play('land', { volume: Math.min(1, p.landSpeed / 14), surface: this.#surface() }); if (p.landSpeed > 9) this.agent.play('Land', { layers: ['lower'] }); }
    // Facing: combat stance faces the view, otherwise the body turns into its motion.
    const stance = aiming || firing || this.time - s.lastFire < 0.8;
    if (this.turnTo) { p.face(this.turnTo.dir, dt, 5); this.turnTo.t -= dt; if (this.turnTo.t <= 0) this.turnTo = null; }
    else if (stance) p.face(this.rig.viewHeading, dt, 20);
    else {
      const vt = _v.copy(p.velocity).addScaledVector(p.up, -p.velocity.dot(p.up));
      if (vt.lengthSq() > 0.4) p.face(vt, dt, p.sprinting ? 9 : 12);
    }
    this.rig.updateFoot(dt, p, { look, aiming, sprinting: p.sprinting, groundRadiusAt: this.#groundAt, center: planet.center });
    // Weapons and regen.
    s.fireCd -= dt; s.pulseCd = Math.max(0, s.pulseCd - dt); s.invuln = Math.max(0, s.invuln - dt);
    let fired = false;
    if (firing && s.fireCd <= 0 && !s.emote) { this.#fireWeapon(); fired = true; }
    s.charge = Math.min(1, s.charge + dt * 0.006);
    if (this.time - s.lastHurt > 3.5) s.shield = Math.min(100, s.shield + dt * 22);
    if (this.time - s.lastHurt > 7) s.health = Math.min(100, s.health + dt * 6);
    // Agent.
    this.agent.root.position.copy(p.position);
    p.orientation(this.agent.root.quaternion);
    this.agent.update(dt, { localVel: p.localVel, grounded: p.grounded, jetpack: p.jetting, sprint: p.sprinting, aiming, firing: stance, pitch: this.rig.pitch, emote: s.emote, firedThisFrame: fired });
    // Card closes when the visitor walks away.
    if (this.card && this.card.poi.position.distanceTo(p.position) > 9) { this.hud.hideCard(); this.card = null; }
    this.challenges.updatePads(this.landmarks.worlds.get(this.worldId), p, dt);
  }

  #refreshFloraColliders() {
    const p = this.player.position;
    if (this.floraColsAt.distanceToSquared(p) < 4) return;
    this.floraColsAt.copy(p);
    this.floraCols = this.flora.collidersNear(p, 12).map(c => {
      const base = new THREE.Vector3(c.x, c.y, c.z);
      return cylinderCollider(base, _u.copy(base).sub(this.planet.center).normalize(), c.radius, c.height, 'flora');
    });
  }

  #surface() {
    const p = this.player;
    if (p.wading) return 'water';
    return SURFACE[this.worldId] || 'rock';
  }

  #footstep(speed) {
    if (this.mode !== 'foot' || !this.player.grounded) return;
    this.sound.play('footstep', { surface: this.#surface(), volume: Math.min(1, 0.35 + speed / 12) });
  }

  /* ------------------------------------------------------------- shooting */
  #fireWeapon() {
    const s = this.state, w = this.run.weapon;
    s.fireCd = w.interval; s.lastFire = this.time;
    const camPos = this.camera.position, camDir = this.rig.forward;
    let distance = 260;
    const enemy = this.combat.raycast(camPos, camDir, 260);
    if (enemy) distance = enemy.distance;
    const ground = this.#rayTerrain(camPos, camDir, distance);
    if (ground !== null) distance = Math.min(distance, ground);
    const target = _p.copy(camPos).addScaledVector(camDir, Math.max(4, distance));
    const muzzle = this.agent.muzzleWorld(new THREE.Vector3());
    // Never shoot "backwards" through the agent when the target is very close.
    if (target.clone().sub(muzzle).dot(camDir) < 0.5) target.copy(muzzle).addScaledVector(camDir, 20);
    const dir = target.clone().sub(muzzle).normalize();
    for (let i = 0; i < w.bolts; i++) {
      const spread = (i - (w.bolts - 1) / 2) * 0.03;
      const d = dir.clone().applyAxisAngle(this.player.up, spread);
      this.combat.firePlayer(muzzle, muzzle.clone().addScaledVector(d, 50), { damage: w.damage, speed: 190 });
    }
    this.sound.play('fire', { tier: this.run.level });
    this.rig.shake = Math.max(this.rig.shake, 0.06);
  }

  /** Distance along a ray to the terrain (or null), by marching then refining. */
  #rayTerrain(origin, dir, max) {
    const planet = this.planet; if (!planet) return null;
    const c = planet.center, shape = planet.shape;
    const below = t => { const q = _w.copy(origin).addScaledVector(dir, t).sub(c); const r = q.length(); q.divideScalar(r); return r < shape.surfaceRadius(q.x, q.y, q.z); };
    let prev = 0, t = 0.5;
    while (t < max) {
      if (below(t)) { let a = prev, b = t; for (let i = 0; i < 7; i++) { const m = (a + b) / 2; if (below(m)) b = m; else a = m; } return b; }
      prev = t; t += Math.max(0.8, t * 0.12);
    }
    return null;
  }

  #usePulse() {
    const s = this.state, p = this.player;
    if (s.pulseCd > 0) { this.sound.play('denied', { volume: 0.5 }); return; }
    s.pulseCd = ABILITIES.pulse.cooldown;
    this.combat.pulse(_v.copy(p.position).addScaledVector(p.up, 0.2), p.up);
    this.sound.play('pulse');
    this.rig.shake = 0.5;
    this.agent.play('Fire', { layers: ['upper'] });
    // A little lift: the low end carries you.
    if (!p.grounded) p.velocity.addScaledVector(p.up, 5);
  }

  #useDrop() {
    const s = this.state, p = this.player;
    if (s.charge < 1) { this.sound.play('denied', { volume: 0.5 }); this.hud.toast('The Drop charges as you explore, collect and fight.'); return; }
    if (!this.combat.drop(_v.copy(p.position), p.up)) return;
    s.charge = 0;
    p.velocity.addScaledVector(p.up, 9); p.grounded = false;
    this.sound.setLoop('charge', true, { amount: 1 });
    this.agent.play('JumpStart', { layers: ['lower'] });
  }

  #toggleEmote() {
    if (!this.journal.data.riff) { this.sound.play('denied', { volume: 0.4 }); this.hud.toast('Find the groove on the Experience stage to unlock the air bass.'); return; }
    if (!this.player.grounded) return;
    this.state.emote = !this.state.emote;
  }

  /* ---------------------------------------------------------- interaction */
  #nearestPoi() {
    const world = this.landmarks.worlds.get(this.worldId); if (!world) return null;
    const chest = _v.copy(this.player.position).addScaledVector(this.player.up, 1);
    let best = null, bestD = 3.6;
    for (const poi of world.pois) {
      if (!poi.discovery || /^POI_pad_/.test(poi.name)) continue;
      const d = poi.position.distanceTo(chest);
      if (d < bestD) { bestD = d; best = poi; }
    }
    return best;
  }
  #nearShip() {
    if (this.ship.state !== 'landed') return false;
    const p = this.player.position;
    return this.ship.boardingPoint(_w).distanceTo(p) < 4.5 || this.ship.object.position.distanceTo(p) < 7.5;
  }

  #interact() {
    if (this.card && this.card.primary && this.card.poi.position.distanceTo(this.player.position) < 6) { this.card.primary(); return; }
    const poi = this.#nearestPoi();
    if (poi) { this.#read(poi); return; }
    if (this.#nearShip()) { this.#board(); return; }
  }

  #read(poi) {
    const d = poi.discovery, p = this.player;
    const fresh = this.journal.discover(d.id);
    const reward = this.run.reward(d.id, d.kind === 'archive' ? 'archive' : 'discovery');
    if (reward) this.state.charge = Math.min(1, this.state.charge + 0.12);
    this.sound.play(d.kind === 'archive' ? 'archiveOpen' : fresh ? 'discover' : 'uiClick');
    this.agent.play('Interact', { layers: ['upper'] });
    this.state.emote = false;
    if (fresh) {
      this.fx.ring(_v.copy(poi.position), p.up, this.planet.spec.color, 6, 0.8);
      this.fx.sparks(poi.position, this.planet.spec.color, 18, 5, p.up);
      const prog = this.journal.progress(this.worldId);
      if (prog.found === prog.total) this.#worldComplete();
    }
    const prog = this.journal.progress(this.worldId);
    const actions = []; let primary = null;
    if (d.panel) { primary = () => this.panels.open(d.panel); actions.push({ label: 'Open the full chapter', key: 'E', onClick: primary }); }
    if (d.challenge === 'arena') {
      primary = () => this.#startArena();
      actions.push({ label: this.challenges.arenaActive ? 'Run in progress' : 'Start the target run', key: 'E', onClick: primary });
    }
    if (d.link) { primary = () => this.#openLink(d.link); actions.push({ label: d.linkLabel || 'Open', href: d.link, key: 'E' }); }
    if (d.links) { primary = () => this.#openLink(d.links[0].url); d.links.forEach((l, i) => actions.push({ label: l.label, href: l.url, key: i === 0 ? 'E' : null, ghost: i > 0 })); }
    this.hud.showCard(d.id, { eyebrow: d.eyebrow, title: d.title, text: d.text, list: d.list, hint: d.hint || (d.challenge === 'arena' && this.journal.data.arenaBest ? `Best time ${formatTime(this.journal.data.arenaBest)}` : ''), actions, count: `${prog.found} / ${prog.total} ON ${this.planet.spec.name.toUpperCase()}${fresh ? ' · NEW' : ''}` });
    this.card = { poi, primary, id: d.id };
    this.canvas.dataset.discoveries = String(this.journal.progress().found);
  }

  #openLink(url) {
    this.leavingForLink = true;
    if (url.startsWith('mailto:')) location.href = url;
    else window.open(url, '_blank', 'noopener,noreferrer');
  }

  #worldComplete() {
    const spec = this.planet.spec;
    this.run.reward(`${spec.id}:complete`, 'world');
    this.sound.play('levelUp');
    const next = WORLD_ORDER.find(id => this.journal.progress(id).found < this.journal.progress(id).total);
    this.hud.toast(next ? `${spec.name} complete. Next: ${this.planets.get(next).spec.name} (press M).` : 'Every discovery found. Thank you for exploring.', 'gold');
  }

  /* ------------------------------------------------------------------ ship */
  #board() {
    if (this.mode !== 'foot' || this.ship.state !== 'landed') return;
    this.ship.unregisterColliders(this.colliders);
    this.agent.root.visible = false;
    this.mode = 'ship';
    this.state.emote = false;
    this.hud.hideCard(); this.card = null;
    this.hud.setControls('ship');
    this.rig.setMode('ship', 1.1);
    const up = _v.copy(this.ship.object.position).sub(this.planet.center).normalize();
    this.ship.takeoff(up);
    this.sound.play('shipBoard'); this.sound.play('takeoff');
    this.combat.clear();
  }

  #disembark() {
    const ship = this.ship, planet = this.universe.nearest(ship.object.position).planet;
    this.#setContext(planet);
    const point = ship.boardingPoint(new THREE.Vector3());
    this.player.place(planet, point, ship.forward(new THREE.Vector3()));
    this.agent.root.visible = true;
    this.mode = 'foot';
    this.hud.setControls('foot');
    this.rig.setMode('foot', 1.0);
    this.rig.lookAlong(this.player.up, ship.forward(new THREE.Vector3()), -0.1);
    ship.registerColliders(this.colliders);
    Object.assign(this.state, { invuln: 1.5 });
  }

  #shipLanded() {
    this.sound.play('shipLand');
    this.sound.setLoop('engine', false);
    setTimeout(() => { if (this.mode === 'ship' && this.ship.state === 'landed') this.#disembark(); }, 450);
  }

  #updateShip(dt) {
    const input = this.input, ship = this.ship, local = this.universe.local;
    const look = input.takeLook();
    const planet = local.planet;
    const radialUp = planet ? _u.copy(ship.object.position).sub(planet.center).normalize().clone() : null;
    const altitude = planet ? local.altitude : Infinity;
    if (input.consume('interact')) this.#shipInteract(planet, altitude);
    const touchYaw = input.touch.active ? -input.touch.moveX : 0;
    ship.update(dt, {
      pitch: input.down.has('jump') ? 1 : 0, yaw: (input.down.has('left') ? 1 : 0) - (input.down.has('right') ? 1 : 0) + touchYaw, roll: 0,
      throttleUp: input.down.has('forward') || (input.touch.active && input.touch.moveY < -0.3), throttleDown: input.down.has('back') || (input.touch.active && input.touch.moveY > 0.5),
      boost: input.down.has('sprint'), mouse: look,
    }, { radialUp, altitude, inAtmosphere: planet ? local.inAtmosphere : 0, groundRadiusAt: planet ? (dir => planet.shape.surfaceRadius(dir.x, dir.y, dir.z)) : null, planet, nearestDistance: altitude });
    this.state.fireCd -= dt;
    if (input.fire && this.state.fireCd <= 0 && ship.state === 'flying') this.#fireShip();
    if (ship.scraped) { ship.scraped = false; this.rig.shake = Math.max(this.rig.shake, 0.3); }
    this.rig.updateShip(dt, ship, { radialUp, altitude, boost: ship.boost || ship.pulse });
  }

  #fireShip() {
    this.state.fireCd = 0.12;
    const fwd = this.ship.forward(new THREE.Vector3());
    for (const m of this.ship.muzzles) {
      const origin = m.getWorldPosition(new THREE.Vector3());
      this.combat.firePlayer(origin, origin.clone().addScaledVector(fwd, 100), { damage: 45, speed: 520 + Math.max(0, this.ship.speed) });
    }
    this.sound.play('fire', { tier: 2, volume: 0.7 });
  }

  #shipInteract(planet, altitude) {
    const ship = this.ship;
    if (ship.state === 'landed') { this.#disembark(); return; }
    if (ship.state !== 'flying') return;
    const project = this.#nearProject();
    if (project) { this.#openLink(project.url); return; }
    if (!planet || altitude > LAND_ALTITUDE) { this.sound.play('denied'); this.hud.toast('Fly closer to a world to land, or press M for autopilot.'); return; }
    const spot = this.#landingSpot(planet);
    if (!spot) { this.sound.play('denied'); this.hud.toast('No flat ground below. Fly over land and try again.'); return; }
    ship.land(spot.position, spot.up);
    if (spot.pad) this.hud.toast(`Landing at ${planet.spec.title}.`);
  }

  /** Flat, dry ground near the ship (or the site's pad when close to it). */
  #landingSpot(planet) {
    const spec = planet.spec, shape = planet.shape, R = spec.radius, pos = this.ship.object.position;
    const dir = _v.copy(pos).sub(planet.center).normalize();
    const site = this.#siteFor(planet);
    const siteUp = site.center.up;
    if (Math.acos(THREE.MathUtils.clamp(dir.dot(siteUp), -1, 1)) * R < 1200) {
      return { position: site.pad.position.clone().addScaledVector(site.pad.up, 0.25), up: site.pad.up.clone(), pad: true };
    }
    const t1 = new THREE.Vector3(-dir.z, 0, dir.x).normalize(), t2 = new THREE.Vector3().crossVectors(dir, t1);
    for (let i = 0; i < 60; i++) {
      const a = i * 2.39996, r = i === 0 ? 0 : 6 + Math.sqrt(i) * 22;
      const d = dir.clone().multiplyScalar(R).addScaledVector(t1, Math.cos(a) * r).addScaledVector(t2, Math.sin(a) * r).normalize();
      const h = shape.heightAt(d.x, d.y, d.z);
      if (shape.seaLevel !== null && h < shape.seaLevel + 0.6) continue;
      let flat = true;
      for (const [ox, oz] of [[5, 0], [-5, 0], [0, 5], [0, -5]]) {
        const e = d.clone().multiplyScalar(R).addScaledVector(t1, ox).addScaledVector(t2, oz).normalize();
        if (Math.abs(shape.heightAt(e.x, e.y, e.z) - h) > 1.6) { flat = false; break; }
      }
      if (!flat) continue;
      return { position: planet.center.clone().addScaledVector(d, R + h), up: d.clone(), pad: false };
    }
    return null;
  }

  #nearProject() {
    const pos = this.ship.object.position;
    for (const p of [this.projects.beacn, this.projects.heardUs]) if (pos.distanceTo(p.position) < p.radius + 900) return p;
    return null;
  }

  /* ---------------------------------------------------------------- travel */
  travel(worldId) {
    const planet = this.planets.get(worldId);
    if (!planet || !this.ready || this.transition) return;
    if (!this.started) this.start();
    if (this.mode === 'ship' && (this.ship.state === 'flying' || this.ship.state === 'landed')) { this.#autopilot(planet); return; }
    this.#warp(planet);
  }

  async #warp(planet) {
    this.transition = true;
    this.sound.play('warpStart');
    document.body.classList.add('is-fading');
    await new Promise(r => setTimeout(r, this.settings.reducedMotion ? 120 : 420));
    try { await this.landmarks.load(planet); } catch (error) { console.warn(error); }
    if (this.mode === 'ship') { this.agent.root.visible = true; this.sound.setLoop('engine', false); this.sound.setLoop('boost', false); }
    this.#arrive(planet);
    this.hud.setControls('foot');
    // Give the terrain a moment to stream in under the fade.
    const t0 = performance.now();
    await new Promise(resolve => {
      const check = () => {
        const s = this.universe.stats().find(x => x.id === planet.spec.id);
        if ((s && s.pending < 2 && this.flora.stats.pending === 0) || performance.now() - t0 > 2600) resolve(); else setTimeout(check, 80);
      };
      setTimeout(check, 120);
    });
    document.body.classList.remove('is-fading');
    this.sound.play('warpEnd');
    this.transition = false;
  }

  #autopilot(planet) {
    const ship = this.ship;
    const go = () => {
      const site = this.#siteFor(planet), up = site.center.up;
      const from = ship.object.position.clone();
      const here = this.universe.nearest(from).planet;
      const fromUp = here ? from.clone().sub(here.center).normalize() : ship.up(new THREE.Vector3());
      const end = site.pad.position.clone().addScaledVector(up, 520);
      const c1 = from.clone().addScaledVector(fromUp, Math.max(4000, (here?.spec.radius || 4000) * 0.9));
      const c2 = end.clone().addScaledVector(up, planet.spec.radius * 1.4);
      ship.travelTo(c1, c2, end, () => {
        this.#setContext(planet);
        ship.land(site.pad.position.clone().addScaledVector(site.pad.up, 0.25), site.pad.up.clone());
      });
      this.sound.play('warpStart');
      this.hud.toast(`Autopilot: ${planet.spec.name}`);
    };
    if (ship.state === 'landed') { ship.takeoff(_v.copy(ship.object.position).sub(this.planet.center).normalize()); setTimeout(() => { if (ship.state === 'flying') go(); }, 1900); }
    else go();
  }

  respawn() {
    const planet = this.planet || this.planets.get('philosophy');
    if (this.mode === 'ship') { this.agent.root.visible = true; this.sound.setLoop('engine', false); }
    this.#arrive(planet);
    this.hud.setControls('foot');
  }

  /* ------------------------------------------------------- combat + pickups */
  #combatEvents() {
    return {
      onHit: (enemy, amount, at) => {
        this.hud.hitmarker(false);
        this.sound.play('hitmarker', { volume: 0.6 });
        const s = this.#toScreen(at); if (s) this.hud.popup(s.x, s.y, String(Math.round(amount)));
      },
      onKill: (enemy, ability) => {
        const before = this.run.level;
        this.run.kill(enemy.boss);
        this.state.charge = Math.min(1, this.state.charge + (enemy.boss ? 0.5 : ability ? 0.05 : 0.15));
        this.hud.hitmarker(true);
        this.sound.play('kill');
        const s = this.#toScreen(enemy.center); if (s) this.hud.popup(s.x, s.y, enemy.boss ? '+900' : '+110', true);
        if (enemy.boss) this.#wardenDefeated(enemy);
        if (this.run.level > before) { this.sound.play('levelUp'); this.hud.toast(`Weapon evolved: ${this.run.weapon.name}`, 'violet'); this.state.shield = 100; }
      },
      onDrop: () => {
        this.sound.setLoop('charge', false);
        this.sound.play('ultimate');
        this.rig.shake = 1.2;
        if (!this.settings.reducedMotion) this.hud.pulseBody('is-drop', 900);
        this.agent.play('Land', { layers: ['lower'] });
      },
      onBoltSegment: (start, end) => this.challenges.hitTest(start, end),
    };
  }

  #applyAurora() {
    let earned = this.journal.data.wardens.length >= 5;
    try { earned = earned || localStorage.getItem('unfolding-starforged-v1') === 'earned'; } catch { /* storage unavailable */ }
    this.ship.setAurora(earned); this.agent.setAurora(earned);
  }

  #wardenDefeated(enemy) {
    const id = enemy.planet.spec.id;
    const fresh = this.journal.addWarden(id);
    this.hud.toast(`${enemy.name || 'The warden'} defeated`, 'gold');
    this.sound.play('levelUp');
    if (fresh && this.journal.data.wardens.length >= 5) {
      try { localStorage.setItem('unfolding-starforged-v1', 'earned'); } catch { /* ignore */ }
      this.#applyAurora();
      setTimeout(() => this.panels.open('achievement'), 1600);
    }
  }

  #playerHit(amount, at) {
    const s = this.state;
    if (s.invuln > 0 || s.dead || this.mode !== 'foot') return;
    const hadShield = s.shield > 0;
    applyDamage(s, amount);
    if (hadShield && s.shield <= 0) this.sound.play('shieldBreak');
    if (amount >= 2) { this.sound.play('hurt', { volume: Math.min(1, amount / 15) }); this.hud.pulseBody('is-hurt', 420); this.rig.shake = Math.max(this.rig.shake, Math.min(0.5, amount / 25)); }
    s.lastHurt = this.time;
    if (s.health <= 0) this.#die();
    void at;
  }

  #die() {
    const s = this.state;
    s.dead = true; s.deadTimer = 2.4; s.emote = false;
    this.mode = 'dead';
    this.hud.toast('Signal lost. Re-forming at the site.', 'coral');
    this.sound.play('shieldBreak');
    document.body.classList.add('is-fading');
    this.hud.hideCard(); this.card = null;
  }
  #updateDead(dt) {
    const s = this.state;
    s.deadTimer -= dt;
    this.agent.update(dt, { localVel: { x: 0, z: 0 }, grounded: true, pitch: 0 });
    if (s.deadTimer <= 0) {
      this.#arrive(this.planet);
      document.body.classList.remove('is-fading');
      this.hud.setControls('foot');
    }
  }

  #challengeEvents() {
    return {
      onArena: (phase, arena) => {
        if (phase === 'start') { this.hud.toast(`Target run: hit ${arena.total} targets in ${arena.limit} seconds`, 'coral'); this.sound.play('gate'); }
        else if (phase === 'win') {
          const t = arena.t, best = this.journal.data.arenaBest;
          const record = !best || t < best;
          if (record) { this.journal.data.arenaBest = t; this.journal.save(); }
          this.run.reward('arena', 'arena');
          this.state.charge = Math.min(1, this.state.charge + 0.3);
          this.sound.play('levelUp');
          this.hud.toast(`Cleared in ${formatTime(t)}${record ? '. New best.' : `. Best ${formatTime(best)}.`}`, 'gold');
        } else { this.sound.play('denied'); this.hud.toast('Time. Try again at the arena console.'); }
      },
      onGroove: () => {
        const fresh = !this.journal.data.riff;
        this.journal.data.riff = true; this.journal.save();
        this.run.reward('groove', 'groove');
        this.sound.play('levelUp');
        this.hud.toast(fresh ? 'You found the groove. Press B to air bass.' : 'The groove. Press B to air bass.', 'violet');
        this.state.emote = true;
      },
    };
  }

  #startArena() {
    const world = this.landmarks.worlds.get(this.worldId);
    if (!world || this.challenges.arenaActive) return;
    if (this.challenges.startArena(world)) { this.hud.hideCard(); this.card = null; }
  }

  #updateWorldSystems(dt) {
    const p = this.player, planet = this.planet, onFoot = this.mode === 'foot';
    // Wardens wake when the agent comes near their lair.
    if (onFoot && planet) {
      const lair = this.lairs.get(planet.spec.id);
      if (lair && !this.journal.data.wardens.includes(planet.spec.id) && lair.distanceTo(p.position) < 240) this.combat.spawnWarden(planet, lair, false);
    }
    this.combat.update(dt, this.time, {
      player: p, planet: onFoot ? planet : null, onFoot, sanctuary: this.sanctuary || (() => true),
      playerHit: (dmg, at) => this.#playerHit(dmg, at), invulnerable: this.state.invuln > 0, colliders: this.colliders,
    });
    this.challenges.update(dt, this.time);
    const shard = this.shards.update(this.time, this.mode === 'ship' ? this.ship.object.position : p.position);
    if (shard && this.mode !== 'intro') this.#collectShard(shard);
  }

  #collectShard(shard) {
    const fresh = this.journal.addShard(shard.id);
    this.run.reward(shard.id, 'shard');
    this.state.charge = Math.min(1, this.state.charge + 0.2);
    this.sound.play('pickup');
    this.fx.sparks(shard.position, '#c9f7ff', 26, 7, shard.up);
    this.fx.ring(shard.position, shard.up, '#b9e9ff', 5, 0.6);
    const world = shard.id.split(':')[0];
    const n = this.journal.data.shards.filter(s => s.startsWith(`${world}:`)).length;
    if (fresh) this.hud.toast(n >= SHARDS_PER_WORLD ? `Every resonance shard on ${this.planets.get(world).spec.name} found.` : `Resonance shard ${n} / ${SHARDS_PER_WORLD}`, n >= SHARDS_PER_WORLD ? 'gold' : '');
    if (n >= SHARDS_PER_WORLD) this.run.reward(`${world}:shards`, 'world');
  }

  /* ------------------------------------------------------------------- HUD */
  #toScreen(world, out = { x: 0, y: 0 }) {
    _w.copy(world).applyMatrix4(this.camera.matrixWorldInverse);
    if (_w.z > -0.2) return null;
    _w.copy(world).project(this.camera);
    if (Math.abs(_w.x) > 1.1 || Math.abs(_w.y) > 1.1) return null;
    out.x = (_w.x + 1) * 0.5 * innerWidth; out.y = (1 - _w.y) * 0.5 * innerHeight;
    return out;
  }

  #updateHUD(dt) {
    if (!this.playing) return;
    const hud = this.hud, s = this.state, onFoot = this.mode === 'foot' || this.mode === 'dead';
    this.hudTimer -= dt;
    const slow = this.hudTimer <= 0;
    if (slow) this.hudTimer = 0.1;
    // Viewer frame for bearings.
    let eye, forward, right;
    if (onFoot) { eye = this.player.position; forward = this.rig.viewHeading; right = _u.crossVectors(forward, this.player.up).normalize().clone(); }
    else { eye = this.ship.object.position; forward = this.ship.forward(new THREE.Vector3()); right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.ship.object.quaternion); }
    const markers = [], labels = [];
    const bearing = target => { const d = _v.copy(target).sub(eye); return Math.atan2(d.dot(right), d.dot(forward)); };
    const world = this.landmarks.worlds.get(this.worldId);
    const objective = this.#objective(world);
    if (onFoot && world) {
      for (const item of world.items) {
        const list = discoveriesFor(this.worldId).filter(d => d.landmark === item.id);
        if (!list.length || list.every(d => this.journal.has(d.id))) continue;
        markers.push({ id: `lm:${item.id}`, bearing: bearing(item.position), kind: 'poi', main: objective.target === item, distance: item.position.distanceTo(eye), label: objective.target === item ? objective.short : '' });
      }
      if (this.ship.state === 'landed' && this.ship.object.position.distanceTo(eye) > 30) markers.push({ id: 'ship', bearing: bearing(this.ship.object.position), kind: 'ship', distance: this.ship.object.position.distanceTo(eye) });
      for (const item of this.shards.items) { const d = item.position.distanceTo(eye); if (d < 450) markers.push({ id: item.id, bearing: bearing(item.position), kind: 'shard', distance: d }); }
      const lair = this.lairs.get(this.worldId), archiveFound = discoveriesFor(this.worldId).some(d => d.kind === 'archive' && this.journal.has(d.id));
      if (lair && archiveFound && !this.journal.data.wardens.includes(this.worldId)) { const d = lair.distanceTo(eye); if (d < 1600) markers.push({ id: 'warden', bearing: bearing(lair), kind: 'warden', distance: d }); }
      // World labels.
      if (world.labelInfo) {
        for (const label of world.labelInfo) {
          const d = label.position.distanceTo(eye), range = label.main ? 140 : label.far ? 260 : label.small ? 22 : 70;
          if (d > range) continue;
          const sp = this.#toScreen(label.position, {}); if (!sp) continue;
          const found = label.ids.every(id => this.journal.has(id));
          labels.push({ id: label.name + label.landmark, x: sp.x, y: sp.y, title: label.title, sub: label.sub, found, main: label.main, opacity: (1 - THREE.MathUtils.smoothstep(d, range * 0.65, range)) * THREE.MathUtils.smoothstep(sp.y, 125, 175) });
        }
      }
    } else if (this.mode === 'ship') {
      const local = this.universe.local;
      for (const planet of this.universe.planets) {
        const d = planet.center.distanceTo(eye) - planet.spec.radius;
        const near = local.planet === planet && local.altitude < 6000;
        if (!near) { const b = bearing(planet.center); markers.push({ id: `planet:${planet.spec.id}`, bearing: b, kind: 'planet', color: planet.spec.color, label: Math.abs(b) < 0.22 ? planet.spec.name.toUpperCase() : '', distance: d, quiet: Math.abs(b) >= 0.22 }); }
        if (!near && d > 1500) {
          const sp = this.#toScreen(planet.center, {});
          if (sp) labels.push({ id: `pl:${planet.spec.id}`, x: sp.x, y: sp.y, title: planet.spec.name, sub: `${planet.spec.number} · ${formatDistance(d)}`, found: false, main: false, opacity: 0.95 });
        }
      }
      for (const p of [this.projects.beacn, this.projects.heardUs]) {
        const d = p.position.distanceTo(eye) - p.radius;
        const pb = bearing(p.position); markers.push({ id: `proj:${p.id}`, bearing: pb, kind: 'planet', color: p.id === 'beacn' ? '#c9b8ff' : '#e9c46a', label: Math.abs(pb) < 0.22 ? p.name.toUpperCase() : '', distance: d, quiet: Math.abs(pb) >= 0.22 });
        const sp = d > 400 && this.#toScreen(p.position, {});
        if (sp) labels.push({ id: `pj:${p.id}`, x: sp.x, y: sp.y, title: p.name, sub: `FEATURED PROJECT · ${formatDistance(d)}`, found: false, main: false, opacity: 0.9 });
      }
      if (local.planet && local.altitude < 6000 && this.site && this.planet === local.planet) {
        const site = this.#siteFor(local.planet);
        markers.push({ id: 'site', bearing: bearing(site.pad.position), kind: 'poi', main: true, label: 'LANDING PAD', distance: site.pad.position.distanceTo(eye) });
      }
    }
    hud.setCompass(markers);
    hud.setLabels(labels);
    if (!slow) return;
    // Slow-changing panels.
    hud.setObjective(objective.title, objective.detail);
    const prog = this.worldId ? this.journal.progress(this.worldId) : this.journal.progress();
    const shards = this.worldId ? this.journal.data.shards.filter(x => x.startsWith(`${this.worldId}:`)).length : this.journal.data.shards.length;
    hud.setProgress(prog.found, prog.total, shards, this.worldId ? SHARDS_PER_WORLD : SHARDS_PER_WORLD * 5);
    hud.setVitals(s.health, s.shield, this.player.jet);
    hud.setAbilities({ dash: this.player.dashCooldown / 2.6, pulse: s.pulseCd / ABILITIES.pulse.cooldown, charge: s.charge, weapon: this.run.weapon.name });
    const warden = this.combat.activeWarden;
    hud.setBoss(warden ? warden.name : null, warden ? warden.hp / warden.maxHp : 0);
    if (this.mode === 'ship') {
      const local = this.universe.local, ship = this.ship;
      const mode = { landed: 'LANDED', takeoff: 'TAKEOFF', landing: 'LANDING', autopilot: 'AUTOPILOT' }[ship.state] || (ship.pulse ? 'PULSE DRIVE' : local.inAtmosphere > 0.05 ? 'ATMOSPHERE' : 'OPEN SPACE');
      hud.setFlight(true, { speed: ship.speed, altitude: local.planet && local.altitude < 40000 ? local.altitude : Infinity, mode });
    } else hud.setFlight(false);
    document.body.classList.toggle('in-ship', this.mode === 'ship');
    document.body.classList.toggle('is-reading', Boolean(this.card));
    document.body.classList.toggle('is-emote', this.state.emote);
    // Interaction prompt.
    let prompt = null, key = 'E';
    if (this.mode === 'foot') {
      const poi = this.#nearestPoi();
      if (this.card?.primary && this.card.poi.position.distanceTo(this.player.position) < 6) prompt = null;
      else if (poi) prompt = this.journal.has(poi.discovery.id) ? `Read again: ${poi.discovery.title}` : `Read: ${poi.discovery.title}`;
      else if (this.#nearShip()) prompt = 'Board the Aster';
      else if (!this.input.locked && !matchMedia('(pointer: coarse)').matches && !this.panels.isOpen) { key = 'CLICK'; prompt = 'Look around'; }
    } else if (this.mode === 'ship') {
      const local = this.universe.local, project = this.#nearProject();
      if (this.ship.state === 'flying') {
        if (project) prompt = `Open ${project.name}`;
        else if (local.planet && local.altitude < LAND_ALTITUDE) prompt = `Land on ${local.planet.spec.name}`;
      } else if (this.ship.state === 'landed') prompt = 'Disembark';
    }
    hud.setPrompt(key, prompt);
    this.canvas.dataset.mode = this.mode;
  }

  /** What to do next, phrased for the visitor. */
  #objective(world) {
    if (this.mode === 'ship') {
      const local = this.universe.local, ship = this.ship;
      if (ship.state === 'autopilot') return { title: 'Autopilot engaged', detail: 'Sit back. Landing is automatic.' };
      if (ship.state === 'takeoff' || ship.state === 'landing') return { title: ship.state === 'takeoff' ? 'Taking off' : 'Landing', detail: 'Hold on.' };
      if (this.#nearProject()) { const p = this.#nearProject(); return { title: `${p.name}`, detail: `A featured project. Press E to open it in a new tab.` }; }
      if (local.planet && local.altitude < LAND_ALTITUDE) return { title: `Land on ${local.planet.spec.name}`, detail: 'Press E. The ship finds flat ground, or the pad near the site.' };
      if (local.planet && local.altitude < 30000) return { title: `Approaching ${local.planet.spec.name}`, detail: 'Descend to land, or press M to travel elsewhere.' };
      return { title: 'Open space', detail: 'Steer toward a world, or press M for autopilot. Shift engages the pulse drive.' };
    }
    if (!world || !this.planet) return { title: 'Explore', detail: '' };
    if (this.challenges.arenaActive) { const a = this.challenges.arena; return { title: `Target run · ${a.hits} / ${a.total}`, detail: `${Math.max(0, a.limit - a.t).toFixed(1)} seconds left` }; }
    const warden = this.combat.activeWarden;
    if (warden) return { title: `Defeat ${warden.name}`, detail: 'Or fall back to the sanctuary at the site.' };
    const id = this.worldId, list = discoveriesFor(id).filter(d => !this.journal.has(d.id));
    const itemFor = d => world.items.find(i => i.id === d.landmark);
    const archive = list.find(d => d.kind === 'archive');
    if (archive) { const item = itemFor(archive); return { title: `Read ${archive.title}`, detail: 'Follow the marker to the main archive.', target: item, short: archive.title.toUpperCase() }; }
    if (list.length) {
      let best = null, bestD = Infinity;
      for (const d of list) { const item = itemFor(d); if (!item) continue; const dist = item.position.distanceTo(this.player.position); if (dist < bestD) { bestD = dist; best = { d, item }; } }
      if (best) return { title: `Explore ${this.planet.spec.name}`, detail: `${list.length} ${list.length === 1 ? 'discovery' : 'discoveries'} left. Nearest: ${best.d.title}`, target: best.item, short: best.d.title.toUpperCase().slice(0, 28) };
    }
    const next = WORLD_ORDER.find(w => this.journal.progress(w).found < this.journal.progress(w).total);
    if (next) return { title: `${this.planet.spec.name} complete`, detail: `Next world: ${this.planets.get(next).spec.name}. Press M to travel, or board the ship.` };
    return { title: 'Every discovery found', detail: 'Thank you for exploring. Shards and wardens still await.' };
  }

  /* ----------------------------------------------------------------- sound */
  #updateSound(dt) {
    if (!this.started) return;
    this.sound.update(dt);
    const ship = this.ship;
    const flying = this.mode === 'ship' && ['flying', 'takeoff', 'landing', 'autopilot'].includes(ship.state);
    this.sound.setLoop('engine', flying, { throttle: Math.min(1, Math.abs(ship.speed) / 400), speed: ship.speed });
    this.sound.setLoop('boost', flying && (ship.boost || ship.pulse));
    this.sound.setLoop('jetpack', this.mode === 'foot' && this.player.jetting, { thrust: 1 });
    this.soundTimer -= dt;
    if (this.soundTimer > 0) return;
    this.soundTimer = 0.1;
    const local = this.universe.local;
    this.sound.setScene({
      world: local.planet && local.altitude < 25000 ? local.planet.spec.id : null,
      mode: this.mode === 'ship' ? 'ship' : 'foot', altitude: Number.isFinite(local.altitude) ? local.altitude : 1e6,
      speed: this.mode === 'ship' ? ship.speed : this.player.velocity.length(), combat: this.combat.threat,
      night: 1 - local.day, reading: this.paused || Boolean(this.card),
    });
  }

  /* ----------------------------------------------------------- performance */
  #monitorPerformance(dt) {
    if (!this.playing || this.paused || this.forcedQuality || this.settings.get('quality') !== 'auto') return;
    const perf = this.perf;
    perf.frames++; perf.time += dt;
    if (perf.time < 4) return;
    const fps = perf.frames / perf.time;
    perf.frames = 0; perf.time = 0;
    if (fps < 30) perf.slow++; else perf.slow = 0;
    if (perf.slow >= 2 && this.quality !== 'low' && perf.downgrades < 2) {
      perf.slow = 0; perf.downgrades++;
      this.applyQuality(this.quality === 'high' ? 'medium' : 'low');
      this.hud.toast('Graphics adjusted for smoother play.');
    }
    this.canvas.dataset.fps = fps.toFixed(0);
  }
}

export { PROJECT_LANDMARKS };
