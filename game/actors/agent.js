import * as THREE from 'three';
import { loadModel } from '../engine/assets.js';
import { createGlow } from '../world/space.js';

/**
 * The playable agent: skinned GLB, layered animation and procedural polish.
 *
 * Two animation layers share one mixer:
 *  - lower body (hips + legs): locomotion blend (walk/run/sprint/strafe/back)
 *  - upper body (spine + arms + head + rifle): locomotion arms, or the
 *    aim/fire pose while shooting.
 * Clips are split at load time by bone name, so each layer can crossfade
 * independently. Aim pitch is applied procedurally to the spine chain.
 */

const LOWER = /^(Root|Hips|UpperLeg_|LowerLeg_|Foot_|Toe_)/;
const CLIP_SPEED = { Walk: 2.4, Run: 6.0, Sprint: 9.5, StrafeLeft: 5.0, StrafeRight: 5.0, Backpedal: 3.5 };

function splitClip(clip) {
  const boneOf = track => track.name.split('.')[0];
  const lower = clip.tracks.filter(t => LOWER.test(boneOf(t)));
  const upper = clip.tracks.filter(t => !LOWER.test(boneOf(t)));
  return { lower: new THREE.AnimationClip(`${clip.name}_lower`, clip.duration, lower), upper: new THREE.AnimationClip(`${clip.name}_upper`, clip.duration, upper) };
}

export class Agent {
  static async load() {
    const gltf = await loadModel('agent.glb');
    return new Agent(gltf);
  }

  constructor(gltf) {
    this.root = new THREE.Group(); this.root.name = 'agent';
    // glTF faces +Z; the game's convention for actors is "forward = -Z".
    this.model = gltf.scene; this.model.rotation.y = Math.PI;
    this.root.add(this.model);
    this.bones = {};
    this.model.traverse(o => {
      if (o.isBone || o.type === 'Bone' || o.name) this.bones[o.name] = this.bones[o.name] || o;
      if (o.isMesh || o.isSkinnedMesh) {
        o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) this.#style(m);
      }
    });
    this.muzzle = this.model.getObjectByName('Muzzle');
    this.jets = ['Jet_L', 'Jet_R'].map(n => this.model.getObjectByName(n)).filter(Boolean);
    this.mixer = new THREE.AnimationMixer(this.model);
    this.clips = Object.fromEntries(gltf.animations.map(c => [c.name, c]));
    this.layers = { lower: {}, upper: {} };
    for (const clip of gltf.animations) {
      const { lower, upper } = splitClip(clip);
      for (const [layer, sub] of [['lower', lower], ['upper', upper]]) {
        const action = this.mixer.clipAction(sub);
        action.enabled = true; action.setEffectiveWeight(0); action.play();
        if (['JumpStart', 'Land', 'Dash', 'Fire', 'Interact'].includes(clip.name)) { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
        this.layers[layer][clip.name] = action;
      }
    }
    this.weights = { lower: {}, upper: {} };
    for (const layer of ['lower', 'upper']) for (const name of Object.keys(this.layers[layer])) this.weights[layer][name] = 0;
    this.weights.lower.Idle = 1; this.weights.upper.Idle = 1;
    this.oneShot = { lower: null, upper: null };
    this.aimPitch = 0; this.recoil = 0; this.fireCooldown = 0;
    this.footPhase = 0; this.lastStepPhase = 0;
    this.onFootstep = null;
    this.flames = this.jets.map(jet => {
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.7, 10, 1, true), new THREE.MeshBasicMaterial({ color: '#9ffcea', transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
      flame.geometry.translate(0, 0.35, 0); // wide at the nozzle, tip along the jet's +Y (exhaust)
      flame.visible = false; jet.add(flame);
      const glow = createGlow('#8cf0d1', 0.7, 0.9); glow.visible = false; jet.add(glow);
      return { flame, glow };
    });
    this.tmpQ = new THREE.Quaternion(); this.tmpV = new THREE.Vector3(); this.tmpV2 = new THREE.Vector3();
  }

  #style(m) {
    if (m.userData.agentStyled) return;
    m.userData.agentStyled = true;
    switch (m.name) {
      case 'SuitDark': m.color.set('#243146'); m.roughness = 0.7; break;
      case 'Fabric': m.color.set('#253540'); m.roughness = 0.85; break;
      case 'Suit': m.roughness = 0.52; break;
      case 'Accent': m.roughness = 0.5; break;
      case 'Visor': m.color.set('#0b3a40'); m.roughness = 0.08; m.metalness = 0.6; m.emissive = new THREE.Color('#0c4d52'); m.emissiveIntensity = 0.35; break;
      case 'Glow': m.emissive = new THREE.Color('#8cf0d1'); m.emissiveIntensity = 2.6; break;
      case 'Metal': m.color.set('#4a5862'); m.metalness = 0.6; m.roughness = 0.35; break;
      default: break;
    }
  }

  /** Plays a non-looping clip on one or both layers. */
  play(name, { layers = ['lower', 'upper'], fade = 0.08 } = {}) {
    for (const layer of layers) {
      const action = this.layers[layer][name]; if (!action) continue;
      action.reset(); action.setEffectiveTimeScale(1); action.play();
      this.oneShot[layer] = { name, until: action.getClip().duration, t: 0, fade };
    }
  }

  /**
   * @param {number} dt
   * @param {object} s locomotion state:
   *   { localVel: {x (right), z (forward)}, grounded, jetpack, sprint, aiming, firing, pitch, emote }
   */
  update(dt, s) {
    const speed = Math.hypot(s.localVel.x, s.localVel.z);
    // ---- lower body target weights
    const target = {};
    let moveClip = null;
    if (!s.grounded) {
      target[s.jetpack ? 'Jetpack' : 'Fall'] = 1;
    } else if (s.emote) {
      target.AirBass = 1;
    } else if (speed < 0.35) {
      target[s.aiming ? 'Aim' : 'Idle'] = 1;
    } else {
      const fwd = s.localVel.z / speed, side = s.localVel.x / speed;
      if (s.sprint && fwd > 0.5) { target.Sprint = 1; moveClip = 'Sprint'; }
      else if (fwd < -0.5) { target.Backpedal = 1; moveClip = 'Backpedal'; }
      else {
        const forwardClip = speed < 3.6 ? 'Walk' : 'Run';
        const wf = Math.max(0, fwd), ws = Math.abs(side);
        const sum = wf + ws || 1;
        target[forwardClip] = wf / sum;
        target[side > 0 ? 'StrafeRight' : 'StrafeLeft'] = ws / sum;
        moveClip = wf >= ws ? forwardClip : (side > 0 ? 'StrafeRight' : 'StrafeLeft');
      }
    }
    // Speed-matched playback so feet don't slide.
    for (const name of ['Walk', 'Run', 'Sprint', 'StrafeLeft', 'StrafeRight', 'Backpedal']) {
      const scale = THREE.MathUtils.clamp(speed / CLIP_SPEED[name], 0.55, 1.6);
      this.layers.lower[name]?.setEffectiveTimeScale(scale); this.layers.upper[name]?.setEffectiveTimeScale(scale);
    }
    // ---- upper body: copy the lower target, unless shooting/aiming overrides it.
    const upperTarget = { ...target };
    const combat = (s.aiming || s.firing || this.recoil > 0.05) && !s.emote && !(s.sprint && speed > 1);
    if (combat) { for (const k of Object.keys(upperTarget)) delete upperTarget[k]; upperTarget.Aim = 1; }
    this.#blend('lower', target, dt);
    this.#blend('upper', upperTarget, dt);
    // Fire recoil as a short one-shot on the upper body.
    this.fireCooldown -= dt;
    if (s.firedThisFrame && this.fireCooldown <= 0) { this.play('Fire', { layers: ['upper'] }); this.fireCooldown = 0.08; this.recoil = 1; }
    this.recoil = Math.max(0, this.recoil - dt * 3);
    this.mixer.update(dt);
    // ---- procedural aim pitch through the spine chain
    this.aimPitch = THREE.MathUtils.damp(this.aimPitch, s.emote ? 0 : THREE.MathUtils.clamp(s.pitch, -0.9, 0.9), 14, dt);
    this.model.updateMatrixWorld(true);
    const right = this.tmpV.set(1, 0, 0).applyQuaternion(this.root.getWorldQuaternion(this.tmpQ)).normalize();
    for (const [bone, share] of [['Spine', 0.3], ['Chest', 0.45], ['Neck', 0.25]]) this.#rotateBoneWorld(this.bones[bone], right, -this.aimPitch * share);
    // ---- footsteps from the locomotion phase
    if (s.grounded && moveClip && speed > 0.8) {
      const action = this.layers.lower[moveClip];
      const phase = (action.time / action.getClip().duration) % 1;
      const stepIndex = Math.floor(phase * 2);
      if (stepIndex !== this.lastStepPhase) { this.lastStepPhase = stepIndex; this.onFootstep?.(speed); }
    }
    // ---- jetpack flames
    for (const f of this.flames) {
      f.flame.visible = f.glow.visible = !!s.jetpack;
      if (s.jetpack) { f.flame.scale.set(1, 0.7 + Math.random() * 0.6, 1); f.glow.material.opacity = 0.6 + Math.random() * 0.4; }
    }
  }

  #rotateBoneWorld(bone, axisWorld, angle) {
    if (!bone || !angle) return;
    const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    const axis = this.tmpV2.copy(axisWorld).applyQuaternion(parentQ).normalize();
    bone.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
  }

  #blend(layer, target, dt) {
    const actions = this.layers[layer], weights = this.weights[layer], shot = this.oneShot[layer];
    const rate = 1 - Math.exp(-dt * 12);
    let shotWeight = 0;
    if (shot) {
      shot.t += dt;
      const fadeOut = shot.until - shot.fade;
      shotWeight = shot.t < shot.fade ? shot.t / shot.fade : shot.t > fadeOut ? Math.max(0, (shot.until - shot.t) / shot.fade) : 1;
      if (shot.t >= shot.until) { this.oneShot[layer] = null; shotWeight = 0; }
    }
    for (const name of Object.keys(actions)) {
      if (shot && name === shot.name) continue;
      const goal = (target[name] || 0) * (1 - shotWeight);
      weights[name] += (goal - weights[name]) * rate;
      if (weights[name] < 0.002) weights[name] = 0;
      actions[name].setEffectiveWeight(weights[name]);
    }
    if (shot) actions[shot.name].setEffectiveWeight(shotWeight);
  }

  /** World-space muzzle position. */
  muzzleWorld(out = new THREE.Vector3()) { return this.muzzle ? this.muzzle.getWorldPosition(out) : this.root.getWorldPosition(out).addScaledVector(this.root.up, 1.4); }
}
