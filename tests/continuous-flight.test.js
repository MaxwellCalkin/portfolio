import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { FLIGHT_HULL_POINTS, LANDING_CLEARANCE, rotateFlight, stepFlight, sweepFlightSegment } from '../game/continuous-flight.js';

const forward = q => new Vector3(0, 0, -1).applyQuaternion(q);
const sphere = (radius = 100, center = new Vector3()) => ({
  center, radius,
  altitudeAt: p => p.distanceTo(center) - radius,
  normalAt: p => p.clone().sub(center).normalize(),
  surfaceNormalAt: p => p.clone().sub(center).normalize(),
  groundAt: (p, clearance = 0) => p.clone().sub(center).normalize().multiplyScalar(radius + clearance).add(center),
});
const facing = (direction, up = new Vector3(0, 1, 0)) => {
  const right = new Vector3().crossVectors(direction, up).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right,
    new Vector3().crossVectors(right, direction).normalize(), direction.clone().negate()));
};
const pose = (position = new Vector3(), quaternion = new Quaternion(), speed = 0) => ({ position, quaternion, speed, landed: false });
const approximately = (a, b, epsilon = 1e-7) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);

 test('local quaternion turns preserve handedness, normalize, and do not mutate inputs', () => {
  const q = new Quaternion();
  assert.ok(forward(rotateFlight(q, .1, 0)).x < 0, 'left yaw');
  assert.ok(forward(rotateFlight(q, 0, .1)).y > 0, 'nose-up');
  approximately(q.angleTo(new Quaternion()), 0);
  approximately(rotateFlight(q, .4, -.7).length(), 1);
});

test('trajectory crosses both altitude UI boundaries without any coordinate or heading reset', () => {
  const surface = sphere(100, new Vector3(13, -40, 28));
  let state = pose(surface.center.clone().add(new Vector3(0, 0, 340)), new Quaternion(), 60);
  let crossed220 = false, crossed45 = false;
  for (let i = 0; i < 420; i++) {
    const previous = state;
    state = stepFlight(state, {}, 1 / 120, [surface]);
    const delta = state.position.clone().sub(previous.position);
    approximately(delta.length(), .5, 1e-7);
    assert.ok(delta.clone().normalize().distanceTo(new Vector3(0, 0, -1)) < 1e-7);
    assert.ok(forward(state.quaternion).distanceTo(new Vector3(0, 0, -1)) < 1e-7);
    approximately(state.speed, 60);
    if (state.altitude < 220) crossed220 = true;
    if (state.altitude < 45) crossed45 = true;
  }
  assert.ok(crossed220 && crossed45);
});

test('space speed is inertial and atmosphere entry does not cap an already-fast ship', () => {
  let state = pose(new Vector3(0, 0, 300), new Quaternion(), 180);
  const surface = sphere();
  state = stepFlight(state, { throttle: true }, .5, [surface]);
  approximately(state.speed, 180);
  assert.ok(state.altitude < 220);
  state = stepFlight(state, {}, .2, [surface]);
  approximately(state.speed, 180);
  const stopped = stepFlight(state, { brake: true }, 4, []);
  approximately(stopped.speed, 0);
});

test('space throttle and boost accelerate to their targets', () => {
  let state = stepFlight(pose(), { throttle: true }, 3, []);
  approximately(state.speed, 120);
  state = stepFlight(state, { boost: true }, 3, []);
  approximately(state.speed, 340);
  approximately(stepFlight(state, {}, 3, []).speed, 340);
});

test('continuous 360-degree pitch traverses both poles without camera-frame flips', () => {
  let state = pose(new Vector3(), new Quaternion(), 80);
  const steps = 1000, h = 2 * Math.PI / 1.02 / steps;
  for (let i = 0; i < steps; i++) {
    const previous = state;
    state = stepFlight(state, { pitch: 1 }, h, []);
    assert.ok(previous.quaternion.angleTo(state.quaternion) < .007);
    assert.ok(previous.position.distanceTo(state.position) <= 80 * h + 1e-8);
    approximately(state.quaternion.length(), 1);
  }
  assert.ok(state.quaternion.angleTo(new Quaternion()) < 1e-6);
  assert.ok(state.position.length() < .01);
});

test('roll leveling preserves the world forward direction near a planetary pole', () => {
  const planet = sphere();
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 1.1);
  const state = pose(new Vector3(0, 115, 0), q, 40);
  const result = stepFlight(state, {}, .1, [planet]);
  assert.ok(forward(result.quaternion).distanceTo(forward(q)) < 1e-8);
  assert.ok(q.angleTo(result.quaternion) < .1);
});

test('a fast step crossing an entire planet cannot tunnel through its surface', () => {
  const planet = sphere();
  const original = pose(new Vector3(0, 0, 220), new Quaternion(), 2500);
  const result = stepFlight(original, {}, .25, [planet]);
  assert.ok(result.impact);
  assert.equal(result.touchdown, false);
  assert.ok(result.altitude >= LANDING_CLEARANCE - 1e-5);
  const firstContact = stepFlight(original, {}, .05, [planet]);
  assert.ok(firstContact.impact && firstContact.position.z > 100, 'first contact remains on its approached side');
  let sample = original;
  for (let i = 0; i < 250; i++) {
    sample = stepFlight(sample, {}, .001, [planet]);
    assert.ok(sample.altitude >= LANDING_CLEARANCE - 1e-5, 'every collision-path sample remains outside');
  }
  assert.ok(result.quaternion.angleTo(original.quaternion) < .4, 'impact orientation is interpolated');
  assert.ok(result.position.distanceTo(original.position) <= 2500 * .25);
});

test('slow radial manual descent touches down continuously and eases into tangent orientation', () => {
  const planet = sphere(100, new Vector3(500, 60, -20));
  let state = pose(planet.center.clone().add(new Vector3(0, 10 + planet.radius, 0)), rotateFlight(new Quaternion(), 0, -.3), 0);
  let touchdown = false;
  for (let i = 0; i < 360; i++) {
    const previous = state;
    state = stepFlight(state, { brake: true, descend: true }, 1 / 120, [planet]);
    if (state.touchdown) touchdown = true;
    assert.ok(state.position.distanceTo(previous.position) <= .051, 'no landing-height teleport');
    assert.ok(previous.quaternion.angleTo(state.quaternion) < .02, 'no orientation cut');
    assert.ok(state.altitude >= LANDING_CLEARANCE - 1e-6);
  }
  assert.ok(touchdown && state.landed);
  approximately(state.altitude, LANDING_CLEARANCE, 2e-5);
  assert.ok(Math.abs(forward(state.quaternion).dot(planet.normalAt(state.position))) < 1e-5);
});

test('W plus nose-up takes off from the exact landing position without a height reset', () => {
  const planet = sphere();
  let state = { ...pose(new Vector3(0, 100 + LANDING_CLEARANCE, 0)), landed: true };
  const start = state.position.clone();
  state = stepFlight(state, { throttle: true, pitch: 1 }, 1 / 60, [planet]);
  assert.equal(state.landed, false);
  assert.ok(state.altitude > LANDING_CLEARANCE);
  assert.ok(state.position.distanceTo(start) < .02);
  for (let i = 0; i < 120; i++) state = stepFlight(state, { throttle: true, pitch: .25 }, 1 / 60, [planet]);
  assert.ok(state.altitude > 20);
  assert.ok(state.speed >= 48);
});

test('landed pose settles gently while waiting, rather than adopting a tangent in one frame', () => {
  const planet = sphere();
  const q = rotateFlight(new Quaternion(), 0, -.65);
  const state = { ...pose(new Vector3(0, 105, 0), q), landed: true };
  const result = stepFlight(state, {}, 1 / 60, [planet]);
  assert.ok(q.angleTo(result.quaternion) <= 1.8 / 60 + 1e-7);
  assert.ok(result.position.distanceTo(state.position) <= .101);
  assert.equal(result.landed, true);
});

test('nearest signed-altitude surface supports Map values and never mutates the source state', () => {
  const a = sphere(100, new Vector3(400, 0, 0)), b = sphere(50, new Vector3(-400, 0, 0));
  const state = pose(new Vector3(-400, 100, 0), facing(new Vector3(1, 0, 0)), 10);
  const original = { position: state.position.clone(), quaternion: state.quaternion.clone(), speed: state.speed };
  const result = stepFlight(state, { yaw: .8, pitch: .3, throttle: true }, .1, new Map([['a', a], ['b', b]]));
  assert.equal(result.surface, b);
  approximately(state.position.distanceTo(original.position), 0);
  approximately(state.quaternion.angleTo(original.quaternion), 0);
  assert.equal(state.speed, original.speed);
  assert.notEqual(result.position, state.position);
  assert.notEqual(result.quaternion, state.quaternion);
});

test('manual landing samples the same displaced spherical triangles as the rendered ground', async () => {
  const { createSphericalTerrain } = await import('../game/spherical-terrain.js');
  const surface = createSphericalTerrain({ id: 'physics-integration', radius: 85, position: [320, -180, 90], terrainSegments: { width: 48, height: 32 } });
  try {
    for (const direction of [new Vector3(0, 1, 0), new Vector3(0, -1, 0), new Vector3(1, .3, -.5).normalize()]) {
      const start = surface.center.clone().addScaledVector(direction, surface.radiusAt(direction) + 6);
      const frame = surface.frameAt(start);
      let state = pose(start, frame.quaternion, 0);
      for (let i = 0; i < 240; i++) {
        const previous = state.position;
        state = stepFlight(state, { brake: true, descend: true }, 1 / 120, [surface]);
        assert.ok(state.altitude >= LANDING_CLEARANCE - 2e-5);
        assert.ok(previous.distanceTo(state.position) <= .051);
      }
      assert.ok(state.landed);
      assert.ok(state.position.distanceTo(surface.groundAt(state.position, LANDING_CLEARANCE)) < 2e-5);
    }
  } finally { surface.geometry.dispose(); }
});


test('S crosses zero into backward travel; release coasts backward and W reverses it', () => {
  let state = pose(new Vector3(), new Quaternion(), 30);
  let crossedZero = false;
  for (let i = 0; i < 240; i++) {
    const previous = state;
    state = stepFlight(state, { reverse: true }, 1 / 120, []);
    assert.ok(state.speed <= previous.speed);
    assert.ok(Math.abs(state.speed - previous.speed) <= 68 / 120 + 1e-7);
    if (state.speed < 0) crossedZero = true;
  }
  assert.ok(crossedZero && state.speed < -100);
  const coast = stepFlight(state, {}, .5, []);
  approximately(coast.speed, state.speed);
  assert.ok(coast.position.z > state.position.z);
  const forwardAgain = stepFlight(coast, { throttle: true }, 4, []);
  approximately(forwardAgain.speed, 120);
  approximately(stepFlight(state, { brake: true }, 3, []).speed, 0);
});

test('backward boosted momentum stays signed at altitude boundaries and impacts are not slow landings', () => {
  const planet = sphere();
  const state = pose(new Vector3(0, 0, -340), new Quaternion(), -340);
  const coast = stepFlight(state, {}, .6, [planet]);
  approximately(coast.speed, -340);
  const contact = stepFlight(coast, {}, .12, [planet]);
  assert.ok(contact.impact);
  assert.equal(contact.touchdown, false);
  assert.ok(contact.speed < -25);
  assert.ok(contact.altitude >= LANDING_CLEARANCE - 1e-5);
});

test('external loop segment sweeps cannot skip a whole planet in either direction', () => {
  const planet = sphere();
  const start = new Vector3(0, 0, 500), end = new Vector3(0, 0, -500);
  const result = sweepFlightSegment(start, end, [planet]);
  assert.equal(result.hit, true);
  assert.equal(result.surface, planet);
  approximately(result.position.z, 100 + LANDING_CLEARANCE, 2e-5);
  approximately(start.z, 500); approximately(end.z, -500);
  const reverse = sweepFlightSegment(end, start, [planet], 3);
  approximately(reverse.position.z, -103, 2e-5);
  const clear = sweepFlightSegment(new Vector3(200, 0, 500), new Vector3(200, 0, -500), [planet]);
  assert.equal(clear.hit, false);
  approximately(clear.position.z, -500);
});


function minimumHullAltitude(state, surface) {
  return Math.min(...FLIGHT_HULL_POINTS.map(point => surface.altitudeAt(new Vector3(...point).applyQuaternion(state.quaternion).add(state.position))));
}

test('nose-first hull contact stays above the sphere and settles smoothly to a tangent landing', () => {
  const planet = sphere(100, new Vector3(42, -700, 28));
  let state = pose(planet.center.clone().add(new Vector3(0, 125, 0)), rotateFlight(new Quaternion(), 0, -Math.PI / 2), 18);
  let touchdown = false, touchdownAltitude = 0;
  for (let i = 0; i < 700; i++) {
    const previous = state;
    state = stepFlight(state, {}, 1 / 120, [planet]);
    assert.ok(minimumHullAltitude(state, planet) >= -2e-5, 'nose, wing, tail, belly, and upper hull stay outside');
    assert.ok(state.position.distanceTo(previous.position) <= .151, 'center has no landing-height reset');
    assert.ok(state.quaternion.angleTo(previous.quaternion) <= 1.8 / 120 + 1e-6, 'attitude does not snap');
    if (state.touchdown) { touchdown = true; touchdownAltitude = state.altitude; }
    if (touchdown) assert.ok(state.landed, 'raised hull contact remains landed while settling');
  }
  assert.ok(touchdown && touchdownAltitude > 7.2, 'contact begins at the nose, before center clearance');
  approximately(state.altitude, LANDING_CLEARANCE, 2e-5);
  assert.ok(Math.abs(forward(state.quaternion).dot(planet.normalAt(state.position))) < 1e-6);
});

test('rotation-only and boosted nose-first contacts also protect all hull supports', () => {
  const planet = sphere();
  let parked = pose(new Vector3(0, 100 + LANDING_CLEARANCE, 0));
  for (let i = 0; i < 120; i++) {
    parked = stepFlight(parked, { pitch: -1 }, 1 / 120, [planet]);
    assert.ok(minimumHullAltitude(parked, planet) >= -2e-5);
  }
  let boosted = pose(new Vector3(0, 160, 0), rotateFlight(new Quaternion(), 0, -Math.PI / 2), 600);
  let collided = false;
  for (let i = 0; i < 120; i++) {
    boosted = stepFlight(boosted, {}, 1 / 240, [planet]);
    collided ||= boosted.impact;
    assert.ok(minimumHullAltitude(boosted, planet) >= -2e-5, 'boosted contact never buries a support vertex');
  }
  assert.ok(collided);
});

test('external maneuver sweeps optionally protect hull attitude and return the safe contact quaternion', () => {
  const planet = sphere();
  const q = rotateFlight(new Quaternion(), 0, -Math.PI / 2);
  const result = sweepFlightSegment(new Vector3(0, 140, 0), new Vector3(0, 80, 0), [planet], LANDING_CLEARANCE, q, q);
  assert.ok(result.hit);
  approximately(result.position.y, 107.3, 3e-5);
  assert.ok(minimumHullAltitude(result, planet) >= -2e-5);
  approximately(q.angleTo(result.quaternion), 0);
});

test('steep landing hull samples follow displaced terrain at translated world coordinates', async () => {
  const { createSphericalTerrain } = await import('../game/spherical-terrain.js');
  const planet = createSphericalTerrain({ id: 'hull-ground', radius: 85, position: [-320, 400, 91], terrainSegments: { width: 48, height: 32 } });
  try {
    const up = new Vector3(.5, -.7, .3).normalize();
    const position = planet.center.clone().addScaledVector(up, planet.radiusAt(up) + 22);
    const q = facing(up.clone().negate(), new Vector3(0, 1, 0));
    let state = pose(position, q, 15), touched = false;
    for (let i = 0; i < 650; i++) {
      const previous = state;
      state = stepFlight(state, {}, 1 / 120, [planet]);
      touched ||= state.touchdown;
      assert.ok(minimumHullAltitude(state, planet) >= -2e-5);
      assert.ok(state.position.distanceTo(previous.position) < .18);
      assert.ok(state.quaternion.angleTo(previous.quaternion) < .025);
    }
    assert.ok(touched && state.landed);
    assert.ok(state.altitude >= LANDING_CLEARANCE - 2e-5 && state.altitude < 2.5);
  } finally { planet.geometry.dispose(); }
});
