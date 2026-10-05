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
import { SpaceFleet, leadPoint } from '../space/fleet.js';
import { SpaceDirector } from '../space/director.js';
import { SpaceScenery } from '../space/scenery.js';
import { Slipstream, RACE_LIMITS } from '../space/slipstream.js';
import { SpeedLines } from '../space/speedlines.js';
import { FIELD_RADIUS, RIFTS, riftById } from '../space/rifts.js';
import { TONE, levelOf, loadout } from '../space/pedals.js';
import { Combat, ABILITIES, makeSanctuary } from '../gameplay/combat.js';
import { Shards, SHARDS_PER_WORLD } from '../gameplay/shards.js';
import { Challenges } from '../gameplay/challenges.js';
import { DISCOVERIES, discoveriesAt, discoveriesFor, WORLD_ORDER } from '../gameplay/discoveries.js';
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
/** Inside a rift's field the Aster flies at dogfight speeds. */
const FIELD_LIMITS = { max: 520, boost: 820 };
const STREAK_CALLS = { 2: 'DOUBLE STOP', 3: 'TRIPLET', 5: 'IN THE POCKET', 8: 'SHREDDING', 12: 'STANDING OVATION' };
const ROMAN = ['', 'I', 'II', 'III'];

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
    // The Aster in deep space: hull and shields, missiles, combos, a respawn after going down.
    this.aster = { hull: 100, shield: 100, lastHit: -99, invuln: 0, down: false, downTimer: 0, respawn: null, missileCd: 0, echoes: [], reverbs: [], nova: null, streak: 0, lastKill: -99, aim: null, lead: new THREE.Vector3(), slowmo: 0, rollSide: 1, inField: false };
    this.shipPrev = new THREE.Vector3();
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
      space: {
        /** Flies the Aster to just outside a rift's field, facing it. */
        toRift: (id, inside = 0) => {
          const rift = riftById(id); if (!rift) return null;
          const center = new THREE.Vector3(...rift.position), from = center.clone().add(new THREE.Vector3(0.3, 0.2, 1).normalize().multiplyScalar(FIELD_RADIUS + 400 - inside));
          this.#enterFlight(from, center.clone().sub(from));
          return this.debug.space.state();
        },
        /** Puts the Aster just before a circuit gate (0 = the start line). */
        toGate: (i = 0) => {
          const gate = this.slipstream.circuit[i]; if (!gate) return null;
          this.#enterFlight(gate.center.clone().addScaledVector(gate.normal, -700), gate.normal.clone(), 600);
          return this.debug.space.state();
        },
        killAll: () => { for (const t of [...this.fleet.targets()]) this.fleet.damage(t.enemy, 1e6, t.position, { part: t.part }); return this.fleet.count(); },
        state: () => {
          const enc = this.director.encounter, race = this.slipstream.race;
          return {
            mode: this.mode, ship: this.ship.state, enemies: this.fleet.count(), tone: this.journal.data.tone, hull: Math.round(this.aster.hull), shield: Math.round(this.aster.shield), down: this.aster.down,
            encounter: enc ? { rift: enc.rift.id, wave: enc.wave, waves: enc.waves.length, phase: enc.phase } : null,
            race: race ? { next: race.next, t: +race.t.toFixed(2) } : null, pedals: { ...this.journal.data.pedals },
          };
        },
      },
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
    // Deep space: rifts and their Static, slipstream gates, speed.
    this.spaceFx = new FX(this.scene, { reducedMotion: this.settings.reducedMotion, scale: 14 });
    this.scenery = new SpaceScenery(this.scene);
    this.fleet = new SpaceFleet(this.scene, { fx: this.spaceFx, sound: this.sound, scenery: this.scenery, events: this.#fleetEvents() });
    this.director = new SpaceDirector({ fleet: this.fleet, events: this.#directorEvents(), clears: id => this.journal.riftClears(id) });
    this.slipstream = new Slipstream(this.scene, { events: this.#slipstreamEvents() });
    this.speedLines = new SpeedLines(this.scene);
    for (const rift of RIFTS) if (this.journal.riftClears(rift.id)) this.scenery.setState(rift.id, 'silenced');
    this.applyLoadout();
    this.aster.shield = this.loadout.shieldMax;
    this.hud.setTone(this.journal.data.tone);
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
    if ('reducedMotion' in patch) { this.rig.reducedMotion = this.fx.reducedMotion = this.spaceFx.reducedMotion = this.settings.reducedMotion; }
    if ('quality' in patch) this.applyQuality(detectQuality(patch.quality));
    if (patch.patrols === false) this.fleet.despawn('patrol');
  }

  /** Re-reads the engaged pedals (after a purchase on the pedalboard). */
  applyLoadout() {
    this.loadout = loadout(this.journal.data.pedals);
    this.aster.shield = Math.min(this.aster.shield, this.loadout.shieldMax);
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
      else if (code === 'KeyU') { event.preventDefault(); this.panels.toggle('pedals'); }
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
    this.challenges.cancelArena();
    this.#leaveSpace();
    this.hud.hideCard(); this.card = null;
    Object.assign(this.state, { health: 100, shield: 100, dead: false, invuln: 2.5 });
    if (!intro) { this.mode = 'foot'; this.rig.setMode('foot', 0.01); this.rig.blend = 1; this.#snapFootCamera(); }
  }

  /** Back on the ground: the fight, the race and the damage stay in space. */
  #leaveSpace() {
    this.director.abort('left');
    this.fleet.clear();
    this.slipstream.abortRace();
    if (this.aster.nova) this.sound.setLoop('charge', false);
    Object.assign(this.aster, { hull: 100, shield: this.loadout.shieldMax, down: false, invuln: 0, echoes: [], reverbs: [], nova: null, aim: null, streak: 0 });
    this.ship.object.visible = true;
    document.body.classList.remove('in-static');
  }

  /** Puts the Aster in flight at `position` (debug, autopilot-free jumps), switching to ship mode if needed. */
  #enterFlight(position, facing, speed = 160) {
    if (this.mode !== 'ship') {
      this.ship.unregisterColliders(this.colliders);
      this.agent.root.visible = false;
      this.mode = 'ship'; this.state.emote = false;
      this.hud.hideCard(); this.card = null;
      this.hud.setControls('ship');
      this.rig.setMode('ship', 0.01);
      this.combat.clear();
      this.challenges.cancelArena();
    }
    this.ship.launchAt(position, facing, new THREE.Vector3(0, 1, 0), speed);
    this.shipPrev.copy(position);
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
      const list = discoveriesAt(worldId, label.landmark);
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
    let dt = Math.min(this.clock.getDelta(), this.maxDt);
    if (this.aster.slowmo > 0) { this.aster.slowmo -= dt; dt *= 0.35; } // the Dissonance falling
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
    this.scenery.update(this.time, dt);
    const inShip = this.mode === 'ship';
    this.speedLines.update(this.camera.position, inShip ? this.ship.velocity : _p.set(0, 0, 0), inShip && !this.aster.down ? 1 - local.inAtmosphere : 0, inShip && this.ship.pulse);
    if (!this.paused) {
      this.#updateWorldSystems(dt);
      this.fx.update(dt);
      this.spaceFx.update(dt);
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
    this.challenges.updatePads(this.landmarks.worlds.get(this.worldId), p);
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
    const poi = this.#nearestPoi();
    // A second press acts on the open card, unless another landmark is now closer.
    if (this.card?.primary && (!poi || poi === this.card.poi) && this.card.poi.position.distanceTo(this.player.position) < 6) { this.card.primary(); return; }
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
      this.#reward(TONE.discovery);
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
    let hint = d.hint || '';
    if (d.id === 'experience:bass') hint = this.journal.data.riff ? 'You found the groove. Press B to air bass.' : 'Step on the pads to play (1 to 8, left to right). The groove: 1, 4, 5, 4, 6, 5.';
    if (d.challenge === 'arena') hint = this.journal.data.arenaBest ? `Best time ${formatTime(this.journal.data.arenaBest)}. Hit 8 targets in 35 seconds.` : 'Hit 8 targets in 35 seconds.';
    this.hud.showCard(d.id, { eyebrow: d.eyebrow, title: d.title, text: d.text, list: d.list, hint, actions, count: `${prog.found} / ${prog.total} ON ${this.planet.spec.name.toUpperCase()}${fresh ? ' · NEW' : ''}` });
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
    this.shipPrev.copy(this.ship.object.position);
    this.sound.play('shipBoard'); this.sound.play('takeoff');
    this.combat.clear();
    this.challenges.cancelArena();
  }

  #disembark() {
    const ship = this.ship, planet = this.universe.nearest(ship.object.position).planet;
    this.#leaveSpace();
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
    const input = this.input, ship = this.ship, local = this.universe.local, a = this.aster, lo = this.loadout;
    const look = input.takeLook();
    const planet = local.planet;
    const radialUp = planet ? _u.copy(ship.object.position).sub(planet.center).normalize().clone() : null;
    const altitude = planet ? local.altitude : Infinity;
    if (a.down) { this.#updateShipDown(dt, { radialUp, altitude }); return; }
    if (input.consume('interact')) this.#shipInteract(planet, altitude);
    this.shipPrev.copy(ship.object.position);
    // Incursions jam the pulse drive and hold fights to dogfight speeds; races cap speed so gates stay hittable.
    const field = this.director.encounter ? this.director.fieldAt(ship.object.position) : null, racing = this.slipstream.racing;
    const limits = field ? { max: FIELD_LIMITS.max, boost: FIELD_LIMITS.boost * lo.boost, pulse: false }
      : racing ? { max: RACE_LIMITS.max, boost: RACE_LIMITS.boost * lo.boost, pulse: false } : { boostScale: lo.boost };
    const touchYaw = input.touch.active ? -input.touch.moveX : 0;
    ship.update(dt, {
      pitch: input.down.has('jump') ? 1 : 0, yaw: (input.down.has('left') ? 1 : 0) - (input.down.has('right') ? 1 : 0) + touchYaw, roll: 0,
      throttleUp: input.down.has('forward') || (input.touch.active && input.touch.moveY < -0.3), throttleDown: input.down.has('back') || (input.touch.active && input.touch.moveY > 0.5),
      boost: input.down.has('sprint'), mouse: look,
    }, { radialUp, altitude, inAtmosphere: planet ? local.inAtmosphere : 0, groundRadiusAt: planet ? (dir => planet.shape.surfaceRadius(dir.x, dir.y, dir.z)) : null, planet, nearestDistance: altitude, limits });
    const flying = ship.state === 'flying';
    if (Boolean(field) !== a.inField) { a.inField = Boolean(field); document.body.classList.toggle('in-static', a.inField); }
    // Weapons and moves.
    this.state.fireCd -= dt; a.missileCd = Math.max(0, a.missileCd - dt);
    if (flying) {
      if (input.fire && this.state.fireCd <= 0) this.#fireCannons();
      if (input.aim || input.consume('ability2')) this.#fireMissiles();
      if (input.consume('ability1')) this.#barrelRoll(input);
      if (input.consume('ultimate')) this.#nova();
    }
    this.#updateDelayed(dt);
    // Gates, encounters, the Static.
    this.slipstream.update(dt, this.time, this.shipPrev, ship.object.position, { active: flying });
    this.director.update(dt, { position: ship.object.position, forward: ship.forward(_w), flying, patrols: this.settings.get('patrols') !== false, quiet: Boolean(planet && altitude < 9000) || this.slipstream.racing });
    this.fleet.update(dt, this.time, {
      ship: { position: ship.object.position, velocity: ship.velocity, radius: 7, evading: ship.evading || a.invuln > 0 || !flying, ram: lo.ram && (ship.boost || ship.surge > 100) },
      hitShip: (amount, at, kind) => this.#shipHit(amount, at, kind),
    });
    this.#rocks();
    this.#shipVitals(dt);
    if (ship.scraped) { ship.scraped = false; this.rig.shake = Math.max(this.rig.shake, 0.3); }
    this.rig.updateShip(dt, ship, { radialUp, altitude, boost: ship.boost || ship.pulse || ship.surge > 120 });
    this.#updateAim();
    this.#spaceHint(planet, altitude);
  }

  /** First time out of the atmosphere: point at the fun. */
  #spaceHint(planet, altitude) {
    if (this.spaceHinted || this.ship.state !== 'flying' || (planet && altitude < 12000)) return;
    this.spaceHinted = true;
    if (this.director.encounter || this.slipstream.racing) return; // busy: the banners have better things to say
    this.hud.banner('DEEP SPACE', 'Static rifts (red) and the slipstream circuit (gold) are on your compass. U opens the pedalboard.', 'gold');
  }

  /* --------------------------------------------------------- the Aster's arsenal */
  #muzzleCenter(out) {
    const muzzles = this.ship.muzzles;
    if (!muzzles.length) return out.copy(this.ship.object.position);
    out.set(0, 0, 0);
    for (const m of muzzles) out.add(m.getWorldPosition(_p));
    return out.divideScalar(muzzles.length);
  }
  /** Where the guns point: the lead point of the target nearest the reticle (aim assist), else straight ahead. */
  #gunDirection(origin, out) {
    const fwd = this.ship.forward(_w), aim = this.aster.aim;
    if (aim && out.copy(aim.lead).sub(origin).normalize().dot(fwd) > 0.994) return out; // within ~6° of the nose
    return out.copy(fwd);
  }
  #fireCannons() {
    const lo = this.loadout;
    this.state.fireCd = lo.fireInterval;
    const origin = this.#muzzleCenter(new THREE.Vector3());
    this.#volley(origin, this.#gunDirection(origin, new THREE.Vector3()), lo.damage);
    if (lo.echo > 0) this.aster.echoes.push({ t: 0.16, damage: lo.damage * lo.echo });
    this.sound.play('fire', { tier: Math.min(4, 1 + levelOf(this.journal.data.pedals, 'overdrive')), volume: 0.6 });
  }
  #volley(origin, dir, damage) {
    const lo = this.loadout, ship = this.ship, up = ship.up(_u), right = _v.crossVectors(dir, up).normalize();
    for (let i = 0; i < lo.bolts; i++) {
      const off = i - (lo.bolts - 1) / 2;
      this.fleet.firePlayer(origin.clone().addScaledVector(right, off * 1.6), dir.clone().applyAxisAngle(up, off * lo.spread), damage, ship.velocity);
    }
  }
  #fireMissiles() {
    const lo = this.loadout, a = this.aster;
    if (!lo.missiles) { if (!a.missileHint) { a.missileHint = true; this.hud.toast('Engage the Harmonics pedal (press U) for homing missiles.'); } return; }
    if (a.missileCd > 0) return;
    a.missileCd = lo.missileCooldown;
    const ship = this.ship, fwd = ship.forward(new THREE.Vector3()), up = ship.up(new THREE.Vector3()), right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const target = a.aim?.target || this.fleet.aimTarget(ship.object.position, fwd, 0.7, 3200);
    for (let i = 0; i < lo.missiles; i++) {
      const side = i % 2 ? 1 : -1, row = Math.floor(i / 2);
      const origin = ship.object.position.clone().addScaledVector(right, side * (4 + row * 1.5)).addScaledVector(up, 1.2 - row);
      const velocity = ship.velocity.clone().addScaledVector(right, side * (70 + row * 30)).addScaledVector(fwd, 140).addScaledVector(up, row * 25 - 10);
      this.fleet.fireMissile(origin, velocity, target, lo.missileDamage);
    }
    this.sound.play('missile');
  }
  #barrelRoll(input) {
    const a = this.aster, dir = input.down.has('left') ? -1 : input.down.has('right') ? 1 : (a.rollSide = -a.rollSide);
    if (this.ship.barrelRoll(dir)) this.sound.play('dash', { pitch: 0.8 });
    else this.sound.play('denied', { volume: 0.3 });
  }
  /** The Drop, in space: a shockwave that lands on the beat of the riser. */
  #nova() {
    const s = this.state;
    if (s.charge < 1) { this.sound.play('denied', { volume: 0.5 }); this.hud.toast('The Drop charges as you fight, race and explore.'); return; }
    s.charge = 0;
    this.aster.nova = { t: 0.95 };
    this.sound.play('ultimate');
    this.sound.setLoop('charge', true, { amount: 1 });
    this.spaceFx.ring(this.ship.object.position, this.ship.forward(_v), '#c9a6ff', 60, 0.95);
  }
  #updateDelayed(dt) {
    const a = this.aster, ship = this.ship;
    for (let i = a.echoes.length - 1; i >= 0; i--) {
      if ((a.echoes[i].t -= dt) > 0) continue;
      if (ship.state === 'flying') { const origin = this.#muzzleCenter(new THREE.Vector3()); this.#volley(origin, this.#gunDirection(origin, new THREE.Vector3()), a.echoes[i].damage); }
      a.echoes.splice(i, 1);
    }
    for (let i = a.reverbs.length - 1; i >= 0; i--) {
      const r = a.reverbs[i];
      if ((r.t -= dt) > 0) continue;
      a.reverbs.splice(i, 1);
      this.spaceFx.ring(r.at, _v.set(0, 1, 0), '#e2b8ff', 170, 0.45);
      this.fleet.blast(r.at, 170, 90, 'reverb');
    }
    if (a.nova && (a.nova.t -= dt) <= 0) {
      a.nova = null;
      const at = ship.object.position.clone(), up = ship.up(_u);
      for (const [color, size, life] of [['#c9a6ff', 1100, 1.4], ['#8cf0d1', 850, 1.1], ['#ffffff', 520, 0.7]]) this.spaceFx.ring(at, up, color, size, life);
      this.spaceFx.flash(at, '#e8dcff', 900, 0.5);
      this.sound.setLoop('charge', false);
      this.rig.shake = 1.2;
      if (!this.settings.reducedMotion) this.hud.pulseBody('is-drop', 900);
      this.fleet.blast(at, 1100, 420, 'nova');
    }
  }

  /* --------------------------------------------------------- the Aster takes hits */
  #shipHit(amount, at, kind) {
    const a = this.aster, ship = this.ship;
    if (a.down || a.invuln > 0 || ship.state !== 'flying' || ship.evading) return;
    const hadShield = a.shield > 0, absorbed = Math.min(a.shield, amount);
    a.shield -= absorbed; a.hull = Math.max(0, a.hull - (amount - absorbed));
    a.lastHit = this.time;
    ship.flashShield(hadShield ? 1 : 0.4);
    this.fx.sparks(at, a.shield > 0 ? '#9ffcea' : '#ffb38a', 6, 8); // small: these happen right in front of the camera
    if (hadShield && a.shield <= 0) this.sound.play('shieldBreak');
    this.sound.play(a.shield > 0 ? 'hit' : 'hurt', { volume: Math.min(1, 0.4 + amount / 25) });
    this.rig.shake = Math.max(this.rig.shake, Math.min(0.6, amount / 28));
    if (amount > absorbed) this.hud.pulseBody('is-hurt', 420);
    if (a.hull <= 0) this.#shipDown();
    void kind;
  }
  #shipVitals(dt) {
    const a = this.aster, lo = this.loadout;
    a.invuln = Math.max(0, a.invuln - dt);
    if (this.time - a.lastHit > lo.shieldDelay) a.shield = Math.min(lo.shieldMax, a.shield + lo.shieldRegen * dt);
    if (this.time - a.lastHit > 8) a.hull = Math.min(100, a.hull + 5 * dt); // nanite patching between fights
    if (a.streak && this.time - a.lastKill > 3.5) a.streak = 0;
  }
  /** The debris fields are solid: bounce off, and hit hard rocks hard. */
  #rocks() {
    const ship = this.ship; if (ship.state !== 'flying') return;
    const hit = this.scenery.collide(ship.object.position, 7); if (!hit) return;
    ship.object.position.addScaledVector(hit.normal, hit.depth);
    const into = ship.velocity.dot(hit.normal);
    if (into >= 0) return;
    ship.velocity.addScaledVector(hit.normal, -into * 1.6);
    ship.speed *= 0.6;
    this.rig.shake = Math.max(this.rig.shake, 0.5);
    this.sound.play('land', { surface: 'rock', volume: 0.9 });
    if (-into > 60) this.#shipHit(Math.min(35, -into * 0.06), ship.object.position.clone(), 'rock');
  }
  #shipDown() {
    const a = this.aster, ship = this.ship, at = ship.object.position.clone();
    Object.assign(a, { down: true, downTimer: 2.8, streak: 0, echoes: [], nova: null });
    this.spaceFx.flash(at, '#ffd2b0', 320, 0.6);
    this.spaceFx.ring(at, ship.up(_u), '#ff7a5c', 160, 0.9);
    this.spaceFx.sparks(at, '#ffb38a', 26, 140);
    this.sound.play('boom', { pitch: 0.55, volume: 1.4 }); this.sound.play('shieldBreak');
    this.sound.setLoop('engine', false); this.sound.setLoop('boost', false); this.sound.setLoop('charge', false);
    ship.object.visible = false;
    this.slipstream.abortRace();
    a.respawn = this.director.respawnPoint(at) || { position: at, facing: ship.forward(new THREE.Vector3()) };
    this.director.abort('down');
    this.fleet.clear(); // patrols and every bolt still in flight
    this.hud.banner('SIGNAL LOST', 'The Aster re-forms beyond the static.', 'coral');
    setTimeout(() => { if (this.aster.down) document.body.classList.add('is-fading'); }, 1400);
  }
  #updateShipDown(dt, env) {
    const a = this.aster;
    this.rig.updateShip(dt, this.ship, env);
    if ((a.downTimer -= dt) > 0) return;
    const spot = a.respawn;
    this.ship.launchAt(spot.position, spot.facing, new THREE.Vector3(0, 1, 0), 150);
    this.ship.object.visible = true;
    Object.assign(a, { down: false, hull: 100, shield: this.loadout.shieldMax, invuln: 3, lastHit: -99, respawn: null });
    this.shipPrev.copy(spot.position);
    document.body.classList.remove('is-fading');
    this.hud.toast(spot.rift ? `Re-formed at the edge of ${spot.rift.name}. Fly back in when you're ready.` : 'Re-formed. Shields at full.');
  }

  /** The target nearest the reticle and where to lead it (aim assist, missiles, the HUD pip). */
  #updateAim() {
    const ship = this.ship, a = this.aster, fwd = ship.forward(_w);
    const target = this.fleet.count() ? this.fleet.aimTarget(ship.object.position, fwd, 0.35, 2600) : null;
    if (!target) { a.aim = null; return; }
    const speed = 1500 + Math.max(0, ship.velocity.dot(fwd));
    leadPoint(ship.object.position, target.position, this.fleet.velocityOf(target.enemy), speed, a.lead);
    a.aim = { target, lead: a.lead };
  }

  /* --------------------------------------------------------- rewards */
  #reward(tone) {
    if (!tone) return;
    this.hud.setTone(this.journal.addTone(tone), tone);
  }
  #fleetEvents() {
    return {
      onHit: (e, amount, at) => {
        this.hud.hitmarker(false);
        this.sound.play('hitmarker', { volume: 0.45 });
        const s = this.#toScreen(at); if (s) this.hud.popup(s.x, s.y, String(Math.round(amount)));
      },
      onKill: (e, cause) => this.#staticDown(e, cause),
      onPartDestroyed: (e, part) => {
        if (part.name === 'core') return;
        const left = e.parts.filter(p => p.name !== 'core' && !p.dead).length;
        this.#reward(TONE.node);
        this.state.charge = Math.min(1, this.state.charge + 0.15);
        this.hud.toast(left ? `Amp silenced. ${left} to go.` : 'Every amp is down.', 'violet');
      },
      onBossPhase: () => {
        this.hud.banner('THE CORE IS OPEN', 'It answers with spirals and shockwaves. Roll (Q) through the rings.', 'violet');
        this.sound.play('bossRoar');
      },
      onShieldBlock: () => this.hud.toast('The core is shielded. Silence the four amps first.'),
      onExplosion: (at, size) => {
        if (this.mode !== 'ship') return;
        const d = at.distanceTo(this.ship.object.position);
        if (d < 150 * size) this.rig.shake = Math.max(this.rig.shake, Math.min(0.9, size * 0.1 * (1 - d / (150 * size))));
      },
    };
  }
  #staticDown(e, cause) {
    if (cause === 'detonate') return; // a spike that hit you earns nothing
    const a = this.aster, boss = e.type === 'boss', before = this.run.level;
    this.run.kill(false);
    this.state.charge = Math.min(1, this.state.charge + e.def.charge);
    const tone = TONE[e.type] || 0;
    this.#reward(tone);
    a.streak = this.time - a.lastKill < 3.5 ? a.streak + 1 : 1; a.lastKill = this.time;
    const call = STREAK_CALLS[a.streak];
    if (call) { this.hud.streak(a.streak, call); this.#reward(TONE.streak); this.sound.play('pickup'); }
    this.hud.hitmarker(true);
    this.sound.play('kill', { volume: 0.7 });
    const s = this.#toScreen(e.position); if (s) this.hud.popup(s.x, s.y, `+${tone} TONE`, true);
    if (this.loadout.reverb && !boss) a.reverbs.push({ t: 0.12, at: e.position.clone() }); // reverb kills ring out too: chain reactions
    if (this.run.level > before) { this.sound.play('levelUp'); this.hud.toast(`The agent's rifle evolved: ${this.run.weapon.name}`, 'violet'); }
    if (boss) this.#dissonanceDown(e);
  }
  #dissonanceDown(e) {
    this.aster.slowmo = this.settings.reducedMotion ? 0 : 1.4;
    this.run.reward('flagship', 'flagship');
    this.spaceFx.flash(e.position, '#ffffff', 2600, 0.9);
    for (const [color, size] of [['#ff3d6e', 1400], ['#c9a6ff', 1000], ['#ffffff', 600]]) this.spaceFx.ring(e.position, this.ship.forward(_v), color, size, 1.6);
    this.sound.play('ultimate');
    this.hud.banner('THE DISSONANCE IS SILENCED', `+${TONE.boss} Tone. The worlds can hear each other again.`, 'gold');
    if (this.journal.earnPedal('reverb')) {
      this.applyLoadout();
      setTimeout(() => this.hud.toast('New pedal earned: Reverb. Your kills now ring out and shatter nearby Static.', 'violet'), 3600);
    }
  }
  #directorEvents() {
    const plural = { glitch: 'glitches', spike: 'spikes', jammer: 'jammers' };
    const wave = enc => enc.waves[enc.wave].map(([type, count]) => `${count} ${count > 1 ? plural[type] : type}`).join(', ');
    return {
      onIncursion: enc => {
        this.scenery.setState(enc.rift.id, 'active');
        if (enc.resumed) this.hud.banner(`BACK INTO ${enc.rift.name.toUpperCase()}`, `Resuming at wave ${enc.wave + 1} of ${enc.waves.length}.`, 'coral', `RIFT ${enc.rift.number}`);
        else this.hud.banner(enc.encore ? `ENCORE ${ROMAN[Math.min(3, enc.clears)] || enc.clears}` : 'STATIC INCURSION', `${enc.rift.name}. ${enc.waves.length} waves. Fly out of the field to retreat.`, 'coral', `RIFT ${enc.rift.number}`);
        this.sound.play('warpStart');
      },
      onWave: enc => {
        const final = enc.waves[enc.wave].some(([type]) => type === 'boss');
        if (final) { this.hud.banner('THE DISSONANCE', 'Silence its four amps to open the core.', 'violet', 'FINAL WAVE'); this.sound.play('bossRoar'); }
        else this.hud.toast(`Wave ${enc.wave + 1} of ${enc.waves.length}: ${wave(enc)}.`, 'coral');
      },
      onWaveCleared: enc => {
        this.#reward(TONE.wave);
        this.aster.shield = Math.min(this.loadout.shieldMax, this.aster.shield + 40);
        this.hud.toast(`Wave cleared. +${TONE.wave} Tone, shields topped up.`, 'gold');
        this.sound.play('levelUp');
      },
      onRiftCleared: enc => {
        const clears = this.journal.clearRift(enc.rift.id), first = clears === 1;
        this.scenery.setState(enc.rift.id, 'silenced');
        this.#reward(first ? TONE.rift : TONE.encore);
        this.run.reward(`rift:${enc.rift.id}`, 'rift');
        this.hud.banner('RIFT SILENCED', first ? `${enc.rift.name} falls quiet. +${TONE.rift} Tone.` : `Encore cleared. +${TONE.encore} Tone. It will come back louder.`, 'gold');
        this.sound.play('levelUp');
      },
      onAbort: (enc, reason) => {
        this.scenery.setState(enc.rift.id, this.journal.riftClears(enc.rift.id) ? 'silenced' : 'open');
        if (reason === 'retreat') this.hud.toast(`You left ${enc.rift.name}. The Static settles, for now.`);
      },
      onPatrol: () => this.hud.toast('A Static patrol is closing in. Fight, or outrun it with the pulse drive (hold Shift).', 'coral'),
    };
  }
  #slipstreamEvents() {
    const medals = ['bronze', 'silver', 'gold'];
    return {
      onGate: (gate, info) => {
        this.ship.addSurge(this.loadout.surge);
        this.sound.play('gate', { pitch: gate.kind === 'lane' ? 1 + (info.chain || 0) * 0.06 : 1 });
        this.rig.shake = Math.max(this.rig.shake, 0.15);
        this.hud.pulseBody('is-surge', 420);
        if (this.run.reward(gate.id, 'gate')) this.#reward(TONE.gate);
      },
      onRaceStart: () => this.hud.banner('SLIPSTREAM CIRCUIT', `Sixteen gates around BEACN. Gold under ${formatTime(this.slipstream.medals.gold)}.`, 'gold', 'GO'),
      onLap: ({ time, medal }) => {
        const best = this.journal.recordLap(time);
        this.#reward(TONE.lap);
        this.run.reward('lap', 'lap');
        let bonus = 0;
        if (medal) for (const m of medals.slice(0, medals.indexOf(medal) + 1)) if (this.journal.addMedal(m)) bonus += TONE[m];
        this.#reward(bonus);
        this.hud.banner(`LAP ${formatTime(time)}`, `${medal ? `${medal.toUpperCase()} MEDAL. ` : ''}${best ? 'A new best.' : `Best ${formatTime(this.journal.data.circuitBest)}.`}${bonus ? ` +${bonus} Tone.` : ''}`, 'gold');
        this.sound.play('levelUp');
      },
      onRaceAbort: () => this.hud.toast('Race abandoned. Fly through the first gold gate to start again.'),
      onSlingshot: gate => {
        this.ship.addSurge(2600);
        this.#reward(TONE.slingshot);
        this.hud.banner('SLINGSHOT', `Toward ${this.planets.get(gate.to)?.spec.name}. Hold Shift for the pulse drive.`, 'gold');
        this.sound.play('warpStart');
        this.rig.shake = 0.6;
      },
    };
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

  /** Autopilot to a point in space, arriving in flight and facing along `toward`. */
  #autopilotTo(end, toward, label) {
    const ship = this.ship;
    const go = () => {
      const from = ship.object.position.clone(), here = this.universe.nearest(from), reach = Math.max(3000, from.distanceTo(end) * 0.25);
      const leave = here.planet && here.altitude < 20000 ? from.clone().sub(here.planet.center).normalize() : ship.forward(new THREE.Vector3());
      ship.travelTo(from.clone().addScaledVector(leave, reach), end.clone().addScaledVector(toward, -reach), end, () => {});
      this.sound.play('warpStart');
      this.hud.toast(`Autopilot: ${label}`);
    };
    if (ship.state === 'landed') { ship.takeoff(_v.copy(ship.object.position).sub(this.planet.center).normalize()); setTimeout(() => { if (ship.state === 'flying') go(); }, 1900); }
    else if (ship.state === 'flying') go();
  }

  /** "Set course" on the map: autopilot to a rift's edge or the circuit's start line. */
  course(target) {
    if (!this.ready) return;
    if (!this.started) this.start();
    if (this.mode !== 'ship' || !['flying', 'landed'].includes(this.ship.state)) { this.hud.toast('Board the Aster first (E at your ship), then set a course.'); return; }
    if (target === 'circuit') {
      const gate = this.slipstream.circuit[0];
      this.#autopilotTo(gate.center.clone().addScaledVector(gate.normal, -1800), gate.normal.clone(), 'the slipstream circuit');
      return;
    }
    const rift = riftById(target); if (!rift) return;
    const center = new THREE.Vector3(...rift.position), out = this.ship.object.position.clone().sub(center).normalize();
    this.#autopilotTo(center.clone().addScaledVector(out, FIELD_RADIUS + 900), out.clone().negate(), rift.name);
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
    if (fresh) this.#reward(TONE.warden);
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
    this.challenges.cancelArena();
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
    if (fresh) this.#reward(TONE.shard);
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
    // The objective changes slowly: markers reuse the last one between HUD ticks.
    if (slow || !this.currentObjective) this.currentObjective = this.#objective(world);
    const objective = this.currentObjective;
    if (onFoot && world) {
      for (const item of world.items) {
        const list = discoveriesAt(this.worldId, item.id);
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
      // Deep space: rifts, the circuit (or the next gate) and the Static around you.
      for (const rift of this.director.rifts) {
        const silenced = this.journal.riftClears(rift.id) > 0, d = rift.center.distanceTo(eye), b = bearing(rift.center), centered = Math.abs(b) < 0.22;
        markers.push({ id: `rift:${rift.id}`, bearing: b, kind: 'rift', color: silenced ? rift.calm : rift.color, label: centered ? rift.name.toUpperCase() : '', distance: d, quiet: !centered });
        const sp = d > FIELD_RADIUS + 500 && this.#toScreen(rift.center, {});
        if (sp) labels.push({ id: `rf:${rift.id}`, x: sp.x, y: sp.y, title: rift.name, sub: `${silenced ? 'SILENCED · ENCORE' : 'STATIC RIFT'} · ${formatDistance(d)}`, found: silenced, main: false, opacity: 0.92 });
      }
      const gate = this.slipstream.nextGate;
      if (gate) markers.push({ id: 'gate', bearing: bearing(gate.center), kind: 'gate', main: true, label: gate.kind === 'circuit' ? (gate.index === 0 ? 'FINISH' : `GATE ${gate.index + 1}`) : 'SLINGSHOT', distance: gate.center.distanceTo(eye) });
      else {
        const start = this.slipstream.circuit[0], d = start.center.distanceTo(eye), b = bearing(start.center), centered = Math.abs(b) < 0.22;
        markers.push({ id: 'gate', bearing: b, kind: 'gate', label: centered ? 'CIRCUIT' : '', distance: d, quiet: !centered });
        const sp = d > 1500 && this.#toScreen(start.center, {});
        if (sp) labels.push({ id: 'circuit', x: sp.x, y: sp.y, title: 'Slipstream circuit', sub: `START LINE · ${formatDistance(d)}`, found: false, main: false, opacity: 0.85 });
      }
      for (const t of this.fleet.targets()) if (!t.part || t.part.name === 'core') markers.push({ id: `foe:${t.enemy.id}`, bearing: bearing(t.position), kind: 'enemy', distance: t.position.distanceTo(eye), quiet: true });
    }
    hud.setCompass(markers);
    hud.setLabels(labels);
    if (this.mode === 'ship') this.#updateTargets();
    else if (this.targetsShown) { hud.setTargets([]); hud.setAim(null); this.targetsShown = false; }
    if (!slow) return;
    // Slow-changing panels.
    hud.setObjective(objective.title, objective.detail);
    // Far from every world, the HUD speaks for the whole system (or the rift you are fighting in).
    const local = this.universe.local, enc = this.mode === 'ship' ? this.director.encounter : null;
    const deep = this.mode === 'ship' && (Boolean(enc) || !(local.planet && local.altitude < 30000));
    const where = enc ? `rift:${enc.rift.id}` : deep ? 'deep' : this.worldId;
    if (where !== this.whereShown) {
      this.whereShown = where;
      hud.setWorld(enc ? { number: `RIFT ${enc.rift.number}`, name: enc.rift.name, color: enc.rift.color } : deep ? null : this.planet?.spec ?? null);
    }
    const scoped = this.worldId && !deep;
    const prog = scoped ? this.journal.progress(this.worldId) : this.journal.progress();
    const shards = scoped ? this.journal.data.shards.filter(x => x.startsWith(`${this.worldId}:`)).length : this.journal.data.shards.length;
    hud.setProgress(prog.found, prog.total, shards, scoped ? SHARDS_PER_WORLD : SHARDS_PER_WORLD * 5);
    hud.setVitals(s.health, s.shield, this.player.jet);
    hud.setAbilities({ dash: this.player.dashCooldown / 2.6, pulse: s.pulseCd / ABILITIES.pulse.cooldown, charge: s.charge, weapon: this.run.weapon.name });
    const warden = this.combat.activeWarden;
    hud.setBoss(warden ? warden.name : null, warden ? warden.hp / warden.maxHp : 0);
    if (this.mode === 'ship') {
      const local = this.universe.local, ship = this.ship, a = this.aster, lo = this.loadout, race = this.slipstream.race;
      const mode = { landed: 'LANDED', takeoff: 'TAKEOFF', landing: 'LANDING', autopilot: 'AUTOPILOT' }[ship.state]
        || (ship.pulse ? 'PULSE DRIVE' : a.inField ? 'STATIC FIELD · DRIVE JAMMED' : ship.surge > 120 ? 'SLIPSTREAM' : local.inAtmosphere > 0.05 ? 'ATMOSPHERE' : 'OPEN SPACE');
      hud.setFlight(true, { speed: ship.speed, altitude: local.planet && local.altitude < 40000 ? local.altitude : Infinity, mode });
      hud.setShip(true, { hull: a.hull, shield: a.shield, shieldMax: lo.shieldMax, weapon: this.#weaponLabel(), missiles: { locked: !lo.missiles, cd: lo.missiles ? a.missileCd / lo.missileCooldown : 0 }, roll: ship.rollCooldown / 1.9, charge: s.charge });
      hud.setRace(race ? { time: formatTime(race.t), detail: `${race.next === 0 ? 'FINISH LINE' : `GATE ${race.next + 1} / 16`} · LAP ${race.lap}${this.journal.data.circuitBest ? ` · BEST ${formatTime(this.journal.data.circuitBest)}` : ''}` } : null);
    } else { hud.setFlight(false); hud.setShip(false); hud.setRace(null); }
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

  /** Brackets on the Static (edge arrows when off screen), the gun reticle and the lead pip. */
  #updateTargets() {
    const hud = this.hud, ship = this.ship, a = this.aster, cam = this.camera.position;
    this.targetsShown = true;
    if (ship.state !== 'flying' || a.down) { hud.setTargets([]); hud.setAim(null); return; }
    const items = [], halfH = innerHeight / 2, tan = Math.tan(this.camera.fov * Math.PI / 360);
    for (const t of this.fleet.targets()) {
      const id = `${t.enemy.id}:${t.part?.name || ''}`, d = t.position.distanceTo(cam), boss = t.enemy.type === 'boss';
      const locked = Boolean(a.aim && a.aim.target.enemy === t.enemy && a.aim.target.part === t.part);
      const sp = this.#toScreen(t.position, {});
      if (sp) items.push({ id, x: sp.x, y: sp.y, size: THREE.MathUtils.clamp(t.radius * 2.6 * halfH / (d * tan), 18, 120), hp: t.part ? t.part.hp / t.part.max : t.enemy.hp / t.enemy.maxHp, locked, boss, label: locked ? formatDistance(d) : '' });
      else items.push({ id, ...this.#edgePoint(t.position), edge: true, boss });
    }
    hud.setTargets(items);
    const reticle = this.#toScreen(_p.copy(ship.object.position).addScaledVector(ship.forward(_w), 900), {});
    if (!reticle) { hud.setAim(null); return; }
    let lead = null;
    if (a.aim) { const lp = this.#toScreen(a.aim.lead, {}); if (lp) lead = { x: lp.x, y: lp.y, on: Math.hypot(lp.x - reticle.x, lp.y - reticle.y) < 24 }; }
    hud.setAim({ x: reticle.x, y: reticle.y, lead });
  }
  /** A point on an ellipse near the screen edge, toward something off screen (and the arrow's angle). */
  #edgePoint(position) {
    _w.copy(position).applyMatrix4(this.camera.matrixWorldInverse);
    let dx = _w.x, dy = -_w.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) { dx = 0; dy = 1; } else { dx /= len; dy /= len; }
    // An ellipse that stays clear of the compass (top) and the Aster's bar (bottom).
    const top = 140, bottom = innerHeight - 200, cx = innerWidth / 2, cy = (top + bottom) / 2, rx = cx - 48, ry = Math.max(60, (bottom - top) / 2);
    const k = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
    return { x: cx + dx * k, y: cy + dy * k, angle: Math.atan2(dy, dx) * 180 / Math.PI + 90 };
  }
  #weaponLabel() {
    const p = this.journal.data.pedals;
    return ['CANNONS', ...['overdrive', 'octaver', 'delay'].filter(id => levelOf(p, id)).map(id => `${id.toUpperCase()} ${ROMAN[levelOf(p, id)]}`)].join(' · ');
  }

  /** What to do next, phrased for the visitor. */
  #objective(world) {
    if (this.mode === 'ship') {
      const local = this.universe.local, ship = this.ship, enc = this.director.encounter, race = this.slipstream.race;
      if (this.aster.down) return { title: 'Signal lost', detail: 'The Aster is re-forming beyond the static.' };
      if (ship.state === 'autopilot') return { title: 'Autopilot engaged', detail: 'Sit back. The Aster flies itself.' };
      if (ship.state === 'takeoff' || ship.state === 'landing') return { title: ship.state === 'takeoff' ? 'Taking off' : 'Landing', detail: 'Hold on.' };
      const boss = this.fleet.boss;
      if (boss) return boss.phase === 1 ? { title: 'Silence the four amps', detail: 'The core stays shielded until every amp is down.' } : { title: 'Break the core', detail: 'Spirals and shockwaves: roll (Q) through the rings.' };
      if (enc) return { title: `${enc.rift.name} · wave ${enc.wave + 1} of ${enc.waves.length}`, detail: enc.phase === 'warning' ? 'The Static is tearing through…' : `${this.fleet.count('rift')} left. Fly out of the field to retreat.` };
      if (race) return { title: `Slipstream circuit · ${race.next === 0 ? 'the finish line' : `gate ${race.next + 1} of 16`}`, detail: `Thread the bright gate. Gold under ${formatTime(this.slipstream.medals.gold)}, silver ${formatTime(this.slipstream.medals.silver)}, bronze ${formatTime(this.slipstream.medals.bronze)}.` };
      if (this.fleet.count('patrol')) return { title: 'Static patrol', detail: 'Fight it, or outrun it with the pulse drive (hold Shift).' };
      if (this.#nearProject()) { const p = this.#nearProject(); return { title: `${p.name}`, detail: `A featured project. Press E to open it in a new tab.` }; }
      if (local.planet && local.altitude < LAND_ALTITUDE) return { title: `Land on ${local.planet.spec.name}`, detail: 'Press E. The ship finds flat ground, or the pad near the site.' };
      if (local.planet && local.altitude < 30000) return { title: `Approaching ${local.planet.spec.name}`, detail: 'Descend to land, or press M to travel elsewhere.' };
      return { title: 'Open space', detail: 'Fly to a world, a red rift or the gold circuit. M opens the map, U the pedalboard. Shift is the pulse drive.' };
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
    this.sound.setLoop('boost', flying && (ship.boost || ship.pulse || ship.surge > 150));
    this.sound.setLoop('jetpack', this.mode === 'foot' && this.player.jetting, { thrust: 1 });
    this.soundTimer -= dt;
    if (this.soundTimer > 0) return;
    this.soundTimer = 0.1;
    const local = this.universe.local;
    this.sound.setScene({
      world: local.planet && local.altitude < 25000 ? local.planet.spec.id : null,
      mode: this.mode === 'ship' ? 'ship' : 'foot', altitude: Number.isFinite(local.altitude) ? local.altitude : 1e6,
      speed: this.mode === 'ship' ? ship.speed : this.player.velocity.length(), combat: Math.max(this.combat.threat, this.mode === 'ship' ? this.fleet.threat : 0),
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
