import { Matrix4, Quaternion, Vector3 } from 'three';

export const LANDING_CLEARANCE = 1.9;
const FORWARD = new Vector3(0, 0, -1);
const UP = new Vector3(0, 1, 0);
const RIGHT = new Vector3(1, 0, 0);
const SKIN = 1e-5;
// These are local model-space support vertices, not a flat-world bounding box.
export const FLIGHT_HULL_POINTS = Object.freeze([
  [0, 0, -7.3], [-6.8, .1, 4.6], [6.8, .1, 4.6], [0, 0, 6],
  [0, -1.3, 0], [0, 2.4, 1], [0, 0, 0],
].map(point => Object.freeze(point)));
const HULL_RADIUS = Math.max(...FLIGHT_HULL_POINTS.map(point => Math.hypot(...point)));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const smooth = (a, b, n) => { const t = clamp((n - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const axis = n => clamp(Number(n) || 0, -1, 1);

/** Local-frame input: positive yaw is left, positive pitch is nose-up, including at poles. */
export function rotateFlight(quaternion, yawRadians = 0, pitchRadians = 0) {
  return quaternion.clone().normalize()
    .multiply(new Quaternion().setFromAxisAngle(UP, Number(yawRadians) || 0))
    .multiply(new Quaternion().setFromAxisAngle(RIGHT, Number(pitchRadians) || 0)).normalize();
}

function nearest(position, surfaces) {
  let surface = null, altitude = Infinity;
  for (const candidate of surfaces) {
    const value = candidate.altitudeAt(position);
    if (value < altitude) { altitude = value; surface = candidate; }
  }
  return { surface, altitude };
}

function radialUp(surface, position) {
  return surface.normalAt ? surface.normalAt(position).clone().normalize()
    : position.clone().sub(surface.center).normalize();
}

function contactUp(surface, position) {
  return surface.surfaceNormalAt ? surface.surfaceNormalAt(position).clone().normalize()
    : radialUp(surface, position);
}

/** Project the current heading, with a body-frame fallback for vertical approaches. */
function tangentFrame(quaternion, up) {
  const forward = FORWARD.clone().applyQuaternion(quaternion);
  forward.addScaledVector(up, -forward.dot(up));
  if (forward.lengthSq() < 1e-10) forward.crossVectors(up, RIGHT.clone().applyQuaternion(quaternion));
  if (forward.lengthSq() < 1e-10) forward.copy(UP).applyQuaternion(quaternion).projectOnPlane(up);
  forward.normalize();
  const right = new Vector3().crossVectors(forward, up).normalize();
  const correctedUp = new Vector3().crossVectors(right, forward).normalize();
  return { forward, quaternion: new Quaternion().setFromRotationMatrix(
    new Matrix4().makeBasis(right, correctedUp, forward.clone().negate())) };
}

/** Only rotate around the ship's current forward: never auto-steer its heading. */
function stabilizeRoll(quaternion, normal, dt, strength) {
  const forward = FORWARD.clone().applyQuaternion(quaternion);
  const up = UP.clone().applyQuaternion(quaternion).projectOnPlane(forward).normalize();
  const desired = normal.clone().projectOnPlane(forward);
  if (desired.lengthSq() < .025) return;
  desired.normalize();
  const angle = Math.atan2(forward.dot(new Vector3().crossVectors(up, desired)), clamp(up.dot(desired), -1, 1));
  quaternion.premultiply(new Quaternion().setFromAxisAngle(forward, angle * (1 - Math.exp(-1.8 * dt * strength)))).normalize();
}

/** Signed free space for the center clearance and every transformed hull vertex. */
function hullMargin(surface, position, quaternion, clearance = LANDING_CLEARANCE) {
  let margin = surface.altitudeAt(position) - clearance;
  if (quaternion) for (const local of FLIGHT_HULL_POINTS) {
    const point = new Vector3(...local).applyQuaternion(quaternion).add(position);
    margin = Math.min(margin, surface.altitudeAt(point) - SKIN);
  }
  return margin;
}

/** Earliest pose contact on a short world segment, including rotation of the hull. */
function sweep(start, end, surfaces, clearance = LANDING_CLEARANCE, startQuaternion = null, endQuaternion = startQuaternion) {
  let hit = null;
  const at = t => ({ position: start.clone().lerp(end, t), quaternion: startQuaternion?.clone().slerp(endQuaternion, t) });
  for (const surface of surfaces) {
    if (hullMargin(surface, end, endQuaternion, clearance) >= 0) continue;
    let low = 0, high = 1;
    if (hullMargin(surface, start, startQuaternion, clearance) < -1e-7) high = 0;
    else for (let i = 0; i < 22; i++) {
      const middle = (low + high) / 2, pose = at(middle);
      if (hullMargin(surface, pose.position, pose.quaternion, clearance) < 0) high = middle;
      else low = middle;
    }
    if (!hit || low < hit.fraction) hit = { surface, fraction: low, ...at(low) };
  }
  return hit;
}

/** Constrain external motion. Optional endpoint attitudes also sweep the real ship hull. */
export function sweepFlightSegment(start, end, surfacesIterable = [], clearance = LANDING_CLEARANCE, startQuaternion = null, endQuaternion = startQuaternion) {
  const surfaces = Array.from(surfacesIterable instanceof Map ? surfacesIterable.values() : surfacesIterable);
  const smallestRadius = surfaces.reduce((r, surface) => Math.min(r, surface.radius || r), Infinity);
  const steps = Math.max(1, Math.ceil(start.distanceTo(end) / Math.min(.85, smallestRadius * .1)),
    startQuaternion ? Math.ceil(startQuaternion.angleTo(endQuaternion) / .01) : 1);
  const previous = start.clone();
  let previousQuaternion = startQuaternion?.clone();
  for (let i = 1; i <= steps; i++) {
    const next = start.clone().lerp(end, i / steps);
    const nextQuaternion = startQuaternion?.clone().slerp(endQuaternion, i / steps);
    const collision = sweep(previous, next, surfaces, clearance, previousQuaternion, nextQuaternion);
    if (collision) return { position: collision.position.addScaledVector(radialUp(collision.surface, collision.position), SKIN),
      quaternion: collision.quaternion, hit: true, surface: collision.surface };
    previous.copy(next); previousQuaternion = nextQuaternion;
  }
  return { position: end.clone(), quaternion: endQuaternion?.clone(), hit: false, surface: null };
}

/** Level first, then settle into the newly available space, at a bounded descent rate. */
function settleLanding(position, quaternion, surface, surfaces, dt) {
  const target = quaternion.clone().rotateTowards(tangentFrame(quaternion, contactUp(surface, position)).quaternion, 1.8 * dt);
  const end = position.clone();
  // A rolled wing may need a small continuous lift while it rotates out of contact.
  if (hullMargin(surface, end, target) < 0) end.addScaledVector(radialUp(surface, position), 20 * dt);
  const rotation = sweep(position, end, surfaces, LANDING_CLEARANCE, quaternion, target);
  if (rotation) { position.copy(rotation.position); quaternion.copy(rotation.quaternion); }
  else { position.copy(end); quaternion.copy(target); }
  const down = position.clone().addScaledVector(radialUp(surface, position), -6 * dt);
  const contact = sweep(position, down, surfaces, LANDING_CLEARANCE, quaternion, quaternion);
  if (contact) position.copy(contact.position).addScaledVector(radialUp(contact.surface, contact.position), SKIN);
  else position.copy(down);
}

/**
 * One immutable world-space flight step. There are no atmosphere/ground scene modes,
 * origin changes, latitude/longitude Euler angles, or speed changes at altitude bands.
 * Terrain is the same radial surface sampled by rendering and walking.
 */
export function stepFlight(state, input = {}, dt = 0, surfacesIterable = []) {
  const position = state.position.clone();
  let quaternion = state.quaternion.clone().normalize();
  let speed = Number.isFinite(state.speed) ? state.speed : 0, landed = Boolean(state.landed);
  let touchdown = false, impact = false;
  const surfaces = Array.from(surfacesIterable instanceof Map ? surfacesIterable.values() : surfacesIterable);
  const duration = Math.max(0, Number.isFinite(dt) ? dt : 0);
  const throttle = clamp(Number(input.throttle) || 0, 0, 1);
  const brake = clamp(Number(input.brake) || 0, 0, 1);
  const reverse = clamp(Number(input.reverse) || 0, 0, 1);
  const boost = Boolean(input.boost);
  const yaw = axis(input.yaw), pitch = axis(input.pitch);
  // Bound both angular time and travel distance, even for very fast boosted impacts.
  // A planet cannot be skipped by a long segment whose endpoints are both outside.
  const smallestRadius = surfaces.reduce((r, s) => Math.min(r, s.radius || r), Infinity);
  const travelLimit = Math.min(.85, smallestRadius * .1);
  const steps = Math.max(1, Math.ceil(duration * 120), Math.ceil((Math.abs(speed) + 170 * duration + 7) * duration / travelLimit));
  const h = duration / steps;

  for (let i = 0; i < steps && h > 0; i++) {
    let { surface, altitude } = nearest(position, surfaces);
    const nearAmount = surface ? 1 - smooth(45, 220, altitude) : 0;
    const launching = landed && ((throttle > 0 && pitch > 0) || (reverse > 0 && pitch < 0));
    if (!surface || altitude > LANDING_CLEARANCE + HULL_RADIUS + 2 || launching) landed = false;
    const oldQuaternion = quaternion.clone();
    quaternion = rotateFlight(quaternion, yaw * 1.12 * h, (landed ? 0 : pitch) * 1.02 * h);

    if (brake > 0) speed -= Math.sign(speed) * Math.min(Math.abs(speed), (36 + Math.abs(speed) * 1.35) * brake * h);
    else if (reverse > 0) {
      const target = -120 + 60 * nearAmount;
      speed -= Math.min(Math.max(0, speed - target), (68 - 34 * nearAmount) * reverse * h);
    } else if (throttle > 0 || boost) {
      const target = boost ? 340 : 120 - 72 * nearAmount;
      const acceleration = boost ? 150 : 68 - 34 * nearAmount;
      // Thrust does not silently brake an already-fast ship on atmosphere entry.
      speed += Math.min(Math.max(0, target - speed), acceleration * (boost ? 1 : throttle) * h);
    }

    if (landed) {
      speed = 0;
      quaternion.copy(oldQuaternion);
      settleLanding(position, quaternion, surface, surfaces, h);
      continue;
    }

    if (surface && nearAmount > 0) stabilizeRoll(quaternion, radialUp(surface, position), h, nearAmount * .45);
    const velocity = FORWARD.clone().applyQuaternion(quaternion).multiplyScalar(speed);
    if (input.descend && surface && Math.abs(speed) < 25) {
      velocity.addScaledVector(radialUp(surface, position), -6 * (1 - smooth(180, 280, altitude)));
    }
    const end = position.clone().addScaledVector(velocity, h);
    const hit = sweep(position, end, surfaces, LANDING_CLEARANCE, oldQuaternion, quaternion);
    if (!hit) { position.copy(end); continue; }

    surface = hit.surface;
    quaternion.copy(hit.quaternion);
    position.copy(hit.position).addScaledVector(radialUp(surface, hit.position), SKIN);
    const up = contactUp(surface, position);
    const frame = tangentFrame(quaternion, up);
    if (Math.abs(speed) < 25 && !launching) {
      landed = true; touchdown = true; speed = 0;
      settleLanding(position, quaternion, surface, surfaces, h * (1 - hit.fraction));
      continue;
    }

    impact = true;
    // Continue the unused part of the step along the actual terrain; the model and
    // rigid chase camera turn toward this tangent gradually instead of cutting.
    const redirect = quaternion.clone().rotateTowards(frame.quaternion, 1.35 * h);
    const rotationHit = sweep(position, position, surfaces, LANDING_CLEARANCE, quaternion, redirect);
    quaternion.copy(rotationHit ? rotationHit.quaternion : redirect);
    const slide = velocity.clone().addScaledVector(up, -Math.min(0, velocity.dot(up)));
    if (slide.lengthSq() < speed * speed * .0025) slide.copy(frame.forward).multiplyScalar(speed * .22);
    const remaining = h * (1 - hit.fraction);
    const slideEnd = position.clone().addScaledVector(slide, remaining);
    const slideHit = sweep(position, slideEnd, surfaces, LANDING_CLEARANCE, quaternion, quaternion);
    if (slideHit) position.copy(slideHit.position).addScaledVector(radialUp(slideHit.surface, slideHit.position), SKIN);
    else position.copy(slideEnd);
    // Impact friction is continuous in elapsed contact time, never a mode speed cap.
    speed *= Math.exp(-.65 * remaining);
  }

  const { surface, altitude } = nearest(position, surfaces);
  return { position, quaternion: quaternion.normalize(), speed, landed, surface, altitude, touchdown, impact };
}
