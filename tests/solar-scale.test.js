import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3, Scene } from 'three';
import { PLANETS } from '../game/world.js';
import { PLANETS as CONTENT_PLANETS } from '../game/content.js';
import { SOLAR_SCALE, FLIGHT_TUNING, GATE_LOCATIONS, INTERCEPTOR_LOCATIONS } from '../game/solar-scale.js';
import { flightEnvelope, stepFlight, sweepFlightSegment, FLIGHT_HULL_POINTS } from '../game/continuous-flight.js';
import { createLoop, updateLoop, createSpacePlayground } from '../game/space-playground.js';
import { createSphericalTerrain } from '../game/spherical-terrain.js';

const v = value => new Vector3(...value);
const sphere = spec => ({ ...spec, center: v(spec.position),
  altitudeAt(p) { return p.distanceTo(this.center) - this.radius; },
  normalAt(p) { return p.clone().sub(this.center).normalize(); },
});
const surfaces = PLANETS.map(sphere);
const pose = (position, direction, speed = 0) => ({ position, quaternion: new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), direction), speed, landed: false });
const hullAbove = (state, surface) => FLIGHT_HULL_POINTS.every(local => surface.altitudeAt(v(local).applyQuaternion(state.quaternion).add(state.position)) > -2e-5);

test('five planets are ten times the prior radius and thirty times farther apart, with synchronized content', () => {
  assert.deepEqual(PLANETS.map(p => p.radius), [1500, 1900, 1450, 2100, 1150]);
  assert.deepEqual(PLANETS.map(p => p.position), [[-22050,2625,-30450],[23100,6300,-52500],[47250,-5250,-8400],[-47250,-3150,9450],[4200,10500,36750]]);
  assert.deepEqual(CONTENT_PLANETS.map(p => [p.id,p.position,p.radius]), PLANETS.map(p => [p.id,p.position,p.radius]));
  for (const planet of PLANETS) {
    assert.ok(v(planet.position).length() + planet.radius < SOLAR_SCALE.worldExtent);
    for (const other of PLANETS) if (other !== planet) assert.ok(v(planet.position).distanceTo(v(other.position)) - planet.radius - other.radius > 20000);
  }
  assert.ok(SOLAR_SCALE.cameraFar > SOLAR_SCALE.skyRadius + SOLAR_SCALE.worldExtent);
  assert.ok(SOLAR_SCALE.starfieldRadius * .8 > SOLAR_SCALE.worldExtent * 3);
});

test('sparse encounter corridors retain nearby discovery and span the full system outside planets', () => {
  assert.equal(GATE_LOCATIONS.length, 14); assert.equal(INTERCEPTOR_LOCATIONS.length, 12);
  for (const locations of [GATE_LOCATIONS, INTERCEPTOR_LOCATIONS]) {
    assert.ok(locations.some(p => v(p).distanceTo(new Vector3(0,8,120)) < 2000));
    assert.ok(locations.filter(p => v(p).length() > 20000).length >= 7);
    for (const p of locations) for (const planet of PLANETS) assert.ok(v(p).distanceTo(v(planet.position)) > planet.radius * 1.06 + 500);
  }
  const playground = createSpacePlayground(new Scene());
  try {
    assert.equal(playground.rings[0].innerRadius, 98.75);
    assert.equal(playground.rings[8].innerRadius, 197.5);
    playground.update(1/60,1,v([0,8,120]));
    assert.ok(playground.rings.every(r => r.mesh.scale.x === r.baseScale));
    playground.reset(); assert.ok(playground.rings.every(r => r.mesh.scale.x === r.baseScale));
  } finally { playground.dispose(); }
});

test('engine envelope changes continuously, retains near-ground handling and reaches usable deep cruise', () => {
  assert.equal(flightEnvelope(10).forwardSpeed, 48);
  assert.equal(flightEnvelope(10000).forwardSpeed, FLIGHT_TUNING.cruiseSpeed);
  assert.equal(flightEnvelope(10000).boostSpeed, FLIGHT_TUNING.boostSpeed);
  let previous = flightEnvelope(0);
  for (let altitude = 1; altitude < 10000; altitude++) {
    const next = flightEnvelope(altitude);
    assert.ok(next.forwardSpeed >= previous.forwardSpeed);
    assert.ok(next.forwardSpeed - previous.forwardSpeed < .7);
    assert.ok(next.boostSpeed - previous.boostSpeed < 1.5);
    previous = next;
  }
  let state = pose(v([0,8,120]), v([0,0,-1]));
  for (let i = 0; i < 300; i++) {
    const prior = state;
    state = stepFlight(state, {throttle:true},1/60,surfaces);
    assert.ok(state.speed >= prior.speed && state.speed - prior.speed <= FLIGHT_TUNING.cruiseAcceleration / 60 + 1e-7);
  }
  assert.equal(state.speed, FLIGHT_TUNING.cruiseSpeed);
  const coast = stepFlight(state,{},.5,surfaces); assert.equal(coast.speed,state.speed);
  const brake = stepFlight(coast,{brake:true},8,surfaces); assert.equal(brake.speed,0);
});

test('deep reverse crosses zero smoothly and preserves signed speed through a full evasive loop', () => {
  let state = pose(v([0,8,120]),v([0,0,-1]),500);
  state = stepFlight(state,{reverse:true},4,surfaces);
  assert.equal(state.speed,-FLIGHT_TUNING.reverseSpeed);
  const coast = stepFlight(state,{},.5,surfaces);
  assert.equal(coast.speed,state.speed); assert.ok(coast.position.z > state.position.z);
  for (const signedSpeed of [FLIGHT_TUNING.cruiseSpeed, -FLIGHT_TUNING.reverseSpeed, FLIGHT_TUNING.boostSpeed, -FLIGHT_TUNING.boostSpeed]) {
    const sign = Math.sign(signedSpeed), nose = v([0,0,-1]);
    const loop = createLoop(v([0,8,120]),nose.clone().multiplyScalar(sign),Math.abs(signedSpeed));
    const start = updateLoop(loop,0); let before = start;
    for (let i = 0; i < 120; i++) {
      const next = updateLoop(loop,loop.duration/120);
      assert.equal(next.speed * sign,signedSpeed);
      assert.ok(before.position.distanceTo(next.position) <= Math.abs(signedSpeed)*loop.duration/120 + 1e-7);
      before = next;
    }
    assert.ok(before.position.distanceTo(start.position) < 1e-7);
    assert.ok(before.direction.distanceTo(start.direction) < 1e-7);
  }
});

test('a hundred-kilometre empty-space sweep does not sample terrain or multiply integration substeps', () => {
  let calls = 0;
  const counted = surfaces.map(surface => ({...surface, altitudeAt(p) { calls++; return surface.altitudeAt(p); }}));
  const a = v([0,70000,50000]), b = v([0,70000,-50000]);
  assert.equal(sweepFlightSegment(a,b,counted).hit,false); assert.equal(calls,0);
  const result = stepFlight(pose(a,v([0,0,-1]),100000),{},1/60,counted);
  assert.equal(result.integrationSteps,2);
  assert.ok(calls <= 15, `${calls} altitude calls in empty space`);
});

test('high-speed forward, reverse, and rotated hull sweeps hit the approached side of actual giant terrain', () => {
  const terrain = createSphericalTerrain({...PLANETS[0],terrainSegments:{width:80,height:48}});
  let calls = 0; const sample = terrain.altitudeAt;
  terrain.altitudeAt = p => { calls++; return sample(p); };
  try {
    for (const axis of [v([0,0,1]),v([0,1,0]),v([1,.3,.2]).normalize()]) {
      const start = terrain.center.clone().addScaledVector(axis,terrain.radius*5);
      const end = terrain.center.clone().addScaledVector(axis,-terrain.radius*5);
      for (const reversed of [false,true]) {
        const nose = axis.clone().multiplyScalar(reversed ? 1 : -1);
        const q = pose(start,nose).quaternion;
        const before = calls;
        const result = sweepFlightSegment(start,end,[terrain],1.9,q,q);
        assert.ok(result.hit); assert.ok(hullAbove(result,terrain));
        assert.ok(result.position.clone().sub(terrain.center).dot(axis) > 0);
        assert.ok(calls-before < 1800, `${calls-before} local hull samples`);
      }
    }
  } finally { terrain.geometry.dispose(); }
});

test('every launch destination and interplanet corridor is reachable in seconds, not minutes', t => {
  const travel = (start, target) => {
    const direction = target.clone().sub(start).normalize();
    let state = pose(start,direction), seconds = 0;
    while (target.clone().sub(state.position).dot(direction) > 0 && seconds < 50) {
      state = stepFlight(state,{boost:true},1/30,surfaces); seconds += 1/30;
      assert.equal(state.impact,false,'straight approach must end before ground contact');
    }
    return seconds;
  };
  const start = v([0,8,120]);
  const fromLaunch = PLANETS.map(p => {
    const center = v(p.position), direction = center.clone().sub(start).normalize();
    return travel(start.clone(),center.addScaledVector(direction,-p.radius-800));
  });
  let slowest = 0;
  for (let i = 0; i < PLANETS.length; i++) for (let j = i+1; j < PLANETS.length; j++) {
    const a = PLANETS[i], b = PLANETS[j], direction = v(b.position).sub(v(a.position)).normalize();
    const from = v(a.position).addScaledVector(direction,a.radius+1000);
    const to = v(b.position).addScaledVector(direction,-b.radius-800);
    slowest = Math.max(slowest,travel(from,to));
  }
  assert.ok(Math.max(...fromLaunch) < 13, `launch times: ${fromLaunch}`);
  assert.ok(slowest < 45, `longest corridor: ${slowest}`);
  t.diagnostic(`launch to each world's 800m approach: ${fromLaunch.map(n=>n.toFixed(1)).join(', ')}s; slowest surface-to-surface corridor: ${slowest.toFixed(1)}s`);
});

test('sloped touchdown readiness follows actual face normal and hull contact rather than radial gravity', async()=>{
  const {isLandingSettled}=await import('../game/continuous-flight.js');
  const terrain=createSphericalTerrain(PLANETS.find(p=>p.id==='mission'),3);
  const point=new Vector3(-45242.254,-2923.970,9111.393),up=terrain.surfaceNormalAt(point);
  let state={position:terrain.groundAt(point,18),quaternion:new Quaternion().setFromUnitVectors(new Vector3(0,1,0),up),speed:0,landed:false};
  for(let i=0;i<1200;i++)state=stepFlight(state,{descend:true},1/60,[terrain]);
  assert.equal(state.landed,true);assert.ok(new Vector3(0,1,0).applyQuaternion(state.quaternion).dot(terrain.normalAt(state.position))<.96);
  assert.equal(isLandingSettled(state.position,state.quaternion,terrain),true);
  assert.equal(isLandingSettled(state.position.clone().addScaledVector(up,8),state.quaternion,terrain),false);
  terrain.geometry.dispose();
});
